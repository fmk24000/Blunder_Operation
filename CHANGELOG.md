# Changelog

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
