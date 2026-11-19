# Changelog

## v0.3.0 — 2026-11-19

> 對齊壽星 Excel 完整流程（`design/26party.xlsx`，第 8–72 行）。四個遊戲由
> 「拍賣估歌／畫畫猜人／搗蛋鬼／問答」改成「**一圖多人畫畫猜**／**拍賣時間估歌**／
> **笨蛋殺手**／**問答環節**」。

### Added — 一圖多人（畫畫臥底）完整局狀態機
- 9 個 host command：`uc.match.start`（抽 2 個臥底＋3 對題、可重抽）／`uc.prompt.reveal`
  （好人題上大mon）／`uc.vote.start`（10 秒）／`uc.eliminate`（大mon 即講中／唔中）／
  `uc.eliminate.undo`／`uc.match.next`／`uc.match.settle`（**冪等**）／`uc.match.reset`。
- 計分：好人勝 → 全部好人 +1；臥底勝 → 全部臥底 +1；未出局者每人再 +2（疊加）。
- 步驟約束：每題要「已收卷 + 本題未 foul 過」才准淘汰；本題未 foul 唔准下一題；
  第 3 題完成後才准結算（防止連撳偷步）。
- 主持台顯示 3 對題目（好人題＋臥底關鍵詞）、現時第幾題、仲有幾個臥底、出局名單。
- 臥底身份／臥底題**只喺主持台**，唔會漏去大mon／手機 DTO。

### Added — 笨蛋殺手
- `killer.assign`／`killer.redraw`／`killer.clear`：抽 1 老闆＋1 殺手（可重抽），
  **只送主持台**；加分帶 `gameId:"killer"`，計入分項結算。

### Changed — 拍賣時間估歌（方向倒轉）
- 由「最高價密封出價」改成**最少秒數先聽；同秒由最後提交者先**（用持久提交順序判）。
- 手機改一個大掣「競投（X 秒）」，撳落去＝當時剩餘秒數（最少 1 秒，0 秒唔准投）。
- **公佈同判分分開**：`bid.publish`（出完整排名）→ `bid.judge`（答對 +1 / 答錯去下一位）
  → `bid.finish`（本首完結，收成終態令下一首開得）。
- 6 張拍賣卡 bootstrap 預先建好，控制頁有齊競投面板（唔使入「進階」）。

### Changed — 總結算同頒獎
- 新大mon 畫面「分項結算」：一圖多人／拍賣估歌／笨蛋殺手／問答／其他調整／總分。
- 「中庸之道獎」由**中位數**改**平均數**（Excel 定義），文案同步。
- 三獎改名：最高分獎／中庸之道獎／多謝參與獎。

### Added — 題庫內容
- 13 條新問答題（`seed/quiz.seed.json`，逐字）：Q1–Q11 MC、Q12/Q13 數字開放題，
  全部 30 秒；Q12 支援容差 ±2 尺（`tolerance`）、Q13 主持即場輸入（容差 0）。
- 7 對一圖多人題目（`seed/undercover.seed.json`：好人題＋臥底關鍵詞）。
- 四頁規則重寫（一圖多人／拍賣／笨蛋殺手／問答）。

### Fixed
- 主持台「分佈／揭曉」以前只換畫面唔收卷；新增真流程掣（先 close 再 tally/reveal）。
- 重複「公佈排名」會重置判分 → 同一首歌派兩次分（已鎖）。
- 同一毫秒提交，「最後提交」判錯人（改用持久提交順序）。
- 主持儲存 Q12/Q13 會刪走 `tolerance`（已保留）。
- 排行榜／開始畫面以前只出 12 人（改自動分欄＋可捲動）。
- 到期後仍收提交（WS 層直接驗 `endsAt` 同剩餘秒數）。
- 部署陷阱：`sync-seed.mjs` 喺冇 `data/` 時會爆（乾淨 clone 建唔到）；已 fallback 用 repo `seed/`。

### Changed — 主持台
- 主 tab 收斂到 5 個（控制／玩家／分數／題庫／頒獎），其餘收喺「進階」（function 全留）。
- rundown 預設 4 關：一圖多人 → 拍賣估歌 → 笨蛋殺手 → 問答。

### Tests
- `npm test`：57 → **112**（+55）。全部綠燈。

### 已知未做
- Q4 參考圖 `imageUrl` 留空（原檔未取得）。
- 笨蛋殺手冇子彈／擊殺狀態機（紙本執行，系統只抽身份＋加分）。
- 舊 journal 唔會自動升級題庫（部署時會開新 data volume）。

## v0.2.2 — 2026-11-19

