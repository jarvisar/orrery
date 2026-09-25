---
name: desktop-release
description: Release a new version of Orrery - the site and the desktop app together - by bumping the version, tagging, and publishing the GitHub release the Desktop workflow drafts with the Windows, Linux and macOS installers. Use when asked to cut, tag, publish or prepare a release or a new version.
---

# Releasing

The site and the desktop app share one version, the one in the root
`package.json`. A `v<version>` tag builds every installer and drafts a GitHub
release. Pages deploys from `main` regardless of tags.

**Authorship:** commits, tags and release notes are the user's alone. Never
add `Co-Authored-By` trailers, "Generated with" lines, or any other credit to
Claude or Claude Code.

## Steps

1. Start from a clean, up-to-date `main` with checks passing:

   ```sh
   git status && git pull
   npm run check && npm run desktop:check
   npm run desktop:smoke          # needs npm run desktop:setup once
   ```

2. Ask the user which bump (patch / minor / major) if they have not said.
   Then:

   ```sh
   npm version minor              # bumps package.json, syncs desktop/package.json
                                  # and its lockfile (the "version" script), commits, tags v<x.y.z>
   ```

   `npm version` uses the user's git identity. Check `git log -1` shows only
   them.

3. Confirm with the user before pushing: it publishes the site and starts
   the release build.

   ```sh
   git push --follow-tags
   ```

4. Watch the build, then check the draft:

   ```sh
   gh run list --workflow desktop.yml --limit 1
   gh run watch <run id>
   gh release view v<x.y.z>       # a draft: 2 .exe, .AppImage, .deb, .tar.gz, 2 .dmg, latest*.yml, *.blockmap
   ```

   Download `screenshot-mac` from the run and look at it before publishing.
   It is the only check on the Mac build. The draft must also hold
   `latest.yml`, `latest-linux.yml` and the `.blockmap` files; the job refuses
   to draft without the two `.yml` files.

5. Publishing is the user's call. When they say so:

   ```sh
   gh release edit v<x.y.z> --draft=false
   ```

   Publishing is what auto-update sees. Within six hours (or at the next
   start), Windows-installer and AppImage copies download it and install it on
   quit, and portable, Mac, .deb and .tar.gz copies show an "Update available"
   toast. Never publish a release that is broken: installed copies would
   update to it. Fix it with a new patch release instead.

## If something goes wrong

- **Tag does not match package.json**: the release job refuses. Delete the
  tag (`git tag -d v<x> && git push origin :refs/tags/v<x>`, only with the
  user's go-ahead) and use `npm version` rather than tagging by hand.
- **A platform's build failed**: the release job does not run. Fix it on
  `main`, then move the tag with the user's agreement, or release the next
  patch version.
- **Re-running a release build**: `gh run rerun <run id>`. `gh release create`
  fails if the draft already exists, so delete the old draft first
  (`gh release delete v<x.y.z>`, drafts only).
