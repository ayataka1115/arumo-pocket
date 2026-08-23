#!/usr/bin/env bash
# アルノポケットのサーバー側（GAS）を貼り替えて、いまのデプロイを新しいバージョンにする。
#
#   bash tools/deploy-gas.sh
#
# 「新しいデプロイ」は作らない。作ると /exec の URL が変わり、
# 家族全員の「設定 > 共有」が一斉に切れるため。
# 更新するのは、いまアプリが見ている URL のデプロイそのもの。
set -euo pipefail

cd "$(dirname "$0")/.."

# clasp は 2 系に固定する。3 系で引数の形が変わっており、
# --deploymentId でいまのデプロイを更新する書き方が通らなくなるため。
CLASP="@google/clasp@2"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

say "1/4  貼る前に検証台を通す"
node tools/gas-harness.mjs gas/Code.gs
node tools/flow-harness.mjs

# アプリが見ている /exec の URL から、デプロイ ID を取り出す。
# https://script.google.com/macros/s/<ここ>/exec
say "2/4  貼り替え先を確かめる"
EXEC_URL="$(sed -n "s#.*'\(https://script\.google\.com/macros/s/[^']*\)'.*#\1#p" js/data.js | head -1)"
[ -n "$EXEC_URL" ] || die "js/data.js から共有URLを読めませんでした（DEFAULT_SHARE_URL を確認してください）"
DEPLOY_ID="$(printf '%s' "$EXEC_URL" | sed -n 's#.*/macros/s/\([^/]*\)/exec.*#\1#p')"
[ -n "$DEPLOY_ID" ] || die "共有URLからデプロイIDを取り出せませんでした：$EXEC_URL"
echo "  URL       : $EXEC_URL"
echo "  デプロイID : $DEPLOY_ID"

if [ ! -f .clasp.json ]; then
  die "$(cat <<'MSG'
.clasp.json がありません。はじめての1回だけ、次をやってください：

  npx --yes @google/clasp@2 login       # Google にログイン（ブラウザが開く）

  # スクリプトIDは Apps Script エディタの URL の
  #   https://script.google.com/home/projects/<ここ>/edit
  cat > .clasp.json <<'JSON'
  { "scriptId": "<スクリプトID>", "rootDir": "gas" }
JSON

そのあと、もう一度このスクリプトを走らせてください。
（.clasp.json と ~/.clasprc.json は .gitignore に入れてあります）
MSG
)"
fi

say "3/4  gas/ の中身を Apps Script に送る"
npx --yes "$CLASP" push --force

say "4/4  いまのデプロイを新しいバージョンにする（URL は変わらない）"
npx --yes "$CLASP" deploy --deploymentId "$DEPLOY_ID" \
  --description "arumo $(date '+%Y-%m-%d %H:%M') $(git rev-parse --short HEAD)"

say "済み。動いているか確かめます"
bash tools/check-gas.sh "$EXEC_URL"
