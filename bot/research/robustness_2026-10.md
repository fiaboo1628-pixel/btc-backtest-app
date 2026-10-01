# Kiểm tra độ bền DonchianRevert — 10/2026

Dữ liệu: Binance USDT-M perpetual thật từ data.binance.vision (nến 15m + 1m, funding thật), 2020-01-03 → 2026-08-31.
Backtest luôn dùng `--timeframe-detail 1m`, phí 0.05%/chiều (taker), vốn 1 000 USDT, rủi ro 1%/lệnh, 1 lệnh/lúc.
Tham số chiến lược giữ nguyên như trong `DonchianRevert.py`. Số liệu do GitHub Actions
[run 36881669387](https://github.com/fiaboo1628-pixel/btc-backtest-app/actions/runs/36881669387) sinh ra (artifact `robustness`).

## Kết luận

1. **Chưa nên chạy tiền thật ở mức vốn có ý nghĩa.** Walk-forward thất bại ở cả hai hàm mục tiêu: tham số tối ưu trên 2 năm rồi chạy 6 tháng kế tiếp lỗ −33% (tối ưu lãi/DD) và −77% (tối ưu lãi), trong khi cùng tham số đó lãi +110–170% trên đoạn train. Tức là trên dữ liệu này, bộ tham số nào "đẹp" trong quá khứ cũng không chuyển sang tương lai được, và không có cách nào chứng minh tham số hiện tại là ngoại lệ, vì nó được chọn sau khi đã xem toàn bộ 2021–2026.
2. **Nếu vẫn muốn chạy, coi đó là thử nghiệm trả phí:** vốn 1 000–2 000 USDT (dưới 500 USDT thì bước 0.001 BTC và lệnh tối thiểu 100 USDT làm bỏ 1–19% lệnh và rủi ro thực tế thấp hơn mục tiêu), **rủi ro 0.5%/lệnh** thay vì 1% (Monte Carlo: max DD p95 13% và tệ nhất 18%, so với 25% và 34% ở mức 1%). Dừng nếu DD vượt 15% hoặc PF < 1 sau 60 lệnh.
3. **Điểm yếu lớn nhất: lợi thế quá mỏng, không tách được khỏi nhiễu.** Trên Binance thật, tham số hiện tại chỉ lãi kép +7.6%/năm, PF 1.22, 2/7 năm lỗ và 2026 hòa; thêm 0.04%/chiều chi phí (phí 0.07% + trượt 0.02%) cắt lãi từ +63% xuống +37%; trên ETH/SOL PF chỉ 1.09 và BNB lỗ −53% với cùng tham số.
4. **Điểm yếu 1 (Bitstamp spot) là thật:** tổng lãi gần nhau (+75% so với +68% cùng phí) nhưng chỉ 108/322 lệnh trùng nến và lãi theo năm khác hẳn (2022: +7.9% so với −2.2%; 2025: +3.5% so với +17.8%). Số trong README không mô tả bot sẽ giao dịch gì trên Binance; từ nay dùng số Binance.
5. **Điểm yếu 2 (tham số chọn sau khi xem kết quả) được xác nhận**, không bác bỏ. Điểm cộng duy nhất: độ nhạy ổn (88% bộ tham số lệch ngẫu nhiên ±20% vẫn có lãi; vùng adx_min 27–40 × atr_min_pct 0.3–0.5 là mặt phẳng, không phải đỉnh nhọn), nhưng độ nhạy đo trên chính dữ liệu đã dùng để chọn tham số nên chỉ nói được rằng tham số không phải điểm may mắn cô lập, không nói được tương lai.

## 0. Đối chiếu bộ mô phỏng nhanh với freqtrade

Walk-forward và độ nhạy cần hàng chục nghìn lần chạy, freqtrade mất ~5 phút/lần nên không dùng được. `research/fastsim.py`
mô phỏng lại cách freqtrade vào lệnh, dời stop và tính funding; các kết quả chính (baseline, chi phí, coin khác, từng đoạn
test walk-forward) đều chạy lại bằng freqtrade thật để kiểm tra.

| | Tổng lãi | Max DD | PF | Số lệnh | Thắng | Lãi từng năm (% vốn đầu năm) |
|---|---|---|---|---|---|---|
| freqtrade | +63.1% | 12.9% | 1.22 | 378 | 42% | 2020: −1.8 · 2021: +29.2 · 2022: −3.4 · 2023: +8.7 · 2024: +4.2 · 2025: +17.6 · 2026: −0.0 |
| fastsim | +67.6% | 12.9% | 1.24 | 377 | 42% | 2020: −1.8 · 2021: +29.2 · 2022: −2.3 · 2023: +8.9 · 2024: +5.0 · 2025: +18.2 · 2026: +0.2 |

377/378 lệnh trùng giờ vào, 100% trùng giờ ra; chênh lãi trung bình 0.25 USDT/lệnh. fastsim lạc quan hơn ~4 điểm % trên 6.7 năm
(một lệnh thiếu và làm tròn), đủ sát để xếp hạng tham số; kết luận dùng số freqtrade khi có.

## 1. Baseline — tham số hiện tại trên Binance BTCUSDT perpetual

| | Tổng lãi | Max DD | PF | Số lệnh | Thắng | Lãi kép/năm |
|---|---|---|---|---|---|---|
| Binance perp, 2020-01 → 2026-08 | +63.1% | 12.9% | 1.22 | 378 | 42% | +7.6% |

| Năm | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 (8 tháng) |
|---|---|---|---|---|---|---|---|
| Lãi USDT (vốn 1 000) | −18 | +286 | −44 | +106 | +56 | +245 | −0 |
| Lãi % vốn đầu năm | −1.8 | +29.2 | −3.4 | +8.7 | +4.2 | +17.6 | −0.0 |
| Số lệnh | 55 | 87 | 66 | 21 | 66 | 55 | 28 |

Long +404 USDT (151 lệnh), Short +227 USDT (227 lệnh). Funding thật cộng dồn +17 USDT (gần như trung tính).
Hai năm 2021 và 2025 đóng góp 531/631 USDT; bỏ hai năm đó, 5 năm còn lại gần hòa.

### Điểm yếu 1: Bitstamp spot so với Binance perpetual (2021-01 → 2026-08, fastsim)

| | Tổng lãi | Max DD | PF | Số lệnh | Lãi từng năm |
|---|---|---|---|---|---|
| Bitstamp spot, phí 0.035% (số README) | +87.1% | 15.1% | 1.25 | 423 | 2021: +19.4 · 2022: +9.2 · 2023: +14.3 · 2024: +10.3 · 2025: +5.2 · 2026: +8.2 |
| Binance perp, phí 0.035% | +74.0% | 12.6% | 1.29 | 322 | 2021: +29.5 · 2022: −1.2 · 2023: +9.1 · 2024: +5.6 · 2025: +17.7 · 2026: +0.3 |
| Bitstamp spot, phí 0.05% | +74.8% | 15.5% | 1.22 | 423 | 2021: +17.5 · 2022: +7.9 · 2023: +13.7 · 2024: +8.5 · 2025: +3.5 · 2026: +7.9 |
| Binance perp, phí 0.05% | +67.9% | 12.9% | 1.27 | 322 | 2021: +27.9 · 2022: −2.2 · 2023: +8.7 · 2024: +4.6 · 2025: +17.8 · 2026: +0.1 |

Chỉ 108 lệnh vào cùng nến 15m trên cả hai nguồn (157 nếu cho lệch ≤ 1 giờ). Donchian/ADX/volume tính trên hai sàn cho tín hiệu
khác nhau ở 2/3 số lệnh; "6/6 năm có lãi" của README trở thành 4/6 trên Binance.

## 2. Walk-forward (train 2 năm → test 6 tháng, trượt 6 tháng, 2022-01 → 2026-08)

Mỗi cửa sổ: 5 000 bộ tham số ngẫu nhiên trên toàn miền của 8 tham số buy/sell + 2 000 bộ tinh chỉnh quanh top 10, cần ≥ 60
lệnh trong 2 năm train. Bộ tốt nhất chạy trên 6 tháng ngay sau (chưa từng thấy). Các đoạn test ghép lãi kép và chạy lại bằng freqtrade.

| | Tổng lãi | Max DD | PF | Số lệnh | Thắng | Lãi kép/năm |
|---|---|---|---|---|---|---|
| WF tối ưu lãi / max(DD, 5) — freqtrade | **−33.3%** | 38.8% | 0.81 | 328 | 27% | −8.3% |
| WF tối ưu tổng lãi — freqtrade | **−77.1%** | 77.1% | 0.71 | 642 | 19% | −27.0% |
| Tham số hiện tại, cùng giai đoạn | +30.0% | 8.3% | 1.20 | 235 | 41% | +5.8% |

Từng đoạn test (hàm mục tiêu lãi/DD):

| Test | Train lãi/DD | Test WF | Test hiện tại | dc_long | dc_short | adx_min | vol_max | atr_min | r_atr | trail_start | trail_dist |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2022-01→07 | +118% / 4% | +2.8% / 24 lệnh | +3.2% | 0.158 | 0.920 | 28 | 2.80 | 1.08 | 1.9 | 3.5 | 1.5 |
| 2022-07→2023-01 | +79% / 7% | −13.8% / 61 | −5.3% | 0.300 | 0.822 | 13 | 2.37 | 0.12 | 5.1 | 0.9 | 1.7 |
| 2023-01→07 | +112% / 9% | −14.9% / 96 | +6.4% | 0.086 | 0.889 | 24 | 1.54 | 0.02 | 4.8 | 1.4 | 0.9 |
| 2023-07→2024-01 | +161% / 8% | +2.2% / 11 | +2.2% | 0.057 | 0.902 | 22 | 1.33 | 0.15 | 4.9 | 4.6 | 0.1 |
| 2024-01→07 | +80% / 5% | −9.3% / 22 | +1.4% | 0.061 | 0.943 | 22 | 2.57 | 0.33 | 5.9 | 4.0 | 0.3 |
| 2024-07→2025-01 | +76% / 5% | +3.1% / 18 | +2.6% | 0.135 | 0.942 | 45 | 1.76 | 0.23 | 4.9 | 3.1 | 1.5 |
| 2025-01→07 | +121% / 5% | +2.3% / 21 | +3.8% | 0.067 | 0.961 | 35 | 2.31 | 0.00 | 5.1 | 5.0 | 1.6 |
| 2025-07→2026-01 | +125% / 8% | −11.2% / 33 | +13.1% | 0.092 | 0.977 | 10 | 2.67 | 0.35 | 4.1 | 3.9 | 1.0 |
| 2026-01→07 | +88% / 8% | +5.5% / 27 | +2.3% | 0.098 | 0.862 | 30 | 1.39 | 0.39 | 4.1 | 4.3 | 0.3 |
| 2026-07→08 | +140% / 9% | −3.3% / 15 | −2.1% | 0.098 | 0.954 | 16 | 2.37 | 0.21 | 4.1 | 4.1 | 2.0 |

Đoạn test có lãi 5/10 (hàm lãi/DD), 3/10 (hàm tổng lãi). Tham số tối ưu nhảy loạn giữa các cửa sổ (adx_min 10→45,
atr_min 0→1.08, r_atr 1.9→5.9): không có vùng tham số nào ổn định theo thời gian. Tham số hiện tại thắng WF ở 8/10 đoạn —
nhưng nó là bộ duy nhất "được xem đáp án" trước.

## 3. Độ nhạy tham số (BTC, 2020-01 → 2026-08, fastsim; baseline +67.6% / DD 12.9% / PF 1.24)

| Tham số | −20% | Lãi / DD / PF | +20% | Lãi / DD / PF |
|---|---|---|---|---|
| dc_long | 0.059 | +61.2% / 12.9% / 1.26 | 0.089 | +66.1% / 10.4% / 1.21 |
| dc_short (lệch theo khoảng cách tới 1) | 0.955 | +66.9% / 9.4% / 1.26 | 0.933 | +51.0% / 13.9% / 1.17 |
| adx_min | 24 | **+5.6% / 32.7% / 1.01** | 36 | +45.2% / 12.3% / 1.32 |
| vol_max | 0.8 | +35.6% / 9.5% / 1.22 | 1.2 | +136.7% / 13.0% / 1.31 |
| atr_min_pct | 0.32 | +67.3% / 12.3% / 1.17 | 0.48 | +39.2% / 13.9% / 1.23 |
| r_atr | 2.4 | +66.6% / 16.5% / 1.19 | 3.6 | +72.0% / 11.5% / 1.29 |
| trail_start_r | 1.6 | +110.3% / 10.4% / 1.34 | 2.4 | +76.5% / 13.7% / 1.26 |
| trail_dist_r | 0.8 | +56.0% / 13.8% / 1.20 | 1.2 | +57.2% / 13.6% / 1.21 |

Lệch đồng thời cả 8 tham số ngẫu nhiên trong ±20% (300 lần): lãi p5/p50/p95 = −9% / +28% / +83%, 88% số lần có lãi,
PF p5 0.96, DD p95 32.7%. Nhạy nhất là **adx_min**: giảm xuống 24 gần như xoá hết lãi.

### dc_long × dc_short (lãi % / PF, **đậm** = hiện tại)

| dc_short \ dc_long | 0.03 | 0.045 | 0.06 | 0.074 | 0.09 | 0.11 | 0.13 | 0.15 |
|---|---|---|---|---|---|---|---|---|
| 0.85 | −40 / 0.86 | −29 / 0.90 | −21 / 0.93 | −21 / 0.94 | −13 / 0.96 | −21 / 0.94 | −24 / 0.94 | −5 / 0.99 |
| 0.87 | −28 / 0.90 | −18 / 0.94 | −11 / 0.96 | −14 / 0.96 | +7 / 1.02 | −12 / 0.97 | −14 / 0.97 | +9 / 1.02 |
| 0.89 | −11 / 0.96 | +8 / 1.03 | +15 / 1.05 | +15 / 1.05 | +45 / 1.11 | +31 / 1.07 | +19 / 1.04 | +38 / 1.09 |
| 0.91 | +0 / 1.00 | +17 / 1.06 | +19 / 1.06 | +24 / 1.07 | +51 / 1.13 | +35 / 1.08 | +30 / 1.07 | +49 / 1.10 |
| 0.926 | +14 / 1.06 | +35 / 1.14 | +39 / 1.14 | +44 / 1.14 | +70 / 1.19 | +56 / 1.14 | +48 / 1.10 | +70 / 1.15 |
| 0.944 | +35 / 1.18 | +52 / 1.24 | +60 / 1.25 | **+68 / 1.24** | +86 / 1.26 | +77 / 1.20 | +81 / 1.18 | +97 / 1.20 |
| 0.96 | +45 / 1.29 | +64 / 1.36 | +70 / 1.35 | +78 / 1.32 | +98 / 1.32 | +81 / 1.23 | +81 / 1.19 | +88 / 1.19 |
| 0.97 | +61 / 1.47 | +83 / 1.52 | +95 / 1.52 | +103 / 1.44 | +120 / 1.40 | +101 / 1.28 | +105 / 1.23 | +115 / 1.23 |

Mặt trơn, đơn điệu theo dc_short: Short càng sát đỉnh kênh càng tốt, Long ít nhạy. Tham số hiện tại nằm trên sườn ổn định,
không phải đỉnh cô lập.

### adx_min × atr_min_pct (lãi % / PF)

| adx_min \ atr_min_pct | 0.2 | 0.25 | 0.3 | 0.35 | 0.4 | 0.45 | 0.5 | 0.6 | 0.8 |
|---|---|---|---|---|---|---|---|---|---|
| 15 | −73 / 0.90 | −56 / 0.92 | −25 / 0.97 | −20 / 0.97 | −12 / 0.98 | +6 / 1.01 | +30 / 1.08 | +4 / 1.02 | +4 / 1.06 |
| 20 | −59 / 0.91 | −51 / 0.92 | −24 / 0.96 | −22 / 0.95 | −12 / 0.97 | +2 / 1.00 | +30 / 1.10 | +12 / 1.07 | +9 / 1.13 |
| 24 | −30 / 0.95 | −16 / 0.97 | +9 / 1.02 | +7 / 1.02 | +6 / 1.01 | +7 / 1.02 | +28 / 1.12 | +5 / 1.04 | +8 / 1.15 |
| 27 | +18 / 1.03 | +36 / 1.07 | +73 / 1.15 | +71 / 1.17 | +67 / 1.19 | +39 / 1.15 | +45 / 1.24 | +19 / 1.18 | +18 / 1.46 |
| 30 | +34 / 1.07 | +52 / 1.11 | +83 / 1.20 | +73 / 1.21 | **+68 / 1.24** | +35 / 1.17 | +43 / 1.28 | +15 / 1.17 | +15 / 1.47 |
| 33 | +13 / 1.04 | +30 / 1.10 | +36 / 1.13 | +37 / 1.16 | +53 / 1.27 | +31 / 1.21 | +26 / 1.24 | +11 / 1.17 | +17 / 1.70 |
| 36 | +17 / 1.07 | +30 / 1.14 | +27 / 1.14 | +21 / 1.13 | +45 / 1.32 | +22 / 1.20 | +18 / 1.22 | −1 / 0.98 | +11 / 1.59 |
| 40 | +8 / 1.05 | +15 / 1.09 | +27 / 1.18 | +19 / 1.15 | +38 / 1.35 | +17 / 1.21 | +8 / 1.13 | +12 / 1.30 | +19 / 2.47 |
| 45 | −13 / 0.88 | −7 / 0.92 | −3 / 0.96 | −1 / 0.99 | +2 / 1.03 | −6 / 0.89 | +0 / 1.01 | +8 / 1.32 | +12 / 3.04 |

Vách đứng ở adx_min < 27 (toàn lỗ) và > 40. Vùng 27–40 × 0.3–0.5 là mặt phẳng; tham số hiện tại ở giữa.

## 4. Chi phí xấu (BTC, 2020-01 → 2026-08)

| | Tổng lãi | Max DD | PF | Lãi từng năm |
|---|---|---|---|---|
| freqtrade, phí 0.05% (baseline) | +63.1% | 12.9% | 1.22 | 2020: −1.8 · 2021: +29.2 · 2022: −3.4 · 2023: +8.7 · 2024: +4.2 · 2025: +17.6 · 2026: −0.0 |
| freqtrade, phí 0.09% (0.07% + trượt 0.02%) | **+36.6%** | 13.9% | 1.14 | 2020: −4.3 · 2021: +24.9 · 2022: −6.0 · 2023: +7.8 · 2024: +0.4 · 2025: +13.9 · 2026: −1.3 |

Lãi tổng % (PF) theo phí × trượt giá mỗi chiều (fastsim):

| Phí \ trượt | 0 | 0.02% | 0.05% | 0.10% |
|---|---|---|---|---|
| 0.020% | +88% (1.30) | +73% (1.25) | +51% (1.18) | +23% (1.09) |
| 0.035% | +74% (1.26) | +60% (1.21) | +45% (1.17) | +15% (1.06) |
| 0.050% | +68% (1.24) | +51% (1.18) | +33% (1.12) | +7% (1.03) |
| 0.070% | +51% (1.18) | +39% (1.14) | +23% (1.09) | −1% (1.00) |
| 0.100% | +33% (1.12) | +23% (1.09) | +7% (1.03) | −12% (0.95) |

Còn lãi ở 0.07% + 0.02%, nhưng mỗi 0.01%/chiều chi phí thêm lấy đi ~6–7 điểm % lãi tổng. Hòa vốn khi tổng chi phí
mỗi chiều ≈ 0.17%. Lệnh vào theo market ở nến mở sau tín hiệu nên trượt 0.02% là mức lạc quan khi biến động mạnh.

## 5. Coin khác, tham số giữ nguyên (freqtrade, phí 0.05%, 1 lệnh/lúc)

| | Tổng lãi | Max DD | PF | Số lệnh | Thắng | Lãi từng năm |
|---|---|---|---|---|---|---|
| BTC | +63.1% | 12.9% | 1.22 | 378 | 42% | 2020: −1.8 · 2021: +29.2 · 2022: −3.4 · 2023: +8.7 · 2024: +4.2 · 2025: +17.6 · 2026: −0.0 |
| ETH | +37.3% | 22.4% | 1.09 | 563 | 38% | 2020: +23.0 · 2021: −2.1 · 2022: −6.5 · 2023: −2.6 · 2024: +15.5 · 2025: −1.4 · 2026: +9.9 |
| SOL (từ 2020-09) | +50.9% | 33.6% | 1.09 | 759 | 37% | 2020: −3.8 · 2021: −26.0 · 2022: +15.8 · 2023: +35.9 · 2024: +36.3 · 2025: +3.0 · 2026: −4.0 |
| BNB (từ 2020-02) | **−52.9%** | 61.4% | 0.84 | 551 | 32% | 2020: −11.6 · 2021: +15.4 · 2022: −17.8 · 2023: −17.9 · 2024: −10.7 · 2025: −22.5 · 2026: −1.2 |

Không phải chỉ hợp BTC, nhưng ngoài BTC lợi thế gần bằng 0 (PF 1.09 với DD 22–34%) và BNB cho thấy cùng logic có thể
thua liên tục 5 năm. Chiến lược không nên mở rộng sang coin khác.

## 6. Monte Carlo (1 000 lần xáo thứ tự lệnh, lãi/lỗ từng lệnh giữ nguyên theo % vốn)

| Chuỗi lệnh | Rủi ro/lệnh | DD thực tế | DD p50 | DD p95 | DD p99 | DD tệ nhất |
|---|---|---|---|---|---|---|
| Baseline | 0.5% | | 8.4% | **13.2%** | 15.5% | 17.7% |
| Baseline | 1.0% | 12.9% | 16.3% | **24.9%** | 29.0% | 33.7% |
| Baseline | 1.5% | | 23.7% | 35.0% | 40.7% | 44.6% |
| Baseline | 2.0% | | 30.9% | 44.5% | 50.4% | 59.4% |
| Walk-forward OOS (lãi/DD) | 1.0% | 38.8% | 41.2% | 49.4% | 53.1% | 58.5% |

DD thực tế 12.9% nằm **dưới trung vị** 16.3% của phân bố: thứ tự lệnh trong quá khứ thuận lợi hơn trung bình, nên kỳ vọng
DD khi chạy thật ở 1% là 16–25%, không phải 13%.

| Chuỗi lệnh | Số lệnh | Thắng | Chuỗi thua thực tế | p50 | p95 | P(≥8) | P(≥10) | P(≥12) | P(≥15) |
|---|---|---|---|---|---|---|---|---|---|
| Baseline | 378 | 42% | 10 | 10 | 14 | 90% | 54% | 20% | 4% |
| Walk-forward OOS | 328 | 27% | 15 | 14 | 21 | 100% | 99% | 88% | 50% |

Bootstrap 12 tháng (rút có hoàn lại 57 lệnh/năm, 10 000 lần, rủi ro 1%): lãi năm p5/p50/p95 = −10.0% / +7.5% / +29.4%,
**26% xác suất một năm lỗ**, 5% lỗ hơn 10%.

## Vốn tối thiểu (bước khối lượng 0.001 BTC, lệnh tối thiểu 100 USDT, giá BTC ≈ 77 600 USDT)

1R trong 12 tháng gần nhất: trung vị 1.49% giá, p90 2.26%.

| Vốn (USDT) | Khối lượng trung vị (BTC) | Rủi ro thực tế (mục tiêu 1%) | Lệnh bị bỏ |
|---|---|---|---|
| 300 | 0.002 | 0.81% | 19% |
| 500 | 0.004 | 0.88% | 1% |
| 1 000 | 0.008 | 0.94% | 0% |
| 2 000 | 0.017 | 0.97% | 0% |
| 5 000 | 0.042 | 0.99% | 0% |

Ở rủi ro 0.5%/lệnh, các cột trên tương ứng với vốn gấp đôi (1 000 USDT ở 0.5% ≈ 500 USDT ở 1%): cần ≥ 1 000 USDT.

## Cách tái chạy

Trên GitHub: Actions → workflow **robustness** → *Run workflow* (tuỳ chọn coin, tháng bắt đầu). Kết quả ở tab Summary và
artifact `robustness` (`result.md`, `result.json`). Chạy khoảng 35 phút. Workflow cũng tự chạy khi đẩy lên nhánh
`claude/**` hay `research/**` có sửa `robustness.py`, `fastsim.py` hoặc chính workflow.

Trên máy (cần mạng tới data.binance.vision, ~4 nhân, ~2 GB RAM):

```bash
cd bot
pip install freqtrade==2026.8 numba
python research/binance_vision.py --pairs BTC ETH SOL BNB --tf 1m 15m --start 2020-01 --end 2026-08 --out data/binance
git clone --depth 1 https://github.com/ff137/bitstamp-btcusd-minute-data.git /tmp/bitstamp   # để so Bitstamp/Binance
python research/robustness.py --datadir data/binance --bitstamp /tmp/bitstamp --coins BTC ETH SOL BNB --out robustness_out
```

Chạy nhanh để thử: `--steps baseline,sens --coins BTC`, hoặc giảm `--wf-rand 500 --wf-local 200 --mc 200`.
Hạt giống ngẫu nhiên cố định (`SEED` trong `robustness.py`), nên chạy lại cho đúng số trên với cùng dữ liệu.

## Giới hạn của chính báo cáo này

- Tối ưu walk-forward dùng tìm kiếm ngẫu nhiên + tinh chỉnh (7 000 bộ/cửa sổ), không phải hyperopt của freqtrade; mục đích
  là đo *tham số tốt trong quá khứ có chuyển sang tương lai không*, không phải tìm tham số tốt nhất.
- Độ nhạy, bảng chi phí và Monte Carlo dùng fastsim (lạc quan hơn freqtrade ~4 điểm % lãi tổng).
- Trượt giá mô phỏng là tỉ lệ cố định trên giá vào/ra; thực tế trượt lớn hơn khi biến động mạnh, đúng lúc chiến lược vào lệnh.
- Monte Carlo giữ nguyên tập lệnh lịch sử, chỉ xáo thứ tự: không mô phỏng thị trường thay đổi (walk-forward mới đo điều đó).
