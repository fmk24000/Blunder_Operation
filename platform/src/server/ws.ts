/** WebSocket /ws（PLAN-v3.1 §7 協議） */
import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { CAPS } from "../shared/protocol.js";
import type { ErrorCode } from "../shared/protocol.js";
import type { Card, Submission } from "../shared/types.js";
import type { Env } from "./env.js";
import type { Hub, ClientConn } from "./hub.js";
import type { Store } from "./store.js";
import { executeCommand, CmdError } from "./commands.js";
import { hashToken } from "./auth.js";

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function originAllowed(env: Env, origin: string | undefined): boolean {
  if (!origin) return true; // bot／curl／native client 冇 Origin
  return env.publicOrigins.includes(origin);
}

function err(conn: ClientConn, hub: Hub, code: ErrorCode, message: string): void {
  hub.send(conn, { type: "error", code, message });
}

type SubmitPayload = { kind: "choice" | "open" | "vote" | "bid"; choice?: number; amount?: number; text?: string; targetId?: string };

function validateSubmission(
  card: Card,
  payload: SubmitPayload,
  maxBid: number,
): { kind: Submission["kind"]; choice?: number; amount?: number; text?: string } {
  if (payload.kind !== card.type && !(card.type === "vote" && payload.kind === "vote")) {
    throw new CmdError("W_BAD_SCHEMA", `kind 要 ${card.type}`);
  }
  if (card.type === "choice") {
    if (typeof payload.choice !== "number" || !Number.isInteger(payload.choice)) throw new CmdError("W_BAD_SCHEMA", "要 choice index");
    const len = card.options?.length ?? 0;
    if (payload.choice < 0 || payload.choice >= len) throw new CmdError("W_BAD_SCHEMA", "choice 超範圍");
    return { kind: "choice", choice: payload.choice };
  }
  if (card.type === "open") {
    if (card.openKind === "number") {
      if (payload.text !== undefined) throw new CmdError("W_INVALID_OPEN_KIND", "number 卡唔可以用 text");
      const amount = payload.amount;
      if (typeof amount !== "number" || !Number.isFinite(amount)) throw new CmdError("W_BAD_SCHEMA", "要數字");
      if (amount < 0 || amount > 999999) throw new CmdError("W_BAD_SCHEMA", "數字要 0–999999");
      const scaled = amount * 10;
      if (Math.abs(scaled - Math.round(scaled)) > 1e-9) throw new CmdError("W_BAD_SCHEMA", "最多 1 位小數");
      return { kind: "open", amount };
    }
    if (payload.amount !== undefined) throw new CmdError("W_INVALID_OPEN_KIND", "text 卡唔可以用 amount");
    const text = (payload.text ?? "").trim();
    if (text.length === 0) throw new CmdError("W_BAD_SCHEMA", "唔可以空");
    if ([...text].length > 60) throw new CmdError("W_BAD_SCHEMA", "最多 60 字");
    return { kind: "open", text };
  }
  if (card.type === "bid") {
    if (typeof payload.amount !== "number" || !Number.isInteger(payload.amount)) throw new CmdError("W_BAD_SCHEMA", "要整數出價");
    const max = card.maxBid ?? maxBid;
    if (payload.amount < 0 || payload.amount > max) throw new CmdError("W_BAD_SCHEMA", `出價要 0–${max}`);
    return { kind: "bid", amount: payload.amount };
  }
  if (card.type === "vote") {
    if (card.voteMode === "works") {
      if (typeof payload.choice !== "number" || !Number.isInteger(payload.choice)) throw new CmdError("W_BAD_SCHEMA", "要揀一張作品");
      const len = card.options?.length ?? 0;
      if (payload.choice < 0 || payload.choice >= len) throw new CmdError("W_BAD_SCHEMA", "作品唔存在");
      return { kind: "vote", choice: payload.choice };
    }
    if (typeof payload.targetId !== "string" || payload.targetId.length === 0) throw new CmdError("W_BAD_SCHEMA", "要揀一個人");
    return { kind: "vote", text: payload.targetId };
  }
  throw new CmdError("W_BAD_SCHEMA", "呢張卡唔接受提交");
}

