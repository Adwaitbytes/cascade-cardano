"""Downscales the high-scale renders to the sizes X expects, plus a 48 px avatar preview with the circle crop."""
from pathlib import Path
from PIL import Image, ImageDraw

out = Path(__file__).parent / "out"
targets = {
    "avatar@5x.png": [("avatar.png", 400), ("avatar-1000.png", 1000)],
    "banner@2x.png": [("banner.png", 1500), ("banner-3000.png", 3000)],
    "post-card@2x.png": [("post-card.png", 1200)],
}
for src, sizes in targets.items():
    im = Image.open(out / src).convert("RGB")
    for name, width in sizes:
        height = round(im.height * width / im.width)
        resized = im if im.width == width else im.resize((width, height), Image.LANCZOS)
        resized.save(out / name, optimize=True)

avatar = Image.open(out / "avatar.png")
preview = avatar.resize((48, 48), Image.LANCZOS)
mask = Image.new("L", (48 * 4, 48 * 4), 0)
ImageDraw.Draw(mask).ellipse((0, 0, 48 * 4 - 1, 48 * 4 - 1), fill=255)
circle = Image.new("RGB", (48, 48), (255, 255, 255))
circle.paste(preview, (0, 0), mask.resize((48, 48), Image.LANCZOS))
circle.save(out / "avatar-48-preview.png")
