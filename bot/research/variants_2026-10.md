# Biến thể ít tham số của DonchianRevert — 10/2026

Tiếp theo [`robustness_2026-10.md`](robustness_2026-10.md): walk-forward tối ưu cả 8 tham số thất bại. Câu hỏi ở đây:
**bớt tham số tự do (ít khớp nhiễu hơn) thì có biến thể nào qua được walk-forward không?** Không sửa bot.

Chạy lại: `python research/variants.py --datadir data/binance --fixed current` (và `--fixed textbook`).
Dữ liệu Binance BTCUSDT perpetual 2020-01 → 2026-08, fastsim (khớp freqtrade 377/378 lệnh), phí 0.05%/chiều, rủi ro 1%.

## Kết luận

1. **Không biến thể nào qua được walk-forward một cách sạch.** Bớt tham số không cứu được chiến lược.
2. Biến thể duy nhất "đạt" là **exit3** (chỉ tối ưu cách thoát lệnh) khi giữ nguyên điều kiện vào lệnh của bot:
   +37–41% ngoài mẫu, PF 1.24, 7–8/10 đoạn có lãi. Nhưng điều kiện vào lệnh đó (dc 0.074/0.944, ADX > 30,
   ATR ≥ 0.4%) được chọn **sau khi đã xem dữ liệu 2021 → 2026**, nên kết quả này vẫn nhìn trước đáp án.
3. Thay các tham số cố định bằng giá trị thông dụng chưa từng tối ưu (kênh 5%/95%, ADX 25, stop 2 ATR,
   trailing 1R) thì **mọi biến thể đều thua hoặc hòa**, kể cả exit3 (+6% / −2%, PF ~1.0); bản không tối ưu
   gì thì lỗ −19%. Tối ưu riêng phần vào lệnh (entry2, entry3) luôn thua, ở cả hai bộ cố định.
4. Tham số thoát lệnh tốt nhất nhảy lung tung giữa các đoạn (r_atr 1.6 → 4.8, trail_dist 0.1 → 1.2): không có
   vùng tham số ổn định nào để bám vào.
5. Lọc xu hướng (chỉ Long trên EMA, Short dưới EMA, EMA 1/4/16 ngày hoặc tắt) không giúp.

**Nghĩa là:** lợi thế của DonchianRevert nằm gần như hoàn toàn ở bộ ngưỡng vào lệnh đã chọn tay, và không có
cách nào tìm lại được bộ ngưỡng đó nếu chỉ dùng dữ liệu quá khứ tại từng thời điểm. Khả năng cao đó là khớp dữ
liệu, không phải lợi thế thật. Giữ bot ở Demo/paper và để báo cáo tuần (hub/weekly.py) đo trên dữ liệu mới;
không nên tốn thêm công tối ưu biến thể của chiến lược này.

## Các biến thể

| Tên | Tham số tự do |
|---|---|
| full8 | cả 8 tham số như bot (đối chứng, giống robustness.py) |
| entry3 | dải Donchian đối xứng (dc_long = b, dc_short = 1 − b), adx_min, atr_min_pct |
| entry2 | dải Donchian đối xứng, adx_min |
| exit3 | r_atr, trail_start_r, trail_dist_r |
| trend4 | như entry3 + lọc xu hướng EMA (tắt / 96 / 384 / 1536 nến 15m) |

Tham số không tự do lấy từ một trong hai bộ: **current** (bot đang chạy, chọn sau khi xem dữ liệu) và
**textbook** (giá trị thông dụng, chưa từng tối ưu). full8 không có tham số cố định nên giống nhau ở hai bộ.

Đạt khi, với cả hai hàm mục tiêu (calmar = lãi/DD, profit = tổng lãi): chuỗi test ghép lại có lãi, PF ≥ 1.15,
≥ 60% số đoạn test có lãi.

## Kết quả — tham số cố định = bot đang chạy (current)

Tham số không tự do: dc_long=0.074, dc_short=0.944, adx_min=30, vol_max=1.0, atr_min_pct=0.4, r_atr=3.0, trail_start_r=2.0, trail_dist_r=1.0.

Train 2 năm → test 6 tháng, 10 đoạn, fastsim, phí 0.05%/chiều, rủi ro 1%. Mỗi lần tối ưu 3000 bộ ngẫu nhiên + 1000 bộ tinh chỉnh, cần ≥ 60 lệnh trong 2 năm. Đạt: cả hai hàm mục tiêu đều có chuỗi test lãi, PF ≥ 1.15, ≥ 60% đoạn có lãi.

Tham số cố định (current), không tối ưu, cùng giai đoạn: +30.0% | 8.3% | 1.20 | 235 | 41%, +5.8%/năm.

| Biến thể | Mục tiêu | Tổng lãi | Max DD | PF | Số lệnh | Thắng | Lãi/năm | Đoạn có lãi | Train TB/2 năm |
|---|---|---|---|---|---|---|---|---|---|
| full8 | calmar | -1.6% | 18.0% | 0.99 | 273 | 32% | -0.3% | 5/10 | +100% |
| full8 | profit | -64.9% | 71.6% | 0.79 | 687 | 24% | -20.1% | 4/10 | +153% |
| entry3 | calmar | -10.2% | 21.1% | 0.91 | 201 | 36% | -2.3% | 6/10 | +44% |
| entry3 | profit | -34.0% | 46.7% | 0.80 | 328 | 33% | -8.5% | 4/10 | +52% |
| entry2 | calmar | +2.8% | 18.0% | 1.02 | 214 | 36% | +0.6% | 5/10 | +40% |
| entry2 | profit | -47.8% | 51.8% | 0.81 | 522 | 33% | -13.0% | 2/10 | +48% |
| exit3 | calmar | +36.7% | 8.5% | 1.24 | 218 | 37% | +6.9% | 8/10 | +51% |
| exit3 | profit | +40.6% | 12.0% | 1.25 | 224 | 36% | +7.6% | 7/10 | +60% |
| trend4 | calmar | +1.5% | 17.1% | 1.02 | 129 | 40% | +0.3% | 5/10 | +46% |
| trend4 | profit | -17.6% | 38.4% | 0.92 | 409 | 36% | -4.1% | 3/10 | +58% |

