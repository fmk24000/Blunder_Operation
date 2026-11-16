/** 主持台 /host（可多開；PLAN-v3.1 §8.2） */
import { Live, api, esc, avatarHtml, connBanner, showToast, el, lsGet, lsSet, lsDel, type ConnStatus } from "./common.js";

const TABS: [string, string][] = [
  ["control", "控制"],
  ["players", "玩家"],
  ["groups", "分組"],
  ["score", "分數"],
  ["cards", "出卡"],
  ["quiz", "題庫"],
  ["rules", "規則頁"],
  ["songs", "歌單"],
  ["draw", "畫畫"],
  ["saboteur", "搗蛋鬼"],
  ["awards", "頒獎"],
  ["status", "狀態"],
];

const MODES = [
  "idle", "rules", "scoreboard", "question", "tally", "reveal", "draw-wall", "draw-focus",
  "bid", "vote", "role-reveal", "song", "leaderboard", "finale", "award", "timer", "blackout",
];

let live: Live | null = null;
let view: any = null;
let status: ConnStatus = "connecting";
let token: string | null = null;
let hostName = "";
let hostId = "";
let roomCode = "";
let tab = "control";
let loginError = "";
let lastCmdError = "";
let importReport: any = null;

let deckId = "";
let deckStatus = "未接管音源";
let audioBlocked = false;
let deckTimer: number | null = null;
let leasePauseTimer: number | null = null;

function ensureDeckId(): string {
  if (!deckId) {
    const saved = lsGet<string>("hbd.deckId");
    deckId = saved || `deck_${Math.random().toString(36).slice(2, 10)}`;
    lsSet("hbd.deckId", deckId);
  }
  return deckId;
}
function deckAudio(): HTMLAudioElement | null {
  return el<HTMLAudioElement>("#deck-audio");
}
function mediaSrc(v: any, songId: string | undefined): string {
  if (!songId) return "";
  const song = (v?.songs ?? []).find((x: any) => x.id === songId);
  return song?.source?.kind === "file" ? `/media/${song.source.fileName}` : "";
}
function syncDeck(): void {
  const a = deckAudio();
  const v = view;
  if (!a || !v) return;
  ensureDeckId();
  const lease = v.audioLease;
  const pb = v.playback;
  const mine = !!lease && lease.deckId === deckId;
  const song = pb ? (v.songs ?? []).find((x: any) => x.id === pb.songId) : undefined;
  if (!mine) {
    if (!a.paused) a.pause();
    deckStatus = lease ? `音源由 ${esc(lease.deckId)}（gen ${lease.generation}）出聲` : "未有音源 lease";
    return;
  }
  if (!pb || pb.state === "idle") {
    if (!a.paused) a.pause();
    deckStatus = "你部機持 lease（未播放）";
    return;
  }
  const src = mediaSrc(v, pb.songId);
  if (!src) {
    deckStatus = "呢首歌冇 MP3 檔（YouTube／Apple 只可手動播）";
    return;
  }
  const abs = new URL(src, location.href).href;
  scheduleLeasePause();
  if (pb.state === "preparing") {
    deckStatus = "等音源 ready（preload／用戶解鎖）";
    if (a.src !== abs) {
      a.src = abs;
      a.load();
    }
    const onReady = () => {
      const cur = view?.playback;
      if (cur && cur.songId === pb.songId && cur.state === "preparing") {
        live?.send({ type: "deck.ready", deckId, songId: pb.songId, positionMs: pb.positionMs });
      }
    };
    a.addEventListener("canplaythrough", onReady, { once: true });
    return;
  }
  if (pb.state === "playing") {
    if (a.src !== abs) {
      a.src = abs;
      a.load();
    }
    // 播 15 秒＝真承諾：window 到期自動 pause（server tick 亦會 250ms 內 pause）
    const elapsed = pb.positionMs + Math.max(0, (live?.serverNow() ?? Date.now()) - pb.playStartedAt);
    if (Array.isArray(pb.window) && Number.isFinite(pb.window[1]) && elapsed >= pb.window[1]) {
      if (windowPausedForSong !== pb.songId) {
        windowPausedForSong = pb.songId;
        pauseDeckLocally("播放 window 到咗（15 秒）：自動停播");
        void cmd("media.pause", undefined, { deckId });
      }
      return;
    }
    if (windowPausedForSong === pb.songId) windowPausedForSong = "";
    if (document.visibilityState === "visible") {
      const target = (pb.positionMs + Math.max(0, (live?.serverNow() ?? Date.now()) - pb.playStartedAt)) / 1000;
      if (Math.abs(a.currentTime - target) > 0.4) a.currentTime = Math.max(0, target);
      if (a.paused) {
        a.play()
          .then(() => {
            if (audioBlocked) {
              audioBlocked = false;
              render();
            }
            deckStatus = `播放中（${song?.title ?? ""}）`;
          })
          .catch(() => {
            if (!audioBlocked) {
              audioBlocked = true;
              deckStatus = "autoplay 被擋：撳「恢復播放」";
              render();
            }
          });
      }
    }
    return;
  }
  if (pb.state === "paused") {
    if (!a.paused) a.pause();
    deckStatus = "已暫停";
  }
}
function pauseDeckLocally(reason: string): void {
  const a = deckAudio();
  if (a && !a.paused) a.pause();
  deckStatus = reason;
  render();
}
/** 精準排程：leaseUntil 一到即停（唔用 10s interval；防雙響硬保證 §8.2） */
function scheduleLeasePause(): void {
  if (leasePauseTimer) {
    window.clearTimeout(leasePauseTimer);
    leasePauseTimer = null;
  }
  const v = view;
  if (!v) return;
  const lease = v.audioLease;
  if (!lease || lease.deckId !== deckId || lease.releasedAt) return;
  const msLeft = lease.leaseUntil - (live?.serverNow() ?? Date.now());
  if (msLeft <= 0) {
    pauseDeckLocally("lease 已到期：已即時停播（防雙響）");
    return;
  }
  leasePauseTimer = window.setTimeout(() => {
    const cur = view?.audioLease;
    if (cur && cur.deckId === deckId && !cur.releasedAt && cur.leaseUntil <= (live?.serverNow() ?? Date.now())) {
      pauseDeckLocally("lease 到期：已即時停播（防雙響）");
    } else {
      scheduleLeasePause();
    }
  }, msLeft + 10);
}
let windowPausedForSong = "";
function startDeckTimer(): void {
  if (deckTimer) window.clearInterval(deckTimer);
  // heartbeat 用 10s interval；停播用精準 setTimeout
  deckTimer = window.setInterval(() => {
    const v = view;
    if (!v || !token) return;
    ensureDeckId();
    const lease = v.audioLease;
    if (lease && lease.deckId === deckId && !lease.releasedAt) {
      void cmd("lease.heartbeat", undefined, { deckId, generation: lease.generation });
    }
    scheduleLeasePause();
  }, 10_000);
  scheduleLeasePause();
}

const MODE_LABEL: Record<string, string> = {
  idle: "Idle", rules: "規則頁", scoreboard: "分數板", question: "問題", tally: "分佈", reveal: "揭曉",
  "draw-wall": "作品牆", "draw-focus": "作品放大", bid: "競投", vote: "投票", "role-reveal": "身份揭曉",
  song: "聽歌", leaderboard: "排行榜", finale: "結算", award: "頒獎", timer: "計時", blackout: "黑屏",
};

function uuid(): string {
  return crypto.randomUUID();
}

async function cmd(kind: string, targetId?: string, payload: Record<string, unknown> = {}, expectedRevision?: number): Promise<any> {
  if (!token) return null;
  const body: any = { commandId: uuid(), kind, payload };
  if (targetId) body.targetId = targetId;
  if (expectedRevision !== undefined) body.expectedRevision = expectedRevision;
  const res = await api("/api/host/command", { method: "POST", token, body });
  if (!res?.ok) {
    if (res?.code === "W_STALE_COMMAND") {
      // 兩個 host 撞命令：靜默更新畫面，唔彈 error（§7）
      lastCmdError = "";
      live?.resync();
      return res;
    }
    lastCmdError = `${res?.code ?? "ERROR"}：${res?.message ?? "命令失敗"}`;
    showToast(lastCmdError);
  } else {
    lastCmdError = "";
  }
  return res;
}

