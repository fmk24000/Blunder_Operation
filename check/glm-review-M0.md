<!-- llm-call-meta {"requested_model": "glm-5.3", "response_model": "glm-5.3", "finish_reason": "stop", "usage": {"prompt_tokens": 196309, "completion_tokens": 42487, "total_tokens": 238796, "prompt_tokens_details": {"cached_tokens": 196308}, "completion_tokens_details": {"accepted_prediction_tokens": null, "reasoning_tokens": 37796, "rejected_prediction_tokens": null}, "cost": 0, "opencode": {"billing_source": "go", "list_cost": 0.23798428, "allowance": 0.95193712, "tokens": {"input": 1, "output": 42487, "reasoning": 37796, "cache_read": 196308, "cache_write_5m": 0, "cache_write_1h": 0}}}, "elapsed_sec": 347.5, "endpoint": "https://opencode.ai/inference/go/v1", "content_chars": 8794, "had_reasoning": true, "id": "chatcmpl-7651e8b0"} -->
## 結論
**有條件收貨** —— 核心實作（journal／協議／狀態機／部署）審閱未發現 P0 級代碼錯誤，大部分驗收有真實證據；但 ⑥⑫ 兩條驗收完全冇證據、單元測試證據係一行失敗 log、交付封包缺 Dockerfile 等檔案令 build 重現唔到——呢四項 P0 清咗先可以簽 M0。

## P0（唔可以收貨，必須先改）

1. **[evidence/M0/test.log §1「單元測試」；M0/SUMMARY.md「證據檔」句＋§3 ⑫行]** 單元測試證據係失敗 log：`cmd: … node --test test/` 之後得一行 `Could not find 'test/'`。即係 `test/unit.test.mjs` 入面嘅 journal 壞尾行 truncate、計分唯一公式、頒獎 n=0/1/2 邊界、Q14 跨 00:00——**一個 passing run 都冇**。SUMMARY 話「test.log（單元＋bots＋fault，全部原始輸出）」、⑫ 又引用「＋unit test」，係超出證據嘅講法。→ 要求：`npm run build && npm test` 重跑，貼完整 spec 輸出（每個 test 名＋pass/fail）；SUMMARY 更正。

2. **[PLAN §10 M0 ⑥；test-bots-run8.log／test-bots-deployed.log「clock offset」行]** ⑥（校歪一部機 ±3 秒＋proxy 注入 200ms 單向延遲→兩機倒數差 ≤0.5 秒）**完全冇做**。現有嗰個 PASS 只係三個同機 client 計出三個一模一樣嘅 offset（`1794803450023/1794803450023/1794803450023`），證明唔到任何嘢。→ 要求：實測——一個 client 注入 ±3s 時鐘偏差，中間行 200ms 單向延遲 proxy（toxiproxy 或自寫 Node delay proxy），開一張 20 秒卡，兩邊每 500ms 讀 `endsAt − serverNow()`，極差 ≤500ms，附原始數據。

3. **[PLAN §10 M0 ⑫＋§9.1.1；evidence/M0/fault.log]** 五個指定 case（append 前 kill／write 後 fsync 前 kill／ACK 前 kill／disk full／人為壞尾行）**冇一個對號**：fault.log 得 kill -9（ACK 之後先殺）同 SIGTERM（graceful shutdown，根本唔係 fault injection）；壞尾行唯一覆蓋係 unit test，而佢冇跑到（見 P0-1）。→ 要求：①壞尾行：跑 P0-1 或人為寫壞行落 segment 再重啟驗 truncate＋replay；②ACK 前 kill：submit 後、`submit.result` 回之前殺 process，重啟後同 submissionId 重送要回 duplicate 收據、分數只入一次；③disk full：journal 目錄放細容量 tmpfs 填滿，驗 server 唔會靜靜哋死、重啟後狀態一致；④append 前／fsync 前窗口如果細到做唔到，明確講明＋交 FAULT_POINT hook 方案（見規格澄清 2）。

