<!-- llm-call-meta {"requested_model": "glm-5.3", "response_model": "glm-5.3", "finish_reason": "stop", "usage": {"prompt_tokens": 336825, "completion_tokens": 12627, "total_tokens": 349452, "prompt_tokens_details": {"cached_tokens": 183}, "completion_tokens_details": {"accepted_prediction_tokens": null, "reasoning_tokens": 9553, "rejected_prediction_tokens": null}, "cost": 0, "opencode": {"billing_source": "go", "list_cost": 0.52690518, "allowance": 2.10762072, "tokens": {"input": 336642, "output": 12627, "reasoning": 9553, "cache_read": 183, "cache_write_5m": 0, "cache_write_1h": 0}}}, "elapsed_sec": 109.1, "endpoint": "https://opencode.ai/inference/go/v1", "content_chars": 5130, "had_reasoning": true, "reasoning_effort": "low", "id": "chatcmpl-fcbd574f"} -->
## 結論
有條件收貨

## P0（唔可以收貨，必須先改）

（無）

## P1（實作前要改，但唔阻 milestone 收貨）

1. **[src/server/commands.ts `bid.settle` case] 同一 round 可以重複結算，冇防重機制** → 證據：`bots/m2.mjs` 第 175–190 行，同一 `round.id` 先後做 `correct:true`（winner +5）再 `correct:false, backup:true`（second +3），兩筆都入帳簿，server 冇拒絕第二次。實測 log（`M2/test-m2-local.log`）兩個 PASS 同時存在。真場如果主持撳錯再撳，會雙重派分。→ 要求：`bid.settle` 加「已結算」檢查（例如 round state 已非 `closed`／`tally` 時回 `W_ALREADY_STATE`），或者用 `expectedRoundId` 互斥。

2. **[src/server/views.ts `buildStageView` bid 段 + public/js/client/stage.js `bidHtml`] stage 喺 bid round 進行中顯示每筆出價金額** → 證據：`views.ts` 第 273 行 `bids: subs.map((s) => s.amount ?? 0)` 直接將所有 confirmed 出價金額放入 StageView；`stage.js` `bidHtml` 用 `<span>${amt}</span>` 逐筆顯示。§5.1 寫明「每人**密封**出價一次」——大mon 係全場睇得到嘅畫面，顯示金額即係公開出價，同「密封」矛盾。→ 要求：要麼 stage 只出 aggregate（已出價人數／最高價走勢，唔出個人金額），要麼 PLAN 明確改寫「密封」定義（見下面規格澄清）。目前實作同規格字面有衝突，需要拍板。

3. **[PLAN §10 M2 ④] 真瀏覽器 media deck 音訊同步（Mac 播 MP3 ↔ stage 畫面 ≤0.5s）未實測** → 證據：`M2/SUMMARY.md` §2 第 ④ 行自己承認「部分（server／協議過，真 browser 音訊未自動化）」。server 端 `playStartedAt`／`positionMs`／`deck.ready ACK` 機制已實測（14ms／42ms 轉 playing），但「Mac 實機播聲同大mon 畫面時間差 ≤0.5 秒」呢條量度冇做。→ 要求：排練前用真 Mac＋大mon 實測一次並記錄時間差；runbook 已列試播步驟，但驗收標準要求嘅「量度方法」仲未執行。

4. **[PLAN §10 M2 ⑦] Tunnel 下 WS 30 分鐘長連測試未做** → 證據：`M2/SUMMARY.md` §3 第 2 項明確列遺留。冇公開 hostname（D31 dashboard 權限），做唔到。→ 要求：上線 flip（Cloudflare Tunnel＋Access policy 設好後）補做 30 分鐘 WS 測試並記錄斷線次數／恢復時間。

5. **[src/server/commands.ts `media.play` case] 冇檢查 playback 是否已經 preparing 中** → 證據：`commands.ts` `media.play` 直接 `push(ctx, { t: "media.set", d: { playback } })` 覆寫現有 playback，唔理之前是否 preparing 另一首歌。快速連撳兩首會令 deck 收到混亂狀態。→ 要求：加 `W_ALREADY_STATE` 檢查（playback.state === "preparing" 時拒絕新 media.play，要先 stop）。

## P2（可以之後先改）

1. **[src/server/commands.ts `media.play` window 參數] `window: [start, end]` 冇 server 或 client 強制執行** → 證據：`commands.ts` 只記錄 `window` 落 playback state；`host.ts` `syncDeck` 冇按 window 停播。播 15 秒後音訊會繼續行，要主持手動 stop。→ 建議：deck client 加 window 到期自動 pause，或者 host UI 加倒數提示。

2. **[src/server/ws.ts `onDeckReady`] 冇驗證發送 deck.ready 嘅 host 係 lease 持有者本人** → 證據：`ws.ts` 只查 `lease.deckId !== msg.deckId`，唔查 `conn.hostId === lease.hostId`。理論上另一個 host 知道 deckId 就可以代發 ready ACK。→ 實際風險低（deckId 係本機隨機生成），但加一行檢查更穩陣。

3. **[bots/m2.mjs] 測試冇明確驗證「答對時其餘玩家分數不變」** → 證據：第一個 settle（correct=true）只查 winner event，冇 snapshot 對比其他 29 人分數。backup 測試有做 `changed.length === 1` 但係喺兩次 settle 之後。→ 建議：加一次 before/after 全場分數對比。

## 逐條核對 §10 驗收標準

