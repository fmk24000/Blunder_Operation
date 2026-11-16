#!/usr/bin/env node
/**
 * m1.mjs — M1 驗收：問答關＋規則頁（PLAN-v3.1 §10 M1 九條）
 * 用法：BASE=http://127.0.0.1:3000 PIN=xxxxxx node bots/m1.mjs
 */
import WebSocket from "ws";
import fs from "node:fs";

const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const PIN = process.env.PIN ?? "";
const N = Number(process.env.BOTS_PLAYERS ?? 30);
const results = [];
function pass(name, detail) { results.push({ name, ok: true, detail }); console.log(`[PASS] ${name} — ${detail}`); }
function fail(name, detail) { results.push({ name, ok: false, detail }); console.log(`[FAIL] ${name} — ${detail}`); }
function check(name, cond, detail) { cond ? pass(name, detail) : fail(name, detail); return cond; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(BASE + path, { method: opts.method ?? "GET", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

async function hostCmd(token, kind, targetId, payload = {}, expectedRevision) {
  const body = { commandId: crypto.randomUUID(), kind, payload };
  if (targetId) body.targetId = targetId;
  if (expectedRevision !== undefined) body.expectedRevision = expectedRevision;
  return (await req("/api/host/command", { method: "POST", token, body })).json;
}

class Client {
  constructor(name, role) { this.name = name; this.role = role; this.ws = null; this.view = null; this.msgs = []; this.results = []; this.hello = null; this.seq = -1; }
  connect(code, token) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/ws", { origin: BASE });
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error(this.name + " timeout")), 8000);
      ws.on("open", () => ws.send(JSON.stringify({ type: "hello", role: this.role, code, sessionToken: token, clientInstanceId: this.name + Math.random().toString(36).slice(2) })));
      ws.on("message", (buf) => {
        const m = JSON.parse(String(buf));
        this.msgs.push(m);
        if (m.type === "hello.ok") { this.hello = m; clearTimeout(timer); resolve(m); }
        else if (m.type === "error") { if (!this.hello) { clearTimeout(timer); resolve({ ok: false, code: m.code }); } }
        else if (m.type === "snapshot") { this.view = m.view; this.seq = m.seq; }
        else if (m.type === "patch") {
          if (m.baseSeq !== this.seq) { ws.send(JSON.stringify({ type: "resync", lastSeq: this.seq })); return; }
          this.seq = m.seq;
          for (const op of m.ops ?? []) {
            if (op.op === "view") this.view = op.view;
            else if (op.op === "section") this.view[op.name] = op.value;
          }
        } else if (m.type === "submit.result") this.results.push(m);
        else if (m.type === "pong") this.lastPong = m;
      });
      ws.on("close", () => {});
    });
  }
  send(o) { this.ws?.send(JSON.stringify(o)); }
  close() { try { this.ws?.close(); } catch {} }
}

function sendSubmit(c, roundId, payload) {
  const submissionId = crypto.randomUUID();
  c.send({ type: "submit", roundId, submissionId, payloadHash: "m1", payload });
  return submissionId;
}

async function waitFor(fn, timeoutMs = 8000, step = 50) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return Date.now() - t0;
    await sleep(step);
  }
  return -1;
}

async function getSnapshot(token) { return (await req("/api/host/snapshot", { token })).json.view; }

function minutesToMidnightHK(closedAt) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const parts = fmt.formatToParts(new Date(closedAt));
  const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const hh = get("hour") === 24 ? 0 : get("hour");
  const consumed = (hh * 3600 + get("minute") * 60 + get("second")) * 1000 + (closedAt % 1000);
  return Math.floor((86400000 - consumed) / 60000);
}

