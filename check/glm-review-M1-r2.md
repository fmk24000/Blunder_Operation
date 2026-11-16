<!-- llm-call-meta {"requested_model": "glm-5.3", "response_model": "glm-5.3", "finish_reason": "stop", "usage": {"prompt_tokens": 326032, "completion_tokens": 3832, "total_tokens": 329864, "prompt_tokens_details": {"cached_tokens": 31183}, "completion_tokens_details": {"accepted_prediction_tokens": null, "reasoning_tokens": 1882, "rejected_prediction_tokens": null}, "cost": 0, "opencode": {"billing_source": "go", "list_cost": 0.43775698, "allowance": 1.75102792, "tokens": {"input": 294849, "output": 3832, "reasoning": 1882, "cache_read": 31183, "cache_write_5m": 0, "cache_write_1h": 0}}}, "elapsed_sec": 43.1, "endpoint": "https://opencode.ai/inference/go/v1", "content_chars": 3341, "had_reasoning": true, "reasoning_effort": "low", "id": "chatcmpl-7cefc6a0"} -->
## 結論
**收貨**（M1 九條驗收全過、本機＋部署機 28/28、重啟持久化有證據；P1 遺留不阻收貨）

## P0（唔可以收貨，必須先改）
冇。

## P1（實作前要改，但唔阻 milestone 收貨）
1. [src/client/host.ts `rulesSection`／PLAN §8.2 第 14 項] 規則頁編輯器係 raw JSON textarea，冇 8 種 block 專屬 UI、冇 1920×1080 本地預覽、冇 beforeunload 警告、冇字數即時提示 → builder 自己喺 M1/SUMMARY §3 承認 → M5 前要補齊（server 端 `W_RULES_LIMIT`／`W_RULES_CONFLICT` 已齊，唔阻 M1）。
2. [src/client/stage.ts `rulesHtml`／PLAN §8.4] `autoAdvanceSeconds` 自動翻頁前端未實作（server payload 有值、預設 0）→ 四關預設 0 所以 M1 驗收唔觸發，但規格寫明「每版停 autoAdvanceSeconds 秒」，M5 前要補或正式 waiver。
3. [src/server/http.ts upload／PLAN §8.4 image block] 規則頁 image block 冇上傳路徑（`/media/rules/<randomId>`）；renderer 有 `rb-img` 但編輯器入唔到 imageUrl → M5 前補。
4. [PLAN §10 M1 ⑨「含重玩／跳返」] 自動出 rules 只實測咗 `rundown.next` 入 quiz 同同關 prev/next；「跳返之前關／重玩同一關令 gameId 轉變 → 自動 rules」冇獨立測試證據（code `advanceRundown` 嘅 gameId 比對邏輯睇落正確）→ M2/M5 補一個 skip-back case。

## P2（可以之後先改）
1. [src/client/host.ts `cardsSection`／PLAN §3.1 主持台欄] 出卡區只顯示「已答 N/M」，冇**未答名單**（§3.1 第 1 階段 host 欄明文要求）。
2. [src/client/play.ts] 兩步確認／草稿保存 client 已實作但冇真 browser e2e（M1 用 WS bot 模擬 confirmed submit）；M0 SUMMARY 亦承認 browser e2e 未自動化 → 排練前手動驗一次。
3. [bots/m1.mjs 頭部] 驗收腳本假設乾淨房，重跑要清 `data/`——建議腳本自己做 idempotent 清理。
4. [M1/deploy.log 第 4 行] `grep: /tmp/m1run.log: 沒有此一檔案或目錄` 係 capture script 手痕，下次清掉免誤導。

## 逐條核對 §10 驗收標準
| # | 驗收條文 | 實作／證據 | 判定 |
|---|---|---|---|
| ① | 30 bots 同時答 20 秒題，30 receipt 齊、零重複、零漏 | m1 local receipts=30 unique=30（100ms）；deployed 30/30（451ms） | 過 |
| ② | tally 三路 sniffer 冇正解／解釋外洩；reveal 後先出 | stageLeak/playerLeak/httpLeak/buildLeak/reconnectLeak 全 false＋export 401/401；reveal 後 correct=1＋解釋；counts=[0,30,0,0] voters=30（逐選項貼人） | 過 |
| ③ | 全員答完即刻自動收（分母正確）；關 auto-close 唔會自動收 | autoClosed 7–11ms、eligible=30；autoClose=false 2.5s 仍 open；另測 offline 照計／pending／kicked 唔計、29/30 仍 open | 過 |
| ④ | 揭曉後分數逐筆同帳簿對上 | 30 筆 +1、reason「問答 Q1」 | 過 |
| ⑤ | 題庫改完即刻生效；一鍵匯入唔蓋 open 題（diff） | q4 即時生效；imported=1 unchanged=9 skippedOpen=8 diffs=["q2"]；Q14 儲存後 autoAnswer 保留＋version+1 | 過 |
| ⑥ | 估數字 actualAnswer → 最接近 +2、並列全 +2 | 30 人同答 300→30 筆 +2；10/20 各 15 人 actual 15→30 筆 +2 | 過 |
| ⑦ | Q14 closedAt＋Asia/HK，跨 23:59:59／00:00:00 fixture | unit test 4 個跨午夜 fixture（23:58:30→1、00:00:00→1440 等）；live actualAnswer=643/640 與本地 HK 計算一致；收卷同 transaction 派 +2；手改回 `W_ALREADY_STATE` | 過 |
| ⑧ | 重開：新 roundId、舊 round void、舊分作廢、舊提交入唔到新輪 | q1#2 retryOf=q1#1、oldState=void、oldSubs=30/newSubs=0、舊 auto 30 筆全 voided | 過 |
| ⑨ | 規則頁：入關 2 秒內 rules、一鍵出收、改完 1 秒、W_RULES_LIMIT、fallback、W_RULES_CONFLICT、分頁各機一致、重啟仍在 | latency 0–1ms；lobby→W_WRONG_PHASE／blackout→W_STAGE_LOCKED；超字 W_RULES_LIMIT；第二 host W_RULES_CONFLICT＋latest；fallback flag 唔阻流程；totalPages=3 pageIndex 兩 stage 一致＋blocks 真切；deploy.log 重啟前後 rulePages v7／q4／8 rounds 全一致 | 過（「重玩／跳返」自動觸發冇獨立測試，見 P1-4） |

## 實測證據可信度
- **可信**：M1 本機＋部署兩份完整 run（28/28，逐項 detail 有數字、有 roomCode/roomId、時間戳一致）；deploy.log 重啟前後 rulePages／rounds／ledger 逐項對照一致；api.log 有 HTTP 原始 response（門檻 error code、tally 投影冇 correct）；unit.log 係完整 spec 輸出（9 test 名齊）。
- **要留意**：M1/api.log 嘅 tally sniffer 用嘅房係 M0 run 留低嘅 40 人房（roomCode 3000），但只做洩漏檢查、q3 未開過，結論仍然成立；部署機 m1 run 用清空後新房（8728），乾淨。
- **假設／未自動化**：兩步確認同草稿保存只有 code＋WS bot 模擬，冇真 browser e2e（builder 已承認）；`autoAdvanceSeconds` 前端未實作所以冇得測。

## 我認為規格本身要澄清嘅位
1. §8.2 第 14 項要求規則頁編輯器有「即時預覽（1920×1080 比例，預覽唔 broadcast）」，但 §10 M1 驗收 ⑨ 冇列預覽——建議明確寫邊個 milestone 驗（而家當 M5 項）。
2. §3.1「未答名單」同 §10 M1 驗收冇對應條文——建議註明係 M1 定 M5 交付。
