"""tmux capture-pane -e の出力（SGR と OSC 8）を、セル単位の JSON に変える。

  python ansi2json.py <cap-dir> <out.json>

各フレーム: {"name", "rows": [[ [text, fg, bg, flags, linkIndex], ... ], ...], "links": [href, ...]}
text は 1 セル分（全角は幅 2 として次のセルを空文字で埋める）。fg/bg は "#rrggbb" か null（既定）。
flags: 1=bold 2=dim 4=italic 8=underline。
"""
from __future__ import annotations

import json
import re
import sys
import unicodedata
from pathlib import Path

COLS = 120


def palette() -> list[str]:
    base = ["000000", "cd3131", "0dbc79", "e5e510", "2472c8", "bc3fbc", "11a8cd", "e5e5e5",
            "666666", "f14c4c", "23d18b", "f5f543", "3b8eea", "d670d6", "29b8db", "ffffff"]
    out = [f"#{c}" for c in base]
    steps = [0, 95, 135, 175, 215, 255]
    for r in steps:
        for g in steps:
            for b in steps:
                out.append(f"#{r:02x}{g:02x}{b:02x}")
    for i in range(24):
        v = 8 + 10 * i
        out.append(f"#{v:02x}{v:02x}{v:02x}")
    return out


PAL = palette()
TOKEN = re.compile(r"\x1b\[([0-9;:]*)m|\x1b\]8;([^;\x1b]*);([^\x1b\x07]*)(?:\x1b\\|\x07)|\x1b\[[0-9;?]*[A-Za-z]|(.)", re.S)


def width(ch: str) -> int:
    if unicodedata.combining(ch):
        return 0
    return 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1


def parse(text: str) -> dict:
    links: list[str] = []
    rows = []
    for line in text.split("\n"):
        fg = bg = None
        flags = 0
        link = -1
        cells: list[list] = []
        for m in TOKEN.finditer(line):
            sgr, _params, href, ch = m.group(1), m.group(2), m.group(3), m.group(4)
            if sgr is not None:
                parts = [int(p) if p else 0 for p in re.split(r"[;:]", sgr)] if sgr else [0]
                i = 0
                while i < len(parts):
                    p = parts[i]
                    if p == 0:
                        fg = bg = None; flags = 0
                    elif p == 1: flags |= 1
                    elif p == 2: flags |= 2
                    elif p == 3: flags |= 4
                    elif p == 4: flags |= 8
                    elif p == 22: flags &= ~3
                    elif p == 23: flags &= ~4
                    elif p == 24: flags &= ~8
                    elif 30 <= p <= 37: fg = PAL[p - 30]
                    elif 90 <= p <= 97: fg = PAL[p - 90 + 8]
                    elif 40 <= p <= 47: bg = PAL[p - 40]
                    elif 100 <= p <= 107: bg = PAL[p - 100 + 8]
                    elif p == 39: fg = None
                    elif p == 49: bg = None
                    elif p in (38, 48) and i + 1 < len(parts):
                        if parts[i + 1] == 5 and i + 2 < len(parts):
                            c = PAL[parts[i + 2] % 256]; i += 2
                        elif parts[i + 1] == 2 and i + 4 < len(parts):
                            c = "#%02x%02x%02x" % tuple(parts[i + 2:i + 5]); i += 4
                        else:
                            c = None
                        if p == 38: fg = c
                        else: bg = c
                    i += 1
            elif href is not None:
                if href:
                    if href not in links:
                        links.append(href)
                    link = links.index(href)
                else:
                    link = -1
            elif ch is not None:
                if ch in "\r\x07" or ord(ch) < 32:
                    continue
                w = width(ch)
                if w == 0:
                    if cells:
                        cells[-1][0] += ch
                    continue
                cells.append([ch, fg, bg, flags, link])
                if w == 2:
                    cells.append(["", fg, bg, flags, link])
        while len(cells) < COLS:
            cells.append([" ", None, None, 0, -1])
        rows.append(cells[:COLS])
    return {"rows": rows, "links": links}


def main() -> None:
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    frames = {}
    for f in sorted(src.glob("*.ans")):
        frames[f.stem] = parse(f.read_text(encoding="utf-8", errors="replace").rstrip("\n"))
    out.write_text(json.dumps(frames, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(frames)} frames -> {out} ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
