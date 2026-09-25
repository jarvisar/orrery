---
name: desktop-build
description: Build, test and fetch the Orrery desktop app's installers - Windows (.exe), Linux/Steam Deck (.AppImage, .deb, .tar.gz), macOS (.dmg) - locally or from the Desktop GitHub workflow, and troubleshoot a build or a platform (Steam Deck Game Mode, Ubuntu sandbox, macOS Gatekeeper, GPU/WebGL). Use when asked to build, package, download or install the desktop app, or when a desktop build or CI job fails.
---

# Building the desktop app

Everything runs from the repository root. `desktop/README.md` is the full
reference.

## Locally

```sh
npm run desktop:setup                 # once, or after desktop/package-lock.json changes
cd desktop && npm run pack            # unpacked build for this OS in desktop/dist/*-unpacked (fast)
npm run desktop:smoke -- --packaged   # launch that build with --self-test; exit code is the verdict
npm run desktop:build                 # real installers for this OS in desktop/dist/
```

`scripts/build.js` stages the site into `desktop/web/` (via `scripts/stage.js`)
and takes the version from the root `package.json` every time, so a build can
never ship a stale copy or version.

Hosts: Windows builds on Windows, macOS on a Mac, Linux on Linux or a Mac.
A Linux build on Windows gets as far as `--linux --dir` (an unpacked tree), but
no AppImage or .deb. On this machine WSL cannot start (virtualization is off),
so Linux and macOS installers come from CI.

## From CI

`.github/workflows/desktop.yml` runs on every push to `main`, on pull
requests, on `v*` tags, and on demand. Each platform: `npm run check`,
`npm run desktop:check`, build, launch the packaged app with `--self-test
--software-gl`, upload the installers (`orrery-win`, `orrery-linux`,
`orrery-mac`) and a screenshot (`screenshot-<platform>`).

```sh
gh workflow run desktop.yml --ref <branch>          # start one by hand
gh run list --workflow desktop.yml --limit 5
gh run watch <run id>
gh run view <run id> --log-failed                   # when a job fails
gh run download <run id> --name orrery-linux --dir desktop/dist/ci
gh run download <run id> --name screenshot-mac --dir desktop/dist/ci   # then Read the PNG
```

The macOS screenshot is the only way to see the Mac build working without a
Mac. Look at it after any change that could affect macOS.

## Platform notes

- **Steam Deck**: use the AppImage. Desktop Mode: mark it executable, then
  *Add a Non-Steam Game* in Steam. It goes full screen by itself under
  gamescope. Black screen in Game Mode: launch option `--ozone-platform=x11`.
  To see what WebGL is running on, run the AppImage with `--self-test` from
  Konsole.
- **Ubuntu 24.04+**: AppArmor blocks the AppImage's sandbox. Install the .deb
  (it adds a profile) or pass `--no-sandbox`. CI works around it with
  `sysctl kernel.apparmor_restrict_unprivileged_userns=0`.
- **macOS**: ad-hoc signed unless the `MAC_CERTIFICATE*` / `APPLE_*` secrets
  exist, which switch on signing and notarization in `desktop/builder.config.js`.
  Users of unsigned builds need *Open Anyway* in Privacy & Security, or
  `xattr -dr com.apple.quarantine /Applications/Orrery.app`.
- **Windows**: unsigned unless `WIN_CERTIFICATE*` exist, so SmartScreen warns
  until then.
- **No GPU / WebGL unavailable**: the app restarts itself with
  `--software-gl`. `--low-power-gpu` keeps a two-GPU laptop on the integrated
  GPU.

## Auto-update

`desktop/src/updates.js`. The Windows installer and AppImage update
themselves on quit (electron-updater). Portable, Mac, .deb and .tar.gz show
the page's "Update available" toast (`src/ui/UpdateToast.js`). To test
without a release, build the current version, then a newer one with
`npm run build -- --version=x.y.z`. Serve the newer `latest.yml` + setup
`.exe` + `.blockmap` locally, and run the older one with
`ORRERY_UPDATE_FEED=http://127.0.0.1:<port>/`. Add `PORTABLE_EXECUTABLE_FILE=x`
for the toast mode. The log lines start `[orrery] update:`. A test install
leaves `%APPDATA%\Orrery` and `%LOCALAPPDATA%\orrery-desktop-updater` behind;
uninstall with `"Uninstall Orrery.exe" /S` and remove both afterwards.
`desktop/README.md`, "Updates", has the full recipe.

## When a build fails

1. `npm run desktop:check`: most failures are the site changing under the app
   (see the desktop-sync skill).
2. Self-test failures print the reason: `404 <path>` means a file is missing
   from `scripts/lib/served.js` or the staged copy, `console.error` means the
   page threw or the CSP blocked something, and `timed out` means a hang
   (in CI, usually software WebGL being slow). `electron-updater is not in the
   packaged app` means it was moved to devDependencies; `no app-update.yml`
   means `publish` was removed from `desktop/builder.config.js`.
3. electron-builder errors: check `desktop/builder.config.js` against
   https://www.electron.build. Artifact names come from `artifactName` there;
   the workflow uploads `*.exe *.AppImage *.deb *.tar.gz *.dmg` from
   `desktop/dist/`.
