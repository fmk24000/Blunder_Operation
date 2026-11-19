/** 單元測試：journal durability、計分公式、頒獎邊界、Q14 時間題（PLAN-v3.1 §6／§3.1） */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import ts from "typescript";

import { minutesToMidnightHK, executeCommand, tickAutoClose, tickLeases, tickUndercover, bidRanking, roundExpired, bidSecondsAllowed } from "../dist/server/commands.js";
import { buildStageView, buildPlayerView, buildHostView } from "../dist/server/views.js";
import { Store } from "../dist/server/store.js";
import { loadQuizSeed, loadUndercoverSeed, loadRulePagesSeed, questionToCard, undercoverTopicToCard, bootstrapMutations, defaultRundown } from "../dist/server/seed.js";
import { Journal } from "../dist/server/journal.js";

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hbd-${tag}-`));
}

function makeStore(tag = "unit") {
  const dir = tmpDir(tag);
  const store = new Store("room_test", path.join(dir, "journal"), "1234");
  store.load();
  return { store, dir };
}

function addPlayers(store, n) {
  const players = [];
  for (let i = 1; i <= n; i++) {
    const p = {
      id: `p${i}`,
      name: `玩家${i}`,
      number: i,
      groupId: null,
      status: "approved",
      connected: true,
      lastSeen: Date.now(),
      avatar: { kind: "emoji", emoji: "🙂", color: "#3b82f6" },
      joinedAt: Date.now(),
    };
    players.push(p);
    store.commit([{ t: "player.add", d: { player: p } }]);
  }
  return players;
}

function addScore(store, targetType, id, delta, reason = "test") {
  store.commit([
    {
      t: "ledger.append",
      d: {
        events: [
          {
            id: `ev_${Math.random().toString(36).slice(2)}`,
            ts: Date.now(),
            target: { type: targetType, id },
            delta,
            reason,
            by: "host",
          },
        ],
      },
    },
  ]);
}

test("Q14 minutesToMidnightHK：23:58:30 → 1、23:59:30 → 0、00:00:00 → 1440、跨年 23:59:59 → 0", () => {
  assert.equal(minutesToMidnightHK(new Date("2026-11-16T23:58:30+08:00").getTime()), 1);
  assert.equal(minutesToMidnightHK(new Date("2026-11-16T23:59:30+08:00").getTime()), 0);
  assert.equal(minutesToMidnightHK(new Date("2026-11-16T00:00:00+08:00").getTime()), 1440);
  assert.equal(minutesToMidnightHK(new Date("2026-12-31T23:59:59+08:00").getTime()), 0);
  assert.equal(minutesToMidnightHK(new Date("2026-11-16T12:00:00+08:00").getTime()), 720);
});

test("頒獎演算法：§6 例子（10 人）大獎 40、2獎 22、3獎 5", () => {
  const { store } = makeStore("awards10");
  const ps = addPlayers(store, 10);
  const scores = [5, 8, 12, 15, 18, 22, 25, 30, 33, 40];
  ps.forEach((p, i) => addScore(store, "player", p.id, scores[i]));
  const awards = store.computeAwards();
  assert.equal(awards.find((a) => a.id === "grand").targetId, ps[9].id);
  assert.equal(awards.find((a) => a.id === "second").targetId, ps[5].id); // 22
  assert.equal(awards.find((a) => a.id === "third").targetId, ps[0].id); // 5
});

test("頒獎邊界：n=1 只有大獎、n=2 大獎＋3獎、n=0 全缺", () => {
  {
    const { store } = makeStore("awards1");
    const ps = addPlayers(store, 1);
    addScore(store, "player", ps[0].id, 7);
    const a = store.computeAwards();
    assert.equal(a.find((x) => x.id === "grand").targetId, ps[0].id);
    assert.equal(a.find((x) => x.id === "second").targetId, null);
    assert.equal(a.find((x) => x.id === "third").targetId, null);
  }
  {
    const { store } = makeStore("awards2");
    const ps = addPlayers(store, 2);
    addScore(store, "player", ps[0].id, 10);
    addScore(store, "player", ps[1].id, 3);
    const a = store.computeAwards();
    assert.equal(a.find((x) => x.id === "grand").targetId, ps[0].id);
    assert.equal(a.find((x) => x.id === "second").targetId, null);
    assert.equal(a.find((x) => x.id === "third").targetId, ps[1].id);
  }
  {
    const { store } = makeStore("awards0");
    const a = store.computeAwards();
    assert.equal(a.every((x) => x.targetId === null), true);
  }
});

test("頒獎：全部同分 → 大獎編號最細、2/3 獎按編號順序", () => {
  const { store } = makeStore("awardsSame");
  const ps = addPlayers(store, 4);
  for (const p of ps) addScore(store, "player", p.id, 5);
  const a = store.computeAwards();
  assert.equal(a.find((x) => x.id === "grand").targetId, ps[0].id);
  assert.equal(a.find((x) => x.id === "second").targetId, ps[1].id);
  assert.equal(a.find((x) => x.id === "third").targetId, ps[2].id);
});

test("計分唯一公式：w=組分＝group 事件＋組員個人分", () => {
  const { store } = makeStore("groupscore");
  const ps = addPlayers(store, 3);
  store.commit([{ t: "groups.set", d: { groups: [{ id: "g1", name: "第一組", color: "#3b82f6", order: 0 }] } }]);
  store.commit([{ t: "group.assign", d: { playerId: ps[0].id, groupId: "g1" } }]);
  store.commit([{ t: "group.assign", d: { playerId: ps[1].id, groupId: "g1" } }]);
  addScore(store, "player", ps[0].id, 4);
  addScore(store, "player", ps[1].id, 3);
  addScore(store, "group", "g1", 2);
  assert.equal(store.playerScore(ps[0].id), 4);
  assert.equal(store.scoreMaps().group.get("g1"), 9);
});

test("undo＝voided:true 唔刪紀錄：重算即還原、歷史仍在", () => {
  const { store } = makeStore("undo");
  const ps = addPlayers(store, 1);
  addScore(store, "player", ps[0].id, 6);
  const ev = store.state.ledger[0];
  store.commit([{ t: "ledger.void", d: { eventIds: [ev.id], by: "host" } }]);
  assert.equal(store.playerScore(ps[0].id), 0);
  assert.equal(store.state.ledger.length, 1);
  assert.equal(store.state.ledger[0].voided, true);
});

test("journal：重啟 replay 後狀態一致（ACK 過嘅分一筆都唔失）", () => {
  const dir = tmpDir("journal-ok");
  const jdir = path.join(dir, "journal");
  {
    const store = new Store("room_j", jdir, "1234");
    store.load();
    const ps = addPlayers(store, 2);
    addScore(store, "player", ps[0].id, 10);
    addScore(store, "player", ps[1].id, -3);
    store.journal.close();
  }
  const store2 = new Store("room_j", jdir, "1234");
  const res = store2.load();
  assert.equal(res.loaded, true);
  assert.equal(store2.state.room.players.length, 2);
  assert.equal(store2.playerScore("p1"), 10);
  assert.equal(store2.playerScore("p2"), -3);
});

test("journal：壞尾行 truncate 到上一個完整 record（唔會永遠 ready 唔到）", () => {
  const dir = tmpDir("journal-bad");
  const jdir = path.join(dir, "journal");
  {
    const store = new Store("room_b", jdir, "1234");
    store.load();
    addPlayers(store, 1);
    addScore(store, "player", "p1", 5);
    store.journal.close();
  }
  const seg = path.join(jdir, "segment-0001.jsonl");
  const raw = fs.readFileSync(seg, "utf8");
  fs.writeFileSync(seg, raw + '{"v":1,"seq":999,"ts":0,"type":"tx","data":{"records":[]}}|deadbeef\n');
  const store2 = new Store("room_b", jdir, "1234");
  const res = store2.load();
  assert.ok(res.truncated >= 1);
  assert.equal(store2.playerScore("p1"), 5);
  assert.equal(store2.state.room.players.length, 1);
});

test("journal：manifest＋segment 檔案齊、checksum 對得上", () => {
  const dir = tmpDir("journal-files");
  const jdir = path.join(dir, "journal");
  const journal = new Journal(jdir, "room_f");
  journal.append([{ t: "room.init", d: { id: "room_f", code: "4321" } }]);
  journal.close();
  const manifest = JSON.parse(fs.readFileSync(path.join(jdir, "manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.roomId, "room_f");
  assert.ok(fs.existsSync(path.join(jdir, "segment-0001.jsonl")));
  const lines = fs.readFileSync(path.join(jdir, "segment-0001.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\|[0-9a-f]{64}$/);
});


/* ───────── codex audit 第二批：搗蛋鬼／評審／計票回歸測試 ───────── */

let cmdSeq = 0;
function run(store, kind, payload = {}, targetId) {
  cmdSeq += 1;
  return executeCommand(store, "host_test", "測試主持", { commandId: `cmd_audit_${cmdSeq}`, kind, targetId, payload });
}
function putCard(store, card) {
  store.commit([{ t: "card.put", d: { card: { version: 1, state: "open", ...card } } }]);
}
function putRound(store, round) {
  store.commit([{
    t: "round.put",
    d: { round: { cardVersion: 1, endsAt: null, closedAt: null, state: "open", eligiblePlayerIds: [], ...round }, currentRoundId: round.id },
  }]);
}
function vote(store, { roundId, cardId, voterId, targetId }) {
  store.commit([{
    t: "submission.add",
    d: { submission: { id: `s_${roundId}_${voterId}`, roundId, cardId, playerId: voterId, ts: Date.now(), kind: "vote", text: targetId, confirmed: true, payloadHash: "h" } },
  }]);
}
function isCmdError(code, re) {
  return (err) => err?.name !== "AssertionError" && err?.code === code && (!re || re.test(err.message));
}

test("saboteur auto-close（過半）會即刻計票結算，唔會繞過計票", () => {
  const { store } = makeStore("sab-auto-majority");
  const players = addPlayers(store, 5);
  run(store, "room.start");
  run(store, "saboteur.assign", { saboteurIndex: 0 }); // p1 做搗蛋鬼
  const opened = run(store, "saboteur.openRound");
  const roundId = opened.result.roundId;
  const cardId = store.round(roundId).cardId;
  for (const voter of [players[0], players[1], players[3]]) vote(store, { roundId, cardId, voterId: voter.id, targetId: "p3" });
  store.commit([
    { t: "settings.set", d: { settings: { autoClose: true } } },
    { t: "round.update", d: { roundId, patch: { endsAt: Date.now() - 1 } } },
  ]);

  assert.equal(tickAutoClose(store), true);
  const st = store.state.room.gameState.saboteur;
  const rec = st.rounds.find((r) => r.roundId === roundId);
  assert.equal(rec.state, "resolved", "auto-close 要結算搗蛋鬼輪次");
  assert.equal(rec.decision, "eliminated");
  assert.deepEqual(st.eliminatedIds, ["p3"]);
  assert.equal(rec.votes.length, 3);
  assert.equal(store.round(roundId).state, "revealed");
  // 已結算嘅輪次再撳「立即計票」：明確拒絕（一個 round 只結算一次），唔係卡死
  assert.throws(() => run(store, "saboteur.closeRound", { roundId }), isCmdError("W_ALREADY_STATE", /已結算/));
});

test("saboteur auto-close（未過半）之後「立即計票」唔會 W_ALREADY_STATE 撞死", () => {
  const { store } = makeStore("sab-auto-decide");
  const players = addPlayers(store, 5);
  run(store, "room.start");
  run(store, "saboteur.assign", { saboteurIndex: 0 });
  const opened = run(store, "saboteur.openRound");
  const roundId = opened.result.roundId;
  const cardId = store.round(roundId).cardId;
  vote(store, { roundId, cardId, voterId: players[0].id, targetId: "p3" });
  vote(store, { roundId, cardId, voterId: players[1].id, targetId: "p4" });
  store.commit([
    { t: "settings.set", d: { settings: { autoClose: true } } },
    { t: "round.update", d: { roundId, patch: { endsAt: Date.now() - 1 } } },
  ]);

  assert.equal(tickAutoClose(store), true);
  assert.equal(store.round(roundId).state, "closed");
  assert.equal(store.state.room.gameState.saboteur.rounds[0].state, "closed");

  // 主持撳「切去分佈」：round→tally，但唔可以蓋走搗蛋鬼計票
  run(store, "card.tally", { cardId });
  assert.equal(store.round(roundId).state, "tally");
  // 主持再撳「立即計票」：照計（idempotent），唔會因為 round 已 closed／tally 而 throw
  const tally = run(store, "saboteur.closeRound", { roundId });
  assert.equal(tally.ok, true);
  assert.equal(tally.result.mode, "decide");
  assert.equal(tally.result.validVotes, 2);
  // 之後主持裁決一樣通
  const decided = run(store, "saboteur.decide", { roundId, decision: "eliminate", targetId: "p3" });
  assert.equal(decided.ok, true);
  assert.deepEqual(store.state.room.gameState.saboteur.eliminatedIds, ["p3"]);
});

test("saboteur retry：roundsDone 只計邏輯輪次（唔會多派 +5）、下一輪 index 唔會跳號", () => {
  const { store } = makeStore("sab-retry");
  const players = addPlayers(store, 5);
  run(store, "room.start");
  run(store, "saboteur.assign", { saboteurIndex: 0 });
  const r1 = run(store, "saboteur.openRound").result.roundId;
  const cardId = store.round(r1).cardId;
  // 真正同票（1:1）→ 裁決，唔係全體棄票（全體棄票而家自己結算，唔會留低等 decide）
  vote(store, { roundId: r1, cardId, voterId: players[1].id, targetId: "p3" });
  vote(store, { roundId: r1, cardId, voterId: players[2].id, targetId: "p4" });
  const tally1 = run(store, "saboteur.closeRound", { roundId: r1 });
  assert.equal(tally1.result.mode, "decide");
  const retry = run(store, "saboteur.decide", { roundId: r1, decision: "retry" });
  const r2 = retry.result.roundId;
  assert.notEqual(r2, r1);
  vote(store, { roundId: r2, cardId, voterId: players[1].id, targetId: "p2" });
  vote(store, { roundId: r2, cardId, voterId: players[2].id, targetId: "p5" });
  const tally2 = run(store, "saboteur.closeRound", { roundId: r2 });
  assert.equal(tally2.result.mode, "decide");
  // 淘汰一個好人：舊碼會當成「兩輪已完成」→ 提早 finished + 搗蛋鬼 +5
  const out = run(store, "saboteur.decide", { roundId: r2, decision: "eliminate", targetId: "p2" });
  const st = store.state.room.gameState.saboteur;
  assert.deepEqual(st.eliminatedIds, ["p2"]);
  assert.equal(st.finished, false, "retry 唔算一輪：未完成兩輪唔可以 finished");
  assert.equal(out.result.nextRound, 2);
  const sabFive = store.state.ledger.filter((e) => !e.voided && e.gameId === "saboteur" && e.reason.includes("潛伏成功"));
  assert.equal(sabFive.length, 0, "唔可以提早派搗蛋鬼 +5");
  // 下一輪 index 用「最大 index + 1」，唔係 rounds.length + 1
  const next = run(store, "saboteur.openRound");
  assert.equal(next.result.index, 2);
});

test("score.judge 拒絕其他 round 嘅提交（跨回合加分）", () => {
  const { store } = makeStore("score-judge");
  addPlayers(store, 2);
  putCard(store, { id: "c1", type: "choice", gameId: "quiz", prompt: "揀一個", points: 2, options: ["A", "B", "C", "D"] });
  putRound(store, { id: "r1", cardId: "c1" });
  store.commit([{ t: "round.put", d: { round: { id: "r2", cardId: "c1", cardVersion: 1, endsAt: null, closedAt: null, state: "open", eligiblePlayerIds: [] } } }]);
  store.commit([{ t: "submission.add", d: { submission: { id: "s_other", roundId: "r2", cardId: "c1", playerId: "p1", ts: Date.now(), kind: "choice", choice: 0, confirmed: true, payloadHash: "h" } } }]);
  store.commit([{ t: "submission.add", d: { submission: { id: "s_unconfirmed", roundId: "r1", cardId: "c1", playerId: "p1", ts: Date.now(), kind: "choice", choice: 0, confirmed: false, payloadHash: "h" } } }]);

  assert.throws(() => run(store, "score.judge", { roundId: "r1", submissionId: "s_other", points: 2 }), isCmdError("W_BAD_SCHEMA", /唔屬於呢個回合/));
  assert.throws(() => run(store, "score.judge", { roundId: "r1", submissionId: "s_unconfirmed", points: 2 }), isCmdError("W_BAD_SCHEMA", /唔屬於呢個回合/));
  assert.equal(store.state.ledger.filter((e) => !e.voided).length, 0, "被拒嘅評分唔可以入帳");
});

test("draw.judge 拒絕唔屬於呢張投票卡嘅作品（同非圖片）", () => {
  const { store } = makeStore("draw-judge");
  addPlayers(store, 2);
  putCard(store, { id: "dc", type: "vote", gameId: "draw", voteMode: "works", prompt: "邊張最似", points: 1, options: ["a1", "a_audio"] });
  const asset = (id, kind, authorId) => ({ id, kind, file: `${id}.bin`, mime: "x", size: 1, originalName: id, uploadedBy: "host", createdAt: Date.now(), authorId });
  store.commit([
    { t: "asset.add", d: { asset: asset("a1", "image", "p1") } },
    { t: "asset.add", d: { asset: asset("a_other", "image", "p2") } },
    { t: "asset.add", d: { asset: asset("a_audio", "audio", "p1") } },
  ]);

  assert.throws(() => run(store, "draw.judge", { cardId: "dc", assetId: "a_other", points: 1 }, "dc"), isCmdError("W_BAD_SCHEMA", /唔屬於呢張投票卡/));
  assert.throws(() => run(store, "draw.judge", { cardId: "dc", assetId: "a_audio", points: 1 }, "dc"), isCmdError("W_BAD_SCHEMA", /唔屬於呢張投票卡/));
  assert.equal(store.state.ledger.filter((e) => !e.voided).length, 0, "被拒嘅評審唔可以入帳");

  const ok = run(store, "draw.judge", { cardId: "dc", assetId: "a1", points: 2 }, "dc");
  assert.equal(ok.ok, true);
  assert.equal(store.playerScore("p1"), 2);
});


test("saboteur：card.tally 觸發即場淘汰之後 round 保持 revealed（唔會蓋成 tally 而卡死下一輪）", () => {
  const { store } = makeStore("sab-tally-elim");
  const players = addPlayers(store, 5);
  run(store, "room.start");
  run(store, "saboteur.assign", { saboteurIndex: 0 });
  const roundId = run(store, "saboteur.openRound").result.roundId;
  const cardId = store.round(roundId).cardId;
  for (const voter of [players[0], players[1], players[2]]) vote(store, { roundId, cardId, voterId: voter.id, targetId: "p4" });

  const res = run(store, "card.tally", { cardId });
  assert.equal(res.ok, true);
  assert.deepEqual(store.state.room.gameState.saboteur.eliminatedIds, ["p4"]);
  assert.equal(store.round(roundId).state, "revealed", "已結算嘅搗蛋鬼 round 唔應該被 tally patch 蓋走");
  // 下一輪照開得（唔會因為 round 停在 tally 而「仲有回合未完成」）
  const next = run(store, "saboteur.openRound");
  assert.equal(next.result.index, 2);
});

/* ───────── codex 第三輪：全體棄票結算／generic reopen 保護 ───────── */

test("saboteur 全體棄票（一輪）：當場結算 decision='none'、冇人淘汰、下一輪照開得", () => {
  const { store } = makeStore("sab-none-one");
  addPlayers(store, 5);
  run(store, "room.start");
  run(store, "saboteur.assign", { saboteurIndex: 0 });
  const roundId = run(store, "saboteur.openRound").result.roundId;
  const cardId = store.round(roundId).cardId;

  const tally = run(store, "saboteur.closeRound", { roundId });
  assert.equal(tally.result.mode, "none");
  assert.equal(tally.result.validVotes, 0);
  const st = store.state.room.gameState.saboteur;
  const rec = st.rounds.find((r) => r.roundId === roundId);
  assert.equal(rec.state, "resolved", "全體棄票都要結算，唔可以留低 closed＋decision:null");
  assert.equal(rec.decision, "none");
  assert.equal(rec.eliminatedId, null);
  assert.deepEqual(st.eliminatedIds, [], "全體棄票＝呢輪冇人淘汰");
  assert.equal(st.finished, false, "一輪棄票唔等於完成兩輪");
  assert.equal(st.caught, false);
  assert.equal(store.round(roundId).state, "revealed", "結算完嘅 round 唔可以停在 closed 卡死下一輪");
  assert.equal(store.card(cardId).state, "revealed");
  assert.equal(store.state.ledger.filter((e) => !e.voided && e.reason.includes("潛伏成功")).length, 0, "一輪棄票唔可以派 +5");

  // 下一輪照開得（舊碼：W_ALREADY_STATE「仲有回合未完成」）
  const next = run(store, "saboteur.openRound");
  assert.equal(next.result.index, 2);
});

test("saboteur 全體棄票（兩輪）：第二輪完結 → finished，搗蛋鬼 +5 只頒一次", () => {
  const { store } = makeStore("sab-none-two");
  addPlayers(store, 5);
  run(store, "room.start");
  run(store, "saboteur.assign", { saboteurIndex: 0 });
  const r1 = run(store, "saboteur.openRound").result.roundId;
  run(store, "saboteur.closeRound", { roundId: r1 });
  const r2 = run(store, "saboteur.openRound").result.roundId;
  const t2 = run(store, "saboteur.closeRound", { roundId: r2 });

  assert.equal(t2.result.mode, "none");
  const st = store.state.room.gameState.saboteur;
  assert.equal(st.finished, true);
  assert.equal(st.revealedRole, "saboteur");
  assert.equal(st.rounds.filter((r) => r.state === "resolved" && r.decision === "none").length, 2);
  const sabFive = store.state.ledger.filter((e) => !e.voided && e.gameId === "saboteur" && e.reason.includes("潛伏成功"));
  assert.equal(sabFive.length, 1, "兩輪不成功 → +5 只頒一次");
  assert.equal(sabFive[0].delta, 5);
  assert.equal(store.playerScore(st.saboteurId), 5);
  // 之後手動完結／再開輪都唔會再派第二次
  assert.throws(() => run(store, "saboteur.finish"), isCmdError("W_ALREADY_STATE", /已經完結/));
  assert.throws(() => run(store, "saboteur.openRound"), isCmdError("W_ALREADY_STATE", /遊戲已完結/));
  assert.equal(store.state.ledger.filter((e) => !e.voided && e.reason.includes("潛伏成功")).length, 1);
});

test("saboteur：已結算嘅搗蛋鬼卡唔准 generic card.reopen／card.open（分數同 state 不變）", () => {
  const { store } = makeStore("sab-reopen");
  const players = addPlayers(store, 5);
  run(store, "room.start");
  run(store, "saboteur.assign", { saboteurIndex: 0 }); // p1 = 搗蛋鬼
  const roundId = run(store, "saboteur.openRound").result.roundId;
  const cardId = store.round(roundId).cardId;
  vote(store, { roundId, cardId, voterId: players[1].id, targetId: players[0].id });
  vote(store, { roundId, cardId, voterId: players[2].id, targetId: players[0].id });
  assert.equal(run(store, "saboteur.closeRound", { roundId }).result.mode, "eliminate");
  assert.equal(store.state.room.gameState.saboteur.caught, true);
  assert.equal(store.state.room.gameState.saboteur.finished, true);

  const stateBefore = JSON.parse(JSON.stringify(store.state.room.gameState.saboteur));
  const scoresBefore = players.map((p) => store.playerScore(p.id));
  const roundsBefore = store.state.room.rounds.length;
  const currentBefore = store.state.room.currentRoundId;

  assert.throws(() => run(store, "card.reopen", { cardId }), isCmdError("W_BAD_SCHEMA", /saboteur\.decide/));
  assert.throws(() => run(store, "card.open", { cardId }), isCmdError("W_BAD_SCHEMA", /saboteur\.openRound/));

  assert.deepEqual(store.state.room.gameState.saboteur, stateBefore, "被拒之後 saboteur state 唔可以變（caught／finished 仍然 true）");
  assert.deepEqual(players.map((p) => store.playerScore(p.id)), scoresBefore, "投票者 +3 唔可以被 reopen void 走");
  assert.equal(store.state.room.rounds.length, roundsBefore, "唔可以偷開一個未註冊嘅 saboteur round");
  assert.equal(store.state.room.currentRoundId, currentBefore);
  assert.equal(store.round(roundId).state, "revealed");
  assert.equal(store.card(cardId).state, "revealed");
  // 已結算嘅輪次再裁決一樣拒絕（唔會靜靜開一個未註冊 round）
  assert.throws(() => run(store, "saboteur.decide", { roundId, decision: "retry" }), isCmdError("W_ALREADY_STATE", /已裁決/));
  assert.equal(store.state.room.gameState.saboteur.rounds.length, 1);
});


/* ───────── codex 第四輪：finish 原子終結／generic reveal 繞過裁決 ───────── */

test("saboteur.finish 原子終結未結算輪次：之後 auto-close／card.close／saboteur.decide 都唔會再派分", () => {
  const { store } = makeStore("sab-finish-atomic");
  const players = addPlayers(store, 5);
  run(store, "room.start");
  run(store, "saboteur.assign", { saboteurIndex: 0 }); // p1 = 搗蛋鬼
  const roundId = run(store, "saboteur.openRound").result.roundId;
  const cardId = store.round(roundId).cardId;
  // 3 票投畀搗蛋鬼（過半）：finish 唔原子終結嘅話，之後 auto-close 會當場揪中再派投票者 +3
  for (const v of [players[1], players[2], players[3]]) vote(store, { roundId, cardId, voterId: v.id, targetId: players[0].id });

  const fin = run(store, "saboteur.finish");
  assert.equal(fin.result.finished, true);
  assert.equal(fin.result.caught, false);

  const st = store.state.room.gameState.saboteur;
  const rec = st.rounds.find((r) => r.roundId === roundId);
  assert.equal(rec.state, "resolved", "finish 要即刻終結未結算輪次");
  assert.equal(rec.decision, "none");
  assert.equal(rec.eliminatedId, null);
  assert.equal(st.finished, true);
  assert.equal(st.caught, false);
  assert.notEqual(store.round(roundId).state, "open", "finish 之後唔可以留低一個 open round 等 auto-close");
  assert.equal(store.card(cardId).state, "revealed");
  assert.equal(store.playerScore(players[0].id), 5, "finish 頒搗蛋鬼 +5");

  const scoresBefore = players.map((p) => store.playerScore(p.id));
  const stateBefore = JSON.parse(JSON.stringify(store.state.room.gameState.saboteur));

  // finish → auto-close：唔可以再結算、唔可以改 caught、唔可以派 +3
  store.commit([
    { t: "settings.set", d: { settings: { autoClose: true } } },
    { t: "round.update", d: { roundId, patch: { endsAt: Date.now() - 1 } } },
  ]);
  tickAutoClose(store);
  assert.equal(store.state.room.gameState.saboteur.caught, false, "finish 之後 auto-close 唔可以改 caught");
  assert.equal(store.state.ledger.filter((e) => !e.voided && e.reason.includes("揪中")).length, 0, "唔可以再派投票者 +3");

  // finish → card.close／card.tally：一律拒絕（round 已經 terminal）
  assert.throws(() => run(store, "card.close", { cardId }), isCmdError("W_ALREADY_STATE"));
  assert.throws(() => run(store, "card.tally", { cardId }), isCmdError("W_ALREADY_STATE"));
  // finish → saboteur.decide：拒絕，唔會改 caught，唔會派 +3
  assert.throws(() => run(store, "saboteur.decide", { roundId, decision: "eliminate", targetId: players[0].id }), isCmdError("W_ALREADY_STATE"));
  assert.throws(() => run(store, "saboteur.decide", { roundId, decision: "retry" }), isCmdError("W_ALREADY_STATE"));
  // finish → saboteur.closeRound：拒絕
  assert.throws(() => run(store, "saboteur.closeRound", { roundId }), isCmdError("W_ALREADY_STATE"));

  assert.deepEqual(store.state.room.gameState.saboteur, stateBefore, "被拒之後 saboteur state 完全唔變");
  assert.deepEqual(players.map((p) => store.playerScore(p.id)), scoresBefore, "finish 之後冇人可以再加分");
  assert.equal(store.state.ledger.filter((e) => !e.voided && e.reason.includes("潛伏成功")).length, 1, "+5 只頒一次");
});

test("saboteur：同票未裁決時 generic card.reveal 被拒，亦唔可以開下一輪；decide 之後先可以", () => {
  const { store } = makeStore("sab-reveal-guard");
  const players = addPlayers(store, 5);
  run(store, "room.start");
  run(store, "saboteur.assign", { saboteurIndex: 0 }); // p1 = 搗蛋鬼
  const roundId = run(store, "saboteur.openRound").result.roundId;
  const cardId = store.round(roundId).cardId;
  vote(store, { roundId, cardId, voterId: players[1].id, targetId: players[2].id });
  vote(store, { roundId, cardId, voterId: players[3].id, targetId: players[4].id });

  const tally = run(store, "saboteur.closeRound", { roundId });
  assert.equal(tally.result.mode, "decide", "1:1 同票 → 交主持裁決");
  const rec = store.state.room.gameState.saboteur.rounds.find((r) => r.roundId === roundId);
  assert.equal(rec.state, "closed");
  assert.equal(rec.decision, null);

  // (a) generic reveal 會把 round 變 revealed 但 record 仲 closed／decision:null → 要拒絕
  const roundStateBefore = store.round(roundId).state;
  const cardStateBefore = store.card(cardId).state;
  assert.throws(() => run(store, "card.reveal", { cardId }), isCmdError("W_ALREADY_STATE", /saboteur\.decide/));
  assert.equal(store.round(roundId).state, roundStateBefore, "被拒之後 round state 唔可以變");
  assert.equal(store.card(cardId).state, cardStateBefore, "被拒之後卡 state 唔可以變");
  assert.equal(store.state.room.gameState.saboteur.rounds.length, 1, "唔可以偷開第 2 輪");

  // (b) 就算 display state 已經 revealed（舊 bug 留低嘅 state），openRound 都要自己擋住
  store.commit([{ t: "round.update", d: { roundId, patch: { state: "revealed" } } }, { t: "card.update", d: { cardId, patch: { state: "revealed" } } }]);
  assert.throws(() => run(store, "saboteur.openRound"), isCmdError("W_ALREADY_STATE", /未裁決/));
  assert.equal(store.state.room.gameState.saboteur.rounds.length, 1, "未裁決就唔可以開下一輪（唔會跳到邏輯第 3 輪）");
  assert.equal(store.round(roundId).state, "revealed");

  // decide 之後：round 已結算，下一輪開得
  const decided = run(store, "saboteur.decide", { roundId, decision: "eliminate", targetId: players[2].id });
  assert.equal(decided.result.caught, false);
  assert.deepEqual(store.state.room.gameState.saboteur.eliminatedIds, [players[2].id]);
  const next = run(store, "saboteur.openRound");
  assert.equal(next.result.index, 2, "裁決完之後下一輪照開得");
});
test("saboteur：進行中嘅 round 被 rundown 轉關 void 咗（currentRoundId=null）→ 返嚟仲開得下一輪", () => {
  const { store } = makeStore("sab-void-abandon");
  addPlayers(store, 5);
  run(store, "room.start");
  run(store, "saboteur.assign", { saboteurIndex: 0 });
  const roundId = run(store, "saboteur.openRound").result.roundId;
  // advanceRundown 嘅行為：未完 round 一律 void ＋ currentRoundId=null（主持轉去第二關）
  store.commit([
    { t: "round.update", d: { roundId, patch: { state: "void" } } },
    { t: "round.current", d: { currentRoundId: null } },
  ]);
  const next = run(store, "saboteur.openRound");
  assert.equal(next.result.index, 2, "被 void 嘅輪次唔算「等裁決」，唔可以永遠擋住下一輪");
  assert.equal(store.round(next.result.roundId).state, "open");
});

/* ───────── codex 第五輪 #1：buffer 咗嘅歌 replay／resume 唔可以卡 preparing ───────── */

function mediaStore(tag) {
  const { store, dir } = makeStore(tag);
  addPlayers(store, 2);
  run(store, "room.start");
  store.commit([
    { t: "song.put", d: { song: { id: "song_1", index: 1, title: "測試歌", source: { kind: "file", fileName: "test-song.mp3" }, state: "ready" } } },
  ]);
  run(store, "lease.acquire");
  return { store, dir };
}

function patchPlayback(store, patch) {
  store.commit([{ t: "media.set", d: { playback: { ...store.state.playback, ...patch } } }]);
}

test("tickLeases：preparing + 過期 readyDeadline 會轉 failed（refresh 嘅理由）", () => {
  const { store } = mediaStore("media-ready-stale");
  run(store, "media.play", { songId: "song_1" });
  patchPlayback(store, { readyDeadline: Date.now() - 1 });
  assert.equal(tickLeases(store), true);
  assert.equal(store.state.playback.state, "failed");
});

test("media.resume 會刷新 readyDeadline：paused 好耐之後 resume 唔會俾 tick 判 failed", () => {
  const { store } = mediaStore("media-resume-deadline");
  run(store, "media.play", { songId: "song_1" });
  // deck ACK：preparing → playing（server 落 playStartedAt）
  patchPlayback(store, { state: "playing", playStartedAt: Date.now(), positionMs: 0 });
  run(store, "media.pause");
  // 真實情況：readyDeadline 仍然係 play 嗰刻算落嘅值，早已過期
  patchPlayback(store, { readyDeadline: Date.now() - 5_000 });
  assert.equal(store.state.playback.state, "paused");

  run(store, "media.resume");
  assert.equal(store.state.playback.state, "preparing");
  assert.ok(store.state.playback.readyDeadline > Date.now(), "resume 要重新起算 readyDeadline");
  // 下一個 lease tick 唔可以即刻轉 failed
  tickLeases(store);
  assert.equal(store.state.playback.state, "preparing", "resume 之後要等 deck ACK，唔係 failed");
});

test("media.play resume:true（同一首歌重播）readyDeadline 亦係新鮮嘅", () => {
  const { store } = mediaStore("media-replay-deadline");
  run(store, "media.play", { songId: "song_1" });
  patchPlayback(store, { state: "playing", playStartedAt: Date.now(), positionMs: 0 });
  run(store, "media.pause");
  patchPlayback(store, { readyDeadline: Date.now() - 5_000, positionMs: 3_000 });

  run(store, "media.play", { songId: "song_1", resume: true });
  assert.equal(store.state.playback.state, "preparing");
  assert.ok(store.state.playback.readyDeadline > Date.now());
  tickLeases(store);
  assert.notEqual(store.state.playback.state, "failed");
});

/* client 側（host.ts／stage.ts）冇 DOM 測試環境：用源碼證據鎖住修正位置同條件 */
function clientSrc(name) {
  return fs.readFileSync(path.resolve("src/client", name), "utf8");
}

test("host.ts：preparing 分支若 audio.readyState >= 3 即場 ACK（已 buffer 唔會再 fire canplaythrough）", () => {
  const src = clientSrc("host.ts");
  const idxPreparing = src.indexOf('if (pb.state === "preparing")');
  const idxAck = src.indexOf("if (a.readyState >= 3) onReady();");
  const idxPlaying = src.indexOf('if (pb.state === "playing")');
  assert.ok(idxPreparing >= 0 && idxAck > idxPreparing && idxAck < idxPlaying, "ACK 要喺 preparing 分支內、return 之前");
  assert.match(src, /const ackState = \{ sentKey: "" \};/, "ACK 只可以送一次（listener 之外再手動觸發；狀態要跨 render）");
  assert.match(src, /send: \(\) => sendDeckReady\(pb\)/, "canplaythrough 都要經同一道閘（真送得出才記 key）");
});

test("host.ts：render() 換 innerHTML 前後會保住主持打緊嘅表單值", () => {
  const src = clientSrc("host.ts");
  const idxRender = src.indexOf("function render(): void {");
  const idxSnap = src.indexOf("const formSnap = snapshotForm();");
  const idxBody = src.indexOf("${connBanner(status, v)}", idxRender);
  const idxRestore = src.indexOf("restoreForm(formSnap);");
  const idxBind = src.indexOf("bindDelegates();", idxBody);
  assert.ok(idxSnap > idxRender && idxSnap < idxBody, "snapshot 要喺主 innerHTML 之前");
  assert.ok(idxRestore > idxBody && idxRestore < idxBind, "restore 要喺主 innerHTML 之後、bind 之前");
  assert.match(src, /root\.addEventListener\("input", markDirty\)/, "要記低主持改過嘅欄");
  assert.match(src, /root\.addEventListener\("change", markDirty\)/, "select 改動都要記低");
});

test("stage.ts：100ms tick 唔會每次重設 toast timer（同一條 activity 只彈一次）", () => {
  const src = clientSrc("stage.ts");
  const start = src.indexOf("function paintTimers(): void {");
  const end = src.indexOf("function setStatus(");
  assert.ok(start >= 0 && end > start);
  const body = src.slice(start, end);
  assert.match(body, /paintToast\(view\.toast, view\.toastId\)/, "paintTimers 要經 dedup 入口（帶 activity id）");
  assert.ok(!/showToast\(view\.toast\)/.test(body), "paintTimers 唔可以直接 showToast");
  assert.match(src, /if \(key === lastToastId\) return;/, "同一條 activity 唔可以重設 timer");
  assert.match(src, /showToast\(t, 2600\)/, "大mon toast 要有 timeout（2.6 秒自動收）");
});

test("play.ts：舊 session／token 失效唔會留低紅色技術錯誤（要 refresh 先清嘅 bug）", () => {
  const src = clientSrc("play.ts");
  // onAuthFail 一定要清走兩個錯誤字
  const auth = src.slice(src.indexOf("onAuthFail: () => {"));
  const authBody = auth.slice(0, auth.indexOf("},"));
  assert.match(authBody, /submitError = ""/, "onAuthFail 要清 submitError");
  assert.match(authBody, /joinError = ""/, "onAuthFail 要清 joinError");
  // 協議內部錯誤唔可以當成玩家錯誤顯示
  assert.match(src, /code === "W_TOKEN_EXPIRED"/, "onError 要特別處理 W_TOKEN_EXPIRED");
  assert.match(src, /code === "W_ROOM_LOCKED"/, "onError 要特別處理 W_ROOM_LOCKED");
  // 每次新連線／新入場都要清
  assert.match(src, /function startLive\(\): void \{[\s\S]{0,400}?submitError = "";/, "startLive 要清 submitError");
  assert.match(src, /joinError = "";\s*\n\s*submitError = "";/, "入場成功要清 submitError");
  // 換房（QR 房碼唔同）唔可以重用舊 token
  assert.match(src, /saved\.roomCode !== qrCode/, "boot 要對比 QR 房碼同舊 token 房碼");
});

test("play.ts：手機版唔顯示 toast（唔會遮住底部分數條）", () => {
  const src = clientSrc("play.ts");
  assert.ok(!/showToast\(view\?\.toast\)/.test(src), "手機唔應該再 render server toast");
  assert.ok(!/\bshowToast\b/.test(src), "手機 client 唔應該再 import 或用 showToast");
});

/* client 行為測試：由 src/client/*.ts 抽出 // <client-block>x … // </client-block> 嘅純邏輯，
   type-strip 之後喺 node 跑（host.ts 冇 DOM 測試環境，但呢幾段唔需要 DOM）。 */
function clientBlock(name, file = "host.ts") {
  const src = clientSrc(file);
  const open = `// <client-block>${name}`;
  const start = src.indexOf(open);
  const end = src.indexOf("// </client-block>", start);
  assert.ok(start >= 0 && end > start, `src/client/${file} 要有 client-block「${name}」`);
  return src.slice(start + open.length, end);
}

