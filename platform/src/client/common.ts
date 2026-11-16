/** 前端共用：WS 自動重連、clock offset、API、DOM helper（D28 唔使手動 refresh） */

export type LiveRole = "host" | "stage" | "player";
export type ConnStatus = "connecting" | "connected" | "reconnecting" | "offline";

export type LiveOpts = {
  role: LiveRole;
  token?: string;
  code?: string;
  onView: (view: any, kind: "snapshot" | "patch") => void;
  onStatus?: (s: ConnStatus) => void;
  onHello?: (msg: any) => void;
  onAuthFail?: () => void;
  /** stage 被新連線接管（4010） */
  onEvicted?: () => void;
  onError?: (code: string, message: string) => void;
  onCommandResult?: (msg: any) => void;
  onSubmitResult?: (msg: any) => void;
  onShutdown?: (reason: string) => void;
};

export function perfNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export class Live {
  readonly opts: LiveOpts;
  ws: WebSocket | null = null;
  view: any = null;
  connected = false;
  status: ConnStatus = "connecting";
  private seq = -1;
  private epoch = "";
  private offset = 0;
  private samples: { rtt: number; offset: number }[] = [];
  private clientInstanceId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  private retry = 0;
  private retryTimer: number | null = null;
  private pingTimer: number | null = null;
  private closedByUs = false;
  private reconnectStarted = false;

  constructor(opts: LiveOpts) {
    this.opts = opts;
    this.bindEvents();
  }

  private bindEvents(): void {
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

  get code(): string {
    return this.opts.code ?? "";
  }

  setCode(code: string): void {
    this.opts.code = code;
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    this.closedByUs = false;
    this.setStatus(this.reconnectStarted ? "reconnecting" : "connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws`);
    } catch {
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
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onclose = (ev) => {
      this.connected = false;
      this.setStatus("reconnecting");
      if (this.pingTimer) window.clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.closedByUs) return;
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

  close(): void {
    this.closedByUs = true;
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    if (this.pingTimer) window.clearInterval(this.pingTimer);
    try {
      this.ws?.close(1000, "bye");
    } catch {
      /* ignore */
    }
  }

  private scheduleReconnect(): void {
    if (this.retryTimer) return;
    const base = [500, 1000, 2000, 4000, 10_000][Math.min(this.retry, 4)] ?? 10_000;
    this.retry += 1;
    const jitter = Math.random() * 250;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, base + jitter);
  }

  private setStatus(s: ConnStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.opts.onStatus?.(s);
  }

  send(msg: any): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify(msg));
  }

  resync(): void {
    if (!this.connected) return;
    this.send({ type: "resync", lastSeq: this.seq, stateHash: this.view?.stateHash });
  }

  private handle(msg: any): void {
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
        if (this.pingTimer) window.clearInterval(this.pingTimer);
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
            if (op.op === "viewport") continue;
            if (op.op === "section") this.view[op.name] = op.value;
            else if (op.op === "view") this.view = op.value;
            else if (op.op === "toast") this.view.toast = op.text;
          }
          this.view.serverNow = msg.serverNow;
          this.view.seq = msg.seq;
          if (msg.revision !== undefined) this.view.revision = msg.revision;
          this.opts.onView(this.view, "patch");
        }
        break;
      }
      case "pong": {
        const t1 = perfNow();
        const rtt = t1 - msg.clientT0;
        const offset = msg.serverNow + rtt / 2 - t1;
        this.samples.push({ rtt, offset });
        if (this.samples.length > 10) this.samples.shift();
        const best = this.samples.reduce((a, b) => (a.rtt <= b.rtt ? a : b));
        // offset 突變 > 300ms 先採用（防跳鐘）
        if (Math.abs(best.offset - this.offset) > 300 || this.samples.length <= 2) this.offset = best.offset;
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

  private clockFromSnapshot(serverNow: number): void {
    if (this.samples.length === 0) {
      this.offset = serverNow - perfNow();
    }
  }

  burstPing(): void {
    for (let i = 0; i < 3; i++) {
      window.setTimeout(() => this.send({ type: "ping", clientT0: perfNow() }), i * 120);
    }
  }

  serverNow(): number {
    return perfNow() + this.offset;
  }

  msLeft(endsAt: number | null | undefined): number | null {
    if (!endsAt) return null;
    return endsAt - this.serverNow();
  }
}

export function fmtClock(ms: number): string {
  if (ms <= 0) return "0.0";
  if (ms >= 10_000) return String(Math.ceil(ms / 1000));
  return (ms / 1000).toFixed(1);
}

/* ── API ── */
export async function api(path: string, opts: { method?: string; body?: unknown; token?: string } = {}): Promise<any> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = { ok: false, code: "W_BAD_MSG", message: `HTTP ${res.status}` };
  }
  if (!res.ok && json && json.ok === undefined) json.ok = false;
  return json;
}

/* ── storage ── */
export function lsGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
export function lsSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}
export function lsDel(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/* ── DOM / format ── */
export function el<T extends HTMLElement>(sel: string): T | null {
  return document.querySelector(sel) as T | null;
}
export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
export function avatarHtml(avatar: { emoji?: string; color?: string } | undefined, size = 44): string {
  const bg = avatar?.color ?? "#3b82f6";
  const emoji = avatar?.emoji ?? "🙂";
  return `<span class="av" style="--av-bg:${esc(bg)};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.55)}px">${esc(emoji)}</span>`;
}
export function scoreBar(view: any): string {
  if (!view?.ticker?.visible) return "";
  const entries = view.scores ?? [];
  if (!entries.length) return "";
  return `<div class="ticker">${entries
    .map(
      (s: any, i: number) =>
        `<div class="tick-item"><span class="tick-rank">${i + 1}</span>${avatarHtml(s.avatar, 40)}<span class="tick-name">${esc(s.name)}</span><span class="tick-score">${s.score}</span></div>`,
    )
    .join("")}</div>`;
}
export function connBanner(status: ConnStatus, lastView: any): string {
  if (status === "connected") return "";
  return `<div class="conn-banner">連線中…（最後更新 ${lastView ? new Date().toLocaleTimeString("zh-HK") : "未有資料"}）</div>`;
}

let toastTimer: number | null = null;
export function showToast(text: string | null | undefined): void {
  const box = el<HTMLDivElement>("#toast");
  if (!box || !text) return;
  box.textContent = text;
  box.classList.add("show");
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => box.classList.remove("show"), 3200);
}
