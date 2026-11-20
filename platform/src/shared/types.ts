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
  | "undercover"
  | "role-reveal"
  | "song"
  | "leaderboard"
  | "finale"
  | "award"
  | "timer"
  /** v0.3.0：自由文字上大mon（好人題目／淘汰結果／心機字） */
  | "message"
  /** v0.3.0：逐個 game 分數矩陣（Excel 第 68 行） */
  | "game-scores"
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
  /** 一圖多人：臥底題（關鍵詞）。呢個欄永遠唔准出 stage／player DTO */
  undercoverPrompt?: string;
  /** 開放題容差（Q12 ±3 尺）：|amount - actualAnswer| <= tolerance → 全體加 points */
  tolerance?: number;
  /** 開放數字題：最近 N 個答案各加 closestPoints（Q15 統計題 top-3） */
  closestCount?: number;
  closestPoints?: number;
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

/** v0.3.0 拍賣時間估歌：最少秒數先聽；同秒最後提交先 */
export type RoundAuction = {
  ranking: { playerId: string; seconds: number; ts: number }[];
  cursor: number;
  judged: string[];
  /** 本首已完結（有人估中或者主持收） */
  finished?: boolean;
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
  /** v0.3.0：拍賣排名／而家輪到邊個（bid.publish 寫入） */
  auction?: RoundAuction;
};

export type ScoreEvent = {
  id: string;
  ts: number;
  target: { type: "player" | "group"; id: string };
  gameId?: string;
  roundId?: string;
  cardId?: string;
  submissionId?: string;
  /** v0.3.0：一圖多人一場波嘅結算標記（去重用；舊 journal 冇呢個欄） */
  matchId?: string;
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
  /** nearest-median 只保留做舊 journal replay；v0.3.0 起 second 用 nearest-avg（中庸之道＝最接近平均數） */
  rule: "max" | "nearest-median" | "nearest-avg" | "min";
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
  gameState?: {
    saboteur?: SaboteurState | null;
    /** v0.3.0 一圖多人（畫畫臥底）整局狀態；身份只可以經 HostView 出 */
    undercover?: UndercoverMatchState | null;
    /** v0.3.0 笨蛋殺手（老闆＋殺手）；身份只可以經 HostView 出 */
    killer?: KillerState | null;
  };
};

/** v0.3.0：一圖多人（畫畫臥底）一整局狀態（最多 3 題、2 個臥底） */
export type UndercoverMatchState = {
  /** 第幾局（1,2,3…；顯示用；重設流程之後會再由 1 開始） */
  matchNo: number;
  /** v0.4.1：永久唯一局 id（計分去重鍵）。舊 journal 冇呢個欄位就 fallback 去 uc_m<matchNo>。 */
  matchUid?: string;
  /** 開局時 approved 快照 */
  participantIds: string[];
  /** 2 個（可以重抽）；只可以出 HostView */
  undercoverIds: string[];
  eliminatedIds: string[];
  /** 0..2（最多 3 題） */
  questionNo: number;
  /** 本局用邊 3 對題（開局時抽定） */
  topicIds: string[];
  /** 現時題目卡（好／臥底兩題都喺同一張卡） */
  promptCardId: string | null;
  /** 有冇「公佈好人題目」 */
  promptRevealed: boolean;
  /** 現時投票 round */
  roundId: string | null;
  result: "good" | "undercover" | null;
  settled: boolean;
  /** 內部：已用過嘅題目卡（跨局避免重複；少於 3 對時循環再用） */
  usedTopicIds?: string[];
  /** B4：每次淘汰屬於第幾題（playerId → questionNo；同一題只准 foul 一個） */
  eliminatedByQuestion?: Record<string, number>;
};

