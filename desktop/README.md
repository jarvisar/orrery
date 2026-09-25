# Orrery for the desktop

The web app in its own window, for Windows, Linux (including the Steam Deck)
and macOS, built with [Electron](https://www.electronjs.org/).

It is a wrapper, not a fork. There is no copy of the site in here: in
development the window serves the repository's working tree directly, and a
release packages exactly the files GitHub Pages deploys
(`scripts/lib/served.js`). Change the site, and the app changes with it.

```sh
npm run desktop:setup    # once: installs Electron and electron-builder into desktop/
npm run desktop          # the app, on your working tree; Ctrl+R reloads after an edit
npm run desktop -- --debug   # the same with ?debug and the dev tools open
```

## What it adds over the browser

- **Its own window.** No tabs or address bar. It remembers its size, position,
  maximised or full screen, and zoom. F11 toggles full screen, Ctrl + plus,
  minus and 0 zoom the interface, and a second launch brings the running
  window forward instead of opening another.
- **The fast GPU.** The renderer already asks for `powerPreference:
  'high-performance'`, which browsers on Windows mostly ignore. On a laptop
  with two GPUs, the app runs on the discrete one. `--low-power-gpu` keeps it
  on the integrated one.
- **Full screen from a controller.** A browser only goes full screen after a
  click or a key press, so the controller's View button has to ask for one
  first. The app goes full screen straight away.
- **It still runs without GPU WebGL.** Where a browser would stop at "WebGL
  unavailable" (a blocklisted driver, remote desktop, a GPU that keeps
  crashing), the app restarts itself with software rendering. Repeated
  crashes of the page do the same.
- **Offline, and quick to start.** Every file is on disk, and compiled
  JavaScript is cached between runs. The service worker is skipped, since
  offline copies would only duplicate what is already there.
- **Steam Deck Game Mode.** It starts full screen under gamescope, and Steam
  Input's controller works like any other.
