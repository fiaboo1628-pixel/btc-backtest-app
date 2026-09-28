"""
Chuẩn bị lần đầu cho bộ dry-run. Chạy trong container (không cần cài Python trên máy):

    docker compose run --rm setup                       # tạo mật khẩu + tải dữ liệu nến
    docker compose run --rm setup --telegram <token> <chat_id>
    docker compose run --rm setup --no-download         # chỉ tạo mật khẩu

Việc làm:
  - secrets/live.json, secrets/lab.json, secrets/paper.json: user/mật khẩu API ngẫu nhiên cho bot, LAB, bot paper
  - hub.json: cấu hình hub — app backtest, tab Live, Chỉnh tham số, nến trên máy chủ (thay cho tuner.json cũ)
  - chép chiến lược sang user_data/strategies_lab/ cho LAB
  - tải nến 15m BTC/USDT:USDT futures từ 2021 (kèm funding) để LAB backtest được
  - --api: cho bot vào lệnh thật trên sàn bằng API key (hỏi Demo hay Thật; key không hiện lên màn hình).
    Demo và tiền thật chạy cùng một cấu hình, chỉ khác bộ key: lên tiền thật = chạy lại --api với key thật.
  - --dryrun: quay về dry-run (lệnh giả trong freqtrade, không cần key)
  - --demo-from-env: như --api chọn Demo, nhưng key lấy từ BINANCE_DEMO_KEY / BINANCE_DEMO_SECRET
    (Codespaces secrets — không phải gõ phím)
Chạy lại an toàn: file đã có thì giữ nguyên, trừ khi thêm --telegram.
"""
import argparse
import getpass
import json
import os
import secrets
import shutil
import sqlite3
import subprocess
from pathlib import Path

DEPLOY = Path(__file__).resolve().parent
USER_DATA = Path("/freqtrade/user_data")
SECRETS = DEPLOY / "secrets"


def rand(n: int = 24) -> str:
    return secrets.token_urlsafe(n)


def api_creds(user: str) -> dict:
    return {"api_server": {"username": user, "password": rand(), "jwt_secret_key": rand(32),
                           "ws_token": rand()}}


def write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


HUB_DATASETS = [{"market": "futures", "symbol": "BTCUSDT", "tf": tf, "from": "2021-01-01"} for tf in ("1m", "5m", "15m")]


