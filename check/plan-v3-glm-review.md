# PLAN-v3 派工前 final check（GLM-5.3 審查）

> 對象：`game-platform/PLAN-v3.md`（585 行）＋ `SESSION記錄_PLAN-v3定案.md`；有對照 `deploy/live_page.py` QUIZ 實物。
> 目的：M0–M5 派工前，捉出會令實作行錯路／活動當日爆嘅嘢。
> 原則：唔重複 v2 已解決（Rust、NAS 後備、「36 題」）；每條有位置、原文、可貼落 PLAN 嘅改法。

---

## A. 致命／矛盾（P0）

### P0-1　拍賣估歌（bid）計分規則完全冇定義 — 成個 Game 1 冇得實作

| ID | 位置 | 問題 | 影響 | 建議 | P |
|---|---|---|---|---|---|
| P0-1 | §3 關1（L64）、§5（L115）、§6 Card（L162–173）、M2（L443） | §5 只寫「points＝競投估歌權；seconds＝用分數買聽歌秒數」，但全份 PLAN 冇一句講：① 出價係咪扣分（seconds 模式暗示扣，points 模式冇講）；② 贏家答啱／答錯各幾多分；③ 輸家分數點變；④ 正解（歌名）幾時揭、答錯之後係咪重拍；⑤ points 模式「競投估歌權」係最高價得標定唯一出價得標；⑥ seconds 模式「直接餵 playWindow」多位出價者點處理。`Card` 有 `maxBid`、`points` 但冇 bid 結算欄位（如 `settleMode`、`winReward`）。M2 驗收只寫「出價次序正確」，完全冇計分驗收 — 工程隊會各自發明規則，做到一半發現同主持玩法對唔上要重寫。 | Game 1（第一個開場環節）無法派工；做到都係空殼，活動當日計分亂。 | 喺 §5 後加一節「§5.1 拍賣估歌結算（唯一定義）」，直接貼：**points 模式**：每位玩家密封出價（0 至 maxBid）；最高價獨得估歌權（同高→先交者）；出價唔扣分；得標者於 playback 後限時 10 秒內經 host 揭答案——答啂 +N（＝card.points，預設 5），答錯 0 分且**次高價者可補答**（主持可選開關，補中得一半分）；正解喺 host 撳 reveal 先 broadcast。**seconds 模式**：出價即承諾扣分，收拍後最高價者扣「出價秒數÷10（無條件進位）」分，換取該秒數 playWindow；答啂另加 card.points；答錯唔退款；其餘玩家 0 變動。兩種模式結算都寫入帳簿 reason「估歌 S3・mode=points」。M2 驗收加一條：「bots 預設劇本跑一輪 points＋一輪 seconds，分數同預期逐筆對得上」。 | P0 |

### P0-2　搗蛋鬼計分對象同兩輪投票規則未定義 — Game 3 計分會計錯人

| ID | 位置 | 問題 | 影響 | 建議 | P |
|---|---|---|---|---|---|
| P0-2a | §4（L91）、§6 ScoreEvent（L181–184） | 「揪中每人 +3」——揪中＝投畀搗蛋鬼嘅每位玩家各 +3（target=player），定係全場每人 +3、定係組 +3（target=group）？§6 帳簿只有 player/group 兩種 target，PLAN 冇講邊種。「生存到最後搗蛋鬼 +5」——如果第二輪已被揪中，遊戲即完結，「生存到最後」係指兩輪都未被揪中先 +5，定係任何生存者都有分？ | 計分公式係全平台地基（§6 講明「唯一公式」），呢兩筆係 Game 3 唯一計分事件，寫錯 target 類型直接計錯。M4 驗收只有 sniffer 檢查，冇計分驗收。 | §4 加：「揪中＝第二輪投票過半數票投畀搗蛋鬼。每位投啂嘅玩家各自 +3（target=player，reason『搗蛋鬼・揪中』）；同時搗蛋鬼即被淘汰、公佈身份、遊戲結束，搗蛋鬼冇 +5。若兩輪都揪唔中：搗蛋鬼 +5（target=player，reason『搗蛋鬼・潛伏成功』），其餘玩家冇分。」有分組時照個人計（組分自動跟，§6 公式），唔開 group target。 | P0 |
| P0-2b | §4（L91）、§3 關3（L66）、M4（L445） | 「2 輪投票揪人」——① 平票點算（無人過半／兩人同票）？② 可否投自己？③ 第一輪被淘汰者第二輪仲投唔投、仲計唔計頒獎？④ 兩輪之間係咪要再玩一個「回合」（派任務題）定純投票？PLAN 完全冇寫，host 台 UI（派身份／裁決）同 vote 卡流程都建基於呢啲細節。 | 活動當日出現平票（10 人好常見）engine 冇定義行為，主持無從裁決；工程隊各自猜。 | §4 加：「投票規則：不可投自己（前端 disable＋server 拒絕 W_SELF_VOTE）；未淘汰者全體投票；平票→主持台即場顯示平票名單，主持一鍵揀『重投一次』或『主持裁決揀一人』；第一輪被淘汰者第二輪唔可以投、唔可以再被投，但保留全部分數同頒獎資格；兩輪之間由主持用 manual 卡／口頭帶一個小任務（引擎唔強制）。」M4 驗收加：「bots 跑 2 輪劇本，含一輪刻意平票 → 主持裁決後計分正確；投自己被 server 拒絕。」 | P0 |

