const { app, shell } = require("electron");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { writeFileSync } = require("node:fs");
const path = require("node:path");
const outcomePath = path.join(__dirname, "pilot-result.txt");
app.setPath("userData", path.join(__dirname, ".pilot-profile"));

const reg = promisify(execFile);
async function readDefaultHttpsHandler() {
  if (process.platform !== "win32") throw new Error("This smoke test requires Windows.");
  const { stdout } = await reg("reg.exe", [
    "query",
    "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice",
    "/v", "ProgId",
  ], { windowsHide: true });
  return stdout.match(/^\s*ProgId\s+REG_SZ\s+(\S+)\s*$/m)?.[1] ?? "";
}

app.whenReady().then(async () => {
  const { openHomeBrowser } = await import("./launch.mjs");
  await openHomeBrowser({ defaultHttpsHandler: readDefaultHttpsHandler, openExternal: (url) => shell.openExternal(url) });
  writeFileSync(outcomePath, "Windows accepted the Chrome launch. Verify the tab and session in Chrome.\n");
  app.exit(0);
}).catch((error) => {
  writeFileSync(outcomePath, "Pilot stopped: " + (error.code ?? error.message) + "\n");
  app.exit(1);
});

