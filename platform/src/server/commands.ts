/**
 * Host command envelope（PLAN-v3.1 §7）
 * - commandId 冪等：同 ID 同 payload → 回原結果；同 ID 異 payload → W_CMD_PAYLOAD_MISMATCH
 * - expectedRevision / expectedRoundId 對唔上 → W_STALE_COMMAND（回目前狀態）
 * - command＋狀態＋分錄＋receipt 同一筆 journal transaction 落盤（fsync）之後才回 ACK
 * - 破壞性動作靠 expectedRevision 互斥：兩個 host 同時撳只有一個成功
 */
import crypto from "node:crypto";
import type { ErrorCode, HostCommand, ApiResult } from "../shared/protocol.js";
import type {
  AudioLease,
  Award,
  Card,
  CommandReceipt,
  MediaPlayback,
  Player,
  QuizQuestion,
  Room,
  Round,
  RundownItem,
  RulePage,
  ScoreEvent,
  Song,
  StageMode,
  StageState,
  Submission,
} from "../shared/types.js";
import type { Mutation } from "./journal.js";
import type { Store } from "./store.js";
import { newId, uuidv4 } from "./store.js";
import { questionToCard } from "./seed.js";

export class CmdError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

type Ctx = {
  store: Store;
  hostId: string;
  hostName: string;
  cmd: HostCommand;
  muts: Mutation[];
  result?: Record<string, unknown>;
  isHostOnline?: (hostId: string) => boolean;
};

const MODES: StageMode[] = [
  "undercover",
  "idle",
  "rules",
  "scoreboard",
  "question",
  "tally",
  "reveal",
  "draw-wall",
  "draw-focus",
  "bid",
  "vote",
  "role-reveal",
  "song",
  "leaderboard",
  "finale",
  "award",
  "timer",
  "message",
  "game-scores",
  "blackout",
];

/** FIX-5：toast 顯示用中文 mode 名（新 mode 唔好出英文 raw 名） */
const MODE_TOAST_LABEL: Partial<Record<StageMode, string>> = {
  message: "文字公告",
  "game-scores": "分項結算",
};

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function payloadHash(cmd: HostCommand): string {
  return sha256(JSON.stringify({ kind: cmd.kind, targetId: cmd.targetId ?? null, payload: cmd.payload }));
}

