# PLAN-v3.1 第二輪聚焦 QA（F-01～F-06）

> 審查日期：2026-11-16（HKT）｜角色：kimi-k3.1-pro／Review & Check  
> 受審文件：[PLAN-v3.1.md](../PLAN-v3.1.md)｜對照：[上一輪 QA](plan-v31-qa.md)、[PLAN-v3.md](../PLAN-v3.md)  
> 現時行數：`wc -l`＝**940 行**；以下行號全部以呢一版為準。  
> 方法：重讀現行全文，逐項用 `grep`／`read` 對行號及交叉章節，再用 Python 3 AST／JSON 檢查舊 QUIZ 實物。只聚焦指定 6 條；舊 P1／P2 唔重列。除本報告外冇寫入任何檔案。  
> 狀態口徑：「修好但引出新問題」指原本點名嘅主條文已補，但新寫法同其他契約撞車；**唔代表可以派工**。

## Verdict

**再修：F-01、F-03 先係乾淨修好；F-02、F-04、F-06 補齊主條文但引出跨章矛盾，F-05 嘅離線到期必停仍未可實作，並且有新引入 P0，依家派工仍會出現投票、保密同音源三套實作。**

## 核對表

| F 編號 | 現時行號 | 狀態 | 備註 |
|---|---|---|---|
| **F-01 題庫匯入語義** | L56、L93、L448、L501、L728、L772–775 | **修好** | 全文已冇「一鍵匯入 QUIZ 20 題」嘅相反講法。L93：「**只匯入 MC 10 題**」，open「只顯示 diff、要主持逐題確認」；L501、L728、L775 同向。L56／L772 嘅「20 題」係 **canonical 總題庫**，唔係 legacy import 數量，兩者冇再混淆。 |
| **F-02 搗蛋鬼** | L102–117、L410、L731、L899–907 | **修好但引出新問題** | 主段已補：L109 分母＝「**有效票（已提交、非棄權）**」；L110–113 寫明第一輪揪中即完、投中者各 +3、搗蛋鬼冇 +5，兩輪唔中先由搗蛋鬼 +5；L114 重投最多一次，再平由主持裁決。不過「過半」同 B.3「最高票者淘汰」未閉合（Q2-01），重投亦未接返 round／Submission 同 +3 歸屬（Q2-02）。另見 Q2-04 公佈時機反口。 |
| **F-03 Card.version／Room.revision／reopen** | L190、L246、L258–265、L340、L462–469 | **修好** | `Card.version` 已存在（L246），`Round.cardVersion` 有對應（L259）；`Room.revision` 已定於 L190。L468 分清 `seq`／`revision`，並指定 `expectedRevision` 用 snapshot 收到嘅 `revision`。L469 可實作：只 reopen 同卡最近 round、舊自動分全 void、手動分預設保留可逐筆 void、歷史保留、新 round 同 version+1，並同一 journal transaction 先 ACK。 |
| **F-04 角色 DTO 披露矩陣** | L176、L205、L213–215、L237–245、L422–437、L483、L515 | **修好但引出新問題** | L426–432 已逐項覆蓋 `secretRole`／`saboteurAnswer`／`correct`／`explanation`／`referenceAnswer`／`actualAnswer`／`hint`／`Song.title`／`revealedRole`，三個 view 同 reveal 前後大致齊；L435 亦改用公開 `revealedRole`。但新 L176 反過來話秘密欄位「**唔會出現喺 HostView／StageView／PlayerSelfView 任何一個 DTO**」，同矩陣HostView ✅及 reveal 後披露正面衝突（Q2-03）；L110 同 L435 嘅公佈時機亦不一（Q2-04）。舊殘留 L214「大mon 永遠唔會見到」同 L515「唔會見到…正解」亦仍未補 reveal 例外。 |
| **F-05 唯一音源／AudioLease** | L45、L72、L192、L230、L497、L671、L729 | **未修好** | §3 L72 已寫死「**唯一 media deck；大mon 永遠唔出聲**」；L497 有 10 秒 heartbeat、30 秒釋放、持久化及接管；§9.4.1 L671 已改「**唔保證離線繼續出聲**」，唔再承諾恢復同一 lease。可惜 L497 冇規定 deck 收唔到 server 指令時都要喺 `leaseUntil` 本地停播，反而要求到期舊機必先收 stop＋回 ACK，斷線情境做不到，接管會卡死或迫使實作者違規放新音源（Q2-05）。 |
| **F-06 openKind／Submission／計分／validation** | L91、L136、L163–168、L241、L249–256、L417–418、L826–863、L918 | **修好但引出新問題** | `Card.openKind` 已有 `text｜number` discriminator（L241）；Submission 雖冇重複一個 `openKind` 欄，但 L167 已按 Card 型別寫死 text 用 `text`、number 用 `amount`，用錯拒絕，runtime 對應已明。L165–166 寫死字數、空值、1 位小數、0–999999／唔准負數；L91、L828、L918 分開估數字最近／並列全 +2 同短答主持關鍵詞 +2。新問題只係 L167 嘅 `W_INVALID_OPEN_KIND` 同 L418「schema 不合一律 `W_BAD_SCHEMA`」撞碼（Q2-06）。 |

