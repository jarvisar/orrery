# Controls

[Back to the README](../README.md)

Click on any planet or moon to focus on it, or pick one from the menu at the top. When something is too small to see, click its label instead. The info panel shows facts about the selected body, a live map of its orbit and links to its moons.

**Tours** move the camera through the solar system one stop at a time: *The Grand Tour* (Sun to Pluto), *Ocean Worlds* and *Odd Ones Out*.

**Click on the date** to jump to any date, or to one of a few notable moments like the 2020 great conjunction or Saturn's 2025 equinox. The date is saved in the URL, so a link opens the same moment.

## Keyboard and mouse

| | |
| --- | --- |
| **Drag** / **scroll** | Rotate and zoom |
| **Click** | Focus on a body |
| **Click a ringed star** | Travel there (whole system view, **H**) |
| **H** | Show the whole system (or click the logo) |
| **T** | Choose a tour, then **←** / **→** to move between stops |
| **Esc** | Free camera, or leave a tour or flight mode |
| **`[`** / **`]`** | Previous / next body |
| **Space** | Play or pause |
| **`,`** / **`.`** | Slow down / speed up time |
| **R** / **N** | Reverse time / jump to now |
| **G** | Flight mode |
| **?** | Full list of controls |

## Flight mode

Press **G** to switch to flight mode, then click to capture the mouse.

| | |
| --- | --- |
| **Mouse** | Steer |
| **W** / **S** or **scroll** | Throttle up / down |
| **A** / **D** | Roll |
| **Shift** | Boost |
| **Space** | Brake |
| **`[`** / **`]`** | Previous / next destination |
| **F** | Autopilot on / off |

Speed depends on how close you are to the nearest planet or moon, so you can cross the solar system quickly and still slow down near a moon. Click on a label to fly there with the autopilot. Use any control to take over. On a phone, drag to steer and use the slider on the left for the throttle.

## Game controllers

Most controllers work, including Xbox, PlayStation, Switch Pro and 8BitDo. Press a button for the browser to detect it. The on-screen legend and the controls list show the button names for your controller. The buttons below use Xbox names.

| | |
| --- | --- |
| **Left stick** | Rotate (in flight mode: steer) |
| **Right stick** | Pan (in flight mode: roll) |
| **LT** / **RT** | Zoom out / in (in flight mode: throttle) |
| **D-pad ←** / **→** | Previous / next body, tour stop or destination |
| **D-pad ↑** / **↓** | Jump to now / reverse time |
| **LB** / **RB** | Slow down / speed up time |
| **A** | Play or pause (in flight mode: hold to boost) |
| **B** | Free camera, end the tour, or leave flight mode |
| **X** | Flight mode |
| **Y** | Show the whole system (in flight mode: autopilot) |
| **Right stick click** | Re-frame the current body |
| **Left stick click** | Show or hide the info panel |
| **Menu** | Control the menus |
| **View** | Full screen |

Press **Menu** to use the menus with the controller. Use the D-pad to move, **A** to select and **B** to go back. Press **Menu** again to go back to the camera. Settings has a controller section while one is connected, for inverting the Y axis, stick speed and vibration.

Browsers only allow full screen after a click or key press. If there hasn't been one recently, **View** will ask you to press a key or click first.

## VR

If a VR headset is available (the Quest browser, or Chrome or Edge with a PC headset connected), a headset button appears in the top bar.

| | |
| --- | --- |
| **Trigger** | Select a body or panel button |
| **Grip** | Grab and move the system |
| **Both grips** | Scale and rotate the system |
| **Left stick** | Fly where the left controller points (click to go faster) |
| **Right stick** | Turn left and right, push forward or back to zoom |
| **A** / **B** | Play or pause / show the whole system |
| **X** / **Y** | Previous / next body |

A panel above the left controller shows the date and has buttons for everything else, including leaving VR.

Hand tracking also works:

| | |
| --- | --- |
| **Pinch** | Select a body or panel button |
| **Pinch and drag** | Grab and move the system |
| **Pinch with both hands** | Scale and rotate the system |
| **Fingertip** | Press a panel button |
| **Left palm toward you** | Bring the panel to your hand |

Hold the Meta button to recenter the view.

## Links

Links can include `?body=saturn` and `?t=2017-05-01` (any ISO date or time, in UTC). Exoplanet systems use `?system=`, for example `?system=TRAPPIST-1&body=planet%3ATRAPPIST-1%20e`.

![Saturn in May 2017](screenshot-saturn.jpg)

## Star systems

Click on **Star systems** to search for confirmed exoplanets from the [NASA Exoplanet Archive](https://exoplanetarchive.ipac.caltech.edu/). You can sort by nearest systems, most planets, multiple stars or newest discoveries. Search works with the archive's names or full star names, so "Tau Ceti" finds tau Cet and "51 Pegasi" finds 51 Peg. Some multi-star systems don't have enough data to draw every star, so their cards say "host star only" or how many stars are shown.

You can also get there from the sky. About 170 of the stars you can see with the naked eye have known planets. In the whole-system view (**H**) each one has a faint ring round it, unless **Labels** is off. Point at one to see its name, and click it to open a card with a **Travel** button. Stars only respond in that view, and the card closes when you leave it.

Exoplanet systems use the same controls as the solar system. Systems where the planets would be too small to see next to a distant companion star, like Proxima Centauri, open on the host star's planets. Press **H** to see every star.

The atlas includes an offline copy of the catalogue that is updated every week. If that copy is more than a week old, the app checks NASA for new planets. Click on **Refresh from NASA** to check at any time. Requests go through my [CORS proxy](https://github.com/jarvisar/cors-proxy). If NASA can't be reached, the last saved catalogue is used. Reopen a system after refreshing to see new data.

See the [exoplanet notes](exoplanets.md) for where the data comes from and how systems are modeled.
