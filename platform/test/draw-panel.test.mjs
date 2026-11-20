/** Round 2（v0.4.3）source-guard：主持「畫畫（一圖多人）」主面板要補齊 G4——
 *  臥底身份（主持專用）／重抽臥底／開票後完整票數＋票軌／獨立「分數結算」。
 *  client 冇 DOM 測試環境，跟 unit.test.mjs 一樣用源碼證據鎖住位置同條件。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function clientSrc(name) {
  return fs.readFileSync(path.resolve("src/client", name), "utf8");
}

/** 由 startMark 去到之後第一個 endMark（唔包 endMark） */
function section(src, startMark, endMark) {
  const start = src.indexOf(startMark);
  assert.ok(start >= 0, `要有「${startMark}」`);
  const end = src.indexOf(endMark, start);
  assert.ok(end > start, `「${startMark}」之後要有「${endMark}」`);
  return src.slice(start, end);
}

const src = clientSrc("host.ts");
// BRIEF：由 `function drawFlowBlock` 到下一個 `\nfunction `
const drawFlow = section(src, "function drawFlowBlock", "\nfunction playersSection");

test("R2-1：drawFlowBlock 有身份 pills／重抽臥底／完整票數／獨立結算，①②③ 三步仲喺度", () => {
  for (const needle of [
    "臥底（主持專用）",
    "undercoverIds",
    'data-act="ucm.redraw"',
    'data-act="ucm.settle"',
    "最高票",
    "票",
    "① 揀題目",
    "② 公佈好人題目",
    "③ 開始投票",
  ]) {
    assert.ok(drawFlow.includes(needle), `drawFlowBlock 要包含「${needle}」`);
  }
  // 身份 pills 要用名（#號 名），唔係淨出 player id
  assert.match(drawFlow, /nameOf\(id\)/, "臥底身份要用 nameOf() 對名");
  // 票數表每行有「— n 票」，最高票要 highlight
  assert.match(drawFlow, /— <b>\$\{c\.count\} 票<\/b>/, "票數表每行要寫「— n 票」");
  assert.match(drawFlow, /👑 最高票/, "最高票要 pill／highlight");
  // 票軌：投票人 → 目標，太長收喺 details
  assert.match(drawFlow, /voterNumber[\s\S]{0,120}?→/, "票軌要寫「投票人 → 目標」");
  assert.match(drawFlow, /<details[^>]*><summary>票軌/, "票軌要收喺 <details>（唔好成版爆開）");
  // 投票中唔可以出票數（phase gate）
  assert.match(drawFlow, /u\?\.phase === "result"/, "票數只可以喺 phase=result 出");
});

test("R2-2：drawFlowBlock 唔准再混入作品牆／作品放大（舊功能留喺進階 details）", () => {
  for (const bad of ['data-act="stage.mode:draw-wall"', 'data-act="stage.mode:draw-focus"', "draw-focus", "作品牆"]) {
    assert.equal(drawFlow.includes(bad), false, `drawFlowBlock 唔應該有「${bad}」`);
  }
});

test("R2-3：重抽臥底 disabled 條件同 server 一致（未公佈／未投票／冇淘汰）", () => {
  assert.match(drawFlow, /st\.questionNo === 0/, "要限第 1 題");
  assert.match(drawFlow, /!st\.promptRevealed/, "未公佈題目先准");
  assert.match(drawFlow, /!st\.roundId/, "未開投票先准");
  assert.match(drawFlow, /eliminatedIds \?\? \[\]\)\.length === 0/, "冇淘汰先准");
  // 條件要真係綁住粒掣（唔係寫死 enabled）
  assert.match(drawFlow, /data-act="ucm\.redraw"\s+\$\{redrawReady \? "" : "disabled"\}/, "重抽掣要跟 redrawReady");
  // disabled 要有 title 講原因
  assert.match(drawFlow, /title="\$\{esc\(redrawTitle\)\}"/, "重抽掣要 title 講原因");
});

test("R2-4：分數結算 disabled 條件同 server／進階面板一致（questionNo >= 2＋questionDone）", () => {
  assert.match(drawFlow, /questionNo >= 2/, "第 3 題先准結算");
  assert.match(drawFlow, /questionDone/, "要計本題有冇 foul 過");
  assert.match(drawFlow, /remaining === 0 \|\| st\.result === "good"/, "兩臥底出局／已定 good 可以即結算");
  assert.match(drawFlow, /data-act="ucm\.settle" \$\{canSettle \? "" : "disabled"\}/, "結算掣要跟 canSettle");
  assert.match(drawFlow, /title="\$\{esc\(settleTitle\)\}"/, "結算掣要 title 講原因");
  // 唔准無條件 enabled（撳完必然 W_WRONG_PHASE）
  assert.equal(/data-act="ucm\.settle">/.test(drawFlow), false, "結算掣唔可以無條件開住");
});

test("R2-5：controlSection 唔再重複出 undercoverMatchPanel；drawSection 仍然有", () => {
  const control = section(src, "function controlSection", "\nfunction drawFlowBlock");
  assert.equal(/undercoverMatchPanel\(v\)/.test(control), false, "controlSection 唔准再呼叫 undercoverMatchPanel");
  const draw = section(src, "function drawSection", "\nfunction cardListSummary");
  assert.match(draw, /undercoverMatchPanel\(v\)/, "進階「畫畫」drawSection 要保留完整面板");
});

test("R2-6：底部 hint 老實描述，唔再寫「呢度就係全部」", () => {
  assert.equal(src.includes("呢度就係全部"), false, "全個 host.ts 都唔應該再有「呢度就係全部」");
  const hintAt = drawFlow.lastIndexOf('<div class="hint">');
  assert.ok(hintAt >= 0, "drawFlowBlock 要有底部 hint");
  const hint = drawFlow.slice(hintAt);
  assert.match(hint, /進階 → 畫畫/, "hint 要講清楚「進階 → 畫畫」仲有咩");
  assert.match(hint, /取消上一個淘汰/, "進階獨有嘅操作要寫明");
  assert.match(hint, /手動揀人/, "手動 foul 入口要寫明");
});
