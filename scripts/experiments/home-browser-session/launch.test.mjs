import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMO_URL, openHomeBrowser } from "./launch.mjs";

test("hands exactly one fixed HTTPS URL to the default Chrome handler", async () => {
  const urls = [];
  await openHomeBrowser({ defaultHttpsHandler: async () => "ChromeHTML", openExternal: async (url) => urls.push(url) });
  assert.deepEqual(urls, [DEMO_URL]);
});

test("does not fall back to another browser or open a page when default is unknown", async () => {
  for (const handler of ["MSEdgeHTM", ""]) {
    await assert.rejects(openHomeBrowser({
      defaultHttpsHandler: async () => handler,
      openExternal: async () => assert.fail("must not launch"),
    }), /No browser was opened/);
  }
});

test("does not retry a failed OS launch", async () => {
  let attempts = 0;
  await assert.rejects(openHomeBrowser({
    defaultHttpsHandler: async () => "ChromeHTML",
    openExternal: async () => { attempts++; throw new Error("OS launch failed"); },
  }), /OS launch failed/);
  assert.equal(attempts, 1);
});

