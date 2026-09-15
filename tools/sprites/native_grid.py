#!/usr/bin/env python3
"""Recover the native pixel grid of an AI-drawn pixel-art render and read it out 1:1.

The renders are clean blocks of flat colour on black. Along each row and column, runs of one
colour are multiples of the cell size; the most common run length (ignoring the background)
is the cell. The phase is the offset that puts colour changes on cell borders. Sampling each
cell at its centre then gives the art exactly as drawn, with no resampling to break it.

    python3 native_grid.py in.png out.png [--max-height N] [--rows R]

--max-height shrinks by an integer factor (2, 3 ...) with per-block majority colour when the
native art is taller than N; the result is still crisp, just coarser."""
import sys
from collections import Counter
from PIL import Image


def load(path):
    # a transparent render is laid over black, so its empty cells read as background
    im = Image.open(path).convert('RGBA')
    flat = Image.new('RGBA', im.size, (0, 0, 0, 255))
    flat.alpha_composite(im)
    im = flat.convert('RGB')
    return im, im.load()


def is_bg(p):
    return p[0] < 40 and p[1] < 40 and p[2] < 40


def runs_along(im, px, axis):
    w, h = im.size
    lengths = Counter()
    outer, inner = (h, w) if axis == 'x' else (w, h)
    for o in range(0, outer, 3):
        prev = None
        n = 0
        for i in range(inner):
            p = px[i, o] if axis == 'x' else px[o, i]
            if prev is not None and sum(abs(p[k] - prev[k]) for k in range(3)) < 60:
                n += 1
            else:
                if prev is not None and not is_bg(prev) and 6 <= n <= 120:
                    lengths[n] += 1
                prev = p
                n = 1
        if prev is not None and not is_bg(prev) and 6 <= n <= 120:
            lengths[n] += 1
    return lengths


