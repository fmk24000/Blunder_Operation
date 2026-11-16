#!/usr/bin/env node
/**
 * fault.mjs — §10 M0 ⑫ fault-injection 五個 case（真 spawn server＋真 SIGKILL）
 *  ① 人為寫壞 segment 尾行 → 重啟 truncate＋replay
 *  ② ACK 前 kill：submit 已 fsync、submit.result 未回 → 重啟同 submissionId 重送 = duplicate、只入一次
 *  ③ append 前 kill（FAULT_POINT=before-append）→ 重啟冇記錄；同 commandId 重送只入一次
 *  ④ write 後 fsync 前 kill（FAULT_POINT=after-write-before-fsync）→ 重啟 ready、狀態一致
 *  ⑤ write failure（FAULT_ENOSPC 注入＋唯讀 journal dir）→ server 唔死、command 回錯、重啟狀態一致
 * 用法：PIN=xxxxxx node bots/fault.mjs
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

const ROOT = path.resolve(import.meta.dirname, "..");
const CACHE = path.join(ROOT, ".cache", "fault");
const PIN = process.env.PIN ?? "";
const results = [];
function pass(name, detail, extra = {}) { results.push({ name, ok: true, detail, extra }); console.log(`[PASS] ${name} — ${detail}`); }
function fail(name, detail, extra = {}) { results.push({ name, ok: false, detail, extra }); console.log(`[FAIL] ${name} — ${detail}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freshDir(name) {
  fs.mkdirSync(CACHE, { recursive: true });
  const dir = path.join(CACHE, name, "data");
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function startServer(name, port, dataDir, extraEnv = {}) {
  const logFile = path.join(CACHE, name, "server.log");
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.openSync(logFile, "a");
  const env = {
    ...process.env,
    NODE_ENV: "development",
    PORT: String(port),
    PIN,
    DATA_DIR: dataDir,
    PUBLIC_ORIGINS: `http://127.0.0.1:${port},http://localhost:${port}`,
    ...extraEnv,
  };
  const child = spawn(process.execPath, ["dist/server/index.js"], { cwd: ROOT, env, stdio: ["ignore", out, out] });
  let exited = false;
  let exitInfo = null;
  const exitPromise = new Promise((resolve) => {
    child.on("exit", (codeVal, signal) => {
      exited = true;
      exitInfo = { code: codeVal, signal };
      resolve(exitInfo);
    });
  });
  return {
    child,
    port,
    dataDir,
    logFile,
    exited: () => exited,
    exit: exitPromise,
    kick: () => child.kill("SIGKILL"),
    log: () => {
      try { return fs.readFileSync(logFile, "utf8"); } catch { return ""; }
    },
  };
}

async function waitReady(port, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/ready`, { signal: AbortSignal.timeout(1000) });
      if (res.status === 200) return true;
    } catch { /* not ready */ }
    await sleep(150);
  }
  return false;
}

async function stopServer(srv) {
  if (!srv.exited()) srv.child.kill("SIGTERM");
  await Promise.race([srv.exit, sleep(6000)]);
  if (!srv.exited()) srv.kick();
}

async function req(port, p, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(8000),
    });
    let json = null;
    try { json = await res.json(); } catch { /* ignore */ }
    return { status: res.status, json, transportError: null };
  } catch (err) {
    return { status: 0, json: null, transportError: String(err?.cause ?? err) };
  }
}

async function loginAndSetup(port, { players = 1 } = {}) {
  const ready = await req(port, "/api/ready");
  if (!ready.json?.ready) throw new Error("server 未 ready");
  const code = ready.json.roomCode;
  const login = await req(port, "/api/host/login", { method: "POST", body: { pin: PIN, hostName: "FaultHost" } });
  if (!login.json?.ok) throw new Error("login 失敗 " + JSON.stringify(login.json));
  const token = login.json.hostToken;
  const made = [];
  for (let i = 0; i < players; i++) {
    const j = await req(port, "/api/join", { method: "POST", body: { code, name: `FaultP${i + 1}`, avatar: { kind: "emoji", emoji: "🐶", color: "#3b82f6" } } });
    if (!j.json?.ok) throw new Error("join 失敗 " + JSON.stringify(j.json));
    await req(port, "/api/host/command", { method: "POST", token, body: { commandId: crypto.randomUUID(), kind: "player.approve", targetId: j.json.playerId, payload: {} } });
    made.push(j.json);
  }
  return { code, token, players: made };
}

