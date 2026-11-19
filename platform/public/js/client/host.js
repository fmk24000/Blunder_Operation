/** 主持台 /host（可多開；PLAN-v3.1 §8.2） */
import { Live, api, esc, avatarHtml, connBanner, showToast, el, lsGet, lsSet, lsDel } from "./common.js";
/** v0.3.0：主 tab 只留 5 個（控制／玩家／分數／題庫／頒獎）；其餘收埋落「進階」（code 全部保留） */
const TABS = [
    ["control", "控制"],
    ["players", "玩家"],
    ["score", "分數"],
    ["quiz", "題庫"],
    ["awards", "頒獎"],
];
const ADVANCED_TABS = [
    ["groups", "分組"],
    ["cards", "出卡"],
    ["rules", "規則頁"],
    ["songs", "歌單"],
    ["draw", "畫畫"],
    ["saboteur", "搗蛋鬼"],
    ["status", "狀態"],
];
const MODES = [
    "idle", "rules", "scoreboard", "question", "tally", "reveal", "draw-wall", "draw-focus",
    "bid", "vote", "role-reveal", "song", "leaderboard", "finale", "award", "timer", "message", "game-scores", "blackout",
];
let live = null;
let view = null;
let status = "connecting";
let token = null;
let hostName = "";
let hostId = "";
let roomCode = "";
let tab = "control";
let loginError = "";
let lastCmdError = "";
let importReport = null;
let deckStatus = "未接管音源";
let audioBlocked = false;
let deckTimer = null;
let leasePauseTimer = null;
// <client-block>deck-id
/** 每個 document（tab／window）一條 deck ID：sessionStorage 每 tab 獨立、reload 後仍然係同一個。
 *  localStorage 會令同一 browser 兩個 host window 共用一條 ID → 兩邊都當自己係 lease owner 雙重出聲。 */
const DECK_ID_KEY = "hbd.deckId";
let deckId = "";
function newDeckId() {
    return `deck_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`;
}
/** 記住一條 deck ID 並寫返 sessionStorage（boot 嘅獨佔檢查換 ID 之後亦要寫返：reload 要沿用同一條） */
function setDeckId(id) {
    deckId = id;
    try {
        sessionStorage.setItem(DECK_ID_KEY, id);
    }
    catch {
        /* 存唔到：用記憶體 ID（見 ensureDeckId） */
    }
    return deckId;
}
function ensureDeckId() {
    if (deckId)
        return deckId;
    // 每次 document 開都生成全新 ID，唔重用 sessionStorage 舊值：
    // 重用會令複製 tab／遲到 BroadcastChannel 訊息期間出現兩個 lease owner（同時出聲）。
    setDeckId(newDeckId());
    try {
        localStorage.removeItem(DECK_ID_KEY);
    }
    catch {
        /* localStorage 冇得寫：ignore */
    }
    return deckId;
}
// </client-block>
// <client-block>deck-exclusive
/** document 獨佔檢查：sessionStorage 雖然每 tab 獨立，但「複製 tab」同「有 opener 嘅新 window」會連 sessionStorage
 *  一齊複製 → 兩個 document 讀到同一條 deck ID → 兩邊都當自己係 lease owner（雙重出聲）。
 *  用 BroadcastChannel（同 origin 嘅 tab／window 互通）宣告自己條 ID：150ms 內有另一個 document 用同一條 ID
 *  應答（taken）就即刻 rotate 一條新 ID、寫返 sessionStorage，再用新 ID 宣告一次。
 *  讓路規則：document 開得早嘅贏（bornAt 舊），同時開就比 nonce —— 兩邊各自計出同一個結論，唔會一齊讓。
 *  正常兩個獨立 tab 各有各 ID（冇人應答）→ 唔會誤 rotate；reload 時舊 document 已經拆咗 → 保持同一條 ID。
 *  冇 BroadcastChannel 就照用（退化；唔會阻 boot）。 */
const DECK_CLAIM_CHANNEL = "hbd.deck-claim";
const DECK_CLAIM_TIMEOUT_MS = 150;
const DECK_CLAIM_ROUNDS = 3;
/** 應答係咪叫我讓：同一條 deck ID ＋ 指住我呢個 nonce（唔係我自己發嘅） */
function deckClaimConflict(msg, deck, nonce) {
    return !!msg && msg.t === "taken" && msg.deckId === deck && msg.to === nonce;
}
/** 邊個讓路：bornAt 舊（早過我開）嘅贏；同時開就比 nonce，兩邊計出同一個結果 */
function deckClaimLoses(mine, theirs) {
    if (mine.bornAt !== theirs.bornAt)
        return mine.bornAt > theirs.bornAt;
    return mine.nonce > theirs.nonce;
}
/** 留住宣告 channel（唔可以俾 GC 收返：boot 完之後仲要應遲到嘅複製 tab） */
let deckClaimChannel = null;
/** 宣告自己條 deck ID 並等 150ms 應答；有衝突就 rotate（最多 3 輪，防病態循環）。
 *  channel 留住：遲過我 boot 嘅複製 tab 宣告同一條 ID 時仲要應佢。
 *  第八輪 (#1)：boot 之後先送到嘅衝突一樣要讓路——被 suspend／busy 嘅 document 可能遲 200ms 才收到
 *  claim，嗰陣 150ms 應答窗已經完（pending=null），唔可以就咁忽略，否則兩邊都留住同一條 ID 出聲。 */
