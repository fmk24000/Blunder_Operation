/** 單元測試：journal durability、計分公式、頒獎邊界、Q14 時間題（PLAN-v3.1 §6／§3.1） */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { minutesToMidnightHK } from "../dist/server/commands.js";
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
