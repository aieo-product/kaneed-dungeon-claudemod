# カニード（Kaneed）デザインメモ

主人公スプライトを作った経緯と、いじるときに守る制約。2026-09-15 に別セッション（claudeModsDesign）で作成し、このリポジトリへ移した。

## 由来

- 当初は Claude Code のマスコット Clawd を使う案だったが、Anthropic の商標ガイドラインは事前許可制で、実際に「Clawdbot」が商標要請で改名（→ Moltbot、2026-01）している。MIT で公開するゲームに第三者のキャラクターは同梱できないため、**独自キャラクターに切り替えた**。
- 「Clawd を知っている人がニヤッとする」までは狙い、「Clawd 本人に見える」ラインは越えない。名前・オレンジ一色・公式スプライトの流用はしない。README では「着想元」として触れる程度に留める。
- 名前「カニード」: 「カニ」+ 外来語語尾「ード」。綴りは Kaneed（Claude / Clawd と 1 文字も揃わない）。

## キャラクター

- 赤いシオマネキ。**大きいハサミは画面右**（= 敵側。正面向きなのでカニ自身の左手）。ゲームは左に主人公、右から敵、攻撃は右へ踏み込むため。
- 目は甲羅の上に茎で 2 つ。**胴体に目は無い**。感情は茎の目と口だけで出す。
- ハチマキ等の小物は無し（ユーザー決定）。
- 色: 赤 `#e02020`、影の暗赤 `#961018`、白目 `#ffffff`、瞳・口 `#1c1c1c`、頬とハイライトのピンク/クリーム。
  - **`#000000` は使わない**（舞台の床と同化する）。瞳は `#1c1c1c`。
  - 白目は純白。クリーム色や灰色にすると 256 色化と床色で沈む。
  - 死亡の × 目、まばたきの線は**白**。黒だと背景と同化して消える。

## コマ設計（24×16、Clawd と同寸）

`tools/sprites/hero/src/kaneed24.py` がパーツ合成で描く。PNG は生成物で、手で直さない。

- 全コマとも**最下段は 14 行目**（接地面）。体を上下させるコマでは脚の長さで吸収し、脚ごと浮かせない。
- 11 コマ: idle_0 / idle_1（呼吸: 甲羅が 1px 沈む）/ idle_glance（敵側をチラ見 + 大バサミが 1px 上がる）/ idle_blink / walk_0 / walk_1 / attack_0（踏み込み・ハサミ開き）/ attack_1（ハサミ閉じ・火花）/ hurt（目の茎が後ろに倒れる）/ victory / dead。
- 待機ループ: idle_0 → idle_1 → idle_0 → idle_glance → idle_0 → idle_0 → idle_blink → idle_0。
- ターミナルは 1 文字 = 縦 2px なので、1px の上下は半セル分にしか見えない。動きを強くしたいときは 2px 単位で。

## 装備

- 5 部位 × 5 段階 = 25 枚のレイヤー（`hero/equip/`）。本体と同じ 24×16 キャンバス。描画順は 靴 → 本体 → 盾 → 剣 → 帽子 → アイウェア。
- 位置は**アンカー**で決まる（`hero/anchors.json`: hat / eyes / hand_l / hand_r / feet、コマごとに上書き。`hero/equip/anchors.json`: 各レイヤーの吸着点）。主人公を差し替えても同じ 25 枚が乗る。旧形式の `frames.json` は同じ元データから出る互換用。
- 配置の考え方: 帽子は甲羅の上で目の茎の間（目は帽子の上に出る）、アイウェアは茎の上の目に直接、盾は左の小バサミ、剣は右の大バサミの先、靴は脚の**付け根の 1 段だけ**（脚は歩きで上下するため）。
- メガネ類は白目が隠れないよう「下辺 + 両脇」の半リム。
- 予備スプライト（`fallback_pixel.png`）用のアンカーは `fallback_anchors.json`。目の間隔が違うのでアイウェアは顔の中央に寄る。ずれが気になる絵では `hero/equip/` を自分のレイヤーで上書きする。

## 更新手順

```sh
# 1. tools/sprites/hero/src/kaneed24.py（ドット）や hero_export.py（装備・アンカー）を編集
uv run tools/sprites/hero/src/hero_export.py .                 # 2. PNG / frames.json / anchors.json / preview を書き出す
uv run tools/sprites/hero/src/anchor_preview.py                # 3. 予備スプライトとの比較プレビュー
python3 tools/sprites/make_sprites.py hooks/boards/sprites.ts  # 4. ゲームのスプライトデータ
bunx -p typescript tsc -p . && bun test                        # 5. 検証
uv run tools/sprites/hero/src/dressup_build.py                 # 6. ギャラリーの着せ替えページを再生成 → artifact の dressup.html として公開
```

変更は issue → feature ブランチ → PR（main 直 push 不可）。

## 制作の途中経過（`tools/sprites/hero/concept/`）

- Higgsfield MCP（GPT Image 2.5）で 4 方向のキャラ案 → シオマネキ案に決定 → NES 3 色制約 → 敵と同じ絵柄（黒背景・約 40px・平塗り）→ 胴体の目を削除 → 大バサミを右へ、の順に詰めた。最終案の元絵が `concept/` にある。
- 元絵は格子が均一ではないため、`hero/src/pixelize.py` で格子を検出して 1 マス = 1px に落とし、35×26 前後の実寸を得た。24×16 にはこの絵を見ながら `kaneed24.py` で手打ちし直した（機械縮小では目と口が潰れる）。
- 生成 AI の出力は日本の現行法では著作権が生じにくい。手打ちした `kaneed24.py` の部分には人の創作が入る。
