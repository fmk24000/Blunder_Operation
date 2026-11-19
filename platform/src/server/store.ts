/**
 * Server state + journal reducers（PLAN-v3.1 §6）
 * - journal 係唯一真相：所有 mutation 先 journal.append（fsync）再 apply，然後 broadcast
 * - replay＝逐筆 apply 同一批 reducer，所以 live 同 replay 走同一條路
 */
import crypto from "node:crypto";
import type {
  ActivityToast,
  AudioLease,
  Award,
  Card,
  CommandReceipt,
  MediaPlayback,
  Player,
  Room,
  RoomSettings,
  Round,
  RuleBlock,
  RulePage,
  ScoreEvent,
  Session,
  Song,
  StageState,
  Submission,
} from "../shared/types.js";
import type { Mutation } from "./journal.js";
import { Journal } from "./journal.js";
import { sha256 } from "./env.js";

export type MediaAsset = {
  id: string;
  kind: "image" | "audio";
  file: string;
  mime: string;
  size: number;
  originalName: string;
  uploadedBy: string;
  createdAt: number;
  authorId?: string;
  cardId?: string;
};

export type Settings = {
  autoClose: boolean;
  maxBid: number;
  pinHash: string;
  allowRepeatAwards: boolean;
};

export type StoreState = {
  room: Room;
  cards: Card[];
  songs: Song[];
  submissions: Submission[];
  ledger: ScoreEvent[];
  sessions: Session[];
  receipts: Map<string, CommandReceipt>;
  settings: Settings;
  playback: MediaPlayback | null;
  activity: ActivityToast[];
  assets: MediaAsset[];
};

export type CommitMeta = {
  mutations: Mutation[];
  seq: number;
  revision: number;
  bumpRevision: boolean;
};

export type Listener = (meta: CommitMeta) => void;

