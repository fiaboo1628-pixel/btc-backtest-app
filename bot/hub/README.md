# Hub: một trang cho cả hệ thống

Server chạy trên máy nhà (service `hub` trong `bot/deploy/docker-compose.yml`, cổng 8090), mở qua Tailscale:
PC ở nhà và điện thoại khi ra ngoài dùng cùng một địa chỉ `https://<tên-máy>.<tailnet>.ts.net`.

| Đường dẫn | Việc |
|---|---|
| `/` | App backtest (cùng mã với bản Vercel). Trên hub có thêm: nến lấy từ máy chủ, tab **Live**, nút **Send to bot** |
| `/tune/` | Chỉnh tham số: backtest bằng freqtrade (LAB), áp dụng cho bot (LIVE) |
| `/api/hub` | Hub có những gì — app dựa vào đây để bật các phần trên (trên Vercel không có → app chạy như cũ) |
| `/api/data/...` | Nến BTC 1m/5m/15m futures từ 2021, **tự tải và cập nhật mỗi 2 phút** (`candles.py`) |
| `/api/live` | Trạng thái bot: số dư, lệnh mở (stop có trên sàn không), lệnh vừa đóng, lãi theo ngày, cảnh báo (`live.py`, chỉ đọc) |
| `/api/tune/*` | Chỉnh tham số (`tune.py`, trước là trang "tuner" riêng) |
| `/api/binance/...` | Proxy chỉ-đọc tới Binance, giống `api/binance.js` trên Vercel |

## Kiến trúc

```
PC / iPhone ──Tailscale HTTPS──► tailscale serve ──► hub (127.0.0.1:8090)
                                                      ├─ nến: user_data/hub_data/*.bin ◄── Binance (nền, 2 phút/lần)
                                                      ├─► LIVE: freqtrade trade (8080) — /api/live, "Send to bot"
                                                      └─► LAB : freqtrade webserver (8081) — backtest ở /tune/
```

- **Luồng tham số**: backtest trong app → **Send to bot** → hub kiểm tra giới hạn, ghi
  `user_data/strategies/DonchianRevert.json` (sao lưu bản cũ vào `param_backups/`) → `reload_config`.
  App chỉ gửi được khi chiến lược đúng khuôn DonchianRevert (`js/botparams.js` báo lý do nếu không):
  bot chỉ đổi ngưỡng, không đổi logic. Lệnh đang mở giữ nguyên stoploss đã tính lúc vào lệnh.
- **Mật khẩu bot** (API freqtrade) chỉ nằm trên máy chủ; trình duyệt chỉ nói chuyện với hub.

## Đăng nhập

- Qua `tailscale serve`: Tailscale đã xác thực người dùng (header `Tailscale-User-Login`) → **không hỏi mật khẩu**.
  **Nên đặt** `"allowed_logins": ["ban@gmail.com"]` trong `hub.json` — để trống thì mọi tài khoản Tailscale
  thấy được máy chủ (kể cả người được share máy) đều vào được. Tắt hẳn: `"trust_tailscale": false`.
  Header này chỉ được tin khi tới từ phía `tailscale serve` (loopback hoặc gateway Docker; đổi bằng
  `"tailscale_proxies": ["127.0.0.1", "172.18.0.1"]`), nên container khác không giả được.
- Các API ghi (ví dụ gửi tham số sang bot) chặn yêu cầu từ trang web khác (`Sec-Fetch-Site` / `Origin`).
- Cách khác (localhost, SSH tunnel, Codespaces): hỏi `admin` / mật khẩu trong `hub.json` (setup in ra).
- Cổng 8090 chỉ mở trên `127.0.0.1` của máy. **Không mở ra internet.**
- Hub chỉ phục vụ đúng file của app (`index.html`, `sw.js`, `manifest.webmanifest`, `js/`, `css/`, `icons/`,
  `vendor/`, `presets/`); `bot/` (có `secrets/`) không đọc được qua web.

## Cấu hình

`bot/deploy/hub.json` do `docker compose run --rm setup` tạo (tự chuyển từ `tuner.json` cũ, giữ mật khẩu).
Mẫu đầy đủ: `hub.example.json`. Thêm coin/khung: thêm dòng vào `data.datasets` rồi `docker compose restart hub`.

Nến cho LAB (backtest ở `/tune/`, `user_data/data/binance/futures`) hub tự cập nhật lúc khởi động và mỗi 24h
(`labdata.py`: `freqtrade download-data` cho các coin + khung của bot trong `config.base.json`, thêm 15m; chỉ
tải phần mới). Thất bại 2 lần liền thì gửi cảnh báo. Tắt: `"lab_data_update": false`.

## Kiểm thử

```bash
pip install fastapi uvicorn httpx pytest
python -m pytest bot/hub/test_hub.py -q
```