def write_hub(creds: dict) -> dict:
    """Tạo hub.json (hoặc nâng cấp tuner.json cũ); giữ mật khẩu đã có, chỉ thêm phần còn thiếu."""
    hub, old = DEPLOY / "hub.json", DEPLOY / "tuner.json"
    src = hub if hub.exists() else old if old.exists() else None
    cfg = json.loads(src.read_text(encoding="utf-8")) if src else {}
    h = cfg.setdefault("hub", cfg.pop("tuner", {}))
    h.setdefault("host", "0.0.0.0")
    h.setdefault("port", 8090)
    h.setdefault("username", "admin")
    h.setdefault("password", rand(12))
    h.setdefault("trust_tailscale", True)             # qua `tailscale serve`: Tailscale đã xác thực, khỏi mật khẩu
    h.setdefault("allowed_logins", [])
    cfg.setdefault("strategy", "DonchianRevert")
    cfg.setdefault("app_dir", "/app")
    cfg.setdefault("exchange_file", "/deploy/secrets/exchange.json")
    cfg.setdefault("data", {"dir": str(USER_DATA / "hub_data"), "update_every_s": 120, "datasets": HUB_DATASETS})
    cfg.setdefault("lab", {"api_url": "http://lab:8081", **_login(creds["lab"]),
                           "strategy_dir": str(USER_DATA / "strategies_lab")})
    cfg.setdefault("live", {"api_url": "http://live:8080", **_login(creds["live"]),
                            "strategy_dir": str(USER_DATA / "strategies")})
    write_json(hub, cfg)
    if src == old:
        old.unlink()
        print("Chuyển tuner.json → hub.json")
    return cfg


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-download", action="store_true", help="bỏ qua tải dữ liệu nến")
    ap.add_argument("--telegram", nargs=2, metavar=("TOKEN", "CHAT_ID"), help="bật thông báo Telegram")
    ap.add_argument("--timerange", default="20210101-", help="khoảng dữ liệu cho LAB")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--api", action="store_true", help="vào lệnh trên sàn bằng API key (Demo hoặc Thật)")
    mode.add_argument("--dryrun", action="store_true", help="quay về dry-run")
    mode.add_argument("--demo-from-env", action="store_true",
                      help="key Demo lấy từ biến môi trường BINANCE_DEMO_KEY / BINANCE_DEMO_SECRET (Codespaces secrets)")
    args = ap.parse_args()
    if args.api or args.dryrun or args.demo_from_env:
        args.no_download = True

    SECRETS.mkdir(exist_ok=True)
    creds = {}
    for side in ("live", "lab", "paper"):
        f = SECRETS / f"{side}.json"
        if not f.exists():
            write_json(f, api_creds(f"ft-{side}"))
            print(f"Tạo {f.relative_to(DEPLOY)}")
        creds[side] = json.loads(f.read_text(encoding="utf-8"))

    if args.telegram:
        token, chat = args.telegram
        creds["live"]["telegram"] = {"enabled": True, "token": token, "chat_id": chat}
        write_json(SECRETS / "live.json", creds["live"])
        print("Bật Telegram cho bot dry-run")

    if args.api or args.demo_from_env or args.dryrun:
        guard_open_trades(interactive=not args.demo_from_env)
    if args.api:
        set_api()
    elif args.demo_from_env:
        set_demo_from_env()
    elif args.dryrun:
        (DEPLOY / ".env").unlink(missing_ok=True)
        print("Đã chuyển về dry-run. Chạy: docker compose up -d")
        return

    t = write_hub(creds)["hub"]
    print(f"\nĐăng nhập hub (app + Live + Chỉnh tham số) khi không đi qua Tailscale:  {t['username']} / {t['password']}")
    live = creds["live"]["api_server"]
    print(f"Đăng nhập FreqUI (bot dry-run): {live['username']} / {live['password']}")
    print("(Xem lại bất cứ lúc nào: chạy lại lệnh setup với --no-download)")

    lab_dir = USER_DATA / "strategies_lab"
    lab_dir.mkdir(parents=True, exist_ok=True)
    src = USER_DATA / "strategies" / "DonchianRevert.py"
    dst = lab_dir / "DonchianRevert.py"
    if not dst.exists() or dst.read_bytes() != src.read_bytes():
        shutil.copy2(src, dst)
        print(f"Chép chiến lược sang {dst}")

    if not args.no_download:
        print("\nTải dữ liệu nến (vài phút)…")
        subprocess.run([
            "freqtrade", "download-data", "--userdir", str(USER_DATA),
            "-c", str(DEPLOY / "config.base.json"), "-c", str(DEPLOY / "config.lab.json"),
            "-c", str(SECRETS / "lab.json"),
            "--timerange", args.timerange, "--timeframes", "15m",
        ], check=True)
    print("\nXong. Tiếp theo: docker compose up -d")


def current_db() -> str:
    """BOT_DB bot đang dùng theo .env (không có .env = dry-run)."""
    env = DEPLOY / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith("BOT_DB="):
                return line.split("=", 1)[1].strip()
    return "dryrun"


def open_trades(db: str) -> list[tuple]:
    f = USER_DATA / f"{db}.sqlite"
    if not f.exists():
        return []
    con = sqlite3.connect(f"file:{f}?mode=ro", uri=True)
    try:
        return con.execute("SELECT id, pair, is_short, open_date FROM trades WHERE is_open = 1").fetchall()
    except sqlite3.Error:
        return []
    finally:
        con.close()


