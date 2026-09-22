"""Builds the sky: the Milky Way glow and the star field.

    python scripts/build-sky.py <milky-way.jpg> <bsc5.dat>

The Milky Way map. The source art (8k_stars_milky_way.jpg, in the git history
under public/) is an all-sky map in galactic coordinates, stored south-up, with
several thousand stars painted into it. Used directly it has three problems:
it is not aligned with anything else in the scene, its painted stars are
soft blobs that smear when the camera zooms, and those stars are not the real
ones. So this script removes the point sources, keeping only the diffuse glow
and the dust lanes, and reprojects what is left into the scene's own frame -
the J2000 ecliptic, in three.js axes - so that it can be used as a plain
equirectangular background with no rotation. It is written out at 2048x1024:
with the stars gone there is no detail left that needs more.

The stars. Real ones, from the Yale Bright Star Catalogue (5th revised ed.,
Hoffleit & Warren 1991; bsc5.dat from http://tdc-www.harvard.edu/catalogs/bsc5.html):
every star to magnitude 6.5, which is everything visible to the eye from a
dark site. Below that, a few thousand fainter stars are drawn from the glow map
itself, so the band keeps its texture where it is densest. Each star is 8 bytes:

    int16 x, y, z    unit direction in scene axes, x 32767
    uint8 magnitude  (V + 1.5) x 25
    int8  colour     (B - V) x 60

brightest first, in public/data/stars.bin.
"""
import json, os, struct, sys
import numpy as np
from PIL import Image
from scipy import ndimage

Image.MAX_IMAGE_PIXELS = None
OUT_TEXTURE = "public/textures/stars_milkyway.webp"
OUT_STARS = "public/data/stars.bin"
MANIFEST = "public/textures/manifest.json"

OBLIQUITY = np.radians(23.4392911)
# Equatorial J2000 -> galactic (Hipparcos, ESA 1997, vol. 1, sec. 1.5.3).
EQ_TO_GAL = np.array([
    [-0.0548755604, -0.8734370902, -0.4838350155],
    [+0.4941094279, -0.4448296300, +0.7469822445],
    [-0.8676661490, -0.1980763734, +0.4559837762],
])
# Ecliptic -> equatorial: rotate back about the equinox direction.
ECL_TO_EQ = np.array([
    [1, 0, 0],
    [0, np.cos(OBLIQUITY), -np.sin(OBLIQUITY)],
    [0, np.sin(OBLIQUITY), np.cos(OBLIQUITY)],
])


def scene_to_ecliptic(d):
    """three.js (x, y, z) -> ecliptic (x, -z, y); the inverse of perifocalToWorld's mapping."""
    return np.stack([d[..., 0], -d[..., 2], d[..., 1]], axis=-1)


def ecliptic_to_scene(d):
    return np.stack([d[..., 0], d[..., 2], -d[..., 1]], axis=-1)


def equatorial_to_scene(ra, dec):
    eq = np.stack([np.cos(dec) * np.cos(ra), np.cos(dec) * np.sin(ra), np.sin(dec)], axis=-1)
    return ecliptic_to_scene(eq @ ECL_TO_EQ)   # row vectors: eq -> ecl is ECL_TO_EQ transposed


