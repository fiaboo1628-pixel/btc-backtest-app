#!/bin/sh
# Deploy trên máy chủ: kéo main rồi chỉ restart phần có mã đổi. Từ PC: `deploy` (hàm fish) hoặc
#   ssh sever@server sh btc-backtest-app/bot/deploy/server/deploy.sh [hub|live|all]
# App tĩnh (index.html, js/, css/) chỉ cần pull. Không đụng paper (đã tắt) — không dùng `docker compose up` trống.
set -e
cd "$(dirname "$0")/../../.."
old=$(git rev-parse HEAD)
git pull -q --ff-only
changed=$(git diff --name-only "$old" HEAD)
hub=; live=
echo "$changed" | grep -q '^bot/hub/' && hub=1
echo "$changed" | grep -qE '^bot/user_data/strategies/|^bot/deploy/config' && live=1
case "$1" in hub) hub=1 ;; live) live=1 ;; all) hub=1; live=1 ;; esac
cd bot/deploy
if echo "$changed" | grep -q '^bot/deploy/docker-compose.yml'; then
  docker compose up -d hub lab live        # tạo lại theo compose mới (chỉ 3 service đang chạy)
else
  if [ -n "$live" ]; then docker compose restart live; fi   # stop-loss nằm trên sàn: restart không mất bảo vệ
  if [ -n "$hub" ]; then docker compose restart hub; fi
fi
echo "$(git log --oneline -1) | $(grep -o '"[0-9.a-z]*"' ../../js/version.js) | đổi: $(echo "$changed" | grep -c . ) file${hub:+ · restart hub}${live:+ · restart live}"
