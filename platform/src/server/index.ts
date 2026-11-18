/** 啟動：env 檢查 → journal 載入 → fastify＋ws＋static → listen（單 process） */
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import staticPlugin from "@fastify/static";
import multipart from "@fastify/multipart";
import { loadEnv, scryptHash, scryptVerify } from "./env.js";
import { Store } from "./store.js";
import { Hub } from "./hub.js";
import { registerWs } from "./ws.js";
import { registerHttp } from "./http.js";
import { bootstrapMutations } from "./seed.js";
import { tickAutoClose, tickLeases, tickUndercover } from "./commands.js";
import { newId } from "./store.js";
import { buildHostView } from "./views.js";

const env = loadEnv();

function findRoomId(): { roomId: string; existing: boolean } {
  const dir = env.journalDir;
  fs.mkdirSync(dir, { recursive: true });
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith("room-"));
  if (entries.length > 1) {
    console.warn(`[boot] 搵到多過一個房 journal（${entries.map((e) => e.name).join(", ")}）；單 instance 只准一個房，用第一個`);
  }
  if (entries.length >= 1) {
    const name = (entries[0] as { name: string }).name;
    return { roomId: name.slice("room-".length), existing: true };
  }
  return { roomId: newId("room"), existing: false };
}

const { roomId, existing } = findRoomId();
const journalDir = path.join(env.journalDir, `room-${roomId}`);
const defaultCode = env.roomCode ?? String(Math.floor(1000 + Math.random() * 9000));
const store = new Store(roomId, journalDir, defaultCode);
const loadRes = store.load();

if (!existing || store.state.room.rundown.length === 0) {
  console.log(`[boot] 新房間 → 寫入起始資料（manifest＋segment）`);
  store.commit(bootstrapMutations(env.appRoot, roomId, defaultCode, scryptHash(env.pin), env.autoCloseDefault));
} else {
  // .env 嘅 PIN 係權威：同 journal 存嘅 hash 唔同就更新（記錄落 journal）
  const stored = store.state.settings.pinHash;
  if (!stored || !scryptVerify(env.pin, stored)) {
    console.log("[boot] PIN 同 journal 存嘅 hash 唔同 → 更新 PIN hash");
    store.commit([{ t: "settings.set", d: { settings: { pinHash: scryptHash(env.pin) } } }]);
  }
}

const hub = new Hub(store);
const app = Fastify({
  logger: {
    level: env.isProduction ? "info" : "info",
    // 永不記 token：serializer 只留 method／url／status
    serializers: {
      req: (req) => ({ method: req.method, url: req.url, id: req.id }),
    },
  },
  // 唔靠 X-Forwarded-For（可偽造）：rate limit key 見 http.ts clientKey()（只喺 loopback 先信 CF-Connecting-IP）
  trustProxy: false,
  bodyLimit: 1024 * 1024,
  disableRequestLogging: false,
});

let ready = false;

await app.register(websocket, {
  options: { maxPayload: 64 * 1024, perMessageDeflate: false, clientTracking: false },
});
await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 4 } });

registerWs(app, store, hub, env);
registerHttp({ app, store, hub, env, isReady: () => ready });

// 靜態檔（前端 build 產物／HTML）＋ media
// 更新部署後前端要即刻見到新樣式：HTML／CSS／JS 一律 no-cache（每次 revalidate，LAN 304 好快）
await app.register(staticPlugin, {
  root: env.publicDir,
  prefix: "/",
  index: false,
  decorateReply: false,
  cacheControl: false,
  setHeaders: (res: { setHeader(name: string, value: string): void }) => {
    res.setHeader("Cache-Control", "no-cache");
  },
});
// media 用無語義隨機 ID，可以長 cache
await app.register(staticPlugin, {
  root: env.mediaDir,
  prefix: "/media/",
  decorateReply: false,
  cacheControl: false,
  setHeaders: (res: { setHeader(name: string, value: string): void }) => {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  },
});

// ── 背景 tick：自動收卷（250ms） ──
const tickTimer = setInterval(() => {
  try {
    tickAutoClose(store);
    tickLeases(store);
    tickUndercover(store);
  } catch (err) {
    app.log.error({ err }, "tick error");
  }
}, 250);
tickTimer.unref();

// ── 30 秒心跳 ──
const heartbeatTimer = setInterval(() => {
  try {
    hub.heartbeat();
  } catch (err) {
    app.log.error({ err }, "heartbeat error");
  }
}, Number(process.env.HEARTBEAT_MS ?? 30_000));
heartbeatTimer.unref();

// ── graceful shutdown ──
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`[shutdown] ${signal}`);
  try {
    hub.broadcastShutdown("server restarting");
    hub.closeAll(1001, "server restarting");
    clearInterval(tickTimer);
    clearInterval(heartbeatTimer);
    await new Promise((r) => setTimeout(r, 200));
    store.journal.close();
    await app.close();
  } finally {
    process.exit(0);
  }
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException", err);
  try {
    store.journal.close();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error("[fatal] unhandledRejection", err);
  process.exit(1);
});

// ── listen ──
await app.listen({ port: env.port, host: env.host });
ready = true;
(globalThis as { __hbdReady?: boolean }).__hbdReady = true;
const room = store.state.room;
const approotNote = `appRoot=${env.appRoot}`;
app.log.info(
  `[ready] HBD 派對遊戲平台 房碼=${room.code} roomId=${roomId} phase=${room.phase} players=${room.players.length} ${approotNote}`,
);
app.log.info(
  env.isProduction
    ? "[ready] PIN：由 .env 提供（production 唔會 print PIN）"
    : `[ready] 開發模式 PIN=${env.pin}`,
);
app.log.info(`[ready] http://127.0.0.1:${env.port}/stage ／ /host ／ /play ／ /api/ready`);
// 給 auditor／runbook 用嘅開機摘要（唔含 PIN）
app.log.info(
  `[ready] journal: ${journalDir} segments=${loadRes.segments.join(",")} truncated=${loadRes.truncated} seqEpoch=${store.seqEpoch}`,
);

// 保持 buildHostView 被引用（避免未用警告）
void buildHostView;
