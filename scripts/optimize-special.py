"""Two textures that don't fit the generic pipeline.

Saturn's rings are radially symmetric, so a full 2048x2048 RGBA sheet stores the
same radial profile 2048 times over. We average it down to a single 1024x1 strip
and let the ring geometry carry a radial U coordinate instead.

The cloud sheet is fully desaturated and pure white wherever it is visible, so
its RGB channels carry no information - only the alpha does. Stored as a
grayscale JPEG and used as an alphaMap.
"""
import json, os
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
OUT = "public/textures"
manifest = json.load(open(os.path.join(OUT, "manifest.json")))

# --- Saturn rings -> radial strip -------------------------------------------
src = np.array(Image.open("public/saturn_rings.png").convert("RGBA")).astype(np.float32)
h, w, _ = src.shape
cx, cy, N, ANGLES = (w - 1) / 2, (h - 1) / 2, 1024, 720
theta = np.linspace(0, 2 * np.pi, ANGLES, endpoint=False)
radii = np.linspace(0, 1, N) * min(cx, cy)
# sample a full disc of radii x angles, then average over angle
xs = np.clip(np.rint(cx + radii[:, None] * np.cos(theta)[None, :]).astype(int), 0, w - 1)
ys = np.clip(np.rint(cy + radii[:, None] * np.sin(theta)[None, :]).astype(int), 0, h - 1)
strip = src[ys, xs].mean(axis=1)                       # (N, 4)
# premultiply-safe: where a ring sample is transparent its RGB is garbage, so
# carry the nearest opaque colour outward rather than averaging in the key colour
opaque = strip[:, 3] > 2
if opaque.any():
    idx = np.where(opaque, np.arange(N), 0)
    idx = np.maximum.accumulate(idx)
    strip[:, :3] = strip[idx, :3]
img = Image.fromarray(np.rint(strip).astype(np.uint8)[None, :, :], "RGBA")   # 1 row x N cols
img.save(f"{OUT}/saturn_rings.webp", "WEBP", lossless=True, method=6)
os.path.getsize(f"{OUT}/saturn_rings.webp")
manifest["saturn_rings"] = {"file": "saturn_rings.webp", "w": N, "h": 1,
                            "bytes": os.path.getsize(f"{OUT}/saturn_rings.webp"), "radialStrip": True}
print(f"saturn_rings -> {N}x1 radial strip, {os.path.getsize(f'{OUT}/saturn_rings.webp')/1024:.1f} KB")

# --- Earth clouds -> alpha-only ---------------------------------------------
cl = Image.open("public/earth_clouds.png").convert("RGBA")
alpha = cl.getchannel("A").resize((2048, 1024), Image.LANCZOS)
alpha.save(f"{OUT}/earth_clouds.jpg", "JPEG", quality=84, optimize=True, progressive=True)
os.remove(f"{OUT}/earth_clouds.webp")
manifest["earth_clouds"] = {"file": "earth_clouds.jpg", "w": 2048, "h": 1024,
                            "bytes": os.path.getsize(f"{OUT}/earth_clouds.jpg"), "alphaOnly": True}
print(f"earth_clouds -> alpha-only JPEG, {os.path.getsize(f'{OUT}/earth_clouds.jpg')/1024:.1f} KB")

json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w"), indent=2, sort_keys=True)
total = sum(v["bytes"] for v in manifest.values())
print(f"\ntexture set total: {total/1048576:.2f} MB across {len(manifest)} files")
