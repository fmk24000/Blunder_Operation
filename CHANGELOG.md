# Changelog

## v0.4.4 — 2026-11-20

### Fixed — 估歌競投（用戶第三輪投訴）
- **大mon 唔會再將非拍賣卡畫成「競投」**：`buildStageView()` 只喺 `card.type === "bid"` 先砌 bid DTO。
  以前主持撳「競投」（純 `stage.set`）會將啱啱收咗卷嘅問答卡畫成假拍賣：假題目＋0.0 倒數＋
  「已競投 0/N 人」，而手機根本冇競投掣（task 跟住張問答卡），永遠 0 人投。
- **主持台「估歌」組只剩兩粒真掣**：`競投`（開下一首拍賣卡＝大mon＋手機 10 秒倒數）、
  `競投結果`（推全部人投到嘅秒數上大mon，最少秒數先聽）。`聽歌`／`開估（揭曉歌名）` 拎走
  —— 播歌同開估由主持自己另一部機做，唔經系統。
- **加完分即刻可以再開**：「競投」遇到上一首已公佈排名會先 `bid.finish` 收成終態，再開下一張
  draft 拍賣卡；如果仲有問答 round 未收就擋住＋提示（唔會再開錯）。
- **競投唔限人數**：`eligiblePlayerIds` 唔再當「開 round 一刻 snapshot」用——ws 改為即場檢查
  `approved`（其他卡類照舊守 eligible），手機 task 同大mon 分母都跟現時 approved 人數，
  開卡之後先批准嘅玩家都投到。
- **倒數完停喺競投畫面**：拍賣 round auto-close 唔再轉 `tally`，大mon 會顯示
  「競投已完，等主持公佈排名」，等主持撳「競投結果」。
- **零人競投唔會卡死**：10 秒內冇人撳，「競投結果」disabled、`card.open` 又會被擋——
  而家再撳「競投」會自動 `bid.finish` 收成終態再開下一首（toast：呢首冇人競投，跳去下一首）。
- **競投唔會提早收卷**：`tickAutoClose` 唔再用「全員交咗」收 bid round（1 人交卷＋遲批准玩家
  會令 10 秒倒數提早結束）；拍賣只按 `endsAt`／主持收卷。
- **void 咗嘅拍賣唔准再判分**：`bid.judge` 加 void guard（以前 void 之後仍然 +1 仲會拉返 revealed）。

### Fixed — 手機入場
- 打咗名之後再揀 emoji／顏色，個名唔會再被 re-render 清空（新增 `joinName` state＋`keepName()`）。

### Fixed — 主持台
- 「問答真流程」兩三行掣加行距（`.ctrl-quiz .btn-row + .btn-row`）。
- `.stage-mode-grid` 入面嘅 primary 掣（例如「競投」）唔會再被 `.stage-mode-grid button` 嘅白底
  蓋走藍底、變成一格空白（specificity 修正）。

### 其他
- 資產版本 `?v=20261120e`。
- Tests **184 → 209**（bid guard／遲 approve／auto-close 畫面／主持掣契約／入場名／floor／唔限首數／B1–B11 古怪 code）。

### Changed — 競投結果畫面（用戶第四輪）
- 結果畫面大字：題目 56px、玩家名 38px、秒數 **52px**，而且一定有「秒」單位（以前細字得個數字）。
- 競投秒數改 **round down**（5.6 秒當 5 秒；以前 `ceil` 會變 6 秒）。
- **唔再限 6 首**：新 command `bid.next`——有 draft 卡就用，冇就自動建「第 N 首」，開幾多首都得。
- 主持台版面：流程欄收窄（5fr）、大mon 控制加闊（7fr）。

### Fixed — 系統古怪 code（codex CLI audit，v0.4.4）
- **B2**：`rundown.reset` 清 `Player.secretRole`；`buildPlayerView` 亦要「有進行中搗蛋鬼局＋張卡係
  搗蛋鬼卡」先送 `secretRole`／`saboteurAnswer`（以前重設後玩問答會向舊搗蛋鬼漏參考答案）。
- **B4**：`card.reopen` 唔准喺另一個 round 未完時重開（以前會搶走 currentRound）。
- **B5**：`card.delete` 唔准刪開緊嘅卡；刪 current 卡會清 `currentRoundId`（以前刪完 round 卡死）。
- **B7**：搗蛋鬼投票未開（open）時 `saboteurInfo.top`／`validVotes` 一律空的（以前大mon DTO 漏個人票）。
- **B8**：尾關撳「下一項」會收成 `final`＋計頒獎（以前永遠唔會 `allDone`，卡喺最後一關 running）。
- **B9**：匯出改讀 raw text（server 回 CSV／JSON，唔係 `{ok}`；以前兩個下載都彈「export 失敗」）。
- **B10**：數字鍵盤用 string 草稿，打得到「1.5」（以前 1 → . → 5 會變 15）。
- **B11**：移除 client render 入面重複嘅 `#toast`（HTML 已有一個常駐）。
- 分佈畫面唔再畫拍賣卡（以前主持撳「分佈」會見到「答案分佈＋玩家名＋秒數」嘅怪畫面）。

