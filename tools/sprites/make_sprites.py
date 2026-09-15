#!/usr/bin/env python3
"""refined/*.png (transparent, trimmed pixel art) -> hooks/boards/sprites.ts for the board, plus a
preview sheet. Each sprite becomes rows of hex colours (null = transparent) at a terminal-friendly
pixel height (even, since one text row holds two pixels)."""
import json, sys
from PIL import Image

import os
# run from the repo root: python3 tools/sprites/make_sprites.py hooks/boards/sprites.ts
HERE = os.path.dirname(os.path.abspath(__file__))
REFINED = os.path.join(HERE, 'refined')
OUT_TS = sys.argv[1] if len(sys.argv) > 1 else 'hooks/boards/sprites.ts'

# target pixel height per sprite (even numbers); boss = 1.4x of the kind's size
TARGETS = {
    'fallback': 14, 'slime': 14, 'bat': 14, 'goblin': 18, 'skeleton': 26, 'orc': 18, 'ghost': 16, 'minotaur': 22, 'dragon': 20,
}
# colours per enemy: the NES-style renders are 4-5 flat colours plus a black outline
COLORS = {'fallback': 4, 'slime': 5, 'bat': 5, 'goblin': 6, 'skeleton': 4, 'orc': 7, 'ghost': 4, 'minotaur': 6, 'dragon': 6}
BOSS_SCALE = 1.4
# redraw the outline after shrinking, so every enemy keeps a crisp black edge at any size
OUTLINE = False

# every colour snaps to the xterm-256 palette (6x6x6 cube + 24 greys), so a terminal limited to
# 256 colours draws exactly what a truecolor one does
CUBE = [0, 95, 135, 175, 215, 255]
GREYS = [8 + 10 * i for i in range(24)]
def snap256(rgb):
    """Nearest xterm-256 colour, emitted in the form Claude Code's renderer (chalk: level =
    round(v/255*5)) maps back onto exactly that palette entry: cube channels as multiples of 51,
    greys as themselves. A 256-colour terminal shows the palette entry; a truecolor one shows the
    canonical value, a hair different but the same hue."""
    r, g, b = rgb
    if (r % 51 == g % 51 == b % 51 == 0) or (r == g == b and (r - 8) % 10 == 0):
        return '#%02x%02x%02x' % (r, g, b)
    def level(v): return min(range(6), key=lambda i: abs(CUBE[i] - v))
    lv = (level(r), level(g), level(b))
    cube = tuple(CUBE[i] for i in lv)
    gk = min(range(24), key=lambda k: abs(GREYS[k] - (r + g + b) / 3))
    grey = (GREYS[gk],) * 3
    d = lambda c: sum((c[i] - rgb[i]) ** 2 for i in range(3))
    if d(cube) <= d(grey):
        return '#%02x%02x%02x' % tuple(i * 51 for i in lv)
    return '#%02x%02x%02x' % grey


def trim(im):
    bbox = im.getchannel('A').point(lambda a: 255 if a > 96 else 0).getbbox()
    return im.crop(bbox) if bbox else im

def shrink(im, height, colors):
    im = trim(im.convert('RGBA'))
    w = max(2, round(im.width * height / im.height))
    # box filter down, then snap alpha and quantise colours
    small = im.resize((w, height), Image.BOX)
    alpha = small.getchannel('A').point(lambda a: 255 if a > 110 else 0)
    rgb = small.convert('RGB')
    # quantise on opaque pixels only: paint transparent ones with a colour already in the sprite
    q = rgb.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert('RGB')
    edge = lambda x, y: any(0 <= x + dx < w and 0 <= y + dy < height and alpha.getpixel((x + dx, y + dy)) == 0 or not (0 <= x + dx < w and 0 <= y + dy < height) for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)))
    out = []
    for y in range(height):
        row = []
        for x in range(w):
            if alpha.getpixel((x, y)) == 0:
                row.append(None)
            elif OUTLINE and edge(x, y):
                row.append('#000000')
            else:
                row.append(snap256(q.getpixel((x, y))))
        out.append(row)
    # drop fully transparent columns at the edges (rows are kept so the height stays even)
    while out and all(r[0] is None for r in out): out = [r[1:] for r in out]
    while out and all(r[-1] is None for r in out): out = [r[:-1] for r in out]
    return out

# the fallback hero: a neutral placeholder figure (tools/sprites/fallback_pixel.png) used when hero/ is absent;
# a small figure (<= 10 px tall) is doubled, a full-size one is used as is
def exact(path, scale):
    im = Image.open(path).convert('RGBA')
    im = im.resize((im.width * scale, im.height * scale), Image.NEAREST)
    return [[snap256(im.getpixel((x, y))[:3]) if im.getpixel((x, y))[3] > 0 else None for x in range(im.width)] for y in range(im.height)]