### Changed — LINE Seed 字體（主持台＋手機）
- 主持台 `/host`、手機 `/play` 改用 **LINE Seed TW**（Rg 400＋Bd 700，WOFF2）。
- 揀 TW 唔用 JP：JP 版覆蓋唔到本專案 61 個用字（你／佢／冇／嘅／喺／啲／咗…），TW 版只缺 10 個粵字（吓咗哋啱啲喺嗰嘅嚟脷），用系統字 fallback 補。
- 大mon 繼續用思緒重生體；landing 繼續系統字。
- 前端資產版本 `?v=20261119p5`。


## v0.2.1 — 2026-11-19

### Changed
- **遊戲改名**為《關於我初試策劃**圍威喂**這檔事》：大mon 標題、手機頁首、四頁 `<title>`（landing／大mon／主持台／手機）、PWA manifest `name`／`short_name`。
- **分數條**：玩家名用墨黑、分數改用 primary 藍＋細分隔線，唔會再讀成「名＋數」一串。
- 前端資產版本 `?v=20261119p4`。


## v0.2.0 — 2026-11-19

### Changed — 視覺大改（Doubao 淺色 ＋ 大字體）
- **全站配色改跟 Doubao 淺色版**：冷調淺底 `#f7f9fc`、白卡、`#e7eaef` hairline、單一 primary 藍 `#0065fd`；取消彩色漸變／grain／大部分陰影，改用 border 分層；圓角 12/18/24。
- **掣改 pill**；主持台 tabbar 選中＝黑 pill 白字；mode tiles 用淺藍 active（唔再成版實心藍）；列表動作降噪（`開`/`批准` 藍、`踢`/`刪` 白底紅字）。
- **大mon**：房碼＋QR 收埋一張紙卡（房碼黑卡白字）、頭像 squircle、分數板獎牌名次、分數條可換行、短畫面垂直置中（`safe center`）、規則頁字階收一級（1080p 一頁放得落）＋底部淡出 mask。
- **主持台**：卡片 flat（白底＋hairline、無陰影）；`階段／畫面／版本／流程／已批准／待批准／已完成／進行中` 全部中文；`Skip 呢關`→`跳過呢關`、`開始 playing`→`開始遊戲`、`回 Lobby`→`返大堂`、`去 Final`→`去結算`。
- **手機**：修正「入場後卡片冇左右 padding 貼邊」；頭像 8 欄（≤420px 7 欄）、色板 8 格圓角方塊、`.helptext` 26px→14px、disabled 主掣改淺底灰字。
- **Landing** 改成 hero＋四張入口卡。

### Added — 大mon 專用字體（思緒重生體）
- `public/fonts/reborn.woff2`（由購買版 `MMF-RebornFont-V1.2-Normal` OTF 轉 WOFF2，1.9MB→1.43MB），`font-display: swap`、只有 `/stage` preload。
- **只限大mon**：`body.stage` 用 `--font-reborn`；主持台／手機／landing 用系統字（之後再揀）。
- 字型 0–9 係哥德體（`0` 似方格），用 `unicode-range` 排除數字、fallback 系統字；大mon 數字用 tabular-nums。

### Fixed
- 大mon 倒數最後 5 秒：原本紅字藍底（睇唔到）→ 整粒紅色 pill 白字。
- Rundown `todo` 狀態顯示英文 → 未開始。
- `Rundown`／`approved`／`pending` 等殘留英文文案。

### Tests
- 57/57 pass。前端資產版本 `?v=20261119p3`。


## v0.1.6 — 2026-11-18

### Added — 畫畫關：臥底投票（紙本出題，手機投票）
- 主持台「臥底投票」面板：列出所有已批准玩家，主持可以 untick 已 foul 嘅人（佢哋唔會出現喺候選名單，但仍然可以投票）；可設定 5–60 秒（預設 10 秒）。
- 撳「開始臥底投票」→ 大mon 顯示「請投出你心目中嘅臥底」＋倒數＋已投人數；玩家手機會見到候選人（自己除外，頭像＋名）＋同一個倒數。
- 10 秒到自動開票（亦可「立即開票」）：大mon 顯示每位候選人得票 bar＋逐個玩家投咗邊個；主持台同步顯示結果，可「再開一輪」。
- 新 `undercover.start` / `undercover.reveal` command、`tickUndercover` 自動開票；結果完全由 round + submissions 推導（journal replay 一致）。
- 投票唔計分，純顯示。

### Changed
- 預設關卡次序改為「畫畫 → 估歌 → 搗蛋鬼 → 問答」（新房間）。
- 規則頁 tab 新增「關卡次序」：每關 ▲▼ 調次序＋「還原預設」掣，改完即刻套用（rundown 同步重排，標題會重新編號）。
- 大mon「畫畫」mode 群組新增「臥底投票」。
- 前端資產版本 `?v=20261118j`。

