#!/usr/bin/env bash
# Dựng máy Arch Linux thành server chạy bot 24/7 (không GUI, điều khiển qua SSH/Tailscale). Chạy lại an toàn.
#   sudo bash setup-arch.sh
# Việc làm:
#   - cài docker, docker-compose, tailscale, git, tmux; bật docker + tailscaled khi khởi động
#   - chặn máy ngủ/ngủ đông (bot phải chạy liên tục)
#   - watchdog: mỗi 5 phút kiểm tra Tailscale, rớt thì tự khởi động lại
#   - pacman hook: cập nhật gói tailscale xong thì khởi động lại tailscaled
#   - cho dịch vụ của user chạy cả khi không đăng nhập (linger)
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Chạy bằng sudo: sudo bash $0"; exit 1; }
USER_NAME=${SUDO_USER:-}
[ -n "$USER_NAME" ] || { echo "Chạy bằng sudo từ tài khoản thường (không đăng nhập root trực tiếp)"; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)

echo "== Cài gói"
pacman -S --needed --noconfirm docker docker-compose tailscale git tmux
systemctl enable --now docker tailscaled
usermod -aG docker "$USER_NAME"

echo "== Chặn ngủ / ngủ đông"
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null

echo "== Watchdog Tailscale (mỗi 5 phút)"
install -m 755 "$HERE/tailscale-watchdog.sh" /usr/local/bin/tailscale-watchdog
cat > /etc/systemd/system/tailscale-watchdog.service <<UNIT
[Unit]
Description=Kiểm tra Tailscale, rớt thì khởi động lại
After=network-online.target tailscaled.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/tailscale-watchdog
UNIT
cat > /etc/systemd/system/tailscale-watchdog.timer <<UNIT
[Unit]
Description=Chạy tailscale-watchdog mỗi 5 phút

[Timer]
OnBootSec=3min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now tailscale-watchdog.timer

echo "== pacman hook: cập nhật tailscale → khởi động lại tailscaled"
mkdir -p /etc/pacman.d/hooks
cat > /etc/pacman.d/hooks/tailscale-restart.hook <<HOOK
[Trigger]
Operation = Upgrade
Type = Package
Target = tailscale

[Action]
Description = Khởi động lại tailscaled sau khi cập nhật
When = PostTransaction
Exec = /usr/bin/systemctl try-restart tailscaled.service
HOOK

echo "== Cho dịch vụ của $USER_NAME chạy khi không đăng nhập"
loginctl enable-linger "$USER_NAME"

cat <<NEXT

Xong. Tiếp theo (bằng tài khoản $USER_NAME, không cần sudo trừ dòng đầu):
  1. sudo tailscale up --ssh          (nếu chưa đăng nhập Tailscale)
     rồi trên login.tailscale.com/admin/machines: máy này → ... → Disable key expiry
  2. Đăng xuất / đăng nhập lại một lần để quyền docker có hiệu lực
  3. git clone https://github.com/fiaboo1628-pixel/btc-backtest-app.git && cd btc-backtest-app/bot/deploy
     docker compose run --rm setup && docker compose run --rm setup --api && docker compose run --rm check
     docker compose up -d
  4. Claude từ điện thoại: tmux new -s claude  →  cd ~/btc-backtest-app && claude remote-control
     (Ctrl+B rồi D để thoát tmux, phiên vẫn chạy)
Kiểm tra watchdog: systemctl list-timers tailscale-watchdog · journalctl -t tailscale-watchdog
NEXT
