#!/usr/bin/env node
/**
 * 建立「持久測試房」：join N 個玩家 → approve → 加分，print roomCode / roomId / scores。
 * 用喺 30005 部署後（容器內或任何機器）：node scripts/seed-room.mjs
 * env：BASE（預設 http://127.0.0.1:3000）、PIN（容器內已有）、PLAYERS（預設 6）
 */
const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const PIN = process.env.PIN ?? "";
const N = Number(process.env.PLAYERS ?? 6);

async function req(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(BASE + path, { method: opts.method ?? "GET", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function main() {
  if (!PIN) throw new Error("PIN env 未設定（容器內會有）");
  const ready = await req("/api/ready");
  if (!ready.json?.ready) throw new Error(`/api/ready 未 ready：${JSON.stringify(ready.json)}`);
  const code = ready.json.roomCode;
  const roomId = ready.json.roomId;
  const login = await req("/api/host/login", { method: "POST", body: { pin: PIN, hostName: "seed-room" } });
  if (!login.json?.ok) throw new Error(`host login 失敗：${JSON.stringify(login.json)}`);
  const token = login.json.hostToken;
  // 先清走現有玩家（重複跑都種到乾淨房）
  const snap = await req("/api/host/snapshot", { token });
  for (const p of snap.json?.view?.players ?? []) {
    await req("/api/host/command", { token, method: "POST", body: { commandId: crypto.randomUUID(), kind: "player.kick", targetId: p.id, payload: {} } });
  }
  const emojis = ["🐶", "🐱", "🦊", "🐼", "🐨", "🦁", "🐯", "🐸", "🐵", "🦄"];
  const made = [];
  for (let i = 0; i < N; i++) {
    const r = await req("/api/join", { method: "POST", body: { code, name: `測試玩家${i + 1}`, avatar: { kind: "emoji", emoji: emojis[i % emojis.length], color: "#3b82f6" } } });
    if (!r.json?.ok) throw new Error(`join 失敗：${JSON.stringify(r.json)}`);
    const ap = await req("/api/host/command", {
      token,
      method: "POST",
      body: { commandId: crypto.randomUUID(), kind: "player.approve", targetId: r.json.playerId, payload: {} },
    });
    if (!ap.json?.ok) throw new Error(`approve 失敗：${JSON.stringify(ap.json)}`);
    made.push(r.json);
  }
  // 固定分數（方便 auditor 重啟後對數）：1,3,5,7,9,11…
  const points = [11, 9, 7, 5, 3, 1, 2, 4, 6, 8, 10, 12];
  for (let i = 0; i < made.length; i++) {
    const delta = points[i % points.length];
    const sc = await req("/api/host/command", {
      token,
      method: "POST",
      body: { commandId: crypto.randomUUID(), kind: "score.add", targetId: made[i].playerId, payload: { targetType: "player", delta, reason: `持久測試房 seed +${delta}` } },
    });
    if (!sc.json?.ok) throw new Error(`score 失敗：${JSON.stringify(sc.json)}`);
  }
  const scores = await req("/api/scores");
  console.log(
    JSON.stringify(
      {
        ok: true,
        roomCode: code,
        roomId,
        players: made.map((p, i) => ({ playerId: p.playerId, number: p.number, score: scores.json.scores.find((s) => s.id === p.playerId)?.score ?? null })),
        revision: scores.json.revision,
        note: "重啟後 GET /api/scores 應該見到同一組分數",
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error("[seed-room] fatal", err.message);
  process.exit(2);
});
