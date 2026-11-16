<!-- llm-call-meta {"requested_model": "glm-5.3", "response_model": "glm-5.3", "finish_reason": "stop", "usage": {"prompt_tokens": 283710, "completion_tokens": 6326, "total_tokens": 290036, "prompt_tokens_details": {"cached_tokens": 10}, "completion_tokens_details": {"accepted_prediction_tokens": null, "reasoning_tokens": 3590, "rejected_prediction_tokens": null}, "cost": 0, "opencode": {"billing_source": "go", "list_cost": 0.425017, "allowance": 1.700068, "tokens": {"input": 283700, "output": 6326, "reasoning": 3590, "cache_read": 10, "cache_write_5m": 0, "cache_write_1h": 0}}}, "elapsed_sec": 60.6, "endpoint": "https://opencode.ai/inference/go/v1", "content_chars": 4695, "had_reasoning": true, "reasoning_effort": "low", "id": "chatcmpl-01f52c2a"} -->
## 結論
唔收貨（P0 只得一組——Q14 自動計分鏈未閉合＋主持可手改；改完呢條就可以收，其餘質素好高）

## P0（唔可以收貨，必須先改）

1. **[src/server/commands.ts `closeRoundMutations`／`quiz.setActualAnswer`] Q14 時間題收卷後冇自動派「最接近 +2」** → 證據：`closeRoundMutations` 對 `autoAnswer==="minutes-to-midnight"` 只寫入 `actualAnswer`（round＋card），冇呼叫最接近者計分；全 codebase 只有 host 手動 `quiz.setActualAnswer` 一條路徑會派 +2。m1.mjs Q14 測試（`bots/m1.mjs`「Q14 用 closedAt…」一段）只驗 `actualAnswer` 數值，**冇驗帳簿有冇 +2 事件**——測試同實作一齊漏。PLAN §3.1 計分寫死「估數字題：最接近者 +2」，Q14 係估數字題（附錄 A.2 Q14 標「估數字・即場」）→ 要求：Q14 收卷 transaction 內（同一筆 journal）計完 actualAnswer 之後即刻按最接近者派 +2（並列全 +2），並補一個 30 bots Q14 帳簿對帳測試。

2. **[src/server/commands.ts `quiz.setActualAnswer`] 主持可以手改 Q14 嘅 `actualAnswer`** → 證據：`quiz.setActualAnswer` 對任何 round 都收 `actualAnswer`，冇檢查 `card.autoAnswer`；即 Q14 自動計完之後主持一個 command 就覆蓋。PLAN §3.1 明文「主持唔可以手改（要改就 void 重開）」→ 要求：`card.autoAnswer` 嘅卡，`quiz.setActualAnswer` 要拒（`W_ALREADY_STATE` 或 `W_BAD_SCHEMA`），改答案只經 `card.reopen`。

## P1（實作前要改，但唔阻 milestone 收貨）

1. **[src/server/commands.ts `stage.rules`] 冇 phase／blackout 門檻** → 證據：`stage.set` mode="rules" 有 `phase!=="playing"` 拒絕，但 `stage.rules` command 完全冇檢查 phase，亦冇 blackout 拒絕（`W_STAGE_LOCKED`）。PLAN §8.4「觸發」一段寫明 `phase=idle/lobby/award` 拒絕（`W_WRONG_PHASE`）、blackout 期間拒絕（`W_STAGE_LOCKED`）。
2. **[src/server/views.ts `buildStageView`／public/js/client/stage.ts `rulesHtml`] 分頁只出頁碼、唔切內容** → 證據：`rulePagination` 有 `totalPages` 估算、stage payload 有 `pageIndex`，但 `buildStageView` 送出整頁 `rulePage`（blocks 全部），`rulesHtml` 亦 render 晒全部 blocks——`totalPages>1` 時「2/3」顯示咗但兩頁內容一齊疊住。M1 ⑨ 只用預設 1 頁測，多頁情況未證實。要求：server 按 `pageIndex` 切 blocks 先送出。
3. **[public/js/client/host.ts `quizSection`] 題庫編輯器冇「複製上一題」** → 證據：只有 加／刪／↑↓／儲存。PLAN §3.1 題庫要求「加刪改拖曳排序、複製上一題」。↑↓ 掣勉強當排序，但複製上一題完全冇。
4. **[bots/m1.mjs ② sniffer] 未覆蓋 localStorage／export／重連** → 證據：sniffer 只查 stage WS view、player WS view、`/api/stage/snapshot`、`play.js` build。PLAN §7 披露矩陣寫死「M1/M2/M4 sniffer 要覆蓋首連、重連、HTTP、build 產物、**localStorage**、**export**，並測 reveal 前後兩個階段」。重連後 snapshot、`/api/host/export` room.json、client localStorage 三路冇查。
5. **[public/js/client/host.ts `rulesSection`] 規則頁編輯器同 §8.2 #14 差一截** → 證據：blocks 用 raw JSON textarea（唔係 8 種 block 結構化編輯）、冇「複製」、冇「重設做預設頁」、冇 1920×1080 即時預覽（「預覽上大mon」係 broadcast，唔係預覽）、冇 beforeunload 警告、冇字數即時提示。M1 ⑨ 驗收項冇逐條列呢啲，所以唔阻收貨，但 §8.4 係 normative，M2 前要補。