async function claimDeckIdExclusive(opts) {
    const ch = opts.makeChannel(DECK_CLAIM_CHANNEL);
    if (!ch)
        return { deckId: opts.deckId, rotated: false, channel: null }; // 冇 BroadcastChannel：照用
    let deck = opts.deckId;
    let rotated = false;
    let pending = null;
    /** 輸咗一輪（taken 指住我／同 ID claim 而對方贏）：boot 期間交返俾 round() 去 rotate；
     *  boot 完之後（pending 已經係 null）即刻自己 rotate──遲到嘅衝突唔可以就咁忽略。 */
    const lose = () => {
        if (pending) {
            pending(true);
            return;
        }
        const next = opts.newId();
        deck = next; // 之後同舊 ID 有關嘅訊息一律唔關我事（deckId 唔再對得上）
        opts.persist(next);
        opts.onLateLoss?.(next);
    };
    ch.onmessage = (ev) => {
        const msg = ev?.data ?? ev;
        if (!msg || msg.deckId !== deck || msg.nonce === opts.nonce)
            return;
        if (deckClaimConflict(msg, deck, opts.nonce)) {
            lose(); // 有人話呢條 ID 係佢嘅（佢開得早過我）→ 我讓
            return;
        }
        if (msg.t === "claim" && !deckClaimLoses(opts, msg)) {
            // 我早過佢開：留住條 ID，答佢令佢一定 rotate
            ch.postMessage({ t: "taken", deckId: deck, nonce: opts.nonce, bornAt: opts.bornAt, to: msg.nonce });
            return;
        }
        if (msg.t === "claim")
            lose(); // 佢早過我：我讓
    };
    const round = () => new Promise((resolve) => {
        const done = (v) => {
            if (pending !== done)
                return; // 過期嘅 timer 唔可以結算新一輪
            pending = null;
            resolve(v);
        };
        pending = done;
        ch.postMessage({ t: "claim", deckId: deck, nonce: opts.nonce, bornAt: opts.bornAt });
        setTimeout(() => done(false), opts.timeoutMs);
    });
    for (let i = 0; i < DECK_CLAIM_ROUNDS; i++) {
        if (!(await round()))
            break;
        deck = opts.newId();
        rotated = true;
        opts.persist(deck); // 寫返 sessionStorage：reload 之後要沿用呢條新 ID
    }
    deckClaimChannel = ch;
    return { deckId: deck, rotated, channel: ch };
}
// </client-block>
function deckAudio() {
    return el("#deck-audio");
}
function mediaSrc(v, songId) {
    if (!songId)
        return "";
    const song = (v?.songs ?? []).find((x) => x.id === songId);
    return song?.source?.kind === "file" ? `/media/${song.source.fileName}` : "";
}
function syncDeck() {
    const a = deckAudio();
    const v = view;
    if (!a || !v)
        return;
    ensureDeckId();
    const lease = v.audioLease;
    const pb = v.playback;
    // 過期／已放 lease 一律唔算 mine：否則 pauseDeckLocally→render→syncDeck→scheduleLeasePause 無限遞迴
    const mine = isLeaseOwner(lease, deckId, live?.serverNow() ?? Date.now());
    dropAckListener(); // 每次 sync 先清舊 canplaythrough listener；preparing 分支會即刻重新掛一個
    const song = pb ? (v.songs ?? []).find((x) => x.id === pb.songId) : undefined;
    if (!mine) {
        if (!a.paused)
            a.pause();
        ackState.sentKey = ""; // 甩咗 lease：下次重新接管時同一個 attempt 仲要可以再 ACK
        deckStatus = lease ? `音源由 ${esc(lease.deckId)}（gen ${lease.generation}）出聲` : "未有音源 lease";
        return;
    }
    if (!pb || pb.state === "idle") {
        if (!a.paused)
            a.pause();
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
        // 一次 preparation attempt 只 ACK 一次：局域 acked 每次 render 都新開，buffered 之後會連送幾個 ACK
        const ackKey = prepAttemptKey(pb);
        // 送唔出（disconnect 中）唔記 key：重連之後 retryPendingAck／下次 sync 仲會再試（codex 第七輪 #2）
        const onReady = () => {
            sendDeckReadyOnce({
                state: ackState,
                ackKey,
                conn: ackLink(live),
                stillPreparing: prepStillCurrent(pb),
                send: () => sendDeckReady(pb),
            });
        };
        a.addEventListener("canplaythrough", onReady);
        ackListener = () => a.removeEventListener("canplaythrough", onReady);
        // 同一首歌已經 buffer 過（replay／resume）唔會再 fire canplaythrough：readyState 夠就即場 ACK，
        // 否則永遠卡 preparing，等到 readyDeadline 就轉 failed（codex 第五輪 #1a）
        if (a.readyState >= 3)
            onReady();
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
        if (windowPausedForSong === pb.songId)
            windowPausedForSong = "";
        if (document.visibilityState === "visible") {
            const target = (pb.positionMs + Math.max(0, (live?.serverNow() ?? Date.now()) - pb.playStartedAt)) / 1000;
            if (Math.abs(a.currentTime - target) > 0.4)
                a.currentTime = Math.max(0, target);
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
        if (!a.paused)
            a.pause();
        deckStatus = "已暫停";
    }
}
function pauseDeckLocally(reason) {
    const a = deckAudio();
    if (a && !a.paused)
        a.pause();
    deckStatus = reason;
    render();
}
/** 精準排程：leaseUntil 一到即停（唔用 10s interval；防雙響硬保證 §8.2） */
function scheduleLeasePause() {
    if (leasePauseTimer) {
        window.clearTimeout(leasePauseTimer);
        leasePauseTimer = null;
    }
    const v = view;
    if (!v)
        return;
    const lease = v.audioLease;
    if (!lease || lease.deckId !== deckId || lease.releasedAt)
        return;
    const msLeft = lease.leaseUntil - (live?.serverNow() ?? Date.now());
    if (msLeft <= 0) {
        pauseDeckLocally("lease 已到期：已即時停播（防雙響）");
        return;
    }
    leasePauseTimer = window.setTimeout(() => {
        const cur = view?.audioLease;
        if (cur && cur.deckId === deckId && !cur.releasedAt && cur.leaseUntil <= (live?.serverNow() ?? Date.now())) {
            pauseDeckLocally("lease 到期：已即時停播（防雙響）");
        }
        else {
            scheduleLeasePause();
        }
    }, msLeft + 10);
}
// <client-block>lease-owner
/** lease 擁有權：只認每個 document 自己嘅 deckId（＋lease 未放、未到期）。
 *  同一 browser 兩個 host window 一定唔同 deckId → 只有一個會出聲（兩邊都 play 就會雙響）。
 *  唔用 lease.hostId 判 owner：每次 login 都新開一個（auth.ts:34 createHostSession newId("host")），
 *  reload 後重新 login 會誤判自己唔係 owner。 */
function isLeaseOwner(lease, deck, now) {
    return !!lease && !!deck && lease.deckId === deck && !lease.releasedAt && lease.leaseUntil > now;
}
// </client-block>
// <client-block>ack-key
/** 一次 preparation attempt 嘅身分：server 每次入 preparing 都會換新 readyDeadline（commands.ts audioReadyDeadline），
 *  所以 songId＋readyDeadline 可以分開「同一次 attempt 重複 render」同「新一次 attempt（replay／resume）」。 */
function prepAttemptKey(pb) {
    const deadline = Number(pb?.readyDeadline) || 0;
    return `${pb?.songId ?? ""}@${deadline}`;
}
/** live（Live | null）→ 閘門要睇嘅連線狀態 */
function ackLink(link) {
    if (!link)
        return null;
    return { connected: link.connected === true, readyState: link.ws?.readyState ?? 0 };
}
function ackSendable(conn) {
    return !!conn && conn.connected && conn.readyState === 1;
}
/** 一次 preparation attempt 只送一個 ACK；只有真送得出才記 state.sentKey（離線唔記，重連仲有機會）。
 *  state 要放 module 層（跨 render 有效），唔可以喺 syncDeck 內新開。 */
function sendDeckReadyOnce(opts) {
    if (!opts.ackKey || !opts.stillPreparing)
        return false;
    if (opts.state.sentKey === opts.ackKey)
        return false;
    if (!ackSendable(opts.conn))
        return false; // 離線：唔記 key，connected 時再試
    if (!opts.send())
        return false; // 真係送得出先算數
    opts.state.sentKey = opts.ackKey;
    return true;
}
// </client-block>
const ackState = { sentKey: "" };
let ackListener = null;
function dropAckListener() {
    if (!ackListener)
        return;
    ackListener();
    ackListener = null;
}
/** 嗰次 preparation attempt 仲係 preparing 嗎（server 可能已經轉 playing／failed／換歌） */
function prepStillCurrent(pb) {
    const cur = view?.playback;
    return !!cur && cur.songId === pb.songId && cur.state === "preparing";
}
/** 真係推出去才回 true（Live.send 喺 ws 未開時靜靜 drop：唔可以當送咗） */
function sendDeckReady(pb) {
    if (!live || !ackSendable(ackLink(live)))
        return false;
    live.send({ type: "deck.ready", deckId, songId: pb.songId, positionMs: pb.positionMs });
    return true;
}
/** 重連之後補送漏咗嘅 ACK：離線期間 buffer 完成 → canplaythrough 已經 fire 過（唔會再 fire），
 *  syncDeck 亦冇新 render → 要喺 status 變 connected 時主動再試一次（codex 第七輪 #2）。 */
function retryPendingAck() {
    const pb = view?.playback;
    const a = deckAudio();
    if (!pb || !a || pb.state !== "preparing")
        return;
    if (!isLeaseOwner(view?.audioLease, deckId, live?.serverNow() ?? Date.now()))
        return;
    if (a.readyState < 3)
        return; // 未 buffer 好：等 canplaythrough（listener 仲掛住）
    sendDeckReadyOnce({
        state: ackState,
        ackKey: prepAttemptKey(pb),
        conn: ackLink(live),
        stillPreparing: prepStillCurrent(pb),
        send: () => sendDeckReady(pb),
    });
}
let windowPausedForSong = "";
function startDeckTimer() {
    if (deckTimer)
        window.clearInterval(deckTimer);
    // heartbeat 用 10s interval；停播用精準 setTimeout
    deckTimer = window.setInterval(() => {
        const v = view;
        if (!v || !token)
            return;
        ensureDeckId();
        const lease = v.audioLease;
        if (lease && lease.deckId === deckId && !lease.releasedAt) {
            void cmd("lease.heartbeat", undefined, { deckId, generation: lease.generation });
        }
        scheduleLeasePause();
    }, 10_000);
    scheduleLeasePause();
}
const PHASE_LABEL = {
    lobby: "大堂", playing: "進行中", finished: "完場", setup: "設定",
};
const PLAYER_STATUS = {
    approved: "已批准", pending: "待批准", kicked: "已踢", left: "已離開",
};
const RD_STATE = {
    done: "已完成", running: "進行中", skipped: "跳過", pending: "未開始", todo: "未開始",
};
const MODE_LABEL = {
    undercover: "臥底投票",
    idle: "待機", rules: "規則頁", scoreboard: "分數板", question: "問題", tally: "分佈", reveal: "揭曉",
    "draw-wall": "作品牆", "draw-focus": "作品放大", bid: "競投", vote: "投票", "role-reveal": "身份揭曉",
    song: "聽歌", leaderboard: "排行榜", finale: "結算", award: "頒獎", timer: "計時", blackout: "黑屏",
    message: "大字訊息", "game-scores": "分項結算",
};
function uuid() {
    return crypto.randomUUID();
}
async function cmd(kind, targetId, payload = {}, expectedRevision) {
    if (!token)
        return null;
    const body = { commandId: uuid(), kind, payload };
    if (targetId)
        body.targetId = targetId;
    if (expectedRevision !== undefined)
        body.expectedRevision = expectedRevision;
    const res = await api("/api/host/command", { method: "POST", token, body });
    if (!res?.ok) {
        if (res?.code === "W_STALE_COMMAND") {
            // 兩個 host 撞命令：靜默更新畫面，唔彈 error（§7）
            lastCmdError = "";
            actFailed = true; // 今次提交冇落到：唔清主持打緊嘅欄
            live?.resync();
            return res;
        }
        actFailed = true;
        lastCmdError = `${res?.code ?? "ERROR"}：${res?.message ?? "命令失敗"}`;
        showToast(lastCmdError);
    }
    else {
        lastCmdError = "";
    }
    return res;
}
/* ───────────── login ───────────── */
function renderLogin() {
    const root = el("#host-root");
    if (!root)
        return;
    root.innerHTML = `
  <div class="login-wrap">
    <h1>主持台</h1>
    <div class="hint">輸入 PIN（6–12 位數字；由 runbook／server .env 提供）。可以多部機同時開，各自 login。</div>
    <input id="pin" inputmode="numeric" maxlength="12" placeholder="PIN" autocomplete="off">
    <input id="hname" maxlength="20" placeholder="主持名（例：Mac・阿 Ken）" value="${esc(lsGet("hbd.hostName") ?? "")}">
    ${loginError ? `<div class="error-box">${esc(loginError)}</div>` : ""}
    <button class="primary" id="login-btn" style="padding:14px;font-size:18px">Login</button>
    <div class="hint">房碼會 login 之後見到。API：POST /api/host/login</div>
  </div>`;
    el("#login-btn")?.addEventListener("click", () => void doLogin());
    el("#pin")?.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter")
            void doLogin();
    });
}
async function doLogin() {
    const pin = (el("#pin")?.value ?? "").trim();
    const name = (el("#hname")?.value ?? "").trim() || "主持";
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
function startLive() {
    if (!token)
        return;
    if (live)
        live.close();
    live = new Live({
        role: "host",
        code: roomCode,
        token,
        onView: (v) => {
            view = v;
            render();
        },
        onStatus: (s) => {
            status = s;
            if (s === "connected")
                retryPendingAck(); // 重連：離線期間 buffer 完嘅 ACK 補送一次
            render();
        },
        onHello: (msg) => {
            hostId = msg.hostId ?? hostId;
            if (msg.seqEpoch)
                view = view ?? {};
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
/* v04-D：問答進度（卡 state ＋ currentRound 計「出咗幾題／下一題／當前」） */
function quizProgress(v) {
    const quiz = v?.quiz ?? [];
    const cur = v?.currentRound ?? null;
    const curIdx = cur ? quiz.findIndex((q) => q.id === cur.cardId) : -1;
    const shown = quiz.filter((q) => q.state !== "draft").length;
    const nextIdx = quiz.findIndex((q) => q.state === "draft");
    const statePill = (q) => {
        if (cur && cur.cardId === q.id) {
            if (cur.state === "open")
                return { label: "答緊", cls: "on" };
            if (cur.state === "closed" || cur.state === "tally")
                return { label: "收咗卷", cls: "hot" };
        }
        if (q.state === "revealed")
            return { label: "已揭曉", cls: "off" };
        if (q.state === "open" || q.state === "tally")
            return { label: "已開過", cls: "" };
        return { label: "未出", cls: "" };
    };
    return { quiz, total: quiz.length, shown, cur, curIdx, nextIdx, statePill };
}
function quizProgressLine(v) {
    const { total, shown, cur, curIdx, nextIdx } = quizProgress(v);
    if (!total)
        return `<div class="hint">題庫未有題目：去「題庫」tab 加題。</div>`;
    const next = nextIdx >= 0 ? `Q${nextIdx + 1}（未出）` : `${total} 題已出完，可以重設再玩`;
    const curTxt = cur && curIdx >= 0 ? `｜當前：Q${curIdx + 1}・${cur.state === "open" ? "答緊" : cur.state === "closed" || cur.state === "tally" ? "收咗卷" : "已揭曉"}` : "";
    return `<div class="hint">問答進度：已出 ${shown}／${total} 題｜下一題：${esc(next)}${esc(curTxt)}</div>`;
}
function controlSection(v) {
    const rd = v.rundown ?? [];
    const cur = rd.find((i) => i.id === v.currentItemId);
    const curIdx = cur ? rd.findIndex((i) => i.id === cur.id) : -1;
    const nxt = rd[curIdx + 1] ?? rd.find((i) => i.state !== "done" && i.state !== "skipped");
    const mode = v.stage?.mode;
    const locked = v.stage?.lock === true;
    // A3-3：主持一眼要知「我撳嘅嘢有冇去到大mon」
    const ROUND_ZH = { open: "進行中", closed: "已收卷", tally: "開票中", revealed: "已揭曉", void: "已作廢" };
    const round = v.currentRound;
    const syncLine = `大mon：<b>${esc(MODE_LABEL[mode] ?? mode ?? "待機")}</b>・${round ? `回合<b>${esc(ROUND_ZH[round.state] ?? round.state)}</b>` : "冇回合"}・${locked
        ? `<span class="pill" style="background:var(--red);color:#fff;border-color:var(--red)">大mon 已鎖定</span>`
        : "<b>正常</b>"}`;
    // A3-4：三種清楚狀態（唔好喺 playing 時仍然大大隻「未開始」）
    const flowPill = cur
        ? `<span class="pill on">進行中：${esc(cur.title)}</span>`
        : v.phase === "final" || v.phase === "award"
            ? `<span class="pill off">已完成（撳「開始遊戲」可以重玩）</span>`
            : `<span class="pill">未開始（撳「開始遊戲」）</span>`;
    // extraHtml：容許喺同一組尾插額外掣（例如估歌組嘅「開估」唔係 stage.mode，而係 media.reveal）
    const group = (label, modes, extraHtml = "") => `<div class="mode-group"><div class="mg-label">${label}</div><div class="stage-mode-grid">${modes
        .map((m) => `<button data-act="stage.mode:${m}" class="${mode === m ? "active" : ""}">${esc(MODE_LABEL[m] ?? m)}</button>`)
        .join("")}${extraHtml}</div></div>`;
    return `<section class="ctrl-rundown"><h3>流程（${rd.filter((i) => i.state === "done" || i.state === "skipped").length}/${rd.length}）</h3>
    <div class="card-box">
      <button class="ctrl-hero" data-act="rd.next">
        <span class="hero-k">下一項 ▶</span>
        <span class="hero-v">${esc(nxt?.title ?? "（已到最後一關）")}</span>
      </button>
      <div class="ctrl-sub">
        <button data-act="rd.prev">◀ 上一項</button>
        <button data-act="rd.skip">跳過呢關</button>
        ${flowPill}
      </div>
      <div class="rd-list">${rd
        .map((i) => `<div class="ledger-row"><span class="pill ${i.state === "running" ? "on" : i.state === "done" ? "off" : ""}">${esc(RD_STATE[i.state] ?? i.state)}</span><span class="grow">${esc(i.title)}</span><span class="muted">${esc(i.gameId)}</span></div>`)
        .join("")}</div>
      <div class="ctrl-phase">
        <button class="primary" data-act="room.start">開始遊戲</button>
        <button data-act="rd.reset">重設流程（返第一關）</button>
        <button data-act="room.phase:lobby">返大堂</button>
        <button data-act="room.phase:final">去結算</button>
      </div>
    </div>
  </section>
  <section class="ctrl-stage"><h3>大mon 控制（現在：${esc(MODE_LABEL[mode] ?? mode)}）</h3>
    <div class="card-box">
      <div class="hint ctrl-sync" style="margin-bottom:10px">${syncLine}</div>
      <div class="ctrl-quick">
        <button class="primary" data-act="stage.qr">大mon 返 QR／入場頁${mode === "blackout" ? "（離開黑屏）" : ""}</button>
      </div>
      <div class="ctrl-quiz">
        <div class="mg-label">問答真流程（會真正收卷／評分）</div>
        ${quizProgressLine(v)}
        <div class="btn-row">
          <button class="primary" data-act="quiz.show">出題目（只上大mon・唔倒數）</button>
          <button class="primary" data-act="quiz.open">開始 30 秒作答</button>
        </div>
        <div class="btn-row">
          <button data-act="qa.dist">公佈分佈（先收卷）</button>
          <button class="primary" data-act="qa.reveal">公佈答案（先收卷＋評分）</button>
          <button data-act="quiz.reset">重設問答（可以再玩）</button>
        </div>
        <div class="hint">「出題目」只喺大mon 出題目文字（唔出選項、唔倒數、手機唔變）；你讀完題目先撳「開始 30 秒作答」，大mon＋手機才會一齊出選項同倒數。全部出完可以撳「重設問答」再玩。</div>
      </div>
      <div class="mode-groups">
        ${group("流程／畫面", ["idle", "rules", "scoreboard", "leaderboard"])}
        ${group("只換畫面（唔會收卷／評分）・冇 round 會出提示", ["question", "tally", "reveal"])}
        ${group("估歌", ["bid", "song"], `<button data-act="media.reveal" class="${mode === "reveal" && v.stage?.payload?.songTitle ? "active" : ""}">開估（揭曉歌名）</button>`)}
        ${group("畫畫", ["draw-wall", "draw-focus"])}
        ${group("搗蛋鬼／其他", ["role-reveal", "timer", "blackout"])}
        ${group("結算／頒獎", ["finale", "award", "game-scores"])}
      </div>
      <div class="ctrl-emergency">
        <button class="danger" data-act="stage.blackout:1">黑屏</button>
        <button data-act="stage.blackout:0">恢復畫面</button>
        <button class="${v.stage?.lock ? "warn" : ""}" data-act="stage.lock">${v.stage?.lock ? "解鎖大mon" : "鎖定大mon"}</button>
        <button data-act="stage.rules:1">出規則頁</button>
        <button data-act="stage.rules:0">收規則頁</button>
        ${mode === "rules"
        ? `<span class="pill">頁 ${((v.stage?.payload?.pageIndex ?? 0) + 1)}/${v.stage?.payload?.totalPages ?? 1}</span>
               <button class="btn-sm" data-act="stage.prevPage">◀ 上一頁</button>
               <button class="btn-sm" data-act="stage.nextPage">下一頁 ▶</button>`
        : ""}
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
            <input id="maxbid" type="number" min="1" max="10000" value="${v.settings?.maxBid ?? 10}" style="width:100px">
            <button data-act="settings.maxbid">改上限</button>
          </div>
        </div>
      </details>

      <div class="hint">Activity：${(v.activity ?? []).slice(-4).map((a) => esc(a.text)).join("｜") || "—"}</div>
    </div>
    ${undercoverMatchPanel(v)}
    ${killerPanel(v)}
    ${bidPanel(v)}
  </section>`;
}
/** FIX-3b：拍賣時間估歌控制（由「進階→歌單」搬上控制頁；舊歌單 tab 嘅 code 仍然保留） */
function bidPanel(v) {
    const round = v.currentRound;
    const card = round ? (v.cards ?? []).find((c) => c.id === round.cardId) : null;
    const isBid = card?.type === "bid";
    const auction = isBid ? round.auction : null;
    const subs = isBid ? (v.submissions ?? []).filter((x) => x.roundId === round.id && x.confirmed && typeof x.amount === "number" && x.amount >= 1) : [];
    const ranked = [...subs].sort((a, b) => a.amount - b.amount || b.ts - a.ts);
    const nameOf = (id) => esc((v.players ?? []).find((x) => x.id === id)?.name ?? "?");
    const draftCards = (v.cards ?? []).filter((c) => c.gameId === "auction" && c.type === "bid" && c.state === "draft");
    const openBlocked = Boolean(round && (round.state === "open" || round.state === "closed" || round.state === "tally"));
    const rankingRows = (auction?.ranking ?? [])
        .map((r, i) => `<div class="ledger-row"><span class="pill ${i === auction?.cursor && !auction?.finished ? "hot" : ""}">${i + 1}</span><span class="grow">${nameOf(r.playerId)}</span><b>${r.seconds} 秒</b>${(auction?.judged ?? []).includes(r.playerId) ? `<span class="pill on">已判</span>` : ""}</div>`)
        .join("");
    return `<div class="card-box" style="margin-top:10px"><h4>拍賣時間估歌</h4>
    <div class="row wrap">
      <span class="pill">${isBid ? `現時：${esc(card.prompt)}・${esc(round.state)}` : "未開拍賣卡"}</span>
      <span class="pill">已競投 ${ranked.length} 人</span>
      <span class="pill">最少：${ranked[0] ? `${nameOf(ranked[0].playerId)}（${ranked[0].amount} 秒）` : "—"}</span>
      <span class="pill">第二：${ranked[1] ? `${nameOf(ranked[1].playerId)}（${ranked[1].amount} 秒）` : "—"}</span>
    </div>
    <div class="btn-row">
      <button class="primary" data-act="bid.publish" ${isBid && ranked.length ? "" : "disabled"}>公佈競投排名</button>
      <button class="primary" data-act="bid.judge:1" ${auction ? "" : "disabled"}>而家嗰位答對 +${isBid ? card.points : 1}</button>
      <button data-act="bid.judge:0" ${auction ? "" : "disabled"}>答唔到 → 下一位</button>
      <button data-act="bid.finish" ${auction || (isBid && round && round.state !== "revealed" && round.state !== "void") ? "" : "disabled"}>本首完結</button>
    </div>
    ${rankingRows ? `<div style="max-height:220px;overflow:auto">${rankingRows}</div>` : ""}
    <div class="row wrap"><span class="muted">開拍賣卡（第 1–6 首）：</span>${draftCards
        .map((c) => `<button class="btn-sm primary" data-act="card.open:${c.id}" ${openBlocked ? "disabled" : ""}>${esc(c.prompt.slice(0, 12))}</button>`)
        .join("") || '<span class="muted">（冇 draft 拍賣卡）</span>'}</div>
    <div class="hint">流程：開卡（10 秒倒數）→ 玩家撳「競投」→ 公佈排名 → 主持自己播歌 → 答對 +1／答唔到去下一位 → 本首完結。舊歌單 tab 仍然有同一組控制。</div>
  </div>`;
}
/** v0.3.0 笨蛋殺手：主持抽老闆＋殺手（身份只喺主持台顯示；輸贏主持手動加分，gameId=killer） */
function killerPanel(v) {
    const k = v.killerState;
    const approved = (v.players ?? []).filter((p) => p.status === "approved");
    const name = (id) => {
        if (!id)
            return "—";
        const p = approved.find((x) => x.id === id);
        return p ? `#${p.number} ${esc(p.name)}` : id;
    };
    if (!k) {
        return `<div class="card-box" style="margin-top:10px"><h4>笨蛋殺手</h4>
      <div class="hint">一個老闆一個殺手（隨機抽、可以重抽）；身份用紙派，系統只喺主持台顯示。3 粒子彈、要殺兩個人，最後全體投票。</div>
      <div class="row wrap"><button class="primary" data-act="killer.assign">抽老闆＋殺手</button></div></div>`;
    }
    return `<div class="card-box" style="margin-top:10px"><h4>笨蛋殺手</h4>
    <div class="row wrap"><span class="pill hot">老闆：${name(k.bossId)}</span><span class="pill hot">殺手：${name(k.killerId)}</span></div>
    <div class="btn-row"><button data-act="killer.redraw">重抽</button><button data-act="killer.clear">清除身份</button></div>
    <div class="btn-row">
      <span class="muted">加分：</span>
      <button class="btn-sm" data-act="killer.score:boss:1">老闆 +1</button>
      <button class="btn-sm" data-act="killer.score:boss:2">老闆 +2</button>
      <button class="btn-sm" data-act="killer.score:killer:1">殺手 +1</button>
      <button class="btn-sm" data-act="killer.score:killer:2">殺手 +2</button>
    </div>
    <div class="row wrap">
      <span class="muted">加分畀邊個（好人／任何人）：</span>
      <select id="killer-target">${approved.map((p) => `<option value="${esc(p.id)}">#${p.number} ${esc(p.name)}</option>`).join("")}</select>
      <button class="btn-sm" data-act="killer.any:1">+1</button>
      <button class="btn-sm" data-act="killer.any:2">+2</button>
    </div>
    <div class="hint">輸贏由主持加分（gameId=killer，會計入「分項結算」個笨蛋殺手欄）。</div></div>`;
}
/** v0.4.0 一圖多人（畫畫臥底）：唯一投票入口。
 *  主持逐步撳：開局 → 公佈好人題目 → 開始投票（10 秒）→ 開票睇票數 → foul 最高票 → 下一題／結算。
 *  票數／票軌／已投人數一律讀 host view 嘅 v.undercover（buildUndercover 已經計好），主持台唔自己再算。 */
function undercoverMatchPanel(v) {
    const st = v.undercoverMatch;
    const approved = (v.players ?? []).filter((p) => p.status === "approved");
    const find = (id) => approved.find((p) => p.id === id);
    const label = (id) => {
        const p = find(id);
        return p ? `#${p.number} ${esc(p.name)}` : id;
    };
    if (!st || (st.participantIds ?? []).length === 0) {
        return `<div class="card-box" style="margin-top:10px"><h4>一圖多人（畫畫臥底）${st ? `・下一局係第 ${st.matchNo} 局` : ""}</h4>
      <div class="hint">開局＝由 approved 玩家隨機抽 2 個臥底＋抽 3 對題目。每題流程：公佈好人題目 → 開投票（10 秒）→ 開票 → foul 最高票嗰個 → 下一題；最多 3 題。</div>
      <div class="row wrap"><label class="row">臥底數 <input id="ucm-count" type="number" min="1" max="4" value="2" style="width:70px"></label>
      <button class="primary" data-act="ucm.start">開新一局</button></div></div>`;
    }
    const remaining = (st.undercoverIds ?? []).filter((id) => !st.eliminatedIds.includes(id)).length;
    const eliminated = (st.eliminatedIds ?? []).map((id) => `<span class="pill ${st.undercoverIds.includes(id) ? "hot" : "gray"}">${label(id)}${st.undercoverIds.includes(id) ? "（臥底）" : ""}</span>`);
    const undercoverList = (st.undercoverIds ?? []).map((id) => `<span class="pill hot">${label(id)}</span>`).join("") || "—";
    // 候選＝未出局參賽者（已出局唔可以再被投）
    const candidates = (st.participantIds ?? []).filter((id) => !st.eliminatedIds.includes(id));
    // FIX-8：勝負未定唔准結算（同 server 前置檢查一致）
    const canSettle = remaining === 0 || st.result === "good" || st.questionNo >= 2;
    // 票數／票軌／進度：全部嚟自 host view（唔自己計）
    const u = v.undercover;
    const voting = !st.settled && u?.phase === "voting";
    const revealed = !st.settled && u?.phase === "result";
    const questionDone = Object.values(st.eliminatedByQuestion ?? {}).some((q) => q === st.questionNo);
    const counts = revealed ? [...(u.candidates ?? [])].sort((a, b) => b.count - a.count) : [];
    const topCount = counts.length ? Math.max(...counts.map((c) => c.count)) : 0;
    const topCandidates = topCount > 0 ? counts.filter((c) => c.count === topCount) : [];
    const topLabel = topCandidates.length === 1 ? label(topCandidates[0].id) : "";
    const status = [
        `第 ${st.matchNo} 局`,
        `第 ${st.questionNo + 1}／3 題`,
        `仲有 ${remaining} 個臥底未出局`,
        st.promptRevealed ? "已公佈好人題目" : "未公佈題目",
        voting ? `投票中（已投 ${u.answeredCount}／${u.eligibleCount}）` : revealed ? "已開票" : "冇投票進行",
        st.settled ? `已結算：${st.result === "good" ? "好人勝" : st.result === "undercover" ? "臥底勝" : "?"}` : "未結算",
    ]
        .map((x) => `<span class="pill">${esc(x)}</span>`)
        .join("");
    // FIX-1：主持要見到本局抽咗邊 3 對題（派題目卡要用），現時嗰對高亮
    const cards = v.cards ?? [];
    const topicRows = (st.topicIds ?? [])
        .map((cid, i) => {
        const c = cards.find((x) => x.id === cid);
        const current = cid === st.promptCardId;
        return `<div class="ledger-row" ${current ? 'style="background:var(--bg-soft);font-weight:700"' : ""}>
        <span class="pill ${current ? "on" : "gray"}">第 ${i + 1}/3 題${current ? "・現在" : ""}</span>
        <span class="grow">好人題：${esc(c?.prompt ?? cid)}</span>
        <span class="pill hot">臥底題（關鍵詞）：${esc(c?.undercoverPrompt ?? "?")}</span></div>`;
    })
        .join("");
    const tallyRows = counts
        .map((c) => {
        const top = topCount > 0 && c.count === topCount;
        return `<div class="ledger-row" ${top ? 'style="background:var(--bg-soft);font-weight:700"' : ""}>
        <span class="pill ${top ? "hot" : "gray"}">${top ? "👑 最高票" : "　"}</span>
        <span class="grow">#${c.number} ${esc(c.name)}</span><b>${c.count} 票</b></div>`;
    })
        .join("");
    const ballotLine = revealed
        ? (u.ballots ?? [])
            .map((b) => `#${b.voterNumber} ${esc(b.voterName)} → ${esc(b.targetName)}`)
            .join("｜")
        : "";
    // 投票步驟：一時只會出一個 phase 嘅控制（唔會再有重複掣）
    const voteStep = st.settled
        ? `<div class="row wrap"><span class="muted">本局已結算，唔再投票。</span></div>`
        : voting
            ? `<div class="row wrap"><span class="pill on">已投 ${u.answeredCount}／${u.eligibleCount}</span>
          <button class="primary" data-act="ucm.revealRound">立即開票</button></div>
        <div class="hint">大mon 顯示「請投出你心目中嘅臥底」＋${u.durationSeconds} 秒倒數；時到自動開票。</div>`
            : revealed
                ? `<div class="row wrap"><span class="pill on">票數</span>${topCandidates.length > 1 ? `<span class="pill hot">同票（${topCandidates.map((c) => esc(c.name)).join("、")}）：請主持揀</span>` : ""}</div>
        ${tallyRows || '<div class="muted">（呢題冇票）</div>'}
        ${ballotLine ? `<div class="hint">票軌：${ballotLine}</div>` : ""}
        <div class="row wrap">
          <button class="primary" data-act="ucm.foultop" ${questionDone || topCandidates.length !== 1 ? "disabled" : ""} title="${questionDone ? "本題已經 foul 咗一個" : topCandidates.length === 1 ? "由 server 計最高票再 foul" : "同票／冇票：請用下面 dropdown 揀人"}">Foul 最高票${topLabel ? `：${topLabel}` : ""}（一人出局）</button>
        </div>`
                : `<div class="row wrap"><span class="muted">${st.promptRevealed ? "題目已公佈，可以開投票。" : "先公佈好人題目，再開投票（跟 FLOW 次序）。"}</span></div>
          <div class="row wrap"><button class="primary" data-act="ucm.vote" ${st.promptRevealed ? "" : "disabled"}>開始投票（10 秒）</button></div>`;
    return `<div class="card-box" style="margin-top:10px"><h4>一圖多人（畫畫臥底）</h4>
    <div class="row wrap">${status}</div>
    <div class="row wrap"><span class="pill hot">臥底（主持專用）</span>${undercoverList}</div>
    <div style="margin-top:6px"><div class="muted">本局題目（派卡用：好人題＋臥底題各一張；現時嗰對高亮）</div>${topicRows || '<div class="muted">（未抽題）</div>'}</div>
    <div class="row wrap"><span class="muted">已出局：</span>${eliminated.join("") || '<span class="muted">（未有）</span>'}</div>
    <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--line)">
      <div class="row wrap"><span class="pill">本題投票</span></div>
      ${voteStep}
    </div>
    <div class="btn-row">
      <button data-act="ucm.redraw">重抽臥底</button>
      <button class="${st.promptRevealed ? "" : "primary"}" data-act="ucm.reveal" ${st.settled ? "disabled" : ""}>公佈好人題目</button>
      <button data-act="ucm.undo" ${st.eliminatedIds.length ? "" : "disabled"}>取消上一個淘汰</button>
      <button class="primary" data-act="ucm.next">下一題／結算</button>
      <button data-act="ucm.settle" ${canSettle ? "" : "disabled"} title="${canSettle ? "判勝負＋加分" : "仲未夠 3 題／仲有臥底未出局（請撳「下一題／結算」）"}">分數結算</button>
      <button data-act="ucm.reset">清走本局（再開一局）</button>
    </div>
    <div class="row wrap">
      <span class="muted">手動揀人 foul（同票／主持想改；已出局者唔會出現）：</span>
      <select id="ucm-target">${candidates.map((id) => `<option value="${esc(id)}">${label(id)}</option>`).join("")}</select>
      <button class="danger" data-act="ucm.eliminate" ${candidates.length ? "" : "disabled"}>淘汰佢</button>
      <span class="muted">（大mon 會即刻講中／唔中）</span>
    </div>
    <div class="hint">每題流程：公佈好人題目 → 開始投票（10 秒）→ 開票睇票數 → foul 最高票嗰個（同票就要主持揀）→ 下一題。最多 3 題；兩個臥底都出局＝好人勝。計分：好人贏→全部好人 +1；臥底贏→全部臥底 +1；未出局嘅人每人再 +2（疊加）。${canSettle ? "" : "仲未夠 3 題／仲有臥底未出局 → 「分數結算」未開得，請用「下一題／結算」。"}</div>
  </div>`;
}
function playersSection(v) {
    const groups = v.groups ?? [];
    const players = v.players ?? [];
    const active = players.filter((p) => p.status !== "kicked");
    const kicked = players.filter((p) => p.status === "kicked");
    const row = (p) => `<div class="player-row">
          <span class="dot ${p.connected ? "on" : ""}"></span>
          <span class="pname">${avatarHtml(p.avatar, 30)} #${p.number} ${esc(p.name)}</span>
          <input type="text" placeholder="改編號" value="${p.number}" data-num="${p.id}" style="width:64px">
          <button class="btn-sm" data-act="player.number:${p.id}">改號</button>
          <input type="text" placeholder="改名" value="${esc(p.name)}" data-name="${p.id}">
          <button class="btn-sm" data-act="player.rename:${p.id}">改名</button>
          ${groups.length ? `<select data-group="${p.id}"><option value="">個人戰</option>${groups.map((g) => `<option value="${g.id}" ${p.groupId === g.id ? "selected" : ""}>${esc(g.name)}</option>`).join("")}</select><button class="btn-sm" data-act="player.group:${p.id}">搬組</button>` : ""}
          <span class="pill ${p.status === "pending" ? "on" : p.status === "kicked" ? "off" : ""}">${esc(PLAYER_STATUS[p.status] ?? p.status)}</span>
          ${p.status === "pending" ? `<button class="btn-sm primary" data-act="player.approve:${p.id}">批准</button>` : ""}
          ${p.status !== "kicked" ? `<button class="btn-sm danger" data-act="player.kick:${p.id}">踢</button>` : `<button class="btn-sm" data-act="player.approve:${p.id}">恢復</button>`}
          <span class="pscore">${p.score}</span>
          <button class="btn-sm" data-act="score.add:${p.id}:1">+1</button>
          <button class="btn-sm" data-act="score.add:${p.id}:2">+2</button>
          <button class="btn-sm" data-act="score.add:${p.id}:5">+5</button>
          <button class="btn-sm" data-act="score.add:${p.id}:-1">-1</button>
        </div>`;
    return `<section><h3>玩家（已批准 ${v.caps?.approved}/${v.caps?.maxApproved}・待批准 ${v.caps?.pending}/${v.caps?.maxPending}）</h3>
    <div class="card-box">${active.map(row).join("")}</div>
    ${kicked.length ? `<details class="kicked-box"><summary>已踢 ${kicked.length}（撳開睇／還原）</summary><div class="card-box">${kicked.map(row).join("")}</div></details>` : ""}
  </section>`;
}
function groupsSection(v) {
    const groups = v.groups ?? [];
    return `<section><h3>分組（0–N；0 組＝個人戰）</h3>
    <div class="card-box">
      <div class="btn-row">${[0, 2, 3, 4, 5, 6].map((n) => `<button data-act="groups.set:${n}">${n === 0 ? "個人戰（0 組）" : `${n} 組`}</button>`).join("")}
      <span class="row">自訂 <input id="group-count" type="number" min="0" max="30" value="${groups.length}" style="width:80px"><button data-act="groups.custom">套用</button></span></div>
      <div>${groups.map((g) => `<div class="ledger-row"><span class="pill" style="background:${esc(g.color)}66;border-left:8px solid ${esc(g.color)}">${esc(g.name)}</span><span class="muted">id=${esc(g.id)}</span><span class="grow"></span><b>${v.players.filter((p) => p.groupId === g.id).length} 人</b></div>`).join("")}</div>
      <div class="hint">搬有分嘅人：選「跟人走」＝分數跟人；「留原組」＝個人分作廢＋一筆 group 補償事件（歷史保留）。</div>
    </div>
  </section>
  <section><h3>搬組</h3>
    <div class="card-box">${(v.players ?? [])
        .filter((p) => p.status === "approved")
        .map((p) => `<div class="player-row"><span class="pname">#${p.number} ${esc(p.name)}</span>
        <select data-assign-g="${p.id}"><option value="">個人戰</option>${groups.map((g) => `<option value="${g.id}" ${p.groupId === g.id ? "selected" : ""}>${esc(g.name)}</option>`).join("")}</select>
        <select data-assign-mode="${p.id}"><option value="follow">跟人走</option><option value="stay">留原組</option></select>
        <button class="btn-sm" data-act="groups.assign:${p.id}">搬</button></div>`)
        .join("")}</div>
  </section>`;
}
function scoreSection(v) {
    const ledger = (v.ledger ?? []).slice(-60).reverse();
    return `<section><h3>加減分／帳簿（${v.ledger?.length ?? 0} 筆）</h3>
    <div class="card-box">
      <div class="row wrap">
        <select id="score-target">${(v.players ?? []).map((p) => `<option value="${p.id}">#${p.number} ${esc(p.name)}</option>`).join("")}</select>
        <input id="score-delta" type="number" value="1" style="width:80px">
        <input id="score-reason" placeholder="reason（例：問答 Q3）" value="主持加分" style="width:200px">
        <button class="primary" data-act="score.custom">加分</button>
        <button data-act="score.bulk:1">全場 +1</button>
        <button data-act="score.bulk:-1">全場 -1</button>
      </div>
      <div class="hint">統計：總分 ${v.stats?.total}・平均 ${(v.stats?.avg ?? 0).toFixed(2)}・中位數 ${v.stats?.median}・max ${v.stats?.max}・min ${v.stats?.min}</div>
      <div style="max-height:420px;overflow:auto">${ledger
        .map((e) => {
        const targetName = e.target.type === "player" ? (v.players.find((p) => p.id === e.target.id)?.name ?? e.target.id) : (v.groups.find((g) => g.id === e.target.id)?.name ?? e.target.id);
        return `<div class="ledger-row ${e.voided ? "voided" : ""}"><span class="who">${esc(targetName)}</span><span class="delta ${e.delta > 0 ? "pos" : "neg"}">${e.delta > 0 ? "+" : ""}${e.delta}</span><span class="grow">${esc(e.reason)}</span><span class="pill gray">${e.by}</span>${e.voided ? `<span class="muted">已作廢</span>` : `<button class="btn-sm danger" data-act="score.void:${e.id}">作廢</button>`}</div>`;
    })
        .join("")}</div>
    </div>
  </section>`;
}
function openGradingHtml(v) {
    const round = v.currentRound;
    if (!round)
        return "";
    const card = (v.cards ?? []).find((c) => c.id === round.cardId);
    if (!card || (card.type !== "open" && card.type !== "vote"))
        return "";
    const subs = (v.submissions ?? []).filter((s) => s.roundId === round.id && s.confirmed);
    const rows = subs
        .map((s) => {
        const p = (v.players ?? []).find((x) => x.id === s.playerId);
        const answer = s.text ?? (s.amount !== undefined ? String(s.amount) : s.choice !== undefined ? `#${s.choice + 1}` : "");
        const judged = s.judged ? `已評 ${s.judged.points} 分` : "未評";
        return `<div class="ledger-row"><span class="who">#${p?.number ?? "?"} ${esc(p?.name ?? s.playerId)}</span><span class="grow">${esc(answer)}</span><span class="pill gray">${judged}</span>
        <button class="btn-sm" data-act="judge.1:${s.id}">+1</button><button class="btn-sm" data-act="judge.2:${s.id}">+2</button><button class="btn-sm" data-act="judge.0:${s.id}">0</button></div>`;
    })
        .join("");
    const numBlock = card.openKind === "number"
        ? `<div class="row wrap"><span class="pill">估數字</span>
        <input id="actual-answer" type="number" step="any" placeholder="真實答案" value="${round.actualAnswer ?? card.actualAnswer ?? ""}" style="width:140px">
        <button class="primary" data-act="judge.actual">入真實答案＋按容差加分</button>
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
function cardsSection(v) {
    const cur = v.currentItemId;
    const item = (v.rundown ?? []).find((i) => i.id === cur);
    const cardIds = item?.cardIds ?? [];
    const cards = cardIds.map((id) => (v.cards ?? []).find((c) => c.id === id)).filter(Boolean);
    const round = v.currentRound;
    const card = round ? (v.cards ?? []).find((c) => c.id === round.cardId) : null;
    // 搗蛋鬼卡：generic 揭示／開卡都會繞過 saboteur.rounds（state 對唔上 → 偷輪次），只用下面搗蛋鬼面板
    const curIsSab = card?.gameId === "saboteur";
    return `<section><h3>出卡：${esc(item?.title ?? "（未入關）")}</h3>
    <div class="card-box">
      ${round ? `<div class="row wrap"><span class="pill hot">currentRound ${esc(round.id)}・${round.state}</span><span class="muted">已答 ${(v.submissions ?? []).filter((s) => s.roundId === round.id && s.confirmed).length}/${round.eligiblePlayerIds.length}</span></div>
        <div class="row wrap"><button data-act="card.close" ${round.state !== "open" ? "disabled" : ""}>收卷</button>
        <button data-act="card.tally" ${round.state === "open" || round.state === "closed" ? "" : "disabled"}>切分佈</button>
        ${curIsSab ? "" : `<button class="primary" data-act="card.reveal" ${round.state === "closed" || round.state === "tally" ? "" : "disabled"}>揭曉</button>`}
        ${curIsSab ? "" : `<button data-act="card.reopen">重開（新 round）</button>`}</div>` : `<div class="muted">未開卡</div>`}
      ${cards.length ? `<div>${cards.map((c) => `<div class="ledger-row"><span class="pill ${round?.cardId === c.id ? "on" : ""}">${esc(c.type)}</span><span class="grow">${esc(c.prompt)}</span><span class="muted">${c.id}</span>${c.gameId === "saboteur" ? `<span class="pill gray">用搗蛋鬼面板開輪</span>` : c.undercoverPrompt ? `<span class="pill gray">一圖多人專用（用一圖多人面板）</span>` : `<button class="btn-sm primary" data-act="card.open:${c.id}" ${round && (round.state === "open" || round.state === "closed" || round.state === "tally") ? "disabled" : ""}>開</button>`}</div>`).join("")}</div>` : `<div class="hint">呢關未有卡。用下面新增。</div>`}
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
/** v04-D：題目監控 panel（進度／下一題／當前＋dropdown 跳題＋重設再玩） */
function quizMonitorHtml(v) {
    const { quiz, total, shown, cur, curIdx, nextIdx, statePill } = quizProgress(v);
    if (!total)
        return "";
    const next = nextIdx >= 0 ? `Q${nextIdx + 1}（未出）` : `${total} 題已出完`;
    const curTxt = cur && curIdx >= 0
        ? `｜當前：Q${curIdx + 1}・${cur.state === "open" ? "答緊" : cur.state === "closed" || cur.state === "tally" ? "收咗卷" : "已揭曉"}`
        : "";
    return `<div class="card-box" style="background:var(--bg-soft)">
    <div class="row wrap" style="justify-content:space-between;align-items:baseline">
      <b>問答進度：已出 ${shown}／${total} 題</b>
      <span class="muted">下一題：${esc(next)}${esc(curTxt)}</span>
    </div>
    <div class="row wrap" style="margin-top:8px">
      <select id="quiz-jump" style="flex:2 1 320px">${quiz
        .map((q, i) => {
        const pill = statePill(q);
        const head = String(q.prompt ?? "").slice(0, 20);
        return `<option value="${esc(q.id)}" ${cur && cur.cardId === q.id ? "selected" : ""}>Q${i + 1}・${esc(pill.label)}・${esc(head)}</option>`;
    })
        .join("")}</select>
      <button data-act="quiz.jump">跳去呢題（只出題目）</button>
      <button data-act="quiz.open">開始 30 秒作答</button>
    </div>
    <div class="row wrap" style="margin-top:8px">
      <button data-act="quiz.reset">重設問答（可以再玩）</button>
      <label class="row"><input type="checkbox" id="quiz-clearscores"> 順便清走問答分</label>
    </div>
    <div class="row wrap" style="margin-top:6px">${quiz
        .map((q, i) => {
        const pill = statePill(q);
        return `<span class="pill ${pill.cls}">Q${i + 1} ${esc(pill.label)}</span>`;
    })
        .join("")}</div>
    <div class="hint">「跳去呢題」＝只喺大mon 出題目文字（唔開卷、唔倒數），可以重新讀題／fallback 去任何一題；撳「開始 30 秒作答」才真正開 round。</div>
  </div>`;
}
function quizSection(v) {
    const quiz = v.quiz ?? [];
    return `${quizMonitorHtml(v)}<section><h3>題庫（${quiz.length} 題；改完即時生效）</h3>
    <div class="card-box">
      <div class="btn-row"><button class="primary" data-act="quiz.add:choice">加 MC 題</button><button data-act="quiz.add:open">加 Open 題</button></div>
      <details class="ctrl-settings"><summary>進階：舊題匯入（會覆蓋同名 MC 題）</summary>
        <div class="row wrap"><button data-act="quiz.import">一鍵匯入舊 QUIZ（只 MC，open 只顯示 diff）</button>
        <span class="muted">撳完會先問你確認，唔會靜靜哋覆蓋。</span></div>
      </details>
      <div class="hint">換題只改資料（data/quiz.seed.json／呢個編輯器），唔使改 code。大mon／手機喺 reveal 前永遠唔會見到正解。</div>
      ${importReport
        ? `<div class="card-box" style="background:var(--bg-soft)"><b>匯入 diff</b>
            <div class="hint">MC 已匯入／更新：${(importReport.imported ?? []).map((x) => esc(x)).join("、") || "冇"}；不變：${(importReport.unchanged ?? []).length} 題</div>
            ${(importReport.diffs ?? []).map((d) => `<div class="ledger-row"><span class="pill">${esc(d.id)}</span><span class="grow">「${esc(d.before)}」→「${esc(d.after)}」</span></div>`).join("")}
            <div class="hint">open 題（唔會覆蓋）：${(importReport.skippedOpen ?? []).map((x) => `${esc(x.id)}・${esc(x.note)}`).join("；") || "—"}</div>
            <button class="btn-sm" data-act="quiz.clearimport">收起</button></div>`
        : ""}
    </div>
    ${quiz
        .map((q, i) => {
        const opts = q.options ?? ["", "", "", ""];
        return `<div class="quiz-item">
        <div class="qi-head"><span class="pill">${i + 1}. ${esc(q.type)}</span>${q.autoAnswer ? `<span class="pill hot">時間題・server 自動計</span>` : ""}<span class="muted">${esc(q.id)}・${esc(q.category ?? "")}</span><span class="grow"></span>
          <button class="btn-sm" data-act="quiz.copy:${q.id}">複製</button>
          <button class="btn-sm" data-act="quiz.up:${q.id}">↑</button><button class="btn-sm" data-act="quiz.down:${q.id}">↓</button><button class="btn-sm danger" data-act="quiz.del:${q.id}">刪</button></div>
        <textarea data-q-prompt="${q.id}" placeholder="題目">${esc(q.prompt)}</textarea>
        ${q.type === "choice" ? `<div class="row wrap" style="margin-top:6px">${opts.map((o, k) => `<input data-q-opt="${q.id}:${k}" value="${esc(o)}" placeholder="${String.fromCharCode(65 + k)}" style="flex:1 1 120px">`).join("")}</div>` : ""}
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
        <button class="btn-sm" data-act="quiz.show:${q.id}">出呢題（只上大mon）</button>
        <span class="muted">state=${esc(q.state)}・version=${q.version}</span></div>
      </div>`;
    })
        .join("")}`;
}
function rulesSection(v) {
    const pages = v.rulePages ?? [];
    return `<section><h3>每關規則頁（D30；大mon 開場自動顯示）</h3>
    <div class="card-box">
      <div class="btn-row">${["auction", "draw", "saboteur", "quiz"].map((g) => `<button data-act="rules.new:${g}">加 ${esc(g)} 頁</button>`).join("")}
      <button data-act="rules.reload">載入最新</button></div>
      <div class="hint">兩個 host 同時改同一頁：second 會收 W_RULES_CONFLICT，再載入最新（唔會蓋走）。字數上限：每 block 120 字／全頁 1200 字／blocks ≤20。</div>
    </div>
    <div class="card-box" style="margin-top:10px"><h4>關卡次序（改完即刻套用）</h4>
      <div class="hint">用 ▲▼ 調次序；預設係「一圖多人 → 拍賣 → 笨蛋殺手 → 問答」。改完大mon／rundown 即刻跟新次序。</div>
      ${(v.rundown ?? []).map((it, i) => `<div class="ledger-row"><span class="grow">${i + 1}. ${esc(it.title)}</span>
        <button class="btn-sm" data-act="rd.moveup:${i}" ${i === 0 ? "disabled" : ""}>▲</button>
        <button class="btn-sm" data-act="rd.movedown:${i}" ${i === (v.rundown ?? []).length - 1 ? "disabled" : ""}>▼</button></div>`).join("")}
      <div class="btn-row"><button class="btn-sm" data-act="rd.resetOrder">還原預設（畫畫先・估歌後）</button></div>
    </div>
    ${pages
        .map((p) => `<div class="quiz-item">
      <div class="qi-head"><span class="pill ${p.enabled ? "on" : "off"}">${esc(p.gameId)}</span><span class="muted">${esc(p.id)}・v${p.version}・order ${p.order}・${esc(p.updatedBy)}</span><span class="grow"></span>
        <button class="btn-sm" data-act="rules.show:${p.id}">預覽上大mon</button>
        <button class="btn-sm danger" data-act="rules.del:${p.id}">停用</button></div>
      <div class="row wrap"><input data-r-title="${p.id}" value="${esc(p.title)}" placeholder="title ≤16 字" style="flex:2 1 200px">
      <input data-r-sub="${p.id}" value="${esc(p.subtitle ?? "")}" placeholder="subtitle ≤24 字" style="flex:2 1 200px">
      <input data-r-auto="${p.id}" type="number" value="${p.autoAdvanceSeconds ?? 0}" title="自動翻頁秒數（0＝手動）" style="width:90px">
      <label class="row"><input type="checkbox" data-r-enabled="${p.id}" ${p.enabled ? "checked" : ""}> enabled</label></div>
      <textarea data-r-blocks="${p.id}" style="width:100%;min-height:120px;font-family:monospace;font-size:12px">${esc(JSON.stringify(p.blocks, null, 1))}</textarea>
      <div class="row"><button class="primary btn-sm" data-act="rules.save:${p.id}:${p.version}">儲存</button><span class="muted">blocks JSON（heading/paragraph/bullets/steps/callout/kv/score-table/image）</span></div>
    </div>`)
        .join("")}`;
}
function awardsSection(v) {
    const awards = v.awards ?? [];
    const medal = { grand: "🥇 最高分獎", second: "🥈 中庸之道獎", third: "🥉 多謝參與獎" };
    const rule = { grand: "最高分獎", second: "中庸之道獎（最接近平均數）", third: "多謝參與獎（最低分）" };
    return `<section><h3>頒獎（phase=${v.phase}）</h3>
    <div class="card-box">
      <div class="btn-row"><button class="primary" data-act="award.compute">重算三獎</button><button data-act="award.reset">重設揭曉</button></div>
      <div class="hint">統計：n=${v.stats?.count}・中位數 ${v.stats?.median}・平均 ${(v.stats?.avg ?? 0).toFixed(2)}</div>
      ${awards
        .map((a) => {
        const target = (v.players ?? []).find((p) => p.id === a.targetId);
        return `<div class="player-row"><span class="pill">${medal[a.id]}</span><span class="grow">${rule[a.id]} → ${target ? `#${target.number} ${esc(target.name)}` : "從缺"}</span>
          <span class="pill ${a.revealed ? "on" : "off"}">${a.revealed ? "已揭曉" : "未揭曉"}</span>
          <select data-award-target="${a.id}"><option value="">—</option>${(v.players ?? []).map((p) => `<option value="${p.id}" ${a.targetId === p.id ? "selected" : ""}>#${p.number} ${esc(p.name)}</option>`).join("")}</select>
          <button class="btn-sm" data-act="award.override:${a.id}">手動改</button>
          <button class="btn-sm primary" data-act="award.reveal:${a.id}">揭曉</button></div>`;
    })
        .join("")}
    </div>
  </section>`;
}
function songsSection(v) {
    const songs = v.songs ?? [];
    const lease = v.audioLease;
    const pb = v.playback;
    const round = v.currentRound;
    const curCard = round ? (v.cards ?? []).find((c) => c.id === round.cardId) : null;
    const isBid = curCard?.type === "bid";
    const bids = isBid && round ? (v.submissions ?? []).filter((x) => x.roundId === round.id && x.confirmed && typeof x.amount === "number" && x.amount >= 1) : [];
    // v0.3.0：最少秒數先聽；同秒 → 最後提交（ts 最大）先
    const ranked = [...bids].sort((a, b) => a.amount - b.amount || b.ts - a.ts);
    const winner = ranked[0];
    const second = ranked[1];
    const auction = isBid && round ? round.auction : null;
    const nameOf = (id) => esc((v.players ?? []).find((x) => x.id === id)?.name ?? "?");
    const rankingRows = (auction?.ranking ?? [])
        .map((r, i) => `<div class="ledger-row"><span class="pill ${i === auction?.cursor && !auction?.finished ? "hot" : ""}">${i + 1}</span><span class="grow">${nameOf(r.playerId)}</span><b>${r.seconds} 秒</b>${(auction?.judged ?? []).includes(r.playerId) ? `<span class="pill on">已判</span>` : ""}</div>`)
        .join("");
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
        .map((sg, i) => `<div class="ledger-row"><span class="pill">${i + 1}</span><span class="grow">${esc(sg.title)} <span class="muted">${esc(sg.source?.kind)}${sg.source?.fileName ? "・" + esc(sg.source.fileName) : ""}</span></span>
            <span class="pill ${sg.state === "ready" ? "on" : "off"}">${esc(sg.state)}</span>
            <button class="btn-sm primary" data-act="song.play:${sg.id}">播 15 秒</button>
            <button class="btn-sm" data-act="song.playFull:${sg.id}">由頭播</button>
            <button class="btn-sm danger" data-act="song.del:${sg.id}">刪</button></div>`)
        .join("") || `<div class="muted">未有歌</div>`}
      <div class="hint">MP3／m4a 先可以 deck 自動播；YouTube／Apple link 只會顯示俾主持手動開。</div>
    </div>
  </section>
  <section><h3>拍賣卡（bid・只 points 模式 D32）</h3>
    <div class="card-box">
      <div class="row wrap"><select id="bid-song">${songs.map((sg) => `<option value="${sg.id}">${esc(sg.title)}</option>`).join("")}</select>
        <input id="bid-prompt" placeholder="卡題目（例：聽幾秒，估歌名）" value="聽幾秒，估歌名" style="flex:1 1 180px">
        <input id="bid-max" type="number" value="10" title="最多幾秒（10）" style="width:90px">
        <input id="bid-seconds" type="number" value="10" title="競投倒數秒數" style="width:70px">
        <input id="bid-points" type="number" value="1" title="答對分" style="width:70px">
        <button class="primary" data-act="bid.card">新增拍賣卡</button></div>
      ${isBid && round ? `<div class="row wrap"><span class="pill hot">${esc(round.state)}</span><span>已競投 ${bids.length} 人</span>
        <span>最少：${winner ? `${nameOf(winner.playerId)}（${winner.amount} 秒）` : "—"}</span>
        <span>第二：${second ? `${nameOf(second.playerId)}（${second.amount} 秒）` : "—"}</span></div>
        <div class="row wrap">
          <button class="primary" data-act="bid.publish">公佈競投排名</button>
          <button class="primary" data-act="bid.judge:1" ${auction ? "" : "disabled"}>而家嗰位答對 +${curCard.points}</button>
          <button data-act="bid.judge:0" ${auction ? "" : "disabled"}>答唔到 → 下一位</button>
          <button data-act="bid.finish" ${auction || (isBid && round && round.state !== "revealed" && round.state !== "void") ? "" : "disabled"}>本首完結</button>
        </div>
        ${rankingRows ? `<div style="max-height:240px;overflow:auto">${rankingRows}</div>` : ""}
        <div class="row wrap"><button class="btn-sm" data-act="bid.settle:1">舊：得標者答對 +${curCard.points}</button><button class="btn-sm" data-act="bid.settle:0">舊：答錯 0 分</button></div>` : `<div class="muted">未開拍賣卡</div>`}
      <div class="hint">最少秒數先聽；同秒就最後撳嗰個先。主持自己 MacBook 播歌，播歌位置唔會因為換人而變。</div>
    </div>
  </section>`;
}
function drawSection(v) {
    const images = (v.assets ?? []).filter((a) => a.kind === "image");
    const round = v.currentRound;
    const curCard = round ? (v.cards ?? []).find((c) => c.id === round.cardId) : null;
    const worksCard = curCard?.type === "vote" && curCard.voteMode === "works" ? curCard : null;
    // 評審掣只出畀「現時投票卡」入面嘅作品（server 亦會驗，client 唔好誘導主持撳無效掣）
    const judgeable = new Set((worksCard?.options ?? []));
    const works = worksCard
        ? (worksCard.options ?? []).map((id) => images.find((a) => a.id === id)).filter(Boolean)
        : [];
    return `<section><h3>畫畫關：影相上牆／作品牆／評審</h3>
    <div class="card-box">
      <div class="row wrap"><input type="file" id="draw-file" accept="image/jpeg,image/png,image/webp" style="flex:1 1 200px">
        <select id="draw-author">${(v.players ?? []).filter((p) => p.status === "approved").map((p) => `<option value="${p.id}">#${p.number} ${esc(p.name)}</option>`).join("")}</select>
        <button class="primary" data-act="draw.upload">上載作品（≤8MB）</button>
        <button data-act="draw.voteCard">建立「最似」投票卡</button>
        <button data-act="stage.mode:draw-wall">出作品牆</button></div>
      <div class="hint">影相→上載；作品牆只出圖＋作者編號；投票卡會用現有全部作品（一人一票，可以投自己）。</div>
      <div class="works-grid" style="grid-template-columns:repeat(4,1fr)">${images
        .map((a) => {
        const author = (v.players ?? []).find((p) => p.id === a.authorId);
        const judgeRow = judgeable.has(a.id)
            ? `<div class="row" style="gap:4px;padding:0 8px 8px"><button class="btn-sm" data-act="draw.judge:${a.id}:1">+1</button><button class="btn-sm" data-act="draw.judge:${a.id}:2">+2</button><button class="btn-sm" data-act="draw.judge:${a.id}:0">0</button></div>`
            : `<div class="row" style="gap:4px;padding:0 8px 8px"><span class="muted">唔喺現時投票卡</span></div>`;
        return `<div class="work"><img src="/media/${esc(a.file)}" alt=""><div class="cap"><span>${author ? `#${author.number} ${esc(author.name)}` : "未指定作者"}</span>
          <span class="row" style="gap:4px"><button class="btn-sm" data-act="draw.focus:${a.id}">放大</button></span></div>
          ${judgeRow}</div>`;
    })
        .join("") || `<div class="muted">未有作品</div>`}</div>
      ${works.length ? `<div class="hint">投票卡作品：${works.length} 張（開卡後手機投「邊張最似」；reveal 後自動入人氣票＋最似獎）</div>` : ""}
    </div>
  </section>
  <section><h3>作品投票卡</h3><div class="card-box">${cardListSummary(v)}</div></section>`;
}
function cardListSummary(v) {
    const item = (v.rundown ?? []).find((i) => i.id === v.currentItemId);
    const cards = (item?.cardIds ?? []).map((id) => (v.cards ?? []).find((c) => c.id === id)).filter(Boolean);
    return cards.length
        ? cards.map((c) => `<div class="ledger-row"><span class="pill">${esc(c.type)}</span><span class="grow">${esc(c.prompt)}</span><span class="muted">${esc(c.id)}</span><button class="btn-sm primary" data-act="card.open:${c.id}">開</button><button class="btn-sm" data-act="delete.card:${c.id}">刪</button></div>`).join("")
        : `<div class="muted">呢關未有卡</div>`;
}
function saboteurSection(v) {
    const st = v.saboteurState;
    const sab = st ? (v.players ?? []).find((p) => p.id === st.saboteurId) : null;
    const approved = (v.players ?? []).filter((p) => p.status === "approved");
    const alive = st ? approved.filter((p) => !(st.eliminatedIds ?? []).includes(p.id)) : approved;
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
        <select id="sab-target">${alive.map((p) => `<option value="${p.id}">#${p.number} ${esc(p.name)}</option>`).join("")}</select>
        <button class="danger" data-act="sab.eliminate">裁決淘汰佢</button></div>
      <div class="hint">淘汰條件：候選人票數 ≥ ⌊validVotes/2⌋+1 即場淘汰；唯一最高但未過半／平票 → 主持重投或裁決；全體棄權 → 當輪冇人淘汰。揪中：投畀搗蛋鬼嘅人各 +3、搗蛋鬼冇 +5；兩輪都揪唔中 → 搗蛋鬼 +5。</div>
    </div>
  </section>
  <section><h3>全場身份（host-only）</h3>
    <div class="card-box">
      ${approved
        .map((p) => {
        const elim = st?.eliminatedIds?.includes(p.id);
        return `<div class="ledger-row ${elim ? "voided" : ""}"><span class="who">#${p.number} ${esc(p.name)}</span>
          <span class="pill ${p.secretRole === "saboteur" ? "hot" : "gray"}">${p.secretRole === "saboteur" ? "😈 搗蛋鬼" : p.secretRole === "crew" ? "🙂 好人" : "未派"}</span>
          <span class="grow"></span><span class="muted">${elim ? "已淘汰" : st ? "在場" : ""}</span></div>`;
    })
        .join("")}
      <div class="hint">round：${esc(pres)}</div>
      ${rounds
        .map((r) => `<div class="hint">第 ${r.index} 輪 ${esc(r.roundId)}：${esc(r.state)}・票 ${r.votes.length}・淘汰 ${r.eliminatedId ? esc((v.players ?? []).find((p) => p.id === r.eliminatedId)?.name ?? r.eliminatedId) : "—"}・裁決 ${esc(r.decision ?? "—")}${r.retried ? "・重投" : ""}</div>`)
        .join("")}
    </div>
  </section>`;
}
function statusSection(v) {
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
function render() {
    const root = el("#host-root");
    if (!root)
        return;
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
    if (tab === "control")
        body = controlSection(v);
    else if (tab === "players")
        body = playersSection(v);
    else if (tab === "groups")
        body = groupsSection(v);
    else if (tab === "score")
        body = scoreSection(v);
    else if (tab === "cards")
        body = cardsSection(v);
    else if (tab === "quiz")
        body = quizSection(v);
    else if (tab === "rules")
        body = rulesSection(v);
    else if (tab === "songs")
        body = songsSection(v);
    else if (tab === "draw")
        body = drawSection(v);
    else if (tab === "saboteur")
        body = saboteurSection(v);
    else if (tab === "awards")
        body = awardsSection(v);
    else
        body = statusSection(v);
    // 主持打緊字時，server patch 觸發嘅 render 唔可以食晒表單輸入（codex 第五輪 #2）
    const formSnap = snapshotForm();
    root.innerHTML = `
    ${connBanner(status, v)}
    <div class="host-top">
      <b>主持台</b>
      <span class="pill">房碼 ${esc(v.roomCode)}</span>
      <span class="pill">階段 ${esc(PHASE_LABEL[v.phase] ?? v.phase)}</span>
      <span class="pill">畫面 ${esc(MODE_LABEL[v.stage?.mode] ?? v.stage?.mode ?? "—")}</span>
      <span class="pill">版本 ${v.revision}</span>
      <span class="pill">${esc(hostName)}</span>
      <span class="grow"></span>
      <button class="btn-sm ghost" data-act="logout">登出</button>
    </div>
    <div class="host-tabs"><div class="tabbar">${TABS.map(([id, label]) => `<button class="${tab === id ? "active" : ""}" data-act="tab:${id}">${label}</button>`).join("")}<details class="tab-more" ${ADVANCED_TABS.some(([id]) => id === tab) ? "open" : ""}><summary class="${ADVANCED_TABS.some(([id]) => id === tab) ? "active" : ""}">進階</summary><div class="tabbar">${ADVANCED_TABS.map(([id, label]) => `<button class="${tab === id ? "active" : ""}" data-act="tab:${id}">${label}</button>`).join("")}</div></details></div></div>
    <div class="host-wrap">${body}</div>
    <div id="toast"></div>`;
    restoreForm(formSnap);
    bindDelegates();
    syncDeck();
}
/** 主持改過／打緊字嘅表單鍵：render() 換 innerHTML 之後要還原（codex 第五輪 #2） */
const dirtyForm = new Set();
/** 每個 key 最後一次真係打字（input／change）嘅時間：請求進行中打嘅字唔可以當提交咗（codex 第七輪 #3） */
const dirtyAt = new Map();
/** 穩定嘅表單鍵：有 id 用 id；其餘用 tag＋data-*（data-act 係按鈕屬性，唔算） */
function formKey(node) {
    if (node.id)
        return `#${node.id}`;
    const attrs = [];
    for (const attr of Array.from(node.attributes)) {
        if (attr.name.startsWith("data-") && attr.name !== "data-act")
            attrs.push(`${attr.name}=${attr.value}`);
    }
    return attrs.length ? `${node.tagName.toLowerCase()}|${attrs.sort().join("|")}` : "";
}
const DIRTY_SCOPE = {
    "card.create": { match: ["#new-card-"], recordArg: null },
    "quiz.save": { match: ["data-q-"], recordArg: 1 },
    "rules.save": { match: ["data-r-"], recordArg: 1 },
    "groups.set": { match: ["#group-count"], recordArg: null },
    "groups.custom": { match: ["#group-count"], recordArg: null },
    "groups.assign": { match: ["data-assign-g", "data-assign-mode"], recordArg: 1 },
    "score.custom": { match: ["#score-target", "#score-delta", "#score-reason"], recordArg: null },
    "song.add": { match: ["#song-title", "#song-url"], recordArg: null },
    "song.upload": { match: ["#song-upload-title"], recordArg: null },
    "bid.card": { match: ["#bid-song", "#bid-prompt", "#bid-max", "#bid-seconds", "#bid-points"], recordArg: null },
    "player.number": { match: ["data-num"], recordArg: 1 },
    "player.rename": { match: ["data-name"], recordArg: 1 },
    "player.group": { match: ["data-group"], recordArg: 1 },
    "judge.actual": { match: ["#actual-answer"], recordArg: null },
    "settings.maxbid": { match: ["#maxbid"], recordArg: null },
    "sab.eliminate": { match: ["#sab-target"], recordArg: null },
    "draw.upload": { match: ["#draw-file", "#draw-author"], recordArg: null },
    "award.override": { match: ["data-award-target"], recordArg: 1 },
};
/** act 嘅 action id：<key>.<sub>（"quiz.save:q_1" → "quiz.save"；"tab:quiz" → "tab"） */
function actIdOf(act) {
    return act.split(":")[0] ?? "";
}
/** formKey 入面有冇一個 data-* 值係呢個記錄（"q_1" 對得上 "q_1" 同 "q_1:0"，唔可以對上 "q_10"） */
function keyHasRecord(key, record) {
    for (const part of key.split("|")) {
        const eq = part.indexOf("=");
        if (eq < 0)
            continue;
        const value = part.slice(eq + 1);
        if (value === record || value.startsWith(`${record}:`))
            return true;
    }
    return false;
}
/** 今次提交可以清邊啲 key：命中 match 片段 ＋（有 record 時）record 完全對得上。
 *  唔識嘅 action、或者有 record 但抽唔到 id，一律唔清（寧願留住主持打緊嘅字）。 */
function dirtyKeysFor(act, dirty) {
    const scope = DIRTY_SCOPE[actIdOf(act)];
    if (!scope)
        return [];
    const record = scope.recordArg === null ? null : act.split(":")[scope.recordArg] || null;
    if (scope.recordArg !== null && !record)
        return [];
    const out = [];
    for (const key of dirty) {
        if (!scope.match.some((p) => key.includes(p)))
            continue;
        if (record && !keyHasRecord(key, record))
            continue;
        out.push(key);
    }
    return out;
}
/** 提交成功之後清相關欄。typedDuringRequest：請求進行中主持新打嘅字要留住（值同 request 開始時唔同）。
 *  只喺提交成功先 call（失敗／驗證不過要留住主持打緊嘅字）。 */
function clearDirtyFor(act, dirty, typedDuringRequest) {
    for (const key of dirtyKeysFor(act, dirty)) {
        if (typedDuringRequest?.(key))
            continue;
        dirty.delete(key);
    }
}
function snapshotForm() {
    const values = new Map();
    const root = el("#host-root");
    if (!root)
        return { values, focus: "" };
    const active = document.activeElement;
    let focus = "";
    for (const node of root.querySelectorAll("input,textarea,select")) {
        const key = formKey(node);
        if (!key)
            continue;
        const focused = active === node;
        if (focused)
            focus = key;
        // 只保住主持真係改過嘅欄；未改過就跟 server 最新值（例如揭曉後清空）
        if (!focused && !dirtyForm.has(key))
            continue;
        values.set(key, {
            value: node.value,
            checked: node.checked === true,
            selStart: focused ? node.selectionStart ?? null : null,
            selEnd: focused ? node.selectionEnd ?? null : null,
        });
    }
    return { values, focus };
}
function restoreForm(snap) {
    const root = el("#host-root");
    if (!root || (!snap.values.size && !snap.focus))
        return;
    let focusNode = null;
    for (const node of root.querySelectorAll("input,textarea,select")) {
        const key = formKey(node);
        if (!key)
            continue;
        if (key === snap.focus)
            focusNode = node;
        const s = snap.values.get(key);
        if (!s)
            continue;
        const type = node.type ?? "";
        if (type === "file")
            continue; // file input 唔可以程式化還原
        if (type === "checkbox" || type === "radio") {
            if (node.checked !== s.checked)
                node.checked = s.checked;
        }
        else if (node.value !== s.value) {
            node.value = s.value;
        }
    }
    const s = snap.values.get(snap.focus);
    if (!focusNode || !s)
        return;
    focusNode.focus();
    const el2 = focusNode;
    if (s.selStart !== null && s.selEnd !== null && typeof el2.setSelectionRange === "function") {
        try {
            el2.setSelectionRange(s.selStart, s.selEnd);
        }
        catch {
            /* number／select 唔支援 selection：位置還原唔到唔緊要 */
        }
    }
}
/** 今次 click 有冇失敗（client 驗證／command 失敗）：有就唔清 dirty fields */
let actFailed = false;
/** 驗證不過（唔會發 command）：記低失敗再彈 toast */
function failAct(msg) {
    actFailed = true;
    showToast(msg);
}
function val(sel) {
    return (el(sel)?.value ?? "").trim();
}
function checked(sel) {
    return el(sel)?.checked === true;
}
/** 空／非數字／非整數 一律回 null（唔好靜靜當 0） */
function parseIntStrict(raw) {
    const s = (raw ?? "").trim();
    if (!s)
        return null;
    const n = Number(s);
    return Number.isInteger(n) ? n : null;
}
function parseGroupCount(raw) {
    const n = parseIntStrict(raw);
    return n !== null && n >= 0 && n <= 30 ? n : null;
}
let delegatesBound = false;
function bindDelegates() {
    const root = el("#host-root");
    if (!root)
        return;
    if (!delegatesBound) {
        delegatesBound = true;
        // 只 bind 一次：render() 會重寫 innerHTML，但 root 本身唔會換，重複 bind 會令一吓 click 發 N 次命令
        // 記低主持改過嘅欄：patch render 之後還原，唔會清空打緊嘅字
        const markDirty = (ev) => {
            const node = ev.target;
            if (!node)
                return;
            const tag = node.tagName?.toLowerCase();
            if (tag !== "input" && tag !== "textarea" && tag !== "select")
                return;
            const key = formKey(node);
            if (!key)
                return;
            dirtyForm.add(key);
            dirtyAt.set(key, Date.now());
        };
        root.addEventListener("input", markDirty);
        root.addEventListener("change", markDirty);
        root.addEventListener("click", (ev) => {
            const target = ev.target?.closest("[data-act]");
            if (!target)
                return;
            const act = target.dataset.act ?? "";
            // 撳掣＝表單交咗／唔再打緊字：下一版重繪照用 server 值（否則欄位永遠留住舊輸入）
            // 但只清同呢個 action 有關嘅欄，而且要佢提交成功先清（失敗／驗證不過就留住主持打緊嘅字）
            actFailed = false;
            // 撳掣一刻嘅時間：請求進行中主持新打嘅字要留住（唔可以當佢已經提交咗）
            const requestStartedAt = Date.now();
            void handleAct(act)
                .catch(() => {
                actFailed = true;
            })
                .then(() => {
                if (!actFailed) {
                    clearDirtyFor(act, dirtyForm, (key) => (dirtyAt.get(key) ?? 0) > requestStartedAt);
                    for (const key of Array.from(dirtyAt.keys()))
                        if (!dirtyForm.has(key))
                            dirtyAt.delete(key);
                }
                actFailed = false;
            });
        });
    }
    for (const sel of root.querySelectorAll("[data-act='ticker.sort'],[data-act='ticker.scope'],[data-act='ticker.range']")) {
        if (sel.__tickerBound)
            continue;
        sel.__tickerBound = true;
        sel.addEventListener("change", () => void tickerChange());
    }
}
async function tickerChange() {
    await cmd("stage.ticker", undefined, {
        sort: val("#ticker-sort") || undefined,
        scope: val("#ticker-scope") || undefined,
        range: val("#ticker-range") || undefined,
    });
}
async function uploadFile(kind, fields, inputSel) {
    const input = el(inputSel);
    const file = input?.files?.[0];
    if (!file) {
        showToast("先揀一個檔案");
        return null;
    }
    if (!token)
        return null;
    const fd = new FormData();
    fd.append("kind", kind);
    for (const [k, v] of Object.entries(fields))
        if (v)
            fd.append(k, v);
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
    }
    catch (err) {
        showToast("上傳失敗：" + String(err));
        return null;
    }
}
async function refreshExport(format) {
    if (!token)
        return;
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
async function handleAct(act) {
    // grammar: <key>.<sub>:<arg1>:<arg2>…（tab:<id> / logout 無 dot，保留舊制）
    const seg = act.split(":");
    const head = seg[0] ?? "";
    const dot = head.indexOf(".");
    const key = dot >= 0 ? head.slice(0, dot) : head;
    const sub = dot >= 0 ? head.slice(dot + 1) : "";
    const arg = seg[1] ?? "";
    const arg2 = seg[2];
    switch (key) {
        case "tab":
            tab = sub || arg || "control";
            render();
            return;
        case "logout":
            lsDel("hbd.hostToken");
            live?.close();
            token = null;
            renderLogin();
            return;
        case "rd":
            if (sub === "moveup" || sub === "movedown") {
                const ids = (view?.rundown ?? []).map((x) => x.id);
                const i = Number(arg);
                const j = sub === "moveup" ? i - 1 : i + 1;
                if (!Number.isInteger(i) || i < 0 || j < 0 || i >= ids.length || j >= ids.length)
                    return;
                [ids[i], ids[j]] = [ids[j], ids[i]];
                await cmd("rundown.reorder", undefined, { ids });
            }
            else if (sub === "resetOrder") {
                const order = ["draw", "auction", "killer", "quiz"];
                const ids = (view?.rundown ?? [])
                    .slice()
                    .sort((a, b) => order.indexOf(a.gameId) - order.indexOf(b.gameId))
                    .map((x) => x.id);
                await cmd("rundown.reorder", undefined, { ids });
            }
            else
                await cmd(`rundown.${sub}`);
            break;
        case "killer":
            if (sub === "assign")
                await cmd("killer.assign");
            else if (sub === "redraw")
                await cmd("killer.redraw");
            else if (sub === "clear")
                await cmd("killer.clear");
            else if (sub === "any") {
                const anyWho = val("#killer-target");
                const anyDelta = parseIntStrict(arg);
                if (!anyWho || anyDelta === null || anyDelta === 0) {
                    failAct("揀一個人同入非 0 整數");
                    return;
                }
                await cmd("score.add", anyWho, { targetType: "player", targetId: anyWho, delta: anyDelta, reason: "笨蛋殺手・主持加分", gameId: "killer" });
            }
            else if (sub === "score") {
                const who = arg === "boss" ? view?.killerState?.bossId : view?.killerState?.killerId;
                const delta = parseIntStrict(arg2);
                if (!who) {
                    failAct("未抽身份");
                    return;
                }
                if (delta === null || delta === 0) {
                    failAct("加分要非 0 整數");
                    return;
                }
                await cmd("score.add", who, { targetType: "player", targetId: who, delta, reason: `笨蛋殺手・${arg === "boss" ? "老闆" : "殺手"}`, gameId: "killer" });
            }
            break;
        case "ucm":
            if (sub === "start") {
                const n = Number(val("#ucm-count")) || 2;
                await cmd("uc.match.start", undefined, { undercoverCount: n });
            }
            else if (sub === "redraw")
                await cmd("uc.match.redraw");
            else if (sub === "reveal")
                await cmd("uc.prompt.reveal");
            else if (sub === "vote")
                await cmd("uc.vote.start");
            // v0.4.0：投票中「立即開票」（同一個 finalizeUndercover，唔再另開一套 code path）
            else if (sub === "revealRound")
                await cmd("undercover.reveal");
            // v0.4.0：由 server 計最高票再 foul（同票／冇票會 throw W_TIE／W_NO_VOTES 顯示喺 toast）
            else if (sub === "foultop")
                await cmd("uc.vote.foulTop");
            else if (sub === "eliminate") {
                if (!val("#ucm-target")) {
                    failAct("冇人可以揀（全部出局？）");
                    return;
                }
                await cmd("uc.eliminate", undefined, { playerId: val("#ucm-target") });
            }
            else if (sub === "undo")
                await cmd("uc.eliminate.undo");
            else if (sub === "next")
                await cmd("uc.match.next");
            else if (sub === "settle")
                await cmd("uc.match.settle");
            else if (sub === "reset")
                await cmd("uc.match.reset");
            break;
        case "room":
            if (sub === "start")
                await cmd("room.start");
            else if (sub === "phase")
                await cmd("room.phase", undefined, { phase: arg });
            break;
        case "stage":
            // 一撳即返 QR／入場頁：stage.set 已經可以離開黑屏（唔使先撳「恢復畫面」）
            if (sub === "qr")
                await cmd("stage.set", undefined, { mode: "idle" });
            else if (sub === "nextPage")
                await cmd("stage.page", undefined, { pageIndex: (view?.stage?.payload?.pageIndex ?? 0) + 1 });
            else if (sub === "prevPage")
                await cmd("stage.page", undefined, { pageIndex: Math.max(0, (view?.stage?.payload?.pageIndex ?? 0) - 1) });
            else if (sub === "lock")
                await cmd("stage.lock", undefined, { lock: !view?.stage?.lock });
            else if (sub === "blackout")
                await cmd("stage.blackout", undefined, { on: arg === "1" });
            else if (sub === "rules")
                await cmd("stage.rules", undefined, { on: arg === "1" });
            else if (sub === "mode")
                await cmd("stage.set", undefined, { mode: arg });
            break;
        case "qa":
            if (sub === "question") {
                // v04-D：唔再自己揀下一題（client 嘅 v.quiz 次序同 server rundown cardIds 次序可能唔一致）：
                // 交畀 server 揀，全部出完就會回 W_ALREADY_STATE 嘅清楚訊息（cmd() 會彈 toast）
                await cmd("quiz.show");
            }
            else if (sub === "dist") {
                if (view?.currentRound?.state === "open")
                    await cmd("card.close");
                await cmd("card.tally");
            }
            else if (sub === "reveal") {
                if (view?.currentRound?.state === "open")
                    await cmd("card.close");
                await cmd("card.reveal");
            }
            break;
        case "ticker":
            if (sub === "toggle")
                await cmd("stage.ticker", undefined, { visible: !view?.stage?.ticker?.visible });
            break;
        case "settings":
            if (sub === "autoclose")
                await cmd("settings.set", undefined, { autoClose: arg === "1" });
            if (sub === "maxbid")
                await cmd("settings.set", undefined, { maxBid: Number(val("#maxbid")) });
            break;
        default:
            break;
    }
    // 第二段：需要 id 嘅 action
    if (key === "player") {
        if (sub === "approve" && arg)
            await cmd("player.approve", arg);
        else if (sub === "kick" && arg)
            await cmd("player.kick", arg);
        else if (sub === "number" && arg)
            await cmd("player.update", arg, { number: Number(val(`[data-num="${arg}"]`)) });
        else if (sub === "rename" && arg)
            await cmd("player.update", arg, { name: val(`[data-name="${arg}"]`) });
        else if (sub === "group" && arg)
            await cmd("groups.assign", undefined, { playerId: arg, groupId: val(`[data-group="${arg}"]`) || null, mode: "follow" });
    }
    else if (key === "groups") {
        if (sub === "set") {
            const count = parseGroupCount(arg);
            if (count === null) {
                failAct("組數字要入 0–30 嘅整數");
                return;
            }
            await cmd("groups.set", undefined, { count });
        }
        else if (sub === "custom") {
            const count = parseGroupCount(val("#group-count"));
            if (count === null) {
                failAct("組數字要入 0–30 嘅整數");
                return;
            }
            await cmd("groups.set", undefined, { count });
        }
        else if (sub === "assign" && arg)
            await cmd("groups.assign", undefined, { playerId: arg, groupId: val(`[data-assign-g="${arg}"]`) || null, mode: val(`[data-assign-mode="${arg}"]`) || "follow" });
    }
    else if (key === "score") {
        if (sub === "add" && arg) {
            const delta = parseIntStrict(arg2);
            if (delta === null || delta === 0 || Math.abs(delta) > 1000) {
                failAct("加減分要入非 0 整數（±1000）");
                return;
            }
            await cmd("score.add", arg, { targetType: "player", delta });
        }
        else if (sub === "bulk" && arg)
            await cmd("score.bulk", undefined, { delta: Number(arg), reason: "全場分" });
        else if (sub === "void" && arg)
            await cmd("score.void", arg);
        else if (sub === "custom") {
            const delta = parseIntStrict(val("#score-delta"));
            if (delta === null || delta === 0 || Math.abs(delta) > 1000) {
                failAct("加減分要入非 0 整數（±1000）");
                return;
            }
            await cmd("score.add", val("#score-target"), {
                targetType: "player",
                targetId: val("#score-target"),
                delta,
                reason: val("#score-reason") || "主持加分",
            });
        }
    }
    else if (key === "card") {
        if (sub === "open" && arg)
            await cmd("card.open", arg);
        else if (sub === "close")
            await cmd("card.close");
        else if (sub === "tally")
            await cmd("card.tally");
        else if (sub === "reveal")
            await cmd("card.reveal");
        else if (sub === "reopen")
            await cmd("card.reopen", view?.currentRound?.cardId);
        else if (sub === "create") {
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
    }
    else if (key === "judge") {
        if (sub === "actual") {
            const round = view?.currentRound;
            const raw = val("#actual-answer");
            if (!raw) {
                failAct("要入真實答案數字");
                return;
            }
            const val2 = Number(raw);
            if (!round || !Number.isFinite(val2)) {
                failAct("要入真實答案數字");
                return;
            }
            await cmd("quiz.setActualAnswer", undefined, { roundId: round.id, actualAnswer: val2 });
        }
        else if (sub === "all") {
            await cmd("score.judge", undefined, { roundId: view?.currentRound?.id, allCorrect: true });
        }
        else if (arg) {
            const points = Number(sub);
            await cmd("score.judge", undefined, { roundId: view?.currentRound?.id, submissionId: arg, points, correct: points > 0 });
        }
    }
    else if (key === "quiz") {
        if (sub === "clearimport") {
            importReport = null;
            render();
            return;
        }
        if (sub === "add") {
            await cmd("quiz.upsert", undefined, {
                question: { type: arg, prompt: "新題目（改我）", category: "", seconds: arg === "choice" ? 20 : 45, points: arg === "choice" ? 1 : 2, openKind: arg === "open" ? "text" : undefined, options: arg === "choice" ? ["A", "B", "C", "D"] : undefined, correct: arg === "choice" ? 0 : undefined },
            });
        }
        else if (sub === "del" && arg)
            await cmd("quiz.delete", arg);
        else if (sub === "copy" && arg) {
            const q = (view.quiz ?? []).find((x) => x.id === arg);
            if (!q)
                return;
            await cmd("quiz.upsert", undefined, {
                question: { type: q.type, category: q.category, prompt: `${q.prompt}（複製）`, options: q.options, correct: q.correct, explanation: q.explanation, hint: q.hint, openKind: q.openKind, referenceAnswer: q.referenceAnswer, seconds: q.seconds, points: q.points },
            });
        }
        else if (sub === "save" && arg) {
            const q = (view.quiz ?? []).find((x) => x.id === arg);
            if (!q)
                return;
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
                    tolerance: q.tolerance,
                    imageUrl: q.imageUrl,
                },
            });
        }
        else if (sub === "import") {
            if (!window.confirm("確定匯入舊 QUIZ？同名 MC 題（包括 13 題新題嘅同名 id）會被覆蓋。")) {
                showToast("已取消匯入");
                return;
            }
            const res = await fetch("/quiz-legacy-mc.json").then((r) => r.json()).catch(() => null);
            if (!res) {
                failAct("搵唔到舊 QUIZ 資料");
                return;
            }
            const r2 = await cmd("quiz.import", undefined, { questions: res.questions });
            importReport = r2?.ok ? r2.result : null;
            showToast(r2?.ok ? `匯入完成：${res.questions.length} 題 MC（open 題唔會蓋）` : "匯入失敗");
            render();
        }
        else if (sub === "up" || sub === "down") {
            const ids = (view.quiz ?? []).map((q) => q.id);
            const i = ids.indexOf(arg);
            const j = sub === "up" ? i - 1 : i + 1;
            if (i >= 0 && j >= 0 && j < ids.length) {
                const tmp = ids[i];
                ids[i] = ids[j];
                ids[j] = tmp;
                await cmd("quiz.reorder", undefined, { ids });
            }
        }
        else if (sub === "show") {
            // v04-D：只出題目（唔開 round）——冇 arg 就由 server 揀下一題 draft
            await cmd("quiz.show", arg || undefined);
        }
        else if (sub === "open") {
            // v04-D：真正開 30 秒 round（冇 arg 就跟大mon 而家 show 緊嗰題）
            await cmd("quiz.open", arg || undefined);
        }
        else if (sub === "jump") {
            const id = val("#quiz-jump");
            if (!id) {
                failAct("先喺 dropdown 揀一題");
                return;
            }
            await cmd("quiz.show", id);
        }
        else if (sub === "reset") {
            const clearScores = checked("#quiz-clearscores");
            if (clearScores && !window.confirm("重設問答會令全部題目變返「未出」並 void 未完成嘅 round。確定順便清走全部問答分？"))
                return;
            await cmd("quiz.reset", undefined, { clearScores });
        }
    }
    else if (key === "rules") {
        if (sub === "new" && arg) {
            await cmd("rules.upsert", undefined, {
                page: { gameId: arg, title: "新規則頁", subtitle: "", blocks: [{ type: "heading", text: "玩法" }], order: (view.rulePages?.length ?? 0) + 1, enabled: true, autoAdvanceSeconds: 0 },
            });
        }
        else if (sub === "save" && arg) {
            const pageId = arg;
            const version = Number(arg2);
            let blocks = [];
            try {
                blocks = JSON.parse(val(`[data-r-blocks="${pageId}"]`) || "[]");
            }
            catch {
                failAct("blocks JSON 格式錯");
                return;
            }
            const page = (view.rulePages ?? []).find((p) => p.id === pageId);
            if (!page)
                return;
            const res = await cmd("rules.upsert", undefined, {
                page: {
                    id: pageId,
                    gameId: page.gameId,
                    title: val(`[data-r-title="${pageId}"]`),
                    subtitle: val(`[data-r-sub="${pageId}"]`),
                    blocks,
                    order: page.order,
                    enabled: checked(`[data-r-enabled="${pageId}"]`),
                    autoAdvanceSeconds: Number(val(`[data-r-auto="${pageId}"]`)) || 0,
                },
                expectedVersion: version,
            });
            if (res && !res.ok && res.code === "W_RULES_CONFLICT") {
                showToast("版本衝突（第二個 host 改過）→ 已載入最新");
                live?.resync();
            }
        }
        else if (sub === "del" && arg)
            await cmd("rules.delete", arg);
        else if (sub === "show" && arg)
            await cmd("stage.rules", undefined, { on: true, rulePageId: arg });
        else if (sub === "reload")
            live?.resync();
    }
    else if (key === "song") {
        if (sub === "add") {
            await cmd("song.upsert", undefined, { song: { title: val("#song-title"), url: val("#song-url") } });
        }
        else if (sub === "upload") {
            await uploadFile("audio", { title: val("#song-upload-title") }, "#song-file");
        }
        else if (sub === "play" && arg) {
            await cmd("media.play", arg, { songId: arg, deckId, window: [0, 15000] });
        }
        else if (sub === "playFull" && arg) {
            await cmd("media.play", arg, { songId: arg, deckId, fromStart: true, window: [0, 600000] });
        }
        else if (sub === "del" && arg)
            await cmd("song.delete", arg);
    }
    else if (key === "media") {
        if (sub === "pause")
            await cmd("media.pause", undefined, { deckId });
        else if (sub === "resume")
            await cmd("media.resume", undefined, { deckId });
        else if (sub === "stop")
            await cmd("media.stop", undefined, { deckId });
        else if (sub === "reveal")
            await cmd("media.reveal");
        else if (sub === "unlock") {
            const a = deckAudio();
            a?.play().then(() => {
                audioBlocked = false;
                render();
            }).catch(() => showToast("瀏覽器仍然擋 autoplay：撳一下頁面再試"));
        }
    }
    else if (key === "lease") {
        if (sub === "acquire") {
            const r = await cmd("lease.acquire", undefined, { deckId });
            if (r && !r.ok)
                showToast(r.message ?? "接管失敗（等 margin）");
            else
                deckStatus = "已申請音源";
            scheduleLeasePause();
        }
        else if (sub === "acquireOnline") {
            const r = await cmd("lease.acquire", undefined, { deckId, forceOnline: true });
            if (r && !r.ok)
                showToast(r.message ?? "在線接管失敗");
            else
                deckStatus = "在線接管成功（舊 deck 即時停）";
            scheduleLeasePause();
        }
        else if (sub === "release") {
            await cmd("lease.release", undefined, { deckId });
        }
    }
    else if (key === "bid") {
        if (sub === "card") {
            await cmd("card.create", undefined, {
                card: {
                    type: "bid",
                    gameId: "auction",
                    prompt: val("#bid-prompt") || "聽 15 秒，估歌名",
                    songId: val("#bid-song"),
                    maxBid: Number(val("#bid-max")) || 10,
                    seconds: Number(val("#bid-seconds")) || 10,
                    points: Number(val("#bid-points")) || 1,
                },
            });
        }
        else if (sub === "publish") {
            await cmd("bid.publish", undefined, { roundId: view?.currentRound?.id });
        }
        else if (sub === "judge") {
            await cmd("bid.judge", undefined, { roundId: view?.currentRound?.id, correct: arg === "1" });
        }
        else if (sub === "finish") {
            await cmd("bid.finish", undefined, { roundId: view?.currentRound?.id });
        }
        else if (sub === "settle") {
            await cmd("bid.settle", undefined, { roundId: view?.currentRound?.id, correct: arg === "1" });
        }
        else if (sub === "settleBackup") {
            await cmd("bid.settle", undefined, { roundId: view?.currentRound?.id, correct: false, backup: true });
        }
    }
    else if (key === "draw") {
        if (sub === "upload") {
            await uploadFile("image", { authorId: val("#draw-author") }, "#draw-file");
        }
        else if (sub === "voteCard") {
            const images = (view?.assets ?? []).filter((a) => a.kind === "image");
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
                    options: images.map((a) => a.id),
                    seconds: 30,
                    points: 1,
                },
            });
        }
        else if (sub === "judge" && arg) {
            const assetId = arg;
            const points = parseIntStrict(arg2 ?? "1");
            const cardId = view?.currentRound?.cardId;
            if (!cardId) {
                showToast("先開投票卡");
                return;
            }
            const card = (view?.cards ?? []).find((c) => c.id === cardId);
            if (!card || card.type !== "vote" || card.voteMode !== "works") {
                showToast("先開畫畫投票卡");
                return;
            }
            if (points === null || ![0, 1, 2].includes(points)) {
                showToast("評審分只可以 0／1／2");
                return;
            }
            if (!(card.options ?? []).includes(assetId)) {
                showToast("作品唔屬於呢張投票卡");
                return;
            }
            await cmd("draw.judge", cardId, { cardId, assetId, points });
        }
        else if (sub === "focus") {
            await cmd("draw.focus", undefined, { assetId: arg || null });
        }
    }
    else if (key === "sab") {
        if (sub === "assign")
            await cmd("saboteur.assign");
        else if (sub === "open")
            await cmd("saboteur.openRound");
        else if (sub === "close")
            await cmd("saboteur.closeRound");
        else if (sub === "retry")
            await cmd("saboteur.decide", undefined, { decision: "retry", roundId: view?.currentRound?.id });
        else if (sub === "eliminate")
            await cmd("saboteur.decide", undefined, { decision: "eliminate", roundId: view?.currentRound?.id, targetId: val("#sab-target") });
        else if (sub === "finish")
            await cmd("saboteur.finish");
        else if (sub === "reset")
            await cmd("saboteur.reset");
    }
    else if (key === "delete") {
        if (sub === "card" && arg)
            await cmd("card.delete", arg);
    }
    else if (key === "award") {
        if (sub === "compute")
            await cmd("award.compute");
        else if (sub === "reset")
            await cmd("award.reset");
        else if (sub === "reveal" && arg)
            await cmd("award.reveal", undefined, { id: arg });
        else if (sub === "override" && arg)
            await cmd("award.override", undefined, { id: arg, targetId: val(`[data-award-target="${arg}"]`) || null });
    }
    else if (key === "export") {
        if (sub === "csv")
            await refreshExport("csv");
        else if (sub === "room")
            await refreshExport("room");
        else if (sub === "all") {
            await refreshExport("json");
            showToast("已寫入 server data/export（同時下載）");
        }
    }
}
/** boot 時間（獨佔檢查嘅讓路規則：同一個 browser 入面開得早嘅 document 留住條 ID） */
const DECK_BOOT_AT = Date.now();
/** boot 時嘅 document 獨佔檢查（codex 第七輪 #1）：複製 tab／有 opener 嘅新 window 會連 sessionStorage
 *  一齊複製 → 同一條 deck ID → 兩邊都當自己係 lease owner 雙重出聲。
 *  用 BroadcastChannel 宣告自己條 ID，150ms 內有另一個 document 用同一條 ID 應答就即刻 rotate
 *  一條新 ID 並寫返 sessionStorage，rotate 後再用新 ID 宣告一次。冇 BroadcastChannel 就照用。 */
