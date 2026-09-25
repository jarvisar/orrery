---
name: desktop-sync
description: Keep the Electron desktop app (desktop/) in step with the Orrery web app. Use after changing the site - new top-level files, new asset types, new CDNs or APIs or external links, icon changes, new browser permissions, share links or full-screen/user-gesture logic, service worker changes - or when asked whether the desktop app still works, to run it, or to check it.
---

# Keeping the desktop app in step with the site

The desktop app wraps the site; it does not copy it. `npm run desktop` serves
the working tree, and a build packages exactly `scripts/lib/served.js`. So
most site changes need nothing. Work through this after any change to the site.

## 1. Run the checks

```sh
npm run check           # the site's own checks, including every tracked top-level entry being classified
npm run desktop:check   # everything the desktop app needs to know about the site; no install needed
```

Each failure message names the file to edit. The usual fixes:

| Failure | Fix |
| --- | --- |
| `X is new at the top level` (npm run check) | Add it to `SERVED` in `scripts/lib/served.js` if the page loads it, else to `NOT_SERVED` |
| `no content type for .ext files` | Add the extension to `desktop/src/mime.js` |
| `uses https://host, which the ... Content-Security-Policy does not know about` | Fetched at runtime: add to `REMOTE_ORIGINS` in `desktop/src/csp.js`. Link only: add to `LINK_ORIGINS` |
| `orrery.svg has changed since the desktop icons were drawn` | `npm run desktop:setup` if needed, then `npm run icons --prefix desktop` |
| `desktop/package.json is at X but the site is at Y` | `node desktop/scripts/sync-version.js` |
| `... without skipping it / copies the page address / waits for a click or key` | Restore the `window.orreryDesktop` hook in that file (see step 3) |

## 2. Launch it

Needs `npm run desktop:setup` once (installs Electron into `desktop/`).

```sh
npm run desktop:smoke                        # starts the app on the working tree, exits 0/1
npm run desktop:smoke -- --screenshot=shot.png   # then Read shot.png to see what it drew
```

The self-test fails on any console error (uncaught exceptions, CSP
violations), any file the app could not serve (in development only `SERVED`
entries are served, so a missing entry is a 404 here), the WebGL-unavailable
screen, or a loading screen that never lifts. Add `--software-gl` on a
machine without a GPU.

To look at it interactively: `npm run desktop` (or `npm run desktop -- --debug`
for `?debug` and the dev tools).

If Electron starts as plain Node ("does not provide an export named"), the
environment has `ELECTRON_RUN_AS_NODE=1` (VS Code sets it). The npm scripts
clear it. Launch through them, or unset it.

## 3. Changes that need a decision, not just a check

- **The page now shares its own URL** (anything copying `location.href`): in
  the desktop app that is `app://orrery/...`. Build it from
  `window.orreryDesktop?.webUrl ?? window.location.href`, as `copyLink` in
  `src/main.js` does.
- **Something now waits for a user gesture** (full screen, pointer lock,
  audio): a controller press is not one in a browser. The desktop app can
  supply one; see `requestFullscreen` in `desktop/src/preload.cjs` and the
  `orrery:request-fullscreen` handler in `desktop/src/main.js`. A new case
  follows the same pattern.
- **A new browser permission** (camera, geolocation, notifications...): add
  its Electron name to `PERMISSIONS` in `desktop/src/main.js`. Everything not
  listed is refused.
- **The service worker registration moved**: keep the `window.orreryDesktop`
  early return with it.
- **The toast area or the install toast changed**: `src/ui/UpdateToast.js`
  shares the `.toast` plate and corner, and is how portable and Mac users
  hear of updates. Keep it mounted (`npm run desktop:check` fails without a
  listener for `orreryDesktop?.onUpdateAvailable`).
- **A new page besides index.html and tetris.html**: it is served
  automatically if it is under `SERVED`. Links between pages stay inside the
  app. Links to other sites open in the system browser.

Keep web-app hooks to a line or two, commented, keyed on `window.orreryDesktop`
(undefined in a browser), so the site behaves identically without the wrapper.
`desktop/README.md` has the full table ("Keeping It in Sync With the Site").
