# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow", "numpy"]
# ///
"""Convert AI-generated 'pixel art' (non-uniform grid) into true 1-cell = 1-px sprites.

- detects the pixel grid (cell size + offset) from colour edges
- samples the median colour of each cell
- flood-fills background from the border, strips the black outline
- snaps colours to a small fixed palette, writes real-size RGBA PNG + 8x preview
"""
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

PALETTE = {
    "red": (224, 32, 32),
    "dark": (150, 16, 24),
    "cream": (252, 228, 184),
    "pink": (240, 128, 160),
    "black": (0, 0, 0),
}


def _peaks(d, thr=0.12, win=3):
    d = d / (d.max() + 1e-9)
    ps = []
    for i in range(len(d)):
        if d[i] < thr:
            continue
        lo, hi = max(0, i - win), min(len(d), i + win + 1)
        if d[i] >= d[lo:hi].max():
            if not ps or i - ps[-1] > win:
                ps.append(i)
    return np.array(ps)


def _boundaries(d, n):
    """Edge profile -> list of cell boundary positions (handles drifting AI grids)."""
    ps = _peaks(d)
    gaps = np.diff(ps)
    small = gaps[(gaps >= 5) & (gaps <= 40)]
    hist = np.bincount(np.round(small).astype(int))
    # fundamental cell = smallest well-populated gap bin
    order = np.argsort(hist)[::-1]
    top = hist[order[0]]
    cell = min(g for g in order[:6] if hist[g] >= top * 0.3)
    # refine: mean of gaps within +-25% of cell
    near = small[(small > cell * 0.75) & (small < cell * 1.25)]
    cell = float(near.mean()) if len(near) else float(cell)
    b = [int(ps[0]) + 1]
    for p0, p1 in zip(ps[:-1], ps[1:]):
        k = max(1, int(round((p1 - p0) / cell)))
        for t in range(1, k + 1):
            b.append(int(round(p0 + (p1 - p0) * t / k)) + 1)
    # extend to the image edges
    while b[0] - cell > 0:
        b.insert(0, int(round(b[0] - cell)))
    while b[-1] + cell < n:
        b.append(int(round(b[-1] + cell)))
    b = [0] + b + [n]
    return sorted(set(x for x in b if 0 <= x <= n)), cell


def _run_lengths(g, axis):
    """Colour-run lengths along every line of the image (axis=1: rows)."""
    lines = g if axis == 1 else g.T
    out = []
    for line in lines[::3]:
        d = np.abs(np.diff(line))
        idx = np.where(d > 60)[0]
        if len(idx) < 2:
            continue
        b = [idx[0]]
        for i in idx[1:]:
            if i - b[-1] > 2:
                b.append(i)
        out.extend(np.diff(b).tolist())
    return np.array(out)


def _estimate_cell(runs):
    runs = runs[(runs >= 6) & (runs <= 60)]
    h = np.bincount(runs)
    # smooth a little, then take the first strong local maximum (fundamental)
    s = np.convolve(h, [1, 2, 1], mode="same")
    peak = s.max()
    for i in range(6, len(s)):
        if s[i] >= 0.5 * peak and s[i] >= s[i - 1] and s[i] >= s[min(i + 1, len(s) - 1)]:
            lo, hi = max(6, i - 2), min(len(h), i + 3)
            w = h[lo:hi]
            return float((np.arange(lo, hi) * w).sum() / max(w.sum(), 1))
    return float(s.argmax())


def _fit_period(d, est, n):
    d = d / (d.max() + 1e-9)
    best = (0, est, 0)
    for s in np.arange(est * 0.85, est * 1.15, 0.05):
        for o in np.arange(0.0, s, 0.25):
            idx = np.round(np.arange(o, n - 1, s)).astype(int)
            idx = idx[idx < len(d)]
            sc = d[idx].mean()
            if sc > best[0]:
                best = (sc, s, o)
    _, s, o = best
    b = list(np.round(np.arange(o + 1, n, s)).astype(int))
    if b[0] > 0:
        b = [0] + b
    if b[-1] < n:
        b.append(n)
    return b, s


def detect_grid(arr):
    g = arr.astype(np.float32).sum(axis=2)
    dx = np.abs(np.diff(g, axis=1)).sum(axis=0)
    dy = np.abs(np.diff(g, axis=0)).sum(axis=1)
    est_x = _estimate_cell(_run_lengths(g, 1))
    est_y = _estimate_cell(_run_lengths(g, 0))
    # AI grids are square-ish: share one estimate to avoid one axis locking onto a harmonic
    est = float(np.median([est_x, est_y]))
    bx, cw = _fit_period(dx, est, arr.shape[1])
    by, ch = _fit_period(dy, est, arr.shape[0])
    return bx, by, cw, ch


