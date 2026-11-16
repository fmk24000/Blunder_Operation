<!-- llm-call-meta {"requested_model": "glm-5.3", "response_model": "glm-5.3", "finish_reason": "stop", "usage": {"prompt_tokens": 326003, "completion_tokens": 7931, "total_tokens": 333934, "prompt_tokens_details": {"cached_tokens": 183}, "completion_tokens_details": {"accepted_prediction_tokens": null, "reasoning_tokens": 5314, "rejected_prediction_tokens": null}, "cost": 0, "opencode": {"billing_source": "go", "list_cost": 0.49109198, "allowance": 1.96436792, "tokens": {"input": 325820, "output": 7931, "reasoning": 5314, "cache_read": 183, "cache_write_5m": 0, "cache_write_1h": 0}}}, "elapsed_sec": 81.4, "endpoint": "https://opencode.ai/inference/go/v1", "content_chars": 4955, "had_reasoning": true, "reasoning_effort": "low", "id": "chatcmpl-e2a81bd1"} -->
## 結論
**有條件收貨**——M0 十三條驗收有十一條半有真證據且過線；⑧（Cloudflare Access 場外實測）完全冇證據，⑪ browser e2e 未做。⑧係外部依賴（PLAN §9.9 自己都承認 dashboard 一步做唔到），唔係 code 問題，但**未補齊之前唔可以當 M0 完全關閉，更加唔可以上線**。

## P0（唔可以收貨，必須先改）
1. **[PLAN §10 M0 ⑧／§9.3]** 部署實例 `ACCESS_REQUIRED=0`、`PUBLIC_ORIGINS` 仲有 placeholder `hbd.example.com`（`.env` 內容），即係而家 `/host` 同 `/api/host/*` 只靠 PIN，冇 Cloudflare Access。→ 證據：`.env`（`ACCESS_REQUIRED=0`）＋RUNBOOK §4.5 自己寫「未做第 2 步 = 未上線」。→ 要求：完成 RUNBOOK §4.5 flip 清單（Tunnel hostname＋兩條 Access policy＋`ACCESS_REQUIRED=1`），場外 4G 實測 `/api/host/*` 被擋、`/play` `/stage` 開得，補 `evidence/M0/` 先算 ⑧ 過。呢個係收貨條件，唔係建議。

## P1（實作前要改，但唔阻 milestone 收貨）
1. **[src/server/store.ts `load()`＋M0/deploy.log]** `revision` 重啟後歸零：deploy.log 明顯「restart 前 revision 64 → restart 後 revision 0」，而 seq 有 replay 返（api.log `seq:138, revision:0` 自相矛盾）。§7 話 revision＝業務版本、expectedRevision 用嚟互斥；而家重啟後所有 host 手上嘅舊 revision 會觸發假 W_STALE_COMMAND（方向安全但語義錯）。→ 要求：replay 時按每筆 `bumpRevision` tx 重建 revision。
2. **[交付封包 `.env`]** 真實 PIN（<PIN-REDACTED>）連 `.env` 全文寫入交付封包。`.gitignore` 有排佢但 review packet 照收。→ 要求：即刻換 PIN；交付封包以後只放 `.env.example`。
3. **[src/server/index.ts `trustProxy: true`]** 無條件信 `X-Forwarded-For`——LAN 直連攻擊者可以偽造 IP 绕过 `/api/join`（200/min）同 login（10/min）rate limit。→ 要求：只對 cloudflared／已知 proxy IP trust，或者改 `trustProxy` 為具體 loopback/address。
4. **[src/server/http.ts `/api/scores`／`/api/stage/snapshot`／`/api/qr`]** 三個公開 endpoint 唔喺 §7 HTTP 表入面（builder 自己喺 README 認）。StageView 零秘密、風險低，但係規格外 API 面，而且 production 預設開。→ 要求：production 預設 `AUDIT_READONLY=0`（要 auditor 先顯式開），或者寫入 PLAN 增補。
5. **[M0/SUMMARY §2 vs api.log／deploy.log]** 「持久測試房」寫 roomCode **6001**／roomId `room_ce6bc964…`／分數 11/9/7/5/3/1，但 api.log／deploy.log／test-bots-deployed 全部係 roomCode **3000**／`room_9e598770…`／分數 [13,0,…]。auditor 對唔上號。→ 要求：重新 seed 後用 `/api/scores` 實測輸出更新 SUMMARY，或者講明兩個房嘅時序。
6. **[PLAN §10 M0 ⑪]** browser e2e（confirm 前後 refresh 草稿保存、stage／host refresh 視覺唔白屏）未自動化——client code 有邏輯（play.ts draft/pending key、common.ts connBanner）但零 browser 證據。→ 要求：M1 交貨前用真 browser（哪怕人手＋screen recording）補一次。

## P2（可以之後先改）
1. [src/server/commands.ts `groups.set`] 用 count 重建組會剷走自訂組名（§8.2「組名顏色隨意」）；UI 冇改名入口。
2. [src/server/store.ts `load()` 註解] 註解話「重啟後 seq 由 0 重新起」，實際 code 係延續 journal seq——註解同行為唔符（行為係啱嘅）。
3. [src/server/http.ts CSP] `connect-src 'self' ws: wss:` 允許任何 WS host，可以收窄。
4. [src/server/commands.ts `saboteur.assign`] 派身份後切 `mode="role-reveal"`——規格入面 role-reveal 係揪中揭曉专用；M4 審嘅時候要改。
5. [bots/bots.mjs] clock offset 檢查三個 client 同機比較，冇意義（真測試喺 skew.mjs，已覆蓋）。

