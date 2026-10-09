"""pv.html をフレームごとに撮って動画にする。

  python render.py stills <w> <h> <t1,t2,...>      # 指定時刻の静止画 → out/still_<w>x<h>_<t>.png
  python render.py video  <w> <h> [fps]             # 無音の動画 → out/video_<w>x<h>.mp4、計画 → out/plan.json
"""
from __future__ import annotations

import json
import subprocess
import sys
import wave
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).parent
WORK = Path(os.environ.get("PV_WORK", HERE / "work"))
NARR = Path(os.environ.get("PV_NARR", "/Volumes/AIWorkSSD/localLLM/outputs/kaneed-links-pv"))
OUT = WORK / "out"


def timing() -> dict[str, float]:
    t = {}
    for f in sorted(NARR.glob("0*.wav")):
        with wave.open(str(f)) as w:
            t[f.stem] = w.getnframes() / w.getframerate()
    return t


def open_page(p, w: int, h: int):
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": w, "height": h}, device_scale_factor=1)
    page.goto(f"file://{HERE / 'pv.html'}?w={w}&h={h}&assets={WORK / 'assets'}")
    frames = json.loads((WORK / "frames.json").read_text(encoding="utf-8"))
    data = json.loads((WORK / "data.json").read_text(encoding="utf-8"))
    info = page.evaluate("([f, d, t]) => PV.init(f, d, t)", [frames, data, timing()])
    return browser, page, info


def main() -> None:
    mode, w, h = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    OUT.mkdir(exist_ok=True)
    with sync_playwright() as p:
        browser, page, info = open_page(p, w, h)
        (OUT / "plan.json").write_text(json.dumps(info, ensure_ascii=False, indent=1), encoding="utf-8")
        if mode == "stills":
            for t in sys.argv[4].split(","):
                page.evaluate(f"PV.render({float(t)})")
                page.screenshot(path=str(OUT / f"still_{w}x{h}_{t}.png"))
            print(json.dumps({"total": info["total"]}))
        else:
            fps = int(sys.argv[4]) if len(sys.argv) > 4 else 30
            n = int(info["total"] * fps)
            dst = OUT / f"video_{w}x{h}.mp4"
            ff = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "image2pipe", "-framerate", str(fps), "-c:v", "mjpeg", "-i", "-",
                                   "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium", str(dst)], stdin=subprocess.PIPE)
            for i in range(n):
                page.evaluate(f"PV.render({i / fps})")
                ff.stdin.write(page.screenshot(type="jpeg", quality=92))
                if i % 150 == 0:
                    print(f"{i}/{n}", flush=True)
            ff.stdin.close()
            ff.wait()
            print(f"done {dst} {n} frames")
        browser.close()


if __name__ == "__main__":
    main()
