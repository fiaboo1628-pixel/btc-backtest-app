# Paper trading (dry-run) trên máy nhà

Chạy chiến lược của bot (TrendBreakout, `config.base.json`) bằng giá Binance Futures thật nhưng **lệnh giả, ví ảo 1000 USDT, không cần API key**.
Gồm 3 phần, chạy bằng Docker (Windows, Mac, Linux đều được):

| Dịch vụ | Cổng | Việc |
|---|---|---|
| `live` | 8080 | Bot dry-run + FreqUI (xem lệnh, lãi lỗ, biểu đồ) |
| `lab` | 8081 | freqtrade webserver cho trang Chỉnh tham số backtest |
| `hub` | 8090 | **Một trang cho tất cả**: app backtest (nến lấy từ máy chủ, tự cập nhật), tab **Live** theo dõi bot, nút **Send to bot**, trang Chỉnh tham số ở `/tune/` |

Mọi cổng chỉ mở trên `127.0.0.1` của máy. Xem từ điện thoại khi ra ngoài: dùng Tailscale (bước 5).

**Lộ trình khuyên dùng: Binance Demo → tiền thật, cùng một cấu hình, chỉ đổi key** (bước 6).
Dry-run (mặc định sau bước 4) chỉ để thử cho chạy được khi chưa có key: nó giả lập lệnh bên trong freqtrade,
không kiểm tra được lệnh stop đặt trên sàn.

## 1. Cài Docker
- Windows / Mac: cài **Docker Desktop**, mở lên một lần. Trên Windows, dùng PowerShell cho các lệnh dưới.
- Linux: cài Docker Engine + plugin compose.

## 2. Lấy code
```bash
git clone https://github.com/fiaboo1628-pixel/btc-backtest-app.git
cd btc-backtest-app/bot/deploy
```

## 3. Chuẩn bị (một lần)
```bash
docker compose run --rm setup
```
Tạo mật khẩu ngẫu nhiên, chép chiến lược cho LAB, tải nến 15m từ 2021 (vài phút).
Mật khẩu hub và FreqUI không in ra màn hình; xem bằng `docker compose run --rm setup --no-download --show-login`.
File mật khẩu/key (`secrets/`, `hub.json`) có quyền 600; setup đặt lại quyền mỗi lần chạy.

**Cảnh báo (bắt buộc trước tiền thật)**: hub canh bot mỗi phút — báo khi bot không trả lời, không xử lý nến
quá 3 phút, bị dừng, có lệnh mở mà không có stop trên sàn, hoặc log có lỗi. Nhận trên điện thoại: mở hub, tab
**Live** → **Alerts on this device** → **Turn on alerts** (iPhone: trước đó Share → Add to Home Screen và mở từ
biểu tượng đó). Một thông báo thử sẽ tới ngay.

Tuỳ chọn thêm Telegram (thông báo từng lệnh + cùng các cảnh báo trên): tạo bot với @BotFather lấy token, nhắn cho
bot một tin rồi lấy chat id (ví dụ qua @userinfobot), sau đó:
```bash
docker compose run --rm setup --no-download --telegram   # hỏi token (gõ không hiện) và chat id
docker compose restart live hub
```

## 4. Chạy
```bash
docker compose up -d
```
Mở trên chính máy đó:
- http://localhost:8080 — FreqUI, đăng nhập `ft-live` / mật khẩu ở bước 3
- http://localhost:8090 — hub (app backtest + tab Live + `/tune/`), đăng nhập `admin` / mật khẩu ở bước 3.
  Lần đầu hub tải nến BTC 1m/5m/15m từ 2021 về máy (~15–20 phút, chạy nền), sau đó tự cập nhật mỗi 2 phút.

Bot tự khởi động lại khi máy khởi động lại (miễn là Docker tự chạy). **Tắt chế độ ngủ (sleep) của máy.**

## 5. Xem từ iPhone khi ra ngoài (Tailscale)
1. Cài Tailscale trên máy nhà và trên iPhone, đăng nhập cùng một tài khoản.
2. Trên máy nhà (một lần; `sudo tailscale set --operator=$USER` để lần sau khỏi sudo):
   ```bash
   sudo tailscale serve --bg --https=443  http://127.0.0.1:8090
   sudo tailscale serve --bg --https=8443 http://127.0.0.1:8080    # FreqUI, nếu cần
   ```
3. Trên PC hoặc iPhone (bật Tailscale): mở `https://<tên-máy>.<tailnet>.ts.net` → app backtest, tab **Live**,
   `/tune/`. **Không phải nhập mật khẩu**: Tailscale đã xác thực bạn (hub đọc header `Tailscale-User-Login`;
   muốn giới hạn tài khoản thì điền `allowed_logins` trong `hub.json`). Trên iPhone: Safari → Chia sẻ →
   **Thêm vào MH chính** để dùng như app. Tên máy xem bằng `tailscale status`.
   Chỉ thiết bị trong tailnet của bạn mở được, không lộ ra internet.