### Fixed — codex audit v0.4.4 第二輪（P1／P2）
- `quiz.delete` 唔准刪開緊嘅題（同 `card.delete` 同一 guard）；刪已完結 current 題會清 `currentRoundId`。
- `bid.judge` 嘅防重派分改為「同一首同一人只派一次」，唔再靠 `reason`——`bid.settle` 舊入口之後再
  `bid.judge` 唔會雙派。
- 臥底投票未開票時 `undercover.candidates[].count` 一律 0（以前 host DTO 漏即時票數）。
- 頒獎未揭曉（`revealed=false`）唔會漏得主名／分數（大mon 同手機 DTO 都會遮）。
- 流程完結（`final`）後再撳「下一項／跳過」唔會靜靜復活第一關。
- `bid.finish` 加 bid 卡／void guard，改用 `setStageIfUnlocked`（大mon 鎖定時唔會硬轉畫面）。
- `bid.next` 自動建嘅新卡會登記入 rundown `cardIds`（流程欄／匯出見得到第 7 首之後）。
- Server `bidSecondsAllowed` 同手機一致用 floor（保留 +1 秒網絡容差，唔再隱含多一秒 ceil）。
- 競投結果名單限高＋可滾動（多人時唔會爆版裁切）。

## v0.4.3 — 2026-11-20

> Codex CLI 實測 v0.4.2 之後搵到 4 個 gap（2 個 P1、2 個 P2）。
> 兩個 team 各做一輪（builder＝deepseek-v4.1-flash），每輪由 zai/glm-5.3 獨立覆核，最後 codex CLI 判 **SHIP**。

### Fixed — G1（P1）開票後換題，舊票仍然可以 foul 人
- `uc.topic.pick`／`uc.topic.reroll` 而家換題會 **void 舊 round**、清 `roundId`／`currentRoundId`，
  所以換題之後唔可以用上一題嘅票 foul。舊 round 已 void 時 `uc.eliminate`／`uc.vote.foulTop` 一律當「未收卷」。
- `uc.vote.start` 要 **已公佈好人題目**（`promptRevealed === true`）先開得，未公佈會被擋。
- 投票進行中唔准再 `uc.prompt.reveal`（避免大mon 由 10 秒倒數被換成題目）。

### Fixed — G2（P1）勝負已定仍可重抽臥底，再結算按新身份派分
- `uc.match.redraw` 只准「未公佈、未開投票、未有淘汰」嘅窗口（＋`result` 必須 null、人數要夠）。
- 重抽會清 `result`；`uc.match.settle` 遇到「`result=good` 但仲有臥底在生」→ **拒絕派分**，
  勝負改由「仲有幾多臥底」判定，唔再信舊 `result`。

### Fixed — G3（P2）未公佈題目經 toast 提早送玩家
- 揀題目嘅 toast 改中性「第 N 題題目已換（未公佈）」，唔再帶好人題內容；
  `ctx.result` 只回 host command response。

### Changed — G4（P2）主持「畫畫（一圖多人）」主面板補齊
- 主控制「大mon 控制」嘅畫畫塊而家齊：**臥底身份（主持專用）**、**重抽臥底**、
  公佈後 **完整票數表＋票軌**、**獨立「分數結算」**；未開局有清楚提示；hint 唔再寫「呢度就係全部」。
- 「重抽臥底」「公佈好人題目」兩個掣嘅 enabled 條件同 server 完全一致（撳得就一定成功）。
- 進階「畫畫」tab 保留完整面板（取消淘汰／手動淘汰／清走本局）。

### 其他
- 資產版本 `?v=20261120d`。
- Tests **163 → 184**（新增 21：G1 三條、G2 三條、G3 一條、settle／void 防禦、主面板 8 條、N1／N2 條件）。
- 驗收：`node --test` 184/184；E2E 63/63；codex CLI 三輪（SHIP-WITH-NITS → N1/N2 修完 → **SHIP**）。

## v0.4.2 — 2026-11-20

### Fixed — 畫畫關「投票投臥底」唔見咗（用戶第二輪投訴）
v0.4.0 把「臥底投票」由獨立面板搬入「一圖多人」面板，但主持台控制頁嘅「畫畫」按鈕組只剩低
`作品牆`／`作品放大` 兩個純換畫面掣 → 主持睇落覺得投票功能冇咗，而且呢兩個掣佢唔需要。

而家「大mon 控制」嘅「畫畫（一圖多人）」位係一條完整 flow（全部係真 command）：

1. **① 揀題目**：dropdown 列出題庫全部一圖多人題目（好人題＋臥底題關鍵詞），
   `用呢對` 或者 `重抽一對` → 真係換到本題用邊一對（新 command `uc.topic.pick`／`uc.topic.reroll`）。
2. **② 公佈好人題目**：只推好人題目上大mon（臥底題永遠唔會出手機／大mon）。
3. **③ 開始投票（10 秒）** → 投票中變「立即開票（已投 x／y）」→ 已開票變
   「Foul 最高票：<名>」；同票／冇票會出 dropdown 畀主持揀。已出局者唔會出現喺候選，亦唔可以投票。

- 完整面板（臥底身份、3 對題目、題庫 7 對逐行「用呢對」、票數、票軌、取消淘汰、下一題、分數結算）
  搬去「進階 → 畫畫」tab 最上面；原本喺控制頁下面嘅同一個 panel 移走，唔會出兩次。