### Fixed（codex audit 揪出）
- host 收唔到 undercover 更新（HOST_SECTIONS 漏咗）、「再開一輪」無效、手動選 undercover mode 被拒、被踢玩家仍可投票、搗蛋鬼淘汰名單誤套用落臥底投票、generic 收卷／切分佈會令投票卡死、開始新投票會棄掉未完成回合、轉關殘留上一關結果、票數名單用今日 roster、deadline 後仍收票、重排後標題關數錯。

### Fixed（獨立 checker 覆核 nit）
- 每輪臥底投票卡而家會登記入當前 rundown item 嘅 cardIds（唔會再累積 orphan 卡）。
- rundown.reorder 會驗證 ids 必須完整、冇重複、冇未知 id（漏／重複一律 W_BAD_SCHEMA）。

### Known Issues
- 主持台規則頁頁碼 pill 喺預覽頁被 disable／delete 之後會顯示舊頁數（cosmetic）。
- `stage.rules{pageIndex}` API 一律由第 0 頁開始（UI 用 `stage.page` 翻頁）。
- 音源未做真 mp3 瀏覽器 E2E（repo media 係 stub）。

## v0.1.5 — 2026-11-18

### Changed — 主持台大mon 控制分組
- **估歌** 組改為：`競投`／`聽歌`／**`開估（揭曉歌名）`**（新掣，觸發 `media.reveal`，大mon 出「歌名揭曉」＋歌名；未播過歌時提示 `W_ALREADY_STATE`）。
- **結算** 由估歌組移去最底新組 **「結算／頒獎」**（連 `頒獎`）。
- **流程／畫面** 只剩 `Idle`／`規則頁`／`分數板`／`排行榜`。
- 前端資產版本 `?v=20261118i`。

## v0.1.4 — 2026-11-17

大mon 黑屏事故修復 ＋ 主持台「返 QR 頁」掣。

### Fixed — 大mon（用戶回報：一入去空白、只見上角分數）
- **黑屏（blackout）死胡同**：黑屏期間 server 拒絕所有 stage.set（W_STAGE_LOCKED），唯一出路係「恢復畫面」，主持唔知就永久空白。而家 stage.set 可以離開黑屏；stage.rules 仍保留鎖。
- **雙撳「黑屏」永久鎖死**：prevMode 會被寫成 blackout，之後「恢復畫面」仍然黑屏。新增 resumableMode()，blackout／rules 永遠唔可以做恢復目標。
- **黑屏疊規則頁後恢復變空白**：恢復會入 rules 但 payload 空。已一併修（fallback idle）。
- **黑屏中仍可經「規則頁」掣出假規則頁**（F1）：stage.set{mode:'rules'} 而家同 stage.rules 一致回 423。
- **規則頁 payload 唔齊**（F2）：抽出 rulesStagePayload() 兩條路徑共用，大mon 出真規則頁。
- **黑屏真全黑**：連 toast 同斷線 banner 都唔顯示（非黑屏照舊顯示斷線 banner）。
- 非黑屏撳「恢復畫面」改為 no-op（唔會亂跳 mode）。

### Added
- 主持台大mon 控制卡頂部新增 primary 掣：**「大mon 返 QR／入場頁」**（黑屏中顯示「（離開黑屏）」），任何 phase 都撳得，係逃生門。

### Fixed — 規則頁預覽（audit 發現，v0.1.3 之前已存在）
- resolveRulePage() 由 currentItem 猜頁 → 改為優先讀 stage.payload.rulePageId；主持揀 B 頁預覽，大mon 就出 B 頁（之前出 A 頁或「主持未設定呢關規則」）。disabled／archived 頁安全 fallback。

### Changed
- 前端資產版本 ?v=20261117h。
- 測試 37 → 49（新增 blackout 逃生、雙撳黑屏、payload 一致、恢復 no-op、真全黑、規則頁預覽跨 game 等）。

### Known Issues
- 主持台規則頁頁碼 pill 喺預覽頁被 disable／delete 之後會顯示舊頁數（cosmetic，大mon 本身正確）。
- stage.rules{pageIndex} API 一律由第 0 頁開始（UI 翻頁用 stage.page，唔會踩到）。
- 音源未做真 mp3 瀏覽器 E2E（repo media 係 stub）。

## v0.1.3 — 2026-11-17

派對前修復版：主持台控制、大mon 穩定度、音源、以及 codex（gpt-6.1-sol）多輪 audit 揪出嘅 server/client bug。

