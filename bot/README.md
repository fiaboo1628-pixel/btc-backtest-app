# Bot Binance USDT-M Futures

**Từ 10/2026 bot chạy TrendBreakout** (`user_data/strategies/TrendBreakout.py`): breakout kênh Donchian 4h, 5 coin
BTC ETH SOL XRP DOGE, vào khi đóng cửa vượt đỉnh/đáy 20 nến (lọc EMA200), thoát khi thủng kênh 10 nến, SL 2×ATR,
rủi ro 0.25%/lệnh, đòn bẩy cố định x5, sụt vốn > 20% giảm nửa khối lượng, > 30% tự dừng (live 02/10/2026: SL 3×ATR, rủi ro 1%). Backtest 04/2020 → 09/2026 (chi tiết 15m, vốn 1000):
1470 lệnh, PF 1.55, 20.5%/năm, max DD 11% — lạc quan vì 5 coin chọn sau khi thấy kết quả (10 coin: PF 1.33, DD 23%).
Kiểm tra độ bền: [`research/robustness_trend_2026-10.md`](research/robustness_trend_2026-10.md). Vốn từ 1000 USDT là đủ.
Tự backtest và đổi tham số: màn **Backtest** của app trên hub (freqtrade ở LAB, phí + trượt 0.08%/chiều, khớp lệnh 15m).

DonchianRevert (bên dưới) đã ngưng: walk-forward thất bại ([`research/robustness_2026-10.md`](research/robustness_2026-10.md)).
Lịch sử lệnh cũ: `user_data/demo-donchian.sqlite`, `user_data/paper-donchian.sqlite`.

# DonchianRevert — BTC M15 mean reversion (đã ngưng 10/2026)

## Chạy bot
- **Máy nhà / VPS (Docker)** hoặc **GitHub Codespaces** (không cần gõ lệnh): xem [`deploy/README.md`](deploy/README.md).
- Chế độ: dry-run (mặc định) → Binance Demo → tiền thật, chỉ khác bộ API key (`setup --api`).

## Chiến lược (`user_data/strategies/DonchianRevert.py`)
| Vai trò | Chỉ báo | Điều kiện |
|---|---|---|
| Tín hiệu | Donchian position (20 nến) | Long ≤ 0.074 · Short ≥ 0.944 (≈ 5% cực trị) |
| Trạng thái | ADX(14) | > 30 |
| Lọc bán tháo/mua đuổi | Volume / TB 96 nến | < 1.0 |
| Rủi ro | ATR(14) | ATR ≥ 0.4% giá; 1R = 3×ATR |

Thoát: SL −1R → khi lãi +2R bật trailing cách đỉnh/đáy 1R. Khối lượng: rủi ro 0.5% vốn/lệnh (tối đa x5).
Tuỳ chọn: `tp_r` chốt lời cố định theo R, `trail_on` bật/tắt trailing.
Tự dừng (`halt_on`, chỉ live/dry-run): ngừng vào lệnh mới khi sụt vốn > 15% hoặc profit factor < 1 sau 60 lệnh,
ghi dòng ERROR để hub đẩy cảnh báo về điện thoại. Xem lại rồi tắt `halt_on` ở trang Chỉnh tham số để chạy tiếp.

## Kết quả backtest — Binance BTCUSDT perpetual (01/2020 → 08/2026)
Freqtrade `--timeframe-detail 1m`, phí 0.05%/chiều, funding thật, rủi ro 1%/lệnh
(chi tiết và các bài kiểm tra độ bền: [`research/robustness_2026-10.md`](research/robustness_2026-10.md)):
Tổng **+63.1%**, ~**7.6%/năm**, max drawdown **12.9%**, profit factor **1.22**, 378 lệnh, thắng 42%, **2/7 năm lỗ**.
Lãi theo năm (% vốn đầu năm): 2020 −1.8 · 2021 +29.2 · 2022 −3.4 · 2023 +8.7 · 2024 +4.2 · 2025 +17.6 · 2026 (8 tháng) −0.0.
Phí 0.07% + trượt 0.02%: +36.6%, PF 1.14. Ở 0.5%/lệnh lãi và sụt vốn còn khoảng một nửa;
Monte Carlo: max DD p95 13% (25% ở mức 1%).

**Walk-forward thất bại** (tối ưu trên 2 năm, chạy 6 tháng kế tiếp, 10 cửa sổ 2022 → 2026): lỗ −33% đến −77%.
Tham số hiện tại được chọn sau khi xem dữ liệu, nên chưa chứng minh được lợi thế ngoài mẫu.

Số cũ trên Bitstamp BTC/USD spot (+84.9%, DD 15.1%, 6/6 năm có lãi) **không mô tả** bot trên Binance:
chỉ 108/322 lệnh trùng nến, lãi theo năm khác hẳn.

So sánh cách thoát (dữ liệu Bitstamp cũ, 1m detail): trailing 0.5R +56% · trailing 1R **+85%, DD 15%** ·
TP cố định 1:4 không trailing +55%, DD 22%, 2 năm lỗ · 1:5 +121% nhưng thắng 22%, chỉ 42% số tháng có lãi.
(Mua & giữ BTC cùng kỳ: +197%.)

## Quá trình rút ra
1. M15 BTC: mọi chỉ báo động lượng/xu hướng có IC **âm** ổn định 6/6 năm → đánh hồi, không đánh theo đà
   (VolatilitySystem breakout M15: −99%).
2. Chỉ báo dao động trùng lặp mạnh (BB%B≈CCI≈Donchian≈W%R≈RSI, ρ 0.86–0.98) → chỉ dùng 1.
3. ADX và Volume độc lập với tín hiệu và làm nhịp hồi mạnh hơn; lọc xu hướng 4h/phiên giao dịch thì vô ích.
4. Phí là nút thắt: lọc ATR ≥ 0.4% để phí chiếm phần nhỏ của R là cải tiến lớn nhất.
5. Donchian bền hơn BB%B khi lệch tham số (tệ nhất −4.9% so với −11.5%).
6. ML lọc tín hiệu (meta-labeling, `research/meta_label.py`) không hơn lọc ngẫu nhiên → giữ bộ lọc hiện tại.

## Hạn chế
- Lợi thế mỏng và tập trung ở 2021, 2025; bỏ hai năm đó thì gần hòa. ETH/SOL PF 1.09, BNB −53%: không mở rộng sang coin khác.
- Donchian được chọn sau khi xem kết quả 2025–2026 → chưa có dữ liệu kiểm tra sạch.
- Lợi thế mỏng. **Hãy dry-run 1–2 tháng trước khi dùng tiền thật. Không phải lời khuyên đầu tư.**

## Hub (thư mục `hub/`)
Tất cả ngưỡng của chiến lược là tham số freqtrade (mặc định trong code, ghi đè bằng `DonchianRevert.json`).
`hub/` là server một cổng trên máy nhà phục vụ app điều khiển bot (Tổng quan, Lệnh, Backtest, Dữ liệu, Cảnh báo).
Xem `hub/README.md`.

## Chạy lại backtest offline
```bash
pip install freqtrade        # hoặc cài từ source
git clone --depth 1 https://github.com/ff137/bitstamp-btcusd-minute-data.git
python build_data.py
python run_futures.py backtesting -c cfg_fut.json --userdir user_data \
  --datadir user_data/data/binance --timerange 20210101- --strategy DonchianRevert --breakdown year
```
`run_futures.py` giả lập danh sách market Binance để chạy không cần mạng. Nếu có mạng tới Binance,
dùng `freqtrade backtesting` bình thường với dữ liệu tải bằng `download-data`.