### P0-3　畫畫關計分主體未定義 — 「+1/+2」同「最似」各自俾分俾邊個冇講

| ID | 位置 | 問題 | 影響 | 建議 | P |
|---|---|---|---|---|---|
| P0-3 | §3 關2（L65）、§8.2 #9（L295）、M3（L444） | 主持台「+1／+2」係加畫出嗰張畫嘅畫家（作品作者），定係評審自己？§3 講「上載圖、影相上牆、+1／+2」同一行，睇唔出對象。手機投票「最似」——得到最多「最似」票嘅作品，分係俾畫家定俾投佢嘅人？票數點換算成分數（每票 +1？最高票 +3？）？§6 帳簿對呢關完全冇範例。更甚：呢關係「畫畫猜人」——原圖係名人，作品係玩家畫，M3 驗收寫「評審一 click＝**正確 player** 得分」，但呢關根本冇「正確 player」概念（唔係答題）——驗收標準本身引用咗一個唔存在嘅概念。 | Game 2 計分完全靠估；M3 驗收語句唔成立，驗完等於冇驗。 | §3 關2 加註解並改 M3 驗收文字，貼上：「計分（唯一定義）：① 玩家投票『最似』：每張作品每得一票，該作品作者 +1（target=player，reason『畫畫・人氣票』）；最高票作品作者額外 +2（reason『畫畫・最似獎』）。② 主持評審 +1/+2：對象係作品作者（評審台選中作品後按 1/2/3/0，1＝+1、2＝+2、0＝undo 該筆），reason『畫畫・主持評分』。③ 可以投自己作品（冇禁），但同一玩家同一輪只可投一票。」M3 驗收改做：「10 張圖 30 秒內上齊；bots 投票＋主持 +1/+2 後，每位作者分數＝人氣票×1＋最似獎＋主持評分，逐筆同帳簿對上」。 | P0 |

### P0-4　三套狀態機（Room.phase 5 個 / StageState.mode 17 個 / Card.state 5 個）關係未定義

| ID | 位置 | 問題 | 影響 | 建議 | P |
|---|---|---|---|---|---|
| P0-4 | §6（L126 phase、L173 Card.state、L188–190 StageState.mode） | Room.phase（idle/lobby/playing/final/award）、StageState.mode（17 個）、Card.state（draft/open/closed/tally/revealed）係三套並行狀態，PLAN 冇寫：① 邊個係權威、由 server 邊個動作推進；② 5 個 phase 同 17 個 mode 嘅 map（例如 phase=playing 時 mode 可以係 17 個入面邊啲？phase=final 同 mode=finale 係同一個定？mode=award 喺 phase=award？）；③ 出卡（cards/:id/open）會唔會自動切 mode？rundown/next 會唔會自動收卡？host 手動 stage 切 mode（§8.2 #2「17 mode 一按切」）同 card 流程自動切 mode 打交點算（例如 tally 未揭曉 host 一按切咗 scoreboard，再切返嚟 tally 資料仲喺唔喺）？ | 呢個係 engine 心臟：狀態機唔清晰，M0 骨架同 M1 出卡流程兩批人會寫出兩套唔相容嘅推進邏輯，返工係全量級。 | §6 後加一節，貼上：「**狀態機主從（唯一定義）**：Card.state 係唯一權威遊戲進度；StageState.mode 係**派生＋可覆寫**嘅顯示狀態；Room.phase 係粗粒度生命週期，只由 rundown 推進（todo→running→done/skip 全 done→final；host 撳頒獎→award）。規則：① card open/close/tally/reveal 成功後 server 自動設 mode（question/tally/reveal…），並喺 payload 記 cardId；② host 手動切 mode＝覆寫，唔改變任何 Card.state，原卡流程繼續，下次 card 動作會再拉返對應 mode；③ mode=question/tally/reveal 只允許喺 phase=playing；④ phase=final 凍結所有 card 動作（server 拒絕，error code W_WRONG_PHASE）；⑤ snapshot 同時帶三套狀態，client 唔准自行推導。M0 驗收加一條：bots 驗證 open→close→tally→reveal 每步後 snapshot 嘅 phase/mode/card.state 三元組符合上表。」 | P0 |