def build_glow(source_path, width=2048):
    # Work at half resolution: the glow has nothing finer than that in it.
    image = Image.open(source_path).convert("RGB")
    image = image.resize((image.width // 2, image.height // 2), Image.BOX)
    src = np.asarray(image, dtype=np.float32) / 255.0
    h, w = src.shape[:2]

    # Stars are a few pixels across; the band's structure is tens. A grey
    # opening removes anything smaller than its footprint and leaves the rest.
    # Two passes of increasing size catch the brighter, wider stars as well.
    luminance = src @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    opened = ndimage.grey_opening(luminance, size=(5, 5), mode="wrap")
    opened = ndimage.grey_opening(opened, size=(9, 9), mode="wrap")
    ratio = np.clip(opened / np.maximum(luminance, 1e-4), 0, 1)[..., None]
    glow = src * ratio
    # The source is a JPEG, and the stretch below would otherwise turn its
    # block noise into blotches.
    glow = ndimage.gaussian_filter(glow, sigma=(4.5, 4.5, 0), mode="wrap")

    # Reproject: for every output pixel, the scene direction it shows, and the
    # galactic longitude and latitude of that direction in the source.
    out_h = width // 2
    u = (np.arange(width) + 0.5) / width
    v = 1 - (np.arange(out_h) + 0.5) / out_h            # three flips Y on upload
    lon = (u - 0.5) * 2 * np.pi                          # atan2(z, x), as equirectUv() has it
    lat = (v - 0.5) * np.pi                              # asin(y)
    lon, lat = np.meshgrid(lon, lat)
    scene = np.stack([np.cos(lat) * np.cos(lon), np.sin(lat), np.cos(lat) * np.sin(lon)], axis=-1)

    eq = scene_to_ecliptic(scene) @ ECL_TO_EQ.T
    gal = eq @ EQ_TO_GAL.T
    l = np.arctan2(gal[..., 1], gal[..., 0])
    b = np.arcsin(np.clip(gal[..., 2], -1, 1))

    # The source: longitude increases to the left from a centred galactic
    # centre, and south is up.
    sx = ((0.5 - l / (2 * np.pi)) % 1.0) * w - 0.5
    sy = (b / np.pi + 0.5) * h - 0.5
    out = np.stack([
        ndimage.map_coordinates(glow[..., c], [sy, sx], order=1, mode="grid-wrap")
        for c in range(3)
    ], axis=-1)

    # Grade, on brightness alone so the hue survives. Take out the painted noise
    # floor so empty sky is black, lift what is left, and keep only a hint of
    # the source's colour. Then warm the bulge the way it looks in long
    # exposures - the centre of the galaxy is older, redder stars - and let the
    # arms fall off toward a cool grey.
    lum = luminance_of(out)
    chroma = out / np.maximum(lum, 1e-4)[..., None]
    chroma = 1 + (np.clip(chroma, 0, 3) - 1) * 0.3
    lum = np.clip(lum - np.percentile(lum, 40), 0, None)
    lum = lum / np.percentile(lum, 99.8)
    # A soft shoulder on the highlights. The bulge is ten times the arms, and
    # left linear it reads as a white cloud at the edge of the frame rather
    # than as the brightest part of a band of stars.
    lum = np.clip(lum / (lum + 0.4) * 1.4 * 0.5, 0, 1)
    centre = np.exp(-(l / np.radians(40)) ** 2 - (b / np.radians(18)) ** 2)[..., None]
    tint = (1 - centre) * np.array([0.9, 0.94, 1.0]) + centre * np.array([1.0, 0.88, 0.72])
    out = np.clip(lum[..., None] * chroma * tint, 0, 1)

    return out, luminance_of(out)


def luminance_of(rgb):
    return rgb @ np.array([0.2126, 0.7152, 0.0722])


def read_catalogue(path):
    stars = []
    with open(path, "r", encoding="latin-1") as f:
        for line in f:
            line = line.rstrip("\n").ljust(115)
            if not line[75:77].strip() or not line[102:107].strip():
                continue  # withdrawn entries: novae, clusters, duplicates
            ra = (int(line[75:77]) + int(line[77:79]) / 60 + float(line[79:83]) / 3600) * 15
            dec = int(line[84:86]) + int(line[86:88]) / 60 + int(line[88:90]) / 3600
            if line[83] == "-":
                dec = -dec
            mag = float(line[102:107])
            bv = float(line[109:114]) if line[109:114].strip() else 0.6
            stars.append((np.radians(ra), np.radians(dec), mag, bv))
    return np.array(stars)


def faint_stars(glow_luminance, count, rng):
    """Fainter stars scattered by the glow's own brightness, plus an even floor."""
    h, w = glow_luminance.shape
    lat = (0.5 - (np.arange(h) + 0.5) / h) * np.pi
    weight = (glow_luminance ** 1.3 + 0.004) * np.cos(lat)[:, None]
    weight = weight.ravel() / weight.sum()
    picks = rng.choice(weight.size, size=count, p=weight)
    row, col = np.divmod(picks, w)
    u = (col + rng.random(count)) / w
    v = 1 - (row + rng.random(count)) / h
    lon = (u - 0.5) * 2 * np.pi
    lat = np.arcsin(np.clip(np.sin((v - 0.5) * np.pi), -1, 1))
    dirs = np.stack([np.cos(lat) * np.cos(lon), np.sin(lat), np.cos(lat) * np.sin(lon)], axis=-1)
    # Star counts climb steeply toward faint magnitudes: roughly x3 per magnitude.
    mag = 6.5 + np.log(1 + rng.random(count) * (3 ** 2.0 - 1)) / np.log(3)
    bv = np.clip(rng.normal(0.7, 0.32, count), -0.3, 1.8)
    return dirs, mag, bv


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    glow_source, catalogue = sys.argv[1], sys.argv[2]
    rng = np.random.default_rng(1991)

    glow, glow_lum = build_glow(glow_source)
    Image.fromarray((glow * 255 + 0.5).astype(np.uint8), "RGB").save(OUT_TEXTURE, "WEBP", quality=90, method=6)

    manifest = json.load(open(MANIFEST))
    manifest["stars_milkyway"] = {
        "bytes": os.path.getsize(OUT_TEXTURE), "file": os.path.basename(OUT_TEXTURE),
        "h": glow.shape[0], "w": glow.shape[1],
    }
    json.dump(manifest, open(MANIFEST, "w"), indent=2, sort_keys=True)
    print(f"{OUT_TEXTURE}: {glow.shape[1]}x{glow.shape[0]}, {os.path.getsize(OUT_TEXTURE) // 1024} KB")

    real = read_catalogue(catalogue)
    real_dirs = equatorial_to_scene(real[:, 0], real[:, 1])
    faint_dirs, faint_mag, faint_bv = faint_stars(glow_lum, 14000, rng)

    dirs = np.concatenate([real_dirs, faint_dirs])
    mag = np.concatenate([real[:, 2], faint_mag])
    bv = np.concatenate([real[:, 3], faint_bv])
    order = np.argsort(mag)

    os.makedirs(os.path.dirname(OUT_STARS), exist_ok=True)
    with open(OUT_STARS, "wb") as f:
        for i in order:
            x, y, z = np.round(dirs[i] / np.linalg.norm(dirs[i]) * 32767).astype(int)
            m = int(np.clip(round((mag[i] + 1.5) * 25), 0, 255))
            c = int(np.clip(round(bv[i] * 60), -128, 127))
            f.write(struct.pack("<hhhBb", x, y, z, m, c))
    print(f"{OUT_STARS}: {len(real)} catalogued + {len(faint_mag)} faint, "
          f"{os.path.getsize(OUT_STARS) // 1024} KB")


if __name__ == "__main__":
    main()
