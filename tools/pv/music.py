"""PV 用のオリジナル BGM（チップチューン）と効果音を合成する。

  python music.py <out-dir> <seconds>

bgm.wav: 116 BPM、C - G - Am - F の 4 小節ループ。矩形波のアルペジオ、三角波のベース、ノイズのハイハット。
最後の 2 秒でフェードアウト。se_click.wav / se_pop.wav / se_whoosh.wav / se_chime.wav も書き出す。
48kHz / 16bit / ステレオ。
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 48000
BPM = 116
BEAT = 60 / BPM
rng = np.random.default_rng(7)


def midi(n: float) -> float:
    return 440.0 * 2 ** ((n - 69) / 12)


def env(n: int, a=0.005, r=0.08) -> np.ndarray:
    e = np.ones(n)
    ai, ri = int(a * SR), int(r * SR)
    if ai: e[:ai] = np.linspace(0, 1, ai)
    if ri and ri < n: e[-ri:] *= np.linspace(1, 0, ri)
    return e


def square(f: float, dur: float, duty=0.25) -> np.ndarray:
    t = np.arange(int(dur * SR)) / SR
    return np.where((t * f) % 1 < duty, 1.0, -1.0)


def tri(f: float, dur: float) -> np.ndarray:
    t = np.arange(int(dur * SR)) / SR
    return 2 * np.abs(2 * ((t * f) % 1) - 1) - 1


def noise(dur: float) -> np.ndarray:
    return rng.uniform(-1, 1, int(dur * SR))


def place(buf: np.ndarray, sig: np.ndarray, at: float, gain: float) -> None:
    i = int(at * SR)
    j = min(len(buf), i + len(sig))
    if i < j:
        buf[i:j] += sig[: j - i] * gain


def bgm(seconds: float) -> np.ndarray:
    n = int(seconds * SR)
    lead = np.zeros(n); bass = np.zeros(n); drums = np.zeros(n); pad = np.zeros(n)
    # C, G, Am, F（ルートの MIDI と和音）
    chords = [(48, [60, 64, 67, 72]), (43, [59, 62, 67, 71]), (45, [57, 60, 64, 69]), (41, [57, 60, 65, 69])]
    melody = [  # 1 小節 8 個の 8 分音符（None は休符）、4 小節
        [72, None, 76, 79, 76, None, 74, 72],
        [71, None, 74, 79, 74, None, 72, 71],
        [69, None, 72, 76, 72, 74, 76, None],
        [77, 76, 74, 72, 69, None, 72, None],
    ]
    bar = 4 * BEAT
    t = 0.0
    bar_i = 0
    while t < seconds:
        root, notes = chords[bar_i % 4]
        section = int(t // (bar * 4))
        # ベース: 8 分でルートとオクターブ
        for k in range(8):
            f = midi(root + (12 if k % 2 else 0))
            place(bass, tri(f, BEAT / 2 * 0.9) * env(int(BEAT / 2 * 0.9 * SR), r=0.03), t + k * BEAT / 2, 0.5)
        # アルペジオ: 16 分
        for k in range(16):
            f = midi(notes[k % 4])
            d = BEAT / 4 * 0.8
            place(pad, square(f, d, 0.125) * env(int(d * SR), r=0.02), t + k * BEAT / 4, 0.10)
        # メロディ: 2 周目から
        if section >= 1:
            for k, m in enumerate(melody[bar_i % 4]):
                if m is None:
                    continue
                d = BEAT / 2 * 0.85
                place(lead, square(midi(m), d, 0.5) * env(int(d * SR), r=0.05), t + k * BEAT / 2, 0.13)
        # ドラム: キック（下降サイン）、スネア（ノイズ）、ハット
        for k in range(4):
            bt = t + k * BEAT
            if k in (0, 2):
                d = 0.12
                tt = np.arange(int(d * SR)) / SR
                kick = np.sin(2 * np.pi * (120 * tt - 300 * tt ** 2)) * np.exp(-tt * 30)
                place(drums, kick, bt, 0.55)
            else:
                d = 0.1
                place(drums, noise(d) * np.exp(-np.arange(int(d * SR)) / SR * 35), bt, 0.22)
            for h in (0, 0.5):
                d = 0.03
                place(drums, noise(d) * np.exp(-np.arange(int(d * SR)) / SR * 120), bt + h * BEAT, 0.08)
        t += bar
        bar_i += 1
    mix_l = lead * 0.9 + bass + drums + pad * 1.1
    mix_r = lead * 1.1 + bass + drums + pad * 0.9
    out = np.stack([mix_l, mix_r], axis=1)
    fade_in, fade_out = int(0.4 * SR), int(2.0 * SR)
    out[:fade_in] *= np.linspace(0, 1, fade_in)[:, None]
    out[-fade_out:] *= np.linspace(1, 0, fade_out)[:, None]
    return out / (np.max(np.abs(out)) + 1e-9) * 0.8


def se() -> dict[str, np.ndarray]:
    out = {}
    d = 0.06
    out["click"] = square(1800, d, 0.5) * np.exp(-np.arange(int(d * SR)) / SR * 70) * 0.5
    d = 0.14
    tt = np.arange(int(d * SR)) / SR
    out["pop"] = np.sin(2 * np.pi * (500 * tt + 2500 * tt ** 2)) * np.exp(-tt * 25) * 0.6
    d = 0.45
    tt = np.arange(int(d * SR)) / SR
    w = noise(d)
    # 簡単なローパス（移動平均の幅を時間で変える）でスイープ
    k = np.clip((1 - tt / d) * 40 + 2, 2, 42).astype(int)
    cs = np.cumsum(np.concatenate([[0], w]))
    idx = np.arange(len(w))
    lo = np.maximum(idx - k, 0)
    sw = (cs[idx + 1] - cs[lo]) / (idx + 1 - lo)
    out["whoosh"] = sw * np.sin(np.pi * tt / d) * 1.4
    chime = np.zeros(int(0.9 * SR))
    for i, m in enumerate([79, 84, 88]):
        dd = 0.6
        place(chime, square(midi(m), dd, 0.25) * np.exp(-np.arange(int(dd * SR)) / SR * 6), i * 0.09, 0.25)
    out["chime"] = chime
    return out


def main() -> None:
    outdir, seconds = Path(sys.argv[1]), float(sys.argv[2])
    outdir.mkdir(parents=True, exist_ok=True)
    sf.write(outdir / "bgm.wav", bgm(seconds), SR, subtype="PCM_16")
    for name, sig in se().items():
        sf.write(outdir / f"se_{name}.wav", np.stack([sig, sig], axis=1), SR, subtype="PCM_16")
    print("ok", seconds)


if __name__ == "__main__":
    main()