export function commandPayloadHash(cmd: HostCommand): string {
  return payloadHash(cmd);
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function reqStr(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  if (typeof v !== "string" || v.length === 0) throw new CmdError("W_BAD_SCHEMA", `缺 ${key}`);
  return v;
}
function optStr(p: Record<string, unknown>, key: string): string | undefined {
  const v = p[key];
  return typeof v === "string" ? v : undefined;
}
function optNum(p: Record<string, unknown>, key: string): number | undefined {
  const v = p[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function reqNum(p: Record<string, unknown>, key: string): number {
  const v = p[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new CmdError("W_BAD_SCHEMA", `缺 ${key}`);
  return v;
}

function push(ctx: Ctx, m: Mutation): void {
  ctx.muts.push(m);
}

function toast(ctx: Ctx, text: string): void {
  push(ctx, {
    t: "activity.add",
    d: { toast: { id: newId("act"), ts: Date.now(), hostName: ctx.hostName, text } },
  });
}

function stageSet(ctx: Ctx, stage: Partial<StageState>): void {
  push(ctx, { t: "stage.set", d: { stage } });
}

/** 黑屏／規則頁都唔可以做「恢復目標」：restore 時一律 fallback idle（否則會再黑一次或者空白） */
function resumableMode(mode: StageMode | undefined): Exclude<StageMode, "blackout" | "rules"> {
  return mode && mode !== "blackout" && mode !== "rules" ? (mode as Exclude<StageMode, "blackout" | "rules">) : "idle";
}

function currentRoundOrThrow(store: Store): Round {
  const r = store.currentRound();
  if (!r) throw new CmdError("W_ALREADY_STATE", "而家冇開住嘅回合");
  return r;
}

function ensurePlaying(store: Store): void {
  if (store.state.room.phase !== "playing") throw new CmdError("W_WRONG_PHASE", "唔係 playing phase");
}

function cardReason(card: Card): string {
  const m = /^q(\d+)$/.exec(card.id);
  if (m) return `問答 Q${m[1]}`;
  if (card.gameId === "auction") return `估歌 ${card.id}`;
  if (card.gameId === "draw") return `畫畫 ${card.id}`;
  return `主持 ${card.id}`;
}

function makeEvent(e: Omit<ScoreEvent, "id" | "ts">): ScoreEvent {
  return { id: newId("ev"), ts: Date.now(), ...e };
}

/** 分數留返原組：void 舊 player 事件 + 一筆 group 補償事件（lineage 指返原事件） */
function transferStay(ctx: Ctx, player: Player, oldGroupId: string): void {
  const events = ctx.store.state.ledger.filter((e) => !e.voided && e.target.type === "player" && e.target.id === player.id);
  if (events.length === 0) return;
  const total = events.reduce((a, e) => a + e.delta, 0);
  push(ctx, { t: "ledger.void", d: { eventIds: events.map((e) => e.id), by: "host" } });
  if (total !== 0) {
    push(ctx, {
      t: "ledger.append",
      d: {
        events: [
          makeEvent({
            target: { type: "group", id: oldGroupId },
            delta: total,
            reason: `換組・分數留原組（${player.name}）`,
            by: "host",
            lineage: { sourceEventIds: events.map((e) => e.id) },
          }),
        ],
      },
    });
  }
}

/** 規則頁 payload：stage.rules 同 stage.set{mode:'rules'} 共用（唔可以有一邊砌漏 title／rulesText 出假頁） */
function rulesStagePayload(ctx: Ctx, item: RundownItem | undefined, pageIdParam?: string): Record<string, unknown> {
  const store = ctx.store;
  let page: RulePage | undefined;
  if (pageIdParam) page = store.state.room.rulePages.find((p) => p.id === pageIdParam);
  if (!page && item?.rulePageId) page = store.state.room.rulePages.find((p) => p.id === item.rulePageId && p.enabled && !p.archived);
  if (!page && item) page = store.activeRulePage(item.gameId);
  const payload: Record<string, unknown> = {
    itemId: item?.id,
    gameId: item?.gameId,
    gameIndex: item ? item.index + 1 : undefined,
    title: item?.title,
    pageIndex: 0,
    fallback: !page,
    rulesText: item?.rulesText ?? "",
  };
  if (page) {
    const pag = store.rulePagination(page);
    payload.rulePageId = page.id;
    payload.totalPages = pag.totalPages;
    payload.autoAdvanceSeconds = page.autoAdvanceSeconds;
  } else {
    payload.totalPages = 1;
    payload.autoAdvanceSeconds = 0;
  }
  return payload;
}

function rulesStageForItem(ctx: Ctx, target?: RundownItem): Partial<StageState> | null {
  const store = ctx.store;
  const item = target ?? store.currentItem();
  if (!item) return null;
  const prev = store.state.room.stage.mode === "rules" || store.state.room.stage.mode === "blackout" ? "idle" : store.state.room.stage.mode;
  return { mode: "rules", payload: rulesStagePayload(ctx, item), prevMode: prev as Exclude<StageMode, "blackout" | "rules"> };
}

function setStageIfUnlocked(ctx: Ctx, stage: Partial<StageState>): void {
  if (ctx.store.state.room.stage.lock) return;
  stageSet(ctx, stage);
}

/** 重排後按 index 重寫「第 N 關」前綴，避免次序改咗但標題仍然寫舊關數 */
function renumberTitle(title: string, idx: number): string {
  const m = title.match(/^第\s*\d+\s*關\s*・\s*(.*)$/);
  return m ? `第 ${idx + 1} 關・${m[1]}` : title;
}

/** start＝由第一關重來（room.start 用）：唔會靜靜 throw，亦唔會留低上一關嘅 running */
type RundownMove = "next" | "prev" | "skip" | "start";

/** 入關／轉關：自動出規則頁（lock=true 唔 override） */
function advanceRundown(ctx: Ctx, targetIndex: number, mode: RundownMove): void {
  const store = ctx.store;
  const room = store.state.room;
  if (room.rundown.length === 0) throw new CmdError("W_ALREADY_STATE", "rundown 係空");
  const cur = store.currentItem();
  const curIndex = cur ? cur.index : -1;
  // 舊 item 狀態
  const rundown = room.rundown.map((i) => ({ ...i }));
  if (mode === "start") {
    for (const i of rundown) if (i.state === "running") i.state = "todo";
  } else if (cur) {
    const old = rundown.find((i) => i.id === cur.id);
    if (old) {
      old.state = mode === "skip" ? "skipped" : "done";
      if (mode === "prev") old.state = "todo";
    }
  }
  let nextIndex: number;
  if (mode === "start") nextIndex = 0;
  else if (mode === "prev") nextIndex = Math.max(0, curIndex - 1);
  else nextIndex = Math.min(rundown.length - 1, curIndex + 1);
  const next = rundown.find((i) => i.index === nextIndex);
  if (!next) throw new CmdError("W_ALREADY_STATE", "冇下一項");
  next.state = "running";
  const allDone = rundown.every((i) => i.state === "done" || i.state === "skipped");
  // 未完 round 一律 void
  const round = store.currentRound();
  if (round) {
    if (round.state === "open" || round.state === "closed" || round.state === "tally") {
      push(ctx, { t: "round.update", d: { roundId: round.id, patch: { state: "void" } } });
    }
    // 任何轉關都唔可以留住上一關嘅 round（revealed 都唔得，否則手機／主持會見到上一關結果）
    push(ctx, { t: "round.current", d: { currentRoundId: null } });
  }
  const newPhase = allDone ? "final" : "playing";
  push(ctx, {
    t: "rundown.set",
    d: { rundown, currentItemId: next.id, phase: newPhase },
  });
  if (allDone) {
    const awards = store.computeAwards();
    push(ctx, { t: "award.set", d: { awards } });
    setStageIfUnlocked(ctx, { mode: "finale", payload: {}, prevMode: "idle" });
  } else {
    // §6.1：轉去另一個 gameId 才自動出規則頁（同 game 連續 item 唔重彈）
    // v0.4.1（codex audit A）：由 final／award「重新開始」時 cur 可能同 next 同 gameId（或者 cur 係封存咗），
    // 一定要出返規則頁，唔好變咗流程 running 但大mon 跳去 idle（又再「兩邊各有各」）。
    const curGame = mode === "start" ? undefined : cur?.gameId;
    if (!curGame || next.gameId !== curGame) {
      const rs = rulesStageForItem(ctx, next);
      if (rs) setStageIfUnlocked(ctx, rs);
    } else if (!room.stage.lock) {
      stageSet(ctx, { mode: "idle", payload: {} });
    }
  }
  const moveLabel = mode === "skip" ? "Skip" : mode === "prev" ? "上一項" : mode === "start" ? "開始" : "下一項";
  toast(ctx, `${moveLabel}：${next.title}`);
}

/** choices 卡揭曉時自動計分（同 round 只派一次） */
function gradeChoiceRound(ctx: Ctx, round: Round, card: Card): void {
  if (typeof card.correct !== "number") return;
  const store = ctx.store;
  const subIds = new Set(store.state.ledger.filter((e) => e.roundId === round.id && e.submissionId).map((e) => e.submissionId));
  const events: ScoreEvent[] = [];
  for (const s of store.submissionsForRound(round.id)) {
    if (!s.confirmed) continue;
    if (subIds.has(s.id)) continue;
    if (s.choice !== card.correct) continue;
    events.push(
      makeEvent({
        target: { type: "player", id: s.playerId },
        gameId: "quiz",
        roundId: round.id,
        cardId: card.id,
        submissionId: s.id,
        delta: card.points,
        reason: cardReason(card),
        by: "auto",
      }),
    );
  }
  if (events.length) push(ctx, { t: "ledger.append", d: { events } });
}

/** 畫畫關揭曉自動計分：人氣票 ×1 + 最高票作品額外 +2（並列都算） */
function gradeDrawRound(ctx: Ctx, round: Round, card: Card): void {
  const store = ctx.store;
  const options = card.options ?? [];
  const works = options.map((assetId) => store.state.assets.find((a) => a.id === assetId)).filter(Boolean);
  const counts = new Map<string, number>(); // authorId -> votes（每張作品每票 +1 畀作者）
  const perWork = new Map<string, number>(); // assetId -> votes
  for (const s of store.submissionsForRound(round.id)) {
    if (!s.confirmed || typeof s.choice !== "number") continue;
    const asset = works[s.choice];
    if (!asset || !asset.authorId) continue;
    counts.set(asset.authorId, (counts.get(asset.authorId) ?? 0) + 1);
    if (asset.id) perWork.set(asset.id, (perWork.get(asset.id) ?? 0) + 1);
  }
  // void 舊 auto 事件（重開／重揭曉）
  const old = store.state.ledger.filter((e) => e.roundId === round.id && e.by === "auto" && !e.voided).map((e) => e.id);
  if (old.length) push(ctx, { t: "ledger.void", d: { eventIds: old, by: "host" } });
  const events: ScoreEvent[] = [];
  for (const [authorId, votes] of counts) {
    events.push(
      makeEvent({
        target: { type: "player", id: authorId },
        gameId: "draw",
        roundId: round.id,
        cardId: card.id,
        delta: votes,
        reason: "畫畫・人氣票",
        by: "auto",
      }),
    );
  }
  const maxVotes = Math.max(0, ...perWork.values());
  if (maxVotes > 0) {
    for (const [assetId, votes] of perWork) {
      if (votes !== maxVotes) continue;
      const asset = works.find((a) => a && a.id === assetId);
      if (!asset?.authorId) continue;
      events.push(
        makeEvent({
          target: { type: "player", id: asset.authorId },
          gameId: "draw",
          roundId: round.id,
          cardId: card.id,
          delta: 2,
          reason: "畫畫・最似獎",
          by: "auto",
        }),
      );
    }
  }
  if (events.length) push(ctx, { t: "ledger.append", d: { events } });
}

/** 估數字最接近者 +2（並列全部 +2）；綁 roundId，重開時由 reopen 嘅 auto-void 清走 */
function gradeClosest(ctx: Ctx, round: Round, card: Card, actual: number): void {
  const store = ctx.store;
  const already = store.state.ledger.some((e) => e.roundId === round.id && e.by === "auto" && e.reason.includes("估數字"));
  if (already) return;
  const subs = store.submissionsForRound(round.id).filter((x) => x.confirmed && typeof x.amount === "number");
  if (!subs.length) return;
  const dist = (x: Submission): number => Math.abs((x.amount ?? 0) - actual);
  const min = Math.min(...subs.map(dist));
  const events = subs
    .filter((x) => dist(x) === min)
    .map((x) =>
      makeEvent({
        target: { type: "player", id: x.playerId },
        gameId: "quiz",
        roundId: round.id,
        cardId: card.id,
        submissionId: x.id,
        delta: 2,
        reason: `${cardReason(card)}・估數字`,
        by: "auto",
      }),
    );
  if (events.length) push(ctx, { t: "ledger.append", d: { events } });
}

/** v0.3.0：開放數字題容差評分（Q12 ±2 尺）——|amount - actual| <= tolerance → 全部 +points。
 *  冇 tolerance 嘅題維持舊行為「最接近 +2」（gradeClosest）。 */
function gradeToleranceRound(ctx: Ctx, round: Round, card: Card, actual: number): void {
  if (typeof card.tolerance !== "number") return;
  const store = ctx.store;
  // 同一筆 transaction 入面已經 void 咗嘅舊分要當唔存在（quiz.setActualAnswer 重新輸入答案）
  const pendingVoid = new Set<string>();
  for (const m of ctx.muts) {
    if (m.t !== "ledger.void") continue;
    for (const id of (m.d.eventIds as string[]) ?? []) pendingVoid.add(id);
  }
  const already = new Set(
    store.state.ledger
      .filter((e) => e.roundId === round.id && e.submissionId && !e.voided && !pendingVoid.has(e.id))
      .map((e) => e.submissionId),
  );
  const events: ScoreEvent[] = [];
  for (const s of store.submissionsForRound(round.id)) {
    if (!s.confirmed || typeof s.amount !== "number") continue;
    if (already.has(s.id)) continue;
    if (Math.abs(s.amount - actual) > card.tolerance) continue;
    events.push(
      makeEvent({
        target: { type: "player", id: s.playerId },
        gameId: "quiz",
        roundId: round.id,
        cardId: card.id,
        submissionId: s.id,
        delta: card.points,
        reason: `${cardReason(card)}・容差`,
        by: "auto",
      }),
    );
  }
  if (events.length) push(ctx, { t: "ledger.append", d: { events } });
}

/** 估數字：收卷 transaction 固定 closedAt → 用 Asia/Hong_Kong 計到下一個 00:00 嘅完整分鐘 */
export function minutesToMidnightHK(closedAt: number): number {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(closedAt));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const y = get("year");
  const mo = get("month");
  const d = get("day");
  const hh = get("hour") === 24 ? 0 : get("hour");
  const mm = get("minute");
  const ss = get("second");
  const consumedMs = ((hh * 3600 + mm * 60 + ss) * 1000 + (closedAt % 1000)) * 1;
  const dayMs = 24 * 3600 * 1000;
  return Math.floor((dayMs - consumedMs) / 60000);
}

/** 回傳 true＝呢次收卷已經由搗蛋鬼計票結算咗（round 已 revealed），caller 唔好再蓋 tally State */
function closeRoundMutations(ctx: Ctx, round: Round, card: Card | undefined, auto: boolean): boolean {
  const closedAt = Date.now();
  const patch: Partial<Round> = { state: "closed", closedAt };
  if (auto) patch.autoClosed = true;
  let actualAnswer: number | undefined;
  if (card?.autoAnswer === "minutes-to-midnight") {
    // 只記答案（由收卷時刻計），唔喺收卷加分 —— 加分留到「揭曉」（主持開正確答案）先做
    actualAnswer = minutesToMidnightHK(closedAt);
    patch.actualAnswer = actualAnswer;
    push(ctx, { t: "card.update", d: { cardId: card.id, patch: { actualAnswer } } });
  } else if (card && typeof card.tolerance === "number" && typeof card.actualAnswer === "number") {
    // v0.3.3：同樣只記答案，唔喺收卷加分
    actualAnswer = card.actualAnswer;
    patch.actualAnswer = actualAnswer;
  }
  push(ctx, { t: "round.update", d: { roundId: round.id, patch } });
  if (card) push(ctx, { t: "card.update", d: { cardId: card.id, patch: { state: "closed" } } });
  setStageIfUnlocked(ctx, { mode: "tally", payload: { roundId: round.id, cardId: card?.id ?? null } });
  // v0.3.3：收卷只係封卷＋出分佈；所有自動評分（MC／容差／最接近）一律留到 card.reveal，
  // 主持「開正確答案」嗰一刻先派分（以前收卷就加分，主持未講答案大mon 已經見分）。
  // 搗蛋鬼投票卡：generic 收卷／auto-close 都要即刻計票結算，唔可以留低一個等 command 但 state 已撞死嘅 round
  return card && card.gameId === "saboteur" ? tallySaboteurIfAny(ctx, round) : false;
}


/* ───────────── M2：media deck／AudioLease ／ M3：畫畫 ／ M4：搗蛋鬼 ───────────── */

/** 每次入 preparing 都要重新起算 ready 期限；沿用舊值會被 tickLeases 即刻判 failed（codex 第五輪 #1b） */
function audioReadyDeadline(): number {
  return Date.now() + Number(process.env.AUDIO_READY_TIMEOUT_MS ?? 15_000);
}

function leaseDeck(ctx: Ctx, deckIdRaw: string | undefined): string {
  const deck = deckIdRaw || `${ctx.hostId}:deck`;
  const lease = ctx.store.state.room.audioLease;
  if (!lease) throw new CmdError("W_NO_AUDIO_LEASE", "未有音源 lease（先申請）");
  if (lease.deckId !== deck) throw new CmdError("W_NO_AUDIO_LEASE", `而家由 ${lease.deckId} 出聲`);
  if (lease.leaseUntil < Date.now()) throw new CmdError("W_NO_AUDIO_LEASE", "lease 已過期（請重新接管）");
  return deck;
}

function ownerDeck(ctx: Ctx, deckIdRaw: string | undefined): string {
  return deckIdRaw || `${ctx.hostId}:deck`;
}

function sourceKindOf(url: string): { kind: "youtube" | "apple" | "external"; url: string } {
  const u = url.trim();
  if (u.includes("youtu")) return { kind: "youtube", url: u };
  if (u.includes("music.apple.com")) return { kind: "apple", url: u };
  return { kind: "external", url: u };
}

/** v0.3.0 拍賣時間估歌：最少秒數先聽；同秒 → 最後提交（ts 最大）先。
 *  0 秒＝冇競投到（ws 已經擋，呢度再濾一次）。 */
export function bidRanking(store: Store, roundId: string): Submission[] {
  // B7：同秒要用「持久提交順序」（submissions 陣列位置，後加入排前），唔可以用 id 字典序
  const order = new Map(store.state.submissions.map((x, i) => [x.id, i]));
  return store
    .submissionsForRound(roundId)
    .filter((x) => x.confirmed && typeof x.amount === "number" && (x.amount ?? 0) >= 1)
    .sort(
      (a, b) =>
        (a.amount ?? 0) - (b.amount ?? 0) ||
        (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0) ||
        b.ts - a.ts ||
        a.id.localeCompare(b.id),
    );
}

/** P1-f：round 到期（endsAt 已過）就一律拒新提交（所有卡類） */
export function roundExpired(endsAt: number | null, nowMs: number): boolean {
  return endsAt !== null && nowMs > endsAt;
}

/** P1-f：競投秒數唔可以多過剩餘秒數（明確規則：容許 +1 秒網絡誤差） */
export function bidSecondsAllowed(amount: number, endsAt: number | null, nowMs: number): boolean {
  if (endsAt === null) return true;
  const remaining = Math.ceil(Math.max(0, endsAt - nowMs) / 1000);
  return amount <= remaining + 1;
}

function bidWinner(store: Store, roundId: string): { submission: Submission | undefined; second: Submission | undefined } {
  const ranked = bidRanking(store, roundId);
  return { submission: ranked[0], second: ranked[1] };
}

function songIndex(store: Store, songId: string): number {
  return store.state.songs.findIndex((s) => s.id === songId);
}

function saboteurState(store: Store): NonNullable<NonNullable<Room["gameState"]>["saboteur"]> {
  const st = store.state.room.gameState?.saboteur;
  if (!st) throw new CmdError("W_ALREADY_STATE", "未派身份（先 saboteur.assign）");
  return st;
}

type SaboteurRec = NonNullable<NonNullable<Room["gameState"]>["saboteur"]>;

/** 深 copy 一份先改，commit（fsync）成功後記憶體先真正套用（§9.1.1：唔准改 live state 先過 journal） */
function cloneSaboteur(store: Store): SaboteurRec {
  return JSON.parse(JSON.stringify(saboteurState(store))) as SaboteurRec;
}

/** 兩輪「邏輯輪次」完成 → 搗蛋鬼潛伏成功 +5。st.finished 之後永遠唔會再派（+5 只頒一次）。
 *  retry 會將舊 record 標 resolved＋decision='retry'，同 index 嘅新 record 再 resolve，唔可以計兩次。
 *  回傳 true＝今次啱啱完結（caller 負責 push game.set／stage.set／toast）。 */
function saboteurAwardsLatentOnce(ctx: Ctx, st: SaboteurRec): boolean {
  if (st.finished) return false;
  const roundsDone = new Set(st.rounds.filter((r) => r.state === "resolved" && r.decision !== "retry").map((r) => r.index)).size;
  if (roundsDone < 2) return false;
  st.finished = true;
  st.revealedRole = "saboteur";
  const sab = ctx.store.player(st.saboteurId ?? "");
  if (sab) {
    push(ctx, {
      t: "ledger.append",
      d: {
        events: [
          makeEvent({ target: { type: "player", id: sab.id }, gameId: "saboteur", delta: 5, reason: "搗蛋鬼・潛伏成功", by: "auto" }),
        ],
      },
    });
  }
  return true;
}

/** 淘汰一位玩家（只改傳入嘅 clone；caller 負責 push game.set）；搗蛋鬼被淘汰＝揪中 */
function eliminateSaboteur(ctx: Ctx, st: NonNullable<NonNullable<Room["gameState"]>["saboteur"]>, targetId: string, decisiveRoundId: string): void {
  const store = ctx.store;
  const target = store.player(targetId);
  if (!target) throw new CmdError("W_BAD_SCHEMA", "冇呢個玩家");
  if (st.eliminatedIds.includes(targetId)) throw new CmdError("W_ALREADY_STATE", "已經淘汰咗");
  const round = store.round(decisiveRoundId);
  const roundOut = st.rounds.find((r) => r.roundId === decisiveRoundId);
  st.eliminatedIds = [...st.eliminatedIds, targetId];
  if (roundOut) {
    roundOut.eliminatedId = targetId;
    roundOut.state = "resolved";
    roundOut.decision = "eliminated";
  }
  if (targetId === st.saboteurId) {
    st.caught = true;
    st.finished = true;
    st.revealedRole = "saboteur";
    const voters = store
      .submissionsForRound(decisiveRoundId)
      .filter((x) => x.confirmed && x.kind === "vote" && x.text === targetId);
    for (const v of voters) {
      push(ctx, {
        t: "ledger.append",
        d: {
          events: [
            makeEvent({
              target: { type: "player", id: v.playerId },
              gameId: "saboteur",
              roundId: decisiveRoundId,
              cardId: round?.cardId,
              submissionId: v.id,
              delta: 3,
              reason: "搗蛋鬼・揪中",
              by: "auto",
            }),
          ],
        },
      });
    }
    if (round) {
      push(ctx, { t: "round.update", d: { roundId: decisiveRoundId, patch: { state: "revealed" } } });
      push(ctx, { t: "card.update", d: { cardId: round.cardId, patch: { state: "revealed" } } });
    }
    push(ctx, { t: "game.set", d: { gameState: { saboteur: st } } });
    push(ctx, {
      t: "stage.set",
      d: { stage: { mode: "role-reveal", payload: { roundId: decisiveRoundId, caught: true, saboteurId: st.saboteurId }, prevMode: "vote" } },
    });
    toast(ctx, `揪中搗蛋鬼：${target.name}！投中者各 +3`);
    ctx.result = { caught: true, saboteurId: st.saboteurId, voters: voters.length, mode: "eliminate" };
    return;
  }
  if (round) push(ctx, { t: "round.update", d: { roundId: decisiveRoundId, patch: { state: "revealed" } } });
  if (saboteurAwardsLatentOnce(ctx, st)) {
    push(ctx, { t: "game.set", d: { gameState: { saboteur: st } } });
    push(ctx, { t: "stage.set", d: { stage: { mode: "role-reveal", payload: { caught: false, saboteurId: st.saboteurId }, prevMode: "vote" } } });
    toast(ctx, `兩輪都揪唔中：搗蛋鬼 +5`);
    ctx.result = { caught: false, finished: true, mode: "eliminate" };
  } else {
    push(ctx, { t: "game.set", d: { gameState: { saboteur: st } } });
    toast(ctx, `淘汰咗 ${target.name}（唔係搗蛋鬼），仲有第 2 輪`);
    ctx.result = { caught: false, finished: false, nextRound: 2, mode: "eliminate" };
  }
}

type SaboteurRoundRec = SaboteurRec["rounds"][number];

/** 仲未結算（state !== 'resolved'）嘅搗蛋鬼輪次＝仍然等主持 saboteur.decide。
 *  唔可以靠 current round 嘅 display state 判斷：generic card.reveal 會將 round 變 revealed，
 *  但 record 仍然 closed／decision:null，於是下一輪就開得，偷走中間輪次。 */
function unsettledSaboteurRounds(store: Store): SaboteurRoundRec[] {
  const st = store.state.room.gameState?.saboteur;
  if (!st) return [];
  return st.rounds.filter((r) => {
    if (r.state === "resolved") return false;
    const live = store.round(r.roundId);
    // 已被 rundown 轉關 void 咗（advanceRundown）：唔算等裁決，否則主持轉關之後永遠開唔返下一輪
    return !live || live.state !== "void";
  });
}

/** 搗蛋鬼計票＋結算嘅唯一入口：saboteur.closeRound、card.close／card.tally（closeRoundMutations）、tickAutoClose 都經呢度。
 *  一個 round 只結算一次：已 resolved 直接 reject（唔會重複派分／重複淘汰）。
 *  未過半／平票／全體棄權 → 留 rOut=closed 等主持 saboteur.decide（decide 只睇 rOut.state，唔會因為 round 已 closed 而卡死）。 */
function tallySaboteurRound(
  ctx: Ctx,
  st: SaboteurRec,
  round: Round,
): { validVotes: number; top: { playerId: string; name: string; count: number }[]; mode: "eliminate" | "decide" | "none" } {
  const store = ctx.store;
  const rOut = st.rounds.find((r) => r.roundId === round.id);
  if (!rOut) throw new CmdError("W_BAD_SCHEMA", "唔係搗蛋鬼 round");
  if (rOut.state === "resolved") throw new CmdError("W_ALREADY_STATE", `第 ${rOut.index} 輪已結算`);
  // finished 之後唔准再結算（finish 已經頒咗 +5；再 tally 會頒投票者 +3 而同 caught 矛盾）
  if (st.finished) throw new CmdError("W_ALREADY_STATE", "搗蛋鬼遊戲已完結，唔可以再結算");
  const subs = store.submissionsForRound(round.id).filter((x) => x.confirmed && x.kind === "vote");
  const counts = new Map<string, number>();
  for (const x of subs) {
    const target = x.text ?? "";
    if (!target) continue;
    counts.set(target, (counts.get(target) ?? 0) + 1);
  }
  const validVotes = subs.filter((x) => x.text && x.text.length > 0).length;
  rOut.votes = subs.map((x) => ({ voterId: x.playerId, targetId: x.text ?? null }));
  rOut.state = "closed";
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || String(store.player(a[0])?.number ?? 0).localeCompare(String(store.player(b[0])?.number ?? 0)));
  const top = ranked[0];
  const topCount = top ? top[1] : 0;
  const tied = ranked.filter(([, c]) => c === topCount);
  const majority = validVotes > 0 && topCount >= Math.floor(validVotes / 2) + 1;
  const mode: "eliminate" | "decide" | "none" = validVotes === 0 ? "none" : majority && tied.length === 1 ? "eliminate" : "decide";
  const result = { validVotes, top: ranked.map(([id, count]) => ({ playerId: id, name: store.player(id)?.name ?? "?", count })), mode };
  if (mode === "eliminate" && top) {
    eliminateSaboteur(ctx, st, top[0], round.id);
  } else if (mode === "none") {
    // 全體棄票＝呢輪冇人淘汰，但一樣要結算：留低 closed＋decision:null 會令下一輪永遠 W_ALREADY_STATE
    rOut.state = "resolved";
    rOut.decision = "none";
    rOut.eliminatedId = null;
    push(ctx, { t: "round.update", d: { roundId: round.id, patch: { state: "revealed", closedAt: round.closedAt ?? Date.now() } } });
    const card0 = store.card(round.cardId);
    if (card0) push(ctx, { t: "card.update", d: { cardId: card0.id, patch: { state: "revealed" } } });
    const finished = saboteurAwardsLatentOnce(ctx, st);
    push(ctx, { t: "game.set", d: { gameState: { saboteur: st } } });
    if (finished) {
      push(ctx, { t: "stage.set", d: { stage: { mode: "role-reveal", payload: { caught: false, saboteurId: st.saboteurId }, prevMode: "vote" } } });
      toast(ctx, "兩輪都冇人揪中：搗蛋鬼 +5");
      ctx.result = { caught: false, finished: true, mode: "none" };
    } else {
      setStageIfUnlocked(ctx, { mode: "tally", payload: { roundId: round.id, cardId: round.cardId, saboteurRound: rOut.index }, prevMode: "vote" });
      toast(ctx, `第 ${rOut.index} 輪全體棄票：冇人淘汰（可以開下一輪）`);
      ctx.result = { caught: false, finished: false, nextRound: rOut.index + 1, mode: "none" };
    }
  } else {
    push(ctx, { t: "game.set", d: { gameState: { saboteur: st } } });
    push(ctx, { t: "round.update", d: { roundId: round.id, patch: { state: "closed", closedAt: round.closedAt ?? Date.now() } } });
    const card = store.card(round.cardId);
    if (card) push(ctx, { t: "card.update", d: { cardId: card.id, patch: { state: "tally" } } });
    setStageIfUnlocked(ctx, { mode: "tally", payload: { roundId: round.id, cardId: round.cardId, saboteurRound: rOut.index }, prevMode: "vote" });
  }
  return result;
}

/** generic 收卷（card.close／card.tally／auto-close）收到搗蛋鬼投票卡時：即刻計票結算。
 *  唔係搗蛋鬼 round／未派身份／已結算 → 乜都唔做（唔會阻住普通卡收卷）。 */
function tallySaboteurIfAny(ctx: Ctx, round: Round): boolean {
  const st0 = ctx.store.state.room.gameState?.saboteur;
  const rOut0 = st0?.rounds.find((r) => r.roundId === round.id);
  // 已完結（finish 頒咗 +5）或已結算：乜都唔做，只留返 generic 收卷本身
  if (!st0 || st0.finished || !rOut0 || rOut0.state === "resolved") return false;
  const st = cloneSaboteur(ctx.store);
  tallySaboteurRound(ctx, st, round);
  return st.rounds.some((r) => r.roundId === round.id && r.state === "resolved");
}

/** lease 到期／ready timeout／window 到期：server 側自動處理（防雙響＋播 15 秒真承諾） */
export function tickLeases(store: Store): boolean {
  const lease = store.state.room.audioLease;
  const muts: Mutation[] = [];
  if (lease && !lease.releasedAt && lease.leaseUntil <= Date.now()) {
    muts.push({ t: "lease.set", d: { lease: { ...lease, releasedAt: Date.now() } } });
    const pb0 = store.state.playback;
    if (pb0 && pb0.deckId === lease.deckId && (pb0.state === "playing" || pb0.state === "preparing")) {
      const positionMs = pb0.positionMs + Math.max(0, Date.now() - pb0.playStartedAt);
      muts.push({ t: "media.set", d: { playback: { ...pb0, state: "paused", positionMs, pausedAt: Date.now() } } });
    }
  }
  const pb = store.state.playback;
  if (pb && pb.state === "preparing" && typeof pb.readyDeadline === "number" && Date.now() > pb.readyDeadline) {
    muts.push({ t: "media.set", d: { playback: { ...pb, state: "failed" } } });
  }
  if (pb && pb.state === "playing" && Array.isArray(pb.window) && Number.isFinite(pb.window[1])) {
    const elapsed = pb.positionMs + Math.max(0, Date.now() - pb.playStartedAt);
    if (elapsed >= pb.window[1]) {
      muts.push({ t: "media.set", d: { playback: { ...pb, state: "paused", positionMs: pb.window[1], pausedAt: Date.now() } } });
    }
  }
  if (!muts.length) return false;
  store.commit(muts, { bumpRevision: true });
  return true;
}

/* ───────────────────── 自動收卷 tick（伺服器權威 endsAt + auto-close） ───────────────────── */
export function tickAutoClose(store: Store): boolean {
  const round = store.currentRound();
  if (!round || round.state !== "open") return false;
  const card = store.card(round.cardId);
  if (!card) return false;
  // 臥底投票由 tickUndercover 固定時間開票（唔跟 autoClose，亦唔可以俾 generic auto-close 搶先收卷變 tally 畫面）
  if (card.gameId === "draw" && card.voteMode === "players" && card.options?.length) return false;
  const nowMs = Date.now();
  // §3.1：auto-close 關咗就只可以主持手動收（時間到都唔自動收）
  const timeUp = store.state.settings.autoClose && round.endsAt !== null && nowMs >= round.endsAt;
  const stats = store.answerStats(round);
  const allAnswered = store.state.settings.autoClose && stats.eligible > 0 && stats.answered >= stats.eligible;
  if (!timeUp && !allAnswered) return false;
  // 同一時間只有一個 tick 會執行（single-thread sync）
  const muts: Mutation[] = [];
  const ctx: Ctx = { store, hostId: "system", hostName: "系統", cmd: { commandId: "auto", kind: "auto.close", payload: {} }, muts };
  push(ctx, { t: "activity.add", d: { toast: { id: newId("act"), ts: nowMs, hostName: "系統", text: timeUp ? "時間到，自動收卷" : "全員答完，自動收卷" } } });
  closeRoundMutations(ctx, round, card, true);
  store.commit(muts, { bumpRevision: true });
  return true;
}

/* ── 臥底投票（畫畫關：紙本出題，手機投票） ── */
const UNDERCOVER_PROMPT = "請投出你心目中嘅臥底";

function finalizeUndercover(ctx: Ctx, round: Round, card: Card, auto: boolean): void {
  const closedAt = Date.now();
  push(ctx, { t: "round.update", d: { roundId: round.id, patch: { state: "revealed", closedAt } } });
  push(ctx, { t: "card.update", d: { cardId: card.id, patch: { state: "revealed" } } });
  setStageIfUnlocked(ctx, { mode: "undercover", payload: { roundId: round.id, cardId: card.id } });
  toast(ctx, auto ? "投票時間到，開票！" : "開票！");
}

/** 固定投票時間到就自動開票（唔跟 settings.autoClose：派對固定 10 秒流程） */
export function tickUndercover(store: Store): boolean {
  const round = store.currentRound();
  if (!round || round.state !== "open") return false;
  const card = store.card(round.cardId);
  if (!card || card.gameId !== "draw" || card.voteMode !== "players") return false;
  if (round.endsAt === null || Date.now() < round.endsAt) return false;
  const muts: Mutation[] = [];
  const ctx: Ctx = { store, hostId: "system", hostName: "系統", cmd: { commandId: "auto", kind: "undercover.auto", payload: {} }, muts };
  push(ctx, { t: "activity.add", d: { toast: { id: newId("act"), ts: Date.now(), hostName: "系統", text: "投票時間到，自動開票" } } });
  finalizeUndercover(ctx, round, card, true);
  store.commit(muts, { bumpRevision: true });
  return true;
}

/* ── v0.4.0：唯一一條「畫畫關投票」code path（undercover.start／uc.vote.start 都行呢個） ── */

type StartDrawVoteOpts = {
  /** 只准呢批人做候選（一圖多人局用）；唔傳＝全部 approved */
  participantIds?: string[] | null;
  /** 一定唔准做候選（已出局／主持剔走） */
  excludeIds?: string[];
  durationSeconds?: number;
  /** 有＝重用／更新呢張投票卡（card_ucmatch）；冇＝開新卡 card_undercover_<ts> */
  cardId?: string | null;
};

/** 開一輪「畫畫關：手機投票揀人」回合。
 *  候選 ＝ approved ∩（有 participantIds 就只用佢）− excludeIds；
 *  eligiblePlayerIds ＝ 候選（已出局／被剔走嘅人唔可以投）。 */
function startDrawVote(ctx: Ctx, opts: StartDrawVoteOpts = {}): { round: Round; card: Card; candidates: string[] } {
  const store = ctx.store;
  const room = store.state.room;
  const exclude = opts.excludeIds ?? [];
  const rawDur = Number(opts.durationSeconds ?? 10);
  const durationSeconds = Math.max(5, Math.min(60, Math.round(Number.isFinite(rawDur) ? rawDur : 10)));
  const openRound = store.currentRound();
  if (openRound && (openRound.state === "open" || openRound.state === "closed" || openRound.state === "tally"))
    throw new CmdError("W_ALREADY_STATE", "仲有回合未完成，先開票或 void");
  const only = Array.isArray(opts.participantIds) ? new Set(opts.participantIds) : null;
  const candidates = store
    .approvedPlayers()
    .map((x) => x.id)
    .filter((id) => (only ? only.has(id) : true))
    .filter((id) => !exclude.includes(id));
  if (candidates.length < 2) throw new CmdError("W_BAD_SCHEMA", "至少要兩個候選人");
  const reuseId = typeof opts.cardId === "string" && opts.cardId.length > 0 ? opts.cardId : null;
  const cardId = reuseId ?? `card_undercover_${Date.now()}`;
  let card = store.card(cardId);
  let cardVersion: number;
  if (card) {
    cardVersion = (card.version ?? 1) + 1;
    push(ctx, {
      t: "card.update",
      d: { cardId, patch: { prompt: UNDERCOVER_PROMPT, options: candidates, seconds: durationSeconds, version: cardVersion } },
    });
    card = { ...card, prompt: UNDERCOVER_PROMPT, options: candidates, seconds: durationSeconds, version: cardVersion };
  } else {
    cardVersion = 1;
    card = {
      id: cardId,
      type: "vote",
      gameId: "draw",
      voteMode: "players",
      prompt: UNDERCOVER_PROMPT,
      options: candidates,
      seconds: durationSeconds,
      points: 0,
      version: 1,
      state: "draft",
    };
    push(ctx, { t: "card.put", d: { card } });
    const item = store.currentItem();
    if (item) {
      const rundown = room.rundown.map((i) => (i.id === item.id ? { ...i, cardIds: [...i.cardIds, cardId] } : { ...i }));
      push(ctx, { t: "rundown.set", d: { rundown, currentItemId: room.currentItemId, phase: room.phase } });
    }
  }
  const openCount = room.rounds.filter((r) => r.cardId === cardId).length + 1;
  const round: Round = {
    id: `${cardId}#${openCount}`,
    cardId,
    cardVersion,
    endsAt: Date.now() + durationSeconds * 1000,
    closedAt: null,
    state: "open",
    // fix(v04-B)：選民＝候選（舊 undercover.start 用晒全部 approved，已出局／被剔走都可以投）
    eligiblePlayerIds: candidates,
  };
  push(ctx, { t: "round.put", d: { round, currentRoundId: round.id } });
  push(ctx, { t: "card.update", d: { cardId, patch: { state: "open" } } });
  setStageIfUnlocked(ctx, { mode: "undercover", payload: { roundId: round.id, cardId } });
  return { round, card, candidates };
}

/** 讀一輪投票嘅 confirmed 票（targetId → 票數） */
function drawVoteTally(store: Store, round: Round): Map<string, number> {
  const counts = new Map<string, number>();
  for (const x of store.state.submissions) {
    if (x.roundId !== round.id || !x.confirmed || x.kind !== "vote") continue;
    const target = (x.text ?? "").trim();
    if (!target) continue;
    counts.set(target, (counts.get(target) ?? 0) + 1);
  }
  return counts;
}

/* ── v0.3.0：一圖多人（畫畫臥底）——state helpers ── */

type UcMatch = NonNullable<NonNullable<Room["gameState"]>["undercover"]>;

function shuffled<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

function ucMatchState(store: Store): UcMatch {
  const st = store.state.room.gameState?.undercover;
  if (!st) throw new CmdError("W_ALREADY_STATE", "未開局（先 uc.match.start）");
  return st;
}

/** 深 copy 一份先改，commit（fsync）成功後記憶體先真正套用 */
function cloneUcMatch(store: Store): UcMatch {
  return JSON.parse(JSON.stringify(ucMatchState(store))) as UcMatch;
}

function ucRemainingUndercover(st: UcMatch): number {
  return st.undercoverIds.filter((id) => !st.eliminatedIds.includes(id)).length;
}

/** B4：本題 foul 咗幾多人（同一題只准一個） */
function ucQuestionElimCount(st: UcMatch): number {
  const map = st.eliminatedByQuestion ?? {};
  return Object.values(map).filter((q) => q === st.questionNo).length;
}

/** B4：本題已經 foul 過人（可以換下一題） */
function ucQuestionDone(st: UcMatch): boolean {
  return ucQuestionElimCount(st) >= 1;
}

/** foul 一個人出局（uc.eliminate＝主持指定；uc.vote.foulTop＝server 計最高票之後叫佢）。
 *  前置條件同 v0.3.0 一樣：本題要開過投票兼已收卷、本題未 foul 過、唔可以 foul 已出局者。 */
function ucEliminateOne(ctx: Ctx, targetId: string): { targetId: string; wasUndercover: boolean; remaining: number } {
  const store = ctx.store;
  const st = cloneUcMatch(store);
  if (st.settled) throw new CmdError("W_ALREADY_STATE", "本局已結算");
  // B4：只准「已開投票並且已收卷」之後 foul（未投票唔可以淘汰）
  const liveRound = st.roundId ? store.round(st.roundId) : undefined;
  if (!liveRound || liveRound.state === "open")
    throw new CmdError("W_WRONG_PHASE", "本題未收卷：先「開投票（10 秒）」等開票，再 foul");
  if (ucQuestionDone(st)) throw new CmdError("W_ALREADY_STATE", "呢題已經 foul 咗一個，請撳「下一題／結算」");
  if (!st.participantIds.includes(targetId)) throw new CmdError("W_BAD_SCHEMA", "呢個人唔係本局參賽者");
  if (st.eliminatedIds.includes(targetId)) throw new CmdError("W_ALREADY_STATE", "已經淘汰咗");
  st.eliminatedIds = [...st.eliminatedIds, targetId];
  st.eliminatedByQuestion = { ...(st.eliminatedByQuestion ?? {}), [targetId]: st.questionNo };
  const wasUndercover = st.undercoverIds.includes(targetId);
  const remaining = ucRemainingUndercover(st);
  if (remaining === 0) st.result = "good";
  push(ctx, { t: "game.set", d: { gameState: { undercover: st } } });
  const target = store.player(targetId);
  stageSet(ctx, {
    mode: "message",
    payload: {
      title: wasUndercover ? "係臥底！" : "唔係臥底",
      lines: [
        `#${target?.number ?? "?"} ${target?.name ?? "?"} 出局`,
        remaining === 0 ? "所有臥底已出局 → 好人勝（撳「結算」加分）" : `仲有 ${remaining} 個臥底未出局`,
      ],
      tone: wasUndercover ? "good" : "bad",
    },
    prevMode: resumableMode(store.state.room.stage.mode),
  });
  toast(ctx, `${target?.name ?? targetId}：${wasUndercover ? "係臥底" : "唔係臥底"}（仲有 ${remaining} 個）`);
  return { targetId, wasUndercover, remaining };
}

/** v0.4.2：畫畫關「揀題目」共用邏輯（uc.topic.pick／uc.topic.reroll 同一條路）。
 *  只改題目相關欄位：promptCardId／topicIds[questionNo]／usedTopicIds／promptRevealed；
 *  唔准掂 participants／undercoverIds／eliminatedIds／round（換題唔等於換局）。 */
function ucApplyTopic(ctx: Ctx, card: Card): { cardId: string; questionNo: number; prompt: string; undercoverPrompt: string } {
  const store = ctx.store;
  const st = cloneUcMatch(store);
  if (st.settled) throw new CmdError("W_ALREADY_STATE", "本局已結算，唔可以換題目");
  if (card.gameId !== "draw" || typeof card.undercoverPrompt !== "string" || card.undercoverPrompt.length === 0)
    throw new CmdError("W_BAD_SCHEMA", "呢張卡唔係一圖多人題目（要 gameId=draw 兼有 undercoverPrompt）");
  if ((st.participantIds ?? []).length === 0) throw new CmdError("W_ALREADY_STATE", "未開局（先撳「開新一局」）");
  const liveRound = st.roundId ? store.round(st.roundId) : undefined;
  if (liveRound && liveRound.state === "open")
    throw new CmdError("W_ALREADY_STATE", "投票進行中，唔可以換題目（等開票或者撳「立即開票」先）");
  st.promptCardId = card.id;
  const topicIds = [...(st.topicIds ?? [])];
  topicIds[st.questionNo] = card.id;
  st.topicIds = topicIds;
  st.usedTopicIds = [...new Set([...(st.usedTopicIds ?? []), card.id])];
  st.promptRevealed = false; // 換題要重新公佈（大mon 唔會殘留上一對嘅好人題）
  push(ctx, { t: "game.set", d: { gameState: { undercover: st } } });
  toast(ctx, `第 ${st.questionNo + 1} 題用咗：${card.prompt}`);
  return { cardId: card.id, questionNo: st.questionNo + 1, prompt: card.prompt, undercoverPrompt: card.undercoverPrompt };
}

/** 一圖多人結算：好人勝→全部好人 +1／臥底勝→全部臥底 +1；未出局者每人 +2（同上面疊加）。
 *  冪等：matchId 去重 ＋ settled 擋，重複撳唔會再加。 */
function settleUndercoverMatch(ctx: Ctx, st: UcMatch, result: "good" | "undercover"): { added: number; result: "good" | "undercover" } {
  const store = ctx.store;
  // v0.4.1（codex audit INT）：用永久唯一 matchUid。以前用 uc_m<matchNo>，rundown.reset 之後
  // 新局又係 matchNo=1，會被當成上一局重複而漏派分（實測 8 筆變 2 筆）。
  const matchId = st.matchUid ?? `uc_m${st.matchNo}`;
  st.result = result;
  st.settled = true;
  const already = new Set(
    store.state.ledger.filter((e) => !e.voided && e.matchId === matchId).map((e) => `${e.target.id}|${e.reason}`),
  );
  const events: ScoreEvent[] = [];
  const add = (playerId: string, delta: number, reason: string): void => {
    if (already.has(`${playerId}|${reason}`)) return;
    events.push(makeEvent({ target: { type: "player", id: playerId }, gameId: "draw", matchId, delta, reason, by: "auto" }));
  };
  const goodIds = st.participantIds.filter((id) => !st.undercoverIds.includes(id));
  if (result === "good") for (const id of goodIds) add(id, 1, "一圖多人・好人勝");
  else for (const id of st.undercoverIds) add(id, 1, "一圖多人・臥底勝");
  const survivors = st.participantIds.filter((id) => !st.eliminatedIds.includes(id));
  for (const id of survivors) add(id, 2, "一圖多人・留到最後");
  if (events.length) push(ctx, { t: "ledger.append", d: { events } });
  push(ctx, { t: "game.set", d: { gameState: { undercover: st } } });
  const nameOf = (id: string): string => store.player(id)?.name ?? "?";
  const lines = [
    result === "good" ? "好人勝：全部好人 +1" : "臥底勝：全部臥底 +1",
    `留到最後 +2：${survivors.map(nameOf).join("、") || "（冇人）"}`,
  ];
  stageSet(ctx, {
    mode: "message",
    payload: { title: `第 ${st.matchNo} 局結算`, lines, tone: result === "good" ? "good" : "bad" },
    prevMode: "scoreboard",
  });
  toast(ctx, `第 ${st.matchNo} 局：${result === "good" ? "好人勝" : "臥底勝"}（${events.length} 筆分）`);
  return { added: events.length, result };
}

/* ── v04-D：問答流程（出題目／開始 30 秒作答／重設再玩） ── */

/** 問答出題次序：以 rundown 嗰關嘅 cardIds 為準（主持改次序／刪題都跟佢），其餘 quiz 卡補喺尾 */
function quizOrder(store: Store): Card[] {
  const item = store.state.room.rundown.find((i) => i.gameId === "quiz");
  const ids = item && item.cardIds.length ? item.cardIds : store.quizCards().map((c) => c.id);
  const cards: Card[] = [];
  for (const id of ids) {
    const c = store.card(id);
    if (c && c.gameId === "quiz" && !cards.some((x) => x.id === c.id)) cards.push(c);
  }
  for (const c of store.quizCards()) if (!cards.some((x) => x.id === c.id)) cards.push(c);
  return cards;
}

function quizCardOrThrow(store: Store, cardId: string | undefined): Card {
  if (!cardId) throw new CmdError("W_BAD_SCHEMA", "要題目 id");
  const card = store.card(cardId);
  if (!card) throw new CmdError("W_BAD_SCHEMA", "冇呢張卡");
  if (card.gameId !== "quiz") throw new CmdError("W_BAD_SCHEMA", "唔係問答題（quiz.show／quiz.open 只接受問答卡）");
  return card;
}

/** 下一題＝次序上第一張仲係 draft 嘅卡（全部 revealed 就冇） */
function nextDraftQuizCard(store: Store): Card | undefined {
  return quizOrder(store).find((c) => c.state === "draft");
}

/** card.open／quiz.open 共用：建立 round、卡轉 open、大mon 出答題畫面（行為同 card.open 原本一致） */
function openCardRound(ctx: Ctx, card: Card): Round {
  const store = ctx.store;
  const room = store.state.room;
  const openCount = room.rounds.filter((r) => r.cardId === card.id).length + 1;
  const round: Round = {
    id: `${card.id}#${openCount}`,
    cardId: card.id,
    cardVersion: card.version,
    endsAt: card.seconds && card.seconds > 0 ? Date.now() + card.seconds * 1000 : null,
    closedAt: null,
    state: "open",
    eligiblePlayerIds: store.approvedPlayers().map((pl) => pl.id),
  };
  push(ctx, { t: "round.put", d: { round, currentRoundId: round.id } });
  push(ctx, { t: "card.update", d: { cardId: card.id, patch: { state: "open" } } });
  const mode: StageMode = card.type === "bid" ? "bid" : card.type === "vote" ? "vote" : "question";
  setStageIfUnlocked(ctx, { mode, payload: { roundId: round.id, cardId: card.id } });
  return round;
}

/* ───────────────────────────── execute ───────────────────────────── */

export type ExecuteResult = ApiResult<unknown>;

export function executeCommand(
  store: Store,
  hostId: string,
  hostName: string,
  cmd: HostCommand,
  deps: { isHostOnline?: (hostId: string) => boolean } = {},
): ExecuteResult {
  if (!cmd || typeof cmd.commandId !== "string" || cmd.commandId.length < 4) {
    throw new CmdError("W_BAD_SCHEMA", "commandId 唔合法");
  }
  if (typeof cmd.kind !== "string") throw new CmdError("W_BAD_SCHEMA", "kind 唔合法");
  const ph = payloadHash(cmd);
  const existing = store.receipt(cmd.commandId);
  if (existing) {
    if (existing.payloadHash !== ph) throw new CmdError("W_CMD_PAYLOAD_MISMATCH", "同 commandId 但 payload 唔同");
    return { ok: true, revision: existing.revision, result: existing.result };
  }
  if (cmd.expectedRevision !== undefined && cmd.expectedRevision !== store.revision) {
    return {
      ok: false,
      code: "W_STALE_COMMAND",
      message: `revision 唔對：預期 ${cmd.expectedRevision}，實際 ${store.revision}`,
      revision: store.revision,
      latest: { phase: store.state.room.phase, mode: store.state.room.stage.mode, currentRoundId: store.state.room.currentRoundId },
    };
  }
  if (cmd.expectedRoundId !== undefined && cmd.expectedRoundId !== (store.state.room.currentRoundId ?? null)) {
    return {
      ok: false,
      code: "W_STALE_COMMAND",
      message: `roundId 唔對：預期 ${cmd.expectedRoundId}，實際 ${store.state.room.currentRoundId ?? "null"}`,
      revision: store.revision,
    };
  }

  const ctx: Ctx = { store, hostId, hostName, cmd, muts: [], isHostOnline: deps.isHostOnline };
  const p = asObj(cmd.payload);
  const room = store.state.room;

  switch (cmd.kind) {
    /* ── 玩家 ── */
    case "player.update":
    case "player.approve":
    case "player.kick": {
      const targetId = cmd.targetId ?? optStr(p, "playerId");
      if (!targetId) throw new CmdError("W_BAD_SCHEMA", "要 playerId");
      const player = store.player(targetId);
      if (!player) throw new CmdError("W_BAD_SCHEMA", "冇呢個玩家");
      const patch: Partial<Player> = {};
      if (cmd.kind === "player.approve") {
        if (player.status === "approved") throw new CmdError("W_ALREADY_STATE", "已經 approved");
        const approved = store.approvedPlayers().length;
        if (approved >= 30) throw new CmdError("W_ROOM_FULL", "approved 名額已滿（30）");
        patch.status = "approved";
      } else if (cmd.kind === "player.kick") {
        patch.status = "kicked";
        patch.connected = false;
        push(ctx, { t: "session.revoke", d: { playerId: targetId } });
        toast(ctx, `踢走咗 ${player.name}`);
      } else {
        if (typeof p.name === "string") {
          const name = p.name.trim();
          if (name.length === 0 || name.length > 12) throw new CmdError("W_BAD_SCHEMA", "名要 1–12 字");
          patch.name = name;
        }
        if (p.number !== undefined) {
          const n = reqNum(p, "number");
          if (!Number.isInteger(n) || n < 1 || n > 999) throw new CmdError("W_BAD_SCHEMA", "number 要 1–999 整數");
          if (room.players.some((x) => x.id !== player.id && x.number === n && x.status !== "kicked"))
            throw new CmdError("W_DUP_NUMBER", `編號 ${n} 已經有人用`);
          patch.number = n;
        }
        if (p.status !== undefined) {
          const st = p.status;
          if (st !== "pending" && st !== "approved" && st !== "kicked") throw new CmdError("W_BAD_SCHEMA", "status 唔合法");
          if (st === "approved" && player.status !== "approved" && store.approvedPlayers().length >= 30)
            throw new CmdError("W_ROOM_FULL", "approved 名額已滿（30）");
          patch.status = st;
          if (st === "kicked") {
            patch.connected = false;
            push(ctx, { t: "session.revoke", d: { playerId: targetId } });
          }
        }
        if (p.avatar !== undefined) patch.avatar = p.avatar as Player["avatar"];
        if (p.groupId !== undefined) {
          const gid = p.groupId === null ? null : String(p.groupId);
          if (gid && !room.groups.some((g) => g.id === gid)) throw new CmdError("W_BAD_SCHEMA", "冇呢個組");
          if (player.groupId && gid !== player.groupId && p.mode === "stay") transferStay(ctx, player, player.groupId);
          patch.groupId = gid;
        }
      }
      push(ctx, { t: "player.update", d: { playerId: targetId, patch } });
      if (cmd.kind === "player.approve") toast(ctx, `批准咗 ${player.name} 入場`);
      break;
    }

    /* ── 分組 ── */
    case "groups.set": {
      const palette = ["#ef4444", "#3b82f6", "#22c55e", "#f59e0b", "#a855f7", "#14b8a6", "#ec4899", "#84cc16", "#f97316", "#06b6d4"];
      let groups = room.groups.map((g) => ({ ...g }));
      if (p.groups !== undefined) {
        const raw = p.groups as { id?: string; name?: string; color?: string }[];
        groups = raw.map((g, i) => ({
          id: g.id ?? `g${i + 1}`,
          name: (g.name ?? `第 ${i + 1} 組`).slice(0, 12),
          color: g.color ?? palette[i % palette.length] ?? "#3b82f6",
          order: i,
        }));
      } else {
        const count = reqNum(p, "count");
        if (!Number.isInteger(count) || count < 0 || count > 30) throw new CmdError("W_BAD_SCHEMA", "count 要 0–30");
        groups = Array.from({ length: count }, (_, i) => ({
          id: `g${i + 1}`,
          name: `第 ${i + 1} 組`,
          color: palette[i % palette.length] ?? "#3b82f6",
          order: i,
        }));
      }
      if (groups.length > 30) throw new CmdError("W_BAD_SCHEMA", "最多 30 組");
      push(ctx, { t: "groups.set", d: { groups } });
      // 被刪組嘅人 → 個人戰
      for (const pl of room.players) {
        if (pl.groupId && !groups.some((g) => g.id === pl.groupId)) {
          push(ctx, { t: "group.assign", d: { playerId: pl.id, groupId: null } });
        }
      }
      toast(ctx, `設定咗 ${groups.length} 組`);
      break;
    }
    case "groups.assign": {
      const playerId = reqStr(p, "playerId");
      const player = store.player(playerId);
      if (!player) throw new CmdError("W_BAD_SCHEMA", "冇呢個玩家");
      const gidRaw = p.groupId;
      const gid = gidRaw === null || gidRaw === "" ? null : String(gidRaw);
      if (gid && !room.groups.some((g) => g.id === gid)) throw new CmdError("W_BAD_SCHEMA", "冇呢個組");
      const mode = optStr(p, "mode") ?? "follow";
      if (mode !== "follow" && mode !== "stay") throw new CmdError("W_BAD_SCHEMA", "mode 要 follow／stay");
      if (mode === "stay" && player.groupId && player.groupId !== gid) transferStay(ctx, player, player.groupId);
      push(ctx, { t: "group.assign", d: { playerId, groupId: gid } });
      toast(ctx, `${player.name} 搬去 ${gid ? (room.groups.find((g) => g.id === gid)?.name ?? gid) : "個人戰"}${mode === "stay" ? "（分數留原組）" : "（分數跟人走）"}`);
      break;
    }

    /* ── 計分帳簿 ── */
    case "score.add": {
      const targetType = optStr(p, "targetType") ?? "player";
      const targetId = cmd.targetId ?? optStr(p, "targetId");
      if (!targetId) throw new CmdError("W_BAD_SCHEMA", "要 targetId");
      if (targetType === "player" && !store.player(targetId)) throw new CmdError("W_BAD_SCHEMA", "冇呢個玩家");
      if (targetType === "group" && !room.groups.some((g) => g.id === targetId)) throw new CmdError("W_BAD_SCHEMA", "冇呢個組");
      const delta = reqNum(p, "delta");
      if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1000) throw new CmdError("W_BAD_SCHEMA", "delta 要非 0 整數（±1000）");
      const reason = (optStr(p, "reason") ?? "主持加分").slice(0, 40);
      const ev = makeEvent({
        target: { type: targetType as "player" | "group", id: targetId },
        delta,
        reason,
        by: "host",
        gameId: optStr(p, "gameId"),
        roundId: room.currentRoundId ?? undefined,
      });
      push(ctx, { t: "ledger.append", d: { events: [ev] } });
      toast(ctx, `${delta > 0 ? "+" : ""}${delta}（${reason}）`);
      break;
    }
    case "score.bulk": {
      const delta = reqNum(p, "delta");
      const reason = (optStr(p, "reason") ?? "全場加減分").slice(0, 40);
      const events = store.approvedPlayers().map((pl) =>
        makeEvent({ target: { type: "player", id: pl.id }, delta, reason, by: "host" }),
      );
      if (events.length === 0) throw new CmdError("W_ALREADY_STATE", "冇 approved 玩家");
      push(ctx, { t: "ledger.append", d: { events } });
      toast(ctx, `全場 ${delta > 0 ? "+" : ""}${delta}（${reason}）`);
      break;
    }
    case "score.void": {
      const eventId = cmd.targetId ?? optStr(p, "eventId");
      if (!eventId) throw new CmdError("W_BAD_SCHEMA", "要 eventId");
      const ev = store.state.ledger.find((e) => e.id === eventId);
      if (!ev) throw new CmdError("W_BAD_SCHEMA", "冇呢筆分");
      if (ev.voided) throw new CmdError("W_ALREADY_STATE", "已經作廢");
      push(ctx, { t: "ledger.void", d: { eventIds: [eventId], by: "host" } });
      toast(ctx, `作廢咗一筆 ${ev.delta > 0 ? "+" : ""}${ev.delta}（${ev.reason}）`);
      break;
    }
    case "score.judge": {
      const roundId = optStr(p, "roundId") ?? room.currentRoundId;
      if (!roundId) throw new CmdError("W_BAD_SCHEMA", "冇 round");
      const round = store.round(roundId);
      if (!round) throw new CmdError("W_BAD_SCHEMA", "冇呢個 round");
      const card = store.card(round.cardId);
      if (!card) throw new CmdError("W_BAD_SCHEMA", "冇呢張卡");
      const allCorrect = p.allCorrect === true;
      const targets: Submission[] = allCorrect
        ? store.submissionsForRound(roundId).filter((s) => s.confirmed)
        : (() => {
            const sid = reqStr(p, "submissionId");
            const s = store.state.submissions.find((x) => x.id === sid);
            if (!s || s.roundId !== roundId || !s.confirmed) throw new CmdError("W_BAD_SCHEMA", "提交唔屬於呢個回合或未確認");
            return [s];
          })();
      const events: ScoreEvent[] = [];
      for (const s of targets) {
        const points = allCorrect ? card.points : Number(p.points ?? 1);
        const correct = allCorrect ? true : p.correct !== false;
        if (!Number.isFinite(points)) throw new CmdError("W_BAD_SCHEMA", "points 唔合法");
        // 重評：void 舊事件
        const old = store.state.ledger.filter((e) => !e.voided && e.submissionId === s.id).map((e) => e.id);
        if (old.length) push(ctx, { t: "ledger.void", d: { eventIds: old, by: "host" } });
        push(ctx, {
          t: "submission.update",
          d: { submissionId: s.id, patch: { judged: { correct, points, by: "host" } } },
        });
        if (points !== 0) {
          events.push(
            makeEvent({
              target: { type: "player", id: s.playerId },
              gameId: card.gameId,
              roundId,
              cardId: card.id,
              submissionId: s.id,
              delta: points,
              reason: `${cardReason(card)}・主持評分`,
              by: "host",
            }),
          );
        }
      }
      if (events.length) push(ctx, { t: "ledger.append", d: { events } });
      toast(ctx, allCorrect ? `全部當答對（${targets.length} 份）` : `評咗一份 ${String(p.points ?? 1)} 分`);
      ctx.result = { judged: targets.map((t) => ({ submissionId: t.id, playerId: t.playerId })) };
      break;
    }

    /* ── 題庫 ── */
    case "quiz.upsert": {
      const q = p.question as QuizQuestion | undefined;
      if (!q || typeof q.prompt !== "string" || q.prompt.trim().length === 0) throw new CmdError("W_BAD_SCHEMA", "題目唔合法");
      if (q.type !== "choice" && q.type !== "open") throw new CmdError("W_BAD_SCHEMA", "type 要 choice／open");
      if (q.type === "open" && q.openKind !== "text" && q.openKind !== "number")
        throw new CmdError("W_BAD_SCHEMA", "open 題一定要有 openKind");
      if (q.type === "choice" && (!Array.isArray(q.options) || q.options.length !== 4))
        throw new CmdError("W_BAD_SCHEMA", "choice 題要 4 個選項");
      const card = questionToCard({ ...q, id: q.id || newId("q") });
      const cards = store.quizCards().map((c) => ({ ...c }));
      const idx = cards.findIndex((c) => c.id === card.id);
      if (idx >= 0) {
        const old = cards[idx] as Card;
        // server-side merge：唔准後台儲存靜靜哋刪走 autoAnswer／state，version 每次 +1（§6）
        card.state = old.state;
        card.version = old.version + 1;
        if (old.autoAnswer) card.autoAnswer = old.autoAnswer;
        if (typeof q.autoAnswer === "string" && q.autoAnswer) card.autoAnswer = "minutes-to-midnight";
        if (old.actualAnswer !== undefined && card.actualAnswer === undefined) card.actualAnswer = old.actualAnswer;
        // B6：主持儲存題目時冇帶嘅欄唔准靜靜哋清走（tolerance／imageUrl 冇提供＝保留）
        if (old.tolerance !== undefined && card.tolerance === undefined) card.tolerance = old.tolerance;
        if (old.imageUrl !== undefined && card.imageUrl === undefined) card.imageUrl = old.imageUrl;
        cards[idx] = card;
      } else {
        if (q.type === "choice") card.state = "draft";
        cards.push(card);
      }
      push(ctx, { t: "quiz.set", d: { cards } });
      const item = room.rundown.find((i) => i.gameId === "quiz");
      if (item) {
        const ids = cards.map((c) => c.id);
        const rundown = room.rundown.map((i) => (i.id === item.id ? { ...i, cardIds: ids } : { ...i }));
        push(ctx, { t: "rundown.set", d: { rundown, currentItemId: room.currentItemId, phase: room.phase } });
      }
      toast(ctx, `題庫：${q.id ? "改" : "加"}咗一題`);
      ctx.result = { id: card.id, type: card.type };
      break;
    }
    case "quiz.delete": {
      const id = cmd.targetId ?? optStr(p, "id");
      if (!id) throw new CmdError("W_BAD_SCHEMA", "要題目 id");
      if (!store.quizCards().some((c) => c.id === id)) throw new CmdError("W_BAD_SCHEMA", "冇呢題");
      const keep = store.quizCards().filter((c) => c.id !== id);
      push(ctx, { t: "quiz.set", d: { cards: keep } });
      push(ctx, { t: "card.remove", d: { cardId: id } });
      const item = room.rundown.find((i) => i.gameId === "quiz");
      if (item) {
        const rundown = room.rundown.map((i) => (i.id === item.id ? { ...i, cardIds: i.cardIds.filter((x) => x !== id) } : { ...i }));
        push(ctx, { t: "rundown.set", d: { rundown, currentItemId: room.currentItemId, phase: room.phase } });
      }
      toast(ctx, "題庫：刪咗一題");
      break;
    }
    case "quiz.reorder": {
      const ids = p.ids as string[] | undefined;
      if (!Array.isArray(ids)) throw new CmdError("W_BAD_SCHEMA", "要 ids");
      const cards = store.quizCards();
      if (ids.length !== cards.length || ids.some((id) => !cards.some((c) => c.id === id)))
        throw new CmdError("W_BAD_SCHEMA", "ids 同題庫對唔上");
      const ordered = ids.map((id) => cards.find((c) => c.id === id) as Card);
      push(ctx, { t: "quiz.set", d: { cards: ordered } });
      const item = room.rundown.find((i) => i.gameId === "quiz");
      if (item) {
        const rundown = room.rundown.map((i) => (i.id === item.id ? { ...i, cardIds: ids } : { ...i }));
        push(ctx, { t: "rundown.set", d: { rundown, currentItemId: room.currentItemId, phase: room.phase } });
      }
      toast(ctx, "題庫：重排咗");
      break;
    }
    case "quiz.import": {
      const questions = (p.questions as QuizQuestion[] | undefined) ?? [];
      if (!Array.isArray(questions)) throw new CmdError("W_BAD_SCHEMA", "要 questions");
      const existing = store.quizCards();
      const imported: string[] = [];
      const unchanged: string[] = [];
      const skippedOpen: { id: string; prompt: string; note: string }[] = [];
      const diffs: { id: string; before: string; after: string }[] = [];
      const cards = [...existing];
      for (const q of questions) {
        if (q.type !== "choice") {
          // open 題：只顯示 diff（現有新版 open 題唔會被覆蓋）
          const cur = cards.find((c) => c.id === q.id);
          skippedOpen.push({
            id: q.id,
            prompt: q.prompt,
            note: cur ? `保留現有 open 題（${cur.prompt}）` : "現有題庫冇呢題，未加入",
          });
          continue;
        }
        const same = cards.find((c) => c.id === q.id);
        if (same && same.type === "choice") {
          if (same.prompt !== q.prompt || JSON.stringify(same.options) !== JSON.stringify(q.options)) {
            diffs.push({ id: same.id, before: same.prompt, after: q.prompt });
            const card = questionToCard({ ...q, id: same.id });
            const idx = cards.findIndex((c) => c.id === same.id);
            cards[idx] = card;
            imported.push(q.id);
          } else {
            unchanged.push(q.id);
          }
          continue;
        }
        const card = questionToCard({ ...q, id: q.id || newId("q") });
        cards.push(card);
        imported.push(card.id);
      }
      push(ctx, { t: "quiz.set", d: { cards } });
      const item = room.rundown.find((i) => i.gameId === "quiz");
      if (item) {
        const rundown = room.rundown.map((i) => (i.id === item.id ? { ...i, cardIds: cards.map((c) => c.id) } : { ...i }));
        push(ctx, { t: "rundown.set", d: { rundown, currentItemId: room.currentItemId, phase: room.phase } });
      }
      toast(ctx, `題庫：匯入 ${imported.length} 題 MC（open 題 ${skippedOpen.length} 題只顯示 diff，冇覆蓋）`);
      ctx.result = { imported, unchanged, skippedOpen, diffs, total: cards.length };
      break;
    }
    case "quiz.setActualAnswer": {
      const roundId = optStr(p, "roundId") ?? room.currentRoundId;
      if (!roundId) throw new CmdError("W_BAD_SCHEMA", "冇 round");
      const round = store.round(roundId);
      if (!round) throw new CmdError("W_BAD_SCHEMA", "冇呢個 round");
      const card = store.card(round.cardId);
      if (!card) throw new CmdError("W_BAD_SCHEMA", "冇呢張卡");
      if (card.autoAnswer) throw new CmdError("W_ALREADY_STATE", "時間題 actualAnswer 由 server 自動計，唔可以手改（要改就 void／reopen，§3.1）");
      const actual = reqNum(p, "actualAnswer");
      push(ctx, { t: "round.update", d: { roundId, patch: { actualAnswer: actual } } });
      push(ctx, { t: "card.update", d: { cardId: card.id, patch: { actualAnswer: actual } } });
      // 最接近者 +2（並列全 +2），綁 roundId 去重
      const old = store.state.ledger.filter((e) => e.roundId === roundId && e.by === "auto").map((e) => e.id);
      if (old.length) push(ctx, { t: "ledger.void", d: { eventIds: old, by: "host" } });
      if (typeof card.tolerance === "number") {
        // v0.3.0：有容差（Q12 ±2／Q13 主持即場輸入、default 0＝完全相等）→ 全部達標 +points
        gradeToleranceRound(ctx, round, card, actual);
        toast(ctx, `估數字答案：${actual}（容差 ±${card.tolerance}）`);
        ctx.result = { actualAnswer: actual, roundId, tolerance: card.tolerance };
        break;
      }
      const subs = store.submissionsForRound(roundId).filter((s) => s.confirmed && typeof s.amount === "number");
      if (subs.length) {
        const dist = (s: Submission): number => Math.abs((s.amount ?? 0) - actual);
        const min = Math.min(...subs.map(dist));
        const events = subs
          .filter((s) => dist(s) === min)
          .map((s) =>
            makeEvent({
              target: { type: "player", id: s.playerId },
              gameId: "quiz",
              roundId,
              cardId: card.id,
              submissionId: s.id,
              delta: 2,
              reason: `${cardReason(card)}・估數字`,
              by: "auto",
            }),
          );
        if (events.length) push(ctx, { t: "ledger.append", d: { events } });
      }
      toast(ctx, `估數字答案：${actual}`);
      ctx.result = { actualAnswer: actual, roundId };
      break;
    }

    /* ── v04-D：問答流程 ── */
    case "quiz.show": {
      // 只出題目：大mon 出題目文字（唔出選項、唔倒數、唔開 round）；手機維持等主持
      // v0.4.1（codex audit INT）：如果場上仲有 quiz round 開緊，主持跳去下一題時一定要先收卷，
      // 否則手機會繼續顯示上一題嘅選項（仲答得），同「等主持開始作答」相反。
      const liveQuizRound = store.currentRound();
      const explicitShow = Boolean(cmd.targetId ?? optStr(p, "cardId"));
      if (liveQuizRound && liveQuizRound.state === "open") {
        const liveCard = store.card(liveQuizRound.cardId);
        // 冇指定題目（＝撳「出題目」掣）而家答緊：擋住，避免主持誤撳跳題令手機答緊嗰題被收卷。
        // 要換題請用 dropdown 明確揀（嗰個係有意識嘅操作），或者先「公佈答案」。
        if (liveCard && liveCard.gameId === "quiz" && !explicitShow) {
          throw new CmdError("W_ALREADY_STATE", "而家答緊題：先撳「公佈答案」，或者用 dropdown 揀題再跳");
        }
        if (liveCard && liveCard.gameId === "quiz") {
          push(ctx, { t: "round.update", d: { roundId: liveQuizRound.id, patch: { state: "closed", closedAt: Date.now() } } });
          push(ctx, { t: "card.update", d: { cardId: liveCard.id, patch: { state: "closed" } } });
          toast(ctx, "上一題已收卷（未評分）");
        } else {
          throw new CmdError("W_ALREADY_STATE", "而家有其他回合（競投／投票）進行緊：先完成或者 void 佢，再出問答題目");
        }
      }
      const cardId = cmd.targetId ?? optStr(p, "cardId");
      const card = cardId ? quizCardOrThrow(store, cardId) : nextDraftQuizCard(store);
      if (!card)
        throw new CmdError("W_ALREADY_STATE", "全部問答題都出完：可以撳「重設問答」再玩，或者用 dropdown 跳去任何一題");
      if (card.type !== "choice" && card.type !== "open")
        throw new CmdError("W_BAD_SCHEMA", "呢張卡唔係選擇／開放題，出唔到題目畫面");
      if (room.stage.lock) throw new CmdError("W_STAGE_LOCKED", "大mon 鎖定咗：先撳「解鎖大mon」再出題目");
      const order = quizOrder(store);
      const index = order.findIndex((c) => c.id === card.id);
      setStageIfUnlocked(ctx, { mode: "question", payload: { cardId: card.id, showOptions: false, preview: true } });
      toast(ctx, `大mon 出題目：Q${index + 1}（讀完先撳「開始 30 秒作答」）`);
      ctx.result = { cardId: card.id, index: index + 1, preview: true, total: order.length };
      break;
    }
    case "quiz.open": {
      ensurePlaying(store);
      // 主持流程：先 quiz.show（只出題目），再 quiz.open；冇指定就跟大mon 而家 show 緊嗰題
      const stagePayload = (room.stage.payload ?? {}) as Record<string, unknown>;
      const stageCardId = typeof stagePayload.cardId === "string" ? stagePayload.cardId : undefined;
      const picked = cmd.targetId ?? optStr(p, "cardId") ?? stageCardId;
      const pickedCard = picked ? quizCardOrThrow(store, picked) : undefined;
      const openRound = store.currentRound();
      const openCard = openRound ? store.card(openRound.cardId) : undefined;
      const openIsQuiz = !!openRound && !!openCard && openCard.gameId === "quiz";
      // 場上已經有一個 quiz round 開緊：一律推返「開緊嗰個」答題畫面，唔會 throw、唔會開多個 round。
      // （主持開卷中撳過「出題目／跳題」睇別題之後再撳「開始 30 秒作答」唔會卡死；要真係換題就先揭曉或者重設。）
      if (openRound && openIsQuiz && openRound.state === "open") {
        const openIdx = quizOrder(store).findIndex((c) => c.id === openRound.cardId);
        setStageIfUnlocked(ctx, { mode: "question", payload: { roundId: openRound.id, cardId: openRound.cardId, showOptions: true } });
        toast(
          ctx,
          pickedCard && pickedCard.id === openRound.cardId
            ? "呢題已經開緊（大mon 返咗答題畫面）"
            : openIdx >= 0
              ? `返去 Q${openIdx + 1} 答題畫面（round 未收卷）`
              : "返去答題畫面（round 未收卷）",
        );
        ctx.result = {
          roundId: openRound.id,
          cardId: openRound.cardId,
          alreadyOpen: true,
          returnedTo: pickedCard && pickedCard.id !== openRound.cardId ? openRound.cardId : undefined,
          cardState: openCard?.state ?? null,
        };
        break;
      }
      const card = pickedCard ?? nextDraftQuizCard(store);
      if (!card) throw new CmdError("W_ALREADY_STATE", "冇未出嘅題：先撳「重設問答」再玩，或者用 dropdown 揀返任何一題");
      // 收咗卷／分佈中嘅回合真係要先揭曉（呢個時候唔可以靜靜換畫面）
      if (openRound && openRound.state === "open")
        throw new CmdError("W_ALREADY_STATE", "上一題仲開緊（未收卷）：先撳「公佈分佈／公佈答案」，或者用「重設問答」");
      if (openRound && (openRound.state === "closed" || openRound.state === "tally")) {
        // v0.4.1（codex audit INT + Team D P1）：主持跳去另一題再撳「開始作答」——
        // 舊嗰題已收卷但未揭曉：作廢佢（唔派分），然後開新一題，避免主持卡死。
        if (openRound.cardId === card.id)
          throw new CmdError("W_ALREADY_STATE", "呢題已經收咗卷（未揭曉）：撳「公佈答案」評分，或者「重設問答」再玩");
        push(ctx, { t: "round.update", d: { roundId: openRound.id, patch: { state: "void" } } });
        push(ctx, { t: "round.current", d: { currentRoundId: null } });
        toast(ctx, "上一題未揭曉：已作廢（未派分）");
      }
      if (card.state === "revealed")
        throw new CmdError("W_ALREADY_STATE", "呢題已經揭曉：要重玩請撳「重設問答」，或者用 dropdown 跳去任何一題只出題目");
      const round = openCardRound(ctx, card);
      const secs = round.endsAt ? Math.max(0, Math.round((round.endsAt - Date.now()) / 1000)) : 0;
      toast(ctx, `開始作答：${secs} 秒（大mon＋手機一齊出選項）`);
      ctx.result = { roundId: round.id, cardId: card.id, endsAt: round.endsAt, seconds: secs, cardState: card.state };
      break;
    }
    case "quiz.reset": {
      const clearScores = p.clearScores === true;
      const cards = quizOrder(store);
      const ids = new Set(cards.map((c) => c.id));
      if (!cards.length) throw new CmdError("W_ALREADY_STATE", "題庫係空：冇問答題可以重設");
      // 1) 全部 quiz 卡返 draft（version +1）
      // v0.4.1（codex audit INT）：Q13 嘅 actualAnswer 係「每次玩主持即場入」嘅動態答案，
      // 重設再玩一定要清走，否則未入新答案就揭曉會用上一局個數去評分。
      const clearDynamic = p.keepActualAnswer !== true;
      const reset = cards.map((c) => {
        const next = { ...c, state: "draft" as const, version: c.version + 1 };
        if (clearDynamic && next.actualAnswer !== undefined) delete next.actualAnswer;
        return next;
      });
      push(ctx, { t: "quiz.set", d: { cards: reset } });
      // 2) void 未完成嘅 quiz round，並清 currentRoundId（只准 quiz 卡嘅 round）
      const voidRounds = room.rounds.filter(
        (r) => ids.has(r.cardId) && (r.state === "open" || r.state === "closed" || r.state === "tally"),
      );
      for (const r of voidRounds) push(ctx, { t: "round.update", d: { roundId: r.id, patch: { state: "void" } } });
      const cur = store.currentRound();
      const curIsQuiz = !!cur && ids.has(cur.cardId);
      if (curIsQuiz) push(ctx, { t: "round.current", d: { currentRoundId: null } });
      // 3) 大mon 仲出緊問答畫面 → 返 idle（黑屏／規則頁唔准打斷；鎖住就唔動，主持自己解鎖再轉）
      const stagePayload = (room.stage.payload ?? {}) as Record<string, unknown>;
      const stageCardId = typeof stagePayload.cardId === "string" ? stagePayload.cardId : null;
      const stageMode = room.stage.mode;
      const stageShowsQuiz =
        stageMode !== "blackout" &&
        stageMode !== "rules" &&
        ((stageCardId !== null && ids.has(stageCardId)) || (curIsQuiz && (stageMode === "question" || stageMode === "tally" || stageMode === "reveal")));
      if (stageShowsQuiz) setStageIfUnlocked(ctx, { mode: "idle", payload: {} });
      // 4) clearScores：只 void quiz 相關 ledger（gameId=quiz 或 cardId 屬 quiz 卡），其他關卡一分都唔郁
      let voidedEvents = 0;
      if (clearScores) {
        const evIds = store.state.ledger
          .filter((e) => !e.voided && (e.gameId === "quiz" || (typeof e.cardId === "string" && ids.has(e.cardId))))
          .map((e) => e.id);
        if (evIds.length) push(ctx, { t: "ledger.void", d: { eventIds: evIds, by: "host" } });
        voidedEvents = evIds.length;
      }
      toast(ctx, `問答已重設：${reset.length} 題可以再出${clearScores ? `（清走 ${voidedEvents} 筆問答分）` : ""}`);
      ctx.result = { cards: reset.length, voidRounds: voidRounds.map((r) => r.id), voidedEvents, clearScores };
      break;
    }

    /* ── 規則頁 ── */
    case "rules.upsert": {
      const pageIn = p.page as RulePage | undefined;
      if (!pageIn || typeof pageIn.gameId !== "string" || typeof pageIn.title !== "string")
        throw new CmdError("W_BAD_SCHEMA", "規則頁唔合法");
      const pages = room.rulePages.map((x) => ({ ...x, blocks: x.blocks.map((b) => ({ ...b })) }));
      const idx = pages.findIndex((x) => x.id === pageIn.id);
      const existing = idx >= 0 ? (pages[idx] as RulePage) : undefined;
      if (existing && p.expectedVersion !== undefined && existing.version !== p.expectedVersion) {
        return {
          ok: false,
          code: "W_RULES_CONFLICT",
          message: `版本衝突：預期 ${String(p.expectedVersion)}，實際 ${existing.version}`,
          revision: store.revision,
          latest: existing,
        };
      }
      const blocks = Array.isArray(pageIn.blocks) ? pageIn.blocks : [];
      if (blocks.length > 20) throw new CmdError("W_RULES_LIMIT", "每頁最多 20 個 block");
      let totalChars = 0;
      for (const b of blocks) {
        const textLen = (b.text ?? "").length + (b.value ?? "").length;
        if (textLen > 120) throw new CmdError("W_RULES_LIMIT", "每個 block 文字最多 120 字");
        if (b.items) {
          if (b.items.length > 6) throw new CmdError("W_RULES_LIMIT", "items 最多 6 個");
          for (const it of b.items) {
            if (it.length > 120) throw new CmdError("W_RULES_LIMIT", "每個 item 最多 120 字");
            totalChars += it.length;
          }
        }
        totalChars += textLen;
      }
      if (totalChars > 1200) throw new CmdError("W_RULES_LIMIT", "全頁文字總和最多 1200 字");
      if (pageIn.title.length > 16) throw new CmdError("W_RULES_LIMIT", "title 最多 16 字");
      if ((pageIn.subtitle ?? "").length > 24) throw new CmdError("W_RULES_LIMIT", "subtitle 最多 24 字");
      const page: RulePage = {
        id: existing?.id ?? newId("rule"),
        gameId: pageIn.gameId,
        title: pageIn.title,
        subtitle: pageIn.subtitle,
        blocks: blocks.map((b) => ({ ...b, id: b.id || newId("b") })),
        order: typeof pageIn.order === "number" ? pageIn.order : pages.length + 1,
        enabled: pageIn.enabled !== false,
        autoAdvanceSeconds: Math.max(0, Number(pageIn.autoAdvanceSeconds ?? 0)),
        updatedAt: Date.now(),
        version: (existing?.version ?? 0) + 1,
        updatedBy: hostName,
      };
      if (page.enabled) {
        for (const other of pages) {
          if (other.id !== page.id && other.gameId === page.gameId) other.enabled = false;
        }
      }
      if (idx >= 0) pages[idx] = page;
      else {
        if (pages.filter((x) => !x.archived).length >= 30) throw new CmdError("W_RULES_LIMIT", "每房最多 30 頁規則");
        pages.push(page);
      }
      push(ctx, { t: "rules.set", d: { rulePages: pages } });
      toast(ctx, `規則頁：${page.title} v${page.version}`);
      break;
    }
    case "rules.delete": {
      const id = cmd.targetId ?? optStr(p, "id");
      if (!id) throw new CmdError("W_BAD_SCHEMA", "要規則頁 id");
      const pages = room.rulePages.map((x) => (x.id === id ? { ...x, archived: true, enabled: false, updatedAt: Date.now(), version: x.version + 1 } : { ...x }));
      push(ctx, { t: "rules.set", d: { rulePages: pages } });
      toast(ctx, "規則頁：已停用");
      break;
    }
    case "rules.reorder": {
      const ids = p.ids as string[] | undefined;
      if (!Array.isArray(ids)) throw new CmdError("W_BAD_SCHEMA", "要 ids");
      const pages = room.rulePages.map((x) => ({ ...x }));
      ids.forEach((id, i) => {
        const page = pages.find((x) => x.id === id);
        if (page) page.order = i;
      });
      push(ctx, { t: "rules.set", d: { rulePages: pages } });
      toast(ctx, "規則頁：重排咗");
      break;
    }

    /* ── rundown ── */
    case "rundown.next":
      advanceRundown(ctx, 0, "next");
      break;
    case "rundown.prev":
      advanceRundown(ctx, 0, "prev");
      break;
    case "rundown.skip":
      advanceRundown(ctx, 0, "skip");
      break;
    case "rundown.reorder": {
      const ids = p.ids as string[] | undefined;
      if (!Array.isArray(ids)) throw new CmdError("W_BAD_SCHEMA", "要 ids");
      const want = new Set(room.rundown.map((i) => i.id));
      const got = new Set(ids);
      if (ids.length !== want.size || got.size !== ids.length || [...want].some((id) => !got.has(id)))
        throw new CmdError("W_BAD_SCHEMA", "ids 要包含全部 rundown 項目（唔可以漏／重複／加未知 id）");
      const rundown = room.rundown
        .map((i) => ({ ...i }))
        .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
        .map((i, idx) => ({ ...i, index: idx, title: renumberTitle(i.title, idx) }));
      push(ctx, { t: "rundown.set", d: { rundown, currentItemId: room.currentItemId, phase: room.phase } });
      toast(ctx, "Rundown：重排咗");
      break;
    }
    case "rundown.insert": {
      const itemIn = p.item as { gameId?: string; title?: string; rulesText?: string } | undefined;
      if (!itemIn?.gameId) throw new CmdError("W_BAD_SCHEMA", "要 gameId");
      const afterId = optStr(p, "afterItemId") ?? room.currentItemId;
      const afterIdx = room.rundown.findIndex((i) => i.id === afterId);
      const rundown = room.rundown.map((i) => ({ ...i }));
      const item = {
        id: newId("rd"),
        index: 0,
        gameId: itemIn.gameId,
        title: (itemIn.title ?? itemIn.gameId).slice(0, 40),
        state: "todo" as const,
        cardIds: [] as string[],
        rulesText: itemIn.rulesText ?? "",
      };
      rundown.splice(afterIdx + 1, 0, item);
      rundown.forEach((i, idx) => {
        i.index = idx;
      });
      push(ctx, { t: "rundown.set", d: { rundown, currentItemId: room.currentItemId, phase: room.phase } });
      toast(ctx, `插入咗「${item.title}」`);
      break;
    }
    case "rundown.reset": {
      // 派對中途想由第一關重玩／測試完想重來：唔使開新房
      const rundown = room.rundown.map((i, idx) => ({ ...i, index: idx, state: "todo" as const }));
      const round = store.currentRound();
      if (round && round.state !== "void") push(ctx, { t: "round.update", d: { roundId: round.id, patch: { state: "void" } } });
      if (room.currentRoundId) push(ctx, { t: "round.current", d: { currentRoundId: null } });
      // v0.4.1（codex audit A）：重設流程＝真正重玩。只清 rundown 會殘留一圖多人／笨蛋殺手／搗蛋鬼
      // 嘅局面（例如舊 match 未 settled → 之後 uc.match.start 會 W_ALREADY_STATE，主持以為壞咗）。
      const hadGameState = Boolean(
        room.gameState && (room.gameState.undercover || room.gameState.killer || room.gameState.saboteur),
      );
      if (hadGameState) push(ctx, { t: "game.set", d: { gameState: { undercover: null, killer: null, saboteur: null } } });
      push(ctx, { t: "rundown.set", d: { rundown, currentItemId: null, phase: "playing" } });
      const first = rundown[0];
      if (first) {
        const rs = rulesStageForItem(ctx, first);
        if (rs) setStageIfUnlocked(ctx, rs);
      } else {
        setStageIfUnlocked(ctx, { mode: "idle", payload: {} });
      }
      toast(ctx, `${first ? `流程重設：返「${first.title}」` : "流程重設（rundown 係空）"}${hadGameState ? "（各關局面已清）" : ""}`);
      break;
    }

    /* ── 出卡流程（§6 狀態機） ── */
    case "card.create": {
      ensurePlaying(store);
      const cardIn = (p.card ?? p) as Partial<Card>;
      const type = cardIn.type;
      if (!type || !["choice", "open", "vote", "bid", "media", "manual"].includes(type))
        throw new CmdError("W_BAD_SCHEMA", "card.type 唔合法");
      if (typeof cardIn.prompt !== "string" || cardIn.prompt.trim() === "") throw new CmdError("W_BAD_SCHEMA", "card.prompt 唔可以空");
      const item = store.currentItem();
      const card: Card = {
        id: newId("card"),
        type,
        gameId: (cardIn.gameId as string | undefined) ?? item?.gameId ?? "quiz",
        prompt: cardIn.prompt,
        seconds: cardIn.seconds === undefined ? null : cardIn.seconds,
        points: cardIn.points ?? 1,
        version: 1,
        state: "draft",
      };
      for (const k of ["category", "imageUrl", "mediaUrl", "explanation", "referenceAnswer", "hint", "openKind", "maxBid", "songId", "voteMode", "undercoverPrompt", "tolerance", "actualAnswer"] as const) {
        if (cardIn[k] !== undefined) (card as unknown as Record<string, unknown>)[k] = cardIn[k];
      }
      if (cardIn.options) card.options = cardIn.options;
      if (typeof cardIn.correct === "number") card.correct = cardIn.correct;
      push(ctx, { t: "card.put", d: { card } });
      if (item) {
        const rundown = room.rundown.map((i) => (i.id === item.id ? { ...i, cardIds: [...i.cardIds, card.id] } : { ...i }));
        push(ctx, { t: "rundown.set", d: { rundown, currentItemId: room.currentItemId, phase: room.phase } });
      }
      toast(ctx, "新增咗一張卡");
      break;
    }
    case "card.update": {
      const cardId = cmd.targetId ?? reqStr(p, "cardId");
      const card = store.card(cardId);
      if (!card) throw new CmdError("W_BAD_SCHEMA", "冇呢張卡");
      const patch = asObj(p.patch ?? p.fields);
      if (typeof patch.prompt === "string" && patch.prompt.trim() === "") throw new CmdError("W_BAD_SCHEMA", "prompt 唔可以空");
      push(ctx, { t: "card.update", d: { cardId, patch: { ...patch, version: card.version + 1 } } });
      toast(ctx, "改咗一張卡");
      break;
    }
    case "undercover.start": {
      ensurePlaying(store);
      // v0.4.1（codex audit B）：有進行中一圖多人局時，舊入口一律跟局——
      // 只用局內參賽者、排除已出局者、並且寫返 st.roundId（否則主持台認唔到呢個結果，
      // 之後 uc.eliminate 亦必然 W_WRONG_PHASE，形成死路）。
      const match = store.state.room.gameState?.undercover ?? null;
      if (match?.settled)
        throw new CmdError("W_ALREADY_STATE", "本局已結算：要再投票請先喺一圖多人面板撳「開新一局」");
      const excludeRaw = p.excludePlayerIds;
      const exclude = Array.isArray(excludeRaw) ? (excludeRaw as string[]) : [];
      const opts: StartDrawVoteOpts = {
        durationSeconds: Number(p.durationSeconds ?? 10),
      };
      if (match) {
        opts.participantIds = match.participantIds;
        opts.excludeIds = [...(match.eliminatedIds ?? []), ...exclude];
        opts.cardId = "card_ucmatch";
      } else {
        opts.excludeIds = exclude;
      }
      const v = startDrawVote(ctx, opts);
      if (match) {
        const st = cloneUcMatch(store);
        st.roundId = v.round.id;
        push(ctx, { t: "game.set", d: { gameState: { undercover: st } } });
      }
      const durationSeconds = v.card.seconds ?? 10;
      toast(ctx, `臥底投票開始（${durationSeconds} 秒）`);
      ctx.result = {
        roundId: v.round.id,
        cardId: v.card.id,
        durationSeconds,
        candidates: v.candidates,
        matchNo: match?.matchNo ?? null,
        questionNo: match ? match.questionNo + 1 : null,
      };
      break;
    }
    case "undercover.reveal": {
      const ucCur = store.currentRound();
      if (!ucCur) throw new CmdError("W_ALREADY_STATE", "冇開住嘅回合");
      const ucCurCard = store.card(ucCur.cardId);
      if (!ucCurCard || ucCurCard.gameId !== "draw" || ucCurCard.voteMode !== "players" || !ucCurCard.options?.length)
        throw new CmdError("W_BAD_SCHEMA", "而家唔係臥底投票");
      if (ucCur.state !== "open") throw new CmdError("W_ALREADY_STATE", `round 已經係 ${ucCur.state}`);
      finalizeUndercover(ctx, ucCur, ucCurCard, false);
      break;
    }
    /* ── v0.3.0：一圖多人（畫畫臥底）完整局 ── */
    case "uc.match.start": {
      ensurePlaying(store);
      const prev = store.state.room.gameState?.undercover ?? null;
      if (prev && prev.participantIds.length > 0 && !prev.settled)
        throw new CmdError("W_ALREADY_STATE", "本局未完：先 uc.match.settle（結算）或 uc.match.reset（再開一局）");
      const participants = store.approvedPlayers();
      const ucRaw = optNum(p, "undercoverCount") ?? 2;
      const ucCount = Math.max(1, Math.min(4, Math.floor(ucRaw)));
      if (participants.length < ucCount + 2)
        throw new CmdError("W_ALREADY_STATE", `approved 玩家太少（要最少 ${ucCount + 2} 人）`);
      const allCards = store
        .gameCards("draw")
        .filter((c) => typeof c.undercoverPrompt === "string" && c.undercoverPrompt.length > 0);
      if (allCards.length < 3) throw new CmdError("W_ALREADY_STATE", "一圖多人題目不足 3 對（檢查 undercover.seed.json）");
      const used = new Set(prev?.usedTopicIds ?? []);
      let pool = allCards.filter((c) => !used.has(c.id));
      let usedBase = [...used];
      if (pool.length < 3) {
        // 題目用晒：循環再用（唔會撞到「抽唔到 3 對」）
        pool = allCards;
        usedBase = [];
      }
      const picked = shuffled(pool.map((c) => c.id)).slice(0, 3);
      const matchNo = !prev ? 1 : prev.participantIds.length > 0 ? prev.matchNo + 1 : prev.matchNo;
      const undercoverIds = shuffled(participants.map((x) => x.id)).slice(0, ucCount);
      const st: UcMatch = {
        matchNo,
        matchUid: newId("ucm"),
        participantIds: participants.map((x) => x.id),
        undercoverIds,
        eliminatedIds: [],
        questionNo: 0,
        topicIds: picked,
        promptCardId: picked[0] ?? null,
        promptRevealed: false,
        roundId: null,
        result: null,
        settled: false,
        usedTopicIds: [...new Set([...usedBase, ...picked])],
        eliminatedByQuestion: {},
      };
      const openRound = store.currentRound();
      if (openRound && (openRound.state === "open" || openRound.state === "closed" || openRound.state === "tally")) {
        push(ctx, { t: "round.update", d: { roundId: openRound.id, patch: { state: "void" } } });
      }
      push(ctx, { t: "round.current", d: { currentRoundId: null } });
      const ucCard = store.card("card_ucmatch");
      if (ucCard) push(ctx, { t: "card.update", d: { cardId: ucCard.id, patch: { state: "draft" } } });
      push(ctx, { t: "game.set", d: { gameState: { undercover: st } } });
      // 大mon：黑屏（唔好爆臥底身份）
      setStageIfUnlocked(ctx, { mode: "blackout", payload: {}, prevMode: "scoreboard" });
      toast(ctx, `一圖多人第 ${matchNo} 局：抽咗 ${ucCount} 個臥底（主持台睇到身份）`);
      ctx.result = { matchNo, participants: st.participantIds.length, undercoverCount: ucCount, questionNo: 1 };
      break;
    }
    case "uc.match.redraw": {
      const st = cloneUcMatch(store);
      if (st.settled) throw new CmdError("W_ALREADY_STATE", "本局已結算，唔可以重抽");
      // FIX-9：已出局者唔可以再抽做臥底
      const pool = st.participantIds.filter((id) => !st.eliminatedIds.includes(id) && store.player(id)?.status === "approved");
      if (pool.length < st.undercoverIds.length + 2) throw new CmdError("W_ALREADY_STATE", "玩家人數唔夠（已出局者唔計），重抽唔到");
      st.undercoverIds = shuffled(pool).slice(0, st.undercoverIds.length);
      push(ctx, { t: "game.set", d: { gameState: { undercover: st } } });
      toast(ctx, `重抽咗 ${st.undercoverIds.length} 個臥底（其他狀態不變）`);
      ctx.result = { matchNo: st.matchNo, undercoverCount: st.undercoverIds.length };
      break;
    }
    case "uc.prompt.reveal": {
      const st = cloneUcMatch(store);
      if (st.settled) throw new CmdError("W_ALREADY_STATE", "本局已結算");
      const card = st.promptCardId ? store.card(st.promptCardId) : undefined;
      if (!card) throw new CmdError("W_ALREADY_STATE", "本局未有題目卡");
      st.promptRevealed = true;
      push(ctx, { t: "game.set", d: { gameState: { undercover: st } } });
      // 只推好人題上大mon：臥底題永遠唔准出 stage／player DTO
      stageSet(ctx, {
        mode: "message",
        payload: { title: "好人題目", lines: [card.prompt], tone: "normal" },
        prevMode: resumableMode(store.state.room.stage.mode),
      });
      toast(ctx, "已公佈好人題目");
      ctx.result = { promptCardId: card.id, questionNo: st.questionNo + 1 };
      break;
    }
    /* ── v0.4.2：畫畫關「揀題目」（主持真係換到本題用邊一對；唔止係 dropdown 裝飾） ── */
    case "uc.topic.pick": {
      ensurePlaying(store);
      ucMatchState(store); // 未開局／已清走本局 → W_ALREADY_STATE
      const pickId = (cmd.targetId ?? optStr(p, "cardId") ?? "").trim();
      if (!pickId) throw new CmdError("W_BAD_SCHEMA", "要 cardId（一圖多人題目卡 id）");
      const pickCard = store.card(pickId);
      if (!pickCard) throw new CmdError("W_BAD_SCHEMA", "冇呢張題目卡");
      ctx.result = ucApplyTopic(ctx, pickCard);
      break;
    }
    case "uc.topic.reroll": {
      ensurePlaying(store);
      const st0 = ucMatchState(store); // 未開局先 throw
      const all = store
        .gameCards("draw")
        .filter((c) => typeof c.undercoverPrompt === "string" && c.undercoverPrompt.length > 0);
      if (all.length === 0) throw new CmdError("W_ALREADY_STATE", "題庫冇一圖多人題目（檢查 undercover.seed.json）");
      const used = new Set(st0.usedTopicIds ?? []);
      const cur = st0.promptCardId;
      // 先揀未用過嘅；題庫用晒就循環再用（唔好 throw）
      let pool = all.filter((c) => !used.has(c.id) && c.id !== cur);
      if (pool.length === 0) pool = all.filter((c) => c.id !== cur);
      if (pool.length === 0) pool = all;
      const picked = shuffled(pool)[0] as Card;
      ctx.result = ucApplyTopic(ctx, picked);
      break;
    }
    case "uc.vote.start": {
      ensurePlaying(store);
      const st = cloneUcMatch(store);
      if (st.settled) throw new CmdError("W_ALREADY_STATE", "本局已結算");
      // v0.4.0：同 undercover.start 行同一條 path（候選＝參賽者−已出局；選民＝候選）
      const v = startDrawVote(ctx, {
        participantIds: st.participantIds,
        excludeIds: st.eliminatedIds,
        durationSeconds: 10,
        cardId: "card_ucmatch",
      });
      st.roundId = v.round.id;
      push(ctx, { t: "game.set", d: { gameState: { undercover: st } } });
      toast(ctx, `第 ${st.questionNo + 1} 題投票開始（${v.card.seconds ?? 10} 秒，${v.candidates.length} 人可投）`);
      ctx.result = { roundId: v.round.id, candidates: v.candidates.length, durationSeconds: v.card.seconds ?? 10 };
      break;
    }
    case "uc.eliminate": {
      const targetId = (cmd.targetId ?? optStr(p, "playerId") ?? "").trim();
      if (!targetId) throw new CmdError("W_BAD_SCHEMA", "要 playerId");
      ctx.result = ucEliminateOne(ctx, targetId);
      break;
    }
    case "uc.vote.foulTop": {
      // v0.4.0：由 server 讀 confirmed 票自己計最高票（主持唔使自己揀人）
      const st0 = ucMatchState(store);
      if (st0.settled) throw new CmdError("W_ALREADY_STATE", "本局已結算");
      const liveRound = st0.roundId ? store.round(st0.roundId) : undefined;
      if (!liveRound) throw new CmdError("W_WRONG_PHASE", "本題未開投票：先撳「開始投票（10 秒）」");
      if (liveRound.state === "open") throw new CmdError("W_WRONG_PHASE", "未收卷：先開票睇結果，再 foul");
      if (ucQuestionDone(st0)) throw new CmdError("W_ALREADY_STATE", "呢題已經 foul 咗一個，請撳「下一題／結算」");
      const tally = drawVoteTally(store, liveRound);
      const totalVotes = [...tally.values()].reduce((a, b) => a + b, 0);
      if (totalVotes === 0) throw new CmdError("W_NO_VOTES", "今題冇人投票：主持揀一個或者重開投票");
      let topId = "";
      let topVotes = -1;
      let tie = false;
      for (const [id, n] of tally) {
        if (n > topVotes) {
          topId = id;
          topVotes = n;
          tie = false;
        } else if (n === topVotes) tie = true;
      }
      if (tie) throw new CmdError("W_TIE", "同票：請主持揀邊個出局");
      const r = ucEliminateOne(ctx, topId);
      ctx.result = { ...r, votes: topVotes, totalVotes };
      break;
    }
    case "uc.eliminate.undo": {
      const st = cloneUcMatch(store);
      if (st.settled) throw new CmdError("W_ALREADY_STATE", "本局已結算，唔可以取消淘汰");
      const last = st.eliminatedIds[st.eliminatedIds.length - 1];
      if (!last) throw new CmdError("W_ALREADY_STATE", "冇淘汰記錄");
      // P1-c：只准喺「本題未換題」時 undo（換咗題就唔可以還原上一題嘅人）
      const lastQ = st.eliminatedByQuestion?.[last];
      if (lastQ !== undefined && lastQ !== st.questionNo)
        throw new CmdError("W_ALREADY_STATE", "已經換咗題，唔可以取消上一題嘅淘汰");
      st.eliminatedIds = st.eliminatedIds.slice(0, -1);
      if (st.eliminatedByQuestion) {
        const map = { ...st.eliminatedByQuestion };
        delete map[last];
        st.eliminatedByQuestion = map;
      }
      if (ucRemainingUndercover(st) > 0) st.result = null;
      push(ctx, { t: "game.set", d: { gameState: { undercover: st } } });
      const target = store.player(last);
      stageSet(ctx, {
        mode: "message",
        payload: { title: "取消淘汰", lines: [`#${target?.number ?? "?"} ${target?.name ?? "?"} 返返嚟`, `仲有 ${ucRemainingUndercover(st)} 個臥底未出局`], tone: "normal" },
        prevMode: resumableMode(store.state.room.stage.mode),
      });
      toast(ctx, `取消淘汰：${target?.name ?? last}`);
      ctx.result = { playerId: last, remaining: ucRemainingUndercover(st) };
      break;
    }
    case "uc.match.next": {
      const st = cloneUcMatch(store);
      if (st.settled) throw new CmdError("W_ALREADY_STATE", "本局已結算");
      const remaining = ucRemainingUndercover(st);
      // B4：本題未 foul 過唔准換題（連撳兩次 next 會被擋）
      if (remaining > 0 && !ucQuestionDone(st))
        throw new CmdError("W_WRONG_PHASE", "本題未 foul 過人：先開投票再淘汰一個，先可以下一題");
      if (remaining === 0) {
        const r = settleUndercoverMatch(ctx, st, "good");
        ctx.result = { settled: true, ...r, matchNo: st.matchNo };
        break;
      }
      if (st.questionNo >= 2) {
        const r = settleUndercoverMatch(ctx, st, "undercover");
        ctx.result = { settled: true, ...r, matchNo: st.matchNo };
        break;
      }
      st.questionNo += 1;
      st.promptRevealed = false;
      st.promptCardId = st.topicIds[st.questionNo] ?? null;
      st.roundId = null;
      push(ctx, { t: "round.current", d: { currentRoundId: null } });
      push(ctx, { t: "game.set", d: { gameState: { undercover: st } } });
      setStageIfUnlocked(ctx, { mode: "blackout", payload: {}, prevMode: "scoreboard" });
      toast(ctx, `第 ${st.questionNo + 1} 題（換新白紙）`);
      ctx.result = { settled: false, questionNo: st.questionNo + 1, promptCardId: st.promptCardId };
      break;
    }
    case "uc.match.settle": {
      const st0 = ucMatchState(store);
      if (st0.settled) {
        // 冪等：唔會再加分，只回報「已結算」
        toast(ctx, `第 ${st0.matchNo} 局已經結算（唔會重複加分）`);
        ctx.result = { already: true, matchNo: st0.matchNo, result: st0.result };
        break;
      }
      // FIX-8：勝負未定之前唔准一撳即判（只有「兩個臥底都出局」或「打完 3 題」先准）
      const remaining0 = ucRemainingUndercover(st0);
      if (!(remaining0 === 0 || st0.result === "good" || (st0.questionNo >= 2 && ucQuestionDone(st0))))
        throw new CmdError("W_WRONG_PHASE", "仲未夠 3 題／仲有臥底未出局，未可以結算（要結算請先撳「下一題／結算」）");
      const st = cloneUcMatch(store);
      const result = st.result === "good" || ucRemainingUndercover(st) === 0 ? "good" : "undercover";
      const r = settleUndercoverMatch(ctx, st, result);
      ctx.result = { settled: true, matchNo: st.matchNo, ...r };
      break;
    }
    case "uc.match.reset": {
      const st0 = ucMatchState(store);
      const nextNo = st0.matchNo + 1;
      const cleared: UcMatch = {
        matchNo: nextNo,
        participantIds: [],
        undercoverIds: [],
        eliminatedIds: [],
        questionNo: 0,
        topicIds: [],
        promptCardId: null,
        promptRevealed: false,
        roundId: null,
        result: null,
        settled: true,
        usedTopicIds: st0.usedTopicIds ?? [],
      };
      const openRound = store.currentRound();
      if (openRound && (openRound.state === "open" || openRound.state === "closed" || openRound.state === "tally")) {
        push(ctx, { t: "round.update", d: { roundId: openRound.id, patch: { state: "void" } } });
      }
      push(ctx, { t: "round.current", d: { currentRoundId: null } });
      const ucCard = store.card("card_ucmatch");
      if (ucCard) push(ctx, { t: "card.update", d: { cardId: ucCard.id, patch: { state: "draft" } } });
      push(ctx, { t: "game.set", d: { gameState: { undercover: cleared } } });
      setStageIfUnlocked(ctx, { mode: "scoreboard", payload: {} });
      toast(ctx, `清咗本局（下一局係第 ${nextNo} 局）`);
      ctx.result = { matchNo: nextNo };
      break;
    }

    case "card.open": {
      ensurePlaying(store);
      const cardId = cmd.targetId ?? reqStr(p, "cardId");
      const card = store.card(cardId);
      if (!card) throw new CmdError("W_BAD_SCHEMA", "冇呢張卡");
      // 搗蛋鬼卡要用 saboteur.openRound：generic open 會開出一個唔喺 saboteur.rounds 註冊嘅 round（永遠結算唔到）
      if (card.gameId === "saboteur") throw new CmdError("W_BAD_SCHEMA", "搗蛋鬼卡要用 saboteur.openRound 開（generic card.open 會開出未註冊嘅搗蛋鬼 round）");
      // FIX-10：一圖多人題目卡（有 undercoverPrompt）唔准 generic 開（會將好人題推去全部手機，未公佈就穿橋）
      if (card.gameId === "draw" && card.undercoverPrompt)
        throw new CmdError("W_WRONG_PHASE", "一圖多人題目卡唔可以用 card.open（請用主持台「一圖多人」面板：公佈好人題目）");
      const openRound = store.currentRound();
      if (openRound && (openRound.state === "open" || openRound.state === "closed" || openRound.state === "tally"))
        throw new CmdError("W_ALREADY_STATE", "仲有回合未完成，先 reveal 或 void");
      if (card.state === "revealed") throw new CmdError("W_ALREADY_STATE", "已 reveal 嘅卡要用 reopen");
      openCardRound(ctx, card);
      toast(ctx, `開咗卡：${card.prompt.slice(0, 12)}`);
      break;
    }
    case "card.close": {
      const cardId = cmd.targetId ?? optStr(p, "cardId");
      const round = store.currentRound();
      if (!round) throw new CmdError("W_ALREADY_STATE", "冇開住嘅回合");
      if (cardId && round.cardId !== cardId) throw new CmdError("W_STALE_COMMAND", "而家開住嘅唔係呢張卡");
      if (round.state !== "open") throw new CmdError("W_ALREADY_STATE", `round 已經係 ${round.state}`);
      const card = store.card(round.cardId);
      if (card && card.gameId === "draw" && card.voteMode === "players" && card.options?.length) {
        finalizeUndercover(ctx, round, card, false);
        break;
      }
      closeRoundMutations(ctx, round, card, false);
      toast(ctx, "收卷");
      // 搗蛋鬼輪次若果喺收卷時已即場結算，狀態由 tallySaboteurRound 決定（revealed），唔再補 tally
      break;
    }
    case "card.tally": {
      const cardId = cmd.targetId ?? optStr(p, "cardId");
      const round = store.currentRound();
      if (!round) throw new CmdError("W_ALREADY_STATE", "冇開住嘅回合");
      if (cardId && round.cardId !== cardId) throw new CmdError("W_STALE_COMMAND", "而家開住嘅唔係呢張卡");
      if (round.state !== "closed" && round.state !== "open") throw new CmdError("W_ALREADY_STATE", `round 係 ${round.state}`);
      const card = store.card(round.cardId);
      if (card && card.gameId === "draw" && card.voteMode === "players" && card.options?.length) {
        if (round.state === "open" || round.state === "closed") finalizeUndercover(ctx, round, card, false);
        else toast(ctx, "已經開咗票");
        break;
      }
      const settled = round.state === "open" ? closeRoundMutations(ctx, round, card, false) : false;
      if (!settled) {
        push(ctx, { t: "card.update", d: { cardId: round.cardId, patch: { state: "tally" } } });
        push(ctx, { t: "round.update", d: { roundId: round.id, patch: { state: "tally" } } });
        setStageIfUnlocked(ctx, { mode: "tally", payload: { roundId: round.id, cardId: round.cardId } });
      }
      toast(ctx, "切去分佈");
      break;
    }
    case "card.reveal": {
      const cardId = cmd.targetId ?? optStr(p, "cardId");
      const round = store.currentRound();
      if (!round) throw new CmdError("W_WRONG_PHASE", "冇開住嘅回合");
      if (cardId && round.cardId !== cardId) throw new CmdError("W_STALE_COMMAND", "而家開住嘅唔係呢張卡");
      if (round.state !== "closed" && round.state !== "tally") throw new CmdError("W_WRONG_PHASE", `round 係 ${round.state}`);
      const card = store.card(round.cardId);
      if (!card) throw new CmdError("W_BAD_SCHEMA", "冇呢張卡");
      // generic reveal 對「未裁決嘅搗蛋鬼輪次」要拒絕：reveal 只會把 round 標 revealed（record 仍然
      // closed／decision:null），之後 saboteur.openRound 就開得下一輪 → 中間輪次被偷走。
      if (card.gameId === "saboteur" && unsettledSaboteurRounds(store).some((r) => r.roundId === round.id))
        throw new CmdError("W_ALREADY_STATE", "搗蛋鬼輪次未裁決：請用 saboteur.decide（retry／eliminate），唔可以用 generic card.reveal");
      if (card.state !== "revealed") {
        push(ctx, { t: "card.update", d: { cardId: card.id, patch: { state: "revealed" } } });
        push(ctx, { t: "round.update", d: { roundId: round.id, patch: { state: "revealed" } } });
        if (card.type === "choice") gradeChoiceRound(ctx, round, card);
        if (card.type === "vote" && card.voteMode === "works") gradeDrawRound(ctx, round, card);
        // v0.3.3：容差題（Q12）同「到午夜幾分鐘」題嘅自動評分搬到呢度（收卷唔再派分）
        if (typeof card.tolerance === "number") {
          const actual = round.actualAnswer ?? card.actualAnswer;
          if (typeof actual === "number") gradeToleranceRound(ctx, round, card, actual);
        } else if (card.autoAnswer === "minutes-to-midnight") {
          const actual = round.actualAnswer ?? (round.closedAt ? minutesToMidnightHK(round.closedAt) : undefined);
          if (typeof actual === "number") gradeClosest(ctx, round, card, actual);
        }
      }
      setStageIfUnlocked(ctx, { mode: "reveal", payload: { roundId: round.id, cardId: card.id } });
      toast(ctx, "揭曉");
      ctx.result = { roundId: round.id, cardId: card.id, correct: card.correct, actualAnswer: round.actualAnswer ?? card.actualAnswer };
      break;
    }
    case "card.reopen": {
      ensurePlaying(store);
      const cardId = cmd.targetId ?? reqStr(p, "cardId");
      const card = store.card(cardId);
      if (!card) throw new CmdError("W_BAD_SCHEMA", "冇呢張卡");
      // 已結算嘅搗蛋鬼卡唔准 generic reopen：會 void 投票者 +3、開新 round 但唔喺 saboteur.rounds 註冊，
      // 而 caught／finished 仍然 true → 之後再也結算唔到。重投只能經 saboteur.decide（每輪一次）。
      if (card.gameId === "saboteur")
        throw new CmdError("W_BAD_SCHEMA", "搗蛋鬼卡唔准 generic reopen；未裁決請用 saboteur.decide { decision: 'retry' }，已結算請用 saboteur.openRound");
      if (card.state !== "revealed") throw new CmdError("W_STALE_COMMAND", "reopen 前置係 card.state=revealed（§6 狀態表）");
      const prevRound = [...room.rounds].reverse().find((r) => r.cardId === cardId && r.state !== "void");
      if (!prevRound) throw new CmdError("W_STALE_COMMAND", "呢張卡未開過");
      const openCount = room.rounds.filter((r) => r.cardId === cardId).length + 1;
      const round: Round = {
        id: `${cardId}#${openCount}`,
        cardId,
        cardVersion: card.version + 1,
        retryOf: prevRound.id,
        endsAt: card.seconds && card.seconds > 0 ? Date.now() + card.seconds * 1000 : null,
        closedAt: null,
        state: "open",
        eligiblePlayerIds: store.approvedPlayers().map((pl) => pl.id),
      };
      // 舊 round void；舊 auto 分作廢；host 分手動保留（除非 payload.voidHostEvents）
      push(ctx, { t: "round.update", d: { roundId: prevRound.id, patch: { state: "void" } } });
      const autoIds = store.state.ledger
        .filter((e) => e.roundId === prevRound.id && e.by === "auto" && !e.voided)
        .map((e) => e.id);
      const hostIds = p.voidHostEvents === true
        ? store.state.ledger.filter((e) => e.roundId === prevRound.id && e.by === "host" && !e.voided).map((e) => e.id)
        : [];
      const voidIds = [...autoIds, ...hostIds];
      if (voidIds.length) push(ctx, { t: "ledger.void", d: { eventIds: voidIds, by: "host" } });
      push(ctx, { t: "round.put", d: { round, currentRoundId: round.id } });
      push(ctx, { t: "card.update", d: { cardId, patch: { state: "open", version: card.version + 1 } } });
      const mode: StageMode = card.type === "bid" ? "bid" : card.type === "vote" ? "vote" : "question";
      setStageIfUnlocked(ctx, { mode, payload: { roundId: round.id, cardId } });
      toast(ctx, `重開：${card.prompt.slice(0, 12)}`);
      break;
    }
    case "card.delete": {
      const cardId = cmd.targetId ?? reqStr(p, "cardId");
      if (!store.card(cardId)) throw new CmdError("W_BAD_SCHEMA", "冇呢張卡");
      push(ctx, { t: "card.remove", d: { cardId } });
      const rundown = room.rundown.map((i) => ({ ...i, cardIds: i.cardIds.filter((x) => x !== cardId) }));
      push(ctx, { t: "rundown.set", d: { rundown, currentItemId: room.currentItemId, phase: room.phase } });
      toast(ctx, "刪咗一張卡");
      break;
    }

    /* ── 大mon 控制 ── */
    case "stage.set": {
      const mode = p.mode as StageMode | undefined;
      if (!mode || !MODES.includes(mode)) throw new CmdError("W_BAD_SCHEMA", "mode 唔合法");
      // A1：大mon 鎖住嘅時候唔好靜靜 return（主持撳完冇反應，就係「兩邊脫節」嘅感覺）
      if (room.stage.lock) throw new CmdError("W_STAGE_LOCKED", "大mon 已鎖定，請先解鎖");
      // 黑屏期間唔准出規則頁（同 stage.rules 一致；其他 mode 照樣放行，QR 逃生門不受影響）
      if (room.stage.mode === "blackout" && mode === "rules") throw new CmdError("W_STAGE_LOCKED", "blackout 期間唔准出規則頁");
      if (mode === "rules" && room.phase !== "playing") throw new CmdError("W_WRONG_PHASE", "rules 只准 playing phase");
      // 黑屏唔可以係死胡同：stage.set 一撳就係離開黑屏，prevMode 亦唔會殘留 blackout／rules
      const prevMode = resumableMode(room.stage.mode === "blackout" ? room.stage.prevMode : room.stage.mode);
      const payload = asObj(p.payload);
      if (mode === "rules") {
        const pageId = typeof payload.rulePageId === "string" ? payload.rulePageId : undefined;
        const rulesPayload = { ...payload, ...rulesStagePayload(ctx, store.currentItem(), pageId) };
        if (typeof payload.pageIndex === "number") rulesPayload.pageIndex = payload.pageIndex;
        stageSet(ctx, { mode, payload: rulesPayload, prevMode });
      } else {
        stageSet(ctx, { mode, payload, prevMode });
      }
      toast(ctx, `大mon → ${MODE_TOAST_LABEL[mode] ?? mode}`);
      break;
    }
    case "stage.qr": {
      // v0.4.1（codex audit A）：緊急逃生門。大mon 鎖定時主持仍然要返得去 QR／入場頁，
      // 否則「大mon 出錯」畫面教人撳嘅嗰粒掣會被 W_STAGE_LOCKED 擋住。
      stageSet(ctx, { mode: "idle", payload: {}, prevMode: "idle" });
      toast(ctx, "大mon 返 QR／入場頁");
      break;
    }
    case "stage.lock": {
      const lock = p.lock === true;
      stageSet(ctx, { lock });
      toast(ctx, lock ? "大mon 鎖定" : "大mon 解鎖");
      break;
    }
    case "stage.blackout": {
      const on = p.on !== false;
      // 唔係黑屏時撳「恢復畫面」＝ no-op：唔好跳去 prevMode 打亂主持而家嘅畫面
      if (!on && room.stage.mode !== "blackout") {
        toast(ctx, "而家唔係黑屏");
        break;
      }
      if (on) {
        // 黑屏期間再撳黑屏：保留原本嘅恢復目標（寫成 blackout 就永遠走唔返出嚟）
        const prev = room.stage.mode === "blackout" ? room.stage.prevMode : room.stage.mode;
        stageSet(ctx, { mode: "blackout", prevMode: resumableMode(prev), payload: {} });
      } else {
        const mode = resumableMode(room.stage.prevMode);
        stageSet(ctx, { mode, prevMode: mode, payload: {} });
      }
      toast(ctx, on ? "黑屏" : "恢復畫面");
      break;
    }
    case "stage.rules": {
      const on = p.on !== false;
      if (on) {
        if (room.phase !== "playing") throw new CmdError("W_WRONG_PHASE", "規則頁只准 playing phase");
        if (room.stage.mode === "blackout") throw new CmdError("W_STAGE_LOCKED", "blackout 期間唔准出規則頁");
      }
      if (on) {
        stageSet(ctx, {
          mode: "rules",
          payload: rulesStagePayload(ctx, store.currentItem(), optStr(p, "rulePageId")),
          prevMode: resumableMode(room.stage.mode),
        });
      } else {
        const mode = resumableMode(room.stage.prevMode);
        stageSet(ctx, { mode, prevMode: mode, payload: {} });
      }
      toast(ctx, on ? "顯示規則頁" : "收起規則頁");
      break;
    }
    case "stage.page": {
      const pageIndex = reqNum(p, "pageIndex");
      stageSet(ctx, { payload: { ...(room.stage.payload as Record<string, unknown>), pageIndex: Math.max(0, Math.floor(pageIndex)) } });
      break;
    }
    case "stage.ticker": {
      const ticker = { ...room.stage.ticker };
      if (p.visible !== undefined) ticker.visible = p.visible === true;
      if (p.scope === "player" || p.scope === "group") ticker.scope = p.scope;
      if (p.range === "current" || p.range === "total") ticker.range = p.range;
      if (p.sort === "score-desc" || p.sort === "score-asc" || p.sort === "number" || p.sort === "name" || p.sort === "group")
        ticker.sort = p.sort;
      stageSet(ctx, { ticker });
      break;
    }

    /* ── 設定 ── */
    case "settings.set": {
      const settings: Record<string, unknown> = {};
      if (p.autoClose !== undefined) settings.autoClose = p.autoClose === true;
      if (p.maxBid !== undefined) {
        const mb = reqNum(p, "maxBid");
        if (!Number.isInteger(mb) || mb < 1 || mb > 10000) throw new CmdError("W_BAD_SCHEMA", "maxBid 1–10000");
        settings.maxBid = mb;
      }
      if (p.allowRepeatAwards !== undefined) settings.allowRepeatAwards = p.allowRepeatAwards === true;
      push(ctx, { t: "settings.set", d: { settings } });
      toast(ctx, "改咗設定");
      break;
    }

    /* ── 房間流程 ── */
    case "room.start": {
      // A1：真正「開始遊戲」＝轉 playing＋入第一關。
      // 以前 phase 已經 playing 就 throw，主持撳完咩都唔變（用戶回報「click 咗開始但冇反應」）。
      if (room.rundown.length === 0) {
        // 極端：rundown 空（未灌 seed）。照舊轉 phase，唔好令主持撳完冇反應。
        if (room.phase !== "playing") push(ctx, { t: "room.phase", d: { phase: "playing" } });
        setStageIfUnlocked(ctx, { mode: "scoreboard", payload: {} });
        toast(ctx, "開始（rundown 係空，未有關卡）");
        break;
      }
      const startedItem = store.currentItem();
      if (room.phase === "playing" && startedItem) {
        // 已經進行緊：唔 throw，但要講清楚而家進行到邊（唔好靜靜死）
        toast(ctx, `已經開始咗：${startedItem.title}`);
        break;
      }
      // lobby／idle／final／award，或者 playing 但 currentItemId=null（用戶撞到嘅情境）
      // → 一律由第一關開始（advanceRundown 會 void 舊 round、出第一關規則頁）
      advanceRundown(ctx, 0, "start");
      break;
    }
    case "room.phase": {
      const phase = p.phase;
      if (phase !== "idle" && phase !== "lobby" && phase !== "playing" && phase !== "final" && phase !== "award")
        throw new CmdError("W_BAD_SCHEMA", "phase 唔合法");
      push(ctx, { t: "room.phase", d: { phase } });
      if (phase === "final") {
        const awards = store.computeAwards();
        push(ctx, { t: "award.set", d: { awards: awards.map((a) => ({ ...a, revealed: false })) } });
        setStageIfUnlocked(ctx, { mode: "finale", payload: {} });
      }
      toast(ctx, `phase → ${phase}`);
      break;
    }

    /* ── 頒獎 ── */
    case "award.compute": {
      if (room.phase !== "final" && room.phase !== "award") throw new CmdError("W_WRONG_PHASE", "只准 final／award");
      const awards = store.computeAwards(p.allowRepeat === true);
      push(ctx, { t: "award.set", d: { awards } });
      toast(ctx, "重算咗三獎");
      break;
    }
    case "award.override": {
      const id = reqStr(p, "id");
      const targetId = p.targetId === null ? null : reqStr(p, "targetId");
      const awards = room.awards.map((a) => (a.id === id ? { ...a, targetId, manual: true } : { ...a }));
      push(ctx, { t: "award.set", d: { awards } });
      toast(ctx, "手動改咗得獎者");
      break;
    }
    case "award.reveal": {
      const id = reqStr(p, "id");
      const awards = room.awards.map((a) => (a.id === id ? { ...a, revealed: true } : { ...a }));
      const award = awards.find((a) => a.id === id);
      if (!award) throw new CmdError("W_BAD_SCHEMA", "冇呢個獎");
      push(ctx, { t: "award.set", d: { awards } });
      push(ctx, { t: "room.phase", d: { phase: "award" } });
      setStageIfUnlocked(ctx, { mode: "award", payload: { revealAwardId: id } });
      toast(ctx, `揭曉 ${id}`);
      break;
    }
    case "award.reset": {
      const awards = store.computeAwards().map((a) => ({ ...a, revealed: false }));
      push(ctx, { t: "award.set", d: { awards } });
      toast(ctx, "重設頒獎");
      break;
    }


    /* ── M2：歌單 ── */
    case "song.upsert": {
      const songIn = asObj(p.song ?? p);
      const title = String(songIn.title ?? "").trim();
      if (title.length === 0 || title.length > 60) throw new CmdError("W_BAD_SCHEMA", "歌名 1–60 字");
      const id = typeof songIn.id === "string" && songIn.id ? songIn.id : newId("song");
      const existing = store.state.songs.find((x) => x.id === id);
      const url = typeof songIn.url === "string" ? songIn.url.trim() : "";
      const asset = typeof songIn.assetId === "string" ? store.state.assets.find((a) => a.id === songIn.assetId) : undefined;
      let source: Song["source"];
      if (asset && asset.kind === "audio") source = { kind: "file", fileName: asset.file };
      else if (url) source = sourceKindOf(url) as Song["source"];
      else source = { kind: "external" };
      const song: Song = {
        id,
        index: existing?.index ?? store.state.songs.length + 1,
        title,
        source,
        state: source.kind === "file" || source.url ? "ready" : "draft",
      };
      if (typeof songIn.hint === "string") song.hint = songIn.hint;
      if (asset && asset.kind === "audio") song.durationMs = undefined;
      push(ctx, { t: "song.put", d: { song } });
      toast(ctx, `歌單：${existing ? "改" : "加"}咗《${title}》${song.state === "draft" ? "（未齊 link／檔案）" : ""}`);
      ctx.result = { id, state: song.state };
      break;
    }
    case "song.delete": {
      const id = cmd.targetId ?? optStr(p, "id");
      if (!id) throw new CmdError("W_BAD_SCHEMA", "要 songId");
      push(ctx, { t: "song.remove", d: { songId: id } });
      toast(ctx, "歌單：刪咗一首");
      break;
    }

    /* ── M2：AudioLease（唯一音源） ── */
    case "lease.acquire": {
      const deckId = ownerDeck(ctx, optStr(p, "deckId"));
      const nowMs = Date.now();
      const old = store.state.room.audioLease;
      const sameDeck = old?.deckId === deckId;
      const ttl = Number(process.env.LEASE_TTL_MS ?? 30_000);
      const marginMs = Number(process.env.LEASE_TAKEOVER_MARGIN_MS ?? 5000);
      const forceOnline = p.forceOnline === true;
      if (old && !sameDeck && !old.releasedAt) {
        // 舊 lease 仲有效：在線接管要 host 明確確認（forceOnline）＋舊 host 真係在線；否則等 old deck release／到期+margin
        if (forceOnline && ctx.isHostOnline && !ctx.isHostOnline(old.hostId)) {
          throw new CmdError("W_NO_AUDIO_LEASE", "舊音源 host 唔在線：唔准 forceOnline 繞 margin（請等 lease 到期 + 5s margin 後接管）");
        }
        if (!forceOnline) {
          const retryAfterMs = Math.max(0, old.leaseUntil - nowMs);
          throw new CmdError("W_NO_AUDIO_LEASE", `舊音源（${old.deckId}）lease 未到期（仲有 ${Math.ceil(retryAfterMs / 1000)}s）。如舊 deck 仲在線，請用「在線接管（確認舊機）」；否則等 ${marginMs / 1000}s safety margin 後自動可接管`);
        }
        // 在線接管：server 叫舊 deck stop（舊 deck 收到 patch 即自行 pause）＋generation+1，最多 2 秒內完成（client 反應 <100ms）
        const pb = store.state.playback;
        if (pb && pb.deckId === old.deckId && (pb.state === "playing" || pb.state === "preparing")) {
          const positionMs = pb.positionMs + Math.max(0, nowMs - pb.playStartedAt);
          push(ctx, { t: "media.set", d: { playback: { ...pb, state: "paused", positionMs, pausedAt: nowMs } } });
        }
        toast(ctx, `在線接管音源：${old.deckId} → ${deckId}（gen ${old.generation + 1}）`);
      } else if (old && !sameDeck && old.releasedAt) {
        // 失聯接管：舊 lease 已到期，但要有 +5s safety margin（等舊 deck 一定停咗）
        const marginLeft = old.releasedAt + marginMs - nowMs;
        if (marginLeft > 0) {
          const err = new CmdError("W_NO_AUDIO_LEASE", `失聯接管要等 safety margin：舊音源 ${Math.ceil(marginLeft / 1000)}s 後先可以接管（防雙響）`);
          (err as CmdError & { retryAfterMs?: number }).retryAfterMs = marginLeft;
          throw err;
        }
        toast(ctx, `失聯接管：${old.deckId} → ${deckId}（gen ${old.generation + 1}，margin 已過）`);
      } else {
        toast(ctx, `音源 lease：${deckId}（gen ${(old?.generation ?? 0) + 1}）`);
      }
      const baseGeneration = old ? (sameDeck ? old.generation : old.generation + 1) : 1;
      const lease: AudioLease = {
        deckId,
        hostId: hostId,
        generation: baseGeneration,
        leaseUntil: nowMs + ttl,
      };
      push(ctx, { t: "lease.set", d: { lease } });
      ctx.result = { deckId, generation: lease.generation, leaseUntil: lease.leaseUntil };
      break;
    }
    case "lease.heartbeat": {
      const lease = store.state.room.audioLease;
      if (!lease) throw new CmdError("W_NO_AUDIO_LEASE", "未有 lease");
      const deckId = optStr(p, "deckId") ?? lease.deckId;
      const gen = optNum(p, "generation") ?? lease.generation;
      if (lease.deckId !== deckId || lease.generation !== gen) throw new CmdError("W_NO_AUDIO_LEASE", "generation 已過期");
      const ttl = Number(process.env.LEASE_TTL_MS ?? 30_000);
      push(ctx, { t: "lease.set", d: { lease: { ...lease, leaseUntil: Date.now() + ttl } } });
      ctx.result = { leaseUntil: Date.now() + ttl, generation: gen };
      break;
    }
    case "lease.release": {
      const lease = store.state.room.audioLease;
      if (lease && lease.deckId === (optStr(p, "deckId") ?? lease.deckId)) push(ctx, { t: "lease.set", d: { lease: null } });
      ctx.result = { released: true };
      break;
    }

    /* ── M2：media 播放（大mon 靜音，media deck 先出聲） ── */
    case "media.play": {
      ensurePlaying(store);
      const curRound = store.currentRound();
      if (curRound && curRound.state === "open") {
        const curCard = store.card(curRound.cardId);
        if (curCard?.type === "bid") throw new CmdError("W_WRONG_PHASE", "bid round 仲 open：先收卷／結算，唔可以而家播歌搶大mon 畫面");
      }
      const deckId = leaseDeck(ctx, optStr(p, "deckId"));
      const cur = store.state.playback;
      if (cur && (cur.state === "preparing" || cur.state === "playing") && p.resume !== true) {
        throw new CmdError("W_ALREADY_STATE", `已經有播放中（${cur.state}）：先 pause／stop 再播另一首`);
      }
      const songId = cmd.targetId ?? reqStr(p, "songId");
      const song = store.state.songs.find((s) => s.id === songId);
      if (!song) throw new CmdError("W_BAD_SCHEMA", "冇呢首歌");
      if (song.source.kind !== "file") throw new CmdError("W_BAD_SCHEMA", "YouTube／Apple 只係手動提示，唔受 media.play 控制（D32）");
      const fromStart = p.fromStart === true;
      const winRaw = p.window;
      const win: [number, number] = Array.isArray(winRaw) && winRaw.length === 2 ? [Number(winRaw[0]), Number(winRaw[1])] : [0, 15_000];
      const playback: MediaPlayback = {
        songId,
        deckId,
        playStartedAt: 0,
        state: "preparing",
        positionMs: 0,
        window: win,
        by: hostName,
        revealedAt: null,
        readyDeadline: audioReadyDeadline(),
      };
      push(ctx, { t: "media.set", d: { playback } });
      push(ctx, { t: "song.put", d: { song: { ...song, state: "played" } } });
      const idx = songIndex(store, songId);
      setStageIfUnlocked(ctx, { mode: "song", payload: { songIndex: idx + 1, total: store.state.songs.length }, prevMode: "bid" });
      toast(ctx, `播歌：第 ${idx + 1} 首（等 deck ready ACK）`);
      ctx.result = { songId, deckId, state: "preparing" };
      break;
    }
    case "media.pause": {
      const deckId = leaseDeck(ctx, optStr(p, "deckId"));
      const pb = store.state.playback;
      if (!pb || pb.deckId !== deckId) throw new CmdError("W_ALREADY_STATE", "唔係你部機播緊");
      if (pb.state !== "playing") throw new CmdError("W_ALREADY_STATE", `而家係 ${pb.state}`);
      const positionMs = pb.positionMs + Math.max(0, Date.now() - pb.playStartedAt);
      push(ctx, { t: "media.set", d: { playback: { ...pb, state: "paused", positionMs, pausedAt: Date.now() } } });
      toast(ctx, "暫停");
      break;
    }
    case "media.resume": {
      const deckId = leaseDeck(ctx, optStr(p, "deckId"));
      const pb = store.state.playback;
      if (!pb || pb.deckId !== deckId) throw new CmdError("W_ALREADY_STATE", "唔係你部機");
      if (pb.state !== "paused") throw new CmdError("W_ALREADY_STATE", `而家係 ${pb.state}`);
      // 入 preparing 一定要重新起算 readyDeadline：舊值（play 嗰刻）早就過咗，
      // 下一個 tickLeases 會即刻轉 failed（codex 第五輪 #1b）
      push(ctx, {
        t: "media.set",
        d: { playback: { ...pb, state: "preparing", playStartedAt: 0, resumedAt: Date.now(), readyDeadline: audioReadyDeadline() } },
      });
      toast(ctx, "繼續播（等 ready）");
      break;
    }
    case "media.stop": {
      const deckId = leaseDeck(ctx, optStr(p, "deckId"));
      const pb = store.state.playback;
      if (pb && pb.deckId === deckId) push(ctx, { t: "media.set", d: { playback: { ...pb, state: "idle", playStartedAt: 0, positionMs: 0, pausedAt: undefined } } });
      toast(ctx, "停播");
      break;
    }
    case "media.reveal": {
      const pb = store.state.playback;
      if (!pb) throw new CmdError("W_ALREADY_STATE", "未播過歌");
      const song = store.state.songs.find((s) => s.id === pb.songId);
      if (!song) throw new CmdError("W_BAD_SCHEMA", "冇呢首歌");
      push(ctx, { t: "media.set", d: { playback: { ...pb, revealedAt: Date.now() } } });
      push(ctx, {
        t: "stage.set",
        d: { stage: { mode: "reveal", payload: { songTitle: song.title, songIndex: song.index }, prevMode: "song" } },
      });
      toast(ctx, `揭曉歌名：《${song.title}》`);
      ctx.result = { title: song.title };
      break;
    }
    case "bid.settle": {
      const roundId = optStr(p, "roundId") ?? room.currentRoundId;
      if (!roundId) throw new CmdError("W_BAD_SCHEMA", "冇 round");
      const round = store.round(roundId);
      if (!round) throw new CmdError("W_BAD_SCHEMA", "冇呢個 round");
      const card = store.card(round.cardId);
      if (!card || card.type !== "bid") throw new CmdError("W_BAD_SCHEMA", "唔係 bid 卡");
      const { submission: best, second } = bidWinner(store, roundId);
      if (!best) throw new CmdError("W_ALREADY_STATE", "冇人出價");
      const correct = p.correct === true;
      const backup = p.backup === true;
      // 同一 round 重複結算：先 void 上次 host 結算分（更正語義，唔會雙派）
      const prevSettle = store.state.ledger.filter((e) => e.roundId === roundId && e.gameId === "auction" && e.by === "host" && !e.voided).map((e) => e.id);
      if (prevSettle.length) push(ctx, { t: "ledger.void", d: { eventIds: prevSettle, by: "host" } });
      const song = card.songId ? store.state.songs.find((s) => s.id === card.songId) : undefined;
      const reason = `估歌 ${song ? `S${song.index}` : card.id}`;
      const events: ScoreEvent[] = [];
      if (correct) {
        events.push(
          makeEvent({
            target: { type: "player", id: best.playerId },
            gameId: "auction",
            roundId,
            cardId: card.id,
            submissionId: best.id,
            delta: card.points,
            reason,
            by: "host",
          }),
        );
      } else if (backup && second) {
        const half = Math.ceil(card.points / 2);
        events.push(
          makeEvent({
            target: { type: "player", id: second.playerId },
            gameId: "auction",
            roundId,
            cardId: card.id,
            submissionId: second.id,
            delta: half,
            reason: `${reason}・次高補答`,
            by: "host",
          }),
        );
      }
      if (events.length) push(ctx, { t: "ledger.append", d: { events } });
      toast(ctx, correct ? `估歌答對：${store.player(best.playerId)?.name} +${card.points}` : backup && second ? `次高補答 +${Math.ceil(card.points / 2)}` : "估歌答錯，0 分");
      ctx.result = { winnerId: best.playerId, correct, points: correct ? card.points : backup && second ? Math.ceil(card.points / 2) : 0, voidedPrevious: prevSettle.length };
      break;
    }

    /* ── v0.3.0：拍賣時間估歌（最少秒數贏）── */
    case "bid.publish": {
      const roundId = optStr(p, "roundId") ?? room.currentRoundId;
      if (!roundId) throw new CmdError("W_BAD_SCHEMA", "冇 round");
      const round = store.round(roundId);
      if (!round) throw new CmdError("W_BAD_SCHEMA", "冇呢個 round");
      const card = store.card(round.cardId);
      if (!card || card.type !== "bid") throw new CmdError("W_BAD_SCHEMA", "唔係 bid 卡");
      // A2：本首已經收成終態（finish／reveal／void）就唔准再公佈，否則 revealed 會被拉返 closed 再判分
      if (round.auction?.finished || round.state === "revealed" || round.state === "void")
        throw new CmdError("W_ALREADY_STATE", "本首已經完結（唔可以再公佈排名／再判分）");
      // B3：已經公佈過就回傳原排名，唔准重建（重建會重置 cursor／judged，同一首歌可以再派分）
      if (round.auction && round.auction.ranking.length) {
        setStageIfUnlocked(ctx, { mode: "bid", payload: { roundId, cardId: card.id, published: true } });
        toast(ctx, "排名已經公佈咗（唔會重算／唔會重置判分）");
        ctx.result = { roundId, ranking: round.auction.ranking, cursor: round.auction.cursor, already: true };
        break;
      }
      const subs = bidRanking(store, roundId);
      if (!subs.length) throw new CmdError("W_ALREADY_STATE", "冇人競投（最少 1 秒先算）");
      const ranking = subs.map((x) => ({ playerId: x.playerId, seconds: x.amount ?? 0, ts: x.ts }));
      const auction = { ranking, cursor: 0, judged: [] as string[], finished: false };
      push(ctx, {
        t: "round.update",
        d: { roundId, patch: { state: "closed", closedAt: round.closedAt ?? Date.now(), auction } },
      });
      push(ctx, { t: "card.update", d: { cardId: card.id, patch: { state: "closed" } } });
      setStageIfUnlocked(ctx, { mode: "bid", payload: { roundId, cardId: card.id, published: true } });
      const first = ranking[0];
      toast(ctx, `競投結果：最少 ${first?.seconds ?? 0} 秒由 ${store.player(first?.playerId ?? "")?.name ?? "?"} 先聽`);
      ctx.result = { roundId, ranking, cursor: 0 };
      break;
    }
    case "bid.judge": {
      const roundId = optStr(p, "roundId") ?? room.currentRoundId;
      if (!roundId) throw new CmdError("W_BAD_SCHEMA", "冇 round");
      const round = store.round(roundId);
      if (!round) throw new CmdError("W_BAD_SCHEMA", "冇呢個 round");
      const card = store.card(round.cardId);
      if (!card || card.type !== "bid") throw new CmdError("W_BAD_SCHEMA", "唔係 bid 卡");
      const auction = round.auction;
      if (!auction || !auction.ranking.length) throw new CmdError("W_ALREADY_STATE", "先 bid.publish 出排名");
      if (auction.finished) {
        toast(ctx, "本首已經完結（重複判分唔會再加）");
        ctx.result = { already: true, roundId };
        break;
      }
      const current = auction.ranking[auction.cursor];
      const wanted = optStr(p, "playerId");
      if (wanted && wanted !== current?.playerId)
        throw new CmdError("W_STALE_COMMAND", `而家輪到 ${current?.playerId ?? "（冇）"}，唔係 ${wanted}`);
      const targetId = wanted ?? current?.playerId ?? "";
      if (!targetId) throw new CmdError("W_BAD_SCHEMA", "冇指定玩家");
      const idx = auction.ranking.findIndex((r) => r.playerId === targetId);
      if (idx < 0) throw new CmdError("W_BAD_SCHEMA", "呢個人唔喺排名");
      const correct = p.correct === true;
      const target = store.player(targetId);
      if (correct) {
        const dup = store.state.ledger.some(
          (e) => !e.voided && e.roundId === roundId && e.gameId === "auction" && e.target.id === targetId && e.reason === "估歌・聽歌",
        );
        if (!dup && card.points !== 0) {
          push(ctx, {
            t: "ledger.append",
            d: {
              events: [
                makeEvent({
                  target: { type: "player", id: targetId },
                  gameId: "auction",
                  roundId,
                  cardId: card.id,
                  delta: card.points,
                  reason: "估歌・聽歌",
                  by: "host",
                }),
              ],
            },
          });
        }
        const judged = [...new Set([...auction.judged, targetId])];
        // B1：本首完結要收成終態（revealed），唔係 closed —— 否則下一張拍賣卡永遠開唔到
        push(ctx, {
          t: "round.update",
          d: {
            roundId,
            patch: { state: "revealed", closedAt: round.closedAt ?? Date.now(), auction: { ...auction, judged, finished: true } },
          },
        });
        push(ctx, { t: "card.update", d: { cardId: card.id, patch: { state: "revealed" } } });
        stageSet(ctx, {
          mode: "message",
          payload: {
            title: "估中！",
            lines: [`${target?.name ?? "?"} +${card.points}`, `佢只係聽咗 ${auction.ranking[idx]?.seconds ?? 0} 秒`],
            tone: "good",
          },
          prevMode: "bid",
        });
        toast(ctx, `估中：${target?.name ?? targetId} +${card.points}`);
        ctx.result = { roundId, playerId: targetId, correct: true, finished: true, points: card.points };
        break;
      }
      const nextCursor = idx + 1;
      if (nextCursor >= auction.ranking.length) {
        push(ctx, {
          t: "round.update",
          d: {
            roundId,
            patch: { state: "revealed", closedAt: round.closedAt ?? Date.now(), auction: { ...auction, cursor: nextCursor, finished: true } },
          },
        });
        push(ctx, { t: "card.update", d: { cardId: card.id, patch: { state: "revealed" } } });
        stageSet(ctx, {
          mode: "message",
          payload: { title: "全部人都估唔到", lines: ["呢首冇人得分", "主持可以揭曉歌名／播下一首"], tone: "bad" },
          prevMode: "bid",
        });
        toast(ctx, "全部人都估唔到（0 分）");
        ctx.result = { roundId, correct: false, finished: true, cursor: nextCursor };
        break;
      }
      push(ctx, { t: "round.update", d: { roundId, patch: { auction: { ...auction, cursor: nextCursor } } } });
      setStageIfUnlocked(ctx, { mode: "bid", payload: { roundId, cardId: card.id, published: true } });
      const next = auction.ranking[nextCursor];
      toast(ctx, `下一位：${store.player(next?.playerId ?? "")?.name ?? "?"}（${next?.seconds ?? 0} 秒）`);
      ctx.result = { roundId, correct: false, cursor: nextCursor, nextPlayerId: next?.playerId };
      break;
    }
    case "bid.finish": {
      const roundId = optStr(p, "roundId") ?? room.currentRoundId;
      if (!roundId) throw new CmdError("W_BAD_SCHEMA", "冇 round");
      const round = store.round(roundId);
      if (!round) throw new CmdError("W_BAD_SCHEMA", "冇呢個 round");
      const card = store.card(round.cardId);
      const auction = round.auction;
      if (auction?.finished) {
        toast(ctx, "本首已經完結");
        ctx.result = { already: true };
        break;
      }
      // B1：零人競投／未 publish 都收得（收成 revealed，否則下一首開唔到卡）
      push(ctx, {
        t: "round.update",
        d: {
          roundId,
          patch: { state: "revealed", closedAt: round.closedAt ?? Date.now(), ...(auction ? { auction: { ...auction, finished: true } } : {}) },
        },
      });
      if (card) push(ctx, { t: "card.update", d: { cardId: card.id, patch: { state: "revealed" } } });
      stageSet(ctx, {
        mode: "message",
        payload: { title: "本首完結", lines: ["主持會播下一首"], tone: "normal" },
        prevMode: "bid",
      });
      toast(ctx, "本首完結");
      ctx.result = { roundId, finished: true };
      break;
    }

    /* ── M3：畫畫（作品牆／評審） ── */
    case "draw.judge": {
      const cardId = cmd.targetId ?? reqStr(p, "cardId");
      const assetId = reqStr(p, "assetId");
      const card = store.card(cardId);
      if (!card) throw new CmdError("W_BAD_SCHEMA", "冇呢張卡");
      if (card.type !== "vote" || card.voteMode !== "works") throw new CmdError("W_BAD_SCHEMA", "呢張卡唔係畫畫投票卡");
      const asset = store.state.assets.find((a) => a.id === assetId);
      if (!asset || asset.kind !== "image" || !(card.options ?? []).includes(assetId))
        throw new CmdError("W_BAD_SCHEMA", "作品唔屬於呢張投票卡");
      const authorId = asset.authorId;
      if (!authorId) throw new CmdError("W_BAD_SCHEMA", "作品冇作者");
      const points = Number(p.points ?? 0);
      if (![0, 1, 2].includes(points)) throw new CmdError("W_BAD_SCHEMA", "評審分要 1／2／0");
      if (points === 0) {
        const prev = [...store.state.ledger]
          .reverse()
          .find((e) => !e.voided && e.by === "host" && e.gameId === "draw" && e.cardId === cardId && e.target.id === authorId && e.reason.includes("主持評分"));
        if (prev) push(ctx, { t: "ledger.void", d: { eventIds: [prev.id], by: "host" } });
        toast(ctx, "主持評分：取消上一筆");
      } else {
        push(ctx, {
          t: "ledger.append",
          d: {
            events: [
              makeEvent({
                target: { type: "player", id: authorId },
                gameId: "draw",
                roundId: room.currentRoundId ?? undefined,
                cardId,
                delta: points,
                reason: "畫畫・主持評分",
                by: "host",
              }),
            ],
          },
        });
        toast(ctx, `主持評分 +${points}（${store.player(authorId)?.name}）`);
      }
      ctx.result = { authorId, points };
      break;
    }
    case "draw.focus": {
      const assetId = p.assetId === null ? null : reqStr(p, "assetId");
      stageSet(ctx, {
        mode: assetId ? "draw-focus" : "draw-wall",
        payload: { focusId: assetId },
        prevMode: room.stage.mode as Exclude<StageMode, "blackout" | "rules">,
      });
      toast(ctx, assetId ? "放大作品" : "作品牆");
      break;
    }

    /* ── M4：搗蛋鬼（版本 A，§4） ── */
    case "saboteur.assign": {
      ensurePlaying(store);
      const approved = store.approvedPlayers();
      if (approved.length < 3) throw new CmdError("W_ALREADY_STATE", "至少 3 位 approved 玩家先玩到");
      const seed = optNum(p, "saboteurIndex");
      const sab = typeof seed === "number" ? approved[seed % approved.length] : approved[Math.floor(Math.random() * approved.length)];
      const sabId = (sab as Player).id;
      for (const pl of approved) {
        push(ctx, { t: "player.setRole", d: { playerId: pl.id, role: pl.id === sabId ? "saboteur" : "crew" } });
      }
      push(ctx, {
        t: "game.set",
        d: {
          gameState: {
            saboteur: {
              saboteurId: sabId,
              eliminatedIds: [],
              rounds: [],
              caught: false,
              finished: false,
              revealedRole: null,
            },
          },
        },
      });
      toast(ctx, `已派身份（1 個搗蛋鬼／${approved.length - 1} 個好人；主持可以口頭帶入下一輪）`);
      ctx.result = { saboteurId: sabId, players: approved.length };
      break;
    }
    case "saboteur.openRound": {
      ensurePlaying(store);
      const st = cloneSaboteur(store);
      if (st.finished) throw new CmdError("W_ALREADY_STATE", "遊戲已完結");
      // 獨立檢查未裁決嘅 saboteur record：唔可以靠 current round 嘅 display state
      // （generic card.reveal／card.close 之後 round 已經 revealed／closed，但 record 仲等裁決）
      const pending = unsettledSaboteurRounds(store)[0];
      if (pending) throw new CmdError("W_ALREADY_STATE", `第 ${pending.index} 輪仲未裁決：先 saboteur.decide（retry／eliminate）`);
      const openRound = store.currentRound();
      if (openRound && (openRound.state === "open" || openRound.state === "closed" || openRound.state === "tally"))
        throw new CmdError("W_ALREADY_STATE", "仲有回合未完成");
      const index = Math.max(0, ...st.rounds.map((r) => r.index)) + 1;
      const existingCard = store.gameCards("saboteur").find((c) => c.type === "vote" && c.voteMode === "players");
      let card: Card;
      if (existingCard) {
        card = existingCard;
      } else {
        const newCard: Card = {
          id: newId("card"),
          type: "vote",
          gameId: "saboteur",
          voteMode: "players",
          prompt: "邊個係搗蛋鬼？投佢一票",
          seconds: 30,
          points: 0,
          version: 1,
          state: "draft",
        };
        card = newCard;
        push(ctx, { t: "card.put", d: { card: newCard } });
        const item = room.rundown.find((i) => i.gameId === "saboteur");
        if (item) {
          const rundown = room.rundown.map((i) => (i.id === item.id ? { ...i, cardIds: [...i.cardIds, newCard.id] } : { ...i }));
          push(ctx, { t: "rundown.set", d: { rundown, currentItemId: room.currentItemId, phase: room.phase } });
        }
      }
      const eligible = store.approvedPlayers().filter((pl) => !st.eliminatedIds.includes(pl.id)).map((pl) => pl.id);
      if (eligible.length < 2) throw new CmdError("W_ALREADY_STATE", "少過 2 個 eligible 玩家");
      const sabCard = card as Card;
      const round: Round = {
        id: `${sabCard.id}#${room.rounds.filter((r) => r.cardId === sabCard.id).length + 1}`,
        cardId: sabCard.id,
        cardVersion: sabCard.version,
        endsAt: sabCard.seconds ? Date.now() + sabCard.seconds * 1000 : null,
        closedAt: null,
        state: "open",
        eligiblePlayerIds: eligible,
      };
      st.rounds = [
        ...st.rounds,
        { index, roundId: round.id, eligiblePlayerIds: eligible, votes: [], state: "open", eliminatedId: null, retried: false, decision: null },
      ];
      push(ctx, { t: "game.set", d: { gameState: { saboteur: st } } });
      push(ctx, { t: "card.update", d: { cardId: sabCard.id, patch: { state: "open", prompt: `第 ${index} 輪：邊個係搗蛋鬼？` } } });
      push(ctx, { t: "round.put", d: { round, currentRoundId: round.id } });
      setStageIfUnlocked(ctx, { mode: "vote", payload: { roundId: round.id, cardId: sabCard.id, saboteurRound: index }, prevMode: "rules" as unknown as Exclude<StageMode, "blackout" | "rules"> });
      toast(ctx, `搗蛋鬼第 ${index} 輪投票開始（eligible ${eligible.length}）`);
      ctx.result = { roundId: round.id, index, eligible: eligible.length };
      break;
    }
    case "saboteur.closeRound": {
      const roundId = optStr(p, "roundId") ?? room.currentRoundId;
      if (!roundId) throw new CmdError("W_BAD_SCHEMA", "冇 round");
      const round = store.round(roundId);
      if (!round) throw new CmdError("W_BAD_SCHEMA", "冇呢個 round");
      const st = cloneSaboteur(store);
      const rOut = st.rounds.find((r) => r.roundId === roundId);
      if (!rOut) throw new CmdError("W_BAD_SCHEMA", "唔係搗蛋鬼 round");
      if (rOut.state === "resolved") throw new CmdError("W_ALREADY_STATE", `第 ${rOut.index} 輪已結算`);
      // auto-close／card.tally 可能已經收咗卷（round=closed／tally）但未裁決：再撳「立即計票」照計，唔可以撞死
      if (round.state !== "open" && round.state !== "closed" && round.state !== "tally")
        throw new CmdError("W_ALREADY_STATE", `round 係 ${round.state}`);
      if (round.state === "open") {
        push(ctx, { t: "round.update", d: { roundId, patch: { state: "closed", closedAt: Date.now() } } });
        push(ctx, { t: "card.update", d: { cardId: round.cardId, patch: { state: "tally" } } });
        setStageIfUnlocked(ctx, { mode: "tally", payload: { roundId, cardId: round.cardId, saboteurRound: rOut.index }, prevMode: "vote" });
      }
      const tally = tallySaboteurRound(ctx, st, round);
      toast(ctx, `第 ${rOut.index} 輪：有效票 ${tally.validVotes}，最高 ${tally.top[0]?.count ?? 0} 票${tally.mode === "eliminate" ? "（過半，即場淘汰）" : tally.mode === "decide" ? "（未過半／平票，主持裁決）" : "（全體棄權）"}`);
      ctx.result = { ...(ctx.result ?? {}), roundId, ...tally };
      break;
    }
    case "saboteur.decide": {
      const roundId = optStr(p, "roundId") ?? room.currentRoundId;
      if (!roundId) throw new CmdError("W_BAD_SCHEMA", "冇 round");
      const st = cloneSaboteur(store);
      const rOut = st.rounds.find((r) => r.roundId === roundId);
      if (!rOut) throw new CmdError("W_BAD_SCHEMA", "唔係搗蛋鬼 round");
      if (rOut.state === "resolved") throw new CmdError("W_ALREADY_STATE", "呢輪已裁決");
      // finish 之後唔准再裁決（會改 caught／再派 +3，同 finish 嘅 +5 矛盾）
      if (st.finished) throw new CmdError("W_ALREADY_STATE", "遊戲已完結，唔可以再裁決");
      const decision = optStr(p, "decision");
      if (decision === "retry") {
        if (rOut.retried) throw new CmdError("W_ALREADY_STATE", "每輪最多重投一次");
        const round = store.round(roundId);
        if (!round) throw new CmdError("W_BAD_SCHEMA", "冇 round");
        push(ctx, { t: "round.update", d: { roundId, patch: { state: "void" } } });
        push(ctx, { t: "round.current", d: { currentRoundId: null } });
        rOut.state = "resolved";
        rOut.decision = "retry";
        const card = store.card(round.cardId);
        const newRound: Round = {
          id: `${round.cardId}#${room.rounds.filter((r) => r.cardId === round.cardId).length + 1}`,
          cardId: round.cardId,
          cardVersion: card?.version ?? 1,
          retryOf: roundId,
          endsAt: card?.seconds ? Date.now() + card.seconds * 1000 : null,
          closedAt: null,
          state: "open",
          eligiblePlayerIds: [...round.eligiblePlayerIds],
        };
        st.rounds = [
          ...st.rounds,
          {
            index: rOut.index,
            roundId: newRound.id,
            eligiblePlayerIds: newRound.eligiblePlayerIds,
            votes: [],
            state: "open",
            eliminatedId: null,
            retried: true,
            decision: null,
          },
        ];
        push(ctx, { t: "game.set", d: { gameState: { saboteur: st } } });
        push(ctx, { t: "card.update", d: { cardId: round.cardId, patch: { state: "open" } } });
        push(ctx, { t: "round.put", d: { round: newRound, currentRoundId: newRound.id } });
        setStageIfUnlocked(ctx, { mode: "vote", payload: { roundId: newRound.id, cardId: round.cardId, saboteurRound: rOut.index, retry: true } });
        toast(ctx, `第 ${rOut.index} 輪重投（原 round void，原票保留但唔計分）`);
        ctx.result = { roundId: newRound.id, retried: true };
        break;
      }
      if (decision === "eliminate") {
        const targetId = reqStr(p, "targetId");
        push(ctx, { t: "round.update", d: { roundId, patch: { closedAt: Date.now() } } });
        eliminateSaboteur(ctx, st, targetId, roundId);
        break;
      }
      throw new CmdError("W_BAD_SCHEMA", "decision 要 retry／eliminate");
    }
    case "saboteur.finish": {
      const st = cloneSaboteur(store);
      if (st.finished) throw new CmdError("W_ALREADY_STATE", "已經完結");
      st.finished = true;
      st.revealedRole = "saboteur";
      // 原子終結所有未結算輪次：record → resolved（decision='none'），連帶把仲 open／closed／tally
      // 嘅 round 同卡收成 revealed。唔可以留低一個 open round，否則之後 auto-close／card.close 會再
      // tally 一次（caught=true＋投票者 +3），同 finish 頒嘅 +5 互相矛盾。
      const finishedAt = Date.now();
      for (const r of st.rounds) {
        if (r.state === "resolved") continue;
        r.state = "resolved";
        r.decision = "none";
        r.eliminatedId = null;
        const live = store.round(r.roundId);
        if (!live || (live.state !== "open" && live.state !== "closed" && live.state !== "tally")) continue;
        push(ctx, { t: "round.update", d: { roundId: live.id, patch: { state: "revealed", closedAt: live.closedAt ?? finishedAt } } });
        if (store.card(live.cardId)) push(ctx, { t: "card.update", d: { cardId: live.cardId, patch: { state: "revealed" } } });
      }
      const sab = store.player(st.saboteurId ?? "");
      if (sab) {
        push(ctx, {
          t: "ledger.append",
          d: {
            events: [
              makeEvent({ target: { type: "player", id: sab.id }, gameId: "saboteur", delta: 5, reason: "搗蛋鬼・潛伏成功", by: "auto" }),
            ],
          },
        });
      }
      push(ctx, { t: "game.set", d: { gameState: { saboteur: st } } });
      push(ctx, { t: "stage.set", d: { stage: { mode: "role-reveal", payload: { caught: false, saboteurId: st.saboteurId }, prevMode: "vote" } } });
      toast(ctx, "兩輪都揪唔中：搗蛋鬼 +5");
      ctx.result = { finished: true, caught: false };
      break;
    }
    case "saboteur.reset": {
      for (const pl of store.state.room.players) push(ctx, { t: "player.setRole", d: { playerId: pl.id, role: null } });
      push(ctx, { t: "game.set", d: { gameState: { saboteur: null } } });
      toast(ctx, "搗蛋鬼：重設身份");
      break;
    }

    /* ── v0.3.0：笨蛋殺手（一個老闆一個殺手；身份只出主持台，唔用 Player.secretRole） ── */
    case "killer.assign": {
      ensurePlaying(store);
      const approved = store.approvedPlayers();
      if (approved.length < 3) throw new CmdError("W_ALREADY_STATE", "至少 3 位 approved 玩家先玩到");
      const ids = shuffled(approved.map((pl) => pl.id));
      const bossId = ids[0] as string;
      const killerId = ids[1] as string;
      push(ctx, { t: "game.set", d: { gameState: { killer: { bossId, killerId, assignedAt: Date.now() } } } });
      toast(ctx, `笨蛋殺手：抽咗老闆＋殺手（主持台先見到身份）`);
      ctx.result = { bossId, killerId, players: approved.length };
      break;
    }
    case "killer.redraw": {
      const prev = store.state.room.gameState?.killer ?? null;
      if (!prev) throw new CmdError("W_ALREADY_STATE", "未抽（先 killer.assign）");
      const approved = store.approvedPlayers();
      if (approved.length < 3) throw new CmdError("W_ALREADY_STATE", "至少 3 位 approved 玩家先玩到");
      let bossId = prev.bossId ?? "";
      let killerId = prev.killerId ?? "";
      for (let i = 0; i < 20; i += 1) {
        const ids = shuffled(approved.map((pl) => pl.id));
        const b = ids[0] as string;
        const k = ids[1] as string;
        bossId = b;
        killerId = k;
        if (!(b === prev.bossId && k === prev.killerId)) break;
      }
      push(ctx, { t: "game.set", d: { gameState: { killer: { bossId, killerId, assignedAt: Date.now() } } } });
      toast(ctx, "重抽咗老闆＋殺手");
      ctx.result = { bossId, killerId };
      break;
    }
    case "killer.clear": {
      push(ctx, { t: "game.set", d: { gameState: { killer: null } } });
      toast(ctx, "清咗笨蛋殺手身份");
      ctx.result = { cleared: true };
      break;
    }

    default:
      throw new CmdError("W_BAD_SCHEMA", `未知 command kind: ${cmd.kind}`);
  }

  if (ctx.muts.length === 0) throw new CmdError("W_BAD_SCHEMA", "冇 mutation");
  const newRevision = store.revision + 1;
  const receipt: CommandReceipt = {
    commandId: cmd.commandId,
    payloadHash: ph,
    hostId,
    kind: cmd.kind,
    ts: Date.now(),
    result: ctx.result ?? { kind: cmd.kind },
    revision: newRevision,
  };
  ctx.muts.push({ t: "receipt.add", d: { receipt } });
  store.commit(ctx.muts, { bumpRevision: true });
  return { ok: true, revision: newRevision, result: receipt.result };
}
