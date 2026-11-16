#!/usr/bin/env node
/**
 * m4.mjs — M4 驗收：搗蛋鬼版本 A（§4 投票邊界／淘汰／計分／身份披露）
 * 用法：BASE=http://127.0.0.1:3000 PIN=xxxxxx node bots/m4.mjs
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
        else if (m.type === "error") this.errors = [...(this.errors ?? []), m];
      });
    });
  }
  send(o) { this.ws?.send(JSON.stringify(o)); }
  submit(roundId, payload) { this.send({ type: "submit", roundId, submissionId: crypto.randomUUID(), payloadHash: "m4", payload }); return this.results.length; }
  close() { try { this.ws?.close(); } catch { /* ignore */ } }
}
async function main() {
  const ready = (await req("/api/ready")).json;
  const code = ready.roomCode;
  console.log(`[info] BASE=${BASE} roomCode=${code}`);
  const h = (await req("/api/host/login", { method: "POST", body: { pin: PIN, hostName: "M4Host" } })).json;
  if (!h?.ok) throw new Error("login 失敗");
  const token = h.hostToken;
  for (const p of (await snap(token)).players ?? []) await hostCmd(token, "player.kick", p.id, {});
  await hostCmd(token, "saboteur.reset").catch(() => {});
  const players = [];
  for (let i = 1; i <= N; i++) {
    const j = (await req("/api/join", { method: "POST", body: { code, name: `M4Bot${String(i).padStart(2, "0")}`, avatar: { kind: "emoji", emoji: "🦊", color: "#a855f7" } } })).json;
    if (!j?.ok) throw new Error("join 失敗 " + JSON.stringify(j));
    players.push(j);
    await hostCmd(token, "player.approve", j.playerId, {});
  }
  const hostC = new Client("M4H", "host");
  const stage = new Client("M4Stage", "stage");
  const pcs = players.map((p, i) => new Client("M4P" + i, "player"));
  await Promise.all([hostC.connect(code, h.hostToken), stage.connect(code), ...pcs.map((c, i) => c.connect(code, players[i].playerToken))]);
  await hostCmd(token, "settings.set", undefined, { autoClose: false });
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

  const sabId = players[0].playerId;

  /* ── 派身份：只送本人（stage 冇 secretRole；每個 player 只知自己） ── */
  const assign = await hostCmd(token, "saboteur.assign", undefined, { saboteurIndex: 0 });
  await sleep(300);
  const stageJson = JSON.stringify(stage.view);
  const stageParsed = stage.view ?? {};
  // 公開投影可以帶 saboteurInfo.revealedRole=null；真正洩漏＝有 secretRole 或 revealedRole 已公開（未揪中前）
  const stageLeak = stageJson.includes('"secretRole"') || (stageParsed.saboteurInfo?.revealedRole ?? null) !== null;
  const selfRoles = pcs.map((c, i) => ({ i, role: c.view?.roleInfo?.secretRole ?? c.view?.me?.secretRole ?? null, otherLeak: JSON.stringify(c.view).includes('"players"') ? false : false }));
  const sabVisible = pcs[0].view?.roleInfo?.secretRole === "saboteur" || pcs[0].view?.me?.secretRole === "saboteur";
  const crewVisible = pcs[1].view?.roleInfo?.secretRole === "crew" || pcs[1].view?.me?.secretRole === "crew";
  const othersDontSeeSab = !pcs.slice(1).some((c, idx) => c.view?.me?.secretRole === "saboteur" || c.view?.roleInfo?.secretRole === "saboteur");
  check("M4① 身份只送到本人：stage 冇 secretRole、搗蛋鬼只自己見到、其他人係 crew", assign?.ok && !stageLeak && sabVisible && crewVisible && othersDontSeeSab, `stageLeak=${stageLeak} sab=${sabVisible} crew=${crewVisible} onlySelf=${othersDontSeeSab}`);

  /* ── 第一輪：stage 只出進度、冇個人票；自投被拒 ── */
  const open1 = await hostCmd(token, "saboteur.openRound");
  await sleep(300);
  const round1 = (await snap(token)).currentRound;
  const stageVote = stage.view;
  const noPersonalVotes = (stageVote?.vote?.counts ?? []).every((c) => c === 0) && (stageVote?.vote?.options ?? []).length > 0;
  check("M4② 開票前 stage 只出投票進度（冇票數／個人票）", open1?.ok && stageVote?.stage?.mode === "vote" && noPersonalVotes, `mode=${stageVote?.stage?.mode} countsZero=${(stageVote?.vote?.counts ?? []).every((c) => c === 0)}`);
  // 自投
  pcs[0].submit(round1.id, { kind: "vote", targetId: players[0].playerId });
  await sleep(250);
  const selfVote = pcs[0].results.at(-1);
  check("M4④ 投自己被 server 拒（W_SELF_VOTE）", selfVote?.code === "W_SELF_VOTE", `code=${selfVote?.code}`);
  // 16 票投 crew players[1]（嚴格過半），其餘 14 票投其他人
  for (let i = 0; i < 16; i++) { if (i === 1) continue; pcs[i].submit(round1.id, { kind: "vote", targetId: players[1].playerId }); await sleep(8); }
  for (let i = 16; i < 30; i++) { pcs[i].submit(round1.id, { kind: "vote", targetId: players[2].playerId }); await sleep(8); }
  await sleep(400);
  const close1 = await hostCmd(token, "saboteur.closeRound");
  await sleep(400);
  const s1 = await snap(token);
  const st1 = s1.saboteurState;
  check(
    "M4③ 第一輪嚴格過半即場淘汰（crew），唔會自動揪中",
    close1?.ok && close1.result?.mode === "eliminate" && st1.eliminatedIds.includes(players[1].playerId) && !st1.caught && !st1.finished,
    `mode=${close1.result?.mode} eliminated=${st1.eliminatedIds.length} caught=${st1.caught}`,
  );

  // 開票後 stage 出 aggregate 票數（仍冇個人票）＋淘汰名單
  const stageAfterClose = (await req("/api/stage/snapshot")).json;
  const agg = stageAfterClose?.tally ?? {};
  const countsSum = (agg.counts ?? []).reduce((a, b) => a + b, 0);
  check(
    "M4②b 開票後 stage 出該輪 aggregate 票數（冇個人票）＋淘汰名單",
    (agg.options ?? []).length === 30 && countsSum === 29 && (agg.voters ?? []).length === 0 && stageAfterClose?.saboteurInfo?.eliminated?.some((x) => x.id === players[1].playerId) && stageAfterClose?.saboteurInfo?.validVotes === 29,
    `options=${(agg.options ?? []).length} countsSum=${countsSum} voters=${(agg.voters ?? []).length} eliminated=${JSON.stringify(stageAfterClose?.saboteurInfo?.eliminated?.map((x) => x.name))}`,
  );

  /* ── 第二輪：被淘汰者唔可以投／唔可以被投；揪中 +3 ── */
  const open2 = await hostCmd(token, "saboteur.openRound");
  await sleep(300);
  const round2 = (await snap(token)).currentRound;
  const eligible2 = round2.eligiblePlayerIds;
  pcs[1].submit(round2.id, { kind: "vote", targetId: players[2].playerId });
  await sleep(250);
  const elimErr = (pcs[1].errors ?? []).some((e) => e.code === "W_FORBIDDEN_ROLE");
  check("M4⑤ 第一輪被淘汰者第二輪唔可以投（W_FORBIDDEN_ROLE）", elimErr, `errors=${(pcs[1].errors ?? []).map((e) => e.code).join(",")}`);
  const aliveVoters = pcs.filter((c, i) => i !== 0 && i !== 1);
  // 15 票投搗蛋鬼（29 eligible → 過半 = 15）
  for (let i = 0; i < aliveVoters.length; i++) { aliveVoters[i].submit(round2.id, { kind: "vote", targetId: sabId }); await sleep(8); }
  await sleep(400);
  const close2 = await hostCmd(token, "saboteur.closeRound");
  await sleep(500);
  const s2 = await snap(token);
  const st2 = s2.saboteurState;
  const hitEvents = s2.ledger.filter((e) => e.gameId === "saboteur" && e.reason === "搗蛋鬼・揪中" && !e.voided);
  const sabPlus5 = s2.ledger.some((e) => e.reason === "搗蛋鬼・潛伏成功" && !e.voided);
  const stageReveal = stage.view;
  check(
    "M4⑥ 揪中：搗蛋鬼被淘汰、公開身份、每位投票者 +3、搗蛋鬼冇 +5",
    close2?.ok && st2.caught && st2.finished && hitEvents.length === 28 && hitEvents.every((e) => e.delta === 3) && !sabPlus5 && stageReveal?.stage?.mode === "role-reveal" && stageReveal?.roleReveal?.saboteurName === "M4Bot01",
    `caught=${st2.caught} hitEvents=${hitEvents.length} sabPlus5=${sabPlus5} roleRevealName=${stageReveal?.roleReveal?.saboteurName}`,
  );
  // 重連唔漏身份
  pcs[5].close();
  await sleep(200);
  const back = new Client("M4P6back", "player");
  await back.connect(code, players[5].playerToken);
  await sleep(200);
  check("M4⑦ 重連後仍然見到自己身份（唔漏身份）", back.view?.roleInfo?.secretRole === "crew", `role=${back.view?.roleInfo?.secretRole}`);
  pcs[5] = back; // 之後嘅投票要用在線 socket

  /* ── 平票／未過半 → 主持裁決＋重投（每輪最多一次）＋兩輪揪唔中 +5 ── */
  await hostCmd(token, "saboteur.reset");
  await sleep(150);
  await hostCmd(token, "saboteur.assign", undefined, { saboteurIndex: 0 });
  await sleep(250);
  // 重新連線用嘅 player client（reset 只清角色，連線仍在）
  const open3 = await hostCmd(token, "saboteur.openRound");
  await sleep(250);
  const round3 = (await snap(token)).currentRound;
  for (let i = 0; i < 30; i++) { pcs[i].submit(round3.id, { kind: "vote", targetId: i % 2 === 0 ? players[1].playerId : players[2].playerId }); await sleep(8); }
  await sleep(400);
  const close3 = await hostCmd(token, "saboteur.closeRound");
  await sleep(350);
  const tieMode = close3.result?.mode;
  const retry1 = await hostCmd(token, "saboteur.decide", undefined, { decision: "retry", roundId: round3.id });
  await sleep(350);
  const s3 = await snap(token);
  const retryRound = s3.currentRound;
  const retry2 = await hostCmd(token, "saboteur.decide", undefined, { decision: "retry", roundId: retryRound.id });
  check(
    "M4③ 平票 → 主持裁決：重投＝新 round（retryOf＋原 round void）、每輪最多重投一次",
    tieMode === "decide" && retry1?.ok && retryRound?.retryOf === round3.id && s3.rounds.find((r) => r.id === round3.id)?.state === "void" && retry2?.code === "W_ALREADY_STATE",
    `tieMode=${tieMode} retryRound=${retryRound?.id} retryOf=${retryRound?.retryOf} retry2=${retry2?.code}`,
  );
  // 重投輪：15/15 平票 → 主持裁決淘汰 crew → 兩輪都揪唔中 → 搗蛋鬼 +5
  for (let i = 0; i < 30; i++) { pcs[i].submit(retryRound.id, { kind: "vote", targetId: i % 2 === 0 ? players[3].playerId : players[4].playerId }); await sleep(8); }
  await sleep(400);
  const close4 = await hostCmd(token, "saboteur.closeRound");
  const decide = await hostCmd(token, "saboteur.decide", undefined, { decision: "eliminate", targetId: players[3].playerId, roundId: retryRound.id });
  await sleep(400);
  const s4 = await snap(token);
  const st4 = s4.saboteurState;
  const sabWin = s4.ledger.find((e) => e.reason === "搗蛋鬼・潛伏成功" && !e.voided);
  check(
    "M4⑥ 兩輪都揪唔中：搗蛋鬼 +5、其餘冇分、公開身份",
    st4?.finished === true && st4?.caught === false && sabWin?.delta === 5 && sabWin?.target?.id === sabId,
    `finished=${st4?.finished} caught=${st4?.caught} sabWin=${sabWin?.delta} targetCorrect=${sabWin?.target?.id === sabId}（close4 mode=${close4?.result?.mode ?? close4?.code}，decide=${decide?.ok}/${decide?.code ?? ""}）`,
  );
  const passed = results.filter((r) => r.ok).length;
  console.log("\n===== M4 SUMMARY =====");
  console.log(JSON.stringify({ base: BASE, roomCode: code, passed, failed: results.length - passed, results }, null, 2));
  console.log(`[done] ${passed}/${results.length} passed`);
  hostC.close(); stage.close(); pcs.forEach((c) => c.close());
  process.exit(results.length === passed ? 0 : 1);
}
main().catch((e) => { console.error("[fatal]", e); process.exit(2); });
