<!-- llm-call-meta {"requested_model": "glm-5.3", "response_model": "glm-5.3", "finish_reason": "stop", "usage": {"prompt_tokens": 343032, "completion_tokens": 10814, "total_tokens": 353846, "prompt_tokens_details": {"cached_tokens": 184}, "completion_tokens_details": {"accepted_prediction_tokens": null, "reasoning_tokens": 7127, "rejected_prediction_tokens": null}, "cost": 0, "opencode": {"billing_source": "go", "list_cost": 0.52761664, "allowance": 2.11046656, "tokens": {"input": 342848, "output": 10814, "reasoning": 7127, "cache_read": 184, "cache_write_5m": 0, "cache_write_1h": 0}}}, "elapsed_sec": 103.2, "endpoint": "https://opencode.ai/inference/go/v1", "content_chars": 6323, "had_reasoning": true, "reasoning_effort": "low", "id": "chatcmpl-2291c760"} -->
## 結論
**有條件收貨** — bots 層面（server／協議／計分／保密）M2 20/20、M3 10/10、M4 9/9 全部有真實測證據且可信；但 §10 明文要求嘅**真機／Tunnel 實測項目完全冇證據**（M2④ deck 同步、⑥ autoplay、⑦ Tunnel 30 分鐘、M3② 真機影相），呢啲係收貨條件，唔係可以靜靜哋略過嘅嘢。

## P0（唔可以收貨，必須先改）

1. **[PLAN §10 M2④／⑥／⑦；M3②] 真機實測全部缺件** → 證據：M2/SUMMARY.md 自己承認「真 browser 音訊同步未自動化」「Tunnel 長連測試冇條件做」；M3/SUMMARY.md 承認真機影相「未自動化」。M2④ 要求「media deck（Mac）播 MP3 同 stage 畫面同步 ≤0.5s」係有量化指標嘅驗收，而家只有 server 端 `playStartedAt`／`deck.ready` 協議測試（bots 層），完全冇量過真 browser 音訊起播延遲；M2⑦「Tunnel 下 WS 連 30 分鐘」零證據；M3②「主持連續影相上牆 10 張零錯誤」零證據 → 要求：按 D26「先 bots 後真機」，喺有公開 hostname（Cloudflare Tunnel ingress 設好）之後補跑：① Mac 真 browser media deck 播 MP3，量大mon 畫面切換同音訊起播時間差（≤0.5s）；② Tunnel 下 30 分鐘 WS 連線記錄；③ 真機影相上牆 10 張演示。呢三項補齊前，M2／M3 只算 bots 層面收貨。

## P1（實作前要改，但唔阻 milestone 收貨）

1. **[src/server/views.ts `buildStageView`（isSab 邏輯）＋ src/server/commands.ts `eliminateSaboteur`] M4 stage 中場唔顯示票數／淘汰名單** → 證據：views.ts 對 saboteur 卡 `counts = round.state === "open" || isSab ? zeros : ...` 且 tally `options: isSab ? [] : options`——即係**收卷開票後 stage 都永遠零票數**；crew 被淘汰後 `eliminateSaboteur` 只出 toast，唔設淘汰名單畫面。PLAN §3 表明大mon 要出「投票進度、**票數**、淘汰」，§4 寫死「stage 顯示淘汰名單」→ 要求：開票後（round closed／tally）stage 出該輪票數 aggregate（仍唔出個人票），淘汰後 stage 出淘汰名單（可用 tally mode payload 或專屬畫面）。
2. **[src/server/commands.ts `saboteur.closeRound`／`eliminateSaboteur`／`saboteur.openRound`] 直接改 live state 先過 journal commit** → 證據：`rOut.votes = ...; rOut.state = "closed"; st.eliminatedIds = [...st.eliminatedIds, targetId]; st.caught = true;` 等全部喺 `store.commit()` 之前直接寫入 `store.state.room.gameState.saboteur`（係同一個 object reference）。如果 commit 拋錯（例如 ENOSPC），memory 已變、journal 冇記錄 → 違反 §9.1.1「journal 係唯一真相」→ 要求：改成先構造新 state object 放入 `game.set` mutation，commit 後先生效（同其他 command 一致）。
3. **[src/server/commands.ts `eliminateSaboteur`] 用 `player.update {connected:false}` 標記淘汰** → 證據：`push(ctx, { t: "player.update", d: { playerId: targetId, patch: { connected: false } } })`——濫用 connected flag，淘汰者實際在線都會喺 host 台顯示離線，同 presence 邏輯（hub.register 會翻返 true）打架 → 要求：移除呢筆 mutation，淘汰狀態一律以 `saboteurState.eliminatedIds` 為準。
4. **[src/server/commands.ts `lease.acquire` forceOnline 路徑] 在線接管冇「等 ACK 最多 2 秒」** → 證據：直接 `media.set paused` 即時生效。§8.2 寫「server 叫舊 deck stop，等 ACK（最多 2 秒），然後 generation+1」。即時 pause 其實更安全（唔會雙響），但同規格唔同 → 要求：要麼補 ACK 等待語義，要麼喺 PLAN 記錄呢個簡化係 lead 拍板（而家 manifest specClarifications 冇呢條）。
5. **[src/server/commands.ts `media.play`] 冇 phase 檢查＋會搶走開住 round 嘅 stage mode** → 證據：`media.play` 冇 `ensurePlaying`，而且 `setStageIfUnlocked(ctx, { mode: "song", ... })` 會喺 bid round 仲 open 嘅時候將大mon 由 bid mode 切去 song——測試流程靠人工先 close 卡先播歌避開咗 → 要求：`media.play` 加 `ensurePlaying`；如果 currentRound 係 bid 卡且 open，要麼拒絕要麼收卷先播。
6. **[src/server/views.ts `buildPlayerView` roleInfo] `saboteurAnswer` 永遠冇內容** → 證據：`saboteurAnswer: p.secretRole === "saboteur" && card ? card.referenceAnswer : undefined`——搗蛋鬼 vote 卡冇 `referenceAnswer`，所以永遠 undefined。§4「搗蛋鬼知道正解但唔可以太明顯」喺版本 A 入面根本冇嘢可送 → 呢個係規格問題（見下節），但實作應該要麼有意義內容要麼明確講明唔適用。