### P0-5　「30 bots＝3 倍餘量」同 §9.6「players 上限 30」直接矛盾

| ID | 位置 | 問題 | 影響 | 建議 | P |
|---|---|---|---|---|---|
| P0-5 | D26（L46）、§9.6（L418）、M0（L441） | §9.6 上限寫死「players 30」，M0 驗收要「30 部 bots join」——即係 bots 已打爆上限，零餘量；之後 stage＋host 連上去、或真機同人再入場會被拒。D26 講明「3 倍餘量」係想驗證 10 人場有餘量，但上限數字令驗收目標同限制互相打交，工程隊唔知應該改上限定減 bots。 | bots 驗收第 31 個連線（stage/host）即失敗；或者工程隊臨場放寬上限冇文檔依據。 | 二揀一，建議改 §9.6：「上限：room 1 個、players **60**（驗收 30 bots 之外留真機餘量）、host 連線 5」；同時 M0 驗收補一句「第 61 個 join 被 server 拒絕（error code W_ROOM_FULL），大mon 顯示房滿」。 | P0 |

---

## B. 規格不足／未定（P1）

### B-1　Cloudflare Access ＋ PIN ＋ host token 三重驗證流程細節

| ID | 位置 | 問題 | 影響 | 建議 | P |
|---|---|---|---|---|---|
| B-1a | §7 HTTP（L261）、§9.3（L351） | host token 壽命、Access session（CF Access JWT cookie 預設 1 個月，但可以設短）同 host token 嘅關係未講：① token 幾耐過期？活動行 3–4 鐘，中場過期會令 host 台全滅；② token 過期後 client 點知（HTTP 401 定 WS error）？③ WS 用 host token 認證（`/ws` 公開＋hello 帶 token），WS 長連線唔會因 Access cookie 過期而斷——呢個係優點，但要寫明「host WS 只信 host token，唔依賴 Access cookie」，否則有人會以為要喺 WS 層再驗 Access。 | 活動中 host token 過期＝主持台突然全部操作被拒，冇定義恢復路徑。 | §7 加：「host token 壽命＝8 小時（啟動可調）；過期回 HTTP 401＋WS `error{code:'W_TOKEN_EXPIRED'}`，host 台自動行 PIN 重換流程（Access cookie 通常仍有效，唔使重新 login）；WS 認證只信 host token，與 Access cookie 壽命脫鉤。」 | P1 |
| B-1b | §9.3 後路（L357）、§7（L261） | LAN 直連後路（http://192.168.x.x:3000）係**另一個 origin**，完全冇 Cloudflare Access——`/api/host/login` 得 PIN 一重。PIN 係短數字，場地 Wi-Fi 上任何人可試。同時 service worker／media cache 喺 LAN origin 全部唔存在（見 B-4）。 | 後路安全性靜靜地由「Access＋PIN」降級做「淨 PIN」；runbook 冇提。 | §9.3 後路加註：「LAN origin 冇 Access，host login 淨得 PIN——PIN 最少 6 位；login 有 per-IP 節流（5 次失敗鎖 5 分鐘）；runbook 寫明後路模式風險自負，只喺 Tunnel 死嗰日用。」 | P1 |
| B-1c | §8.2（L285）、§9.6（L418） | 「host 可多開，各自 token」——host token 有冇同時生效上限？§9.6 寫「host 連線 5」係 WS 數，唔係 token 數；同一 token 可唔可以喺兩部機用（session 共享定綁機）？ | 唔明確就會出現「舊 iPad token 被新 login 撤銷」或者相反完全冇限。 | 加一句：「每次 login 發獨立 token（綁 clientInstanceId），上限同時 5 個有效 host token；撤銷＝host 台主動登出或撳『踢走其他 host』。」 | P1 |