/** v0.3.0：笨蛋殺手（一個老闆一個殺手） */
export type KillerState = {
  bossId: string | null;
  killerId: string | null;
  assignedAt?: number;
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
  imageUrl?: string;
  options?: string[];
  correct?: number;
  explanation?: string;
  referenceAnswer?: string;
  hint?: string;
  openKind?: "text" | "number";
  /** 容差（Q12 ±3 尺） */
  tolerance?: number;
  /** 最近 N 個答案各加 closestPoints（Q15 統計題 top-3） */
  closestCount?: number;
  closestPoints?: number;
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
  /** v0.3.3：開放題（數字／文字）收卷之後，大mon 要見到「邊個答咗乜」（以前淨係得個數） */
  answers?: { name: string; avatar: Avatar; text: string }[];
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

export type UndercoverView = {
  phase: "voting" | "result";
  prompt: string;
  endsAt: number | null;
  durationSeconds: number;
  candidates: { id: string; number: number; name: string; avatar: Avatar; count: number }[];
  ballots: { voterId: string; voterNumber: number; voterName: string; targetId: string | null; targetName: string }[];
  eligibleCount: number;
  answeredCount: number;
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
    /** v04-D：大mon 要唔要出選項（v0.4.5 起 preview 都係 true；preview 只靠 endsAt=null＋preview=true 分辨） */
    showOptions?: boolean;
    /** v04-D：true＝preview（未開 round，`quiz.show`）；大mon 出題目＋選項但唔倒數，手機仲係等主持 */
    preview?: boolean;
  } | null;
  tally: StageTally | null;
  reveal: StageReveal | null;
  vote: { roundId: string; cardId: string; prompt: string; options: { id: string; label: string }[]; counts: number[]; answeredCount: number; eligibleCount: number } | null;
  undercover: UndercoverView | null;
  /** v0.3.0：一圖多人完整局（只送公開資訊；臥底身份永遠唔會出現） */
  undercoverMatch?: UndercoverMatchView | null;
  /** v0.3.0：message mode 大字內容 */
  message?: { title?: string; lines?: string[]; tone?: "normal" | "good" | "bad" } | null;
  /** v0.3.0：逐個 game 分數矩陣 */
  gameScores?: GameScoresView | null;
  bid: { roundId: string; cardId: string; prompt: string; maxBid: number; endsAt: number | null; bidCount: number; eligibleCount: number; closed: boolean; settled: boolean; winnerName: string | null; winnerAmount: number | null; ranking?: { playerId: string; name: string; number: number; seconds: number; tried: boolean; current: boolean }[]; currentName?: string | null; currentSeconds?: number | null; remaining?: number } | null;
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
  /** 最新一條 activity 嘅 id：大mon 用嚟判斷「係唔係新通知」，重複 projection 唔會重新彈 */
  toastId?: string | null;
};

/** v0.3.0 一圖多人：大mon／主持共用嘅公開投影（永遠冇 undercoverIds） */
export type UndercoverMatchView = {
  matchNo: number;
  /** 1-based（1／3） */
  questionNo: number;
  totalQuestions: number;
  participantCount: number;
  /** 仲有幾個臥底未出局（大家都知有 2 個，所以係公開進度） */
  remainingUndercover: number;
  totalUndercover: number;
  eliminated: { id: string; name: string; number: number; wasUndercover: boolean }[];
  promptRevealed: boolean;
  /** 只有 promptRevealed 之後才送（好人題） */
  prompt: string | null;
  voting: boolean;
  roundId: string | null;
  endsAt: number | null;
  /** 最近一次淘汰（大mon 顯示「係唔係臥底」） */
  lastElimination: { id: string; name: string; number: number; wasUndercover: boolean } | null;
  result: "good" | "undercover" | null;
  settled: boolean;
};

/** v0.3.0 逐個 game 分數矩陣（Excel 第 68 行） */
export type GameScoresView = {
  games: { gameId: string; title: string }[];
  rows: {
    id: string;
    name: string;
    number: number;
    avatar: Avatar;
    scores: number[];
    other: number;
    total: number;
  }[];
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
  /** v0.3.0 一圖多人：只送「你有冇出局」＋賽果，永遠唔送身份 */
  undercoverMatch?: { matchNo: number; questionNo: number; eliminated: boolean; result: "good" | "undercover" | null } | null;
  finale: StageView["finale"];
  toast: string | null;
  toastId?: string | null;
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
  undercover: UndercoverView | null;
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
  /** v0.3.0 一圖多人：主持先見到臥底身份（原始 state） */
  undercoverMatch: UndercoverMatchState | null;
  /** v0.3.0 笨蛋殺手：老闆／殺手身份（只出主持台） */
  killerState: KillerState | null;
};