## P2（可以之後先改）

1. [bots/m3.mjs `PNG_1PX`] M3①「30 張 ≤1MB 圖」用 1px PNG（~90 bytes）測，吞吐證據力度弱；建議用接近 1MB 嘅真圖重跑一次。
2. [M2/test.log vs M2/test-m2-local.log] test.log 係舊版 15/15 run（LEASE_TTL_MS=3000、唔同 roomCode），test-m2-* 係新版 20/20；兩份並存容易混亂，建議 test.log 只留最新版。
3. [M3/api.log] 有 bash 殘留錯誤（「.cache/m3files: 沒有此一檔案或目錄」）——證據檔應該乾淨。
4. [src/server/commands.ts `saboteur.openRound`] `prevMode: "rules" as unknown as Exclude<...>` 型別 cast hack；同埋 `deck.ready` 只驗 deckId＋hostId，冇驗 generation 參數（§8.2「舊 generation 指令一律拒絕」靠 lease 比對間接擋住，建議顯式驗）。
5. [src/server/hub.ts `broadcastPresence`] presence patch 唔跳 seq 但 baseSeq＝seq，邏輯啱但脆弱（依賴 client 對同 seq patch 嘅容忍）；建議加註解或測試鎖死。

## 逐條核對 §10 驗收標準

### M2（估歌關＋media deck）

| # | 驗收條文 | 實作／證據 | 判定 |
|---|---|---|---|
| ① | 30 bots 出價次序＋同價 tie-break；maxBid 拒超額 | m2 本機＋部署 20/20：兩個 90 先交者贏、120→W_BAD_SCHEMA | 過 |
| ② | 結算逐筆對帳（答對 +points／答錯 0／次高補答一半） | winner +5、backup +3（ceil）、答錯 0、防重複結算 void+重派 | 過 |
| ③ | 倒數各機誤差 ≤0.5s（注入延遲） | 沿用 M0 skew 真測（200ms 單向延遲極差 101ms） | 過 |
| ④ | deck 播 MP3 同 stage 同步 ≤0.5s、大mon靜音、reveal 前冇歌名 | 協議層過（deck.ready→playing 14–54ms、song title=null、sniffer 冇歌名）；**真 Mac browser 音訊同步未量** | 唔過（冇真機證據） |
| ⑤ | 同時只一部出聲：非 lease 拒、在線／離線接管、舊機唔准復播 | server 層全過（gen+1、margin 5s、W_NO_AUDIO_LEASE）；deck client 自我到期停播係前端 code 未 e2e | 過（server 層）／deck 自停冇真機證據 |
| ⑥ | autoplay 被擋 → stage 顯示等音源 | 前端有「恢復播放」掣＋preparing 狀態；真 browser 攔截未測 | 冇證據 |
| ⑦ | Tunnel 下 WS 30 分鐘最多斷 1 次 | 完全冇做（冇公開 hostname） | 冇證據 |
| ⑧ | 同步承諾只限 file | YouTube media.play → W_BAD_SCHEMA | 過 |

