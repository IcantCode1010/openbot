# Chrome browser pilot

This OpenBot fork experiment uses the existing extension connection and the current Chrome profile. The normal OpenBot build is unchanged.

From the cloned repository, run `bun install --frozen-lockfile`, then run `bun run build --mode chrome-pilot` from `apps/browser-extension`. Use Chrome's **Load unpacked** for `apps/browser-extension/dist-chrome-pilot` only where policy permits it. A new unpacked extension ID cannot use OpenBot production web sign-in. Use the supported email-code option if available or a development host. Do not copy account tokens or impersonate the store extension.

The pilot can open and reuse tabs, read visible page text and links, and navigate in the same tab on supported HTTP(S) sites. At the site approval card, Chrome asks for access to that host if it has not granted it yet. **Allow once** approves one OpenBot operation; Chrome can retain its host permission, but OpenBot asks again on the next operation. **Always for this site** saves the OpenBot decision for that origin, including its port. To revoke access, remove it in OpenBot's browser settings or Chrome's extension site-access settings. Cross-site navigation requires both sites to be approved. Unexpected cross-site redirects are not read.

Visible page text and URLs can be sensitive, including in signed-in pages. Read only sites and content you are authorized to share with the paired OpenBot host and agent provider. The pilot does not use debugger or cookie permissions, enter text, submit forms, read form fields, read cross-origin frames, take screenshots, or use Chrome settings pages. Policies can restrict site access or extension installation. OpenBot's noncommercial license still applies.

Acceptance test: start on Wikipedia's Beaver article. Ask OpenBot to summarize it and navigate to the North American beaver link in the same tab. Repeat the same pattern on a different approved site, such as an HTTPS docs site. Verify the tab is reused and Chrome and OpenBot ask before granting a new site's access. Do not accept a desktop Computer Use or embedded browser run as a pilot pass.
