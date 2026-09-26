# Exoplanets

[Back to the README](../README.md)

Exoplanet systems use the same renderer as the solar system. Each system is converted into the same format as `src/data/bodies.js`, so orbits, labels, the camera, flight mode, the Scale setting and VR all work the same way. Opening a system loads a new page with `?system=` in the URL.

## Data

Planet and star data comes from the [NASA Exoplanet Archive](https://exoplanetarchive.ipac.caltech.edu/) through its [TAP service](https://exoplanetarchive.ipac.caltech.edu/docs/TAP/usingTAP.html). No API key is needed.

- Each planet uses its default published solution from the `ps` table (`default_flag=1`), so a planet's measurements and its star's measurements come from the same paper. Different planets in the same system can come from different papers.
- Distances come from the `pscomppars` (composite) table.
- If the default solution is missing a period, orbit size, eccentricity, or the star's mass, radius, temperature or spectral type, the composite table's value is used instead and labeled as such in the info panel.
- See the [column definitions](https://exoplanetarchive.ipac.caltech.edu/docs/API_TD_columns.html) for what each value means.

Binary and multiple star systems use data from the [Open Exoplanet Catalogue](https://github.com/OpenExoplanetCatalogue/open_exoplanet_catalogue) (MIT license). Only planets that are in the NASA data are shown, and NASA's count of stars in each system is the one used. If the catalogue lists more stars than NASA (usually a brown dwarf that NASA counts as a planet), its data isn't used for that system.

Companion star masses that aren't reported are estimated from temperature or spectral type using the main-sequence table from [Pecaut & Mamajek (2013)](https://www.pas.rochester.edu/~emamajek/EEM_dwarf_UBVIJHK_colors_Teff.txt). White dwarfs use a typical 0.6 M☉. Giant stars aren't estimated.

`scripts/update-stellar-systems.js` has a short list of corrections for known mistakes in the catalogue, like a period entered in years instead of days. Each one only applies while the catalogue still has the wrong value.

## Updating the Data

```sh
npm run exoplanets:update   # public/data/exoplanets.json
npm run stars:update        # public/data/stellar-systems.json
```

Both scripts check the new data before saving it. If the download fails, the data is invalid, the catalogue is more than 5% smaller than before, or any system can't be drawn, the old file is kept.

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

## Known Limitations

- All orbits are drawn in the same plane, and planet positions along their orbits are made up. They don't predict transits or real positions on a given date.
- Surfaces and colors are generated and are not based on real observations.
- Sizes and distances are compressed.
- The background sky is the view from Earth.
- Moons, rings and debris disks aren't shown.
- Binary star orbits are simplified and don't include gravitational effects between planets and stars. Orbits based on a separation on the sky are usually smaller than the real ones.

## Testing

```sh
npm run exoplanets:verify   # checks every system in the data can be drawn
npm run exoplanets:test     # unit tests
npm run exoplanets:smoke    # tests the atlas and several systems in Chrome
```

`npm run exoplanets:verify` doesn't depend on which systems are in the data, so the deploy workflow uses it to check new data. `npm run exoplanets:test` also checks specific systems like Kepler-16 and Proxima Centauri against the committed data. Add `--live` to `npm run exoplanets:smoke` to also test a real refresh through the proxy.
