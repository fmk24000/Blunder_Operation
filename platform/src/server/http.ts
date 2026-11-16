/** HTTP API（PLAN-v3.1 §7） */
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import QRCode from "qrcode";
import type { ApiErr, HostCommand } from "../shared/protocol.js";
import type { ErrorCode } from "../shared/protocol.js";
import type { Env } from "./env.js";
import type { Hub } from "./hub.js";
import type { Store } from "./store.js";
import { buildHostView, buildStageView } from "./views.js";
import { CmdError, executeCommand } from "./commands.js";
import { AuthError, createHostSession, joinRoom, verifyPin } from "./auth.js";
import { newId } from "./store.js";

const STATUS_FOR: Partial<Record<ErrorCode, number>> = {
  W_TOKEN_EXPIRED: 401,
  W_FORBIDDEN_ROLE: 403,
  W_STALE_COMMAND: 409,
  W_CMD_PAYLOAD_MISMATCH: 409,
  W_RULES_CONFLICT: 409,
  W_ROOM_FULL: 409,
  W_ALREADY_STATE: 409,
  W_ROUND_CLOSED: 409,
  W_STAGE_LOCKED: 423,
  W_RATE_LIMIT: 429,
  W_UPLOAD_REJECTED: 415,
};

function sendErr(reply: FastifyReply, code: ErrorCode, message: string, extra: Record<string, unknown> = {}): FastifyReply {
  const body: ApiErr & Record<string, unknown> = { ok: false, code, message, ...extra };
  return reply.code(STATUS_FOR[code] ?? 400).send(body);
}

/** rate limit key：LAN 直連用 socket IP；Cloudflare Tunnel 由 loopback 出，只喺 loopback 先信 CF-Connecting-IP（假 XFF 無效） */
function clientKey(req: FastifyRequest): string {
  const socketIp = req.socket.remoteAddress ?? "unknown";
  const loopback = socketIp === "127.0.0.1" || socketIp === "::1" || socketIp === "::ffff:127.0.0.1";
  if (loopback) {
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf.length > 0) return `cf:${cf}`;
  }
  return `ip:${socketIp}`;
}

function bearer(req: FastifyRequest): string {
  const h = req.headers.authorization;
  if (typeof h === "string" && h.startsWith("Bearer ")) return h.slice(7).trim();
  return "";
}

type HostAuth = { hostId: string; hostName: string };

export type HttpDeps = {
  app: FastifyInstance;
  store: Store;
  hub: Hub;
  env: Env;
  isReady: () => boolean;
  onLogin?: () => void;
};