function blockFactory(name, params = [], returns = []) {
  const js = ts.transpileModule(clientBlock(name), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return new Function(...params, `${js}\nreturn { ${returns.join(", ")} };`);
}

function fakeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  };
}

test("host.ts deckId：每個 tab 一條（同 browser 兩個 window 唔會撞）、reload 後保持同一條", () => {
  const makeTab = blockFactory("deck-id", ["sessionStorage", "localStorage"], ["ensureDeckId", "newDeckId"]);
  const sharedLocal = fakeStorage(); // 同一個 browser＝同一個 localStorage

  // 兩個 tab：sessionStorage 各自一份
  const sessionA = fakeStorage();
  const sessionB = fakeStorage();
  const docA = makeTab(sessionA, sharedLocal);
  const idA = docA.ensureDeckId();
  const idB = makeTab(sessionB, sharedLocal).ensureDeckId();
  assert.match(idA, /^deck_[a-z0-9]+$/);
  assert.notEqual(idA, idB, "兩個 host window 一定要唔同 deck ID（否則兩邊都當自己係 lease owner 雙重出聲）");
  assert.equal(docA.ensureDeckId(), idA, "同一 document 內要穩定");
  assert.equal(sessionA.getItem("hbd.deckId"), idA);

  // reload＝同一個 tab（同一個 sessionStorage）開一個新 document
  // 每個 document 一定用全新 ID：重用 sessionStorage 舊值會令複製 tab／遲到訊息期間有兩個 lease owner
  const reloaded = makeTab(sessionA, sharedLocal).ensureDeckId();
  assert.notEqual(reloaded, idA, "reload 後一定要換新 deck ID（唔可以重用，否則會雙重出聲）");
  assert.notEqual(makeTab(fakeStorage(), sharedLocal).ensureDeckId(), idA, "新 tab 唔可以沿用上一條 ID");

  // 舊版將 deck ID 存喺 localStorage：全 browser 共用 → 要當冇見過、仲要清走
  const legacyLocal = fakeStorage();
  legacyLocal.setItem("hbd.deckId", "deck_legacy");
  const legacyTabA = makeTab(fakeStorage(), legacyLocal).ensureDeckId();
  const legacyTabB = makeTab(fakeStorage(), legacyLocal).ensureDeckId();
  assert.notEqual(legacyTabA, "deck_legacy", "唔可以沿用 localStorage 嘅共用 ID");
  assert.notEqual(legacyTabA, legacyTabB, "舊版共用 ID 唔可以再令兩個 tab 撞");
  assert.equal(legacyLocal.map.has("hbd.deckId"), false, "舊 localStorage deck ID 要清走");

  // 唔可以再寫返 localStorage（共用就係 bug 本體）
  assert.equal(sharedLocal.map.has("hbd.deckId"), false, "deck ID 唔可以寫入 localStorage");
});

test("host.ts：同一個 lease 只有一條 deck ID 可以做 owner（兩個 window 唔會一齊出聲）", () => {
  const { isLeaseOwner } = blockFactory("lease-owner", [], ["isLeaseOwner"])();
  const lease = { deckId: "deck_tabA", hostId: "host_1", generation: 3, leaseUntil: 2_000 };
  assert.equal(isLeaseOwner(lease, "deck_tabA", 1_000), true, "deckId 對得上＝owner");
  assert.equal(isLeaseOwner(lease, "deck_tabB", 1_000), false, "同一 browser 第二個 window（唔同 deckId）唔可以出聲");
  assert.equal(isLeaseOwner({ ...lease, releasedAt: 900 }, "deck_tabA", 1_000), false, "lease 已放唔算 owner");
  assert.equal(isLeaseOwner(lease, "deck_tabA", 3_000), false, "lease 到期唔算 owner");
  assert.equal(isLeaseOwner(null, "deck_tabA", 1_000), false, "冇 lease 唔算 owner");
  assert.equal(isLeaseOwner(lease, "", 1_000), false, "未 generate deck ID 唔算 owner");

  const src = clientSrc("host.ts");
  assert.match(src, /const mine = isLeaseOwner\(lease, deckId, live\?\.serverNow\(\) \?\? Date\.now\(\)\);/, "syncDeck 要經 isLeaseOwner");
  assert.ok(!/lease\.hostId === hostId/.test(src), "唔可以用 lease.hostId 判 owner（reload 後重新 login 會誤判）");
});

