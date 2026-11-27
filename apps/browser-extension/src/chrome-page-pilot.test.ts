import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { pageUrl, pilotTab, runPilot, sitePattern } from "./chrome-page-pilot";

const wiki = "https://en.wikipedia.org/wiki/Beaver";
const docs = "https://docs.example.com/search?q=beaver";
const another = "https://docs.example.com/guide";
const blocked = "chrome://settings/";
const previous = Object.getOwnPropertyDescriptor(globalThis, "chrome");
let url = docs;
const tab = () => ({ id: 42, url, title: "A page", active: true, status: "complete", windowId: 1, groupId: -1 });
const allow = vi.fn(async () => {});
const get = vi.fn(async () => tab());
const query = vi.fn(async () => [tab()]);
const create = vi.fn(async ({ url: next }: { url: string }) => {
  url = next;
  return tab();
});
const update = vi.fn(async (_id: number, { url: next }: { url: string }) => {
  url = next;
  return tab();
});
const executeScript = vi.fn(async () => [
  {
    result: {
      url,
      text: "Page facts",
      links: [
        { label: "Wiki", url: wiki },
        { label: "Guide", url: another },
        { label: "Blocked", url: blocked },
        { label: "Tokenized", url: "https://example.com/?access_token=xyz" },
      ],
    },
  },
]);

beforeEach(() => {
  url = docs;
  for (const fn of [allow, get, query, create, update, executeScript]) fn.mockClear();
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: { tabs: { get, query, create, update }, scripting: { executeScript } },
  });
});

afterEach(() => {
  if (previous) Object.defineProperty(globalThis, "chrome", previous);
  else Reflect.deleteProperty(globalThis, "chrome");
});

test("supports unrelated sites, ordinary queries, and local web pages", () => {
  expect(pageUrl(wiki)).toBe(wiki);
  expect(pageUrl(docs)).toBe(docs);
  expect(pageUrl("http://localhost:3000/guide")).toBe("http://localhost:3000/guide");
  expect(sitePattern("http://localhost:3000")).toBe("http://localhost:3000/*");
  expect(sitePattern(docs)).toBe("https://docs.example.com/*");
});

test("omits browser internals, file URLs, and common credential links", () => {
  for (const unsafe of [
    blocked,
    "file:///local",
    "javascript:void(0)",
    "https://user:pass@example.com/",
    "https://example.com/oauth/callback?code=abc",
    "https://example.com/login",
    "https://example.com/?password=xyz",
    "https://example.com/#access_token=xyz",
    "https://example.com/?X-Amz-Signature=abc",
  ]) {
    expect(pageUrl(unsafe)).toBeNull();
  }
  expect(pilotTab({ ...tab(), url: blocked })).toBeNull();
});

test("reuses a real-tab identity and returns links from unrelated sites", async () => {
  const first = await runPilot({ kind: "open", url: docs }, { allow });
  expect(first.tab?.id).toBe("42");
  expect(create).not.toHaveBeenCalled();
  const page = await runPilot({ kind: "snapshot", tabId: "42" }, { allow });
  expect(page.text).toContain("Page facts");
  expect(page.text).toContain(wiki);
  expect(page.text).toContain(another);
  expect(page.text).not.toContain(blocked);
  expect(page.text).not.toContain("access_token");
  const next = await runPilot({ kind: "navigate", tabId: "42", url: another }, { allow });
  expect(next.tab).toMatchObject({ id: "42", url: another });
  expect(update).toHaveBeenCalledWith(42, { url: another });
  expect(create).not.toHaveBeenCalled();
});

test("checks both sites before cross-origin navigation", async () => {
  const next = await runPilot({ kind: "navigate", tabId: "42", url: wiki }, { allow });
  expect(next.tab).toMatchObject({ id: "42", url: wiki });
  expect(allow).toHaveBeenNthCalledWith(1, "site", docs, "");
  expect(allow).toHaveBeenNthCalledWith(2, "site", wiki, "");
});

test("does not navigate if the destination is denied", async () => {
  await expect(
    runPilot(
      { kind: "navigate", tabId: "42", url: wiki },
      {
        allow: async (_kind, target) => {
          if (target === wiki) throw new Error("Denied by user");
        },
      },
    ),
  ).rejects.toThrow("Denied by user");
  expect(update).not.toHaveBeenCalled();
});

test("rejects browser pages and arbitrary clicks before any action", async () => {
  await expect(runPilot({ kind: "open", url: blocked }, { allow })).rejects.toMatchObject({ code: "denied" });
  await expect(runPilot({ kind: "click", tabId: "42", target: { css: "button" } }, { allow })).rejects.toMatchObject({
    code: "denied",
  });
  expect(allow).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  expect(executeScript).not.toHaveBeenCalled();
});

test("does not read a tab that changed during approval", async () => {
  await expect(
    runPilot(
      { kind: "snapshot", tabId: "42" },
      {
        allow: async () => {
          url = wiki;
        },
      },
    ),
  ).rejects.toMatchObject({ code: "denied" });
  expect(executeScript).not.toHaveBeenCalled();
});

test("discards results if navigation begins after the read is sent", async () => {
  executeScript.mockImplementationOnce(async () => [{ result: { url: wiki, text: "private", links: [] } }]);
  await expect(runPilot({ kind: "snapshot", tabId: "42" }, { allow })).rejects.toMatchObject({ code: "denied" });
});

test("does not open a tab when the user denies access", async () => {
  await expect(
    runPilot(
      { kind: "open", url: wiki },
      {
        allow: async () => {
          throw new Error("Denied by user");
        },
      },
    ),
  ).rejects.toThrow("Denied by user");
  expect(create).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
});

test("does not expose a redirected site that was not approved", async () => {
  update.mockImplementationOnce(async () => {
    url = wiki;
    return tab();
  });
  await expect(runPilot({ kind: "navigate", tabId: "42", url: another }, { allow })).rejects.toMatchObject({
    code: "denied",
  });
  expect(executeScript).not.toHaveBeenCalled();
});
