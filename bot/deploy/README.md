# Paper trading (dry-run) trên máy nhà

Chạy DonchianRevert bằng giá Binance Futures thật nhưng **lệnh giả, ví ảo 1000 USDT, không cần API key**.
Gồm 3 phần, chạy bằng Docker (Windows, Mac, Linux đều được):

| Dịch vụ | Cổng | Việc |
|---|---|---|
| `live` | 8080 | Bot dry-run + FreqUI (xem lệnh, lãi lỗ, biểu đồ) |
| `lab` | 8081 | freqtrade webserver cho trang Chỉnh tham số backtest |
| `tuner` | 8090 | Trang "Chỉnh tham số": backtest thử, áp dụng tham số cho bot dry-run |

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
**Ghi lại 2 dòng mật khẩu in ra** (quên thì chạy lại `docker compose run --rm setup --no-download`).

Muốn nhận thông báo lệnh qua Telegram: tạo bot với @BotFather lấy token, nhắn cho bot một tin rồi
lấy chat id (ví dụ qua @userinfobot), sau đó:
```bash
docker compose run --rm setup --no-download --telegram <token> <chat_id>
```

## 4. Chạy
```bash
docker compose up -d
```
Mở trên chính máy đó:
- http://localhost:8080 — FreqUI, đăng nhập `ft-live` / mật khẩu ở bước 3
- http://localhost:8090 — trang Chỉnh tham số, đăng nhập `admin` / mật khẩu ở bước 3

Bot tự khởi động lại khi máy khởi động lại (miễn là Docker tự chạy). **Tắt chế độ ngủ (sleep) của máy.**

## 5. Xem từ iPhone khi ra ngoài (Tailscale)
1. Cài Tailscale trên máy nhà và trên iPhone, đăng nhập cùng một tài khoản.
2. Trên máy nhà:
   ```bash
   tailscale serve --bg --https=443  http://127.0.0.1:8090
   tailscale serve --bg --https=8443 http://127.0.0.1:8080
   ```
3. Trên iPhone (bật Tailscale): mở `https://<tên-máy>.<tailnet>.ts.net` (trang Chỉnh tham số) và
   `https://<tên-máy>.<tailnet>.ts.net:8443` (FreqUI). Tên chính xác xem bằng `tailscale status`
   hoặc trong app Tailscale. Chỉ thiết bị trong tailnet của bạn mở được, không lộ ra internet.

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
   - Có thể đặt **vốn tối đa** bot được dùng (ví dụ 300 USDT); bỏ trống = toàn bộ số dư futures.
   - Chọn Thật phải gõ chữ `REAL` để xác nhận.
   - Mỗi loại tài khoản có lịch sử lệnh riêng: `user_data/demo.sqlite`, `user_data/real.sqlite`.
4. Quay về dry-run: `docker compose run --rm setup --dryrun` rồi `docker compose up -d`.

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
4. Tab **Ports**: dòng **8080** (FreqUI) hoặc **8090** (Chỉnh tham số) → bấm biểu tượng quả địa cầu.
   Link chỉ tài khoản GitHub của bạn mở được (để Private, đừng đổi sang Public).
5. Muốn thử lệnh trên Binance Demo: `cd bot/deploy`, `docker compose run --rm setup --api` (chọn `d`) rồi `docker compose up -d`.
6. Xong thì **Stop codespace** (menu ☰ → Codespaces) để không tốn giờ miễn phí. Mở lại thì bot tự bật lại
   ; xoá codespace thì mất dữ liệu và mật khẩu (tạo lại sẽ tự cài lại).

Không nhập key tài khoản thật trên Codespaces.

## Lệnh hay dùng
```bash
docker compose ps                    # trạng thái
docker compose logs -f live          # log bot dry-run
docker compose restart live          # khởi động lại bot
docker compose down                  # dừng tất cả
git pull && docker compose pull && docker compose up -d   # cập nhật code + freqtrade
```

## Khác gì so với backtest
- Vào/ra lệnh bằng **lệnh market** ngay khi nến tín hiệu đóng (backtest vào ở giá mở nến sau — gần như nhau).
- Phí thật là **phí taker 0.05%/chiều** (app backtest đã mặc định mức này). Trượt giá khi stop khớp không có trong
  backtest: ước tính làm lãi giảm thêm ~15–25% (xem README gốc, mục "Backtest so với live"). Funding tính theo mức thật.
- Chiến lược trung bình ~6–7 lệnh/tháng: chạy ít nhất 1–2 tháng rồi hẵng đánh giá. Nên so từng lệnh với
  backtest cùng khoảng thời gian (giá vào, SL, lúc kích hoạt trailing) hơn là chỉ nhìn lãi/lỗ.

## Ghi chú
- `secrets/`, `tuner.json`, `.env` chứa mật khẩu/key, đã có trong `.gitignore`. Không chia sẻ.
- Dữ liệu lệnh dry-run nằm ở `../user_data/dryrun.sqlite`; xoá file này để làm lại từ đầu với ví 1000 USDT.
- Linux báo lỗi quyền ghi: `sudo chown -R 1000:1000 ../user_data .`
- Mạng chặn Binance (lỗi 451/403 trong log): thử mạng khác hoặc VPN; không dùng máy chủ đặt ở Mỹ.
- Nên chạy Demo ít nhất 1–2 tháng (qua hết checklist ở bước 6) trước khi dùng key thật, và bắt đầu với vốn nhỏ.
