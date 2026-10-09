#!/usr/bin/env bash
# PV を一から作る。作業ファイルは PV_WORK（既定: tools/pv/work、git 管理外）、ナレーションは PV_NARR に置く。
#   tools/pv/build.sh            # キャプチャ → データ → BGM → 映像 2 本 → 音声を重ねて docs/media へ
# ナレーションは別に narration.py で作っておく（Irodori-TTS が要る。README 参照）。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
export PV_WORK=${PV_WORK:-$HERE/work}
mkdir -p "$PV_WORK"/{cap,audio,assets,out}
cp "$REPO"/tools/sprites/hero/{idle_0,idle_1,walk_0,walk_1,victory}.png "$PV_WORK/assets/"
bash "$HERE/capture.sh" "$PV_WORK/cap"
python3 "$HERE/ansi2json.py" "$PV_WORK/cap" "$PV_WORK/frames.json"
python3 "$HERE/data.py" "$PV_WORK/data.json"
uv run --quiet --with numpy --with soundfile python "$HERE/music.py" "$PV_WORK/audio" 80
for size in "1600 900" "720 1280"; do
  uv run --quiet --with playwright==1.63.0 python "$HERE/render.py" video $size 30
done
python3 "$HERE/mix.py" "$PV_WORK/out/video_1600x900.mp4" "$REPO/docs/media/kaneed-dungeon-pv-16x9.mp4"
python3 "$HERE/mix.py" "$PV_WORK/out/video_720x1280.mp4" "$REPO/docs/media/kaneed-dungeon-pv-9x16.mp4"
uv run --quiet --with playwright==1.63.0 python "$HERE/poster.py"
cp "$PV_WORK/out/pv-poster.jpg" "$REPO/docs/pv-poster.jpg"
echo "✔ docs/media/kaneed-dungeon-pv-{16x9,9x16}.mp4, docs/pv-poster.jpg"
