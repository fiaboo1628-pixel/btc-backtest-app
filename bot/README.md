# DonchianRevert — BTC M15 mean reversion (Binance USDT-M Futures)

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

Thoát: SL −1R → khi lãi +2R bật trailing cách đỉnh/đáy 1R. Khối lượng: rủi ro 1% vốn/lệnh (tối đa x5).
Tuỳ chọn: `tp_r` chốt lời cố định theo R, `trail_on` bật/tắt trailing.

## Kết quả backtest (01/2021 → 09/2026, phí 0.035%/chiều, funding 0.01%/8h)
Chạy với `--timeframe-detail 1m` (thoát lệnh tính trên từng nến 1m bên trong nến 15m — chỉ dùng nến 15m
thì trailing sát bị thổi phồng hoặc đánh giá thấp):
Tổng **+84.9%**, ~**11.3%/năm**, max drawdown **15.1%**, profit factor **1.24**, 426 lệnh, thắng 39%, 6/6 năm có lãi.
Lãi theo năm (USDT, vốn 1000): 2021 +208 · 2022 +112 · 2023 +192 · 2024 +146 · 2025 +88 · 2026 +103.
Dữ liệu Binance Futures thật (data.binance.vision, trailing 0.5R cũ): +53%, DD 12.9%, PF 1.22.

So sánh cách thoát (cùng dữ liệu, 1m detail): trailing 0.5R +56% · trailing 1R **+85%, DD 15%** ·
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
- Dữ liệu Bitstamp BTC/USD spot, không phải Binance perpetual; funding giả định cố định.
- Donchian được chọn sau khi xem kết quả 2025–2026 → chưa có dữ liệu kiểm tra sạch.
- Lợi thế mỏng. **Hãy dry-run 1–2 tháng trước khi dùng tiền thật. Không phải lời khuyên đầu tư.**

## Trang "Chỉnh tham số" (thư mục `tuner/`)
Tất cả ngưỡng của chiến lược là tham số freqtrade (mặc định trong code, ghi đè bằng `DonchianRevert.json`).
`tuner/` là trang web tiếng Việt cho điện thoại để chỉnh tham số, backtest ngay và áp dụng cho bot live.
Xem `tuner/README.md`.

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
