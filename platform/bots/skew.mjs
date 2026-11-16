#!/usr/bin/env node
/**
 * skew.mjs — §10 M0 ⑥：校歪一部機 ±3 秒＋proxy 注入 200ms 單向延遲，量兩機倒數差 ≤0.5 秒
 * 做法：三個 client 同時睇同一張 20 秒卡嘅 endsAt
 *   ① direct     直連 server
 *   ② delayed    經 Node TCP proxy（server→client 每個 data chunk 遲 200ms）
 *   ③ skewed     模擬「client 本機鐘快 3 秒」：naive 用本機鐘計倒數（錯），再用 RTT 校時修正
 * 量度：endsAt − client.serverNow()（每 400ms 一次，共 6 秒）
 * 用法：BASE=http://127.0.0.1:3100 PIN=xxxxxx node bots/skew.mjs
 */
import net from "node:net";
import WebSocket from "ws";

const BASE = new URL(process.env.BASE ?? "http://127.0.0.1:3100");
const PIN = process.env.PIN ?? "";
const PROXY_PORT = Number(process.env.PROXY_PORT ?? 3299);
const DELAY_MS = Number(process.env.PROXY_DELAY_MS ?? 200);
const SAMPLES = Number(process.env.SAMPLES ?? 15);
const SAMPLE_EVERY = Number(process.env.SAMPLE_EVERY_MS ?? 400);