### M3（畫畫關）

| # | 驗收條文 | 實作／證據 | 判定 |
|---|---|---|---|
| ① | 30 bots 並發上載 ≤1MB 圖 15 秒內上牆 | 30/30、上牆 2–8ms（但圖係 1px，證據力度弱） | 過（證據偏弱） |
| ② | 真機：主持連續影相上牆 10 張零錯誤 | 未做（人手操作，runbook 有列） | 冇證據 |
| ③ | 計分逐筆對：人氣票 ×1＋最高票 +2 | author0=10／author1=8、最似獎 1 筆 +2、總和 30 | 過 |
| ④ | 主持 +1/+2＝作者得分、commandId 去重、0＝void | 同 commandId 兩撳 1 筆；0 後 alive=0＋voided 保留 | 過 |
| ⑤ | magic bytes／size／quota 拒偽裝 | 假 jpg／9MB → W_UPLOAD_REJECTED | 過 |

### M4（搗蛋鬼版本 A）

| # | 驗收條文 | 實作／證據 | 判定 |
|---|---|---|---|
| ① | 身份只送本人（sniffer） | stage 冇 secretRole／saboteurId；搗蛋鬼只自己見 | 過 |
| ② | 開票前 stage 只出進度、冇個人票 | mode=vote、counts 全 0 | 過 |
| ③ | 兩輪劇本含刻意平票 → 裁決計分正確 | tie→decide、retry 新 round（retryOf＋void）、二次 retry W_ALREADY_STATE | 過 |
| ④ | 投自己 W_SELF_VOTE | server 拒 | 過 |
| ⑤ | 淘汰者第二輪唔投／唔被投、保留分數 | W_FORBIDDEN_ROLE、eligible 29、冇扣分 | 過 |
| ⑥ | 揪中每位投票者 +3、冇 +5；兩輪唔中 +5 | 28 筆 +3、sabPlus5=false；+5 target 正確 | 過 |
| ⑦ | 重連唔漏身份、重開唔重複派分 | 重連 roleInfo=crew；綁 roundId／submissionId | 過 |

## 實測證據可信度

- **可信**：M2/M3/M4 本機＋部署機 bots log 有命令、時間戳、逐項 PASS detail、exit code；部署 restart 前後 state（songs／lease／playback／assets／saboteurState／revision）逐欄一致；M4 api.log sniffer 有原文。計分對帳全部逐筆核過，冇斷章取義跡象。
- **要重跑／補跑**：M2④⑥⑦、M3②（見 P0）；M3① 建議用接近 1MB 圖重跑加強吞吐證據。
- **假設／聲明**：M2 SUMMARY 對「真 browser 未自動化」「Tunnel 冇條件」係如實申報，冇講大——呢點值得肯定；但如實申報唔等於驗收通過。
- **小瑕疵**：M2 test.log（15/15 舊版）同 test-m2-*（20/20 新版）並存；M3 api.log 有 bash error 殘留；M0 api.log roomCode=3000 同 SUMMARY 房 6001 唔同（唔同 run，可接受但建議統一講明）。

## 我認為規格本身要澄清嘅位

1. **§4「搗蛋鬼知道正解」**：版本 A（潛伏者）入面「正解」指咩？搗蛋鬼關冇題目、冇 referenceAnswer 可送（`saboteurAnswer` 機制而家係空殼）。要麼 PLAN 講明版本 A 唔適用呢句、要麼定義 saboteurAnswer 內容來源。
2. **§3「競投走勢」**：lead 已拍板＝參與度（已記錄喺 DELIVERY-MANIFEST specClarifications），建議 PLAN 正文吸納，唔好長期靠 manifest 附件承載規格變更。
3. **§8.2 在線接管「等 ACK 最多 2 秒」**：實作改為即時 pause＋generation+1（更安全但唔同規格）；要麼修 PLAN 要麼修實作。
4. **§4 開票後 stage 顯示票數／淘汰名單嘅具體 mode**：而家規格只寫「開票前唔出」，冇講開票後用邊個 mode 出票數——導致實作索性全程唔出（見 P1-1）。PLAN 應寫死開票後嘅 stage 呈現。
