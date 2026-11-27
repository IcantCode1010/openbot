# Chrome browser pilot

Use this pilot to run ordinary web tasks in the Chrome profile that has the extension. The normal OpenBot build is unchanged. The pilot does not request debugger or cookie access.

## Setup

From the repository, run `bun install --frozen-lockfile`. Then run `bun run build --mode chrome-pilot` from `apps/browser-extension`. Use Chrome's **Load unpacked** to load `apps/browser-extension/dist-chrome-pilot`. A new unpacked extension ID cannot use OpenBot production web sign-in. Use the supported email-code option if available, or build for a development host with `VITE_OPENBOT_API_URL` set to that host's account-service URL. Do not copy account tokens or use the store extension's identity.

## Tasks and approvals

In OpenBot chat, specify **my Chrome**, not the embedded browser. Ask it to open the address with `browser: "chrome"`, then use the same `chrome:` tab ID for subsequent steps. Tell it to stop if that Chrome connection is unavailable or if it cannot do a step; do not fall back to another browser.

The pilot opens or reuses tabs, reads visible text and links, lists visible controls, follows links, navigates to a URL, reloads, scrolls, and waits for visible text. It can enter text in supported fields, select a native dropdown option by its label, and click approved buttons. Use a fresh snapshot reference or one exact visible label. Use `type` with `submit: false`; request a separate button click to submit a supported form. Some sites ignore synthetic browser events or use custom widgets that this pilot cannot operate.

**Allow once** approves one OpenBot operation. **Always for this site** remembers read and navigation access for that origin, including its port. Clicks on buttons, text entry, and dropdown changes always need a separate one-time approval. Cross-origin navigation needs the destination's approval. Chrome can retain a host permission after **Allow once**; OpenBot still asks again. Revoke access in OpenBot or Chrome's extension site-access settings.

The pilot does not read field values in a snapshot, type into password, payment, or verification fields it can identify, read frames, take screenshots, simulate keyboard shortcuts, go back or forward, or operate Chrome settings. A page can navigate when clicked; inspect a fresh snapshot to check what changed. Chrome or OpenBot will not read a destination outside the approved scope. Only allow content that the paired OpenBot host and the agent provider are permitted to see.

## Verification

After the pilot build, run `node --experimental-strip-types scripts/chrome-pilot-e2e.ts` from the repository with Chrome for Testing installed by Playwright. The test uses a disposable profile and a test-only loopback grant. It checks real browser actions and OpenBot worker approvals; it does not test production sign-in or the Chrome permission dialog. Results go to `.openbot-build/chrome-pilot-e2e/report.json`.

The developer smoke test used the normal extension sign-in and chat screens with a disposable Chrome profile and a local dashboard. To repeat it with a paired agent, say: “Use my Chrome only. Open the test dashboard. Read it, set the ID and status, apply the filter, wait for the result, then follow a link in the same tab.” Verify the result in the page and that unrelated origins are denied rather than opened in a second browser.