const results = [];
function pass(name, detail) { results.push({ name, ok: true, detail }); console.log(`[PASS] ${name} — ${detail}`); }
function fail(name, detail) { results.push({ name, ok: false, detail }); console.log(`[FAIL] ${name} — ${detail}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(BASE.origin + path, { method: opts.method ?? "GET", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}

function startProxy(delayMs) {
  return new Promise((resolve) => {
    const srv = net.createServer((client) => {
      if (process.env.SKEW_DEBUG === "1") console.log("[debug] proxy client connected");
      const upstream = net.connect(Number(BASE.port), BASE.hostname);
      client.pipe(upstream); // client → server 即時（一定要喺 connect callback 外先 pipe，否則 handshake 會跌）
      upstream.on("data", (chunk) => {
        if (process.env.SKEW_DEBUG === "1") console.log("[debug] proxy upstream data", chunk.length);
        // server → client 每個 chunk 延遲 200ms（單向延遲）
        setTimeout(() => {
          if (!client.destroyed) client.write(chunk);
        }, delayMs);
      });
      const close = () => { client.destroy(); upstream.destroy(); };
      client.on("close", close);
      upstream.on("close", close);
      client.on("error", close);
      upstream.on("error", close);
    });
    srv.on("error", (e) => { console.log("[debug] proxy server error", e.message); resolve(srv); });
    srv.listen(PROXY_PORT, "127.0.0.1", () => { if (process.env.SKEW_DEBUG === "1") console.log("[debug] proxy listening", PROXY_PORT); resolve(srv); });
  });
}

class ClockClient {
  constructor(name, url, opts = {}) {
    this.name = name;
    this.url = url;
    this.origin = opts.origin ?? BASE.origin;
    this.simulatedSkewMs = opts.simulatedSkewMs ?? 0;
    this.samples = [];
    this.ws = null;
    this.hello = null;
    this.offsets = [];
    this.endsAt = null;
  }
  connect(code, opts = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, { origin: this.origin });
      this.ws = ws;
      const role = opts.role ?? "stage";
      const token = opts.token;
      const timer = setTimeout(() => reject(new Error(this.name + " timeout")), 10000);
      ws.on("open", () => ws.send(JSON.stringify({ type: "hello", role, code, sessionToken: token, clientInstanceId: this.name })));
      ws.on("message", (buf) => {
        const m = JSON.parse(String(buf));
        if (m.type === "hello.ok") { this.hello = m; clearTimeout(timer); resolve(m); }
        else if (m.type === "snapshot") { this.endsAt = m.view?.question?.endsAt ?? m.view?.task?.endsAt ?? null; }
        else if (m.type === "patch") {
          for (const op of m.ops ?? []) {
            if (op.op === "view") this.endsAt = op.view?.question?.endsAt ?? op.view?.task?.endsAt ?? null;
          }
        } else if (m.type === "pong") {
          const t1 = performance.now();
          const rtt = t1 - m.clientT0;
          this.offsets.push({ rtt, offset: m.serverNow + rtt / 2 - t1 });
        }
      });
    });
  }
  async calibrate(rounds = 6) {
    for (let i = 0; i < rounds; i++) {
      this.ws.send(JSON.stringify({ type: "ping", clientT0: performance.now() }));
      await sleep(80);
    }
  }
  best() {
    if (!this.offsets.length) return { rtt: 0, offset: 0 };
    return this.offsets.reduce((a, b) => (a.rtt <= b.rtt ? a : b));
  }
  serverNow() {
    return performance.now() + this.best().offset;
  }
  remaining() {
    if (this.endsAt === null) return null;
    return this.endsAt - this.serverNow();
  }
  // 模擬「本機時鐘慢／快 offsetMs」但唔做校時（錯誤示範）
  naiveRemaining() {
    if (this.endsAt === null) return null;
    // 模擬「client 本機鐘快 simulatedSkewMs，但冇做 RTT 校時」：倒數會短咗 skew 咁多
    return this.endsAt - (this.serverNow() + this.simulatedSkewMs);
  }
}

async function main() {
  const ready = await req("/api/ready");
  if (!ready.json?.ready) throw new Error("/api/ready 唔 ready");
  const code = ready.json.roomCode;
  console.log(`[info] BASE=${BASE.origin} roomCode=${code} proxy=127.0.0.1:${PROXY_PORT}（server→client +${DELAY_MS}ms）`);

  const login = await req("/api/host/login", { method: "POST", body: { pin: PIN, hostName: "SkewHost" } });
  if (!login.json?.ok) throw new Error("host login 失敗");
  const token = login.json.hostToken;
  // 清房 + 1 個 player（唔影響倒數）
  const snap0 = (await req("/api/host/snapshot", { token })).json.view;
  for (const p of snap0.players ?? []) {
    await req("/api/host/command", { method: "POST", token, body: { commandId: crypto.randomUUID(), kind: "player.kick", targetId: p.id, payload: {} } });
  }
  await req("/api/host/command", { method: "POST", token, body: { commandId: crypto.randomUUID(), kind: "room.start", payload: {} } });
  // 清走上一輪留低嘅 open round，再開一張未開過嘅卡
  {
    const snapPre = (await req("/api/host/snapshot", { token })).json.view;
    const cur = snapPre.currentRound;
    if (cur) {
      if (cur.state === "open") await req("/api/host/command", { method: "POST", token, body: { commandId: crypto.randomUUID(), kind: "card.close", payload: {} } });
      await req("/api/host/command", { method: "POST", token, body: { commandId: crypto.randomUUID(), kind: "card.tally", payload: {} } });
      await req("/api/host/command", { method: "POST", token, body: { commandId: crypto.randomUUID(), kind: "card.reveal", payload: {} } });
    }
  }
  // skew 用 player 連線（stage 上限 2），所以先加 2 個 approved player 令佢哋有 task.endsAt
  const extraPlayers = [];
  for (const nm of ["SkewP1", "SkewP2"]) {
    const j = await req("/api/join", { method: "POST", body: { code, name: nm, avatar: { kind: "emoji", emoji: "🐱", color: "#f59e0b" } } });
    if (j.json?.ok) {
      await req("/api/host/command", { method: "POST", token, body: { commandId: crypto.randomUUID(), kind: "player.approve", targetId: j.json.playerId, payload: {} } });
      extraPlayers.push(j.json);
    }
  }
  if (extraPlayers.length < 2) throw new Error("join skew players 失敗");
  const freshCard = ((await req("/api/host/snapshot", { token })).json.view.quiz ?? []).find((c) => c.state === "draft");
  if (!freshCard) throw new Error("冇 draft 卡可開");
  const open = await req("/api/host/command", { method: "POST", token, body: { commandId: crypto.randomUUID(), kind: "card.open", targetId: freshCard.id, payload: {} } });
  if (!open.json?.ok) throw new Error("card.open 失敗 " + JSON.stringify(open.json));
  await sleep(200);
  const snap = (await req("/api/host/snapshot", { token })).json.view;
  const round = snap.currentRound;
  if (!round) throw new Error("冇開到 round");
  const endsAt = round.endsAt;
  console.log(`[info] round=${round.id} endsAt=${endsAt}（server 時鐘）`);

  // stage socket 上限 2：direct 用 stage，delayed／skewed 用 player token
  const proxy = await startProxy(DELAY_MS);
  const direct = new ClockClient("direct", BASE.origin.replace(/^http/, "ws") + "/ws");
  const delayed = new ClockClient("delayed", `ws://127.0.0.1:${PROXY_PORT}/ws`, { origin: BASE.origin, simulatedSkewMs: 0 });
  const skewed = new ClockClient("skewed", BASE.origin.replace(/^http/, "ws") + "/ws", { simulatedSkewMs: 3000 });
  await Promise.all([
    direct.connect(code, { role: "stage" }),
    delayed.connect(code, { role: "player", token: extraPlayers[0].playerToken }),
    skewed.connect(code, { role: "player", token: extraPlayers[1].playerToken }),
  ]);
  await Promise.all([direct.calibrate(), delayed.calibrate(), skewed.calibrate()]);

  const rows = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t = Date.now();
    const d = direct.remaining();
    const dl = delayed.remaining();
    const sk = skewed.remaining();
    const naive = skewed.naiveRemaining();
    rows.push({
      i,
      at: new Date(t).toISOString(),
      remainingMs: { direct: Math.round(d ?? NaN), delayed: Math.round(dl ?? NaN), skewedCorrected: Math.round(sk ?? NaN) },
      skewedNaiveMs: Math.round(naive ?? NaN),
      rttMs: { direct: Math.round(direct.best().rtt * 10) / 10, delayed: Math.round(delayed.best().rtt * 10) / 10, skewed: Math.round(skewed.best().rtt * 10) / 10 },
      offsetMs: { direct: Math.round(direct.best().offset), delayed: Math.round(delayed.best().offset), skewed: Math.round(skewed.best().offset) },
    });
    await sleep(SAMPLE_EVERY);
  }
  console.log("[info] 原始 sample（每 400ms）:");
  console.log(JSON.stringify(rows, null, 1));

  const valid = rows.filter((r) => Number.isFinite(r.remainingMs.direct));
  const corrected = valid.map((r) => [r.remainingMs.direct, r.remainingMs.delayed, r.remainingMs.skewedCorrected]);
  const maxDev = (idxA, idxB) => Math.max(...corrected.map((v) => Math.abs(v[idxA] - v[idxB])));
  const devDirectDelayed = maxDev(0, 1);
  const devDirectSkewCorrected = maxDev(0, 2);
  const naiveDev = Math.max(...valid.map((r) => Math.abs(r.skewedNaiveMs - r.remainingMs.direct)));
  const rttDirect = rows.at(-1).rttMs.direct;
  const rttDelayed = rows.at(-1).rttMs.delayed;

  console.log(`[info] 倒數差（極差）：direct↔delayed=${devDirectDelayed.toFixed(0)}ms  direct↔skewedCorrected=${devDirectSkewCorrected.toFixed(0)}ms`);
  console.log(`[info] 唔校時（skewed 用本機鐘 +3000ms）↔direct 極差=${naiveDev.toFixed(0)}ms`);
  console.log(`[info] RTT：direct=${rttDirect}ms delayed(proxy)=${rttDelayed}ms`);
  if (devDirectDelayed <= 500) pass("⑥ 200ms 單向延遲下兩機倒數差 ≤0.5 秒", `極差 ${devDirectDelayed.toFixed(0)}ms（${valid.length} samples）`);
  else fail("⑥ 200ms 單向延遲下兩機倒數差 ≤0.5 秒", `極差 ${devDirectDelayed.toFixed(0)}ms > 500ms`);
  if (devDirectSkewCorrected <= 500) pass("⑥ 校歪 ±3 秒（RTT 校時後）倒數差 ≤0.5 秒", `極差 ${devDirectSkewCorrected.toFixed(0)}ms`);
  else fail("⑥ 校歪 ±3 秒（RTT 校時後）倒數差 ≤0.5 秒", `極差 ${devDirectSkewCorrected.toFixed(0)}ms > 500ms`);
  if (naiveDev >= 2500) pass("⑥ 對照：唔校時會被 skew 影響（證明測試有效）", `唔校時極差 ${naiveDev.toFixed(0)}ms（≥2500ms）`);
  else fail("⑥ 對照：唔校時會被 skew 影響", `極差只 ${naiveDev.toFixed(0)}ms`);
  if (rttDelayed - rttDirect >= 150) pass("⑥ proxy 真係注入咗單向延遲", `RTT direct=${rttDirect}ms → delayed=${rttDelayed}ms（+${(rttDelayed - rttDirect).toFixed(0)}ms）`);
  else fail("⑥ proxy 真係注入咗單向延遲", `RTT 差不足：${rttDirect} → ${rttDelayed}`);

  const passed = results.filter((r) => r.ok).length;
  console.log("\n===== SKEW SUMMARY =====");
  console.log(JSON.stringify({ base: BASE.origin, roomCode: code, passed, failed: results.length - passed, results, metrics: { devDirectDelayedMs: devDirectDelayed, devDirectSkewCorrectedMs: devDirectSkewCorrected, naiveDeviationMs: naiveDev, rttDirect, rttDelayed } }, null, 2));
  proxy.close();
  direct.ws.close(); delayed.ws.close(); skewed.ws.close();
  process.exit(results.length === passed ? 0 : 1);
}

main().catch((e) => { console.error("[fatal]", e); process.exit(2); });
