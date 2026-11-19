/** 大mon /stage（唯讀；17 mode；PLAN-v3.1 §8.1） */
import { Live, api, esc, avatarHtml, scoreBar, connBanner, showToast, fmtClock, el } from "./common.js";
let live = null;
let view = null;
let status = "connecting";
let timer = null;
let stableClearTimer = null;
/** 連線穩定 60 秒後才清 evicted flag：避免多個大mon 互踢造成 reload 輪迴 */
const EVICT_STABLE_MS = 60000;
function armStableClear() {
    disarmStableClear();
    stableClearTimer = window.setTimeout(() => {
        stableClearTimer = null;
        sessionStorage.removeItem("hbd.evictedAt");
    }, EVICT_STABLE_MS);
}
function disarmStableClear() {
    if (stableClearTimer === null)
        return;
    window.clearTimeout(stableClearTimer);
    stableClearTimer = null;
}
const MODE_LABEL = {
    idle: "",
    rules: "本關規則",
    scoreboard: "分數",
    leaderboard: "排行榜",
    question: "答題中",
    tally: "答案分佈",
    reveal: "揭曉",
    "draw-wall": "作品牆",
    "draw-focus": "作品放大",
    bid: "競投中",
    vote: "投票中",
    "role-reveal": "身份揭曉",
    song: "聽歌",
    finale: "結算",
    award: "頒獎",
    timer: "計時",
    message: "",
    "game-scores": "分項結算",
    blackout: "",
};
/**
 * A2：冇資料時嘅友善佔位畫面。
 * 大mon 最怕「死畫面」——寧願講清楚等主持做乜，都唔可以 throw 或者留白。
 */
