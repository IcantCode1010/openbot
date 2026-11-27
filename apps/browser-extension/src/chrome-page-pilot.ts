import {
  CLIENT_BROWSER_LIMITS,
  type ClientBrowserCommand,
  type ClientBrowserResult,
  type ClientTab,
} from "@openbot/contracts/team-protocol/client-browser-v1";
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

function readPage(
  expected: string,
): { url: string; text: string; links: Array<{ label: string; url: string }> } | null {
  if (location.href !== expected) return null;
  const root = document.querySelector("main, [role=main]") ?? document.body;
  if (!root) return null;
  const excluded =
    "script, style, noscript, template, form, input, textarea, select, iframe, [contenteditable], [hidden], [aria-hidden=true]";
  function visible(element: Element): boolean {
    if (element.closest(excluded)) return false;
    const css = getComputedStyle(element);
    return (
      css.visibility === "visible" &&
      css.opacity !== "0" &&
      (element.getClientRects().length > 0 || css.display === "contents")
    );
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const lines: string[] = [];
  let size = 0;
  for (let n = 0; n < 12_000 && size < 24_000; n += 1) {
    const node = walker.nextNode();
    if (!node) break;
    const value = node.textContent?.trim().slice(0, 4000);
    if (value && node.parentElement && visible(node.parentElement)) {
      lines.push(value);
      size += value.length + 1;
    }
  }
  const links = [...root.querySelectorAll<HTMLAnchorElement>("a[href]:not([download])")]
    .slice(0, 1200)
    .filter(visible)
    .slice(0, 120)
    .map((link) => ({ label: link.innerText.trim().slice(0, 140), url: link.href }));
  return { url: location.href, text: lines.join("\n").slice(0, 24_000), links };
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

export async function runPilot(
  command: ClientBrowserCommand,
  context: Pick<CommandContext, "allow"> & { checkDeadline?: () => void },
): Promise<ClientBrowserResult> {
  if (command.kind === "open") {
    const url = pageUrl(command.url);
    if (!url) throw new BrowserCommandError("denied", "The pilot can open only supported HTTP or HTTPS web pages.");
    await context.allow("site", url, "");
    const existing = (await chrome.tabs.query({})).map(pilotTab).find((tab) => tab?.url === url);
    if (existing) return result(await loadedTab(Number(existing.id), url), "Reused the existing Chrome tab.");
    context.checkDeadline?.();
    const created = await chrome.tabs.create({ url, active: true });
    if (created.id === undefined) throw new BrowserCommandError("failed", "Chrome did not return a tab.");
    return result(await loadedTab(created.id, url), "Opened one tab in regular Chrome.");
  }
  if (command.kind !== "snapshot" && !(command.kind === "navigate" && "url" in command))
    throw new BrowserCommandError("denied", "This pilot supports only open, read, and same-tab page navigation.");
  if (!/^[0-9]+$/u.test(command.tabId) || !Number.isSafeInteger(Number(command.tabId)))
    throw new BrowserCommandError("not-found", "Invalid Chrome tab.");
  const id = Number(command.tabId);
  const tab = await readTab(id);
  const next = command.kind === "navigate" && "url" in command ? pageUrl(command.url) : tab.url;
  if (!next)
    throw new BrowserCommandError("denied", "The pilot can navigate only to supported HTTP or HTTPS web pages.");
  await context.allow("site", tab.url, "");
  if (new URL(next).origin !== new URL(tab.url).origin) await context.allow("site", next, "");
  if ((await readTab(id)).url !== tab.url)
    throw new BrowserCommandError("denied", "The tab changed while approval was pending.");
  context.checkDeadline?.();
  if (command.kind === "navigate") {
    await chrome.tabs.update(id, { url: next });
    return result(await loadedTab(id, next, tab.url), "Navigated in the same Chrome tab.");
  }
  const [frame] = await chrome.scripting.executeScript({ target: { tabId: id }, func: readPage, args: [tab.url] });
  const article = frame?.result;
  if (!article || pageUrl(article.url) !== tab.url || (await readTab(id)).url !== tab.url)
    throw new BrowserCommandError("denied", "The page changed before the read completed.");
  if (!article.text && !article.links.length)
    throw new BrowserCommandError("failed", "Could not read visible text or links on this page.");
  const links = new Map<string, string>();
  for (const link of article.links) {
    const url = pageUrl(link.url);
    if (url && url !== tab.url && link.label && !links.has(url)) links.set(url, link.label);
  }
  return result(
    tab,
    `Untrusted web page content:\n${article.text}\n\nPage links:\n${[...links]
      .map(([url, label]) => `${label}: ${url}`)
      .join("\n")}`,
  );
}