### Fixed — 主持台（你回報）
- **所有控制掣撳完冇反應**：`handleAct()` 用 `split(":")` 解析，但 action 係 `room.start`／`stage.mode:x`／`player.kick:<id>` 呢類 dotted 格式，成個 switch 永遠撞唔中。已重寫 dispatcher，全部 data-act（105 處）逐一對照 server command 覆蓋。
- 每次 render 重複綁 click listener（一撳掣發 N 次命令）→ 改為只綁一次。
- 玩家名單仍然顯示已踢玩家 → 主名單隱藏，收埋喺「已踢 N」摺疊區，可還原。
- 表單輸入被 patch 清空 → render 前後保留 dirty／聚焦欄位。
- dirty 清理範圍過闊（儲存一題清走其他題嘅未儲存編輯）→ 改為只清對應 record。

### Fixed — 大mon（你回報）
- 被新連線接管（4010）後永久卡住 → 5 秒倒數自動 reload＋「立即重新連線」掣。
- ≥3 個大mon 分頁互踢輪迴 → 60 秒 stable 視窗才清 evicted flag。
- **畫面永久凍結**：`common.ts` 讀 `op.value` 但 protocol 送 `{op:"view", view}` → `view` 變 undefined，之後所有 patch 靜靜丟棄。已修＋壞 payload 會 resync。
- mode 缺資料時 render 拋錯留舊畫面 → 顯示「等待主持…」等待畫面。
- toast 每 100ms 重設計時器 → 只在文字變更時顯示。

### Fixed — 音源／計分／搗蛋鬼（codex audit）
- 同一 browser 兩個 host window 同時出聲 → deck ID 改為每個 document 全新生成。
- 已 buffer 歌曲 replay/resume 卡 preparing → readyState 夠即場 ACK；resume 刷新 readyDeadline。
- 過期 lease 造成 render 無限遞迴（RangeError）→ ownership predicate 加 leaseUntil 檢查。
- `draw.judge` 接受非畫畫投票卡／非卡內作品 → 兩邊都加 type＋membership 檢查；空 `cardId` 唔再送。
- `judge.actual` 空輸入變 0 → 先驗空字串。
- `score.judge` 接受其他 round 嘅 submission → 加 roundId 檢查；分數驗證補 ±1000 同非 0。
- 搗蛋鬼：auto-close 繞過計票、retry 重複計輪、全體棄票唔結算、finish 後仲可以矛盾計分、generic reveal/reopen 繞過裁決 → 統一 `tallySaboteurRound`＋`saboteurAwardsLatentOnce`，generic 入口全部擋。

### Changed
- 前端資產版本 `?v=20261117g`（避免舊 cache 一直行舊 JS）。
- 測試：9 → 37（新增覆蓋上面大部分修復，含可執行邏輯測試）。

### Known Issues
- 音源未做真 mp3 瀏覽器 E2E（repo 內 media 係 stub 檔）。
- `rules.save` 撞 `W_RULES_CONFLICT` 時會清走該頁未存草稿（既有行為）。
- ticker 三個下拉選單嘅 dirty 記錄唔會被清（純顯示，無功能影響）。

## v0.1.1 — 2026-11-16

首個公開版本（派對遊戲平台）。

### Added
- 三端：大mon `/stage`（唯讀 kiosk）、主持台 `/host`（PIN login，可多開）、手機 `/play`（QR 入場）。
- 四關遊戲：拍賣估歌（密封出價＋media deck＋AudioLease）、畫畫猜人、搗蛋鬼（版本 A）、常識問答。
- 每關規則頁：大mon 入關自動顯示、後台可編輯（`W_RULES_LIMIT`／`W_RULES_CONFLICT`）。
- 計分事件帳簿＋undo（void，不刪紀錄）＋換組＋頒獎三獎＋`/api/host/export`（CSV＋room.json）。
- JSONL journal（manifest＋segment＋sha256＋fsync＋壞尾行 truncate＋replay），重啟／kill -9 分數不失。
- WS 自動重連＋resync、clock offset（RTT）、commandId 冪等、reconnect race、5 種連線名額。
- Docker multi-stage（node:26-alpine）＋ docker compose（30005:3000、volume、healthcheck）。
- 30 bots 驗收腳本（M0–M5）＋ fault injection／clock skew 測試。
- shadcn／iOS 風 UI；大mon 超過 2 條連線時自動踢走最舊（新連線優先，舊機收 4010 並提示）。

### Security
- PIN 必須由環境變數提供（缺／default 拒啟動），支援 6–12 位數字。
- 全站 CSP、host-only API 全部收入 `/api/host/*`、rate limit、Origin 檢查。
- 本 repo 不含任何真實 PIN／密碼／憑證。
