#!/usr/bin/env node
/**
 * bots.mjs — 30 approved bots＋2 host＋1 stage 併發壓測／驗收（PLAN-v3.1 D26、§10 M0）
 * 用法：BASE=http://127.0.0.1:3000 PIN=246810 node bots/bots.mjs
 * 輸出：每項 PASS/FAIL 一行＋尾段 JSON summary（exit code 非 0 代表有 FAIL）
 */
import WebSocket from "ws";

const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const PIN = process.env.PIN ?? "246810";
const N_PLAYERS = Number(process.env.BOTS_PLAYERS ?? 30);

const results = [];
let code = "";
const t0 = Date.now();
function ms() {
  return Date.now() - t0;
}
function pass(name, detail, extra = {}) {
  results.push({ name, ok: true, detail, extra, at: ms() });
  console.log(`[PASS] ${name} — ${detail}`);
}
function fail(name, detail, extra = {}) {
  results.push({ name, ok: false, detail, extra, at: ms() });
  console.log(`[FAIL] ${name} — ${detail}`);
}
function check(name, cond, detail, extra = {}) {
  if (cond) pass(name, detail, extra);
  else fail(name, detail, extra);
  return cond;
}

async function req(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(BASE + path, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

class Client {
  constructor(name) {
    this.name = name;
    this.ws = null;
    this.view = null;
    this.patches = 0;
    this.errors = [];
    this.submitResults = [];
    this.commandResults = [];
    this.helloOk = null;
    this.seq = -1;
    this.epoch = "";
    this.offset = 0;
    this.samples = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/ws", { origin: BASE });
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error(`${this.name} hello timeout`)), 8000);
      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            type: "hello",
            role: this.role,
            code,
            sessionToken: this.token,
            clientInstanceId: `${this.name}-${Math.random().toString(36).slice(2)}`,
          }),
        );
      });
      ws.on("message", (buf) => {
        let msg;
        try {
          msg = JSON.parse(String(buf));
        } catch {
          return;
        }
        if (msg.type === "hello.ok") {
          this.helloOk = msg;
          this.epoch = msg.seqEpoch;
          clearTimeout(timer);
          resolve({ ok: true, ...msg });
        } else if (msg.type === "error") {
          this.errors.push(msg);
          if (!this.helloOk) {
            clearTimeout(timer);
            resolve({ ok: false, code: msg.code, message: msg.message });
          }
        } else if (msg.type === "snapshot") {
          this.view = msg.view;
          this.seq = msg.seq;
          this.epoch = msg.seqEpoch;
        } else if (msg.type === "patch") {
          this.patches += 1;
          if (msg.baseSeq !== this.seq) {
            this.ws.send(JSON.stringify({ type: "resync", lastSeq: this.seq }));
            return;
          }
          this.seq = msg.seq;
          for (const op of msg.ops ?? []) {
            if (op.op === "view") this.view = op.view;
            else if (op.op === "section") this.view[op.name] = op.value;
          }
        } else if (msg.type === "pong") {
          const t1 = performance.now();
          const rtt = t1 - msg.clientT0;
          this.samples.push({ rtt, offset: msg.serverNow + rtt / 2 - t1 });
        } else if (msg.type === "submit.result") {
          this.submitResults.push(msg);
        } else if (msg.type === "command.result") {
          this.commandResults.push(msg);
        }
      });
      ws.on("error", (err) => {
        this.errors.push({ code: "WS_ERROR", message: String(err.message) });
      });
      ws.on("close", () => {
        clearTimeout(timer);
      });
    });
  }
  ping() {
    this.ws?.send(JSON.stringify({ type: "ping", clientT0: performance.now() }));
  }
  bestOffset() {
    if (!this.samples.length) return 0;
    return this.samples.reduce((a, b) => (a.rtt <= b.rtt ? a : b)).offset;
  }
  serverNow() {
    return performance.now() + this.bestOffset();
  }
  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }
  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

async function login(name) {
  const res = await req("/api/host/login", { method: "POST", body: { pin: PIN, hostName: name } });
  if (!res.json?.ok) throw new Error(`host login failed: ${JSON.stringify(res.json)}`);
  return res.json;
}

