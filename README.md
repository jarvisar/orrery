# Orrery

An interactive 3D model of the solar system, built with [three.js](https://threejs.org/).

**[Open it →](https://jarvisar.github.io/solar-system/)**

Every body is placed by solving Kepler's equation against its real J2000 orbital
elements, so what you see is roughly where things actually are on the date shown
in the time bar. Sizes and distances are compressed — a true-to-scale solar
system is mostly empty space with sub-pixel planets in it — but every length
goes through the same power law, so the ordering and proportions survive it.
Pluto still ducks inside Neptune's orbit near perihelion.

Contains the Sun, eight planets, eleven moons, four dwarf planets, and the
asteroid and Kuiper belts.

![The whole system](docs/screenshot-system.jpg)

## Using it

Click any body to focus it, or pick one from the menu at the top. When bodies
are too small to see, labelled markers fade in — click those instead.

| | |
| --- | --- |
| **Drag** / **scroll** | Orbit and zoom |
| **Click** | Focus a body |
| **Esc** | Free view, or leave flight mode |
| **`[`** / **`]`** | Previous / next body |
| **Space** | Play or pause time |
| **`,`** / **`.`** | Slow down / speed up time (or drag the rate slider) |
| **R** / **N** | Reverse time / jump to now |
| **G** | Flight mode |
| **?** | Full list of controls |

In flight mode, **W**/**S** work the throttle, **A**/**D** roll, the mouse steers,
**Shift** boosts and **Space** is a full stop.

## Running it locally

```sh
npm install     # three.js, plus the tools used to rebuild assets
npm run dev     # http://localhost:5173
```

There is no build step. `npm run dev` serves the repository as-is, so what you
see locally is byte-for-byte what gets deployed.

```sh
npm run check   # syntax, vendored three.js, every texture and model reference
npm run smoke   # loads the real page in headless Chrome and fails on any error
npm run vendor  # re-copy three.js out of node_modules after a version bump
```

Because nothing is bundled, `npm run check` stands in for the errors a bundler
would normally catch: a stale vendored three.js, or a texture named in the
catalogue that is not actually shipped. `npm run smoke` catches the rest, by
loading the page and failing on any uncaught error, failed request or loading
screen that never lifts. It uses whatever Chrome is already installed and skips
itself if there is none.

## Deploying

`.github/workflows/deploy.yml` publishes to GitHub Pages on every push to
`main`. It runs the checks, stages only the files that are actually served, and
uploads them — there is nothing to compile.

**One-time setup:** in the repository, go to *Settings → Pages* and set
**Source** to **GitHub Actions**. Until that is switched over, the workflow will
run but the deployment step will fail.

`.github/workflows/ci.yml` runs the same checks on pull requests and on pushes
to other branches.

## How it is put together

```
src/
  data/bodies.js       every measurement, in real units — the catalogue
  sim/                 Kepler solver and the simulation clock
  scene/               scene graph, orbit paths, belts, ring shadows, scaling
  camera/              focus and framing, free flight
  core/                renderer, asset streaming, settings, picking
  ui/                  every panel, built in JS so each owns its own markup
vendor/three/          three.js, vendored — see below
scripts/               dev server, asset pipeline, vendoring
```

`src/data/bodies.js` is the only place any number about a real object lives.
Adding a body means adding an entry and a texture; nothing else needs to change.
`src/scene/scaling.js` is the only place those real units become scene units.

### three.js is vendored, not fetched

`vendor/three/` holds the exact three.js files the app imports, copied out of
`node_modules` by `scripts/vendor.js` and mapped in through an import map. The
page loads nothing from a third-party CDN at runtime.

To upgrade, bump `three` in `package.json` and run `npm run vendor`.

### Assets

Textures under `public/textures/` and models under `public/models/` are built
from the original source art by `scripts/optimize-textures.py` and
`gltf-transform`. The originals are not in the working tree; they are in the
git history if you need them.

The pipeline exists because the original art was 185 MB. An 8192×4096 bump map
costs 179 MB of VRAM once it is uploaded with mipmaps, and several of them were
being used on moons drawn eight pixels across. Sizes are now chosen from how
large each body actually renders.

Saturn's rings are stored as a 1024×1 radial strip rather than a 2048² sheet —
the rings only vary with radius, so the ring geometry carries a radial `U`
coordinate and the texture stores that one profile once. 4.5 MB became 1.7 KB.

## Notes on what is and is not accurate

- **Positions** use the J2000 elements from JPL's *Keplerian Elements for
  Approximate Positions of the Major Planets*, valid 1800–2050. Outside that
  range they drift. Dwarf-planet and satellite elements are mean values and are
  good enough to put a body on the right side of its primary, not to navigate by.
- **Eccentricity, inclination and axial tilt** are real. Retrograde rotation
  (Venus, Uranus, Pluto) and retrograde orbits (Triton) are real.
- **Sizes and distances** all go through one power law,
  `units = 24 × (km / Earth radius) ^ k`, defined in `src/scene/scaling.js`.
  Radii, orbits, moon distances and rings use the same `k`, so every ratio of
  two lengths is compressed the same way and nothing is tuned per category. The
  **Scale** setting is `k`: higher is closer to true proportions, with smaller
  bodies and wider orbits.
- **Moon orbits** are measured from their planet's equator, so Saturn's moons
  share the plane of its rings. The Moon, whose elements are referred to the
  ecliptic, is the one exception. Every moon here is tidally locked and keeps
  one face toward its planet.
- **Lighting** uses a point light with distance falloff disabled. Real
  inverse-square falloff leaves everything past Jupiter in the dark.
- **Ring shadows** — rings onto Saturn, and Saturn onto its rings — are solved
  analytically in the shader rather than with a shadow map. A point light's cube
  shadow map has about ten texels across a planet at Saturn's distance, which is
  enough to produce shadow acne and nothing else. The optional shadow map in
  Settings is off by default for the same reason.

## Credits

Planet and moon textures from [Solar System Scope](https://www.solarsystemscope.com/textures/)
and NASA/JPL imagery. Phobos and Deimos models from NASA's 3D resources.
three.js is MIT licensed; its licence travels with the vendored copy.
