# Hub: một cổng cho cả hệ thống

Server FastAPI trên máy nhà (service `hub` trong `bot/deploy/docker-compose.yml`, cổng 8090, chỉ mở trên 127.0.0.1),
mở qua Tailscale: PC ở nhà và điện thoại khi ra ngoài dùng cùng địa chỉ `https://<tên-máy>.<tailnet>.ts.net`.
Hub phục vụ **app điều khiển bot** (thư mục gốc repo: `index.html`, `js/`, `css/`, `icons/`) và là backend duy nhất của app.

| Đường dẫn | Việc | File |
|---|---|---|
| `/` | App (Tổng quan, Lệnh, Backtest, Dữ liệu, Cảnh báo). `/tune/` cũ chuyển về `/#backtest` | `server.py` |
| `/api/hub` | Hub có những gì (`features.live/tune/data`), người đang đăng nhập, tên chiến lược | `server.py` |
| `/api/live` | Trạng thái bot: chế độ (lấy từ bot đang chạy, cảnh báo nếu khác file trên đĩa), số dư, lợi nhuận, **sụt vốn so với ngưỡng tự dừng 25%** (`halt`, cùng cách tính `TrendBreakout.halt_reason`), lệnh mở (stop có trên sàn không), 20 lệnh vừa đóng, lãi theo ngày, **đường vốn**, log cảnh báo | `live.py` |
| `/api/trades` | Mọi lệnh đã đóng + thống kê (số lệnh, thắng, PF, sụt vốn) và kỳ vọng từ backtest (`weekly.EXPECT`) | `live.py` |
| `/api/tune/schema` | Tham số chiến lược đọc từ class (tên, nhãn tiếng Việt, min/max/bước, mặc định) + giá trị LAB và LIVE | `tune.py` |
| `/api/tune/backtest` | POST chạy backtest ở LAB (freqtrade webserver, nến chi tiết 15m, từ chối nếu một coin thiếu 15m); GET tiến độ / kết quả | `tune.py` |
| `/api/tune/history` | 20 lần thử gần nhất (trong bộ nhớ hub) | `tune.py` |
| `/api/tune/apply` | Ghi tham số cho bot LIVE (sao lưu bản cũ vào `param_backups/`) + `reload_config` | `tune.py` |
| `/api/tune/live` | Bot đang chạy: tài khoản, coin, khung, nến LAB có từ ngày nào tới ngày nào, trạng thái tự cập nhật nến | `tune.py`, `labdata.py` |
| `/api/alerts` | Kênh cảnh báo đang có, sự cố đang báo, cảnh báo gần đây (ghi ở `alerts.json` cạnh `push.json`) | `alerts.py` |
| `/api/weekly` | Báo cáo tuần: bot so với backtest và so với paper | `weekly.py` |
| `/api/push/*` | Thông báo đẩy (Web Push, VAPID) tới điện thoại | `push.py` |
| `/api/data/...`, `/api/binance/...` | Nến trên máy chủ + proxy Binance chỉ-đọc. **App hiện không dùng** (dành cho app backtest cũ); giữ cho công cụ khác, tắt bằng cách bỏ khối `data` trong `hub.json` | `candles.py` |

## Kiến trúc

```
iPhone / PC ──Tailscale HTTPS──► tailscale serve ──► hub (127.0.0.1:8090)
                                                      ├─► LIVE: freqtrade trade (8080) — /api/live, /api/trades, apply
                                                      ├─► LAB : freqtrade webserver (8081) — backtest
                                                      ├─► paper: freqtrade dry-run (8082) — báo cáo tuần (tuỳ chọn)
                                                      ├─ watchdog mỗi phút → Telegram / Web Push (alerts.py, push.py)
                                                      └─ tải nến cho LAB mỗi ngày (labdata.py)
```

- **Luồng tham số**: màn Backtest → `/api/tune/backtest` (LAB) → **Áp dụng cho bot** → hub kiểm tra giới hạn/bước,
  ghi `user_data/strategies/<Strategy>.json`, sao lưu bản cũ → `reload_config`. Bot chỉ đổi ngưỡng, không đổi logic.
  Lệnh đang mở giữ stoploss đã tính lúc vào lệnh.
- **Mật khẩu bot** (API freqtrade) chỉ nằm trên máy chủ; trình duyệt chỉ nói chuyện với hub.

## Đăng nhập

- Qua `tailscale serve`: Tailscale đã xác thực người dùng (header `Tailscale-User-Login`) → **không hỏi mật khẩu**.
  **Nên đặt** `"allowed_logins": ["ban@gmail.com"]` trong `hub.json`. Tắt hẳn: `"trust_tailscale": false`.
  Header này chỉ được tin khi tới từ phía `tailscale serve` (loopback hoặc gateway Docker; đổi bằng `"tailscale_proxies"`).
- Các API ghi (áp dụng tham số, bật thông báo) chặn yêu cầu từ trang web khác (`Sec-Fetch-Site` / `Origin`).
- Cách khác (localhost, SSH tunnel, Codespaces): `admin` / mật khẩu trong `hub.json` (xem bằng `setup --show-login`).
- Hub chỉ phục vụ đúng file của app (`index.html`, `sw.js`, `manifest.webmanifest`, `js/`, `css/`, `icons/`);
  `bot/` (có `secrets/`) không đọc được qua web.

## Cấu hình

`bot/deploy/hub.json` do `docker compose run --rm setup` tạo. Mẫu đầy đủ: `hub.example.json`.
Nến cho LAB (`user_data/data/binance/futures`) hub tự cập nhật lúc khởi động và mỗi 24h (`labdata.py`); thất bại 2 lần liền
thì gửi cảnh báo. Tắt: `"lab_data_update": false`. Lịch sử cảnh báo: `"alerts_file"` (mặc định cạnh `push.json`).

## Phát hành app

Hub phục vụ app thẳng từ repo (bind mount chỉ đọc), nên trên máy chủ chỉ cần `git pull`; đổi mã hub thì thêm
`docker compose restart hub`. Mỗi bản phát hành đổi `js/version.js` và `CACHE` trong `sw.js`.

## Chạy thử không cần bot

```bash
uv run --no-project --with fastapi --with uvicorn --with httpx --with cryptography python bot/hub/dev.py --scenario demo
```
`dev.py` chạy đúng `server.py` với bot LIVE/LAB bịa (đăng nhập `admin` / `dev`). Kịch bản: `demo`, `live`, `paper`,
`halted`, `offline`, `empty`.

## Kiểm thử

```bash
uv run --no-project --with fastapi --with uvicorn --with httpx --with pytest --with cryptography python -m pytest bot/hub/test_hub.py
```
