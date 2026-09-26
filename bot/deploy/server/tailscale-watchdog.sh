#!/usr/bin/env bash
# Chạy mỗi 5 phút (systemd timer). Tailscale không ở trạng thái Running → khởi động lại tailscaled.
# Cần đăng nhập lại (key hết hạn) thì khởi động lại không giúp được: chỉ ghi cảnh báo vào journal.
# Xem log: journalctl -t tailscale-watchdog
log() { logger -t tailscale-watchdog "$*"; echo "$*"; }

state=$(tailscale status --json 2>/dev/null | grep -o '"BackendState": *"[A-Za-z]*"' | head -1 | grep -o '[A-Za-z]*"$' | tr -d '"')
[ "$state" = "Running" ] && exit 0

case "$state" in
  NeedsLogin|NeedsMachineAuth)
    log "Tailscale cần đăng nhập lại ($state) — chạy: sudo tailscale up; và tắt key expiry cho máy này trong trang admin"
    exit 1 ;;
esac

if ! ping -c1 -W3 1.1.1.1 >/dev/null 2>&1; then
  log "Mất internet (Tailscale: ${state:-không phản hồi}) — thử khởi động lại mạng"
  systemctl try-restart NetworkManager systemd-networkd 2>/dev/null
  exit 1
fi

log "Tailscale đang '${state:-không phản hồi}' — khởi động lại tailscaled"
systemctl restart tailscaled
