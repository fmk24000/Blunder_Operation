/**
 * 2026 HBD 派對遊戲平台 — 共用型別（PLAN-v3.1 §6）
 * server 內部 model 同三個對外 DTO 分開；DTO 由 views.ts 逐欄投影，永不 spread 私有 model。
 */

export type Phase = "idle" | "lobby" | "playing" | "final" | "award";

export type StageMode =
  | "idle"
  | "rules"
  | "scoreboard"
  | "question"
  | "tally"
  | "reveal"
  | "draw-wall"
  | "draw-focus"
  | "bid"
  | "vote"
  | "role-reveal"
  | "song"
  | "leaderboard"
  | "finale"
  | "award"
  | "timer"
  | "blackout";

export type SortKey = "score-desc" | "score-asc" | "number" | "name" | "group";

export type PlayerStatus = "pending" | "approved" | "kicked";

export type Avatar = { kind: "emoji" | "photo"; emoji?: string; color: string; url?: string };

export type Group = { id: string; name: string; color: string; order: number; archived?: boolean };

export type Player = {
  id: string;
  name: string;
  number: number;
  groupId: string | null;
  status: PlayerStatus;
  connected: boolean;
  lastSeen: number;
  avatar: Avatar;
  /** 搗蛋鬼用；唔會 broadcast 去 stage 或其他玩家 */
  secretRole?: "saboteur" | "crew";
  joinedAt: number;
};

export type RundownItem = {
  id: string;
  index: number;
  gameId: string;
  title: string;
  state: "todo" | "running" | "done" | "skipped";
  cardIds: string[];
  rulePageId?: string;
  rulesText?: string;
};

export type Song = {
  id: string;
  index: number;
  title: string;
  hint?: string;
  source: { kind: "file" | "youtube" | "apple" | "external"; url?: string; fileName?: string };
  playlistRef?: string;
  playWindow?: [number, number];
  state: "draft" | "ready" | "played";
  /** 內部：audio duration ms（如知） */
  durationMs?: number;
};

export type MediaPlayback = {
  songId: string;
  deckId: string | null;
  playStartedAt: number;
  state: "idle" | "preparing" | "playing" | "paused" | "failed";
  pausedAt?: number;
  resumedAt?: number;
  positionMs: number;
  window: [number, number];
  by: string;
  /** 內部：reveal 前唔可以出歌名 */
  revealedAt?: number | null;
  /** 內部：preparing 狀態 deadline（冇 ready ACK 就 failed，W_AUDIO_READY_TIMEOUT） */
  readyDeadline?: number;
};

export type AudioLease = {
  deckId: string;
  hostId: string;
  generation: number;
  leaseUntil: number;
  /** lease 已到期嘅時間（失聯接管要等 releasedAt+5s safety margin） */
  releasedAt?: number;
};

export type CardType = "choice" | "open" | "vote" | "bid" | "media" | "manual";

export type Card = {
  id: string;
  type: CardType;
  /** 內部：屬於邊個 gameId（quiz 題庫用 "quiz"；bid 用 "auction"；vote 用 "draw"／"saboteur"） */
  gameId: string;
  category?: string;
  prompt: string;
  imageUrl?: string;
  mediaUrl?: string;
  options?: string[];
  correct?: number;
  explanation?: string;
  referenceAnswer?: string;
  hint?: string;
  openKind?: "text" | "number";
  maxBid?: number;
  /** bid 卡引用歌單 */
  songId?: string;
  /** vote 卡投咩：players＝投人（搗蛋鬼）；works＝投作品（畫畫） */
  voteMode?: "players" | "works";
  seconds: number | null;
  points: number;
  actualAnswer?: number;
  /** 內部：server 自動計 actualAnswer（Q14＝收卷時刻到 Asia/Hong_Kong 下一個 00:00 嘅完整分鐘） */
  autoAnswer?: "minutes-to-midnight";
  version: number;
  state: "draft" | "open" | "closed" | "tally" | "revealed";
};

export type Submission = {
  id: string;
  roundId: string;
  cardId: string;
  playerId: string;
  ts: number;
  kind: "choice" | "open" | "vote" | "bid";
  choice?: number;
  amount?: number;
  text?: string;
  confirmed: boolean;
  payloadHash: string;
  onBehalfOf?: string;
  byHost?: boolean;
  judged?: { correct: boolean; points: number; by: "auto" | "host" };
};

export type Round = {
  id: string;
  cardId: string;
  cardVersion: number;
  retryOf?: string;
  endsAt: number | null;
  closedAt: number | null;
  state: "open" | "closed" | "tally" | "revealed" | "void";
  eligiblePlayerIds: string[];
  actualAnswer?: number;
  autoClosed?: boolean;
};

export type ScoreEvent = {
  id: string;
  ts: number;
  target: { type: "player" | "group"; id: string };
  gameId?: string;
  roundId?: string;
  cardId?: string;
  submissionId?: string;
  lineage?: { sourceEventIds: string[] };
  delta: number;
  reason: string;
  by: "host" | "auto";
  voided?: boolean;
};