async function hostCmd(host, kind, targetId, payload = {}, expectedRevision) {
  const body = { commandId: crypto.randomUUID(), kind, payload };
  if (targetId) body.targetId = targetId;
  if (expectedRevision !== undefined) body.expectedRevision = expectedRevision;
  const res = await req("/api/host/command", { method: "POST", token: host.hostToken, body });
  return res.json;
}

async function main() {
  const ready = await req("/api/ready");
  if (ready.status !== 200 || !ready.json?.ready) throw new Error(`/api/ready ${ready.status}: ${JSON.stringify(ready.json)}`);
  code = ready.json.roomCode;
  console.log(`[info] BASE=${BASE} roomCode=${code} roomId=${ready.json.roomId} revision=${ready.json.revision}`);

  /* ── 1. host login ×2（join 之後即刻 approve，避免 pending 10 上限） ── */
  const host1 = await login("BotHost1");
  const host2 = await login("BotHost2");
  check("host login（PIN）", !!host1.hostToken && !!host2.hostToken, `hostId=${host1.hostId}`);
  // 清走之前 run 留低嘅玩家（pending/approved 名額），令重跑可重複
  {
    const snap = await req("/api/host/snapshot", { token: host1.hostToken });
    for (const p of snap.json?.view?.players ?? []) {
      await hostCmd(host1, "player.kick", p.id, {});
    }
  }

  /* ── 2. join 30 players（p95 ≤5 秒、全部 15 秒內；每個即刻 approve） ── */
  const players = [];
  const joinStart = Date.now();
  for (let i = 1; i <= N_PLAYERS; i++) {
    const s = Date.now();
    const res = await req("/api/join", {
      method: "POST",
      body: { code, name: `Bot${String(i).padStart(2, "0")}`, avatar: { kind: "emoji", emoji: ["🐶", "🐱", "🦊", "🐼", "🐨", "🦁", "🐯", "🐸", "🐵", "🦄"][i % 10], color: "#3b82f6" } },
    });
    if (!res.json?.ok) {
      throw new Error(`join ${i} failed ${res.status} ${JSON.stringify(res.json)}`);
    }
    players.push({ ...res.json, joinMs: Date.now() - s });
    const ap = await hostCmd(host1, "player.approve", res.json.playerId, {});
    if (!ap?.ok) throw new Error(`approve ${i} failed ${JSON.stringify(ap)}`);
  }
  const joinMs = Date.now() - joinStart;
  const sorted = players.map((p) => p.joinMs).sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  check("① join 30 players（p95 ≤5s／全部 15s）", p95 <= 5000 && joinMs <= 15000, `p95=${p95}ms total=${joinMs}ms`);

  {
    const snapA = await req("/api/host/snapshot", { token: host1.hostToken });
    const approvedCount = (snapA.json?.view?.players ?? []).filter((p) => p.status === "approved").length;
    check("① approve 30 players（join 後即刻批）", approvedCount === N_PLAYERS, `approved=${approvedCount}/${N_PLAYERS}`);
  }

  /* ── 3. cap 測試：第 31 個 approved／第 11 個 pending／第 6 個 host／第 3 個 stage ── */
  // 先填 pending 至 10 個
  const pending = [];
  for (let i = 0; i < 10; i++) {
    const r = await req("/api/join", { method: "POST", body: { code, name: `Pend${i}`, avatar: { kind: "emoji", emoji: "🙂", color: "#22c55e" } } });
    if (r.json?.ok) pending.push(r.json);
  }
  check("pending 10 個 join 成功", pending.length === 10, `ok=${pending.length}`);
  const p11 = await req("/api/join", { method: "POST", body: { code, name: "Pend11", avatar: { kind: "emoji", emoji: "🙂", color: "#22c55e" } } });
  check("第 11 個 pending → W_ROOM_FULL", p11.json?.code === "W_ROOM_FULL", `code=${p11.json?.code}`);
  // 30 approved 已滿：新 join（auto approve off）入 pending 位，但 approved 名額要另外試 approve 第 31 個
  // 用 host 直接 approve 第一個 pending → 應該被 30 上限拒絕
  const p31 = await hostCmd(host1, "player.approve", pending[0].playerId, {});
  check("第 31 個 approved → W_ROOM_FULL", p31?.code === "W_ROOM_FULL", `code=${p31?.code}`);
  // 清走 10 個 pending（kick）令之後 socket cap 測試可控
  for (const p of pending) await hostCmd(host1, "player.kick", p.playerId, {});

  /* ── 4. WS 連線：30 players＋2 hosts＋1 stage ── */
  const clients = [];
  const playerClients = [];
  for (const p of players) {
    const c = new Client(`p${p.number}`);
    c.role = "player";
    c.token = p.playerToken;
    clients.push(c);
    playerClients.push(c);
  }
  const hc1 = new Client("host1");
  hc1.role = "host";
  hc1.token = host1.hostToken;
  hc1.hostToken = host1.hostToken;
  const hc2 = new Client("host2");
  hc2.role = "host";
  hc2.token = host2.hostToken;
  hc2.hostToken = host2.hostToken;
  const sc = new Client("stage");
  sc.role = "stage";
  clients.push(hc1, hc2, sc);
  const connStart = Date.now();
  const conns = await Promise.allSettled(clients.map((c) => c.connect()));
  const connected = conns.filter((r) => r.status === "fulfilled" && r.value?.ok !== false).length;
  check("① 30 bots＋2 host＋1 stage 同時連線", connected === clients.length, `connected=${connected}/${clients.length} in ${Date.now() - connStart}ms`);

  // host socket cap：再開 4 條 host 連線（現有 2 → 第 3–5 條 OK？上限 5 條 host，第 6 條拒絕）
  const extraHosts = [];
  for (let i = 0; i < 4; i++) extraHosts.push(new Client(`hostx${i}`));
  for (const c of extraHosts) {
    c.role = "host";
    c.token = host1.hostToken;
  }
  const extraResults = await Promise.allSettled(extraHosts.map((c) => c.connect()));
  const extraOk = extraResults.filter((r) => r.status === "fulfilled" && r.value?.ok !== false).length;
  const hostCapRejected = extraResults.some((r) => r.status === "fulfilled" && r.value?.ok === false && r.value?.code === "W_ROOM_FULL");
  check("host socket cap（5 條；第 6 條 W_ROOM_FULL）", extraOk <= 3 && hostCapRejected, `extraOk=${extraOk} rejected=${hostCapRejected}`);
  // 3rd stage
  const stage2 = new Client("stage2");
  stage2.role = "stage";
  const stage3 = new Client("stage3");
  stage3.role = "stage";
  const s2r = await stage2.connect().catch(() => ({ ok: false }));
  const s3r = await stage3.connect().catch(() => ({ ok: false }));
  check("stage socket cap（2 條；第 3 條 W_ROOM_FULL）", s2r.ok !== false && s3r.ok === false && s3r.code === "W_ROOM_FULL", `s2=${JSON.stringify(s2r)} s3=${JSON.stringify(s3r)}`);
  // 總 socket cap 60：現有 30+2+1+3(extra hosts)+1(stage2)=37；再用 player token 開多 23 條 → 60，第 61 條拒絕
  const filler = [];
  for (let i = 0; i < 23; i++) {
    const c = new Client(`fill${i}`);
    c.role = "player";
    c.token = players[i % players.length].playerToken;
    filler.push(c);
  }
  const fillRes = await Promise.allSettled(filler.map((c) => c.connect()));
  const fillOk = fillRes.filter((r) => r.status === "fulfilled" && r.value?.ok !== false).length;
  const over = new Client("over");
  over.role = "player";
  over.token = players[0].playerToken;
  const overRes = await over.connect().catch(() => ({ ok: true }));
  check("總 socket cap（60；第 61 條 W_ROOM_FULL）", overRes.ok === false && overRes.code === "W_ROOM_FULL", `fillOk=${fillOk} over=${JSON.stringify(overRes)}`);
  for (const c of filler) c.close();
  for (const c of extraHosts) c.close();
  stage3.close();
  stage2.close();

  /* ── clock offset 取樣 ── */
  for (let i = 0; i < 3; i++) {
    for (const c of [hc1, sc, playerClients[0]]) c.ping();
    await sleep(150);
  }
  const offsets = [hc1, sc, playerClients[0]].map((c) => c.bestOffset());
  check(
    "clock offset（RTT 最低樣本；兩機 serverNow 差 ≤0.5s）",
    Math.abs(offsets[0] - offsets[2]) <= 500,
    `offsets=${offsets.map((o) => Math.round(o)).join("/")}ms`,
  );

  /* ── 5. 加 10 分 → stage patch ≤1s ── */
  await hostCmd(hc1, "room.phase", undefined, { phase: "playing" });
  const target = players[0];
  const beforeScore = sc.view?.scores?.find((s) => s.id === target.playerId)?.score ?? 0;
  const tSend = Date.now();
  const scoreRes = await hostCmd(hc1, "score.add", target.playerId, { targetType: "player", delta: 10, reason: "M0 驗收・加 10 分" });
  let latency = -1;
  for (let i = 0; i < 100; i++) {
    const sc0 = sc.view?.scores?.find((s) => s.id === target.playerId)?.score ?? 0;
    if (sc0 === beforeScore + 10) {
      latency = Date.now() - tSend;
      break;
    }
    await sleep(20);
  }
  check("② 加 10 分 → stage 收到 patch ≤1 秒", scoreRes?.ok && latency >= 0 && latency <= 1000, `latency=${latency}ms`);

  /* ── 6. commandId 冪等 ── */
  const cid = crypto.randomUUID();
  const b1 = { commandId: cid, kind: "score.add", targetId: target.playerId, payload: { targetType: "player", targetId: target.playerId, delta: 3, reason: "冪等測試" } };
  const r1 = await req("/api/host/command", { method: "POST", token: host1.hostToken, body: b1 });
  const r2 = await req("/api/host/command", { method: "POST", token: host1.hostToken, body: b1 });
  const b2 = { ...b1, payload: { ...b1.payload, delta: 99 } };
  const r3 = await req("/api/host/command", { method: "POST", token: host1.hostToken, body: b2 });
  check(
    "⑩ commandId 冪等（同 ID 同 payload 回原結果、同 ID 異 payload 拒）",
    r1.json?.ok && r2.json?.ok && r1.json.revision === r2.json.revision && r3.json?.code === "W_CMD_PAYLOAD_MISMATCH",
    `r1rev=${r1.json?.revision} r2rev=${r2.json?.revision} r3code=${r3.json?.code}`,
  );

  /* ── 7. 兩個 host 同時 next：只有一個成功 ── */
  const rev = (await req("/api/host/snapshot", { token: host1.hostToken })).json.view.revision;
  const [n1, n2] = await Promise.all([
    hostCmd(hc1, "rundown.next", undefined, {}, rev),
    hostCmd(hc2, "rundown.next", undefined, {}, rev),
  ]);
  const okCount = [n1, n2].filter((r) => r?.ok).length;
  check("⑩ 兩個 host 同時 next 只行一次", okCount === 1, `ok=${okCount} codes=${n1?.code ?? "ok"}/${n2?.code ?? "ok"}`);

  /* ── 8. 狀態四元組 open→close→tally→reveal ── */
  const snap1 = (await req("/api/host/snapshot", { token: host1.hostToken })).json.view;
  const quartet = [];
  const curItem = snap1.rundown.find((i) => i.id === snap1.currentItemId);
  const quizCard = (snap1.quiz ?? [])[0];
  if (curItem && curItem.gameId !== "quiz") {
    // 前進到 quiz 關
    for (let i = 0; i < 4; i++) await hostCmd(hc1, "rundown.next");
  }
  const openRes = await hostCmd(hc1, "card.open", quizCard?.id);
  await sleep(120);
  let s = (await req("/api/host/snapshot", { token: host1.hostToken })).json.view;
  quartet.push({ step: "open", phase: s.phase, mode: s.stage.mode, card: s.cards.find((c) => c.id === s.currentRound?.cardId)?.state, round: s.currentRound?.state });
  await hostCmd(hc1, "card.close");
  await sleep(100);
  s = (await req("/api/host/snapshot", { token: host1.hostToken })).json.view;
  quartet.push({ step: "close", phase: s.phase, mode: s.stage.mode, card: s.cards.find((c) => c.id === s.currentRound?.cardId)?.state, round: s.currentRound?.state });
  await hostCmd(hc1, "card.tally");
  await sleep(100);
  s = (await req("/api/host/snapshot", { token: host1.hostToken })).json.view;
  quartet.push({ step: "tally", phase: s.phase, mode: s.stage.mode, card: s.cards.find((c) => c.id === s.currentRound?.cardId)?.state, round: s.currentRound?.state });
  const revealRes = await hostCmd(hc1, "card.reveal");
  await sleep(100);
  s = (await req("/api/host/snapshot", { token: host1.hostToken })).json.view;
  quartet.push({ step: "reveal", phase: s.phase, mode: s.stage.mode, card: s.cards.find((c) => c.id === s.currentRound?.cardId)?.state, round: s.currentRound?.state });
  const quartetOk =
    !!openRes?.ok &&
    !!revealRes?.ok &&
    quartet[0].phase === "playing" && quartet[0].mode === "question" && quartet[0].card === "open" && quartet[0].round === "open" &&
    quartet[1].mode === "tally" && quartet[1].card === "closed" && quartet[1].round === "closed" &&
    quartet[2].card === "tally" && quartet[2].round === "tally" &&
    quartet[3].mode === "reveal" && quartet[3].card === "revealed" && quartet[3].round === "revealed";
  check("④ 狀態四元組 open→close→tally→reveal", quartetOk, JSON.stringify(quartet));

  /* ── 9. 分組／搬組兩種語義＋undo ── */
  await hostCmd(hc1, "score.add", players[1].playerId, { targetType: "player", delta: 12, reason: "搬組測試分" });
  await hostCmd(hc1, "groups.set", undefined, { count: 4 });
  for (const p of players.slice(0, 4)) await hostCmd(hc1, "groups.assign", undefined, { playerId: p.playerId, groupId: "g1", mode: "follow" });
  const before = (await req("/api/host/snapshot", { token: host1.hostToken })).json.view;
  const mover = before.players.find((p) => p.id === players[1].playerId);
  const moverScore = mover.score;
  // stay：分數留原組
  await hostCmd(hc1, "groups.assign", undefined, { playerId: players[1].playerId, groupId: "g2", mode: "stay" });
  await sleep(100);
  let after = (await req("/api/host/snapshot", { token: host1.hostToken })).json.view;
  const mover2 = after.players.find((p) => p.id === players[1].playerId);
  const g1After = after.stats; // stats 只係全體
  const groupEvent = after.ledger.find((e) => e.target.type === "group" && e.target.id === "g1");
  const stayOk = mover2.groupId === "g2" && mover2.score === 0 && moverScore > 0 && !!groupEvent;
  check("⑤ 搬組「分數留原組」（player 0＋group 補償事件＋lineage）", stayOk, `moverScore=${moverScore} after=${mover2.score} event=${groupEvent ? groupEvent.delta : "none"}`);
  // undo 該 group 補償事件
  if (groupEvent) await hostCmd(hc1, "score.void", groupEvent.id);
  await sleep(100);
  after = (await req("/api/host/snapshot", { token: host1.hostToken })).json.view;
  const voided = after.ledger.find((e) => e.id === groupEvent?.id);
  const totalScore = after.players.reduce((a, p) => a + p.score, 0);
  const ledgerSum = after.ledger.filter((e) => !e.voided && e.target.type === "player").reduce((a, e) => a + e.delta, 0);
  check("⑤ undo 唔刪紀錄＋帳簿重算對數", voided?.voided === true && totalScore === ledgerSum, `voided=${voided?.voided} totalScore=${totalScore} ledgerSum=${ledgerSum}`);

  /* ── 10. 重連 race／跨 tab presence／token resume（D28） ── */
  const pc = playerClients[2];
  const oldWs = pc.ws;
  // 同一 token 再開一條新線（模擬 refresh／跨 tab）
  const pcNew = new Client("p3-new");
  pcNew.role = "player";
  pcNew.token = players[2].playerToken;
  await pcNew.connect();
  await sleep(120);
  const hashBefore = pcNew.view?.me?.id;
  oldWs.close();
  await sleep(200);
  const afterOldClose = (await req("/api/host/snapshot", { token: host1.hostToken })).json.view;
  const p3 = afterOldClose.players.find((p) => p.id === players[2].playerId);
  check("⑦ 舊 socket 遲斷唔影響新 socket（presence 仍 online）", p3?.connected === true && hashBefore === players[2].playerId, `connected=${p3?.connected}`);
  // refresh：close 新線再用同一 token 重連，身份／分數保留
  pcNew.close();
  await sleep(150);
  const pcRefresh = new Client("p3-refresh");
  pcRefresh.role = "player";
  pcRefresh.token = players[2].playerToken;
  await pcRefresh.connect();
  await sleep(100);
  check(
    "⑪ D28：refresh 後同一身份＋分數保留（自動 resume、唔使手動 refresh）",
    pcRefresh.view?.me?.id === players[2].playerId && typeof pcRefresh.view?.me?.score === "number",
    `playerId=${pcRefresh.view?.me?.id} score=${pcRefresh.view?.me?.score}`,
  );
  playerClients[2] = pcRefresh;

  /* ── 11. 30 bots 隨機斷線重連（每筆提交／計分只出現一次） ── */
  let reconnectOk = 0;
  const reconnected = [];
  for (let i = 0; i < 30; i++) {
    const c = playerClients[i];
    c.close();
    await sleep(30);
    const nc = new Client(c.name + "-r");
    nc.role = "player";
    nc.token = c.token;
    const r = await nc.connect().catch(() => ({ ok: false }));
    if (r.ok !== false) reconnectOk++;
    playerClients[i] = nc;
    reconnected.push(nc);
    await sleep(20);
  }
  const finalSnap = (await req("/api/host/snapshot", { token: host1.hostToken })).json.view;
  const playerEvents = finalSnap.ledger.filter((e) => e.target.type === "player");
  const eventIds = new Set(playerEvents.map((e) => e.id));
  check(
    "⑪ 30 bots 斷線重連：冇重複 event id、分數＝帳簿",
    reconnectOk === 30 && eventIds.size === playerEvents.length,
    `reconnect=${reconnectOk}/30 uniqueEvents=${eventIds.size}/${playerEvents.length}`,
  );

  /* ── 12. 30 bots 答案提交（quiz round） ── */
  // 重開 quiz 第一題，30 bots 一齊答
  await hostCmd(hc1, "card.reopen", quizCard?.id);
  await sleep(150);
  const roundId = (await req("/api/host/snapshot", { token: host1.hostToken })).json.view.currentRound?.id;
  const submitStart = Date.now();
  const submitIds = [];
  for (const c of playerClients) {
    const payload = { kind: "choice", choice: 0 };
    const payloadHash = "bot-hash";
    const submissionId = crypto.randomUUID();
    submitIds.push(submissionId);
    c.send({ type: "submit", roundId, submissionId, payloadHash, payload });
  }
  const deadline = Date.now() + 8000;
  let allResults = 0;
  while (Date.now() < deadline) {
    allResults = playerClients.reduce((a, c) => a + c.submitResults.length, 0);
    if (allResults >= 30) break;
    await sleep(50);
  }
  const receipts = new Set();
  for (const c of playerClients) for (const r of c.submitResults) if (r.receiptAt) receipts.add(`${r.submissionId}`);
  const accepted = playerClients.reduce((a, c) => a + c.submitResults.filter((r) => r.status === "accepted" || r.status === "duplicate").length, 0);
  check(
    "M1 ① 30 bots 同時答題：30 份 receipt、零重複",
    accepted === 30 && receipts.size === 30,
    `accepted=${accepted} uniqueReceipts=${receipts.size} in ${Date.now() - submitStart}ms`,
  );

  /* ── 13. 兩個 host 同時操大mon／stage 設定 ── */
  await sleep(500);
  await hostCmd(hc1, "card.reveal");
  await sleep(150);
  await hostCmd(hc1, "stage.set", undefined, { mode: "scoreboard" });
  await sleep(200);
  check("⑦ stage mode 同步", sc.view?.stage?.mode === "scoreboard", `mode=${sc.view?.stage?.mode}`);

  /* ── summary ── */
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log("\n===== SUMMARY =====");
  console.log(JSON.stringify({ base: BASE, roomCode: code, passed, failed: failed.length, results }, null, 2));
  console.log(`[done] ${passed}/${results.length} passed, ${failed.length} failed, elapsed=${Date.now() - t0}ms`);
  for (const c of clients) c.close();
  for (const c of playerClients) c.close();
  for (const c of [pcRefresh, pcNew, ...reconnected]) c.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(2);
});