| # | 驗收條文 | 實作／證據 | 判定 |
|---|---|---|---|
| ① | 30 bots 出價次序＋同價 tie-break（先交者贏）正確；maxBid 驗證拒超額 | `m2.mjs` 30 筆出價全 accepted；bids [90,90,80,...] 首位 90 提交者 wins；120>100 → `W_BAD_SCHEMA`。本機＋部署 15/15 PASS | 過 |
| ② | 結算逐筆對帳：得標者答對 +points、答錯 0、其餘冇變（跑一輪完整數字例） | winner +5 reason「估歌」；backup 次高 +3 ceil(5/2)；changed=1 人。但「答錯 0（冇 backup）」冇獨立測；「其餘冇變」喺 correct case 冇明確 snapshot 對比；同 round 雙重結算冇防（P1-1） | 有條件過（P1-1／P2-3 補） |
| ③ | 倒數各機誤差 ≤0.5s（注入延遲版本） | 沿用 `M0/clock-skew.log`：200ms 單向延遲、極差 101ms。機制（endsAt−serverNow）同 quiz 完全一樣，但測試用 quiz 卡唔係 bid 卡 | 過（間接證據） |
| ④ | media deck（Mac）播 MP3 同 stage 畫面同步 ≤0.5s、大mon 預設靜音；任何 mode（reveal 前）唔會出現歌名（sniffer） | deck.ready ACK 14ms/42ms → playing；stage song title=null（reveal 前）；`media.reveal` 後 stage 出歌名。**真瀏覽器音訊同步未量度**（P1-3）。歌名 sniffer 只覆蓋 song mode，其他 mode 由 code review 確認 title 只喺 revealedAt 後非 null | 部分過（協議層過；實機音訊未量） |
| ⑤ | 同時只一部機出聲：非 lease play 拒；在線接管；離線接管（舊機自行停、新機接管、唔雙響、舊機唔准復播） | 非 lease → `W_NO_AUDIO_LEASE`；接管 gen 1→2、舊指令拒；lease 到期 tickLeases 釋放（3.1s/30.3s 實測）；舊 gen play → `W_NO_AUDIO_LEASE`。「舊機自行停」client code 有（host.ts leaseUntil 檢查）但未真瀏覽器驗證；「唔雙響」需真音訊 | 過（server 層齊；client 自行停未實機驗） |
| ⑥ | autoplay 被擋 → stage 顯示「等音源 ready」，唔會假裝播放 | stage.js `songHtml`：state 非 playing/paused 時出「等音源 ready」；host.ts 有「恢復播放」掣＋audioBlocked flag。協議層 preparing 狀態正確。未真瀏覽器驗證 autoplay 攔截 | 過（code 層；未實機驗） |
| ⑦ | Tunnel 下 WS 連 30 分鐘，最多斷 1 次且 5 秒內自動恢復 | 未做（冇公開 hostname）。SUMMARY 明確列遺留 | 冇證據 |
| ⑧ | 同步承諾只限 source.kind='file'；YouTube／Apple 只係手動提示 | YouTube song `media.play` → `W_BAD_SCHEMA`；host UI 顯示「只可手動播」 | 過 |

## 實測證據可信度

| 證據 | 可信度 | 備註 |
|---|---|---|
| `M2/test-m2-local.log`（15/15） | 高 | 完整輸出、時間戳一致、細節具體（songId、playStartedAt、generation） |
| `M2/test-m2-deployed.log`（15/15） | 高 | 同上，部署機 30005 實測 |
| `M2/deploy.log`（重啟持久化） | 高 | songs／lease／playback／ledger 重啟前後逐欄一致 |
| `M0/clock-skew.log`（③用） | 中 | 真測但用 quiz 卡非 bid 卡；機制相同可接受 |
| ④ 真瀏覽器音訊同步 | **冇證據** | 承認未做；需排練前補 |
| ⑦ Tunnel 30 分鐘 | **冇證據** | 承認未做；外部依賴 |
| ⑤「舊機自行停」client 行為 | **冇直接證據** | code 有（host.ts leaseUntil 檢查＋pause）；server 端 tickLeases 已驗證；client 端需實機確認 |

**需要重跑／補做嘅項目：**
- ④：Mac 實機播 MP3＋大mon 量時間差（一次即可，記錄 ms）
- ⑦：Tunnel 設好後 30 分鐘 WS 測試
- ②：獨立測「答錯 0（冇 backup）」＋「答對時其餘 29 人分數不變」snapshot 對比

## 我認為規格本身要澄清嘅位

1. **§5.1「密封出價」vs §3 stage「競投走勢」**：「密封出價一次」字面係 sealed bid（其他人唔知你出幾多），但 stage 要顯示「競投走勢」。目前實作喺 stage 顯示每筆出價金額（柱狀圖＋數字），令「密封」形同虛設。需要拍板：
   - **A**：密封＝手機端互相唔知（stage 可以顯示金額做娛樂效果）→ 目前實作 OK
   - **B**：密封＝真隱藏（stage 只出已出價人數／走勢線，唔出個人金額）→ 要改 stage 投影
   呢個直接影響 P1-2 是否成立。建議傾向 A（派對遊戲大mon 出金額更有戲），但 PLAN 要改寫「密封」呢個字。

2. **§10 M2 ④「media deck（Mac）播 MP3 同 stage 畫面同步 ≤0.5s」量度方法未定義**：係量「deck 音訊起播 ↔ stage song mode 顯示 playing」延遲？定係「音訊內容 ↔ 畫面倒數」同步？建議定義為「server 落 playStartedAt 後，stage 收 patch 顯示 playing 嘅延遲」＋「deck 實際出聲延遲」，兩個分開量。