### B-2　clock offset 單程差值忽略 RTT — ≤0.5s 保證喺流動網絡下唔穩陣

| ID | 位置 | 問題 | 影響 | 建議 | P |
|---|---|---|---|---|---|
| B-2 | §9.5（L409–411）、§5 Timer（L100） | `offset = serverNow − 本地收到嗰刻` 內含**單向下行延遲**。經 Cloudflare Tunnel＋場地 Wi-Fi，RTT 隨時 80–300ms；非對稱路徑／Wi-Fi 排隊時單向延遲可以去到 200–400ms，貼住 0.5s 上限。M0 驗收「校歪 ±3 秒仍一致」測嘅係本地時鐘偏，完全測唔到網絡延遲呢部分——驗收過咗都唔代表 ≤0.5s 成立。 | 倒數唔一致（有人話仲有 3 秒有人已收卷）、media deck 貼錯秒。 | §9.5 改做 NTP 式取樣，貼上：「client 連線時送 3 次 `ping`（帶 clientT0），server 回 `{serverNow, receivedTs}`；client 對每個樣本計 `offset_i = serverNow + (T1−T0)/2 − T1本`，取 **RTT 最細嗰個樣本**嘅 offset 為準；其後每 60 秒用 WS pong 重取一次，offset 突變 >300ms 先採用新值。M0 驗收加：bots 注入 200ms 單向延遲（proxy 模擬），兩機倒數差仍 ≤0.5s。」 | P1 |

### B-3　media deck：lease 模型、非 file 來源同步、背景 tab throttle 三個窿

| ID | 位置 | 問題 | 影響 | 建議 | P |
|---|---|---|---|---|---|
| B-3a | §8.2 #3（L289）、§9.4.1 表（L402「音源 lease」） | 「恢復同一音源 lease」——但 lease 嘅**定義**（邊個 host 持有音源、點轉移、lease 期間其他 host 撳 play 係乜行為）全份 PLAN 冇提過呢個詞以外嘅任何內容。兩個 host 同時撳 play 只靠 activity toast「防止互搶」＝事後通知，唔係互斥。 | 兩部 host 一齊出聲（雙重音樂）或者互相搶暫停，活動當日好易發生。 | §8.2 #3 加：「音源 lease：media deck 開估歌關時向 server 申請 `audioLease`（deckId 綁定）；lease 持有者嘅 play/pause 先有效，其他 host 撳 play 收 `W_NO_AUDIO_LEASE`（host 台個掣變灰並顯示而家邊部機出聲）；host 台一鍵『接管音源』＝申請轉移，toast 通知雙方；lease 斷線 30 秒後自動釋放，可被接管。」 | P1 |
| B-3b | §6 Song.source（L153–156）、§8.2 #8（L294） | `playStartedAt` 同步只對本地 MP3 file 成立；YouTube（iframe player）同 Apple Music 冇秒級 seek＋autoplay 保證，PLAN 講「遲加入都用 playStartedAt 貼返同一秒」對呢兩種來源係空話。§11 風險表提咗 YouTube 廣告／Apple 冇 API，但冇講**同步要求喺非 file 來源時自動降級**。 | M2 驗收「播歌同 stage 畫面同步 ≤0.5s」用 YouTube 來源測必定唔達標，工程隊會浪費時間追一個做不到嘅數。 | 明寫：「playStartedAt 秒級同步承諾只限 `source.kind='file'`；YouTube 來源＝media deck 主播、畫面同步以人手為準（host 台顯示『同步不保證』標記）；Apple Music＝純提示，唔受 media.play 控制（同 §11 一致）。M2 同步驗收只用 MP3 測。」 | P1 |
| B-3c | §8.2 #3（L289）、M2（L443） | media deck 通常係 Mac 開住第二個 tab／另一部 iPad 兼控台——瀏覽器背景 tab 會 throttle timer（Chrome background tab setInterval 最疏 1 分鐘）兼可能暫停 `<audio>`。PLAN 對 media deck 要 keep foreground 冇任何要求或對策（wake lock、audio element keep-alive）。 | 音樂中途窒住／播唔落，主持人當日先發現。 | 加：「media deck 頁要 `navigator.wakeLock`＋頁面可見性警告（落背景即刻喺 UI 警『音源 tab 已轉背景』）；runbook 寫明 Mac media deck 用獨立 browser window 保持 foreground。」 | P1 |