function connectWs(port, role, token, code) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` });
    const state = { ws, hello: null, msgs: [], closed: null };
    const timer = setTimeout(() => reject(new Error("ws timeout")), 8000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", role, code, sessionToken: token, clientInstanceId: "fault-" + Math.random().toString(36).slice(2) })));
    ws.on("message", (buf) => {
      const m = JSON.parse(String(buf));
      state.msgs.push(m);
      if (m.type === "hello.ok") { state.hello = m; clearTimeout(timer); resolve(state); }
    });
    ws.on("close", (c, r) => { state.closed = { code: c, reason: String(r) }; });
    ws.on("error", () => {});
  });
}

async function scoreAdd(port, token, commandId, delta, playerId) {
  return req(port, "/api/host/command", {
    method: "POST",
    token,
    body: { commandId, kind: "score.add", payload: { targetType: "player", targetId: playerId, delta, reason: "fault test" } },
  });
}

async function scoreValue(port, token, playerId) {
  const snap = await req(port, "/api/host/snapshot", { token });
  return snap.json?.view?.players?.find((p) => p.id === playerId)?.score ?? null;
}

/* ───────── case ①：壞尾行 → truncate＋replay ───────── */
async function caseBadTail() {
  console.log("\n=== case ① 人為寫壞 segment 尾行 → 重啟 truncate＋replay ===");
  const port = 3301;
  const dir = freshDir("bad-tail");
  let srv = startServer("bad-tail", port, dir);
  if (!(await waitReady(port))) return fail("① 壞尾行：首啟 ready", srv.log().slice(-500));
  const { token, players } = await loginAndSetup(port);
  await req(port, "/api/host/command", { method: "POST", token, body: { commandId: "bt-1", kind: "room.phase", payload: { phase: "playing" } } });
  await req(port, "/api/host/command", { method: "POST", token, body: { commandId: "bt-2", kind: "score.add", targetId: players[0].playerId, payload: { targetType: "player", targetId: players[0].playerId, delta: 9, reason: "壞尾行前" } } });
  const before = await scoreValue(port, token, players[0].playerId);
  await stopServer(srv);
  const journalDir = path.join(dir, "journal");
  const roomDir = fs.readdirSync(journalDir).find((x) => x.startsWith("room-"));
  const segFile = path.join(journalDir, roomDir, "segment-0001.jsonl");
  const sizeBefore = fs.statSync(segFile).size;
  fs.appendFileSync(segFile, '{"v":1,"seq":99999,"ts":0,"type":"tx","data":{"records":[]}}|deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n');
  const sizeBad = fs.statSync(segFile).size;
  srv = startServer("bad-tail", port, dir);
  const ready2 = await waitReady(port);
  const login2 = await req(port, "/api/host/login", { method: "POST", body: { pin: PIN, hostName: "FaultHost2" } });
  const token2 = login2.json?.hostToken;
  const after = ready2 ? await scoreValue(port, token2, players[0].playerId) : null;
  const log = srv.log();
  const segText = fs.readFileSync(segFile, "utf8");
  const garbageGone = !segText.includes("deadbeef");
  const lines = segText.trim().split("\n");
  const lastLine = lines[lines.length - 1] ?? "";
  const lastOk = /\|[0-9a-f]{64}$/.test(lastLine);
  await stopServer(srv);
  if (ready2 && before === 9 && after === 9 && garbageGone && lastOk && sizeBad > sizeBefore && /truncate/i.test(log)) {
    pass(
      "① 壞尾行：重啟 ready、truncate 到上一個完整 record、分數 replay 返 9",
      `size 壞行 ${sizeBefore}→${sizeBad}，重啟後垃圾行已清（garbageGone=${garbageGone}、尾行 checksum 有效=${lastOk}）、score ${before}→${after}`,
    );
  } else {
    fail("① 壞尾行", `ready=${ready2} score ${before}→${after} garbageGone=${garbageGone} lastOk=${lastOk} logHasTruncate=${/truncate/i.test(log)}`);
  }
}

/* ───────── case ②：submit ACK 前 kill → 重啟 duplicate 收據 ───────── */
async function caseAckBeforeKill() {
  console.log("\n=== case ② submit 已 fsync、ACK 未回前 SIGKILL ===");
  const port = 3302;
  const dir = freshDir("ack-kill");
  let srv = startServer("ack-kill", port, dir, { FAULT_POINT: "after-fsync-before-ack", FAULT_ON_TYPE: "submission.add" });
  if (!(await waitReady(port))) return fail("② ACK 前 kill：首啟 ready", srv.log().slice(-500));
  const { code, token, players } = await loginAndSetup(port);
  // 關 auto-close，避免重啟後 tick 收卷影響重送
  await req(port, "/api/host/command", { method: "POST", token, body: { commandId: "ak-cfg", kind: "settings.set", payload: { autoClose: false } } });
  await req(port, "/api/host/command", { method: "POST", token, body: { commandId: "ak-start", kind: "room.start", payload: {} } });
  await req(port, "/api/host/command", { method: "POST", token, body: { commandId: "ak-open", kind: "card.open", targetId: "q1", payload: {} } });
  await sleep(200);
  const snap = (await req(port, "/api/host/snapshot", { token })).json.view;
  const round = snap.currentRound;
  if (!round) return fail("② ACK 前 kill：開卡", "冇 round");
  const pws = await connectWs(port, "player", players[0].playerToken, code);
  const submissionId = crypto.randomUUID();
  const payload = { kind: "choice", choice: 0 };
  const payloadHash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  pws.ws.send(JSON.stringify({ type: "submit", roundId: round.id, submissionId, payloadHash, payload }));
  const exitInfo = await Promise.race([srv.exit, sleep(7000).then(() => ({ timeout: true }))]);
  const killed = exitInfo?.signal === "SIGKILL" || exitInfo?.code === null;
  const gotAck = pws.msgs.some((m) => m.type === "submit.result");
  // 重啟（唔再 fault）
  srv = startServer("ack-kill", port, dir);
  const ready2 = await waitReady(port);
  if (!ready2) return fail("② 重啟", srv.log().slice(-500));
  const login2 = await req(port, "/api/host/login", { method: "POST", body: { pin: PIN, hostName: "FaultHost2" } });
  const token2 = login2.json.hostToken;
  const snap2 = (await req(port, "/api/host/snapshot", { token: token2 })).json.view;
  const subs1 = snap2.submissions.filter((s) => s.roundId === round.id && s.id === submissionId);
  const pws2 = await connectWs(port, "player", players[0].playerToken, code);
  pws2.ws.send(JSON.stringify({ type: "submit", roundId: round.id, submissionId, payloadHash, payload }));
  await sleep(500);
  const dup = pws2.msgs.find((m) => m.type === "submit.result");
  const snap3 = (await req(port, "/api/host/snapshot", { token: token2 })).json.view;
  const subs2 = snap3.submissions.filter((s) => s.roundId === round.id && s.id === submissionId);
  pws.ws.close(); pws2.ws.close();
  await stopServer(srv);
  if (killed && !gotAck && ready2 && subs1.length === 1 && dup?.status === "duplicate" && typeof dup?.receiptAt === "number" && subs2.length === 1) {
    pass("② ACK 前 kill：重啟後同 submissionId 重送回 duplicate 原收據、提交只入一次", `signal=${exitInfo?.signal} ack=${gotAck} subs ${subs1.length}→${subs2.length} duplicateStatus=${dup?.status}`);
  } else {
    fail("② ACK 前 kill", `killed=${killed} signal=${exitInfo?.signal} ack=${gotAck} subs1=${subs1.length} dup=${dup?.status} subs2=${subs2.length}`);
  }
}

/* ───────── case ③：append 前 kill ───────── */
async function caseBeforeAppend() {
  console.log("\n=== case ③ journal append 前 SIGKILL ===");
  const port = 3303;
  const dir = freshDir("before-append");
  let srv = startServer("before-append", port, dir, { FAULT_POINT: "before-append", FAULT_ON_TYPE: "ledger.append" });
  if (!(await waitReady(port))) return fail("③ append 前 kill：首啟 ready", srv.log().slice(-500));
  const { token, players } = await loginAndSetup(port);
  await req(port, "/api/host/command", { method: "POST", token, body: { commandId: "ba-start", kind: "room.phase", payload: { phase: "playing" } } });
  const cmdId = "cmd-before-append-1";
  const r1 = await scoreAdd(port, token, cmdId, 7, players[0].playerId);
  const exitInfo = await Promise.race([srv.exit, sleep(7000).then(() => ({ timeout: true }))]);
  srv = startServer("before-append", port, dir);
  const ready2 = await waitReady(port);
  const login2 = await req(port, "/api/host/login", { method: "POST", body: { pin: PIN, hostName: "FaultHost2" } });
  const token2 = login2.json.hostToken;
  const score0 = ready2 ? await scoreValue(port, token2, players[0].playerId) : null;
  // 重送同一 commandId → 應該只入一次
  const r2 = await req(port, "/api/host/command", {
    method: "POST",
    token: token2,
    body: { commandId: cmdId, kind: "score.add", targetId: players[0].playerId, payload: { targetType: "player", delta: 7, reason: "fault test" } },
  });
  const score1 = await scoreValue(port, token2, players[0].playerId);
  const r3 = await req(port, "/api/host/command", {
    method: "POST",
    token: token2,
    body: { commandId: cmdId, kind: "score.add", targetId: players[0].playerId, payload: { targetType: "player", delta: 7, reason: "fault test" } },
  });
  const score2 = await scoreValue(port, token2, players[0].playerId);
  await stopServer(srv);
  if (exitInfo?.signal === "SIGKILL" && ready2 && score0 === 0 && r2.json?.ok && score1 === 7 && r3.json?.ok && r3.json.revision === r2.json.revision && score2 === 7) {
    pass("③ append 前 kill：重啟冇記錄（0 分）；同 commandId 重送只入一次（7 分）", `signal=${exitInfo?.signal} score ${score0}→${score1}→${score2}`);
  } else {
    fail("③ append 前 kill", `signal=${exitInfo?.signal} ready=${ready2} score0=${score0} r2=${r2.json?.ok} score1=${score1} score2=${score2} r1=${r1.transportError ?? r1.status}`);
  }
}

/* ───────── case ④：write 後 fsync 前 kill ───────── */
async function caseWriteBeforeFsync() {
  console.log("\n=== case ④ journal write 後 fsync 前 SIGKILL ===");
  const port = 3304;
  const dir = freshDir("write-before-fsync");
  let srv = startServer("write-before-fsync", port, dir, { FAULT_POINT: "after-write-before-fsync", FAULT_ON_TYPE: "ledger.append" });
  if (!(await waitReady(port))) return fail("④ fsync 前 kill：首啟 ready", srv.log().slice(-500));
  const { token, players } = await loginAndSetup(port);
  await req(port, "/api/host/command", { method: "POST", token, body: { commandId: "wf-start", kind: "room.phase", payload: { phase: "playing" } } });
  const cmdId = "cmd-fsync-kill-1";
  await scoreAdd(port, token, cmdId, 7, players[0].playerId);
  const exitInfo = await Promise.race([srv.exit, sleep(7000).then(() => ({ timeout: true }))]);
  srv = startServer("write-before-fsync", port, dir);
  const ready2 = await waitReady(port);
  const login2 = await req(port, "/api/host/login", { method: "POST", body: { pin: PIN, hostName: "FaultHost2" } });
  const token2 = login2.json.hostToken;
  const scoreAfterRestart = ready2 ? await scoreValue(port, token2, players[0].playerId) : null;
  // 重送同一 commandId：如果 record 冇 survive → 正常入一次；survive 咗（receipt 喺 journal）→ 回原結果
  const r2 = await req(port, "/api/host/command", {
    method: "POST",
    token: token2,
    body: { commandId: cmdId, kind: "score.add", payload: { targetType: "player", targetId: players[0].playerId, delta: 7, reason: "fault test" } },
  });
  const scoreFinal = await scoreValue(port, token2, players[0].playerId);
  const log = srv.log();
  await stopServer(srv);
  // 合法結果：0（record 未 fsync，重啟 truncate 咗）或 7（OS flush 咗，重啟 replay 咗）；重送後最多 7
  if (exitInfo?.signal === "SIGKILL" && ready2 && [0, 7].includes(scoreAfterRestart) && r2.json?.ok && [0, 7].includes(scoreFinal) && scoreFinal <= 7) {
    pass(
      "④ write 後 fsync 前 kill：重啟 ready、狀態一致（fsync 前 crash 最多失一筆，唔會半截）；重送後最多入一次",
      `signal=${exitInfo?.signal} restartScore=${scoreAfterRestart} finalScore=${scoreFinal}${log.includes("truncate") ? "（有 truncate log）" : ""}`,
    );
  } else {
    fail("④ fsync 前 kill", `signal=${exitInfo?.signal} ready=${ready2} restart=${scoreAfterRestart} final=${scoreFinal} r2=${r2.json?.ok}`);
  }
}

/* ───────── case ⑤：write failure（ENOSPC 注入＋唯讀 journal dir） ───────── */
async function caseEnospc() {
  console.log("\n=== case ⑤ write failure：ENOSPC 注入 ＋ 唯讀 journal dir ===");
  const port = 3305;
  const dir = freshDir("enospc");
  let srv = startServer("enospc", port, dir, { FAULT_ENOSPC: "1", FAULT_ON_TYPE: "ledger.append" });
  if (!(await waitReady(port))) return fail("⑤ ENOSPC：首啟 ready", srv.log().slice(-500));
  const { token, players } = await loginAndSetup(port);
  await req(port, "/api/host/command", { method: "POST", token, body: { commandId: "en-start", kind: "room.phase", payload: { phase: "playing" } } });
  const bad = await req(port, "/api/host/command", {
    method: "POST",
    token,
    body: { commandId: "en-1", kind: "score.add", targetId: players[0].playerId, payload: { targetType: "player", targetId: players[0].playerId, delta: 7, reason: "ENOSPC 測試" } },
  });
  const alive1 = (await req(port, "/api/ready")).status === 200;
  const scoreAfter = await scoreValue(port, token, players[0].playerId);
  await stopServer(srv);
  // 重啟：write 未 persist → 0 分
  srv = startServer("enospc", port, dir);
  const ready2 = await waitReady(port);
  const login2 = await req(port, "/api/host/login", { method: "POST", body: { pin: PIN, hostName: "FaultHost2" } });
  const token2 = login2.json?.hostToken;
  const scoreRestart = ready2 && token2 ? await scoreValue(port, token2, players[0].playerId) : null;

  // 註：唯讀 journal dir 對「已開 fd」無效（server 設計係長開 fd 做 append），所以用 ENOSPC injection 做 write-failure 代表
  await stopServer(srv);
  const enospcOk = bad.json?.ok === false && alive1 && scoreAfter === 0;
  if (enospcOk && ready2 && scoreRestart === 0) {
    pass(
      "⑤ write failure（ENOSPC 注入）：command 回錯、server 唔死、重啟 0 分、狀態一致",
      `enospc=${bad.status}/${bad.json?.code} alive=${alive1} scoreAfter=${scoreAfter} restart=${scoreRestart}`,
    );
  } else {
    fail("⑤ write failure", `enospc=${bad.status}/${bad.json?.code} alive1=${alive1} scoreAfter=${scoreAfter} ready2=${ready2} restart=${scoreRestart}`);
  }
  // 註：真 ENOSPC 喺沙盒做唔到（/dev/shm 32GB、冇 mount 細 volume 權限），用 env-gated write-failure injection 代替，已喺 SUMMARY 寫明
}

async function main() {
  if (!PIN) throw new Error("PIN env 未設定");
  console.log(`=== M0 fault-injection（真 spawn server；Node ${process.version}） ===`);
  await caseBadTail();
  await caseAckBeforeKill();
  await caseBeforeAppend();
  await caseWriteBeforeFsync();
  await caseEnospc();
  const passed = results.filter((r) => r.ok).length;
  console.log("\n===== FAULT SUMMARY =====");
  console.log(JSON.stringify({ passed, failed: results.length - passed, results }, null, 2));
  console.log(`[done] ${passed}/${results.length} passed`);
  process.exit(results.length === passed ? 0 : 1);
}

main().catch((err) => { console.error("[fatal]", err); process.exit(2); });
