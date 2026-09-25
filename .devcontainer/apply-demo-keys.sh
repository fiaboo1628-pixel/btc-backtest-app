#!/usr/bin/env bash
# Có Codespaces secrets BINANCE_DEMO_KEY + BINANCE_DEMO_SECRET → bot chạy trên Binance Demo, không phải gõ phím.
# Lần đầu (hoặc khi đổi key) tự chạy demo_check, ghi kết quả vào bot/deploy/DEMO_CHECK.md. Chạy lại an toàn.
# Không có secrets → không làm gì (bot giữ chế độ đang có, mặc định dry-run).
set -uo pipefail
cd "$(dirname "$0")/../bot/deploy"
[ -n "${BINANCE_DEMO_KEY:-}" ] && [ -n "${BINANCE_DEMO_SECRET:-}" ] || exit 0

# đã nhập key THẬT bằng `setup --api` → không ghi đè bằng key Demo
if [ -f secrets/exchange.json ] && grep -q '"demo_trading": false' secrets/exchange.json; then
  echo "Đang dùng key tài khoản thật — bỏ qua key Demo từ Codespaces secrets."
  exit 0
fi

docker compose run --rm -T -e BINANCE_DEMO_KEY -e BINANCE_DEMO_SECRET -e BINANCE_DEMO_CAPITAL \
  setup --demo-from-env >/dev/null || { echo "Không ghi được key Demo"; exit 1; }

# demo_check một lần cho mỗi bộ key (dấu vết nằm trong secrets/, đã gitignore)
mark=$(printf '%s' "$BINANCE_DEMO_KEY" | sha256sum | cut -c1-16)
if [ "$(cat secrets/.demo_checked 2>/dev/null)" != "$mark" ]; then
  docker compose stop live >/dev/null 2>&1
  out=$(docker compose run --rm -T check 2>&1)
  {
    echo "# Kết quả demo_check (Binance Demo)"
    echo
    echo "Gửi nguyên khung dưới đây cho người review — không chứa key."
    echo
    echo '```'
    printf '%s\n' "$out" | awk '/^={20,}/{p=1} p'
    echo '```'
  } > DEMO_CHECK.md
  printf '%s' "$mark" > secrets/.demo_checked
fi
docker compose up -d
