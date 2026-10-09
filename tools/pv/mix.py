"""ナレーション・BGM・効果音を、render.py が書いた計画（out/plan.json）どおりに並べて 1 本の音声にし、
映像と合わせて仕上げる。

  python mix.py <video.mp4> <out.mp4>

BGM はナレーションに合わせて下げ（sidechaincompress）、全体を -16 LUFS に揃える。AAC 160kbps。
"""
from __future__ import annotations

import json
import subprocess
import sys
import os
from pathlib import Path

HERE = Path(__file__).parent
WORK = Path(os.environ.get("PV_WORK", HERE / "work"))
NARR = Path(os.environ.get("PV_NARR", "/Volumes/AIWorkSSD/localLLM/outputs/kaneed-links-pv"))
AUD = WORK / "audio"
SE_GAIN = {"click": 0.55, "pop": 0.5, "whoosh": 0.45, "chime": 0.5}


def main() -> None:
    video, out = sys.argv[1], sys.argv[2]
    plan = json.loads((WORK / "out" / "plan.json").read_text(encoding="utf-8"))
    total = plan["total"]
    inputs = ["-i", video, "-i", str(AUD / "bgm.wav")]
    filters = []
    narr_labels, se_labels = [], []
    idx = 2
    for s in plan["scenes"]:
        inputs += ["-i", str(NARR / f"{s['narr']}.wav")]
        ms = int(s["nstart"] * 1000)
        filters.append(f"[{idx}:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay={ms}|{ms}[n{idx}]")
        narr_labels.append(f"[n{idx}]")
        idx += 1
    for c in plan["cues"]:
        inputs += ["-i", str(AUD / f"se_{c['se']}.wav")]
        ms = int(c["t"] * 1000)
        filters.append(f"[{idx}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume={SE_GAIN[c['se']]},adelay={ms}|{ms}[s{idx}]")
        se_labels.append(f"[s{idx}]")
        idx += 1
    n = len(narr_labels)
    filters.append(f"{''.join(narr_labels)}amix=inputs={n}:normalize=0,apad[narr]")
    filters.append("[narr]asplit=2[narr_a][narr_key]")
    fade = total - 2.2
    filters.append(f"[1:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:{total:.2f},volume=0.20,afade=t=out:st={fade:.2f}:d=2.0[bgm0]")
    filters.append("[bgm0][narr_key]sidechaincompress=threshold=0.02:ratio=10:attack=30:release=500[bgm]")
    filters.append(f"{''.join(se_labels)}amix=inputs={len(se_labels)}:normalize=0[se]")
    filters.append(f"[narr_a][bgm][se]amix=inputs=3:normalize=0,atrim=0:{total:.2f},loudnorm=I=-16:TP=-1.5:LRA=11[a]")
    cmd = ["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", ";".join(filters),
           "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
           "-movflags", "+faststart", "-shortest", out]
    subprocess.run(cmd, check=True)
    print("ok", out)


if __name__ == "__main__":
    main()