export function registerHttp(deps: HttpDeps): void {
  const { app, store, hub, env } = deps;

  // 全域安全 header（onSend 一定要 return payload，唔可以 return reply）
  app.addHook("onSend", async (req, reply, payload) => {
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    if ((req.url ?? "").startsWith("/api/")) reply.header("Cache-Control", "no-store");
    return payload;
  });

  const requireHost = (req: FastifyRequest, reply: FastifyReply): HostAuth | null => {
    const origin = req.headers.origin;
    if (origin && !env.publicOrigins.includes(origin)) {
      sendErr(reply, "W_FORBIDDEN_ROLE", "origin 唔准");
      return null;
    }
    if (env.accessRequired) {
      const jwt = req.headers["cf-access-jwt-assertion"];
      if (typeof jwt !== "string" || jwt.length === 0) {
        sendErr(reply, "W_FORBIDDEN_ROLE", "要 Cloudflare Access（/host 同 /api/host/*）");
        return null;
      }
    }
    const token = bearer(req);
    if (!token) {
      sendErr(reply, "W_TOKEN_EXPIRED", "冇 host token（先 /api/host/login）");
      return null;
    }
    const session = store.sessionByToken(token);
    if (!session || session.role !== "host" || !session.hostId) {
      sendErr(reply, "W_TOKEN_EXPIRED", "host token 無效或過期");
      return null;
    }
    return { hostId: session.hostId, hostName: session.name ?? "主持" };
  };

  const runCommand = (host: HostAuth, reply: FastifyReply, cmd: HostCommand) => {
    try {
      const res = executeCommand(store, host.hostId, host.hostName, cmd, { isHostOnline: (hid) => hub.isHostOnline(hid) });
      if (res.ok) return reply.send(res);
      return reply.code(STATUS_FOR[res.code] ?? 400).send(res);
    } catch (error) {
      if (error instanceof CmdError) return sendErr(reply, error.code, error.message);
      if (error instanceof AuthError) return sendErr(reply, error.code, error.message);
      deps.app.log.error(error);
      return sendErr(reply, "W_BAD_SCHEMA", "內部錯誤");
    }
  };

  /* ── 公開 ── */
  app.get("/api/health", async () => ({ ok: true, uptime: process.uptime(), pid: process.pid, node: process.version }));

  app.get("/api/ready", async (_req, reply) => {
    if (!deps.isReady()) return reply.code(503).send({ ok: false, ready: false });
    const info = {
      ok: true,
      ready: true,
      roomId: store.state.room.id,
      roomCode: store.state.room.code,
      phase: store.state.room.phase,
      seq: store.seq,
      revision: store.revision,
      seqEpoch: store.seqEpoch,
      players: store.state.room.players.filter((p) => p.status !== "kicked").length,
      uptime: process.uptime(),
    };
    return reply.send(info);
  });

  app.get("/api/qr", async (req, reply) => {
    const q = req.query as { data?: string; size?: string };
    const data = typeof q.data === "string" ? q.data.slice(0, 500) : "";
    if (!data) return sendErr(reply, "W_BAD_SCHEMA", "要 data");
    const size = Math.min(800, Math.max(96, Number(q.size ?? 320)));
    try {
      const buf = await QRCode.toBuffer(data, { width: size, margin: 1, color: { dark: "#0b1020", light: "#ffffff" } });
      return reply.header("Content-Type", "image/png").header("Cache-Control", "no-store").send(buf);
    } catch {
      return sendErr(reply, "W_BAD_SCHEMA", "QR 生成失敗");
    }
  });

  // 非 §7 表：auditor 用公開只讀 endpoint（零秘密；AUDIT_READONLY=0 可關）
  // production 預設關（auditor 要顯式 AUDIT_READONLY=1）；development 預設開
  const auditReadonly = process.env.AUDIT_READONLY !== undefined ? process.env.AUDIT_READONLY === "1" : !env.isProduction;
  app.get("/api/stage/snapshot", async (_req, reply) => {
    if (!auditReadonly) return reply.code(404).send({ ok: false, code: "W_BAD_SCHEMA", message: "AUDIT_READONLY=0" });
    return buildStageView(store);
  });

  app.get("/api/scores", async (_req, reply) => {
    if (!auditReadonly) return reply.code(404).send({ ok: false, code: "W_BAD_SCHEMA", message: "AUDIT_READONLY=0" });
    const view = buildStageView(store);
    return {
      ok: true,
      roomId: store.state.room.id,
      roomCode: store.state.room.code,
      revision: store.revision,
      seqEpoch: store.seqEpoch,
      scores: view.scores,
      stats: store.stats(),
    };
  });

  /* ── join ── */
  const joinHits = new Map<string, { win: number; count: number }>();
  app.post("/api/join", async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && !env.publicOrigins.includes(origin)) return sendErr(reply, "W_FORBIDDEN_ROLE", "origin 唔准");
    const ip = clientKey(req);
    const nowMs = Date.now();
    const hit = joinHits.get(ip) ?? { win: nowMs, count: 0 };
    if (nowMs - hit.win > 60_000) {
      hit.win = nowMs;
      hit.count = 0;
    }
    hit.count += 1;
    joinHits.set(ip, hit);
    if (hit.count > 200) return sendErr(reply, "W_RATE_LIMIT", "join 太密");
    if (joinHits.size > 5000) joinHits.clear();
    const body = (req.body ?? {}) as { code?: string; name?: string; avatar?: unknown };
    try {
      const res = joinRoom(store, String(body.code ?? ""), String(body.name ?? ""), body.avatar, {
        autoApprove: process.env.AUTO_APPROVE === "1",
        ttlMs: 12 * 3600 * 1000,
      });
      return reply.send({
        ok: true,
        playerToken: res.token,
        playerId: res.playerId,
        number: res.number,
        status: res.status,
        roomCode: store.state.room.code,
        revision: store.revision,
      });
    } catch (error) {
      if (error instanceof AuthError) return sendErr(reply, error.code, error.message);
      throw error;
    }
  });

  /* ── host login ── */
  app.post("/api/host/login", async (req, reply) => {
    if (env.accessRequired) {
      const jwt = req.headers["cf-access-jwt-assertion"];
      if (typeof jwt !== "string" || jwt.length === 0) return sendErr(reply, "W_FORBIDDEN_ROLE", "要 Cloudflare Access");
    }
    const origin = req.headers.origin;
    if (origin && !env.publicOrigins.includes(origin)) return sendErr(reply, "W_FORBIDDEN_ROLE", "origin 唔准");
    const body = (req.body ?? {}) as { pin?: string; hostName?: string };
    const pin = String(body.pin ?? "").trim();
    const loginHits = clientKey(req) + ":login";
    const nowMs = Date.now();
    const hit = joinHits.get(loginHits) ?? { win: nowMs, count: 0 };
    if (nowMs - hit.win > 60_000) {
      hit.win = nowMs;
      hit.count = 0;
    }
    hit.count += 1;
    joinHits.set(loginHits, hit);
    if (hit.count > 10) return sendErr(reply, "W_RATE_LIMIT", "PIN 試太多次");
    if (!verifyPin(store, pin)) return sendErr(reply, "W_FORBIDDEN_ROLE", "PIN 唔啱");
    const hostName = String(body.hostName ?? "主持").trim().slice(0, 20) || "主持";
    const { token, session, hostId } = createHostSession(store, hostName, env.hostTokenTtlMs);
    deps.onLogin?.();
    return reply.send({
      ok: true,
      hostToken: token,
      hostId,
      hostName: session.name,
      expiresAt: session.expiresAt,
      roomCode: store.state.room.code,
      revision: store.revision,
      seqEpoch: store.seqEpoch,
    });
  });

  /* ── host snapshot／ledger／export ── */
  app.get("/api/host/snapshot", async (req, reply) => {
    const host = requireHost(req, reply);
    if (!host) return;
    return reply.send({ ok: true, view: buildHostView(store, host.hostId, host.hostName, hub.counts()) });
  });

  app.get("/api/host/ledger", async (req, reply) => {
    const host = requireHost(req, reply);
    if (!host) return;
    const q = req.query as { gameId?: string; playerId?: string; groupId?: string };
    let events = store.state.ledger;
    if (q.gameId) events = events.filter((e) => e.gameId === q.gameId);
    if (q.playerId) events = events.filter((e) => e.target.type === "player" && e.target.id === q.playerId);
    if (q.groupId) events = events.filter((e) => e.target.type === "group" && e.target.id === q.groupId);
    return reply.send({ ok: true, events, playerScores: Object.fromEntries(store.scoreMaps().player), groupScores: Object.fromEntries(store.scoreMaps().group) });
  });

  app.get("/api/host/export", async (req, reply) => {
    const host = requireHost(req, reply);
    if (!host) return;
    const maps = store.scoreMaps();
    const q = req.query as { format?: string };
    const playersCsv = [
      "number,name,group,score,groupScore,status",
      ...store.state.room.players.map((p) => {
        const g = store.state.room.groups.find((x) => x.id === p.groupId);
        return [p.number, `"${p.name.replace(/"/g, '""')}"`, g ? `"${g.name}"` : "", maps.player.get(p.id) ?? 0, p.groupId ? (maps.group.get(p.groupId) ?? 0) : 0, p.status].join(",");
      }),
    ].join("\n");
    const ledgerCsv = [
      "id,ts,targetType,targetId,delta,reason,gameId,roundId,by,voided",
      ...store.state.ledger.map((e) =>
        [e.id, new Date(e.ts).toISOString(), e.target.type, e.target.id, e.delta, `"${e.reason.replace(/"/g, '""')}"`, e.gameId ?? "", e.roundId ?? "", e.by, e.voided === true].join(","),
      ),
    ].join("\n");
    const roomJson = {
      exportedAt: new Date().toISOString(),
      room: store.state.room,
      settings: { autoClose: store.state.settings.autoClose, maxBid: store.state.settings.maxBid, allowRepeatAwards: store.state.settings.allowRepeatAwards },
      ledger: store.state.ledger,
      submissions: store.state.submissions,
      cards: store.state.cards,
      songs: store.state.songs,
      revision: store.revision,
      seqEpoch: store.seqEpoch,
    };
    if (q.format === "csv") {
      return reply
        .header("Content-Type", "text/plain; charset=utf-8")
        .send(`${playersCsv}\n\n${ledgerCsv}`);
    }
    if (q.format === "room") {
      return reply.header("Content-Type", "application/json; charset=utf-8").send(roomJson);
    }
    // 落 USB 用：寫一份入 data/export
    try {
      const dir = path.join(env.dataDir, "export");
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      fs.writeFileSync(path.join(dir, `players-${stamp}.csv`), playersCsv);
      fs.writeFileSync(path.join(dir, `ledger-${stamp}.csv`), ledgerCsv);
      fs.writeFileSync(path.join(dir, `room-${stamp}.json`), JSON.stringify(roomJson, null, 2));
    } catch (err) {
      deps.app.log.warn({ err }, "export 寫檔失敗");
    }
    return reply.send({ ok: true, generatedAt: new Date().toISOString(), playersCsv, ledgerCsv, room: roomJson });
  });


  /* ── M2/M3：上傳（MP3／圖片；驗 magic bytes／size／quota） ── */
  app.post("/api/host/upload", async (req, reply) => {
    const host = requireHost(req, reply);
    if (!host) return;
    let data;
    try {
      data = await req.file();
    } catch {
      return sendErr(reply, "W_UPLOAD_REJECTED", "唔係合法 multipart");
    }
    if (!data) return sendErr(reply, "W_UPLOAD_REJECTED", "冇檔案");
    const buf = await data.toBuffer();
    const fields = data.fields as Record<string, { value?: unknown } | undefined>;
    const kindRaw = String(fields.kind?.value ?? "image");
    const kind: "audio" | "image" = kindRaw === "audio" ? "audio" : "image";
    const maxSize = kind === "audio" ? 20 * 1024 * 1024 : 8 * 1024 * 1024;
    if (buf.length === 0) return sendErr(reply, "W_UPLOAD_REJECTED", "空檔案");
    if (buf.length > maxSize) return sendErr(reply, "W_UPLOAD_REJECTED", `檔案太大（上限 ${maxSize / 1024 / 1024}MB）`);
    const head = buf.subarray(0, 16);
    let ext: string | null = null;
    if (kind === "image") {
      if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) ext = "jpg";
      else if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) ext = "png";
      else if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") ext = "webp";
    } else {
      if (head.subarray(0, 3).toString("ascii") === "ID3") ext = "mp3";
      else if (head[0] === 0xff && (head[1] ?? 0) >= 0xe0) ext = "mp3";
      else if (buf.subarray(4, 8).toString("ascii") === "ftyp") ext = "m4a";
    }
    if (!ext) return sendErr(reply, "W_UPLOAD_REJECTED", `magic bytes 唔對（${kind} 只收 ${kind === "image" ? "jpg／png／webp" : "mp3／m4a"}）`);
    const total = store.state.assets.reduce((a, x) => a + x.size, 0);
    if (total + buf.length > 500 * 1024 * 1024) return sendErr(reply, "W_UPLOAD_REJECTED", "媒體 quota 已滿（500MB）");
    const file = `${newId("media")}.${ext}`;
    fs.writeFileSync(path.join(env.mediaDir, file), buf);
    const asset = {
      id: newId("asset"),
      kind,
      file,
      mime: data.mimetype,
      size: buf.length,
      originalName: data.filename ?? file,
      uploadedBy: host.hostId,
      createdAt: Date.now(),
      authorId: typeof fields.authorId?.value === "string" ? fields.authorId.value : undefined,
      cardId: typeof fields.cardId?.value === "string" ? fields.cardId.value : undefined,
    };
    const muts: { t: string; d: Record<string, unknown> }[] = [{ t: "asset.add", d: { asset } }];
    let song: unknown = null;
    if (kind === "audio") {
      const titleRaw = typeof fields.title?.value === "string" ? fields.title.value : "";
      const title = (titleRaw.trim() || String(data.filename ?? "未命名").replace(/\.[^.]+$/, "")).slice(0, 60);
      song = {
        id: newId("song"),
        index: store.state.songs.length + 1,
        title,
        source: { kind: "file", fileName: file },
        state: "ready",
      };
      muts.push({ t: "song.put", d: { song } });
    }
    store.commit(muts);
    return reply.send({ ok: true, asset, song, mediaUrl: `/media/${file}` });
  });

  /* ── 通用 host command ── */
  app.post("/api/host/command", async (req, reply) => {
    const host = requireHost(req, reply);
    if (!host) return;
    const body = (req.body ?? {}) as Partial<HostCommand>;
    if (typeof body.kind !== "string") return sendErr(reply, "W_BAD_SCHEMA", "要 kind");
    return runCommand(host, reply, {
      commandId: typeof body.commandId === "string" && body.commandId.length >= 4 ? body.commandId : newId("cmd"),
      kind: body.kind,
      targetId: body.targetId,
      expectedRevision: body.expectedRevision,
      expectedRoundId: body.expectedRoundId,
      payload: (body.payload ?? {}) as Record<string, unknown>,
    });
  });

  /* ── 具名 endpoint（§7 表格；全部收入 /api/host/*） ── */
  type RouteSpec = { method: "POST" | "PATCH"; url: string; kind: string; target?: (req: FastifyRequest) => string | undefined; wrap?: (body: Record<string, unknown>) => Record<string, unknown> };
  const specs: RouteSpec[] = [
    { method: "PATCH", url: "/api/host/players/:id", kind: "player.update", target: (r) => (r.params as { id: string }).id },
    { method: "POST", url: "/api/host/groups", kind: "groups.set" },
    { method: "POST", url: "/api/host/groups/assign", kind: "groups.assign" },
    { method: "POST", url: "/api/host/cards", kind: "card.create" },
    { method: "POST", url: "/api/host/cards/:id/open", kind: "card.open", target: (r) => (r.params as { id: string }).id },
    { method: "POST", url: "/api/host/cards/:id/close", kind: "card.close", target: (r) => (r.params as { id: string }).id },
    { method: "POST", url: "/api/host/cards/:id/tally", kind: "card.tally", target: (r) => (r.params as { id: string }).id },
    { method: "POST", url: "/api/host/cards/:id/reveal", kind: "card.reveal", target: (r) => (r.params as { id: string }).id },
    { method: "POST", url: "/api/host/cards/:id/reopen", kind: "card.reopen", target: (r) => (r.params as { id: string }).id },
    { method: "POST", url: "/api/host/quiz", kind: "quiz.upsert" },
    { method: "POST", url: "/api/host/quiz/import", kind: "quiz.import" },
    { method: "POST", url: "/api/host/quiz/reorder", kind: "quiz.reorder" },
    { method: "POST", url: "/api/host/score", kind: "score.add" },
    { method: "POST", url: "/api/host/score/:eventId/void", kind: "score.void", target: (r) => (r.params as { eventId: string }).eventId },
    { method: "POST", url: "/api/host/rundown/next", kind: "rundown.next" },
    { method: "POST", url: "/api/host/rundown/prev", kind: "rundown.prev" },
    { method: "POST", url: "/api/host/rundown/skip", kind: "rundown.skip" },
    { method: "POST", url: "/api/host/rundown/reorder", kind: "rundown.reorder" },
    { method: "POST", url: "/api/host/rundown/insert", kind: "rundown.insert" },
    { method: "POST", url: "/api/host/stage", kind: "stage.set" },
    { method: "POST", url: "/api/host/stage/lock", kind: "stage.lock" },
    { method: "POST", url: "/api/host/stage/blackout", kind: "stage.blackout" },
    { method: "POST", url: "/api/host/stage/rules", kind: "stage.rules" },
    { method: "POST", url: "/api/host/stage/page", kind: "stage.page" },
    { method: "POST", url: "/api/host/stage/ticker", kind: "stage.ticker" },
    { method: "POST", url: "/api/host/rules", kind: "rules.upsert" },
    { method: "POST", url: "/api/host/rules/reorder", kind: "rules.reorder" },
    { method: "POST", url: "/api/host/awards", kind: "award.compute" },
    { method: "POST", url: "/api/host/awards/:id/override", kind: "award.override", target: (r) => (r.params as { id: string }).id },
    { method: "POST", url: "/api/host/awards/reveal", kind: "award.reveal" },
    { method: "POST", url: "/api/host/settings", kind: "settings.set" },
    { method: "POST", url: "/api/host/room/start", kind: "room.start" },
    { method: "POST", url: "/api/host/room/phase", kind: "room.phase" },
    { method: "POST", url: "/api/host/quiz/actual", kind: "quiz.setActualAnswer" },
    { method: "POST", url: "/api/host/score/judge", kind: "score.judge" },
    { method: "POST", url: "/api/host/score/bulk", kind: "score.bulk" },
    { method: "POST", url: "/api/host/songs", kind: "song.upsert" },
    { method: "POST", url: "/api/host/songs/:id/delete", kind: "song.delete", target: (r) => (r.params as { id: string }).id },
    { method: "POST", url: "/api/host/media/play", kind: "media.play" },
    { method: "POST", url: "/api/host/media/pause", kind: "media.pause" },
    { method: "POST", url: "/api/host/media/resume", kind: "media.resume" },
    { method: "POST", url: "/api/host/media/stop", kind: "media.stop" },
    { method: "POST", url: "/api/host/media/reveal", kind: "media.reveal" },
    { method: "POST", url: "/api/host/media/lease", kind: "lease.acquire" },
    { method: "POST", url: "/api/host/media/lease/heartbeat", kind: "lease.heartbeat" },
    { method: "POST", url: "/api/host/media/lease/release", kind: "lease.release" },
    { method: "POST", url: "/api/host/bid/settle", kind: "bid.settle" },
    { method: "POST", url: "/api/host/draw/judge", kind: "draw.judge" },
    { method: "POST", url: "/api/host/draw/focus", kind: "draw.focus" },
    { method: "POST", url: "/api/host/saboteur/assign", kind: "saboteur.assign" },
    { method: "POST", url: "/api/host/saboteur/open", kind: "saboteur.openRound" },
    { method: "POST", url: "/api/host/saboteur/close", kind: "saboteur.closeRound" },
    { method: "POST", url: "/api/host/saboteur/decide", kind: "saboteur.decide" },
    { method: "POST", url: "/api/host/saboteur/finish", kind: "saboteur.finish" },
    { method: "POST", url: "/api/host/saboteur/reset", kind: "saboteur.reset" },
  ];
  for (const spec of specs) {
    const handler = async (req: FastifyRequest, reply: FastifyReply) => {
      const host = requireHost(req, reply);
      if (!host) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const cmd: HostCommand = {
        commandId: typeof body.commandId === "string" && body.commandId.length >= 4 ? body.commandId : newId("cmd"),
        kind: spec.kind,
        targetId: spec.target ? spec.target(req) : (body.targetId as string | undefined),
        expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
        expectedRoundId: typeof body.expectedRoundId === "string" ? body.expectedRoundId : undefined,
        payload: (body.payload as Record<string, unknown>) ?? body,
      };
      return runCommand(host, reply, cmd);
    };
    if (spec.method === "PATCH") app.patch(spec.url, handler);
    else app.post(spec.url, handler);
  }

  /* ── 靜態頁 ── */
  const sendPage = (file: string) => async (_req: FastifyRequest, reply: FastifyReply) => {
    const full = path.join(env.publicDir, file);
    if (!fs.existsSync(full)) return reply.code(404).send("page missing");
    return reply.header("Content-Type", "text/html; charset=utf-8").header("Cache-Control", "no-store").send(fs.readFileSync(full, "utf8"));
  };
  app.get("/", sendPage("index.html"));
  app.get("/stage", sendPage("stage.html"));
  app.get("/host", sendPage("host.html"));
  app.get("/play", sendPage("play.html"));
}
