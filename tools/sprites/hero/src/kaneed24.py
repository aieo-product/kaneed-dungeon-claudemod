"""Hand-built 24x16 sprites of Kaneed (fiddler crab hero), same footprint as Clawd (24x16).

Design rules (from the approved concept):
- no eyes on the body; two stalk eyes on top + mouth carry the emotion
- big claw on the RIGHT (enemy side), small claw on the left
- flat palette: red, dark red (underside), cream, pink, black
"""
from pathlib import Path

import numpy as np
from PIL import Image

W, H = 24, 16
PAL = {
    "R": (224, 32, 32),
    "D": (150, 16, 24),
    "C": (252, 228, 184),
    "P": (240, 128, 160),
    "W": (255, 255, 255),  # eye whites: pure white so they never read as grey on the board
    "K": (28, 28, 28),  # never pure black: the board background is near-black
}


class Canvas:
    def __init__(self, w=W, h=H):
        self.g = [["." for _ in range(w)] for _ in range(h)]
        self.w, self.h = w, h

    def px(self, x, y, c):
        if 0 <= x < self.w and 0 <= y < self.h:
            self.g[y][x] = c

    def rect(self, x0, y0, x1, y1, c):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.px(x, y, c)

    def blit(self, rows, ox, oy):
        for j, row in enumerate(rows):
            for i, ch in enumerate(row):
                if ch != ".":
                    self.px(ox + i, oy + j, ch)

    def text(self):
        return "\n".join("".join(r) for r in self.g)

    def image(self):
        img = np.zeros((self.h, self.w, 4), np.uint8)
        for y in range(self.h):
            for x in range(self.w):
                ch = self.g[y][x]
                if ch != ".":
                    img[y, x, :3] = PAL[ch]
                    img[y, x, 3] = 255
        return Image.fromarray(img, "RGBA")


# ---- parts -----------------------------------------------------------------
EYE = {
    "open": ["WWW", "WKW", "WWW"],
    "narrow": ["...", "WKW", "WWW"],
    "happy": ["WWW", "W.W", "..."],
    "x": ["W.W", ".W.", "W.W"],
    "shock": ["WWW", "WKW", "WWW"],
    "look_r": ["WWW", "WWK", "WWW"],
    "blink": ["...", "WWW", "..."],
}
MOUTH = {
    "smile": ["KK", "PP"],
    "flat": ["KK"],
    "o": ["KK", "KK"],
    "wide": ["KKKK", ".PP."],
    "wavy": ["K.K", ".K."],
}
BIG_CLAW_CLOSED = [
    "..RRR.",
    ".RRRRR",
    "RCRRRR",
    "RRRRR.",
    "RRRDDR",
    "RRRRRR",
    ".RRRRR",
    "..RRR.",
]
BIG_CLAW_OPEN = [  # 'C' shape opening to the right
    ".RRRR.",
    "RRRRRR",
    "RCR...",
    "RRR...",
    "RRR...",
    "RRRRRR",
    ".RRRR.",
]
BIG_CLAW_UP = [  # raised straight up
    ".RRR.",
    "RRRRR",
    "RCRRR",
    "RRRRR",
    "RRRRR",
    ".RRR.",
    "..R..",
]
SMALL_CLAW = [
    ".RR",
    "RCR",
    "RRR",
    ".RR",
]


