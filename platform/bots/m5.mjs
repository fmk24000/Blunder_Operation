#!/usr/bin/env node
/**
 * m5.mjs — M5-lite 驗收：常駐分數條／finale／頒獎（§6 演算法）／multi-host toast／export／PWA meta
 * 用法：BASE=http://127.0.0.1:3000 PIN=xxxxxx node bots/m5.mjs
 */
import WebSocket from "ws";

const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const PIN = process.env.PIN ?? "";
const N = Number(process.env.BOTS_PLAYERS ?? 30);
const results = [];
function pass(n, d) { results.push({ name: n, ok: true, detail: d }); console.log(`[PASS] ${n} — ${d}`); }
function fail(n, d) { results.push({ name: n, ok: false, detail: d }); console.log(`[FAIL] ${n} — ${d}`); }
function check(n, c, d) { c ? pass(n, d) : fail(n, d); return c; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function req(p, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(BASE + p, { method: opts.method ?? "GET", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}
async function hostCmd(token, kind, targetId, payload = {}) {
  const body = { commandId: crypto.randomUUID(), kind, payload };
  if (targetId) body.targetId = targetId;
  return (await req("/api/host/command", { method: "POST", token, body })).json;
}
async function snap(token) { return (await req("/api/host/snapshot", { token })).json.view; }
class Client {
  constructor(name, role) { this.name = name; this.role = role; this.view = null; this.seq = -1; }
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
        }
      });
    });
  }
  close() { try { this.ws?.close(); } catch { /* ignore */ } }
}
async function main() {
  const ready = (await req("/api/ready")).json;
  const code = ready.roomCode;
  console.log(`[info] BASE=${BASE} roomCode=${code}`);
  const h1 = (await req("/api/host/login", { method: "POST", body: { pin: PIN, hostName: "M5Host1" } })).json;
  const h2 = (await req("/api/host/login", { method: "POST", body: { pin: PIN, hostName: "M5Host2" } })).json;
  if (!h1?.ok || !h2?.ok) throw new Error("host login 失敗");
  const token = h1.hostToken;
  // 清房 + 30 players，分數 = 1..30（用嚟驗 §6 演算法：median 15.5、grand 30、second 16、third 1）
  for (const p of (await snap(token)).players ?? []) await hostCmd(token, "player.kick", p.id, {});
  const players = [];
  for (let i = 1; i <= N; i++) {
    const j = (await req("/api/join", { method: "POST", body: { code, name: `M5Bot${String(i).padStart(2, "0")}`, avatar: { kind: "emoji", emoji: "🐼", color: "#22c55e" } } })).json;
    players.push(j);
    await hostCmd(token, "player.approve", j.playerId, {});
    await hostCmd(token, "score.add", j.playerId, { targetType: "player", targetId: j.playerId, delta: i, reason: "M5 seed" });
  }
  const hc1 = new Client("M5H1", "host");
  const hc2 = new Client("M5H2", "host");
  const stage = new Client("M5Stage", "stage");
  await Promise.all([hc1.connect(code, h1.hostToken), hc2.connect(code, h2.hostToken), stage.connect(code)]);
  await hostCmd(token, "room.phase", undefined, { phase: "final" });
  await sleep(400);
  const snapFinal = await snap(token);
  const stats = snapFinal.stats;
  check(
    "M5② finale 全屏分數＋統計（總分 465、median 15.5、30 人）",
    stats.count === 30 && stats.total === 465 && stats.median === 15.5 && stats.max === 30 && stats.min === 1 && stage.view?.stage?.mode === "finale" && (stage.view?.finale?.entries ?? []).length === 30,
    `count=${stats.count} total=${stats.total} median=${stats.median} stageMode=${stage.view?.stage?.mode}`,
  );
  // §6 演算法：grand=30, second=16（dist 0.5 tie→分高）, third=1
  const awards = snapFinal.awards;
  const byId = Object.fromEntries(awards.map((a) => [a.id, a.targetId]));
  check(
    "M5② §6 頒獎演算法：大獎最高分(30)、2獎最接近中位數(16)、3獎最低分(1)",
    byId.grand === players[29].playerId && byId.second === players[15].playerId && byId.third === players[0].playerId,
    `grand=${byId.grand === players[29].playerId} second=${byId.second === players[15].playerId} third=${byId.third === players[0].playerId}`,
  );
  check("M5② 三獎未揭曉（revealed=false）＋stage award 未出人", awards.every((a) => a.revealed === false) && (stage.view?.finale?.awards ?? []).every((a) => a.revealed === false), `awardsRevealed=${awards.map((a) => a.revealed)}`);
  // 逐個揭曉（3→2→大）
  const order = ["third", "second", "grand"];
  const revealLog = [];
  for (const id of order) {
    const r = await hostCmd(token, "award.reveal", undefined, { id });
    await sleep(220);
    const s = await snap(token);
    const a = s.awards.find((x) => x.id === id);
    revealLog.push({ id, ok: r?.ok, revealed: a?.revealed, stageMode: stage.view?.stage?.mode, stageRevealId: stage.view?.stage?.payload?.revealAwardId });
  }
  check(
    "M5② 主持逐個揭曉（3獎→2獎→大獎）、stage award 跟住出",
    revealLog.every((x) => x.ok && x.revealed) && revealLog[0].stageRevealId === "third" && revealLog[1].stageRevealId === "second" && revealLog[2].stageRevealId === "grand" && revealLog.every((x) => x.stageMode === "award"),
    JSON.stringify(revealLog),
  );
  const stageAward = stage.view?.finale?.awards ?? [];
  check("M5② stage award 顯示已揭曉者名＋分數", stageAward.filter((a) => a.revealed).length === 3 && stageAward.find((a) => a.id === "grand")?.name === "M5Bot30", `revealed=${stageAward.filter((a) => a.revealed).length} grand=${stageAward.find((a) => a.id === "grand")?.name}`);
  // 手動改人 + 重設
  const override = await hostCmd(token, "award.override", undefined, { id: "second", targetId: players[2].playerId });
  await sleep(200);
  const sOverride = await snap(token);
  const second = sOverride.awards.find((a) => a.id === "second");
  const stageSecond = stage.view?.finale?.awards?.find((a) => a.id === "second");
  check("M5② 手動改人（≤1 秒畫面跟）＋manual 標記", override?.ok && second.targetId === players[2].playerId && second.manual === true && stageSecond?.name === "M5Bot03", `target=${second.targetId === players[2].playerId} manual=${second.manual} stageName=${stageSecond?.name}`);
  const reset = await hostCmd(token, "award.reset");
  await sleep(200);
  const sReset = await snap(token);
  check("M5② 重設頒獎：三獎重新算出＋revealed=false", reset?.ok && sReset.awards.every((a) => a.revealed === false), `revealed=${sReset.awards.map((a) => a.revealed)}`);

  // 常駐分數條一鍵收放／全屏分數
  await hostCmd(token, "stage.ticker", undefined, { visible: false });
  await sleep(150);
  const tickerOff = stage.view?.ticker?.visible === false && (stage.view?.stage?.mode === "scoreboard" || true);
  await hostCmd(token, "stage.ticker", undefined, { visible: true });
  await hostCmd(token, "stage.set", undefined, { mode: "leaderboard" });
  await sleep(200);
  check("M5① 常駐分數條一鍵收放＋全屏分數（leaderboard）", tickerOff && stage.view?.ticker?.visible === true && stage.view?.stage?.mode === "leaderboard" && (stage.view?.scores ?? []).length === 30, `tickerOff=${tickerOff} mode=${stage.view?.stage?.mode} scores=${(stage.view?.scores ?? []).length}`);

  // multi-host activity toast：host1 動作兩個 host 都見到
  const toastText = `M5 toast ${Date.now()}`;
  await hostCmd(token, "score.add", players[0].playerId, { targetType: "player", targetId: players[0].playerId, delta: 1, reason: toastText });
  await sleep(300);
  const t1 = hc1.view?.activity?.at(-1)?.text ?? "";
  const t2 = hc2.view?.activity?.at(-1)?.text ?? "";
  check("M5③ multi-host activity toast（兩個 host 都見到最後動作）", t1.includes(toastText) && t2.includes(toastText) && hc1.view?.activity?.at(-1)?.hostName === "M5Host1", `h1="${t1}" h2="${t2}"`);

  // /api/host/export：CSV＋room.json
  const csv = await req("/api/host/export?format=csv", { token });
  const roomJson = await req("/api/host/export?format=room", { token });
  const roomBody = await req("/api/host/export", { token });
  const csvLines = (csv.text ?? "").split("\n").filter(Boolean);
  check(
    "M5④ /api/host/export：CSV（players＋ledger）＋room.json＋一鍵寫檔",
    csv.status === 200 && csvLines.length >= 31 && csv.text.includes("score") && roomJson.status === 200 && Array.isArray(roomJson.json?.ledger) && roomBody.json?.ok === true && typeof roomBody.json?.playersCsv === "string" && typeof roomBody.json?.ledgerCsv === "string",
    `csvLines=${csvLines.length} roomLedger=${roomJson.json?.ledger?.length} writeFilesOk=${roomBody.json?.ok}`,
  );

  // PWA：只做「加到主畫面」meta，冇 service worker（D33）
  const playHtml = await req("/play");
  const manifest = await req("/manifest.webmanifest");
  const playJs = await req("/js/client/play.js");
  check(
    "M5 PWA：apple-mobile-web-app-capable＋manifest（standalone）＋冇 service worker（D33）",
    playHtml.status === 200 && (playHtml.text ?? "").includes("apple-mobile-web-app-capable") && (playHtml.text ?? "").includes("manifest.webmanifest") && manifest.json?.display === "standalone" && !(playJs.text ?? "").includes("serviceWorker"),
    `playMeta=${(playHtml.text ?? "").includes("apple-mobile-web-app-capable")} display=${manifest.json?.display} sw=${(playJs.text ?? "").includes("serviceWorker")}`,
  );
  const passed = results.filter((r) => r.ok).length;
  console.log("\n===== M5 SUMMARY =====");
  console.log(JSON.stringify({ base: BASE, roomCode: code, passed, failed: results.length - passed, results }, null, 2));
  console.log(`[done] ${passed}/${results.length} passed`);
  for (const c of [hc1, hc2, stage]) c.close();
  process.exit(results.length === passed ? 0 : 1);
}
main().catch((e) => { console.error("[fatal]", e); process.exit(2); });
