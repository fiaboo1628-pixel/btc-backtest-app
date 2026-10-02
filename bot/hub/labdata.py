"""
Tự cập nhật nến cho LAB (trang Chỉnh tham số), để backtest luôn chạy tới gần hôm nay.

Lúc hub khởi động và sau đó mỗi 24h: `freqtrade download-data` cho các cặp + khung của bot (config.base.json:
pair_whitelist, timeframe) thêm khung 15m (khớp lệnh chi tiết), vào đúng datadir của LAB. Không --erase:
freqtrade chỉ tải tiếp từ nến cuối của mỗi file (cặp mới chưa có file thì tải 30 ngày gần nhất).

config.base.json bật api_server, mà freqtrade đòi username/password của khối đó khi kiểm tra config — nên chạy
với một bản tạm (tempfile) bỏ khối api_server. Không đụng secrets.

Thất bại liên tiếp 2 lần thì log ERROR và gửi cảnh báo (Telegram/điện thoại) một lần; chạy lại được thì báo hết.
Tắt: hub.json "lab_data_update": false.
"""
import asyncio
import json
import logging
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Awaitable, Callable

from tune import DETAIL_TF

log = logging.getLogger("hub.labdata")

EVERY_S = 24 * 3600
TIMEOUT_S = 30 * 60
ALERT_AFTER = 2                 # thất bại liên tiếp ngần này lần mới báo (mạng chập chờn một lần thì thôi)
BUSY_WAIT_S, BUSY_TRIES = 30, 120   # LAB đang backtest thì chờ (tối đa ~1h), tránh ghi file nến đang được đọc


def temp_config(bot_cfg: dict) -> dict:
    """Bản config để tải nến: như config của bot nhưng bỏ api_server."""
    return {k: v for k, v in bot_cfg.items() if k != "api_server"}


def build_command(bot_cfg: dict, cfg_file: Path, datadir: Path) -> list[str]:
    tf = bot_cfg["timeframe"]
    tfs = [tf] + ([DETAIL_TF] if tf != DETAIL_TF else [])
    # --userdir: freqtrade đòi thư mục user_data tồn tại (mặc định tính từ thư mục đang đứng); datadir = user_data/data/binance
    return ["freqtrade", "download-data", "-c", str(cfg_file), "--userdir", str(datadir.parent.parent), "--datadir", str(datadir),
            "-p", *bot_cfg["exchange"]["pair_whitelist"], "-t", *tfs]


def error_of(output: str) -> str:
    """Dòng lỗi đáng đọc nhất trong log của freqtrade."""
    lines = [x.strip() for x in output.splitlines() if x.strip()]
    bad = [x for x in lines if " - ERROR - " in x or " - CRITICAL - " in x]
    return ((bad or lines or ["không có log"])[-1])[:300]


async def _exec(cmd: list[str], timeout: float) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.STDOUT)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise RuntimeError(f"quá {int(timeout // 60)} phút chưa xong, đã dừng") from None
    return proc.returncode, out.decode(errors="replace")


class Updater:
    def __init__(self, bot_config: Path, datadir: Path,
                 notify: Callable[[str], Awaitable[None]] | None = None,
                 lab_busy: Callable[[], Awaitable[bool]] | None = None,
                 exec_: Callable[[list[str], float], Awaitable[tuple[int, str]]] = _exec):
        self.bot_config, self.datadir = Path(bot_config), Path(datadir)
        self.notify, self.lab_busy, self.exec = notify, lab_busy, exec_
        self.state_file = self.datadir / "hub_download.json"      # lần thành công gần nhất, giữ qua lần khởi động lại
        self.fails = 0
        self.running = False
        self.last_error: str | None = None
        self.last_ok: str | None = None
        try:
            self.last_ok = json.loads(self.state_file.read_text(encoding="utf-8")).get("last_ok")
        except (OSError, ValueError):
            pass

    def status(self) -> dict:
        return {"enabled": True, "running": self.running, "last_ok": self.last_ok,
                "last_error": self.last_error if self.fails else None}

    async def _wait_lab_idle(self) -> None:
        for _ in range(BUSY_TRIES):
            try:
                if not (self.lab_busy and await self.lab_busy()):
                    return
            except Exception:  # noqa: BLE001 — không hỏi được LAB thì cứ tải
                return
            await asyncio.sleep(BUSY_WAIT_S)

    async def download(self) -> None:
        """Một lần tải; lỗi thì raise RuntimeError với dòng lỗi của freqtrade."""
        try:
            bot_cfg = json.loads(self.bot_config.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            raise RuntimeError(f"không đọc được {self.bot_config}: {e}") from None
        fd, tmp = tempfile.mkstemp(prefix="hub-download-", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(temp_config(bot_cfg), f)
            cmd = build_command(bot_cfg, Path(tmp), self.datadir)
            log.info("Tải nến cho LAB: %s", " ".join(cmd[cmd.index("-p"):]))
            try:
                rc, out = await self.exec(cmd, TIMEOUT_S)
            except OSError as e:                                  # không có lệnh freqtrade
                raise RuntimeError(f"không chạy được freqtrade: {e}") from None
        finally:
            Path(tmp).unlink(missing_ok=True)
        # freqtrade bỏ qua cặp lỗi (vd sàn không có) mà vẫn thoát 0: coi dòng ERROR là thất bại
        if rc != 0 or " - ERROR - " in out or " - CRITICAL - " in out:
            raise RuntimeError(f"download-data lỗi (mã {rc}): {error_of(out)}")

    async def once(self) -> bool:
        self.running = True
        try:
            await self._wait_lab_idle()
            await self.download()
        except Exception as e:  # noqa: BLE001 — mọi lỗi đều là "không cập nhật được"
            self.fails += 1
            self.last_error = str(e)
            if self.fails == ALERT_AFTER:
                log.error("Không cập nhật được nến LAB %s lần liền: %s", self.fails, e)
                await self._send(f"⚠️ Không cập nhật được nến cho LAB {self.fails} lần liền: {e}")
            else:
                log.warning("Không cập nhật được nến LAB (lần %s): %s", self.fails, e)
            return False
        finally:
            self.running = False
        if self.fails >= ALERT_AFTER:
            await self._send("✅ Hết: nến cho LAB đã cập nhật lại được")
        self.fails, self.last_error = 0, None
        self.last_ok = datetime.now(timezone.utc).isoformat(timespec="seconds")
        try:
            self.state_file.write_text(json.dumps({"last_ok": self.last_ok}), encoding="utf-8")
        except OSError as e:
            log.warning("Không ghi được %s: %s", self.state_file, e)
        log.info("Đã cập nhật nến cho LAB")
        return True

    async def _send(self, msg: str) -> None:
        if not self.notify:
            return
        try:
            await self.notify(f"[hub] {msg}")
        except Exception as e:  # noqa: BLE001
            log.warning("Chưa gửi được cảnh báo tải nến (%s)", type(e).__name__)

    async def run(self) -> None:
        while True:
            try:
                await self.once()
            except Exception:  # noqa: BLE001 — vòng lặp không được chết
                log.exception("Cập nhật nến LAB lỗi")
            await asyncio.sleep(EVERY_S)