async function ensureDeckIdExclusive() {
    ensureDeckId(); // 先有 sessionStorage／記憶體版本嘅 ID：獨佔檢查出錯都仲有一條可用
    try {
        const res = await claimDeckIdExclusive({
            deckId,
            nonce: `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
            bornAt: DECK_BOOT_AT,
            timeoutMs: DECK_CLAIM_TIMEOUT_MS,
            makeChannel: (name) => {
                const BC = globalThis.BroadcastChannel;
                try {
                    return typeof BC === "function" ? new BC(name) : null;
                }
                catch {
                    return null; // BroadcastChannel 被封（部分私密模式）：照用
                }
            },
            newId: newDeckId,
            persist: (id) => {
                setDeckId(id); // 寫返 sessionStorage：reload 要沿用呢條新 ID
            },
            /** boot 之後先送到嘅衝突（例如被 suspend 嘅 document 遲 200ms 才收到 claim）：
             *  舊 ID 已經唔係我 → 即刻收聲、重設 ACK、叫 server 重發 snapshot 令 lease 畫面跟新 ID。
             *  唔處理就會兩個 document 都當自己係 lease owner（雙重出聲）。 */
            onLateLoss: (nextId) => {
                const a = deckAudio();
                if (a && !a.paused)
                    a.pause();
                ackState.sentKey = ""; // 新 ID 要重新 ACK（同一個 attempt 亦要再送）
                deckStatus = `偵測到另一個 document 搶咗條 deck ID → 已換新 ID（${nextId}）`;
                live?.resync();
            },
        });
        if (res.rotated)
            deckStatus = `偵測到另一個 document 用同一條 deck ID → 已換新 ID（${res.deckId}）`;
    }
    catch {
        /* 檢查出錯唔可以阻 boot：照用 sessionStorage 嘅 ID */
    }
}
async function boot() {
    await ensureDeckIdExclusive();
    startDeckTimer();
    const saved = lsGet("hbd.hostToken");
    if (saved?.token) {
        token = saved.token;
        hostName = saved.hostName ?? "主持";
        roomCode = saved.roomCode ?? "";
        hostId = saved.hostId ?? "";
        startLive();
    }
    else {
        renderLogin();
    }
}
void boot();
