/**
 * 對外 DTO 投影（PLAN-v3.1 §7 披露矩陣）
 * 唔准 spread server 私有 model；逐欄 allowlist。
 */
import type {
  Award,
  Card,
  GameScoresView,
  Group,
  HostView,
  MediaPlayback,
  Player,
  PublicPlayer,
  Round,
  RulePage,
  ScoreBoardEntry,
  SortKey,
  StageReveal,
  StageTally,
  StageView,
  UndercoverView,
  Submission,
  PlayerSelfView,
  DrawWork,
  UndercoverMatchView,
} from "../shared/types.js";
import type { Store } from "./store.js";

export type ConnStats = { hosts: number; stages: number; players: number; total: number };

const AWARD_REASON: Record<Award["id"], string> = {
  grand: "最高分獎",
  second: "中庸之道獎",
  third: "多謝參與獎",
};

function publicPlayer(p: Player): PublicPlayer {
  return {
    id: p.id,
    name: p.name,
    number: p.number,
    avatar: p.avatar,
    groupId: p.groupId,
    connected: p.connected,
    status: p.status,
  };
}

function scoreEntry(store: Store, p: Player, maps: { player: Map<string, number>; group: Map<string, number> }): ScoreBoardEntry {
  return {
    id: p.id,
    name: p.name,
    number: p.number,
    avatar: p.avatar,
    groupId: p.groupId,
    connected: p.connected,
    score: maps.player.get(p.id) ?? 0,
    groupScore: p.groupId ? (maps.group.get(p.groupId) ?? 0) : 0,
  };
}

export function sortedEntries(store: Store, sort: SortKey): ScoreBoardEntry[] {
  const maps = store.scoreMaps();
  const entries = store.state.room.players
    .filter((p) => p.status === "approved")
    .map((p) => scoreEntry(store, p, maps));
  const groupName = new Map(store.state.room.groups.map((g) => [g.id, g.name]));
  entries.sort((a, b) => {
    switch (sort) {
      case "score-asc":
        return a.score - b.score || a.number - b.number;
      case "number":
        return a.number - b.number;
      case "name":
        return a.name.localeCompare(b.name, "zh-Hant");
      case "group":
        return (groupName.get(a.groupId ?? "") ?? "").localeCompare(groupName.get(b.groupId ?? "") ?? "", "zh-Hant") || a.number - b.number;
      case "score-desc":
      default:
        return b.score - a.score || a.number - b.number;
    }
  });
  return entries;
}

function worksForCard(store: Store, card: Card | undefined): DrawWork[] {
  if (!card) return [];
  const optionIds = card.type === "vote" && card.voteMode === "works" ? (card.options ?? []) : [];
  return store.state.assets
    .filter((a) => (a.kind === "image") && (optionIds.length ? optionIds.includes(a.id) : a.cardId === card.id))
    .map((a) => {
      const author = a.authorId ? store.player(a.authorId) : undefined;
      return {
        id: a.id,
        authorId: a.authorId ?? "",
        authorName: author?.name ?? "作品",
        authorNumber: author?.number ?? 0,
        imageUrl: `/media/${a.file}`,
        votes: 0,
        createdAt: a.createdAt,
      };
    })
    .sort((x, y) => x.createdAt - y.createdAt);
}

function voteCounts(store: Store, round: Round, optionsLength: number): number[] {
  const counts = new Array<number>(optionsLength).fill(0);
  for (const s of store.submissionsForRound(round.id)) {
    if (!s.confirmed) continue;
    if (typeof s.choice === "number" && s.choice >= 0 && s.choice < counts.length) counts[s.choice] = (counts[s.choice] ?? 0) + 1;
  }
  return counts;
}

function resolveRulePage(store: Store): RulePage | null {
  // 預覽：主持喺 host 揀邊一頁，就以 stage.payload 為準（唔可以由 currentItem 猜返出嚟）
  const pickedId = store.state.room.stage.payload?.rulePageId;
  if (typeof pickedId === "string") {
    const picked = store.state.room.rulePages.find((x) => x.id === pickedId);
    if (picked && picked.enabled && !picked.archived) return picked;
  }
  const item = store.currentItem();
  if (item?.rulePageId) {
    const p = store.state.room.rulePages.find((x) => x.id === item.rulePageId);
    if (p && p.enabled && !p.archived) return p;
  }
  if (item) {
    const p = store.activeRulePage(item.gameId);
    if (p) return p;
  }
  return null;
}

function currentQuestion(store: Store) {
  const round = store.currentRound();
  if (!round) return null;
  const card = store.card(round.cardId);
  if (!card) return null;
  const stats = store.answerStats(round);
  return {
    round,
    card,
    answered: stats.answered,
    eligible: stats.eligible,
  };
}

