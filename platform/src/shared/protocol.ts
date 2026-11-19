/** 協議：WS 訊息、穩定 error code、host command envelope（PLAN-v3.1 §7） */

export const ERROR_CODES = [
  "W_BAD_MSG",
  "W_BAD_SCHEMA",
  "W_ROOM_FULL",
  "W_ROOM_LOCKED",
  "W_WRONG_PHASE",
  "W_STALE_COMMAND",
  "W_CMD_PAYLOAD_MISMATCH",
  "W_ID_PAYLOAD_MISMATCH",
  "W_ROUND_CLOSED",
  "W_ALREADY_STATE",
  "W_SELF_VOTE",
  "W_DUP_NUMBER",
  "W_TOKEN_EXPIRED",
  "W_FORBIDDEN_ROLE",
  "W_RATE_LIMIT",
  "W_UPLOAD_REJECTED",
  "W_RULES_LIMIT",
  "W_RULES_CONFLICT",
  "W_INVALID_OPEN_KIND",
  "W_NO_AUDIO_LEASE",
  "W_AUDIO_READY_TIMEOUT",
  "W_STAGE_LOCKED",
  /** v0.4.0：投票 foul 最高票（同票／冇人投票由主持決定） */
  "W_TIE",
  "W_NO_VOTES",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const CAPS = {
  rooms: 1,
  approvedPlayers: 30,
  pendingPlayers: 10,
  hostSockets: 5,
  stageSockets: 2,
  totalSockets: 60,
} as const;

export type HelloMsg = {
  type: "hello";
  role: "host" | "player" | "stage";
  code: string;
  sessionToken?: string;
  clientInstanceId: string;
  lastSeq?: number;
};

export type ClientMsg =
  | HelloMsg
  | { type: "ping"; clientT0: number }
  | { type: "resync"; lastSeq: number; stateHash?: string }
  | {
      type: "submit";
      roundId: string;
      submissionId: string;
      payloadHash: string;
      payload: { kind: "choice" | "open" | "vote" | "bid"; choice?: number; amount?: number; text?: string; targetId?: string };
    }
  | {
      type: "command";
      commandId: string;
      kind: string;
      targetId?: string;
      expectedRevision?: number;
      expectedRoundId?: string;
      payload: Record<string, unknown>;
    }
  | { type: "leave" }
  | { type: "deck.ready"; deckId: string; songId: string; positionMs?: number };

export type ServerMsg =
  | {
      type: "hello.ok";
      role: "host" | "player" | "stage";
      playerId?: string;
      hostId?: string;
      serverNow: number;
      seqEpoch: string;
      revision: number;
    }
  | { type: "snapshot"; seq: number; seqEpoch: string; serverNow: number; revision: number; stateHash: string; view: unknown }
  | {
      type: "patch";
      baseSeq: number;
      seq: number;
      serverNow: number;
      revision: number;
      ops: PatchOp[];
    }
  | { type: "pong"; clientT0: number; serverNow: number }
  | { type: "submit.result"; roundId: string; submissionId: string; status: "accepted" | "duplicate" | "rejected"; code?: ErrorCode; message?: string; receiptAt?: number }
  | { type: "command.result"; commandId: string; status: "ok" | "error"; code?: ErrorCode; message?: string; revision?: number; result?: unknown }
  | { type: "error"; code: ErrorCode; message: string }
  | { type: "shutdown"; reason: string };

export type PatchOp =
  /** stage／player：一次過換成完整 role-filtered view（細房間，一次恢復完整） */
  | { op: "view"; view: unknown }
  /** host：按段落換（只送有變嘅 section） */
  | { op: "section"; name: string; value: unknown }
  | { op: "toast"; text: string };

export type HostCommand = {
  commandId: string;
  kind: string;
  targetId?: string;
  expectedRevision?: number;
  expectedRoundId?: string;
  payload: Record<string, unknown>;
};

export type ApiOk<T> = { ok: true; revision: number; result?: T };
export type ApiErr = { ok: false; code: ErrorCode; message: string; revision?: number; latest?: unknown };
export type ApiResult<T> = ApiOk<T> | ApiErr;