- 舊「影相上牆／作品牆／評審」收埋喺畫畫 tab 嘅「舊：…（唔用）」details，功能保留但唔再擺主要位置。
- 換題目之後會**即刻收走大mon 上一對嘅「好人題目」畫面**（CHECK-DRAW P1），避免主持換完題、
  大mon 仍然大字顯示舊題。

### 其他
- 新 command：`uc.topic.pick`（`targetId` 或 `payload.cardId`）、`uc.topic.reroll`。
  兩者只改題目相關欄位，唔會碰參賽者／臥底／已出局／round。
- 資產版本 `?v=20261120c`。
- Tests **155 → 163**（新增 8 條：揀題目／重抽／投票中擋換題／非 draw 卡／流程冇斷／P1 收走舊題／UI 契約）。

## v0.4.1 — 2026-11-19

### Fixed — 大mon 規則頁序號斷開
一圖多人／拍賣兩頁為咗符合「每個 block ≤120 字」拆成兩個 `steps` block，
但大mon 每個 `<ol>` 都由 1 開始，結果畫面變成「1 2 3 / 1 2 3」。
而家 `blocksHtml()` 用 `stepCursor` 跨 block 連續編號（`<ol start="N">`）。

### Tests
- 154 → **155**。

## v0.4.0 — 2026-11-19

> 用戶實試 v0.3.3 之後報嘅四個問題，逐個修＋重寫規則頁。
> 四個 team（builder＝deepseek-v4.1-flash／checker＝GLM-5.3／codex CLI audit）並行，最後由 Lead 合併。

### Fixed — 主持台撳「開始遊戲」冇反應、左邊 panel 同大mon 脫節
- **成因**：`room.start` 一開頭 `if (phase === "playing") throw W_ALREADY_STATE`。試完一次之後房間一直係
  `playing`，所以之後每次撳「開始遊戲」都靜靜 throw，rundown 永遠「未開始」，大mon 亦唔會轉。
- 而家：`room.start` 唔會再 throw。未開始／`currentItemId` 係 null／final／award → 一律**由第一關開始**
  （設 playing＋rundown 第一項 running＋大mon 出第一關規則頁）；已經進行緊 → toast「已經開始咗：X」，唔會跳關。
- 新增「**重設流程（返第一關）**」：全部 rundown 返 todo、void 未完成 round、**清走各關局面**
  （一圖多人／笨蛋殺手／搗蛋鬼），測試完想重新玩唔使開新房。
- 流程卡 pill 分三種清楚狀態（進行中／未開始（撳「開始遊戲」）／已完成（可以重玩）），
  完成狀態唔會再被殘留 `currentItem` 遮住。
- 大mon 控制加**同步狀態一行**（`大mon：模式・回合・鎖定`），鎖定時紅色 pill。
- 大mon 鎖定時 `stage.set` 會回 `W_STAGE_LOCKED`「大mon 已鎖定，請先解鎖」，唔再靜靜冇反應。
  另外新增 `stage.qr`：**緊急逃生門**，鎖定時主持仍然返得去 QR／入場頁。

### Fixed — 大mon 死畫面（畫畫嗰幾個掣冇一個有用）
- **成因**：`vote`／`undercover` 兩個掣只係 `stage.set`（冇開 round），stage `voteHtml()` 讀
  `v.vote.options` 但 `v.vote` 係 null → TypeError → 大mon 凍結。
- 移除「畫畫」組重複／死路嘅 `投票`、`臥底投票` 兩粒掣（真投票搬去一圖多人面板）。
- `stage.ts` 所有 mode 加 null guard＋粵語佔位（vote／tally／reveal／question／bid／song／role-reveal／finale 等），
  冇資料時出「等主持…」而唔會炸。
- `render()` 加 error boundary：任何 render 錯誤都出「大mon 出錯」＋保留分數條＋教主持撳邊粒掣；
  連寫入畫面／分數條本身出錯都有最後純文字防線。

### Changed — 一圖多人投票：用返舊「投臥底」，跟 FLOW foul 走已被投走嘅人
- 主持台**刪走**「舊：臥底投票」details 同重複掣；一圖多人面板變成**唯一投票入口**：
  公佈好人題目 → 開始投票（10 秒）→ 已投 x/y＋立即開票 → **票數表＋票軌** → **Foul 最高票** → 下一題。
- 票數／票軌全部讀 server 嘅 `v.undercover`，主持台唔自己再計。
- server 統一成一條 `startDrawVote()`：候選＝approved ∩ 局內參賽者 − 已出局；
  **選民＝候選**（修正舊 bug：舊 `undercover.start` 令已出局者一樣投得票）。
- 新增 `uc.vote.foulTop`：server 自己計最高票再 foul；**同票**回 `W_TIE`、**0 票**回 `W_NO_VOTES`，
  主持可以用 dropdown 手動揀人。重複 foul／重複結算都唔會 double count。
- 舊 `undercover.start` 保留（API 兼容），但**有進行中一局時一律跟局**（排除出局者＋寫返 `roundId`），
  本局已結算就清楚報錯，唔會開出孤兒 round。