4. **[docker-compose.yml `build: .`；public/play.html manifest／icon 引用；scripts/sync-seed.mjs copyFileSync 迴圈]** 交付封包唔完整，由源碼重現唔到：①**Dockerfile 冇附**——compose build 指住佢，PLAN §9.8 嘅 multi-stage／`node:26-alpine`／runtime 只帶 dist＋prod deps 無得審；②`public/manifest.webmanifest`、`public/icon.svg` 冇附，但 api.log 實測 200（251 bytes）——部署 image 有檔案係交付入面冇；③`scripts/sync-seed.mjs` 第一步就 `copyFileSync(data/quiz.seed.json → seed/…)`，交付只有 `seed/` 冇 `data/`，乾淨 checkout 行 `npm run build` 即炸。→ 要求：補齊 Dockerfile＋manifest.webmanifest＋icon.svg＋data/ 兩個 seed（或改 sync-seed 只喺 data/ 存在時 copy），並由乾淨 checkout 跑 `npm run build && docker compose build && up -d` 貼 log。

## P1（實作前要改，但唔阻 milestone 收貨）

1. **[PLAN §10 M0 ⑧；.env `ACCESS_REQUIRED=0`／`PUBLIC_ORIGINS=…hbd.example.com`；RUNBOOK.md]** Tunnel hostname＋Access 兩條 policy 未設，⑧ 冇證據；.env 仲係 placeholder hostname、ACCESS_REQUIRED=0，RUNBOOK 冇「上線前 flip」一步。PLAN §9.9 自己列明呢步要 dashboard 權限，所以唔當實作錯；但開公開 hostname 之前必須：①dashboard 設 Tunnel＋`/host`、`/api/host/*` 兩條 policy ②`ACCESS_REQUIRED=1` ③真 hostname 入 PUBLIC_ORIGINS ④場外 4G 實測補簽 ⑧ ⑤RUNBOOK 補呢步。
2. **[src/server/http.ts `requireHost`；PLAN §7「所有 WS 握手同改狀態 HTTP 檢查 Origin」]** `/api/host/command`（最主要改狀態 endpoint）、`/api/host/snapshot`、`/api/host/ledger`、`/api/host/export` 冇 Origin 檢查，得具名 route specs 迴圈有——同一個 spec 兩套標準。→ 統一搬入 requireHost。
3. **[src/server/commands.ts `card.reopen` case；PLAN §6 狀態轉移表「reopen 前置 card.state=revealed」]** reopen 冇驗前置：round open 緊都可以直接 reopen（void 当前 round 開新 round），違反 §6 表。→ 加 `card.state !== "revealed" → W_STALE_COMMAND`。
4. **[PLAN §10 M0 ⑤；test-bots log]** 「多次搬組＋undo＋export→replay 後帳簿對得返數」成條鏈冇測（只做咗一次搬＋一次 undo）；0/1/2 組排版冇驗。→ bots 補：兩次搬組（follow＋stay 各一）＋undo＋`/api/host/export`→重啟→分數／帳簿逐筆對；groups.set 0/1/2/4 各一次驗組數＋組分公式。
5. **[PLAN §10 M0 ⑪；src/server/ws.ts `onSubmit`]** 缺 server-side 可測嘅部分：①reopen 後用舊 roundId 重送要 `W_ROUND_CLOSED`（bots 只測咗新 round 收 30 份）；②同 submissionId 異 payload → `W_ID_PAYLOAD_MISMATCH`；③同 ID 同 payload 重送 → duplicate 回原收據（D28「落盤後未 ACK 就 refresh」嘅 server 半邊）；④heartbeat 30 秒 timeout terminate 冇直接證據；⑤「30 bots 隨機斷線」實際只做咗 10 個。browser e2e（confirm 前後 refresh 草稿、stage／host refresh）可以正式延期到 M1 playwright，但要寫入遺留清單。
6. **[bots/bots.mjs `check("① approve 30 players…", … || true)`]** 呢行係永真假斷言，永遠 PASS。→ 改真條件（approve 完 snapshot 驗 approved==30）。
7. **[PLAN §9.1 Runtime pin；M0/SUMMARY.md §4.5]** 規格要求「全部環境綁同一 patch 版本＋交付 manifest 記錄」：本機 26.8.1、容器 26.13.1，冇 .nvmrc、冇 manifest。→ 統一 patch 或記錄差異理由＋補 .nvmrc／交付 manifest。

## P2（可以之後先改）