/* ───────────── login ───────────── */
function renderLogin(): void {
  const root = el<HTMLDivElement>("#host-root");
  if (!root) return;
  root.innerHTML = `
  <div class="login-wrap">
    <h1>主持台</h1>
    <div class="hint">輸入 PIN（6–12 位數字；由 runbook／server .env 提供）。可以多部機同時開，各自 login。</div>
    <input id="pin" inputmode="numeric" maxlength="12" placeholder="PIN" autocomplete="off">
    <input id="hname" maxlength="20" placeholder="主持名（例：Mac・阿 Ken）" value="${esc(lsGet<string>("hbd.hostName") ?? "")}">
    ${loginError ? `<div class="error-box">${esc(loginError)}</div>` : ""}
    <button class="primary" id="login-btn" style="padding:14px;font-size:18px">Login</button>
    <div class="hint">房碼會 login 之後見到。API：POST /api/host/login</div>
  </div>`;
  el<HTMLButtonElement>("#login-btn")?.addEventListener("click", () => void doLogin());
  el<HTMLInputElement>("#pin")?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") void doLogin();
  });
}

async function doLogin(): Promise<void> {
  const pin = (el<HTMLInputElement>("#pin")?.value ?? "").trim();
  const name = (el<HTMLInputElement>("#hname")?.value ?? "").trim() || "主持";
  if (!pin) {
    loginError = "要入 PIN";
    renderLogin();
    return;
  }
  const res = await api("/api/host/login", { method: "POST", body: { pin, hostName: name } });
  if (!res?.ok) {
    loginError = `${res?.code ?? "ERROR"}：${res?.message ?? "Login 失敗"}`;
    renderLogin();
    return;
  }
  token = res.hostToken;
  hostId = res.hostId;
  hostName = res.hostName ?? name;
  roomCode = res.roomCode ?? "";
  lsSet("hbd.hostToken", { token, hostName, roomCode, hostId });
  lsSet("hbd.hostName", hostName);
  startLive();
}

function startLive(): void {
  if (!token) return;
  if (live) live.close();
  live = new Live({
    role: "host",
    code: roomCode,
    token,
    onView: (v: any) => {
      view = v;
      render();
    },
    onStatus: (s) => {
      status = s;
      render();
    },
    onHello: (msg: any) => {
      hostId = msg.hostId ?? hostId;
      if (msg.seqEpoch) view = view ?? {};
    },
    onAuthFail: () => {
      lsDel("hbd.hostToken");
      token = null;
      renderLogin();
    },
    onError: (code, msg) => showToast(`${code}：${msg}`),
  });
  live.connect();
}

/* ───────────── 各 section ───────────── */
function controlSection(v: any): string {
  const rd = v.rundown ?? [];
  const cur = rd.find((i: any) => i.id === v.currentItemId);
  const curIdx = cur ? rd.findIndex((i: any) => i.id === cur.id) : -1;
  const nxt = rd[curIdx + 1] ?? rd.find((i: any) => i.state !== "done" && i.state !== "skipped");
  const mode = v.stage?.mode;
  const group = (label: string, modes: string[]) =>
    `<div class="mode-group"><div class="mg-label">${label}</div><div class="stage-mode-grid">${modes
      .map((m) => `<button data-act="stage.mode:${m}" class="${mode === m ? "active" : ""}">${esc(MODE_LABEL[m] ?? m)}</button>`)
      .join("")}</div></div>`;
  return `<section class="ctrl-rundown"><h3>Rundown（${rd.filter((i: any) => i.state === "done" || i.state === "skipped").length}/${rd.length}）</h3>
    <div class="card-box">
      <button class="ctrl-hero" data-act="rd.next">
        <span class="hero-k">下一項 ▶</span>
        <span class="hero-v">${esc(nxt?.title ?? "（已到最後一關）")}</span>
      </button>
      <div class="ctrl-sub">
        <button data-act="rd.prev">◀ 上一項</button>
        <button data-act="rd.skip">Skip 呢關</button>
        <span class="pill ${cur ? "on" : ""}">${cur ? `進行中：${esc(cur.title)}` : "未開始"}</span>
      </div>
      <div class="rd-list">${rd
        .map(
          (i: any) =>
            `<div class="ledger-row"><span class="pill ${i.state === "running" ? "on" : i.state === "done" ? "off" : ""}">${i.state}</span><span class="grow">${esc(i.title)}</span><span class="muted">${esc(i.gameId)}</span></div>`,
        )
        .join("")}</div>
      <div class="ctrl-phase">
        <button class="primary" data-act="room.start">開始 playing</button>
        <button data-act="room.phase:lobby">回 Lobby</button>
        <button data-act="room.phase:final">去 Final</button>
      </div>
    </div>
  </section>
  <section class="ctrl-stage"><h3>大mon 控制（現在：${esc(MODE_LABEL[mode] ?? mode)}）</h3>
    <div class="card-box">
      <div class="mode-groups">
        ${group("流程／畫面", ["idle", "rules", "scoreboard", "leaderboard", "award"])}
        ${group("問答", ["question", "tally", "reveal"])}
        ${group("估歌", ["bid", "song", "finale"])}
        ${group("畫畫", ["draw-wall", "draw-focus", "vote"])}
        ${group("搗蛋鬼／其他", ["role-reveal", "timer", "blackout"])}
      </div>
      <div class="ctrl-emergency">
        <button class="danger" data-act="stage.blackout:1">黑屏</button>
        <button data-act="stage.blackout:0">恢復畫面</button>
        <button class="${v.stage?.lock ? "warn" : ""}" data-act="stage.lock">${v.stage?.lock ? "解鎖大mon" : "鎖定大mon"}</button>
        <button data-act="stage.rules:1">出規則頁</button>
        <button data-act="stage.rules:0">收規則頁</button>
        ${
          mode === "rules"
            ? `<span class="pill">頁 ${((v.stage?.payload?.pageIndex ?? 0) + 1)}/${v.stage?.payload?.totalPages ?? 1}</span>
               <button class="btn-sm" data-act="stage.prevPage">◀ 上一頁</button>
               <button class="btn-sm" data-act="stage.nextPage">下一頁 ▶</button>`
            : ""
        }
      </div>
      <details class="ctrl-settings">
        <summary>進階設定：分數條／auto-close／maxBid</summary>
        <div class="ctrl-settings-body">
          <div class="row wrap">
            <span class="pill">分數條</span>
            <button data-act="ticker.toggle">${v.stage?.ticker?.visible ? "收起" : "顯示"}</button>
            <select id="ticker-sort" data-act="ticker.sort">${["score-desc", "score-asc", "number", "name", "group"]
              .map((s) => `<option value="${s}" ${v.stage?.ticker?.sort === s ? "selected" : ""}>${s}</option>`)
              .join("")}</select>
            <select id="ticker-scope" data-act="ticker.scope">${["player", "group"]
              .map((s) => `<option value="${s}" ${v.stage?.ticker?.scope === s ? "selected" : ""}>${s}</option>`)
              .join("")}</select>
            <select id="ticker-range" data-act="ticker.range">${["total", "current"]
              .map((s) => `<option value="${s}" ${v.stage?.ticker?.range === s ? "selected" : ""}>${s}</option>`)
              .join("")}</select>
          </div>
          <div class="row wrap">
            <span class="pill">auto-close：${v.settings?.autoClose ? "開" : "關"}</span>
            <button data-act="settings.autoclose:${v.settings?.autoClose ? 0 : 1}">${v.settings?.autoClose ? "關咗佢" : "開返"}</button>
            <span class="muted">maxBid ${v.settings?.maxBid}</span>
            <input id="maxbid" type="number" min="1" max="10000" value="${v.settings?.maxBid ?? 100}" style="width:100px">
            <button data-act="settings.maxbid">改上限</button>
          </div>
        </div>
      </details>
      <div class="hint">Activity：${(v.activity ?? []).slice(-4).map((a: any) => esc(a.text)).join("｜") || "—"}</div>
    </div>
  </section>`;
}

