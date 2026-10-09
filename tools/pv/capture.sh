#!/usr/bin/env bash
# Runs the real Claude Code with this repo's kaneed-dungeon in tmux and saves the screen buffer
# (ANSI colours and OSC 8 links included) at intervals, for the PV to draw from.
#   capture.sh <out-dir>
set -euo pipefail
OUT=${1:?out dir}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
S=kdpv
COLS=120
ROWS=42
mkdir -p "$OUT"
rm -f "$OUT"/*.ans
tmux kill-session -t $S 2>/dev/null || true
tmux new-session -d -s $S -x $COLS -y $ROWS -c "$REPO" "claude --plugin-dir $REPO --model haiku"
snap() { tmux capture-pane -p -e -t $S > "$OUT/$1.ans"; }
sleep 14
snap idle

# 1. Claude works for a while (Kaneed walks): a Bash sleep, then the reply with paths and #N
PROMPT='まず Bash で sleep 9 を実行して。そのあとツールを使わずに、次の文章を一字一句そのまま出力して（前置き・後書きなし）:
リンクの書き換えを直しました。
- 変更したフォルダ: hooks/links/
- 書き換えの本体: hooks/links/linkify.ts:245
- 設計メモ: docs/kaneed-design.md
- リリース手順: scripts/release.sh
関連 issue は #50 です。リリースノート: https://github.com/aieo-product/kaneed-dungeon-claudemod/releases/tag/v0.6.0'
tmux send-keys -t $S -l "$PROMPT"
sleep 1
snap typed
tmux send-keys -t $S C-m
# while it works: a frame every 0.25 s
for i in $(seq -w 0 99); do
  snap "work_$i"
  sleep 0.25
  if tmux capture-pane -p -t $S | grep -q "リリースノート: https"; then break; fi
done
sleep 4
snap done
for i in $(seq -w 0 39); do snap "after_$i"; sleep 0.25; done
tmux kill-session -t $S
ls "$OUT" | wc -l
