/**
 * 連線管理、broadcast、presence（PLAN-v3.1 §7／§9.4）
 * - 細房間唔維護複雜 delta：stage／player 每次收完整 role-filtered view；host 收有變嘅 section
 * - 舊 socket 遲斷唔可以踢走新 socket（identity → 最新 socket 集合）
 * - 重啟後 seqEpoch 變，client 見到 epoch 唔同即用 snapshot
 */
import crypto from "node:crypto";
import type { ClientMsg, ServerMsg } from "../shared/protocol.js";
import { CAPS } from "../shared/protocol.js";
import type { HostView, PlayerSelfView, StageView } from "../shared/types.js";
import type { Store, CommitMeta } from "./store.js";
import { buildHostView, buildPlayerView, buildStageView, type ConnStats } from "./views.js";

export type ConnKind = "host" | "stage" | "player";

export type ClientConn = {
  id: string;
  socket: import("ws").WebSocket;
  kind: ConnKind;
  playerId?: string;
  hostId?: string;
  hostName?: string;
  clientInstanceId: string;
  alive: boolean;
  lastSeen: number;
  helloDone: boolean;
  /** 連線建立時間（大mon 超額時踢最舊用） */
  openedAt: number;
  badCount: number;
  rateWindowStart: number;
  rateCount: number;
  hostSections: Map<string, string>;
  closing?: boolean;
};

type WsLike = import("ws").WebSocket;

function identityKey(c: ClientConn): string {
  if (c.kind === "player") return `player:${c.playerId ?? ""}`;
  if (c.kind === "host") return `host:${c.hostId ?? ""}`;
  return `stage:${c.id}`;
}

const HOST_SECTIONS = [
  "phase",
  "stage",
  "settings",
  "players",
  "groups",
  "rundown",
  "currentItemId",
  "currentItem",
  "currentRound",
  "rounds",
  "cards",
  "undercover",
  "undercoverMatch",
  "killerState",
  "quiz",
  "songs",
  "playback",
  "audioLease",
  "ledger",
  "submissions",
  "rulePages",
  "awards",
  "stats",
  "activity",
  "connections",
  "caps",
  "revision",
] as const;

export class Hub {
  conns = new Set<ClientConn>();
  /** identity → 有效 socket 集合（同時幾個 tab 開＝presence 計算） */
  byIdentity = new Map<string, Set<ClientConn>>();
  private store: Store;

  constructor(store: Store) {
    this.store = store;
    store.onCommit((meta) => this.onCommit(meta));
  }

  counts(): ConnStats {
    let hosts = 0;
    let stages = 0;
    let players = 0;
    for (const c of this.conns) {
      if (!c.helloDone) continue;
      if (c.kind === "host") hosts++;
      else if (c.kind === "stage") stages++;
      else players++;
    }
    return { hosts, stages, players, total: this.conns.size };
  }

  /** 名額爆咗：踢走最舊嘅同類連線（大mon 用「新連線優先」）。回傳被踢嘅 conn。 */
  evictOldest(kind: ConnKind, closeCode = 4010, reason = "evicted"): ClientConn | null {
    let oldest: ClientConn | null = null;
    for (const c of this.conns) {
      if (c.kind !== kind) continue;
      if (!oldest || c.openedAt < oldest.openedAt) oldest = c;
    }
    if (!oldest) return null;
    oldest.closing = true;
    this.conns.delete(oldest);
    const key = identityKey(oldest);
    const set = this.byIdentity.get(key);
    if (set) {
      set.delete(oldest);
      if (set.size === 0) this.byIdentity.delete(key);
    }
    try {
      (oldest.socket as WsLike).close(closeCode, reason);
    } catch {
      /* ignore */
    }
    console.warn(`[ws] evicted oldest ${kind} conn=${oldest.id} (cap ${kind})`);
    return oldest;
  }

  canAccept(kind: ConnKind): boolean {
    const c = this.counts();
    if (process.env.DEBUG_CAPS === "1") console.log(`[cap] kind=${kind} counts=${JSON.stringify(c)} total=${this.conns.size}`);
    if (this.conns.size >= CAPS.totalSockets) return false;
    if (kind === "host" && c.hosts >= CAPS.hostSockets) return false;
    if (kind === "stage" && c.stages >= CAPS.stageSockets) return false;
    return true;
  }

  register(conn: ClientConn): void {
    this.conns.add(conn);
    const key = identityKey(conn);
    let set = this.byIdentity.get(key);
    if (!set) {
      set = new Set();
      this.byIdentity.set(key, set);
    }
    set.add(conn);
    if (conn.kind === "player" && conn.playerId) {
      const p = this.store.player(conn.playerId);
      if (p && !p.connected) {
        p.connected = true;
        p.lastSeen = Date.now();
        this.broadcastPresence();
      }
    }
    this.onCommit({ mutations: [], seq: this.store.seq, revision: this.store.revision, bumpRevision: false });
  }

