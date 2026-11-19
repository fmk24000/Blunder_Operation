/** 手機 /play（單向提交；PLAN-v3.1 §8.3／§9.4.1 D28） */
import { Live, api, esc, avatarHtml, connBanner, showToast, fmtClock, el, lsGet, lsSet, lsDel } from "./common.js";
const EMOJIS = ["😀", "😎", "🤩", "🥳", "😺", "🐶", "🐱", "🦊", "🐼", "🐨", "🦁", "🐯", "🐸", "🐵", "🦄", "🐮", "🐷", "🐔", "🐧", "🐦", "🦉", "🦋", "🐝", "🐢", "🐙", "🦀", "🐬", "🐳", "🦖", "🦕", "🌞", "🌙", "⭐", "🌈", "🍕", "🍔", "🍟", "🍣", "🍜", "🍩", "🍰", "🍦", "🍎", "🍉", "⚽", "🏀", "🎮", "🎸"];
const COLORS = ["#ef4444", "#f97316", "#f59e0b", "#22c55e", "#14b8a6", "#3b82f6", "#a855f7", "#ec4899"];
let live = null;
let view = null;
let status = "connecting";
let roomCode = "";
let token = null;
let avatarSel = { emoji: "😀", color: COLORS[0] };
let joinError = "";
let selected = {};
let submitting = false;
let submitError = "";
let timer = null;
function dv() {
    return view;
}
function keyDraft(roundId) {
    return `hbd.draft.${view?.roomCode ?? roomCode}.${roundId}`;
}
function keyPending(roundId) {
    return `hbd.pending.${view?.roomCode ?? roomCode}.${roundId}`;
}
async function sha256Hex(text) {
    const data = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function renderJoin() {
    const root = el("#play-root");
    if (!root)
        return;
    root.innerHTML = `
    <div class="play-wrap">
      <div class="play-head"><span>壽星黑歷史</span><span>房碼 ${esc(roomCode || "…")}</span></div>
      <div class="play-card">
        <div class="play-q">你叫咩名？</div>
        <input id="join-name" maxlength="12" placeholder="名（最多 12 字）" autocomplete="off">
        <div class="field-label">揀個頭像</div>
        <div id="emoji-grid">${EMOJIS.map((e) => `<button class="emoji-btn ${e === avatarSel.emoji ? "primary" : ""}" data-emoji="${esc(e)}">${e}</button>`).join("")}</div>
        <div id="color-grid">${COLORS.map((c) => `<button data-color="${c}" style="background:${c};${c === avatarSel.color ? "outline:2px solid #16150f;outline-offset:2px" : ""}"></button>`).join("")}</div>
        ${joinError ? `<div class="error-box">${esc(joinError)}</div>` : ""}
        <button class="primary" id="join-btn">入場</button>
      </div>
      <div class="helptext">入場後等主持批准，大mon 會見到你個頭像。</div>
    </div>`;
    for (const btn of root.querySelectorAll("[data-emoji]")) {
        btn.addEventListener("click", () => {
            avatarSel.emoji = btn.dataset.emoji ?? "😀";
            renderJoin();
        });
    }
    for (const btn of root.querySelectorAll("[data-color]")) {
        btn.addEventListener("click", () => {
            avatarSel.color = btn.dataset.color ?? COLORS[0];
            renderJoin();
        });
    }
    el("#join-btn")?.addEventListener("click", () => void doJoin());
    el("#join-name")?.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter")
            void doJoin();
    });
}
async function doJoin() {
    const nameInput = el("#join-name");
    const name = (nameInput?.value ?? "").trim();
    if (!name) {
        joinError = "打個名先";
        renderJoin();
        return;
    }
    const res = await api("/api/join", { method: "POST", body: { code: roomCode, name, avatar: { kind: "emoji", emoji: avatarSel.emoji, color: avatarSel.color } } });
    if (!res?.ok) {
        joinError = `${res?.code ?? "ERROR"}：${res?.message ?? "入唔到場"}`;
        renderJoin();
        return;
    }
    token = res.playerToken;
    lsSet("hbd.playerToken", { token: res.playerToken, playerId: res.playerId, name, roomCode });
    joinError = "";
    startLive();
}
function startLive() {
    if (!token)
        return;
    if (live)
        live.close();
    live = new Live({
        role: "player",
        code: roomCode,
        token,
        onView: (v) => {
            handleView(v);
        },
        onStatus: (s) => {
            status = s;
            render();
        },
        onAuthFail: () => {
            lsDel("hbd.playerToken");
            token = null;
            renderJoin();
        },
        onError: (code, msg) => {
            submitError = `${code}：${msg}`;
            render();
        },
        onSubmitResult: (msg) => {
            submitting = false;
            const roundId = msg.roundId;
            if (msg.status === "accepted" || msg.status === "duplicate") {
                submitError = "";
                lsDel(keyPending(roundId));
                lsDel(keyDraft(roundId));
                selected = {};
            }
            else {
                // 明確拒絕：保留內容俾用戶睇
                submitError = `${msg.code ?? "拒絕"}：${msg.message ?? "交唔到"}`;
                if (msg.code === "W_ROUND_CLOSED" || msg.code === "W_ALREADY_STATE")
                    lsDel(keyPending(roundId));
            }
            render();
        },
    });
    live.connect();
    if (timer)
        window.clearInterval(timer);
    timer = window.setInterval(updateClock, 100);
}
function handleView(v) {
    view = v;
    // 未 ACK 嘅提交：重連後同 ID 重送（server 只處理一次）
    const pend = lsGet(keyPending(v.task?.roundId ?? v.mySubmission?.roundId ?? "x"));
    const roundId = v.task?.roundId ?? v.mySubmission?.roundId ?? "";
    if (pend && pend.roundId === roundId && v.mySubmission?.status === "none" && v.task) {
        void sendSubmit(pend.payload, pend.submissionId);
    }
    if (v.task) {
        const draft = lsGet(keyDraft(v.task.roundId));
        if (draft && v.mySubmission?.status === "none")
            selected = draft;
    }
    render();
}
function updateClock() {
    const task = view?.task;
    for (const node of document.querySelectorAll("[data-countdown]")) {
        const left = live?.msLeft(task?.endsAt) ?? null;
        node.textContent = left === null ? "—" : fmtClock(left);
        node.style.color = left !== null && left <= 5000 ? "var(--red)" : "";
    }
    showToast(view?.toast);
}
function confirmButton(label, enabled) {
    return `<button class="primary" id="confirm-btn" ${enabled && !submitting ? "" : "disabled"}>${submitting ? "送出中…" : label}</button>`;
}
function renderTask(v) {
    const task = v.task;
    const submitted = v.mySubmission?.status === "submitted";
    const left = live?.msLeft(task.endsAt);
    const clock = left === null ? "" : `<div class="row" style="justify-content:space-between"><span class="muted">剩</span><span data-countdown="1" style="font-size:28px;font-weight:800;color:var(--accent)">--</span></div>`;
    if (submitted) {
        const mine = v.mySubmission;
        const shown = mine.choice !== undefined ? `A/B/C/D #${(mine.choice ?? 0) + 1}` : mine.amount !== undefined ? `${mine.amount}` : mine.text ? esc(mine.text) : "";
        return `<div class="play-card"><div class="play-q">${esc(task.prompt)}</div>
      <div class="reveal-box">已提交${shown ? `：<b>${shown}</b>` : ""}。等其他人…</div>
      <div class="muted">已答 ${v.progress?.answered ?? "?"}/${v.progress?.eligible ?? "?"}</div></div>`;
    }
    if (task.kind === "choice") {
        const opts = task.options ?? [];
        return `<div class="play-card">
      <div class="play-q">${esc(task.prompt)}</div>${clock}
      <div class="play-options">${opts
            .map((o, i) => `<button class="play-option ${selected.choice === i ? "selected" : ""}" data-choice="${i}"><span class="letter">${String.fromCharCode(65 + i)}</span><span>${esc(o)}</span></button>`)
            .join("")}</div>
      ${submitError ? `<div class="error-box">${esc(submitError)}</div>` : ""}
      ${confirmButton(selected.choice === undefined ? "揀一個" : "確認送出", selected.choice !== undefined)}
    </div>`;
    }
    if (task.kind === "open") {
        const isNum = task.openKind === "number";
        const draft = isNum ? (selected.choice !== undefined ? String(selected.choice) : "") : (selected.targetId ?? "");
        return `<div class="play-card">
      <div class="play-q">${esc(task.prompt)}</div>${clock}
      ${isNum
            ? `<div class="bid-input">${esc(draft || "0")}</div><div class="keypad">${["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"]
                .map((k) => `<button data-key="${k}">${k}</button>`)
                .join("")}</div>`
            : `<input id="open-text" maxlength="60" placeholder="輸入答案（≤60 字）" value="${esc(draft)}">`}
      ${submitError ? `<div class="error-box">${esc(submitError)}</div>` : ""}
      ${confirmButton("確認送出", isNum ? draft !== "" : false)}
    </div>`;
    }
    if (task.kind === "vote") {
        const opts = task.voteOptions ?? [];
        return `<div class="play-card">
      <div class="play-q">${esc(task.prompt)}</div>${clock}
      <div class="play-options">${opts
            .map((o, i) => `<button class="play-option ${/^\d+$/.test(String(o.id)) ? (selected.choice === Number(o.id) ? "selected" : "") : selected.targetId === String(o.id) ? "selected" : ""}" data-vote="${esc(o.id)}" data-vote-index="${i}"><span class="letter">${i + 1}</span>${o.avatar ? avatarHtml(o.avatar, 34) : ""}<span>${esc(o.label)}</span></button>`)
            .join("")}</div>
      ${submitError ? `<div class="error-box">${esc(submitError)}</div>` : ""}
      ${confirmButton(selected.targetId || selected.choice !== undefined ? "確認送出" : "揀一個", !!selected.targetId || selected.choice !== undefined)}
    </div>`;
    }
    if (task.kind === "bid") {
        const draft = selected.choice !== undefined ? String(selected.choice) : "";
        return `<div class="play-card">
      <div class="play-q">${esc(task.prompt)}</div>
      <div class="muted">出價上限 ${task.maxBid}（出價唔會扣分）</div>${clock}
      <div class="bid-input">${esc(draft || "0")}</div>
      <div class="keypad">${["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "⌫"]
            .map((k) => `<button data-key="${k}">${k}</button>`)
            .join("")}</div>
      ${submitError ? `<div class="error-box">${esc(submitError)}</div>` : ""}
      ${confirmButton("確認出價", draft !== "")}
    </div>`;
    }
    return `<div class="play-card"><div class="play-q">${esc(task.prompt)}</div><div class="waiting">等主持…</div></div>`;
}
function renderReveal(v) {
    const r = v.reveal;
    const my = r.myResult;
    const resText = my === "correct" ? "✅ 你答對" : my === "wrong" ? "❌ 你答錯" : my === "unjudged" ? "主持評分中" : "冇提交";
    return `<div class="play-card">
    <div class="play-q">${esc(r.myResult !== "none" ? "揭曉" : "揭曉")}</div>
    <div style="font-size:22px;font-weight:800">${resText}</div>
    ${r.correct !== undefined ? `<div class="reveal-box">正解：<b>${String.fromCharCode(65 + r.correct)}</b>${r.explanation ? `<br>${esc(r.explanation)}` : ""}</div>` : ""}
    ${r.referenceAnswer ? `<div class="reveal-box">參考答案：<b>${esc(r.referenceAnswer)}</b></div>` : ""}
    ${r.actualAnswer !== undefined && !r.referenceAnswer ? `<div class="reveal-box">正確答案：<b>${esc(r.actualAnswer)}</b></div>` : ""}
  </div>`;
}
function render() {
    const root = el("#play-root");
    if (!root)
        return;
    const v = view;
    if (!v) {
        root.innerHTML = `<div class="play-wrap"><div class="waiting">連線中…</div></div>`;
        return;
    }
    const me = v.me;
    let body = "";
    if (me.status === "pending") {
        body = `<div class="play-card"><div class="play-q">等主持批准入場</div><div class="waiting">你係 #${me.number} ${esc(me.name)}</div>${v.players?.length ? `<div class="joined-list">${(v.players ?? []).map((p) => `${avatarHtml(p.avatar, 36)}`).join("")}</div>` : ""}</div>`;
    }
    else if (v.mode === "blackout") {
        body = `<div class="play-card"><div class="waiting">大mon 黑屏中…</div></div>`;
    }
    else if (me.status === "kicked") {
        body = `<div class="play-card"><div class="error-box">你已被主持移出房間</div></div>`;
    }
    else if (v.roleInfo) {
        body = `<div class="role-card"><div style="font-size:18px;letter-spacing:2px">你嘅秘密身份</div><div class="r">${v.roleInfo.secretRole === "saboteur" ? "😈 搗蛋鬼" : "🙂 好人"}</div>${v.roleInfo.secretRole === "saboteur" ? `<div class="muted" style="margin-top:8px">唔好太明顯！兩輪都揪唔中你就贏 +5</div>` : `<div class="muted" style="margin-top:8px">兩輪投票揪出搗蛋鬼</div>`}${v.roleInfo.saboteurAnswer ? `<div class="reveal-box" style="margin-top:10px">正解提示：${esc(v.roleInfo.saboteurAnswer)}</div>` : ""}</div>`;
        if (v.task)
            body += renderTask(v);
        else
            body += `<div class="play-card"><div class="waiting">等主持下一步…</div></div>`;
    }
    else if (v.reveal) {
        body = renderReveal(v);
    }
    else if (v.task) {
        body = renderTask(v);
    }
    else if (v.finale) {
        const rows = (v.finale.entries ?? [])
            .slice(0, 10)
            .map((s, i) => `<div class="row" style="justify-content:space-between;font-size:18px"><span>${i + 1}. ${esc(s.name)}${s.id === me.id ? "（我）" : ""}</span><b style="color:var(--accent)">${s.score}</b></div>`)
            .join("");
        body = `<div class="play-card"><div class="play-q">結算</div>${rows}</div>`;
    }
    else {
        body = `<div class="play-card"><div class="play-q">${v.phase === "lobby" ? "等主持開始" : "等主持指示"}</div><div class="waiting">大mon 會有畫面</div></div>`;
    }
    root.innerHTML = `
    <div class="play-wrap">
    ${body}
    ${submitError ? `<div class="error-box">${esc(submitError)}</div>` : ""}
    ${connBanner(status, v)}
    <div class="play-bottom">
      <div class="me">${avatarHtml(me.avatar, 40)}<span>#${me.number} ${esc(me.name)}</span></div>
      <div class="row" style="gap:14px">
        ${me.groupId ? `<span class="muted">組分 ${me.groupScore}</span>` : ""}
        <span class="myscore">${me.score} 分</span>
      </div>
    </div>
    <div id="toast"></div>
    </div>`;
    bindTask(v);
}
function bindTask(v) {
    const task = v.task;
    if (!task)
        return;
    for (const btn of document.querySelectorAll("[data-choice]")) {
        btn.addEventListener("click", () => {
            selected.choice = Number(btn.dataset.choice);
            lsSet(keyDraft(task.roundId), selected);
            render();
        });
    }
    for (const btn of document.querySelectorAll("[data-vote]")) {
        btn.addEventListener("click", () => {
            const isWorks = (task.voteOptions ?? []).every((o) => /^\d+$/.test(String(o.id)));
            if (isWorks) {
                selected.choice = Number(btn.dataset.voteIndex ?? "0");
                selected.targetId = undefined;
            }
            else {
                selected.targetId = btn.dataset.vote ?? "";
                selected.choice = undefined;
            }
            lsSet(keyDraft(task.roundId), selected);
            render();
        });
    }
    for (const btn of document.querySelectorAll("[data-key]")) {
        btn.addEventListener("click", () => void onKey(task, btn.dataset.key ?? ""));
    }
    const openInput = el("#open-text");
    if (openInput) {
        openInput.value = selected.targetId ?? "";
        openInput.addEventListener("input", () => {
            selected.targetId = openInput.value.slice(0, 60);
            lsSet(keyDraft(task.roundId), selected);
            const cf = el("#confirm-btn");
            if (cf)
                cf.disabled = !selected.targetId || submitting;
        });
    }
    el("#confirm-btn")?.addEventListener("click", () => void onConfirm(task));
    updateClock();
}
async function onKey(task, key) {
    const cur = selected.choice !== undefined ? String(selected.choice) : "";
    let next;
    if (key === "⌫")
        next = cur.slice(0, -1);
    else if (key === "00")
        next = (cur || "0") + "00";
    else if (key === ".") {
        if (cur.includes("."))
            return;
        next = (cur || "0") + ".";
    }
    else
        next = cur.length > 7 ? cur : cur + key;
    const cleaned = next.replace(/^0+(?=\d)/, "");
    selected.choice = cleaned === "" || cleaned === "." ? undefined : Number(cleaned);
    lsSet(keyDraft(task.roundId), selected);
    render();
}
function payloadFor(task) {
    if (task.kind === "choice")
        return { kind: "choice", choice: selected.choice };
    if (task.kind === "open") {
        return task.openKind === "number" ? { kind: "open", amount: selected.choice } : { kind: "open", text: selected.targetId ?? "" };
    }
    if (task.kind === "vote") {
        const isWorks = (task.voteOptions ?? []).every((o) => /^\d+$/.test(String(o.id)));
        if (isWorks)
            return { kind: "vote", choice: selected.choice };
        return { kind: "vote", targetId: selected.targetId };
    }
    if (task.kind === "bid")
        return { kind: "bid", amount: selected.choice };
    return { kind: task.kind };
}
async function onConfirm(task) {
    if (submitting)
        return;
    const payload = payloadFor(task);
    const submissionId = crypto.randomUUID();
    await sendSubmit(payload, submissionId);
}
async function sendSubmit(payload, submissionId) {
    if (!live || !view?.task)
        return;
    submitting = true;
    submitError = "";
    render();
    const roundId = view.task.roundId;
    const payloadHash = await sha256Hex(JSON.stringify(payload));
    lsSet(keyPending(roundId), { roundId, submissionId, payloadHash, payload });
    live.send({ type: "submit", roundId, submissionId, payloadHash, payload });
    // 10 秒冇回應 → 提示（重連會用同一 ID 重送）
    window.setTimeout(() => {
        if (submitting && view?.task?.roundId === roundId && view.mySubmission?.status === "none") {
            submitting = false;
            submitError = "等唔到 server 確認，會自動重試…";
            render();
        }
    }, 10_000);
}
async function boot() {
    const params = new URLSearchParams(location.search);
    const saved = lsGet("hbd.playerToken");
    roomCode = params.get("code") ?? saved?.roomCode ?? "";
    if (!roomCode) {
        try {
            const ready = await api("/api/ready");
            roomCode = ready?.roomCode ?? "";
        }
        catch {
            /* ignore */
        }
    }
    if (saved?.token) {
        token = saved.token;
        startLive();
        return;
    }
    renderJoin();
}
void boot();