### Added — 問答流程：出題目同 30 秒作答分開、可以重玩、有題目監控
- `ctrl-quiz` 由三個掣變五個：**出題目（只上大mon・唔倒數）**／**開始 30 秒作答**／公佈分佈／公佈答案／**重設問答**。
  - `quiz.show`：大mon **只出題目文字**（唔出選項、唔倒數、唔開 round），手機維持等主持——主持可以慢慢讀題。
  - `quiz.open`：真正開 30 秒 round，大mon＋手機先一齊出選項同倒數。
  - 開卷中誤撳「出題目／跳題」再撳「開始作答」會**返去開緊嗰題**，唔會卡死。
- **題目監控 panel**（題庫 tab）：已出 X／13、下一題 Q幾、當前題狀態、每題狀態 pill，
  加 **dropdown 跳去任何一題**（只出題目，可以 fallback／重讀）。
- **重設問答（可以再玩）**：13 題返 draft、void 未完成 round、可選「順便清走問答分」；
  重設之後即刻可以再出 Q1（修正「RUN 咗一次就冇得再答」）。

### Changed — 四頁規則頁跟壽星 FLOW 逐條重寫
- 一圖多人／拍賣時間估歌／笨蛋殺手／問答四頁，按 `design/26party.xlsx`（第 8–72 行）重寫：
  5 秒輪流畫、10 秒投票、foul 晒好人贏／3 題後仲有臥底＝臥底贏、拍賣最少秒數先聽＋同秒最後撳先＋指壓板 ×2、
  笨蛋殺手 3 粒子彈殺兩人＋主持手動加分、問答 30 秒＋先分佈後答案、Q12 ±2 尺／Q13 主持即場入答案。
- 每頁一屏放得落（1920×1080），加 test 鎖住字數／block type 白名單／一屏高度。
- 對照表：`platform/docs/RULES-v0.4.md`。

### 其他（codex audit 第二輪修嘅嘢）
- **一圖多人局加永久唯一 `matchUid`**：以前用 `uc_m<局數>` 做計分去重，重設流程之後新局又係第 1 局，
  會被當成上一局重複而**漏派分**。而家用 matchUid，重設再玩照派分；舊 journal 自動 fallback。
- **問答跳題唔會再偷偷留住上一題**：`quiz.show` 遇到仲開緊嘅 quiz round 會先收卷（唔評分）；
  撳「出題目」掣而家答緊題會擋住並叫主持用 dropdown 明確揀或者先公佈答案（避免誤收卷）。
- **重設問答會清走 Q13 即場答案**（保留 Q12 固定參考答案／±2 尺容差），唔會用上一局個數評分。
- 主持台「分數結算」掣要第三題都 foul 咗先開得（同 server 前置一致）；
  題目監控嘅「下一題 Q幾」跟返 server 次序（rundown cardIds）。
- 笨蛋殺手規則頁去掉 FLOW 冇嘅「全體投票」，改寫「用完子彈／殺夠人之後主持揭曉判輸贏」。

### 其他
- 資產版本 `?v=20261120a`（強制大mon／主持台／手機重新下載新 JS）。
- Tests **116 → 154**（新增 38 條：Team A 9、Team B 6、Team C 1、Team D 12、整合／audit 修正 10）。
- 驗收：`node --test` 154/154、E2E 59/59（真 command＋真 WS 投票＋真 30 秒回合），
  host／stage 真 browser 截圖。

## v0.3.3 — 2026-11-19

### Changed — 問答：收卷唔再派分，開正確答案先派分
以前 `card.close`（收卷／全員答完自動收卷／出分佈）會即刻自動評分，主持未講答案，
分數已經加咗。而家：
- 收卷只係封卷＋上大mon 出分佈，**唔會派分**（MC／容差題／最接近題一律唔派）。
- 真正評分搬去 `card.reveal`（主持撳「公佈答案（先收卷＋評分）」嗰刻）先做。
- 主持控制頁「問答真流程」三個掣照舊：`開下一題` → `公佈分佈（先收卷）` → `公佈答案（先收卷＋評分）`。

### Added — 大mon 分佈／對卷要見到人名
- MC 分佈：每個頭像下面加**人名**（以前淨係得個圓形頭像，主持同觀眾都認唔到邊個）。
- 開放題（Q12 一匹布／Q13 iPhone app 數）：新增「名＋答案」膠囊列表（例如「阿明 38」），
  收卷之後主持一眼睇齊所有人答咗乜。

### Fixed — 長題目大mon 爆版
Q4／Q8／Q10 題目同選項都長，再加 Q4 幾百字解釋，1080p 一屏放唔落（下面被分數條遮住）。
- 分佈／揭曉：題目同選項字階收一級、限行數；揭曉改成「正解放大 + 其餘選項一行一個 + 解釋限 6 行」。
- 底部分數條改**單行唔換行**（10 人以上唔會變兩行壓住內容），多人時可以橫向捲。

### 其他
- 資產版本 `?v=20261119p8`。
- Tests 114 → **116**。

## v0.3.2 — 2026-11-19