- **full8** (8 tham số như bot (đối chứng, giống robustness.py)): không đạt
- **entry3** (3 tham số vào lệnh: dải Donchian đối xứng, adx_min, atr_min_pct; thoát lệnh cố định): không đạt
- **entry2** (2 tham số: dải Donchian đối xứng, adx_min): không đạt
- **exit3** (chỉ 3 tham số thoát lệnh (r_atr, trailing), vào lệnh cố định): ĐẠT
- **trend4** (entry3 + lọc xu hướng: chỉ Long trên EMA, Short dưới EMA (EMA tắt/1/4/16 ngày)): không đạt


## Kết quả — tham số cố định = giá trị thông dụng (textbook)

Tham số không tự do: dc_long=0.05, dc_short=0.95, adx_min=25, vol_max=1.0, atr_min_pct=0.4, r_atr=2.0, trail_start_r=1.0, trail_dist_r=1.0.

Train 2 năm → test 6 tháng, 10 đoạn, fastsim, phí 0.05%/chiều, rủi ro 1%. Mỗi lần tối ưu 3000 bộ ngẫu nhiên + 1000 bộ tinh chỉnh, cần ≥ 60 lệnh trong 2 năm. Đạt: cả hai hàm mục tiêu đều có chuỗi test lãi, PF ≥ 1.15, ≥ 60% đoạn có lãi.

Tham số cố định (textbook), không tối ưu, cùng giai đoạn: -18.8% | 26.2% | 0.84 | 266 | 48%, -4.4%/năm.

| Biến thể | Mục tiêu | Tổng lãi | Max DD | PF | Số lệnh | Thắng | Lãi/năm | Đoạn có lãi | Train TB/2 năm |
|---|---|---|---|---|---|---|---|---|---|
| full8 | calmar | -1.6% | 18.0% | 0.99 | 273 | 32% | -0.3% | 5/10 | +100% |
| full8 | profit | -64.9% | 71.6% | 0.79 | 687 | 24% | -20.1% | 4/10 | +153% |
| entry3 | calmar | -19.5% | 26.8% | 0.72 | 156 | 49% | -4.5% | 4/10 | +19% |
| entry3 | profit | -34.1% | 39.0% | 0.62 | 214 | 45% | -8.6% | 3/10 | +19% |
| entry2 | calmar | -16.7% | 24.2% | 0.85 | 256 | 49% | -3.9% | 4/10 | +14% |
| entry2 | profit | -23.3% | 30.4% | 0.81 | 299 | 49% | -5.5% | 4/10 | +16% |
| exit3 | calmar | +6.1% | 11.4% | 1.04 | 206 | 37% | +1.3% | 5/10 | +44% |
| exit3 | profit | -2.2% | 22.9% | 0.99 | 232 | 30% | -0.5% | 5/10 | +54% |
| trend4 | calmar | -2.2% | 11.1% | 0.97 | 163 | 50% | -0.5% | 5/10 | +34% |
| trend4 | profit | -6.4% | 17.9% | 0.94 | 216 | 50% | -1.4% | 5/10 | +35% |

- **full8** (8 tham số như bot (đối chứng, giống robustness.py)): không đạt
- **entry3** (3 tham số vào lệnh: dải Donchian đối xứng, adx_min, atr_min_pct; thoát lệnh cố định): không đạt
- **entry2** (2 tham số: dải Donchian đối xứng, adx_min): không đạt
- **exit3** (chỉ 3 tham số thoát lệnh (r_atr, trailing), vào lệnh cố định): không đạt
- **trend4** (entry3 + lọc xu hướng: chỉ Long trên EMA, Short dưới EMA (EMA tắt/1/4/16 ngày)): không đạt


## exit3 (current, calmar): tham số chọn ở từng đoạn

| Test | Train lãi | Test lãi/lệnh | Tham số |
|---|---|---|---|
| 2022-01 | +69% | +1.2% / 44 | r_atr=1.6, trail_start_r=1.1, trail_dist_r=0.1 |
| 2022-07 | +51% | +0.2% / 24 | r_atr=4.4, trail_start_r=3.4, trail_dist_r=0.3 |
| 2023-01 | +67% | -2.0% / 11 | r_atr=4.1, trail_start_r=3.0, trail_dist_r=0.1 |
| 2023-07 | +46% | +1.2% / 7 | r_atr=4.1, trail_start_r=2.7, trail_dist_r=1.1 |
| 2024-01 | +32% | +9.8% / 26 | r_atr=3.9, trail_start_r=2.5, trail_dist_r=1.2 |
| 2024-07 | +33% | +5.2% / 31 | r_atr=4.8, trail_start_r=2.3, trail_dist_r=0.1 |
| 2025-01 | +51% | +3.3% / 27 | r_atr=3.3, trail_start_r=3.0, trail_dist_r=1.0 |
| 2025-07 | +53% | +3.7% / 23 | r_atr=3.2, trail_start_r=3.4, trail_dist_r=1.1 |
| 2026-01 | +58% | +14.2% / 21 | r_atr=3.0, trail_start_r=3.7, trail_dist_r=0.1 |
| 2026-07 | +53% | -3.9% / 4 | r_atr=3.0, trail_start_r=3.5, trail_dist_r=0.1 |
