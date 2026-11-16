# M0 SUMMARY（r2 — 3 個 P0 已清＋重新部署）

- 日期：2026-11-16（香港）｜最新 build：`DELIVERY-MANIFEST.json`（52 files＋sha256）
- 部署：Windows `192.168.99.20:30005` → 容器 3000（Docker Compose，healthy）；LAN / 127.0.0.1 都實測 200
- 證據：`test.log`（unit 9/9＋bots 本機 22/22＋bots 部署 22/22＋時鐘＋fault 5/5＋P1 補證＋production 禁令）、`deploy.log`（ps／restart／down-up／save-load／RSS）、`api.log`（HTTP／header／WS 101）、`clock-skew.log`、`fault-injection.log`、`extra.log`、`unit.log`、`prod-checks.log`

## 0. r2 P0 修正（對照 checker / lead）

| P0 | 修正 | 證據 |
|---|---|---|
| **P0-1 單元測試證據係失敗 log** | 重跑 `npm run build && npm test`，`unit.log` 有完整 spec 輸出（9 個 test 名＋pass）；`test.log` §1 引用同一個真輸出；SUMMARY 唔再講大 | `unit.log`：`tests 9 / pass 9 / fail 0`；每個 test 名都喺 log 入面 |
| **P0-2 ⑥ 時鐘冇真測** | 新 `bots/skew.mjs`：Node TCP proxy 對 server→client 每個 chunk 加 **200ms 單向延遲**；3 個 client（direct stage／delayed 經 proxy／skewed 模擬本機鐘快 3 秒）每 400ms 量 `endsAt − serverNow()` 15 次 | `clock-skew.log`：direct↔delayed 極差 **101ms**、direct↔skewed(校時後) **1ms**、唔校時對照 **3000ms**、RTT direct 0.6ms→delayed 200.8ms（proxy 真生效） |
| **P0-3 ⑫ fault 冇對號** | 加 env-gated `FAULT_POINT=before-append｜after-write-before-fsync｜after-fsync-before-ack`（＋`FAULT_ON_TYPE` 只喺指定 mutation 觸發；production 開 FAULT_* 拒啟動）＋`FAULT_ENOSPC`；`bots/fault.mjs` 真 spawn server、真 SIGKILL、重啟驗證 | `fault-injection.log` **5/5 PASS**：①壞尾行 truncate＋replay 分數 9→9 ②submit fsync 後 ACK 前 SIGKILL → 重啟同 submissionId 重送 **duplicate**、提交只入一次 ③append 前 kill → 重啟 0 分、同 commandId 重送只入一次 ④write 後 fsync 前 kill → 重啟 ready、狀態一致、重送最多一次 ⑤ENOSPC 注入 → command 回錯、server 唔死、重啟 0 分 |

**真 ENOSPC 限制（如實講）**：沙盒 `/dev/shm` 32GB、冇 mount 細 volume 權限，真填滿磁碟做唔到；用 env-gated write-failure injection（`FAULT_ENOSPC`，production 拒啟動）驗 error path＋重啟一致性。唯讀 journal dir 對「已開 fd」無效（server 長開 fd append），所以冇用呢個做代表。

## 1. 做咗乜（§10 M0）

- fastify＋`@fastify/websocket`＋`@fastify/static`＋multipart；`/stage /host /play`＋`/api/health /api/ready /api/join /api/host/*`＋`/ws`
- JSONL journal：manifest＋segment＋每行 `<payload>|<sha256>`、`write→fsync→ACK`、壞尾行 truncate、replay；segment 8MB 轉卷
- 計分事件帳簿（唯一公式）＋undo（voided 唔刪）；分組 0–N＋搬組 follow／stay（lineage）
- host command envelope（commandId 冪等、expectedRevision／expectedRoundId、receipt 同 command 同一筆 journal）；兩個 host 同時 next 只行一次
- clock offset（RTT 最低樣本）；reconnect race／跨 tab presence／resync／seqEpoch；WS 保護（maxPayload／rate limit／slow consumer／5 個 cap／Origin）
- PIN 冇 default；production 缺 PIN／default PIN／engines 唔對／DEV_LAN_MODE=1／FAULT_* → 拒啟動（5 個 case exit=78 全實測）
- Docker multi-stage（node:26-alpine＋npm ci；runtime 只帶 dist）＋compose（30005:3000、volumes、restart、healthcheck）

## 2. 持久測試房（auditor 用；現時狀態）

| 項目 | 值 |
|---|---|
| 入口 | `http://192.168.99.20:30005`（LAN 200）／server 本機 `127.0.0.1:30005` |
| room code | **3840**（交貨時最終 seed；本 SUMMARY 內 6001 係 M0 時序較早嘅房，已由 M5 重新 seed） |
| room id | **room_bacf121ceae3be53** |
| 玩家分數 | 測試玩家1–6＝**11／9／7／5／3／1**（總分 36、中位數 6、revision 12） |
| host PIN 來源 | server `C:\Users\<ssh-user>\hbd\platform\.env` 嘅 `PIN=`（compose 注入；本機同一份 `game-platform/platform/.env`，**唔會 print**） |
| 只讀攞分 | `GET /api/scores`（免 token：roomId／roomCode／scores／stats）、`GET /api/stage/snapshot`（StageView，零秘密）、`GET /api/ready` |
| 有 token | `POST /api/host/login {pin}` → `GET /api/host/snapshot` |
| 重啟驗分 | `python3 .team/win_server.py run "cd /d C:\Users\<ssh-user>\hbd\platform && docker compose restart"` 後再 curl `/api/scores`（實測分數不變，見 `deploy.log`） |