function placeholder(v, title, text) {
    return `<div class="stage-main stage-idle">
    <div class="stage-mode-title">${esc(title)}</div>
    <div class="stage-sub">${esc(text)}</div>
    ${v ? scoreBar(v) : ""}
  </div>`;
}
function blocksHtml(page) {
    if (!page)
        return "";
    return (page.blocks ?? [])
        .map((b) => {
        switch (b.type) {
            case "heading":
                return `<div class="rb-heading">${esc(b.text)}</div>`;
            case "paragraph":
                return `<div class="rb-text">${esc(b.text)}</div>`;
            case "callout":
                return `<div class="rb-callout">${esc(b.text)}</div>`;
            case "bullets":
                return `<ul class="rb-list">${(b.items ?? []).map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
            case "steps":
                return `<ol class="rb-list">${(b.items ?? []).map((i) => `<li>${esc(i)}</li>`).join("")}</ol>`;
            case "kv":
                return `<div class="rb-kv"><span>${esc(b.text)}</span><span class="val">${esc(b.value ?? "")}</span></div>`;
            case "score-table":
                return `<div class="rb-table">${(b.items ?? [])
                    .map((i) => `<div class="r"><span>${esc(i)}</span></div>`)
                    .join("")}</div>`;
            case "image":
                return b.imageUrl ? `<img class="rb-img" src="${esc(b.imageUrl)}" alt="${esc(b.text ?? "")}">` : "";
            default:
                return "";
        }
    })
        .join("");
}
function idleHtml(v) {
    const code = v.roomCode ?? "";
    const qr = `${location.origin}/play?code=${encodeURIComponent(code)}`;
    const players = (v.players ?? []).filter((p) => p.status !== "kicked");
    return `
  <div class="stage-main stage-idle">
    <div class="stage-logo">關於我初試策劃<span class="accent">圍威喂</span>這檔事</div>
    <div class="stage-sub">用手機掃 QR 入場，等主持開始</div>
    <div class="idle-cols">
      <div>
        <div class="muted" style="font-size:28px;letter-spacing:6px">房碼</div>
        <div class="roomcode">${esc(code)}</div>
      </div>
      <div class="qr-box"><img src="/api/qr?data=${encodeURIComponent(qr)}&size=240" alt="QR"></div>
    </div>
    <div class="avatar-wall">${players.map((p) => avatarHtml(p.avatar, 64)).join("")}</div>
    <div class="helptext">已入場 ${players.length} 人</div>
    ${scoreBar(v)}
  </div>`;
}
function rulesHtml(v) {
    const page = v.rulePage;
    const payload = v.stage?.payload ?? {};
    const badge = payload.gameIndex ? `第 ${payload.gameIndex} 關` : "規則";
    const title = page?.title ?? payload.title ?? "規則";
    const subtitle = page?.subtitle ?? (page ? "" : "等主持開始");
    const body = page
        ? blocksHtml(page)
        : `<div class="rb-text">${esc(payload.rulesText || "主持未設定呢關規則，等主持開始。")}</div>`;
    const meta = v.rulePagesMeta;
    const pageNum = meta && meta.totalPages > 1 ? `<div class="page-num">${(meta.pageIndex ?? 0) + 1}/${meta.totalPages}</div>` : "";
    return `
  <div class="stage-main">
    <div><span class="rules-badge">${esc(badge)}</span></div>
    <div class="rules-title">${esc(title)}</div>
    <div class="rules-sub">${esc(subtitle)}</div>
    <div class="rules-body">${body}</div>
    ${pageNum}
    ${scoreBar(v)}
  </div>`;
}
/** B5：26–30 人都要睇得齊 —— 超過 12 人自動分 2／3 欄＋縮字，唔再 slice */
function scoreRowsHtml(entries, avatarSize = 48) {
    const n = entries.length;
    const cls = n > 20 ? "multi cols-3" : n > 12 ? "multi cols-2" : "";
    return `<div class="scoreboard-list ${cls}">${entries
        .map((s, i) => `<div class="sb-row"><span class="num">${i + 1}</span>${avatarHtml(s.avatar, avatarSize)}<span class="name">${esc(s.name)}</span><span class="score">${s.score}</span></div>`)
        .join("")}</div>`;
}
function boardHtml(v) {
    const entries = v.scores ?? [];
    const groups = v.groups ?? [];
    const groupScores = new Map();
    for (const e of entries) {
        if (e.groupId)
            groupScores.set(e.groupId, e.groupScore);
    }
    const groupBlock = groups.length > 0
        ? `<div style="margin-top:26px;display:flex;gap:24px;flex-wrap:wrap;font-size:34px">${groups
            .map((g) => `<div class="pill" style="font-size:30px;background:${esc(g.color)}33;border-left:10px solid ${esc(g.color)};padding:8px 20px">${esc(g.name)} <b style="color:var(--accent)">${groupScores.get(g.id) ?? 0}</b></div>`)
            .join("")}</div>`
        : "";
    return `
  <div class="stage-main">
    <div class="stage-mode-title">分數</div>
    ${scoreRowsHtml(entries, 52)}
    ${groupBlock}
    ${scoreBar(v)}
  </div>`;
}
function questionHtml(v) {
    const q = v?.question;
    // v04-D：冇題目都唔准炸。Team A 有頂層 try/catch 都唔靠佢（大mon 要至少顯示友善 placeholder）
    if (!q)
        return placeholder(v, "答題中", "等主持出題…（主持台撳「出題目」或者「開始 30 秒作答」先會出）");
    // v04-D：quiz.show → 只出題目（唔出選項、唔倒數），主持讀完才開 30 秒 round
    if (q.preview === true || q.showOptions === false) {
        return `
  <div class="stage-main">
    <div class="row" style="justify-content:space-between;align-items:baseline">
      <div class="stage-mode-title">題目</div>
    </div>
    <div class="q-prompt">${esc(q.prompt ?? "")}</div>
    ${q.imageUrl ? `<img src="${esc(q.imageUrl)}" style="max-height:260px;margin-top:12px;border-radius:14px">` : ""}
    <div class="helptext" style="margin-top:20px">等主持開始作答…（宣佈開始之後 30 秒，選項會喺大mon 同手機一齊出）</div>
    ${scoreBar(v)}
  </div>`;
    }
    const opts = q.options ?? [];
    return `
  <div class="stage-main">
    <div class="row" style="justify-content:space-between;align-items:baseline">
      <div class="stage-mode-title">${esc(MODE_LABEL[v.stage.mode] ?? "")}</div>
      <div class="countdown" data-countdown="1">--</div>
    </div>
    <div class="q-prompt">${esc(q.prompt)}</div>
    ${q.imageUrl ? `<img src="${esc(q.imageUrl)}" style="max-height:260px;margin-top:12px;border-radius:14px">` : ""}
    ${opts.length
        ? `<div class="q-options">${opts
            .map((o, i) => `<div class="q-option"><span class="letter">${String.fromCharCode(65 + i)}</span><span>${esc(o)}</span></div>`)
            .join("")}</div>`
        : `<div class="helptext" style="margin-top:20px">開放題：用手機輸入答案</div>`}
    <div class="q-meta"><div class="answered" data-answered="1">已答 ${q.answeredCount}/${q.eligibleCount}</div></div>
    ${scoreBar(v)}
  </div>`;
}
function tallyHtml(v) {
    const t = v.tally;
    if (!t)
        return placeholder(v, "答案分佈", "等主持喺主持台開投票／收卷…");
    const correct = v.stage.mode === "tally" ? undefined : undefined;
    void correct;
    return `
  <div class="stage-main">
    <div class="stage-mode-title">答案分佈（未公佈正解）</div>
    <div class="q-prompt tally-prompt">${esc(t.prompt)}</div>
    <div class="tally-grid">${(t.options ?? [])
        .map((o, i) => {
        const n = t.counts?.[i] ?? 0;
        const voters = (t.voters ?? []).filter((vv) => vv.choice === i);
        // v0.3.3：頭像下面要出人名（以前淨係得個圓圈，主持／觀眾認唔到邊個）
        return `<div class="tally-col"><h4>${String.fromCharCode(65 + i)}．${esc(o)}</h4><div class="n">${n} 票</div><div class="tally-avatars">${voters
            .map((vv) => `<span class="tally-voter">${avatarHtml(vv.avatar, 46)}<span class="tally-name">${esc(vv.name)}</span></span>`)
            .join("")}</div></div>`;
    })
        .join("")}</div>
    ${(t.answers ?? []).length ? `<div class="tally-answers">${(t.answers ?? [])
        .map((a) => `<div class="tally-answer">${avatarHtml(a.avatar, 40)}<span class="tally-answer-name">${esc(a.name)}</span><span class="tally-answer-val">${esc(String(a.text ?? ""))}</span></div>`)
        .join("")}</div>` : ""}
    <div class="q-meta"><div class="answered">${(v.tally?.options ?? []).length ? "已開票" : "已投"} ${t.answerCount}/${t.eligibleCount}</div></div>
    ${v.saboteurInfo?.eliminated?.length ? `<div class="helptext" style="margin-top:12px">已淘汰：${v.saboteurInfo.eliminated.map((p) => `#${p.number} ${esc(p.name)}`).join("、")}</div>` : ""}
    ${scoreBar(v)}
  </div>`;
}
function revealHtml(v) {
    const songTitle = v.stage?.payload?.songTitle;
    if (songTitle) {
        return `<div class="stage-main" style="align-items:center;justify-content:center;text-align:center"><div class="stage-mode-title">歌名揭曉</div><div class="song-big">${esc(songTitle)}</div><div class="song-sub">主持會俾分</div>${scoreBar(v)}</div>`;
    }
    const r = v.reveal;
    if (!r)
        return placeholder(v, "揭曉", "等主持喺主持台揭曉答案…");
    const opts = r.options ?? [];
    // v0.3.3：長題目（Q4／Q8／Q10）＋長解釋要喺 1080p 一屏放得落 →
    // 正解放大一嚿，其餘選項壓成一行，解釋放最後並限制行數。
    const correct = typeof r.correct === "number" ? r.correct : -1;
    const correctText = correct >= 0 ? opts[correct] : undefined;
    const others = opts.map((o, i) => ({ o, i })).filter((x) => x.i !== correct);
    return `
  <div class="stage-main reveal-main">
    <div class="stage-mode-title">揭曉</div>
    <div class="reveal-prompt">${esc(r.prompt)}</div>
    ${correctText !== undefined
        ? `<div class="reveal-answer"><span class="letter">${String.fromCharCode(65 + correct)}</span><span class="reveal-answer-text">${esc(correctText)}</span>${r.counts ? `<span class="reveal-count">${r.counts[correct] ?? 0} 票</span>` : ""}</div>`
        : ``}
    ${others.length
        ? `<div class="reveal-rest">${others
            .map((x) => `<div class="reveal-rest-row"><span class="reveal-rest-letter">${String.fromCharCode(65 + x.i)}</span><span class="reveal-rest-text">${esc(x.o)}</span>${r.counts ? `<span class="reveal-rest-count">${r.counts[x.i] ?? 0}</span>` : ""}</div>`)
            .join("")}</div>`
        : !correctText
            ? `<div class="explain">參考答案：${esc(r.referenceAnswer ?? r.actualAnswer ?? "（主持揭曉）")}</div>`
            : ``}
    ${r.explanation ? `<div class="reveal-explain">${esc(r.explanation)}</div>` : ""}
    ${r.actualAnswer !== undefined && r.referenceAnswer === undefined && !correctText ? `<div class="explain">正確答案：${esc(r.actualAnswer)}</div>` : ""}
    ${scoreBar(v)}
  </div>`;
}
function worksGrid(works, counts) {
    return `<div class="works-grid">${works
        .map((w, i) => {
        const c = counts ? counts[i] ?? 0 : null;
        return `<div class="work"><img src="${esc(w.imageUrl)}" alt="${esc(w.authorName)}"><div class="cap"><span>#${w.authorNumber} ${esc(w.authorName)}</span>${c === null ? "" : `<span class="votes">${c} 票</span>`}</div></div>`;
    })
        .join("")}</div>`;
}
function undercoverHtml(v) {
    const u = v.undercover;
    if (!u) {
        return `<div class="stage-main stage-idle"><div class="stage-mode-title">臥底投票</div><div class="stage-sub">等主持開始…</div>${scoreBar(v)}</div>`;
    }
    const m = v.undercoverMatch;
    const matchLine = m
        ? `<div class="stage-sub">第 ${m.matchNo} 局・第 ${m.questionNo}／${m.totalQuestions} 題・仲有 ${m.remainingUndercover} 個臥底未出局</div>`
        : "";
    if (u.phase === "voting") {
        return `<div class="stage-main" style="align-items:center;justify-content:center;text-align:center">
      <div class="stage-mode-title">請投出你心目中嘅臥底</div>
      ${matchLine}
      <div class="countdown" data-countdown="1">--</div>
      <div class="stage-sub">已投 ${u.answeredCount}／${u.eligibleCount}</div>
    </div>`;
    }
    const max = Math.max(1, ...u.candidates.map((c) => c.count));
    const topCount = Math.max(0, ...u.candidates.map((c) => c.count));
    const topN = u.candidates.filter((c) => topCount > 0 && c.count === topCount).length;
    return `<div class="stage-main">
    <div class="stage-mode-title">投票結果</div>
    ${matchLine}
    <div class="uc-cands">${u.candidates
        .map((c) => {
        const top = topCount > 0 && c.count === topCount;
        return `<div class="uc-cand"><span class="uc-name">#${c.number} ${esc(c.name)}${top ? ` <span class="badge hot">👑 最高票${topN > 1 ? "（同票）" : ""}</span>` : ""}</span>
          <span class="uc-bar"><i style="width:${Math.round((c.count / max) * 100)}%"></i></span><b class="uc-count">${c.count}</b></div>`;
    })
        .join("")}</div>
    <div class="uc-ballots">${u.ballots
        .map((b) => `<div class="uc-ballot"><span>#${b.voterNumber} ${esc(b.voterName)}</span><span class="muted">→</span><b>${esc(b.targetName)}</b></div>`)
        .join("")}</div>
    ${scoreBar(v)}
  </div>`;
}
function voteHtml(v) {
    const vote = v.vote;
    // A2：冇開 round 就出佔位（以前 vote.options 直接 TypeError，成個大mon 凍結）
    if (!vote)
        return placeholder(v, "投票", "等主持喺主持台開投票…");
    const works = v.drawWall?.works ?? [];
    if (works.length) {
        return `<div class="stage-main"><div class="stage-mode-title">投票：邊張最似（${vote.answeredCount}/${vote.eligibleCount}）</div>
    <div class="q-prompt" style="font-size:48px">${esc(vote.prompt)}</div>${worksGrid(works, vote.counts)}${scoreBar(v)}</div>`;
    }
    if (!(vote.options ?? []).length) {
        return `<div class="stage-main" style="align-items:center;justify-content:center;text-align:center"><div class="stage-mode-title">投票中</div>
    <div class="q-prompt" style="font-size:64px">${esc(vote.prompt)}</div>
    <div class="answered" style="margin-top:24px">已投 ${vote.answeredCount}/${vote.eligibleCount}</div>
    <div class="helptext">${v.saboteurInfo?.eliminated?.length ? `已淘汰：${v.saboteurInfo.eliminated.map((p) => `#${p.number} ${esc(p.name)}`).join("、")}` : "開票前只顯示進度，唔會出任何個人票"}</div>${scoreBar(v)}</div>`;
    }
    return `<div class="stage-main"><div class="stage-mode-title">投票中（${vote.answeredCount}/${vote.eligibleCount}）</div>
  <div class="q-prompt" style="font-size:52px">${esc(vote.prompt)}</div>
  <div class="q-options">${(vote.options ?? [])
        .map((o, i) => `<div class="q-option"><span class="letter">${i + 1}</span><span>${esc(o.label)}</span></div>`)
        .join("")}</div>
  <div class="helptext">開票前只顯示進度，唔會出個人票</div>${scoreBar(v)}</div>`;
}
function bidHtml(v) {
    const b = v.bid;
    if (!b)
        return placeholder(v, "競投中", "等主持喺主持台開競投…");
    const ranking = b.ranking ?? [];
    if (ranking.length) {
        // 公佈競投結果：最少秒數排第一；而家由邊個聽
        const rows = ranking
            .map((r, i) => `<div class="uc-cand ${r.current ? "current" : ""}">
          <span class="uc-name">${i + 1}. #${r.number} ${esc(r.name)}${r.tried ? "（試過）" : ""}</span>
          <span class="uc-bar"><i style="width:${Math.max(6, 100 - (r.seconds / Math.max(1, b.maxBid)) * 100)}%"></i></span>
          <b class="uc-count">${r.seconds} 秒</b></div>`)
            .join("");
        const now = b.currentName
            ? `<div class="bid-winner">而家由 <b style="color:var(--accent)">${esc(b.currentName)}</b> 聽歌（${b.currentSeconds} 秒）</div>`
            : `<div class="bid-winner">${b.settled ? "本首已完結" : "等主持開始"}</div>`;
        return `<div class="stage-main">
      <div class="stage-mode-title">競投結果（最少秒數先聽）</div>
      <div class="q-prompt" style="font-size:44px">${esc(b.prompt)}</div>
      ${now}
      <div class="uc-cands" style="width:100%">${rows}</div>
      <div class="helptext">仲有 ${b.remaining} 人未試；播歌位置由主持自己控制（唔經系統）</div>
      ${scoreBar(v)}
    </div>`;
    }
    // 競投中：密封（唔顯示個別秒數）
    return `
    <div class="stage-main" style="align-items:center;justify-content:center;text-align:center">
      <div class="row" style="justify-content:space-between;width:100%"><div class="stage-mode-title">競投中・最多 ${b.maxBid} 秒</div>
      <div class="countdown" data-countdown="1">--</div></div>
      <div class="q-prompt" style="font-size:56px">${esc(b.prompt)}</div>
      <div class="bid-winner" style="margin-top:30px">已競投 <b style="color:var(--accent)">${b.bidCount}</b> / ${b.eligibleCount} 人</div>
      <div class="helptext">${b.closed ? "競投已完，等主持公佈排名" : "撳落去嗰刻剩幾秒＝你嘅聽歌時間；最少秒數先聽（同秒最後撳先）"}</div>
      ${scoreBar(v)}
    </div>`;
}
function songHtml(v) {
    const s = v.song;
    if (!s)
        return placeholder(v, "聽歌", "等主持喺主持台開始播歌…");
    return `
  <div class="stage-main" style="align-items:center;justify-content:center;text-align:center">
    <div class="stage-mode-title">聽歌・第 ${s.songIndex}／${s.totalSongs} 首</div>
    <div class="song-big">${s.title ? esc(s.title) : "🎵 聽緊…"}</div>
    <div class="song-sub">${s.state === "playing" ? "播放中（由 media deck 出聲，大mon 靜音）" : s.state === "paused" ? "暫停" : "等音源 ready"}</div>
    ${scoreBar(v)}
  </div>`;
}
function roleRevealHtml(v) {
    const r = v.roleReveal;
    if (!r)
        return placeholder(v, "身份揭曉", "等主持喺主持台揭曉身份…");
    return `
  <div class="stage-main" style="align-items:center;justify-content:center;text-align:center">
    <div class="stage-mode-title">身份揭曉</div>
    <div class="role-big">${r.saboteurName ? esc(r.saboteurName) : "？"}</div>
    <div class="role-sub">${r.caught ? "搗蛋鬼被揪中！" : "搗蛋鬼潛伏成功！"}</div>
    <div class="tally-grid" style="width:80%">${(r.votes ?? [])
        .slice(0, 8)
        .map((x) => `<div class="tally-col"><h4>${esc(x.name)}</h4><div class="n">${x.count} 票</div></div>`)
        .join("")}</div>
    ${scoreBar(v)}
  </div>`;
}
/** v0.3.0 message mode：大字（好人題目／淘汰中唔中／勝負） */
function messageHtml(v) {
    const m = v.message ?? { lines: [] };
    const lines = m.lines ?? [];
    const tone = m.tone === "good" ? "var(--green)" : m.tone === "bad" ? "var(--red)" : "var(--accent)";
    const body = lines.length
        ? lines
            .map((l, i) => `<div style="font-size:${i === 0 ? 76 : 46}px;font-weight:800;line-height:1.25;color:${i === 0 ? tone : "var(--ink)"}">${esc(l)}</div>`)
            .join("")
        : `<div class="helptext">等主持…</div>`;
    return `<div class="stage-main" style="align-items:center;justify-content:center;text-align:center">
    ${m.title ? `<div class="stage-mode-title">${esc(m.title)}</div>` : ""}
    ${body}
    ${scoreBar(v)}
  </div>`;
}
/** v0.3.0 game-scores：每個 game 每個人幾多分（Excel 第 68 行） */
function gameScoresHtml(v) {
    const g = v.gameScores;
    if (!g)
        return `<div class="stage-main stage-idle"><div class="stage-mode-title">各 game 結算</div>${scoreBar(v)}</div>`;
    const head = `<tr><th>#</th><th class="gs-name">玩家</th>${g.games
        .map((x) => `<th>${esc(x.title)}</th>`)
        .join("")}<th>其他調整</th><th>總分</th></tr>`;
    const rows = (g.rows ?? [])
        .map((r) => `<tr><td>${r.number}</td><td class="gs-name">${esc(r.name)}</td>${(r.scores ?? [])
        .map((x) => `<td>${x}</td>`)
        .join("")}<td>${r.other}</td><td><b>${r.total}</b></td></tr>`)
        .join("");
    // FIX-2：人多（26 人）都唔可以 cut：超出可視高度就 scroll，表頭 sticky
    return `<div class="stage-main"><div class="stage-mode-title">各 game 結算</div>
    <div class="gs-wrap"><table class="gs-table"><thead>${head}</thead><tbody>${rows}</tbody></table></div>
    ${scoreBar(v)}
  </div>`;
}
function finalHtml(v) {
    const f = v.finale;
    if (!f)
        return placeholder(v, "結算", "等主持喺主持台撳「去結算」…");
    const stats = f.stats ?? {};
    const awardRows = (f.awards ?? [])
        .map((a) => {
        const medal = a.id === "grand" ? "🥇 最高分獎" : a.id === "second" ? "🥈 中庸之道獎" : "🥉 多謝參與獎";
        return `<div class="award-slot ${a.revealed ? "revealed" : ""}"><span class="medal">${medal}</span><span>${a.revealed && a.name ? esc(a.name) + `　<b style="color:var(--accent)">${a.score ?? ""}</b>` : "?"}</span></div>`;
    })
        .join("");
    return `
  <div class="stage-main">
    <div class="stage-mode-title">${v.stage.mode === "award" ? "頒獎" : "結算"}</div>
    <div class="finale-grid">
      ${scoreRowsHtml(f.entries ?? [], 48)}
      <div>
        <div class="card-box" style="font-size:30px;line-height:1.6">
          <div>總分 <b style="color:var(--accent)">${stats.total}</b></div>
          <div>平均 <b>${(stats.avg ?? 0).toFixed(1)}</b>・中位數 <b>${stats.median}</b></div>
          <div>人數 <b>${stats.count}</b></div>
        </div>
        <div class="award-box" style="margin-top:16px">${awardRows}</div>
      </div>
    </div>
    ${scoreBar(v)}
  </div>`;
}
/**
 * A2 最後防線：render 出錯都唔可以令大mon 永遠停留喺舊 frame。
 * catch 到就出「大mon 出錯」＋保留分數條（黑屏除外，唔可以自己漏光）。
 */
function errorHtml(v) {
    return `<div class="stage-main stage-idle">
    <div class="stage-mode-title">大mon 出錯</div>
    <div class="stage-sub">呢一版畫面砌唔到，等主持撳「大mon 返 QR／入場頁」</div>
    <div class="helptext">如果一直係咁，refresh 大mon 一次</div>
    ${v ? scoreBar(v) : ""}
  </div>`;
}
function render() {
    const root = el("#stage-root");
    if (!root)
        return;
    const v = view;
    // 黑屏要真係全黑：連分數條／toast 都收埋（CSS 用 body.is-blackout 攔截）
    document.body.classList.toggle("is-blackout", v?.stage?.mode === "blackout");
    let html;
    try {
        html = stageHtml(v);
    }
    catch (err) {
        console.warn("[stage] render 失敗，改顯示錯誤提示", err);
        html = v?.stage?.mode === "blackout" ? `<div class="blackout"></div>` : errorHtml(v);
    }
    // 黑屏要真全黑：斷線 banner 都唔可以浮喺黑色 overlay 上面（非黑屏照舊顯示）
    root.innerHTML = html + (v?.stage?.mode === "blackout" ? "" : connBanner(status, v));
    updateTimers();
}
function stageHtml(v) {
    let html = "";
    if (!v) {
        html = `<div class="stage-main stage-idle"><div class="stage-logo">連線中…</div></div>`;
    }
    else if (v.stage?.mode === "blackout") {
        // 黑屏分支唔可以有任何 ticker／分數（連文字都唔要，畫面要真係黑）
        html = `<div class="blackout"></div>`;
    }
    else {
        const mode = v.stage?.mode ?? "idle";
        switch (mode) {
            case "idle":
                html = idleHtml(v);
                break;
            case "rules":
                html = rulesHtml(v);
                break;
            case "scoreboard":
            case "leaderboard":
                html = boardHtml(v);
                break;
            case "question":
                html = questionHtml(v);
                break;
            case "tally":
                html = tallyHtml(v);
                break;
            case "reveal":
                html = revealHtml(v);
                break;
            case "vote":
                html = voteHtml(v);
                break;
            case "undercover":
                html = undercoverHtml(v);
                break;
            case "draw-wall": {
                const works = v.drawWall?.works ?? [];
                html = `<div class="stage-main"><div class="stage-mode-title">作品牆（${works.length} 張）</div>${works.length ? worksGrid(works, works.map((w) => w.votes ?? 0)) : `<div class="helptext">等主持上載作品…</div>`}${scoreBar(v)}</div>`;
                break;
            }
            case "draw-focus": {
                const focusId = v.drawWall?.focusId ?? null;
                const work = (v.drawWall?.works ?? []).find((w) => w.id === focusId) ?? (v.drawWall?.works ?? [])[0];
                html = `<div class="stage-main" style="align-items:center"><div class="stage-mode-title">作品放大</div>${work ? `<img class="rb-img" style="max-height:640px" src="${esc(work.imageUrl)}"><div class="q-prompt" style="font-size:44px">#${work.authorNumber} ${esc(work.authorName)}</div>` : `<div class="helptext">等主持喺主持台揀作品…</div>`}${scoreBar(v)}</div>`;
                break;
            }
            case "bid":
                html = bidHtml(v);
                break;
            case "song":
                html = songHtml(v);
                break;
            case "role-reveal":
                html = roleRevealHtml(v);
                break;
            case "message":
                html = messageHtml(v);
                break;
            case "game-scores":
                html = gameScoresHtml(v);
                break;
            case "finale":
            case "award":
                html = finalHtml(v);
                break;
            case "timer":
                html = `<div class="stage-main" style="align-items:center;justify-content:center"><div class="stage-mode-title">計時</div><div class="countdown" data-countdown="1">--</div>${scoreBar(v)}</div>`;
                break;
            default:
                html = idleHtml(v);
        }
    }
    return html;
}
/** 100ms interval 同 render 都經呢個 guard：timer 只係裝飾，唔可以拋砲炸死成個大mon */
function updateTimers() {
    try {
        paintTimers();
    }
    catch (err) {
        console.warn("[stage] updateTimers 失敗", err);
    }
}
function paintTimers() {
    if (!view)
        return;
    const endsAt = view.question?.endsAt ?? view.bid?.endsAt ?? view.undercover?.endsAt ?? null;
    const left = live?.msLeft(endsAt) ?? null;
    for (const node of document.querySelectorAll("[data-countdown]")) {
        node.textContent = left === null ? "—" : fmtClock(left);
        // 最後 5 秒：用 class 轉紅色 pill（白字），唔好喺藍底上用紅字
        node.classList.toggle("is-urgent", left !== null && left <= 5000);
        node.style.color = "";
    }
    const answeredNode = document.querySelector("[data-answered]");
    if (answeredNode) {
        const q = view.question;
        const t = view.tally;
        const n = q?.answeredCount ?? t?.answerCount;
        const tot = q?.eligibleCount ?? t?.eligibleCount;
        if (n !== undefined)
            answeredNode.textContent = `已答 ${n}/${tot}`;
    }
    paintToast(view.toast, view.toastId);
}
/**
 * 100ms tick 都會行到：同一個 toast 唔可以每次都重設 timer，否則永遠唔會收（codex 第五輪 #3）。
 * v0.3.1：改用 activity id 去重——文字一樣但係新事件（例如連撳兩次同一個掣）都要彈；
 * 文字唔同但係同一條 activity 就唔應該重彈。
 */
let lastToastId = "";
function paintToast(text, id) {
    const t = (text ?? "").trim();
    const key = id ?? t;
    if (!t)
        return;
    if (key === lastToastId)
        return;
    lastToastId = key;
    showToast(t, 2600); // 大mon：2.6 秒自動收，唔會長遮分數條
}
function setStatus(s) {
    status = s;
    render();
}
async function boot() {
    const root = el("#stage-root");
    if (root)
        root.innerHTML = `<div class="stage-main stage-idle"><div class="stage-logo">連線中…</div></div>`;
    let code = new URLSearchParams(location.search).get("code") ?? "";
    if (!code) {
        try {
            const ready = await api("/api/ready");
            code = ready?.roomCode ?? "";
        }
        catch {
            /* ignore */
        }
    }
    live = new Live({
        role: "stage",
        code,
        onView: (v) => {
            view = v;
            render();
        },
        onStatus: (s) => {
            setStatus(s);
            if (s === "connected")
                armStableClear();
            else
                disarmStableClear();
        },
        onError: (c, m) => showToast(`${c}: ${m}`),
        onEvicted: () => {
            disarmStableClear();
            showToast("已被另一個大mon 接管");
            const root = document.querySelector("#stage-root");
            if (root) {
                const prev = Number(sessionStorage.getItem("hbd.evictedAt") ?? "0");
                const recent = prev > 0 && Date.now() - prev < 60000;
                sessionStorage.setItem("hbd.evictedAt", String(Date.now()));
                if (recent) {
                    root.innerHTML = `<div class="stage-main stage-idle"><div class="stage-logo">已被另一個大mon 接管</div><div class="stage-sub">短時間內重複被接管，已停止自動重新載入，以免多個大mon 互踢。</div><button id="evict-reload" class="btn">立即重新連線</button></div>`;
                }
                else {
                    root.innerHTML = `<div class="stage-main stage-idle"><div class="stage-logo">已被另一個大mon 接管</div><div class="stage-sub"><span id="evict-count">5</span> 秒後自動重新載入（復原靠 reload，避免互踢）</div><button id="evict-reload" class="btn">立即重新連線</button></div>`;
                    let remain = 5;
                    const h = window.setInterval(() => {
                        remain -= 1;
                        const c = document.querySelector("#evict-count");
                        if (c)
                            c.textContent = String(Math.max(0, remain));
                        if (remain <= 0) {
                            window.clearInterval(h);
                            location.reload();
                        }
                    }, 1000);
                }
                document.querySelector("#evict-reload")?.addEventListener("click", () => location.reload());
            }
        },
    });
    live.connect();
    if (timer)
        window.clearInterval(timer);
    timer = window.setInterval(updateTimers, 100);
}
void boot();
