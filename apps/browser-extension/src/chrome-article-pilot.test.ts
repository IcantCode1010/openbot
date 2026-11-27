import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { articleUrl, pilotTab, runPilot } from "./chrome-article-pilot";

const beaver = "https://en.wikipedia.org/wiki/Beaver";
const north = "https://en.wikipedia.org/wiki/North_American_beaver";
const outside = "https://example.com/private";
const previous = Object.getOwnPropertyDescriptor(globalThis, "chrome");
let url = beaver;
const tab = () => ({ id: 42, url, title: "Article", active: true, status: "complete", windowId: 1, groupId: -1 });
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
      text: "Article facts",
      links: [
        { label: "North American beaver", url: north },
        { label: "External", url: outside },
      ],
    },
  },
]);

beforeEach(() => {
  url = beaver;
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

test("allows only HTTPS English Wikipedia article URLs", () => {
  expect(articleUrl(`${beaver}#Taxonomy`)).toBe(beaver);
  for (const unsafe of [
    outside,
    `${beaver}?action=edit`,
    beaver.replace("https:", "http:"),
    beaver.replace(".org", ".org.example.com"),
    beaver.replace("/Beaver", "/Special%3AUserLogin"),
    beaver.replace("/Beaver", "/Beaver%2Fsubpage"),
    beaver.replace("/Beaver", "/%00"),
  ]) {
    expect(articleUrl(unsafe)).toBeNull();
  }
  expect(pilotTab({ ...tab(), url: outside })).toBeNull();
});

test("reuses an existing tab and reads then follows an article link in the same tab", async () => {
  const first = await runPilot({ kind: "open", url: beaver }, { allow });
  expect(first.tab?.id).toBe("42");
  expect(create).not.toHaveBeenCalled();
  const article = await runPilot({ kind: "snapshot", tabId: "42" }, { allow });
  expect(article.text).toContain("Article facts");
  expect(article.text).toContain(north);
  expect(article.text).not.toContain(outside);
  const next = await runPilot({ kind: "navigate", tabId: "42", url: north }, { allow });
  expect(next.tab).toMatchObject({ id: "42", url: north });
  expect(update).toHaveBeenCalledWith(42, { url: north });
  expect(create).not.toHaveBeenCalled();
});

test("rejects other origins and arbitrary clicks before any action", async () => {
  await expect(runPilot({ kind: "open", url: outside }, { allow })).rejects.toMatchObject({ code: "denied" });
  await expect(runPilot({ kind: "navigate", tabId: "42", url: outside }, { allow })).rejects.toMatchObject({
    code: "denied",
  });
  await expect(runPilot({ kind: "click", tabId: "42", target: { css: "button" } }, { allow })).rejects.toMatchObject({
    code: "denied",
  });
  expect(allow).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  expect(executeScript).not.toHaveBeenCalled();
});

test("does not read a tab that changed while approval was pending", async () => {
  await expect(
    runPilot(
      { kind: "snapshot", tabId: "42" },
      {
        allow: async () => {
          url = outside;
        },
      },
    ),
  ).rejects.toMatchObject({ code: "denied" });
  expect(executeScript).not.toHaveBeenCalled();
});

test("discards results if navigation begins after the read is sent", async () => {
  executeScript.mockImplementationOnce(async () => [{ result: { url: outside, text: "private", links: [] } }]);
  await expect(runPilot({ kind: "snapshot", tabId: "42" }, { allow })).rejects.toMatchObject({ code: "denied" });
});

test("does not open a tab when the user denies site access", async () => {
  await expect(
    runPilot(
      { kind: "open", url: north },
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