### Fixed — 手機入場後殘留「player token 過期」
玩家掃 QR → 改名入場之後，畫面會顯示紅色「W_TOKEN_EXPIRED：player token 無效或過期」，
就算主持批咗佢入都唔會消失，要 refresh 先正常。

**成因**：手機 localStorage 留住上一節（舊房／舊 session）嘅 token，開頁時先用舊 token 連 WS；
server 拒絕時會回一條 `error` 訊息 → 前端寫入 `submitError` 顯示紅色字。之後就算成功入場，
`submitError` 從來冇被清，所以會一直留喺度。

**修正**：
- 開頁時如果 QR 帶嘅房碼同舊 token 個房碼唔同 → **直接丟舊 token**，唔會連上去等 server 拒。
- `onAuthFail`（token 失效／房碼唔啱）→ 清 `submitError`＋`joinError`，靜靜返入場頁。
- 入場成功、每次開新 WS 連線、收到 `hello.ok` → 一律清 `submitError`。
- `onError` 唔再將 `W_TOKEN_EXPIRED`／`W_ROOM_LOCKED`／`W_FORBIDDEN_ROLE` 當玩家錯誤顯示
  （呢啲一定會跟住斷線＋自動返入場頁）。
- 資產版本 `?v=20261119p7`。

### Tests
- 113 → **114**（加「舊 session 唔會留低紅色技術錯誤」test）。


## v0.3.1 — 2026-11-19

### Fixed — 通知（toast）
- **手機 `/play` 唔再顯示 toast**：以前 server 每次投影都帶住最新一條 activity，手機每 100ms
  重繪時就重設 3.2 秒計時器，所以黑色通知（例如「踢走咗 XXX」）會**永遠唔消失**，仲遮住
  底部分數條。而家手機完全唔顯示 toast；玩家需要知嘅錯誤仍然喺表單內顯示。
- **大mon toast 有 timeout**：改用 activity `id` 去重（唔再靠文字），同一條通知唔會重彈；
  並明確設定 **2.6 秒自動收**，唔會長遮畫面。連撳兩次同一個掣（新 activity）仍然會彈。
- 前端資產版本 `?v=20261119p6`（強制手機／大mon 重新下載新 JS，唔會用 cache 舊版）。

### Tests
- 112 → **113**（加「手機唔用 showToast」test；改寫大mon dedup test 驗 `toastId`）。


## v0.3.0 — 2026-11-19

> 對齊壽星 Excel 完整流程（`design/26party.xlsx`，第 8–72 行）。四個遊戲由
> 「拍賣估歌／畫畫猜人／搗蛋鬼／問答」改成「**一圖多人畫畫猜**／**拍賣時間估歌**／
> **笨蛋殺手**／**問答環節**」。

### Added — 一圖多人（畫畫臥底）完整局狀態機
- 9 個 host command：`uc.match.start`（抽 2 個臥底＋3 對題、可重抽）／`uc.prompt.reveal`
  （好人題上大mon）／`uc.vote.start`（10 秒）／`uc.eliminate`（大mon 即講中／唔中）／
  `uc.eliminate.undo`／`uc.match.next`／`uc.match.settle`（**冪等**）／`uc.match.reset`。
- 計分：好人勝 → 全部好人 +1；臥底勝 → 全部臥底 +1；未出局者每人再 +2（疊加）。
- 步驟約束：每題要「已收卷 + 本題未 foul 過」才准淘汰；本題未 foul 唔准下一題；
  第 3 題完成後才准結算（防止連撳偷步）。
- 主持台顯示 3 對題目（好人題＋臥底關鍵詞）、現時第幾題、仲有幾個臥底、出局名單。
- 臥底身份／臥底題**只喺主持台**，唔會漏去大mon／手機 DTO。

### Added — 笨蛋殺手
- `killer.assign`／`killer.redraw`／`killer.clear`：抽 1 老闆＋1 殺手（可重抽），
  **只送主持台**；加分帶 `gameId:"killer"`，計入分項結算。

### Changed — 拍賣時間估歌（方向倒轉）
- 由「最高價密封出價」改成**最少秒數先聽；同秒由最後提交者先**（用持久提交順序判）。
- 手機改一個大掣「競投（X 秒）」，撳落去＝當時剩餘秒數（最少 1 秒，0 秒唔准投）。
- **公佈同判分分開**：`bid.publish`（出完整排名）→ `bid.judge`（答對 +1 / 答錯去下一位）
  → `bid.finish`（本首完結，收成終態令下一首開得）。
- 6 張拍賣卡 bootstrap 預先建好，控制頁有齊競投面板（唔使入「進階」）。

### Changed — 總結算同頒獎
- 新大mon 畫面「分項結算」：一圖多人／拍賣估歌／笨蛋殺手／問答／其他調整／總分。
- 「中庸之道獎」由**中位數**改**平均數**（Excel 定義），文案同步。
- 三獎改名：最高分獎／中庸之道獎／多謝參與獎。

### Added — 題庫內容
- 13 條新問答題（`seed/quiz.seed.json`，逐字）：Q1–Q11 MC、Q12/Q13 數字開放題，
  全部 30 秒；Q12 支援容差 ±2 尺（`tolerance`）、Q13 主持即場輸入（容差 0）。