def cell_size(im, px):
    lengths = runs_along(im, px, 'x') + runs_along(im, px, 'y')
    if not lengths:
        return None
    # score each candidate cell by how many runs are (near) multiples of it, weighted toward
    # the smallest cell that explains the runs
    scores = {}
    for c in range(8, 80):
        score = 0
        for n, count in lengths.items():
            k = round(n / c)
            if k >= 1 and abs(n - k * c) <= max(1.5, c * 0.12):
                score += count / k
        scores[c] = score
    top = max(scores.values())
    # a doubled cell explains the runs almost as well as the true one; take the smallest cell
    # that is nearly as good, and whose half is clearly worse (so a real cell is not halved)
    for c in sorted(scores):
        if scores[c] >= top * 0.7 and scores.get(c // 2, 0) < scores[c] * 0.7:
            return c
    return max(scores, key=scores.get)


def bbox(im, px):
    w, h = im.size
    xs = [x for x in range(w) if any(not is_bg(px[x, y]) for y in range(0, h, 2))]
    ys = [y for y in range(h) if any(not is_bg(px[x, y]) for x in range(0, w, 2))]
    return xs[0], ys[0], xs[-1] + 1, ys[-1] + 1


def sample(im, px, cell, box):
    x0, y0, x1, y1 = box
    cols = max(1, round((x1 - x0) / cell))
    rows = max(1, round((y1 - y0) / cell))
    sx = (x1 - x0) / cols
    sy = (y1 - y0) / rows
    out = Image.new('RGBA', (cols, rows), (0, 0, 0, 0))
    for r in range(rows):
        for c in range(cols):
            # majority colour in the inner 60% of the cell, so edges never bleed in
            votes = Counter()
            for fy in (0.3, 0.5, 0.7):
                for fx in (0.3, 0.5, 0.7):
                    p = px[min(im.width - 1, int(x0 + (c + fx) * sx)), min(im.height - 1, int(y0 + (r + fy) * sy))]
                    votes[(p[0] // 8 * 8, p[1] // 8 * 8, p[2] // 8 * 8)] += 1
            col = votes.most_common(1)[0][0]
            if not is_bg(col):
                out.putpixel((c, r), col + (255,))
    return out


def is_outline(p):
    return p[3] and p[0] < 50 and p[1] < 50 and p[2] < 50


# the shrink can regrow a black outline around the silhouette; off for outline-free art
OUTLINE = False


def shrink(img, factor):
    """Structure-preserving integer shrink, in the spirit of PixelRefiner's cleanup passes:
    1. each block takes the majority of its *interior* colours (the black outline does not vote,
       so it cannot swallow a thin limb), with rare colours (eyes, highlights) weighted up so a
       single bright pixel survives the block it sits in;
    2. a block is solid when at least a third of it was drawn;
    3. the outline is put back afterwards by growing one pixel around the silhouette, so every
       enemy keeps the crisp black edge of the original at any size;
    4. stray single pixels that match none of their neighbours are smoothed away."""
    w, h = img.width // factor, img.height // factor
    freq = Counter()
    for y in range(img.height):
        for x in range(img.width):
            p = img.getpixel((x, y))
            if p[3] and not is_outline(p):
                freq[p] += 1
    out = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    for y in range(h):
        for x in range(w):
            votes = Counter()
            drawn = 0
            for dy in range(factor):
                for dx in range(factor):
                    p = img.getpixel((x * factor + dx, y * factor + dy))
                    if not p[3]:
                        continue
                    drawn += 1
                    if not is_outline(p):
                        votes[p] += 1.0 / (freq[p] ** 0.5)
            if drawn * 3 < factor * factor:
                continue
            if votes:
                out.putpixel((x, y), votes.most_common(1)[0][0])
            else:
                out.putpixel((x, y), (0, 0, 0, 255))
    # despeckle: a lone pixel unlike all four neighbours takes the commonest neighbour
    fixed = out.copy()
    for y in range(h):
        for x in range(w):
            p = out.getpixel((x, y))
            if not p[3]:
                continue
            around = [out.getpixel((x + dx, y + dy)) for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)) if 0 <= x + dx < w and 0 <= y + dy < h]
            opaque = [q for q in around if q[3]]
            if opaque and all(q != p for q in opaque) and len(opaque) >= 3:
                fixed.putpixel((x, y), Counter(opaque).most_common(1)[0][0])
    out = fixed
    if not OUTLINE:
        return out
    # outline: grow one black pixel around the silhouette (padded so the edge has room)
    padded = Image.new('RGBA', (w + 2, h + 2), (0, 0, 0, 0))
    padded.paste(out, (1, 1))
    lined = padded.copy()
    for y in range(h + 2):
        for x in range(w + 2):
            if padded.getpixel((x, y))[3]:
                continue
            if any(0 <= x + dx < w + 2 and 0 <= y + dy < h + 2 and padded.getpixel((x + dx, y + dy))[3] for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                lined.putpixel((x, y), (0, 0, 0, 255))
    return lined


def trim(img):
    box = img.getchannel('A').getbbox()
    return img.crop(box) if box else img


def convert(src, dst, max_height=None, force_rows=None):
    """force_rows lays our own grid over the drawing (that many rows tall, columns from the
    aspect ratio) instead of the render's native cell; each cell becomes one pixel by majority."""
    im, px = load(src)
    box = bbox(im, px)
    if force_rows:
        cell = (box[3] - box[1]) / force_rows
    else:
        cell = cell_size(im, px)
    art = trim(sample(im, px, cell, box))
    factor = 1
    if max_height and art.height > max_height:
        factor = -(-art.height // (max_height - (2 if OUTLINE else 0)))
        art = trim(shrink(art, factor))
    art.save(dst)
    return cell, factor, art.size


if __name__ == '__main__':
    args = sys.argv[1:]
    mh = None
    if '--max-height' in args:
        i = args.index('--max-height')
        mh = int(args[i + 1])
        del args[i:i + 2]
    fr = None
    if '--rows' in args:
        i = args.index('--rows'); fr = int(args[i + 1]); del args[i:i + 2]
    cell, factor, size = convert(args[0], args[1], mh, fr)
    print(f'{args[0]}: cell {cell}px, factor 1/{factor}, out {size[0]}x{size[1]}')
