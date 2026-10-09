# PV（デモ動画）の作り方

`docs/media/kaneed-dungeon-pv-{16x9,9x16}.mp4`（v0.6.0「会話ログのリンク」の紹介、約 66 秒）を作るスクリプト一式。

- **ターミナルの画面は実物**。`capture.sh` が tmux の中で実際の Claude Code とこのリポジトリの kaneed-dungeon を動かし、画面バッファ（色と OSC 8 のリンク情報つき）を 0.25 秒ごとに保存する。`ansi2json.py` がそれをセル単位の JSON にし、`pv.html` が canvas に描き直す。
- **開いた先の窓（Finder・エディタ・ブラウザ）は HTML で描いた再現**。中身は `data.py` が集めた実データ（`hooks/links/` の一覧、`linkify.ts` のコード、issue #50）。デスクトップは撮っていない。
- **ナレーション**は Irodori-TTS v4-Large（Gemma Terms of Use）で、`narration.py` が作る。qa-guide の PV と同じ参照音声・設定。読みは whisper で聞き取り直して確認した。
- **BGM と効果音**は `music.py` が numpy で合成するオリジナル（チップチューン）。

## 手順

```sh
# 1. ナレーション（Irodori-TTS の環境で。出力先は PV_NARR）
python tools/pv/narration.py lines --ref <参照音声.wav>
# 2. それ以外を全部（キャプチャ → データ → BGM → 映像 2 本 → 音声の合成 → docs/media）
tools/pv/build.sh
```

要るもの: tmux、Claude Code（function hooks 有効）、`gh`、`ffmpeg`、`uv`（Playwright・numpy・soundfile を一時的に入れる）。作業ファイルは `PV_WORK`（既定 `tools/pv/work/`、git 管理外）に出る。

| ファイル | 役割 |
|---|---|
| `capture.sh` | 実際の Claude Code を tmux で動かし、画面バッファを保存する |
| `ansi2json.py` | 画面バッファ（SGR・OSC 8）→ セル単位の JSON |
| `data.py` | 窓に出す実データ（フォルダの一覧・コード・issue） |
| `pv.html` | 構成とアニメーション。`PV.render(t)` で任意の時刻を描く |
| `render.py` | Playwright で 30fps に撮って映像にする。静止画の確認もできる |
| `music.py` | BGM と効果音の合成 |
| `mix.py` | ナレーション・BGM（ナレーション中は下げる）・効果音を重ね、-16 LUFS に揃える |
| `narration.py` | ナレーションの生成（台本もここ） |
| `poster.py` | README 用のポスター画像 |