function playersSection(v: any): string {
  const groups = v.groups ?? [];
  return `<section><h3>玩家（approved ${v.caps?.approved}/${v.caps?.maxApproved}・pending ${v.caps?.pending}/${v.caps?.maxPending}）</h3>
    <div class="card-box">${(v.players ?? [])
      .map(
        (p: any) => `<div class="player-row">
          <span class="dot ${p.connected ? "on" : ""}"></span>
          <span class="pname">${avatarHtml(p.avatar, 30)} #${p.number} ${esc(p.name)}</span>
          <input type="text" placeholder="改編號" value="${p.number}" data-num="${p.id}" style="width:64px">
          <button class="btn-sm" data-act="player.number:${p.id}">改號</button>
          <input type="text" placeholder="改名" value="${esc(p.name)}" data-name="${p.id}">
          <button class="btn-sm" data-act="player.rename:${p.id}">改名</button>
          ${
            groups.length
              ? `<select data-group="${p.id}"><option value="">個人戰</option>${groups
                  .map((g: any) => `<option value="${g.id}" ${p.groupId === g.id ? "selected" : ""}>${esc(g.name)}</option>`)
                  .join("")}</select><button class="btn-sm" data-act="player.group:${p.id}">搬組</button>`
              : ""
          }
          <span class="pill">${p.status}</span>
          ${p.status !== "approved" ? `<button class="btn-sm primary" data-act="player.approve:${p.id}">批准</button>` : ""}
          ${p.status !== "kicked" ? `<button class="btn-sm danger" data-act="player.kick:${p.id}">踢</button>` : `<button class="btn-sm" data-act="player.approve:${p.id}">恢復</button>`}
          <span class="pscore">${p.score}</span>
          <button class="btn-sm" data-act="score.add:${p.id}:1">+1</button>
          <button class="btn-sm" data-act="score.add:${p.id}:2">+2</button>
          <button class="btn-sm" data-act="score.add:${p.id}:5">+5</button>
          <button class="btn-sm" data-act="score.add:${p.id}:-1">-1</button>
        </div>`,
      )
      .join("")}</div>
  </section>`;
}

function groupsSection(v: any): string {
  const groups = v.groups ?? [];
  return `<section><h3>分組（0–N；0 組＝個人戰）</h3>
    <div class="card-box">
      <div class="btn-row">${[0, 2, 3, 4, 5, 6].map((n) => `<button data-act="groups.set:${n}">${n === 0 ? "個人戰（0 組）" : `${n} 組`}</button>`).join("")}
      <span class="row">自訂 <input id="group-count" type="number" min="0" max="30" value="${groups.length}" style="width:80px"><button data-act="groups.custom">套用</button></span></div>
      <div>${groups.map((g: any) => `<div class="ledger-row"><span class="pill" style="background:${esc(g.color)}66;border-left:8px solid ${esc(g.color)}">${esc(g.name)}</span><span class="muted">id=${esc(g.id)}</span><span class="grow"></span><b>${v.players.filter((p: any) => p.groupId === g.id).length} 人</b></div>`).join("")}</div>
      <div class="hint">搬有分嘅人：選「跟人走」＝分數跟人；「留原組」＝個人分作廢＋一筆 group 補償事件（歷史保留）。</div>
    </div>
  </section>
  <section><h3>搬組</h3>
    <div class="card-box">${(v.players ?? [])
      .filter((p: any) => p.status === "approved")
      .map(
        (p: any) => `<div class="player-row"><span class="pname">#${p.number} ${esc(p.name)}</span>
        <select data-assign-g="${p.id}"><option value="">個人戰</option>${groups.map((g: any) => `<option value="${g.id}" ${p.groupId === g.id ? "selected" : ""}>${esc(g.name)}</option>`).join("")}</select>
        <select data-assign-mode="${p.id}"><option value="follow">跟人走</option><option value="stay">留原組</option></select>
        <button class="btn-sm" data-act="groups.assign:${p.id}">搬</button></div>`,
      )
      .join("")}</div>
  </section>`;
}

function scoreSection(v: any): string {
  const ledger = (v.ledger ?? []).slice(-60).reverse();
  return `<section><h3>加減分／帳簿（${v.ledger?.length ?? 0} 筆）</h3>
    <div class="card-box">
      <div class="row wrap">
        <select id="score-target">${(v.players ?? []).map((p: any) => `<option value="${p.id}">#${p.number} ${esc(p.name)}</option>`).join("")}</select>
        <input id="score-delta" type="number" value="1" style="width:80px">
        <input id="score-reason" placeholder="reason（例：問答 Q3）" value="主持加分" style="width:200px">
        <button class="primary" data-act="score.custom">加分</button>
        <button data-act="score.bulk:1">全場 +1</button>
        <button data-act="score.bulk:-1">全場 -1</button>
      </div>
      <div class="hint">統計：總分 ${v.stats?.total}・平均 ${(v.stats?.avg ?? 0).toFixed(2)}・中位數 ${v.stats?.median}・max ${v.stats?.max}・min ${v.stats?.min}</div>
      <div style="max-height:420px;overflow:auto">${ledger
        .map((e: any) => {
          const targetName =
            e.target.type === "player" ? (v.players.find((p: any) => p.id === e.target.id)?.name ?? e.target.id) : (v.groups.find((g: any) => g.id === e.target.id)?.name ?? e.target.id);
          return `<div class="ledger-row ${e.voided ? "voided" : ""}"><span class="who">${esc(targetName)}</span><span class="delta ${e.delta > 0 ? "pos" : "neg"}">${e.delta > 0 ? "+" : ""}${e.delta}</span><span class="grow">${esc(e.reason)}</span><span class="pill gray">${e.by}</span>${
            e.voided ? `<span class="muted">已作廢</span>` : `<button class="btn-sm danger" data-act="score.void:${e.id}">作廢</button>`
          }</div>`;
        })
        .join("")}</div>
    </div>
  </section>`;
}

function openGradingHtml(v: any): string {
  const round = v.currentRound;
  if (!round) return "";
  const card = (v.cards ?? []).find((c: any) => c.id === round.cardId);
  if (!card || (card.type !== "open" && card.type !== "vote")) return "";
  const subs = (v.submissions ?? []).filter((s: any) => s.roundId === round.id && s.confirmed);
  const rows = subs
    .map((s: any) => {
      const p = (v.players ?? []).find((x: any) => x.id === s.playerId);
      const answer = s.text ?? (s.amount !== undefined ? String(s.amount) : s.choice !== undefined ? `#${s.choice + 1}` : "");
      const judged = s.judged ? `已評 ${s.judged.points} 分` : "未評";
      return `<div class="ledger-row"><span class="who">#${p?.number ?? "?"} ${esc(p?.name ?? s.playerId)}</span><span class="grow">${esc(answer)}</span><span class="pill gray">${judged}</span>
        <button class="btn-sm" data-act="judge.1:${s.id}">+1</button><button class="btn-sm" data-act="judge.2:${s.id}">+2</button><button class="btn-sm" data-act="judge.0:${s.id}">0</button></div>`;
    })
    .join("");
  const numBlock =
    card.openKind === "number"
      ? `<div class="row wrap"><span class="pill">估數字</span>
        <input id="actual-answer" type="number" step="any" placeholder="真實答案" value="${round.actualAnswer ?? card.actualAnswer ?? ""}" style="width:140px">
        <button class="primary" data-act="judge.actual">入真實答案＋最接近 +2</button>
        <span class="muted">${round.actualAnswer !== undefined ? `actualAnswer=${round.actualAnswer}` : "未入"}</span></div>`
      : "";
  return `<div style="border-top:1px solid var(--line);padding-top:10px">
    <div class="row wrap"><b>評分（${subs.length} 份提交）</b>
      <button class="btn-sm primary" data-act="judge.all">一次過全部當答對</button>
      <span class="muted">${card.points} 分／份</span></div>
    ${numBlock}
    <div style="max-height:260px;overflow:auto">${rows || '<div class="muted">未有提交</div>'}</div>
  </div>`;
}

