/** session token、join（PLAN-v3.1 §7 Token） */
import crypto from "node:crypto";
import type { ErrorCode } from "../shared/protocol.js";
import type { Avatar, Player, Session } from "../shared/types.js";
import type { Store } from "./store.js";
import { newId, now } from "./store.js";
import { scryptVerify } from "./env.js";

export function randomToken(): string {
  return crypto.randomBytes(32).toString("base64url"); // ≥256-bit
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export class AuthError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function verifyPin(store: Store, pin: string): boolean {
  const stored = store.state.settings.pinHash;
  if (!stored) return false;
  return scryptVerify(pin, stored);
}

export function createHostSession(store: Store, hostName: string, ttlMs: number): { token: string; session: Session; hostId: string } {
  const token = randomToken();
  const hostId = newId("host");
  const session: Session = {
    tokenHash: hashToken(token),
    role: "host",
    hostId,
    name: hostName.slice(0, 20),
    createdAt: now(),
    expiresAt: now() + ttlMs,
  };
  store.commit([{ t: "session.add", d: { session } }]);
  return { token, session, hostId };
}

const EMOJI_COLORS = [
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#84cc16",
  "#22c55e",
  "#14b8a6",
  "#06b6d4",
  "#3b82f6",
  "#6366f1",
  "#a855f7",
  "#ec4899",
  "#78716c",
];

export function normalizeAvatar(input: unknown, seed: number): Avatar {
  const a = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const emoji = typeof a.emoji === "string" ? [...a.emoji].slice(0, 2).join("") : "🙂";
  const color =
    typeof a.color === "string" && /^#[0-9a-fA-F]{6}$/.test(a.color)
      ? a.color
      : EMOJI_COLORS[Math.abs(seed) % EMOJI_COLORS.length] ?? "#3b82f6";
  return { kind: "emoji", emoji, color };
}

export function joinRoom(
  store: Store,
  code: string,
  name: string,
  avatarInput: unknown,
  opts: { autoApprove: boolean; ttlMs: number },
): { token: string; playerId: string; number: number; status: Player["status"] } {
  const room = store.state.room;
  if (code !== room.code) throw new AuthError("W_ROOM_LOCKED", "房碼唔啱");
  const trimmed = (name ?? "").trim();
  if (trimmed.length === 0 || trimmed.length > 12) throw new AuthError("W_BAD_SCHEMA", "名要 1–12 字");
  const pending = room.players.filter((p) => p.status === "pending").length;
  const approved = room.players.filter((p) => p.status === "approved").length;
  const willApprove = opts.autoApprove;
  if (willApprove ? approved >= 30 : pending >= 10) throw new AuthError("W_ROOM_FULL", "房間名額已滿");
  const number = room.players.reduce((m, p) => Math.max(m, p.number), 0) + 1;
  const player: Player = {
    id: newId("pl"),
    name: trimmed,
    number,
    groupId: null,
    status: willApprove ? "approved" : "pending",
    connected: false,
    lastSeen: now(),
    avatar: normalizeAvatar(avatarInput, number),
    joinedAt: now(),
  };
  const token = randomToken();
  const session: Session = {
    tokenHash: hashToken(token),
    role: "player",
    playerId: player.id,
    name: player.name,
    createdAt: now(),
    expiresAt: now() + opts.ttlMs,
  };
  store.commit([{ t: "player.add", d: { player, session } }]);
  return { token, playerId: player.id, number, status: player.status };
}
