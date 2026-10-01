# Kiểm tra độ bền TrendBreakout — 10/2026

TrendBreakout: 4h, breakout kênh Donchian 2 chiều, danh mục 10 coin (BTC ETH SOL BNB XRP DOGE ADA LINK AVAX LTC), mỗi coin
tối đa 1 lệnh, rủi ro 0.5%/lệnh, đòn bẩy cố định x5. Dữ liệu Binance USDT-M perpetual thật (data.binance.vision): nến 4h + 15m,
funding thật, 2020-04-01 → 2026-08-31. Backtest dùng `--timeframe-detail 15m`, phí 0.05%/chiều. Tham số giữ nguyên như
`TrendBreakout.py` (mặc định kênh 20/10, r_atr 2.0, không EMA). Số liệu từ GitHub Actions
[run 36896374832](https://github.com/fiaboo1628-pixel/btc-backtest-app/actions/runs/36896374832) (artifact `robustness-trend`).
Cùng bộ kiểm tra như `robustness_2026-10.md` (DonchianRevert), để so sánh trực tiếp.

## Kết luận

1. **TrendBreakout vượt qua các bài kiểm tra mà DonchianRevert đã trượt.** Walk-forward (tối ưu 2 năm → test 6 tháng, 10 cửa sổ
   2022–2026) có lãi ở cả hai hàm mục tiêu: +239% (lãi kép +30%/năm) và +751% (+58%/năm), 6–7/10 đoạn test có lãi; tham số tối
   ưu ổn định qua các cửa sổ (entry 14–15, exit 13–15, r_atr 1.0) thay vì nhảy loạn. Độ nhạy: 100% trong 200 bộ lệch ±20% có lãi,
   mọi ô trong hai bảng 2 chiều đều dương (+250% → +3000%). Chi phí 0.09%/chiều vẫn còn +764%, PF 1.12. 8/10 coin lãi khi chạy
   riêng, bỏ bất kỳ coin nào danh mục vẫn +700% → +1500%. Lợi thế có thật và không phụ thuộc một tham số hay một coin.
2. **Nhưng rủi ro ở mức 0.5%/lệnh là quá cao để chạy thật:** max DD 48.7% (+EMA200: 39.6%), năm 2025 −15%, chuỗi thua dài nhất
   67 lệnh. Monte Carlo xáo lệnh cho DD p50 chỉ 26%, p99 42% — DD thực tế vượt p99, nghĩa là **lệnh thua dồn cục**: 10 coin
   phá vỡ cùng lúc rồi thất bại cùng lúc, rủi ro thật mỗi "đợt" là 10 × 0.5% chứ không phải 0.5%. Monte Carlo theo lệnh đánh
   giá thấp rủi ro của chiến lược này gần 2 lần.
3. **Nếu chạy thật: rủi ro 0.2–0.25%/lệnh, vốn ≥ 3 000 USDT, dry-run trước ít nhất 3 tháng.** Ở 0.25%, kỳ vọng DD 20–30%
   (Monte Carlo p95 20.5% × hệ số dồn cục ~1.5–1.9), lãi kép ước 15–25%/năm. Dưới 3 000 USDT, lệnh BTC/ETH ở 0.25% nhỏ hơn giá
   trị tối thiểu 100 USDT của Binance và bị bỏ. Nên dùng cấu hình **20/10 + EMA200** (DD thấp hơn 9 điểm, PF 1.27, 7/7 năm lãi,
   thắng walk-forward ở 8/10 đoạn) chứ không phải mặc định hiện tại.
4. **Điểm yếu lớn nhất: lãi đến theo cụm năm và phía Short không đóng góp.** 2021 + 2023 + 2024 chiếm gần hết lãi; 2025 lỗ cả
   năm; funding ăn −1 933 USDT (≈16% lãi gộp). Short lỗ −518 USDT trên 1 867 lệnh, Long +11 856 trên 2 047 — toàn bộ lợi thế nằm
   ở Long (đây là nhận xét sau khi xem kết quả, chưa được kiểm tra ngoài mẫu, không nên đổi tham số ngay). Cảnh báo
   look-ahead 1/40 của nghiên cứu cũ là báo nhầm (đã làm rõ 10/2026, xem mục "Việc cần làm" bước 1).
5. **Ghép với DonchianRevert không có ý nghĩa ở quy mô này:** Revert BTC +31% so với Trend +1134% cùng kỳ; tương quan tháng −0.12,
   Trend bù được 18/28 tháng Revert lỗ, Revert không bù được tháng nào Trend lỗ (0/33). Nếu chạy cả hai, Revert chỉ là nhiễu.
   Thứ tự ưu tiên nên đảo lại: TrendBreakout (rủi ro thấp) là ứng viên chính, DonchianRevert là phụ hoặc bỏ.

## 0. Đối chiếu bộ mô phỏng nhanh với freqtrade

| | Tổng lãi | Max DD | PF | Số lệnh | Thắng | Lãi từng năm (% vốn đầu năm) |
|---|---|---|---|---|---|---|
| freqtrade | +1133.8% | 48.7% | 1.15 | 3914 | 32% | 2020: +62 · 2021: +121 · 2022: +26 · 2023: +73 · 2024: +72 · 2025: −15 · 2026: +8 |
| fastsim_trend | +1224.2% | 48.8% | 1.15 | 3954 | 32% | 2020: +65 · 2021: +125 · 2022: +29 · 2023: +73 · 2024: +73 · 2025: −14 · 2026: +8 |

3899/3914 lệnh trùng coin và giờ vào; 98.8% trong đó trùng giờ ra. Chênh tổng lãi 8% sau 6 năm lãi kép (lệch 15 lệnh và một vài
giờ thoát); DD, PF, lãi theo năm trùng. Kết luận dùng số freqtrade khi có.

## 1. Baseline — danh mục 10 coin

| | Tổng lãi | Max DD | PF | Số lệnh | Thắng | Lãi kép/năm | Lãi từng năm |
|---|---|---|---|---|---|---|---|
| Mặc định: kênh 20/10, không EMA | +1133.8% | 48.7% | 1.15 | 3914 | 32% | +48.0% | 2020: +62 · 2021: +121 · 2022: +26 · 2023: +73 · 2024: +72 · **2025: −15** · 2026: +8 |
| Kênh 20/10 + EMA200 | +2116.8% | 39.6% | 1.27 | 3021 | 33% | +62.1% | 2020: +68 · 2021: +151 · 2022: +40 · 2023: +87 · 2024: +45 · 2025: +12 · 2026: +23 |

| Coin | Lệnh | Lãi USDT (mặc định) | Thắng | Lệnh | Lãi USDT (+EMA200) |
|---|---|---|---|---|---|
| BTC | 395 | +1752 | 32% | 297 | +3420 |
| ETH | 409 | +1801 | 28% | 312 | +3934 |
| SOL | 365 | +1924 | 36% | 282 | +2793 |
| BNB | 392 | +979 | 33% | 309 | +1892 |
| XRP | 377 | +3001 | 30% | 297 | +3510 |
| DOGE | 340 | +2232 | 32% | 268 | +3580 |
| ADA | 413 | +1046 | 32% | 314 | +1754 |
| LINK | 434 | −405 | 31% | 329 | +224 |
| AVAX | 371 | +1332 | 34% | 287 | +1762 |
| LTC | 418 | **−2324** | 33% | 326 | −1701 |

Long +11 856 USDT (2 047 lệnh), Short −518 USDT (1 867 lệnh). Funding cộng dồn −1 933 USDT.

## 2. Walk-forward (train 2 năm → test 6 tháng, trượt 6 tháng, 2022-01 → 2026-08)

Mỗi cửa sổ: 1 500 bộ ngẫu nhiên + 500 bộ tinh chỉnh quanh top 10 trên entry_period 10–100, exit_period 5–50, r_atr 1–6, EMA200
bật/tắt; cần ≥ 100 lệnh trong 2 năm train. Đoạn test ghép lãi kép, chạy lại bằng freqtrade.

| | Tổng lãi | Max DD | PF | Số lệnh | Lãi kép/năm | Đoạn lãi | Hơn mặc định | Hơn +EMA200 |
|---|---|---|---|---|---|---|---|---|
| WF tối ưu lãi / max(DD, 5) — freqtrade | **+237.5%** | 61.2% | 1.13 | 2747 | +30% | 6/10 | 3/10 | 2/10 |
| WF tối ưu tổng lãi — fastsim | **+751.2%** | 59.1% | 1.20 | 2738 | +58% | 7/10 | 6/10 | 7/10 |
| Mặc định 20/10, cùng giai đoạn | +290.6% | 47.7% | 1.15 | 2981 | +34% | | | |
| 20/10 + EMA200, cùng giai đoạn | +465.4% | 39.2% | 1.28 | 2297 | +45% | | | |

So với DonchianRevert cùng khung kiểm tra: WF −33% và −77%. Ở đây cả hai hàm mục tiêu đều cho lãi ngoài mẫu lớn; chênh lệch
train/test vẫn lớn (train +587–733%/2 năm so với test +16–28%/6 tháng) nhưng dấu không đổi.

Từng đoạn test (hàm tổng lãi):

| Test | Train lãi/DD | Test WF | Test mặc định | Test +EMA200 | entry | exit | r_atr | EMA |
|---|---|---|---|---|---|---|---|---|
| 2022-01→07 | +1196% / 36% | +64.0% / 22.6% | +35.2% / 13.7% | +48.4% / 11.0% | 38 | 36 | 1.0 | tắt |
| 2022-07→2023-01 | +2729% / 27% | −11.1% / 36.7% | −3.9% / 25.3% | −3.9% / 22.0% | 14 | 14 | 1.0 | bật |
| 2023-01→07 | +794% / 37% | +30.1% / 36.6% | +30.7% / 19.7% | +19.3% / 19.8% | 14 | 14 | 1.0 | bật |
| 2023-07→2024-01 | +247% / 36% | +39.2% / 28.7% | +30.7% / 19.0% | +51.6% / 13.1% | 14 | 13 | 1.2 | tắt |
| 2024-01→07 | +440% / 43% | +1.4% / 31.9% | −4.2% / 15.7% | −8.5% / 15.4% | 15 | 15 | 1.0 | bật |
| 2024-07→2025-01 | +164% / 42% | +77.2% / 41.0% | +77.5% / 12.7% | +56.5% / 9.9% | 40 | 30 | 1.0 | bật |
| 2025-01→07 | +662% / 39% | −3.1% / 22.2% | −18.2% / 25.3% | −9.2% / 17.7% | 18 | 15 | 1.0 | bật |
| 2025-07→2026-01 | +464% / 32% | +63.3% / 23.9% | +12.9% / 20.4% | +30.0% / 10.5% | 15 | 15 | 1.0 | bật |
| 2026-01→07 | +382% / 29% | −15.8% / 59.1% | −10.7% / 46.4% | +2.7% / 39.2% | 23 | 15 | 1.0 | bật |
| 2026-07→08 | +257% / 52% | +34.8% / 24.3% | +25.6% / 23.2% | +26.3% / 20.3% | 33 | 15 | 1.0 | bật |

Tham số được chọn hội tụ: kênh vào 14–15 (ngắn hơn mặc định 20), kênh ra 13–15 (dài hơn mặc định 10), **r_atr 1.0** ở 9/10
cửa sổ, EMA200 bật ở 8/10. Đây là vùng tham số ổn định theo thời gian — trái ngược với DonchianRevert, nơi tham số tối ưu nhảy
loạn giữa các cửa sổ. Giá phải trả của r_atr 1.0 là DD 59–61% (so với 39% của +EMA200 r_atr 2.0).

## 3. Độ nhạy tham số (fastsim; baseline +1224% / DD 49% / PF 1.15)

| Tham số | −20% | Lãi / DD / PF | +20% | Lãi / DD / PF |
|---|---|---|---|---|
| entry_period | 16 | +1270% / 52% / 1.13 | 24 | +1161% / 48% / 1.17 |
| exit_period | 8 | +991% / 50% / 1.15 | 12 | +1617% / 50% / 1.16 |
| r_atr | 1.6 | +1641% / 57% / 1.12 | 2.4 | +747% / 42% / 1.16 |
| ema_filter | tắt | +1224% / 49% / 1.15 | bật | +2141% / 40% / 1.27 |

Lệch đồng thời 3 tham số ±20% + EMA ngẫu nhiên (200 lần): lãi p5/p50/p95 = +839% / +1581% / +2884%, **100% có lãi**, DD p95 56%.

### entry_period × exit_period (không EMA; lãi % / DD %)

| exit \ entry | 10 | 15 | 20 | 30 | 40 | 55 | 70 | 100 |
|---|---|---|---|---|---|---|---|---|
| 5 | +473 / 46 | +510 / 53 | +409 / 52 | +585 / 50 | +634 / 38 | +342 / 36 | +312 / 32 | +392 / 24 |
| 7 | +1172 / 39 | +1207 / 49 | +956 / 48 | +1167 / 42 | +1177 / 33 | +580 / 34 | +546 / 28 | +577 / 20 |
| 10 | +1298 / 42 | +1490 / 50 | **+1224 / 49** | +1292 / 43 | +1289 / 35 | +524 / 34 | +541 / 28 | +604 / 23 |
| 15 | +1298 / 42 | +2993 / 55 | +2541 / 52 | +2192 / 47 | +2203 / 38 | +929 / 38 | +1000 / 31 | +1052 / 23 |
| 20 | +1298 / 42 | +2993 / 55 | +2061 / 51 | +1948 / 46 | +1992 / 37 | +752 / 36 | +814 / 31 | +930 / 27 |
| 27 | +1298 / 42 | +2993 / 55 | +2061 / 51 | +1485 / 46 | +1611 / 37 | +617 / 37 | +661 / 35 | +794 / 29 |
| 35 | +1298 / 42 | +2993 / 55 | +2061 / 51 | +1979 / 46 | +2318 / 37 | +1023 / 34 | +1130 / 33 | +1228 / 27 |

(exit_period bị cắt về ≤ entry_period, nên các ô dưới đường chéo lặp lại.) Mọi ô dương. Kênh vào ≤ 40 tốt hơn ≥ 55; kênh ra 15
tốt hơn 10. DD giảm đều khi kênh vào dài hơn (ít lệnh hơn).

### entry_period × r_atr (không EMA, exit = 10)

| r_atr \ entry | 10 | 15 | 20 | 30 | 40 | 55 | 70 | 100 |
|---|---|---|---|---|---|---|---|---|
| 1.0 | +2614 / 67 | +1838 / 77 | +1684 / 74 | +2016 / 61 | +2858 / 53 | +695 / 48 | +528 / 45 | +905 / 40 |
| 1.5 | +2033 / 52 | +1816 / 67 | +1651 / 61 | +2204 / 51 | +1754 / 42 | +647 / 39 | +567 / 35 | +759 / 31 |
| 2.0 | +1298 / 42 | +1490 / 50 | **+1224 / 49** | +1292 / 43 | +1289 / 35 | +524 / 34 | +541 / 28 | +604 / 23 |
| 2.5 | +909 / 37 | +894 / 40 | +677 / 40 | +725 / 38 | +791 / 30 | +368 / 30 | +393 / 24 | +465 / 19 |
| 3.0 | +650 / 32 | +625 / 35 | +565 / 33 | +581 / 32 | +595 / 26 | +309 / 26 | +319 / 19 | +383 / 16 |
| 4.0 | +428 / 25 | +438 / 26 | +396 / 24 | +384 / 23 | +359 / 19 | +231 / 19 | +242 / 15 | +262 / 12 |
| 5.0 | +298 / 21 | +315 / 22 | +282 / 20 | +261 / 18 | +245 / 15 | +163 / 16 | +170 / 12 | +184 / 11 |

Đơn điệu: stop càng sát lãi càng cao và DD càng cao. r_atr là nút chỉnh lãi/rủi ro, không phải tham số "đúng/sai".
Với cùng rủi ro 0.5%/lệnh, r_atr 4–5 cho DD 12–25% và lãi +250–440% (lãi kép ~20–30%/năm) — một cách khác để hạ rủi ro thay
cho giảm risk_pct.

## 4. Chi phí xấu

| | Tổng lãi | Max DD | PF | Lãi từng năm |
|---|---|---|---|---|
| freqtrade, phí 0.05% (baseline) | +1133.8% | 48.7% | 1.15 | 2020: +62 · 2021: +121 · 2022: +26 · 2023: +73 · 2024: +72 · 2025: −15 · 2026: +8 |
| freqtrade, phí 0.09% (0.07% + trượt 0.02%) | **+764.4%** | 51.7% | 1.12 | 2020: +58 · 2021: +115 · 2022: +20 · 2023: +62 · 2024: +62 · 2025: −21 · 2026: +3 |

Lãi tổng % (PF) theo phí × trượt giá mỗi chiều (fastsim):

| Phí \ trượt | 0 | 0.02% | 0.05% | 0.10% |
|---|---|---|---|---|
| 0.020% | +1618% (1.17) | +1343% (1.16) | +999% (1.14) | +606% (1.10) |
| 0.035% | +1402% (1.16) | +1159% (1.15) | +862% (1.13) | +515% (1.09) |
| 0.050% | +1224% (1.15) | +999% (1.14) | +742% (1.12) | +439% (1.09) |
| 0.070% | +999% (1.14) | +820% (1.12) | +606% (1.10) | +351% (1.07) |
| 0.100% | +742% (1.12) | +606% (1.10) | +439% (1.09) | +246% (1.06) |

Vẫn lãi ở phí 0.10% + trượt 0.10% (PF 1.06). Khung 4h với 1R = 2 ATR(4h) ≈ 4–6% giá nên chi phí chỉ là phần nhỏ của R —
đúng điều báo cáo DonchianRevert chỉ ra là nút thắt ở 15m.

## 5. Từng coin riêng và bỏ-một-coin (fastsim, mặc định 20/10)

| Coin | Riêng: lãi | DD | PF | Lệnh | Năm lãi | Danh mục bỏ coin này: lãi | DD | PF |
|---|---|---|---|---|---|---|---|---|
| BTC | +62% | 7% | 1.49 | 395 | 6/7 | +859% | 46% | 1.16 |
| ETH | +46% | 7% | 1.34 | 409 | 7/7 | +984% | 46% | 1.15 |
| SOL | +50% | 7% | 1.43 | 377 | 6/7 | +916% | 46% | 1.15 |
| BNB | +47% | 7% | 1.32 | 398 | 5/7 | +949% | 45% | 1.16 |
| XRP | +63% | 14% | 1.44 | 376 | 6/7 | +880% | 45% | 1.15 |
| DOGE | +89% | 9% | 1.55 | 350 | 6/7 | +701% | 46% | 1.15 |
| ADA | +27% | 8% | 1.20 | 418 | 6/7 | +1098% | 47% | 1.16 |
| LINK | +5% | 14% | 1.04 | 434 | 4/7 | +1297% | 44% | 1.18 |
| AVAX | +52% | 14% | 1.35 | 385 | 4/7 | +921% | 42% | 1.17 |
| LTC | **−11%** | 23% | 0.90 | 412 | 2/7 | +1499% | 44% | 1.20 |

Mỗi coin riêng ở 0.5%/lệnh chỉ lãi +5% → +89% với DD 7–23%; lãi danh mục +1224% là do 10 coin chạy song song (rủi ro tổng
≈ 5%/đợt) và lãi kép. Bỏ LTC tăng lãi lên +1499% và PF 1.20 — nhưng đó là chọn sau khi xem; không nên bỏ coin vì lý do này.

## 6. Monte Carlo (1 000 lần xáo thứ tự lệnh)

| Chuỗi lệnh | Rủi ro/lệnh | DD thực tế | DD p50 | DD p95 | DD p99 | Tệ nhất |
|---|---|---|---|---|---|---|
| Baseline 20/10 | 0.25% | | 13.5% | 20.5% | 23.5% | 27.5% |
| Baseline 20/10 | 0.5% | **48.7%** | 25.9% | 36.5% | 42.0% | 57.7% |
| Baseline 20/10 | 1.0% | | 46.0% | 60.5% | 67.4% | 75.1% |
| Walk-forward OOS | 0.5% | **61.2%** | 37.0% | 52.1% | 57.8% | 66.5% |

**DD thực tế vượt p99 của Monte Carlo** ở cả hai chuỗi: lệnh thua không độc lập mà dồn cục (10 coin phá vỡ giả cùng lúc trong
thị trường đi ngang). Chuỗi thua dài nhất thực tế 67 lệnh (WF: 86) so với p50 Monte Carlo 19 (23). Vì vậy không dùng p50/p95
Monte Carlo làm kỳ vọng DD; dùng DD thực tế nhân với tỉ lệ rủi ro: ở 0.25%/lệnh ước DD 25–30%.

Bootstrap 12 tháng (610 lệnh/năm, 10 000 lần, rủi ro 0.5%): lãi năm p5/p50/p95 = −7% / +46% / +149%, P(năm lỗ) 9%,
P(lỗ > 20%) 1% — nhưng cũng chịu cùng sai lệch dồn cục (năm 2025 thật −15%).

## 7. Ghép với DonchianRevert BTC trên cùng tài khoản (rủi ro 0.5%/lệnh mỗi bên)

| | Tổng lãi | Max DD | PF | Số lệnh | Lãi từng năm |
|---|---|---|---|---|---|
| TrendBreakout 20/10 | +1133.8% | 48.7% | 1.15 | 3914 | 2020: +62 · 2021: +121 · 2022: +26 · 2023: +73 · 2024: +72 · 2025: −15 · 2026: +8 |
| DonchianRevert BTC | +31.4% | 6.3% | 1.27 | 358 | 2020: +2 · 2021: +13 · 2022: −1 · 2023: +4 · 2024: +2 · 2025: +8 · 2026: +1 |
| Cả hai, một tài khoản | +1165.2% | 47.4% | 1.15 | 4272 | 2020: +64 · 2021: +128 · 2022: +25 · 2023: +72 · 2024: +70 · 2025: −15 · 2026: +8 |

Tương quan lãi theo tháng −0.12. Trend bù được 18/28 tháng Revert lỗ; Revert bù được 0/33 tháng Trend lỗ. Ở quy mô 1 coin ×
0.5% so với 10 coin × 0.5%, DonchianRevert không ảnh hưởng gì đến đường vốn chung. Muốn Revert có vai trò giảm DD thì phải
tăng rủi ro của nó lên ~10 lần, điều mà báo cáo robustness_2026-10.md đã khuyên không làm.

| Năm | Trend USDT | Revert USDT | Cả hai |
|---|---|---|---|
| 2020 | +622 | +18 | +640 |
| 2021 | +1965 | +133 | +2098 |
| 2022 | +934 | −12 | +923 |
| 2023 | +3317 | +48 | +3366 |
| 2024 | +5624 | +24 | +5647 |
| 2025 | −2078 | +94 | −1984 |
| 2026 | +955 | +8 | +963 |

## Việc cần làm trước khi cân nhắc chạy thật

1. ~~Làm rõ cảnh báo look-ahead~~ — **xong, báo nhầm.** Lệnh bị báo (SOL 08/01/2023) không phải do nhìn trước:
   lookahead-analysis đặt ví 1 tỷ USDT, và khi chạy qua `run_futures.py` (market giả, không giới hạn quy mô vị thế) với đòn
   bẩy tự tính (ra x1 khi 1R lớn), BTC + ETH ngày 02/01 ăn hết ~99% ví nên lần chạy đủ 3 cặp bỏ lệnh SOL 02/01 rồi vào 08/01;
   lần chạy cắt chỉ có SOL thì đủ tiền, vào từ 02/01 và còn giữ lệnh lúc 08/01 → "lệch". Kiểm chứng: cùng dữ liệu, freqtrade với
   market thật của Binance 0/40 và 0/300 tín hiệu (07/2022–12/2024); `run_futures.py` + `fixed_lev` (cấu hình nghiên cứu dùng)
   0/40. Dữ liệu data.binance.vision và API Binance trùng 100% quanh lệnh đó. `trend.py --checks-only` giờ chạy với `fixed_lev`.
2. Chạy dry-run cấu hình 20/10 + EMA200, rủi ro 0.25%/lệnh, ≥ 3 tháng, so lệnh thật với backtest cùng kỳ (hub đã có báo cáo tuần).
3. Kiểm tra lại Short riêng theo walk-forward (hiện Short lỗ toàn kỳ) — nếu Short cũng không có lợi thế ngoài mẫu thì cân nhắc
   `short_enabled = False`, nhưng chỉ sau khi kiểm tra, không phải vì bảng trên.
4. Tính lại funding: −1 933 USDT là chi phí thật khi giữ lệnh 4h nhiều ngày; dry-run sẽ cho số thực tế.

## Cách tái chạy

GitHub: Actions → **robustness-trend** → *Run workflow* (chọn coin). ~50 phút. Kết quả ở tab Summary và artifact `robustness-trend`.

Trên máy (cần mạng tới data.binance.vision, ~4 nhân, ~3 GB RAM):

```bash
cd bot
pip install freqtrade==2026.8 numba
python research/binance_vision.py --pairs BTC ETH SOL BNB XRP DOGE ADA LINK AVAX LTC --tf 15m 4h --start 2020-01 --end 2026-08 --out data/binance
python research/binance_vision.py --pairs BTC --tf 1m --start 2020-01 --end 2026-08 --out data/binance   # DonchianRevert cho bước 7
python research/robustness_trend.py --datadir data/binance --out robustness_trend_out
```

Chạy nhanh: `--steps baseline,sens --coins BTC ETH`, hoặc `--wf-rand 200 --wf-local 50 --mc 200`. Hạt giống cố định (`SEED`).

## Giới hạn của báo cáo này

- fastsim_trend lạc quan hơn freqtrade ~8% tổng lãi sau 6 năm (lệch 15 lệnh + 1.2% giờ thoát); DD, PF, dấu theo năm trùng.
  Walk-forward hàm "tổng lãi" chưa chạy lại bằng freqtrade (hàm lãi/DD đã chạy: +237.5% so với +239.3% fastsim).
- Monte Carlo xáo lệnh giả định lệnh độc lập — sai với chiến lược này (xem bước 6); các số p50/p95 chỉ để so với DD thực tế.
- Mọi cấu hình trong bảng độ nhạy và bước 5 đều chạy trên toàn kỳ (đã thấy dữ liệu); chỉ bước 2 là ngoài mẫu thật.
- Rủi ro 0.5%/lệnh × 10 coin đồng thời; không mô phỏng giới hạn tổng vị thế hay thiếu ký quỹ khi 10 lệnh cùng mở (đòn bẩy x5 →
  ký quỹ mỗi lệnh ≈ 2% vốn, tổng ≈ 20%, chưa chạm giới hạn).