test("host.ts：preparing ACK 以「一次 preparation attempt」為單位（同一次只送一個）", () => {
  const { prepAttemptKey } = blockFactory("ack-key", [], ["prepAttemptKey"])();
  const attempt1 = { songId: "song_1", positionMs: 0, readyDeadline: 1_000 };
  const attempt1Rerender = { songId: "song_1", positionMs: 0, readyDeadline: 1_000 };
  const attempt2 = { songId: "song_1", positionMs: 0, readyDeadline: 9_000 }; // replay／resume 換新 deadline
  assert.equal(prepAttemptKey(attempt1), prepAttemptKey(attempt1Rerender), "同一次 attempt 重複 render 要同一個 key");
  assert.notEqual(prepAttemptKey(attempt1), prepAttemptKey(attempt2), "新一次 attempt 要唔同 key（唔會永遠唔 ACK）");
  assert.equal(prepAttemptKey({ songId: "song_x" }), "song_x@0", "冇 readyDeadline 都要有穩定 key");

  const src = clientSrc("host.ts");
  assert.ok(!/let acked = false;/.test(src), "唔可以再用每個 render 都新開嘅局域 acked");
  assert.match(src, /const ackState = \{ sentKey: "" \};/, "ACK 狀態要喺 module 層（跨 render 有效）");
  assert.match(src, /if \(opts.state.sentKey === opts.ackKey\) return false;/, "同一 attempt 只送一個 ACK");
  assert.match(src, /ackListener = \(\) => a\.removeEventListener\("canplaythrough", onReady\);/, "要記低點樣拆 listener");
  assert.match(src, /\n\s+dropAckListener\(\);/, "每次 sync 先拆舊 listener，唔會愈積愈多");
  assert.ok(!/canplaythrough", onReady, \{ once: true \}/.test(src), "唔好留低 once listener 同手動觸發兩套語義");
});

test("host.ts：提交 action 只清同佢有關嘅 dirty 欄（題庫打緊字唔會俾分數掣清走）", () => {
  const { clearDirtyFor, actIdOf } = blockFactory("dirty-scope", [], ["clearDirtyFor", "actIdOf"])();
  assert.equal(actIdOf("quiz.save:q_1"), "quiz.save");
  assert.equal(actIdOf("score.add:p1:5"), "score.add");
  assert.equal(actIdOf("tab:quiz"), "tab");

  const dirty = new Set(["input|data-q-prompt=q_1", "input|data-q-category=q_1", "#score-delta", "#new-card-prompt", "#group-count"]);
  clearDirtyFor("quiz.save:q_1", dirty);
  assert.deepEqual(
    [...dirty].sort(),
    ["#group-count", "#new-card-prompt", "#score-delta"],
    "提交題目只可以清返題目欄（其他 tab 打緊嘅字要留住）",
  );
  clearDirtyFor("score.custom", dirty);
  assert.deepEqual([...dirty].sort(), ["#group-count", "#new-card-prompt"], "提交加分只可以清返加分欄");
  clearDirtyFor("score.add:p1:5", dirty);
  assert.equal(dirty.size, 2, "玩家 tab 嘅 +1 冇讀過表單 → 唔可以清任何欄");
  clearDirtyFor("stage.blackout:1", dirty);
  assert.equal(dirty.size, 2, "唔識嘅 action 一律唔清");

  const src = clientSrc("host.ts");
  assert.ok(!/dirtyForm\.clear\(\);/.test(src), "唔可以再一嘢清晒所有 dirty 欄");
  assert.match(src, /if \(!actFailed\) \{\n\s+clearDirtyFor\(act, dirtyForm,/, "提交成功先清相關欄");
  assert.match(src, /\(key\) => \(dirtyAt\.get\(key\) \?\? 0\) > requestStartedAt/, "請求期間新打嘅字唔可以清");
  assert.match(src, /actFailed = false;/, "每次 click 之前 reset 失敗旗");
  assert.match(src, /actFailed = true;/, "驗證／command 失敗要記低（唔清欄）");
});

test("host.ts：清一個 record 唔會清其他記錄嘅未存草稿（groups.assign／award.override 各自一條 ID）", () => {
  const { clearDirtyFor } = blockFactory("dirty-scope", [], ["clearDirtyFor"])();
  const dirty = new Set([
    "select|data-assign-g=p1|data-assign-mode=p1",
    "select|data-assign-g=p2|data-assign-mode=p2",
    "select|data-award-target=a1",
    "select|data-award-target=a2",
    "#group-count",
  ]);
  clearDirtyFor("groups.assign:p1", dirty);
  assert.deepEqual(
    [...dirty].sort(),
    [
      "#group-count",
      "select|data-assign-g=p2|data-assign-mode=p2",
      "select|data-award-target=a1",
      "select|data-award-target=a2",
    ].sort(),
    "搬 p1 只可以清 p1 嘅未存草稿（p2 打緊嘅字要留住）",
  );
  clearDirtyFor("award.override:a2", dirty);
  assert.deepEqual(
    [...dirty].sort(),
    ["#group-count", "select|data-assign-g=p2|data-assign-mode=p2", "select|data-award-target=a1"].sort(),
    "手動改 a2 只可以清 a2 嘅未存草稿（a1 要留住）",
  );
  clearDirtyFor("groups.assign", dirty); // 抽唔到 record id
  assert.equal(dirty.size, 3, "冇 record id 嘅提交一律唔清（寧願留住主持打緊嘅字）");
});

/* ── 第七輪 codex majors ── */

/** 假 BroadcastChannel 總線：同一個 name 嘅 channel 之間互通（唔會迴音畀自己）。
 *  delayMs：模擬被 suspend／busy 嘅 document——訊息遲 N ms 才送到（可以超過 150ms 應答窗）。 */
function fakeBus(delayMs = 0) {
  const chans = new Set();
  const deliver = (from, msg) => {
    if (delayMs > 0) {
      // 訊息排住隊，送到嗰刻才派（同真 BroadcastChannel 一樣：遲開嘅 channel 一樣收得到）
      setTimeout(() => {
        for (const c of chans) if (c !== from) c.onmessage?.({ data: msg });
      }, delayMs);
      return;
    }
    for (const c of chans) if (c !== from) queueMicrotask(() => c.onmessage?.({ data: msg }));
  };
  return {
    open(name) {
      const ch = {
        name,
        onmessage: null,
        postMessage: (msg) => deliver(ch, msg),
        close: () => void chans.delete(ch),
      };
      chans.add(ch);
      return ch;
    },
    size: () => chans.size,
  };
}

test("host.ts #1：複製 tab（sessionStorage 一齊複製 → 同一條 deck ID）會 rotate，舊 document 留住條 ID", async () => {
  const { claimDeckIdExclusive, deckClaimLoses } = blockFactory("deck-exclusive", [], [
    "claimDeckIdExclusive",
    "deckClaimLoses",
  ])();
  const bus = fakeBus();
  let seq = 0;
  const claim = (deckId, nonce, bornAt, session) =>
    claimDeckIdExclusive({
      deckId,
      nonce,
      bornAt,
      timeoutMs: 20,
      makeChannel: (name) => bus.open(name),
      newId: () => `deck_new${++seq}`,
      persist: (id) => session.setItem("hbd.deckId", id),
    });

  // 讓路規則：早開嘅贏；同時開就比 nonce（兩邊計出同一個結論）
  assert.equal(deckClaimLoses({ nonce: "a", bornAt: 1 }, { nonce: "b", bornAt: 2 }), false, "早開嘅唔讓");
  assert.equal(deckClaimLoses({ nonce: "b", bornAt: 2 }, { nonce: "a", bornAt: 1 }), true, "遲開嘅讓");
  assert.equal(deckClaimLoses({ nonce: "b", bornAt: 7 }, { nonce: "a", bornAt: 7 }), true, "同時開就比 nonce");
  assert.equal(deckClaimLoses({ nonce: "a", bornAt: 7 }, { nonce: "b", bornAt: 7 }), false);

  const session = fakeStorage();
  const solo = await claim("deck_other", "nonceZ", 1500, fakeStorage());
  assert.equal(solo.rotated, false, "獨立 tab（唔同 ID）唔會誤 rotate");
  assert.equal(solo.deckId, "deck_other");

  const a = await claim("deck_same", "nonceA", 1000, session);
  assert.equal(a.rotated, false, "冇人用同一條 ID：唔可以 rotate");
  const b = await claim("deck_same", "nonceB", 2000, session); // 遲開嘅複製 tab
  assert.equal(b.rotated, true, "同 ID 碰撞一定要 rotate");
  assert.equal(b.deckId, "deck_new1");
  assert.equal(session.getItem("hbd.deckId"), b.deckId, "rotate 之後要寫返 sessionStorage（reload 沿用）");
  assert.equal(a.deckId, "deck_same", "舊 document 要留住條 ID（唔可以令佢甩 lease）");

  // channel 留住：boot 完之後先開嘅複製 tab 一樣要 rotate
  const late = await claim("deck_same", "nonceC", 3000, fakeStorage());
  assert.equal(late.rotated, true, "boot 完之後仲要應遲到嘅複製 tab");

  // 同時 boot：兩邊計出同一個結論 → 只有一邊 rotate（唔會兩邊都讓／兩邊都唔讓）
  const r1 = await claim("deck_tie", "nonce1", 5000, fakeStorage());
  const r2 = await claim("deck_tie", "nonce2", 5000, fakeStorage());
  assert.equal([r1.rotated, r2.rotated].filter(Boolean).length, 1, "同時 boot 只可以有一邊 rotate");
  assert.notEqual(r1.deckId, r2.deckId, "rotate 之後兩邊一定唔同 ID");

  // reload：舊 document 已經拆咗（channel 關咗）→ 保持同一條 ID
  const reloadSession = fakeStorage();
  reloadSession.setItem("hbd.deckId", "deck_reload");
  const beforeReload = await claim("deck_reload", "old", 100, reloadSession);
  assert.equal(beforeReload.rotated, false);
  beforeReload.channel.close();
  const afterReload = await claim("deck_reload", "new", 900, reloadSession);
  assert.equal(afterReload.rotated, false, "reload（冇其他同 ID document）要保住同一條 ID");
  assert.equal(afterReload.deckId, "deck_reload");
  assert.equal(reloadSession.getItem("hbd.deckId"), "deck_reload");

  // 冇 BroadcastChannel（私密模式／舊瀏覽器）：照用，唔 rotate
  const noBc = await claimDeckIdExclusive({
    deckId: "deck_solo",
    nonce: "n",
    bornAt: 1,
    timeoutMs: 5,
    makeChannel: () => null,
    newId: () => assert.fail("冇 BroadcastChannel 唔應該 rotate"),
    persist: () => assert.fail("冇 rotate 唔應該寫 sessionStorage"),
  });
  assert.deepEqual({ deckId: noBc.deckId, rotated: noBc.rotated, channel: noBc.channel }, {
    deckId: "deck_solo",
    rotated: false,
    channel: null,
  });

  const src = clientSrc("host.ts");
  assert.match(src, /const DECK_CLAIM_TIMEOUT_MS = 150;/, "應答窗 150ms");
  assert.match(src, /async function boot\(\): Promise<void> \{\n  await ensureDeckIdExclusive\(\);/, "boot 要等獨佔檢查");
  assert.match(src, /new BC\(name\)/, "要用 BroadcastChannel 宣告");
  assert.match(src, /opts\.persist\(deck\);/, "rotate 之後要寫返 sessionStorage");
  assert.ok(!/localStorage\.setItem\(DECK_ID_KEY/.test(src), "deck ID 唔可以寫 localStorage（全 browser 共用）");
});

test("host.ts #1（第八輪）：遲 200ms 才送到嘅同 ID claim 一樣要 rotate（兩個 document 唔會同時當 lease owner）", async () => {
  const { claimDeckIdExclusive } = blockFactory("deck-exclusive", [], ["claimDeckIdExclusive"])();
  const bus = fakeBus(200); // 兩邊都被 suspend／忙：claim 遲 200ms 才送到，遠超 150ms 應答窗
  const sessionA = fakeStorage();
  const sessionB = fakeStorage();
  const late = [];
  const run = (session, nonce, bornAt) =>
    claimDeckIdExclusive({
      deckId: "deck_copied", // 複製 tab：兩個 document 讀到同一條 deck ID
      nonce,
      bornAt,
      timeoutMs: 20, // 縮短版應答窗；一樣細過 200ms 延遲
      makeChannel: (name) => bus.open(name),
      newId: () => `deck_fresh_${nonce}`,
      persist: (id) => session.setItem("hbd.deckId", id),
      onLateLoss: (id) => late.push({ nonce, id }),
    });

  // 兩邊真正同時開始（唔可以 sequential await：sequential 嘅話第一個已經應咗第二個）
  const [a, b] = await Promise.all([run(sessionA, "nonceA", 1000), run(sessionB, "nonceB", 2000)]);
  assert.deepEqual([a.deckId, b.deckId], ["deck_copied", "deck_copied"], "遲到嘅應答未到：兩邊都仲以為自己得");
  assert.equal(late.length, 0, "應答窗內冇衝突就唔可以 rotate");

  await new Promise((r) => setTimeout(r, 260)); // 遲 200ms 嘅 claim 送到（應答窗已經完）
  assert.deepEqual([...late], [{ nonce: "nonceB", id: "deck_fresh_nonceB" }], "遲開嘅一邊要讓（唔可以兩邊都留住同一條 ID 出聲）");
  assert.equal(sessionB.getItem("hbd.deckId"), "deck_fresh_nonceB", "rotate 之後要寫返 sessionStorage（reload 沿用）");
  assert.equal(sessionA.getItem("hbd.deckId"), null, "贏嘅 document 唔可以 rotate（唔可以令佢甩 lease）");

  await new Promise((r) => setTimeout(r, 300)); // 對方嘅 taken 再遲 200ms 送到：唔可以再 rotate 一次
  assert.equal(late.length, 1, "已經換咗新 ID：遲到嘅 taken 唔可以再 rotate");
  assert.equal(sessionB.getItem("hbd.deckId"), "deck_fresh_nonceB");
});

test("host.ts #1（第八輪）：boot 完之後嘅衝突長期有效（對方贏就讓、taken 指住自己都讓）", async () => {
  const { claimDeckIdExclusive } = blockFactory("deck-exclusive", [], ["claimDeckIdExclusive"])();
  const bus = fakeBus(); // 即時投遞：衝突喺 boot 完成之後才送
  const session = fakeStorage();
  const late = [];
  const doc = await claimDeckIdExclusive({
    deckId: "deck_lateX",
    nonce: "nonceX",
    bornAt: 1000,
    timeoutMs: 20,
    makeChannel: (name) => bus.open(name),
    newId: () => "deck_freshX",
    persist: (id) => session.setItem("hbd.deckId", id),
    onLateLoss: (id) => late.push(id),
  });
  assert.equal(doc.deckId, "deck_lateX");

  // 1) boot 之後才送到嘅 claim，而對方開得早過我 → 即刻讓路（唔可以就咁忽略）
  const older = bus.open("hbd.deck-claim");
  older.postMessage({ t: "claim", deckId: "deck_lateX", nonce: "older", bornAt: 1 });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(late, ["deck_freshX"], "boot 後 pending 已經係 null：遲到嘅衝突一樣要 rotate");
  assert.equal(session.getItem("hbd.deckId"), "deck_freshX", "rotate 之後要寫返 sessionStorage（reload 沿用）");

  // 2) 已經換咗新 ID：同舊 ID 有關嘅訊息唔可以再 rotate 一次
  older.postMessage({ t: "taken", deckId: "deck_lateX", nonce: "older", to: "nonceX" });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(late, ["deck_freshX"], "舊 ID 嘅遲到 taken 唔可以再 rotate");

  // 3) 遲到嘅 claim 但對方開得遲過我：我留住條 ID，答 taken 叫佢讓
  const newer = bus.open("hbd.deck-claim");
  const seen = [];
  newer.onmessage = (ev) => seen.push(ev.data);
  newer.postMessage({ t: "claim", deckId: "deck_freshX", nonce: "newer", bornAt: 99999 });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(late, ["deck_freshX"], "我開得早：唔可以讓");
  assert.deepEqual(seen.map((m) => m.t), ["taken"], "要答 taken 令對方一定 rotate");
  assert.equal(session.getItem("hbd.deckId"), "deck_freshX");

  const src = clientSrc("host.ts");
  const body = src.slice(src.indexOf("async function ensureDeckIdExclusive"), src.indexOf("async function boot"));
  assert.match(body, /onLateLoss: \(nextId: string\) => \{/, "boot 之後遲到嘅衝突要接（channel handler 長期有效）");
  assert.match(body, /if \(a && !a\.paused\) a\.pause\(\);/, "讓路要即刻收聲");
  assert.match(body, /ackState\.sentKey = "";/, "讓路要重設 ACK 狀態");
  assert.match(body, /live\?\.resync\(\);/, "讓路要叫 server 重發 snapshot（lease 畫面跟新 ID）");
  assert.ok(!/pending\?\.\(true\)/.test(src), "唔可以再只 settle pending（boot 之後 pending 已經係 null）");
});

test("host.ts #2：disconnect 期間 buffer 完成唔會白記 key，重連之後一定補送一個 ACK", () => {
  const { sendDeckReadyOnce, ackLink } = blockFactory("ack-gate", [], ["sendDeckReadyOnce", "ackLink"])();
  const state = { sentKey: "" };
  const attempt = "song_1@1000";
  let sent = 0;
  const push = () => {
    sent += 1;
    return true;
  };
  const offline = ackLink({ connected: false, ws: { readyState: 3 } });
  const online = ackLink({ connected: true, ws: { readyState: 1 } });

  // 離線時 canplaythrough fire（buffer 完成）：送唔出 → 唔可以記 key
  assert.equal(sendDeckReadyOnce({ state, ackKey: attempt, conn: offline, stillPreparing: true, send: push }), false);
  assert.equal(state.sentKey, "", "送唔出就唔可以記 ackSentKey（否則重連後永遠唔會再送）");
  assert.equal(sent, 0);

  // 未收到 hello.ok（ws 開咗但 connected=false）：一樣唔可以當送咗
  const wsOpenNoHello = ackLink({ connected: false, ws: { readyState: 1 } });
  assert.equal(sendDeckReadyOnce({ state, ackKey: attempt, conn: wsOpenNoHello, stillPreparing: true, send: push }), false);
  assert.equal(state.sentKey, "");

  // 重連（connected && ws.readyState === 1）：補送一個 ACK
  assert.equal(sendDeckReadyOnce({ state, ackKey: attempt, conn: online, stillPreparing: true, send: push }), true);
  assert.equal(sent, 1, "重連之後一定要補返個 ACK");
  assert.equal(state.sentKey, attempt);
  assert.equal(sendDeckReadyOnce({ state, ackKey: attempt, conn: online, stillPreparing: true, send: push }), false);
  assert.equal(sent, 1, "同一次 attempt 只送一個 ACK");

  // 新一次 attempt（replay／resume）：再送得
  assert.equal(sendDeckReadyOnce({ state, ackKey: "song_1@9000", conn: online, stillPreparing: true, send: push }), true);
  assert.equal(sent, 2);

  // server 已經唔再 preparing：唔送
  assert.equal(sendDeckReadyOnce({ state, ackKey: "song_1@12000", conn: online, stillPreparing: false, send: push }), false);
  assert.equal(sent, 2);

  // send 自己落空（ws 啱啱關）：都唔可以記 key，留住下次機會
  const flaky = { sentKey: "" };
  assert.equal(
    sendDeckReadyOnce({ state: flaky, ackKey: attempt, conn: online, stillPreparing: true, send: () => false }),
    false,
  );
  assert.equal(flaky.sentKey, "", "send 落空都唔可以記 key");

  // 冇 live／未有 socket
  assert.equal(ackLink(null), null);
  assert.equal(ackLink({ connected: true, ws: null }).readyState, 0);
  assert.equal(sendDeckReadyOnce({ state, ackKey: "song_1@30000", conn: ackLink(null), stillPreparing: true, send: push }), false);

  const src = clientSrc("host.ts");
  assert.match(src, /const ackState = \{ sentKey: "" \};/, "ACK 狀態要喺 module 層（跨 render）");
  assert.match(src, /if \(s === "connected"\) retryPendingAck\(\);/, "status 變 connected 要主動補送");
  assert.match(src, /live\.ws\?\.readyState|ackSendable\(ackLink\(live\)\)/, "要睇 ws.readyState 先送");
  assert.ok(!/ackSentKey = ackKey;\n\s+live\?\.send/.test(src), "唔可以先記 key 再 send");
});

test("host.ts #3：儲存 q_1 唔可以清走 q_2 嘅 dirty 保護（請求期間新打嘅字亦要留住）", () => {
  const { clearDirtyFor, keyHasRecord } = blockFactory("dirty-scope", [], ["clearDirtyFor", "keyHasRecord"])();

  const dirty = new Set([
    "input|data-q-prompt=q_1",
    "textarea|data-q-explanation=q_1",
    "input|data-q-opt=q_1:0",
    "input|data-q-prompt=q_2",
    "input|data-q-prompt=q_10",
    "#score-delta",
  ]);
  clearDirtyFor("quiz.save:q_1", dirty);
  assert.deepEqual(
    [...dirty].sort(),
    ["#score-delta", "input|data-q-prompt=q_10", "input|data-q-prompt=q_2"].sort(),
    "只可以清 q_1 嘅欄：q_2／q_10 打緊嘅字要留住（否則下次 render 還原 server 舊值）",
  );

  const rules = new Set(["input|data-r-title=p_1", "textarea|data-r-blocks=p_2"]);
  clearDirtyFor("rules.save:p_1:3", rules);
  assert.deepEqual([...rules], ["textarea|data-r-blocks=p_2"], "儲存 p_1 唔可以清走 p_2");

  const players = new Set(["input|data-num=p1", "input|data-name=p1", "select|data-group=p1", "input|data-name=p2"]);
  clearDirtyFor("player.rename:p1", players);
  assert.deepEqual(
    [...players].sort(),
    ["input|data-name=p2", "input|data-num=p1", "select|data-group=p1"].sort(),
    "改名只可以清 p1 嘅名（p1 嘅編號／分組 dropdown 同 p2 都要留住）",
  );

  const noRecord = new Set(["input|data-q-prompt=q_1"]);
  clearDirtyFor("quiz.save", noRecord);
  assert.equal(noRecord.size, 1, "抽唔到 record id：唔知清邊個 → 唔清");

  // 請求進行中主持新打嘅字：值同 request 開始時唔同 → 唔清
  const typed = new Set(["input|data-q-prompt=q_1", "input|data-q-hint=q_1"]);
  clearDirtyFor("quiz.save:q_1", typed, (key) => key.includes("data-q-prompt"));
  assert.deepEqual([...typed], ["input|data-q-prompt=q_1"], "請求期間新打嘅字唔可以清");

  assert.equal(keyHasRecord("input|data-q-opt=q_1:0", "q_1"), true, "q_1:0（選項）算 q_1");
  assert.equal(keyHasRecord("input|data-q-prompt=q_10", "q_1"), false, "q_10 唔可以當 q_1");
  assert.equal(keyHasRecord("#new-card-prompt", "q_1"), false, "冇 data-* 值嘅 key 唔算");

  const src = clientSrc("host.ts");
  assert.match(src, /const record = scope\.recordArg === null \? null : act\.split\(":"\)\[scope\.recordArg\] \|\| null;/, "record 由 act 抽");
  assert.match(src, /const requestStartedAt = Date\.now\(\);/, "撳掣一刻要記低時間（比對請求期間有冇新打字）");
  assert.match(src, /dirtyAt\.set\(key, Date\.now\(\)\);/, "每次 input／change 要記低時間");
});


/* ───────── 大mon 黑屏陷阱（blackout dead-end）／返 QR 掣 ───────── */

test("stage.set 由黑屏轉其他 mode 唔會再 W_STAGE_LOCKED，會真正離開黑屏", () => {
  const { store } = makeStore("stage-leave-blackout");
  run(store, "stage.set", { mode: "scoreboard" });
  run(store, "stage.blackout", { on: true });
  assert.equal(store.state.room.stage.mode, "blackout");

  const res = run(store, "stage.set", { mode: "idle" });
  assert.equal(res.ok, true, "blackout 期間 stage.set 要放行（唔再 W_STAGE_LOCKED）");
  assert.equal(store.state.room.stage.mode, "idle", "撳完要真正離開黑屏");
  assert.notEqual(store.state.room.stage.prevMode, "blackout", "prevMode 唔可以殘留 blackout");
});

test("黑屏期間 stage.set 去 question：一次過離開黑屏、payload 一齊換", () => {
  const { store } = makeStore("stage-leave-blackout-payload");
  run(store, "stage.blackout", { on: true });
  const res = run(store, "stage.set", { mode: "question", payload: { roundId: "r1" } });
  assert.equal(res.ok, true);
  assert.equal(store.state.room.stage.mode, "question");
  assert.equal(store.state.room.stage.payload.roundId, "r1");
});

test("連撳兩次黑屏：prevMode 唔會變 blackout，恢復畫面一定返到原本 mode", () => {
  const { store } = makeStore("stage-double-blackout");
  run(store, "stage.set", { mode: "scoreboard" });
  run(store, "stage.blackout", { on: true });
  assert.equal(store.state.room.stage.prevMode, "scoreboard");
  run(store, "stage.blackout", { on: true }); // 黑屏期間再撳黑屏
  assert.notEqual(store.state.room.stage.prevMode, "blackout", "第二次黑屏要保留原本恢復目標");
  assert.equal(store.state.room.stage.prevMode, "scoreboard");

  run(store, "stage.blackout", { on: false });
  assert.equal(store.state.room.stage.mode, "scoreboard", "恢復畫面要返到非黑屏嘅實際畫面");
});

test("黑屏前停喺規則頁：恢復畫面 fallback idle（唔會出空白規則頁）", () => {
  const { store } = makeStore("stage-blackout-rules");
  run(store, "room.start");
  run(store, "stage.rules", { on: true });
  assert.equal(store.state.room.stage.mode, "rules");
  run(store, "stage.blackout", { on: true });
  assert.equal(store.state.room.stage.prevMode, "idle", "rules 唔可以做恢復目標（payload 已經冇咗）");

  run(store, "stage.blackout", { on: false });
  assert.equal(store.state.room.stage.mode, "idle");
  assert.deepEqual(store.state.room.stage.payload, {}, "恢復之後唔可以留低空規則頁 payload");
});

test("host.ts：控制台有 primary「大mon 返 QR／入場頁」掣，撳完送 stage.set idle", () => {
  const src = clientSrc("host.ts");
  assert.match(
    src,
    /<button class="primary" data-act="stage\.qr">大mon 返 QR／入場頁/,
    "要有明確、primary 樣式嘅返 QR 掣（唔止係 mode 格仔）",
  );
  assert.match(src, /if \(sub === "qr"\) await cmd\("stage\.qr"\)/, "一撳要送 stage.qr（逃生門：大mon 鎖定時都撳得）");
  const idxQuick = src.indexOf('data-act="stage.qr"');
  const idxGroups = src.indexOf('<div class="mode-groups">');
  assert.ok(idxQuick >= 0 && idxQuick < idxGroups, "掣要放喺流程／畫面區頂部（mode 格仔之上）");
});

test("stage.ts＋app.css：黑屏真係全黑（唔 render ticker、CSS 亦攔截）", () => {
  const src = clientSrc("stage.ts");
  assert.match(src, /classList\.toggle\(\s*"is-blackout",\s*v\?\.stage\?\.mode === "blackout"\)/, "黑屏要標記 body，俾 CSS 攔截浮層");
  const start = src.indexOf('v.stage?.mode === "blackout"');
  const end = src.indexOf("} else {", start);
  assert.ok(start >= 0 && end > start);
  const branch = src.slice(start, end);
  assert.ok(!/scoreBar\(/.test(branch), "黑屏分支唔可以 render 分數條／ticker");
  assert.ok(!/class="ticker"/.test(branch), "黑屏分支唔可以出 ticker 節點");
  assert.ok(!/[（(]黑屏[）)]/.test(branch), "黑屏分支唔好再印字（要真係黑）");

  const css = fs.readFileSync(path.resolve("public/app.css"), "utf8");
  assert.match(css, /body\.is-blackout \.ticker[^{]*\{[^}]*display: none/, "黑屏期間 ticker 一定要隱藏");
});

/* ───────── checker 覆核 F1／F2／F3／F5 ───────── */

test("F1：黑屏中 stage.set{mode:'rules'} 一樣 423（同 stage.rules 一致），QR 逃生門唔受影響", () => {
  const { store } = makeStore("f1-blackout-rules");
  run(store, "room.start");
  run(store, "stage.blackout", { on: true });
  assert.throws(() => run(store, "stage.set", { mode: "rules" }), isCmdError("W_STAGE_LOCKED", /blackout 期間唔准出規則頁/));
  assert.equal(store.state.room.stage.mode, "blackout", "被拒之後要仍然係黑屏");
  assert.throws(() => run(store, "stage.rules", { on: true }), isCmdError("W_STAGE_LOCKED"));

  const res = run(store, "stage.set", { mode: "idle" });
  assert.equal(res.ok, true, "其他 mode 照樣放行（逃生門）");
  assert.equal(store.state.room.stage.mode, "idle");
});

function putRundownItem(store, item) {
  store.commit([{ t: "rundown.set", d: { rundown: [item], currentItemId: item.id, phase: "playing" } }]);
}

test("F2：stage.set{mode:'rules'} 會砌齊規則頁 payload（同 stage.rules 一致，唔會出假頁）", () => {
  const { store } = makeStore("f2-rules-payload");
  run(store, "room.start");
  putRundownItem(store, { id: "rd_1", index: 0, gameId: "quiz", title: "第 1 關", state: "todo", cardIds: [], rulesText: "規矩內容" });

  run(store, "stage.set", { mode: "rules" });
  const viaSet = { ...store.state.room.stage.payload };
  assert.equal(viaSet.itemId, "rd_1", "要有 itemId（stage.page／上一頁下一頁靠佢）");
  assert.equal(viaSet.title, "第 1 關");
  assert.equal(viaSet.rulesText, "規矩內容", "冇 rulesText 就會出「主持未設定呢關規則」假頁");
  assert.equal(viaSet.gameId, "quiz");
  assert.equal(viaSet.fallback, true);

  run(store, "stage.set", { mode: "idle" });
  run(store, "stage.rules", { on: true });
  const viaRules = { ...store.state.room.stage.payload };
  assert.deepEqual(viaSet, viaRules, "兩條路徑砌出嚟嘅 payload 要一樣");
});

test("F3：非黑屏時撳「恢復畫面」係 no-op（唔會跳去 prevMode）", () => {
  const { store } = makeStore("f3-restore-noop");
  run(store, "stage.set", { mode: "scoreboard" });
  run(store, "stage.set", { mode: "question" });
  assert.equal(store.state.room.stage.prevMode, "scoreboard");

  const res = run(store, "stage.blackout", { on: false });
  assert.equal(res.ok, true, "no-op 都要回 ok");
  assert.equal(store.state.room.stage.mode, "question", "非黑屏時唔可以跳去 prevMode");
  assert.equal(store.state.room.stage.prevMode, "scoreboard", "state 完全唔應該變");
});

test("F5：黑屏分支連斷線 banner 都唔 render（非黑屏照舊有）", () => {
  const src = clientSrc("stage.ts");
  assert.match(
    src,
    /root\.innerHTML = html \+ \(v\?\.stage\?\.mode === "blackout" \? "" : connBanner\(status, v\)\)/,
    "黑屏時要吞咗 conn banner",
  );
  assert.match(src, /function connBanner|connBanner\(status, v\)/, "非黑屏仍然要有 banner 路徑");
});

/* ───────── auditor A：規則頁「預覽上大mon」出錯頁 ───────── */

function rulePageFixture(id, gameId, order, heading, extra = {}) {
  return {
    id,
    gameId,
    title: "頁 " + id,
    blocks: [{ id: id + "-b1", type: "heading", text: heading }],
    order,
    enabled: true,
    autoAdvanceSeconds: 0,
    updatedAt: 0,
    version: 1,
    updatedBy: "test",
    ...extra,
  };
}

test("A：預覽唔屬於 currentItem 嘅規則頁 → 大mon view.rulePage 要係揀中嗰頁", () => {
  const { store } = makeStore("preview-rule-page");
  const pageA = rulePageFixture("rp_quiz", "quiz", 0, "A 頁：問答規則");
  const pageB = rulePageFixture("rp_auction", "auction", 1, "B 頁：拍賣規則");
  store.commit([{ t: "rules.set", d: { rulePages: [pageA, pageB] } }]);
  const item = { id: "rd_quiz", index: 0, gameId: "quiz", title: "問答關", state: "todo", cardIds: [], rulesText: "" };
  store.commit([{ t: "rundown.set", d: { rundown: [item], currentItemId: item.id, phase: "playing" } }]);

  // 對照：冇指定頁 → 由 currentItem（quiz）推 A 頁
  run(store, "stage.rules", { on: true });
  assert.equal(buildStageView(store).rulePage?.id, "rp_quiz", "冇指定時照舊用 currentItem 嗰關嘅頁");

  // 主持人喺 host 揀 B 頁預覽（B 唔屬於 currentItem 嘅 gameId）
  run(store, "stage.set", { mode: "rules", payload: { rulePageId: "rp_auction" } });
  const view = buildStageView(store);
  assert.equal(view.rulePage?.id, "rp_auction", "大mon 要出主持揀中嗰頁，唔係 currentItem 嗰頁");
  assert.match(JSON.stringify(view.rulePage?.blocks ?? []), /B 頁：拍賣規則/);
});

test("A 邊界：揀中嘅頁 disabled／archived → 照舊 fallback currentItem 嗰頁", () => {
  const { store } = makeStore("preview-rule-page-guard");
  const pageA = rulePageFixture("rp_quiz", "quiz", 0, "A 頁");
  const archivedB = rulePageFixture("rp_auction", "auction", 1, "B 頁", { archived: true });
  const disabledB = rulePageFixture("rp_off", "auction", 2, "B2 頁", { enabled: false });
  store.commit([{ t: "rules.set", d: { rulePages: [pageA, archivedB, disabledB] } }]);
  const item = { id: "rd_quiz", index: 0, gameId: "quiz", title: "問答關", state: "todo", cardIds: [], rulesText: "" };
  store.commit([{ t: "rundown.set", d: { rundown: [item], currentItemId: item.id, phase: "playing" } }]);

  run(store, "stage.set", { mode: "rules", payload: { rulePageId: "rp_auction" } });
  assert.equal(buildStageView(store).rulePage?.id, "rp_quiz", "archived 頁唔可以上大mon");
  run(store, "stage.set", { mode: "rules", payload: { rulePageId: "rp_off" } });
  assert.equal(buildStageView(store).rulePage?.id, "rp_quiz", "disabled 頁唔可以上大mon");
});


test("undercover.start：建卡＋round＋大mon 轉 undercover，exclude 唔止影響候選（亦唔可以投）", () => {
  const { store } = makeStore("uc-start");
  const players = addPlayers(store, 3);
  run(store, "room.start");
  const res = run(store, "undercover.start", { excludePlayerIds: [players[2].id], durationSeconds: 10 });
  assert.equal(res.ok, true);
  const round = store.round(res.result.roundId);
  assert.equal(round.state, "open");
  const card = store.card(round.cardId);
  assert.equal(card.voteMode, "players");
  assert.equal(card.gameId, "draw");
  assert.deepEqual(card.options, [players[0].id, players[1].id], "被 exclude 嘅唔可以做候選");
  // v0.4.0 fix：選民＝候選（舊版用晒全部 approved，被剔走嘅人都投得）
  assert.deepEqual(round.eligiblePlayerIds, [players[0].id, players[1].id], "被 exclude 嘅唔可以投票");
  assert.equal(store.state.room.stage.mode, "undercover");
});

test("undercover.start：duration clamp 5–60 秒", () => {
  const { store } = makeStore("uc-clamp");
  addPlayers(store, 2);
  run(store, "room.start");
  const low = run(store, "undercover.start", { durationSeconds: 1 });
  assert.equal(store.card(store.round(low.result.roundId).cardId).seconds, 5);
  run(store, "undercover.reveal");
  const high = run(store, "undercover.start", { durationSeconds: 999 });
  assert.equal(store.card(store.round(high.result.roundId).cardId).seconds, 60);
});

test("undercover：tickUndercover 到時自動開票，票數同 ballots 正確", () => {
  const { store } = makeStore("uc-tick");
  const players = addPlayers(store, 3);
  run(store, "room.start");
  const res = run(store, "undercover.start", { excludePlayerIds: [players[2].id], durationSeconds: 10 });
  const roundId = res.result.roundId;
  const cardId = store.round(roundId).cardId;
  // v0.4.0：被 exclude 嘅人唔喺選民名單（唔可以投），所以只有兩個選民投票
  vote(store, { roundId, cardId, voterId: players[0].id, targetId: players[1].id });
  vote(store, { roundId, cardId, voterId: players[1].id, targetId: players[0].id });
  store.commit([{ t: "round.update", d: { roundId, patch: { endsAt: Date.now() - 1 } } }]);
  assert.equal(tickUndercover(store), true);
  assert.equal(store.round(roundId).state, "revealed");
  const view = buildStageView(store);
  assert.equal(view.undercover.phase, "result");
  const counts = Object.fromEntries(view.undercover.candidates.map((c) => [c.id, c.count]));
  assert.equal(counts[players[0].id], 1);
  assert.equal(counts[players[1].id], 1);
  assert.equal(view.undercover.ballots.length, 2, "票軌只列選民（被剔走者唔喺名單）");
  const byVoter = Object.fromEntries(view.undercover.ballots.map((b) => [b.voterId, b.targetName]));
  assert.equal(byVoter[players[0].id], players[1].name);
  assert.equal(byVoter[players[1].id], players[0].name);
  assert.equal(byVoter[players[2].id], undefined);
});

test("undercover.reveal：提早開票", () => {
  const { store } = makeStore("uc-reveal");
  const players = addPlayers(store, 2);
  run(store, "room.start");
  const res = run(store, "undercover.start", { durationSeconds: 60 });
  const roundId = res.result.roundId;
  vote(store, { roundId, cardId: store.round(roundId).cardId, voterId: players[0].id, targetId: players[1].id });
  assert.equal(run(store, "undercover.reveal").ok, true);
  assert.equal(store.round(roundId).state, "revealed");
  assert.equal(buildStageView(store).undercover.phase, "result");
});


test("undercover：generic 收卷／切分佈都要開票（唔可以留 closed／tally）", () => {
  const { store } = makeStore("uc-generic-close");
  const players = addPlayers(store, 2);
  run(store, "room.start");
  const a = run(store, "undercover.start", { durationSeconds: 60 });
  assert.equal(run(store, "card.close").ok, true);
  assert.equal(store.round(a.result.roundId).state, "revealed");
  assert.equal(buildStageView(store).undercover.phase, "result");
  const b = run(store, "undercover.start", { durationSeconds: 60 });
  assert.equal(run(store, "card.tally").ok, true);
  assert.equal(store.round(b.result.roundId).state, "revealed");
  // closed 狀態嘅 undercover round（例如由舊版 restore）撳切分佈都要開票，唔可以卡死
  const c = run(store, "undercover.start", { durationSeconds: 60 });
  store.commit([{ t: "round.update", d: { roundId: c.result.roundId, patch: { state: "closed" } } }]);
  assert.equal(run(store, "card.tally").ok, true);
  assert.equal(store.round(c.result.roundId).state, "revealed");
  void players;
});

test("undercover：轉關會清走 revealed round（唔會殘留下一關）", () => {
  const { store } = makeStore("uc-advance");
  addPlayers(store, 2);
  store.commit([{ t: "rundown.set", d: { rundown: [
    { id: "rd_draw", index: 0, gameId: "draw", title: "第 1 關・畫畫", state: "running", cardIds: [] },
    { id: "rd_auction", index: 1, gameId: "auction", title: "第 2 關・估歌", state: "todo", cardIds: [] },
  ], currentItemId: "rd_draw", phase: "playing" } }]);
  const res = run(store, "undercover.start", { durationSeconds: 60 });
  run(store, "undercover.reveal");
  assert.equal(store.round(res.result.roundId).state, "revealed");
  run(store, "rundown.next");
  assert.equal(store.state.room.currentRoundId, null, "轉關要清 currentRoundId");
  assert.equal(buildStageView(store).undercover, null);
});


test("undercover.start：卡會登記入當前 item.cardIds（唔會 orphan）", () => {
  const { store } = makeStore("uc-cardids");
  addPlayers(store, 2);
  store.commit([{ t: "rundown.set", d: { rundown: [
    { id: "rd_draw", index: 0, gameId: "draw", title: "第 1 關・畫畫", state: "running", cardIds: [] },
  ], currentItemId: "rd_draw", phase: "playing" } }]);
  const res = run(store, "undercover.start", { durationSeconds: 10 });
  const item = store.state.room.rundown.find((i) => i.id === "rd_draw");
  assert.ok(item.cardIds.includes(res.result.cardId), "undercover card 要入 item.cardIds");
});

test("rundown.reorder：ids 唔完整／重複／有未知 id 一律拒", () => {
  const { store } = makeStore("rd-validate");
  store.commit([{ t: "rundown.set", d: { rundown: [
    { id: "rd_draw", index: 0, gameId: "draw", title: "第 1 關・畫畫", state: "running", cardIds: [] },
    { id: "rd_auction", index: 1, gameId: "auction", title: "第 2 關・估歌", state: "todo", cardIds: [] },
  ], currentItemId: "rd_draw", phase: "playing" } }]);
  assert.throws(() => run(store, "rundown.reorder", { ids: ["nope", "nope2"] }), isCmdError("W_BAD_SCHEMA"));
  assert.throws(() => run(store, "rundown.reorder", { ids: ["rd_quiz"] }), isCmdError("W_BAD_SCHEMA"));
  assert.throws(() => run(store, "rundown.reorder", { ids: ["rd_draw", "rd_draw"] }), isCmdError("W_BAD_SCHEMA"));
  assert.equal(run(store, "rundown.reorder", { ids: ["rd_auction", "rd_draw"] }).ok, true);
  assert.deepEqual(store.state.room.rundown.map((i) => i.id), ["rd_auction", "rd_draw"]);
});


/* ───────── v0.3.0 階段 1：題庫／一圖多人題目／四頁規則（逐字 deepEqual） ───────── */

const APP_ROOT = path.resolve(import.meta.dirname, "..");

test("v0.3 題庫：13 題・id q1..q13・MC 4 個選項冇 A. 前綴・30 秒", () => {
  const qs = loadQuizSeed(APP_ROOT);
  assert.equal(qs.length, 13);
  assert.deepEqual(qs.map((q) => q.id), ["q1","q2","q3","q4","q5","q6","q7","q8","q9","q10","q11","q12","q13"]);
  for (const q of qs) {
    assert.equal(q.seconds, 30, `${q.id} 要 30 秒`);
    assert.ok(q.prompt.length > 0, `${q.id} 要有題目`);
  }
  const mc = qs.filter((q) => q.type === "choice");
  assert.equal(mc.length, 11, "Q1–Q11 係 MC");
  for (const q of mc) {
    assert.equal(q.options.length, 4, `${q.id} 要 4 個選項`);
    for (const o of q.options) assert.doesNotMatch(o, /^[A-D][.．、]/, `${q.id} 選項唔應該有前綴：${o}`);
    assert.ok(Number.isInteger(q.correct) && q.correct >= 0 && q.correct < 4, `${q.id} correct index`);
    assert.equal(q.points, 1);
  }
  assert.deepEqual(qs.map((q) => q.correct), [0,1,1,1,3,3,3,2,3,0,2,undefined,undefined]);
});

test("v0.3 題庫：Q12 容差 ±2、actualAnswer 40；Q13 冇 actualAnswer", () => {
  const qs = loadQuizSeed(APP_ROOT);
  const q12 = qs.find((q) => q.id === "q12");
  assert.equal(q12.type, "open");
  assert.equal(q12.openKind, "number");
  assert.equal(q12.tolerance, 2);
  assert.equal(q12.actualAnswer, 40);
  assert.equal(q12.points, 2);
  const q13 = qs.find((q) => q.id === "q13");
  assert.equal(q13.type, "open");
  assert.equal(q13.openKind, "number");
  assert.equal(q13.actualAnswer, undefined);
  assert.equal(q13.tolerance, 0, "Q13 主持即場輸入，容差 0＝完全相等");
  assert.equal(q13.points, 2);
  assert.equal(q13.explanation, "即時開電話check");
  // Q4 參考圖暫時留空（原檔攞唔到）
  assert.equal(qs.find((q) => q.id === "q4").imageUrl, undefined);
});

test("v0.3 題庫：questionToCard 會 copy tolerance／imageUrl", () => {
  const c = questionToCard({ id: "qx", type: "open", category: "t", prompt: "p", openKind: "number", seconds: 30, points: 2, tolerance: 2, imageUrl: "/media/x.png" });
  assert.equal(c.tolerance, 2);
  assert.equal(c.imageUrl, "/media/x.png");
});

test("v0.3 一圖多人：7 對題目逐字 deepEqual", () => {
  const topics = loadUndercoverSeed(APP_ROOT);
  assert.deepEqual(topics, [
    { id: "uc1", prompt: "同翹妹去迪士尼", undercoverPrompt: "翹妹" },
    { id: "uc2", prompt: "係麥當勞搞生日party", undercoverPrompt: "麥當勞" },
    { id: "uc3", prompt: "Hollye 食譚仔", undercoverPrompt: "Hollye" },
    { id: "uc4", prompt: "海邊賞月", undercoverPrompt: "賞月" },
    { id: "uc5", prompt: "哥斯拉同金剛係沙漠結婚", undercoverPrompt: "哥斯拉" },
    { id: "uc6", prompt: "係浴室開住花灑舉啞鈴", undercoverPrompt: "舉啞鈴" },
    { id: "uc7", prompt: "300磅肥仔被卷入黑洞", undercoverPrompt: "黑洞" },
  ]);
});

test("v0.3 規則頁：四頁（draw／auction／killer／quiz），舊 saboteur 頁冇咗，長度限制合格", () => {
  const pages = loadRulePagesSeed(APP_ROOT);
  assert.deepEqual(pages.map((p) => p.gameId), ["draw", "auction", "killer", "quiz"]);
  assert.equal(pages.some((p) => p.gameId === "saboteur"), false);
  for (const p of pages) {
    assert.ok(p.title.length <= 16, `${p.id} title ≤16`);
    assert.ok((p.subtitle ?? "").length <= 24, `${p.id} subtitle ≤24`);
    assert.ok(p.blocks.length > 0 && p.blocks.length <= 20);
    let total = 0;
    for (const b of p.blocks) {
      const t = (b.text ?? "").length + (b.value ?? "").length;
      assert.ok(t <= 120, `${p.id}/${b.id} block ≤120 字`);
      total += t;
      for (const it of b.items ?? []) {
        assert.ok(it.length <= 120, `${p.id}/${b.id} item ≤120 字`);
        total += it.length;
      }
    }
    assert.ok(total <= 1200, `${p.id} 全頁 ≤1200 字`);
  }
});

test("v0.3 bootstrap：預設 4 關次序 draw→auction→killer→quiz，7 張臥底題卡入 rundown", () => {
  const rundown = defaultRundown(["q1"], ["uc_uc1"]);
  assert.deepEqual(rundown.map((r) => r.gameId), ["draw", "auction", "killer", "quiz"]);
  assert.match(rundown[0].title, /^第 1 關・/);
  assert.deepEqual(rundown[0].cardIds, ["uc_uc1"]);
  const muts = bootstrapMutations(APP_ROOT, "room_x", "1234", "hash", true);
  const allPut = muts.filter((m) => m.t === "card.put");
  const put = allPut.filter((m) => m.d.card.gameId === "draw");
  assert.equal(put.length, 7, "7 對題目 → 7 張卡");
  for (const m of put) {
    assert.equal(m.d.card.gameId, "draw");
    assert.equal(m.d.card.type, "open");
    assert.equal(m.d.card.state, "draft");
    assert.equal(m.d.card.seconds, null);
    assert.equal(m.d.card.points, 0);
    assert.ok(m.d.card.prompt && m.d.card.undercoverPrompt);
  }
  const sets = muts.find((m) => m.t === "settings.set");
  assert.equal(sets.d.settings.maxBid, 10, "競投上限預設 10 秒");
});


/* ───────── v0.3.0 階段 2：一圖多人（畫畫臥底）完整局 ───────── */

function ucSetup(tag, n = 6) {
  const { store } = makeStore(tag);
  const players = addPlayers(store, n);
  for (const t of loadUndercoverSeed(APP_ROOT)) store.commit([{ t: "card.put", d: { card: undercoverTopicToCard(t) } }]);
  run(store, "room.start");
  return { store, players };
}

/** B4：依正常流程 foul 一個人（開投票 → 收卷 → 淘汰） */
function ucFoul(store, playerId) {
  const cur = store.currentRound();
  if (!cur || cur.state !== "open") run(store, "uc.vote.start");
  run(store, "card.close");
  return run(store, "uc.eliminate", { playerId });
}

function hostOver(store) {
  return buildHostView(store, "host_test", "測試主持", { hosts: 1, stages: 0, players: 0, total: 1 });
}

test("uc.match.start：抽 2 個臥底（唔重複）＋3 對題（唔重複）＋questionNo=0", () => {
  const { store, players } = ucSetup("ucm-start");
  const res = run(store, "uc.match.start");
  assert.equal(res.ok, true);
  const st = store.state.room.gameState.undercover;
  assert.equal(st.matchNo, 1);
  assert.equal(st.undercoverIds.length, 2);
  assert.equal(new Set(st.undercoverIds).size, 2, "兩個臥底一定唔同人");
  assert.equal(st.participantIds.length, players.length);
  assert.equal(st.topicIds.length, 3);
  assert.equal(new Set(st.topicIds).size, 3, "3 對題唔可以重複");
  assert.equal(st.questionNo, 0);
  assert.equal(st.promptCardId, st.topicIds[0]);
  assert.equal(st.settled, false);
  // 主持見到身份、玩家／大mon 見唔到
  assert.equal(hostOver(store).undercoverMatch.undercoverIds.length, 2);
  const stageJson = JSON.stringify(buildStageView(store));
  const playerJson = JSON.stringify(buildPlayerView(store, players[0].id));
  for (const j of [stageJson, playerJson]) {
    assert.equal(j.includes("undercoverIds"), false, "唔准漏臥底名單");
    assert.equal(j.includes("undercoverPrompt"), false, "唔准漏臥底題");
  }
});

test("uc.match.redraw：只換臥底，其他 state 不變", () => {
  const { store } = ucSetup("ucm-redraw");
  run(store, "uc.match.start");
  const before = JSON.parse(JSON.stringify(store.state.room.gameState.undercover));
  let same = true;
  for (let i = 0; i < 8 && same; i += 1) {
    run(store, "uc.match.redraw");
    const st = store.state.room.gameState.undercover;
    same = st.undercoverIds.join(",") === before.undercoverIds.join(",");
    if (!same) {
      assert.equal(new Set(st.undercoverIds).size, 2);
      assert.equal(st.matchNo, before.matchNo);
      assert.deepEqual(st.topicIds, before.topicIds);
      assert.deepEqual(st.eliminatedIds, []);
      assert.equal(st.questionNo, 0);
    }
  }
});

test("uc.prompt.reveal：大mon 出好人題目（message mode），玩家手機見唔到題目", () => {
  const { store, players } = ucSetup("ucm-reveal");
  run(store, "uc.match.start");
  const res = run(store, "uc.prompt.reveal");
  const st = store.state.room.gameState.undercover;
  assert.equal(st.promptRevealed, true);
  const sv = buildStageView(store);
  assert.equal(sv.stage.mode, "message");
  assert.equal(sv.message.title, "好人題目");
  const card = store.card(st.promptCardId);
  assert.deepEqual(sv.message.lines, [card.prompt]);
  // 玩家 DTO 冇題目內容
  const pj = JSON.stringify(buildPlayerView(store, players[0].id));
  assert.equal(pj.includes(card.prompt), false);
});

test("uc.vote.start：候選＝未出局參賽者，出局者唔喺 eligible（唔可以投亦唔可以被投）", () => {
  const { store } = ucSetup("ucm-vote");
  run(store, "uc.match.start");
  run(store, "uc.prompt.reveal");
  const st0 = store.state.room.gameState.undercover;
  const victim = st0.participantIds.find((id) => !st0.undercoverIds.includes(id));
  ucFoul(store, victim);
  const res = run(store, "uc.vote.start");
  const round = store.round(res.result.roundId);
  assert.equal(round.eligiblePlayerIds.includes(victim), false, "出局者唔可以投");
  const card = store.card(round.cardId);
  assert.equal(card.options.includes(victim), false, "出局者唔可以被投");
  assert.equal(card.options.length, st0.participantIds.length - 1);
  assert.equal(round.state, "open");
  assert.ok(round.endsAt - Date.now() <= 10_000);
  // 重用同一張卡（唔會每次開新卡）
  run(store, "card.close");
  const res2 = run(store, "uc.vote.start");
  assert.equal(store.round(res2.result.roundId).cardId, round.cardId, "要重用同一張投票卡");
  assert.equal(store.state.cards.filter((c) => c.id === "card_ucmatch").length, 1);
});

test("uc.eliminate：大mon 即刻講中／唔中；uc.eliminate.undo 還原", () => {
  const { store } = ucSetup("ucm-elim");
  run(store, "uc.match.start");
  const st0 = store.state.room.gameState.undercover;
  const [uc1] = st0.undercoverIds;
  let res = ucFoul(store, uc1);
  assert.equal(res.result.wasUndercover, true);
  let sv = buildStageView(store);
  assert.equal(sv.stage.mode, "message");
  assert.equal(sv.message.title, "係臥底！");
  assert.equal(sv.message.tone, "good");
  run(store, "uc.match.next");
  const good = st0.participantIds.find((id) => !st0.undercoverIds.includes(id));
  res = ucFoul(store, good);
  assert.equal(res.result.wasUndercover, false);
  sv = buildStageView(store);
  assert.equal(sv.message.title, "唔係臥底");
  assert.equal(sv.message.tone, "bad");
  run(store, "uc.eliminate.undo");
  assert.deepEqual(store.state.room.gameState.undercover.eliminatedIds, [uc1]);
});

test("一圖多人計分：好人勝 → 好人 +1、留到最後 +2（疊加）；臥底 0", () => {
  const { store } = ucSetup("ucm-good-win", 6);
  run(store, "uc.match.start");
  const st0 = store.state.room.gameState.undercover;
  ucFoul(store, st0.undercoverIds[0]);
  run(store, "uc.match.next");
  ucFoul(store, st0.undercoverIds[1]);
  assert.equal(store.state.room.gameState.undercover.result, "good", "兩個臥底出局 → ready-to-settle 好人勝");
  const res = run(store, "uc.match.next");
  assert.equal(res.result.settled, true);
  const goodIds = st0.participantIds.filter((id) => !st0.undercoverIds.includes(id));
  for (const id of goodIds) assert.equal(store.playerScore(id), 3, "好人 +1 再留到最後 +2");
  for (const id of st0.undercoverIds) assert.equal(store.playerScore(id), 0, "出局臥底 0 分");
  // 大mon 出結算
  const sv = buildStageView(store);
  assert.equal(sv.stage.mode, "message");
  assert.match(sv.message.title, /第 1 局結算/);
  const ev = store.state.ledger.filter((e) => e.matchId === store.state.room.gameState.undercover.matchUid);
  assert.ok(ev.every((e) => e.gameId === "draw"));
  assert.ok(ev.some((e) => e.reason === "一圖多人・好人勝"));
  assert.ok(ev.some((e) => e.reason === "一圖多人・留到最後"));
});

test("一圖多人：3 題上限（未 foul 晒）→ 臥底勝，臥底 +1、留到最後 +2", () => {
  const { store } = ucSetup("ucm-uc-win", 6);
  run(store, "uc.match.start");
  const st0 = store.state.room.gameState.undercover;
  const goods = st0.participantIds.filter((id) => !st0.undercoverIds.includes(id));
  ucFoul(store, goods[0]);
  run(store, "uc.match.next");
  assert.equal(store.state.room.gameState.undercover.questionNo, 1);
  ucFoul(store, goods[1]);
  run(store, "uc.match.next");
  assert.equal(store.state.room.gameState.undercover.questionNo, 2);
  ucFoul(store, goods[2]); // 第三題都要 foul 過先准結算
  const res = run(store, "uc.match.next");
  assert.equal(res.result.settled, true, "第 3 題完 → 自動結算");
  assert.equal(store.state.room.gameState.undercover.settled, true);
  for (const id of st0.undercoverIds) assert.equal(store.playerScore(id), 3, "臥底 +1 留到最後 +2");
  for (const id of [goods[0], goods[1], goods[2]]) assert.equal(store.playerScore(id), 0, "出局好人 0 分");
  assert.equal(store.playerScore(goods[3]), 2, "未出局好人只有留到最後 +2");
});

test("uc.match.settle：冪等（重複撳唔會重複加分）", () => {
  const { store } = ucSetup("ucm-idem", 5);
  run(store, "uc.match.start");
  const ucIds = store.state.room.gameState.undercover.undercoverIds;
  ucFoul(store, ucIds[0]);
  run(store, "uc.match.next");
  ucFoul(store, ucIds[1]);
  const first = run(store, "uc.match.settle");
  assert.equal(first.result.settled, true);
  const snapshot = store.state.ledger.length;
  const matchUid = store.state.room.gameState.undercover.matchUid;
  assert.ok(matchUid, "每局要有唯一 matchUid（v0.4.1 去重鍵）");
  const second = run(store, "uc.match.settle");
  assert.equal(second.result.already, true);
  assert.equal(store.state.ledger.filter((e) => !e.voided && e.matchId === matchUid).length, snapshot);
  assert.throws(() => run(store, "uc.eliminate", { playerId: store.state.room.gameState.undercover.participantIds[0] }), isCmdError("W_ALREADY_STATE"));
});

test("uc.match.reset：清走本局，再開一局 matchNo+1", () => {
  const { store } = ucSetup("ucm-reset", 5);
  run(store, "uc.match.start");
  assert.equal(store.state.room.gameState.undercover.matchNo, 1);
  const resetUcIds = store.state.room.gameState.undercover.undercoverIds;
  ucFoul(store, resetUcIds[0]);
  run(store, "uc.match.next");
  ucFoul(store, resetUcIds[1]);
  run(store, "uc.match.settle");
  run(store, "uc.match.reset");
  const cleared = store.state.room.gameState.undercover;
  assert.deepEqual(cleared.participantIds, []);
  assert.equal(cleared.matchNo, 2);
  run(store, "uc.match.start");
  assert.equal(store.state.room.gameState.undercover.matchNo, 2);
  assert.equal(store.state.room.gameState.undercover.settled, false);
});

/* ───────── v0.4.0 Team B：一條投票 path ＋ foul 最高票（B5 六條） ───────── */

test("B5-1：uc.vote.start 嘅 eligiblePlayerIds 唔包已出局者（選民＝候選）", () => {
  const { store } = ucSetup("b5-vote-eligible", 6);
  run(store, "uc.match.start");
  run(store, "uc.prompt.reveal");
  const st0 = store.state.room.gameState.undercover;
  const victim = st0.participantIds.find((id) => !st0.undercoverIds.includes(id));
  ucFoul(store, victim);
  const res = run(store, "uc.vote.start");
  const round = store.round(res.result.roundId);
  const card = store.card(round.cardId);
  assert.equal(round.eligiblePlayerIds.includes(victim), false, "已出局者唔可以投票");
  const expected = st0.participantIds.filter((id) => id !== victim).sort();
  assert.deepEqual([...round.eligiblePlayerIds].sort(), expected, "選民＝未出局參賽者");
  assert.deepEqual([...card.options].sort(), expected, "候選＝未出局參賽者");
  assert.deepEqual([...round.eligiblePlayerIds].sort(), [...card.options].sort(), "選民同候選係同一批人");
});

test("B5-2：undercover.start 嘅 eligiblePlayerIds 唔包 excludePlayerIds（舊 bug：全部 approved 都投得）", () => {
  const { store } = makeStore("b5-start-exclude");
  const players = addPlayers(store, 4);
  run(store, "room.start");
  const res = run(store, "undercover.start", { excludePlayerIds: [players[1].id, players[3].id], durationSeconds: 10 });
  const round = store.round(res.result.roundId);
  const card = store.card(round.cardId);
  assert.deepEqual([...round.eligiblePlayerIds].sort(), [players[0].id, players[2].id].sort());
  assert.deepEqual([...card.options].sort(), [players[0].id, players[2].id].sort());
  assert.equal(round.eligiblePlayerIds.length, 2, "4 個 approved 剔走 2 個 → 2 個選民");
  assert.equal(new Set(round.eligiblePlayerIds).size, 2, "選民唔可以重複");
});

test("B5-3：uc.vote.foulTop 最高票唯一 → foul 佢、記錄題號、大mon 出係／唔係臥底", () => {
  const { store } = ucSetup("b5-foultop-ok", 6);
  run(store, "uc.match.start");
  run(store, "uc.prompt.reveal");
  const st0 = store.state.room.gameState.undercover;
  const victim = st0.undercoverIds[0];
  const res0 = run(store, "uc.vote.start");
  const round = store.round(res0.result.roundId);
  const card = store.card(round.cardId);
  const voters = st0.participantIds.filter((id) => id !== victim);
  vote(store, { roundId: round.id, cardId: card.id, voterId: voters[0], targetId: victim });
  vote(store, { roundId: round.id, cardId: card.id, voterId: voters[1], targetId: victim });
  run(store, "card.close");
  const res = run(store, "uc.vote.foulTop");
  assert.equal(res.result.targetId, victim, "最高票唯一 → foul 佢");
  assert.equal(res.result.votes, 2);
  assert.equal(res.result.totalVotes, 2);
  assert.equal(res.result.wasUndercover, true);
  assert.equal(res.result.remaining, 1);
  const st = store.state.room.gameState.undercover;
  assert.deepEqual(st.eliminatedIds, [victim]);
  assert.equal(st.eliminatedByQuestion?.[victim], st.questionNo, "淘汰要記低題號");
  const sv = buildStageView(store);
  assert.equal(sv.stage.mode, "message", "大mon 要出 message（係／唔係臥底）");
  assert.equal(sv.message.title, "係臥底！");
  assert.equal(sv.message.tone, "good");
});

test("B5-4：uc.vote.foulTop 同票 → W_TIE，eliminatedIds 不變", () => {
  const { store } = ucSetup("b5-foultop-tie", 6);
  run(store, "uc.match.start");
  run(store, "uc.prompt.reveal");
  const st0 = store.state.room.gameState.undercover;
  const goods = st0.participantIds.filter((id) => !st0.undercoverIds.includes(id));
  const [a, b] = goods;
  const res0 = run(store, "uc.vote.start");
  const round = store.round(res0.result.roundId);
  const card = store.card(round.cardId);
  vote(store, { roundId: round.id, cardId: card.id, voterId: st0.undercoverIds[0], targetId: a });
  vote(store, { roundId: round.id, cardId: card.id, voterId: st0.undercoverIds[1], targetId: b });
  run(store, "card.close");
  assert.throws(() => run(store, "uc.vote.foulTop"), isCmdError("W_TIE", /同票/));
  assert.deepEqual(store.state.room.gameState.undercover.eliminatedIds, [], "同票唔可以自己揀");
});

test("B5-5：uc.vote.foulTop 0 票 → W_NO_VOTES", () => {
  const { store } = ucSetup("b5-foultop-none", 6);
  run(store, "uc.match.start");
  run(store, "uc.prompt.reveal");
  run(store, "uc.vote.start");
  run(store, "card.close");
  assert.throws(() => run(store, "uc.vote.foulTop"), isCmdError("W_NO_VOTES", /冇人投票/));
  assert.deepEqual(store.state.room.gameState.undercover.eliminatedIds, []);
});

test("B5-6：已出局者唔可以再被 foul（uc.eliminate → W_ALREADY_STATE）", () => {
  const { store } = ucSetup("b5-refoul", 6);
  run(store, "uc.match.start");
  const st0 = store.state.room.gameState.undercover;
  const victim = st0.participantIds.find((id) => !st0.undercoverIds.includes(id));
  ucFoul(store, victim);
  assert.deepEqual(store.state.room.gameState.undercover.eliminatedIds, [victim]);
  run(store, "uc.match.next");
  const res0 = run(store, "uc.vote.start");
  run(store, "card.close");
  const round = store.round(res0.result.roundId);
  assert.equal(round.eligiblePlayerIds.includes(victim), false, "已出局者唔可以再投");
  assert.equal(store.card(round.cardId).options.includes(victim), false, "已出局者唔可以再被投");
  assert.throws(() => run(store, "uc.eliminate", { playerId: victim }), isCmdError("W_ALREADY_STATE", /已經淘汰/));
  assert.deepEqual(store.state.room.gameState.undercover.eliminatedIds, [victim], "唔會重複淘汰");
});


/* ───────── v0.3.0 階段 3：拍賣時間估歌（最少秒數贏） ───────── */

function bidSetup(tag, n = 3, points = 1, maxBid = 10, seconds = 10) {
  const { store } = makeStore(tag);
  const players = addPlayers(store, n);
  run(store, "room.start");
  run(store, "card.create", { card: { type: "bid", gameId: "auction", prompt: "聽幾秒，估歌名", maxBid, seconds, points } });
  const card = store.state.cards.find((c) => c.type === "bid");
  run(store, "card.open", {}, card.id);
  const round = store.currentRound();
  return { store, players, card, round };
}

function bidSub(store, round, card, playerId, amount, ts) {
  store.commit([{
    t: "submission.add",
    d: {
      submission: {
        id: `b_${playerId}_${amount}_${ts}`,
        roundId: round.id,
        cardId: card.id,
        playerId,
        ts,
        kind: "bid",
        amount,
        confirmed: true,
        payloadHash: "h",
      },
    },
  }]);
}

test("拍賣：最少秒數贏；同秒 → 最後提交（ts 最大）贏", () => {
  const { store, players, card, round } = bidSetup("bid-min", 3);
  bidSub(store, round, card, players[0].id, 5, 1000);
  bidSub(store, round, card, players[1].id, 3, 2000);
  bidSub(store, round, card, players[2].id, 3, 3000); // 同秒，但最後提交
  const ranked = bidRanking(store, round.id);
  assert.deepEqual(ranked.map((x) => x.playerId), [players[2].id, players[1].id, players[0].id]);
  const res = run(store, "bid.publish");
  assert.equal(res.result.ranking.length, 3);
  const auction = store.round(round.id).auction;
  assert.equal(auction.ranking[0].playerId, players[2].id, "同秒最後提交贏");
  assert.equal(auction.ranking[0].seconds, 3);
  assert.equal(auction.cursor, 0);
  assert.deepEqual(auction.judged, []);
  assert.equal(store.round(round.id).state, "closed");
});

test("拍賣：0 秒唔算競投（唔會入排名）", () => {
  const { store, players, card, round } = bidSetup("bid-zero", 3);
  bidSub(store, round, card, players[0].id, 0, 1000);
  bidSub(store, round, card, players[1].id, 2, 2000);
  assert.deepEqual(bidRanking(store, round.id).map((x) => x.playerId), [players[1].id]);
  run(store, "bid.publish");
  assert.equal(store.round(round.id).auction.ranking.length, 1);
  // ws 亦要擋 0 秒（source-level 保證：validateSubmission 要 1–max）
  const wsSrc = fs.readFileSync(path.join(APP_ROOT, "src/server/ws.ts"), "utf8");
  assert.match(wsSrc, /amount < 1 \|\| payload\.amount > max/, "ws 要拒 0 秒競投");
});

test("拍賣：publish 之後大mon 見排名＋而家邊個聽；未 publish 唔漏秒數", () => {
  const { store, players, card, round } = bidSetup("bid-stage", 3);
  bidSub(store, round, card, players[0].id, 4, 1000);
  bidSub(store, round, card, players[1].id, 2, 2000);
  let sv = buildStageView(store);
  assert.equal(sv.bid.ranking.length, 0, "未 publish 唔會漏排名");
  assert.equal(JSON.stringify(sv.bid).includes('"seconds"'), false, "未 publish 唔會漏個別秒數");
  run(store, "bid.publish");
  sv = buildStageView(store);
  assert.equal(sv.bid.ranking.length, 2);
  assert.equal(sv.bid.ranking[0].seconds, 2);
  assert.equal(sv.bid.ranking[0].current, true);
  assert.equal(sv.bid.currentName, players[1].name);
  assert.equal(sv.bid.currentSeconds, 2);
  assert.equal(sv.bid.remaining, 2);
});

test("拍賣：bid.judge 答對 +1、重複判分唔會加兩次", () => {
  const { store, players, card, round } = bidSetup("bid-judge-ok", 3, 1);
  bidSub(store, round, card, players[0].id, 4, 1000);
  bidSub(store, round, card, players[1].id, 2, 2000);
  run(store, "bid.publish");
  const res = run(store, "bid.judge", { correct: true });
  assert.equal(res.result.playerId, players[1].id, "judge 唔帶 playerId 就係而家嗰位");
  assert.equal(store.playerScore(players[1].id), 1);
  assert.equal(store.round(round.id).auction.finished, true);
  const sv = buildStageView(store);
  assert.equal(sv.stage.mode, "message");
  assert.equal(sv.message.title, "估中！");
  run(store, "bid.judge", { correct: true });
  run(store, "bid.judge", { correct: true, playerId: players[1].id });
  assert.equal(store.playerScore(players[1].id), 1, "重複判分唔會加兩次");
  assert.equal(store.state.ledger.filter((e) => !e.voided && e.reason === "估歌・聽歌").length, 1);
});

test("拍賣：答錯去下一位（cursor++），全部試完就完結", () => {
  const { store, players, card, round } = bidSetup("bid-judge-miss", 3);
  bidSub(store, round, card, players[0].id, 2, 1000);
  bidSub(store, round, card, players[1].id, 3, 2000);
  bidSub(store, round, card, players[2].id, 5, 3000);
  run(store, "bid.publish");
  let res = run(store, "bid.judge", { correct: false });
  assert.equal(res.result.cursor, 1);
  assert.equal(res.result.nextPlayerId, players[1].id);
  let sv = buildStageView(store);
  assert.equal(sv.stage.mode, "bid");
  assert.equal(sv.bid.ranking[0].tried, true);
  assert.equal(sv.bid.currentName, players[1].name);
  res = run(store, "bid.judge", { correct: false });
  assert.equal(res.result.cursor, 2);
  res = run(store, "bid.judge", { correct: false });
  assert.equal(res.result.finished, true);
  assert.equal(store.round(round.id).auction.finished, true);
  sv = buildStageView(store);
  assert.equal(sv.stage.mode, "message");
  assert.equal(sv.message.title, "全部人都估唔到");
  assert.equal(store.playerScore(players[0].id), 0);
});

test("拍賣：bid.publish 之前 bid.judge 會被拒；冇人競投 publish 都會拒", () => {
  const { store } = bidSetup("bid-guards", 3);
  assert.throws(() => run(store, "bid.judge", { correct: true }), isCmdError("W_ALREADY_STATE", /bid.publish/));
  assert.throws(() => run(store, "bid.publish"), isCmdError("W_ALREADY_STATE", /冇人競投/));
});

test("拍賣：bid.finish 收本首（唔會派分）", () => {
  const { store, players, card, round } = bidSetup("bid-finish", 2);
  bidSub(store, round, card, players[0].id, 3, 1000);
  run(store, "bid.publish");
  const res = run(store, "bid.finish");
  assert.equal(res.result.finished, true);
  assert.equal(store.round(round.id).auction.finished, true);
  assert.equal(store.state.ledger.filter((e) => !e.voided && e.gameId === "auction").length, 0);
});


/* ───────── v0.3.0 階段 4：笨蛋殺手／容差評分／分項結算／中庸之道 ───────── */

test("killer.assign：抽一個老闆＋一個殺手（唔同人），只出主持台", () => {
  const { store, players } = ucSetup("killer-assign", 5);
  const res = run(store, "killer.assign");
  assert.equal(res.ok, true);
  assert.notEqual(res.result.bossId, res.result.killerId, "老闆同殺手唔可以同一個人");
  assert.ok(players.some((p) => p.id === res.result.bossId));
  const hv = hostOver(store);
  assert.equal(hv.killerState.bossId, res.result.bossId);
  assert.equal(hv.killerState.killerId, res.result.killerId);
  // 唔准用 Player.secretRole，亦唔可以漏去手機／大mon
  for (const p of players) assert.equal(store.player(p.id).secretRole, undefined);
  const stageJson = JSON.stringify(buildStageView(store));
  assert.equal(stageJson.includes("bossId"), false, "大mon 唔可以漏老闆身份");
  assert.equal(stageJson.includes("killerState"), false, "大mon 唔可以漏笨蛋殺手 state");
  for (const p of players) {
    const pj = JSON.stringify(buildPlayerView(store, p.id));
    assert.equal(pj.includes("bossId"), false, "手機唔可以漏老闆");
    assert.equal(pj.includes("killerId"), false, "手機唔可以漏殺手");
  }
});

test("killer.redraw：重抽會換人；killer.clear 清走身份", () => {
  const { store } = ucSetup("killer-redraw", 5);
  run(store, "killer.assign");
  const before = JSON.parse(JSON.stringify(store.state.room.gameState.killer));
  run(store, "killer.redraw");
  const after = store.state.room.gameState.killer;
  assert.notEqual(`${after.bossId}|${after.killerId}`, `${before.bossId}|${before.killerId}`, "重抽要換人");
  assert.notEqual(after.bossId, after.killerId);
  run(store, "killer.clear");
  assert.equal(store.state.room.gameState.killer, null);
  assert.equal(hostOver(store).killerState, null);
});

test("容差評分：Q12 ±2 尺（40）→ 38/40/42 中、37/43 唔中", () => {
  const { store, players } = ucSetup("quiz-tol", 5);
  const q12 = loadQuizSeed(APP_ROOT).find((q) => q.id === "q12");
  store.commit([{ t: "quiz.set", d: { cards: [questionToCard(q12)] } }]);
  run(store, "card.open", {}, "q12");
  const round = store.currentRound();
  const answers = [38, 40, 42, 37, 43];
  players.forEach((p, i) => {
    store.commit([{
      t: "submission.add",
      d: { submission: { id: `s12_${i}`, roundId: round.id, cardId: "q12", playerId: p.id, ts: 1000 + i, kind: "open", amount: answers[i], confirmed: true, payloadHash: "h" } },
    }]);
  });
  run(store, "card.close");
  // v0.3.3：收卷只封卷，唔派分（主持未「揭曉」之前唔應該見到分）
  assert.deepEqual(players.map((p) => store.playerScore(p.id)), [0, 0, 0, 0, 0], "收卷唔可以加分");
  assert.equal(store.state.ledger.filter((e) => !e.voided && e.roundId === round.id).length, 0);
  // 揭曉（開正確答案）先派分
  run(store, "card.reveal");
  assert.equal(store.playerScore(players[0].id), 2, "38 ＝ 40-2 邊界內");
  assert.equal(store.playerScore(players[1].id), 2, "40 中");
  assert.equal(store.playerScore(players[2].id), 2, "42 ＝ 40+2 邊界內");
  assert.equal(store.playerScore(players[3].id), 0, "37 邊界外");
  assert.equal(store.playerScore(players[4].id), 0, "43 邊界外");
  assert.equal(store.state.ledger.filter((e) => !e.voided && e.reason === "問答 Q12・容差").length, 3);
  // 重複揭曉：round 已經 revealed → 拒絕，唔會再加分
  assert.throws(() => run(store, "card.reveal"), isCmdError("W_WRONG_PHASE"));
  assert.equal(store.state.ledger.filter((e) => !e.voided && e.roundId === round.id).length, 3);
});

test("容差評分：Q13 主持即場輸入答案（容差 0＝完全相等）", () => {
  const { store, players } = ucSetup("quiz-q13", 4);
  const q13 = loadQuizSeed(APP_ROOT).find((q) => q.id === "q13");
  store.commit([{ t: "quiz.set", d: { cards: [questionToCard(q13)] } }]);
  run(store, "card.open", {}, "q13");
  const round = store.currentRound();
  [100, 101, 99, 100].forEach((amount, i) => {
    store.commit([{
      t: "submission.add",
      d: { submission: { id: `s13_${i}`, roundId: round.id, cardId: "q13", playerId: players[i].id, ts: 1000 + i, kind: "open", amount, confirmed: true, payloadHash: "h" } },
    }]);
  });
  run(store, "card.close");
  assert.equal(store.playerScore(players[0].id), 0, "未入答案之前唔會加分");
  const res = run(store, "quiz.setActualAnswer", { roundId: round.id, actualAnswer: 100 });
  assert.equal(res.result.tolerance, 0);
  assert.equal(store.playerScore(players[0].id), 2);
  assert.equal(store.playerScore(players[1].id), 0);
  assert.equal(store.playerScore(players[2].id), 0);
  assert.equal(store.playerScore(players[3].id), 2);
  // 重複入答案：void 舊 auto 分再加，唔會累積
  run(store, "quiz.setActualAnswer", { roundId: round.id, actualAnswer: 100 });
  assert.equal(store.playerScore(players[0].id), 2, "重複輸入唔會加兩次");
});

test("分項結算 game-scores：由 ledger gameId 聚合（冇 gameId 算其他）", () => {
  const { store, players } = ucSetup("game-scores", 3);
  store.commit([{ t: "ledger.append", d: { events: [
    { id: "e1", ts: 1, target: { type: "player", id: players[0].id }, gameId: "draw", delta: 3, reason: "畫", by: "host" },
    { id: "e2", ts: 2, target: { type: "player", id: players[0].id }, gameId: "auction", delta: 1, reason: "歌", by: "host" },
    { id: "e3", ts: 3, target: { type: "player", id: players[1].id }, gameId: "killer", delta: 2, reason: "殺", by: "host" },
    { id: "e4", ts: 4, target: { type: "player", id: players[1].id }, gameId: "quiz", delta: 2, reason: "問", by: "host" },
    { id: "e5", ts: 5, target: { type: "player", id: players[2].id }, delta: 5, reason: "手動", by: "host" },
    { id: "e6", ts: 6, target: { type: "player", id: players[2].id }, gameId: "draw", delta: 9, reason: "作廢", by: "host", voided: true },
  ] } }]);
  store.commit([{ t: "stage.set", d: { stage: { mode: "game-scores", payload: {} } } }]);
  const sv = buildStageView(store);
  assert.equal(sv.stage.mode, "game-scores");
  assert.deepEqual(sv.gameScores.games.map((g) => g.gameId), ["draw", "auction", "killer", "quiz"]);
  const r0 = sv.gameScores.rows.find((r) => r.id === players[0].id);
  assert.deepEqual(r0.scores, [3, 1, 0, 0]);
  assert.equal(r0.other, 0);
  assert.equal(r0.total, 4);
  const r1 = sv.gameScores.rows.find((r) => r.id === players[1].id);
  assert.deepEqual(r1.scores, [0, 0, 2, 2]);
  assert.equal(r1.total, 4);
  const r2 = sv.gameScores.rows.find((r) => r.id === players[2].id);
  assert.equal(r2.other, 5, "冇 gameId 嘅算其他");
  assert.equal(r2.total, 5, "voided 唔計");
});

test("中庸之道：second 用平均數距離、rule=nearest-avg、stable tie-break", () => {
  const { store } = makeStore("awards-avg");
  const ps = addPlayers(store, 4);
  addScore(store, "player", ps[0].id, 10);
  addScore(store, "player", ps[1].id, 10);
  addScore(store, "player", ps[2].id, 10);
  addScore(store, "player", ps[3].id, 0);
  const awards = store.computeAwards();
  const second = awards.find((a) => a.id === "second");
  assert.equal(second.rule, "nearest-avg");
  assert.equal(second.targetId, ps[1].id, "平均 7.5；p2/p3 都距 2.5 → 編號細嘅贏");
  assert.equal(awards.find((a) => a.id === "grand").targetId, ps[0].id);
  assert.equal(awards.find((a) => a.id === "third").targetId, ps[3].id);
  // 中庸之道＝最接近平均數（唔再係中位數）
  const swapped = makeStore("awards-avg2");
  const ps2 = addPlayers(swapped.store, 5);
  [0, 1, 2, 3, 100].forEach((v, i) => addScore(swapped.store, "player", ps2[i].id, v));
  const a2 = swapped.store.computeAwards();
  const avg = (0 + 1 + 2 + 3 + 100) / 5; // 21.2；中位數係 2
  const cand = [0, 1, 2, 3].filter((i) => i !== 4).map((i) => ({ i, d: Math.abs([0, 1, 2, 3, 100][i] - avg) }));
  const best = cand.sort((x, y) => x.d - y.d || y.i - x.i)[0];
  assert.equal(a2.find((x) => x.id === "second").targetId, ps2[best.i].id, "最接近平均數（唔係中位數）");
});

test("頒獎文案：最高分獎／中庸之道獎／多謝參與獎", () => {
  const { store } = makeStore("award-copy");
  const ps = addPlayers(store, 3);
  [5, 3, 1].forEach((v, i) => addScore(store, "player", ps[i].id, v));
  store.commit([{ t: "award.set", d: { awards: store.computeAwards() } }, { t: "stage.set", d: { stage: { mode: "finale", payload: {} } } }]);
  const sv = buildStageView(store);
  const reasons = sv.finale.awards.map((a) => a.reason);
  assert.deepEqual(reasons, ["最高分獎", "中庸之道獎", "多謝參與獎"]);
});


test("FIX-8：uc.match.settle 勝負未定時拒絕（唔會偷判臥底勝／唔會寫分）", () => {
  const { store } = ucSetup("fix8-settle", 6);
  run(store, "uc.match.start");
  const before = store.state.ledger.length;
  assert.throws(() => run(store, "uc.match.settle"), isCmdError("W_WRONG_PHASE", /未可以結算/));
  assert.equal(store.state.ledger.length, before, "被拒時一筆分都唔應該寫");
  assert.equal(store.state.room.gameState.undercover.settled, false);
  // 打到第 3 題而且要 foul 過先准（走「下一題／結算」同一條路）
  const f8uc = store.state.room.gameState.undercover;
  const f8goods = f8uc.participantIds.filter((id) => !f8uc.undercoverIds.includes(id));
  ucFoul(store, f8goods[0]);
  run(store, "uc.match.next");
  ucFoul(store, f8goods[1]);
  run(store, "uc.match.next");
  ucFoul(store, f8goods[2]);
  const res = run(store, "uc.match.settle");
  assert.equal(res.result.settled, true);
  assert.equal(store.state.room.gameState.undercover.result, "undercover");
});


test("FIX-9：uc.match.redraw 唔會抽已出局者做臥底", () => {
  const { store } = ucSetup("fix9-redraw", 6);
  run(store, "uc.match.start");
  const st0 = store.state.room.gameState.undercover;
  const victim = st0.participantIds.find((id) => !st0.undercoverIds.includes(id));
  ucFoul(store, victim);
  for (let i = 0; i < 12; i += 1) {
    run(store, "uc.match.redraw");
    const st = store.state.room.gameState.undercover;
    assert.equal(st.undercoverIds.includes(victim), false, "已出局者唔可以再做臥底");
    assert.equal(new Set(st.undercoverIds).size, 2);
  }
});


test("FIX-10：一圖多人題目卡唔准 generic card.open（唔會穿橋／唔會開 round）", () => {
  const { store } = ucSetup("fix10-open", 5);
  run(store, "uc.match.start");
  const beforeRounds = store.state.room.rounds.length;
  const beforeMode = store.state.room.stage.mode;
  assert.throws(() => run(store, "card.open", {}, "uc_uc1"), isCmdError("W_WRONG_PHASE", /一圖多人/));
  assert.equal(store.state.room.rounds.length, beforeRounds, "唔會開 round");
  assert.equal(store.state.room.stage.mode, beforeMode, "大mon 畫面不變");
  assert.equal(store.state.room.currentRoundId, null);
});


/* ───────── 第三輪 audit：B1／B3（拍賣回合終態／公佈冪等） ───────── */

function bidMulti(tag, cardCount = 2, playersN = 3) {
  const { store } = makeStore(tag);
  const players = addPlayers(store, playersN);
  run(store, "room.start");
  const cards = [];
  for (let i = 1; i <= cardCount; i += 1) {
    run(store, "card.create", { card: { type: "bid", gameId: "auction", prompt: `第 ${i} 首・聽幾秒估歌名`, maxBid: 10, seconds: 10, points: 1 } });
    cards.push(store.state.cards.filter((c) => c.type === "bid").at(-1));
  }
  return { store, players, cards };
}

function openBid(store, card) {
  run(store, "card.open", {}, card.id);
  return store.currentRound();
}

test("B1：答對之後 round 收成 revealed，下一張拍賣卡開得", () => {
  const { store, players, cards } = bidMulti("b1-correct", 2);
  const round = openBid(store, cards[0]);
  bidSub(store, round, cards[0], players[0].id, 5, 1000);
  run(store, "bid.publish");
  run(store, "bid.judge", { correct: true });
  assert.equal(store.round(round.id).state, "revealed", "要終態 revealed");
  assert.equal(store.round(round.id).auction.finished, true);
  assert.equal(store.state.ledger.filter((e) => !e.voided && e.reason === "估歌・聽歌").length, 1, "分錄要保留");
  const next = openBid(store, cards[1]);
  assert.equal(next.state, "open", "下一首要開得（唔使先去揭曉）");
  assert.notEqual(next.id, round.id);
});

test("B1：全部答錯之後 round 收成 revealed，下一張拍賣卡開得", () => {
  const { store, players, cards } = bidMulti("b1-miss", 2, 2);
  const round = openBid(store, cards[0]);
  bidSub(store, round, cards[0], players[0].id, 3, 1000);
  run(store, "bid.publish");
  run(store, "bid.judge", { correct: false });
  assert.equal(store.round(round.id).state, "revealed");
  const next = openBid(store, cards[1]);
  assert.equal(next.state, "open");
});

test("B1：手動 bid.finish 之後 round 收成 revealed，下一張拍賣卡開得", () => {
  const { store, players, cards } = bidMulti("b1-finish", 2);
  const round = openBid(store, cards[0]);
  bidSub(store, round, cards[0], players[0].id, 4, 1000);
  run(store, "bid.publish");
  run(store, "bid.finish");
  assert.equal(store.round(round.id).state, "revealed");
  const next = openBid(store, cards[1]);
  assert.equal(next.state, "open");
});

test("B1：零人競投都收得本首（bid.finish），下一張拍賣卡開得", () => {
  const { store, cards } = bidMulti("b1-nobody", 2);
  const round = openBid(store, cards[0]);
  assert.throws(() => run(store, "bid.publish"), isCmdError("W_ALREADY_STATE", /冇人競投/));
  run(store, "bid.finish");
  assert.equal(store.round(round.id).state, "revealed", "零人競投都要收成終態");
  const next = openBid(store, cards[1]);
  assert.equal(next.state, "open");
});

test("A2：finish 之後唔可以再 bid.publish（唔可以將 revealed 拉返 closed 再派分）", () => {
  const { store, players, cards } = bidMulti("a2-revive", 2);
  const round = openBid(store, cards[0]);
  bidSub(store, round, cards[0], players[0].id, 4, 1000);
  run(store, "bid.finish"); // 未 publish 就收本首
  assert.equal(store.round(round.id).state, "revealed");
  assert.throws(() => run(store, "bid.publish"), isCmdError("W_ALREADY_STATE", /已經完結/));
  assert.equal(store.round(round.id).state, "revealed", "唔可以被拉返 closed");
  assert.equal(store.playerScore(players[0].id), 0, "唔應該有分");
  const next = openBid(store, cards[1]);
  assert.equal(next.state, "open", "下一首仍然開得");
});

test("A2：已判完（finished）之後再 bid.publish 都要拒", () => {
  const { store, players, cards } = bidMulti("a2-finished", 2);
  const round = openBid(store, cards[0]);
  bidSub(store, round, cards[0], players[0].id, 4, 1000);
  run(store, "bid.publish");
  run(store, "bid.judge", { correct: true });
  assert.throws(() => run(store, "bid.publish"), isCmdError("W_ALREADY_STATE", /已經完結/));
  assert.equal(store.playerScore(players[0].id), 1, "只派一次");
});

test("B3：重複公佈排名唔會重置判分（同一首歌唔會派兩次分）", () => {
  const { store, players, cards } = bidMulti("b3-publish", 2);
  const round = openBid(store, cards[0]);
  bidSub(store, round, cards[0], players[0].id, 5, 1000);
  bidSub(store, round, cards[0], players[1].id, 3, 2000);
  run(store, "bid.publish");
  const ranking = JSON.parse(JSON.stringify(store.round(round.id).auction.ranking));
  // 未判分之前再公佈：回原排名，唔重建
  const again = run(store, "bid.publish");
  assert.equal(again.result.already, true, "已公佈過要回原排名");
  assert.deepEqual(store.round(round.id).auction.ranking, ranking, "排名唔可以重建");
  assert.equal(store.round(round.id).auction.cursor, 0, "cursor 唔可以被重置");
  run(store, "bid.judge", { correct: true }); // players[1] 答對 +1
  assert.equal(store.playerScore(players[1].id), 1);
  // A2：本首已完成 → 再公佈一律拒（唔可以將 revealed 拉返 closed）
  assert.throws(() => run(store, "bid.publish"), isCmdError("W_ALREADY_STATE", /已經完結/));
  // 換 commandId（新對象）重判：finished 擋住，唔會派第二次
  run(store, "bid.judge", { correct: true });
  run(store, "bid.judge", { correct: true, playerId: players[1].id });
  assert.equal(store.playerScore(players[1].id), 1, "同一首歌只准一個得分者");
  assert.equal(store.state.ledger.filter((e) => !e.voided && e.reason === "估歌・聽歌").length, 1);
});

test("B3：bid.judge 指定非當前玩家 → W_STALE_COMMAND，唔會派分", () => {
  const { store, players, cards } = bidMulti("b3-cursor", 2);
  const round = openBid(store, cards[0]);
  bidSub(store, round, cards[0], players[0].id, 6, 1000);
  bidSub(store, round, cards[0], players[1].id, 3, 2000);
  run(store, "bid.publish");
  assert.throws(() => run(store, "bid.judge", { correct: true, playerId: players[0].id }), isCmdError("W_STALE_COMMAND"));
  assert.equal(store.playerScore(players[0].id), 0);
  assert.equal(store.playerScore(players[1].id), 0);
});


/* ───────── 第三輪 audit：B4（一圖多人步驟約束）／P1-c（undo） ───────── */

test("B4：本題未 foul 過唔准下一題（連撳 next 被擋）", () => {
  const { store } = ucSetup("b4-next", 6);
  run(store, "uc.match.start");
  assert.throws(() => run(store, "uc.match.next"), isCmdError("W_WRONG_PHASE", /未 foul/));
  assert.throws(() => run(store, "uc.match.next"), isCmdError("W_WRONG_PHASE", /未 foul/));
  assert.equal(store.state.room.gameState.undercover.questionNo, 0, "questionNo 唔可以跳");
});

test("B4：同一題唔准 foul 第二個人", () => {
  const { store } = ucSetup("b4-double", 6);
  run(store, "uc.match.start");
  const st = store.state.room.gameState.undercover;
  const goods = st.participantIds.filter((id) => !st.undercoverIds.includes(id));
  ucFoul(store, goods[0]);
  assert.throws(() => ucFoul(store, goods[1]), isCmdError("W_ALREADY_STATE", /已經 foul/));
  assert.equal(store.state.room.gameState.undercover.eliminatedIds.length, 1);
});

test("B4：投票仲 open（未收卷）唔准 foul", () => {
  const { store } = ucSetup("b4-voting", 6);
  run(store, "uc.match.start");
  run(store, "uc.vote.start");
  const st = store.state.room.gameState.undercover;
  const goods = st.participantIds.filter((id) => !st.undercoverIds.includes(id));
  assert.throws(() => run(store, "uc.eliminate", { playerId: goods[0] }), isCmdError("W_WRONG_PHASE", /未收卷/));
  assert.equal(store.state.room.gameState.undercover.eliminatedIds.length, 0);
});

test("B4：第三題未 foul 就 settle → 拒絕；foul 咗就准", () => {
  const { store } = ucSetup("b4-settle3", 6);
  run(store, "uc.match.start");
  const st = store.state.room.gameState.undercover;
  const goods = st.participantIds.filter((id) => !st.undercoverIds.includes(id));
  ucFoul(store, goods[0]);
  run(store, "uc.match.next");
  ucFoul(store, goods[1]);
  run(store, "uc.match.next");
  assert.equal(store.state.room.gameState.undercover.questionNo, 2);
  assert.throws(() => run(store, "uc.match.settle"), isCmdError("W_WRONG_PHASE", /未可以結算/));
  ucFoul(store, goods[2]);
  const res = run(store, "uc.match.settle");
  assert.equal(res.result.settled, true);
  assert.equal(store.state.room.gameState.undercover.result, "undercover");
});

test("P1-c：換咗題之後唔可以 undo 上一題嘅淘汰", () => {
  const { store } = ucSetup("p1c-undo", 6);
  run(store, "uc.match.start");
  const st = store.state.room.gameState.undercover;
  const goods = st.participantIds.filter((id) => !st.undercoverIds.includes(id));
  ucFoul(store, goods[0]);
  run(store, "uc.match.next");
  assert.throws(() => run(store, "uc.eliminate.undo"), isCmdError("W_ALREADY_STATE", /換咗題/));
  // 本題 foul 完之後 undo 得
  ucFoul(store, goods[1]);
  run(store, "uc.eliminate.undo");
  assert.deepEqual(store.state.room.gameState.undercover.eliminatedIds, [goods[0]]);
  assert.equal(store.state.room.gameState.undercover.eliminatedByQuestion?.[goods[1]], undefined);
});


/* ───────── 第三輪 audit：B5／B6／B7／P1-d／P1-e ───────── */

test("B5：大mon 排行榜／結算唔再 slice 12 人（自動分欄）", () => {
  const stageSrc = fs.readFileSync(path.join(APP_ROOT, "src/client/stage.ts"), "utf8");
  assert.equal(/\.slice\(0,\s*12\)/.test(stageSrc), false, "唔可以只 render 頭 12 人");
  assert.match(stageSrc, /scoreRowsHtml/, "要用分欄 helper");
  assert.match(stageSrc, /cols-3/, "26 人以上要 3 欄");
  const css = fs.readFileSync(path.join(APP_ROOT, "public/app.css"), "utf8");
  assert.match(css, /\.scoreboard-list\.multi/, "要有分欄 CSS");
  assert.match(css, /overflow-y: auto/, "分欄之後仲要可以捲");
});

test("B6：主持儲存 Q12／Q13 唔會刪走 tolerance（儲存後容差評分照 work）", () => {
  const { store, players } = ucSetup("b6-save", 5);
  const qs = loadQuizSeed(APP_ROOT);
  const q12 = qs.find((q) => q.id === "q12");
  const q13 = qs.find((q) => q.id === "q13");
  store.commit([{ t: "quiz.set", d: { cards: [questionToCard(q12), questionToCard(q13)] } }]);
  // 模擬主持台儲存題目（payload 冇帶 tolerance）
  run(store, "quiz.upsert", { question: { id: "q12", type: "open", openKind: "number", category: q12.category, prompt: q12.prompt, explanation: q12.explanation, seconds: 30, points: 2 } });
  run(store, "quiz.upsert", { question: { id: "q13", type: "open", openKind: "number", category: q13.category, prompt: q13.prompt, explanation: q13.explanation, seconds: 30, points: 2 } });
  assert.equal(store.card("q12").tolerance, 2, "Q12 儲存後 tolerance 要保留");
  assert.equal(store.card("q12").actualAnswer, 40, "Q12 actualAnswer 要保留");
  assert.equal(store.card("q13").tolerance, 0, "Q13 tolerance 0 要保留");
  // 儲存後再跑容差評分：38／40／42 中、37／43 唔中
  run(store, "card.open", {}, "q12");
  const round = store.currentRound();
  [38, 40, 42, 37, 43].forEach((amount, i) => {
    store.commit([{
      t: "submission.add",
      d: { submission: { id: `b6_${i}`, roundId: round.id, cardId: "q12", playerId: players[i].id, ts: 1000 + i, kind: "open", amount, confirmed: true, payloadHash: "h" } },
    }]);
  });
  run(store, "card.close");
  assert.deepEqual(players.map((p) => store.playerScore(p.id)), [0, 0, 0, 0, 0], "v0.3.3：收卷唔派分");
  run(store, "card.reveal");
  assert.deepEqual(players.map((p) => store.playerScore(p.id)), [2, 2, 2, 0, 0], "揭曉先派分");
});

test("v0.3.3：問答收卷唔派分，揭曉先派分（MC）", () => {
  const { store, players } = ucSetup("v33-quiz", 3);
  const q1 = loadQuizSeed(APP_ROOT).find((q) => q.id === "q1");
  store.commit([{ t: "quiz.set", d: { cards: [questionToCard(q1)] } }]);
  run(store, "card.open", {}, "q1");
  const round = store.currentRound();
  [0, 0, 1].forEach((choice, i) => {
    store.commit([{
      t: "submission.add",
      d: { submission: { id: `v33_${i}`, roundId: round.id, cardId: "q1", playerId: players[i].id, ts: 1000 + i, kind: "choice", choice, confirmed: true, payloadHash: "h" } },
    }]);
  });
  run(store, "card.close");
  assert.deepEqual(players.map((p) => store.playerScore(p.id)), [0, 0, 0], "收卷唔可以派分");
  run(store, "card.tally");
  assert.deepEqual(players.map((p) => store.playerScore(p.id)), [0, 0, 0], "出分佈都唔可以派分");
  // 分佈畫面要有名（唔止頭像）
  const tv = buildStageView(store).tally;
  assert.ok(tv && tv.voters.length === 3, "分佈要見到 3 個投票者");
  assert.ok(tv.voters.every((x) => typeof x.name === "string" && x.name.length > 0), "每個投票者都要有名");
  run(store, "card.reveal");
  assert.deepEqual(players.map((p) => store.playerScore(p.id)), [1, 1, 0], "揭曉先派分");
});

test("v0.3.3：數字開放題收卷後大mon 見到「名＋答案」", () => {
  const { store, players } = ucSetup("v33-open", 3);
  const q12 = loadQuizSeed(APP_ROOT).find((q) => q.id === "q12");
  store.commit([{ t: "quiz.set", d: { cards: [questionToCard(q12)] } }]);
  run(store, "card.open", {}, "q12");
  const round = store.currentRound();
  [38, 40, 41].forEach((amount, i) => {
    store.commit([{
      t: "submission.add",
      d: { submission: { id: `v33o_${i}`, roundId: round.id, cardId: "q12", playerId: players[i].id, ts: 1000 + i, kind: "open", amount, confirmed: true, payloadHash: "h" } },
    }]);
  });
  run(store, "card.close");
  const tv = buildStageView(store).tally;
  assert.ok(tv, "要有 tally");
  assert.equal(tv.answers.length, 3, "三個人都要列出");
  assert.deepEqual(tv.answers.map((a) => a.text), ["38", "40", "41"], "要出答案數字");
  assert.deepEqual(players.map((p) => store.playerScore(p.id)), [0, 0, 0], "收卷唔派分");
});

test("B7：同一毫秒提交，用持久提交順序判「最後提交」（唔用 id 字典序）", () => {
  const { store, players, card, round } = bidSetup("b7-order", 2);
  store.commit([{ t: "submission.add", d: { submission: { id: "sub_aaa", roundId: round.id, cardId: card.id, playerId: players[0].id, ts: 5000, kind: "bid", amount: 5, confirmed: true, payloadHash: "h" } } }]);
  store.commit([{ t: "submission.add", d: { submission: { id: "sub_zzz", roundId: round.id, cardId: card.id, playerId: players[1].id, ts: 5000, kind: "bid", amount: 5, confirmed: true, payloadHash: "h" } } }]);
  const ranked = bidRanking(store, round.id);
  assert.deepEqual(ranked.map((x) => x.id), ["sub_zzz", "sub_aaa"], "後加入者排前（唔係 aaa 先）");
  run(store, "bid.publish");
  const sv = buildStageView(store);
  assert.equal(sv.bid.ranking[0].playerId, players[1].id, "大mon 排名都要跟持久提交順序");
  assert.equal(store.round(round.id).auction.ranking[0].playerId, players[1].id);
});

test("P1-d：card.create whitelist 有 undercoverPrompt／tolerance／actualAnswer", () => {
  const { store } = ucSetup("p1d-create", 3);
  run(store, "card.create", {
    card: { type: "open", gameId: "draw", prompt: "測試", undercoverPrompt: "關鍵詞", tolerance: 3, actualAnswer: 12, openKind: "number" },
  });
  const card = store.state.cards.filter((c) => c.prompt === "測試").at(-1);
  assert.equal(card.undercoverPrompt, "關鍵詞");
  assert.equal(card.tolerance, 3);
  assert.equal(card.actualAnswer, 12);
});

test("P1-e：數字題自動容差評分後，手機顯示中／唔中（唔再係主持評分中）", () => {
  const { store, players } = ucSetup("p1e-result", 3);
  const q12 = loadQuizSeed(APP_ROOT).find((q) => q.id === "q12");
  store.commit([{ t: "quiz.set", d: { cards: [questionToCard(q12)] } }]);
  run(store, "card.open", {}, "q12");
  const round = store.currentRound();
  [40, 39, 30].forEach((amount, i) => {
    store.commit([{
      t: "submission.add",
      d: { submission: { id: `p1e_${i}`, roundId: round.id, cardId: "q12", playerId: players[i].id, ts: 1000 + i, kind: "open", amount, confirmed: true, payloadHash: "h" } },
    }]);
  });
  run(store, "card.close");
  run(store, "card.reveal");
  assert.equal(buildPlayerView(store, players[0].id).reveal.myResult, "correct", "40 中");
  assert.equal(buildPlayerView(store, players[1].id).reveal.myResult, "correct", "39 喺 ±2 內");
  assert.equal(buildPlayerView(store, players[2].id).reveal.myResult, "wrong", "30 唔中");
});


/* ───────── 第三輪 audit：B2／P1-a／P1-b／P1-f ───────── */

test("B2：問答『揭曉』＝先收卷再 reveal（round 已封、只派一次分、下一題開得）", () => {
  const { store, players } = ucSetup("b2-reveal", 4);
  const qs = loadQuizSeed(APP_ROOT).filter((q) => q.id === "q1" || q.id === "q2");
  store.commit([{ t: "quiz.set", d: { cards: qs.map(questionToCard) } }]);
  run(store, "card.open", {}, "q1");
  const round = store.currentRound();
  // 第 5 秒：一人答對（choice 0）、一人答錯
  store.commit([{
    t: "submission.add",
    d: { submission: { id: "b2_a", roundId: round.id, cardId: "q1", playerId: players[0].id, ts: 5000, kind: "choice", choice: 0, confirmed: true, payloadHash: "h" } },
  }]);
  store.commit([{
    t: "submission.add",
    d: { submission: { id: "b2_b", roundId: round.id, cardId: "q1", playerId: players[1].id, ts: 5001, kind: "choice", choice: 1, confirmed: true, payloadHash: "h" } },
  }]);
  // 主持撳「揭曉」嘅真實順序：card.close → card.reveal
  run(store, "card.close");
  run(store, "card.reveal");
  assert.equal(store.round(round.id).state, "revealed", "round 要封（唔可以仲 open）");
  assert.equal(store.playerScore(players[0].id), 1);
  assert.equal(store.playerScore(players[1].id), 0);
  // 重複 reveal 會被拒（唔會再派分）
  assert.throws(() => run(store, "card.reveal"), isCmdError("W_WRONG_PHASE"));
  assert.equal(store.state.ledger.filter((e) => !e.voided && e.roundId === round.id).length, 1);
  // 下一題開得
  run(store, "card.open", {}, "q2");
  assert.equal(store.currentRound().state, "open");
  assert.notEqual(store.currentRound().id, round.id);
});

test("B2：控制頁三個掣接真 command（唔再純粹 stage.set）", () => {
  const src = fs.readFileSync(path.join(APP_ROOT, "src/client/host.ts"), "utf8");
  // v04-D：出題目／開始作答拆成兩個掣（quiz.show／quiz.open），分佈＋答案照舊
  assert.match(src, /data-act="quiz\.show"/);
  assert.match(src, /data-act="quiz\.open"/);
  assert.match(src, /data-act="qa\.dist"/);
  assert.match(src, /data-act="qa\.reveal"/);
  assert.match(src, /只換畫面（唔會收卷／評分）/, "純換畫面嘅掣要另外標示");
  // 真流程分支要 call card command，唔係 stage.set
  assert.match(src, /if \(sub === "reveal"\) \{[\s\S]{0,220}cmd\("card\.reveal"\)/);
});

test("P1-a：笨蛋殺手一般玩家加分有得揀人＋gameId=killer", () => {
  const src = fs.readFileSync(path.join(APP_ROOT, "src/client/host.ts"), "utf8");
  assert.match(src, /id="killer-target"/, "要有玩家選擇");
  assert.match(src, /data-act="killer\.any:1"/, "要有 +1 掣");
  assert.match(src, /reason: "笨蛋殺手・主持加分", gameId: "killer"/, "要送 gameId=killer");
});

test("P1-b：舊題匯入收埋喺進階＋有 confirm（唔會一撳即覆蓋）", () => {
  const src = fs.readFileSync(path.join(APP_ROOT, "src/client/host.ts"), "utf8");
  assert.match(src, /進階：舊題匯入/, "要喺進階摺疊入面");
  assert.match(src, /window\.confirm\("確定匯入舊 QUIZ/, "要有確認對話");
  const idx = src.indexOf('sub === "import"');
  assert.ok(idx > 0 && src.slice(idx, idx + 400).includes("window.confirm"), "import 分支要先 confirm");
});

test("P1-f：到期一律拒提交＋競投秒數唔可以大過剩餘秒數（+1 秒誤差）", () => {
  const t0 = Date.now();
  assert.equal(roundExpired(null, t0), false, "冇 endsAt 唔會過期");
  assert.equal(roundExpired(t0 + 5000, t0), false);
  assert.equal(roundExpired(t0 - 1, t0), true, "過咗 endsAt 就過期");
  // endsAt 仲有 5 秒：剩餘 5 → 最多准 6（+1 秒網絡誤差）
  assert.equal(bidSecondsAllowed(5, t0 + 5000, t0), true);
  assert.equal(bidSecondsAllowed(6, t0 + 5000, t0), true);
  assert.equal(bidSecondsAllowed(7, t0 + 5000, t0), false, "唔可以偷多幾秒");
  // 剩 0.4 秒：remaining=1 → 最多准 2
  assert.equal(bidSecondsAllowed(2, t0 + 400, t0), true);
  assert.equal(bidSecondsAllowed(3, t0 + 400, t0), false);
  // ws 真係用呢兩個 helper（source-level 保證）
  const wsSrc = fs.readFileSync(path.join(APP_ROOT, "src/server/ws.ts"), "utf8");
  assert.match(wsSrc, /roundExpired\(round\.endsAt, Date\.now\(\)\)/, "到期要一律拒（唔再淨係 draw 卡）");
  assert.match(wsSrc, /bidSecondsAllowed\(/, "bid 要驗剩餘秒數");
});

/* ───────── v0.4 Team C：規則頁格式約束（防將來改爆；唔驗文案寫法） ───────── */

test("v0.4 規則頁：四頁齊＋字數／一屏限制＋block type 白名單", () => {
  const ALLOWED = ["heading", "paragraph", "bullets", "steps", "callout", "kv", "score-table", "image"];
  // 高度估算同 store.rulePages() 一致（1920×1080 主體可用 ≈700px）；>700 會被切走（大mon 只出 pageIndex 0）
  const height = (b) => {
    const text = (b.text ?? "").length + (b.value ?? "").length;
    switch (b.type) {
      case "heading": return 110;
      case "callout": return 130;
      case "image": return 360;
      case "kv": return 80;
      case "score-table": return 56 * ((b.items?.length ?? 0) + 1) + 24;
      case "bullets":
      case "steps": return 62 * ((b.items?.length ?? 0) || 1) + 28;
      default: return Math.ceil(text / 36) * 72 + 28;
    }
  };
  // block「文字合計」＝text + value + 所有 items（v0.4 自我約束，比 commands.ts 更嚴）
  const blockChars = (b) =>
    (b.text ?? "").length + (b.value ?? "").length + (b.items ?? []).reduce((n, it) => n + it.length, 0);

  const raw = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "seed/rulepages.seed.json"), "utf8"));
  assert.equal(raw.pages.length, 4, "四頁規則");

  // 1) id／gameId／order／enabled／autoAdvance 沿用 v0.3 約定（每頁對應一個 game）
  assert.deepEqual(raw.pages.map((p) => p.id), ["rule-draw", "rule-auction", "rule-killer", "rule-quiz"]);
  assert.deepEqual(raw.pages.map((p) => p.gameId), ["draw", "auction", "killer", "quiz"]);
  assert.deepEqual(raw.pages.map((p) => p.order), [0, 1, 2, 3]);
  assert.deepEqual(raw.pages.map((p) => p.enabled), [true, true, true, true]);
  for (const p of raw.pages) assert.equal(p.autoAdvanceSeconds, 0, `${p.id} 唔自動翻頁`);

  // 2) seed 讀得返入 store（loadRulePagesSeed 唔會爆，gameId 對得返）
  const pages = loadRulePagesSeed(APP_ROOT);
  assert.equal(pages.length, 4);
  assert.deepEqual(pages.map((p) => p.gameId), ["draw", "auction", "killer", "quiz"]);
  for (const p of pages) assert.ok(p.blocks.length > 0, `${p.id} 讀到 blocks`);

  for (const p of raw.pages) {
    // 3) 字數限制（commands.ts rules.upsert／本 team v0.4 約束）
    assert.ok(p.title.length > 0 && p.title.length <= 16, `${p.id} title ≤16 字`);
    assert.ok((p.subtitle ?? "").length <= 24, `${p.id} subtitle ≤24 字`);
    assert.ok(p.blocks.length > 0 && p.blocks.length <= 20, `${p.id} blocks ≤20`);
    let total = 0;
    for (const b of p.blocks) {
      assert.ok(ALLOWED.includes(b.type), `${p.id} block type 喺白名單`);
      const bs = blockChars(b);
      assert.ok(bs <= 120, `${p.id} ${b.type} block 文字合計 ≤120 字（實際 ${bs}）`);
      assert.ok((b.items ?? []).length <= 6, `${p.id} ${b.type} items ≤6`);
      for (const it of b.items ?? []) assert.ok(it.length <= 120, `${p.id} 單條 item ≤120 字`);
      total += bs;
    }
    assert.ok(total <= 1200, `${p.id} 全頁 ≤1200 字（實際 ${total}）`);

    // 4) 一屏（1920×1080）：heading ≤2、steps+bullets ≤6 條、callout ≤1、score-table ≤3 行
    const count = (types) => p.blocks.filter((b) => types.includes(b.type)).length;
    const listItems = p.blocks.filter((b) => ["steps", "bullets"].includes(b.type)).reduce((n, b) => n + (b.items ?? []).length, 0);
    const scoreRows = p.blocks.filter((b) => b.type === "score-table").reduce((n, b) => n + (b.items ?? []).length, 0);
    assert.ok(count(["heading"]) <= 2, `${p.id} heading ≤2`);
    assert.ok(listItems <= 6, `${p.id} steps+bullets ≤6 條`);
    assert.ok(count(["callout"]) <= 1, `${p.id} callout ≤1`);
    assert.ok(scoreRows <= 3, `${p.id} score-table ≤3 行`);
    const totalHeight = p.blocks.reduce((n, b) => n + height(b), 0);
    assert.ok(totalHeight <= 700, `${p.id} 一屏放得落（估算 ${totalHeight}px ≤700px）`);
  }
});

/* ───────── v0.4 Team A：主持台「開 game」同大mon 脫節／掣冇反應／大mon 死畫面 ───────── */

/** 預設 4 關 rundown（draw→auction→killer→quiz），currentItemId=null、phase=lobby */
function aSetup(tag) {
  const { store } = makeStore(tag);
  const rundown = defaultRundown(["q1"], ["uc_uc1"], ["auc_1"]);
  store.commit([{ t: "rundown.set", d: { rundown, currentItemId: null, phase: "lobby" } }]);
  return { store, rundown };
}

function rdOf(store) {
  return store.state.room.rundown;
}

test("A4-1：room.start 喺 lobby → playing＋currentItemId=第一關＋大mon 出第一關規則頁", () => {
  const { store } = aSetup("a4-start-lobby");
  assert.equal(store.state.room.phase, "lobby");
  const res = run(store, "room.start");
  assert.equal(res.ok, true);
  assert.equal(store.state.room.phase, "playing", "要轉 playing");
  assert.equal(store.currentItem().id, "rd_draw", "currentItemId 要係第一關（左邊 panel 唔會再話未開始）");
  assert.equal(rdOf(store)[0].state, "running");
  assert.equal(store.state.room.stage.mode, "rules", "大mon 要即刻出第一關規則頁（唔再兩邊各有各）");
  assert.equal(store.state.room.stage.payload.itemId, "rd_draw");
  assert.equal(rdOf(store).filter((i) => i.state === "running").length, 1, "唔可以重複 push 出兩個 running");
});

test("A4-2：room.start 喺 playing 但 currentItemId=null（用戶撞到嘅情境）→ 唔 throw，照樣入第一關", () => {
  const { store } = aSetup("a4-start-null-item");
  // 模擬正式 server：已經 playing（之前試過），rundown 全部 todo，currentItemId=null
  store.commit([{ t: "room.phase", d: { phase: "playing" } }]);
  assert.equal(store.state.room.currentItemId, null);
  const res = run(store, "room.start");
  assert.equal(res.ok, true, "唔可以再 throw W_ALREADY_STATE（撳開始要有反應）");
  assert.equal(store.currentItem().id, "rd_draw");
  assert.equal(store.state.room.stage.mode, "rules");
});

test("A4-3：room.start 已經進行緊 → 唔 throw，亦唔會跳關（currentItemId 唔變）", () => {
  const { store } = aSetup("a4-start-already");
  run(store, "room.start");
  run(store, "rundown.next"); // 主持撳到第 2 關
  const before = store.currentItem().id;
  assert.equal(before, "rd_auction");
  const res = run(store, "room.start");
  assert.equal(res.ok, true, "重複撳「開始遊戲」唔可以 throw");
  assert.equal(store.currentItem().id, before, "唔可以因為撳開始而跳返第一關");
  assert.equal(store.state.room.phase, "playing");
});

test("A4-4：stage.set 喺大mon 鎖住時 → W_STAGE_LOCKED（唔再靜靜冇反應）", () => {
  const { store } = aSetup("a4-stage-locked");
  run(store, "room.start");
  const modeBefore = store.state.room.stage.mode;
  run(store, "stage.lock", { lock: true });
  assert.throws(() => run(store, "stage.set", { mode: "scoreboard" }), isCmdError("W_STAGE_LOCKED", /大mon 已鎖定，請先解鎖/));
  assert.equal(store.state.room.stage.mode, modeBefore, "被拒之後畫面唔應該變");
  // 解鎖之後即刻恢復正常（唔會變死結）
  run(store, "stage.lock", { lock: false });
  const res = run(store, "stage.set", { mode: "scoreboard" });
  assert.equal(res.ok, true);
  assert.equal(store.state.room.stage.mode, "scoreboard");
});

test("A4-5：rundown.reset → 全部 todo、currentItemId=null、phase=playing、未完 round void", () => {
  const { store } = aSetup("a4-reset");
  run(store, "room.start");
  run(store, "rundown.next"); // 第 1 關 done、第 2 關 running
  putRound(store, { id: "r_reset", cardId: "c1", state: "open", eligiblePlayerIds: [] });
  const res = run(store, "rundown.reset");
  assert.equal(res.ok, true);
  assert.deepEqual(rdOf(store).map((i) => i.state), ["todo", "todo", "todo", "todo"], "全部返 todo");
  assert.deepEqual(rdOf(store).map((i) => i.index), [0, 1, 2, 3]);
  assert.equal(store.state.room.currentItemId, null);
  assert.equal(store.state.room.phase, "playing");
  assert.equal(store.state.room.currentRoundId, null, "要清走上一輪");
  assert.equal(store.round("r_reset").state, "void", "未完 round 要 void（唔會殘留開住）");
  // 大mon 出第一關規則頁（唔會空白／唔會留上一關畫面）
  assert.equal(store.state.room.stage.mode, "rules");
  assert.equal(store.state.room.stage.payload.itemId, "rd_draw");
});

test("A4-6：buildStageView 喺 mode=vote 但冇開 round → 唔 throw、vote=null", () => {
  const { store } = aSetup("a4-vote-null");
  run(store, "room.start");
  run(store, "stage.set", { mode: "vote" });
  assert.equal(store.state.room.currentRoundId, null, "前提：真係冇 round");
  const view = buildStageView(store);
  assert.equal(view.stage.mode, "vote");
  assert.equal(view.vote, null, "冇 round 就係 null（大mon 側要有 placeholder 接住）");
});

test("A4-7：final／award 之後撳「開始遊戲」可以重新由第一關玩", () => {
  const { store } = aSetup("a4-start-from-award");
  run(store, "room.start");
  for (let i = 0; i < 3; i += 1) run(store, "rundown.next"); // 玩到最後一關
  run(store, "room.phase", { phase: "final" });
  const res = run(store, "room.start");
  assert.equal(res.ok, true, "完咗都要撳得返落去（唔好令主持要開新房）");
  assert.equal(store.state.room.phase, "playing");
  assert.equal(store.currentItem().id, "rd_draw");
  assert.equal(rdOf(store).filter((i) => i.state === "running").length, 1, "只可以有一關 running");
});

test("A4-8：大mon 每個 mode 都 null-safe（冇資料出佔位）＋render 有 error boundary", () => {
  const src = clientSrc("stage.ts");
  for (const fn of ["voteHtml", "tallyHtml", "revealHtml", "questionHtml", "bidHtml", "songHtml", "roleRevealHtml"]) {
    const start = src.indexOf(`function ${fn}(`);
    assert.ok(start >= 0, `${fn} 要存在`);
    const body = src.slice(start, src.indexOf("\nfunction ", start + 10));
    assert.match(body, /if \(!\w+\) return placeholder\(/, `${fn} 開頭要有 null guard（唔可以再 TypeError 令大mon 凍結）`);
  }
  assert.match(src, /function placeholder\(/, "要有友善佔位 helper");
  assert.match(src, /等主持喺主持台開投票…/, "vote 冇 round 要有粵語提示");
  assert.match(src, /等主持出題…/, "question 冇 round 要有提示");
  assert.ok(!/v\.vote\.options/.test(src), "唔可以再直接讀 v.vote.options");
  // render 出錯＝最後防線：出錯誤提示＋保留分數條（唔會停留喺舊 frame）
  assert.match(src, /catch \(err\)[\s\S]{0,160}errorHtml\(v\)/, "render catch 要出 errorHtml");
  assert.match(src, /function errorHtml[\s\S]{0,400}scoreBar\(v\)/, "錯誤畫面要保留分數條");
  assert.match(src, /大mon 返 QR／入場頁/, "錯誤畫面要教主持撳邊個掣");
});

test("A4-9：主持台大mon 控制有同步狀態／鎖定紅 pill；畫畫組唔再放 vote／undercover", () => {
  const src = clientSrc("host.ts");
  // A3-3：一行同步狀態
  assert.match(src, /const syncLine = `大mon：/, "要有「大mon：模式・回合・鎖定」一行");
  assert.match(src, /大mon 已鎖定/, "鎖定時要出「大mon 已鎖定」pill");
  assert.match(src, /background:var\(--red\)/, "鎖定 pill 要用紅色");
  assert.match(src, /ROUND_ZH/, "要有回合狀態中文（唔好出 raw state）");
  // A3-1：畫畫組只留純換畫面嘅兩個掣（真投票喺一圖多人面板）
  assert.match(src, /group\("畫畫", \["draw-wall", "draw-focus"\]\)/, "畫畫組只留兩個掣");
  assert.ok(!/group\("畫畫", \[[^\]]*"vote"/.test(src), "唔可以再放 vote（冇 round 會 TypeError）");
  assert.ok(!/group\("畫畫", \[[^\]]*"undercover"/.test(src), "唔可以再放 undercover（死胡同）");
  // A3-4：流程卡三種清楚狀態＋重設流程
  assert.match(src, /未開始（撳「開始遊戲」）/, "未開始要教主持撳邊個掣");
  assert.match(src, /已完成（撳「開始遊戲」可以重玩）/, "玩完要有第三種狀態");
  assert.match(src, /data-act="rd\.reset"/, "要有「重設流程（返第一關）」掣");
  assert.match(src, /await cmd\(`rundown\.\$\{sub\}`\)/, "rd.<sub> 要真係送 rundown command");
});

/* ───────── v04-D：問答流程（出題目／開始 30 秒作答／重設再玩） ───────── */

/** 造 n 張 quiz 卡（預設 draft）：最後一張係 open 題 */
function putQuizCards(store, n = 3) {
  const cards = [];
  for (let i = 1; i <= n; i++) {
    const card = {
      id: `q${i}`,
      type: i === n ? "open" : "choice",
      gameId: "quiz",
      prompt: `第 ${i} 題題目（測試）`,
      seconds: 30,
      points: 1,
      version: 1,
      state: "draft",
    };
    if (card.type === "choice") {
      card.options = ["甲", "乙", "丙", "丁"];
      card.correct = 0;
    } else {
      card.openKind = "number";
      card.tolerance = 0;
    }
    cards.push(card);
    store.commit([{ t: "card.put", d: { card } }]);
  }
  return cards;
}

function putLedgerEvent(store, event) {
  store.commit([{
    t: "ledger.append",
    d: {
      events: [{
        id: event.id,
        ts: Date.now(),
        target: { type: "player", id: event.playerId ?? "p1" },
        delta: event.delta ?? 1,
        reason: event.reason ?? "test",
        by: event.by ?? "auto",
        ...(event.gameId ? { gameId: event.gameId } : {}),
        ...(event.cardId ? { cardId: event.cardId } : {}),
      }],
    },
  }]);
}

test("v04-D・quiz.show：大mon 只出題目（唔開 round、唔出選項、唔倒數）", () => {
  const { store } = makeStore("d-quiz-show");
  addPlayers(store, 3);
  run(store, "room.start");
  putQuizCards(store, 3);

  const res = run(store, "quiz.show");
  assert.equal(res.ok, true);
  assert.equal(store.state.room.stage.mode, "question", "大mon 要轉 question mode");
  assert.equal(store.state.room.stage.payload.showOptions, false, "payload 要標明唔出選項");
  assert.equal(store.state.room.currentRoundId, null, "quiz.show 唔准開 round");

  const v = buildStageView(store);
  assert.equal(v.question.cardId, "q1");
  assert.equal(v.question.prompt, "第 1 題題目（測試）");
  assert.equal(v.question.preview, true, "preview：未開 round");
  assert.equal(v.question.showOptions, false);
  assert.equal(v.question.endsAt, null, "preview 冇倒數");
  assert.equal(v.question.options, undefined, "preview 唔准帶選項");
  assert.equal(v.question.roundId, "", "preview 冇 roundId");

  // 手機乜都唔變：冇 task ＝冇選項可以答
  const pv = buildPlayerView(store, "p1");
  assert.equal(pv.task, null);
  assert.equal(pv.mode, "question");
});

test("v04-D・quiz.show 跟 rundown 次序揀下一題（跳過已揭曉／已出）", () => {
  const { store } = makeStore("d-quiz-show-next");
  addPlayers(store, 2);
  run(store, "room.start");
  putQuizCards(store, 3);
  // 主持改過次序：q3 → q1 → q2
  putRundownItem(store, { id: "rd_q", index: 0, gameId: "quiz", title: "第 4 關・問答", state: "running", cardIds: ["q3", "q1", "q2"], rulesText: "" });
  store.commit([{ t: "card.update", d: { cardId: "q3", patch: { state: "revealed" } } }]);

  run(store, "quiz.show");
  assert.equal(store.state.room.stage.payload.cardId, "q1", "跟 rundown 次序跳過 revealed 嘅 q3");

  // 明確指定邊一題（dropdown 跳題）
  const jump = run(store, "quiz.show", {}, "q3");
  assert.equal(jump.ok, true);
  assert.equal(store.state.room.stage.payload.cardId, "q3", "要可以直接跳去任何一題");
  assert.equal(store.state.room.stage.payload.showOptions, false);
});

test("v04-D・quiz.show 全部出完：清楚報錯（唔會靜靜 fail）", () => {
  const { store } = makeStore("d-quiz-show-done");
  addPlayers(store, 2);
  run(store, "room.start");
  putQuizCards(store, 2);
  store.commit([{ t: "card.update", d: { cardId: "q1", patch: { state: "revealed" } } }]);
  store.commit([{ t: "card.update", d: { cardId: "q2", patch: { state: "revealed" } } }]);
  assert.throws(() => run(store, "quiz.show"), isCmdError("W_ALREADY_STATE", /重設問答/));
});

test("v04-D・quiz.open：開 round、卡轉 open、30 秒倒數、大mon 出選項", () => {
  const { store } = makeStore("d-quiz-open");
  addPlayers(store, 3);
  run(store, "room.start");
  putQuizCards(store, 3);
  run(store, "quiz.show"); // 主持先讀題

  const t0 = Date.now();
  const res = run(store, "quiz.open");
  assert.equal(res.ok, true);
  const round = store.currentRound();
  assert.ok(round, "要開 round");
  assert.equal(round.state, "open");
  assert.equal(round.cardId, "q1");
  assert.equal(store.card("q1").state, "open");
  assert.equal(store.state.room.stage.mode, "question");
  assert.notEqual(store.state.room.stage.payload.showOptions, false, "開卷之後要出選項");
  const left = round.endsAt - t0;
  assert.ok(left >= 29_000 && left <= 31_500, `endsAt 應該係 30 秒後（實際 ${left}ms）`);

  const v = buildStageView(store);
  assert.equal(v.question.preview, false);
  assert.equal(v.question.showOptions, true);
  assert.deepEqual(v.question.options, ["甲", "乙", "丙", "丁"], "大mon 要出 4 個選項");
  assert.ok(v.question.endsAt > Date.now());
  assert.equal(v.question.roundId, round.id);

  // 手機出得選項（task 有 options）
  const pv = buildPlayerView(store, "p1");
  assert.equal(pv.task.roundId, round.id);
  assert.equal(pv.task.kind, "choice");
  assert.deepEqual(pv.task.options, ["甲", "乙", "丙", "丁"]);
});

test("v04-D・quiz.open 同一題已經開緊：唔會彈 W_ALREADY_STATE（亦唔會開多個 round）", () => {
  const { store } = makeStore("d-quiz-open-idem");
  addPlayers(store, 2);
  run(store, "room.start");
  putQuizCards(store, 2);
  run(store, "quiz.open");
  const first = store.currentRound().id;
  const count = store.state.room.rounds.length;

  const again = run(store, "quiz.open");
  assert.equal(again.ok, true);
  assert.equal(store.currentRound().id, first, "round 唔可以換");
  assert.equal(store.state.room.rounds.length, count, "唔可以開多個 round");
  assert.equal(again.result.alreadyOpen, true);
  assert.notEqual(store.state.room.stage.payload.showOptions, false, "要推返答題畫面");
});

test("v04-D・quiz.open 已 revealed 嘅卡：清楚報錯（唔會靜靜開新 round）", () => {
  const { store } = makeStore("d-quiz-open-revealed");
  addPlayers(store, 2);
  run(store, "room.start");
  putQuizCards(store, 2);
  store.commit([{ t: "card.update", d: { cardId: "q1", patch: { state: "revealed" } } }]);
  const before = store.state.room.rounds.length;
  assert.throws(() => run(store, "quiz.open", {}, "q1"), isCmdError("W_ALREADY_STATE", /重設問答/));
  assert.equal(store.state.room.rounds.length, before, "被拒就一筆 round 都唔准開");
  assert.equal(store.currentRoundId ?? store.state.room.currentRoundId, null);
});

test("v04-D・quiz.open：仲有回合未完成／唔係 playing phase 會清楚報錯", () => {
  const { store } = makeStore("d-quiz-open-guard");
  addPlayers(store, 2);
  // 未開始遊戲：open 要報 phase 錯（唔好開到半個 round）
  putQuizCards(store, 2);
  assert.throws(() => run(store, "quiz.open"), isCmdError("W_WRONG_PHASE"));
  assert.equal(store.state.room.currentRoundId, null);

  run(store, "room.start");
  store.commit([{ t: "card.update", d: { cardId: "q1", patch: { state: "open" } } }]);
  store.commit([{ t: "card.update", d: { cardId: "q2", patch: { state: "open" } } }]);
  // 收咗卷（closed）但未揭曉：指定同一題再開 → 清楚報錯（要先 reveal／重設）
  const round = { id: "q1#1", cardId: "q1", cardVersion: 1, endsAt: null, closedAt: Date.now(), state: "closed", eligiblePlayerIds: [] };
  store.commit([{ t: "round.put", d: { round, currentRoundId: round.id } }]);
  assert.throws(() => run(store, "quiz.open", {}, "q1"), isCmdError("W_ALREADY_STATE", /收咗卷|揭曉/));
  assert.equal(store.currentRound().id, "q1#1", "被拒之後 currentRound 唔可以變");
  // 指定「另一題」→ 舊題作廢（唔派分）＋開新題，主持唔會卡死
  const switched = run(store, "quiz.open", {}, "q2");
  assert.equal(switched.ok, true);
  assert.equal(store.round("q1#1").state, "void", "未揭曉嘅舊題作廢");
  assert.equal(store.currentRound().cardId, "q2");
});

test("v04-D・P1-1：開卷中跳去別題再撳「開始 30 秒作答」→ 舊題作廢、開新題（唔會卡死）", () => {
  const { store } = makeStore("d-quiz-open-return");
  addPlayers(store, 2);
  run(store, "room.start");
  putQuizCards(store, 4);
  run(store, "quiz.open"); // q1 開卷
  const openRoundId = store.currentRound().id;
  assert.equal(store.card("q1").state, "open");

  // 主持開卷中撳「出題目」睇 q3：q1 要即刻收卷（手機唔可以再答上一題）
  run(store, "quiz.show", {}, "q3");
  assert.equal(store.state.room.stage.payload.cardId, "q3");
  assert.equal(store.round(openRoundId).state, "closed", "跳題要收卷");
  assert.equal(store.card("q1").state, "closed");

  // 再撳「開始 30 秒作答」（client 會帶大mon 嗰張卡＝q3）→ 唔准 throw，要開到 q3
  const res = run(store, "quiz.open");
  assert.equal(res.ok, true, "開卷中撳『開始作答』唔可以 throw（主持會卡死）");
  assert.equal(store.round(openRoundId).state, "void", "未揭曉嘅舊題要作廢（唔派分）");
  assert.equal(store.currentRound().cardId, "q3", "要開大mon 而家 show 緊嗰題");
  assert.equal(store.card("q3").state, "open");
  assert.notEqual(store.state.room.stage.payload.showOptions, false, "要有選項＋倒數");
  // 作廢唔會派分
  assert.equal(store.state.ledger.filter((e) => e.roundId === openRoundId && !e.voided).length, 0);

  // 同一題已收卷未揭曉 → 再撳「開始作答」要清楚報錯，唔好靜靜開多個 round
  run(store, "card.close");
  const before = store.state.room.rounds.length;
  assert.throws(() => run(store, "quiz.open", {}, "q3"), isCmdError("W_ALREADY_STATE", /收咗卷|揭曉/));
  assert.equal(store.state.room.rounds.length, before, "唔可以開多個 round");
});

test("v04-D・quiz.reset：13 張 quiz 卡返 draft、currentRoundId 清空、其他關卡唔受影響", () => {
  const { store } = makeStore("d-quiz-reset");
  addPlayers(store, 3);
  run(store, "room.start");
  putQuizCards(store, 13);
  // 其他 gameId 嘅卡／round 唔可以受影響
  putCard(store, { id: "draw_1", type: "choice", gameId: "draw", prompt: "畫畫題", options: ["A", "B"], correct: 0, state: "revealed" });
  putCard(store, { id: "bid_1", type: "bid", gameId: "auction", prompt: "估歌", maxBid: 10, seconds: 10, state: "revealed" });

  // 出到第 5 題＋已揭曉（模擬「run 咗一次就冇得再玩」嘅狀態）
  for (let i = 1; i <= 5; i++) run(store, "quiz.open", {}, `q${i}`), run(store, "card.close"), run(store, "card.reveal");
  assert.equal(store.currentRound().state, "revealed");
  assert.equal(store.quizCards().filter((c) => c.state === "draft").length, 8);
  // 再開一題（未完成 round）→ reset 要 void 佢
  run(store, "quiz.open", {}, "q6");
  assert.equal(store.currentRound().cardId, "q6");

  const res = run(store, "quiz.reset");
  assert.equal(res.ok, true);
  assert.equal(store.state.room.currentRoundId, null, "currentRoundId 要清空");
  for (const card of store.quizCards()) assert.equal(card.state, "draft", `${card.id} 要返 draft`);
  assert.equal(store.quizCards().length, 13);
  const voided = store.state.room.rounds.filter((r) => r.cardId.startsWith("q") && r.state === "void");
  assert.ok(voided.length >= 1, "未完成嘅 quiz round 要 void（q6 嗰個）");
  // 其他關卡完全唔郁
  assert.equal(store.card("draw_1").state, "revealed");
  assert.equal(store.card("bid_1").state, "revealed");
  assert.equal(store.state.room.stage.mode, "idle", "大mon 由問答畫面返 idle");
  // 重設之後真係再玩到
  const again = run(store, "quiz.open", {}, "q1");
  assert.equal(again.ok, true);
  assert.equal(store.card("q1").state, "open");
});

test("v04-D・quiz.reset clearScores：只 void quiz 分，其他 gameId 一分都唔郁", () => {
  const { store } = makeStore("d-quiz-reset-scores");
  addPlayers(store, 3);
  run(store, "room.start");
  putQuizCards(store, 13);
  putLedgerEvent(store, { id: "ev_quiz_1", playerId: "p1", delta: 3, gameId: "quiz", cardId: "q1" });
  putLedgerEvent(store, { id: "ev_quiz_2", playerId: "p2", delta: 2, gameId: "quiz", cardId: "q12" });
  putLedgerEvent(store, { id: "ev_draw", playerId: "p1", delta: 5, gameId: "draw", cardId: "draw_1" });
  putLedgerEvent(store, { id: "ev_auction", playerId: "p2", delta: 4, gameId: "auction", cardId: "bid_1" });
  putLedgerEvent(store, { id: "ev_other", playerId: "p3", delta: 7, gameId: "killer" });

  run(store, "quiz.reset", { clearScores: true });
  const ev = (id) => store.state.ledger.find((e) => e.id === id);
  assert.equal(ev("ev_quiz_1").voided, true);
  assert.equal(ev("ev_quiz_2").voided, true);
  assert.ok(!ev("ev_draw").voided, "畫畫分唔准郁");
  assert.ok(!ev("ev_auction").voided, "估歌分唔准郁");
  assert.ok(!ev("ev_other").voided, "笨蛋殺手分唔准郁");
  assert.equal(store.playerScore("p1"), 5, "p1 淨返畫畫 5 分");
  assert.equal(store.playerScore("p2"), 4, "p2 淨返估歌 4 分");
  assert.equal(store.playerScore("p3"), 7);
});

test("v04-D・quiz.reset 唔清分（clearScores:false）：ledger 一筆都唔 void", () => {
  const { store } = makeStore("d-quiz-reset-keep");
  addPlayers(store, 2);
  run(store, "room.start");
  putQuizCards(store, 4);
  putLedgerEvent(store, { id: "ev_quiz_keep", playerId: "p1", delta: 3, gameId: "quiz", cardId: "q1" });
  run(store, "quiz.reset", { clearScores: false });
  assert.ok(!store.state.ledger.find((e) => e.id === "ev_quiz_keep").voided);
  assert.equal(store.playerScore("p1"), 3);
});

test("v04-D・大mon／手機 gating：只出題目階段唔會出選項、冇題目都唔會炸", () => {
  const stageSrc = fs.readFileSync(path.join(APP_ROOT, "src/client/stage.ts"), "utf8");
  // questionHtml 要有 preview 分支（唔出選項、唔倒數）＋ null 安全 placeholder
  assert.match(stageSrc, /q\.preview === true \|\| q\.showOptions === false/, "要有 preview／showOptions gating");
  assert.match(stageSrc, /等主持開始作答…/, "preview 要寫住等主持開始");
  const fn = stageSrc.slice(stageSrc.indexOf("function questionHtml"), stageSrc.indexOf("function tallyHtml"));
  assert.match(fn, /if \(!q\) return placeholder\(/, "冇 v.question 唔准 throw（大mon 出佔位）");
  assert.match(fn, /等主持出題…/, "冇題目要出友善 placeholder");

  const playSrc = fs.readFileSync(path.join(APP_ROOT, "src/client/play.ts"), "utf8");
  assert.match(playSrc, /v\.mode === "question" && !v\.task && !v\.mySubmission/, "手機只喺有 round 時出選項");
  assert.match(playSrc, /等主持開始作答/, "手機要等主持開始");

  const hostSrc = fs.readFileSync(path.join(APP_ROOT, "src/client/host.ts"), "utf8");
  // qa.question 唔再自動開 round（跟 D5）
  const qaIdx = hostSrc.indexOf('if (sub === "question")');
  const qaBlock = hostSrc.slice(qaIdx, qaIdx + 700);
  assert.match(qaBlock, /cmd\("quiz\.show"/, "qa.question 要變成 quiz.show（唔再自動開 round）");
  assert.ok(!/card\.open/.test(qaBlock), "qa.question 唔准再自動 card.open");
  assert.match(hostSrc, /題目監控|問答進度：已出/, "主持台要有題目進度／下一題監控");
  assert.match(hostSrc, /id="quiz-jump"/, "要有 dropdown 跳題");
  assert.match(hostSrc, /id="quiz-clearscores"/, "要有『順便清走問答分』checkbox");
});

/* ───────── v0.4.1 整合修正（codex audit A／B 嘅 findings） ───────── */

test("I1：stage.qr 係逃生門——大mon 鎖定時仍然返得去 QR", () => {
  const { store } = aSetup("i1-qr");
  run(store, "room.start");
  run(store, "stage.lock", { lock: true });
  // 普通 stage.set 照舊要被擋
  assert.throws(() => run(store, "stage.set", { mode: "idle" }), isCmdError("W_STAGE_LOCKED", /大mon 已鎖定/));
  // 但緊急逃生門要通
  const qr = run(store, "stage.qr");
  assert.equal(qr.ok, true, "stage.qr 唔應該被 lock 擋");
  assert.equal(store.state.room.stage.mode, "idle", "大mon 要返到 QR／入場頁");
  assert.equal(store.state.room.stage.lock, true, "唔可以順手解鎖（主持自己決定）");
});

test("I2：rundown.reset 會清走各關局面（唔會殘留舊一圖多人局擋住重玩）", () => {
  const { store } = ucSetup("i2-reset-state", 6);
  const started = run(store, "uc.match.start", { undercoverCount: 2 });
  assert.equal(started.ok, true);
  assert.ok(store.state.room.gameState?.undercover, "先要有進行中嘅一圖多人局");
  const reset = run(store, "rundown.reset");
  assert.equal(reset.ok, true);
  assert.equal(store.state.room.gameState?.undercover ?? null, null, "重設流程要清走 undercover 局");
  // 清咗之後即刻可以再開新一局（唔會再 W_ALREADY_STATE）
  const again = run(store, "uc.match.start", { undercoverCount: 2 });
  assert.equal(again.ok, true, `重設流程之後要開得返新局：${JSON.stringify(again)}`);
});

test("I3：由 final 重新開始 → 大mon 一定要出第一關規則頁（唔好跳去 idle）", () => {
  const { store } = aSetup("i3-final-start");
  run(store, "room.start");
  // 直接用 room.phase 去 final，令 currentItem 仍然係第一關（codex audit A 重現嘅情境）
  const fin = run(store, "room.phase", { phase: "final" });
  assert.equal(fin.ok, true);
  const restart = run(store, "room.start");
  assert.equal(restart.ok, true);
  assert.equal(store.currentItem()?.id, "rd_draw", "要返第一關");
  assert.equal(store.state.room.stage.mode, "rules", "同 gameId 重入都要出規則頁（唔好 idle）");
});

test("I4：有進行中一圖多人局時，舊 undercover.start 要跟局（排除出局者＋寫 st.roundId）", () => {
  const { store } = ucSetup("i4-legacy-start", 6);
  const started = run(store, "uc.match.start", { undercoverCount: 2 });
  assert.equal(started.ok, true);
  const st0 = store.state.room.gameState.undercover;
  const victim = st0.participantIds[0];
  st0.eliminatedIds = [victim];
  store.commit([{ t: "game.set", d: { gameState: { undercover: st0 } } }]);
  const legacy = run(store, "undercover.start", { durationSeconds: 10 });
  assert.equal(legacy.ok, true, JSON.stringify(legacy));
  const round = store.currentRound();
  assert.ok(round, "要有新 round");
  assert.ok(!round.eligiblePlayerIds.includes(victim), "已出局者唔可以再做候選／選民");
  assert.equal(store.state.room.gameState.undercover.roundId, round.id, "要寫返 st.roundId，主持台才認得結果");
  assert.equal(round.cardId, "card_ucmatch", "要重用一圖多人投票卡");
  // 之後主持台嘅 foul 流程唔會 W_WRONG_PHASE
  assert.ok(store.card(round.cardId), "投票卡要存在");
});

test("I5：舊 undercover.start 喺本局已結算時要清楚報錯（唔好開出一個孤兒 round）", () => {
  const { store } = ucSetup("i5-legacy-settled", 6);
  run(store, "uc.match.start", { undercoverCount: 2 });
  const st = store.state.room.gameState.undercover;
  st.settled = true;
  st.result = "good";
  store.commit([{ t: "game.set", d: { gameState: { undercover: st } } }]);
  assert.throws(() => run(store, "undercover.start", { durationSeconds: 10 }), isCmdError("W_ALREADY_STATE", /已結算/));
  assert.ok(!store.currentRound(), "唔可以靜靜開一個孤兒 round");
});

/* ───────── v0.4.1 整合第二輪修正（codex audit INT 嘅 findings） ───────── */

/** 直接淘汰晒所有臥底再結算（唔使模擬 3 題投票流程，專測計分去重） */
function forceSettleGood(store) {
  const st = JSON.parse(JSON.stringify(store.state.room.gameState.undercover));
  st.eliminatedIds = [...st.undercoverIds];
  store.commit([{ t: "game.set", d: { gameState: { undercover: st } } }]);
  return run(store, "uc.match.settle");
}

test("J1：重設流程 → 再開一局 → 再結算，分數要照派（唔會同上一局撞 id 而漏分）", () => {
  const { store } = ucSetup("j1-reset-resettle", 6);
  run(store, "uc.match.start");
  const first = forceSettleGood(store);
  assert.equal(first.ok, true);
  const after1 = store.state.ledger.filter((e) => e.gameId === "draw" && !e.voided).length;
  assert.ok(after1 >= 4, `第一局要有分（實際 ${after1}）`);

  run(store, "rundown.reset");
  run(store, "uc.match.start");
  const second = forceSettleGood(store);
  assert.equal(second.ok, true);
  const after2 = store.state.ledger.filter((e) => e.gameId === "draw" && !e.voided).length;
  assert.equal(after2 - after1, after1, `第二局要再派同樣數量嘅分（${after1} → ${after2}）`);

  // 同一局重複結算仍然要冪等
  const again = run(store, "uc.match.settle");
  assert.equal(again.ok, true);
  const after3 = store.state.ledger.filter((e) => e.gameId === "draw" && !e.voided).length;
  assert.equal(after3, after2, "同一局重複結算唔可以再加分");
});

test("J2：quiz.show 跳題時，場上開緊嘅 quiz round 要先收卷（手機唔可以再答上一題）", () => {
  const { store } = makeStore("j2-show-closes");
  const players = addPlayers(store, 3);
  run(store, "room.start");
  putQuizCards(store, 3);
  run(store, "quiz.show", undefined, "q1");
  const opened = run(store, "quiz.open", undefined, "q1");
  assert.equal(opened.ok, true);
  const roundId = store.state.room.currentRoundId;
  assert.ok(roundId, "要有開住嘅 round");

  const show2 = run(store, "quiz.show", undefined, "q2");
  assert.equal(show2.ok, true);
  const round = store.round(roundId);
  assert.equal(round.state, "closed", "跳題要順手收卷（唔評分）");
  assert.equal(store.state.room.currentRoundId, roundId, "currentRound 唔變（分佈／答案仲用返呢個 round）");
  assert.equal(store.state.room.stage.mode, "question");
  assert.equal(store.state.room.stage.payload.showOptions, false);
  // 手機唔應該再有 task
  const pv = buildPlayerView(store, players[0].id);
  assert.ok(!pv.task, `手機唔可以再見上一題選項：${JSON.stringify(pv.task)}`);
});

test("J3：quiz.show 遇到非問答回合（競投／投票）要清楚報錯，唔好偷走人哋回合", () => {
  const { store } = makeStore("j3-show-bid-guard");
  addPlayers(store, 3);
  run(store, "room.start");
  putQuizCards(store, 2);
  putCard(store, { id: "bid_x", type: "bid", gameId: "auction", prompt: "聽幾秒估歌名", maxBid: 10, state: "draft" });
  run(store, "card.open", {}, "bid_x");
  assert.throws(() => run(store, "quiz.show", undefined, "q1"), isCmdError("W_ALREADY_STATE", /競投|投票/));
});

test("J4：quiz.reset 清走 Q13 類型嘅即場答案，但保留 Q12 固定參考答案／容差", () => {
  const { store } = makeStore("j4-reset-actual");
  addPlayers(store, 3);
  run(store, "room.start");
  putQuizCards(store, 2);
  // 模擬主持入過 Q13 真實答案（動態）＋ Q12 固定 40 尺 ±2
  run(store, "card.update", { patch: { actualAnswer: 37 } }, "q2");
  run(store, "card.update", { patch: { referenceAnswer: 40, tolerance: 2 } }, "q1");
  assert.equal(store.card("q2").actualAnswer, 37, "先要有動態答案");
  const reset = run(store, "quiz.reset");
  assert.equal(reset.ok, true);
  assert.equal(store.card("q2").actualAnswer, undefined, "重設要清走即場答案（唔好攞上一局個數評分）");
  assert.equal(store.card("q1").referenceAnswer, 40, "固定參考答案要保留");
  assert.equal(store.card("q1").tolerance, 2, "容差要保留");
});

test("J5：quiz.show 冇指定題目（撳「出題目」掣）而家答緊題 → 擋住，唔會誤收卷", () => {
  const { store } = makeStore("j5-show-noarg-guard");
  addPlayers(store, 2);
  run(store, "room.start");
  putQuizCards(store, 3);
  const opened = run(store, "quiz.open", {}, "q1");
  assert.equal(opened.ok, true);
  const rid = store.state.room.currentRoundId;
  assert.throws(() => run(store, "quiz.show"), isCmdError("W_ALREADY_STATE", /答緊題|dropdown/));
  assert.equal(store.round(rid).state, "open", "唔可以靜靜收卷");
  assert.equal(store.state.room.stage.payload.cardId, "q1");
  // 明確揀題（dropdown）就照舊可以跳，並會先收卷（唔評分）
  const jump = run(store, "quiz.show", {}, "q3");
  assert.equal(jump.ok, true);
  assert.equal(store.round(rid).state, "closed");
  assert.equal(store.state.room.stage.payload.cardId, "q3");
});