- 7 對一圖多人題目（`seed/undercover.seed.json`：好人題＋臥底關鍵詞）。
- 四頁規則重寫（一圖多人／拍賣／笨蛋殺手／問答）。

### Fixed
- 主持台「分佈／揭曉」以前只換畫面唔收卷；新增真流程掣（先 close 再 tally/reveal）。
- 重複「公佈排名」會重置判分 → 同一首歌派兩次分（已鎖）。
- 同一毫秒提交，「最後提交」判錯人（改用持久提交順序）。
- 主持儲存 Q12/Q13 會刪走 `tolerance`（已保留）。
- 排行榜／開始畫面以前只出 12 人（改自動分欄＋可捲動）。
- 到期後仍收提交（WS 層直接驗 `endsAt` 同剩餘秒數）。
- 部署陷阱：`sync-seed.mjs` 喺冇 `data/` 時會爆（乾淨 clone 建唔到）；已 fallback 用 repo `seed/`。

### Changed — 主持台
- 主 tab 收斂到 5 個（控制／玩家／分數／題庫／頒獎），其餘收喺「進階」（function 全留）。
- rundown 預設 4 關：一圖多人 → 拍賣估歌 → 笨蛋殺手 → 問答。

### Tests
- `npm test`：57 → **112**（+55）。全部綠燈。

### 已知未做
- Q4 參考圖 `imageUrl` 留空（原檔未取得）。
- 笨蛋殺手冇子彈／擊殺狀態機（紙本執行，系統只抽身份＋加分）。
- 舊 journal 唔會自動升級題庫（部署時會開新 data volume）。

## v0.2.2 — 2026-11-19

### Changed — LINE Seed 字體（主持台＋手機）
- 主持台 `/host`、手機 `/play` 改用 **LINE Seed TW**（Rg 400＋Bd 700，WOFF2）。
- 揀 TW 唔用 JP：JP 版覆蓋唔到本專案 61 個用字（你／佢／冇／嘅／喺／啲／咗…），TW 版只缺 10 個粵字（吓咗哋啱啲喺嗰嘅嚟脷），用系統字 fallback 補。
- 大mon 繼續用思緒重生體；landing 繼續系統字。
- 前端資產版本 `?v=20261119p5`。


## v0.2.1 — 2026-11-19

### Changed
- **遊戲改名**為《關於我初試策劃**圍威喂**這檔事》：大mon 標題、手機頁首、四頁 `<title>`（landing／大mon／主持台／手機）、PWA manifest `name`／`short_name`。
- **分數條**：玩家名用墨黑、分數改用 primary 藍＋細分隔線，唔會再讀成「名＋數」一串。
- 前端資產版本 `?v=20261119p4`。


## v0.2.0 — 2026-11-19

### Changed — 視覺大改（Doubao 淺色 ＋ 大字體）
- **全站配色改跟 Doubao 淺色版**：冷調淺底 `#f7f9fc`、白卡、`#e7eaef` hairline、單一 primary 藍 `#0065fd`；取消彩色漸變／grain／大部分陰影，改用 border 分層；圓角 12/18/24。
- **掣改 pill**；主持台 tabbar 選中＝黑 pill 白字；mode tiles 用淺藍 active（唔再成版實心藍）；列表動作降噪（`開`/`批准` 藍、`踢`/`刪` 白底紅字）。
- **大mon**：房碼＋QR 收埋一張紙卡（房碼黑卡白字）、頭像 squircle、分數板獎牌名次、分數條可換行、短畫面垂直置中（`safe center`）、規則頁字階收一級（1080p 一頁放得落）＋底部淡出 mask。
- **主持台**：卡片 flat（白底＋hairline、無陰影）；`階段／畫面／版本／流程／已批准／待批准／已完成／進行中` 全部中文；`Skip 呢關`→`跳過呢關`、`開始 playing`→`開始遊戲`、`回 Lobby`→`返大堂`、`去 Final`→`去結算`。
- **手機**：修正「入場後卡片冇左右 padding 貼邊」；頭像 8 欄（≤420px 7 欄）、色板 8 格圓角方塊、`.helptext` 26px→14px、disabled 主掣改淺底灰字。
- **Landing** 改成 hero＋四張入口卡。

### Added — 大mon 專用字體（思緒重生體）
- `public/fonts/reborn.woff2`（由購買版 `MMF-RebornFont-V1.2-Normal` OTF 轉 WOFF2，1.9MB→1.43MB），`font-display: swap`、只有 `/stage` preload。
- **只限大mon**：`body.stage` 用 `--font-reborn`；主持台／手機／landing 用系統字（之後再揀）。
- 字型 0–9 係哥德體（`0` 似方格），用 `unicode-range` 排除數字、fallback 系統字；大mon 數字用 tabular-nums。

### Fixed
- 大mon 倒數最後 5 秒：原本紅字藍底（睇唔到）→ 整粒紅色 pill 白字。
- Rundown `todo` 狀態顯示英文 → 未開始。
- `Rundown`／`approved`／`pending` 等殘留英文文案。

### Tests
- 57/57 pass。前端資產版本 `?v=20261119p3`。


## v0.1.6 — 2026-11-18

