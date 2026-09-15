"""Export the Kaneed hero frames + 25 equipment layers into clawd-dungeon/tools/sprites/hero/.

Frames (24x16, RGBA): idle_0 idle_1 walk_0 walk_1 attack_0 attack_1 hurt dead (+ extras).
Equipment layers: equip/<slot>_<tier>.png on the same canvas, aligned to idle_0.
frames.json: per-frame, per-slot (dx, dy) so a layer follows the part it is attached to.
"""
import json
import sys
from pathlib import Path

from PIL import Image

import kaneed24 as K

REPO = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
    "/Volumes/AIWorkSSD/AIWorkSpace/github/otani-side/kaneed-dungeon")
HERO = REPO / "tools/sprites/hero"
EQUIP = HERO / "equip"
W, H = K.W, K.H

# game frame name -> kaneed24 frame name
FRAME_MAP = {
    "idle_0": "idle",
    "idle_1": "idle_d",      # breathe: body sinks 1px
    "walk_0": "walk_a",
    "walk_1": "walk_b",
    "attack_0": "attack",    # lunge, claw open
    "attack_1": "attack_hit",  # snap, sparks
    "hurt": "hurt",
    "dead": "ko",
}
EXTRA = {"idle_glance": "idle_b", "idle_blink": "idle_c", "victory": "victory"}

# (dx, dy) of each slot relative to idle_0, derived from how kaneed24.frame() moves each part
Z = [0, 0]
OFFSETS = {
    "idle_0": {"hat": Z, "eyewear": Z, "shield": Z, "sword": Z, "boots": Z},
    "idle_1": {"hat": [0, 1], "eyewear": [0, 1], "shield": Z, "sword": Z, "boots": [0, 1]},
    "walk_0": {"hat": [0, -1], "eyewear": [0, -1], "shield": [0, -1], "sword": [0, -1], "boots": [0, -1]},
    "walk_1": {"hat": Z, "eyewear": Z, "shield": Z, "sword": Z, "boots": Z},
    "attack_0": {"hat": [1, 0], "eyewear": [1, 0], "shield": [1, 0], "sword": [1, 0], "boots": [1, 0]},
    "attack_1": {"hat": [1, 0], "eyewear": [1, 0], "shield": [1, 0], "sword": [1, 0], "boots": [1, 0]},
    "hurt": {"hat": [-1, 0], "eyewear": [-3, 0], "shield": [-1, 0], "sword": [-1, 1], "boots": [-1, 0]},
    "dead": {"hat": [0, 2], "eyewear": [0, 4], "shield": [0, 3], "sword": [0, 4], "boots": [0, 2]},
}

# Anchor points (idle_0, hero canvas px). A hero that replaces Kaneed supplies its own anchors.json
# with the same keys; each equipment layer declares which anchor it hangs from, and the game blits
# the layer so the two anchors coincide. Per-frame anchors = base + the slot offset above.
ANCHOR_OF = {"hat": "hat", "eyewear": "eyes", "shield": "hand_l", "sword": "hand_r", "boots": "feet"}
BASE_ANCHORS = {
    "hat": [10, 5],      # centre of the shell top, where the hat brim sits
    "eyes": [10, 2],     # midpoint between the two eyes, at eye height
    "hand_l": [2, 7],    # small claw (shield side)
    "hand_r": [22, 7],   # big claw grip (sword side)
    "feet": [10, 12],    # centre of the leg row where boots go
}


def dumps_compact(obj):
    """json.dumps with indent, but coordinate pairs kept on one line."""
    import re
    txt = json.dumps(obj, indent=1, ensure_ascii=False)
    return re.sub(r"\[\s+(-?\d+),\s+(-?\d+)\s+\]", r"[\1, \2]", txt)


def hero_anchors():
    frames = {}
    for f, per_slot in OFFSETS.items():
        frames[f] = {}
        for slot, key in ANCHOR_OF.items():
            dx, dy = per_slot[slot]
            bx, by = BASE_ANCHORS[key]
            frames[f][key] = [bx + dx, by + dy]
    return {"slots": ANCHOR_OF, "default": BASE_ANCHORS, "frames": frames}


def equip_anchors():
    return {f"{slot}_{t}": {"anchor": ANCHOR_OF[slot], "at": BASE_ANCHORS[ANCHOR_OF[slot]]}
            for slot in ANCHOR_OF for t in range(1, 6)}


