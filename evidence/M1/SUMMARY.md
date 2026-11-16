# M1 SUMMARY（r2 — 2 個 GLM P0＋checker P0-3 已清；28/28 PASS）

- 日期：2026-11-16（香港）｜部署：`192.168.99.20:30005`（最新 build，已重新 deploy）
- 證據：`test.log`（unit 9/9＋本機 28/28＋部署機 28/28＋重啟持久化）、`deploy.log`（ps／restart／logs；之前 KeyError traceback 嘅 capture script 已修正，log 係新 capture）、`api.log`（HTTP＋規則頁門檻＋tally sniffer＋題庫）

## 0. r2 P0 修正對照

| P0 | 修正 | 證據 |
|---|---|---|
| **M1-P0-1 Q14 收卷冇派最接近 +2** | `closeRoundMutations` 計完 `actualAnswer` 之後**同一 transaction** 呼叫 `gradeClosest`：最接近者 +2、並列全部 +2、綁 roundId／submissionId（重開時由 reopen 嘅 auto-void 清走） | `test.log`「Q14 收卷同一 transaction 即派最接近 +2」events=30／deltas=2；m1 local＋deployed 都 PASS |
| **M1-P0-2 主持可手改 Q14 actualAnswer** | `quiz.setActualAnswer` 對 `card.autoAnswer` 卡直接回 `W_ALREADY_STATE`（要改就 void／reopen，§3.1） | `test.log`「§3.1 主持唔可以手改 Q14 actualAnswer（W_ALREADY_STATE）」 |
| **M1-P0-3 後台儲存 Q14 靜默刪 autoAnswer** | `quiz.upsert` 改成 server-side merge：保留 `autoAnswer`／`actualAnswer`／`state`，`version` 每次 +1（唔會變 draft／version 1）；唔再靜默降級 | `test.log`「Q14 後台儲存後 autoAnswer 仍在＋version+1」autoAnswer=minutes-to-midnight、version 1→2 |

## 1. 同時清咗嘅 P1（checker 要求）

| P1 | 修正／證據 |
|---|---|
| `stage.rules` phase／blackout 門檻 | code + 實測：`test.log`「stage.rules 門檻：phase=lobby → W_WRONG_PHASE；blackout → W_STAGE_LOCKED」；`api.log` 亦有 HTTP response 原文 |
| 多頁規則頁真正切 blocks | `store.rulePages()` 按 block 視覺高度（≈700px）切 sub-page；`buildStageView` 只送當前頁 blocks＋`pageIndex/totalPages`；host 台有「上一頁／下一頁」；實測 totalPages=3、pageIndex=1 blocksDiff=true、兩個 stage 一致（`test.log`） |
| sniffer 覆蓋 reconnect／export | tally 階段：重連 stage snapshot 冇 correct、`/api/host/export` 冇 token 同 player token 都 401（`test.log`） |
| 分母證據 | `test.log`「分母＝開題鎖定 approved roster」eligible=30、offline approved 照計、pending／kicked 唔計、29/30 答完仍然 open |
| `autoClose` 關咗時間到仍自動收 | `tickAutoClose` 嘅 `timeUp` 已 gate 落 `settings.autoClose`（§3.1）；`test.log`「關閉 auto-close 時全員答完唔會自動收」 |
| 規則頁編輯器字數提示／beforeunload／複製上一題 | 已加「複製」掣；`W_RULES_LIMIT` server 驗證；**原始 JSON blocks 編輯器／本地 1920×1080 預覽／beforeunload 仍列遺留**（M5 前如時間許可再補） |
| M1 deploy.log KeyError traceback | capture script 已修正（`p.get("archived", False)`），`deploy.log` 係新 capture，冇 traceback |
| 題庫「複製上一題」 | host 台每題有「複製」掣（新增題目、prompt 加「（複製）」） |

## 2. §10 M1 驗收（r2；本機 28/28、部署 28/28）

| # | 項目 | 結果 | 證據 |
|---|---|---|---|
| ① | 30 bots 答 20 秒題：30 receipt、零重複、零漏 | **過** | receipts=30 unique=30（本機 100ms／部署 454ms） |
| ② | tally 階段 WS／HTTP／build／重連／export sniffer 冇正解／解釋；逐選項貼人；reveal 後先出 | **過** | counts=[0,30,0,0]、voters=30、export 401/401、reconnect 冇 leak；reveal 後 correct=1＋解釋 |
| ③ | 自動收卷分母正確；關閉 auto-close 唔會自動收 | **過** | autoClosed 7–30ms、eligible=30；autoClose=false 2.5s 仍 open；分母 test（offline 照計／pending/kicked 唔計） |
| ④ | 揭曉後分數逐筆對帳 | **過** | 30 筆 +1、reason「問答 Q1」 |
| ⑤ | 題庫改完即時生效；一鍵匯入唔蓋 open 題（diff）；Q14 儲存回歸 | **過** | imported=1、unchanged=9、skippedOpen=8、diffs=["q2"]；open 題前後一樣；q4 即時生效；Q14 autoAnswer／version+1 |
| ⑥ | 估數字 actualAnswer → 最接近 +2、並列全 +2 | **過** | 30 人同答 300→30 筆 +2；10/20 各 15 人 actual 15→30 筆 +2 |
| ⑦ | Q14 closedAt＋Asia/Hong_Kong；跨 00:00 fixture；**收卷即派 +2**；**主持唔可以手改** | **過** | actualAnswer 與本地計算一致；unit test 4 個跨午夜 fixture；events=30 deltas=2；手改 `W_ALREADY_STATE` |
| ⑧ | 重開：新 roundId、舊 round void、舊分作廢、舊提交唔入新輪 | **過** | q1#2 retryOf=q1#1、oldState=void、oldSubs=30／newSubs=0、舊 auto 30 筆全 voided |
| ⑨ | 規則頁九條（含多頁、門檻、fallback、conflict、重啟持久） | **過** | 入關 0ms 出 rules；預設四頁＝附錄 B；編輯 0–1ms；`W_RULES_LIMIT`；`W_RULES_CONFLICT`；多頁切 blocks；pageIndex 各機一致；重啟後四頁 v7／q4 改動／8 個 round 全部仍在（`deploy.log`） |

## 3. 已知限制（M2 前遺留）

1. 規則頁編輯器仍係 raw JSON blocks textarea（冇 8 種 block 專屬 UI／本地 1920×1080 預覽／beforeunload 警告／字數即時提示）→ M5 前可補；server 限制／衝突／權限已齊。
2. stage `autoAdvanceSeconds` 自動翻頁前端未實作（四關預設 0＝手動；server payload 有值）→ M5 前補或明確 waiver。
3. 兩步確認／草稿保存：client 已實作，未用真 browser e2e 驗（m1 用 WS bot 模擬 confirmed submit）。
4. M1 acceptance script 假設乾淨房（開新卡假設未 reveal）；重跑前要清 `data/`（腳本頭部有註明；部署證據用清空後 clean run）。
