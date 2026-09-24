# Backtest BTC — web app chạy trên điện thoại

Backtest chiến lược crypto ngay trên trình duyệt, không cần server:

- **Dữ liệu**: tải nến + funding thật từ API công khai Binance (Futures USDT-M hoặc Spot, không cần
  tài khoản), lưu trong máy (IndexedDB), bấm "Cập nhật" chỉ tải phần mới; nhập/xuất CSV.
- **Nhiều khung thời gian**: tải một khung gốc (1m / 5m / 15m / 1h), các khung lớn hơn
  (15m, 30m, 1h, 2h, 4h, 1d) được ghép tự động. Một điều kiện có thể dùng khung lớn hơn khung giao dịch
  (ví dụ vào lệnh 15m, lọc bằng ADX nến 1h) — chỉ dùng nến khung lớn **đã đóng**.
- **Lắp ghép chiến lược**: 18 chỉ báo (Donchian, Bollinger %B, Williams %R, RSI, Stochastic, CCI, MFI,
  ROC, ADX, ±DI, khoảng cách/độ dốc EMA, MACD, ATR %, ATR so với nền, độ rộng Bollinger, biên độ nến,
  khối lượng). Mỗi điều kiện: `chỉ báo(tham số) [khung] ≤ ≥ < > cắt lên/cắt xuống ngưỡng`,
  các điều kiện nối bằng **VÀ**, Long và Short riêng.
- **Thoát lệnh theo R**: 1R = k × ATR(14) nến tín hiệu; lãi chạm mốc thì stoploss bám đỉnh/đáy;
  giới hạn thời gian giữ lệnh. Khối lượng theo % vốn rủi ro, có trần đòn bẩy; phí + funding thật.
- **Chống tự lừa mình**: kết quả luôn tách 2 giai đoạn; đếm số lần thử và cảnh báo khi thử quá nhiều.
- Lưu / xuất / nhập chiến lược dạng JSON. Cài lên màn hình chính như app (PWA), mở được khi mất mạng.

## Độ chính xác

Bộ máy backtest mô phỏng đúng cách freqtrade backtest từng nến. Đối chiếu chiến lược DonchianRevert
(BTC 15m, 01/2021 → 09/2026) với freqtrade:

| | freqtrade | web app |
|---|---|---|
| Số lệnh | 451 | 451 — trùng giờ vào, chiều, giờ ra **từng lệnh** |
| Lợi nhuận | +35,21% | +35,24% |
| Chênh giá ra lớn nhất | | 0,09 USD (làm tròn) |
| Chênh lãi/lỗ lớn nhất 1 lệnh | | 0,004 USDT |

Các chỉ báo khớp TA-Lib tới sai số 1e-6 (`tests/indicators.test.mjs`).

## Chạy

Mở `index.html` qua một web server bất kỳ (GitHub Pages, hoặc `python3 -m http.server`).
Không có bước build, không phụ thuộc thư viện ngoài.

Test: `npm test` (Node 22+). Test đối chiếu freqtrade cần fixture lớn không commit —
tạo bằng `tools/export_parity.py`; thiếu fixture thì test đó được bỏ qua.

## Lưu ý

- Nếu trình duyệt không gọi được Binance trực tiếp (CORS / mạng chặn), dùng ô proxy trong
  "Nâng cao" hoặc nhập CSV.
- Backtest không mô phỏng trượt giá và sổ lệnh. Kết quả quá khứ không bảo đảm tương lai;
  chạy thử bằng tiền ảo trước khi dùng tiền thật. Không phải lời khuyên đầu tư.

## Cấu trúc

```
index.html, css/app.css      giao diện (tiếng Anh, gọn, ưu tiên điện thoại)
js/app.js                    điều khiển giao diện
js/data.js                   tải Binance, IndexedDB, CSV
js/indicators.js             chỉ báo (khớp TA-Lib)
js/catalog.js                thư viện chỉ báo cho bộ lắp ghép
js/rules.js                  điều kiện → tín hiệu (nhiều khung)
js/timeframes.js             ghép nến, căn khung lớn
js/engine.js                 bộ máy backtest futures
js/worker.js                 chạy backtest ở luồng riêng
presets/                     chiến lược mẫu
sw.js, manifest.webmanifest  PWA
```