- **It keeps itself up to date.** See [Updates](#updates).

Everything else is the web app unchanged. Browser-only features stay hidden:
the install prompt never appears, and WebXR finds no headset. For VR, use the
browser.

## How it fits together

```
desktop/
  src/main.js           the window, flags, permissions, and where links go
  src/protocol.js       serves the site from app://orrery/
  src/preload.cjs       window.orreryDesktop: all the page learns about being here
  src/csp.js            the Content-Security-Policy, and the remote origins it allows
  src/mime.js           content types for served files
  src/menu.js           the macOS menu; keyboard shortcuts on Windows and Linux
  src/window-state.js   remembers the window between runs
  src/self-test.js      --self-test: start, check, exit 0 or 1
  src/updates.js        auto-update from GitHub Releases
  src/identity.js       the app id and names
  builder.config.js     what each platform's installer is (electron-builder)
  build/                icons, drawn from public/icon/orrery.svg by scripts/icons.js
  scripts/              build, smoke test, sync check, icons, version sync
  web/  dist/           staged site and build output; never committed
```

**Why `app://` and not `file://`.** The site is ES modules behind an import
map, and it fetches its textures and star catalogue. Chromium gives every
`file://` URL its own opaque origin, which breaks all of those, and
localStorage with them. `src/protocol.js` registers `app://orrery/` as a
privileged, secure, standard scheme, so the page behaves exactly as it does on
`https://`: fetch, modules, storage, clipboard and pointer lock all work.

**Where the web app knows about this.** There are four short hooks, each
commented, and each checked by `npm run desktop:check`. Search `src/` for
`orreryDesktop` to find them:

| Where | What it does |
| --- | --- |
| `src/main.js`, `registerServiceWorker` | skips the service worker |
| `src/main.js`, `copyLink` | shares `https://jarvisar.github.io/orrery/?…` rather than `app://` |
| `src/ui/fullscreen.js`, `toggleFullscreen` | enters full screen without waiting for a key press |
| `src/ui/UpdateToast.js` | the "Update available" toast, for copies that cannot update themselves |

In a browser `window.orreryDesktop` is undefined, and each hook does nothing.

**Security.** The page runs sandboxed with context isolation and no Node.js.
It can request full screen, pointer lock and clipboard *writes*. Every other
permission is refused. Links to other sites open in the system browser, and
the window never navigates away from `app://orrery/`.

## Keeping it in step with the site

Most changes to the site need nothing here. These are the exceptions, and
`npm run desktop:check` catches every one of them:

| When the site… | …the desktop app needs | Checked by |
| --- | --- | --- |
| gains a new top-level file or folder | an entry in `scripts/lib/served.js` (Pages needs it too) | `npm run check` |
| serves a new kind of file (`.ktx2`, `.wasm`, `.mp3`…) | its type in `src/mime.js` | `desktop:check` |
| fetches from a new origin (a CDN, an API) | the origin in `REMOTE_ORIGINS`, `src/csp.js` | `desktop:check` |
| links to a new site | the origin in `LINK_ORIGINS`, `src/csp.js` | `desktop:check` |
| changes `public/icon/orrery.svg` | `npm run icons` in `desktop/` | `desktop:check` |
| changes version | nothing: `npm version` syncs `desktop/package.json` | `desktop:check` |
| needs a new permission (camera, geolocation…) | the name in `PERMISSIONS`, `src/main.js` | self-test, if it fails at startup |
| starts sharing its own URL, or waits on a user gesture | a hook like the ones above | `desktop:check`, partly |

Then run it:

```sh
npm run desktop:check    # the table above; no install needed
npm run desktop:smoke    # launches the app on your working tree and checks it came up
```

The smoke test (`src/self-test.js`) loads the page and waits for the scene. It
fails on any console error, which includes CSP violations and uncaught
exceptions. It also fails on any file the app could not serve, a renderer
crash, the "WebGL unavailable" screen, or a loading screen that never lifts.
It then visits `tetris.html`. In development the app serves only what
`served.js` ships, so a missing entry shows up as a 404 here and not in a
release.

## Building

```sh
npm run desktop:build              # installers for this machine's platform, in desktop/dist/
cd desktop && npm run pack         # unpacked only (dist/*-unpacked), much faster
npm run desktop:smoke -- --packaged    # launch that build and check it
```

| Platform | Output | Build on |
| --- | --- | --- |
| Windows x64 | `Orrery-<v>-win-x64-setup.exe` (installer, per user), `…-portable.exe` | Windows |
| Linux x64 | `Orrery-<v>-linux-x86_64.AppImage`, `…-linux-amd64.deb`, `…-linux-x64.tar.gz` | Linux or macOS |
| macOS | `Orrery-<v>-mac-arm64.dmg` (Apple silicon), `…-mac-x64.dmg` (Intel) | macOS |

electron-builder cannot make a DMG or an AppImage on Windows, so
`.github/workflows/desktop.yml` builds all three. It runs on every push to
`main` and on every pull request. Each platform is built, its packaged app is
launched with `--self-test`, and the installers are uploaded as artifacts,
along with a screenshot of what the app drew. That screenshot is the way to see
the Mac build working without a Mac. To fetch the latest build:

```sh
gh run list --workflow desktop.yml --branch main --limit 1
gh run download <run id> --name orrery-linux    # or orrery-win, orrery-mac, screenshot-mac
```

### Updates

Installed copies check GitHub Releases 15 seconds after starting and every six
hours after that. What happens next depends on how the app was installed:

| Installed as | When there is a newer release |
| --- | --- |
| Windows installer (`…-setup.exe`) | downloads it in the background and installs it when the app quits |
| Linux AppImage | the same: the AppImage replaces itself when the app quits |
| Windows portable, macOS, Linux `.deb` / `.tar.gz` | an "Update available" toast in the corner; **Download** opens the release page |

The portable build, unsigned Mac builds and system packages cannot replace
themselves safely, so they only tell you. Only **published** releases count;
a draft is invisible to every copy. Checks never run in development, in a
self-test, or with `--no-updates`. A failed check (offline, GitHub down, a
broken feed) is one line in the log and nothing else.

Updates depend on files the release workflow uploads next to the installers:
`latest.yml` (Windows), `latest-linux.yml` (AppImage) and the `.blockmap` files
that let an update download only what changed. The release job refuses to
draft a release without the two `.yml` files. The packaged app's self-test
fails if electron-updater or its `app-update.yml` is missing from the build.

**Testing an update without releasing one.** Build the current version, then
a newer one with `--version`. Serve the newer one's `latest.yml`, setup `.exe`
and `.blockmap` from any local web server, and point the older copy at it with
`ORRERY_UPDATE_FEED`:

```sh
cd desktop
npm run build                              # e.g. 2.1.1: install this one
mv dist dist-old
npm run build -- --version=2.1.2           # the "new release"
npx http-server dist -p 8765               # or any static server
ORRERY_UPDATE_FEED=http://127.0.0.1:8765/ "<install dir>/Orrery.exe"
# log: "2.1.2 is available; downloading" … "downloaded; it installs when the app quits"
# quit it, and the install is now 2.1.2
```

Setting `PORTABLE_EXECUTABLE_FILE=x` as well puts an unpacked build in the
"tell, don't install" mode, which shows the toast.

### Releasing

```sh
npm version minor            # or patch / major: bumps both package.json files, commits, tags
git push --follow-tags       # the tag builds everything and drafts a GitHub release
```

The release is a **draft**: check the installers on the Releases page, then
publish it. Publishing is also what makes installed copies update. The
workflow refuses a tag that does not match `package.json`.

## Installing

**Windows.** Run the setup `.exe`. It installs for your user only, so it needs
no administrator rights, and keeps itself up to date. Or keep the portable
`.exe` anywhere; it tells you about updates rather than installing them. Both
builds are unsigned, so SmartScreen warns on first run: choose *More info →
Run anyway*.

**Steam Deck.** In Desktop Mode:

1. Download the `.AppImage` to somewhere permanent, e.g. `~/Applications`.
2. Right-click it, then *Properties → Permissions → Is executable*. Or run
   `chmod +x Orrery-*.AppImage`.
3. In Steam: *Games → Add a Non-Steam Game to My Library*, browse to the
   AppImage, and add it.
4. Back in Game Mode it is in your library under *Non-Steam*. It starts full
   screen. Steam Input's default gamepad layout works: sticks, triggers, D-pad
   and buttons all map as the README describes.

If the screen stays black in Game Mode, add `--ozone-platform=x11` to the
shortcut's launch options in Steam (*Properties → Launch Options*). If WebGL
reports the wrong GPU, run the AppImage with `--self-test` from Konsole: it
prints what WebGL is running on.

**Other Linux.** The AppImage runs on most distributions. On Ubuntu 24.04 and
later, AppArmor blocks the sandbox an AppImage relies on. Either install the
`.deb` (`sudo apt install ./Orrery-*.deb`), which installs a profile that
allows it, or start the AppImage with `--no-sandbox`.

**macOS.** Open the DMG that matches your Mac (arm64 for Apple silicon, x64
for Intel) and drag Orrery to Applications. The app is ad-hoc signed but not
notarized, so macOS refuses it the first time. On macOS 15 and later, try to
open it once, then go to *System Settings → Privacy & Security → Open Anyway*.
On older versions, right-click the app and choose *Open*. Or, in Terminal:

```sh
xattr -dr com.apple.quarantine /Applications/Orrery.app
```

### Signing

Unsigned builds work but come with the warnings above. The workflow signs
automatically when these repository secrets exist:

| Secret | For |
| --- | --- |
| `MAC_CERTIFICATE`, `MAC_CERTIFICATE_PASSWORD` | a *Developer ID Application* certificate, as a base64 `.p12`, and its password |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | notarization, so Gatekeeper opens the app without a prompt |
| `WIN_CERTIFICATE`, `WIN_CERTIFICATE_PASSWORD` | a Windows code-signing certificate, as a base64 `.pfx` |

With a Mac certificate, `builder.config.js` switches from ad-hoc signing to
the hardened runtime with notarization. Nothing else changes.

## Flags

Pass these after `--` with npm (`npm run desktop -- --fullscreen`), or directly
to the installed app:

| Flag | |
| --- | --- |
| `--fullscreen` | start full screen (automatic in Steam Deck Game Mode) |
| `--debug` | open `?debug` and the dev tools |
| `--low-power-gpu` | stay on the integrated GPU |
| `--software-gl` | render WebGL on the CPU (chosen automatically when the GPU cannot) |
| `--web-root=<dir>` | serve another copy of the site, e.g. `desktop/web` after `npm run stage` |
| `--no-updates` | never check for a newer release |
| `--self-test` | start, check everything came up, exit 0 or 1 |
| `--screenshot=<png>` | with `--self-test`, save what the window showed |

Chromium's own switches work too, e.g. `--ignore-gpu-blocklist` or
`--ozone-platform=x11`.

**Running from VS Code.** VS Code sets `ELECTRON_RUN_AS_NODE` for processes
its extensions start, and with it set, Electron runs as plain Node and no
window opens. The npm scripts clear it (`scripts/electron.js`). Launching
Electron some other way from inside VS Code needs the same.