## P2（可以之後先改）

1. **[public/js/client/stage.ts boot() 尾段] `autoAdvanceSeconds` 自動翻頁係空殼**——個 setInterval 計完 `last` 之後 `void last`，乜都唔做。預設四頁都係 0（手動）所以 M1 驗收唔觸發，但欄位對外存在，遲早係假功能。
2. **[src/server/commands.ts `card.reopen`] 舊 host 分「逐筆揀 void」冇做到**——只有 `voidHostEvents` 全有全冇開關；PLAN §7 reopen 規則④話主持可以「逐筆揀 void」。
3. **[public/js/client/host.ts rulesSection] 冇「上一頁／下一頁」掣**——`stage.page` command 有，host UI 冇掣（§8.1 話 host 台可以插手翻頁）。
4. **[src/server/store.ts `rulePagination`] 分頁用粗高度估算**（heading 100px／其他 80px ÷700），唔係真 1920×1080 幾何；M1 SUMMARY 自己都認。

## 逐條核對 §10 驗收標準

| # | 驗收條文 | 實作／證據 | 判定 |
|---|---|---|---|
| ① | 30 bots 同時答 20 秒題，30 receipt 零重複零漏 | m1.mjs 本機＋部署均 receipts=30 unique=30（101ms／400ms） | 過 |
| ② | tally 三路 sniffer 冇正解外洩；reveal 後先出 | WS／HTTP／build 三路查咗、counts/voters=30、reveal 後 correct+解釋出現；但 localStorage／export／重連未覆蓋 | 部分過（核心過，覆蓋面唔夠） |
| ③ | 全員答完即刻自動收（分母正確）；關 auto-close 唔自動收 | autoClosed 3–27ms、eligible=30；autoClose=false 2.5s 仍 open | 過 |
| ④ | 揭曉後分數逐筆同帳簿對上 | autoEvents=30、delta=1、reason「問答 Q1」 | 過 |
| ⑤ | 題庫改完即刻生效；匯入唔蓋 open 題（diff） | q4 即時改；imported=1 unchanged=9 skippedOpen=8 diffs=["q2"] | 過 |
| ⑥ | 估數字 actualAnswer → 最接近 +2、並列全 +2 | q11（30 並列）、q13（10/20 各 15 人）都 30 筆 +2 | 過（但 Q14 呢條路徑冇自動派分——見 P0-1） |
| ⑦ | Q14 closedAt＋Asia/Hong_Kong，跨 00:00 fixture | 部署 actualAnswer=675=expected；unit test 4 個 fixture 全過 | 部分過——數值計算過，但**收卷後冇自動 +2 派分、主持可覆蓋**（P0-1／P0-2），且測試冇驗帳簿 |
| ⑧ | 重開：新 roundId、舊 void、舊分作廢、舊提交入唔到新輪 | q1#2／retryOf／void／oldSubs=30 newSubs=0／30 筆 auto voided | 過 |
| ⑨ | 規則頁九項 | 入關 0ms、附錄 B 文字、編輯 0–1ms、W_RULES_LIMIT、fallback、W_RULES_CONFLICT+latest、pageIndex/totalPages 兩 stage 一致（但只測 1 頁）、重啟後仍在 | 部分過——多頁分頁顯示未真正實作（P1-2）、重玩／跳返只喺 fallback 測試順帶覆蓋 |

## 實測證據可信度

- **可信**：m1.mjs 本機＋部署雙跑 22/22、unit test 9/9（有命令、輸出、時間戳）；重啟前後 rulePages／q4 改動／rounds 逐項對照一致；部署乾淨房重跑有講明清 data。
- **要重跑／補**：① Q14 要補「收卷後帳簿 +2 事件」斷言（而家條 test 同個 bug 一齊盲）；② sniffer 要補 localStorage／export／重連三路；③ `M1/deploy.log` 第一段有 `KeyError: 'archived'` traceback（驗證 script 自己爆咗），後段先跑通——第一段證據作廢；④ 多頁規則頁（totalPages>1）完全冇實測。
- **假設**：兩步確認／草稿保存係 client 行為，只有 code 冇 browser e2e——builder 自己喺 SUMMARY §3 認咗，算誠實但未證實。

## 我認為規格本身要澄清嘅位

1. PLAN §3.1 冇寫明 Q14 嘅 +2 派分**幾時**入帳（收卷 transaction 內定案，定 reveal 後先入？）——建議寫死「收卷同一 transaction」，免得又出現 tally 階段見分數嘅爭議（MC 而家係 close 時派分，tally 階段分數條已經變，嚴格講同「未公佈正解」精神有張力，但規格冇禁止）。
2. §8.2 #14 規則頁編輯器要求（結構化 block 編輯／預覽唔 broadcast）同 M1 驗收 ⑨ 嘅清單唔對齊——M1 收貨線應該以邊個為準？建議 §10 M1 行明寫「編輯器 M1 版＝JSON 編輯可接受，結構化 UI 屬 M5」。