# enemies: the render's own pixel grid, read out 1:1 by native_grid.py (no resampling), shrunk
# by a whole number only when the art is taller than the stage allows. The boss is the same art
# at 1.5x (nearest), one size up without the 2x that would not fit.
sys.path.insert(0, HERE)
from native_grid import convert as native_convert  # noqa: E402
MAX_H = {'slime': 26, 'bat': 26, 'goblin': 26, 'skeleton': 26, 'orc': 26, 'ghost': 26, 'minotaur': 26, 'dragon': 26}

def pixels_of(img):
    img = img.convert('RGBA')
    out = []
    for y in range(img.height):
        out.append([snap256(img.getpixel((x, y))[:3]) if img.getpixel((x, y))[3] else None for x in range(img.width)])
    return out

def scale_up(px, factor):
    hgt = round(len(px) * factor); w = round(len(px[0]) * factor)
    return [[px[min(len(px) - 1, int(y / factor))][min(len(px[0]) - 1, int(x / factor))] for x in range(w)] for y in range(hgt)]

def idle_frames(px):
    """Squash and stretch a sprite by one pixel row. The row removed or doubled sits a third of
    the way down, where a body is widest, so eyes and weapons near the top keep their shape and
    simply move. The squash also pushes the widest row one pixel outward on each side."""
    h = len(px); w = len(px[0])
    cut = max(1, h // 3)
    squash = [row[:] for row in px[:cut]] + [row[:] for row in px[cut + 1:]]
    # bulge: the row just above the feet gets its outer opaque pixels copied one step outward
    if h >= 4:
        y = len(squash) - 2
        row = squash[y]
        xs = [x for x, c in enumerate(row) if c]
        if xs:
            lo, hi = xs[0], xs[-1]
            row = [None] + row + [None]
            row[lo] = px[cut + 1 + (y - cut) if y >= cut else y][lo]
            row[hi + 2] = px[cut + 1 + (y - cut) if y >= cut else y][hi]
            squash = [[None] + r + [None] if i != y else row for i, r in enumerate(squash)]
    squash = [[None] * (w + 2)] + squash  # keep the height: an empty row on top
    stretch = [row[:] for row in px[:cut]] + [px[cut][:]] + [row[:] for row in px[cut:]]
    # same width for all three, so the sprite does not shift when frames change
    stretch = [[None] + r + [None] for r in stretch]
    base_pad = [[None] + r + [None] for r in px]
    return squash, stretch, base_pad

NATIVE = os.path.join(HERE, 'native'); os.makedirs(NATIVE, exist_ok=True)
sprites = {}
for name in TARGETS:
    if name == 'fallback':
        hero = Image.open(os.path.join(HERE, 'fallback_pixel.png'))
        sprites[name] = exact(os.path.join(HERE, 'fallback_pixel.png'), 2 if hero.height <= 10 else 1)
        continue
    cell, factor, size = native_convert(os.path.join(HERE, 'source', f'{name}.png'), os.path.join(NATIVE, f'{name}.png'), MAX_H[name])
    print(f'  {name}: cell {cell}px, 1/{factor}, {size[0]}x{size[1]}')
    px = pixels_of(Image.open(os.path.join(NATIVE, f'{name}.png')))
    sprites[name] = px
    sprites[name + '_boss'] = scale_up(px, 1.5)
    # a three-frame idle for each: rest, a squash (one row shorter, a pixel wider at the base),
    # a stretch (one row taller). Drawn feet-down, so the top does the moving.
    for suffix, base in (('', px), ('_boss', sprites[name + '_boss'])):
        squash, stretch, padded = idle_frames(base)
        sprites[f'{name}{suffix}'] = padded
        sprites[f'{name}{suffix}_1'] = squash
        sprites[f'{name}{suffix}_2'] = stretch

# the hero as frames: tools/sprites/hero/<frame>.png (idle_0, idle_1, walk_0, walk_1, attack_0,
# attack_1, hurt, dead) drawn at final size on one shared canvas, plus equipment layers
# tools/sprites/hero/equip/<slot>_<tier>.png on the same canvas, aligned to idle_0. frames.json may
# hold per-frame offsets for the layers: {"walk_1": [0, 1]}. Without the folder, Kaneed is the hero.
HERO = os.path.join(HERE, 'hero')
FRAMES = ['idle_0', 'idle_1', 'idle_glance', 'idle_blink', 'walk_0', 'walk_1', 'attack_0', 'attack_1', 'hurt', 'dead', 'victory']
hero_offsets = {}
hero_anchors = None
equip_anchors = {}
fallback_anchors = None
if os.path.exists(os.path.join(HERE, 'fallback_anchors.json')):
    fallback_anchors = json.load(open(os.path.join(HERE, 'fallback_anchors.json')))
if os.path.isdir(HERO):
    for fr in FRAMES:
        path = os.path.join(HERO, f'{fr}.png')
        if os.path.exists(path):
            sprites[f'hero_{fr}'] = exact(path, 1)
    equip_dir = os.path.join(HERO, 'equip')
    if os.path.isdir(equip_dir):
        for f in sorted(os.listdir(equip_dir)):
            if f.endswith('.png'):
                sprites[f'equip_{f[:-4]}'] = exact(os.path.join(equip_dir, f), 1)
    frames_json = os.path.join(HERO, 'frames.json')
    if os.path.exists(frames_json):
        hero_offsets = json.load(open(frames_json))
    # anchors: the hero's five named points and, per equipment layer, the pixel that meets them
    if os.path.exists(os.path.join(HERO, 'anchors.json')):
        hero_anchors = json.load(open(os.path.join(HERO, 'anchors.json')))
    if os.path.exists(os.path.join(HERO, 'equip', 'anchors.json')):
        equip_anchors = {f'equip_{k}': v for k, v in json.load(open(os.path.join(HERO, 'equip', 'anchors.json'))).items()}
    print(f'  hero: {sum(1 for k in sprites if k.startswith("hero_"))} frames, {sum(1 for k in sprites if k.startswith("equip_"))} equipment layers')

# preview sheet: each sprite scaled x6 on a dark ground, in the terminal's 1:2 cell shape
scale = 6
cell_w, cell_h = 40 * scale, 30 * scale
names = list(sprites)
sheet = Image.new('RGB', (cell_w * 6, cell_h * ((len(names) + 5) // 6)), (20, 17, 14))
for i, n in enumerate(names):
    px = sprites[n]
    img = Image.new('RGBA', (len(px[0]), len(px)), (0, 0, 0, 0))
    for y, row in enumerate(px):
        for x, c in enumerate(row):
            if c: img.putpixel((x, y), tuple(int(c[j:j + 2], 16) for j in (1, 3, 5)) + (255,))
    big = img.resize((img.width * scale, img.height * scale), Image.NEAREST)
    ox = (i % 6) * cell_w + (cell_w - big.width) // 2
    oy = (i // 6) * cell_h + (cell_h - big.height) // 2
    sheet.paste(big, (ox, oy), big)
sheet.save(os.path.join(HERE, 'sheet.png'))

lines = ['import type { HeroAnchors, LayerAnchor } from \'./anchors.ts\'', '// Generated by make_sprites.py from higgsfield renders refined with PixelRefiner. Rows of hex',
         '// colours, null = transparent; one text row draws two pixel rows with ▀ ▄ █ and fg/bg colours.',
         'export type Pixels = (string | null)[][]',
         'export const SPRITES: Record<string, Pixels> = {']
for n, px in sprites.items():
    lines.append(f'  {json.dumps(n)}: {json.dumps(px, separators=(",", ":"))},')
lines.append('}')
lines.append('// per-frame offsets for the equipment layers, from tools/sprites/hero/frames.json:')
lines.append('// either one (dx, dy) for every slot, or a map slot -> (dx, dy)')
lines.append('export type HeroOffset = [number, number] | Record<string, [number, number]>')
lines.append(f'export const HERO_OFFSETS: Record<string, HeroOffset> = {json.dumps(hero_offsets, separators=(",", ":"))}')
lines.append('// anchor tables (tools/sprites/hero/anchors.json, hero/equip/anchors.json, fallback_anchors.json); null / {} when absent')
lines.append(f'export const HERO_ANCHORS: HeroAnchors | null = {json.dumps(hero_anchors, separators=(",", ":"))}')
lines.append(f'export const FALLBACK_ANCHORS: HeroAnchors | null = {json.dumps(fallback_anchors, separators=(",", ":"))}')
lines.append(f'export const EQUIP_ANCHORS: Record<string, LayerAnchor> = {json.dumps(equip_anchors, separators=(",", ":"))}')
open(OUT_TS, 'w').write('\n'.join(lines) + '\n')
for n, px in sprites.items():
    cols = {c for r in px for c in r if c}
    print(f'{n:15s} {len(px[0]):3d}x{len(px):<3d} colours {len(cols)}')
