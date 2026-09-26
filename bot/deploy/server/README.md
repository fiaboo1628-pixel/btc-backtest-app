# Máy nhà chạy Arch Linux làm server cho bot

Cho mini PC (vd Lenovo M710q) chạy 24/7, không GUI, điều khiển bằng SSH qua Tailscale.

```bash
git clone https://github.com/fiaboo1628-pixel/btc-backtest-app.git
sudo bash btc-backtest-app/bot/deploy/server/setup-arch.sh
```

Script (chạy lại an toàn):
- cài `docker`, `docker-compose`, `tailscale`, `git`, `tmux`; bật docker + tailscaled khi khởi động
- chặn máy ngủ / ngủ đông
- **watchdog**: mỗi 5 phút kiểm tra Tailscale; rớt thì khởi động lại `tailscaled`; mất internet thì khởi động
  lại mạng; key hết hạn (cần đăng nhập lại) thì ghi cảnh báo — xem `journalctl -t tailscale-watchdog`
- pacman hook: `pacman -Syu` cập nhật tailscale xong thì tự khởi động lại `tailscaled`
- linger: dịch vụ của user chạy cả khi không đăng nhập

Việc tay còn lại (script in ra khi xong): `sudo tailscale up --ssh`, **Disable key expiry** cho máy trong
login.tailscale.com/admin/machines, rồi cài bot như `bot/deploy/README.md`.

BIOS (F1 khi khởi động): **After Power Loss → Power On** để mất điện có lại thì máy tự bật.

## Tailscale rớt — dò nhanh
```bash
tailscale status                                # Logged out / NeedsLogin → sudo tailscale up
systemctl status tailscaled
journalctl -u tailscaled -b --no-pager | tail -40
journalctl -t tailscale-watchdog --no-pager | tail
last -x | head                                  # có khởi động lại / ngủ không
```