def sample_cells(arr, bx, by):
    out = np.zeros((len(by) - 1, len(bx) - 1, 3), np.uint8)
    for j in range(len(by) - 1):
        y0, y1 = by[j], by[j + 1]
        for i in range(len(bx) - 1):
            x0, x1 = bx[i], bx[i + 1]
            mx, my = (x1 - x0) * 0.3, (y1 - y0) * 0.3
            cx0, cx1 = int(round(x0 + mx)), int(round(x1 - mx))
            cy0, cy1 = int(round(y0 + my)), int(round(y1 - my))
            cx1, cy1 = max(cx1, cx0 + 1), max(cy1, cy0 + 1)
            block = arr[cy0:cy1, cx0:cx1].reshape(-1, 3)
            out[j, i] = np.median(block, axis=0)
    return out


def classify(cells):
    """Return label grid: 'bg' | palette name."""
    h, w = cells.shape[:2]
    lum = cells.astype(int).sum(axis=2) / 3
    dark = lum < 70
    labels = np.full((h, w), "", dtype=object)
    # flood fill bg over dark cells from the border
    bg = np.zeros((h, w), bool)
    q = deque()
    for y in range(h):
        for x in (0, w - 1):
            if dark[y, x] and not bg[y, x]:
                bg[y, x] = True
                q.append((y, x))
    for x in range(w):
        for y in (0, h - 1):
            if dark[y, x] and not bg[y, x]:
                bg[y, x] = True
                q.append((y, x))
    while q:
        y, x = q.popleft()
        for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if 0 <= ny < h and 0 <= nx < w and dark[ny, nx] and not bg[ny, nx]:
                bg[ny, nx] = True
                q.append((ny, nx))
    names = [k for k in PALETTE if k != "black"]
    cols = np.array([PALETTE[k] for k in names], float)
    for y in range(h):
        for x in range(w):
            if bg[y, x]:
                labels[y, x] = "bg"
            elif dark[y, x]:
                labels[y, x] = "black"
            else:
                d = ((cols - cells[y, x].astype(float)) ** 2).sum(axis=1)
                labels[y, x] = names[int(d.argmin())]
    return labels


def strip_outline(labels):
    h, w = labels.shape
    out = labels.copy()
    for y in range(h):
        for x in range(w):
            if labels[y, x] != "black":
                continue
            for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if not (0 <= ny < h and 0 <= nx < w) or labels[ny, nx] == "bg":
                    out[y, x] = "bg"
                    break
    return out


def render(labels):
    h, w = labels.shape
    img = np.zeros((h, w, 4), np.uint8)
    for y in range(h):
        for x in range(w):
            k = labels[y, x]
            if k != "bg":
                img[y, x, :3] = PALETTE[k]
                img[y, x, 3] = 255
    ys, xs = np.where(img[:, :, 3] > 0)
    if len(ys) == 0:
        return img
    return img[ys.min(): ys.max() + 1, xs.min(): xs.max() + 1]


def shrink(labels, f):
    """Reduce label grid by integer factor f using majority vote per block."""
    h, w = labels.shape
    H, W = h // f, w // f
    out = np.full((H, W), "bg", dtype=object)
    for y in range(H):
        for x in range(W):
            blk = labels[y * f:(y + 1) * f, x * f:(x + 1) * f].ravel().tolist()
            fg = [k for k in blk if k != "bg"]
            if len(fg) * 2 < len(blk):
                continue
            # prefer feature colours (eyes / mouth) over body colour on ties
            wt = {"black": 3.0, "cream": 2.5, "pink": 2.0, "dark": 1.0, "red": 1.0}
            best = max(set(fg), key=lambda k: (fg.count(k) * wt[k], wt[k]))
            out[y, x] = best
    return out


def process(arr, keep_outline=False, factor=1):
    bx, by, cw, ch = detect_grid(arr)
    cells = sample_cells(arr, bx, by)
    labels = classify(cells)
    if not keep_outline:
        labels = strip_outline(labels)
    # crop to content before shrinking so blocks align to the sprite
    ys, xs = np.where(labels != "bg")
    labels = labels[ys.min(): ys.max() + 1, xs.min(): xs.max() + 1]
    if factor > 1:
        labels = shrink(labels, factor)
    return render(labels), (cw, ch)


def save(img, path, scale=8):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    im = Image.fromarray(img, "RGBA")
    im.save(path)
    im.resize((im.width * scale, im.height * scale), Image.NEAREST).save(
        str(path).replace(".png", f"_x{scale}.png"))
    return im.size


if __name__ == "__main__":
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2])
    cols = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    rows = int(sys.argv[4]) if len(sys.argv) > 4 else 1
    factor = int(sys.argv[5]) if len(sys.argv) > 5 else 1
    arr = np.array(Image.open(src).convert("RGB"))
    H, W = arr.shape[:2]
    cw, ch = W // cols, H // rows
    n = 0
    for r in range(rows):
        for c in range(cols):
            sub = arr[r * ch:(r + 1) * ch, c * cw:(c + 1) * cw]
            img, cell = process(sub, factor=factor)
            n += 1
            name = dst if cols * rows == 1 else dst.with_name(f"{dst.stem}_{n}.png")
            size = save(img, name)
            print(f"{name.name}: {size[0]}x{size[1]} px  (cell {cell[0]:.2f}x{cell[1]:.2f})")
