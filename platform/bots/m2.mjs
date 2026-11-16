#!/usr/bin/env node
/**
 * m2.mjs — M2 驗收：歌單／bid 卡（密封）／media deck＋AudioLease（PLAN-v3.1 §5.1／§8.2／§10 M2）
 * 用法：BASE=http://127.0.0.1:3000 PIN=xxxxxx node bots/m2.mjs
 * 建議 server env（加快測試）：LEASE_TTL_MS=2000 LEASE_TAKEOVER_MARGIN_MS=1500 AUDIO_READY_TIMEOUT_MS=1500
 */
import WebSocket from "ws";

const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const PIN = process.env.PIN ?? "";
const N = Number(process.env.BOTS_PLAYERS ?? 30);
const TTL = Number(process.env.LEASE_TTL_MS ?? 2000);
const MARGIN = Number(process.env.LEASE_TAKEOVER_MARGIN_MS ?? 1500);
const READY_TIMEOUT = Number(process.env.AUDIO_READY_TIMEOUT_MS ?? 1500);
const results = [];
function pass(n, d) { results.push({ name: n, ok: true, detail: d }); console.log(`[PASS] ${n} — ${d}`); }
function fail(n, d) { results.push({ name: n, ok: false, detail: d }); console.log(`[FAIL] ${n} — ${d}`); }
function check(n, c, d) { c ? pass(n, d) : fail(n, d); return c; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function req(p, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(BASE + p, { method: opts.method ?? "GET", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}
async function hostCmd(token, kind, targetId, payload = {}) {
  const body = { commandId: crypto.randomUUID(), kind, payload };
  if (targetId) body.targetId = targetId;
  return (await req("/api/host/command", { method: "POST", token, body })).json;
}
async function snap(token) { return (await req("/api/host/snapshot", { token })).json.view; }
async function waitFor(fn, timeout = 8000, step = 60) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await fn()) return Date.now() - t0; await sleep(step); }
  return -1;
}
class Client {
  constructor(name, role) { this.name = name; this.role = role; this.view = null; this.results = []; this.seq = -1; }
  connect(code, token) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/ws", { origin: BASE });
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error(this.name + " timeout")), 8000);
      ws.on("open", () => ws.send(JSON.stringify({ type: "hello", role: this.role, code, sessionToken: token, clientInstanceId: this.name + Math.random().toString(36).slice(2) })));
      ws.on("message", (buf) => {
        const m = JSON.parse(String(buf));
        if (m.type === "hello.ok") { clearTimeout(timer); resolve(m); }
        else if (m.type === "snapshot") { this.view = m.view; this.seq = m.seq; }
        else if (m.type === "patch") {
          if (m.baseSeq !== this.seq) { ws.send(JSON.stringify({ type: "resync", lastSeq: this.seq })); return; }
          this.seq = m.seq;
          for (const op of m.ops ?? []) { if (op.op === "view") this.view = op.view; else if (op.op === "section") this.view[op.name] = op.value; }
        } else if (m.type === "submit.result") this.results.push(m);
      });
    });
  }
  send(o) { this.ws?.send(JSON.stringify(o)); }
  submit(roundId, payload) { this.send({ type: "submit", roundId, submissionId: crypto.randomUUID(), payloadHash: "m2", payload }); }
  close() { try { this.ws?.close(); } catch { /* ignore */ } }
}
function mp3Buffer() {
  const id3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const frame = Buffer.alloc(417);
  frame[0] = 0xff; frame[1] = 0xfb; frame[2] = 0x90; frame[3] = 0x64;
  return Buffer.concat([id3, frame, frame, frame]);
}
async function uploadMp3(token, title) {
  const fd = new FormData();
  fd.append("kind", "audio");
  fd.append("title", title);
  fd.append("file", new Blob([mp3Buffer()], { type: "audio/mpeg" }), "test.mp3");
  const res = await fetch(BASE + "/api/host/upload", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function main() {
  const ready = (await req("/api/ready")).json;
  const code = ready.roomCode;
  console.log(`[info] BASE=${BASE} roomCode=${code} TTL=${TTL} MARGIN=${MARGIN} READY_TIMEOUT=${READY_TIMEOUT}`);
  const h1 = (await req("/api/host/login", { method: "POST", body: { pin: PIN, hostName: "M2Host1" } })).json;
  const h2 = (await req("/api/host/login", { method: "POST", body: { pin: PIN, hostName: "M2Host2" } })).json;
  if (!h1?.ok || !h2?.ok) throw new Error("host login 失敗");
  const token = h1.hostToken;
  for (const p of (await snap(token)).players ?? []) await hostCmd(token, "player.kick", p.id, {});
  const players = [];
  for (let i = 1; i <= N; i++) {
    const j = (await req("/api/join", { method: "POST", body: { code, name: `M2Bot${String(i).padStart(2, "0")}`, avatar: { kind: "emoji", emoji: "🐶", color: "#3b82f6" } } })).json;
    if (!j?.ok) throw new Error("join 失敗");
    players.push(j);
    await hostCmd(token, "player.approve", j.playerId, {});
  }
  const hc1 = new Client("M2H1", "host");
  const hc2 = new Client("M2H2", "host");
  const stage = new Client("M2Stage", "stage");
  const pcs = players.map((p, i) => new Client("M2P" + i, "player"));
  await Promise.all([hc1.connect(code, h1.hostToken), hc2.connect(code, h2.hostToken), stage.connect(code), ...pcs.map((c, i) => c.connect(code, players[i].playerToken))]);
  await hostCmd(token, "settings.set", undefined, { autoClose: false });
  await hostCmd(token, "room.start");

  /* ── 歌單 ── */
  const draft = await hostCmd(token, "song.upsert", undefined, { song: { title: "未齊 Link 嘅歌" } });
  const withLink = await hostCmd(token, "song.upsert", undefined, { song: { title: "YouTube 歌", url: "https://youtu.be/abc123" } });
  const uploaded = await uploadMp3(token, "測試 MP3 歌");
  await sleep(200);
  const s1 = await snap(token);
  const draftSong = s1.songs.find((s) => s.id === draft.result?.id);
  const linkSong = s1.songs.find((s) => s.id === withLink.result?.id);
  const fileSong = uploaded.json?.song;
  check("M2① 歌單：先入名 draft、link ready、MP3 上傳入庫", draftSong?.state === "draft" && linkSong?.state === "ready" && linkSong?.source?.kind === "youtube" && uploaded.json?.ok && fileSong?.source?.kind === "file", `draft=${draftSong?.state} link=${linkSong?.state} upload=${uploaded.status}`);
  const fakeFd = new FormData();
  fakeFd.append("kind", "audio");
  fakeFd.append("file", new Blob([Buffer.from("not an mp3 at all")], { type: "audio/mpeg" }), "fake.mp3");
  const fake = await fetch(BASE + "/api/host/upload", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fakeFd });
  const fakeJson = await fake.json().catch(() => null);
  check("M2① 上傳 magic bytes 驗證（假 MP3 被拒 W_UPLOAD_REJECTED）", fakeJson?.code === "W_UPLOAD_REJECTED", `code=${fakeJson?.code}`);

  /* ── AudioLease：非持有者拒、preparing 唔可以覆寫、ready ACK、window 自動停 ── */
  const deckA = "deckA", deckB = "deckB";
  const acquireA = await hostCmd(token, "lease.acquire", undefined, { deckId: deckA });
  const playByB = await hostCmd(h2.hostToken, "media.play", fileSong.id, { songId: fileSong.id, deckId: deckB });
  check("M2⑤ 非 lease 持有者 play → W_NO_AUDIO_LEASE", acquireA?.ok && playByB?.code === "W_NO_AUDIO_LEASE", `code=${playByB?.code}`);
  const playA = await hostCmd(token, "media.play", fileSong.id, { songId: fileSong.id, deckId: deckA, window: [0, 800] });
  await sleep(120);
  const preparing = (await snap(token)).playback;
  const playAgain = await hostCmd(token, "media.play", fileSong.id, { songId: fileSong.id, deckId: deckA, window: [0, 800] });
  check("M2⑤ preparing／playing 時再 play 被拒（W_ALREADY_STATE，防覆寫）", playA?.ok && preparing?.state === "preparing" && playAgain?.code === "W_ALREADY_STATE", `code=${playAgain?.code}`);
  hc1.send({ type: "deck.ready", deckId: deckA, songId: fileSong.id, positionMs: 0 });
  const playingMs = await waitFor(async () => (await snap(token)).playback?.state === "playing", 4000);
  check("M2④ deck.ready ACK 後 server 才落 playStartedAt", playingMs >= 0, `playing in ${playingMs}ms`);
  const winPaused = await waitFor(async () => (await snap(token)).playback?.state === "paused" && (await snap(token)).playback?.positionMs >= 800, 3000, 100);
  check("M2④/P1「播 15 秒」真承諾：window 到期 server 自動 pause（唔使主持手動）", winPaused >= 0, `auto-paused in ${winPaused}ms positionMs=${(await snap(token)).playback?.positionMs}`);
  // 再次播放（paused 可以再 play）
  await hostCmd(token, "media.play", fileSong.id, { songId: fileSong.id, deckId: deckA, fromStart: true, window: [0, 15000] });
  await sleep(120);
  hc1.send({ type: "deck.ready", deckId: deckA, songId: fileSong.id, positionMs: 0 });
  await waitFor(async () => (await snap(token)).playback?.state === "playing", 4000);
  const songMode = stage.view;
  const stageSnapBeforeReveal = (await req("/api/stage/snapshot")).json;
  check(
    "M2④ stage song mode 預設靜音＋reveal 前任何 mode 都唔出歌名",
    songMode?.stage?.mode === "song" && songMode?.song?.title === null && !JSON.stringify(stageSnapBeforeReveal).includes("測試 MP3 歌"),
    `mode=${songMode?.stage?.mode} songTitle=${songMode?.song?.title} titleLeak=${JSON.stringify(stageSnapBeforeReveal).includes("測試 MP3 歌")}`,
  );

  /* ── 在線接管（forceOnline）+ ACK 行為；失聯接管 margin ── */
  const tTake = Date.now();
  const acquireB = await hostCmd(h2.hostToken, "lease.acquire", undefined, { deckId: deckB, forceOnline: true });
  const oldStopped = await waitFor(() => hc1.view?.playback?.state === "paused" || hc1.view?.audioLease?.deckId !== deckA, 2000, 50);
  const oldPause = await hostCmd(token, "media.pause", undefined, { deckId: deckA });
  const s4 = await snap(token);
  check(
    "M2⑤ 在線接管：forceOnline、generation+1、舊 deck 2 秒內停、舊指令被拒",
    acquireB?.ok && acquireB.result?.generation > acquireA.result?.generation && oldStopped >= 0 && oldPause?.code === "W_NO_AUDIO_LEASE" && s4.audioLease?.deckId === deckB,
    `gen ${acquireA.result?.generation}→${acquireB.result?.generation} oldStopped=${oldStopped}ms oldPause=${oldPause?.code}`,
  );
  // 舊 deck（B）斷網：forceOnline 唔准繞 margin（必須驗到舊 host 在線先准）
  hc2.close();
  await sleep(300);
  const forceOffline = await hostCmd(token, "lease.acquire", undefined, { deckId: deckA, forceOnline: true });
  check("M2 P1 forceOnline：舊 deck 唔在線 → 拒絕（W_NO_AUDIO_LEASE，唔准繞 5s margin）", forceOffline?.code === "W_NO_AUDIO_LEASE", `code=${forceOffline?.code}`);
  // lease 到期 → releasedAt；即刻接管要被 margin 擋
  const released = await waitFor(async () => !!(await snap(token)).audioLease?.releasedAt, TTL + 4000, 150);
  const tooEarly = await hostCmd(token, "lease.acquire", undefined, { deckId: deckA });
  const earlyOk = tooEarly?.code === "W_NO_AUDIO_LEASE";
  const afterMargin = await waitFor(async () => (await hostCmd(token, "lease.acquire", undefined, { deckId: deckA }))?.ok === true, MARGIN + 4000, 250);
  check(
    "M2⑤ 失聯接管：lease 到期＋5s margin 前拒絕、margin 後成功（防雙響）",
    released >= 0 && earlyOk && afterMargin >= 0,
    `released in ${released}ms early=${tooEarly?.code} margin後=${afterMargin}ms`,
  );

  /* ── W_AUDIO_READY_TIMEOUT：deck 唔 ready → failed ── */
  await hostCmd(token, "media.play", fileSong.id, { songId: fileSong.id, deckId: deckA, fromStart: true, window: [0, 15000] });
  const failedMs = await waitFor(async () => (await snap(token)).playback?.state === "failed", READY_TIMEOUT + 3000, 120);
  check("M2④ W_AUDIO_READY_TIMEOUT：deck 唔 ready → playback failed（stage 顯示等音源／失敗）", failedMs >= 0, `failed in ${failedMs}ms`);
  // YouTube 只係手動提示
  const ytPlay = await hostCmd(token, "media.play", linkSong.id, { songId: linkSong.id, deckId: deckA });
  check("M2⑧ YouTube/Apple 只係手動提示（media.play 拒絕）", ytPlay?.code === "W_BAD_SCHEMA", `code=${ytPlay?.code}`);
  // reveal 歌名（先 reset 去 playing？reveal 唔需要 lease）
  const revealSong = await hostCmd(token, "media.reveal");
  await sleep(200);
  check("M2④ 主持 reveal 之後 stage 先出歌名", revealSong?.ok && stage.view?.stage?.mode === "reveal" && stage.view?.stage?.payload?.songTitle === fileSong.title, `title=${stage.view?.stage?.payload?.songTitle}`);

  /* ── bid 卡：密封出價（stage 唔收金額）＋結算防重複 ── */
  const bidCard = await hostCmd(token, "card.create", undefined, { card: { type: "bid", gameId: "auction", prompt: "聽 15 秒，估歌名", songId: fileSong.id, maxBid: 100, seconds: 30, points: 5 } });
  const bidCardId = (await snap(token)).cards.filter((c) => c.type === "bid").at(-1)?.id;
  await hostCmd(token, "card.open", bidCardId);
  await waitFor(() => pcs.every((c) => c.view?.task?.roundId), 4000);
  const round = (await snap(token)).currentRound;
  // bid round 仲 open 時 media.play 要拒絕，唔可以搶大mon bid 畫面
  const playWhileBidOpen = await hostCmd(token, "media.play", fileSong.id, { songId: fileSong.id, deckId: deckA });
  const stageModeAfter = (await req("/api/stage/snapshot")).json?.stage?.mode;
  check("M2 P1 media.play：bid round open 期間拒絕（W_WRONG_PHASE），stage 仍然係 bid", playWhileBidOpen?.code === "W_WRONG_PHASE" && stageModeAfter === "bid", `code=${playWhileBidOpen?.code} stageMode=${stageModeAfter}`);
  const over = await (async () => {
    pcs[0].submit(round.id, { kind: "bid", amount: 120 });
    await sleep(220);
    return pcs[0].results.at(-1);
  })();
  check("M2① maxBid 驗證：超額出價被拒", over?.status === "rejected" && over?.code === "W_BAD_SCHEMA", `status=${over?.status} code=${over?.code}`);
  const bids = [90, 90, 80, 70, 60, 50, 40, 30, 20, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22];
  for (let i = 0; i < pcs.length; i++) { pcs[i].submit(round.id, { kind: "bid", amount: bids[i] }); await sleep(10); }
  await sleep(300);
  const stageOpen = (await req("/api/stage/snapshot")).json;
  const stageOpenJson = JSON.stringify(stageOpen);
  check(
    "M2① 密封出價：bidding 階段 StageView 冇任何個別金額（bids／topBids 唔會送）",
    !stageOpenJson.includes('"bids"') && !stageOpenJson.includes('"topBids"') && stageOpen?.bid?.winnerName === null && stageOpen?.bid?.winnerAmount === null && stageOpen?.bid?.bidCount === 30 && stageOpen?.bid?.eligibleCount === 30,
    `bidCount=${stageOpen?.bid?.bidCount}/${stageOpen?.bid?.eligibleCount} hasBids=${stageOpenJson.includes('"bids"')}`,
  );
  await hostCmd(token, "card.close");
  await hostCmd(token, "stage.set", undefined, { mode: "bid" });
  await sleep(200);
  const stageClosed = (await req("/api/stage/snapshot")).json;
  const stageClosedJson = JSON.stringify(stageClosed);
  check("M2① 密封出價：收卷但未 settle 都唔會出金額", !stageClosedJson.includes('"bids"') && stageClosed?.bid?.settled === false && stageClosed?.bid?.winnerName === null, `settled=${stageClosed?.bid?.settled} winner=${stageClosed?.bid?.winnerName}`);
  const beforeSettle = await snap(token);
  const beforeScores = Object.fromEntries(beforeSettle.players.map((p) => [p.id, p.score]));
  await hostCmd(token, "stage.set", undefined, { mode: "bid" });
  const settle = await hostCmd(token, "bid.settle", undefined, { roundId: round.id, correct: true });
  await sleep(250);
  const afterSettle = await snap(token);
  const changed = afterSettle.players.filter((p) => (beforeScores[p.id] ?? 0) !== p.score);
  const winEvent = afterSettle.ledger.filter((e) => e.roundId === round.id && e.gameId === "auction" && e.by === "host" && !e.voided);
  const stageSettled = (await req("/api/stage/snapshot")).json;
  check(
    "M2② 結算：最高價得標者（同價先交者）+5、其餘 29 人分數不變",
    settle?.ok && settle.result?.winnerId === players[0].playerId && winEvent.length === 1 && winEvent[0].delta === 5 && changed.length === 1 && changed[0].id === players[0].playerId,
    `winner=${settle.result?.winnerId} delta=${winEvent[0]?.delta} changed=${changed.length}`,
  );
  check(
    "M2① settle 之後 stage 先出得標者＋金額（只一個 winnerAmount，冇其他金額）",
    stageSettled?.bid?.settled === true && stageSettled?.bid?.winnerName === "M2Bot01" && stageSettled?.bid?.winnerAmount === 90 && !JSON.stringify(stageSettled).includes('"bids"'),
    `settled=${stageSettled?.bid?.settled} winner=${stageSettled?.bid?.winnerName}/${stageSettled?.bid?.winnerAmount}`,
  );
  // 防重複結算：再 settle correct → 先 void 舊結算再派一次（總分只 +5）
  const settleAgain = await hostCmd(token, "bid.settle", undefined, { roundId: round.id, correct: true });
  await sleep(250);
  const s5 = await snap(token);
  const aliveAuction = s5.ledger.filter((e) => e.roundId === round.id && e.gameId === "auction" && e.by === "host" && !e.voided);
  const winnerScore = s5.players.find((p) => p.id === players[0].playerId).score;
  check(
    "M2 P0-1 防重複結算：同一 round 再 settle 會 void 舊結算、只保留一筆 +5（唔會雙派）",
    settleAgain?.ok && settleAgain.result?.voidedPrevious >= 1 && aliveAuction.length === 1 && winnerScore === beforeScores[players[0].playerId] + 5,
    `voidedPrevious=${settleAgain.result?.voidedPrevious} aliveEvents=${aliveAuction.length} score ${beforeScores[players[0].playerId]}→${winnerScore}`,
  );
  // 答錯＋次高補答：舊結算 void，second +3，其餘不變
  const settleBackup = await hostCmd(token, "bid.settle", undefined, { roundId: round.id, correct: false, backup: true });
  await sleep(250);
  const s6 = await snap(token);
  const backupAlive = s6.ledger.filter((e) => e.roundId === round.id && e.gameId === "auction" && e.by === "host" && !e.voided);
  check("M2② 答錯＋次高補答：舊結算 void、次高 +3、其餘不變", settleBackup?.ok && backupAlive.length === 1 && backupAlive[0].delta === 3 && backupAlive[0].target.id === players[1].playerId, `alive=${JSON.stringify(backupAlive.map((e) => [e.target.id === players[1].playerId, e.delta]))}`);
  // 答錯唔 backup：舊結算 void、冇新分
  const settleWrong = await hostCmd(token, "bid.settle", undefined, { roundId: round.id, correct: false });
  await sleep(250);
  const s7 = await snap(token);
  const noneAlive = s7.ledger.filter((e) => e.roundId === round.id && e.gameId === "auction" && e.by === "host" && !e.voided);
  check("M2② 答錯（冇 backup）：舊結算 void、冇新分（0 分）", settleWrong?.ok && noneAlive.length === 0 && settleWrong.result?.points === 0, `alive=${noneAlive.length} points=${settleWrong.result?.points}`);

  const passed = results.filter((r) => r.ok).length;
  console.log("\n===== M2 SUMMARY =====");
  console.log(JSON.stringify({ base: BASE, roomCode: code, passed, failed: results.length - passed, results }, null, 2));
  console.log(`[done] ${passed}/${results.length} passed`);
  for (const c of [hc1, hc2, stage, ...pcs]) c.close();
  process.exit(results.length === passed ? 0 : 1);
}
main().catch((e) => { console.error("[fatal]", e); process.exit(2); });