export type StageState = {
  mode: StageMode;
  payload: Record<string, unknown>;
  lock: boolean;
  prevMode?: Exclude<StageMode, "blackout" | "rules">;
  rulePageId?: string;
  ticker: { visible: boolean; scope: "player" | "group"; range: "current" | "total"; sort: SortKey };
};

export type Award = {
  id: "grand" | "second" | "third";
  targetId: string | null;
  rule: "max" | "nearest-median" | "min";
  manual: boolean;
  revealed: boolean;
};

export type RuleBlockType =
  | "heading"
  | "paragraph"
  | "bullets"
  | "steps"
  | "callout"
  | "kv"
  | "score-table"
  | "image";

export type RuleBlock = {
  id: string;
  type: RuleBlockType;
  text?: string;
  items?: string[];
  value?: string;
  imageUrl?: string;
  icon?: string;
  emphasis?: "normal" | "hot";
};

export type RulePage = {
  id: string;
  gameId: string;
  title: string;
  subtitle?: string;
  blocks: RuleBlock[];
  order: number;
  enabled: boolean;
  autoAdvanceSeconds: number;
  updatedAt: number;
  version: number;
  updatedBy: string;
  archived?: boolean;
};

export type Room = {
  id: string;
  code: string;
  phase: Phase;
  groups: Group[];
  players: Player[];
  rundown: RundownItem[];
  rulePages: RulePage[];
  awards: Award[];
  currentItemId: string | null;
  currentRoundId: string | null;
  rounds: Round[];
  stage: StageState;
  seq: number;
  revision: number;
  seqEpoch: string;
  audioLease?: AudioLease;
  /** 內部：各關額外狀態（唔會直出 DTO） */
  gameState?: { saboteur?: SaboteurState };
};

export type SaboteurRound = {
  index: number;
  roundId: string;
  eligiblePlayerIds: string[];
  /** 票：投邊個；targetId=null＝棄權 */
  votes: { voterId: string; targetId: string | null }[];
  state: "open" | "closed" | "resolved";
  eliminatedId: string | null;
  retried: boolean;
  decision: "eliminated" | "retry" | "none" | null;
};

export type SaboteurState = {
  saboteurId: string | null;
  eliminatedIds: string[];
  rounds: SaboteurRound[];
  caught: boolean;
  finished: boolean;
  /** 揪中結算嗰刻自動寫入嘅公開身份（落 journal） */
  revealedRole: "saboteur" | null;
};

export type Session = {
  tokenHash: string;
  role: "host" | "player" | "stage";
  playerId?: string;
  hostId?: string;
  name?: string;
  createdAt: number;
  expiresAt: number;
  revoked?: boolean;
};

export type CommandReceipt = {
  commandId: string;
  payloadHash: string;
  hostId: string;
  kind: string;
  ts: number;
  result: unknown;
  revision: number;
};

export type RoomSettings = {
  autoClose: boolean;
  pin: string | null; // 只存 hash（scrypt）→ 對外永遠唔會出
  maxBid: number;
  sourceKindNote?: string;
};

export type QuizQuestion = {
  id: string;
  type: "choice" | "open";
  category: string;
  prompt: string;
  options?: string[];
  correct?: number;
  explanation?: string;
  referenceAnswer?: string;
  hint?: string;
  openKind?: "text" | "number";
  seconds: number;
  points: number;
  actualAnswer?: number;
  /** 內部：server 自動計答案（Q14 時間題） */
  autoAnswer?: "minutes-to-midnight";
};

export type ActivityToast = { id: string; ts: number; hostName: string; text: string };

/* ───────────────────────── 對外 DTO（allowlist 投影） ───────────────────────── */

export type ScoreBoardEntry = {
  id: string;
  name: string;
  number: number;
  avatar: Avatar;
  groupId: string | null;
  connected: boolean;
  score: number;
  groupScore: number;
};

export type PublicPlayer = {
  id: string;
  name: string;
  number: number;
  avatar: Avatar;
  groupId: string | null;
  connected: boolean;
  status: PlayerStatus;
};

export type StageTally = {
  roundId: string;
  cardId: string;
  prompt: string;
  options: string[];
  counts: number[];
  voters: { name: string; avatar: Avatar; choice: number }[];
  answerCount: number;
  eligibleCount: number;
};

export type StageReveal = {
  roundId: string;
  cardId: string;
  prompt: string;
  options?: string[];
  correct?: number;
  explanation?: string;
  referenceAnswer?: string;
  actualAnswer?: number;
  counts?: number[];
};

export type DrawWork = {
  id: string;
  authorId: string;
  authorName: string;
  authorNumber: number;
  imageUrl: string;
  votes: number;
  createdAt: number;
};

