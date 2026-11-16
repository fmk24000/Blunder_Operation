# PLAN-v3.1「Review & Check」獨立對抗式 QA

> 審查日期：2026-11-16（HKT）｜角色：kimi-k3.1-pro／Review & Check  
> 方法：完整閱讀 v3.1 全部 875 行，以 diff 心態對照 v3、final check、三份舊審查及規則頁原規格；再用 `read`／`grep`／`glob`／`wc`／`stat`／`pdfinfo`／`pdftotext`／Python AST、JSON 與逐字比對實證。除新增本報告外，冇修改任何檔案。  
> 判定口徑：「通過」只代表該項 **P0 目標已寫死**，唔代表冇 P1／P2；「唔通過」代表仍有會令實作分歧、計錯分、漏秘密或令承諾失效嘅矛盾。  
> 行號簡寫：`v3.1:Lx`＝[PLAN-v3.1.md](../PLAN-v3.1.md)；`v3:Lx`＝[PLAN-v3.md](../PLAN-v3.md)；`final:Lx`＝[PLAN-v3-FINAL-CHECK.md](../PLAN-v3-FINAL-CHECK.md)；`rules-spec:Lx`＝[spec-rules-page.md](spec-rules-page.md)；`live:Lx`＝[live_page.py](../../deploy/live_page.py)；`html:Lx`＝[quiz.html](../../deploy/site/crew/quiz.html)；`print-task:Lx`＝[TASKS-print-pack-rebuild.md](../TASKS-print-pack-rebuild.md)。

## 0. Verdict（可以派工 ／ 要再修：一句話＋理由）

**要再修：9 個 P0 只有 4 個通過（P0-1／3／5／9）；題庫匯入仍然一句話 20 題、一句話只 MC，Round／revision 同重開舊分契約未閉合，角色 DTO 未覆蓋潛伏者同公開揭曉，音源又有「大mon 都可以出聲」同離線 lease 雙響漏洞，依家派工仍會各寫各。**

- 本輪新確認／修補後新暴露嘅 finding：**20 條＝P0 6、P1 10、P2 4**；呢個數包含「舊根因未修淨、今輪先確認到具體斷點」，唔係話 20 條全部由 v3.1 新製造。
- 最嚴重三條：**F-01（canonical 匯入互相矛盾）／F-03（revision＋重開舊分冇可實作契約）／F-04（私密正解同身份 DTO 未閉合）**。
- 實物警戒線：**print-pack 存在，但仍是舊題＋30 秒，重建工作單未開始；唔可以當新版最後防線已可用。**呢點係已知未完成工序，唔當新 regression（`print-task:L4,L40`）。

## 1. P0 核對表（一定要 9 行，每行：P0 編號｜已修？｜證據行號／原文｜有冇殘留問題｜判定）

