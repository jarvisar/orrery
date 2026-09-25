# Orrery Desktop App

The Orrery web app in its own window for Windows, Linux (including the Steam Deck) and macOS, built with [Electron](https://www.electronjs.org/).

The app doesn't have its own copy of the site. In development it serves the repository's files directly, and a release packages the same files GitHub Pages deploys (listed in `scripts/lib/served.js`). Any change to the site also changes the app.

```sh
npm run desktop:setup        # once, installs Electron and electron-builder into desktop/
npm run desktop              # run the app, Ctrl+R reloads after an edit
npm run desktop -- --debug   # run with ?debug and the dev tools open
```

## Features

- Its own window that remembers its size, position, full screen and zoom. F11 toggles full screen and Ctrl +/-/0 changes the zoom. Opening the app again brings the existing window forward.
- Uses the dedicated GPU on laptops with two GPUs. Use `--low-power-gpu` to stay on the integrated one.
- The controller's View button goes full screen right away, without needing a click or key press first.
- Falls back to software rendering if WebGL isn't available on the GPU or the page keeps crashing.
- Works offline, since every file is included. The service worker is disabled.
- Starts full screen in Steam Deck Game Mode, and Steam Input works like any other controller.
- Updates itself (see [Updates](#updates)).

Everything else works the same as the website. The install prompt is hidden, and VR is only available in the browser.

## Project Structure

```
desktop/
  src/main.js           the window, flags, permissions and links
  src/protocol.js       serves the site from app://orrery/
  src/preload.cjs       window.orreryDesktop, the only thing the page knows about the app
  src/csp.js            the Content-Security-Policy and allowed remote origins
  src/mime.js           content types for served files
  src/menu.js           the macOS menu and keyboard shortcuts
  src/window-state.js   saves the window size and position
  src/self-test.js      --self-test: starts, checks and exits with 0 or 1
  src/updates.js        auto-updates from GitHub Releases
  src/identity.js       the app id and names
  builder.config.js     installer settings for each platform (electron-builder)
  build/                icons, generated from public/icon/orrery.svg by scripts/icons.js
  scripts/              build, smoke test, sync check, icons and version sync
  web/, dist/           staged site and build output, never committed
```

The site is served from `app://orrery/` instead of `file://`. With `file://`, ES modules, fetch and localStorage don't work properly.

The web app checks for `window.orreryDesktop` in four places. Each one is commented and checked by `npm run desktop:check`:

| Where | What it does |
| --- | --- |
| `src/main.js`, `registerServiceWorker` | skips the service worker |
| `src/main.js`, `copyLink` | copies a `https://jarvisar.github.io/orrery/` link instead of `app://` |
| `src/ui/fullscreen.js`, `toggleFullscreen` | goes full screen without waiting for a key press |
| `src/ui/UpdateToast.js` | shows the "Update available" message for copies that can't update themselves |

In a browser, `window.orreryDesktop` is undefined and none of these do anything.

The page runs sandboxed with context isolation and no Node.js access. It can only use full screen, pointer lock and clipboard writes. Links to other sites open in your browser.

## Keeping It in Sync With the Site

Most changes to the site don't need anything here. These do, and the checks catch each one:

| When the site... | The app needs | Checked by |
| --- | --- | --- |
| adds a top-level file or folder | an entry in `scripts/lib/served.js` | `npm run check` |
| serves a new file type (`.ktx2`, `.wasm`, `.mp3`...) | its type in `src/mime.js` | `desktop:check` |
| loads something from a new site (a CDN or API) | the origin in `REMOTE_ORIGINS` in `src/csp.js` | `desktop:check` |
| links to a new site | the origin in `LINK_ORIGINS` in `src/csp.js` | `desktop:check` |
| changes `public/icon/orrery.svg` | `npm run icons` in `desktop/` | `desktop:check` |
| changes version | nothing, `npm version` updates `desktop/package.json` | `desktop:check` |
| needs a new permission (camera, location...) | its name in `PERMISSIONS` in `src/main.js` | the smoke test |
| copies its own URL or waits for a click | a hook like the ones above | `desktop:check`, partly |

```sh
npm run desktop:check    # the table above, no install needed
npm run desktop:smoke    # launches the app and checks that it starts
```

The smoke test fails on any console error (including CSP violations), any file the app couldn't serve, a crash, the "WebGL unavailable" screen, or a loading screen that never goes away. It also opens a few exoplanet systems and `tetris.html`.

## Building

```sh
npm run desktop:build                  # installers for this platform in desktop/dist/
cd desktop && npm run pack             # unpacked build only, much faster
npm run desktop:smoke -- --packaged    # launch the build and check it
```

| Platform | Output | Build on |
| --- | --- | --- |
| Windows x64 | `Orrery-<v>-win-x64-setup.exe` (installer), `...-portable.exe` | Windows |
| Linux x64 | `Orrery-<v>-linux-x86_64.AppImage`, `...-linux-amd64.deb`, `...-linux-x64.tar.gz` | Linux or macOS |
| macOS | `Orrery-<v>-mac-arm64.dmg` (Apple silicon), `...-mac-x64.dmg` (Intel) | macOS |

electron-builder can't make a DMG or AppImage on Windows, so `.github/workflows/desktop.yml` builds all three on every push to `main` and every pull request. Each build is launched with `--self-test`, and the installers and a screenshot from the Mac build are uploaded as artifacts. To download the latest build:

```sh
gh run list --workflow desktop.yml --branch main --limit 1
gh run download <run id> --name orrery-linux    # or orrery-win, orrery-mac, screenshot-mac
```

### Updates

The app checks GitHub Releases 15 seconds after starting and every six hours after that.

| Installed as | When there is a new release |
| --- | --- |
| Windows installer (`...-setup.exe`) | downloads it and installs it when the app closes |
| Linux AppImage | same as above |
| Windows portable, macOS, Linux `.deb` / `.tar.gz` | shows an "Update available" message with a link to the release |

Only published releases count, not drafts. The app doesn't check for updates in development, in the self-test, or with `--no-updates`. If a check fails, it's logged and ignored.

Updates need the `latest.yml`, `latest-linux.yml` and `.blockmap` files that the release workflow uploads with the installers. The workflow won't draft a release without the `.yml` files, and the packaged app's self-test fails if the updater is missing.

To test an update without releasing one, build the current version, then build a newer one with `--version`, serve it locally and point the older copy at it with `ORRERY_UPDATE_FEED`:

```sh
cd desktop
npm run build                              # e.g. 2.1.1, install this one
mv dist dist-old
npm run build -- --version=2.1.2           # the "new release"
npx http-server dist -p 8765
ORRERY_UPDATE_FEED=http://127.0.0.1:8765/ "<install dir>/Orrery.exe"
# quit the app and it updates to 2.1.2
```

Set `PORTABLE_EXECUTABLE_FILE=x` as well to test the "Update available" message instead.

### Releasing

Update the exoplanet data first, since the app includes the committed files:

```sh
npm run exoplanets:update && npm run stars:update
npm version minor            # or patch / major, updates both package.json files, commits and tags
git push --follow-tags       # the tag builds everything and drafts a GitHub release
```

Check the installers in the draft release, then publish it. Installed copies only update once it's published. The workflow won't build a tag that doesn't match `package.json`.

## Installing

**Windows:** Run the setup `.exe`. It installs for your user only, so it doesn't need administrator rights, and it updates itself. The portable `.exe` can be kept anywhere and shows a message when there's an update. Both are unsigned, so SmartScreen shows a warning the first time. Click *More info → Run anyway*.

**Steam Deck:** In Desktop Mode:

1. Download the `.AppImage` somewhere permanent, like `~/Applications`.
2. Right-click it, go to *Properties → Permissions* and check *Is executable*. Or run `chmod +x Orrery-*.AppImage`.
3. In Steam, go to *Games → Add a Non-Steam Game to My Library* and add the AppImage.
4. In Game Mode it's in your library under *Non-Steam*. It starts full screen and the default controller layout works.

If the screen stays black in Game Mode, add `--ozone-platform=x11` to the launch options in Steam (*Properties → Launch Options*). If WebGL uses the wrong GPU, run the AppImage with `--self-test` from Konsole to see which GPU it found.

**Other Linux:** The AppImage works on most distributions. On Ubuntu 24.04 and later, AppArmor blocks it. Install the `.deb` instead (`sudo apt install ./Orrery-*.deb`), or run the AppImage with `--no-sandbox`.

**macOS:** Open the DMG for your Mac (arm64 for Apple silicon, x64 for Intel) and drag Orrery to Applications. The app isn't notarized, so macOS blocks it the first time. On macOS 15 and later, try to open it, then go to *System Settings → Privacy & Security → Open Anyway*. On older versions, right-click the app and choose *Open*. Or run:

```sh
xattr -dr com.apple.quarantine /Applications/Orrery.app
```

### Signing

The workflow signs the builds if these repository secrets are set:

| Secret | For |
| --- | --- |
| `MAC_CERTIFICATE`, `MAC_CERTIFICATE_PASSWORD` | a *Developer ID Application* certificate as a base64 `.p12`, and its password |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | notarization, so macOS opens the app without a warning |
| `WIN_CERTIFICATE`, `WIN_CERTIFICATE_PASSWORD` | a Windows code signing certificate as a base64 `.pfx` |

Without them, the Windows build is unsigned and the Mac build is ad-hoc signed.

## Flags

Pass these after `--` with npm (`npm run desktop -- --fullscreen`), or to the installed app:

| Flag | |
| --- | --- |
| `--fullscreen` | start full screen (automatic in Steam Deck Game Mode) |
| `--debug` | open with `?debug` and the dev tools |
| `--low-power-gpu` | use the integrated GPU |
| `--software-gl` | render on the CPU (used automatically if the GPU can't) |
| `--web-root=<dir>` | serve a different copy of the site, like `desktop/web` after `npm run stage` |
| `--no-updates` | don't check for updates |
| `--self-test` | start, check that everything loaded, and exit with 0 or 1 |
| `--screenshot=<png>` | with `--self-test`, save a screenshot |

Chromium flags like `--ignore-gpu-blocklist` or `--ozone-platform=x11` also work.

If the app opens as plain Node with no window when launched from VS Code, it's because VS Code sets `ELECTRON_RUN_AS_NODE`. The npm scripts clear it (`scripts/electron.js`).
