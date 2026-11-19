/** 前端共用：WS 自動重連、clock offset、API、DOM helper（D28 唔使手動 refresh） */
export function perfNow() {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
}
export class Live {
    opts;
    ws = null;
    view = null;
    connected = false;
    status = "connecting";
    seq = -1;
    epoch = "";
    offset = 0;
    samples = [];
    clientInstanceId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    retry = 0;
    retryTimer = null;
    pingTimer = null;
    closedByUs = false;
    reconnectStarted = false;
    constructor(opts) {
        this.opts = opts;
        this.bindEvents();
    }
    bindEvents() {
        window.addEventListener("online", () => {
            this.burstPing();
            this.resync();
        });
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") {
                this.burstPing();
                this.resync();
            }
        });
    }
    get code() {
        return this.opts.code ?? "";
    }
    setCode(code) {
        this.opts.code = code;
    }
    connect() {
        if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1))
            return;
        this.closedByUs = false;
        this.setStatus(this.reconnectStarted ? "reconnecting" : "connecting");
        const proto = location.protocol === "https:" ? "wss" : "ws";
        let ws;
        try {
            ws = new WebSocket(`${proto}://${location.host}/ws`);
        }
        catch {
            this.scheduleReconnect();
            return;
        }
        this.ws = ws;
        ws.onopen = () => {
            this.send({
                type: "hello",
                role: this.opts.role,
                code: this.code,
                sessionToken: this.opts.token,
                clientInstanceId: this.clientInstanceId,
                lastSeq: this.seq >= 0 ? this.seq : undefined,
            });
        };
        ws.onmessage = (ev) => {
            let msg;
            try {
                msg = JSON.parse(String(ev.data));
            }
            catch {
                return;
            }
            this.handle(msg);
        };
        ws.onclose = (ev) => {
            this.connected = false;
            this.setStatus("reconnecting");
            if (this.pingTimer)
                window.clearInterval(this.pingTimer);
            this.pingTimer = null;
            if (this.closedByUs)
                return;
            if (ev.code === 4010) {
                // 被另一個大mon 接管：唔好重連（會互踢）
                this.setStatus("offline");
                this.opts.onEvicted?.();
                return;
            }
            if (ev.code === 4001 || ev.code === 1008) {
                // token 失效／origin 拒絕：唔好無限重試
                this.setStatus("offline");
                this.opts.onAuthFail?.();
                return;
            }
            this.reconnectStarted = true;
            this.scheduleReconnect();
        };
        ws.onerror = () => {
            /* onclose 會處理 */
        };
    }
    close() {
        this.closedByUs = true;
        if (this.retryTimer)
            window.clearTimeout(this.retryTimer);
        if (this.pingTimer)
            window.clearInterval(this.pingTimer);
        try {
            this.ws?.close(1000, "bye");
        }
        catch {
            /* ignore */
        }
    }
    scheduleReconnect() {
        if (this.retryTimer)
            return;
        const base = [500, 1000, 2000, 4000, 10_000][Math.min(this.retry, 4)] ?? 10_000;
        this.retry += 1;
        const jitter = Math.random() * 250;
        this.retryTimer = window.setTimeout(() => {
            this.retryTimer = null;
            this.connect();
        }, base + jitter);
    }
    setStatus(s) {
        if (this.status === s)
            return;
        this.status = s;
        this.opts.onStatus?.(s);
    }
    send(msg) {
        if (!this.ws || this.ws.readyState !== 1)
            return;
        this.ws.send(JSON.stringify(msg));
    }
    resync() {
        if (!this.connected)
            return;
        this.send({ type: "resync", lastSeq: this.seq, stateHash: this.view?.stateHash });
    }
    handle(msg) {
        switch (msg.type) {
            case "hello.ok": {
                this.connected = true;
                this.retry = 0;
                this.setStatus("connected");
                this.opts.onHello?.(msg);
                this.burstPing();
                const ping = () => {
                    this.send({ type: "ping", clientT0: perfNow() });
                };
                ping();
                if (this.pingTimer)
                    window.clearInterval(this.pingTimer);
                this.pingTimer = window.setInterval(ping, 10_000);
                break;
            }
            case "snapshot": {
                this.epoch = msg.seqEpoch;
                this.seq = msg.seq;
                this.clockFromSnapshot(msg.serverNow);
                this.view = msg.view;
                this.opts.onView(msg.view, "snapshot");
                break;
            }
            case "patch": {
                if (msg.seqEpoch !== undefined && msg.seqEpoch !== this.epoch) {
                    this.resync();
                    return;
                }
                if (msg.baseSeq !== this.seq) {
                    // 跳號／hash 對唔上 → 唔准繼續用懷疑有缺漏嘅畫面
                    this.resync();
                    return;
                }
                this.seq = msg.seq;
                if (this.view) {
                    for (const op of msg.ops ?? []) {
                        if (op.op === "viewport")
                            continue;
                        if (op.op === "section")
                            this.view[op.name] = op.value;
                        else if (op.op === "view") {
                            // protocol 送 {op:"view", view}（唔係 value）；收到壞 payload 就 resync，唔好整爛個 view
                            if (!op.view || typeof op.view !== "object") {
                                this.resync();
                                return;
                            }
                            this.view = op.view;
                        }
                        else if (op.op === "toast")
                            this.view.toast = op.text;
                    }
                    if (!this.view || typeof this.view !== "object") {
                        this.resync();
                        return;
                    }
                    this.view.serverNow = msg.serverNow;
                    this.view.seq = msg.seq;
                    if (msg.revision !== undefined)
                        this.view.revision = msg.revision;
                    this.opts.onView(this.view, "patch");
                }
                break;
            }
            case "pong": {
                const t1 = perfNow();
                const rtt = t1 - msg.clientT0;
                const offset = msg.serverNow + rtt / 2 - t1;
                this.samples.push({ rtt, offset });
                if (this.samples.length > 10)
                    this.samples.shift();
                const best = this.samples.reduce((a, b) => (a.rtt <= b.rtt ? a : b));
                // offset 突變 > 300ms 先採用（防跳鐘）
                if (Math.abs(best.offset - this.offset) > 300 || this.samples.length <= 2)
                    this.offset = best.offset;
                break;
            }
            case "error": {
                this.opts.onError?.(msg.code, msg.message);
                break;
            }
            case "submit.result": {
                this.opts.onSubmitResult?.(msg);
                break;
            }
            case "command.result": {
                this.opts.onCommandResult?.(msg);
                break;
            }
            case "shutdown": {
                this.opts.onShutdown?.(msg.reason);
                break;
            }
            default:
                break;
        }
    }
    clockFromSnapshot(serverNow) {
        if (this.samples.length === 0) {
            this.offset = serverNow - perfNow();
        }
    }
    burstPing() {
        for (let i = 0; i < 3; i++) {
            window.setTimeout(() => this.send({ type: "ping", clientT0: perfNow() }), i * 120);
        }
    }
    serverNow() {
        return perfNow() + this.offset;
    }
    msLeft(endsAt) {
        if (!endsAt)
            return null;
        return endsAt - this.serverNow();
    }
}
export function fmtClock(ms) {
    if (ms <= 0)
        return "0.0";
    if (ms >= 10_000)
        return String(Math.ceil(ms / 1000));
    return (ms / 1000).toFixed(1);
}
/* ── API ── */
export async function api(path, opts = {}) {
    const headers = { "Content-Type": "application/json" };
    if (opts.token)
        headers.Authorization = `Bearer ${opts.token}`;
    const res = await fetch(path, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    let json = null;
    try {
        json = await res.json();
    }
    catch {
        json = { ok: false, code: "W_BAD_MSG", message: `HTTP ${res.status}` };
    }
    if (!res.ok && json && json.ok === undefined)
        json.ok = false;
    return json;
}
/* ── storage ── */
export function lsGet(key) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
    }
    catch {
        return null;
    }
}
export function lsSet(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    }
    catch {
        /* ignore */
    }
}
export function lsDel(key) {
    try {
        localStorage.removeItem(key);
    }
    catch {
        /* ignore */
    }
}
/* ── DOM / format ── */
export function el(sel) {
    return document.querySelector(sel);
}
export function esc(s) {
    return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
export function avatarHtml(avatar, size = 44) {
    const bg = avatar?.color ?? "#3b82f6";
    const emoji = avatar?.emoji ?? "🙂";
    return `<span class="av" style="--av-bg:${esc(bg)};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.55)}px">${esc(emoji)}</span>`;
}
export function scoreBar(view) {
    if (!view?.ticker?.visible)
        return "";
    const entries = view.scores ?? [];
    if (!entries.length)
        return "";
    return `<div class="ticker">${entries
        .map((s, i) => `<div class="tick-item"><span class="tick-rank">${i + 1}</span>${avatarHtml(s.avatar, 40)}<span class="tick-name">${esc(s.name)}</span><span class="tick-score">${s.score}</span></div>`)
        .join("")}</div>`;
}
export function connBanner(status, lastView) {
    if (status === "connected")
        return "";
    return `<div class="conn-banner">連線中…（最後更新 ${lastView ? new Date().toLocaleTimeString("zh-HK") : "未有資料"}）</div>`;
}
let toastTimer = null;
/** v0.3.1：可以指定顯示時間（大mon 用短啲，唔好遮住分數條／畫面）。預設 3.2 秒。 */
export function showToast(text, ms = 3200) {
    const box = el("#toast");
    if (!box || !text)
        return;
    box.textContent = text;
    box.classList.add("show");
    if (toastTimer)
        window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => box.classList.remove("show"), Math.max(600, ms));
}