> 註：M3/M4/M5 測試會再郁呢個房；交貨前（M5）會再清一次並重新 seed，房碼到時更新喺 M5 SUMMARY／RUNBOOK。

## 3. §10 M0 驗收逐條（r2）

| # | 項目 | 結果 | 證據 |
|---|---|---|---|
| ① | 30 approved bots＋2 host＋1 stage；5 個 cap；join p95 ≤5s、15s 內完成 | **過** | 本機／部署各 22/22 PASS；join p95 5–10ms、33/33 連線；31st approved／11th pending／6th host／3rd stage／61st socket 全 `W_ROOM_FULL` |
| ② | 加 10 分 → stage patch ≤1 秒 | **過** | latency 6–20ms（`test.log`） |
| ③ | 重啟（SIGTERM／kill -9）分數仍在、ACK 過嘅分唔失 | **過** | 本機 kill -9 7→7、SIGTERM 12→12（`fault.log`／舊 log）；部署 restart／down-up／save-load 後 `/api/scores` 不變（`deploy.log`） |
| ④ | 狀態四元組 open→close→tally→reveal | **過** | (playing,question,open,open)→(playing,tally,closed,closed)→(playing,tally,tally,tally)→(playing,reveal,revealed,revealed) |
| ⑤ | 0/1/2/4 組＋搬 12 分人兩種語義＋多次搬組＋undo＋export→replay 對帳 | **過** | `extra.log` 9/9：groups.set 0/1/2/4 全對；組分公式 g1=2+4+3=9；stay＝p1 0＋g1 補償 4（lineage）；undo 後 g1=5；follow＝p2 3 分跟去 g2；export→重啟帳簿 4 筆逐筆一致（id／delta／voided／target）＋個人／組分一致 |
| ⑥ | 校歪 ±3s＋proxy 200ms 單向延遲 → 兩機倒數差 ≤0.5s | **過（真測）** | `clock-skew.log`：極差 101ms（delayed）／1ms（skewed 校時）／naive 對照 3000ms |
| ⑦ | 舊 socket 遲斷、跨 tab presence、timeout resume | **過** | 新線連上後舊線 close 仍 online；refresh 同身份同分數（`test.log`） |
| ⑧ | Cloudflare Access 場外驗證 | **未證實（外部依賴，已同 lead 講明唔做）** | 冇公開 hostname／Access policy（dashboard 權限）；程式支援 `ACCESS_REQUIRED=1`＋`Cf-Access-Jwt-Assertion`，production 開 Access=0 會 warn；RUNBOOK 已加「上線 flip 清單」 |
| ⑨ | production 禁令 | **過** | 缺 PIN／default PIN／engines 唔對／DEV_LAN_MODE／FAULT_* 全部 exit=78（`prod-checks.log`） |
| ⑩ | commandId 冪等＋兩 host 同時 next 只行一次 | **過** | 同 ID 同 payload 回原 revision、異 payload `W_CMD_PAYLOAD_MISMATCH`；next 1 ok＋1 stale |
| ⑪ | D28 恢復矩陣 | **部分（核心＋證據齊）** | 自動重連（restart 6.4s 內復線）、refresh 同身份、30 bots 斷線重連零重複、未 ACK 重送。`extra.log` 補：同 ID 同 payload duplicate 原收據、同 ID 異 payload `W_ID_PAYLOAD_MISMATCH`、新 ID 再交 `W_ALREADY_STATE`、reopen 後舊 round 提交 `W_ROUND_CLOSED`、heartbeat 唔回 pong 被 terminate。**browser e2e（confirm 前後 refresh 草稿／stage／host refresh 視覺）未自動化**，列 M1 遺留 |
| ⑫ | fault-injection 五 case | **過（5/5）** | `fault-injection.log`（詳見 §0） |
| ⑬ | Docker：up 後 ready 200、restart 分數仍在、down/up、30005、save/load 可搬 | **過** | `deploy.log`：ps healthy、restart／down-up／save(>70MB)→rmi→load→up 後分數不變、RSS 38.8MiB |

## 4. 已知限制（唔隱瞞）

1. ⑧ Cloudflare Access：外部依賴，未設 hostname／policy；程式＋RUNBOOK 已備。
2. ⑪ browser e2e：未用真 browser 自動化（client 有草稿／同 ID 重送邏輯）；建議 auditor 手動做一次 refresh 測試。
3. ⑫ 真 ENOSPC：沙盒冇細 volume／mount 權限，用 env-gated injection 代替（production 拒用）。
4. Node patch：本機 v26.8.1、容器 v26.13.1（同 major，`engines >=26 <27` 通過）；`DELIVERY-MANIFEST.json` 有記錄。
5. 非 §7 表公開只讀 endpoint：`/api/qr`、`/api/scores`、`/api/stage/snapshot`（auditor 用、零秘密）；`AUDIT_READONLY=0` 可關後兩者。已寫入 README／RUNBOOK。
