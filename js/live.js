// Tab Live: theo dõi bot freqtrade qua hub (/api/live). Chỉ đọc; chỉ có khi app chạy trên hub.
// Tự làm mới mỗi 15 s khi tab đang mở và app đang hiện trên màn hình.

const REFRESH_MS = 15000;
const MODE = {
  paper: ["Paper", "mid", "Dry-run: simulated orders, no exchange"],
  demo: ["Demo", "good", "Binance Demo account: real orders, fake money"],
  live: ["LIVE", "bad", "Real money"],
};

export function createLive({ root, esc, fmt, sign, cls }) {
  let timer = null, busy = false, lastOk = 0, failSince = 0;
  const ago = (ms) => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${fmt(s / 3600, 1)} h ago`;
  };
  const pad = (n) => String(n).padStart(2, "0");
  const when = (ms) => { const d = new Date(ms); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };  // giờ máy người xem

  // Thông báo đẩy (Web Push) tới máy này: hub báo khi bot chết, kẹt, mất stop, log lỗi (bot/hub/alerts.py).
  const push = { sub: null, checked: false, busy: false, msg: "", alerts: null };
  const canPush = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const ios = /iPhone|iPad/.test(navigator.userAgent);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined }).then(async (r) => {
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
    return r.json();
  });

  function paintPush() {
    const box = root.querySelector("#pushCard");
    if (!box) return;
    const none = push.alerts === false;
    let body;
    if (!canPush) {
      body = ios && !standalone
        ? `<p class="hint">On iPhone: tap Share → <b>Add to Home Screen</b>, open the app from that icon, then come back here.</p>`
        : `<p class="hint">This browser can't receive notifications.</p>`;
    } else if (!push.checked) {
      body = `<p class="hint">Checking…</p>`;
    } else if (push.sub) {
      body = `<p class="hint">On for this device ✓ — you get a notification when the bot stops, gets stuck, loses its stop order or logs an error.</p>
        <div class="row"><button class="btn sm" data-push="test" ${push.busy ? "disabled" : ""}>Send test</button>
        <button class="btn sm" data-push="off" ${push.busy ? "disabled" : ""}>Turn off</button></div>`;
    } else {
      body = `<p class="hint">Get a notification on this device when the bot stops, gets stuck, loses its stop order or logs an error.</p>
        <div class="row"><button class="btn sm" data-push="on" ${push.busy ? "disabled" : ""}>Turn on alerts</button></div>`;
    }
    box.innerHTML = `<h2>Alerts on this device</h2>
      ${none ? `<p class="hint warn">No alerts set up yet: if the bot stops or loses its stop order, nobody is told.</p>` : ""}
      ${body}${push.msg ? `<p class="hint">${esc(push.msg)}</p>` : ""}`;
  }

  async function checkPush() {
    if (!canPush || push.checked) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      push.sub = await reg.pushManager.getSubscription();
    } catch { push.sub = null; }
    push.checked = true;
    paintPush();
  }

  async function pushAction(what) {
    push.busy = true; push.msg = ""; paintPush();
    try {
      const reg = await navigator.serviceWorker.ready;
      if (what === "on") {
        if (await Notification.requestPermission() !== "granted") throw new Error("Notifications are blocked for this app in Settings.");
        const { key } = await fetch("/api/push/key").then((r) => r.json());
        push.sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
        await post("/api/push/subscribe", push.sub.toJSON());
        const t = await post("/api/push/test");
        push.msg = t.sent ? "Done. A test notification is on its way." : "Saved, but the test notification did not go through.";
      } else if (what === "test") {
        if (push.sub) await post("/api/push/subscribe", push.sub.toJSON());   // đăng ký lại phòng khi hub đã xoá
        const t = await post("/api/push/test");
        push.msg = t.sent ? `Sent to ${t.sent} device(s).` : "Nothing was delivered — turn alerts off and on again.";
      } else if (what === "off" && push.sub) {
        await post("/api/push/unsubscribe", push.sub.toJSON());
        await push.sub.unsubscribe();
        push.sub = null;
      }
    } catch (e) {
      push.msg = `Couldn't do that: ${e.message}`;
    } finally {
      push.busy = false;
      paintPush();
    }
  }

  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-push]");
    if (b && !push.busy) pushAction(b.dataset.push);
  });

  function render(j) {
    if (!j.reachable) {
      root.innerHTML = `<div class="card"><h2>Bot offline</h2>
        <p class="hint warn">The home server can't reach the bot: ${esc(j.error || "no answer")}.</p>
        <p class="hint">On the server: <code>docker compose ps</code> then <code>docker compose logs --tail 50 live</code>.</p></div>`;
      return;
    }
    const cur = j.balance.currency || j.stake_currency || "USDT";
    const p = j.profit || {};
    const [mName, mCls, mHelp] = MODE[j.mode] || [j.mode, "", ""];
    const stale = j.last_process_ts && Date.now() / 1000 - j.last_process_ts > 300;
    const kpi = (label, val, extra = "") => `<div class="kpi"><span>${label}</span><b class="${extra}">${val}</b></div>`;
    const guard = j.mode !== "paper";

    const open = j.open.length ? j.open.map((t) => {
      const dir = t.is_short ? "short" : "long";
      const noStop = guard && !t.stop_on_exchange;
      return `<div class="tr">
        <span class="side ${dir}">${t.is_short ? "S" : "L"}</span>
        <span class="tmain"><b>${esc(t.pair)} · ${fmt(t.open_rate, 1)} → ${fmt(t.current_rate, 1)}</b>
          <small>since ${when(t.open_timestamp)} · stop ${fmt(t.stop_loss_abs, 1)}
          ${noStop ? `<span class="pill bad">stop not on exchange</span>` : guard ? "· on exchange ✓" : ""} · x${fmt(t.leverage, 0)}</small></span>
        <b class="${cls(t.profit_abs)}">${sign(t.profit_pct, 2)}%<small>${sign(t.profit_abs, 2)}</small></b></div>`;
    }).join("") : `<p class="hint">No open position — waiting for a signal.</p>`;

    const days = j.daily.slice().reverse();                          // cũ → mới
    const maxAbs = Math.max(1e-9, ...days.map((d) => Math.abs(d.abs || 0)));
    const bars = days.map((d, i) => {
      const h = (Math.abs(d.abs || 0) / maxAbs) * 45, x = (i / days.length) * 600, w = 600 / days.length - 3;
      const y = d.abs >= 0 ? 50 - h : 50;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(h, 0.8).toFixed(1)}"
        class="${d.abs > 0 ? "bup" : d.abs < 0 ? "bdown" : "bzero"}"><title>${esc(d.date)}: ${sign(d.abs || 0, 2)} ${esc(cur)} · ${d.trades} trades</title></rect>`;
    }).join("");

    const closed = j.closed.length ? j.closed.map((t) => `<div class="tr">
        <span class="side ${t.is_short ? "short" : "long"}">${t.is_short ? "S" : "L"}</span>
        <span class="tmain"><b>${fmt(t.open_rate, 1)} → ${fmt(t.close_rate, 1)}</b><small>${when(t.close_timestamp)} · ${esc(t.exit_reason || "")}</small></span>
        <b class="${cls(t.profit_abs)}">${sign(t.profit_abs, 2)}</b></div>`).join("") : `<p class="hint">No closed trades yet.</p>`;

    const logs = j.logs.length ? `<div class="card"><details class="more"><summary>Warnings (${j.logs.length})</summary>
      <div class="logs">${j.logs.map((l) => `<p class="${l.level === "WARNING" ? "warn" : "err"}"><small>${when(l.t * 1000)}</small> ${esc(l.msg)}</p>`).join("")}</div>
      </details></div>` : "";

    root.innerHTML = `
      <div class="card offline" hidden><p class="hint warn"></p></div>
      ${j.mode_warning ? `<div class="card"><p class="hint warn">${esc(j.mode_warning)}</p></div>` : ""}
      <div class="card" id="pushCard"></div>
      <div class="card hero">
        <div class="hero-top">
          <div>
            <div class="eyebrow">${esc(j.strategy || "Bot")} · ${esc(j.timeframe || "")} · bot balance</div>
            <div class="big">${fmt(j.balance.total, 2)} <small>${esc(cur)}</small></div>
            ${j.balance.account_total > j.balance.total + 1 ? `<div class="hint">Whole account ${fmt(j.balance.account_total, 2)} ${esc(cur)} (other coins, not used by the bot)</div>` : ""}
            <div class="sub ${cls(p.profit_all_coin)}">${sign(p.profit_all_coin || 0, 2)} ${esc(cur)} total (${sign(p.profit_all_percent || 0, 2)}%)</div>
          </div>
          <div class="pillbox">
            <span class="pill ${mCls}" title="${esc(mHelp)}">${esc(mName)}</span>
            <span class="pill ${j.state === "running" ? "good" : "bad"}">${esc(j.state || "?")}</span>
            ${stale ? `<span class="pill bad">not processing</span>` : ""}
          </div>
        </div>
        <div class="kpis">
          ${kpi("Closed trades", p.closed_trade_count ?? 0)}
          ${kpi("Win rate", p.winrate != null ? `${fmt(p.winrate * 100, 0)}%` : "–")}
          ${kpi("Profit factor", p.profit_factor != null ? fmt(p.profit_factor, 2) : "–")}
          ${kpi("Max drawdown", p.max_drawdown != null ? `${fmt(p.max_drawdown * 100, 1)}%` : "–")}
        </div>
        <p class="hint">${esc(mHelp)} · updated ${ago(lastOk)}${j.last_process_ts ? ` · bot checked ${ago(j.last_process_ts * 1000)}` : ""}</p>
      </div>
      <div class="card"><h2>Open position</h2><div class="trades">${open}</div></div>
      <div class="card"><h2>Daily profit <span class="hint">last ${days.length} days</span></h2>
        <svg class="daybars" viewBox="0 0 600 100" preserveAspectRatio="none" role="img" aria-label="Daily profit">
          <line x1="0" y1="50" x2="600" y2="50" class="zero"/>${bars}</svg></div>
      <div class="card"><h2>Last trades</h2><div class="trades">${closed}</div></div>
      ${logs}`;
  }

  async function refresh() {
    if (busy || document.hidden) return;
    busy = true;
    try {
      const r = await fetch("/api/live", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      lastOk = Date.now();
      failSince = 0;
      render(j);
      push.alerts = j.alerts;
      paintPush();
      checkPush();
    } catch (e) {
      if (!lastOk) root.innerHTML = `<div class="card"><p class="hint warn">Can't reach the home server: ${esc(e.message)}</p></div>`;
      else {
        // giữ số liệu cũ nhưng nói rõ là cũ — không để "updated 0s ago" / "running" đứng yên khi mất kết nối
        failSince ||= Date.now();
        const box = root.querySelector(".offline");
        if (box) {
          box.hidden = false;
          box.querySelector("p").textContent =
            `Can't reach the home server since ${new Date(failSince).toLocaleTimeString()} (${e.message}). Numbers below are from ${ago(lastOk)}.`;
        }
      }
    } finally {
      busy = false;
    }
  }

  const onVis = () => { if (!document.hidden && timer) refresh(); };
  return {
    start() {
      if (timer) return;
      if (!lastOk) root.innerHTML = `<div class="card"><p class="hint">Loading…</p></div>`;
      refresh();
      timer = setInterval(refresh, REFRESH_MS);
      document.addEventListener("visibilitychange", onVis);
    },
    stop() {
      clearInterval(timer); timer = null;
      document.removeEventListener("visibilitychange", onVis);
    },
  };
}
