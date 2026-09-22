"""One-shot pipeline that rebuilds public/textures/ from the original source art.

Colour (albedo) maps become WebP; single-channel data maps (elevation/specular)
become grayscale JPEG, which beats WebP for smooth noise-free height data.
Target sizes are chosen from how large each body actually renders on screen -
an 8192x4096 bump map on a moon drawn 8px across costs 179MB of VRAM for
nothing, which is what used to stall the first frame.
"""
import os, sys, json
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
SRC, OUT = "public", "public/textures"

# (source, output stem, kind, max width)
#   kind: 'color'  -> WebP RGB
#         'alpha'  -> WebP RGBA (keeps transparency)
#         'data'   -> grayscale JPEG (bump / specular / elevation)
JOBS = [
    ("8k_stars_milky_way.jpg",      "stars_milkyway",   "color", 4096),
    ("2k_sun.jpg",                  "sun",              "color", 2048),

    ("2k_mercury.jpg",              "mercury",          "color", 2048),
    ("mercury_elevation.jpg",       "mercury_bump",     "data",  1024),
    ("2k_venus_surface.jpg",        "venus",            "color", 2048),
    ("venus_elevation.jpg",         "venus_bump",       "data",  1024),
    ("2k_venus_atmosphere.jpg",     "venus_atmosphere", "color", 2048),

    ("8k_earth_daymap.jpg",         "earth",            "color", 4096),
    ("earth_elevation.jpg",         "earth_bump",       "data",  2048),
    ("2k_earth_specular_map.tif",   "earth_specular",   "data",  1024),
    ("2k_earth_nightmap.jpg",       "earth_night",      "color", 2048),
    ("earth_clouds.png",            "earth_clouds",     "alpha", 2048),
    ("2k_moon.jpg",                 "moon",             "color", 2048),
    ("moon_elevation.jpg",          "moon_bump",        "data",  1024),

    ("2k_mars.jpg",                 "mars",             "color", 2048),
    ("mars_elevation.jpg",          "mars_bump",        "data",  1024),

    ("2k_jupiter.jpg",              "jupiter",          "color", 2048),
    ("io_texture.jpg",              "io",               "color", 2048),
    ("io_elevation.png",            "io_bump",          "data",  1024),
    ("europa_texture.png",          "europa",           "color", 2048),
    ("europa_elevation.jpg",        "europa_bump",      "data",  1024),
    ("ganymede_texture.png",        "ganymede",         "color", 2048),
    ("ganymede_elevation.jpg",      "ganymede_bump",    "data",  1024),
    ("callisto_texture.jpg",        "callisto",         "color", 2048),
    ("callisto_elevation.jpg",      "callisto_bump",    "data",  1024),

    ("2k_saturn.jpg",               "saturn",           "color", 2048),
    ("saturn_rings.png",            "saturn_rings",     "alpha", 2048),
    ("titan_texture.png",           "titan",            "color", 2048),
    ("titan_elevation.png",         "titan_bump",       "data",  1024),
    ("enceladus_texture.jpg",       "enceladus",        "color", 2048),
    ("enceladus_elevation.png",     "enceladus_bump",   "data",  1024),
    ("iapetus_texture.png",         "iapetus",          "color", 2048),
    ("iapetus_elevation.png",       "iapetus_bump",     "data",  1024),

    ("2k_uranus.jpg",               "uranus",           "color", 2048),
    ("2k_neptune.jpg",              "neptune",          "color", 2048),
    ("triton_texture.png",          "triton",           "color", 2048),
    ("triton_elevation.jpg",        "triton_bump",      "data",  1024),

    ("2k_ceres.jpg",                "ceres",            "color", 2048),
    ("ceres_elevation.png",         "ceres_bump",       "data",  1024),
    ("2k_pluto.webp",               "pluto",            "color", 2048),
    ("pluto_elevation.png",         "pluto_bump",       "data",  1024),
    ("pluto_spec.png",              "pluto_specular",   "data",  1024),
    ("2k_eris.jpg",                 "eris",             "color", 2048),
    ("eris_elevation.jpg",          "eris_bump",        "data",  1024),
    ("2k_makemake.jpg",             "makemake",         "color", 2048),
]

def fit(im, max_w):
    if im.width <= max_w:
        return im
    h = max(1, round(im.height * max_w / im.width))
    return im.resize((max_w, h), Image.LANCZOS)

os.makedirs(OUT, exist_ok=True)
manifest, before, after, missing = {}, 0, 0, []

for src, stem, kind, max_w in JOBS:
    path = os.path.join(SRC, src)
    if not os.path.exists(path):
        missing.append(src)
        continue
    before += os.path.getsize(path)
    im = Image.open(path)

    if kind == "data":
        dst = os.path.join(OUT, stem + ".jpg")
        fit(im.convert("L"), max_w).save(dst, "JPEG", quality=82, optimize=True, progressive=True)
    elif kind == "alpha":
        dst = os.path.join(OUT, stem + ".webp")
        fit(im.convert("RGBA"), max_w).save(dst, "WEBP", quality=86, method=6)
    else:
        dst = os.path.join(OUT, stem + ".webp")
        fit(im.convert("RGB"), max_w).save(dst, "WEBP", quality=84, method=6)

    size = os.path.getsize(dst)
    after += size
    out_im = Image.open(dst)
    manifest[stem] = {"file": os.path.basename(dst), "w": out_im.width, "h": out_im.height, "bytes": size}
    print(f"{src:34s} -> {os.path.basename(dst):28s} "
          f"{os.path.getsize(path)/1048576:7.2f} MB -> {size/1048576:6.2f} MB")

print(f"\ntextures: {before/1048576:.1f} MB -> {after/1048576:.1f} MB "
      f"({100 - after/before*100:.1f}% smaller)")
if missing:
    print("MISSING SOURCES:", missing, file=sys.stderr)
    sys.exit(1)
json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w"), indent=2, sort_keys=True)