/** 大mon（StageView） */
function buildUndercover(store: Store): UndercoverView | null {
  const round = store.currentRound();
  const card = round ? store.card(round.cardId) : undefined;
  if (!round || !card || card.gameId !== "draw" || card.voteMode !== "players" || !card.options?.length) return null;
  const subs = store.state.submissions.filter((x) => x.roundId === round.id && x.confirmed && x.kind === "vote");
  const counts = new Map<string, number>();
  for (const x of subs) {
    const target = x.text ?? "";
    if (target) counts.set(target, (counts.get(target) ?? 0) + 1);
  }
  // v0.4.4（codex audit B3）：未開票唔可以送即時票數（以前只遮 ballots，count 照漏）
  const revealed = round.state !== "open";
  const candidates = card.options
    .map((id) => store.player(id))
    .filter((x): x is Player => !!x)
    .map((x) => ({ id: x.id, number: x.number, name: x.name, avatar: x.avatar, count: revealed ? counts.get(x.id) ?? 0 : 0 }));
  const ballots = revealed
    ? round.eligiblePlayerIds
        .map((id) => store.player(id))
        .filter((x): x is Player => !!x)
        .map((v) => {
        const sub = subs.find((x) => x.playerId === v.id);
        const targetId = sub?.text ?? null;
        const target = targetId ? store.player(targetId) : undefined;
        return { voterId: v.id, voterNumber: v.number, voterName: v.name, targetId, targetName: target ? target.name : "（冇投）" };
      })
    : [];
  return {
    phase: revealed ? "result" : "voting",
    prompt: card.prompt,
    endsAt: round.endsAt,
    durationSeconds: card.seconds ?? 10,
    candidates,
    ballots,
    eligibleCount: round.eligiblePlayerIds.length,
    answeredCount: subs.length,
  };
}

/** v0.3.0 一圖多人：大mon／玩家見嘅公開投影（永遠冇 undercoverIds／臥底題） */
function buildUndercoverMatchView(store: Store): UndercoverMatchView | null {
  const st = store.state.room.gameState?.undercover ?? null;
  if (!st) return null;
  const card = st.promptCardId ? store.card(st.promptCardId) : undefined;
  const eliminatedIdSet = new Set(st.eliminatedIds);
  const eliminated = st.eliminatedIds.map((id) => {
    const p = store.player(id);
    return { id, name: p?.name ?? "?", number: p?.number ?? 0, wasUndercover: st.undercoverIds.includes(id) };
  });
  const remainingUndercover = st.undercoverIds.filter((id) => !eliminatedIdSet.has(id)).length;
  const round = st.roundId ? store.round(st.roundId) : undefined;
  const last = eliminated.length ? eliminated[eliminated.length - 1] : null;
  return {
    matchNo: st.matchNo,
    questionNo: st.questionNo + 1,
    totalQuestions: 3,
    participantCount: st.participantIds.length,
    remainingUndercover,
    totalUndercover: st.undercoverIds.length,
    eliminated,
    promptRevealed: st.promptRevealed,
    // 好人題先可以出；臥底題永遠唔准出 stage／player DTO
    prompt: st.promptRevealed ? (card?.prompt ?? null) : null,
    voting: round?.state === "open",
    roundId: st.roundId,
    endsAt: round?.state === "open" ? round.endsAt : null,
    lastElimination: last ? { ...last } : null,
    result: st.result,
    settled: st.settled,
  };
}

/** v0.3.0 message mode：大mon 大字（payload 由 command 寫入） */
function buildMessage(store: Store): StageView["message"] {
  const stage = store.state.room.stage;
  if (stage.mode !== "message") return null;
  const payload = stage.payload as Record<string, unknown>;
  const rawLines = Array.isArray(payload.lines) ? payload.lines : typeof payload.text === "string" ? [payload.text] : [];
  const lines = rawLines.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 12);
  const tone = payload.tone === "good" || payload.tone === "bad" ? payload.tone : "normal";
  return {
    title: typeof payload.title === "string" ? payload.title : undefined,
    lines,
    tone,
  };
}

/** v0.3.0 game-scores：由 ledger 嘅 gameId 聚合（冇 gameId 嘅算「其他」） */
const GAME_SCORE_TITLES: { gameId: string; title: string }[] = [
  { gameId: "draw", title: "一圖多人" },
  { gameId: "auction", title: "拍賣估歌" },
  { gameId: "killer", title: "笨蛋殺手" },
  { gameId: "quiz", title: "問答" },
];