### B-4　D28 offline/PWA 承諾同 LAN fallback origin 衝突

| ID | 位置 | 問題 | 影響 | 建議 | P |
|---|---|---|---|---|---|
| B-4 | §9.3（L357）、§9.4.1（L400–405）、D28（L48） | §9.3 話 service worker「Tunnel 下有，所以平時唔影響」——但 LAN 後路係**另一個 origin**（IP 直連）：① 從未經 Tunnel 開過嘅機（例如後備大mon）喺 LAN origin 冇 SW、冇 media cache，§9.4.1「完全離線時 refresh 要事前成功載入 app shell」喺呢個場景永遠唔成立；② 已經喺 Tunnel origin 裝咗 SW 嘅手機，切去 LAN origin 係全新 site，乜 cache 都冇——D28「任何角色都唔應被要求手動 refresh」嘅保證喺後路場景大幅降級但 PLAN 當佢冇事。 | Tunnel 當日死、切 LAN 後路時，所有 D28 恢復承諾（草稿、最後畫面、media cache）靜靜失效，用戶體驗同驗收結論唔同行。 | 誠實寫明並寫入 runbook：「D28 offline／app-shell 承諾只喺 Tunnel origin 成立。切 LAN 後路＝fresh session：手機 sessionToken 唔跨 origin，玩家要重新掃 LAN QR 入場（runbook 印埋 LAN 版 QR）；LAN 模式下倒數以 serverNow 校正仍然生效（呢個唔靠 SW）。M0 驗收 offline refresh 測試只喺 Tunnel origin 驗，另加一條：切 LAN 後 re-join 60 秒內全場完成（用 sessionToken 搵返原名同分數——server 係同一個，player 資料唔會甩）。」 | P1 |

### B-5　resync／idempotency 邊界個案

| ID | 位置 | 問題 | 影響 | 建議 | P |
|---|---|---|---|---|---|
| B-5a | §7（L250）、§9.4.1 #2（L374） | 「每次開題有新 roundId」——但**主持重開同一題**（§3.1「要改由主持重開該題」）係咪新 roundId？如果 host reuse 同一 cardId 開第二次而 roundId 冇更新，玩家重送舊 idempotency key 會被舊收據「回原收據」吞咗，新答案入唔到。M0 驗收有「重開同一題後舊提交不得入新一輪」，但協議層冇寫點保證。 | 重開題後玩家改答案無聲失敗——活動當日難 debug。 | §7 加一句：「roundId 由 server 生成，格式 `{cardId}#{openCount}`；任何 open（包括重開）必產生新 roundId 並 broadcast `card.update`；server 對舊 roundId 嘅 submit 一律 `W_ROUND_CLOSED`。」 | P1 |
| B-5b | §7（L250–251）、§9.4.1 #2 | submissionId 由 client 生成（UUID）未寫；兩步確認「確認送出」嗰刻先定 ID 定揀答案嗰刻？refresh 後草稿未有 ID，重送要用同一 ID——生成時機唔明確會令「重送同一 ID」做唔到。 | 重複計分或者提交唔到。 | 寫死：「submissionId 喺撳『確認送出』嗰刻由 client 生成（UUID v4）並連 payload 一齊本機持久化；確認前嘅選擇只有草稿，冇 ID、唔會送出。」 | P1 |
| B-5c | §9.4.1 #2（L374「主持命令同樣綁定原目標及預期階段／版本」） | host 指令（如 reveal）嘅 idempotency：兩個 host 差唔多同時撳同一掣，第二次係「回原收據」定「W_WRONG_STATE」？「最後指令為準」同「預期版本」兩句並存，語義未夾。 | 多開 host 操作出現難解釋嘅 error toast。 | 明寫：「host 冇 client 生成 idempotency key；server 對不可重複動作（open/close/reveal）用目標 cardId＋當前 state 做天然互斥：重複同義動作回 `W_ALREADY_STATE`（200 語義，host 台靜默處理）；對可疊加動作（score、stage set）係冇害重複，照做。」 | P1 |
| B-5d | §7（L249） | `patch {baseSeq…}` 之外，`snapshot` 都帶 seq，但 PLAN 冇寫 seq 單調性保證（journal replay 後 seq 會唔會重置？restart 後 client lastSeq 大過 server seq 點算）。 | 重啟後 client 誤判跳號、不斷 resync。 | 加一句：「seq 單調持久（journal 內遞增，restart 唔重置）；client 發現 `serverSeq < lastSeq` 視為 server 回滾，直接丟棄本地並以 snapshot 為準（唔彈 error）。」 | P1 |