## 逐條核對 §10 驗收標準

| # | 驗收條文 | 實作／證據 | 判定 |
|---|---|---|---|
| ① | 30 bots＋2 host＋1 stage；join p95≤5s／15s；五個 cap | test-bots-run8／deployed：22/22，p95 5–16ms，33/33 連線，31st approved／11th pending／6th host／3rd stage／61st socket 全 W_ROOM_FULL | 過 |
| ② | 加 10 分 → stage patch ≤1s | latency 8–25ms | 過 |
| ③ | SIGTERM＋kill -9 重啟分數仍在 | fault.log：kill -9 7→7、SIGTERM 12→12；deploy.log restart／down-up／save-load 分數不變 | 過 |
| ④ | 狀態四元組 | 四步全對 §6 狀態機表 | 過 |
| ⑤ | 0/1/2/4 組；搬 12 分兩語義；多次搬組＋undo＋export→replay 對帳 | extra.log 9/9（含 lineage、voided 唔刪、逐筆 id/delta/voided/target 一致） | 過 |
| ⑥ | ±3s skew＋200ms 單向延遲 → ≤0.5s | clock-skew.log：真 TCP proxy，RTT +200ms 實證；極差 101ms／1ms；naive 對照 3000ms | 過 |
| ⑦ | 舊 socket 遲斷、跨 tab presence、timeout resume | bots：新線接上舊線斷仍 online；refresh 同身份同分數 | 過 |
| ⑧ | 場外 4G `/api/host/*` 被 Cloudflare 擋；cookie＋PIN→token | **零證據**；ACCESS_REQUIRED=0、placeholder hostname；RUNBOOK 有 flip 清單但未執行 | **唔過（收貨條件）** |
| ⑨ | production 禁令 | prod-checks.log 五個 case exit=78（缺 PIN／default PIN／engines／DEV_LAN_MODE／FAULT_*） | 過 |
| ⑩ | commandId 冪等；兩 host 同時 next 只行一次 | 同 ID 回原 revision、異 payload W_CMD_PAYLOAD_MISMATCH；next 1 ok＋1 stale | 過 |
| ⑪ | D28 恢復矩陣全過 | bots＋fault②＋extra：自動重連 6.4s、同 ID duplicate、W_ID_PAYLOAD_MISMATCH、reopen 舊 round W_ROUND_CLOSED、heartbeat terminate；**browser e2e（草稿 refresh／stage 視覺）冇做** | 部分過（P1-6） |
| ⑫ | fault-injection 五 case | fault-injection.log 5/5；case⑤ 用 FAULT_ENOSPC 注入代替真 disk full（builder 如實講，沙盒限制成立） | 過（附註） |
| ⑬ | Docker：ready 200／restart 分數在／down-up 重連／30005／save-load | deploy.log 全齊（ps healthy、restart／down-up／save>70MB→load、RSS 38.8MiB） | 過 |

## 實測證據可信度
- **可信**：unit.log（9/9 spec 輸出）、bots 本機＋部署雙跑、skew 原始 15 個 sample（RTT 數值自洽）、fault 五 case（SIGKILL signal 有記錄）、prod-checks exit=78。log 有命令、時間、輸出，冇斷章取義跡象。
- **要重跑／對號**：①「持久測試房」資料（6001 vs 3000）同 api.log／deploy.log 唔對號——見 P1-5；②`/api/scores` 喺 api.log 嘅輸出格式（array）同 code 回傳（object）唔同，明顯係 capture script 轉過，下次直接貼 raw response；③deploy.log restart 後 revision 0 呢個「瑕疵」反而證明 log 冇執過——但都要修（P1-1）。
- **假設而非實測**：⑧ Access、⑪ browser 部分、⑫ 真 disk full、M2 browser 音訊同步（後兩個唔屬 M0 範圍）。

## 我認為規格本身要澄清嘅位
1. **§10 M0 ⑧ vs §9.9**：⑧要求場外 Access 實測，§9.9又承認 Cloudflare dashboard 一步「SSH 做唔到」——規格應寫明⑧可以延後到「上線 flip」做、但係 M0 關閘條件，而唔係留俾 builder 自行判斷。
2. **revision 跨重啟語義**：§7冇講 revision 係唔係要由 journal replay 重建；建議寫死「replay 必須重建 revision」（同 seq 一樣），避免實作各自演繹。
3. **§7 HTTP 表係封閉集合定唔係**：builder 加咗 `/api/qr`（大mon QR 其實係剛需，§8.1 idle mode 要 QR 但 §7 冇對應 endpoint）——規格應補 `/api/qr` 入表，並講明 auditor 只讀 endpoint 嘅預設開關歸邊。

<!-- checker 註：GLM 報告原文含真實 PIN，已由 checker redact 為 <PIN-REDACTED>；PIN 需輪換。 -->