function cardsSection(v: any): string {
  const cur = v.currentItemId;
  const item = (v.rundown ?? []).find((i: any) => i.id === cur);
  const cardIds: string[] = item?.cardIds ?? [];
  const cards = cardIds.map((id) => (v.cards ?? []).find((c: any) => c.id === id)).filter(Boolean);
  const round = v.currentRound;
  const card = round ? (v.cards ?? []).find((c: any) => c.id === round.cardId) : null;
  return `<section><h3>出卡：${esc(item?.title ?? "（未入關）")}</h3>
    <div class="card-box">
      ${round ? `<div class="row wrap"><span class="pill hot">currentRound ${esc(round.id)}・${round.state}</span><span class="muted">已答 ${(v.submissions ?? []).filter((s: any) => s.roundId === round.id && s.confirmed).length}/${round.eligiblePlayerIds.length}</span></div>
        <div class="row wrap"><button data-act="card.close" ${round.state !== "open" ? "disabled" : ""}>收卷</button>
        <button data-act="card.tally" ${round.state === "open" || round.state === "closed" ? "" : "disabled"}>切分佈</button>
        <button class="primary" data-act="card.reveal" ${round.state === "closed" || round.state === "tally" ? "" : "disabled"}>揭曉</button>
        <button data-act="card.reopen">重開（新 round）</button></div>` : `<div class="muted">未開卡</div>`}
      ${cards.length ? `<div>${cards.map((c: any) => `<div class="ledger-row"><span class="pill ${round?.cardId === c.id ? "on" : ""}">${esc(c.type)}</span><span class="grow">${esc(c.prompt)}</span><span class="muted">${c.id}</span><button class="btn-sm primary" data-act="card.open:${c.id}" ${round && (round.state === "open" || round.state === "closed" || round.state === "tally") ? "disabled" : ""}>開</button></div>`).join("")}</div>` : `<div class="hint">呢關未有卡。用下面新增。</div>`}
      ${openGradingHtml(v)}
    </div>
  </section>
  <section><h3>新增卡</h3>
    <div class="card-box">
      <div class="row wrap"><select id="new-card-type"><option value="choice">choice</option><option value="open">open</option><option value="vote">vote</option><option value="manual">manual</option><option value="bid">bid</option></select>
      <input id="new-card-prompt" placeholder="題目／提示" style="flex:1 1 200px">
      <input id="new-card-options" placeholder="選項（用 | 分隔，choice 用）" style="flex:1 1 200px">
      <input id="new-card-seconds" type="number" value="20" style="width:80px">
      <input id="new-card-points" type="number" value="1" style="width:70px">
      <button class="primary" data-act="card.create">新增</button></div>
      <div class="hint">choice 卡填 4 個選項用 | 分隔；正確答案 index 喺卡建立後用「改卡」JSON 改（M1 題庫建議用題庫 tab）。</div>
    </div>
  </section>`;
}

function quizSection(v: any): string {
  const quiz = v.quiz ?? [];
  return `<section><h3>題庫（${quiz.length} 題；改完即時生效）</h3>
    <div class="card-box">
      <div class="btn-row"><button class="primary" data-act="quiz.add:choice">加 MC 題</button><button data-act="quiz.add:open">加 Open 題</button>
      <button data-act="quiz.import">一鍵匯入舊 QUIZ（只 MC，open 只顯示 diff）</button></div>
      <div class="hint">換題只改資料（data/quiz.seed.json／呢個編輯器），唔使改 code。大mon／手機喺 reveal 前永遠唔會見到正解。</div>
      ${
        importReport
          ? `<div class="card-box" style="background:var(--bg-soft)"><b>匯入 diff</b>
            <div class="hint">MC 已匯入／更新：${(importReport.imported ?? []).map((x: string) => esc(x)).join("、") || "冇"}；不變：${(importReport.unchanged ?? []).length} 題</div>
            ${(importReport.diffs ?? []).map((d: any) => `<div class="ledger-row"><span class="pill">${esc(d.id)}</span><span class="grow">「${esc(d.before)}」→「${esc(d.after)}」</span></div>`).join("")}
            <div class="hint">open 題（唔會覆蓋）：${(importReport.skippedOpen ?? []).map((x: any) => `${esc(x.id)}・${esc(x.note)}`).join("；") || "—"}</div>
            <button class="btn-sm" data-act="quiz.clearimport">收起</button></div>`
          : ""
      }
    </div>
    ${quiz
      .map((q: any, i: number) => {
        const opts = q.options ?? ["", "", "", ""];
        return `<div class="quiz-item">
        <div class="qi-head"><span class="pill">${i + 1}. ${esc(q.type)}</span>${q.autoAnswer ? `<span class="pill hot">時間題・server 自動計</span>` : ""}<span class="muted">${esc(q.id)}・${esc(q.category ?? "")}</span><span class="grow"></span>
          <button class="btn-sm" data-act="quiz.copy:${q.id}">複製</button>
          <button class="btn-sm" data-act="quiz.up:${q.id}">↑</button><button class="btn-sm" data-act="quiz.down:${q.id}">↓</button><button class="btn-sm danger" data-act="quiz.del:${q.id}">刪</button></div>
        <textarea data-q-prompt="${q.id}" placeholder="題目">${esc(q.prompt)}</textarea>
        ${q.type === "choice" ? `<div class="row wrap" style="margin-top:6px">${opts.map((o: string, k: number) => `<input data-q-opt="${q.id}:${k}" value="${esc(o)}" placeholder="${String.fromCharCode(65 + k)}" style="flex:1 1 120px">`).join("")}</div>` : ""}
        <div class="row wrap" style="margin-top:6px">
          ${q.type === "choice" ? `<span>正解 <select data-q-correct="${q.id}">${[0, 1, 2, 3].map((k) => `<option value="${k}" ${q.correct === k ? "selected" : ""}>${String.fromCharCode(65 + k)}</option>`).join("")}</select></span>` : ""}
          ${q.type === "open" ? `<span>openKind <select data-q-openkind="${q.id}"><option value="text" ${q.openKind === "text" ? "selected" : ""}>text</option><option value="number" ${q.openKind === "number" ? "selected" : ""}>number</option></select></span>` : ""}
          <span>秒 <input data-q-seconds="${q.id}" type="number" value="${q.seconds ?? 20}" style="width:70px"></span>
          <span>分 <input data-q-points="${q.id}" type="number" value="${q.points ?? 1}" style="width:60px"></span>
          <span>分類 <input data-q-category="${q.id}" value="${esc(q.category ?? "")}" style="width:100px"></span>
        </div>
        <input data-q-hint="${q.id}" value="${esc(q.hint ?? "")}" placeholder="主持貼士（唔會出大mon）" style="width:100%;margin-top:6px">
        <textarea data-q-explanation="${q.id}" placeholder="解釋（reveal 後才出）">${esc(q.explanation ?? "")}</textarea>
        ${q.type === "open" ? `<input data-q-ref="${q.id}" value="${esc(q.referenceAnswer ?? "")}" placeholder="參考答案（例：206 塊）" style="width:100%;margin-top:6px">` : ""}
        <div class="row" style="margin-top:6px"><button class="primary btn-sm" data-act="quiz.save:${q.id}">儲存呢題</button>
        <button class="btn-sm" data-act="card.open:${q.id}">用呢題出卡</button>
        <span class="muted">state=${esc(q.state)}・version=${q.version}</span></div>
      </div>`;
      })
      .join("")}`;
}

function rulesSection(v: any): string {
  const pages = v.rulePages ?? [];
  return `<section><h3>每關規則頁（D30；大mon 開場自動顯示）</h3>
    <div class="card-box">
      <div class="btn-row">${["auction", "draw", "saboteur", "quiz"].map((g) => `<button data-act="rules.new:${g}">加 ${esc(g)} 頁</button>`).join("")}
      <button data-act="rules.reload">載入最新</button></div>
      <div class="hint">兩個 host 同時改同一頁：second 會收 W_RULES_CONFLICT，再載入最新（唔會蓋走）。字數上限：每 block 120 字／全頁 1200 字／blocks ≤20。</div>
    </div>
    ${pages
      .map(
        (p: any) => `<div class="quiz-item">
      <div class="qi-head"><span class="pill ${p.enabled ? "on" : "off"}">${esc(p.gameId)}</span><span class="muted">${esc(p.id)}・v${p.version}・order ${p.order}・${esc(p.updatedBy)}</span><span class="grow"></span>
        <button class="btn-sm" data-act="rules.show:${p.id}">預覽上大mon</button>
        <button class="btn-sm danger" data-act="rules.del:${p.id}">停用</button></div>
      <div class="row wrap"><input data-r-title="${p.id}" value="${esc(p.title)}" placeholder="title ≤16 字" style="flex:2 1 200px">
      <input data-r-sub="${p.id}" value="${esc(p.subtitle ?? "")}" placeholder="subtitle ≤24 字" style="flex:2 1 200px">
      <input data-r-auto="${p.id}" type="number" value="${p.autoAdvanceSeconds ?? 0}" title="自動翻頁秒數（0＝手動）" style="width:90px">
      <label class="row"><input type="checkbox" data-r-enabled="${p.id}" ${p.enabled ? "checked" : ""}> enabled</label></div>
      <textarea data-r-blocks="${p.id}" style="width:100%;min-height:120px;font-family:monospace;font-size:12px">${esc(JSON.stringify(p.blocks, null, 1))}</textarea>
      <div class="row"><button class="primary btn-sm" data-act="rules.save:${p.id}:${p.version}">儲存</button><span class="muted">blocks JSON（heading/paragraph/bullets/steps/callout/kv/score-table/image）</span></div>
    </div>`,
      )
      .join("")}`;
}