## 新引入問題

### Q2-01｜P0｜「過半」冇寫明作用門檻，同 B.3「最高票者淘汰」會得出唔同賽果

- **位置行號**：PLAN L109、L903（另見 L731 M4 驗收）。
- **問題**：有效票分母係補咗，但冇完整寫「邊個要攞過半先算淘汰／揪中；唯一最高票但唔過半時點做」；附錄 B.3 仍然係無條件最高票淘汰。
- **原文證據**：
  - L109：「**過半定義**：該輪『有效票』（已提交、非棄權）**過半數**；唔夠一半但有主持裁決，裁決都算揪中。」
  - L903：「第一輪投票，**最高票者淘汰**。」
- **影響**：例如 10 張有效票分佈 4／3／3，唯一最高票得 4，未過 5；跟 B.3 要淘汰，跟「須過半」解讀就唔淘汰，而主段冇寫之後流程。若最高票正係搗蛋鬼，會直接影響即完、+3／+5。呢個唔係純措辭問題，而係 test oracle 可以兩個答案。
- **建議**：拍板並寫成一條完整條件式：候選人點樣被淘汰、是否必須 `votes > validVotes/2`、不過半嘅唯一最高票點處理、主持裁決可乜時介入；補 4／3／3 同全棄權數例，並同步 B.3 及 M4。

### Q2-02｜P0｜「重投一次」冇新 round／替換語義，同一 round 第二票會被總協議拒絕，+3 按邊次票都未明

- **位置行號**：PLAN L103、L110、L114、L117、L410；B.3 L906。
- **問題**：主持一鍵重投係今輪新增，但冇講新 `roundId`、原票作廢定覆蓋、重投候選人及 eligible 名單；總協議仍然一人每 round 只收一份最終答案。計分又只講「每位投畀搗蛋鬼嘅玩家」，未分原票定決定性重投票。
- **原文證據**：
  - L103／L114：主持可「**重投一次**」，再平先裁決。
  - L410：「**同一玩家同一 round 只收一份最終答案**；重送同一 ID 回原收據。」
  - L110：「**每位投畀搗蛋鬼嘅玩家各 +3**」；L117 只以「同一輪…綁 `roundId`」講防重。
  - L906：規則頁仍只寫「平票由主持裁決」，冇重投選項。
- **影響**：照 L410 做會拒絕重投；臨時開新 round 又可各寫各，首輪投票者同重投投票者可攞唔同 +3，甚至有機會兩邊派分。
- **建議**：明定重投创建新 `roundId`（含 `parentRoundId`／`retryOf`）或允許同一 round 一次 replacement，二擇一；寫死候選人、eligible、原票保留但不計分、只按決定性重投票派 +3、重投再平裁決點計分；同步 B.3 同 M4 驗收。

