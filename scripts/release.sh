#!/usr/bin/env bash
# リリース 1 本分の手順。バージョンを上げ、PR を作ってマージし、タグと GitHub リリースを出す。
#
#   scripts/release.sh patch|minor|major|X.Y.Z [-n|--notes <ファイル>] [--dry-run]
#
# バージョンは plugin.json と package.json の両方を上げる（同じ番号のままだと
# 自動更新も `claude plugin update` も「最新」と判断して新しいコードを配らない）。
# リリースノートを渡さなければ、前のタグからのコミットで作る。
set -euo pipefail

cd "$(dirname "$0")/.."
BUMP=${1:-}
NOTES_FILE=""
DRY=0
shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    -n|--notes) NOTES_FILE=${2:-}; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "不明な引数: $1" >&2; exit 2 ;;
  esac
done

die() { echo "✘ $1" >&2; exit 1; }
run() { if [ "$DRY" = 1 ]; then echo "  (dry-run) $*"; else "$@"; fi }

[ -n "$BUMP" ] || die "使い方: scripts/release.sh patch|minor|major|X.Y.Z [--notes <ファイル>] [--dry-run]"
command -v gh >/dev/null || die "gh が要る"
command -v bun >/dev/null || die "bun が要る"
gh auth status >/dev/null 2>&1 || die "gh にログインしていない"
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || die "main で実行する"
[ -z "$(git status --porcelain)" ] || die "作業ツリーに未コミットの変更がある"

echo "▌main を最新にする"
git fetch -q origin
git merge -q --ff-only origin/main || die "main が origin/main と分岐している"

CURRENT=$(node -p "require('./.claude-plugin/plugin.json').version" 2>/dev/null || bun -e "console.log(require('./.claude-plugin/plugin.json').version)")
IFS=. read -r MAJOR MINOR PATCH <<<"$CURRENT"
case "$BUMP" in
  patch) NEXT="$MAJOR.$MINOR.$((PATCH + 1))" ;;
  minor) NEXT="$MAJOR.$((MINOR + 1)).0" ;;
  major) NEXT="$((MAJOR + 1)).0.0" ;;
  [0-9]*.[0-9]*.[0-9]*) NEXT=$BUMP ;;
  *) die "バージョンは patch / minor / major か X.Y.Z" ;;
esac
[ "$NEXT" != "$CURRENT" ] || die "バージョンが変わらない（${CURRENT}）"
git rev-parse -q --verify "refs/tags/v$NEXT" >/dev/null && die "タグ v$NEXT はもうある"
echo "  $CURRENT → $NEXT"

echo "▌検査（テスト・型・lint・マニフェスト）"
bun test >/dev/null
bunx -p typescript tsc -p . >/dev/null
bunx --bun oxlint@1.83.0 hooks tests --deny-warnings >/dev/null
claude plugin validate .claude-plugin/plugin.json >/dev/null
claude plugin validate . >/dev/null
echo "  ✔ 通過"

LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || true)
if [ -n "$NOTES_FILE" ]; then
  NOTES=$(cat "$NOTES_FILE")
elif [ -n "$LAST_TAG" ]; then
  NOTES=$(printf '## %s からの変更\n\n%s\n' "$LAST_TAG" "$(git log --no-merges --pretty='- %s' "$LAST_TAG"..HEAD)")
else
  NOTES=$(printf '## 変更\n\n%s\n' "$(git log --no-merges --pretty='- %s' -20)")
fi
NOTES=$(printf '%s\n\n**更新**: 自動更新を入れていれば次の起動で入る。手動なら `claude plugin update kaneed-dungeon@kaneed-dungeon`（再起動で反映）。\n' "$NOTES")

BRANCH="chore/release-$NEXT"
echo "▌バージョンを上げて PR を作る（${BRANCH}）"
run git checkout -q -b "$BRANCH"
if [ "$DRY" = 0 ]; then
  for f in .claude-plugin/plugin.json package.json; do
    perl -0pi -e "s/\"version\": \"\Q$CURRENT\E\"/\"version\": \"$NEXT\"/" "$f"
  done
  git commit -qam "chore: バージョンを $NEXT に上げる

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
fi
run git push -q -u origin "$BRANCH"
if [ "$DRY" = 0 ]; then
  gh pr create --base main --title "chore: リリース v$NEXT" \
    --body "$(printf '%s\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n' "$NOTES")" >/dev/null
  gh pr merge "$BRANCH" --merge --delete-branch >/dev/null
  git checkout -q main
  git pull -q
else
  echo "  (dry-run) gh pr create / gh pr merge"
  git checkout -q main
  git branch -q -D "$BRANCH" 2>/dev/null || true
fi

echo "▌タグとリリース v$NEXT"
run git tag -a "v$NEXT" -m "v$NEXT"
run git push -q origin "v$NEXT"
if [ "$DRY" = 0 ]; then
  gh release create "v$NEXT" --latest --title "v$NEXT" --notes "$NOTES" >/dev/null
  echo "✔ v$NEXT を公開した: $(gh release view "v$NEXT" --json url --jq .url)"
else
  echo "  (dry-run) gh release create v$NEXT"
  echo "✔ dry-run 完了（$CURRENT → ${NEXT}）"
fi