export function now(): number {
  return Date.now();
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

export function uuidv4(): string {
  return crypto.randomUUID();
}

function emptyRoom(id: string, code: string, seqEpoch: string): Room {
  return {
    id,
    code,
    phase: "lobby",
    groups: [],
    players: [],
    rundown: [],
    rulePages: [],
    awards: [],
    currentItemId: null,
    currentRoundId: null,
    rounds: [],
    stage: {
      mode: "idle",
      payload: {},
      lock: false,
      ticker: { visible: true, scope: "player", range: "total", sort: "score-desc" },
    },
    seq: 0,
    revision: 0,
    seqEpoch,
  };
}

function find<T extends { id: string }>(arr: T[], id: string): T | undefined {
  return arr.find((x) => x.id === id);
}

function applyOne(st: StoreState, m: Mutation): void {
  const d = m.d as Record<string, unknown>;
  switch (m.t) {
    case "room.init": {
      st.room.id = String(d.id ?? st.room.id);
      st.room.code = String(d.code ?? st.room.code);
      if (typeof d.phase === "string") st.room.phase = d.phase as Room["phase"];
      break;
    }
    case "room.phase": {
      st.room.phase = d.phase as Room["phase"];
      break;
    }
    case "player.add": {
      const p = d.player as Player;
      if (!find(st.room.players, p.id)) st.room.players.push(p);
      if (d.session) {
        const s = d.session as Session;
        if (!st.sessions.some((x) => x.tokenHash === s.tokenHash)) st.sessions.push(s);
      }
      break;
    }
    case "player.update": {
      const p = d.playerId ? find(st.room.players, String(d.playerId)) : undefined;
      if (p && d.patch) Object.assign(p, d.patch as Partial<Player>);
      break;
    }
    case "player.remove": {
      st.room.players = st.room.players.filter((p) => p.id !== String(d.playerId));
      break;
    }
    case "player.setRole": {
      const p = find(st.room.players, String(d.playerId));
      if (p) {
        if (d.role === null || d.role === undefined) delete p.secretRole;
        else p.secretRole = d.role as "saboteur" | "crew";
      }
      break;
    }
    case "session.add": {
      const s = d.session as Session;
      if (!st.sessions.some((x) => x.tokenHash === s.tokenHash)) st.sessions.push(s);
      break;
    }
    case "session.revoke": {
      for (const s of st.sessions) {
        if (d.playerId && s.playerId === String(d.playerId)) s.revoked = true;
        if (d.hostId && s.hostId === String(d.hostId)) s.revoked = true;
        if (d.tokenHash && s.tokenHash === String(d.tokenHash)) s.revoked = true;
      }
      break;
    }
    case "groups.set": {
      st.room.groups = (d.groups as Room["groups"]) ?? [];
      break;
    }
    case "group.assign": {
      const p = find(st.room.players, String(d.playerId));
      if (p) p.groupId = (d.groupId as string | null) ?? null;
      break;
    }
    case "rundown.set": {
      st.room.rundown = (d.rundown as Room["rundown"]) ?? st.room.rundown;
      if (d.currentItemId !== undefined) st.room.currentItemId = (d.currentItemId as string | null) ?? null;
      if (typeof d.phase === "string") st.room.phase = d.phase as Room["phase"];
      break;
    }
    case "card.put": {
      const c = d.card as Card;
      const i = st.cards.findIndex((x) => x.id === c.id);
      if (i >= 0) st.cards[i] = c;
      else st.cards.push(c);
      break;
    }
    case "card.update": {
      const c = find(st.cards, String(d.cardId));
      if (c && d.patch) Object.assign(c, d.patch as Partial<Card>);
      break;
    }
    case "card.remove": {
      st.cards = st.cards.filter((c) => c.id !== String(d.cardId));
      break;
    }
    case "round.put": {
      const r = d.round as Round;
      const i = st.room.rounds.findIndex((x) => x.id === r.id);
      if (i >= 0) st.room.rounds[i] = r;
      else st.room.rounds.push(r);
      if (d.currentRoundId !== undefined) st.room.currentRoundId = (d.currentRoundId as string | null) ?? null;
      break;
    }
    case "round.current": {
      st.room.currentRoundId = (d.currentRoundId as string | null) ?? null;
      break;
    }
    case "round.update": {
      const r = find(st.room.rounds, String(d.roundId));
      if (r && d.patch) Object.assign(r, d.patch as Partial<Round>);
      break;
    }
    case "submission.add": {
      const s = d.submission as Submission;
      if (!st.submissions.some((x) => x.id === s.id)) st.submissions.push(s);
      break;
    }
    case "submission.update": {
      const s = st.submissions.find((x) => x.id === String(d.submissionId));
      if (s && d.patch) Object.assign(s, d.patch as Partial<Submission>);
      break;
    }
    case "game.set": {
      st.room.gameState = { ...(st.room.gameState ?? {}), ...((d.gameState as Record<string, unknown>) ?? {}) };
      break;
    }
    case "ledger.append": {
      const evs = (d.events as ScoreEvent[]) ?? [];
      for (const e of evs) if (!st.ledger.some((x) => x.id === e.id)) st.ledger.push(e);
      break;
    }
    case "ledger.void": {
      const ids = new Set((d.eventIds as string[]) ?? []);
      for (const e of st.ledger) if (ids.has(e.id)) e.voided = true;
      break;
    }
    case "stage.set": {
      const s = d.stage as Partial<StageState>;
      st.room.stage = { ...st.room.stage, ...s };
      break;
    }
    case "rules.set": {
      st.room.rulePages = (d.rulePages as RulePage[]) ?? [];
      break;
    }
    case "award.set": {
      st.room.awards = (d.awards as Award[]) ?? [];
      break;
    }
    case "media.set": {
      st.playback = (d.playback as MediaPlayback | null) ?? null;
      break;
    }
    case "lease.set": {
      if (d.lease) st.room.audioLease = d.lease as AudioLease;
      else delete st.room.audioLease;
      break;
    }
    case "settings.set": {
      if (d.settings) Object.assign(st.settings, d.settings as Partial<Settings>);
      break;
    }
    case "activity.add": {
      const t = d.toast as ActivityToast;
      st.activity.push(t);
      if (st.activity.length > 50) st.activity.splice(0, st.activity.length - 50);
      break;
    }
    case "quiz.set": {
      const cards = (d.cards as Card[]) ?? [];
      const ids = new Set(cards.map((c) => c.id));
      st.cards = st.cards.filter((c) => c.gameId !== "quiz" || ids.has(c.id));
      for (const c of cards) {
        const i = st.cards.findIndex((x) => x.id === c.id);
        if (i >= 0) st.cards[i] = c;
        else st.cards.push(c);
      }
      break;
    }
    case "song.put": {
      const s = d.song as Song;
      const i = st.songs.findIndex((x) => x.id === s.id);
      if (i >= 0) st.songs[i] = s;
      else st.songs.push(s);
      break;
    }
    case "song.remove": {
      st.songs = st.songs.filter((s) => s.id !== String(d.songId));
      break;
    }
    case "asset.add": {
      const a = d.asset as MediaAsset;
      if (!st.assets.some((x) => x.id === a.id)) st.assets.push(a);
      break;
    }
    case "asset.remove": {
      st.assets = st.assets.filter((a) => a.id !== String(d.assetId));
      break;
    }
    case "receipt.add": {
      const r = d.receipt as CommandReceipt;
      st.receipts.set(r.commandId, r);
      break;
    }
    default:
      console.warn(`[store] 未知 mutation type: ${m.t}`);
  }
}

export class Store {
  state: StoreState;
  journal: Journal;
  seqEpoch: string;
  private listeners = new Set<Listener>();
  private lastSeq = 0;
  private lastRevision = 0;

  constructor(
    public readonly roomId: string,
    journalDir: string,
    code: string,
  ) {
    this.seqEpoch = crypto.randomBytes(6).toString("hex");
    this.journal = new Journal(journalDir, roomId);
    this.state = {
      room: emptyRoom(roomId, code, this.seqEpoch),
      cards: [],
      songs: [],
      submissions: [],
      ledger: [],
      sessions: [],
      receipts: new Map(),
      settings: { autoClose: true, maxBid: 10, pinHash: "", allowRepeatAwards: false },
      playback: null,
      activity: [],
      assets: [],
    };
  }

  get seq(): number {
    return this.lastSeq;
  }
  get revision(): number {
    return this.lastRevision;
  }

  stateHash(): string {
    return sha256(`${this.seqEpoch}:${this.lastSeq}:${this.lastRevision}`);
  }

  /** 載入 journal 並 replay；回傳是否有既有房間 */
  load(): { loaded: boolean; truncated: number; segments: number[] } {
    const res = this.journal.load();
    for (const env of res.envelopes) {
      for (const m of env.data.records) applyOne(this.state, m);
      if (env.data.receipt) this.state.receipts.set(env.data.receipt.commandId, env.data.receipt);
      if (env.data.bumpRevision) this.lastRevision += 1; // §7 revision 係業務版本：重啟 replay 重建
      this.lastSeq = Math.max(this.lastSeq, env.seq + 1);
    }
    // seq 係傳輸序號：重啟後由 0 重新起（seqEpoch 每次開機都唔同，client 見到 epoch 變即用 snapshot）
    const loaded = this.state.room.players.length > 0 || this.state.room.rundown.length > 0;
    return { loaded, truncated: res.truncated, segments: res.segments };
  }

  onCommit(fn: Listener): void {
    this.listeners.add(fn);
  }

  /** 只 apply（唔落盤），用於 replay 或 bootstrap 內部 */
  applyMutations(muts: Mutation[]): void {
    for (const m of muts) applyOne(this.state, m);
  }

  /**
   * 落盤（fsync）→ apply → broadcast。
   * 全部同步執行，single-process 之下命令自然串列化。
   */
  commit(muts: Mutation[], opts: { bumpRevision?: boolean } = {}): CommitMeta {
    if (muts.length === 0) throw new Error("empty commit");
    const bump = opts.bumpRevision === true;
    const ready = (globalThis as { __hbdReady?: boolean }).__hbdReady === true;
    const fp = process.env.FAULT_POINT;
    const onType = process.env.FAULT_ON_TYPE;
    const matched = !onType || muts.some((m) => m.t === onType);
    const fire = ready && !!fp && matched;
    // fault-injection hook（只限測試；production startup 已經拒絕 FAULT_*）
    if (fire && fp === "before-append") process.kill(process.pid, "SIGKILL");
    if (ready && process.env.FAULT_ENOSPC === "1" && matched && !(globalThis as { __hbdEnospcDone?: boolean }).__hbdEnospcDone) {
      (globalThis as { __hbdEnospcDone?: boolean }).__hbdEnospcDone = true;
      const err = new Error("ENOSPC: no space left on device（FAULT_ENOSPC 注入：write 失敗）") as NodeJS.ErrnoException;
      err.code = "ENOSPC";
      throw err;
    }
    // receipt 由 caller 放入 mutation 陣列（同一筆 journal record）
    this.journal.append(muts, undefined, fire ? fp : undefined, bump);
    if (fire && fp === "after-fsync-before-ack") process.kill(process.pid, "SIGKILL");
    this.applyMutations(muts);
    if (bump) this.lastRevision += 1;
    this.lastSeq += 1;
    const meta: CommitMeta = { mutations: muts, seq: this.lastSeq, revision: this.lastRevision, bumpRevision: bump };
    for (const fn of this.listeners) {
      try {
        fn(meta);
      } catch (err) {
        console.error("[store] listener error", err);
      }
    }
    return meta;
  }

  /* ───────────── query helpers ───────────── */

  player(id: string): Player | undefined {
    return this.state.room.players.find((p) => p.id === id);
  }
  card(id: string): Card | undefined {
    return this.state.cards.find((c) => c.id === id);
  }
  round(id: string): Round | undefined {
    return this.state.room.rounds.find((r) => r.id === id);
  }
  currentRound(): Round | undefined {
    const id = this.state.room.currentRoundId;
    return id ? this.round(id) : undefined;
  }
  currentCard(): Card | undefined {
    const r = this.currentRound();
    return r ? this.card(r.cardId) : undefined;
  }
  currentItem() {
    const id = this.state.room.currentItemId;
    return id ? this.state.room.rundown.find((i) => i.id === id) : undefined;
  }
  quizCards(): Card[] {
    return this.state.cards.filter((c) => c.gameId === "quiz");
  }
  gameCards(gameId: string): Card[] {
    return this.state.cards.filter((c) => c.gameId === gameId);
  }
  approvedPlayers(): Player[] {
    return this.state.room.players.filter((p) => p.status === "approved");
  }

  /** 計分唯一公式（§6）：唔准另外寫 group.score */
  scoreMaps(): { player: Map<string, number>; group: Map<string, number> } {
    const player = new Map<string, number>();
    const group = new Map<string, number>();
    for (const e of this.state.ledger) {
      if (e.voided) continue;
      if (e.target.type === "player") player.set(e.target.id, (player.get(e.target.id) ?? 0) + e.delta);
      else group.set(e.target.id, (group.get(e.target.id) ?? 0) + e.delta);
    }
    // 個人分自動計入組分
    const withGroups = new Map(group);
    for (const p of this.state.room.players) {
      if (!p.groupId) continue;
      const s = player.get(p.id) ?? 0;
      withGroups.set(p.groupId, (withGroups.get(p.groupId) ?? 0) + s);
    }
    return { player, group: withGroups };
  }

  playerScore(id: string): number {
    return this.scoreMaps().player.get(id) ?? 0;
  }

  stats(): { total: number; avg: number; median: number; max: number; min: number; count: number } {
    const scores = this.approvedPlayers()
      .map((p) => this.playerScore(p.id))
      .sort((a, b) => a - b);
    const count = scores.length;
    if (count === 0) return { total: 0, avg: 0, median: 0, max: 0, min: 0, count: 0 };
    const total = scores.reduce((a, b) => a + b, 0);
    const mid = Math.floor(count / 2);
    const median =
      count % 2 === 1 ? (scores[mid] as number) : ((scores[mid - 1] as number) + (scores[mid] as number)) / 2;
    return {
      total,
      avg: total / count,
      median,
      max: scores[count - 1] as number,
      min: scores[0] as number,
      count,
    };
  }

  /** 頒獎計算（§6） */
  computeAwards(allowRepeat = this.state.settings.allowRepeatAwards): Award[] {
    const players = this.approvedPlayers().map((p) => ({ id: p.id, number: p.number, score: this.playerScore(p.id) }));
    const n = players.length;
    const empty = (id: Award["id"], rule: Award["rule"]): Award => ({
      id,
      targetId: null,
      rule,
      manual: false,
      revealed: false,
    });
    const grand = empty("grand", "max");
    // v0.3.0 中庸之道：改為最接近「平均數」（保留 nearest-median union 值但唔再用）
    const second = empty("second", "nearest-avg");
    const third = empty("third", "min");
    if (n === 0) return [grand, second, third];
    const byScoreDesc = [...players].sort((a, b) => b.score - a.score || a.number - b.number);
    const byScoreAsc = [...players].sort((a, b) => a.score - b.score || a.number - b.number);
    grand.targetId = (byScoreDesc[0] as { id: string }).id;
    // 平均數（中庸之道用；唔係中位數）
    const sum = players.reduce((acc, p) => acc + p.score, 0);
    const median = sum / n;
    if (n === 1) return [grand, second, third];
    if (n === 2) {
      const remaining = byScoreAsc.filter((p) => !(p.id === grand.targetId));
      third.targetId = (byScoreAsc[0] as { id: string })?.id ?? null;
      if (!allowRepeat && remaining.length) third.targetId = (remaining[0] as { id: string }).id;
      return [grand, second, third];
    }
    if (allowRepeat) {
      const byDist = [...players].sort(
        (a, b) => Math.abs(a.score - median) - Math.abs(b.score - median) || b.score - a.score || a.number - b.number,
      );
      second.targetId = (byDist[0] as { id: string }).id;
      third.targetId = (byScoreAsc[0] as { id: string }).id;
      return [grand, second, third];
    }
    const afterGrand = players.filter((p) => p.id !== grand.targetId);
    const byDist = [...afterGrand].sort(
      (a, b) => Math.abs(a.score - median) - Math.abs(b.score - median) || b.score - a.score || a.number - b.number,
    );
    second.targetId = (byDist[0] as { id: string })?.id ?? null;
    const afterSecond = afterGrand.filter((p) => p.id !== second.targetId);
    const byScoreAsc2 = [...afterSecond].sort((a, b) => a.score - b.score || a.number - b.number);
    third.targetId = (byScoreAsc2[0] as { id: string })?.id ?? null;
    return [grand, second, third];
  }

  /** 有效 session（token 以 hash 儲存） */
  sessionByToken(token: string): Session | undefined {
    const h = sha256(token);
    return this.state.sessions.find((s) => s.tokenHash === h && !s.revoked && s.expiresAt > now());
  }

  receipt(commandId: string): CommandReceipt | undefined {
    return this.state.receipts.get(commandId);
  }

  activeRulePage(gameId: string): RulePage | undefined {
    const pages = this.state.room.rulePages.filter((p) => p.gameId === gameId && p.enabled && !p.archived);
    return pages.sort((a, b) => a.order - b.order)[0];
  }

  /** 規則頁分頁：按 block 估算視覺高度切 sub-page（1920×1080 主體可用高度≈700px，§8.4） */
  rulePages(page: RulePage): RuleBlock[][] {
    const height = (b: RuleBlock): number => {
      const text = (b.text ?? "").length + (b.value ?? "").length;
      switch (b.type) {
        case "heading":
          return 110;
        case "callout":
          return 130;
        case "image":
          return 360;
        case "score-table":
          return 56 * ((b.items?.length ?? 0) + 1) + 24;
        case "bullets":
        case "steps":
          return 62 * ((b.items?.length ?? 0) || 1) + 28;
        case "kv":
          return 80;
        default:
          return Math.ceil(text / 36) * 72 + 28;
      }
    };
    const pages: RuleBlock[][] = [];
    let cur: RuleBlock[] = [];
    let used = 0;
    for (const b of page.blocks) {
      const h = height(b);
      if (cur.length > 0 && used + h > 700) {
        pages.push(cur);
        cur = [];
        used = 0;
      }
      cur.push(b);
      used += h;
    }
    if (cur.length) pages.push(cur);
    return pages.length ? pages : [[]];
  }

  /** 規則頁分頁（pageIndex / totalPages 由 server 計，各機一致） */
  rulePagination(page: RulePage): { pageIndex: number; totalPages: number } {
    return { pageIndex: 0, totalPages: this.rulePages(page).length };
  }

  /** 目前 round 嘅答案／票數進度 */
  answerStats(round: Round): { answered: number; eligible: number } {
    const eligible = round.eligiblePlayerIds.length;
    const answered = new Set(
      this.state.submissions.filter((s) => s.roundId === round.id && s.confirmed).map((s) => s.playerId),
    ).size;
    return { answered, eligible };
  }

  submissionsForRound(roundId: string): Submission[] {
    return this.state.submissions.filter((s) => s.roundId === roundId);
  }
}

export { applyOne };