function buildGameScores(store: Store): GameScoresView | null {
  if (store.state.room.stage.mode !== "game-scores") return null;
  const players = store.approvedPlayers().slice().sort((a, b) => a.number - b.number);
  const idx = new Map(GAME_SCORE_TITLES.map((g, i) => [g.gameId, i]));
  const rows = players.map((p) => ({
    id: p.id,
    name: p.name,
    number: p.number,
    avatar: p.avatar,
    scores: GAME_SCORE_TITLES.map(() => 0),
    other: 0,
    total: 0,
  }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const e of store.state.ledger) {
    if (e.voided) continue;
    if (e.target.type !== "player") continue;
    const row = byId.get(e.target.id);
    if (!row) continue;
    row.total += e.delta;
    const i = e.gameId ? idx.get(e.gameId) : undefined;
    if (i === undefined) row.other += e.delta;
    else row.scores[i] = (row.scores[i] ?? 0) + e.delta;
  }
  return { games: GAME_SCORE_TITLES.map((g) => ({ ...g })), rows };
}

/** v0.3.0 一圖多人：玩家自己只知「有冇出局」＋賽果（唔准送身份） */
function playerUndercoverMatch(store: Store, playerId: string): PlayerSelfView["undercoverMatch"] {
  const st = store.state.room.gameState?.undercover ?? null;
  if (!st || !st.participantIds.includes(playerId)) return null;
  // v0.4.6（用戶）：手機「你已出局」以前一直唔消失（refresh 都仲喺度）。
  // 只喺「一圖多人本局進行中、未結算」先送出去；過咗關／結算咗就唔再提。
  const item = store.currentItem();
  if (!item || item.gameId !== "draw") return null;
  if (store.state.room.phase !== "playing") return null; // 去咗結算／返大堂都唔應該再提「你已出局」
  if (st.settled || st.result) return null;
  return {
    matchNo: st.matchNo,
    questionNo: st.questionNo + 1,
    eliminated: st.eliminatedIds.includes(playerId),
    result: st.result,
  };
}

export function buildStageView(store: Store): StageView {
  const room = store.state.room;
  const stage = room.stage;
  const item = store.currentItem();
  const fullRulePage = stage.mode === "rules" ? resolveRulePage(store) : null;
  const payload = stage.payload as Record<string, unknown>;
  const rulePagesSplit = fullRulePage ? store.rulePages(fullRulePage) : null;
  const rawPageIndex = typeof payload.pageIndex === "number" ? payload.pageIndex : 0;
  const pageIndex = rulePagesSplit ? Math.max(0, Math.min(rawPageIndex, rulePagesSplit.length - 1)) : rawPageIndex;
  const rulePage = fullRulePage ? { ...fullRulePage, blocks: rulePagesSplit ? (rulePagesSplit[pageIndex] ?? []) : fullRulePage.blocks } : null;
  const pag = rulePagesSplit ? { pageIndex, totalPages: rulePagesSplit.length } : null;
  const cur = currentQuestion(store);

  let question: StageView["question"] = null;
  let tally: StageTally | null = null;
  let reveal: StageReveal | null = null;
  let vote: StageView["vote"] = null;
  let bid: StageView["bid"] = null;
  let drawWall: StageView["drawWall"] = null;
  let song: StageView["song"] = null;
  let roleReveal: StageView["roleReveal"] = null;
  let saboteurInfo: StageView["saboteurInfo"] = null;

  // v04-D／v0.4.5：主持「出題目」＝stage.payload.preview:true，唔開 round 都要砌到題目＋全部選項出大mon
  // （preview 只係「未開 round」嘅標記：大mon 要讀得晒題目同選項先開始計時；手機維持等主持）
  // 兼容舊 journal／舊 payload：v0.4.5 之前用 showOptions:false 做「只出題目」標記
  const isPreview = stage.mode === "question" && (payload.preview === true || payload.showOptions === false);
  if (isPreview) {
    const previewCard = typeof payload.cardId === "string" ? store.card(payload.cardId) : undefined;
    if (previewCard && (previewCard.type === "choice" || previewCard.type === "open")) {
      // preview 有 options（選擇題），但永遠冇 endsAt／answeredCount：唔倒數、唔開 round
      question = {
        roundId: "",
        cardId: previewCard.id,
        prompt: previewCard.prompt,
        imageUrl: previewCard.imageUrl,
        options: previewCard.options,
        endsAt: null,
        answeredCount: 0,
        eligibleCount: store.approvedPlayers().length,
        kind: previewCard.type,
        showOptions: true,
        preview: true,
      };
    }
  } else if (cur) {
    const { round, card } = cur;
    if (stage.mode === "question" && (card.type === "choice" || card.type === "open")) {
      question = {
        roundId: round.id,
        cardId: card.id,
        prompt: card.prompt,
        imageUrl: card.imageUrl,
        options: card.options,
        endsAt: round.endsAt,
        answeredCount: cur.answered,
        eligibleCount: cur.eligible,
        kind: card.type,
        showOptions: true,
        preview: false,
      };
    }
  }

  // v0.4.4：分佈畫面唔適用拍賣卡（以前會將拍賣畫成「答案分佈」＋玩家名＋秒數）。
  // open 數字／文字題收卷後仍然要靠 tally 出「名＋答案」，所以只排除 bid。
  if (stage.mode === "tally" && cur && cur.card.type !== "bid") {
    const { round, card } = cur;
    const subs = store.submissionsForRound(round.id).filter((s) => s.confirmed);
    const options = card.options ?? [];
    const counts = voteCounts(store, round, options.length);
    const voters = subs
      .map((s) => {
        const p = store.player(s.playerId);
        return p && typeof s.choice === "number"
          ? { name: p.name, avatar: p.avatar, choice: s.choice, number: p.number }
          : null;
      })
      .filter((x): x is { name: string; avatar: PublicPlayer["avatar"]; choice: number; number: number } => x !== null)
      .sort((a, b) => a.number - b.number)
      .map(({ name, avatar, choice }) => ({ name, avatar, choice }));
    const isSab = card.gameId === "saboteur";
    // 搗蛋鬼：開票後（closed／tally／revealed）出該輪 aggregate 票數，但永遠唔出個人票（§3／§4）
    let sabOptions = options;
    let sabCounts = counts;
    if (isSab) {
      const approved = store.approvedPlayers();
      sabOptions = approved.map((p) => p.name);
      const subs2 = store.submissionsForRound(round.id).filter((x) => x.confirmed && x.kind === "vote");
      sabCounts = approved.map((p) => subs2.filter((x) => x.text === p.id).length);
      if (round.state === "open") sabCounts = sabOptions.map(() => 0);
    }
    // v0.3.3：開放題（冇 options）→ 列出「名＋答案」，主持／大mon 對卷時認得人
    const answers = options.length
      ? []
      : subs
          .map((s) => {
            const p = store.player(s.playerId);
            if (!p) return null;
            const text = typeof s.amount === "number" ? String(s.amount) : (s.text ?? "");
            return { name: p.name, avatar: p.avatar, text, number: p.number };
          })
          .filter((x): x is { name: string; avatar: PublicPlayer["avatar"]; text: string; number: number } => x !== null)
          .sort((a, b) => a.number - b.number)
          .map(({ name, avatar, text }) => ({ name, avatar, text }));
    tally = {
      roundId: round.id,
      cardId: card.id,
      prompt: card.prompt,
      options: sabOptions,
      counts: sabCounts,
      voters: isSab ? [] : voters,
      answerCount: cur.answered,
      eligibleCount: cur.eligible,
      answers: isSab ? [] : answers,
    };
  }

  if (stage.mode === "reveal" && cur) {
    const { round, card } = cur;
    const options = card.options ?? [];
    const counts = options.length ? voteCounts(store, round, options.length) : undefined;
    reveal = {
      roundId: round.id,
      cardId: card.id,
      prompt: card.prompt,
      options: card.options,
      correct: card.correct,
      explanation: card.explanation,
      referenceAnswer: card.referenceAnswer,
      actualAnswer: round.actualAnswer ?? card.actualAnswer,
      counts,
    };
  }

  if ((stage.mode === "draw-wall" || stage.mode === "draw-focus") && cur) {
    const works = worksForCard(store, cur.card);
    const counts = voteCounts(store, cur.round, works.length);
    works.forEach((w, i) => { w.votes = counts[i] ?? 0; });
    drawWall = { works, focusId: (payload.focusId as string) ?? null };
  }

  if (stage.mode === "vote" && cur) {
    const { round, card } = cur;
    let options: { id: string; label: string }[] = [];
    let counts: number[] = [];
    if (card.voteMode === "works") {
      const works = worksForCard(store, card);
      options = works.map((w) => ({ id: w.id, label: `#${w.authorNumber} ${w.authorName}` }));
      counts = round.state === "open" ? new Array(options.length).fill(0) : voteCounts(store, round, options.length);
      works.forEach((w, i) => { w.votes = counts[i] ?? 0; });
      drawWall = { works, focusId: (payload.focusId as string) ?? null };
    } else {
      const approved = store.approvedPlayers();
      const isSab = card.gameId === "saboteur";
      options = approved.map((p) => ({ id: p.id, label: p.name }));
      // 搗蛋鬼：開票前（open）stage 只出進度；closed 後出 aggregate（仍唔出個人票）
      if (isSab) {
        const subs2 = store.submissionsForRound(round.id).filter((x) => x.confirmed && x.kind === "vote");
        counts = round.state === "open" ? options.map(() => 0) : approved.map((p) => subs2.filter((x) => x.text === p.id).length);
      } else {
        counts = round.state === "open" ? new Array(options.length).fill(0) : voteCounts(store, round, options.length);
      }
    }
    vote = {
      roundId: round.id,
      cardId: card.id,
      prompt: card.prompt,
      options,
      counts,
      answeredCount: cur.answered,
      eligibleCount: cur.eligible,
    };
  }

  // v0.4.3（P0）：一定要係 bid 卡先砌競投畫面。以前主持撳「競投」（純 stage.set）會將
  // 任何 currentRound（例如啱啱收咗卷嘅問答卡）畫成假拍賣：假題目＋0.0 倒數＋「已競投 0/N 人」，
  // 而手機根本冇競投掣（task 跟住張問答卡）。
  if (stage.mode === "bid" && cur && cur.card.type === "bid") {
    const { round, card } = cur;
    const bidOrder = new Map(store.state.submissions.map((x, i) => [x.id, i]));
    const subs = store
      .submissionsForRound(round.id)
      .filter((s) => s.confirmed && typeof s.amount === "number" && (s.amount ?? 0) >= 1)
      .sort(
        (a, b) =>
          (a.amount ?? 0) - (b.amount ?? 0) ||
          (bidOrder.get(b.id) ?? 0) - (bidOrder.get(a.id) ?? 0) ||
          b.ts - a.ts,
      );
    const closed = round.state !== "open";
    const best = subs[0];
    const winner = best ? store.player(best.playerId) : undefined;
    // 規格澄清（2026-11-16，lead 拍板）：bid.publish 之前唔送個別秒數；
    // publish 之後（round.auction 有值）大mon 要顯示完整排名（主播自己撳咗公佈）。
    const settled =
      !!round.auction ||
      store.state.ledger.some((e) => e.roundId === round.id && e.gameId === "auction" && e.by === "host" && !e.voided);
    const auction = round.auction;
    const cursor = auction?.cursor ?? 0;
    const ranking = (auction?.ranking ?? []).map((r, i) => {
      const p = store.player(r.playerId);
      return {
        playerId: r.playerId,
        name: p?.name ?? "?",
        number: p?.number ?? 0,
        seconds: r.seconds,
        tried: i < cursor,
        current: i === cursor && !auction?.finished,
      };
    });
    const currentEntry = auction && !auction.finished ? auction.ranking[cursor] : undefined;
    bid = {
      roundId: round.id,
      cardId: card.id,
      prompt: card.prompt,
      maxBid: card.maxBid ?? store.state.settings.maxBid,
      endsAt: round.endsAt,
      bidCount: subs.length,
      // v0.4.3：競投唔限人數——分母用「而家 approved 嘅人」，唔用開 round 一刻嘅 snapshot
      eligibleCount: store.approvedPlayers().length,
      closed,
      settled,
      winnerName: settled ? winner?.name ?? null : null,
      winnerAmount: settled ? best?.amount ?? null : null,
      ranking,
      currentName: currentEntry ? (store.player(currentEntry.playerId)?.name ?? "?") : null,
      currentSeconds: currentEntry ? currentEntry.seconds : null,
      remaining: ranking.filter((r) => !r.tried).length,
    };
  }

  const playback = store.state.playback;
  if (stage.mode === "song" && playback) {
    const idx = store.state.songs.findIndex((s) => s.id === playback.songId);
    song = {
      songIndex: idx >= 0 ? idx + 1 : 1,
      totalSongs: store.state.songs.length,
      state: playback.state,
      title: playback.revealedAt ? (store.state.songs[idx]?.title ?? null) : null,
    };
  }

  const sab = room.gameState?.saboteur;
  if (sab) {
    const curSabRound = sab.rounds.find((r) => r.roundId === room.currentRoundId) ?? sab.rounds[sab.rounds.length - 1];
    // v0.4.4（codex audit B7）：投票未開（open）唔准送票數／top，否則大mon DTO 會漏個人票
    const sabVoteOpen = Boolean(curSabRound && store.round(curSabRound.roundId)?.state === "open");
    const approved = store.approvedPlayers();
    const subs2 = curSabRound ? store.submissionsForRound(curSabRound.roundId).filter((x) => x.confirmed && x.kind === "vote") : [];
    const countsMap = new Map<string, number>();
    for (const x of subs2) if (x.text) countsMap.set(x.text, (countsMap.get(x.text) ?? 0) + 1);
    saboteurInfo = {
      roundIndex: curSabRound?.index ?? null,
      eliminated: sab.eliminatedIds.map((id) => {
        const p = store.player(id);
        return { id, name: p?.name ?? "?", number: p?.number ?? 0 };
      }),
      caught: sab.caught,
      finished: sab.finished,
      revealedRole: sab.revealedRole,
      validVotes: sabVoteOpen ? 0 : subs2.length,
      top: sabVoteOpen
        ? []
        : [...countsMap.entries()]
            .map(([id, count]) => ({ name: store.player(id)?.name ?? "?", count }))
            .sort((a, b) => b.count - a.count),
    };
  }
  if (stage.mode === "role-reveal" && sab) {
    const counts = new Map<string, number>();
    for (const r of sab.rounds) {
      for (const v of r.votes) {
        if (v.targetId) counts.set(v.targetId, (counts.get(v.targetId) ?? 0) + 1);
      }
    }
    roleReveal = {
      saboteurName: sab.revealedRole ? (store.player(sab.saboteurId ?? "")?.name ?? null) : null,
      caught: sab.caught,
      votes: [...counts.entries()]
        .map(([id, count]) => ({ name: store.player(id)?.name ?? "?", count }))
        .sort((a, b) => b.count - a.count),
    };
  }

  let finale: StageView["finale"] = null;
  if (stage.mode === "finale" || stage.mode === "award" || stage.mode === "leaderboard") {
    const entries = sortedEntries(store, stage.ticker.sort);
    const maps = store.scoreMaps();
    void maps;
    const awards = room.awards.map((a) => {
      const target = a.targetId ? store.player(a.targetId) : undefined;
      // v0.4.4（codex audit B4）：未撳「揭曉」唔可以漏得主名／分數（大mon／手機 DTO 都會收到）
      return {
        id: a.id,
        revealed: a.revealed,
        name: a.revealed ? target?.name ?? null : null,
        score: a.revealed && target ? store.playerScore(target.id) : null,
        reason: AWARD_REASON[a.id],
      };
    });
    finale = {
      entries,
      stats: store.stats(),
      awards: awards.filter((a) => stage.mode !== "award" || a.revealed),
    };
  }

  const toast = store.state.activity.length ? store.state.activity[store.state.activity.length - 1] : null;

  return {
    role: "stage",
    serverNow: Date.now(),
    seq: store.seq,
    revision: store.revision,
    seqEpoch: store.seqEpoch,
    phase: room.phase,
    stage,
    ticker: stage.ticker,
    roomCode: room.code,
    players: room.players.filter((p) => p.status !== "kicked").map(publicPlayer),
    groups: room.groups.map((g) => ({ ...g })),
    scores: sortedEntries(store, stage.ticker.sort),
    currentItem: item
      ? { id: item.id, index: item.index, gameId: item.gameId, title: item.title, state: item.state }
      : null,
    rundownCount: room.rundown.length,
    rulePage,
    rulePagesMeta: pag ? { pageIndex, totalPages: pag.totalPages, autoAdvanceSeconds: rulePage?.autoAdvanceSeconds ?? 0 } : null,
    question,
    tally,
    reveal,
    vote,
    undercover: buildUndercover(store),
    undercoverMatch: buildUndercoverMatchView(store),
    message: buildMessage(store),
    gameScores: buildGameScores(store),
    bid,
    drawWall,
    song,
    roleReveal,
    saboteurInfo,
    finale,
    toast: toast ? toast.text : null,
    toastId: toast ? toast.id : null,
  };
}

function mySubmission(store: Store, round: Round | undefined, playerId: string): PlayerSelfView["mySubmission"] {
  if (!round) return null;
  const s = store.state.submissions.find((x) => x.roundId === round.id && x.playerId === playerId);
  if (!s) return { roundId: round.id, status: "none", confirmed: false };
  return {
    roundId: round.id,
    status: s.confirmed ? "submitted" : "rejected",
    choice: s.choice,
    amount: s.amount,
    text: s.text,
    confirmed: s.confirmed,
  };
}

function playerReveal(store: Store, round: Round | undefined, card: Card | undefined, playerId: string): PlayerSelfView["reveal"] {
  if (!round || !card) return null;
  const sub = store.state.submissions.find((x) => x.roundId === round.id && x.playerId === playerId);
  let myResult: "correct" | "wrong" | "unjudged" | "none" = "none";
  if (sub) {
    if (sub.judged) myResult = sub.judged.correct ? "correct" : "wrong";
    else if (card.type === "choice" && typeof card.correct === "number") myResult = sub.choice === card.correct ? "correct" : "wrong";
    else {
      // P1-e：數字開放題自動容差評分之後，手機要見到「中／唔中」（唔好永遠「主持評分中」）
      const actual = round.actualAnswer ?? card.actualAnswer;
      const tol = card.tolerance;
      if (card.type === "open" && typeof tol === "number" && typeof sub.amount === "number" && typeof actual === "number")
        myResult = Math.abs(sub.amount - actual) <= tol ? "correct" : "wrong";
      else myResult = "unjudged";
    }
  }
  return {
    roundId: round.id,
    correct: card.correct,
    explanation: card.explanation,
    referenceAnswer: card.referenceAnswer,
    actualAnswer: round.actualAnswer ?? card.actualAnswer,
    myResult,
  };
}

/** 手機（PlayerSelfView） */
export function buildPlayerView(store: Store, playerId: string): PlayerSelfView {
  const room = store.state.room;
  const p = store.player(playerId) as Player;
  const maps = store.scoreMaps();
  const stage = room.stage;
  const round = store.currentRound();
  const card = round ? store.card(round.cardId) : undefined;
  const item = store.currentItem();
  // v0.4.3：競投唔限人數——approved 就投得，唔理開 round 一刻嘅 eligible snapshot
  const eligible = round ? (card?.type === "bid" ? p?.status === "approved" : round.eligiblePlayerIds.includes(playerId)) : false;

  let task: PlayerSelfView["task"] = null;
  if (round && card && eligible && round.state === "open") {
    if (card.type === "choice" || card.type === "open" || card.type === "bid") {
      task = {
        roundId: round.id,
        cardId: card.id,
        kind: card.type,
        prompt: card.prompt,
        imageUrl: card.imageUrl,
        options: card.options,
        openKind: card.openKind,
        maxBid: card.maxBid ?? store.state.settings.maxBid,
        endsAt: round.endsAt,
        seconds: card.seconds,
      };
    } else if (card.type === "vote") {
      if (card.voteMode === "works") {
        const works = worksForCard(store, card);
        task = {
          roundId: round.id,
          cardId: card.id,
          kind: "vote",
          prompt: card.prompt,
          voteOptions: works.map((w, wi) => ({ id: String(wi), label: `#${w.authorNumber} ${w.authorName}` })),
          endsAt: round.endsAt,
          seconds: card.seconds,
        };
      } else if (card.options && card.options.length) {
        // 臥底投票：候選名單由主持揀（card.options），自己唔可以投自己
        task = {
          roundId: round.id,
          cardId: card.id,
          kind: "vote",
          prompt: card.prompt,
          voteOptions: card.options
            .filter((id) => id !== playerId)
            .map((id) => store.player(id))
            .filter((x): x is Player => !!x)
            .map((x) => ({ id: x.id, label: x.name, avatar: x.avatar })),
          endsAt: round.endsAt,
          seconds: card.seconds,
        };
      } else {
        const votesNeeded = store.state.room.gameState?.saboteur?.eliminatedIds ?? [];
        task = {
          roundId: round.id,
          cardId: card.id,
          kind: "vote",
          prompt: card.prompt,
          voteOptions: store
            .approvedPlayers()
            .filter((x) => x.id !== playerId && !votesNeeded.includes(x.id))
            .map((x) => ({ id: x.id, label: x.name, avatar: x.avatar })),
          endsAt: round.endsAt,
          seconds: card.seconds,
        };
      }
    }
  }

  let reveal: PlayerSelfView["reveal"] = null;
  if (round && card && (stage.mode === "reveal" || round.state === "revealed")) {
    reveal = playerReveal(store, round, card, playerId);
  }

  const sab = room.gameState?.saboteur;
  // v0.4.4（codex audit B2）：secretRole 會殘留（rundown.reset 冇清）——所以一定要有
  // 進行中嘅搗蛋鬼局、而且當前卡係搗蛋鬼卡，先准送角色／參考答案，否則玩完搗蛋鬼去問答會漏答案。
  const roleActive = Boolean(sab);
  const roleInfo: PlayerSelfView["roleInfo"] = p.secretRole && roleActive
    ? {
        secretRole: p.secretRole,
        saboteurAnswer: p.secretRole === "saboteur" && card?.gameId === "saboteur" ? card.referenceAnswer : undefined,
      }
    : null;

  let finale: PlayerSelfView["finale"] = null;
  if (stage.mode === "finale" || stage.mode === "award" || stage.mode === "leaderboard") {
    finale = buildStageView(store).finale;
  }
  const toast = store.state.activity.length ? store.state.activity[store.state.activity.length - 1] : null;

  return {
    role: "player",
    serverNow: Date.now(),
    seq: store.seq,
    revision: store.revision,
    seqEpoch: store.seqEpoch,
    phase: room.phase,
    mode: stage.mode,
    lock: stage.lock,
    me: {
      id: p.id,
      name: p.name,
      number: p.number,
      avatar: p.avatar,
      groupId: p.groupId,
      status: p.status,
      score: maps.player.get(p.id) ?? 0,
      groupScore: p.groupId ? (maps.group.get(p.groupId) ?? 0) : 0,
      secretRole: roleActive ? p.secretRole : undefined,
      saboteurAnswer: roleActive && p.secretRole === "saboteur" && card?.gameId === "saboteur" ? card.referenceAnswer : undefined,
    },
    roomCode: room.code,
    ticker: stage.ticker,
    groups: room.groups.map((g) => ({ ...g })),
    scores: sortedEntries(store, stage.ticker.sort),
    task,
    mySubmission: mySubmission(store, round, playerId),
    progress: round && (card?.type === "choice" || card?.type === "open" || card?.type === "vote" || card?.type === "bid")
      ? store.answerStats(round)
      : null,
    reveal,
    roleInfo,
    undercoverMatch: playerUndercoverMatch(store, playerId),
    finale,
    toast: toast ? toast.text : null,
    toastId: toast ? toast.id : null,
  };
}

/** 主持台（HostView）——全部 */
export function buildHostView(store: Store, hostId: string, hostName: string, conns: ConnStats): HostView {
  const room = store.state.room;
  const maps = store.scoreMaps();
  const cur = store.currentRound() ?? null;
  const currentItem = store.currentItem();
  const toast = store.state.activity.length ? store.state.activity[store.state.activity.length - 1] : null;
  void toast;
  const stats = store.stats();
  return {
    role: "host",
    serverNow: Date.now(),
    seq: store.seq,
    revision: store.revision,
    seqEpoch: store.seqEpoch,
    hostId,
    hostName,
    roomCode: room.code,
    phase: room.phase,
    stage: room.stage,
    settings: { autoClose: store.state.settings.autoClose, maxBid: store.state.settings.maxBid },
    players: room.players.map((p) => ({
      ...p,
      score: maps.player.get(p.id) ?? 0,
      groupScore: p.groupId ? (maps.group.get(p.groupId) ?? 0) : 0,
    })),
    groups: room.groups.map((g) => ({ ...g })),
    rundown: room.rundown.map((i) => ({ ...i })),
    currentItemId: room.currentItemId,
    currentRound: cur,
    rounds: room.rounds.map((r) => ({ ...r })),
    cards: store.state.cards.map((c) => ({ ...c })),
    undercover: buildUndercover(store),
    quiz: store.quizCards().map((c) => ({ ...c })),
    songs: store.state.songs.map((s) => ({ ...s })),
    playback: store.state.playback ? ({ ...store.state.playback } as MediaPlayback) : null,
    audioLease: room.audioLease ? { ...room.audioLease } : null,
    ledger: store.state.ledger.map((e) => ({ ...e })),
    submissions: store.state.submissions.map((s) => ({ ...s })),
    rulePages: room.rulePages.map((p) => ({ ...p })),
    awards: room.awards.map((a) => ({ ...a })),
    stats,
    activity: store.state.activity.slice(-10).map((a) => ({ ...a })),
    connections: conns,
    caps: {
      approved: store.approvedPlayers().length,
      pending: room.players.filter((p) => p.status === "pending").length,
      maxApproved: 30,
      maxPending: 10,
    },
    currentItem: currentItem ? { ...currentItem } : null,
    assets: store.state.assets.map((a) => ({
      id: a.id,
      kind: a.kind,
      file: a.file,
      mime: a.mime,
      size: a.size,
      originalName: a.originalName,
      authorId: a.authorId,
      cardId: a.cardId,
      createdAt: a.createdAt,
    })),
    saboteurState: room.gameState?.saboteur ? JSON.parse(JSON.stringify(room.gameState.saboteur)) : null,
    undercoverMatch: room.gameState?.undercover ? JSON.parse(JSON.stringify(room.gameState.undercover)) : null,
    killerState: room.gameState?.killer ? JSON.parse(JSON.stringify(room.gameState.killer)) : null,
  } as HostView;
}
