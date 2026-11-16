#!/usr/bin/env node
/**
 * m0-extra.mjs — M0 P1 補證（checker r2 要求）：
 *  ⑤ groups.set 0/1/2/4＋組分公式；多次搬組（follow＋stay）＋undo＋export→重啟 replay→逐筆對帳
 *  ⑪ 同 submissionId 異 payload → W_ID_PAYLOAD_MISMATCH；同 ID 同 payload → duplicate 原收據；
 *     同玩家新 ID 再交 → W_ALREADY_STATE；reopen 後舊 round 提交 → W_ROUND_CLOSED；
 *     heartbeat 30s（測試用 HEARTBEAT_MS=500）唔回 pong → server terminate
 * 自己 spawn server（port 3306）：
 * 用法：PIN=xxxxxx node bots/m0-extra.mjs
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import WebSocket from "ws";

const ROOT = path.resolve(import.meta.dirname, "..");
const CACHE = path.join(ROOT, ".cache", "m0extra");
const PIN = process.env.PIN ?? "";
const PORT = Number(process.env.PORT ?? 3306);
const results = [];
function pass(n, d) { results.push({ name: n, ok: true, detail: d }); console.log(`[PASS] ${n} — ${d}`); }
function fail(n, d) { results.push({ name: n, ok: false, detail: d }); console.log(`[FAIL] ${n} — ${d}`); }
function check(n, c, d) { c ? pass(n, d) : fail(n, d); return c; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(dataDir, extraEnv = {}) {
  const logFile = path.join(CACHE, "server.log");
  fs.mkdirSync(CACHE, { recursive: true });
  const out = fs.openSync(logFile, "a");
  const env = {
    ...process.env,
    NODE_ENV: "development",
    PORT: String(PORT),
    PIN,
    DATA_DIR: dataDir,
    PUBLIC_ORIGINS: `http://127.0.0.1:${PORT},http://localhost:${PORT}`,
    ...extraEnv,
  };
  const child = spawn(process.execPath, ["dist/server/index.js"], { cwd: ROOT, env, stdio: ["ignore", out, out] });
  const exitPromise = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return { child, exit: exitPromise };
}
async function waitReady(timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/ready`, { signal: AbortSignal.timeout(1000) });
      if (res.status === 200) return true;
    } catch { /* retry */ }
    await sleep(150);
  }
  return false;
}
async function stop(srv) {
  srv.child.kill("SIGTERM");
  await Promise.race([srv.exit, sleep(6000)]);
  try { srv.child.kill("SIGKILL"); } catch { /* ignore */ }
}
async function req(p, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method: opts.method ?? "GET", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}
async function cmd(token, kind, targetId, payload = {}) {
  const body = { commandId: crypto.randomUUID(), kind, payload };
  if (targetId) body.targetId = targetId;
  return (await req("/api/host/command", { method: "POST", token, body })).json;
}
async function snap(token) { return (await req("/api/host/snapshot", { token })).json.view; }

class Client {
  constructor(name, role) { this.name = name; this.role = role; this.view = null; this.results = []; this.seq = -1; }
  connect(code, token) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { origin: `http://127.0.0.1:${PORT}` });
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error(this.name + " timeout")), 8000);
      ws.on("open", () => ws.send(JSON.stringify({ type: "hello", role: this.role, code, sessionToken: token, clientInstanceId: this.name + Math.random().toString(36).slice(2) })));
      ws.on("message", (buf) => {
        const m = JSON.parse(String(buf));
        if (m.type === "hello.ok") { clearTimeout(timer); this.ok = true; resolve(m); }
        else if (m.type === "snapshot") { this.view = m.view; this.seq = m.seq; }
        else if (m.type === "patch") {
          if (m.baseSeq !== this.seq) { ws.send(JSON.stringify({ type: "resync", lastSeq: this.seq })); return; }
          this.seq = m.seq;
          for (const op of m.ops ?? []) { if (op.op === "view") this.view = op.view; else if (op.op === "section") this.view[op.name] = op.value; }
        } else if (m.type === "submit.result") this.results.push(m);
        else if (m.type === "error") this.errors = [...(this.errors ?? []), m];
      });
    });
  }
  send(o) { this.ws?.send(JSON.stringify(o)); }
  close() { try { this.ws?.close(); } catch { /* ignore */ } }
}

function wsFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
  else header = Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

async function main() {
  if (!PIN) throw new Error("PIN env 未設定");
  fs.rmSync(CACHE, { recursive: true, force: true });
  const dataDir = path.join(CACHE, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  console.log(`=== M0 P1 補證（真 server port=${PORT}，HEARTBEAT_MS=500） ===`);
  let srv = startServer(dataDir, { HEARTBEAT_MS: "500" });
  if (!(await waitReady())) throw new Error("server 未 ready");
  const ready = (await req("/api/ready")).json;
  const code = ready.roomCode;
  const login = (await req("/api/host/login", { method: "POST", body: { pin: PIN, hostName: "ExtraHost" } })).json;
  const token = login.hostToken;
  const players = [];
  for (let i = 1; i <= 6; i++) {
    const j = (await req("/api/join", { method: "POST", body: { code, name: `XBot${i}`, avatar: { kind: "emoji", emoji: "🐶", color: "#3b82f6" } } })).json;
    players.push(j);
    await cmd(token, "player.approve", j.playerId, {});
  }
  await cmd(token, "room.start");
  const score = (id) => 0; void score;

  /* ── ⑤ groups.set 0/1/2/4 ── */
  const counts = [];
  for (const n of [0, 1, 2, 4]) {
    const r = await cmd(token, "groups.set", undefined, { count: n });
    const s = await snap(token);
    counts.push({ n, ok: r?.ok, groups: s.groups.length });
  }
  check("⑤ groups.set 0/1/2/4 各自成功＋組數正確", counts.every((c) => c.ok && c.groups === c.n), JSON.stringify(counts));

  /* ── ⑤ 組分公式：group 事件＋組員個人分 ── */
  await cmd(token, "groups.set", undefined, { count: 2 });
  const p1 = players[0].playerId;
  const p2 = players[1].playerId;
  const p3 = players[2].playerId;
  await cmd(token, "groups.assign", undefined, { playerId: p1, groupId: "g1", mode: "follow" });
  await cmd(token, "groups.assign", undefined, { playerId: p2, groupId: "g1", mode: "follow" });
  await cmd(token, "groups.assign", undefined, { playerId: p3, groupId: "g2", mode: "follow" });
  const p4 = players[3].playerId;
  await cmd(token, "groups.assign", undefined, { playerId: p4, groupId: "g1", mode: "follow" });
  await cmd(token, "score.add", p1, { targetType: "player", targetId: p1, delta: 4, reason: "組分公式 p1" });
  await cmd(token, "score.add", p2, { targetType: "player", targetId: p2, delta: 3, reason: "組分公式 p2" });
  await cmd(token, "score.add", "g1", { targetType: "group", targetId: "g1", delta: 2, reason: "組分公式 group" });
  await sleep(200);
  let s = await snap(token);
  const g1 = s.players.find((p) => p.id === p1).groupScore;
  check("⑤ 組分＝group 事件＋組員個人分（g1=2+4+3=9）", g1 === 9 && s.players.find((p) => p.id === p3).groupScore === 0, `g1=${g1}`);

  /* ── ⑤ 多次搬組：stay → undo → follow ── */
  await cmd(token, "groups.assign", undefined, { playerId: p1, groupId: "g2", mode: "stay" });
  await sleep(200);
  s = await snap(token);
  const p1ScoreAfterStay = s.players.find((p) => p.id === p1).score;
  const comp = s.ledger.find((e) => !e.voided && e.target.type === "group" && e.target.id === "g1" && e.reason.includes("留原組"));
  const g1AfterStay = s.players.find((p) => p.id === p2).groupScore;
  check(
    "⑤ 搬組 stay：p1 個人分 0、g1 收補償事件（lineage 指返原事件）、g1＝2(組)+4(補償)+3(p2)=9",
    p1ScoreAfterStay === 0 && comp?.delta === 4 && (comp?.lineage?.sourceEventIds?.length ?? 0) >= 1 && g1AfterStay === 9,
    `p1=${p1ScoreAfterStay} comp=${comp?.delta} lineage=${comp?.lineage?.sourceEventIds?.length} g1=${g1AfterStay}`,
  );
  await cmd(token, "score.void", comp.id, {});
  await sleep(200);
  s = await snap(token);
  const g1AfterUndo = s.players.find((p) => p.id === p2).groupScore;
  const voidedKept = s.ledger.some((e) => e.id === comp.id && e.voided === true);
  check("⑤ undo 補償事件：g1 返 5（2+3）、紀錄仍在（voided）", g1AfterUndo === 5 && voidedKept, `g1=${g1AfterUndo} voidedKept=${voidedKept}`);
  // follow：p2 帶 3 分去 g2
  await cmd(token, "groups.assign", undefined, { playerId: p2, groupId: "g2", mode: "follow" });
  await sleep(200);
  s = await snap(token);
  const p2Entry = s.players.find((p) => p.id === p2);
  const g1Final = s.players.find((p) => p.id === p4).groupScore;
  const g2Final = p2Entry.groupScore;
  check("⑤ 搬組 follow：p2 3 分跟去 g2；g1 只剩組事件 2、g2=3", p2Entry.score === 3 && p2Entry.groupId === "g2" && g2Final === 3 && g1Final === 2, `p2.score=${p2Entry.score} p2.group=${p2Entry.groupId} g1=${g1Final} g2=${g2Final}`);

  /* ── ⑤ export → 重啟 replay → 逐筆對帳 ── */
  const beforeExport = await snap(token);
  const beforePlayerScores = Object.fromEntries(beforeExport.players.map((p) => [p.id, p.score]));
  const beforeGroupScores = Object.fromEntries(beforeExport.players.map((p) => [p.id, p.groupScore]));
  const beforeLedger = beforeExport.ledger.map((e) => ({ id: e.id, delta: e.delta, voided: e.voided === true, target: e.target }));
  const exp = await req("/api/host/export", { token }); // 預設回 {ok:true, room, playersCsv, ledgerCsv} 並寫入 data/export
  const revisionBefore = beforeExport.revision;
  await stop(srv);
  srv = startServer(dataDir, { HEARTBEAT_MS: "500" });
  if (!(await waitReady())) throw new Error("restart 未 ready");
  const login2 = (await req("/api/host/login", { method: "POST", body: { pin: PIN, hostName: "ExtraHost2" } })).json;
  const after = await snap(login2.hostToken);
  const afterPlayerScores = Object.fromEntries(after.players.map((p) => [p.id, p.score]));
  const afterGroupScores = Object.fromEntries(after.players.map((p) => [p.id, p.groupScore]));
  const afterLedger = after.ledger.map((e) => ({ id: e.id, delta: e.delta, voided: e.voided === true, target: e.target }));
  if (JSON.stringify(beforeLedger) !== JSON.stringify(afterLedger)) {
    console.log("[debug] beforeLedger=", JSON.stringify(beforeLedger));
    console.log("[debug] afterLedger =", JSON.stringify(afterLedger));
  }
  check("P1-3 revision 重啟 replay 重建（唔會歸零）", typeof revisionBefore === "number" && revisionBefore > 0 && after.revision === revisionBefore, `revision ${revisionBefore} → ${after.revision}`);
  check(
    "⑤ export→重啟 replay：帳簿逐筆一致（id／delta／voided／target）＋個人／組分對得返數",
    exp.json?.ok && JSON.stringify(beforeLedger) === JSON.stringify(afterLedger) && JSON.stringify(beforePlayerScores) === JSON.stringify(afterPlayerScores) && JSON.stringify(beforeGroupScores) === JSON.stringify(afterGroupScores),
    `ledger ${beforeLedger.length}→${afterLedger.length} 筆、scores一致=${JSON.stringify(beforePlayerScores) === JSON.stringify(afterPlayerScores)}、exportRoom=${!!exp.json?.room} ledgerCsv=${(exp.json?.ledgerCsv ?? "").split("\n").length - 1}行`,
  );

  /* ── P1-2 trustProxy：假 X-Forwarded-For 唔可以繞 login rate limit ── */
  {
    let lastStatus = 0;
    let lastCode = "";
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/host/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": `10.0.0.${i + 1}` },
        body: JSON.stringify({ pin: "000000", hostName: "xff" }),
      });
      lastStatus = res.status;
      const j = await res.json().catch(() => null);
      lastCode = j?.code ?? "";
    }
    check("P1-2 假 X-Forwarded-For 唔可以繞 login rate limit（第 12 次 → 429 W_RATE_LIMIT）", lastStatus === 429 && lastCode === "W_RATE_LIMIT", `status=${lastStatus} code=${lastCode}`);
  }

  /* ── ⑪ 提交／收據邊界 ── */
  const pc = new Client("XSubmit", "player");
  await pc.connect(code, players[0].playerToken);
  await cmd(token, "card.open", "q1");
  await sleep(200);
  s = await snap(login2.hostToken);
  const round = s.currentRound;
  const payload1 = { kind: "choice", choice: 0 };
  const hash1 = crypto.createHash("sha256").update(JSON.stringify(payload1)).digest("hex");
  const sid = crypto.randomUUID();
  pc.send({ type: "submit", roundId: round.id, submissionId: sid, payloadHash: hash1, payload: payload1 });
  await sleep(300);
  const first = pc.results.at(-1);
  pc.send({ type: "submit", roundId: round.id, submissionId: sid, payloadHash: hash1, payload: payload1 });
  await sleep(300);
  const dup = pc.results.at(-1);
  const payload2 = { kind: "choice", choice: 1 };
  const hash2 = crypto.createHash("sha256").update(JSON.stringify(payload2)).digest("hex");
  pc.send({ type: "submit", roundId: round.id, submissionId: sid, payloadHash: hash2, payload: payload2 });
  await sleep(300);
  const mismatch = pc.results.at(-1);
  pc.send({ type: "submit", roundId: round.id, submissionId: crypto.randomUUID(), payloadHash: hash1, payload: payload1 });
  await sleep(300);
  const secondNew = pc.results.at(-1);
  check(
    "⑪ 同 ID 同 payload → duplicate 原收據；同 ID 異 payload → W_ID_PAYLOAD_MISMATCH；同玩家新 ID 再交 → W_ALREADY_STATE",
    first?.status === "accepted" && dup?.status === "duplicate" && dup?.receiptAt === first?.receiptAt && mismatch?.code === "W_ID_PAYLOAD_MISMATCH" && secondNew?.code === "W_ALREADY_STATE",
    `accepted=${first?.status} dup=${dup?.status} mismatch=${mismatch?.code} newId=${secondNew?.code}`,
  );
  // reopen 後舊 round 提交 → W_ROUND_CLOSED
  await cmd(token, "card.close");
  await cmd(token, "card.reveal");
  await cmd(token, "card.reopen", "q1");
  await sleep(250);
  pc.send({ type: "submit", roundId: round.id, submissionId: crypto.randomUUID(), payloadHash: hash1, payload: payload1 });
  await sleep(350);
  const oldRound = pc.results.at(-1);
  check("⑪ reopen 後舊 roundId 提交 → W_ROUND_CLOSED", oldRound?.code === "W_ROUND_CLOSED", `code=${oldRound?.code}`);

  /* ── ⑪ heartbeat：正常 client 自動 pong 保持連線；唔回 pong 嘅 client 會被 terminate ── */
  await sleep(1600); // 3 個 heartbeat cycle
  const normalAlive = pc.ws.readyState === 1;
  // raw socket：做 handshake＋送 hello frame，之後唔回 ping
  const zombieClosed = await new Promise((resolve) => {
    const sock = net.connect(PORT, "127.0.0.1", () => {
      sock.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
      setTimeout(() => {
        sock.write(wsFrame(JSON.stringify({ type: "hello", role: "stage", code, clientInstanceId: "zombie" })));
      }, 100);
    });
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); try { sock.destroy(); } catch { /* ignore */ } } };
    sock.on("data", () => { /* 收 ping／snapshot 但唔回 pong */ });
    sock.on("close", () => finish(true));
    sock.on("error", () => finish(true));
    setTimeout(() => finish(false), 4000);
  });
  check("⑪ 30s heartbeat（測試 500ms）：正常 client 保持連線、唔回 pong 嘅 client 被 terminate", normalAlive && zombieClosed, `normalAlive=${normalAlive} zombieClosed=${zombieClosed}`);
  pc.close();

  const passed = results.filter((r) => r.ok).length;
  console.log("\n===== M0-EXTRA SUMMARY =====");
  console.log(JSON.stringify({ passed, failed: results.length - passed, results }, null, 2));
  console.log(`[done] ${passed}/${results.length} passed`);
  await stop(srv);
  process.exit(results.length === passed ? 0 : 1);
}

main().catch((err) => { console.error("[fatal]", err); process.exit(2); });
