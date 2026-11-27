# Home Chrome session test

Personal experiment based on OpenBot v0.80.0. This is a separate Electron test program, not a change to the OpenBot desktop app.

On Windows, with Chrome as the default HTTPS browser, run `npm ci`, `npm test`, then `npm start` from this directory. The test program hands one Amazon URL to Windows, then exits. Check that the site opens in regular Chrome and shows an existing sign-in. No login is submitted.

The launcher does not install a Chrome extension, attach DevTools, copy a browser profile, or read cookies or passwords. Windows and Chrome choose which eligible Chrome profile handles the link. This test does not implement tab selection, browser control, or automated workflow execution. Do not use this experiment to bypass browser or workplace policy.