### Added — 畫畫關：臥底投票（紙本出題，手機投票）
- 主持台「臥底投票」面板：列出所有已批准玩家，主持可以 untick 已 foul 嘅人（佢哋唔會出現喺候選名單，但仍然可以投票）；可設定 5–60 秒（預設 10 秒）。
- 撳「開始臥底投票」→ 大mon 顯示「請投出你心目中嘅臥底」＋倒數＋已投人數；玩家手機會見到候選人（自己除外，頭像＋名）＋同一個倒數。
- 10 秒到自動開票（亦可「立即開票」）：大mon 顯示每位候選人得票 bar＋逐個玩家投咗邊個；主持台同步顯示結果，可「再開一輪」。
- 新 `undercover.start` / `undercover.reveal` command、`tickUndercover` 自動開票；結果完全由 round + submissions 推導（journal replay 一致）。
- 投票唔計分，純顯示。

### Changed
- 預設關卡次序改為「畫畫 → 估歌 → 搗蛋鬼 → 問答」（新房間）。
- 規則頁 tab 新增「關卡次序」：每關 ▲▼ 調次序＋「還原預設」掣，改完即刻套用（rundown 同步重排，標題會重新編號）。
- 大mon「畫畫」mode 群組新增「臥底投票」。
- 前端資產版本 `?v=20261118j`。

### Fixed（codex audit 揪出）
- host 收唔到 undercover 更新（HOST_SECTIONS 漏咗）、「再開一輪」無效、手動選 undercover mode 被拒、被踢玩家仍可投票、搗蛋鬼淘汰名單誤套用落臥底投票、generic 收卷／切分佈會令投票卡死、開始新投票會棄掉未完成回合、轉關殘留上一關結果、票數名單用今日 roster、deadline 後仍收票、重排後標題關數錯。

### Fixed（獨立 checker 覆核 nit）
- 每輪臥底投票卡而家會登記入當前 rundown item 嘅 cardIds（唔會再累積 orphan 卡）。
- rundown.reorder 會驗證 ids 必須完整、冇重複、冇未知 id（漏／重複一律 W_BAD_SCHEMA）。

### Known Issues
- 主持台規則頁頁碼 pill 喺預覽頁被 disable／delete 之後會顯示舊頁數（cosmetic）。
- `stage.rules{pageIndex}` API 一律由第 0 頁開始（UI 用 `stage.page` 翻頁）。
- 音源未做真 mp3 瀏覽器 E2E（repo media 係 stub）。

## v0.1.5 — 2026-11-18

### Changed — 主持台大mon 控制分組
- **估歌** 組改為：`競投`／`聽歌`／**`開估（揭曉歌名）`**（新掣，觸發 `media.reveal`，大mon 出「歌名揭曉」＋歌名；未播過歌時提示 `W_ALREADY_STATE`）。
- **結算** 由估歌組移去最底新組 **「結算／頒獎」**（連 `頒獎`）。
- **流程／畫面** 只剩 `Idle`／`規則頁`／`分數板`／`排行榜`。
- 前端資產版本 `?v=20261118i`。

## v0.1.4 — 2026-11-17

大mon 黑屏事故修復 ＋ 主持台「返 QR 頁」掣。

### Fixed — 大mon（用戶回報：一入去空白、只見上角分數）
- **黑屏（blackout）死胡同**：黑屏期間 server 拒絕所有 stage.set（W_STAGE_LOCKED），唯一出路係「恢復畫面」，主持唔知就永久空白。而家 stage.set 可以離開黑屏；stage.rules 仍保留鎖。
- **雙撳「黑屏」永久鎖死**：prevMode 會被寫成 blackout，之後「恢復畫面」仍然黑屏。新增 resumableMode()，blackout／rules 永遠唔可以做恢復目標。
- **黑屏疊規則頁後恢復變空白**：恢復會入 rules 但 payload 空。已一併修（fallback idle）。
- **黑屏中仍可經「規則頁」掣出假規則頁**（F1）：stage.set{mode:'rules'} 而家同 stage.rules 一致回 423。
- **規則頁 payload 唔齊**（F2）：抽出 rulesStagePayload() 兩條路徑共用，大mon 出真規則頁。
- **黑屏真全黑**：連 toast 同斷線 banner 都唔顯示（非黑屏照舊顯示斷線 banner）。
- 非黑屏撳「恢復畫面」改為 no-op（唔會亂跳 mode）。

### Added
- 主持台大mon 控制卡頂部新增 primary 掣：**「大mon 返 QR／入場頁」**（黑屏中顯示「（離開黑屏）」），任何 phase 都撳得，係逃生門。

### Fixed — 規則頁預覽（audit 發現，v0.1.3 之前已存在）
- resolveRulePage() 由 currentItem 猜頁 → 改為優先讀 stage.payload.rulePageId；主持揀 B 頁預覽，大mon 就出 B 頁（之前出 A 頁或「主持未設定呢關規則」）。disabled／archived 頁安全 fallback。

### Changed
- 前端資產版本 ?v=20261117h。
- 測試 37 → 49（新增 blackout 逃生、雙撳黑屏、payload 一致、恢復 no-op、真全黑、規則頁預覽跨 game 等）。

