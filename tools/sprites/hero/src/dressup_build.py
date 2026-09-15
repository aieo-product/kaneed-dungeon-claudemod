# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow"]
# ///
"""Build the gallery's dress-up page (dressup.html) from the hero sprites in tools/sprites/hero/.

    uv run tools/sprites/hero/src/dressup_build.py [out.html]

Embeds the 11 hero frames, the 25 equipment layers, both anchor tables, frames.json and the
fallback hero (fallback_pixel.png doubled to 24x16) as data URIs into dressup_template.html.
The page composes body + layers exactly like hooks/boards/anchors.ts (anchor → frames.json →
[0,0]) and rounds colours to xterm-256 the way make_sprites.py does. Publish the result as the
`dressup.html` file of the gallery artifact; index.html links to it in two places.
"""
import base64
import io
import sys
from pathlib import Path

from PIL import Image

SRC = Path(__file__).resolve().parent
SPR = SRC.parents[1]           # tools/sprites
HERO = SPR / "hero"
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else SPR / "hero" / "dressup.html"


def uri(png_bytes: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(png_bytes).decode()


def main():
    frames = {p.stem: uri(p.read_bytes()) for p in sorted(HERO.glob("*.png")) if not p.stem.startswith("preview")}
    equip = {p.stem: uri(p.read_bytes()) for p in sorted((HERO / "equip").glob("*.png"))}
    fb = Image.open(SPR / "fallback_pixel.png").convert("RGBA")
    fb = fb.resize((fb.width * 2, fb.height * 2), Image.NEAREST)
    buf = io.BytesIO(); fb.save(buf, "PNG")
    import json
    data = "\n".join([
        "const FRAMES = %s;" % json.dumps(frames),
        "const EQUIP = %s;" % json.dumps(equip),
        "const OFFSETS = %s;" % (HERO / "frames.json").read_text(),
        "const KANEED_ANCHORS = %s;" % (HERO / "anchors.json").read_text(),
        "const EQUIP_ANCHORS = %s;" % (HERO / "equip" / "anchors.json").read_text(),
        "const FALLBACK_ANCHORS = %s;" % (SPR / "fallback_anchors.json").read_text(),
        'const FALLBACK_PNG = "%s";' % uri(buf.getvalue()),
    ])
    html = (SRC / "dressup_template.html").read_text().replace("/*DATA*/", data)
    OUT.write_text(html)
    print(f"{OUT}: {len(frames)} frames, {len(equip)} layers, {len(html) // 1024} KB")


if __name__ == "__main__":
    main()