| P0 編號 | 已修？ | 證據行號／原文 | 有冇殘留問題 | 判定 |
|---|---|---|---|---|
| P0-1 唯一權威文件 | 已修 | v3.1:L6「呢份係**唯一權威規格**」；[00-INDEX.md:6-10](../00-INDEX.md#L6-L10) 同樣指定唯一權威；[PLAN-GPT.md:1-3](../PLAN-GPT.md#L1-L3)／[TASKS-GPT.md:1-3](../TASKS-GPT.md#L1-L3) 已標「另案」；v3:L1 已標歷史 | 索引行數仍寫錯（F-20），但唔影響主次 | **通過** |
| P0-2 題庫 canonical（D34／附錄 A／一鍵匯入語義） | 未修淨 | D34 有寫：v3.1:L56「附錄 A 新版 20 題（MC 10 題沿用…open 10 題新寫）」；L710「只匯入 MC 10 題」；但 L93、L436 仍寫「一鍵匯入…QUIZ…20 題」 | 兩種匯入語義直接打架；seed 只在 export 出現，未見實體 canonical seed；Q9 亦唔係絕對逐字（F-01、§3、§4） | **唔通過** |
| P0-3 網絡拓撲＋server 留屋企＋熱點後路（D31／§9.2–9.3） | 主線已修 | D31（v3.1:L53）；L530「屋企 Windows server…唔會搬去場地」；L536 明寫場地冇 LAN 後路；L556-559 分開場地 Wi-Fi／屋企 WAN／server 三種故障，熱點只救場地 WAN | 屋企 LAN 綵排會撞公開 hostname Origin 檢查（F-11），屬 P1 實作阻礙 | **通過（附 P1）** |
| P0-4 三個 game 計分（§4／§5.1／§3.1＋畫畫） | 未修淨 | 拍賣有 §5.1（v3.1:L141-147）；估數字有 L89-91；搗蛋鬼有 L101-112；畫畫只在驗收 L665 同附錄 B L820-830 寫公式 | 第一輪淘汰真正搗蛋鬼後流程／+5 無定義（F-02）；畫畫最高票平手、自投同每票 target 未寫死（F-08） | **唔通過** |
| P0-5 狀態機主從（§6） | 主從已修 | v3.1:L283-298：L289 `Card.state`「唯一遊戲進度權威」、L291 `StageState.mode`「派生＋可覆寫」、L294 priority、L298 snapshot 同帶四層且 client 唔准推導 | M0 所謂「符合 §6 狀態機表」其實缺逐 action 預期 tuple 表（F-16）；「三元組」實列四值（F-18） | **通過（附 P1／P2）** |
| P0-6 Round／roundId（§6／§7） | 未修淨 | 已有 `Room.rounds/currentRoundId`（v3.1:L164-165）、`Submission.roundId/payloadHash`（L219-226）、`Round`（L228-235）、`ScoreEvent.roundId/submissionId`（L237-243）、submit 綁 round（L362-363） | `Round.cardVersion` 對應嘅 `Card.version` 唔存在；reopen 只講 round void，冇舊自動分點作廢；M1「舊分按規則作廢」所指規則不存在（F-03） | **唔通過** |
| P0-7 host command envelope＋角色 DTO／保密（§7） | 未修淨 | Envelope 同冪等條文確實存在（v3.1:L398-404）；三個 view 名稱同階段披露亦存在（L371-374） | `expectedRevision` 冇 model／snapshot 對應；共用 type 仍有秘密；潛伏者正解、公開身份 reveal、`referenceAnswer/actualAnswer` 冇完整披露規則；「最後指令為準」仍打架（F-03／F-04／F-09） | **唔通過** |
| P0-8 media deck 唯一音源 AudioLease（§6／§8.2） | 未修淨 | `MediaPlayback.deckId`（v3.1:L197）、`AudioLease`（L202）、§8.2 lease／接管／ready ACK（L432）、M2 雙 host 驗收（L664） | §3 仍准「音源＝media deck 或大mon」（L72）；30 秒釋放同「離線音樂仍可用／恢復同一 lease」冇防雙響；lease 續期、落盤及到期停播未寫（F-05） | **唔通過** |
| P0-9 每關規則頁（§6.1／§8.4／附錄 B） | 核心需求已修 | `Room.rulePages`（v3.1:L161）、rundown override／fallback（L182-186）、RuleBlock／RulePage（L262-280）、§6.1 自動觸發同純顯示態（L300-307）、§8.1／§8.4 版面編輯（L422,L456-492）、附錄 B 四關（L804-854） | `image` block 冇圖片來源欄；原規格部分分頁／重入／fallback／multi-host 驗收喺 merge 時甩咗（F-14／F-15）；D30 缺右括號（F-17） | **通過（附 P1／P2）** |

**小結：4／9 通過；5／9 唔通過（P0-2、P0-4、P0-6、P0-7、P0-8）。**

## 2. 新發現（P0／P1／P2，逐條：位置、問題、證據原文、影響、建議）

> 「新發現」包括：v3.1 修補直接引入嘅矛盾、merge 時甩漏，以及舊根因喺今輪先確認到嘅具體未閉合位；刻意留低嘅舊 P1／P2 統一另列 §3。

| ID | 位置 | 問題 | 證據／原文 | 影響 | 建議 | P |
|---|---|---|---|---|---|---|
| F-01 | v3.1:L93,L385,L436,L663,L710 | **一鍵匯入仍然兩個講法，D34 未真正壟斷。** | L93／L436：「QUIZ…20 題」；L385／L710：「只 MC／只匯入 MC 10 題」；M1 L663 又係「匯入 MC」 | 實作者可合法匯入舊 Q12–18、Q20，蓋走 8 條新版 open 題，帶返「兩隊估」語義 | 刪走兩句「20 題」；規定 canonical seed 為唯一來源，legacy 按鈕只讀 MC 10 題；open 只可顯 diff、唔准覆蓋；逐欄 deep-equal 驗收 | P0 |
| F-02 | v3.1:L99-110,L666,L838 | **第一輪已淘汰真正搗蛋鬼時，兩輪規則斷裂。** | L838「第一輪…最高票者淘汰」；L104「第二輪唔可以…被投」；但 L109「揪中＝第二輪…」；L110 又只講「兩輪都揪唔中」+5 | 真搗蛋鬼第一輪出局後第二輪唔可能再被投；遊戲會唔會停、邊個 +3、佢算唔算潛伏成功完全可各寫各 | 拍板第一輪揪中係即刻結算定唔公開身份繼續；寫明 +3/+5、投票過半分母（eligible 定有效票）、重投再平票處理，加兩輪完整數例 | P0 |
| F-03 | v3.1:L204-243,L290,L359,L384,L399-404,L663 | **Round 有殼，version／revision 同重開計分契約未閉合。** | L229 用 `cardVersion`，但 Card L204-217 冇 `version`；L399 用 `expectedRevision`，Room／snapshot 只有 `seq`；M1 L663「舊分按規則作廢」，全文冇該規則 | client 無從填正確版本；重開可留舊分再加新分，或誤 void 另一張卡已完成 round；雙 host 互斥可因各解讀 seq／revision 而失效 | 加 `Card.version` 並在 card/reveal patch 曝光；明定 revision＝邊個持久序號及作用域；reopen 限同一 card 被取代 round，定明舊自動分 void、手動分政策、歷史保留、同一 journal transaction | P0 |
| F-04 | v3.1:L153,L180,L189,L204-216,L371-374,L99,L109 | **三個 view 仍只係名單，私密資料生命周期有洞。** | §6 標「前後端共用同一套 type」但 Player／Card 同時含秘密；L373 只准 `secretRole` 本人、`correct/explanation` reveal 後送一般 player；L99 卻要求潛伏者開場知正解，L109 要公佈身份；`referenceAnswer` L211、`actualAnswer` L216 又唔在披露清單 | 一邊會漏正解／open 答案／秘密身份；另一邊為做玩法會把 server model 全送，搗蛋鬼亦收唔到應有正解 | 分開 ServerModel 同三個真正 DTO allowlist；補 `saboteur-self-answer`、公開 `role-reveal`、open `referenceAnswer/actualAnswer` reveal 前後規則；sniffer 逐角色逐階段驗 snapshot／patch／HTTP／build／localStorage／export | P0 |
| F-05 | v3.1:L72,L197-202,L432,L606 | **唯一音源同 lease 恢復承諾互相排斥。** | L72「音源＝media deck 或大mon」；L432「唯一 active 音源」＋斷線 30 秒釋放；L606「音樂仍然離線可用；恢復同一音源 lease，唔會變雙重音源」 | 大mon 可成第二音源；舊 deck 離線照播、server 30 秒後放新 deck 就雙響；逾 30 秒返線亦唔保證取返同一 lease | 移除大mon 音源選項；持久化每房 active lease，寫明 heartbeat 續期、deck 到期必停、接管屏障、逾期重新申請；離線只准保留 cached 檔，唔准保證繼續出聲 | P0 |
| F-06 | v3.1:L131,L205,L219-226,L450,L761-798；print-task:L25 | **open 題冇 text／number discriminator，最低交付 M1 都未可照 schema 做。** | Card 只有 `type="open"`；Submission 同時有 optional `amount/text`；§8.3 要揀數字鍵盤定文字框；附錄同時有估數字同短答；工作單另寫 `open-number/open-text`，又同 PLAN 唔同 | 前端唔知出邊種輸入；同一提交可用 text 或 amount，server 難做 runtime validation 同最近距離計算 | 用 discriminated union（`open-number/open-text` 或 `openKind`），Submission payload 跟型別；定小數、負數、範圍、單位同空字串規則，對齊 seed 工作單 | P0 |
| F-07 | v3.1:L55,L609,L667,L703,L870；對照 v3:L407 | **D33 已砍 SW，但舊離線 app-shell 段全文留低，變成直接反口。** | D33／M5／DoD「唔做 service worker」；L609 卻要求「可離線 app shell」「M0 驗…完全離線 refresh」「service worker 只 cache…」 | M0／M5 scope、隱私 cache 同驗收完全唔同；跟 L609 做就違 D33，跟 D33 做就唔過 L609 | 以 D33 為準刪 L609 的 SW／app-shell／M0 離線 refresh 要求；只保留頁面仍在時最後畫面同同源 storage，重寫 warm/cold reload 例外 | P1 |
| F-08 | v3.1:L438,L665,L825-830 | **畫畫有基本分式，但唔係完整「唯一定義」。** | M3「人氣票 ×1＋最高票額外 +2」；附錄 B「每得一票 +1」「一人一票」；§8.2 評審台仍只寫 +1/+2；冇最高票平手／自投規則 | 並列最高票可 +2 俾一張、全部或主持抽；自投可改變賽果；每票 target 只靠 M3 另一點間接推斷 | 補正式畫畫計分小節：每票 `target=作者 player`、每輪一人一票、自投准唔准、最高票平手全部額外 +2 或 tie-break、host 分 commandId／undo，附數例 | P1 |
| F-09 | v3.1:L403,L428 | **多 host 一句「最後指令為準」仍同 expectedRevision 單一 winner 講法未收口。** | L403「兩個 host 同時撳只有一個成功」；L428「操作以最後指令為準，冇 conflict lock」 | next／reveal／reopen 可有人照 L428 接受後到命令，另一人照 L403 拒絕 stale | L428 收窄做「可疊加／純顯示命令最後成功者生效；破壞性命令必用 expectedRevision， stale 唔執行」 | P1 |
| F-10 | v3.1:L637,L662 | **總 socket 上限 60，驗收卻要求第 41 個就滿。** | L637「總 socket 60」；M0 L662「第 41 個 socket…→ W_ROOM_FULL」 | 同一 server 實作唔可能同時符合兩句，M0 可以假過或誤拒合法連線 | 統一 cap 同溢出 case；分開測第 31 approved、pending 11、host 6、stage 3、總 socket 61，另測舊 socket 重疊 | P1 |
| F-11 | v3.1:L409,L411,L561,L638 | **LAN 綵排豁免 Access，但冇豁免／配置 LAN Origin。** | L409／L638 只准公開 hostname；L561 叫用 `http://192.168.x.x:3000`；L411 `DEV_LAN_MODE` 只寫「跳過 Access」 | 照文件綵排時 IP Origin 會被 WS／改狀態 HTTP 拒絕，P0-3 嘅彩排路徑行唔通 | DEV_LAN_MODE 下加明確 LAN Origin allowlist（192.168 IP＋port），production 仍拒 flag；M0 加 HTTP IP join／host／WS 實測 | P1 |
| F-12 | v3.1:L368-369,L432,L639,L664,L443 | **「穩定 error code 清單」未包含實際使用碼。** | `W_NO_AUDIO_LEASE` 出現於 L432/L664，但 L369 清單冇；L639 schema 不合仍用 `W_BAD_MSG`，清單另有 `W_BAD_SCHEMA`；規則 409 亦冇指定碼 | 前端無法只 switch code；新音源分支會漏處理，規則 multi-host 亦只能靠文字 | 由單一 error registry 生成 protocol 同 UI；補 `W_NO_AUDIO_LEASE`、rules conflict code，統一 `W_BAD_SCHEMA` 用法並做 negative contract tests | P1 |
| F-13 | v3.1:L197-200 | **pause／resume 公式引用不存在欄位，而且秒／毫秒混用。** | L199「已播秒數＝`accumulatedMs`＋(now−`resumeStartedAt`)」；MediaPlayback 只有 `playStartedAt/pausedAt/accumulatedMs`，冇 `resumeStartedAt`；`Ms` 相加又被叫秒數 | refresh／pause 後播放位置可跳錯或差 1000 倍，M2 ≤0.5 秒承諾失守 | 用 `positionMs`、`resumedAt`、`pausedAt` 明確狀態；全部 ms，寫 pause／resume／seek／refresh 不變式及 fixture | P1 |
| F-14 | v3.1:L262-270,L467；rules-spec:L33-43 | **保留 `image` block，卻冇欄位指向圖片。** | RuleBlock 只有 `text`（image alt）、items、value、icon、emphasis；§8.4 又准 1MB 上載圖；原規格 L33 至少標「上載圖（url）」 | image block 無法渲染，MIME／size 驗完都冇 asset 可綁 | 加 `assetId`／`imageUrl` 同 host 上載關聯、下載授權；或者按原規格裁剪建議直接砍 image block | P1 |
| F-15 | v3.1:L303,L422,L443,L663,L667；rules-spec:L89,L159-163,L202-222,L244-253 | **規則頁 merge 甩咗原規格部分流程資料同客觀驗收。** | v3.1 自動觸發只寫 `rundown/next`，原規格 L89 包括重玩／跳返；原規格 stage payload 有 `pageIndex,totalPages`、B4 有 JSON seed、8 條驗收含 fallback／multi-host／分頁；v3.1 M1/M5 冇齊呢啲 case | 重入同一 game 可唔出規則；分頁各機狀態靠估；「seed 可直接用」仍要人手翻譯；已有需求驗收覆蓋倒退 | 將重入／prev／reorder 行為、`pageIndex,totalPages`、machine-readable seed 及原 8 case 補回 M1；至少保留 fallback、version conflict、重啟、分頁驗收 | P1 |
| F-16 | v3.1:L283-298,L662 | **M0 引用嘅「狀態機表」唔係可逐步核對嘅 transition table。** | M0 要求 open→close→tally→reveal 每步四值「符合 §6 狀態機表」；§6 只有主從／priority，尤其冇 `closed` 應顯示邊個 mode、手動 override 後何時再派生 | 同一條驗收可以有多套預期，主從修好但 test oracle 仍不唯一 | 補 action×前置×Card/Round/mode/phase／lock/blackout 結果表，列錯誤碼同 host 手動覆寫後行為 | P1 |
| F-17 | v3.1:L52 | **D30 表格括號未收。** | 「後台可編輯（§6.1／§8.1／§8.4 | 已拍板」 | 輕微文件破損，易令之後 patch 表格再錯位 | 補「）」 | P2 |
| F-18 | v3.1:L662 | **「三元組」實際列四個值。** | 「狀態三元組…`phase/mode/card.state/round.state`」 | 數字命名錯，review／test report 容易照錯 | 改「狀態四元組」 | P2 |
| F-19 | v3.1:L868 | **改動摘要所引「三個 game 計分」位置漏咗畫畫。** | 摘要只列「§4、§5.1、§3.1」，§3.1 係問答；畫畫實際散落 M3 L665／附錄 B L820-830 | 追蹤者會以為第三個 game＝問答，搵唔到 P0-4 的畫畫權威段 | 摘要列明「搗蛋鬼／拍賣／畫畫（另補估數字）」及正確章節；最好新增正式畫畫小節 | P2 |
| F-20 | [00-INDEX.md:10,28](../00-INDEX.md#L10-L28)；v3:L1 | **實際行數同索引／受審聲稱對唔上。** | 實測 v3.1＝875 行（index 寫 874）；目前 v3＝587 行（舊稱 585，後加兩行歷史標頭） | 唔改變玩法，但證明文件元數據未回寫，引用舊行號會漂移 | 報告／index 用當次量度值；v3 備註「585 行舊版＋2 行歷史標頭＝587」 | P2 |

## 3. 仍然存在嘅已知問題（對照之前份 final check，逐條講邊啲係刻意留低嘅 P1／P2，唔好當新嘢）

> 以下直接按 [PLAN-v3-FINAL-CHECK.md](../PLAN-v3-FINAL-CHECK.md) §4 的 P1-1–P1-16、§5 的 P2-1–P2-8 逐條回帳。**§2 已詳述嘅只留狀態，唔當第二次新發現。**「刻意留低」指文件已承認未做／延後，唔代表可以無視上場閘口。

### 3.1 舊 P1 回帳

| 舊 ID | v3.1 現況 | 證據 | 結論 |
|---|---|---|---|
| P1-1 token 壽命／多開／Access 關係 | 8 小時、hash、撤銷、續期已補 | v3.1:L380,L407-411,L442,L689 | **大致已修**；5 個有效 token 同 WS 只靠 host token 未完全明寫，殘餘 P1，唔係新問題 |
| P1-2 clock offset 忽略 RTT | 已改 3 次 ping、最低 RTT、performance.now、延遲注入 | v3.1:L613-630,L662 | **已修** |
| P1-3 HTTP 路線覆蓋不足 | groups／quiz／awards／ledger／media／代答已補；**歌單 CRUD／試播仍冇 `/api/host/songs`** | v3.1:L378-396 對 L437 | **部分留低 P1**；唔係新問題 |
| P1-4 model 缺欄位 | category／hint／deckId／roundId 已補；bidMode 刻意砍；Card.version、songId、auto-close config 仍缺 | v3.1:L204-243；L137 | **部分留低**，其中 version 已升做 F-03 P0；其餘唔當新問題 |
| P1-5 手機輸入敘述矛盾 | §2 已改「有限表單」；但 §3 關 4 同 §3.1 仍只寫 A／B／C／D／四粒掣 | v3.1:L64 對 L75,L83,L450 | **部分留低 P1**；open subtype 的致命位見 F-06 |
| P1-6 eligible roster／代答 | roster 鎖定、offline 照計、late join、`onBehalfOf/byHost` 已補；auto-close 開關仍無 config 欄，移除資格流程未齊 | v3.1:L89,L219-235,L393 | **大致已修，殘餘 P1**；唔當新問題 |
| P1-7 Q14 時間基準 | `closedAt`、HK 時區、下一個 00:00、floor、fixture 已寫 | v3.1:L89,L231,L663,L774-775 | **已修** |
| P1-8 換組 replay 契約 | void＋group 補償＋lineage＋membership＋同事務＋多次 replay 驗收已補 | v3.1:L323-327,L662 | **已修** |
| P1-9 crash durability | manifest／segment／checksum／fsync／五類 fault injection 已補 | v3.1:L516-524,L662 | **已修** |
| P1-10 最後防線／PDF／睡眠 | 每關 export＋紙本 checkpoint、睡眠／Auto-Lock／試播已補；**PDF 實物仍舊，工作單未開始** | v3.1:L677,L681,L685-689；print-task:L4,L8-17,L40 | **規格已修、實物未修**；係已知上場 P0 閘口，唔當新 regression |
| P1-11 上傳／顯示安全 | magic bytes、size／pixel／duration、quota、隨機 ID、nosniff、CSP 已補；全端 text-node escaping、媒體下載授權／Range 未齊 | v3.1:L653；final:L165 | **部分留低 P1**；唔當新問題 |
| P1-12 30 players／pending／socket cap | approved／pending／host／stage／總 socket 已定義，30＋2＋1 topology 已寫；但 60 vs 41 新矛盾 | v3.1:L48,L637,L662 | **原缺口大致已修；F-10 係新數字矛盾** |
| P1-13 組數上限／版面矩陣 | `0..30`、1 組、5+、30 人、長名已在 model／驗收出現；30 組、長組名、archived 行為仍未完整 | v3.1:L159,L424,L662,L667 | **部分留低 P1**；唔當新問題 |
| P1-14 驗收無 protocol | join p95、全部 15 秒、patch≤1秒、30 receipt、媒體上載、斷線容忍已量化；N／重複次數／冷暖和 LAN/Tunnel 全矩陣仍未盡齊 | v3.1:L658-669 | **大幅改善，仍有刻意留低 P1**；唔逐項當新問題 |
| P1-15 前端框架／PWA 範圍 | 仍然「React／Vue／vanilla 三揀一，開工前定」；PWA 主決策砍 SW，但舊段未刪 | v3.1:L650,L55,L609 | **框架係刻意留低 P1**；SW 反口已列 F-07 |
| P1-16 穩定 error code | 18 碼清單已加，但使用中的 `W_NO_AUDIO_LEASE` 漏咗 | v3.1:L368-369,L432 | **部分留低**，具體新斷點見 F-12 |

### 3.2 舊 P2 回帳

| 舊 ID | v3.1 現況 | 證據 | 結論 |
|---|---|---|---|
| P2-1 SESSION 舊快照 | 檔頭已標歷史快照／以 v3.1 為準；內文舊數字保留 | [SESSION:1-3](../SESSION記錄_PLAN-v3定案.md#L1-L3) | **已用歷史標記處理**；唔再當現行錯誤 |
| P2-2 PLAN／v2／TASKS 歷史標記 | 三份都已有「已被 v3.1 取代」標頭 | [PLAN:1](../PLAN.md#L1)、[PLAN-v2:1](../PLAN-v2.md#L1)、[TASKS:1](../TASKS.md#L1) | **已修** |
| P2-3 D13 原意 | 仍只寫「v3 廢…冇後備 server」，未交代 v2 D13 原本係 Windows 後備 | v3.1:L35 | **刻意留低 P2**，唔當新問題 |
| P2-4 搗蛋鬼決策編號 | D29 已加入 | v3.1:L51 | **已修** |
| P2-5 WS 數學 | 已改 13–14；host 5 係上限亦寫清 | v3.1:L496,L637 | **已修**；第 41 個 socket 的新矛盾另見 F-10 |
| P2-6 Q9「逐字」排版 | 仍係 `2^42`，live 係 `2⁴²` | v3.1:L755；live:L36 | **刻意留低 P2**；但 D34 用「逐字」後仍應補返上標 |
| P2-7 quiz.html 初始題號 | 仍寫 `1 / 30`，JS 執行後先變 20 | html:L202,L245,L256 | **舊站 P2，依舊存在**；唔當新平台 regression |
| P2-8 RAM 估算／路徑 | RAM 已標「估算，未實測」；`deploy/live_page.py` 仍用 workspace-root 相對寫法 | v3.1:L496,L56,L93 | **RAM 已修；路徑註明 repo-root 即可，屬留低 P2** |

## 4. 實證結果（聲稱 vs 實況 vs 行號證據）

| 聲稱／檢查 | 實況 | 行號／工具證據 | 判定 |
|---|---|---|---|
| 「PLAN-v3.1＝874 行」 | `wc -l`＝**875**，Python `splitlines` 亦 875，檔尾有 newline；v3 目前＝**587** | v3.1 全檔；v3:L1 歷史標頭；[00-INDEX:10,28](../00-INDEX.md#L10-L28) | ❌ 元數據差 1；v3 差 2 有標頭原因 |
| D1–D34 編號 | 決定表實際 34 行，`[1..34]` 連續、無重複 | v3.1:L23-56 | ✅ |
| D34 真正出現次數 | **4 次／4 行**：L56,L710,L868,L869 | Python exact substring count；grep 覆核 | ✅ 有寫，但不等於修好（F-01） |
| D31 真正出現次數 | **10 次／10 行**：L28,L33,L53,L530,L536,L556,L662,L681,L868,L869 | 同上 | ✅ |
| §6.1 引用／實體 | `§6.1` **5 次**：L52,L125,L161,L422,L868；真正章節標題在 L300（標題本身冇 § 字） | 同上 | ✅ |
| §8.4 引用／實體 | `§8.4` **6 次**：L52,L305,L307,L391,L422,L868；章節標題 L456 | 同上 | ✅ |
| 附錄 B 引用／實體 | `附錄 B` **5 次**：L307,L492,L667,L804,L868；B.1–B.4＝L808,L820,L832,L844 | 同上 | ✅ 四關齊 |
| AudioLease | **4 次／4 行**：L202,L432,L664,L872；但 Room 無 `audioLease` 欄，續期／到期停播／持久化未寫 | type 在 L202；唯一音源主段 L432 | ⚠️ 有名稱，未閉合 |
| roundId | **15 次字串／14 行**：L112,L121,L147,L220,L239,L290,L362,L363,L602,L662,L663,L868,L871,L872（L147 有兩次） | Python count＋grep；實際 Round model L228-235 | ⚠️ 有 model，但 F-03 未完 |
| commandId | **7 次／7 行**：L327,L399,L400,L401,L403,L662,L665 | 同上；envelope L398-404 | ✅ 有冪等條文 |
| expectedRevision／expectedRoundId | `expectedRevision` **4 次**：L399,L402,L403,L871；`expectedRoundId` **2 次**：L399,L402 | Room L156-168／snapshot L359 無 `revision` | ⚠️ command 有用，client model 無來源 |
| canonical、「canonical seed」、seed 實物 | `canonical` **6 次**：L5,L56,L710,L868,L869,L875；精確字串 **`canonical seed`＝0**；`quiz.seed.json` 只在 L395 出現一次；全 workspace `glob **/quiz.seed.json`＝**0 檔** | v3.1:L395,L710；print-task:L25 另有建議但未實作 | ⚠️ 規格有 canonical 概念，實體 seed 未交 |
| 17 mode／6 卡型 | StageState enum 實數 **17**，§8.1 列舉亦 17；Card.type 實數 **6**，§5 表亦 6 | mode：v3.1:L247-253,L418；卡：L128-135,L205 | ✅ 無舊 `result`／Buzz 卡殘留 |
| 章節／附錄引用 | §3.1、§4、§5.1、§6.1、§8.1、§8.2、§8.4、§9.1.1、§9.2、§9.3、§9.5、§9.7、§9.8、附錄 A／B 都有實體；14 個 fence＝7 block，平衡 | 標題實位見本文 grep；重點 L79,L97,L141,L300,L417,L426,L456,L516,L526,L538,L613,L642,L648,L707,L804 | ✅ 大節無斷鏈；細內容矛盾另計 |
| live_page.py QUIZ 題數 | AST literal 解析＝**20 題：10 MC＋10 open** | live:L7-72 | ✅ |
| quiz.html 是否 QUIZ 投影 | JSON 解析＝20 題；同 live QUIZ 轉 list 後 **deep-equal=True** | html:L245；live:L7-72 | ✅，但係舊 QUIZ 投影，唔係新版 canonical |
| 附錄 A 題數／MC 逐字 | 附錄 20 題（10＋10）；Q1–Q10 prompt／options／正解全部相同；**9 條 explanation 完全相同，Q9 不同**：附錄 `2^42`、QUIZ `2⁴²` | 附錄 v3.1:L719-759；live:L10-39；Q9 對 L755 vs live:L36 | ⚠️ 語義同，但「逐字」非 100% |
| 附錄 A open 是否沿用舊 QUIZ | **唔沿用**：Q19 完全相同；Q11 改寫；其餘 Q12–Q18、Q20 共 8 條係新題。live 舊 Q12–Q18、Q20 正是影相／電量／血管／餐飯／長頸鹿頸／貓紙箱／打喊露／車牌 | v3.1:L761-798；live:L42-71 | ✅ D34 對內容來源嘅描述成立；匯入句仍矛盾 |
| print-pack.pdf 存在性 | 存在，**2,449,159 bytes**，PDF 1.4、A4、**13 頁**，CreationDate 2026-11-08 03:16:28 HKT | `stat`／`pdfinfo`；[print-pack.pdf](../../deploy/print-pack.pdf) | ✅ 只證明存在 |
| print-pack 是否已同新版 seed 重 build | **未**：`pdftotext` 有「電量」1、「血管」1、「每題 30 秒」1；「鞋碼／銀包／大帽山／20 秒／45 秒」全部 0 | [print-pack.pdf](../../deploy/print-pack.pdf)；print-task:L8-17,L40 明寫未開始／未可用 | ❌ 不能當新版最後防線 |
| service worker 次數 | `service worker` **5 次／5 行**：L55,L561,L609,L703,L870；其中 L609 係要求實作，其餘主要係禁令／豁免 | D33 L55 vs L609 | ❌ 直接內部矛盾 |
| error registry | 清單 18 個碼；全文另用到 **1 個未申報碼**：`W_NO_AUDIO_LEASE` | L369 清單；L432,L664 使用 | ⚠️ 清單不是封閉集合 |

### 總結

v3.1 唔係冇做工：唯一權威、拓撲主線、狀態主從、規則頁骨架，連同大量舊 P1（校時、帳簿 replay、耐久性、Q14、量化驗收）都確實有改善；但目前自我宣稱「9 個 P0 已寫死」（v3.1:L5,L868）仍然過早。**最少先修 F-01–F-06，再重跑一次逐字核對；print-pack 則照現有工作單完成並逐題驗收，先可以話規格可派工、實物可上場。**