# ---- equipment art -----------------------------------------------------------
# idle_0 anatomy: eyes 3x3 at (7..9,1..3) and (11..13,1..3); stalks x=8,12 y=4..5; body x=5..16
# y=6..11 (row 11 = underside); legs base row y=12 at x=5,7,9,12,14,16; small claw x=1..3 y=6..9
# (arm at (4,8)); big claw x=17..22 y=1..8.
CLR = {
    "beige": (215, 175, 135), "brown": (135, 95, 0), "dbrown": (95, 63, 0),
    "purple": (95, 0, 175), "violet": (175, 95, 255), "silver": (208, 208, 208),
    "grey": (138, 138, 138), "dgrey": (78, 78, 78), "ink": (48, 48, 48),
    "sky": (135, 175, 255), "blue": (95, 95, 255), "cyan": (95, 215, 255),
    "green": (0, 135, 95), "gold": (215, 175, 0), "lgold": (255, 215, 135),
    "cream": (252, 228, 184), "white": (255, 255, 255), "red": (215, 0, 0), "dred": (95, 0, 0),
    "copper": (215, 135, 95),
}


class Layer:
    def __init__(self):
        self.im = Image.new("RGBA", (W, H), (0, 0, 0, 0))

    def px(self, x, y, c):
        if 0 <= x < W and 0 <= y < H:
            self.im.putpixel((x, y), CLR[c] + (255,))

    def rect(self, x0, y0, x1, y1, c):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.px(x, y, c)

    def eye_rim(self, ex, c):
        # half rim: sides + bottom, leaving the top and centre of the white eye visible
        for dx in range(3):
            self.px(ex + dx, 3, c)
        self.px(ex, 2, c); self.px(ex + 2, 2, c)


def hat(t):
    L = Layer()
    if t == 1:    # cloth cap: low dome between the stalks
        L.rect(7, 5, 14, 5, "beige"); L.rect(9, 4, 11, 4, "beige")
    elif t == 2:  # leather hat: brim + short crown
        L.rect(6, 5, 15, 5, "brown"); L.rect(9, 4, 11, 4, "brown"); L.px(10, 3, "brown")
    elif t == 3:  # wizard: tall pointed crown between the eyes, star on the brim
        L.rect(6, 5, 15, 5, "purple"); L.rect(9, 4, 11, 4, "purple")
        L.px(10, 3, "purple"); L.px(10, 2, "purple"); L.px(10, 1, "purple"); L.px(11, 0, "purple")
        L.px(10, 5, "cream")
    elif t == 4:  # mithril helm: silver cap with cheek guards
        L.rect(6, 5, 15, 5, "silver"); L.rect(9, 4, 11, 4, "silver"); L.px(10, 3, "sky")
        L.px(5, 6, "silver"); L.px(5, 7, "silver"); L.px(16, 6, "silver"); L.px(16, 7, "silver")
    elif t == 5:  # dragon-scale helm: green cap with horns beside the eyes
        L.rect(6, 5, 15, 5, "green"); L.rect(9, 4, 11, 4, "green"); L.px(10, 3, "green")
        L.px(6, 4, "lgold"); L.px(6, 3, "lgold"); L.px(15, 4, "lgold"); L.px(15, 3, "lgold")
    return L


def eyewear(t):
    L = Layer()
    if t == 1:    # round glasses
        L.eye_rim(7, "ink"); L.eye_rim(11, "ink"); L.px(10, 2, "ink")
    elif t == 2:  # goggles: brown rims, cyan lens, strap
        L.eye_rim(7, "brown"); L.eye_rim(11, "brown"); L.px(10, 2, "brown")
        L.px(8, 2, "cyan"); L.px(12, 2, "cyan"); L.px(6, 2, "brown"); L.px(14, 2, "brown")
    elif t == 3:  # monocle on the enemy-side eye, with a chain
        L.eye_rim(11, "gold"); L.px(14, 3, "gold"); L.px(14, 4, "gold")
    elif t == 4:  # sage's monocle: blue rim, sparkle
        L.eye_rim(11, "blue"); L.px(14, 3, "blue"); L.px(14, 4, "blue"); L.px(15, 0, "white")
    elif t == 5:  # monocle of truth: gold rim, violet lens, sparkles
        L.eye_rim(11, "gold"); L.px(12, 2, "violet"); L.px(14, 3, "gold"); L.px(14, 4, "gold")
        L.px(15, 0, "white"); L.px(16, 1, "white")
    return L


def shield(t):
    L = Layer()

    def plate(fill, edge):
        L.rect(0, 5, 3, 8, edge); L.rect(1, 9, 2, 9, edge)
        L.rect(1, 6, 2, 7, fill); L.px(1, 8, fill); L.px(2, 8, fill)

    if t == 1:
        plate("beige", "brown")
    elif t == 2:  # magic-barrier amulet: floating blue diamond
        L.px(1, 5, "sky"); L.px(2, 5, "sky"); L.rect(0, 6, 3, 7, "sky"); L.px(1, 8, "sky"); L.px(2, 8, "sky")
        L.px(1, 6, "white"); L.px(2, 7, "white")
    elif t == 3:
        plate("grey", "dgrey")
    elif t == 4:
        plate("silver", "sky")
    elif t == 5:
        plate("green", "red")
    return L