### B-6　題庫「一鍵匯入 QUIZ 20 題」同附錄 A 內容唔一致

| ID | 位置 | 問題 | 影響 | 建議 | P |
|---|---|---|---|---|---|
| B-6 | §3.1（L85）、§8.2 #7（L293）、附錄 A 標題（L481） | 附錄 A 聲稱「來源＝live_page.py 嘅 QUIZ 陣列」，實物核對（deploy/live_page.py L7–72）：**MC 10 題完全一致**；但**開放題 10 題只有 2 題吻合**（Q11 App 數、Q19 一匹布）——QUIZ 實際係「影幾多張相、手機電量、血管長度、食幾多餐、長頸鹿頸、貓紙箱、喊露傳染、車牌冇 O/I」等，同附錄 A 嘅「鞋碼、身高、至 12 點分鐘、手機鐘數、206 骨頭、espresso 克數、大帽山、銀包紙幣」係兩套題。而且 QUIZ 開放題有「散場時揭曉」（影相數）呢類即場無答案嘅題，匯入後 actualAnswer 無從輸入。 | 「一鍵匯入」同「附錄 A 預設題庫」係兩套唔同內容，工程隊揀邊套做 default 會撞；匯入器對「散場揭曉」題冇處理定義。 | 改附錄 A 標題做：「初始題庫＝附錄 A（以 QUIZ 為基礎改編，開放題換成可即場揭曉嘅估數字／短答）」；匯入器規格加：「匯入只取 MC 10 題＋開放題中可即場評分嘅題；其餘標 `state:'draft'` 入庫唔自動排入 rundown，host 台顯示『需主持處理』。」 | P1 |

### B-7　雜項未定義（各一小條）

| ID | 位置 | 問題 | 影響 | 建議 | P |
|---|---|---|---|---|---|
| B-7a | §6 StageState.mode（L190）、§8.1（L277） | `leaderboard` 同 `scoreboard` 兩個 mode 分別係咩（一個帶 ticker 一個全屏？）冇定義；`rules` 嘅內容來源（rundown item title？自定文字？）都冇。 | 17 mode 清單入面至少 2 個語義唔明。 | 一句定義：「scoreboard＝排行榜主畫面（可帶 sort）；leaderboard＝關與關之間過場榜（自動帶上關 reason 過濾）；rules＝顯示 currentItemId 對應 rundown item 嘅 title＋預先綁定嘅規則文字（rundown item 加可選 `rulesText` 欄）。」 | P1 |
| B-7b | §3.1（L81）、§6 Card.seconds（L170） | open 題（45 秒）同 choice 一樣有 tally 嗎？open 題 tally 畫面顯示咩（文字牆）？StageState 冇 open 專用 mode。 | M1 做 open 題時 stage 畫面冇規格可跟。 | 加：「open 題復用 question→tally→reveal；tally 顯示文字答案匿名牆（收卷先顯示）；reveal 顯示 actualAnswer／referenceAnswer＋最接近者高亮。」 | P1 |
| B-7c | §6（L141）、D17 | player.number 1..N「入場次序，主持可改」——兩人同號、有人離場後個號點處理冇講；頒獎 tie-break 用編號細，同號會壞 tie-break。 | 頒獎演算法輸入唔合法。 | 加：「number 全房唯一，host 改號時 server 即時重排並拒絕衝突（W_DUP_NUMBER）；kick 唔回收號，新玩家派最大號 +1。」 | P1 |
| B-7d | §6 MediaPlayback（L159–160） | 冇 `pausedAt`／`stoppedAt`——pause 之後 refresh，media deck 用 playStartedAt 計算會由頭計，播錯位。 | 播歌中途暫停再恢復跳返之前位。 | type 加 `pausedAt?: number; accumulatedMs?: number`，恢復算法寫「已播秒數＝accumulatedMs＋(now−resumeStartedAt)」。 | P1 |

