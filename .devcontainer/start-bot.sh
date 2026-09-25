#!/usr/bin/env bash
# Tự chạy khi tạo codespace: chuẩn bị + bật bot dry-run, ghi thông tin đăng nhập vào BOT_LOGIN.md
# để mở bằng cách bấm (không cần gõ lệnh). Chạy lại an toàn.
set -uo pipefail
cd "$(dirname "$0")/../bot/deploy"
OUT=BOT_LOGIN.md
note() { echo "$*" | tee -a "$OUT"; }

echo "# Bot DonchianRevert trên Codespaces" > "$OUT"
note ""
note "_Đang cài… file này tự cập nhật, mở lại sau 1–2 phút._"

for i in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 2; done

code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://fapi.binance.com/fapi/v1/ping) || true

docker compose pull -q
login=$(docker compose run --rm -T setup --no-download 2>&1 | grep "Đăng nhập")
bash ../../.devcontainer/apply-demo-keys.sh     # có Codespaces secrets key Demo → bot chạy trên Binance Demo
docker compose up -d
mode="dry-run (ví ảo 1000 USDT)"
grep -q "BOT_DB=demo" .env 2>/dev/null && mode="Binance DEMO (key từ Codespaces secrets)"

{
  echo "# Bot DonchianRevert trên Codespaces"
  echo
  if [ "$code" = "200" ]; then
    echo "✅ Kết nối Binance: OK. Bot đang chạy: **$mode**."
    [ -f DEMO_CHECK.md ] && echo "   Kết quả kiểm tra đặt lệnh: mở file **bot/deploy/DEMO_CHECK.md**."
  elif [ "$code" = "451" ] || [ "$code" = "403" ]; then
    echo "❌ Binance chặn máy chủ này (HTTP $code) — codespace đang ở vùng bị chặn (thường là Mỹ)."
    echo "   Xoá codespace này, vào github.com/settings/codespaces → Region → **Southeast Asia**, rồi tạo lại."
  else
    echo "⚠️ Chưa gọi được Binance (HTTP ${code:-000}). Bot vẫn bật; xem log trong FreqUI (Logs)."
  fi
  echo
  echo "## Đăng nhập"
  echo '```'
  echo "$login"
  echo '```'
  echo
  echo "## Mở giao diện"
  echo "Tab **Ports** (cạnh Terminal) → dòng **8080 FreqUI (bot)** → bấm biểu tượng quả địa cầu."
  echo "FreqUI: đăng nhập bằng dòng *FreqUI* ở trên. Dòng **8090** là trang Chỉnh tham số (dòng *Chỉnh tham số*)."
  echo
  echo "_Dữ liệu nến cho trang Chỉnh tham số đang tải ngầm (vài phút) — backtest dùng được sau khi xong._"
} > "$OUT"

# tải nến cho LAB (backtest) chạy ngầm — không bắt chờ
setsid nohup bash -c '
  if docker compose run --rm -T setup >/tmp/download.log 2>&1; then
    sed -i "s/^_Dữ liệu nến .*/_Dữ liệu nến đã tải xong — backtest dùng được._/" BOT_LOGIN.md
  else
    sed -i "s|^_Dữ liệu nến .*|_Tải dữ liệu nến lỗi, xem /tmp/download.log._|" BOT_LOGIN.md
  fi' >/dev/null 2>&1 &
