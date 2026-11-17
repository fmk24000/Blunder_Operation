/** 單元測試：journal durability、計分公式、頒獎邊界、Q14 時間題（PLAN-v3.1 §6／§3.1） */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import ts from "typescript";

import { minutesToMidnightHK, executeCommand, tickAutoClose, tickLeases } from "../dist/server/commands.js";
import { Store } from "../dist/server/store.js";
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

test("stage.ts：100ms tick 唔會每次重設 toast timer（只有文字變更才 showToast）", () => {
  const src = clientSrc("stage.ts");
  const start = src.indexOf("function paintTimers(): void {");
  const end = src.indexOf("function setStatus(");
  assert.ok(start >= 0 && end > start);
  const body = src.slice(start, end);
  assert.match(body, /paintToast\(view\.toast\);/, "paintTimers 要經 dedup 入口");
  assert.ok(!/showToast\(view\.toast\)/.test(body), "paintTimers 唔可以直接 showToast");
  assert.match(src, /if \(t === lastToastText\) return;/, "同一段文字唔可以重設 timer");
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

