/** 起始資料：rundown、四關規則頁（附錄 B）、題庫 seed（附錄 A）→ 全部純資料 */
import fs from "node:fs";
import path from "node:path";
import type { Card, QuizQuestion, RundownItem, RuleBlock, RulePage } from "../shared/types.js";
import type { Mutation } from "./journal.js";

export type QuizSeedFile = { version: number; source: string; questions: QuizQuestion[] };
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
    if (q.options) card.options = q.options;
    if (q.correct !== undefined) card.correct = q.correct;
    if (q.explanation !== undefined) card.explanation = q.explanation;
    if (q.referenceAnswer !== undefined) card.referenceAnswer = q.referenceAnswer;
    if (q.hint !== undefined) card.hint = q.hint;
    if (q.openKind !== undefined) card.openKind = q.openKind;
    if (q.actualAnswer !== undefined) card.actualAnswer = q.actualAnswer;
    if ((q as QuizQuestion & { autoAnswer?: string }).autoAnswer) {
      card.autoAnswer = "minutes-to-midnight";
    }
    return card;
  }
}

export function quizQuestionsToCards(questions: QuizQuestion[]): Card[] {
  return questions.map((q) => questionToCard(q));
}

export const GAME_TITLES: Record<string, string> = {
  auction: "拍賣時間估歌",
  draw: "一圖多用畫畫猜人",
  saboteur: "搗蛋鬼",
  quiz: "問答",
};

export function defaultRundown(quizCardIds: string[]): RundownItem[] {
  const games = ["auction", "draw", "saboteur", "quiz"];
  return games.map((gameId, i) => {
    const item: RundownItem = {
      id: `rd_${gameId}`,
      index: i,
      gameId,
      title: `第 ${i + 1} 關・${GAME_TITLES[gameId]}`,
      state: i === 0 ? "todo" : "todo",
      cardIds: gameId === "quiz" ? quizCardIds : [],
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
  const rulePages = loadRulePagesSeed(appRoot);
  const rundown = defaultRundown(quizCards.map((c) => c.id));
  const ts = Date.now();
  return [
    { t: "room.init", d: { id: roomId, code, phase: "lobby", createdAt: ts } },
    { t: "settings.set", d: { settings: { autoClose, maxBid: 100, pinHash, allowRepeatAwards: false } } },
    { t: "rules.set", d: { rulePages } },
    { t: "quiz.set", d: { cards: quizCards } },
    { t: "rundown.set", d: { rundown, currentItemId: null, phase: "lobby" } },
  ];
}