def body(c, ox, oy, eye="open", mouth="smile", eye_dx=0, eye_dy=0, stalk_lean=0):
    """Body block 12 wide x 6 tall with origin (ox, oy) at its top-left.
    Eyes/stalks are drawn above it."""
    c.rect(ox + 1, oy, ox + 10, oy, "R")          # top row (rounded)
    c.rect(ox, oy + 1, ox + 11, oy + 4, "R")      # middle
    c.rect(ox + 1, oy + 5, ox + 10, oy + 5, "D")  # underside shade
    # cheeks
    c.px(ox + 2, oy + 3, "P")
    c.px(ox + 9, oy + 3, "P")
    # mouth centred at x = ox+5..6, y = oy+3
    m = MOUTH[mouth]
    mw = len(m[0])
    c.blit(m, ox + 6 - mw // 2, oy + 3)
    # stalks + eyes  (stalk bases at ox+3 and ox+7)
    for base in (ox + 3, ox + 7):
        c.px(base + stalk_lean, oy - 1, "R")
        c.px(base + 2 * stalk_lean, oy - 2, "R")
        ex = base - 1 + 2 * stalk_lean + eye_dx
        c.blit(EYE[eye], ex, oy - 5 + eye_dy)


GROUND = 14  # every frame's lowest pixel row


def legs(c, ox, oy, phase=0, flat=False):
    """Six legs from the body underside down to GROUND. phase None = all planted;
    0/1 = alternate legs lifted one pixel (walk cycle)."""
    ly = oy + 6
    if flat:
        for x in (ox, ox + 2, ox + 4, ox + 7, ox + 9, ox + 11, ox - 2, ox - 1, ox + 12, ox + 13):
            c.px(x, GROUND, "R")
        return
    left = [ox, ox + 2, ox + 4]
    right = [ox + 7, ox + 9, ox + 11]
    for side, xs, out in (("l", left, -1), ("r", right, 1)):
        for i, x in enumerate(xs):
            up = phase is not None and (i + phase) % 2 == (1 if side == "l" else 0)
            foot = GROUND - 1 if up else GROUND
            for y in range(ly, foot):
                c.px(x, y, "R")
            c.px(x + out, foot, "R")


def small_claw(c, ox, oy):
    c.px(ox - 1, oy + 2, "R")  # arm
    c.blit(SMALL_CLAW, ox - 4, oy)


def big_claw(c, ox, oy, kind="closed", dx=0, dy=0):
    if kind == "closed":
        c.px(ox + 12, oy + 2, "R")
        c.px(ox + 13, oy + 2, "R")
        c.blit(BIG_CLAW_CLOSED, ox + 12 + dx, oy - 5 + dy)
    elif kind == "open":
        c.px(ox + 12, oy + 2, "R")
        c.blit(BIG_CLAW_OPEN, ox + 12 + dx, oy - 4 + dy)
    elif kind == "up":
        c.px(ox + 12, oy + 1, "R")
        c.blit(BIG_CLAW_UP, ox + 13 + dx, oy - 6 + dy)


# ---- frames ----------------------------------------------------------------
def frame(name):
    c = Canvas()
    ox, oy = 5, 6  # body top-left; eyes reach y=1, legs reach y=14
    if name == "idle":
        body(c, ox, oy); legs(c, ox, oy, None); small_claw(c, ox, oy); big_claw(c, ox, oy)
    elif name == "idle_b":   # glance toward the enemy side, big claw bobs up
        body(c, ox, oy, eye="look_r"); legs(c, ox, oy, None); small_claw(c, ox, oy)
        big_claw(c, ox, oy, "closed", dy=-1)
    elif name == "idle_c":   # blink
        body(c, ox, oy, eye="blink"); legs(c, ox, oy, None); small_claw(c, ox, oy); big_claw(c, ox, oy)
    elif name == "idle_d":   # breathe: body sinks 1px, claws stay
        body(c, ox, oy + 1); legs(c, ox, oy, None); small_claw(c, ox, oy); big_claw(c, ox, oy)
    elif name == "walk_a":
        oy -= 1
        body(c, ox, oy); legs(c, ox, oy, 0); small_claw(c, ox, oy); big_claw(c, ox, oy)
    elif name == "walk_b":
        body(c, ox, oy); legs(c, ox, oy, 1); small_claw(c, ox, oy); big_claw(c, ox, oy)
    elif name == "attack":
        ox += 1
        body(c, ox, oy, eye="narrow", mouth="flat"); legs(c, ox, oy, None)
        small_claw(c, ox, oy); big_claw(c, ox, oy, "open")
    elif name == "attack_hit":
        ox += 1
        body(c, ox, oy, eye="narrow", mouth="flat"); legs(c, ox, oy, None)
        small_claw(c, ox, oy); big_claw(c, ox, oy, "closed")
        for x, y in ((23, 2), (23, 9), (21, 12)):
            c.px(x, y, "C")
    elif name == "hurt":
        ox -= 1
        body(c, ox, oy, eye="shock", mouth="o", stalk_lean=-1); legs(c, ox, oy, None)
        small_claw(c, ox, oy); big_claw(c, ox, oy, "closed", dy=1)
    elif name == "victory":
        body(c, ox, oy, eye="happy", mouth="wide"); legs(c, ox, oy, None)
        small_claw(c, ox, oy); big_claw(c, ox, oy, "up")
    elif name == "ko":
        oy += 2
        body(c, ox, oy, eye="x", mouth="wavy", eye_dy=2); legs(c, ox, oy, flat=True)
        c.blit(SMALL_CLAW[1:3], ox - 4, oy + 2)
        c.blit(BIG_CLAW_CLOSED[2:6], ox + 12, oy - 1)
    return c


NAMES = ["idle", "idle_b", "idle_c", "idle_d", "walk_a", "walk_b", "attack", "attack_hit", "hurt", "victory", "ko"]
IDLE_CYCLE = ["idle", "idle_d", "idle", "idle_b", "idle", "idle", "idle_c", "idle"]

if __name__ == "__main__":
    out = Path("out/final24")
    out.mkdir(parents=True, exist_ok=True)
    strip = Image.new("RGBA", (W * len(NAMES), H), (0, 0, 0, 0))
    for i, n in enumerate(NAMES):
        c = frame(n)
        im = c.image()
        im.save(out / f"kaneed24_{i + 1:02d}_{n}.png")
        strip.alpha_composite(im, (i * W, 0))
        (out / f"kaneed24_{i + 1:02d}_{n}.txt").write_text(c.text() + "\n")
        print(f"== {n}\n{c.text()}\n")
    strip.save(out / "kaneed24_strip.png")
    # preview on the game's ground colour, 8x
    bg = (0x14, 0x11, 0x0E, 255)
    pv = Image.new("RGBA", (strip.width * 8 + 9 * 8, H * 8 + 16), bg)
    for i in range(len(NAMES)):
        f = strip.crop((i * W, 0, (i + 1) * W, H)).resize((W * 8, H * 8), Image.NEAREST)
        pv.alpha_composite(f, (8 + i * (W * 8 + 8), 8))
    pv.save(out / "preview_x8.png")
