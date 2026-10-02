# Backtest BTC — web app chạy trên điện thoại

Backtest chiến lược crypto ngay trên trình duyệt, không cần server:

- **Dữ liệu**: tải nến + funding thật từ API công khai Binance (Futures USDT-M hoặc Spot, không cần
  tài khoản), lưu trong máy (IndexedDB), bấm "Cập nhật" chỉ tải phần mới; nhập/xuất CSV.
- **Nhiều khung thời gian**: tải một khung gốc (1m / 5m / 15m / 1h), các khung lớn hơn
  (15m, 30m, 1h, 2h, 4h, 1d) được ghép tự động. Một điều kiện có thể dùng khung lớn hơn khung giao dịch
  (ví dụ vào lệnh 15m, lọc bằng ADX nến 1h) — chỉ dùng nến khung lớn **đã đóng**.
- **Lắp ghép chiến lược**: 21 chỉ báo (Donchian, Bollinger %B, Williams %R, RSI, Stochastic, CCI, MFI,
  ROC, ADX, ±DI, khoảng cách/độ dốc EMA, MACD, ATR %, ATR so với nền, độ rộng Bollinger, biên độ nến,
  khối lượng, **Market Structure Break & Order Block** — xu hướng MSB, vị trí giá trong vùng Bu-OB/Be-OB). Mỗi điều kiện: `chỉ báo(tham số) [khung] ≤ ≥ < > cắt lên/cắt xuống ngưỡng`,
  các điều kiện nối bằng **VÀ**, Long và Short riêng.
- **Thoát lệnh theo R**: 1R = k × ATR(14) nến tín hiệu; lãi chạm mốc thì stoploss bám đỉnh/đáy;
  giới hạn thời gian giữ lệnh; hoặc thoát theo kênh Donchian (TrendBreakout). Khối lượng theo % vốn rủi ro,
  có trần đòn bẩy (hoặc đòn bẩy cố định như bot); phí + funding thật.
- **Nhiều coin chung tài khoản** (khung "Portfolio" trong Results): chạy cùng một chiến lược trên nhiều coin
  (mặc định 5 coin của bot: BTC ETH SOL XRP DOGE), vốn chung — khối lượng theo % rủi ro của vốn hiện tại,
  tối đa N lệnh mở (1 lệnh/coin), tín hiệu cùng nến xử lý theo thứ tự freqtrade (coin đang có lệnh trước,
  rồi theo whitelist), tùy chọn tự dừng vào lệnh mới khi sụt vốn > 15% như bot. Kết quả chung + bảng theo coin.
- **Send to bot**: đọc chiến lược bot đang chạy từ Hub (`/api/tune/schema`), đổi chiến lược trong app sang
  tham số bot theo đúng khuôn (TrendBreakout hoặc DonchianRevert) và ngược lại; báo lỗi rõ khi không khớp khuôn.
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

Chế độ nhiều coin chung tài khoản đối chiếu với freqtrade chạy TrendBreakout như bot (5 coin BTC ETH SOL XRP DOGE,
nến 4h, max_open_trades 5, rủi ro 0.25 %, đòn bẩy cố định 5, 09/2025 → 08/2026):

| | freqtrade | web app |
|---|---|---|
| Số lệnh | 241 | 241 — trùng coin, chiều, giờ vào, giờ ra, giá, khối lượng, đòn bẩy **từng lệnh** |
| Lợi nhuận | +21,65 % | +21,65 % |
| Sụt vốn lớn nhất | 10,46 % | 10,46 % |
| Chênh lãi/lỗ lớn nhất 1 lệnh | | < 1e-8 USDT |

Các chỉ báo khớp TA-Lib tới sai số 1e-6 (`tests/indicators.test.mjs`).

## Chạy

Mở `index.html` qua một web server bất kỳ (GitHub Pages, hoặc `python3 -m http.server`).
Không có bước build, không phụ thuộc thư viện ngoài.

