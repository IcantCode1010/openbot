import {
  CLIENT_BROWSER_LIMITS,
  type ClientBrowserCommand,
  type ClientBrowserResult,
  type ClientTab,
} from "@openbot/contracts/team-protocol/client-browser-v1";
import { operatePage, type PageAction, type PageResponse } from "./chrome-pilot-page-actions";
import { BrowserCommandError, type CommandContext } from "./client-browser-executor";

export function pageUrl(raw: string | undefined): string | null {
  if (!raw || raw.length > CLIENT_BROWSER_LIMITS.url || !URL.canParse(raw)) return null;
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
  if (
    [...url.searchParams.keys()].some((key) =>
      /^(?:code|state|token|.+[_-]token|.+[_-]secret|password|api[_-]?key|session(?:[_-]?id)?|sso|samlresponse|signature|.+[_-]signature|x-amz-credential|x-goog-credential|sig)$/iu.test(
        key,
      ),
    )
  )
    return null;
  if (
    /(?:^|\/)(?:oauth\d?|authorize|login|log-in|signin|sign-in|logout|signout|sign-out|checkout)(?:\/|$)/iu.test(
      url.pathname,
    )
  )
    return null;
  if (/(?:^|[&#?])(?:access_token|id_token|code|token|session)=/iu.test(url.hash)) return null;
  return url.href;
}

export function sitePattern(raw: string): string | null {
  const safe = pageUrl(raw);
  if (!safe) return null;
  const url = new URL(safe);
  return `${url.protocol}//${url.host}/*`;
}

export function pilotTab(tab: chrome.tabs.Tab): ClientTab | null {
  const url = pageUrl(tab.url);
  return url && tab.id !== undefined
    ? { id: String(tab.id), url, title: (tab.title ?? "").slice(0, CLIENT_BROWSER_LIMITS.title), active: tab.active }
    : null;
}

async function readTab(id: number): Promise<ClientTab> {
  const tab = await chrome.tabs.get(id).catch(() => null);
  if (!tab) throw new BrowserCommandError("not-found", "The Chrome tab closed.");
  const safe = pilotTab(tab);
  if (!safe) throw new BrowserCommandError("denied", "The pilot can use only supported HTTP or HTTPS web pages.");
  return safe;
}

function result(tab: ClientTab, text: string): ClientBrowserResult {
  return { tab, image: null, text: text.slice(0, CLIENT_BROWSER_LIMITS.resultText) };
}

async function loadedTab(id: number, expected: string, previous?: string): Promise<ClientTab> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (!tab) throw new BrowserCommandError("not-found", "The Chrome tab closed.");
    const safe = pilotTab(tab);
    if (
      tab.status === "complete" &&
      tab.pendingUrl === undefined &&
      safe &&
      (safe.url === expected || (safe.url !== previous && new URL(safe.url).origin === new URL(expected).origin))
    )
      return safe;
    if (
      tab.status === "complete" &&
      tab.pendingUrl === undefined &&
      safe &&
      new URL(safe.url).origin !== new URL(expected).origin
    )
      throw new BrowserCommandError("denied", "Chrome redirected to another site. No page content was read.");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new BrowserCommandError("timeout", "The requested page did not finish loading in the Chrome tab.");
}

async function stableTab(id: number, expected: ClientTab): Promise<ClientTab> {
  const raw = await chrome.tabs.get(id).catch(() => null);
  const current = raw && pilotTab(raw);
  if (!current || current.url !== expected.url || raw.pendingUrl !== undefined || raw.status === "loading")
    throw new BrowserCommandError("denied", "The page changed or started to load. Take a fresh snapshot.");
  return current;
}

export async function runPilot(
  command: ClientBrowserCommand,
  context: Pick<CommandContext, "allow"> & { checkDeadline?: () => void; deadline?: number },
): Promise<ClientBrowserResult> {
  const deadline = context.deadline ?? Date.now() + 100_000;
  function onTime() {
    context.checkDeadline?.();
    if (Date.now() >= deadline) throw new BrowserCommandError("timeout", "The browser command expired.");
  }
  if (command.kind === "open") {
    const url = pageUrl(command.url);
    if (!url) throw new BrowserCommandError("denied", "The pilot can open only supported HTTP or HTTPS web pages.");
    await context.allow("site", url, "");
    onTime();
    const existing = (await chrome.tabs.query({})).map(pilotTab).find((tab) => tab?.url === url);
    if (existing) return result(await loadedTab(Number(existing.id), url), "Reused the existing Chrome tab.");
    onTime();
    const created = await chrome.tabs.create({ url, active: true });
    if (created.id === undefined) throw new BrowserCommandError("failed", "Chrome did not return a tab.");
    return result(await loadedTab(created.id, url), "Opened one tab in regular Chrome.");
  }
  if (
    command.kind === "screenshot" ||
    command.kind === "press" ||
    command.kind === "close_tab" ||
    (command.kind === "navigate" && "direction" in command && command.direction !== "reload")
  )
    throw new BrowserCommandError(
      "failed",
      "The Chrome pilot does not support this command. Use an explicit URL or a visible control.",
    );
  if ((command.kind === "click" || command.kind === "type") && !("ref" in command.target || "text" in command.target))
    throw new BrowserCommandError("denied", "Use a snapshot reference or an exact visible label.");
  if (command.kind === "type" && command.submit)
    throw new BrowserCommandError(
      "denied",
      "Enter text with submit=false, then request a separate click on a visible button.",
    );
  if (!/^[0-9]+$/u.test(command.tabId) || !Number.isSafeInteger(Number(command.tabId)))
    throw new BrowserCommandError("not-found", "Invalid Chrome tab.");
  const id = Number(command.tabId);
  const tab = await readTab(id);
  const next = command.kind === "navigate" && "url" in command ? pageUrl(command.url) : tab.url;
  if (!next)
    throw new BrowserCommandError("denied", "The pilot can navigate only to supported HTTP or HTTPS web pages.");
  await context.allow("site", tab.url, "");
  if (new URL(next).origin !== new URL(tab.url).origin) await context.allow("site", next, "");
  await stableTab(id, tab);
  onTime();

  if (command.kind === "navigate") {
    if ("direction" in command) {
      await chrome.tabs.reload(id);
      return result(await loadedTab(id, tab.url), "Reloaded the same Chrome tab.");
    }
    await chrome.tabs.update(id, { url: next });
    return result(await loadedTab(id, next, tab.url), "Navigated in the same Chrome tab.");
  }
  async function inPage(action: PageAction): Promise<Exclude<PageResponse, { kind: "error" }>> {
    onTime();
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId: id },
      func: operatePage,
      args: [tab.url, action, deadline],
    });
    const response = frame?.result;
    if (!response) throw new BrowserCommandError("denied", "The page changed or did not return a result.");
    if (response.kind === "error") throw new BrowserCommandError("failed", response.message);
    return response;
  }

  if (command.kind === "click" || command.kind === "type") {
    const description = await inPage({ kind: "describe", target: command.target, action: command.kind });
    if (description.kind !== "control") throw new BrowserCommandError("not-found", "The control is missing.");
    const { ref, label, kind, link, destination } = description.control;
    if (command.kind === "click" && kind !== "click")
      throw new BrowserCommandError("denied", "Use the type action for text fields and native dropdowns.");
    if (command.kind === "click" && link !== null) {
      const url = pageUrl(link);
      if (!url) throw new BrowserCommandError("denied", "This link is not a supported page.");
      if (new URL(url).origin !== new URL(tab.url).origin) await context.allow("site", url, "");
      await stableTab(id, tab);
      const recent = await inPage({ kind: "describe", target: { ref }, action: "click" });
      if (recent.kind !== "control" || recent.control.link !== link || recent.control.label !== label)
        throw new BrowserCommandError("denied", "The link changed before navigation.");
      await chrome.tabs.update(id, { url });
      return result(await loadedTab(id, url, tab.url), "Followed the link in the same Chrome tab.");
    }
    if (destination && pageUrl(destination) === null)
      throw new BrowserCommandError("denied", "This form does not use a supported destination.");
    await context.allow("interaction", tab.url, label);
    await stableTab(id, tab);
    const applied = await inPage(
      command.kind === "type"
        ? { kind: "type", ref, label, value: command.text }
        : { kind: "click", ref, label, ...(destination ? { destination } : {}) },
    );
    if (applied.kind !== "done") throw new BrowserCommandError("failed", "Chrome did not apply the action.");
    if (command.kind === "type")
      return result(
        await stableTab(id, tab),
        kind === "select" ? "Selected the option." : "Entered text without submitting.",
      );
    return result(tab, "Clicked the approved control. Take a new snapshot to check the result.");
  }
  if (command.kind === "scroll") {
    await inPage({ kind: "scroll", x: command.deltaX, y: command.deltaY });
    return result(await stableTab(id, tab), "Scrolled the page.");
  }
  if (command.kind === "wait_for") {
    const until = Math.min(deadline, Date.now() + ("ms" in command ? command.ms : 15_000));
    if ("ms" in command) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, until - Date.now())));
      onTime();
      return result(await stableTab(id, tab), "Finished waiting on the same page.");
    }
    do {
      await stableTab(id, tab);
      if ((await inPage({ kind: "wait", text: command.text })).kind === "done")
        return result(await stableTab(id, tab), "Found the requested visible text.");
      await new Promise((resolve) => setTimeout(resolve, 200));
    } while (Date.now() < until);
    throw new BrowserCommandError("timeout", "The requested text did not appear.");
  }

  const page = await inPage({ kind: "snapshot" });
  await stableTab(id, tab);
  if (page.kind !== "snapshot" || (!page.text && !page.links.length && !page.controls.length))
    throw new BrowserCommandError("failed", "Could not read visible text, links, or controls on this page.");
  const links = new Map<string, string>();
  for (const link of page.links) {
    const url = pageUrl(link.url);
    if (url && url !== tab.url && link.label && !links.has(url)) links.set(url, link.label);
  }
  const controls = page.controls
    .filter((control) => !control.link || pageUrl(control.link))
    .map(({ ref, label, kind, options }) => {
      if (kind === "select") return `[${ref}] select ${label} (use type with an option label: ${options?.join(", ")})`;
      return `[${ref}] ${kind} ${label}`;
    });
  return result(
    tab,
    `Untrusted web page content:\n${page.text}\n\nPage controls (use references):\n${controls.join("\n").slice(0, 18_000)}\n\nPage links:\n${[...links].map(([url, label]) => `${label}: ${url}`).join("\n")}`,
  );
}