async function main() {
  const ready = (await req("/api/ready")).json;
  const code = ready.roomCode;
  console.log(`[info] BASE=${BASE} roomCode=${code} roomId=${ready.roomId}`);
  const h1 = (await req("/api/host/login", { method: "POST", body: { pin: PIN, hostName: "M1Host1" } })).json;
  const h2 = (await req("/api/host/login", { method: "POST", body: { pin: PIN, hostName: "M1Host2" } })).json;
  if (!h1?.ok || !h2?.ok) throw new Error("host login failed");
  const token = h1.hostToken;

  // 清房 + 30 players
  const snap0 = await getSnapshot(token);
  for (const p of snap0.players ?? []) await hostCmd(token, "player.kick", p.id, {});
  const players = [];
  for (let i = 1; i <= N; i++) {
    const r = (await req("/api/join", { method: "POST", body: { code, name: `M1Bot${String(i).padStart(2, "0")}`, avatar: { kind: "emoji", emoji: ["🐶","🐱","🦊","🐼","🐨","🦁","🐯","🐸","🐵","🦄"][i % 10], color: "#3b82f6" } } })).json;
    if (!r?.ok) throw new Error("join failed " + JSON.stringify(r));
    players.push(r);
    await hostCmd(token, "player.approve", r.playerId, {});
  }
  const hostC1 = new Client("M1HostConn1", "host");
  const hostC2 = new Client("M1HostConn2", "host");
  const stage = new Client("M1Stage", "stage");
  const stage2 = new Client("M1Stage2", "stage");
  const pcs = players.map((p, i) => new Client("M1P" + i, "player"));
  await Promise.all([hostC1.connect(code, h1.hostToken), hostC2.connect(code, h2.hostToken), stage.connect(code), stage2.connect(code), ...pcs.map((c, i) => c.connect(code, players[i].playerToken))]);
  check("M1 連線：30 players＋2 host＋2 stage", pcs.every((c) => c.hello?.ok !== false), `${pcs.length} players connected`);

  // 入 quiz 關：rundown next ×4
  await hostCmd(token, "room.start");
  for (let i = 0; i < 4; i++) await hostCmd(token, "rundown.next");
  const rulesLatency = await waitFor(() => stage.view?.stage?.mode === "rules" && stage.view?.currentItem?.gameId === "quiz", 3000);
  check("⑨ rundown 入關自動出 rules mode（≤2 秒）", rulesLatency >= 0 && rulesLatency <= 2000, `latency=${rulesLatency}ms mode=${stage.view?.stage?.mode}`);
  // §6.1/§8.4：rules 只准 playing；blackout 期間拒絕
  await hostCmd(token, "room.phase", undefined, { phase: "lobby" });
  const rulesLobby = await hostCmd(token, "stage.rules", undefined, { on: true });
  await hostCmd(token, "room.phase", undefined, { phase: "playing" });
  await hostCmd(token, "stage.blackout", undefined, { on: true });
  const rulesBlackout = await hostCmd(token, "stage.rules", undefined, { on: true });
  await hostCmd(token, "stage.blackout", undefined, { on: false });
  check("⑨ stage.rules 門檻：phase=lobby → W_WRONG_PHASE；blackout → W_STAGE_LOCKED", rulesLobby?.code === "W_WRONG_PHASE" && rulesBlackout?.code === "W_STAGE_LOCKED", `lobby=${rulesLobby?.code} blackout=${rulesBlackout?.code}`);
  const page1 = stage.view?.rulePage;
  const metaA = stage.view?.rulePagesMeta;
  await sleep(200);
  const metaB = stage2.view?.rulePagesMeta;
  check("⑨ pageIndex/totalPages 各機一致", !!metaA && !!metaB && metaA.totalPages === metaB.totalPages && metaA.pageIndex === metaB.pageIndex, `A=${JSON.stringify(metaA)} B=${JSON.stringify(metaB)}`);
  check("⑨ 預設規則頁＝附錄 B（quiz：常識問答）", page1?.title === "常識問答", `title=${page1?.title}`);
  const quizPage = (await getSnapshot(token)).rulePages.find((p) => p.gameId === "quiz");

  // 後台編輯 → 1 秒內更新
  const editRes = await hostCmd(token, "rules.upsert", undefined, {
    page: { id: quizPage.id, gameId: "quiz", title: "常識問答（M1 改）", subtitle: quizPage.subtitle, blocks: quizPage.blocks, order: quizPage.order, enabled: true, autoAdvanceSeconds: 0 },
    expectedVersion: quizPage.version,
  });
  const editLatency = await waitFor(() => stage.view?.rulePage?.title === "常識問答（M1 改）", 2000);
  check("⑨ 後台改完 1 秒內更新（stage 即時收到）", editRes?.ok && editLatency >= 0 && editLatency <= 1000, `latency=${editLatency}ms`);
  // W_RULES_LIMIT
  const tooLong = await hostCmd(token, "rules.upsert", undefined, {
    page: { id: quizPage.id, gameId: "quiz", title: "超長", blocks: [{ type: "paragraph", text: "字".repeat(150) }], order: quizPage.order, enabled: true, autoAdvanceSeconds: 0 },
  });
  check("⑨ 超字數 W_RULES_LIMIT", tooLong?.code === "W_RULES_LIMIT", `code=${tooLong?.code}`);
  // 兩個 host 同時改 → conflict
  const vNow = (await getSnapshot(token)).rulePages.find((p) => p.id === quizPage.id).version;
  const c1 = await hostCmd(h1.hostToken, "rules.upsert", undefined, { page: { id: quizPage.id, gameId: "quiz", title: "Host1 改", blocks: [{ type: "paragraph", text: "A" }], order: quizPage.order, enabled: true, autoAdvanceSeconds: 0 }, expectedVersion: vNow });
  const c2 = await hostCmd(h2.hostToken, "rules.upsert", undefined, { page: { id: quizPage.id, gameId: "quiz", title: "Host2 改", blocks: [{ type: "paragraph", text: "B" }], order: quizPage.order, enabled: true, autoAdvanceSeconds: 0 }, expectedVersion: vNow });
  check("⑨ 兩個 host 同時改 → 第二個 W_RULES_CONFLICT＋回最新", c1?.ok && c2?.code === "W_RULES_CONFLICT" && c2?.latest?.version === vNow + 1, `c1=${c1?.ok} c2=${c2?.code} latestVersion=${c2?.latest?.version}`);
  // fallback：停用 enabled 頁 → 出 rules 用 fallback，流程照推
  await hostCmd(token, "rules.delete", quizPage.id);
  const itemQuiz = (await getSnapshot(token)).rundown.find((i) => i.gameId === "quiz");
  await hostCmd(token, "rundown.prev");
  await hostCmd(token, "rundown.next");
  await sleep(300);
  const fallbackOk = stage.view?.stage?.mode === "rules" && stage.view?.rulePage === null && stage.view?.stage?.payload?.fallback === true;
  check("⑨ 冇 enabled 頁 → fallback（rulePage null＋fallback flag）唔阻流程", fallbackOk, `mode=${stage.view?.stage?.mode} rulePage=${stage.view?.rulePage} fallback=${stage.view?.stage?.payload?.fallback}`);
  // 復原 enabled 頁
  await hostCmd(token, "rules.upsert", undefined, { page: { id: quizPage.id, gameId: "quiz", title: "常識問答", subtitle: "每人自己答，答案唔會漏", blocks: quizPage.blocks, order: quizPage.order, enabled: true, autoAdvanceSeconds: 0 } });
  await sleep(200);
  // 多頁：塞長內容 → server 按高度切 sub-page，stage 只 render 當前頁
  {
    const vNow2 = (await getSnapshot(token)).rulePages.find((p) => p.id === quizPage.id).version;
    const longBlocks = Array.from({ length: 10 }, (_, i) => ({ type: "paragraph", text: `第 ${i + 1} 段：${"內容".repeat(30)}` }));
    const up = await hostCmd(token, "rules.upsert", undefined, { page: { id: quizPage.id, gameId: "quiz", title: "常識問答（多頁）", blocks: longBlocks, order: quizPage.order, enabled: true, autoAdvanceSeconds: 0 }, expectedVersion: vNow2 });
    await hostCmd(token, "stage.rules", undefined, { on: true });
    await sleep(250);
    const meta0 = stage.view?.rulePagesMeta;
    const blocks0 = JSON.stringify(stage.view?.rulePage?.blocks ?? []);
    await hostCmd(token, "stage.page", undefined, { pageIndex: 1 });
    await sleep(250);
    const meta1 = stage.view?.rulePagesMeta;
    const meta1b = stage2.view?.rulePagesMeta;
    const blocks1 = JSON.stringify(stage.view?.rulePage?.blocks ?? []);
    check(
      "⑨ 多頁規則頁 pageIndex 真正切 blocks（各機一致）",
      up?.ok && (meta0?.totalPages ?? 0) > 1 && meta1?.pageIndex === 1 && meta1b?.pageIndex === 1 && meta1?.totalPages === meta0?.totalPages && blocks0 !== blocks1,
      `totalPages=${meta0?.totalPages} page0Blocks=${(stage.view?.rulePage?.blocks ?? []).length} pageIndex=${meta1?.pageIndex}/${meta1b?.pageIndex} blocksDiff=${blocks0 !== blocks1}`,
    );
    // 還原原本附錄 B 頁
    await hostCmd(token, "rules.upsert", undefined, { page: { id: quizPage.id, gameId: "quiz", title: "常識問答", subtitle: "每人自己答，答案唔會漏", blocks: quizPage.blocks, order: quizPage.order, enabled: true, autoAdvanceSeconds: 0 } });
    await sleep(150);
  }

  const snapQuiz = await getSnapshot(token);
  const q1 = snapQuiz.quiz.find((c) => c.id === "q1");
  const q2 = snapQuiz.quiz.find((c) => c.id === "q2");
  const q3 = snapQuiz.quiz.find((c) => c.id === "q3");
  const q11 = snapQuiz.quiz.find((c) => c.id === "q11");
  const q14 = snapQuiz.quiz.find((c) => c.id === "q14");
  const correct1 = q1.correct;
  const explanation1 = q1.explanation;

  /* ── 30 bots 答 20 秒 MC 題：30 receipts 零重複零漏 ── */
  await hostCmd(token, "card.open", "q1");
  await waitFor(() => pcs.every((c) => c.view?.task?.roundId), 3000);
  const round1 = (await getSnapshot(token)).currentRound;
  const t0 = Date.now();
  for (const c of pcs) sendSubmit(c, round1.id, { kind: "choice", choice: correct1 });
  const receiptMs = await waitFor(() => pcs.every((c) => c.results.length >= 1), 8000);
  const receipts = pcs.map((c) => c.results[0]).filter(Boolean);
  const uniq = new Set(receipts.map((r) => r.submissionId));
  check("① 30 bots 同時答 20 秒題：30 receipt、零重複、零漏", receipts.length === 30 && uniq.size === 30 && receipts.every((r) => r.status === "accepted"), `receipts=${receipts.length} unique=${uniq.size} elapsed=${receiptMs}ms total=${Date.now() - t0}ms`);

  /* ── 自動收卷：全員答完即刻收（分母＝eligible roster） ── */
  const autoClosedMs = await waitFor(async () => (await getSnapshot(token)).currentRound?.state === "closed", 3000);
  const snapClosed = await getSnapshot(token);
  check("③ 全員答完即刻自動收（分母正確）", autoClosedMs >= 0 && snapClosed.currentRound?.autoClosed === true, `autoClosed in ${autoClosedMs}ms, autoClosed=${snapClosed.currentRound?.autoClosed}, eligible=${snapClosed.currentRound?.eligiblePlayerIds.length}`);

  /* ── tally 階段：冇正解／解釋外洩（WS／HTTP／build 三路） ── */
  await hostCmd(token, "card.tally");
  await sleep(300);
  const tallyStage = stage.view;
  const stageTallyText = JSON.stringify(tallyStage?.tally);
  const stageHasCorrect = /"correct"\s*:/.test(JSON.stringify(stage.view)) || stageTallyText.includes(String(explanation1));
  const playerTallyHasCorrect = pcs.some((c) => JSON.stringify(c.view).includes('"explanation"') || JSON.stringify(c.view).includes('"correct"'));
  const httpStage = await req("/api/stage/snapshot");
  const httpHasCorrect = JSON.stringify(httpStage.json).includes('"correct"') || JSON.stringify(httpStage.json).includes(explanation1);
  const exportNoToken = await req("/api/host/export?format=room");
  const exportPlayerToken = await req("/api/host/export?format=room", { token: players[0].playerToken });
  const stub = { status: exportNoToken.status, status2: exportPlayerToken.status, ok: exportNoToken.json?.ok, ok2: exportPlayerToken.json?.ok };
  // 重連（tally 階段）snapshot 都唔可以有正解
  const tallyReconnect = new Client("M1Reconnect", "stage");
  await tallyReconnect.connect(code);
  await sleep(120);
  const reconnectHasCorrect = JSON.stringify(tallyReconnect.view).includes('"correct"') || JSON.stringify(tallyReconnect.view).includes(explanation1);
  tallyReconnect.close();
  let buildHasAnswer = false;
  try {
    const js = fs.readFileSync(new URL("../public/js/client/play.js", import.meta.url), "utf8");
    buildHasAnswer = js.includes(explanation1) || js.includes("紫黑色可以防曬");
  } catch { /* ignore */ }
  check(
    "② tally 階段 WS／HTTP／build／重連／export 都冇正解／解釋外洩＋逐選項貼人",
    !stageHasCorrect && !playerTallyHasCorrect && !httpHasCorrect && !buildHasAnswer && !reconnectHasCorrect && stub.status === 401 && stub.status2 === 401 && tallyStage?.tally?.counts?.reduce((a, b) => a + b, 0) === 30 && tallyStage?.tally?.voters?.length === 30,
    `stageLeak=${stageHasCorrect} playerLeak=${playerTallyHasCorrect} httpLeak=${httpHasCorrect} buildLeak=${buildHasAnswer} reconnectLeak=${reconnectHasCorrect} exportCode=${stub.status}/${stub.status2} counts=${tallyStage?.tally?.counts} voters=${tallyStage?.tally?.voters?.length}`,
  );
  // reveal 之後才出
  const revealRes = await hostCmd(token, "card.reveal");
  await sleep(250);
  const stageReveal = stage.view;
  check("② reveal 之後先出正解＋解釋", stageReveal?.reveal?.correct === correct1 && stageReveal?.reveal?.explanation === explanation1, `correct=${stageReveal?.reveal?.correct} expLen=${(stageReveal?.reveal?.explanation ?? "").length}`);
  const snapReveal = await getSnapshot(token);
  const autoEvents = snapReveal.ledger.filter((e) => e.roundId === round1.id && e.by === "auto" && !e.voided);
  check("④ 揭曉後分數逐筆同帳簿對上（每份正確答案 +1）", autoEvents.length === 30 && autoEvents.every((e) => e.delta === 1 && e.reason.startsWith("問答 Q1")), `autoEvents=${autoEvents.length} deltas=${[...new Set(autoEvents.map((e) => e.delta))]}`);

  /* ── 重開同一題：新 roundId、舊 round void、舊提交入唔到新輪 ── */
  const oldId = round1.id;
  const reopenRes = await hostCmd(token, "card.reopen", "q1");
  await sleep(250);
  const snapReopen = await getSnapshot(token);
  const newRound = snapReopen.currentRound;
  const oldRound = snapReopen.rounds.find((r) => r.id === oldId);
  const oldSubsInNew = snapReopen.submissions.filter((s) => s.roundId === newRound.id).length;
  const oldSubsKept = snapReopen.submissions.filter((s) => s.roundId === oldId).length;
  check("⑧ 重開：新 roundId、舊 round void、舊提交入唔到新輪", reopenRes?.ok && newRound.id === "q1#2" && newRound.retryOf === oldId && oldRound?.state === "void" && oldSubsInNew === 0 && oldSubsKept === 30, `new=${newRound?.id} retryOf=${newRound?.retryOf} oldState=${oldRound?.state} oldSubs=${oldSubsKept} newSubs=${oldSubsInNew}`);
  // 舊 round auto 分作廢
  const voidedAuto = snapReopen.ledger.filter((e) => e.roundId === oldId && e.by === "auto").every((e) => e.voided === true);
  check("⑧ 重開：舊 round 自動分全部作廢（歷史保留）", voidedAuto, `oldRoundEvents=${snapReopen.ledger.filter((e) => e.roundId === oldId).length}`);
  await hostCmd(token, "card.close");
  await hostCmd(token, "card.reveal");
  await sleep(150);

  /* ── auto-close 關閉：全員答完唔會自動收 ── */
  await hostCmd(token, "settings.set", undefined, { autoClose: false });
  await hostCmd(token, "card.open", "q2");
  await waitFor(() => pcs.every((c) => c.view?.task?.roundId), 3000);
  const round2 = (await getSnapshot(token)).currentRound;
  for (const c of pcs) sendSubmit(c, round2.id, { kind: "choice", choice: q2.correct });
  await sleep(2500);
  const snapNoAuto = await getSnapshot(token);
  check("③ 關閉 auto-close 時全員答完唔會自動收", snapNoAuto.currentRound?.state === "open", `state=${snapNoAuto.currentRound?.state}`);
  await hostCmd(token, "settings.set", undefined, { autoClose: true });
  await hostCmd(token, "card.close");
  await hostCmd(token, "card.reveal");
  await sleep(150);

  /* ── 估數字：actualAnswer → 最接近者 +2、並列全 +2 ── */
  const amounts = [100, 101, 500, 1000]; // 前兩位並列最接近
  await hostCmd(token, "card.open", "q11");
  await waitFor(() => pcs.every((c) => c.view?.task?.roundId), 3000);
  const round11 = (await getSnapshot(token)).currentRound;
  for (const c of pcs) sendSubmit(c, round11.id, { kind: "open", amount: 300 });
  // 為咗測並列，頭 4 個覆寫唔到（同一 round 只收一份）→ 改用 q13 另測；實際上頭 4 個已交 300
  await sleep(200);
  await hostCmd(token, "card.close");
  const actual = 300;
  const setRes = await hostCmd(token, "quiz.setActualAnswer", undefined, { roundId: round11.id, actualAnswer: actual });
  await sleep(200);
  const snap11 = await getSnapshot(token);
  const closestEvents = snap11.ledger.filter((e) => e.roundId === round11.id && e.reason.includes("估數字") && !e.voided);
  check("⑥ 估數字入 actualAnswer → 最接近者 +2（30 人同答 300＝全部並列）", setRes?.ok && snap11.rounds.find((r) => r.id === round11.id)?.actualAnswer === 300 && closestEvents.length === 30 && closestEvents.every((e) => e.delta === 2), `events=${closestEvents.length} actual=${snap11.rounds.find((r) => r.id === round11.id)?.actualAnswer}`);
  await hostCmd(token, "card.reveal");

  /* ── 並列最接近（唔同答案）＋ Q14 時間題 ── */
  // 並列：用 q13，頭一半答 5、另一半答 5（一樣）→ 全部並列；再另一組測試用兩個值同距
  await hostCmd(token, "card.open", "q13");
  await waitFor(() => pcs.every((c) => c.view?.task?.roundId), 3000);
  const round13 = (await getSnapshot(token)).currentRound;
  pcs.forEach((c, i) => sendSubmit(c, round13.id, { kind: "open", amount: i % 2 === 0 ? 10 : 20 }));
  await sleep(250);
  await hostCmd(token, "card.close");
  await hostCmd(token, "quiz.setActualAnswer", undefined, { roundId: round13.id, actualAnswer: 15 });
  await sleep(200);
  const snap13 = await getSnapshot(token);
  const tieEvents = snap13.ledger.filter((e) => e.roundId === round13.id && e.reason.includes("估數字") && !e.voided);
  check("⑥ 並列最接近全部 +2（10 距 5／20 距 5，各 15 人）", tieEvents.length === 30 && tieEvents.every((e) => e.delta === 2), `tieEvents=${tieEvents.length}`);
  await hostCmd(token, "card.reveal");

  // Q14 時間題
  const q14open = await hostCmd(token, "card.open", "q14");
  await waitFor(() => pcs.every((c) => c.view?.task?.roundId), 3000);
  const round14 = (await getSnapshot(token)).currentRound;
  for (const c of pcs) sendSubmit(c, round14.id, { kind: "open", amount: 999 });
  await sleep(200);
  await hostCmd(token, "card.close");
  await sleep(200);
  const snap14 = await getSnapshot(token);
  const r14 = snap14.rounds.find((r) => r.id === round14.id);
  const expect = r14?.closedAt ? minutesToMidnightHK(r14.closedAt) : -1;
  check("⑦ Q14 用 closedAt＋Asia/Hong_Kong 計實際分鐘（跨 00:00 fixture 另由 unit test 覆蓋）", q14open?.ok && typeof r14?.actualAnswer === "number" && Math.abs(r14.actualAnswer - expect) <= 1, `actualAnswer=${r14?.actualAnswer} expected=${expect} closedAt=${r14?.closedAt}`);
  const q14events = snap14.ledger.filter((e) => e.roundId === round14.id && e.reason.includes("估數字") && !e.voided);
  check(
    "⑦ Q14 收卷同一 transaction 即派最接近 +2（30 人同答 999＝全部並列）",
    q14events.length === 30 && q14events.every((e) => e.delta === 2 && e.by === "auto"),
    `events=${q14events.length} deltas=${[...new Set(q14events.map((e) => e.delta))]}`,
  );
  const manualQ14 = await hostCmd(token, "quiz.setActualAnswer", undefined, { roundId: round14.id, actualAnswer: 123 });
  check("⑦ §3.1 主持唔可以手改 Q14 actualAnswer（W_ALREADY_STATE）", manualQ14?.code === "W_ALREADY_STATE", `code=${manualQ14?.code}`);
  await hostCmd(token, "card.reveal");

  /* ── open 評分：主持 +2 一次過全部答對 ── */
  await hostCmd(token, "card.open", "q16");
  await waitFor(() => pcs.every((c) => c.view?.task?.roundId), 3000);
  const round16 = (await getSnapshot(token)).currentRound;
  for (const c of pcs) sendSubmit(c, round16.id, { kind: "open", text: "206" });
  await sleep(250);
  await hostCmd(token, "card.close");
  const judgeAll = await hostCmd(token, "score.judge", undefined, { roundId: round16.id, allCorrect: true });
  await sleep(200);
  const snap16 = await getSnapshot(token);
  const judgeEvents = snap16.ledger.filter((e) => e.roundId === round16.id && e.by === "host" && !e.voided);
  check("open 評分：一次過全部當答對（30 份 × 2 分）", judgeAll?.ok && judgeEvents.length === 30 && judgeEvents.every((e) => e.delta === 2), `events=${judgeEvents.length}`);
  await hostCmd(token, "card.reveal");

  /* ── ③ 分母：eligible＝開題鎖定 approved roster（offline 照計）；pending／kicked 唔計 ── */
  {
    // offline approved：斷開其中一個 bot 嘅 socket（仍然 approved，但唔喺線）
    const offlinePlayer = players[29];
    pcs[29].close();
    await sleep(200);
    const pend = (await req("/api/join", { method: "POST", body: { code, name: "M1Pend", avatar: { kind: "emoji", emoji: "🙂", color: "#22c55e" } } })).json;
    const kick = (await req("/api/join", { method: "POST", body: { code, name: "M1Kick", avatar: { kind: "emoji", emoji: "🙂", color: "#22c55e" } } })).json;
    await hostCmd(token, "player.kick", kick.playerId, {});
    await hostCmd(token, "card.open", "q5");
    await waitFor(() => pcs.slice(0, 29).every((c) => c.view?.task?.roundId), 3000);
    const snapDen = await getSnapshot(token);
    const roundDen = snapDen.currentRound;
    const eligible = roundDen.eligiblePlayerIds;
    const approvedCount = snapDen.players.filter((p) => p.status === "approved").length;
    const pendIn = eligible.includes(pend.playerId);
    const kickIn = eligible.includes(kick.playerId);
    const offlineIn = eligible.includes(offlinePlayer.playerId);
    for (const c of pcs.slice(0, 29)) sendSubmit(c, roundDen.id, { kind: "choice", choice: 0 });
    await sleep(800);
    const stillOpen = (await getSnapshot(token)).currentRound?.state === "open";
    check(
      "③ 分母＝開題鎖定 approved roster（offline 照計、pending／kicked 唔計）",
      eligible.length === approvedCount && !pendIn && !kickIn && offlineIn && stillOpen,
      `eligible=${eligible.length} approved=${approvedCount} pendingIn=${pendIn} kickedIn=${kickIn} offlineIn=${offlineIn} answered=29／eligible=${eligible.length} 仍然open=${stillOpen}`,
    );
    await hostCmd(token, "card.close");
    await hostCmd(token, "card.reveal");
    await sleep(120);
    // 重新連返 offline bot，之後測試要 30 個都在線
    const back = new Client("M1P30back", "player");
    await back.connect(code, players[29].playerToken);
    pcs[29] = back;
    await sleep(150);
  }

  /* ── 一鍵匯入 MC：唔蓋 open 題、有 diff ── */
  const before = await getSnapshot(token);
  const q2Cur = before.quiz.find((c) => c.id === "q2");
  await hostCmd(token, "quiz.upsert", undefined, { question: { id: "q2", type: "choice", category: q2Cur.category, prompt: "TEMP 改壞嘅題目", options: q2Cur.options, correct: q2Cur.correct, explanation: q2Cur.explanation, seconds: 20, points: 1 } });
  const beforeImport = await getSnapshot(token);
  const openBefore = beforeImport.quiz.filter((c) => c.type === "open").map((c) => `${c.id}:${c.prompt}`);
  const legacy = JSON.parse(fs.readFileSync(new URL("../public/quiz-legacy-mc.json", import.meta.url), "utf8"));
  const imp = await hostCmd(token, "quiz.import", undefined, { questions: legacy.questions });
  const afterImport = await getSnapshot(token);
  const q2After = afterImport.quiz.find((c) => c.id === "q2");
  const openAfter = afterImport.quiz.filter((c) => c.type === "open").map((c) => `${c.id}:${c.prompt}`);
  check(
    "⑤ 一鍵匯入唔會蓋走新版 open 題＋有 diff",
    imp?.ok && q2After.prompt !== "TEMP 改壞嘅題目" && JSON.stringify(openBefore) === JSON.stringify(openAfter) && (imp.result?.diffs ?? []).some((d) => d.id === "q2") && (imp.result?.skippedOpen ?? []).length >= 8,
    `imported=${imp.result?.imported?.length} unchanged=${imp.result?.unchanged?.length} skippedOpen=${imp.result?.skippedOpen?.length} diffs=${JSON.stringify(imp.result?.diffs?.map((d) => d.id))}`,
  );
  // 題庫改完即時生效（開新題目卡片用新 prompt）
  const beforeOpen = await getSnapshot(token);
  const q4prompt = beforeOpen.quiz.find((c) => c.id === "q4").prompt;
  await hostCmd(token, "quiz.upsert", undefined, { question: { id: "q4", type: "choice", category: "食物", prompt: "即時生效測試題", options: ["A", "B", "C", "D"], correct: 0, explanation: "x", seconds: 20, points: 1 } });
  const afterEdit = await getSnapshot(token);
  check("⑤ 題庫改完即刻生效", afterEdit.quiz.find((c) => c.id === "q4").prompt === "即時生效測試題", `before=${q4prompt} after=${afterEdit.quiz.find((c) => c.id === "q4").prompt}`);
  // Q14 後台儲存回歸：autoAnswer 保留、version+1（唔會靜靜哋變普通估數字題）
  {
    const q14before = (await getSnapshot(token)).quiz.find((c) => c.id === "q14");
    await hostCmd(token, "quiz.upsert", undefined, { question: { id: "q14", type: "open", openKind: "number", category: q14before.category, prompt: `${q14before.prompt}（後台改）`, hint: q14before.hint, seconds: q14before.seconds, points: q14before.points } });
    const q14after = (await getSnapshot(token)).quiz.find((c) => c.id === "q14");
    check("⑤ Q14 後台儲存後 autoAnswer 仍在＋version+1（唔會靜默降級）", q14after.autoAnswer === "minutes-to-midnight" && q14after.version === q14before.version + 1 && q14after.prompt.includes("後台改"), `autoAnswer=${q14after.autoAnswer} version ${q14before.version}→${q14after.version}`);
  }

  const passed = results.filter((r) => r.ok).length;
  console.log("\n===== M1 SUMMARY =====");
  console.log(JSON.stringify({ base: BASE, roomCode: code, passed, failed: results.length - passed, results }, null, 2));
  console.log(`[done] ${passed}/${results.length} passed, ${results.length - passed} failed`);
  for (const c of [hostC1, hostC2, stage, stage2, ...pcs]) c.close();
  process.exit(results.length === passed ? 0 : 1);
}

main().catch((e) => { console.error("[fatal]", e); process.exit(2); });
