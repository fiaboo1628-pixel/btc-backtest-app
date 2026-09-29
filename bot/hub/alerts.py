"""
Canh bot live, báo khi có sự cố (thông báo đẩy tới điện thoại đã bật Alerts ở tab Live — push.py — và/hoặc Telegram) — để bot chết hay mất stop không nằm im tới lúc có người mở app.

Mỗi phút hỏi API của bot (chỉ đọc) và báo khi:
  - bot không trả lời, hoặc không xử lý nến (last_process quá 3 phút), hoặc không ở trạng thái running
  - có lệnh mở mà không có stop trên sàn (Demo/tiền thật; dry-run không có lệnh trên sàn)
  - log có dòng ERROR/CRITICAL mới
Báo một lần khi sự cố bắt đầu và một lần khi hết, không lặp lại mỗi phút.

Telegram (tuỳ chọn): hub.json "alerts": {"telegram_token": "...", "chat_id": "..."} — `setup --no-download --telegram`.
Chưa có kênh nào thì vẫn canh và ghi log, nhưng không gửi được đi đâu (tab Live báo thiếu cảnh báo).
"""
import asyncio
import logging
import time
from typing import Awaitable, Callable

import httpx

from tune import FtClient

log = logging.getLogger("hub.alerts")

EVERY_S = 60
STALE_S = 180                   # bot xử lý mỗi ~5 s; quá 3 phút là kẹt
DOWN_AFTER = 3                  # 3 lần hỏi hỏng liền (~3 phút) mới báo, tránh báo nhầm lúc bot restart


def telegram_sender(token: str, chat_id: str) -> Callable[[str], Awaitable[None]]:
    async def send(text: str) -> None:
        async with httpx.AsyncClient(timeout=15) as cl:
            r = await cl.post(f"https://api.telegram.org/bot{token}/sendMessage",
                              json={"chat_id": chat_id, "text": text})
        if r.status_code >= 400:
            log.warning("Telegram HTTP %s", r.status_code)      # không log nội dung: URL có token
    return send


class Watchdog:
    def __init__(self, live: FtClient, send: Callable[[str], Awaitable[None]] | None,
                 has_channel: Callable[[], bool] = lambda: False, now: Callable[[], float] = time.time):
        self.live, self.send, self.has_channel, self.now = live, send, has_channel, now
        self.fails = 0
        self.active: dict[str, str] = {}             # sự cố đang báo: khoá → nội dung
        self.no_stop: dict[int, int] = {}            # trade_id → số lần liền thấy thiếu stop
        self.last_log = self.now()                   # chỉ báo log mới hơn lúc hub khởi động

    async def _get(self, path: str, **params):
        return await self.live.call("GET", path, params=params or None)

    async def check(self) -> list[str]:
        """Một vòng canh; trả về các tin cần gửi (sự cố mới + sự cố đã hết)."""
        found: dict[str, str] = {}
        logs: list[str] = []
        try:
            conf = await self._get("/show_config")
            health = await self._get("/health")
            status = await self._get("/status")
            rows = (await self._get("/logs", limit=50)).get("logs", [])
            self.fails = 0
        except Exception as e:  # noqa: BLE001 — mọi lỗi gọi API đều là "bot không trả lời"
            self.fails += 1
            if self.fails >= DOWN_AFTER or "down" in self.active:
                found["down"] = f"Bot không trả lời API ({str(e)[:120]})"
            else:
                return []                             # chưa đủ lâu: giữ nguyên các sự cố đang báo
            return self._diff(found)

        if conf.get("state") != "running":
            found["state"] = f"Bot đang ở trạng thái {conf.get('state')!r}, không vào/thoát lệnh"
        ts = health.get("last_process_ts")
        if ts and self.now() - ts > STALE_S:
            found["stale"] = f"Bot không xử lý nến {int((self.now() - ts) / 60)} phút"

        if not conf.get("dry_run"):
            seen = set()
            for t in status if isinstance(status, list) else []:
                tid = t.get("trade_id")
                seen.add(tid)
                orders = t.get("orders") or []
                has_stop = bool(t.get("stoploss_order_id")) or any(
                    o.get("ft_order_side") == "stoploss" and o.get("status") in ("open", "new") for o in orders)
                self.no_stop[tid] = 0 if has_stop else self.no_stop.get(tid, 0) + 1
                if self.no_stop[tid] >= 2:            # lúc dời trailing có vài giây không có stop: bỏ qua
                    found[f"nostop{tid}"] = (f"Lệnh #{tid} {t.get('pair')} {'Short' if t.get('is_short') else 'Long'} "
                                             "đang mở mà KHÔNG có stop trên sàn")
            self.no_stop = {k: v for k, v in self.no_stop.items() if k in seen}

        newest = self.last_log
        for row in rows:                              # [giờ dạng chữ, giây, logger, level, nội dung]
            t = row[1]
            if t > self.last_log and row[3] in ("ERROR", "CRITICAL"):
                logs.append(f"{row[3]}: {row[4][:300]}")
            newest = max(newest, t)
        self.last_log = newest
        return self._diff(found) + logs[-5:]

    def _diff(self, found: dict[str, str]) -> list[str]:
        out = [f"⚠️ {v}" for k, v in found.items() if k not in self.active]
        out += [f"✅ Hết: {v}" for k, v in self.active.items() if k not in found]
        self.active = found
        return out

    async def run(self) -> None:
        if not self.has_channel():
            log.warning("Chưa có kênh cảnh báo (Telegram hoặc điện thoại bật Alerts ở tab Live): "
                        "sự cố của bot chỉ ghi vào log hub")
        while True:
            try:
                for msg in await self.check():
                    log.warning("Cảnh báo: %s", msg)
                    if self.send:
                        await self.send(f"[bot] {msg}")
            except Exception:  # noqa: BLE001 — watchdog không được chết
                log.exception("Watchdog lỗi")
            await asyncio.sleep(EVERY_S)