export function registerWs(app: FastifyInstance, store: Store, hub: Hub, env: Env): void {
  app.get("/ws", { websocket: true }, (socket, req: FastifyRequest) => {
    const origin = req.headers.origin;
    if (!originAllowed(env, origin)) {
      socket.close(1008, "bad origin");
      return;
    }
    const conn: ClientConn = {
      id: hub.randomConnId(),
      socket,
      kind: "stage",
      clientInstanceId: "",
      alive: true,
      lastSeen: Date.now(),
      helloDone: false,
      openedAt: Date.now(),
      badCount: 0,
      rateWindowStart: Date.now(),
      rateCount: 0,
      hostSections: new Map(),
    };
    socket.on("pong", () => {
      conn.alive = true;
    });
    socket.on("message", (data: unknown) => {
      const raw = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      try {
        hub.handleClientMsg(conn, raw, handlers);
      } catch (error) {
        console.error("[ws] handler error", error);
        err(conn, hub, "W_BAD_SCHEMA", "內部錯誤");
      }
    });
    socket.on("close", (code: number, reason: Buffer) => {
      if (process.env.DEBUG_WS === "1") console.log(`[ws] close conn=${conn.id} kind=${conn.kind} pid=${conn.playerId ?? ""} code=${code} reason=${reason.toString()}`);
      hub.unregister(conn);
    });
    socket.on("error", (e: Error) => {
      console.warn(`[ws] socket error ${conn.id}: ${e.message}`);
    });
  });

  const handlers = {
    onHello(conn: ClientConn, msg: Extract<import("../shared/protocol.js").ClientMsg, { type: "hello" }>) {
      if (conn.helloDone) {
        err(conn, hub, "W_ALREADY_STATE", "重複 hello");
        return;
      }
      if (msg.code !== store.state.room.code) {
        err(conn, hub, "W_ROOM_LOCKED", "房碼唔啱");
        conn.socket.close(1008, "bad code");
        return;
      }
      const token = typeof msg.sessionToken === "string" ? msg.sessionToken : "";
      const session = token ? store.sessionByToken(token) : undefined;
      let kind: "host" | "player" | "stage";
      if (session?.role === "host") kind = "host";
      else if (session?.role === "player") kind = "player";
      else if (msg.role === "stage") kind = "stage";
      else if (msg.role === "host") {
        err(conn, hub, "W_TOKEN_EXPIRED", "host token 無效或過期");
        conn.socket.close(4001, "invalid token");
        return;
      } else {
        err(conn, hub, "W_TOKEN_EXPIRED", "player token 無效或過期");
        conn.socket.close(4001, "invalid token");
        return;
      }
      // 大mon（stage）上限 2：唔再拒絕新連線，改為踢走最舊（新連線優先；舊 tab 會收 4010 並顯示提示）
      if (kind === "stage") {
        while (hub.counts().stages >= CAPS.stageSockets) {
          if (!hub.evictOldest("stage", 4010, "evicted by newer stage")) break;
        }
      }
      if (!hub.canAccept(kind)) {
        err(conn, hub, "W_ROOM_FULL", "連線名額已滿");
        conn.socket.close(4003, "room full");
        return;
      }
      if (kind === "player") {
        const playerId = session?.playerId ?? "";
        const player = store.player(playerId);
        if (!player || player.status === "kicked" || !session) {
          err(conn, hub, "W_TOKEN_EXPIRED", "玩家身份無效");
          conn.socket.close(4001, "invalid player");
          return;
        }
        conn.kind = "player";
        conn.playerId = playerId;
      } else if (kind === "host") {
        conn.kind = "host";
        conn.hostId = session?.hostId ?? "";
        conn.hostName = session?.name ?? "主持";
      } else {
        conn.kind = "stage";
      }
      conn.clientInstanceId = typeof msg.clientInstanceId === "string" ? msg.clientInstanceId : "";
      hub.register(conn);
      conn.helloDone = true;
      hub.send(conn, {
        type: "hello.ok",
        role: conn.kind,
        playerId: conn.playerId,
        hostId: conn.hostId,
        serverNow: Date.now(),
        seqEpoch: store.seqEpoch,
        revision: store.revision,
      });
      hub.sendSnapshot(conn);
      if (conn.kind === "player" && conn.playerId) {
        const p = store.player(conn.playerId);
        if (p && !p.connected) {
          p.connected = true;
          hub.broadcastPresence();
        }
      }
    },

    onPing(conn: ClientConn, msg: Extract<import("../shared/protocol.js").ClientMsg, { type: "ping" }>) {
      hub.send(conn, { type: "pong", clientT0: msg.clientT0, serverNow: Date.now() });
    },

    onResync(conn: ClientConn, _msg: Extract<import("../shared/protocol.js").ClientMsg, { type: "resync" }>) {
      hub.sendSnapshot(conn);
    },

    onDeckReady(conn: ClientConn, msg: Extract<import("../shared/protocol.js").ClientMsg, { type: "deck.ready" }>) {
      if (conn.kind !== "host") {
        err(conn, hub, "W_FORBIDDEN_ROLE", "只有 host 可以做 media deck");
        return;
      }
      const lease = store.state.room.audioLease;
      const pb = store.state.playback;
      if (!lease || lease.deckId !== msg.deckId || lease.leaseUntil < Date.now() || lease.releasedAt) {
        hub.send(conn, { type: "error", code: "W_NO_AUDIO_LEASE", message: "deck 唔係 lease 持有者" });
        return;
      }
      if (lease.hostId !== conn.hostId) {
        hub.send(conn, { type: "error", code: "W_NO_AUDIO_LEASE", message: "deck 唔係呢個 host 嘅 lease" });
        return;
      }
      if (!pb || pb.songId !== msg.songId || pb.state !== "preparing") return;
      const positionMs = typeof msg.positionMs === "number" ? msg.positionMs : pb.positionMs;
      // play 要先 preload＋用戶解鎖＋ready ACK，server 才落 playStartedAt（§8.2）
      store.commit([{ t: "media.set", d: { playback: { ...pb, state: "playing", playStartedAt: Date.now(), positionMs } } }]);
      hub.send(conn, { type: "command.result", commandId: "deck.ready", status: "ok" });
    },

    onSubmit(conn: ClientConn, msg: Extract<import("../shared/protocol.js").ClientMsg, { type: "submit" }>) {
      if (conn.kind !== "player" || !conn.playerId) {
        err(conn, hub, "W_FORBIDDEN_ROLE", "只有玩家可以提交");
        return;
      }
      const playerId = conn.playerId;
      const round = store.currentRound();
      if (!round || round.id !== msg.roundId) {
        hub.send(conn, { type: "submit.result", roundId: msg.roundId, submissionId: msg.submissionId, status: "rejected", code: "W_ROUND_CLOSED", message: "回合已收" });
        return;
      }
      if (round.state !== "open") {
        hub.send(conn, { type: "submit.result", roundId: msg.roundId, submissionId: msg.submissionId, status: "rejected", code: "W_ROUND_CLOSED", message: "回合已收" });
        return;
      }
      if (!round.eligiblePlayerIds.includes(playerId)) {
        err(conn, hub, "W_FORBIDDEN_ROLE", "你唔喺呢一輪名單");
        return;
      }
      const card = store.card(round.cardId);
      if (!card) {
        err(conn, hub, "W_BAD_SCHEMA", "冇呢張卡");
        return;
      }
      const meNow = store.player(playerId);
      if (!meNow || meNow.status !== "approved") {
        err(conn, hub, "W_FORBIDDEN_ROLE", "你已經唔喺名單");
        return;
      }
      if (card.gameId === "draw" && card.voteMode === "players" && round.endsAt !== null && Date.now() >= round.endsAt) {
        hub.send(conn, { type: "submit.result", roundId: msg.roundId, submissionId: msg.submissionId, status: "rejected", code: "W_ROUND_CLOSED", message: "投票時間已過" });
        return;
      }
      const existingById = store.state.submissions.find((s) => s.id === msg.submissionId);
      if (existingById) {
        const computed = sha256(JSON.stringify(msg.payload ?? {}));
        if (existingById.payloadHash !== computed) {
          hub.send(conn, { type: "submit.result", roundId: msg.roundId, submissionId: msg.submissionId, status: "rejected", code: "W_ID_PAYLOAD_MISMATCH", message: "同 ID 但 payload 唔同" });
          return;
        }
        hub.send(conn, {
          type: "submit.result",
          roundId: msg.roundId,
          submissionId: msg.submissionId,
          status: "duplicate",
          receiptAt: existingById.ts,
        });
        return;
      }
      const existingFinal = store.state.submissions.find((s) => s.roundId === round.id && s.playerId === playerId && s.confirmed);
      if (existingFinal) {
        hub.send(conn, {
          type: "submit.result",
          roundId: msg.roundId,
          submissionId: msg.submissionId,
          status: "rejected",
          code: "W_ALREADY_STATE",
          message: "你已經交咗",
          receiptAt: existingFinal.ts,
        });
        return;
      }
      let validated: { kind: Submission["kind"]; choice?: number; amount?: number; text?: string };
      try {
        validated = validateSubmission(card, msg.payload ?? ({} as SubmitPayload), store.state.settings.maxBid);
        if (card.type === "vote" && card.voteMode !== "works") {
          const targetId = validated.text ?? "";
          if (targetId === playerId) throw new CmdError("W_SELF_VOTE", "唔可以投自己");
          const target = store.player(targetId);
          if (!target || target.status !== "approved") throw new CmdError("W_BAD_SCHEMA", "呢個人唔存在");
          if (card.options && card.options.length && !card.options.includes(targetId)) throw new CmdError("W_BAD_SCHEMA", "呢個人唔喺候選名單");
          if (card.gameId === "saboteur") {
            const eliminated = store.state.room.gameState?.saboteur?.eliminatedIds ?? [];
            if (eliminated.includes(targetId)) throw new CmdError("W_BAD_SCHEMA", "呢個人已被淘汰");
            if (eliminated.includes(playerId)) throw new CmdError("W_FORBIDDEN_ROLE", "你已被淘汰，唔可以投票");
          }
        }
      } catch (error) {
        if (error instanceof CmdError) {
          hub.send(conn, { type: "submit.result", roundId: msg.roundId, submissionId: msg.submissionId, status: "rejected", code: error.code, message: error.message });
        } else {
          hub.send(conn, { type: "submit.result", roundId: msg.roundId, submissionId: msg.submissionId, status: "rejected", code: "W_BAD_SCHEMA", message: "內部錯誤" });
        }
        return;
      }
      const submission: Submission = {
        id: msg.submissionId,
        roundId: round.id,
        cardId: card.id,
        playerId,
        ts: Date.now(),
        kind: validated.kind,
        confirmed: true,
        payloadHash: sha256(JSON.stringify(msg.payload ?? {})),
      };
      if (validated.choice !== undefined) submission.choice = validated.choice;
      if (validated.amount !== undefined) submission.amount = validated.amount;
      if (validated.text !== undefined) submission.text = validated.text;
      store.commit([{ t: "submission.add", d: { submission } }]);
      hub.send(conn, {
        type: "submit.result",
        roundId: round.id,
        submissionId: submission.id,
        status: "accepted",
        receiptAt: submission.ts,
      });
    },

    onCommand(conn: ClientConn, msg: Extract<import("../shared/protocol.js").ClientMsg, { type: "command" }>) {
      if (conn.kind !== "host") {
        err(conn, hub, "W_FORBIDDEN_ROLE", "只有主持可以下命令");
        return;
      }
      try {
        const res = executeCommand(store, conn.hostId ?? "", conn.hostName ?? "主持", {
          commandId: msg.commandId,
          kind: msg.kind,
          targetId: msg.targetId,
          expectedRevision: msg.expectedRevision,
          expectedRoundId: msg.expectedRoundId,
          payload: msg.payload ?? {},
        }, { isHostOnline: (hid) => hub.isHostOnline(hid) });
        if (res.ok) {
          hub.send(conn, { type: "command.result", commandId: msg.commandId, status: "ok", revision: res.revision, result: res.result });
        } else {
          hub.send(conn, { type: "command.result", commandId: msg.commandId, status: "error", code: res.code, message: res.message, revision: res.revision });
        }
      } catch (error) {
        if (error instanceof CmdError) {
          hub.send(conn, { type: "command.result", commandId: msg.commandId, status: "error", code: error.code, message: error.message });
        } else {
          console.error("[ws] command error", error);
          hub.send(conn, { type: "command.result", commandId: msg.commandId, status: "error", code: "W_BAD_SCHEMA", message: "內部錯誤" });
        }
      }
    },
  };
  void hashToken;
}