export type StageView = {
  role: "stage";
  serverNow: number;
  seq: number;
  revision: number;
  seqEpoch: string;
  phase: Phase;
  stage: StageState;
  ticker: StageState["ticker"];
  roomCode: string;
  players: PublicPlayer[];
  groups: Group[];
  scores: ScoreBoardEntry[];
  currentItem: { id: string; index: number; gameId: string; title: string; state: string } | null;
  rundownCount: number;
  rulePage: RulePage | null;
  rulePagesMeta: { pageIndex: number; totalPages: number; autoAdvanceSeconds: number } | null;
  question: {
    roundId: string;
    cardId: string;
    prompt: string;
    imageUrl?: string;
    options?: string[];
    endsAt: number | null;
    answeredCount: number;
    eligibleCount: number;
    kind: string;
  } | null;
  tally: StageTally | null;
  reveal: StageReveal | null;
  vote: { roundId: string; cardId: string; prompt: string; options: { id: string; label: string }[]; counts: number[]; answeredCount: number; eligibleCount: number } | null;
  bid: { roundId: string; cardId: string; prompt: string; maxBid: number; endsAt: number | null; bidCount: number; eligibleCount: number; closed: boolean; settled: boolean; winnerName: string | null; winnerAmount: number | null } | null;
  drawWall: { works: DrawWork[]; focusId: string | null } | null;
  song: { songIndex: number; totalSongs: number; state: string; title: string | null } | null;
  roleReveal: { saboteurName: string | null; caught: boolean; votes: { name: string; count: number }[] } | null;
  saboteurInfo: {
    roundIndex: number | null;
    eliminated: { id: string; name: string; number: number }[];
    caught: boolean;
    finished: boolean;
    revealedRole: string | null;
    validVotes: number;
    top: { name: string; count: number }[];
  } | null;
  finale: {
    entries: ScoreBoardEntry[];
    stats: { total: number; avg: number; median: number; count: number };
    awards: { id: string; revealed: boolean; name: string | null; score: number | null; reason: string | null }[];
  } | null;
  toast: string | null;
};

export type PlayerSelfView = {
  role: "player";
  serverNow: number;
  seq: number;
  revision: number;
  seqEpoch: string;
  phase: Phase;
  mode: StageMode;
  lock: boolean;
  me: {
    id: string;
    name: string;
    number: number;
    avatar: Avatar;
    groupId: string | null;
    status: PlayerStatus;
    score: number;
    groupScore: number;
    secretRole?: "saboteur" | "crew";
    saboteurAnswer?: string;
  };
  roomCode: string;
  ticker: StageState["ticker"];
  groups: Group[];
  scores: ScoreBoardEntry[];
  task: {
    roundId: string;
    cardId: string;
    kind: "choice" | "open" | "vote" | "bid";
    prompt: string;
    imageUrl?: string;
    options?: string[];
    openKind?: "text" | "number";
    maxBid?: number;
    endsAt: number | null;
    seconds: number | null;
    /** vote 卡：可以投嘅對象（搗蛋鬼唔可以投自己） */
    voteOptions?: { id: string; label: string; avatar?: Avatar }[];
  } | null;
  mySubmission: {
    roundId: string;
    status: "none" | "submitted" | "rejected";
    choice?: number;
    amount?: number;
    text?: string;
    confirmed: boolean;
  } | null;
  progress: { answered: number; eligible: number } | null;
  reveal: {
    roundId: string;
    correct?: number;
    explanation?: string;
    referenceAnswer?: string;
    actualAnswer?: number;
    myResult: "correct" | "wrong" | "unjudged" | "none";
  } | null;
  roleInfo: { secretRole: "saboteur" | "crew"; saboteurAnswer?: string } | null;
  finale: StageView["finale"];
  toast: string | null;
};

export type HostView = {
  role: "host";
  serverNow: number;
  seq: number;
  revision: number;
  seqEpoch: string;
  hostId: string;
  hostName: string;
  roomCode: string;
  phase: Phase;
  stage: StageState;
  settings: { autoClose: boolean; maxBid: number };
  players: (Player & { score: number; groupScore: number })[];
  groups: Group[];
  rundown: RundownItem[];
  currentItemId: string | null;
  currentItem: RundownItem | null;
  currentRound: Round | null;
  rounds: Round[];
  cards: Card[];
  quiz: Card[];
  songs: Song[];
  playback: MediaPlayback | null;
  audioLease: AudioLease | null;
  ledger: ScoreEvent[];
  submissions: Submission[];
  rulePages: RulePage[];
  awards: Award[];
  stats: { total: number; avg: number; median: number; max: number; min: number; count: number };
  activity: ActivityToast[];
  connections: { hosts: number; stages: number; players: number; total: number };
  caps: { approved: number; pending: number; maxApproved: number; maxPending: number };
  assets: { id: string; kind: "image" | "audio"; file: string; mime: string; size: number; originalName: string; authorId?: string; cardId?: string; createdAt: number }[];
  saboteurState: SaboteurState | null;
};
