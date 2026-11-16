/** 環境變數 + production 啟動禁令（PLAN-v3.1 §9.1） */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** dist/server → platform；src/server（tsx）→ platform */
export const APP_ROOT = path.resolve(HERE, "../..");

const DEFAULT_PINS = new Set([
  "000000",
  "111111",
  "123456",
  "123123",
  "654321",
  "666666",
  "888888",
  "999999",
  "112233",
  "121212",
]);

export type Env = {
  nodeEnv: string;
  isProduction: boolean;
  port: number;
  host: string;
  pin: string;
  dataDir: string;
  mediaDir: string;
  journalDir: string;
  publicDir: string;
  appRoot: string;
  publicOrigins: string[];
  devLanMode: boolean;
  accessRequired: boolean;
  hostTokenTtlMs: number;
  roomCode: string | null;
  autoCloseDefault: boolean;
};

function fail(msg: string): never {
  console.error("[fatal] " + msg);
  process.exit(78); // EX_CONFIG
}

export function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export function scryptHash(secret: string, salt?: string): string {
  const s = salt ?? crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(secret, s, 32).toString("hex");
  return `scrypt$${s}$${hash}`;
}

export function scryptVerify(secret: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, hash] = parts;
  if (!salt || !hash) return false;
  const got = crypto.scryptSync(secret, salt, 32).toString("hex");
  const a = Buffer.from(got, "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseNodeEngines(): { min: number; max: number } | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "package.json"), "utf8")) as {
      engines?: { node?: string };
    };
    const range = pkg.engines?.node;
    if (!range) return null;
    const m = /^>=\s*(\d+)(?:\.\d+)?(?:\.\d+)?\s*<\s*(\d+)/.exec(range);
    if (!m) return null;
    return { min: Number(m[1]), max: Number(m[2]) };
  } catch {
    return null;
  }
}

export function loadEnv(): Env {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const isProduction = nodeEnv === "production";
  const devLanMode = process.env.DEV_LAN_MODE === "1";

  if (isProduction && devLanMode) {
    fail("production 見到 DEV_LAN_MODE=1 → 拒絕啟動（§7 Token/Origin）");
  }

  if (isProduction && (process.env.FAULT_POINT || process.env.FAULT_ENOSPC)) {
    fail("production 唔准開 FAULT_POINT／FAULT_ENOSPC（只限測試）");
  }

  // production 一定要行 compiled JS（唔准 tsx／ts-node）
  const runningFromDist = fileURLToPath(import.meta.url).includes(`${path.sep}dist${path.sep}`);
  if (isProduction && !runningFromDist) {
    fail("production 一定要跑 dist/ compiled JS（唔准 tsx／ts-node 行 production）");
  }

  const engines = parseNodeEngines();
  if (engines) {
    const major = Number(process.versions.node.split(".")[0]);
    if (isProduction && (major < engines.min || major >= engines.max)) {
      fail(`engines.node 唔對：要 >=${engines.min} <${engines.max}，實際 v${process.versions.node}`);
    }
  }

  let pin = (process.env.PIN ?? "").trim();
  if (isProduction) {
    if (!pin) fail("production 缺 PIN → 拒絕啟動（PIN 冇 default）");
    if (DEFAULT_PINS.has(pin)) fail("production 用緊 default PIN → 拒絕啟動");
    if (!/^\d{6,12}$/.test(pin)) fail("PIN 要 6–12 位數字");
  } else if (!pin) {
    pin = String(Math.floor(100000 + Math.random() * 900000));
    console.log(`[dev] 冇 PIN env，隨機產生 PIN=${pin}（production 唔准缺 PIN）`);
  }
  if (DEFAULT_PINS.has(pin)) {
    console.warn(`[warn] 用緊 default PIN「${pin}」，production 會拒絕啟動`);
  }

  const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(APP_ROOT, "data"));
  const mediaDir = path.resolve(process.env.MEDIA_DIR ?? path.join(APP_ROOT, "media"));
  for (const d of [dataDir, mediaDir, path.join(dataDir, "journal")]) {
    fs.mkdirSync(d, { recursive: true });
  }

  if (isProduction) {
    if (process.env.ACCESS_REQUIRED !== "1") {
      console.warn("[warn] production ACCESS_REQUIRED!=1：上線前記得 Cloudflare Access 鎖 /host 同 /api/host/*（RUNBOOK §上線 flip 清單）");
    }
    const placeholder = (process.env.PUBLIC_ORIGINS ?? "").includes("hbd.example.com");
    if (placeholder) console.warn("[warn] PUBLIC_ORIGINS 仲有 placeholder hbd.example.com：正式場要換成真實 hostname");
  }

  const originsRaw =
    process.env.PUBLIC_ORIGINS ??
    "http://127.0.0.1:3000,http://localhost:3000,http://127.0.0.1:30005,http://localhost:30005,http://192.168.99.20:30005";

  return {
    nodeEnv,
    isProduction,
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? "0.0.0.0",
    pin,
    dataDir,
    mediaDir,
    journalDir: path.join(dataDir, "journal"),
    publicDir: path.join(APP_ROOT, "public"),
    appRoot: APP_ROOT,
    publicOrigins: originsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    devLanMode,
    accessRequired: process.env.ACCESS_REQUIRED === "1",
    hostTokenTtlMs: Number(process.env.HOST_TOKEN_TTL_MS ?? 8 * 3600 * 1000),
    roomCode: process.env.ROOM_CODE ? String(process.env.ROOM_CODE) : null,
    autoCloseDefault: (process.env.AUTO_CLOSE ?? "1") !== "0",
  };
}
