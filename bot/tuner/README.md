# Trang "Chỉnh tham số" (tuner)

Trang web tiếng Việt, tối ưu cho điện thoại, để:

- chỉnh 12 tham số của `DonchianRevert` bằng thanh trượt hoặc ô nhập số,
- **backtest ngay** với bộ tham số đó (chọn 2021→nay, 2021–2024, 2025→nay, 12 tháng hoặc tự nhập ngày),
- xem lợi nhuận, drawdown, profit factor, đường vốn, kết quả từng năm, và so với lần chạy trước,
- **áp dụng cho bot live** (có hộp xác nhận liệt kê thay đổi, cảnh báo nếu bộ tham số chưa backtest).

Thêm chỉ báo mới hoặc đổi logic vẫn phải sửa file `.py` — trang này chỉ chỉnh các ngưỡng có sẵn.

## Kiến trúc

```
điện thoại ──SSH tunnel──► tuner (127.0.0.1:8090, có mật khẩu)
                            ├─► LAB : freqtrade webserver (8081) — backtest, dùng user_data/strategies_lab/
                            └─► LIVE: freqtrade trade     (8080) — bot thật/dry-run, dùng user_data/strategies/
```

- LAB và LIVE dùng **hai thư mục chiến lược riêng**. Thử tham số chỉ ghi vào `strategies_lab/`,
  không đụng tới bot đang chạy.
- "Áp dụng" ghi `strategies/DonchianRevert.json` (sao lưu bản cũ vào `strategies/param_backups/`)
  rồi gọi `reload_config` để bot nạp lại. Lệnh đang mở giữ nguyên stoploss đã tính lúc vào lệnh.
- Tuner kiểm tra mọi giá trị nằm trong giới hạn khai báo trong chiến lược trước khi ghi.

## Cài đặt

1. Chép chiến lược vào cả hai thư mục:
   ```bash
   mkdir -p user_data/strategies_lab
   cp user_data/strategies/DonchianRevert.py user_data/strategies_lab/
   ```
2. **LAB** — một file config freqtrade riêng (ví dụ `config_lab.json`), giống config backtest, thêm:
   ```json
   "strategy_path": "user_data/strategies_lab",
   "api_server": { "enabled": true, "listen_ip_address": "127.0.0.1", "listen_port": 8081,
                   "jwt_secret_key": "<chuỗi ngẫu nhiên dài>", "username": "<lab-user>",
                   "password": "<lab-pass>", "CORS_origins": [] }
   ```
   Chạy: `freqtrade webserver -c config_lab.json` (cần có sẵn dữ liệu nến trong `datadir`).
3. **LIVE** — config của bot dry-run/live, bật `api_server` ở cổng 8080 (user/pass khác LAB).
   Chạy: `freqtrade trade -c config_live.json --strategy DonchianRevert`.
4. **Tuner**:
   ```bash
   cp tuner/tuner.example.json tuner/tuner.json   # điền mật khẩu; KHÔNG commit file này
   python tuner/server.py -c tuner/tuner.json
   ```
   Tuner chạy bằng chính môi trường Python của freqtrade (dùng fastapi, uvicorn, httpx có sẵn).
5. Mở trên điện thoại qua SSH tunnel (hoặc VPN như Tailscale):
   ```bash
   ssh -L 8090:127.0.0.1:8090 user@vps     # rồi mở http://localhost:8090
   ```

## Bảo mật

- Để `host` là `127.0.0.1` cho cả tuner lẫn hai `api_server`. **Không mở cổng ra internet.**
- Tuner có quyền đổi tham số bot thật — dùng mật khẩu mạnh, khác với mật khẩu freqtrade.
- `tuner.json` chứa mật khẩu: đã có trong `.gitignore` của thư mục này.

## API của tuner

| Method | Đường dẫn | Việc |
|---|---|---|
| GET | `/api/schema` | Danh sách tham số, giới hạn, giá trị LAB và LIVE |
| POST | `/api/backtest` | `{params, timerange, wallet}` → ghi tham số LAB và chạy backtest |
| GET | `/api/backtest` | Tiến độ và kết quả lần chạy mới nhất |
| GET | `/api/history` | 20 lần chạy gần nhất (trong bộ nhớ) |
| POST | `/api/apply` | `{params}` → ghi tham số LIVE (có sao lưu) và `reload_config` |
| GET | `/api/live` | Trạng thái bot live: chạy/dừng, dry-run, số lệnh mở, lợi nhuận |
