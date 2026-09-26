# Development

[Back to the README](../README.md)

## Running Locally

```sh
npm install
npm run dev     # http://localhost:5173
```

There is no build step. The dev server serves the repository as is, so what you see locally is what gets deployed. Add `?debug` to the URL to access the scene, camera and clock from the console through `window.orrery`.

## Checks

```sh
npm run check       # syntax, vendored three.js, textures, models, fonts and links
npm run smoke       # loads the page in headless Chrome and fails on any error
npm run responsive  # layout and accessibility at ten screen sizes
npm run vr          # an emulated Quest 3: controllers, hands and the VR panel
npm run gamepad     # an emulated game controller: bindings, menus and full screen
```

The browser checks use your local installation of Chrome and skip themselves if it isn't found. Pass `--strict` to make a missing Chrome a failure (CI does this). `npm run responsive -- --shots=dir`, `VR_SHOTS=dir` and `GAMEPAD_SHOTS=dir` save screenshots.

Exoplanet data and checks:

```sh
npm run exoplanets:update   # download the latest NASA catalogue
npm run stars:update        # download the latest binary and multiple star data
npm run exoplanets:verify   # check that every system in the data can be drawn
npm run exoplanets:test     # unit tests for the exoplanet models and data
npm run exoplanets:smoke    # the star systems atlas and exoplanet systems in Chrome
```

See the [exoplanet notes](exoplanets.md) for more details.

## Desktop App

The desktop app in `desktop/` loads the site's own files. In development it serves this folder, and a release packages the same files GitHub Pages deploys.

```sh
npm run desktop:setup   # once, installs Electron into desktop/
npm run desktop         # run the app, Ctrl+R reloads after an edit
npm run desktop:check   # check the app is in sync with the site
npm run desktop:smoke   # launch the app and check it starts
npm run desktop:build   # build installers for this platform into desktop/dist/
```

See [desktop/README.md](../desktop/README.md) for more details.

## Deploying

`.github/workflows/deploy.yml` deploys to GitHub Pages on every push to `main` and every Monday. It runs the checks, downloads the latest exoplanet data, copies the files listed in `scripts/lib/served.js` and uploads them.

`scripts/stamp-sw.js` adds every deployed file and its hash to `sw.js`. The service worker uses that list to cache the site for offline use, and only downloads changed files after an update. The committed `sw.js` has an empty list, so `npm run dev` always loads the latest files.

The first time, go to *Settings → Pages* in the repository and set **Source** to **GitHub Actions**.

`.github/workflows/ci.yml` runs all of the checks on pull requests and other branches.

## Project Structure

```
src/
  data/       solar system measurements, exoplanet data, tours and moments
  sim/        Kepler solver, reference frames and the clock
  scene/      planets, orbits, belts, the sky and shaders
  camera/     camera focus, the overview and flight mode
  core/       renderer, post-processing, asset loading, settings and picking
  ui/         the interface
  xr/         VR
vendor/three/ three.js
public/       textures, models, fonts and data
scripts/      dev server, checks, deployment and asset tools
desktop/      the Electron app
```

`src/data/bodies.js` has the measurements for every planet and moon. Exoplanet data is in `public/data/exoplanets.json` and is turned into systems by `src/data/exoplanets.js`. All real distances go through `src/scene/scaling.js` before they are drawn.

Exoplanets and their stars have no image textures. `src/data/worlds.js` decides what each one probably looks like, and `src/scene/worldTextures.js` paints its maps on the GPU when the system opens. See [How They Look](exoplanets.md#how-they-look).

three.js is copied into `vendor/three/` so the page doesn't load anything from a CDN. The only exception is VR controller models, which come from jsDelivr (simple shapes are drawn if they can't be loaded). To update three.js, change its version in `package.json` and run `npm run vendor`.

Textures and models are compressed from the original files with `scripts/optimize-textures.py` and `gltf-transform`. The originals are in the git history. The background sky is built from the Milky Way panorama and the Yale Bright Star Catalogue:

```sh
python scripts/build-sky.py 8k_stars_milky_way.jpg bsc5.dat
```

## Accuracy

- Planet positions use JPL's approximate orbital elements, which are valid between 1800 and 2050. Dwarf planet and moon orbits use average values.
- Axis orientation and rotation come from the IAU WGCCRE reports, so the seasons and the day side of each planet are correct.
- Eccentricity, inclination and axial tilt are real. Every moon here is tidally locked.
- Sizes and distances are compressed with one formula, `units = 24 × (km / Earth radius) ^ k`, in `src/scene/scaling.js`. The **Scale** setting changes `k`. Higher values are closer to real proportions.
- Moon orbits are measured from their planet's equator, except the Moon's.
- Stars are shown at their J2000 positions.
- Light doesn't fade with distance, otherwise everything past Jupiter would be dark.
- Saturn's ring shadows are calculated in the shader. The optional shadows in Settings let moons shadow their planets and are off by default.

![The Ocean Worlds tour, at Europa](screenshot-tour.jpg)
