# Exoplanets

[Back to the README](../README.md)

Exoplanet systems use the same renderer as the solar system. Each system is converted into the same format as `src/data/bodies.js`, so orbits, labels, the camera, flight mode, the Scale setting and VR all work the same way. Opening a system loads a new page with `?system=` in the URL.

## Data

Planet and star data comes from the [NASA Exoplanet Archive](https://exoplanetarchive.ipac.caltech.edu/) through its [TAP service](https://exoplanetarchive.ipac.caltech.edu/docs/TAP/usingTAP.html). No API key is needed.

- Each planet uses its default published solution from the `ps` table (`default_flag=1`), so a planet's measurements and its star's measurements come from the same paper. Different planets in the same system can come from different papers.
- Distances come from the `pscomppars` (composite) table, and so do the sky positions and brightness of the stars you can click in the sky.
- If the default solution is missing a period, orbit size, eccentricity, or the star's mass, radius, temperature or spectral type, the composite table's value is used instead and labeled as such in the info panel.
- See the [column definitions](https://exoplanetarchive.ipac.caltech.edu/docs/API_TD_columns.html) for what each value means.

Binary and multiple star systems use data from the [Open Exoplanet Catalogue](https://github.com/OpenExoplanetCatalogue/open_exoplanet_catalogue) (MIT license). Only planets that are in the NASA data are shown, and NASA's count of stars in each system is the one used. If the catalogue lists more stars than NASA (usually a brown dwarf that NASA counts as a planet), its data isn't used for that system.

Companion star masses that aren't reported are estimated from temperature or spectral type using the main-sequence table from [Pecaut & Mamajek (2013)](https://www.pas.rochester.edu/~emamajek/EEM_dwarf_UBVIJHK_colors_Teff.txt). White dwarfs use a typical 0.6 M☉. Giant stars aren't estimated.

`scripts/update-stellar-systems.js` has a short list of corrections for known mistakes in the catalogue, like a period entered in years instead of days. Each one only applies while the catalogue still has the wrong value.

## Updating the Data

```sh
npm run exoplanets:update   # public/data/exoplanets.json and sky-hosts.json
npm run stars:update        # public/data/stellar-systems.json
```

Both scripts check the new data before saving it. If the download fails, the data is invalid, the catalogue is more than 5% smaller than before, or any system can't be drawn, the old file is kept.

`sky-hosts.json` lists the hosts bright enough to see without a telescope (V magnitude 6.5 or brighter), with where they are and how many planets they have. It's a few kilobytes, so the sky can load it without the whole catalogue. Each one is matched to the star the sky draws for it, and the few that the sky's star catalogue doesn't include can't be clicked. The two files are replaced together or not at all.

The deploy workflow runs both scripts on every push to `main` and every Monday. The desktop app includes whichever files are committed, so update them before a release.

The site checks NASA for new planets when its copy is more than a week old, or when you click **Refresh from NASA**. NASA's archive doesn't allow requests from other websites, so these go through my [CORS proxy](https://github.com/jarvisar/cors-proxy) (`PROXY_URL` in `src/core/ExoplanetCatalogue.js`). The planet names are downloaded first, then the rest of the data in pages of 700. If any page fails or doesn't match, the refresh is canceled and the saved data is kept. Updated data is saved in IndexedDB for offline use. Binary star data is only updated with each release.

## How Systems Are Modeled

- Orbits use the reported period, semi-major axis and eccentricity. If one of the period or semi-major axis is missing, it is calculated from the other using Kepler's third law and the star's mass. If the star's mass is missing, it is estimated from its surface gravity and radius. Unknown eccentricities are shown as circular orbits.
- Planets found with direct imaging or microlensing often only have a projected separation. If there is no period, that separation is used as the orbit size.
- Missing planet radii are estimated from mass using [Chen & Kipping (2017)](https://exoplanetarchive.ipac.caltech.edu/docs/pscp_calc.html), the same method NASA uses. Minimum mass (M sin i) is used if that's all there is.
- Missing star radii are calculated from luminosity and temperature, or from mass and surface gravity. Pulsars use a typical 12 km radius.
- Star colors are based on each star's temperature.
- Binary and multiple star systems are drawn when the Open Exoplanet Catalogue has enough data for the star orbits. Planets orbit either their own star or the center of mass of a pair.
- Most wide pairs only have a separation on the sky. If there is no period or orbit size, that separation is used as the orbit size (converted from arcseconds using NASA's distance if needed) and the period is calculated from the masses.
- If a pair's reported orbit size doesn't match its period and masses, the size is calculated from the period instead.
- Stars that can't be drawn are listed under the system in the info panel, and the atlas shows "host star only" or how many are shown. About 110 of the 432 multi-star systems show every star. Most of the rest have no companion data in the Open Exoplanet Catalogue, so only the host star is shown.
- Each star only lights its own planets.
- Systems where the planets would be too small to see next to a distant companion star, like Proxima Centauri, open on the host star's planets.

Every estimate is labeled in the info panel, along with the reported values, errors, limits and links to the papers. 32 of about 6,400 planets don't have enough data to draw an orbit. They are still listed in the info panel.

## How They Look

Very few exoplanets have been seen as more than a dot, so their appearance is a best guess from what has been measured: size, mass and how much light each planet gets. `src/data/worlds.js` makes the guess, and the info panel shows the reasoning behind it ("Drawn as").

- Each planet's equilibrium temperature is estimated from its star's luminosity and its orbit, averaged over an eccentric orbit. It is shown as "Model temperature".
- Planets are sorted by size: rocky below 1.6 R⊕, then sub-Neptunes, Neptunes and giants. Density is used when both mass and radius are measured. Planets with only a mass limit use it to pick a kind, although their drawn size stays a placeholder.
- Giant planets follow the classes of [Sudarsky et al. (2003)](https://doi.org/10.1086/374331):
  - ammonia clouds below about 150 K
  - white water clouds up to 350 K
  - clear blue skies up to 800 K
  - very dark hot Jupiters up to 1,400 K
  - glowing hot Jupiters above that
- Neptunes are blue when cold, and hazy when warm.
- Planets found by direct imaging are young and still hot from forming, so they glow a dull red or magenta.
- Rocky planets:
  - Hot enough to melt rock under the star (about 1,500 K): lava worlds.
  - Past the "cosmic shoreline" of [Zahnle & Catling (2017)](https://doi.org/10.3847/1538-4357/aa7846): airless. The shoreline is lowered for active red and orange dwarfs.
  - Otherwise, by the [Kopparapu et al. (2014)](https://doi.org/10.1088/2041-8205/787/2/L29) habitable zone limits:
    - Venus-like inside the zone
    - seas and clouds in it
    - frozen outside it
  - A tidally locked temperate planet around a red dwarf is drawn as an "eyeball" world: frozen except under its star.
- Planets close enough to their star are drawn tidally locked. Hot ones have a day side hotter than their night side, following [Cowan & Agol (2011)](https://doi.org/10.1088/0004-637X/729/1/54), with the hottest point a little east of noon.
- About 40% of cold giants get illustrative rings, and the info panel says so. No ring has been detected around an exoplanet.
- Stars are colored by temperature and darken toward the edge by the Eddington–Barbier relation. Granules are larger on giants, and spots are more common on cooler stars. White dwarfs, pulsars and brown dwarfs are drawn as what they are.
- Light from another star is shifted halfway to white, as eyes adapt, so an M dwarf's planets are not all orange.

About 25 planets have been observed well enough to override the guess, such as the deep blue of HD 189733 b, the bare rock of TRAPPIST-1 b and the dust of the HR 8799 planets. They are listed with their papers in `src/data/appearances.js`.

Dust disks are shown only where their edges have been measured, around 14 stars including β Pictoris, ε Eridani, HR 8799, PDS 70 and TWA 7. They are listed with their papers in `src/data/disks.js`. The **Belts** setting shows or hides them.

Nothing is downloaded for any of this. When a system opens, `src/scene/worldTextures.js` paints each planet's and star's maps on the GPU from 3D noise. The maps are 2048 pixels wide, 1024 on phones and 512 without a GPU. Planets then use the same materials, lights, clouds and atmosphere glow as the solar system.

## Known Limitations

- All orbits are drawn in the same plane, and planet positions along their orbits are made up. They don't predict transits or real positions on a given date.
- Apart from the observed planets above, surfaces and colors are generated from each planet's size and temperature, not from observations. Rotation and axial tilt are made up.
- Sizes and distances are compressed.
- The background sky is the view from Earth.
- Moons aren't shown, rings are illustrative, and only measured dust disks are drawn. Disks are drawn in the planets' plane, although some are tilted to it.
- Binary star orbits are simplified and don't include gravitational effects between planets and stars. Orbits based on a separation on the sky are usually smaller than the real ones.

## Testing

```sh
npm run exoplanets:verify   # checks every system in the data can be drawn
npm run exoplanets:test     # unit tests
npm run exoplanets:smoke    # tests the atlas and several systems in Chrome
```

`npm run exoplanets:verify` doesn't depend on which systems are in the data, so the deploy workflow uses it to check new data. `npm run exoplanets:test` also checks specific systems like Kepler-16 and Proxima Centauri against the committed data. Add `--live` to `npm run exoplanets:smoke` to also test a real refresh through the proxy.