1. [public/index.html 內聯 `<style>`；src/server/http.ts onSend CSP `style-src 'self'`] landing 頁樣式會被自己嘅 CSP 擋——搬入 app.css。
2. [src/server/hub.ts `canAccept`／`register`；PLAN §9.6 總 socket 60] 60 上限只計 hello 完成嘅 conn；未 hello 嘅 socket 唔計數、heartbeat 亦掃唔到（永遠唔會 terminate）→ 僵屍 socket 空間。connection open 即入 pre-hello 集合計數＋清理。
3. [public/js/client/host.js `cmd()`；PLAN §7「W_STALE_COMMAND…靜默更新畫面，唔彈 error」] host 台對 W_STALE_COMMAND 會 showToast——改靜默 resync。
4. [public/js/client/stage.js `idleHtml`；PLAN §8.1 常駐分數條「所有 mode 都喺度（blackout／finale 除外）」] idle 冇分數條。
5. [public/js/client/stage.js `boot()` rules 自動翻頁 setInterval；PLAN §6.1／§8.4] 係 no-op stub（`void last`），`autoAdvanceSeconds>0` 唔會郁。M1 規則頁要實做（seed 而家全 0，唔阻 M0）。
6. [src/server/commands.ts `stage.rules`；PLAN §8.4] 出頁冇驗 phase（idle/lobby/award 應 `W_WRONG_PHASE`）同 blackout（`W_STAGE_LOCKED`）；另外 `advanceRundown` 但凡 next/prev/skip 都彈 rules，§6.1 話「轉去另一個 gameId」先觸發——同 gameId item 之間移動會多彈。
7. [src/server/commands.ts `card.open` 對 revealed 卡；PLAN §6 表] error code 用 W_STALE_COMMAND，表列 W_ALREADY_STATE／W_WRONG_PHASE。
8. [src/server/hub.ts `supersede`] 空函式 dead code，刪。
9. [src/server/commands.ts `player.approve` 對 kicked；host.js「恢復」掣] 恢復 status 但 session 已 revoke，玩家實際連唔返——要麼拒絕、要麼連 session 一齊處理。
10. [scripts/seed-room.mjs kick 迴圈；evidence/M0/deploy.log 12:31] kick 結果冇 check；seed 對部署機失敗（W_ROOM_FULL）之後，持久房 8879 嘅成功建立冇 log（12:31 fail → 12:34 已係 8879 六人房，中間嗰步冇記錄）→ check response＋補 log。
11. [PLAN §10 M0 ②「渲染完成 ≤3 秒」] 未量度（client innerHTML）——M1 playwright 一齊量。
12. [evidence/M0/reconnect.log] 冇標明觸發命令（restart 定 down/up）——下次 log 開頭寫命令。

## 逐條核對 §10 驗收標準

| # | 驗收條文 | 實作／證據 | 判定 |
|---|---|---|---|
| ① | 30 bots＋2 host＋1 stage；join p95 ≤5s／15s 內；五個 cap 逐個測 | 本機＋部署各 22/22；p95 4–10ms、total 162–516ms；第 31 approved／11 pending／6 host／3 stage／61 socket 全 `W_ROOM_FULL` | **過**（註：「approve 30」一行係 `\|\| true` 假斷言，但 cap 數字由其他行獨立支撐） |
| ② | 加 10 分→stage patch ≤1s（instrumented）；渲染 ≤3s | patch 6–20ms（bots 讀 stage view）；渲染未量度 | **部分過** |
| ③ | SIGTERM＋kill -9 各一次，分數仍在、ACK 過嘅分唔失 | fault.log：kill -9 7→7、SIGTERM 12→12；部署 restart／down+up 分數 `[11,9,7,5,3,1]` 不變 | **過** |
| ④ | open→close→tally→reveal 四元組符合 §6 表 | test.log quadruple：(playing,question,open,open)→(tally,closed,closed)→(tally,tally,tally)→(reveal,revealed,revealed)，逐格對表 | **過** |
| ⑤ | 0/1/2/4 組排版；搬 12 分人兩種語義；多次搬組＋undo＋export→replay 對數 | follow×4＋stay×1＋undo＋帳簿對數有測；多次搬組鏈、export→replay 對數、0/1/2 組冇測 | **部分過** |
| ⑥ | 校歪 ±3s＋200ms 單向延遲→兩機倒數差 ≤0.5s | 冇做；現有 log 只係同機三個相同 offset | **唔過（冇證據）** |
| ⑦ | 舊 socket 遲斷、跨 tab presence、timeout 後 resume | race（新線連上舊線斷、presence online）＋跨 tab（新舊並存）＋同 token resume 有 log；heartbeat timeout terminate 冇直接證據 | **部分過** |
| ⑧ | 場外 4G 開 `/api/host/*` 被 Cloudflare 擋；cookie＋PIN 先有 token | Tunnel／Access policy 未設（§9.9 列明要 dashboard 權限）；`ACCESS_REQUIRED=0` | **唔過（冇證據；外部工序）** |
| ⑨ | 缺 PIN／default PIN／engines.node 唔對→拒啟動 | prod-checks.log 4 case 全部 exit=78（另加 DEV_LAN_MODE=1） | **過** |
| ⑩ | commandId 冪等；同 ID 異 payload 拒；兩 host 同時 next 只行一次 | r1rev=r2rev、異 payload `W_CMD_PAYLOAD_MISMATCH`、next 1 ok＋1 `W_STALE_COMMAND` | **過** |
| ⑪ | D28 恢復矩陣全過 | 自動復線 6.4s＋新 epoch snapshot、refresh 同身份、10/30 bots 重連零重複 event；confirm前後/stage/host browser refresh、未 ACK refresh、reopen 舊提交拒絕冇測 | **部分過** |
| ⑫ | fault-injection 五 case | 得 kill -9（ACK 後）＋SIGTERM；五個指定 case 冇一個對號；壞尾行 unit test 冇跑到 | **唔過** |
| ⑬ | Docker：ready 200／restart 分數在／down-up 自動重連／30005／save-load | api.log＋deploy.log：ready 200、restart／down+up 分數不變、save 71.6MB→load 後分數在、`30005:3000`；reconnect.log 6.4s 復線；RSS 38.21MiB | **過**（reconnect.log 未標明 restart 定 down/up） |