## 6. Vào lệnh trên sàn bằng API (Demo → Thật)
Dry-run chỉ giả lập lệnh bên trong freqtrade. Chế độ **API** cho bot đặt lệnh thật lên Binance, thấy lệnh,
vị thế, SL ngay trong app Binance. **Demo và tiền thật dùng chung một cấu hình, chỉ khác bộ key**: chạy Demo
cho quen, khi muốn lên tiền thật chỉ cần nhập lại key thật.

1. Trong tài khoản (Demo Trading hoặc thật), Futures USDⓈ-M: đặt **One-way mode** (không dùng Hedge mode).
2. Tạo API key trong **API Management** của đúng tài khoản đó.
   Với key thật: chỉ bật **Futures**, **không bật rút tiền**, giới hạn IP của máy nhà.
3. Trên máy nhà:
   ```bash
   docker compose run --rm setup --api     # chọn [d] Demo hoặc [t] Thật, nhập key + secret (gõ không hiện)
   docker compose up -d
   ```
   - **Vốn tối đa** bot được dùng (ví dụ 300 USDT): Demo bỏ trống được (= toàn bộ số dư futures);
     tiền thật bắt buộc, phải là số dương và không quá số USDT trong ví futures.
   - Chọn Thật: phải có kênh cảnh báo trước (điện thoại hoặc Telegram), gõ chữ `REAL` để xác nhận, và setup hỏi Binance quyền của key —
     key bật rút tiền hoặc chưa bật Futures thì từ chối; chưa giới hạn IP thì phải gõ `KHONG IP` mới cho qua.
   - Mỗi loại tài khoản có lịch sử lệnh riêng: `user_data/demo.sqlite`, `user_data/real.sqlite`.
4. Quay về dry-run: `docker compose run --rm setup --dryrun` rồi `docker compose up -d`.

### Kiểm tra tự động (1 lệnh, ~30 giây)
Sau khi nhập key Demo, chạy thử cả chuỗi đặt lệnh bằng đúng code của bot — vào lệnh ~110 USDT, đặt stop trên sàn,
dời stop, đóng lệnh, dọn sạch:
```bash
docker compose stop live          # tạm dừng bot để không đụng lệnh thử
docker compose run --rm check     # in BÁO CÁO cuối cùng: dán phần đó khi cần hỗ trợ (không chứa key)
docker compose start live
```
Chỉ chạy với key Demo (key thật: script từ chối). Mọi bước ✅ thì chạy bot; có ❌ thì gửi báo cáo để sửa.

### Kiểm tra trên Demo trước khi lên tiền thật
Lệnh đầu tiên có thể mất vài ngày (trung bình ~6 lệnh/tháng). Khi có lệnh, mở app Binance (tài khoản Demo):
- [ ] Vị thế mở đúng chiều, khối lượng ≈ rủi ro 1% vốn (lỗ khi chạm stop ban đầu ≈ 1% số dư).
- [ ] Tab **Lệnh mở (Open Orders)** có lệnh **Stop Market** reduce-only ngay sau khi vào lệnh
      (stop nằm trên sàn — `stoploss_on_exchange`).
- [ ] Khi lãi ≥ 2R, lệnh stop được **dời lên** (mỗi ≤ 60 s).
- [ ] Tắt bot khi đang có lệnh (`docker compose stop live`): lệnh stop **vẫn còn** trên sàn. Bật lại: bot nhận lại vị thế.
- [ ] Log không có lỗi đặt lệnh: `docker compose logs live | grep -iE "error|exception"`.
- [ ] Sau 1–2 tháng: backtest trong app đúng khoảng thời gian đó (nến 1m) và so từng lệnh: giờ vào, chiều, giá thoát.

Đạt hết thì lên tiền thật: **đóng hết vị thế đang mở** của bot demo (FreqUI → Force exit), rồi
`docker compose run --rm setup --api` chọn `t`, đặt vốn tối đa nhỏ, `docker compose up -d`.

Lưu ý: freqtrade **chưa hỗ trợ chính thức** Demo Trading cho Binance; bộ này bật nó bằng tuỳ chọn
`_ft_has_params` trong `config.exchange.json` (không ảnh hưởng khi dùng key thật). Nếu log báo lỗi lúc khởi
động hoặc lúc đặt lệnh (đòn bẩy, margin), quay về dry-run và gửi log để sửa. Trang Chỉnh tham số "Áp dụng"
sẽ đổi tham số của bot đang chạy (demo hoặc thật).

## Chạy thử trên GitHub Codespaces (không cần máy nhà)
Codespaces là máy ảo của GitHub, mở được từ trình duyệt điện thoại. Hợp để **thử cho chạy được**,
không hợp để chạy lâu dài: máy tự tắt khi không dùng (mặc định 30 phút, tối đa 4 giờ) và bot dừng theo.
Tài khoản miễn phí có khoảng 60 giờ/tháng với máy 2 nhân.

