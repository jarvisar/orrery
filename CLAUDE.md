# Orrery

An interactive 3D solar system: plain ES modules, three.js vendored, no build
step. `README.md` explains the site; `desktop/README.md` explains the desktop
app (Electron) that wraps it.

## Always keep the desktop app in step with the site

After **every** change to the site (`src/`, `index.html`, `style.css`,
`tetris.html`, `sw.js`, `public/`, `vendor/`, or any new top-level file), update
the desktop app to match before calling the work done:

1. Run `npm run check` and `npm run desktop:check`, and fix whatever they
   report. Each message names the file to edit (`scripts/lib/served.js`,
   `desktop/src/mime.js`, `desktop/src/csp.js`, icons, version).
2. Run `npm run desktop:smoke` (after `npm run desktop:setup` once) and make
   sure it passes.
3. If the change shares the page's own URL, waits on a user gesture (full
   screen, pointer lock), needs a new browser permission, touches the service
   worker, or changes the toasts (`src/ui/UpdateToast.js` is how some desktop
   copies hear of updates), update the matching `window.orreryDesktop` hook or
   `desktop/src/` code. The desktop-sync skill has the details.

The desktop app serves the site's own files. Never copy site code into
`desktop/`; keep any web-app hook to a commented line or two keyed on
`window.orreryDesktop`, so the site behaves the same in a browser.

## Checks

```sh
npm run check && npm run smoke     # the site
npm run desktop:check && npm run desktop:smoke   # the desktop app
```

A published GitHub release is what installed desktop copies auto-update to,
so never publish one that is broken; ship a fix as the next patch release.

## Authorship

The user is the only author. Never add `Co-Authored-By` trailers, "Generated
with" lines, or any other credit to Claude in commits, PRs, releases or files.