def sword(t):
    L = Layer()
    if t == 1:    # wooden sword
        L.rect(22, 0, 22, 6, "beige"); L.rect(21, 7, 23, 7, "brown"); L.rect(22, 8, 22, 9, "brown")
    elif t == 2:  # copper
        L.rect(22, 0, 22, 6, "copper"); L.rect(21, 7, 23, 7, "brown"); L.rect(22, 8, 22, 9, "dbrown")
    elif t == 3:  # iron
        L.rect(22, 0, 22, 6, "silver"); L.px(22, 0, "white"); L.rect(21, 7, 23, 7, "dgrey"); L.rect(22, 8, 22, 9, "brown")
    elif t == 4:  # mage's staff: stick with a glowing orb
        L.rect(22, 2, 22, 9, "brown"); L.rect(21, 0, 22, 1, "blue"); L.px(21, 0, "white")
    elif t == 5:  # dragon-slayer: wide gold-edged blade
        L.rect(22, 0, 22, 6, "silver"); L.rect(21, 1, 21, 6, "lgold"); L.px(22, 0, "white")
        L.rect(20, 7, 23, 7, "gold"); L.rect(22, 8, 22, 9, "dred")
    return L


def boots(t):
    L = Layer()
    xs = (5, 7, 9, 12, 14, 16)
    col = {1: "beige", 2: "brown", 3: "grey", 4: "silver", 5: "violet"}[t]
    for x in xs:
        L.px(x, 12, col)
    if t == 3:
        for x in xs:
            L.px(x, 13, "dgrey")
    if t == 4:
        L.px(4, 12, "white"); L.px(17, 12, "white")
    if t == 5:  # flying boots: little wings
        for x in (3, 4, 17, 18):
            L.px(x, 12, "cream")
        L.px(3, 11, "cream"); L.px(18, 11, "cream")
    return L


MAKERS = {"hat": hat, "eyewear": eyewear, "shield": shield, "sword": sword, "boots": boots}
ORDER = ["boots", "shield", "sword", "hat", "eyewear"]


def composite(frame_key, gear):
    """Body frame + equipment (dict slot->tier) using OFFSETS, for previews."""
    im = K.frame(FRAME_MAP[frame_key]).image().copy()
    for slot in ORDER:
        t = gear.get(slot)
        if not t:
            continue
        dx, dy = OFFSETS[frame_key][slot]
        layer = MAKERS[slot](t).im
        shifted = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        shifted.alpha_composite(layer, (max(dx, 0), max(dy, 0)), (max(-dx, 0), max(-dy, 0)))
        im.alpha_composite(shifted)
    return im


def main():
    EQUIP.mkdir(parents=True, exist_ok=True)
    for game, src in {**FRAME_MAP, **EXTRA}.items():
        K.frame(src).image().save(HERO / f"{game}.png")
    for slot, mk in MAKERS.items():
        for t in range(1, 6):
            mk(t).im.save(EQUIP / f"{slot}_{t}.png")
    (HERO / "frames.json").write_text(dumps_compact(OFFSETS) + "\n")
    (HERO / "anchors.json").write_text(dumps_compact(hero_anchors()) + "\n")
    (EQUIP / "anchors.json").write_text(dumps_compact(equip_anchors()) + "\n")

    # previews: (a) idle_0 with each slot at tiers 1-5, (b) all 8 frames wearing tier 3 everything
    bg = (0x14, 0x11, 0x0E, 255)
    S = 6
    rows = []
    for slot in MAKERS:
        row = [composite("idle_0", {slot: t}) for t in range(1, 6)]
        rows.append(row)
    rows.append([composite(f, {s: 3 for s in MAKERS}) for f in FRAME_MAP])
    rows.append([composite(f, {"hat": 3, "eyewear": 4, "shield": 2, "sword": 4, "boots": 5}) for f in FRAME_MAP])
    pw = max(len(r) for r in rows) * (W * S + 8) + 8
    pv = Image.new("RGBA", (pw, len(rows) * (H * S + 8) + 8), bg)
    for j, row in enumerate(rows):
        for i, im in enumerate(row):
            pv.alpha_composite(im.resize((W * S, H * S), Image.NEAREST), (8 + i * (W * S + 8), 8 + j * (H * S + 8)))
    out = Path("out/final24/preview_equip_x6.png")
    pv.save(out)
    print("frames:", sorted(p.name for p in HERO.glob("*.png")))
    print("equip:", len(list(EQUIP.glob("*.png"))), "layers")
    print("preview:", out)


if __name__ == "__main__":
    main()
