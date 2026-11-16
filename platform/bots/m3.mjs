#!/usr/bin/env node
/**
 * m3.mjs — M3 驗收：畫畫關（上載／作品牆／放大／評審／vote 最似；§5.2 計分）
 * 用法：BASE=http://127.0.0.1:3000 PIN=xxxxxx node bots/m3.mjs
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
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}
async function hostCmd(token, kind, targetId, payload = {}, opts = {}) {
  const body = { commandId: opts.commandId ?? crypto.randomUUID(), kind, payload };
  if (targetId) body.targetId = targetId;
  if (opts.expectedRevision !== undefined) body.expectedRevision = opts.expectedRevision;
  return (await req("/api/host/command", { method: "POST", token, body })).json;
}
async function snap(token) { return (await req("/api/host/snapshot", { token })).json.view; }
async function waitFor(fn, timeout = 10000, step = 60) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await fn()) return Date.now() - t0; await sleep(step); }
  return -1;
}
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
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
  close() { try { this.ws?.close(); } catch { /* ignore */ } }
}
async function uploadImage(token, authorId, i) {
  const fd = new FormData();
  fd.append("kind", "image");
  fd.append("authorId", authorId);
  fd.append("file", new Blob([PNG_1PX], { type: "image/png" }), `work-${i}.png`);
  const res = await fetch(BASE + "/api/host/upload", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function main() {
  const ready = (await req("/api/ready")).json;
  const code = ready.roomCode;
  console.log(`[info] BASE=${BASE} roomCode=${code}`);
  const h = (await req("/api/host/login", { method: "POST", body: { pin: PIN, hostName: "M3Host" } })).json;
  if (!h?.ok) throw new Error("login 失敗");
  const token = h.hostToken;
  for (const p of (await snap(token)).players ?? []) await hostCmd(token, "player.kick", p.id, {});
  const players = [];
  for (let i = 1; i <= N; i++) {
    const j = (await req("/api/join", { method: "POST", body: { code, name: `M3Bot${String(i).padStart(2, "0")}`, avatar: { kind: "emoji", emoji: "🐱", color: "#f59e0b" } } })).json;
    if (!j?.ok) throw new Error("join 失敗 " + JSON.stringify(j));
    players.push(j);
    await hostCmd(token, "player.approve", j.playerId, {});
  }
  const hc = new Client("M3H", "host");
  const stage = new Client("M3Stage", "stage");
  const pcs = players.map((p, i) => new Client("M3P" + i, "player"));
  await Promise.all([hc.connect(code, h.hostToken), stage.connect(code), ...pcs.map((c, i) => c.connect(code, players[i].playerToken))]);
  await hostCmd(token, "room.start");
  // 清走之前測試未完成嘅 round（close→tally→reveal），令 clean-state 假設成立
  for (let guard = 0; guard < 6; guard++) {
    const cur = (await snap(token)).currentRound;
    if (!cur) break;
    if (cur.state === "open") await hostCmd(token, "card.close");
    if ((await snap(token)).currentRound?.state === "closed") await hostCmd(token, "card.tally");
    await hostCmd(token, "card.reveal");
    if ((await snap(token)).currentRound?.state === "revealed" || (await snap(token)).currentRound?.state === "void") break;
  }

  /* ── 30 並發上載（吞吐） ── */
  const t0 = Date.now();
  const uploads = await Promise.all(players.map((p, i) => uploadImage(token, p.playerId, i)));
  const okUploads = uploads.filter((u) => u.json?.ok);
  const uploadedMs = await waitFor(async () => ((await snap(token)).assets ?? []).filter((a) => a.kind === "image").length >= N, 20000);
  check("M3① 30 bots 並發上載 30 張圖：全部成功＋15 秒內全部上牆", okUploads.length === N && uploadedMs >= 0 && uploadedMs <= 15000, `uploads=${okUploads.length}/${N} 上牆=${uploadedMs}ms total=${Date.now() - t0}ms`);
  // 偽裝檔被拒
  const fakeFd = new FormData();
  fakeFd.append("kind", "image");
  fakeFd.append("file", new Blob([Buffer.from("this is not an image")], { type: "image/jpeg" }), "fake.jpg");
  const fake = await fetch(BASE + "/api/host/upload", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fakeFd });
  const fakeJson = await fake.json().catch(() => null);
  check("M3⑤ 偽裝圖被拒（magic bytes → W_UPLOAD_REJECTED）", fakeJson?.code === "W_UPLOAD_REJECTED", `status=${fake.status} code=${fakeJson?.code}`);
  // 超大檔被拒（9MB > 8MB）
  const bigFd = new FormData();
  bigFd.append("kind", "image");
  bigFd.append("file", new Blob([Buffer.concat([PNG_1PX, Buffer.alloc(9 * 1024 * 1024)])], { type: "image/png" }), "big.png");
  const big = await fetch(BASE + "/api/host/upload", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: bigFd });
  const bigJson = await big.json().catch(() => null);
  check("M3⑤ 超大圖被拒（>8MB → W_UPLOAD_REJECTED）", bigJson?.code === "W_UPLOAD_REJECTED", `status=${big.status} code=${bigJson?.code}`);

  /* ── 建立作品投票卡＋開放投票 ── */
  const s1 = await snap(token);
  const assets = (s1.assets ?? []).filter((a) => a.kind === "image");
  const card = await hostCmd(token, "card.create", undefined, { card: { type: "vote", gameId: "draw", voteMode: "works", prompt: "邊張畫最似？", options: assets.map((a) => a.id), seconds: 60, points: 1 } });
  const cardId = (await snap(token)).cards.filter((c) => c.type === "vote" && c.voteMode === "works").at(-1)?.id;
  const opened = await hostCmd(token, "card.open", cardId);
  await waitFor(() => pcs.every((c) => c.view?.task?.roundId), 5000);
  const round = (await snap(token)).currentRound;
  await sleep(250);
  const stageVoteOpen = stage.view;
  check("M3② 作品牆：30 張作品＋開放投票期間唔出票數", opened?.ok && stageVoteOpen?.stage?.mode === "vote" && (stageVoteOpen?.drawWall?.works ?? []).length === 30 && (stageVoteOpen?.vote?.counts ?? []).every((c) => c === 0), `mode=${stageVoteOpen?.stage?.mode} works=${(stageVoteOpen?.drawWall?.works ?? []).length} countsZero=${(stageVoteOpen?.vote?.counts ?? []).every((c) => c === 0)}`);
  // 放大
  await hostCmd(token, "draw.focus", undefined, { assetId: assets[0].id });
  await sleep(200);
  const focusOk = stage.view?.stage?.mode === "draw-focus" && stage.view?.drawWall?.focusId === assets[0].id;
  await hostCmd(token, "draw.focus", undefined, { assetId: null });
  check("M3② stage draw-focus／draw-wall 切換", focusOk && stage.view?.stage?.mode === "draw-wall", `focusMode=${focusOk}`);

  /* ── 投票：作品 0 得 10 票、作品 1 得 8 票、其餘各 1 票 ── */
  const votePlan = [];
  for (let i = 0; i < 30; i++) {
    if (i < 10) votePlan.push(0);
    else if (i < 18) votePlan.push(1);
    else votePlan.push(i - 18 + 2);
  }
  for (let i = 0; i < pcs.length; i++) {
    pcs[i].send({ type: "submit", roundId: round.id, submissionId: crypto.randomUUID(), payloadHash: "m3", payload: { kind: "vote", choice: votePlan[i] } });
    await sleep(10);
  }
  await sleep(500);
  const closedAuto = await waitFor(async () => (await snap(token)).currentRound?.state === "closed", 4000);
  const tallyStage = stage.view;
  check("M3② 30 票收齊／tally 顯示每張作品票數", closedAuto >= 0 && tallyStage?.stage?.mode === "tally" && tallyStage?.tally?.counts?.[0] === 10 && tallyStage?.tally?.counts?.[1] === 8, `autoClosed in ${closedAuto}ms mode=${tallyStage?.stage?.mode} counts0/1=${tallyStage?.tally?.counts?.[0]}/${tallyStage?.tally?.counts?.[1]}`);

  /* ── reveal：人氣票 ×1＋最高票 +2（§5.2） ── */
  await hostCmd(token, "card.reveal");
  await sleep(400);
  const s2 = await snap(token);
  const voteEvents = s2.ledger.filter((e) => e.roundId === round.id && e.reason === "畫畫・人氣票" && !e.voided);
  const topEvents = s2.ledger.filter((e) => e.roundId === round.id && e.reason === "畫畫・最似獎" && !e.voided);
  const author0 = assets[0]?.authorId; // 作品 0（card.options[0]）嘅作者（上載完成次序唔等於 player 次序）
  const author1 = assets[1]?.authorId;
  const ev0 = voteEvents.find((e) => e.target.id === author0);
  const ev1 = voteEvents.find((e) => e.target.id === author1);
  check(
    "M3③ 計分 §5.2：人氣票每票 +1（作者 0 得 10、作者 1 得 8）",
    voteEvents.reduce((a, e) => a + e.delta, 0) === 30 && ev0?.delta === 10 && ev1?.delta === 8,
    `voteEvents=${voteEvents.length} 人氣票總和=${voteEvents.reduce((a, e) => a + e.delta, 0)} author0=${ev0?.delta} author1=${ev1?.delta}`,
  );
  check("M3③ 最似獎：最高票作品作者額外 +2（作品 0 最高）", topEvents.length === 1 && topEvents[0].target.id === author0 && topEvents[0].delta === 2, `topEvents=${topEvents.length} target=${topEvents[0]?.target?.id === author0 ? "author0" : topEvents[0]?.target?.id} delta=${topEvents[0]?.delta}`);

  /* ── 主持評審 +1／+2／0＋commandId 去重 ── */
  const judgeCmd = crypto.randomUUID();
  await hostCmd(token, "draw.judge", cardId, { cardId, assetId: assets[0].id, points: 2 }, { commandId: judgeCmd });
  await hostCmd(token, "draw.judge", cardId, { cardId, assetId: assets[0].id, points: 2 }, { commandId: judgeCmd });
  await sleep(250);
  let s3 = await snap(token);
  const reviewEvents = s3.ledger.filter((e) => e.gameId === "draw" && e.reason === "畫畫・主持評分" && !e.voided);
  check("M3④ 主持 +2 一 click＝作品作者加分（commandId 重複撳唔會重複加）", reviewEvents.length === 1 && reviewEvents[0].target.id === author0 && reviewEvents[0].delta === 2, `reviewEvents=${reviewEvents.length} delta=${reviewEvents[0]?.delta}`);
  await hostCmd(token, "draw.judge", cardId, { cardId, assetId: assets[0].id, points: 0 });
  await sleep(250);
  s3 = await snap(token);
  const aliveReview = s3.ledger.filter((e) => e.gameId === "draw" && e.reason === "畫畫・主持評分" && !e.voided);
  const voidedReview = s3.ledger.some((e) => e.reason === "畫畫・主持評分" && e.voided === true);
  check("M3④ 主持按 0 → void 上一筆評審分（歷史保留）", aliveReview.length === 0 && voidedReview, `alive=${aliveReview.length} voidedKept=${voidedReview}`);
  const passed = results.filter((r) => r.ok).length;
  console.log("\n===== M3 SUMMARY =====");
  console.log(JSON.stringify({ base: BASE, roomCode: code, passed, failed: results.length - passed, results }, null, 2));
  console.log(`[done] ${passed}/${results.length} passed`);
  hc.close(); stage.close(); pcs.forEach((c) => c.close());
  process.exit(results.length === passed ? 0 : 1);
}
main().catch((e) => { console.error("[fatal]", e); process.exit(2); });