function awardsSection(v: any): string {
  const awards = v.awards ?? [];
  const medal: Record<string, string> = { grand: "🥇 大獎", second: "🥈 2獎", third: "🥉 3獎" };
  const rule: Record<string, string> = { grand: "最高分", second: "最接近中位數", third: "最低分" };
  return `<section><h3>頒獎（phase=${v.phase}）</h3>
    <div class="card-box">
      <div class="btn-row"><button class="primary" data-act="award.compute">重算三獎</button><button data-act="award.reset">重設揭曉</button></div>
      <div class="hint">統計：n=${v.stats?.count}・中位數 ${v.stats?.median}・平均 ${(v.stats?.avg ?? 0).toFixed(2)}</div>
      ${awards
        .map((a: any) => {
          const target = (v.players ?? []).find((p: any) => p.id === a.targetId);
          return `<div class="player-row"><span class="pill">${medal[a.id]}</span><span class="grow">${rule[a.id]} → ${target ? `#${target.number} ${esc(target.name)}` : "從缺"}</span>
          <span class="pill ${a.revealed ? "on" : "off"}">${a.revealed ? "已揭曉" : "未揭曉"}</span>
          <select data-award-target="${a.id}"><option value="">—</option>${(v.players ?? []).map((p: any) => `<option value="${p.id}" ${a.targetId === p.id ? "selected" : ""}>#${p.number} ${esc(p.name)}</option>`).join("")}</select>
          <button class="btn-sm" data-act="award.override:${a.id}">手動改</button>
          <button class="btn-sm primary" data-act="award.reveal:${a.id}">揭曉</button></div>`;
        })
        .join("")}
    </div>
  </section>`;
}

function songsSection(v: any): string {
  const songs = v.songs ?? [];
  const lease = v.audioLease;
  const pb = v.playback;
  const round = v.currentRound;
  const curCard = round ? (v.cards ?? []).find((c: any) => c.id === round.cardId) : null;
  const isBid = curCard?.type === "bid";
  const bids = isBid && round ? (v.submissions ?? []).filter((x: any) => x.roundId === round.id && x.confirmed && typeof x.amount === "number") : [];
  const ranked = [...bids].sort((a: any, b: any) => b.amount - a.amount || a.ts - b.ts);
  const winner = ranked[0];
  const second = ranked[1];
  return `<section><h3>音源（media deck・唯一 AudioLease）</h3>
    <div class="card-box">
      <div class="row wrap"><span class="pill ${lease && lease.deckId === ensureDeckId() && !lease.releasedAt ? "on" : "off"}">${lease ? `lease：${esc(lease.deckId)}・gen ${lease.generation}${lease.releasedAt ? "（已到期，等 5s margin）" : ""}` : "冇 lease"}</span>
      <button class="primary" data-act="lease.acquire">申請／接管音源（舊機已離線）</button>
      <button class="warn" data-act="lease.acquireOnline">在線接管（確認舊機仲開住）</button>
      <button data-act="lease.release">放開音源</button>
      <button data-act="media.pause">Pause</button><button data-act="media.resume">繼續</button><button data-act="media.stop">Stop</button>
      <button data-act="media.reveal">揭曉歌名（大mon reveal）</button></div>
      <div class="hint">deck：${esc(deckStatus)}${audioBlocked ? `　<button class="btn-sm" data-act="media.unlock">恢復播放</button>` : ""}</div>
      ${pb ? `<div class="hint">playback：${esc(pb.state)}・song=${esc(pb.songId)}・deck=${esc(pb.deckId ?? "")}・position=${Math.round(pb.positionMs)}ms</div>` : `<div class="hint">未開始播放</div>`}
      <div class="hint">大mon song mode 預設靜音；只有 lease 持有 deck 先會出聲。YouTube／Apple 只係手動提示（D32）。</div>
    </div>
  </section>
  <section><h3>歌單（先入名後補 link／MP3）</h3>
    <div class="card-box">
      <div class="row wrap"><input id="song-title" placeholder="歌名（答案，大mon reveal 前唔會出）" style="flex:1 1 160px">
        <input id="song-url" placeholder="YouTube／Apple Music link（可留空）" style="flex:1 1 180px">
        <button class="primary" data-act="song.add">加歌</button></div>
      <div class="row wrap"><input type="file" id="song-file" accept="audio/mpeg,audio/mp4,audio/*" style="flex:1 1 200px">
        <input id="song-upload-title" placeholder="上傳 MP3 嘅歌名（答案）" style="flex:1 1 160px">
        <button data-act="song.upload">上傳 MP3（≤20MB）</button></div>
      ${songs
        .map(
          (sg: any, i: number) =>
            `<div class="ledger-row"><span class="pill">${i + 1}</span><span class="grow">${esc(sg.title)} <span class="muted">${esc(sg.source?.kind)}${sg.source?.fileName ? "・" + esc(sg.source.fileName) : ""}</span></span>
            <span class="pill ${sg.state === "ready" ? "on" : "off"}">${esc(sg.state)}</span>
            <button class="btn-sm primary" data-act="song.play:${sg.id}">播 15 秒</button>
            <button class="btn-sm" data-act="song.playFull:${sg.id}">由頭播</button>
            <button class="btn-sm danger" data-act="song.del:${sg.id}">刪</button></div>`,
        )
        .join("") || `<div class="muted">未有歌</div>`}
      <div class="hint">MP3／m4a 先可以 deck 自動播；YouTube／Apple link 只會顯示俾主持手動開。</div>
    </div>
  </section>
  <section><h3>拍賣卡（bid・只 points 模式 D32）</h3>
    <div class="card-box">
      <div class="row wrap"><select id="bid-song">${songs.map((sg: any) => `<option value="${sg.id}">${esc(sg.title)}</option>`).join("")}</select>
        <input id="bid-prompt" placeholder="卡題目（例：聽 15 秒，估歌名）" value="聽 15 秒，估歌名" style="flex:1 1 180px">
        <input id="bid-max" type="number" value="100" title="出價上限" style="width:90px">
        <input id="bid-seconds" type="number" value="30" title="秒" style="width:70px">
        <input id="bid-points" type="number" value="5" title="答對分" style="width:70px">
        <button class="primary" data-act="bid.card">新增拍賣卡</button></div>
      ${isBid && round ? `<div class="row wrap"><span class="pill hot">${esc(round.state)}</span><span>出價 ${bids.length} 人</span>
        <span>最高：${winner ? `${esc((v.players ?? []).find((x: any) => x.id === winner.playerId)?.name ?? "?")}（${winner.amount}）` : "—"}</span>
        <span>次高：${second ? `${esc((v.players ?? []).find((x: any) => x.id === second.playerId)?.name ?? "?")}（${second.amount}）` : "—"}</span></div>
        <div class="row wrap"><button class="primary" data-act="bid.settle:1">得標者答對 +${curCard.points}</button><button data-act="bid.settle:0">答錯 0 分</button>
        <button data-act="bid.settleBackup:1">次高價補答（一半分）</button></div>` : `<div class="muted">未開拍賣卡</div>`}
      <div class="hint">最高價得標；同價先交者贏；出價唔扣分。結算後用「揭曉歌名」出 stage reveal。</div>
    </div>
  </section>`;
}