---

## C. 里程碑同驗收（M0–M5）：唔客觀／驗唔到／自相矛盾

| ID | 位置 | 問題 | 影響 | 建議 | P |
|---|---|---|---|---|---|
| C-1 | M3（L444） | 「10 張圖 30 秒內上齊」——流程係主持逐張影相上載（§3 畫作走紙畫→影相→上牆），30 秒影 10 張相＋揀檔＋上傳，對人手操作嚟係幻想數字；驗證嘅係 upload throughput 定 host 手速根本分唔清。 | 驗收必肥，或者逼工程隊做批量拍攝等冇需求嘅功能。 | 改做客觀兩段：「① 30 bots 並發上載 30 張 ≤1MB 圖，server 15 秒內全部上牆（測 throughput）；② 真機演示：主持連續影相上牆 10 張，中途零錯誤、無須 refresh（唔設秒數）」。 | P1 |
| C-2 | M3（L444） | 「評審一 click＝正確 player 得分」——引用唔存在嘅概念（見 P0-3），呢條驗收而家係唔可驗。 | M3 冇計分驗收。 | 照 P0-3 建議改寫，加逐筆帳簿核對。 | P0（併入 P0-3） |
| C-3 | M2（L443） | 「播歌同 stage 畫面同步 ≤0.5s」未限來源（見 B-3b）；另「Tunnel 下 WS 連 30 分鐘唔斷」——Cloudflare 免費 Tunnel 閒置斷線靠心跳已處理，但冇寫斷咗當唔當 fail（斷一次自動重連成功算唔算過）。 | 驗收結論視乎邊個判。 | 改：「同步驗收僅 MP3 來源；WS 30 分鐘期間最多斷 1 次且 5 秒內自動恢復、畫面分數無誤，即算通過。」 | P1 |
| C-4 | M4（L445） | 只有 sniffer 驗收（身份外洩、重連），冇計分正確驗收、冇平票／裁決流程驗收（見 P0-2b）。 | 搗蛋鬼計分錯咗都當通過。 | 加（併入 P0-2b 建議）：「bots 兩輪劇本＋刻意平票＋裁決後，分數逐筆對帳簿；投自己被拒。」 | P0（併入 P0-2） |
| C-5 | M0（L441） | 「入場 10 秒」冇定義由幾多部機同時測（1 部定 30 bots 同時？30 部同時 join 時第 30 部幾秒內完成先算過？）；「stage 3 秒內變」由撳掣定由 broadcast 起計都冇講。 | 量唔到嘅驗收等於冇。 | 改：「30 bots 同時 join，全部喺 5 秒內完成（bot 量度 join API RTT）；host 撳加 10 分至 stage 收到 patch ≤1s（bot 量度），畫面渲染後人眼覆核 ≤3s。」 | P1 |
| C-6 | M0（L441） | 「冇 Access cookie 打 /api/host/* 被 Cloudflare 擋」——只能喺外面網絡測（Access policy 唔會擋 LAN 直連 origin），測試環境未講明；亦冇驗 `/ws` 公開同時 `/api/host/*` 被鎖嘅組合。 | 驗收喺 LAN 測會假陽性通過。 | 改：「用手機 4G（場外網絡）開 /host → 被 Access 擋；同一網絡 /play、/stage、/ws 正常；LAN 直連 origin 下 /api/host/* 回 PIN 流程（後路模式，見 B-1b）。」 | P1 |
| C-7 | M5（L446） | 「10 人奇／偶數三獎都算對」——冇講用 bots 定真機、冇講中途離場剔除（§6 有「唔計入頒獎」功能）係咪入測試範圍；「斷網 10 秒自動重連回到同分」邊個端（stage？手機？host？）。 | 頒獎係全場高潮，驗收覆蓋面唔清。 | 改：「bots 跑 9／10／11 人＋隨機剔除 2 人共 6 個 case，三獎同 §6 演算法逐個核對；斷網測試分別喺 stage、手機、host 各做一次。」 | P1 |
| C-8 | §10（L448） | 「最低可出貨線：M0–M1」同 D28（「Resync／refresh recovery 係核心功能」）嘅關係：D28 大部分驗收塞晒入 M0，但 offline app shell／PWA（M5）都係 D28 一部分——出貨線 M0–M1 時 D28 嘅 offline 承諾明顯未達標。兩個「必達」聲明打交。 | 出貨判定標準混亂：M0–M1 出咗貨算唔算違反 D28。 | 加一句：「D28 分兩級：連線級（resync／session 恢復／idempotency）隨 M0 必達；離線級（app shell／media cache）隨 M5，M0–M1 出貨唔含離線承諾。」 | P1 |

---

## D. 範圍建議（活動前一定交得出）

**一定要保留（核心體驗，缺一即崩）**
- M0 骨架＋journal＋reconnect race＋clock offset＋帳簿（全部地基，唔可以瘦）
- M1 問答關（出貨線本身；tally/reveal 分開係亮點）
- M5 入面嘅**頒獎面板＋finale**：三獎揭曉係生日會收尾高潮，唔可以等到最後一刻——建議由 M5 抽前，同 M1 之後一齊做（計分有咗，頒獎只係演算法＋一版 UI）
- 手機 session 恢復（D28 連線級）

**應該砍／降級（風險大、回報細）**
1. **seconds 模式拍賣**（P0-1 內嘅分支）：「用分數買秒數」連結算都要新發明，砍走佢，只做 points 模式，bid 卡即時簡單一半——建議改 D 決定表加一行「D29：拍賣只做 points 模式」。
2. **YouTube／Apple Music 來源**：§11 自己都認咗 YouTube 廣告／Apple 冇 API 係風險；MP3 自備係主線（D7），砍到只剩 `file` 一種 source.kind，Song.source type 簡化，M2 驗收即刻可測。
3. **PWA／service worker／offline app shell（M5 後半）**：成個 SW＋cache versioning＋離線 refresh 係成個 plan 入面複雜度／回報比最差嘅一嚿（而且同 LAN origin 打交，B-4）；活動喺室內有 Wi-Fi，真底線係 WS 重連（已有）。砍到「得 QR 加主畫面 fullscreen meta tag，唔做 SW」。
4. **17 mode 一按切**：收窄做 rundown 驅動＋blackout＋lock＋分數條開關 4 個掣；mode 由卡流程自動派生（P0-4 建議本來就係咁），一按切係 debug 用可以先收喺 dev panel。
5. **multi-host 音源 lease**：簡化做「**只有 Mac media deck 一部機出聲，其他 host 靜音**」——固定音源機就唔使成個 lease/state machine（B-3a 成條消失），activity toast 照留。

**保留但收細**
- bots.mjs 30 個：保留，但上限數字照 P0-5 改。
- open 題 host 評分：保留「一次過全部當答對」，自訂逐個評次之。

---

## E. 結論

**要修幾樣先派工。** PLAN-v3 嘅工程地基（協議、WS hardening、帳簿、驗收方法學）係扎實嘅，但**四個 game 有三個（估歌、畫畫、搗蛋鬼）嘅計分規則冇定義**——呢啲唔係實作細節，係玩法本身；派工落去工程隊會各自發明，M2–M4 全部要返工。

最低限度派工前要修（按優先次序）：

1. **P0-1**（拍賣結算規則，或按 D 節砍走 seconds 模式）
2. **P0-2**（搗蛋鬼計分 target＋投票邊界）
3. **P0-3**（畫畫關計分主體＋M3 驗收改寫）
4. **P0-4**（三套狀態機主從關係一段）
5. **P0-5**（players 上限 30 vs 30 bots 矛盾，一行改數）
6. **B-6**（附錄 A 來源聲明改正，避免工程隊攞錯題庫）

P1 各條（尤其 B-1 token 壽命、B-2 clock 取樣、B-3 音源、B-5 roundId）可以喺對應 milestone 開工前補入 PLAN，唔阻 M0 派工——但 **B-5a（roundId 規則）同 B-1a（token 壽命）建議同 P0 一齊修**，因為佢哋決定 M0 嘅 API/協議形狀。
