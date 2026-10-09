"""kaneed-dungeon v0.6.0 PV（会話ログのリンク）のナレーションを Irodori-TTS v4-Large で生成する。

  python narration.py audition                       # caption のみ・seed 違い → <out>/audition/
  python narration.py lines --ref <wav> [--only 00-hook,07-cta] [--scale 03-pane=0.9]

出力: 48kHz / mono / 16bit WAV。前後の無音（-45 dBFS 未満）は 0.05 秒を残して詰める。
起動ディスクの空きが 10GB を切ったら中断する。
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import threading
import time
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, "/Volumes/AIWorkSSD/localLLM/apps/irodori-tts")
from irodori_tts.inference_runtime import (  # noqa: E402
    InferenceRuntime, RuntimeKey, SamplingRequest, download_hf_checkpoint,
)

OUT = Path(os.environ.get("PV_NARR", "/Volumes/AIWorkSSD/localLLM/outputs/kaneed-links-pv"))
CAPTION = ("落ち着いていて明るめの女性ナレーター。プロダクト紹介動画のように、"
           "聞き取りやすくはっきりと、やや速めのテンポで歯切れよく話す。")
AUDITION_TEXT = "インストールは、二行だけ。キューエー・ガイドで、迷わず答えよう。"
AUDITION_SEEDS = [111, 222, 333, 444, 555, 666, 777, 888]
LINE_SEED = 4200
DEFAULT_SCALE = 0.95  # やや速め

# 読みはカタカナ（Claude=クロード、kaneed-dungeon=カニード・ダンジョン、Finder=ファインダー、URL=ユーアールエル、0.6=ゼロテンロク）
LINES: dict[str, str | None] = {
    "00-hook": "クロードの返信に出てきた、フォルダやファイル。開くたびに、パスをコピーしていませんか？",
    "01-title": "カニード・ダンジョン、ゼロテンロク。会話ログの中のパスが、クリックで開けるようになりました。",
    "02-walk": "クロードが作業している間は、いつもどおり、カニードがダンジョンを探索。返信が届くと、パスがリンクになっています。",
    "03-dir": "フォルダのパスをクリックすると、ファインダーで開きます。",
    "04-file": "コードは、エディタで開き、行番号つきなら、その行へ、まっすぐ飛びます。",
    "05-issue": "イシューの番号や、ユーアールエルは、ブラウザで開きます。",
    "06-safe": "スクリプトは、実行されないよう、入っているフォルダまで。リンクになるのは、実在するパスだけです。",
    "07-cta": "設定は、いりません。アップデートして、再起動するだけ。会話から、すぐ開こう。",
}

MIN_FREE_GB = int(os.environ.get("MIN_FREE_GB", "10"))
TRIM_DB = -45.0
KEEP_S = 0.05


def disk_guard() -> None:
    while True:
        free_gb = shutil.disk_usage("/").free / 1024**3
        if free_gb < MIN_FREE_GB:
            print(f"[guard] ABORT boot disk free {free_gb:.1f}GB", flush=True)
            os._exit(3)
        time.sleep(2)


def trim(audio: np.ndarray, sr: int) -> np.ndarray:
    idx = np.where(np.abs(audio) > 10 ** (TRIM_DB / 20))[0]
    if idx.size == 0:
        return audio
    keep = int(KEEP_S * sr)
    out = audio[max(idx[0] - keep, 0): idx[-1] + keep + 1].copy()
    fade = int(0.01 * sr)  # 切り口のプチノイズ防止
    out[:fade] *= np.linspace(0, 1, fade)
    out[-fade:] *= np.linspace(1, 0, fade)
    return out


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("mode", choices=["audition", "lines"])
    p.add_argument("--ref")
    p.add_argument("--only", default="")
    p.add_argument("--scale", action="append", default=[])
    p.add_argument("--seed", default=str(LINE_SEED), help="カンマ区切りで複数指定すると <name>_s<seed>.wav を出す")
    p.add_argument("--suffix", default="", help="出力ファイル名の末尾（別テイク用）")
    p.add_argument("--text", action="append", default=[], help="本文の差し替え（例: 01-problem=...）")
    a = p.parse_args()

    threading.Thread(target=disk_guard, daemon=True).start()
    t0 = time.time()
    rt = InferenceRuntime.from_key(RuntimeKey(
        checkpoint=download_hf_checkpoint("Aratako/Irodori-TTS-v4-Large"), model_device="mps", codec_device="mps",
    ))
    print(f"[load] {time.time() - t0:.1f}s", flush=True)

    def synth(path: Path, text: str, seed: int, ref: str | None, scale: float) -> dict:
        t = time.time()
        res = rt.synthesize(SamplingRequest(text=text, caption=CAPTION, seed=seed, ref_wav=ref,
                                            no_ref=ref is None, duration_scale=scale), log_fn=None)
        audio = trim(res.audio.detach().cpu().float().reshape(-1).numpy(), res.sample_rate)
        path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(path, audio, res.sample_rate, subtype="PCM_16")
        info = {"file": path.name, "seconds": round(len(audio) / res.sample_rate, 2), "seed": seed,
                "duration_scale": scale, "ref": ref, "text": text, "synth_s": round(time.time() - t, 1)}
        print(json.dumps(info, ensure_ascii=False), flush=True)
        return info

    results = []
    if a.mode == "audition":
        for seed in AUDITION_SEEDS:
            results.append(synth(OUT / "audition" / f"seed{seed}.wav", AUDITION_TEXT, seed, None, DEFAULT_SCALE))
    else:
        only = {s.strip() for s in a.only.split(",") if s.strip()}
        scales = dict(s.split("=", 1) for s in a.scale)
        texts = dict(LINES)
        texts.update(dict(s.split("=", 1) for s in a.text))
        for name, text in texts.items():
            if (only and name not in only) or not text:
                if not text:
                    print(f"[skip] {name}: 原稿なし", flush=True)
                continue
            seeds = [int(x) for x in a.seed.split(",")]
            for seed in seeds:
                suffix = a.suffix + (f"_s{seed}" if len(seeds) > 1 else "")
                results.append(synth(OUT / f"{name}{suffix}.wav", text, seed, a.ref,
                                     float(scales.get(name, DEFAULT_SCALE))))
    log = OUT / f"_{a.mode}_{time.strftime('%m%d-%H%M%S')}.jsonl"
    log.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in results), encoding="utf-8")
    print(f"[done] -> {log}", flush=True)


if __name__ == "__main__":
    main()