### Q2-03｜P0｜§6 新「任何 DTO 都冇秘密欄位」同 §7 HostView／reveal 披露矩陣正面相撞

- **位置行號**：PLAN L174–176 對 L422–432（另見舊殘留 L214、L237、L483、L515）。
- **問題**：為分開 ServerModel／DTO 而新加嘅總括句寫成所有秘密欄位都唔會出現喺任何 DTO；但矩陣明明允許 HostView 全部、stage／player 喺 reveal 後收答案、stage 喺 reveal 收歌名，搗蛋鬼本人又要收 `saboteurAnswer`。
- **原文證據**：
  - L176：秘密欄位只存在 server 私有 model，「**唔會出現在 `HostView`／`StageView`／`PlayerSelfView` 任何一個 DTO**」。
  - L426–431：`secretRole` HostView「✅ 全部人」、本人「✅」；`correct`／`referenceAnswer`／`actualAnswer` stage／player「✅ 只 reveal 後」；`Song.title` stage「✅ 只 `mode="reveal"`…」。
  - L435 又要求新增公開 `revealedRole`，證明公開 DTO 並非完全冇身份相關欄位。
- **影響**：照 L176 做，主持睇唔到正解／貼士、搗蛋鬼收唔到專用正解、reveal 亦冇資料；照矩陣做就違反 §6。實作者為「兩邊都顧」而直接 spread server model，正正會造成秘密外洩。
- **建議**：將 §6 改成「以下係 server 內部 model；三個 DTO 由明確 allowlist 投影，unfiltered model 永不直送」；分別定義 pre-reveal／post-reveal DTO variant，`secretRole` 本人／host、`saboteurAnswer` 只搗蛋鬼、公開身份只用 `revealedRole`；同時將 L214 改成 reveal 前禁止、L515 補 reveal 後例外，唔好再留絕對句。

### Q2-04｜P1｜揪中後身份係自動即場公佈，定等主持再撳，§4 同 §7 未統一

- **位置行號**：PLAN L110 對 L432、L435；M4 L731。
- **問題**：新增第一／第二輪統一結算話揪中即場 `role-reveal`，但 DTO 段仍然以主持「公佈身份」按鈕做披露閘口。
- **原文證據**：L110「搗蛋鬼即場淘汰、**公佈身份**（`mode="role-reveal"`）、遊戲即刻完結」；L435「**只有主持撳咗『公佈身份』之後**才出現在 stage／player DTO」。L432 表格另寫「開票後」，同「主持撳咗」都唔係完全同一時點。
- **影響**：一套實作會自動切 stage，另一套會停喺投票結果等主持；Players 收到 `revealedRole` 嘅時間同 M4 劇本亦會唔同，現場流程多一個無定義狀態。
- **建議**：二擇一：揪中 transaction 自動寫公開 `revealedRole`＋切 `role-reveal`；或者揪中即完但待主持發佈，並將 L110 改成「淘汰／結算即時，身份待公佈」、補 command／endpoint 同 stage 中介態。表格「開票後」亦改做同一確切條件，M4 加自動／手動其中一條驗收。

### Q2-05｜P0｜AudioLease 斷線到期要「先收 stop＋ACK」不可達，仍冇 deck 自主到期必停

- **位置行號**：PLAN L230、L497、L671、L729。
- **問題**：server 30 秒自動釋放同新 deck 必須等舊 deck stop ACK，喺舊 deck 斷線時互相卡住；`leaseUntil` 雖存在，但冇條文要求舊 deck 用校準時鐘喺到期時自行停。§9.4.1 只係「唔保證」離線出聲，並唔係防止雙響所需嘅禁止／到期停止契約。
- **原文證據**：
  - L497：「每 10 秒 heartbeat…**30 秒冇心跳即自動釋放**」；但同句亦寫「lease 到期／被接管時，舊 deck **必先收到 stop 指令並回 ACK，之後才准新 deck 出聲**」。
  - L671：斷網超過 30 秒 lease 會釋放，返線重新申請；只話「**唔保證離線繼續出聲**」。
  - L729 驗收只有一般「接管音源測試」，冇舊機離線到期再接管 case。
