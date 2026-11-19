/** 起始資料：rundown、四關規則頁（附錄 B）、題庫 seed（附錄 A）→ 全部純資料 */
import fs from "node:fs";
import path from "node:path";
import type { Card, QuizQuestion, RundownItem, RuleBlock, RulePage } from "../shared/types.js";
import type { Mutation } from "./journal.js";

export type QuizSeedFile = { version: number; source: string; questions: QuizQuestion[] };
export type UndercoverTopic = { id: string; prompt: string; undercoverPrompt: string };
export type UndercoverSeedFile = { version: number; source: string; topics: UndercoverTopic[] };
export type RuleSeedFile = {
  version: number;
  source: string;
  pages: {
    id: string;
    gameId: string;
    title: string;
    subtitle?: string;
    order: number;
    enabled: boolean;
    autoAdvanceSeconds: number;
    blocks: { type: string; text?: string; items?: string[]; value?: string; emphasis?: "normal" | "hot" }[];
  }[];
};

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

/** data/ 優先（repo canonical），Docker volume 蓋住 data 時 fallback 去 seed/ */
function readSeed<T>(appRoot: string, name: string): T {
  const candidates = [path.join(appRoot, "data", name), path.join(appRoot, "seed", name)];
  for (const file of candidates) {
    if (fs.existsSync(file)) return readJson<T>(file);
  }
  throw new Error(`搵唔到 seed 檔 ${name}（試過 ${candidates.join(", ")}）`);
}

export function loadQuizSeed(appRoot: string): QuizQuestion[] {
  return readSeed<QuizSeedFile>(appRoot, "quiz.seed.json").questions;
}

/** v0.3.0：一圖多人 7 對題目（好人題＋臥底關鍵詞）；換題只改呢個檔 */
export function loadUndercoverSeed(appRoot: string): UndercoverTopic[] {
  return readSeed<UndercoverSeedFile>(appRoot, "undercover.seed.json").topics;
}

export function loadRulePagesSeed(appRoot: string, updatedBy = "seed"): RulePage[] {
  const f = readSeed<RuleSeedFile>(appRoot, "rulepages.seed.json");
  const ts = Date.now();
  return f.pages.map((p) => ({
    id: p.id,
    gameId: p.gameId,
    title: p.title,
    subtitle: p.subtitle,
    blocks: p.blocks.map((b, i) => {
      const block: RuleBlock = { id: `${p.id}-b${i + 1}`, type: b.type as RuleBlock["type"] };
      if (b.text !== undefined) block.text = b.text;
      if (b.items !== undefined) block.items = b.items;
      if (b.value !== undefined) block.value = b.value;
      if (b.emphasis !== undefined) block.emphasis = b.emphasis;
      return block;
    }),
    order: p.order,
    enabled: p.enabled,
    autoAdvanceSeconds: p.autoAdvanceSeconds,
    updatedAt: ts,
    version: 1,
    updatedBy,
  }));
}

/** 單一題目 → 卡（題目未定：換 seed 即換題，唔使改 code） */
export function questionToCard(q: QuizQuestion): Card {
  {
    const card: Card = {
      id: q.id,
      type: q.type,
      gameId: "quiz",
      category: q.category,
      prompt: q.prompt,
      seconds: q.seconds,
      points: q.points,
      version: 1,
      state: "draft",
    };
    if (q.imageUrl !== undefined) card.imageUrl = q.imageUrl;
    if (q.options) card.options = q.options;
    if (q.correct !== undefined) card.correct = q.correct;
    if (q.explanation !== undefined) card.explanation = q.explanation;
    if (q.referenceAnswer !== undefined) card.referenceAnswer = q.referenceAnswer;
    if (q.hint !== undefined) card.hint = q.hint;
    if (q.openKind !== undefined) card.openKind = q.openKind;
    if (q.tolerance !== undefined) card.tolerance = q.tolerance;
    if (q.actualAnswer !== undefined) card.actualAnswer = q.actualAnswer;
    if ((q as QuizQuestion & { autoAnswer?: string }).autoAnswer) {
      card.autoAnswer = "minutes-to-midnight";
    }
    return card;
  }
}

/** v0.3.0：一圖多人題目卡（同一張卡帶好人題＋臥底題；臥底題永遠唔出 DTO） */
export function undercoverTopicToCard(t: UndercoverTopic): Card {
  return {
    id: `uc_${t.id}`,
    type: "open",
    gameId: "draw",
    prompt: t.prompt,
    undercoverPrompt: t.undercoverPrompt,
    seconds: null,
    points: 0,
    version: 1,
    state: "draft",
  };
}

export function quizQuestionsToCards(questions: QuizQuestion[]): Card[] {
  return questions.map((q) => questionToCard(q));
}

export const GAME_TITLES: Record<string, string> = {
  draw: "一圖多人畫畫猜",
  auction: "拍賣時間估歌",
  killer: "笨蛋殺手",
  quiz: "問答環節",
  saboteur: "搗蛋鬼",
};

/** v0.3.0 預設 4 關次序：一圖多人 → 拍賣估歌 → 笨蛋殺手 → 問答 */
export const DEFAULT_GAMES = ["draw", "auction", "killer", "quiz"];

/** v0.3.0：預設 6 張拍賣卡（第 1–6 首），主持唔使逐首建卡 */
export function defaultAuctionCards(): Card[] {
  return Array.from({ length: 6 }, (_, i) => ({
    id: `bid_s${i + 1}`,
    type: "bid",
    gameId: "auction",
    prompt: `第 ${i + 1} 首・聽幾秒估歌名`,
    maxBid: 10,
    seconds: 10,
    points: 1,
    version: 1,
    state: "draft",
  }));
}

export function defaultRundown(quizCardIds: string[], drawCardIds: string[] = [], auctionCardIds: string[] = []): RundownItem[] {
  const games = DEFAULT_GAMES;
  return games.map((gameId, i) => {
    const item: RundownItem = {
      id: `rd_${gameId}`,
      index: i,
      gameId,
      title: `第 ${i + 1} 關・${GAME_TITLES[gameId]}`,
      state: "todo",
      cardIds: gameId === "quiz" ? quizCardIds : gameId === "draw" ? drawCardIds : gameId === "auction" ? auctionCardIds : [],
      rulesText: "",
    };
    return item;
  });
}

/** 第一次開機要寫入 journal 嘅起始資料（同一筆 transaction） */
export function bootstrapMutations(
  appRoot: string,
  roomId: string,
  code: string,
  pinHash: string,
  autoClose: boolean,
): Mutation[] {
  const questions = loadQuizSeed(appRoot);
  const quizCards = quizQuestionsToCards(questions);
  const ucCards = loadUndercoverSeed(appRoot).map(undercoverTopicToCard);
  const auctionCards = defaultAuctionCards();
  const rulePages = loadRulePagesSeed(appRoot);
  const rundown = defaultRundown(quizCards.map((c) => c.id), ucCards.map((c) => c.id), auctionCards.map((c) => c.id));
  const ts = Date.now();
  return [
    { t: "room.init", d: { id: roomId, code, phase: "lobby", createdAt: ts } },
    { t: "settings.set", d: { settings: { autoClose, maxBid: 10, pinHash, allowRepeatAwards: false } } },
    { t: "rules.set", d: { rulePages } },
    { t: "quiz.set", d: { cards: quizCards } },
    ...ucCards.map((card) => ({ t: "card.put", d: { card } })),
    ...auctionCards.map((card) => ({ t: "card.put", d: { card } })),
    { t: "rundown.set", d: { rundown, currentItemId: null, phase: "lobby" } },
  ];
}
