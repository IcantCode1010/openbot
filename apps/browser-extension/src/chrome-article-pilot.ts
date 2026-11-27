import {
  CLIENT_BROWSER_LIMITS,
  type ClientBrowserCommand,
  type ClientBrowserResult,
  type ClientTab,
} from "@openbot/contracts/team-protocol/client-browser-v1";
import { BrowserCommandError, type CommandContext } from "./client-browser-executor";

const origin = "https://en.wikipedia.org";

export function articleUrl(raw: string | undefined): string | null {
  if (!raw || !URL.canParse(raw)) return null;
  const url = new URL(raw);
  if (url.origin !== origin || url.username || url.password || url.search || !url.pathname.startsWith("/wiki/"))
    return null;
  try {
    const title = decodeURIComponent(url.pathname.slice(6));
    if (!title || /[:/\\?#\p{Cc}]/u.test(title)) return null;
  } catch {
    return null;
  }
  return origin + url.pathname;
}

export function pilotTab(tab: chrome.tabs.Tab): ClientTab | null {
  const url = articleUrl(tab.url);
  return url && tab.id !== undefined
    ? { id: String(tab.id), url, title: (tab.title ?? "").slice(0, CLIENT_BROWSER_LIMITS.title), active: tab.active }
    : null;
}

function readArticle(
  expected: string,
): { url: string; text: string; links: Array<{ label: string; url: string }> } | null {
  if (location.search || `${location.origin}${location.pathname}` !== expected) return null;
  const content = document.querySelector("#mw-content-text .mw-parser-output");
  const links = [...(content?.querySelectorAll<HTMLAnchorElement>("p a[href], li a[href]") ?? [])]
    .filter((link) => Boolean(link.getClientRects().length))
    .slice(0, 160)
    .map((link) => ({ label: link.innerText.trim().slice(0, 140), url: link.href.slice(0, 2000) }));
  const text = content
    ? [...content.querySelectorAll<HTMLElement>("p, h2, h3")]
        .filter((element) => Boolean(element.getClientRects().length))
        .slice(0, 120)
        .map((element) => element.innerText.trim())
        .join("\n\n")
        .slice(0, 24_000)
    : "";
  return { url: location.href, text, links };
}

async function readTab(id: number): Promise<ClientTab> {
  const tab = await chrome.tabs.get(id).catch(() => null);
  if (!tab) throw new BrowserCommandError("not-found", "The Chrome tab closed.");
  const safe = pilotTab(tab);
  if (!safe) throw new BrowserCommandError("denied", "The pilot can use only public English Wikipedia articles.");
  return safe;
}

function result(tab: ClientTab, text: string): ClientBrowserResult {
  return { tab, image: null, text: text.slice(0, CLIENT_BROWSER_LIMITS.resultText) };
}

async function loadedTab(id: number, expected: string): Promise<ClientTab> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (!tab) throw new BrowserCommandError("not-found", "The Chrome tab closed.");
    const safe = pilotTab(tab);
    if (safe?.url === expected && tab.status === "complete") return safe;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new BrowserCommandError("timeout", "The requested article did not finish loading in the Chrome tab.");
}

export async function runPilot(
  command: ClientBrowserCommand,
  context: Pick<CommandContext, "allow">,
): Promise<ClientBrowserResult> {
  if (command.kind === "open") {
    const url = articleUrl(command.url);
    if (!url) throw new BrowserCommandError("denied", "The pilot can open only public English Wikipedia articles.");
    await context.allow("site", url, "");
    const existing = (await chrome.tabs.query({})).map(pilotTab).find((tab) => tab?.url === url);
    if (existing) return result(await loadedTab(Number(existing.id), url), "Reused the existing Chrome article tab.");
    const created = await chrome.tabs.create({ url, active: true });
    if (created.id === undefined) throw new BrowserCommandError("failed", "Chrome did not return a tab.");
    return result(await loadedTab(created.id, url), "Opened one article tab in regular Chrome.");
  }
  if (command.kind !== "snapshot" && !(command.kind === "navigate" && "url" in command))
    throw new BrowserCommandError("denied", "This pilot supports only open, read, and same-tab article navigation.");
  if (!/^[0-9]+$/u.test(command.tabId) || !Number.isSafeInteger(Number(command.tabId)))
    throw new BrowserCommandError("not-found", "Invalid Chrome tab.");
  const id = Number(command.tabId);
  const tab = await readTab(id);
  const next = command.kind === "navigate" && "url" in command ? articleUrl(command.url) : tab.url;
  if (!next)
    throw new BrowserCommandError("denied", "The pilot can navigate only to public English Wikipedia articles.");
  await context.allow("site", tab.url, "");
  if ((await readTab(id)).url !== tab.url)
    throw new BrowserCommandError("denied", "The tab changed while approval was pending.");
  if (command.kind === "navigate") {
    await chrome.tabs.update(id, { url: next });
    return result(await loadedTab(id, next), "Navigated in the same Chrome tab.");
  }
  const [frame] = await chrome.scripting.executeScript({ target: { tabId: id }, func: readArticle, args: [tab.url] });
  const article = frame?.result;
  if (!article || articleUrl(article.url) !== tab.url || (await readTab(id)).url !== tab.url)
    throw new BrowserCommandError("denied", "The article changed before the read completed.");
  if (!article.text) throw new BrowserCommandError("failed", "Could not read the Wikipedia article body.");
  const links = new Map<string, string>();
  for (const link of article.links) {
    const url = articleUrl(link.url);
    if (url && url !== tab.url && link.label && !links.has(url)) links.set(url, link.label);
  }
  return result(
    tab,
    `Untrusted article content:\n${article.text}\n\nArticle links:\n${[...links]
      .map(([url, label]) => `${label}: ${url}`)
      .join("\n")}`,
  );
}