### Known Issues
- 主持台規則頁頁碼 pill 喺預覽頁被 disable／delete 之後會顯示舊頁數（cosmetic，大mon 本身正確）。
- stage.rules{pageIndex} API 一律由第 0 頁開始（UI 翻頁用 stage.page，唔會踩到）。
- 音源未做真 mp3 瀏覽器 E2E（repo media 係 stub）。

## v0.1.3 — 2026-11-17

派對前修復版：主持台控制、大mon 穩定度、音源、以及 codex（gpt-6.1-sol）多輪 audit 揪出嘅 server/client bug。

### Fixed — 主持台（你回報）
- **所有控制掣撳完冇反應**：`handleAct()` 用 `split(":")` 解析，但 action 係 `room.start`／`stage.mode:x`／`player.kick:<id>` 呢類 dotted 格式，成個 switch 永遠撞唔中。已重寫 dispatcher，全部 data-act（105 處）逐一對照 server command 覆蓋。
- 每次 render 重複綁 click listener（一撳掣發 N 次命令）→ 改為只綁一次。
- 玩家名單仍然顯示已踢玩家 → 主名單隱藏，收埋喺「已踢 N」摺疊區，可還原。
- 表單輸入被 patch 清空 → render 前後保留 dirty／聚焦欄位。
- dirty 清理範圍過闊（儲存一題清走其他題嘅未儲存編輯）→ 改為只清對應 record。

### Fixed — 大mon（你回報）
- 被新連線接管（4010）後永久卡住 → 5 秒倒數自動 reload＋「立即重新連線」掣。
- ≥3 個大mon 分頁互踢輪迴 → 60 秒 stable 視窗才清 evicted flag。
- **畫面永久凍結**：`common.ts` 讀 `op.value` 但 protocol 送 `{op:"view", view}` → `view` 變 undefined，之後所有 patch 靜靜丟棄。已修＋壞 payload 會 resync。
- mode 缺資料時 render 拋錯留舊畫面 → 顯示「等待主持…」等待畫面。
- toast 每 100ms 重設計時器 → 只在文字變更時顯示。

### Fixed — 音源／計分／搗蛋鬼（codex audit）
- 同一 browser 兩個 host window 同時出聲 → deck ID 改為每個 document 全新生成。
- 已 buffer 歌曲 replay/resume 卡 preparing → readyState 夠即場 ACK；resume 刷新 readyDeadline。
- 過期 lease 造成 render 無限遞迴（RangeError）→ ownership predicate 加 leaseUntil 檢查。
- `draw.judge` 接受非畫畫投票卡／非卡內作品 → 兩邊都加 type＋membership 檢查；空 `cardId` 唔再送。
- `judge.actual` 空輸入變 0 → 先驗空字串。
- `score.judge` 接受其他 round 嘅 submission → 加 roundId 檢查；分數驗證補 ±1000 同非 0。
- 搗蛋鬼：auto-close 繞過計票、retry 重複計輪、全體棄票唔結算、finish 後仲可以矛盾計分、generic reveal/reopen 繞過裁決 → 統一 `tallySaboteurRound`＋`saboteurAwardsLatentOnce`，generic 入口全部擋。

### Changed
- 前端資產版本 `?v=20261117g`（避免舊 cache 一直行舊 JS）。
- 測試：9 → 37（新增覆蓋上面大部分修復，含可執行邏輯測試）。

### Known Issues
- 音源未做真 mp3 瀏覽器 E2E（repo 內 media 係 stub 檔）。
- `rules.save` 撞 `W_RULES_CONFLICT` 時會清走該頁未存草稿（既有行為）。
- ticker 三個下拉選單嘅 dirty 記錄唔會被清（純顯示，無功能影響）。

## v0.1.1 — 2026-11-16

首個公開版本（派對遊戲平台）。

### Added
- 三端：大mon `/stage`（唯讀 kiosk）、主持台 `/host`（PIN login，可多開）、手機 `/play`（QR 入場）。
- 四關遊戲：拍賣估歌（密封出價＋media deck＋AudioLease）、畫畫猜人、搗蛋鬼（版本 A）、常識問答。
- 每關規則頁：大mon 入關自動顯示、後台可編輯（`W_RULES_LIMIT`／`W_RULES_CONFLICT`）。
- 計分事件帳簿＋undo（void，不刪紀錄）＋換組＋頒獎三獎＋`/api/host/export`（CSV＋room.json）。
- JSONL journal（manifest＋segment＋sha256＋fsync＋壞尾行 truncate＋replay），重啟／kill -9 分數不失。
- WS 自動重連＋resync、clock offset（RTT）、commandId 冪等、reconnect race、5 種連線名額。
- Docker multi-stage（node:26-alpine）＋ docker compose（30005:3000、volume、healthcheck）。
- 30 bots 驗收腳本（M0–M5）＋ fault injection／clock skew 測試。
- shadcn／iOS 風 UI；大mon 超過 2 條連線時自動踢走最舊（新連線優先，舊機收 4010 並提示）。

### Security
- PIN 必須由環境變數提供（缺／default 拒啟動），支援 6–12 位數字。
- 全站 CSP、host-only API 全部收入 `/api/host/*`、rate limit、Origin 檢查。
- 本 repo 不含任何真實 PIN／密碼／憑證。