- **影響**：舊機斷線時永遠收唔到 stop／回唔到 ACK，新音源會無限期被禁；若實作者略過 ACK 又可能同仍喺離線播放嘅舊機雙響。即係「30 秒釋放」並未變成可實作嘅「到期必停＋安全接管」。
- **建議**：lease 加 generation／fencing token，server 拒絕舊 generation；deck 取得 `leaseUntil` 後以 server offset＋monotonic clock自我管理，**即使收唔到 stop 都最遲喺到期即靜音／pause**。在線接管可先 stop ACK；失聯接管唔等永遠唔會到嘅 ACK，而係等舊 lease 到期加安全 margin 才發新 lease。M2 必測舊機播歌中斷網 30+ 秒、舊機自行停、新機接管一曲唔雙響、舊機返線唔准復播；§9.4.1 同期改成明確離線播放 policy。

### Q2-06｜P1｜新 openKind 錯欄 error code 同「schema 不合一律 W_BAD_SCHEMA」衝突

- **位置行號**：PLAN L165–167、L417–418。
- **問題**：`W_INVALID_OPEN_KIND` 已加入封閉清單係好事，但用途同總錯誤規則冇劃清。number 卡送 `text` 本身正係 payload schema 不合，L167 指定一個碼，L418 又話一律另一個碼。
- **原文證據**：L167「用錯欄位 → **`W_INVALID_OPEN_KIND`**」；L418「malformed JSON／**schema 不合一律用 `W_BAD_MSG`／`W_BAD_SCHEMA`**，唔可以自創」。
- **影響**：server 同 client 可以各自選碼，前端只 switch code 就可能漏處理；negative contract test 無唯一預期。
- **建議**：最簡單係 L418 補明確例外：結構／型別 schema 錯用 `W_BAD_SCHEMA`；結構合法但與 `Card.openKind` 唔匹配用 `W_INVALID_OPEN_KIND`，並喺 M1 加 text／number 交叉 payload、空值、小數位、負數同上下界測試。否則刪專用碼，全用 `W_BAD_SCHEMA`。

## 實證摘要

- `wc -l game-platform/PLAN-v3.1.md`＝**940**；舊 QA 審嘅 875 行行號已唔再套用。
- 全文 grep `一鍵匯入.*20 題`、`匯入.*QUIZ.*20 題`、`匯入.*20 題`、`QUIZ 陣列（20 題）` 等相反模式 **0 match**；現存匯入條文全部係「legacy 只 MC 10＋open diff」，「20 題」只保留做 canonical 總數。
- Python 3 AST 解析 [live_page.py:7](../../deploy/live_page.py#L7)：`QUIZ=20；MC=10；open=10`；JSON 解析 [quiz.html:245](../../deploy/site/crew/quiz.html#L245) 得 20 題，同 live QUIZ 轉 list 後 **deep-equal=True**。呢個只確認舊來源實物，唔代表新版 open 題由佢匯入。
- 交叉讀取 L97–117、L163–168、L174–312、L399–469、L491–517、L638–674、L723–732、L772–918；指定關鍵字 `openKind`、`AudioLease`、`heartbeat`、`secretRole`、`saboteurAnswer`、`revealedRole`、`referenceAnswer`、`actualAnswer`、`Card.version`／`version`、`revision`、`expectedRevision`、`reopen`、`匯入` 均已用現檔核對。
- 快速 scan 未見今輪新造嘅錯 § 編號：§5.3（L163）、§6／§7、§8.2（L491）、§9.4.1（L638）實體都存在；問題係上述**內容互相矛盾**，唔係單純斷鏈。舊 P1／P2 冇借呢輪重新申報。