  unregister(conn: ClientConn): void {
    this.conns.delete(conn);
    const key = identityKey(conn);
    const set = this.byIdentity.get(key);
    if (set) {
      set.delete(conn);
      if (set.size === 0) this.byIdentity.delete(key);
    }
    if (conn.kind === "player" && conn.playerId) {
      const stillConnected = [...(this.byIdentity.get(key) ?? [])].length > 0;
      const p = this.store.player(conn.playerId);
      if (p && !stillConnected && p.status !== "kicked") {
        p.connected = false;
        p.lastSeen = Date.now();
        this.broadcastPresence();
      }
    }
  }

  send(conn: ClientConn, msg: ServerMsg): void {
    const sock = conn.socket as WsLike;
    if (sock.readyState !== 1) return;
    try {
      // slow consumer 保護：outbound buffer 太大即斷
      if (sock.bufferedAmount > 4 * 1024 * 1024) {
        console.warn(`[ws] slow consumer ${conn.id} bufferedAmount=${sock.bufferedAmount} → close`);
        sock.close(4009, "slow consumer");
        return;
      }
      sock.send(JSON.stringify(msg));
    } catch (err) {
      console.warn("[ws] send failed", err);
    }
  }

  snapshotFor(conn: ClientConn): unknown {
    if (conn.kind === "stage") return buildStageView(this.store);
    if (conn.kind === "player") return buildPlayerView(this.store, conn.playerId ?? "");
    return this.hostView(conn);
  }

  hostView(conn: ClientConn): HostView {
    return buildHostView(this.store, conn.hostId ?? "", conn.hostName ?? "主持", this.counts());
  }

  sendSnapshot(conn: ClientConn): void {
    const view = this.snapshotFor(conn);
    this.send(conn, {
      type: "snapshot",
      seq: this.store.seq,
      seqEpoch: this.store.seqEpoch,
      serverNow: Date.now(),
      revision: this.store.revision,
      stateHash: this.store.stateHash(),
      view,
    });
    if (conn.kind === "host") {
      conn.hostSections = new Map();
      const hv = view as HostView;
      for (const key of HOST_SECTIONS) conn.hostSections.set(key, JSON.stringify((hv as unknown as Record<string, unknown>)[key]));
    }
  }

  /** 每次 commit 之後：stage／player 換 view，host 只送有變 section */
  onCommit(meta: CommitMeta): void {
    const seq = this.store.seq;
    // 有真正 commit 才 +1 seq；presence 之類嘅 synthetic patch 唔跳號（baseSeq 必須等於 client 手上 seq）
    const baseSeq = meta.mutations.length > 0 ? Math.max(0, seq - 1) : seq;
    const serverNow = Date.now();
    for (const conn of this.conns) {
      if (!conn.helloDone) continue;
      try {
        if (conn.kind === "host") {
          const hv = this.hostView(conn);
          const ops: { op: "section"; name: string; value: unknown }[] = [];
          for (const key of HOST_SECTIONS) {
            const value = (hv as unknown as Record<string, unknown>)[key];
            const json = JSON.stringify(value);
            if (conn.hostSections.get(key) !== json) {
              conn.hostSections.set(key, json);
              ops.push({ op: "section", name: key, value });
            }
          }
          if (ops.length) {
            this.send(conn, { type: "patch", baseSeq, seq, serverNow, revision: this.store.revision, ops });
          }
        } else {
          const view = conn.kind === "stage" ? buildStageView(this.store) : buildPlayerView(this.store, conn.playerId ?? "");
          this.send(conn, {
            type: "patch",
            baseSeq,
            seq,
            serverNow,
            revision: this.store.revision,
            ops: [{ op: "view", view }],
          });
        }
      } catch (err) {
        console.error("[hub] patch error", err);
      }
    }
    void meta;
  }

  /** presence 改變（唔落 journal）：借 patch 管道通知 */
  broadcastPresence(): void {
    const seq = this.store.seq;
    const baseSeq = seq;
    const serverNow = Date.now();
    for (const conn of this.conns) {
      if (!conn.helloDone) continue;
      try {
        if (conn.kind === "host") {
          const hv = this.hostView(conn);
          const ops: { op: "section"; name: string; value: unknown }[] = [];
          for (const key of ["players", "connections", "caps", "stats"] as const) {
            const value = (hv as unknown as Record<string, unknown>)[key];
            const json = JSON.stringify(value);
            if (conn.hostSections.get(key) !== json) {
              conn.hostSections.set(key, json);
              ops.push({ op: "section", name: key, value });
            }
          }
          if (ops.length) this.send(conn, { type: "patch", baseSeq, seq, serverNow, revision: this.store.revision, ops });
        } else {
          const view = conn.kind === "stage" ? buildStageView(this.store) : buildPlayerView(this.store, conn.playerId ?? "");
          this.send(conn, { type: "patch", baseSeq, seq, serverNow, revision: this.store.revision, ops: [{ op: "view", view }] });
        }
      } catch (err) {
        console.error("[hub] presence patch error", err);
      }
    }
  }

