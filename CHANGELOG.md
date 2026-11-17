# Changelog

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
