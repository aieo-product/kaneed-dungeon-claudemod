# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow", "numpy"]
# ///
"""Preview: Kaneed and the fallback hero wearing the same 25 layers, placed by anchors only."""
import json
from pathlib import Path
from PIL import Image
import hero_export as HE
# tools/sprites, relative to this file (…/tools/sprites/hero/src)
SPR = Path(__file__).resolve().parents[2]
EQ = json.loads((SPR / 'hero/equip/anchors.json').read_text())
PAD = 8  # room above the 24x16 canvas so hats on a full-height hero are visible

def paste(dst, src, x, y):
    """alpha-composite src onto dst at (x, y), allowing negative offsets."""
    sx, sy = max(0, -x), max(0, -y)
    if sx >= src.width or sy >= src.height: return
    src = src.crop((sx, sy, src.width, src.height))
    dst.alpha_composite(src, (max(0, x), max(0, y)))

def wear(body, anchors, gear):
    out = Image.new('RGBA', (24, 16 + PAD), (0, 0, 0, 0))
    out.alpha_composite(body, (0, PAD))
    for slot in HE.ORDER:
        t = gear.get(slot)
        if not t: continue
        key = f'{slot}_{t}'
        ax, ay = anchors[EQ[key]['anchor']]; lx, ly = EQ[key]['at']
        layer = Image.open(SPR / 'hero/equip' / f'{key}.png').convert('RGBA')
        paste(out, layer, ax - lx, ay - ly + PAD)
    return out

if __name__ == '__main__':
    fb = Image.open(SPR / 'fallback_pixel.png').convert('RGBA'); fb = fb.resize((24, 16), Image.NEAREST)
    fa = json.loads((SPR / 'fallback_anchors.json').read_text())['default']
    kan = Image.open(SPR / 'hero/idle_0.png').convert('RGBA')
    ka = json.loads((SPR / 'hero/anchors.json').read_text())['default']
    sets = [{}, {s: 1 for s in HE.ORDER}, {"hat": 3, "eyewear": 4, "shield": 2, "sword": 4, "boots": 5}, {s: 5 for s in HE.ORDER}]
    bg = (0x14, 0x11, 0x0E, 255); S = 6; TH = 16 + PAD
    pv = Image.new('RGBA', (8 + len(sets) * (24 * S + 8), 8 + 2 * (TH * S + 8)), bg)
    for j, (body, an) in enumerate(((kan, ka), (fb, fa))):
        for i, g in enumerate(sets):
            pv.alpha_composite(wear(body, an, g).resize((24 * S, TH * S), Image.NEAREST), (8 + i * (24 * S + 8), 8 + j * (TH * S + 8)))
    pv.save(SPR / 'hero/preview_anchors_x6.png'); pv.save('out/final24/preview_anchors_x6.png'); print('ok')