def guard_open_trades(interactive: bool) -> None:
    """Đổi chế độ/tài khoản khi bot đang có lệnh trên sàn thì bot mới mở DB khác và không còn quản lý lệnh đó
    (không dời trailing, không chốt lời; chỉ còn lệnh stop cũ trên sàn). Chặn lại, trừ khi gõ xác nhận."""
    db = current_db()
    if db == "dryrun":
        return                                             # lệnh giả, không có gì trên sàn
    trades = open_trades(db)
    if not trades:
        return
    print(f"\n!! Bot ({db}) đang có {len(trades)} lệnh mở trên sàn:")
    for tid, pair, short, opened in trades:
        print(f"   #{tid} {pair} {'Short' if short else 'Long'} từ {opened}")
    print("Đổi chế độ bây giờ thì bot sẽ KHÔNG còn quản lý các lệnh này (không dời trailing stop, không chốt lời).\n"
          "Nên đóng lệnh trong FreqUI / tab Live trước (forceexit), rồi chạy lại.")
    if not interactive or input('Vẫn đổi? Gõ đúng chữ BO LENH để tiếp tục: ').strip() != "BO LENH":
        raise SystemExit("Huỷ, không đổi gì.")


def ask(prompt: str, choices: dict[str, str]) -> str:
    while True:
        a = input(prompt).strip().lower()
        if a in choices:
            return choices[a]


def set_api() -> None:
    """Lưu key vào secrets/exchange.json và bật overlay config.exchange.json qua file .env của compose.
    Demo/Thật chỉ khác cờ demo_trading + bộ key; mỗi tài khoản dùng file lịch sử lệnh riêng."""
    kind = ask("Key của tài khoản nào? [d] Demo / [t] Thật: ", {"d": "demo", "t": "real"})
    if kind == "real":
        print("\nTIỀN THẬT. Key phải: chỉ bật Futures, KHÔNG bật rút tiền, giới hạn IP của máy này.")
        if input('Gõ đúng chữ REAL để tiếp tục: ').strip() != "REAL":
            raise SystemExit("Huỷ, không đổi gì.")
    else:
        print("Key lấy trong tài khoản Demo Trading → API Management.")
    key = getpass.getpass("API Key: ").strip()
    secret = getpass.getpass("Secret Key: ").strip()
    if not key or not secret:
        raise SystemExit("Thiếu key/secret, không đổi gì.")
    cap = input("Vốn tối đa bot được dùng, USDT (Enter = toàn bộ số dư futures): ").strip()
    write_exchange(kind, key, secret, cap)


def set_demo_from_env() -> None:
    """Không cần gõ phím: key Demo lấy từ Codespaces secrets (hoặc biến môi trường). Chỉ cho Demo."""
    key = os.environ.get("BINANCE_DEMO_KEY", "").strip()
    secret = os.environ.get("BINANCE_DEMO_SECRET", "").strip()
    if not key or not secret:
        raise SystemExit("Thiếu BINANCE_DEMO_KEY / BINANCE_DEMO_SECRET, không đổi gì.")
    write_exchange("demo", key, secret, os.environ.get("BINANCE_DEMO_CAPITAL", "").strip())


def write_exchange(kind: str, key: str, secret: str, cap: str = "") -> None:
    conf: dict = {"bot_name": f"DonchianRevert-{kind}",
                  "exchange": {"key": key, "secret": secret, "demo_trading": kind == "demo"}}
    if cap:
        conf["available_capital"] = float(cap)
    SECRETS.mkdir(exist_ok=True)
    write_json(SECRETS / "exchange.json", conf)
    (DEPLOY / ".env").write_text(
        "# Bật bởi setup.py --api; xoá file này (hoặc setup.py --dryrun) để quay về dry-run\n"
        "BOT_EXTRA_CONFIG=-c /deploy/config.exchange.json -c /deploy/secrets/exchange.json\n"
        f"BOT_DB={kind}\n", encoding="utf-8")
    print(f"Đã bật chế độ API ({'Demo' if kind == 'demo' else 'TIỀN THẬT'}). Chạy: docker compose up -d")


def _login(c: dict) -> dict:
    return {"username": c["api_server"]["username"], "password": c["api_server"]["password"]}


if __name__ == "__main__":
    main()