## 實測證據可信度

- **可信**：bots 兩輪（本機 3100＋部署 30005）log 完整、時間戳 12:26–12:37 +08:00 順序一致、有命令有輸出有 exit code；api.log header dump（CSP／nosniff／no-store）齊全；deploy.log 連第一次 `docker rmi` 失敗都原樣貼出——冇斷章取義式造假嘅跡象。
- **唔夠／要重跑**：①test.log §1 係失敗 log（P0-1）；②⑥ 完全冇（P0-2）；③⑫ 五 case 冇一個對號（P0-3）。
- **講大咗嘅位**：SUMMARY 話單元測試有原始輸出（冇）；「30 bots 隨機斷線重連」實際 10 個；「渲染 ≤3 秒」未量；「approve 30」係 `|| true` 假斷言。
- **證據鏈斷裂**：deploy.log 12:31 seed-room 對部署機失敗（W_ROOM_FULL）→ 12:34 突然出現持久房 8879（六人、[11,9,7,5,3,1]），中間「wipe data＋重新 seed」嗰步冇 log——持久房嘅建立過程要補記錄；之後 down/up＋save/load 前後分數一致嘅部分本身可信。
- **含糊**：reconnect.log 冇寫觸發命令；prod-checks ④ 係臨時改 engines（`>=27 <28`）觸發——證明檢查存在，OK，但 log 冇顯示還原。
- clock offset 嗰行三個 offset 完全相同——只證明同機同鐘冇互相打亂，唔構成 ⑥ 嘅任何證據（builder 有誠實標「部分」，呢點加分）。

## 我認為規格本身要澄清嘅位

1. **⑧ 同 §9.9 時序矛盾**：⑧ 要求場外 4G 實測 Access，但 §9.9 自己寫明「部署前仲差 Cloudflare 一步（SSH 做唔到，要 dashboard 權限）」。建議寫明：⑧ 允許喺 Tunnel＋Access 設好後補簽，但補簽之前**禁止開公開 hostname**（而家 ACCESS_REQUIRED=0＋placeholder origin，一開 Tunnel 就係得 PIN 一道門）。
2. **⑫ 嘅 crash window**：「append 前 kill」「write 後 fsync 前 kill」喺 `writeSync＋fsyncSync`（冇 await）嘅實作入面窗口極細，冇 injection hook 基本做唔到。建議 PLAN 補一句：允許／要求一個 `FAULT_POINT` env 開關模擬 crash point，否則呢兩條永遠驗收唔到。
3. **⑤「0/1/2/4 組排版」冇 M0 級量度方法**：幾何驗收喺 M5 ① 先定義。建議 M0 定義收窄做「groups.set 0/1/2/4 功能生效＋組分公式正確」，幾何留 M5。
4. **（小）§7 envelope 有 `roomId` 欄**，但 §9.1.1 寫死單 instance 單房——可註明單房下 server 端可省略呢欄，免得下次 review 又當缺失。
