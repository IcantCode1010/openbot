import assert from "node:assert/strict";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { ClientBrowserAnswer, ClientBrowserCommand } from "@openbot/contracts/team-protocol/client-browser-v1";
import { type BrowserContext, chromium } from "playwright-core";

const fixture = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(
    request.url === "/second"
      ? "<main>Second fixture page</main>"
      : `<!doctype html>
    <main><h1>Pilot test dashboard</h1><input type="password" aria-label="Password" value="fixture-private">
    <form><label>Aircraft<input name="aircraft"></label>
    <label>Status<select name="status"><option>Open</option><option>Resolved</option></select></label>
    <button type="button" id="apply">Apply filter</button></form>
    <p hidden>HIDDEN FIXTURE TEXT</p><output></output>
    <div style="height:1800px"></div><a href="/second">Second page</a></main>
    <script>
    document.querySelector("#apply").addEventListener("click", () => {
      const aircraft = document.querySelector("[name=aircraft]").value;
      const status = document.querySelector("[name=status]").value;
      setTimeout(() => { document.querySelector("output").textContent = "Filter result: " + aircraft + " " + status; }, 300);
    });
    </script>`,
  );
});
fixture.listen(0, "127.0.0.1");
await once(fixture, "listening");
const address = fixture.address();
assert.ok(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
const other = `http://localhost:${address.port}`;
const root = await mkdtemp(resolve(tmpdir(), "openbot-chrome-pilot-"));
const dist = resolve(root, "extension");
const report: { browser: string; cases: string[]; passed: boolean } = { browser: "", cases: [], passed: false };
let context: BrowserContext | undefined;
try {
  await cp(resolve("apps/browser-extension/dist-chrome-pilot"), dist, { recursive: true });
  const manifestPath = resolve(dist, "manifest.json");
  const manifest = await readFile(manifestPath, "utf8");
  const manifestJson = JSON.parse(manifest);
  for (const name of ["debugger", "cookies", "tabs"]) assert.ok(!manifestJson.permissions.includes(name));
  assert.deepEqual(manifestJson.optional_host_permissions, ["https://*/*", "http://*/*"]);
  manifestJson.host_permissions.push(`${origin}/*`);
  await writeFile(manifestPath, JSON.stringify(manifestJson));
  await writeFile(resolve(dist, "fixture-runner.html"), "<!doctype html><title>Pilot command fixture</title>");
  const executablePath = process.argv.find((arg) => arg.startsWith("--browser="))?.slice(10);
  context = await chromium.launchPersistentContext(resolve(root, "profile"), {
    ...(executablePath ? { executablePath } : { channel: "chromium" }),
    headless: true,
    timeout: 20_000,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });

  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
  const id = new URL(worker.url()).host;

  report.browser = (await worker.evaluate(() => navigator.userAgent)).replace(/^.*Chrome\//u, "").split(" ")[0] ?? "";
  const runner = await context.newPage();
  await runner.goto(`chrome-extension://${id}/fixture-runner.html`);
  const nativeAccess = await runner.evaluate<boolean>(
    `chrome.permissions.contains({ origins: [${JSON.stringify(`${origin}/*`)}] })`,
  );
  assert.ok(nativeAccess, "Chrome did not recognize the fixture host permission.");
  report.cases.push("Chrome recognized a fixture-only manifest grant");
  const askKey = "openbot.client-browser.asks.v1";
  const labels = { title: "Fixture approval", body: "Fixture approval", working: "Testing" };
  async function command(command: ClientBrowserCommand, response?: "always" | "once" | "deny") {
    process.stdout.write(`Checking ${command.kind}${response ? ` (${response})` : ""}\n`);
    const token = crypto.randomUUID();
    const pending = runner.evaluate<ClientBrowserAnswer>(
      `chrome.runtime.sendMessage(${JSON.stringify({
        kind: "openbot-browser-run",
        event: { type: "client-browser-command", id: token, agentId: "fixture", agentName: "Pilot Test", command },
        labels,
      })})`,
    );
    void pending.catch(() => undefined);
    if (response) {
      let ask: { id: string; kind: string } | undefined;
      const start = Date.now();
      do {
        ask = await runner.evaluate<{ id: string; kind: string } | undefined>(
          `chrome.storage.local.get(${JSON.stringify(askKey)}).then(x => x[${JSON.stringify(askKey)}]?.find(a => a.action === ${JSON.stringify(command.kind)}))`,
        );
        if (ask) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (Date.now() - start < 6000);
      if (!ask) {
        const outcome = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve(null), 20))]);
        throw new Error(`No approval for ${command.kind}: ${JSON.stringify(outcome)}`);
      }
      if (command.kind === "type" || (command.kind === "click" && response !== "deny"))
        assert.equal(ask.kind, "interaction");
      await runner.evaluate(
        `chrome.runtime.sendMessage(${JSON.stringify({ kind: "openbot-browser-answer", id: ask.id, choice: response })})`,
      );
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`No browser result for ${command.kind}`)), 20_000);
      }),
    ]).finally(() => clearTimeout(timer));
    assert.equal(result.id, token);
    return result;
  }
  async function success(request: ClientBrowserCommand, response?: "always" | "once") {
    const answer = await command(request, response);
    if (!answer.ok) throw new Error(`${request.kind}: ${answer.code}: ${answer.error}`);
    return answer.result;
  }
  const opened = await success({ kind: "open", url: `${origin}/` }, "always");
  assert.ok(opened.tab);
  const tabId = opened.tab.id;
  const same = await success({ kind: "open", url: `${origin}/` });
  assert.equal(same.tab?.id, tabId);
  const page = context.pages().find((page) => page.url() === `${origin}/`);
  assert.ok(page);
  assert.equal(context.pages().filter((page) => page.url() === `${origin}/`).length, 1);
  report.cases.push("Opened and reused one real Chrome tab");
  const read = await success({ kind: "snapshot", tabId });
  for (const expected of ["Pilot test dashboard", "type Aircraft", "select Status", "Apply filter", "Second page"])
    assert.ok(read.text.includes(expected), `Missing ${expected}`);
  for (const privateText of ["fixture-private", "HIDDEN FIXTURE TEXT", "type Password"])
    assert.ok(!read.text.includes(privateText));
  report.cases.push("Read public text, links and visible control labels, not password or hidden text");
  const fieldRef = /\[([^\]]+)\] type Aircraft/u.exec(read.text)?.[1];
  assert.ok(fieldRef);
  await success({ kind: "type", tabId, target: { ref: fieldRef }, text: "TEST-01", submit: false }, "once");
  await success({ kind: "type", tabId, target: { text: "Status" }, text: "Resolved", submit: false }, "once");
  assert.equal(await page.getByLabel("Aircraft").inputValue(), "TEST-01");
  assert.equal(await page.getByLabel("Status").inputValue(), "Resolved");
  const button = { kind: "click", tabId, target: { text: "Apply filter" } } as const;
  assert.deepEqual((await command(button, "deny")).ok, false);
  assert.equal(await page.locator("output").textContent(), "");
  await success(button, "once");
  await success({ kind: "wait_for", tabId, text: "Filter result: TEST-01 Resolved" });
  assert.equal(await page.locator("output").textContent(), "Filter result: TEST-01 Resolved");
  report.cases.push(
    "Approved typing and dropdown selection; denied click did nothing; approved click updated the dashboard; wait found the result",
  );
  await success({ kind: "scroll", tabId, deltaX: 0, deltaY: 550 });
  assert.ok((await page.evaluate(() => window.scrollY)) > 0);
  const denied = await command({ kind: "navigate", tabId, url: `${other}/second` }, "deny");
  assert.ok(!denied.ok && denied.code === "denied");
  assert.equal(page.url(), `${origin}/`);
  report.cases.push("Scrolled and denied a cross-origin navigation without leaving the page");
  const link = await success({ kind: "click", tabId, target: { text: "Second page" } });
  assert.equal(link.tab?.id, tabId);
  assert.equal(page.url(), `${origin}/second`);
  await success({ kind: "navigate", tabId, direction: "reload" });
  assert.match((await success({ kind: "snapshot", tabId })).text, /Second fixture page/u);
  report.cases.push("Followed a link and reloaded in the same tab");
  report.passed = true;
} finally {
  await context?.close();
  fixture.closeAllConnections();
  fixture.close();
  const out = resolve(".openbot-build/chrome-pilot-e2e");
  await mkdir(out, { recursive: true });
  await writeFile(resolve(out, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
