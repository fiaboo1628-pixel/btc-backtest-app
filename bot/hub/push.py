"""
Thông báo đẩy (Web Push) tới điện thoại đã bật "Alerts on this phone" trong tab Live — kênh cảnh báo không cần
Telegram. iPhone: mở hub từ biểu tượng trên màn hình chính (Share → Add to Home Screen) mới nhận được.

Mã hoá theo RFC 8291 (aes128gcm) + xác thực VAPID (RFC 8292), chỉ dùng thư viện `cryptography`.
Khoá VAPID và danh sách máy đăng ký nằm trong một file JSON (mặc định <data dir>/push.json), hub tự tạo lần đầu.

    GET  /api/push/key          → khoá công khai VAPID (trình duyệt cần để đăng ký)
    POST /api/push/subscribe    → lưu đăng ký của máy này
    POST /api/push/unsubscribe  → xoá
    POST /api/push/test         → gửi thử tới mọi máy đã đăng ký
"""
import base64
import json
import logging
import os
import struct
import time
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hmac import HMAC
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

log = logging.getLogger("hub.push")


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def unb64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _hmac(key: bytes, data: bytes) -> bytes:
    h = HMAC(key, hashes.SHA256())
    h.update(data)
    return h.finalize()


def _hkdf(salt: bytes, ikm: bytes, info: bytes, n: int) -> bytes:
    """HKDF-SHA256 một khối (n ≤ 32), đúng như RFC 8291 dùng."""
    return _hmac(_hmac(salt, ikm), info + b"\x01")[:n]


def _pub_bytes(k: ec.EllipticCurvePublicKey) -> bytes:
    return k.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def encrypt(payload: bytes, p256dh: str, auth: str, *, salt: bytes | None = None,
            eph: ec.EllipticCurvePrivateKey | None = None) -> bytes:
    """Thân tin nhắn aes128gcm (RFC 8291 §3.4): salt | rs | idlen | khoá tạm | bản mã."""
    ua_pub = unb64u(p256dh)
    eph = eph or ec.generate_private_key(ec.SECP256R1())
    salt = salt or os.urandom(16)
    as_pub = _pub_bytes(eph.public_key())
    shared = eph.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_pub))
    ikm = _hkdf(unb64u(auth), shared, b"WebPush: info\x00" + ua_pub + as_pub, 32)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    body = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)          # \x02 = bản ghi cuối
    return salt + struct.pack(">IB", 4096, len(as_pub)) + as_pub + body


def vapid_header(key: ec.EllipticCurvePrivateKey, endpoint: str, subject: str, now: float | None = None) -> str:
    u = urlsplit(endpoint)
    head = b64u(json.dumps({"typ": "JWT", "alg": "ES256"}).encode())
    claims = b64u(json.dumps({"aud": f"{u.scheme}://{u.netloc}", "exp": int((now or time.time()) + 12 * 3600),
                              "sub": subject}).encode())
    r, s = decode_dss_signature(key.sign(f"{head}.{claims}".encode(), ec.ECDSA(hashes.SHA256())))
    jwt = f"{head}.{claims}.{b64u(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"
    return f"vapid t={jwt}, k={b64u(_pub_bytes(key.public_key()))}"


class Sub(BaseModel):
    endpoint: str
    keys: dict[str, str]


class Push:
    def __init__(self, path: Path):
        self.path = path
        st = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        # "sub" của VAPID: Apple trả 403 BadJwtToken với mailto:…@localhost, nên dùng địa chỉ https của hub,
        # lấy từ lần đăng ký đầu tiên (tên miền trang người dùng đang mở)
        self.subject: str | None = st.get("subject")
        if st.get("vapid_private"):
            self.key = serialization.load_pem_private_key(st["vapid_private"].encode(), None)
        else:
            self.key = ec.generate_private_key(ec.SECP256R1())
        self.subs: list[dict] = st.get("subs", [])
        if not st.get("vapid_private"):
            self._save()

    @property
    def public_key(self) -> str:
        return b64u(_pub_bytes(self.key.public_key()))

    def _save(self) -> None:
        pem = self.key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                     serialization.NoEncryption()).decode()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"vapid_private": pem, "subject": self.subject, "subs": self.subs}, f)
            f.flush()
            os.fsync(f.fileno())
        tmp.replace(self.path)

    def add(self, sub: dict) -> None:
        self.subs = [s for s in self.subs if s["endpoint"] != sub["endpoint"]] + [sub]
        self._save()

    def remove(self, endpoint: str) -> None:
        self.subs = [s for s in self.subs if s["endpoint"] != endpoint]
        self._save()

    async def send(self, title: str, body: str) -> int:
        """Gửi tới mọi máy; máy đã huỷ đăng ký (404/410) thì bỏ. Trả về số máy nhận."""
        data = json.dumps({"title": title, "body": body}).encode()
        subject = self.subject or "https://github.com/fiaboo1628-pixel/btc-backtest-app"
        ok, gone = 0, []
        async with httpx.AsyncClient(timeout=15) as cl:
            for s in list(self.subs):
                try:
                    r = await cl.post(s["endpoint"], content=encrypt(data, s["keys"]["p256dh"], s["keys"]["auth"]),
                                      headers={"Authorization": vapid_header(self.key, s["endpoint"], subject),
                                               "Content-Encoding": "aes128gcm", "TTL": "86400", "Urgency": "high",
                                               "Content-Type": "application/octet-stream"})
                except httpx.HTTPError as e:
                    log.warning("Push lỗi mạng: %s", e)
                    continue
                if r.status_code in (404, 410):
                    gone.append(s["endpoint"])
                elif r.status_code >= 400:
                    log.warning("Push HTTP %s: %s", r.status_code, r.text[:200])
                else:
                    ok += 1
        for e in gone:
            self.remove(e)
        return ok

    def router(self) -> APIRouter:
        r = APIRouter()

        @r.get("/api/push/key")
        async def key():
            return {"key": self.public_key, "devices": len(self.subs)}

        @r.post("/api/push/subscribe")
        async def subscribe(sub: Sub, request: Request):
            if not sub.endpoint.startswith("https://") or not {"p256dh", "auth"} <= set(sub.keys):
                raise HTTPException(400, "Đăng ký không hợp lệ")
            host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or "").split(",")[0].strip()
            if not self.subject and host and not host.startswith(("localhost", "127.")):
                self.subject = f"https://{host.split(':')[0]}"
            self.add(sub.model_dump())
            return {"devices": len(self.subs)}

        @r.post("/api/push/unsubscribe")
        async def unsubscribe(sub: Sub):
            self.remove(sub.endpoint)
            return {"devices": len(self.subs)}

        @r.post("/api/push/test")
        async def test():
            n = await self.send("Bot alerts", "Test: alerts from the home server reach this phone.")
            return {"sent": n, "devices": len(self.subs)}

        return r