1. **Chọn region châu Á trước** (Binance chặn IP Mỹ): github.com/settings/codespaces →
   *Region* → **Southeast Asia**. Cùng trang đó, *Default idle timeout* có thể tăng lên 240 phút.
2. Mở repo trên GitHub → nút **Code** → tab **Codespaces** → **Create codespace on main**.
   **Không cần gõ lệnh**: codespace tự cài Docker, tạo mật khẩu và bật bot dry-run (2–3 phút).
3. Mở file **`bot/deploy/BOT_LOGIN.md`** (tự mở sẵn; nếu thấy "đang cài" thì đợi rồi mở lại
   từ cây thư mục bên trái). File ghi: kết nối Binance OK hay bị chặn, và 2 mật khẩu đăng nhập.
4. Tab **Ports**: dòng **8080** (FreqUI) hoặc **8090** (hub: app + Live + Chỉnh tham số) → bấm biểu tượng quả địa cầu.
   Link chỉ tài khoản GitHub của bạn mở được (để Private, đừng đổi sang Public).
5. **Chạy trên Binance Demo không cần gõ phím** (hợp khi dùng điện thoại): key Demo đặt trong *Codespaces secrets*.
   - github.com/settings/codespaces → **Codespaces secrets** → **New secret**, tạo 2 secret, chọn repo này ở
     *Repository access*: `BINANCE_DEMO_KEY` = API Key, `BINANCE_DEMO_SECRET` = Secret Key
     (tuỳ chọn `BINANCE_DEMO_CAPITAL` = vốn tối đa, USDT).
   - Tạo codespace mới (hoặc **Stop** rồi mở lại codespace đang có): bot tự chuyển sang Demo, tự chạy kiểm tra
     đặt lệnh một lần và ghi kết quả vào **`bot/deploy/DEMO_CHECK.md`** — mở file đó, gửi khung báo cáo khi cần hỗ trợ.
   - Đổi key: sửa secret rồi mở lại codespace (kiểm tra tự chạy lại với key mới). Chỉ dùng cho key **Demo**.
   - Có bàn phím thì vẫn dùng được cách cũ: `cd bot/deploy`, `docker compose run --rm setup --api` (chọn `d`),
     `docker compose up -d`.
6. Xong thì **Stop codespace** (menu ☰ → Codespaces) để không tốn giờ miễn phí. Mở lại thì bot tự bật lại
   ; xoá codespace thì mất dữ liệu và mật khẩu (tạo lại sẽ tự cài lại).

Không nhập key tài khoản thật trên Codespaces.

## Máy nhà chạy Arch Linux
Xem `server/README.md`: script dựng server 1 lệnh (docker, tailscale, chặn ngủ, watchdog Tailscale).

## Lệnh hay dùng
```bash
docker compose ps                    # trạng thái
docker compose logs -f live          # log bot dry-run
docker compose restart live          # khởi động lại bot
docker compose down                  # dừng tất cả
git pull && docker compose up -d     # cập nhật code (freqtrade giữ nguyên phiên bản ghim)
```

Nâng cấp freqtrade: đổi tag `image:` trong `docker-compose.yml`, chạy trên **Demo** trước
(`docker compose up -d` rồi `docker compose run --rm check`), đạt hết mới chuyển sang tiền thật.

## Khác gì so với backtest
- Vào/ra lệnh bằng **lệnh market** ngay khi nến tín hiệu đóng (backtest vào ở giá mở nến sau — gần như nhau).
- Phí thật là **phí taker 0.05%/chiều** (app backtest đã mặc định mức này). Trượt giá khi stop khớp không có trong
  backtest: ước tính làm lãi giảm thêm ~15–25% (xem README gốc, mục "Backtest so với live"). Funding tính theo mức thật.
- Chiến lược trung bình ~6–7 lệnh/tháng: chạy ít nhất 1–2 tháng rồi hẵng đánh giá. Nên so từng lệnh với
  backtest cùng khoảng thời gian (giá vào, SL, lúc kích hoạt trailing) hơn là chỉ nhìn lãi/lỗ.

## Ghi chú
- `secrets/`, `hub.json`, `.env` chứa mật khẩu/key, đã có trong `.gitignore`. Không chia sẻ.
- Dữ liệu lệnh dry-run nằm ở `../user_data/dryrun.sqlite`; xoá file này để làm lại từ đầu với ví 1000 USDT.
- Linux báo lỗi quyền ghi: `sudo chown -R 1000:1000 ../user_data .`
- Mạng chặn Binance (lỗi 451/403 trong log): thử mạng khác hoặc VPN; không dùng máy chủ đặt ở Mỹ.
- Nên chạy Demo ít nhất 1–2 tháng (qua hết checklist ở bước 6) trước khi dùng key thật, và bắt đầu với vốn nhỏ.