Test: `npm test` (Node 22+). `tests/parity.test.mjs` so bộ máy với freqtrade 2026.8 từng lệnh
(DonchianRevert, nến 1m detail, 02–03/2026; fixture `tests/fixtures/parity_donchian_1m.json.gz`,
tạo lại bằng `tools/export_parity.py`). `tests/parity_trend.test.mjs` so chế độ nhiều coin với freqtrade
(TrendBreakout 5 coin, nến 4h, 09/2025 → 08/2026; fixture `tests/fixtures/parity_trend_4h.json.gz`, tạo lại bằng
workflow `parity-trend` trên GitHub Actions — tải nến từ data.binance.vision, chạy freqtrade, commit fixture lên nhánh).

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
js/engine.js                 bộ máy backtest futures (sổ lệnh chung + bộ chạy từng coin)
js/portfolio.js              nhiều coin chung tài khoản theo thứ tự freqtrade; bước giá/khối lượng từng coin
js/botparams.js              đổi chiến lược app ↔ tham số bot (khuôn TrendBreakout, DonchianRevert)
js/worker.js                 chạy backtest ở luồng riêng (một coin hoặc nhiều coin)
js/replay.js                 xem lại lệnh kiểu MT5 (vendor/lightweight-charts.js, tải khi mở)
api/binance.js               proxy Binance trên Vercel (khi trình duyệt bị chặn)
presets/                     chiến lược mẫu
sw.js, manifest.webmanifest  PWA
bot/                         bot freqtrade TrendBreakout 4h 5 coin + nghiên cứu (không deploy lên Vercel)
.devcontainer/               Codespaces: tự bật bot dry-run trong bot/deploy
```

## Tiến độ dự án (cập nhật 09/2026)

Repo này gom toàn bộ dự án. Trước đây bot nằm ở repo `bot_trade` (và bản cũ hơn ở
`sat-hach-trainer/trading/`); cả hai đã chuyển hết về `bot/` ở đây.

### Đã xong
| Phần | Trạng thái |
|---|---|
| **App backtest** (thư mục gốc, Vercel) | Chạy ổn trên iPhone. Engine khớp freqtrade từng lệnh; khớp lệnh chính xác bằng nến 1m (`detail`); chốt lời theo R; giao diện kết quả mới; **Replay** xem lại từng lệnh như MT5 |
| **Bot** (`bot/`) | Chiến lược TrendBreakout 4h 5 coin (trước là DonchianRevert BTC M15) + bộ Docker: dry-run → Binance Demo → tiền thật, chỉ đổi API key (`setup --api`). **Hub** (`bot/hub`): một trang trên máy chủ nhà qua Tailscale — app backtest với nến có sẵn trên máy chủ, tab **Live** theo dõi bot, nút **Send to bot**, Chỉnh tham số ở `/tune/`. Codespaces tự bật bot |
| **Nghiên cứu** (`bot/research/`) | Xem bên dưới |

### Kết luận nghiên cứu
- **Chỉ DonchianRevert trên BTC 15m có lợi thế.** Nhiều coin, vàng, scalp khung nhỏ, các chỉ báo khác: đều thua.
- Thiết lập khuyên dùng: **stop 3 ATR, trailing từ +2R, cách đỉnh 1.0R, rủi ro 0.5%/lệnh** (tối đa x5).
  Binance BTCUSDT perpetual 01/2020 → 08/2026, nến 1m, rủi ro 1%: +63%, ~7.6%/năm, DD 12.9%, PF 1.22, 2/7 năm lỗ.
  Walk-forward thất bại (`bot/research/robustness_2026-10.md`): chưa nên chạy tiền thật ở mức vốn có ý nghĩa.
- **ML lọc lệnh (meta-labeling) không giúp** (`bot/research/meta_label.py`, walk-forward ngoài mẫu 2022 → 2026):
  gốc +55% DD 14.6%; LightGBM giữ 70% +47% DD 12.4%, không hơn lọc ngẫu nhiên có ý nghĩa.
  Nới điều kiện vào lệnh để có nhiều lệnh hơn: −53%, ML lọc lại chỉ về +4%. → giữ nguyên bộ lọc hiện tại.
- **Backtest so với live** (`cost-check`, nến 1m): phí taker 0.05% cả 2 chiều (bot vào/ra bằng lệnh market)
  và trượt giá 0.015–0.03%/chiều kéo lãi 01/2021 → 08/2026 từ +74% xuống khoảng +50–57% (PF 1.29 → 1.20–1.23).
  App giờ mặc định phí 0.05%. Kỳ vọng live thực tế: khoảng 6–8%/năm, sụt vốn 15–20%.
- LLM: không dùng để ra lệnh (không backtest trung thực được). Nếu thử thì chỉ làm bộ **chặn lệnh** theo tin
  tức trong `confirm_trade_entry`, kiểm chứng bằng 2 bot dry-run song song vài tháng.

### Việc còn để sau
- Chạy bot trên **Binance Demo** 1–2 tháng (máy nhà; Codespaces chỉ để thử), qua checklist trong `bot/deploy/README.md`
  bước 6, rồi mới đổi sang key thật — cùng một cấu hình.
- Nếu muốn nghiên cứu tiếp: thêm dữ liệu mới ngoài nến giá (funding, open interest, long/short ratio, lịch tin).
- Repo `bot_trade` giờ là bản trùng, có thể archive.

### Lưu ý an toàn
- Stop nằm trên sàn (`stoploss_on_exchange` trong `bot/deploy/config.live.json`, dời theo trailing mỗi 60 s): bot
  hay máy tắt giữa chừng thì lệnh vẫn có stop.
- Không bao giờ dán API key vào chat hay commit. Key chỉ nhập qua `docker compose run --rm setup --api`
  (lưu ở `bot/deploy/secrets/`, đã gitignore).
- Key thật: chỉ bật Futures, **tắt rút tiền**, giới hạn IP. Không dùng key thật trên Codespaces.