  broadcastShutdown(reason: string): void {
    for (const conn of this.conns) {
      this.send(conn, { type: "shutdown", reason });
    }
  }

  closeAll(code = 1001, reason = "server shutdown"): void {
    for (const conn of this.conns) {
      try {
        conn.socket.close(code, reason);
      } catch {
        /* ignore */
      }
    }
  }

  /** 30 秒心跳：無 pong 即 mark offline，但唔刪 session */
  heartbeat(): void {
    for (const conn of this.conns) {
      const sock = conn.socket as WsLike;
      if (!conn.alive) {
        console.warn(`[ws] heartbeat timeout ${conn.id}（${conn.kind}）`);
        try {
          sock.terminate();
        } catch {
          /* ignore */
        }
        continue;
      }
      conn.alive = false;
      try {
        sock.ping();
      } catch {
        /* ignore */
      }
    }
  }

  parseRate(conn: ClientConn, nowMs: number): boolean {
    if (nowMs - conn.rateWindowStart > 1000) {
      conn.rateWindowStart = nowMs;
      conn.rateCount = 0;
    }
    conn.rateCount += 1;
    return conn.rateCount <= 10;
  }

  /** 舊 host connection 係咪真係在線（forceOnline 接管前要驗，防斷網繞 margin） */
  isHostOnline(hostId: string, freshMs = 15_000): boolean {
    const nowMs = Date.now();
    for (const c of this.conns) {
      if (c.kind === "host" && c.helloDone && c.hostId === hostId && nowMs - c.lastSeen <= freshMs) return true;
    }
    return false;
  }

  randomConnId(): string {
    return crypto.randomBytes(6).toString("hex");
  }

  handleClientMsg(
    conn: ClientConn,
    raw: string,
    handlers: {
      onHello: (conn: ClientConn, msg: Extract<ClientMsg, { type: "hello" }>) => void;
      onSubmit: (conn: ClientConn, msg: Extract<ClientMsg, { type: "submit" }>) => void;
      onCommand: (conn: ClientConn, msg: Extract<ClientMsg, { type: "command" }>) => void;
      onPing: (conn: ClientConn, msg: Extract<ClientMsg, { type: "ping" }>) => void;
      onResync: (conn: ClientConn, msg: Extract<ClientMsg, { type: "resync" }>) => void;
      onDeckReady: (conn: ClientConn, msg: Extract<ClientMsg, { type: "deck.ready" }>) => void;
    },
  ): void {
    const nowMs = Date.now();
    conn.lastSeen = nowMs;
    const sock = conn.socket as WsLike;
    if (!this.parseRate(conn, nowMs)) {
      this.send(conn, { type: "error", code: "W_RATE_LIMIT", message: "太快，慢啲" });
      try {
        sock.close(4008, "rate limit");
      } catch {
        /* ignore */
      }
      return;
    }
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw) as ClientMsg;
    } catch {
      conn.badCount += 1;
      this.send(conn, { type: "error", code: "W_BAD_MSG", message: "malformed JSON" });
      if (conn.badCount >= 3) {
        try {
          sock.close(4002, "bad msg");
        } catch {
          /* ignore */
        }
      }
      return;
    }
    if (!msg || typeof (msg as { type?: unknown }).type !== "string") {
      this.send(conn, { type: "error", code: "W_BAD_MSG", message: "冇 type" });
      return;
    }
    if (msg.type === "hello") {
      handlers.onHello(conn, msg);
      return;
    }
    if (!conn.helloDone) {
      this.send(conn, { type: "error", code: "W_FORBIDDEN_ROLE", message: "未 hello" });
      return;
    }
    switch (msg.type) {
      case "ping":
        handlers.onPing(conn, msg);
        break;
      case "resync":
        handlers.onResync(conn, msg);
        break;
      case "submit":
        handlers.onSubmit(conn, msg);
        break;
      case "command":
        handlers.onCommand(conn, msg);
        break;
      case "deck.ready":
        handlers.onDeckReady(conn, msg);
        break;
      case "leave":
        try {
          sock.close(1000, "bye");
        } catch {
          /* ignore */
        }
        break;
      default:
        this.send(conn, { type: "error", code: "W_BAD_MSG", message: "未知 type" });
    }
  }

}
