#!/usr/bin/env bash
# 貼り替えたサーバーが、ちゃんと新しい中身で動いているか確かめる。
#
#   bash tools/check-gas.sh [/exec のURL]
#
# URL を省くと js/data.js の共有URLを使う。
set -euo pipefail

cd "$(dirname "$0")/.."

URL="${1:-$(sed -n "s#.*'\(https://script\.google\.com/macros/s/[^']*\)'.*#\1#p" js/data.js | head -1)}"
[ -n "$URL" ] || { echo "URL が分かりません" >&2; exit 1; }

PROBE_HOUSE="probe-delete-me-$(date '+%Y%m%d-%H%M%S')"
fail=0
ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }
ng()  { printf '  \033[31m✗\033[0m %s\n' "$*"; fail=1; }
post() { curl -sS -L --max-time 90 -X POST "$URL" --data-raw "$1"; }

printf '\n\033[1m▸ つながるか\033[0m\n'
GET="$(curl -sS -L --max-time 60 "$URL")"
case "$GET" in
  *'稼働中'*) ok "共有APIが応答した" ;;
  *) ng "応答が想定と違う：$(printf '%s' "$GET" | head -c 200)" ;;
esac

printf '\n\033[1m▸ 新しい中身が載っているか（Gemini は使いません）\033[0m\n'
# 一度も同期していない家。新しい中身なら code:"unknown-house" が付いて返る
R1="$(post '{"house":"never-synced-probe-zzzz","action":"recognize","image":"data:image/jpeg;base64,AAA"}')"
case "$R1" in
  *'"code":"unknown-house"'*) ok "新しい中身が載っている" ;;
  *'この家族コードでは使えません'*) ng "古い中身のままです。Apps Script への貼り替えが反映されていません" ;;
  *) ng "想定外の返事：$(printf '%s' "$R1" | head -c 300)" ;;
esac

printf '\n\033[1m▸ 棚が空の家でも写真の読み取りが通るか（今回の不具合そのもの）\033[0m\n'
R2="$(post "{\"house\":\"$PROBE_HOUSE\",\"action\":\"sync\",\"since\":0,\"changes\":[]}")"
case "$R2" in
  *'"ok":true'*) ok "品目0件でも同期は通る" ;;
  *) ng "同期が通らない：$(printf '%s' "$R2" | head -c 300)" ;;
esac

R3="$(post "{\"house\":\"$PROBE_HOUSE\",\"action\":\"recognize\",\"image\":\"data:image/jpeg;base64,AAA\"}")"
case "$R3" in
  *'この家族コードでは使えません'*)
    ng "まだ弾かれます。houses 台帳に載っていない可能性があります" ;;
  *'GEMINI_API_KEY'*)
    ng "家族コードの関門は抜けました。ただし鍵が通っていません：$(printf '%s' "$R3" | head -c 200)" ;;
  *'混み合っています'*)
    ng "候補のモデルがどれも通りませんでした。GEMINI_MODEL / GEMINI_MODELS を見直してください" ;;
  *)
    # AAA は写真として壊れているので、Gemini が中身を咎めるのが正解
    ok "家族コードの関門を抜けて Gemini まで届いた"
    echo "     （返事：$(printf '%s' "$R3" | head -c 160)）"
    echo "     壊れた写真を送っているので、中身を咎める返事が出るのが正しい反応です" ;;
esac

printf '\n'
if [ "$fail" -eq 0 ]; then
  printf '\033[32m全部通りました。\033[0m\n'
else
  printf '\033[31m通らなかったものがあります。上を見てください。\033[0m\n'
fi
echo "スプレッドシートの houses シートから、確認用に作られた次の行を消してください："
echo "  $PROBE_HOUSE"
exit "$fail"
