# Chrome browser pilot

This is a local OpenBot fork experiment for a home Chrome profile. It uses the existing OpenBot extension connection and site approval. The normal OpenBot build is unchanged.

Build from `apps/browser-extension` with `bun run build --mode chrome-pilot`. The separate unpacked build is in `dist-chrome-pilot`. It has no debugger or cookies permission. A new unpacked extension ID cannot use OpenBot production web sign-in. Use the supported email-code option if available or a development host. Do not copy an account token or impersonate the store extension.

The browser action path allows only the open, snapshot, and same-tab navigate commands for public English Wikipedia articles. It sends article text and link URLs to the paired OpenBot host after site approval. It does not read password fields or release the Chrome profile to the agent. Treat article text as untrusted. Do not try to use this pilot to work around employer policy.

Acceptance test in a home Chrome profile with the pilot paired: open Wikipedia's Beaver article first. Ask OpenBot to reuse that tab, summarize the article, follow the North American beaver link, and summarize it. Check that the original tab navigates and no duplicate tab opens. Check that the agent refuses to navigate to another site. Do not accept a run via desktop Computer Use or the embedded browser as a pilot pass.