function drawSection(v: any): string {
  const images = (v.assets ?? []).filter((a: any) => a.kind === "image");
  const round = v.currentRound;
  const curCard = round ? (v.cards ?? []).find((c: any) => c.id === round.cardId) : null;
  const works = curCard?.type === "vote" && curCard.voteMode === "works"
    ? (curCard.options ?? []).map((id: string) => images.find((a: any) => a.id === id)).filter(Boolean)
    : [];
  return `<section><h3>畫畫關：影相上牆／作品牆／評審</h3>
    <div class="card-box">
      <div class="row wrap"><input type="file" id="draw-file" accept="image/jpeg,image/png,image/webp" style="flex:1 1 200px">
        <select id="draw-author">${(v.players ?? []).filter((p: any) => p.status === "approved").map((p: any) => `<option value="${p.id}">#${p.number} ${esc(p.name)}</option>`).join("")}</select>
        <button class="primary" data-act="draw.upload">上載作品（≤8MB）</button>
        <button data-act="draw.voteCard">建立「最似」投票卡</button>
        <button data-act="stage.mode:draw-wall">出作品牆</button></div>
      <div class="hint">影相→上載；作品牆只出圖＋作者編號；投票卡會用現有全部作品（一人一票，可以投自己）。</div>
      <div class="works-grid" style="grid-template-columns:repeat(4,1fr)">${images
        .map((a: any) => {
          const author = (v.players ?? []).find((p: any) => p.id === a.authorId);
          return `<div class="work"><img src="/media/${esc(a.file)}" alt=""><div class="cap"><span>${author ? `#${author.number} ${esc(author.name)}` : "未指定作者"}</span>
          <span class="row" style="gap:4px"><button class="btn-sm" data-act="draw.focus:${a.id}">放大</button></span></div>
          <div class="row" style="gap:4px;padding:0 8px 8px"><button class="btn-sm" data-act="draw.judge:${a.id}:1">+1</button><button class="btn-sm" data-act="draw.judge:${a.id}:2">+2</button><button class="btn-sm" data-act="draw.judge:${a.id}:0">0</button></div></div>`;
        })
        .join("") || `<div class="muted">未有作品</div>`}</div>
      ${works.length ? `<div class="hint">投票卡作品：${works.length} 張（開卡後手機投「邊張最似」；reveal 後自動入人氣票＋最似獎）</div>` : ""}
    </div>
  </section>
  <section><h3>作品投票卡</h3><div class="card-box">${cardListSummary(v)}</div></section>`;
}

function cardListSummary(v: any): string {
  const item = (v.rundown ?? []).find((i: any) => i.id === v.currentItemId);
  const cards = (item?.cardIds ?? []).map((id: string) => (v.cards ?? []).find((c: any) => c.id === id)).filter(Boolean);
  return cards.length
    ? cards.map((c: any) => `<div class="ledger-row"><span class="pill">${esc(c.type)}</span><span class="grow">${esc(c.prompt)}</span><span class="muted">${esc(c.id)}</span><button class="btn-sm primary" data-act="card.open:${c.id}">開</button><button class="btn-sm" data-act="delete.card:${c.id}">刪</button></div>`).join("")
    : `<div class="muted">呢關未有卡</div>`;
}

function saboteurSection(v: any): string {
  const st = v.saboteurState;
  const sab = st ? (v.players ?? []).find((p: any) => p.id === st.saboteurId) : null;
  const approved = (v.players ?? []).filter((p: any) => p.status === "approved");
  const alive = st ? approved.filter((p: any) => !(st.eliminatedIds ?? []).includes(p.id)) : approved;
  const rounds = st?.rounds ?? [];
  const lastRound = rounds[rounds.length - 1];
  const pres = lastRound ? `${lastRound.roundId}・${lastRound.state}・${lastRound.votes.length} 票` : "未開輪";
  return `<section><h3>搗蛋鬼（版本 A・§4）</h3>
    <div class="card-box">
      <div class="row wrap"><span class="pill ${st ? "on" : "off"}">${st ? `已派身份：搗蛋鬼＝#${sab?.number ?? "?"} ${esc(sab?.name ?? "?")}` : "未派身份"}</span>
        <span class="muted">${st ? `已淘汰：${(st.eliminatedIds ?? []).length}｜caught=${st.caught}｜finished=${st.finished}` : ""}</span></div>
      <div class="btn-row"><button class="primary" data-act="sab.assign">派身份（1 搗蛋鬼／N 好人）</button>
        <button data-act="sab.open">開／下一輪投票</button>
        <button class="warn" data-act="sab.close">立即計票</button>
        <button data-act="sab.finish">兩輪未完：結算（搗蛋鬼 +5）</button>
        <button class="danger" data-act="sab.reset">重設</button></div>
      <div class="row wrap"><span class="pill">裁決</span>
        <button data-act="sab.retry">重投一次（原 round void）</button>
        <select id="sab-target">${alive.map((p: any) => `<option value="${p.id}">#${p.number} ${esc(p.name)}</option>`).join("")}</select>
        <button class="danger" data-act="sab.eliminate">裁決淘汰佢</button></div>
      <div class="hint">淘汰條件：候選人票數 ≥ ⌊validVotes/2⌋+1 即場淘汰；唯一最高但未過半／平票 → 主持重投或裁決；全體棄權 → 當輪冇人淘汰。揪中：投畀搗蛋鬼嘅人各 +3、搗蛋鬼冇 +5；兩輪都揪唔中 → 搗蛋鬼 +5。</div>
    </div>
  </section>
  <section><h3>全場身份（host-only）</h3>
    <div class="card-box">
      ${approved
        .map((p: any) => {
          const elim = st?.eliminatedIds?.includes(p.id);
          return `<div class="ledger-row ${elim ? "voided" : ""}"><span class="who">#${p.number} ${esc(p.name)}</span>
          <span class="pill ${p.secretRole === "saboteur" ? "hot" : "gray"}">${p.secretRole === "saboteur" ? "😈 搗蛋鬼" : p.secretRole === "crew" ? "🙂 好人" : "未派"}</span>
          <span class="grow"></span><span class="muted">${elim ? "已淘汰" : st ? "在場" : ""}</span></div>`;
        })
        .join("")}
      <div class="hint">round：${esc(pres)}</div>
      ${rounds
        .map((r: any) => `<div class="hint">第 ${r.index} 輪 ${esc(r.roundId)}：${esc(r.state)}・票 ${r.votes.length}・淘汰 ${r.eliminatedId ? esc((v.players ?? []).find((p: any) => p.id === r.eliminatedId)?.name ?? r.eliminatedId) : "—"}・裁決 ${esc(r.decision ?? "—")}${r.retried ? "・重投" : ""}</div>`)
        .join("")}
    </div>
  </section>`;
}

function statusSection(v: any): string {
  return `<section><h3>連線／狀態</h3>
    <div class="card-box">
      <div>連線：host ${v.connections?.hosts}・stage ${v.connections?.stages}・player ${v.connections?.players}・total ${v.connections?.total}</div>
      <div>phase=${esc(v.phase)}・stage.mode=${esc(v.stage?.mode)}・revision=${v.revision}・seq=${v.seq}・seqEpoch=${esc(v.seqEpoch)}</div>
      <div>房碼：<b style="color:var(--accent);font-size:22px">${esc(v.roomCode)}</b>（PK 開 <a href="/play?code=${esc(v.roomCode)}" style="color:var(--blue)">/play</a>）</div>
      <div>journal：唯一真相；重啟自動 replay。export 一鍵出 CSV＋room.json。</div>
      <div class="btn-row"><button class="primary" data-act="export.csv">下載評論 CSV</button><button data-act="export.room">下載 room.json</button><button data-act="export.all">寫入 server data/export</button></div>
      <div class="hint">${lastCmdError ? esc(lastCmdError) : "token TTL 8 小時；過期會自動要 PIN 重 login。"}</div>
    </div>
  </section>`;
}

function render(): void {
  const root = el<HTMLDivElement>("#host-root");
  if (!root) return;
  if (!token) {
    renderLogin();
    return;
  }
  const v = view;
  if (!v) {
    root.innerHTML = `<div class="login-wrap"><div class="waiting">連線中…</div></div>`;
    return;
  }
  let body = "";
  if (tab === "control") body = controlSection(v);
  else if (tab === "players") body = playersSection(v);
  else if (tab === "groups") body = groupsSection(v);
  else if (tab === "score") body = scoreSection(v);
  else if (tab === "cards") body = cardsSection(v);
  else if (tab === "quiz") body = quizSection(v);
  else if (tab === "rules") body = rulesSection(v);
  else if (tab === "songs") body = songsSection(v);
  else if (tab === "draw") body = drawSection(v);
  else if (tab === "saboteur") body = saboteurSection(v);
  else if (tab === "awards") body = awardsSection(v);
  else body = statusSection(v);
  root.innerHTML = `
    ${connBanner(status, v)}
    <div class="host-top">
      <b>主持台</b>
      <span class="pill">房碼 ${esc(v.roomCode)}</span>
      <span class="pill">phase ${esc(v.phase)}</span>
      <span class="pill">mode ${esc(v.stage?.mode)}</span>
      <span class="pill">rev ${v.revision}</span>
      <span class="pill">${esc(hostName)}</span>
      <span class="grow"></span>
      <button class="btn-sm ghost" data-act="logout">登出</button>
    </div>
    <div class="host-tabs"><div class="tabbar">${TABS.map(([id, label]) => `<button class="${tab === id ? "active" : ""}" data-act="tab:${id}">${label}</button>`).join("")}</div></div>
    <div class="host-wrap">${body}</div>
    <div id="toast"></div>`;
  bindDelegates();
  syncDeck();
}

function val(sel: string): string {
  return (el<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(sel)?.value ?? "").trim();
}
function checked(sel: string): boolean {
  return el<HTMLInputElement>(sel)?.checked === true;
}

function bindDelegates(): void {
  const root = el<HTMLDivElement>("#host-root");
  if (!root) return;
  root.addEventListener("click", (ev) => {
    const target = (ev.target as HTMLElement | null)?.closest("[data-act]") as HTMLElement | null;
    if (!target) return;
    const act = target.dataset.act ?? "";
    void handleAct(act);
  });
  for (const sel of root.querySelectorAll<HTMLSelectElement>("[data-act='ticker.sort'],[data-act='ticker.scope'],[data-act='ticker.range']")) {
    sel.addEventListener("change", () => void tickerChange());
  }
}

async function tickerChange(): Promise<void> {
  await cmd("stage.ticker", undefined, {
    sort: val("#ticker-sort") || undefined,
    scope: val("#ticker-scope") || undefined,
    range: val("#ticker-range") || undefined,
  });
}

async function uploadFile(kind: "audio" | "image", fields: Record<string, string>, inputSel: string): Promise<any> {
  const input = el<HTMLInputElement>(inputSel);
  const file = input?.files?.[0];
  if (!file) {
    showToast("先揀一個檔案");
    return null;
  }
  if (!token) return null;
  const fd = new FormData();
  fd.append("kind", kind);
  for (const [k, v] of Object.entries(fields)) if (v) fd.append(k, v);
  fd.append("file", file, file.name);
  try {
    const res = await fetch("/api/host/upload", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd });
    const json = await res.json().catch(() => null);
    if (!json?.ok) {
      showToast(`${json?.code ?? "UPLOAD_FAIL"}：${json?.message ?? "上傳失敗"}`);
      return null;
    }
    showToast(kind === "audio" ? `上傳完成（已加入歌單）` : `上傳完成（作品已上牆）`);
    return json;
  } catch (err) {
    showToast("上傳失敗：" + String(err));
    return null;
  }
}

async function refreshExport(format: string): Promise<void> {
  if (!token) return;
  const res = await api(`/api/host/export?format=${format}`, { token });
  if (!res?.ok) {
    showToast("export 失敗");
    return;
  }
  const text = format === "csv" ? `${res.playersCsv}\n\n${res.ledgerCsv}` : JSON.stringify(res.room ?? res, null, 2);
  const blob = new Blob([text], { type: format === "csv" ? "text/csv" : "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `hbd-${format}-${Date.now()}.${format === "csv" ? "csv" : "json"}`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function handleAct(act: string): Promise<void> {
  const [name, a1, a2] = act.split(":");
  switch (name) {
    case "tab":
      tab = a1 ?? "control";
      render();
      return;
    case "logout":
      lsDel("hbd.hostToken");
      live?.close();
      token = null;
      renderLogin();
      return;
    case "rd":
      await cmd(`rundown.${a1}`);
      break;
    case "room":
      if (a1 === "start") await cmd("room.start");
      else await cmd("room.phase", undefined, { phase: a1 });
      break;
    case "stage":
      if (a1 === "nextPage") await cmd("stage.page", undefined, { pageIndex: (view?.stage?.payload?.pageIndex ?? 0) + 1 });
      else if (a1 === "prevPage") await cmd("stage.page", undefined, { pageIndex: Math.max(0, (view?.stage?.payload?.pageIndex ?? 0) - 1) });
      else if (a1 === "lock") await cmd("stage.lock", undefined, { lock: !view?.stage?.lock });
      else if (a1 === "blackout") await cmd("stage.blackout", undefined, { on: a2 === "1" });
      else if (a1 === "rules") await cmd("stage.rules", undefined, { on: a2 === "1" });
      else await cmd("stage.set", undefined, { mode: a1 });
      break;
    case "ticker":
      if (a1 === "toggle") await cmd("stage.ticker", undefined, { visible: !view?.stage?.ticker?.visible });
      break;
    case "settings":
      if (a1 === "autoclose") await cmd("settings.set", undefined, { autoClose: a2 === "1" });
      if (a1 === "maxbid") await cmd("settings.set", undefined, { maxBid: Number(val("#maxbid")) });
      break;
    default:
      break;
  }
  // 第二段：需要 id 嘅 action
  const parts = act.split(":");
  const key = parts[0];
  const id = parts[1] ?? "";
  const arg = parts[2];
  if (key === "player") {
    if (id === "approve" && arg) await cmd("player.approve", arg);
    else if (id === "kick" && arg) await cmd("player.kick", arg);
    else if (id === "number" && arg) await cmd("player.update", arg, { number: Number(val(`[data-num="${arg}"]`)) });
    else if (id === "rename" && arg) await cmd("player.update", arg, { name: val(`[data-name="${arg}"]`) });
    else if (id === "group" && arg) await cmd("groups.assign", undefined, { playerId: arg, groupId: val(`[data-group="${arg}"]`) || null, mode: "follow" });
  } else if (key === "groups") {
    if (id === "set") await cmd("groups.set", undefined, { count: Number(arg) });
    else if (id === "custom") await cmd("groups.set", undefined, { count: Number(val("#group-count")) });
    else if (id === "assign" && arg) await cmd("groups.assign", undefined, { playerId: arg, groupId: val(`[data-assign-g="${arg}"]`) || null, mode: val(`[data-assign-mode="${arg}"]`) || "follow" });
  } else if (key === "score") {
    if (id === "add" && arg) await cmd("score.add", arg, { targetType: "player", delta: Number(arg) });
    else if (id === "bulk" && arg) await cmd("score.bulk", undefined, { delta: Number(arg), reason: "全場分" });
    else if (id === "void" && arg) await cmd("score.void", arg);
    else if (id === "custom") {
      await cmd("score.add", val("#score-target"), {
        targetType: "player",
        targetId: val("#score-target"),
        delta: Number(val("#score-delta")),
        reason: val("#score-reason") || "主持加分",
      });
    }
  } else if (key === "card") {
    if (id === "open" && arg) await cmd("card.open", arg);
    else if (id === "close") await cmd("card.close");
    else if (id === "tally") await cmd("card.tally");
    else if (id === "reveal") await cmd("card.reveal");
    else if (id === "reopen") await cmd("card.reopen", view?.currentRound?.cardId);
    else if (id === "create") {
      const opts = val("#new-card-options").split("|").map((s) => s.trim()).filter(Boolean);
      await cmd("card.create", undefined, {
        card: {
          type: val("#new-card-type"),
          prompt: val("#new-card-prompt"),
          options: opts.length ? opts : undefined,
          seconds: Number(val("#new-card-seconds")) || null,
          points: Number(val("#new-card-points")) || 1,
        },
      });
    }
  } else if (key === "judge") {
    if (id === "actual") {
      const round = view?.currentRound;
      const val2 = Number(val("#actual-answer"));
      if (!round || !Number.isFinite(val2)) {
        showToast("要入真實答案數字");
        return;
      }
      await cmd("quiz.setActualAnswer", undefined, { roundId: round.id, actualAnswer: val2 });
    } else if (id === "all") {
      await cmd("score.judge", undefined, { roundId: view?.currentRound?.id, allCorrect: true });
    } else if (arg) {
      const points = Number(id);
      await cmd("score.judge", undefined, { roundId: view?.currentRound?.id, submissionId: arg, points, correct: points > 0 });
    }
  } else if (key === "quiz") {
    if (id === "clearimport") {
      importReport = null;
      render();
      return;
    }
    if (id === "add") {
      await cmd("quiz.upsert", undefined, {
        question: { type: arg, prompt: "新題目（改我）", category: "", seconds: arg === "choice" ? 20 : 45, points: arg === "choice" ? 1 : 2, openKind: arg === "open" ? "text" : undefined, options: arg === "choice" ? ["A", "B", "C", "D"] : undefined, correct: arg === "choice" ? 0 : undefined },
      });
    } else if (id === "del" && arg) await cmd("quiz.delete", arg);
    else if (id === "copy" && arg) {
      const q = (view.quiz ?? []).find((x: any) => x.id === arg);
      if (!q) return;
      await cmd("quiz.upsert", undefined, {
        question: { type: q.type, category: q.category, prompt: `${q.prompt}（複製）`, options: q.options, correct: q.correct, explanation: q.explanation, hint: q.hint, openKind: q.openKind, referenceAnswer: q.referenceAnswer, seconds: q.seconds, points: q.points },
      });
    }
    else if (id === "save" && arg) {
      const q = (view.quiz ?? []).find((x: any) => x.id === arg);
      if (!q) return;
      const options = q.type === "choice" ? [0, 1, 2, 3].map((k) => val(`[data-q-opt="${arg}:${k}"]`)) : undefined;
      await cmd("quiz.upsert", undefined, {
        question: {
          id: arg,
          type: q.type,
          category: val(`[data-q-category="${arg}"]`),
          prompt: val(`[data-q-prompt="${arg}"]`),
          options,
          correct: q.type === "choice" ? Number(val(`[data-q-correct="${arg}"]`)) : undefined,
          explanation: val(`[data-q-explanation="${arg}"]`),
          hint: val(`[data-q-hint="${arg}"]`),
          openKind: q.type === "open" ? val(`[data-q-openkind="${arg}"]`) : undefined,
          referenceAnswer: q.type === "open" ? val(`[data-q-ref="${arg}"]`) || undefined : undefined,
          seconds: Number(val(`[data-q-seconds="${arg}"]`)) || undefined,
          points: Number(val(`[data-q-points="${arg}"]`)) || undefined,
        },
      });
    } else if (id === "import") {
      const res = await fetch("/quiz-legacy-mc.json").then((r) => r.json()).catch(() => null);
      if (!res) {
        showToast("搵唔到舊 QUIZ 資料");
        return;
      }
      const r2 = await cmd("quiz.import", undefined, { questions: res.questions });
      importReport = r2?.ok ? r2.result : null;
      showToast(r2?.ok ? `匯入完成：${res.questions.length} 題 MC（open 題唔會蓋）` : "匯入失敗");
      render();
    } else if (id === "up" || id === "down") {
      const ids = (view.quiz ?? []).map((q: any) => q.id);
      const i = ids.indexOf(arg);
      const j = id === "up" ? i - 1 : i + 1;
      if (i >= 0 && j >= 0 && j < ids.length) {
        const tmp = ids[i];
        ids[i] = ids[j];
        ids[j] = tmp;
        await cmd("quiz.reorder", undefined, { ids });
      }
    }
  } else if (key === "rules") {
    if (id === "new" && arg) {
      await cmd("rules.upsert", undefined, {
        page: { gameId: arg, title: "新規則頁", subtitle: "", blocks: [{ type: "heading", text: "玩法" }], order: (view.rulePages?.length ?? 0) + 1, enabled: true, autoAdvanceSeconds: 0 },
      });
    } else if (id === "save" && arg) {
      const version = Number(arg);
      let blocks: any = [];
      try {
        blocks = JSON.parse(val(`[data-r-blocks="${id}"]`) || "[]");
      } catch {
        showToast("blocks JSON 格式錯");
        return;
      }
      const page = (view.rulePages ?? []).find((p: any) => p.id === id);
      if (!page) return;
      const res = await cmd("rules.upsert", undefined, {
        page: {
          id,
          gameId: page.gameId,
          title: val(`[data-r-title="${id}"]`),
          subtitle: val(`[data-r-sub="${id}"]`),
          blocks,
          order: page.order,
          enabled: checked(`[data-r-enabled="${id}"]`),
          autoAdvanceSeconds: Number(val(`[data-r-auto="${id}"]`)) || 0,
        },
        expectedVersion: version,
      });
      if (res && !res.ok && res.code === "W_RULES_CONFLICT") {
        showToast("版本衝突（第二個 host 改過）→ 已載入最新");
        live?.resync();
      }
    } else if (id === "del" && arg) await cmd("rules.delete", arg);
    else if (id === "show" && arg) await cmd("stage.rules", undefined, { on: true, rulePageId: arg });
    else if (id === "reload") live?.resync();
  } else if (key === "song") {
    if (id === "add") {
      await cmd("song.upsert", undefined, { song: { title: val("#song-title"), url: val("#song-url") } });
    } else if (id === "upload") {
      await uploadFile("audio", { title: val("#song-upload-title") }, "#song-file");
    } else if (id === "play" && arg) {
      await cmd("media.play", arg, { songId: arg, deckId, window: [0, 15000] });
    } else if (id === "playFull" && arg) {
      await cmd("media.play", arg, { songId: arg, deckId, fromStart: true, window: [0, 600000] });
    } else if (id === "del" && arg) await cmd("song.delete", arg);
  } else if (key === "media") {
    if (id === "pause") await cmd("media.pause", undefined, { deckId });
    else if (id === "resume") await cmd("media.resume", undefined, { deckId });
    else if (id === "stop") await cmd("media.stop", undefined, { deckId });
    else if (id === "reveal") await cmd("media.reveal");
    else if (id === "unlock") {
      const a = deckAudio();
      a?.play().then(() => {
        audioBlocked = false;
        render();
      }).catch(() => showToast("瀏覽器仍然擋 autoplay：撳一下頁面再試"));
    }
  } else if (key === "lease") {
    if (id === "acquire") {
      const r = await cmd("lease.acquire", undefined, { deckId });
      if (r && !r.ok) showToast(r.message ?? "接管失敗（等 margin）");
      else deckStatus = "已申請音源";
      scheduleLeasePause();
    } else if (id === "acquireOnline") {
      const r = await cmd("lease.acquire", undefined, { deckId, forceOnline: true });
      if (r && !r.ok) showToast(r.message ?? "在線接管失敗");
      else deckStatus = "在線接管成功（舊 deck 即時停）";
      scheduleLeasePause();
    } else if (id === "release") {
      await cmd("lease.release", undefined, { deckId });
    }
  } else if (key === "bid") {
    if (id === "card") {
      await cmd("card.create", undefined, {
        card: {
          type: "bid",
          gameId: "auction",
          prompt: val("#bid-prompt") || "聽 15 秒，估歌名",
          songId: val("#bid-song"),
          maxBid: Number(val("#bid-max")) || 100,
          seconds: Number(val("#bid-seconds")) || 30,
          points: Number(val("#bid-points")) || 5,
        },
      });
    } else if (id === "settle") {
      await cmd("bid.settle", undefined, { roundId: view?.currentRound?.id, correct: arg === "1" });
    } else if (id === "settleBackup") {
      await cmd("bid.settle", undefined, { roundId: view?.currentRound?.id, correct: false, backup: true });
    }
  } else if (key === "draw") {
    if (id === "upload") {
      await uploadFile("image", { authorId: val("#draw-author") }, "#draw-file");
    } else if (id === "voteCard") {
      const images = (view?.assets ?? []).filter((a: any) => a.kind === "image");
      if (!images.length) {
        showToast("先上載作品");
        return;
      }
      await cmd("card.create", undefined, {
        card: {
          type: "vote",
          gameId: "draw",
          voteMode: "works",
          prompt: "邊張畫最似？投佢一票",
          options: images.map((a: any) => a.id),
          seconds: 30,
          points: 1,
        },
      });
    } else if (id === "judge") {
      const seg = act.split(":");
      const assetId = seg[2] ?? "";
      const points = Number(seg[3] ?? "1");
      await cmd("draw.judge", view?.currentRound?.cardId ?? "", { cardId: view?.currentRound?.cardId, assetId, points });
    } else if (id === "focus") {
      await cmd("draw.focus", undefined, { assetId: arg || null });
    }
  } else if (key === "sab") {
    if (id === "assign") await cmd("saboteur.assign");
    else if (id === "open") await cmd("saboteur.openRound");
    else if (id === "close") await cmd("saboteur.closeRound");
    else if (id === "retry") await cmd("saboteur.decide", undefined, { decision: "retry", roundId: view?.currentRound?.id });
    else if (id === "eliminate") await cmd("saboteur.decide", undefined, { decision: "eliminate", roundId: view?.currentRound?.id, targetId: val("#sab-target") });
    else if (id === "finish") await cmd("saboteur.finish");
    else if (id === "reset") await cmd("saboteur.reset");
  } else if (key === "delete") {
    if (id === "card" && arg) await cmd("card.delete", arg);
  } else if (key === "award") {
    if (id === "compute") await cmd("award.compute");
    else if (id === "reset") await cmd("award.reset");
    else if (id === "reveal" && arg) await cmd("award.reveal", undefined, { id: arg });
    else if (id === "override" && arg) await cmd("award.override", undefined, { id: arg, targetId: val(`[data-award-target="${arg}"]`) || null });
  } else if (key === "export") {
    if (id === "csv") await refreshExport("csv");
    else if (id === "room") await refreshExport("room");
    else if (id === "all") {
      await refreshExport("json");
      showToast("已寫入 server data/export（同時下載）");
    }
  }
}

function boot(): void {
  ensureDeckId();
  startDeckTimer();
  const saved = lsGet<{ token: string; hostName: string; roomCode: string; hostId: string }>("hbd.hostToken");
  if (saved?.token) {
    token = saved.token;
    hostName = saved.hostName ?? "主持";
    roomCode = saved.roomCode ?? "";
    hostId = saved.hostId ?? "";
    startLive();
  } else {
    renderLogin();
  }
}

void boot();
