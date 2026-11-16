# PLAN-v3 事實與一致性核對

> 核對對象：`game-platform/PLAN-v3.md`（585 行）為主體，另核 `SESSION記錄_PLAN-v3定案.md`、`PLAN-v2.md`、`PLAN.md`、`PLAN-GPT.md`、`TASKS-GPT.md`、`TASKS.md`、`game-platform-node-ts-session-summary.md`，以及 workspace 實物（`deploy/`、`deploy/site/crew/`、機器環境）。
> 核對日期：2026-11-16（HKT）。
> 方法：全部只讀——`read`／`grep`／`glob`／`wc`／`stat`／`node --version`／`curl`（舊站）／`pdftotext`／Python 逐題比對；冇改過任何現有檔。
> 判定定義：**✅**＝聲稱同實況對得上；**⚠️**＝有偏差、措辭鬆、規格缺口但未至於相反，或者未能確認；**❌**＝錯、同實況相反、或者缺咗會令實作跟錯／做唔到。
> 限制：NAS 內部（docker 容器清單、SSH、NAS 上嘅檔案）冇權限驗，只驗到「20013 站有 HTTP 回應」；Cloudflare Access 政策、Cloudflare Tunnel 行為未能實測；瀏覽器行為（iOS HTTP 加主畫面）只按文件記錄。

---

## 0. 一頁摘要

**核對總數：61 條 → ✅ 17 條｜⚠️ 18 條｜❌ 26 條。**

❌ 同 ⚠️ 嘅分佈：實物核對 24 條（11✅／6⚠️／7❌）、PLAN-v3 內部一致性 24 條（6✅／11⚠️／7❌）、跨文件矛盾 13 條（0✅／1⚠️／12❌）。

### 最需要主持注意嘅 5 條

1. **附錄 A 嘅來源標示錯咗，而且「一鍵匯入 20 題」會蓋走 8 條新題。** `QUIZ` 陣列確實有 20 題，但附錄 A.2 十條開放題入面，只有 Q11 同 QUIZ 第 11 題相近、Q19 相同，另外 **8 條係新寫**；QUIZ 原有 8 條（影相／電量／血管／餐飯／長頸鹿頸／貓紙箱／打喊露／車牌）完全唔在附錄。照字面做「匯入 QUIZ 20 題」，平台題庫會變返舊題，而且舊開放題答案文字寫「兩隊…最接近嘅一隊 ＋2」，同新版「每人自己手機答」語義相反（§1 第 3、4 條）。
2. **最後防線（列印包）同平台題庫／時限唔對版。** `deploy/print-pack.pdf` 存在（8 頁），但內文係舊 QUIZ 開放題（有「電量」「血管」，冇「鞋碼」「銀包」「大帽山」），流程頁寫「每題 30 秒」；PLAN-v3 平台係新題庫＋MC 20 秒。真係要靠列印包頂上嗰晚，題目同計時會同平台唔一致（§1 第 9 條）。
3. **兩套 Plan／兩套 Task Book 並存，派工一定跟錯版本。** `TASKS-GPT.md:3` 明文寫「規格以 PLAN-GPT.md 為準」，而 PLAN-GPT 用 **Socket.IO＋SQLite**；PLAN-v3 用 **fastify＋ws＋JSONL journal**。同時 `SESSION記錄` 話「下一步：出 task book（未做）」，但 TASKS-GPT 已經存在。主持要一句話釘死：PLAN-v3 係唯一權威（§3 第 5、6、12 條）。
4. **HTTP 路線表覆蓋唔到 §8.2 主持台功能，資料模型又缺幾個明文欄位。** §8.2 有分組工具、題庫編輯器、歌單、頒獎面板、media pause、rundown「上一項」、主持代答，但 §7 路線表冇對應 endpoint；`Submission` 冇 `roundId`（§7 submit 明文要）、`Card` 冇分類／主持貼士、冇 bid `mode` 欄位（§2 第 13–16 條）。
5. **PLAN-v3 自己講嘅手機端卡型三處唔一致。** §2（`PLAN-v3.md:56`）寫「手機端只有一種卡型（大按鈕），冇輸入法」；但 §5 卡型表寫 `open`＝文字輸入、`bid`＝數字鍵盤，§3.1 同附錄 A.2 又話玩家自己手機打答案。另外 §5／§7 有 `Buzz` 零件同 `buzz` 訊息，但六種卡型冇一種觸發 buzz、四關亦冇搶答關（§2 第 6、7 條）。

> 其餘 ⚠️ 大部分係「規格缺口／未實測／歷史文件數字過時」，唔一定阻住開工，但建議開工前一次過清（見 §4）。

---

## 1. 對 workspace 實物核對

| # | 項目 | 聲稱（出處） | 實況 | 證據 | 判定 |
|---|---|---|---|---|---|
| 1 | 附錄 A 題庫來源題數 | 「來源＝deploy/live_page.py 嘅 QUIZ 陣列（20 題）」（`PLAN-v3.md:481`、`:85`） | QUIZ 確實係 20 題（10 MC＋10 open），數量啱 | `deploy/live_page.py:7-72`；Python `ast` 解析：`len(QUIZ)=20`、MC 10、open 10 | ✅ |
| 2 | 附錄 A.1 選擇題內容 | A.1 十題「來源＝QUIZ」（`PLAN-v3.md:492-532`） | 十題題目、A-D 選項、正解、解釋**逐字相同**（只有 Q9 解釋「2^42」vs 原檔上標「2⁴²」，屬排版） | 逐題程式比對：Q1–Q10 題目／選項／正解／解釋全部 True，Q9 解釋正規化後文字相同 | ✅ |
| 3 | 附錄 A.2 開放題內容 | A.2 十題「來源＝QUIZ」（`PLAN-v3.md:534-571`） | **內容同 QUIZ 唔係同一套**：Q11 相近但改寫（「全場 10 部手機」→「全場所有人」）；Q19 文字相同；**Q12–Q18、Q20 共 8 條係新題**。QUIZ 嘅第 12–18、20 題（影相／電量／血管／餐飯／長頸鹿頸／貓紙箱／打喊露／車牌）完全唔在附錄 | Python 逐題輸出：QUIZ 11–20 題目見 `live_page.py:42-71`；附錄題目見 `PLAN-v3.md:538-571` | ❌ |
| 4 | 「一鍵匯入 20 題」後果 | 題庫編輯器可「一鍵匯入 deploy/live_page.py 嘅 QUIZ 陣列（20 題）」（`PLAN-v3.md:85`、`:293`） | 照做＝用舊 QUIZ 蓋走附錄 A.2 嘅 8 條新題；而且舊開放題答案欄寫「兩隊估，最接近嘅一隊 ＋2」（`live_page.py:43`、`:46`、`:49`），同新版「每人自己手機答、個人計分」語義相反，匯入會帶錯答案文字 | `live_page.py:43`「主持即場加總：兩隊估，最接近嘅一隊 ＋2。」；`PLAN-v3.md:534-536`「玩家手機自己打答案」「兩種判定」 | ❌ |
| 5 | `deploy/site/crew/quiz.html` 存在同題數 | 存在、20 題（README 同 PLAN 附錄都咁講） | 存在；內嵌 QUIZ 20 題，同 `live_page.py` QUIZ **內容完全相同**；`crew/quiz.html` 真係「QUIZ 嘅投影版」 | `deploy/site/crew/quiz.html:245`（`var QUIZ = [...]`）；JSON 解析 20 題；同 `live_page.py` QUIZ 比較＝True；`README-NAS.md:38` 寫「20 題：10 MC ＋ 10 開放題」 | ✅ |
| 6 | quiz.html MC 時限（附錄比較表） | 「舊版 quiz.html MC 時限 30 秒、開放題 45 秒」（`PLAN-v3.md:488-489`） | 實測正確：MC 預設 30 秒、open 45 秒（另有 20s/30s/45s 預設掣） | `quiz.html:284`（`total = isOpen ? 45 : 30`）、`quiz.html:224-226`（20s/30s/45s 掣） | ✅ |
| 7 | quiz.html 初始題號顯示 | 冇文件講；但頁面寫死「1 / 30」 | 靜態初始值寫「1 / 30」，同實際 20 題唔符（JS 行到會覆寫成「1 / 20」，只係 HTML 初始值錯） | `quiz.html:202`（`<span class="qno" id="qno">1 / 30</span>`） | ⚠️ |
| 8 | `deploy/print-pack.pdf` 存在 | 「最後防線＝列印包＋手動計分」，「列印包（已有 print-pack）」（`PLAN-v3.md:456`、`:433`） | 存在，PDF 版本 1.4、8 頁、2.4MB；`deploy/site/crew/print-pack.pdf` 同一尺寸同一 mtime | `ls -la deploy/print-pack.pdf`（2449159 bytes，11月8 03:16）；`file`：PDF 1.4, 8 pages | ✅ |
| 9 | 列印包內容同 PLAN-v3 題庫／時限對版 | 假設列印包可以直接做新平台最後防線（`PLAN-v3.md:456`、`:433`） | **唔對版**：PDF 內文係舊 QUIZ 開放題（有「電量」「血管」，冇「鞋碼」「銀包」「大帽山」），流程頁寫「每題 30 秒」；平台係新題庫＋MC 20 秒 | `pdftotext deploy/print-pack.pdf -`：第 31 行「開 quiz.html 投影出題、每題 30 秒」；含「電量」／「血管」2 處，含「鞋碼」／「銀包」／「大帽山」0 處；`.html` 源頭 `deploy/site/crew/print.html:230` ⑪⑫節同一批舊題 | ❌ |
| 10 | 舊站 20013 部署講法一致 | 「現有 20013 靜態站（NAS nginx）」（`PLAN-v3.md:6`）；舊站照舊行 | 三份文件一致：compose 20013:80、README 講 192.168.99.8:20013、PLAN-v3 講 20013 | `deploy/docker-compose.yml:6-7`（`"20013:80"`）、`:3`（`nginx:stable-alpine`）；`README-NAS.md:3-4`、`:21`；`PLAN-v3.md:6` | ✅ |
| 11 | 20013 站實際可達 | 舊站照舊行（`PLAN-v3.md:6`） | 實機 curl：HTTP 200，Server: nginx/1.28.3；`/crew/quiz.html` 200、24960 bytes（同本機檔一樣） | `curl -I http://192.168.99.8:20013/` → `HTTP/1.1 200 OK`、`Server: nginx/1.28.3`；`curl /crew/quiz.html` → `HTTP 200, 24960 bytes` | ✅ |
| 12 | Rust 程式碼殘留 | 「Rust 殘留（axum/tokio/rust-embed/node server.js）0 處」（SESSION `:166`） | `game-platform/` 冇任何 `.rs`／`Cargo.toml`／`Cargo.lock`；PLAN-v3 內 `axum`／`tokio`／`rust-embed` 0 次；「Rust」只出現 3 次（全部係「已移除／唔留」嘅聲明） | `find game-platform -name "*.rs" -o -name "Cargo.*"` → 無結果；`grep -rn "axum\|tokio\|rust-embed" game-platform/` → 命中只在 `PLAN-v2.md` 同 `SESSION記錄`;`PLAN-v3.md:4`、`:34`、`:579` | ✅ |
| 13 | 「0 處」嘅適用範圍 | SESSION 表格寫「Rust 殘留…0 處」（SESSION `:166`） | 講 PLAN-v3 就啱；但 `game-platform/` 全目錄仍然有 PLAN-v2 嘅 Rust 條文（`:34`、`:408-419`、`:422`、`:492`），任何「grep 全目錄」都會中招。SESSION 冇寫清楚範圍 | `grep -rn "Rust" game-platform/` → 命中 `PLAN-v2.md` 7 處、`SESSION記錄` 8 處、`PLAN-v3.md` 3 處 | ⚠️ |
| 14 | PLAN-v3 行數 | 「PLAN-v3.md（539 行）」（SESSION `:10`、`:153`） | 實際 **585 行**，差 46 行；PLAN-v3 mtime 02:24 遲過 SESSION 01:49，即 SESSION 寫完之後 v3 仲有更新（D28、§9.4.1 等），SESSION 冇回頭更新 | `wc -l game-platform/PLAN-v3.md` → 585；`stat`：PLAN-v3 2026-11-15 02:24:04、SESSION 01:49:10 | ❌ |
| 15 | 決定表編號範圍 | 「D1–D27 決定表」（SESSION `:156`） | 實際 D1–**D28**（28 行，連續無跳）；D28（Resync／refresh recovery）係 SESSION 之後加 | `grep -c`＋Python 解析：28 行、`nums == 1..28`；`PLAN-v3.md:48` | ❌ |
| 16 | Code fence 數量 | 「Code fence 5 個 block 全平衡」（SESSION `:167`） | 實際 **6 個 block**（12 條 ```）：§5 零件樹、§6 TypeScript、計分公式、頒獎公式、§9.3 路由樹、§9.4.1 復原流程 | `grep -n '^\`\`\`' PLAN-v3.md` → 行 97/104、123/198、202/206、226/232、343/353、379/389 | ❌ |
| 17 | 逃逸字符／mode 修正 | 「逃逸字符殘留 0 個 backslash」「tally/reveal 取代 result，17 個對齊 §8.1」（SESSION `:168-169`） | backslash 實測 0 個；§6 mode enum 17 個、同 §8.1 列舉 17 個完全同一集合（次序唔同） | `grep -o '\\' PLAN-v3.md \| wc -l` → 0；§6 `PLAN-v3.md:188-190`；§8.1 `PLAN-v3.md:277` | ✅ |
| 18 | 機器：Node／npm | 「Node v26.8.1＋npm 11.19.0（已裝）」（SESSION `:50`） | 完全一致 | `node --version` → `v26.8.1`；`npm --version` → `11.19.0`；`which node` → `~/.local/bin/node` → `~/.hermes/node/bin/node` | ✅ |
| 19 | 機器：cargo／docker | 「Rust 冇 cargo」「Docker（本機）冇（Docker 喺 NAS）」（SESSION `:51-52`） | 一致：`cargo`／`rustc`／`docker` 都冇；NAS 有 docker 呢層只能靠 README＋舊站有回應間接印證 | `command -v cargo/rustc/docker` → 全部 not found；`README-NAS.md:21`（nginx:stable-alpine）；`:11` 常用指令用 `/usr/local/bin/docker compose` | ✅ |
| 20 | Node 24 可用性 | summary 要求「開發、CI、主機統一 Node 24，不接受開發用 Node 26」（summary `:10`、`:200`） | 本機只有 Node v26.8.1，冇 Node 24；亦冇 nvm／fnm／volta 可以切版本 | `ls ~/.nvm/...` → 無；`command -v node24 fnm volta` → 無；只有 `~/.hermes/node/bin/node` | ⚠️ |
| 21 | PLAN.md 檔案大小數字 | 「quiz.html 27KB」（`PLAN.md:23`）、「scoreboard.html 17KB」（`:22`） | scoreboard 17KB 啱（17157 bytes＝16.8 KiB）；quiz.html 實際 24960 bytes＝24.4 KiB，已唔係 27KB（PLAN.md 10月26 寫，quiz.html 11月8 重 build，數字過時） | `stat -c %s` → 24960／17157；`PLAN.md:22-23` | ⚠️ |
| 22 | PLAN-v2 題數 | v2 兩處寫「匯入 quiz.html 36 題」（`PLAN-v2.md:109`、`:376`），但同一份文件 §3.1／附錄 A 寫 20 題（`:98-100`、`:508`） | 文件內部自相矛盾；36 係錯（實物 20）。PLAN-v3 已修正，但 v2 仍保留 36 兩處 | `grep -n "36 題" game-platform/PLAN-v2.md` → 109、376；`quiz.html` 20 題 | ❌ |
| 23 | 題庫路徑寫法 | 「deploy/live_page.py」（`PLAN-v3.md:85`、`:481`） | 相對 workspace root 啱；但兩份規格檔都在 `game-platform/`，由 `game-platform/` 解讀會變 `game-platform/deploy/...`（唔存在）。`TASKS-GPT.md:52` 就寫 `../deploy/live_page.py`，證明兩份 task book 路徑寫法都唔統一 | `ls -d game-platform/deploy` → 沒有此目錄；`ls deploy/live_page.py` → 存在；`TASKS-GPT.md:52` | ⚠️ |
| 24 | TypeScript 工具鏈 | PLAN-v3 假設有 tsc／tsx（production 行 dist/、開發准 tsx watch；`PLAN-v3.md:327`、`:430`） | 本機未裝 `tsc`／`tsx`（全域只有 pnpm）；未 start 專案前仲要 `npm i`，唔算 PLAN 事實錯誤，但屬環境 gap | `command -v tsc tsx` → 無；`npm ls -g --depth=0` → 只有 `pnpm@12.3.4` | ⚠️ |

---

## 2. PLAN-v3 內部一致性

| # | 項目 | 聲稱（出處） | 實況 | 證據 | 判定 |
|---|---|---|---|---|---|
| 1 | D 表完整性 | 決定記錄 D1–D28（`PLAN-v3.md:19-48`） | 28 行、編號連續無跳無重複；狀態＝已確認 17、已拍板 10、— 1（D13） | Python 解析表頭：`nums == [1..28]`；狀態 Counter | ✅ |
| 2 | D13 表述 | D13 欄寫「**v3 廢**（被 D27 取代）：冇後備 server」（`PLAN-v3.md:33`） | 但 v2 D13 原本係「後備 server＝Windows 機」（`PLAN-v2.md:33`）。v3 冇寫返原內容，讀者會以為 v2 D13 本來就係「冇後備 server」 | `PLAN-v2.md:33`（原 D13）；`PLAN-v3.md:33` | ⚠️ |
| 3 | 搗蛋鬼版本 A 有冇決策編號 | 「版本 A（潛伏者）— v3 正式拍板」（`PLAN-v3.md:89`）；SESSION 亦話拍板（`:79`） | 正式決策表 D1–D28 **冇一條**講搗蛋鬼版本；拍板只散落在 §4 同 SESSION，無法由 D 表追溯 | `PLAN-v3.md:19-48` 冇「搗蛋鬼」；`:89-91` 有 | ⚠️ |
| 4 | 17 個 StageState.mode | §6 enum 17 個（`:188-193`）；§8.1「17 個 mode」（`:277`）；§8.2 控制條「17 mode」（`:288`） | 三處一致：idle／rules／scoreboard／question／tally／reveal／draw-wall／draw-focus／bid／vote／role-reveal／song／leaderboard／finale／award／timer／blackout | 程式抽 §6 enum＝17；抽 §8.1 列舉＝17；集合相同（次序唔同） | ✅ |
| 5 | 6 種卡型 | §0「6 種卡」（`:12`）、§5 卡型表（`:106-113`）、§6 `Card.type`（`:163`） | 三處一致（choice／open／vote／bid／media／manual） | 同上 | ✅ |
| 6 | Buzz 零件同卡型/關卡對得上？ | §5 零件有「Buzz 搶答排序」（`:101`），§7 有 C→S `buzz`（`:252`），規則亦寫 player 可以 submit/buzz（`:255`） | 六種卡型冇一種會觸發 buzz；四關（`:62-67`）亦冇搶答關。Buzz／buzz 訊息係孤兒規格，實作唔知幾時用 | `PLAN-v3.md:101`、`:252`、`:255`；卡型表 `:106-113`；四關表 `:62-67` | ❌ |
| 7 | 手機端卡型描述 | §2「手機端只有一種卡型（大按鈕），冇輸入法、冇 canvas、冇手勢」（`:56`）；§3 四關表「問答：手機 A／B／C／D」（`:67`） | 同 §5 卡型表（open＝文字輸入／數字鍵盤、bid＝數字鍵盤，`:109-111`）、§3.1「open 主持逐個評」（`:83`）、附錄 A.2「玩家手機自己打答案」（`:536`）直接矛盾 | `PLAN-v3.md:56` vs `:109-111`、`:83`、`:536` | ❌ |
| 8 | 計分加總 30 分 | A.1 十題×1 分＋A.2 十題×2 分，「全環節 30 分」（`:573`）；§3.1「選擇題自動 +N」（`:83`；`Card.points` `:171`） | 10×1＋10×2＝30，一致 | `PLAN-v3.md:492`、`:534`、`:573` | ✅ |
| 9 | 頒獎例子驗算 | 10 人分數 5 8 12 15 18 22 25 30 33 40 → 中位數 20、大獎 40、2獎 22、3獎 5（`:236`） | 獨立重算：n=10 偶數 → median=(18+22)/2=20 ✅；max=40 ✅；剩餘 dist 最小＝18 同 22 都係 2 → 分高者 22 ✅；剩餘最低＝5 ✅ | Python 重算（見核對 script 輸出） | ✅ |
| 10 | 頒獎「可調項」同公式 | 「三個可調項：tie-break、**允許重複開關**、個人／按組」（`:234`）；但公式寫「大獎先派，2獎一定落喺**剩餘者**」「3獎＝剩餘者 min」（`:230-234`）；`Award.manual`／`revealed` 亦冇 repeat 旗標 | 「允許重複」一開，同「一定落喺剩餘者」寫死規則相反；規格冇講重複時邊條優先 | `PLAN-v3.md:230-234`、`:195-197` | ⚠️ |
| 11 | 規模：15 條 WS 算術 | 「正常場次約 15 條 WS（10 手機＋大mon＋2–3 host）」（`:313`）；§9.1 廣播列寫「15 條連線」（`:322`） | 10＋1＋2~3＝**13–14**，唔係 15。`host 連線 5` 上限（`:418`）亦高過「2–3 host」 | `PLAN-v3.md:313`、`:322`、`:418` | ⚠️ |
| 12 | 規模：30 players／host 5／M0 30 bots 矛唔矛盾 | §9.6 上限 players 30、host 5（`:418`）；§9 開頭「驗收支援 30 位玩家加主持及大mon」（`:313`）；D26／M0「30 個 client（3 倍餘量）」「30 部 bots 同時 join」（`:46`、`:441`） | 三者唔矛盾：15 係正常場次，30 係硬上限，30 bots 係壓測（10 人×3 倍）；host 5 上限包住「2–3 host」正常值 | `PLAN-v3.md:313`、`:418`、`:46`、`:441` | ✅ |
| 13 | HTTP 路線表 vs §8.2 功能 | §7 路線表只有 login／join／players／cards／score／rundown(next,skip,reorder)／stage(+lock,blackout,media.play)／upload／export／health／ready（`:259-270`） | §8.2 明文有但路線表冇嘅：**分組工具 0/2/3/N 組**（`:291`）、**題庫編輯器＋一鍵匯入**（`:293`）、**歌單 CRUD／試播**（`:294`）、**頒獎面板改人／揭曉**（`:298`）、**media deck pause／stop／由頭播**（`:289`）、**rundown 上一項／插入**（`:287`）、**主持代答**（`:299`、風險表 `:457`）、**帳簿逐筆查詢**（`:296`） | `PLAN-v3.md:259-270` 對比 `:287-299`、`:457` | ❌ |
| 14 | 資料模型：roundId | §7 `submit {roundId, submissionId, ...}`「每次開題有新 roundId」（`:250`）；§9.4.1 講「重開同一題」舊提交不得入新一輪（`:441`） | `Room`／`Card`／`Submission`／`RundownItem` 全部冇 `roundId` 欄位；round 生命週期（幾時開／幾時作廢）亦冇 model | `PLAN-v3.md:175-179`（Submission）、`:162-173`（Card）、`:124-132`（Room） | ❌ |
| 15 | 資料模型：題庫分類／主持貼士 | 附錄 A 每題有分類（動物／食物／太空／數學／科學／估數字／短答…），開放題另有 10 條「主持貼士」（`:495-571`）；§3.1 題庫欄位＝類型／題目／A-D／正解／解釋／秒／分（`:85`） | `Card` 冇 `category`、冇 `hint`（貼士）；題庫欄位表亦冇。貼士係主持專用（唔應該入 `explanation` 因為 reveal 會送出手機），即係冇位放 | `PLAN-v3.md:162-173`、`:85`、`:538-571`（10 個「主持貼士」） | ❌ |
| 16 | 資料模型：bid mode | §5「`mode: "points"`／`"seconds"`」（`:115`） | `Card` 冇 `bidMode`／`mode` 欄位（只有 `maxBid`、`points`、`seconds`），拍賣兩種模式無處落 | `PLAN-v3.md:115` vs `:162-173` | ❌ |
| 17 | 自動收卷開關 | 「全員提交 → 自動收卷（開關可關）」（`:81`） | 全份文件只此一次；冇 config 欄位、冇 host endpoint、冇 M1 驗收提及「關閉自動收卷」 | `grep -n "自動收卷" PLAN-v3.md` → 只有 81、442（M1 只講開） | ⚠️ |
| 18 | Media deck 身份／租約 | §9.4.1 表「media deck 身份｜本機 media cache＋deckId」（`:402`）；§8.2 講 audio 源由 host 機擔任（`:289`） | `MediaPlayback` 只有 `by: string`（邊個 host 撳）；冇 `deckId`／lease／「同時只一個音源」規格（PLAN-GPT 有租約，v3 冇） | `PLAN-v3.md:159-160`、`:402`、`:289` | ⚠️ |
| 19 | 組數排版／分數條容量 | finale「0 組／2 組／3–4 組／5+」（`:281`）；分數條「超過 12 人縮字轉兩行」（`:279`） | 缺 **1 組** 排版；分數條設計只覆蓋 >12 人兩行，但上限 30 players，30 人同一條 96px 分數條未設計／未驗（M5 只驗 10 人） | `PLAN-v3.md:279-281`、`:418`、`:446` | ⚠️ |
| 20 | 100–200MB RAM | 「100–200MB RAM 綽綽有餘」（`:313`） | 未能確認：冇任何實測／benchmark；而家只有估算 | `PLAN-v3.md:313`；workspace 冇 server code 可測 | ⚠️ |
| 21 | 前端框架／build 工具 | §9.8「前端 vite build」（`:430`）；D1 講 PWA／service worker（`:405`） | 全份冇講用 React／Vue／vanilla；`§9.1` 揀型表亦冇前端 build 一層，實作要自己揀 | `grep -n "React\|Vue" PLAN-v3.md` → 0；`:430` 只有 vite | ⚠️ |
| 22 | 預設秒數講法 | §3.1「逐題可改（預設 20 秒）」（`:81`）；`Card.seconds` 註「問答預設 20 秒」（`:170`）；附錄 open 題 45 秒（`:534`） | 20 秒只適用 MC；open 45 秒。文件冇分開寫，容易被理解成所有題 20 秒 | `PLAN-v3.md:81`、`:170`、`:534` | ⚠️ |
| 23 | 「冇後備 server」引用 | 「**冇後備 server（D27）**」（`:339`）、風險表「單點，D27」（`:456`） | D27 本文係「NAS 完全退役、唔做備份、最後防線列印包」，字面冇講「冇後備 server」（嗰句係 D13 廢除後嘅結果）。引用鬆散但語意方向啱 | `PLAN-v3.md:47`（D27）、`:33`（D13）、`:339`、`:456` | ⚠️ |
| 24 | 估數字題得分規則 | 「估數字題主持輸入 actualAnswer → 自動排最接近」（`:83`）；A.2「自動排最接近（actualAnswer）」（`:536`）；舊版規則係「最接近嘅**一隊** ＋2」（`live_page.py:43`） | 新版係個人賽，但冇寫「最接近嘅人得幾分」「並列最接近點算」「係咪只派一份分」。呢個係核心計分規則缺口 | `PLAN-v3.md:83`、`:536-537`；`live_page.py:43` | ❌ |

---

## 3. 跨文件矛盾／過時講法

> 權威判定原則：SESSION 兩處明文（`:4`、`:181`）＋ PLAN-v3 自述（`:5`）都話 **PLAN-v3 係正式規格**；其餘文件按「歷史／另案」處理。以下「權威」欄＝建議跟邊份。

| # | 項目 | 講法 A | 講法 B | 證據（檔案行號） | 邊份權威 | 建議 | 判定 |
|---|---|---|---|---|---|---|---|
| 1 | Cloudflare Access 開唔開 | **開**：鎖 `/host`＋`/api/host/*`，兩條 policy | **唔開**：只用 Tunnel＋app session，「不啟用 Cloudflare Access」 | A：`PLAN-v3.md:44`、`:347`、`:351`；B：`game-platform-node-ts-session-summary.md:63-72`、`:210`、`:232` | PLAN-v3 | 刪／標 summary 第 4 節；實作前的 Access 設定照 v3 | ❌ |
| 2 | 主持認證方式 | **Access＋PIN → host token**，每部 host 機各自 login | **HOST_KEY／SCREEN_KEY**：主持首次輸 HOST_KEY 換 cookie、大mon 用 SCREEN_KEY | A：`PLAN-v3.md:261`、`:351`、`:283-285`；B：`summary:76-89`、`:233` | PLAN-v3 | v3 冇 SCREEN_KEY 呢個概念（/stage 公開），要刪；PIN 要寫明來源（env／開場產生） | ❌ |
| 3 | 大mon（stage）認證 | **公開**：`/stage` 任何人開都用得，淨係 QR＋房碼 | 用 SCREEN_KEY 換唯讀 session；PLAN-GPT 又要「一次性配對碼」 | A：`PLAN-v3.md:44`、`:346`；B：`summary:87`、`PLAN-GPT.md:14` | PLAN-v3 | 統一「/stage 公開、零控制」；如果其實想保護，就要改 v3 D24 | ❌ |
| 4 | 後備 server／NAS 角色 | **冇後備 server；NAS 完全退役**（唔跑 server、唔做備份），最後防線＝列印包 | summary：NAS snapshot＋failover＋single-writer；v2：NAS 做主 server、Windows 做後備；PLAN-GPT：外部儲存一致備份 | A：`PLAN-v3.md:33`、`:47`、`:339`；B：`summary:114-135`、`:236`、`:247`；`PLAN-v2.md:26`、`:431`；`PLAN-GPT.md:72` | PLAN-v3 | 刪 summary 第 6 節 failover 章；v2 NAS 部署段落標「歷史」 | ❌ |
| 5 | 持久化 | **JSONL append journal**（零 DB、可重播） | **SQLite**（commit／transaction／migration） | A：`PLAN-v3.md:324`、`:432`；B：`PLAN-GPT.md:7`、`:46-48`；`TASKS-GPT.md:9-11`、`:22` | PLAN-v3 | PLAN-GPT／TASKS-GPT 唔可以當 v3 嘅 task book 用 | ❌ |
| 6 | 即時通道 | **fastify＋@fastify/websocket（raw ws）** | **Socket.IO**（transport fallback、`/socket.io/`） | A：`PLAN-v3.md:320`；B：`PLAN-GPT.md:7`、`:17`；`TASKS-GPT.md:9` | PLAN-v3 | 同上；如要留 GPT 方案，要成份標「另案」 | ❌ |
| 7 | Node 版本政策 | v3 只寫「Node LTS」（冇 pin）；SESSION 寫「部署 pin node:24-alpine，開發機 v26 係 current 無所謂」 | summary 釘死「全體統一 Node 24，不接受開發用 Node 26」；PLAN-GPT／TASKS-GPT 寫 Node.js 24 LTS | A：`PLAN-v3.md:26`、`:34`；`SESSION:67`；B：`summary:9-10`、`:199-200`、`:230`；`PLAN-GPT.md:7`；`TASKS-GPT.md:9` | 未定（要主持揀） | 本機只有 v26.8.1；而 Node 26 已於 2026-10 進入 LTS（官方：<https://nodejs.org/en/blog/release/v26.13.0>、<https://endoflife.date/nodejs>）。建議 v3 明文 pin「Node 26 LTS」（或裝 Node 24 並全體統一），並改 SESSION「v26 係 current」句 | ❌ |
| 8 | 大mon 路徑 | `/stage` | `/screen` | A：`PLAN-v3.md:346`；B：`summary:49` | PLAN-v3 | 統一 `/stage`；（最易漏嘅低級錯） | ⚠️ |
| 9 | 題數 | 20 題（v2 §3.1＋附錄、v3、GPT、實物） | 36 題（PLAN.md、PLAN-v2 兩處） | A：`PLAN-v3.md:481`；`PLAN-v2.md:98-100`、`:508`；`quiz.html` 20 題；B：`PLAN.md:224`、`:295`；`PLAN-v2.md:109`、`:376` | v3／實物 20 | PLAN.md 標 archived；v2 兩處 36 要改或加 errata | ❌ |
| 10 | 卡型數 | 6 種（choice/open/vote/bid/media/manual） | 4 種（加減分／選擇題／舉牌／畫板，PLAN.md、TASKS.md）；5 種（v2 §5 標題） | A：`PLAN-v3.md:163`；B：`PLAN.md:11`、`:40`；`TASKS.md:17`；`PLAN-v2.md:127`（5 種卡）vs `:148`（6 種 type） | PLAN-v3 6 種 | TASKS.md／PLAN.md 標 archived | ❌ |
| 11 | stage mode 數 | 17 | 11（PLAN.md、TASKS.md）；16（v2 §6 enum 用 result） | A：`PLAN-v3.md:277`；B：`PLAN.md:222`、`:298`；`TASKS.md:24`；`PLAN-v2.md:223-225` | PLAN-v3 17 | 同上；v2 自身 §6(16) vs §8.1(17) 已係舊矛盾 | ❌ |
| 12 | task book 權威／狀態 | v3「你過目後出 task book 派工」（即未出）；SESSION「下一步：批准後出 task book（未做）」 | TASKS-GPT 已經存在，而且明文「規格以 PLAN-GPT.md 為準」 | v3：`PLAN-v3.md:5`；SESSION：`:173-177`；TASKS-GPT：`TASKS-GPT.md:3`（mtime 02:06 早過 PLAN-v3 02:24） | PLAN-v3（Task book 待出） | 一係刪 TASKS-GPT／改寫成「PLAN-GPT 另案」，一係主持明確話用 GPT 方案——唔可以兩份並存 | ❌ |
| 13 | LAN 後路點行 | **LAN 直連 `http://192.168.x.x:3000` 就得**，全部相對路徑；iOS Safari HTTP 可加主畫面 | summary：「Node 只 listen `127.0.0.1`，不直接公開 LAN port」；PLAN-GPT：LAN 後路要「受信任 HTTPS＋firewall 規則＋獨立本地主持驗證」 | A：`PLAN-v3.md:31`、`:357`、`:460`；B：`summary:70`；`PLAN-GPT.md:72` | PLAN-v3 | 要寫清楚：D11 揀 LAN 直連＝一定要綁 LAN interface，同 summary 相反；runbook 驗一次 HTTP-only 手機入場 | ❌ |

---

## 4. 建議行動

### P0 — 派工前必做（否則實作會跟錯／做漏）

1. **釘死唯一權威**：宣佈 `game-platform/PLAN-v3.md` 係唯一規格；`PLAN-GPT.md`＋`TASKS-GPT.md` 改做「另案／參考，唔准照做」，或者直接移去 `archive/`；`PLAN.md`、`PLAN-v2.md`、`TASKS.md` 加一行「歷史文件，已被 PLAN-v3 取代」。要改位置：`TASKS-GPT.md:3`、`PLAN-GPT.md:1-3`、各檔頂部。
2. **修題庫來源同匯入語義**（`PLAN-v3.md:85`、`:293`、`:481`）：
   - 來源句改成「MC 10 題沿用 `deploy/live_page.py` QUIZ；open 10 題係新寫」；
   - 「一鍵匯入 20 題」改成「只匯入 MC／或匯入後 diff 提示保留新 open 題」；
   - 路徑統一寫 `../deploy/live_page.py`（同 `TASKS-GPT.md:52` 一致）或者寫 repo root 相對。
3. **重出最後防線列印包**（`deploy/print-pack.pdf`、`deploy/site/crew/print.html`）：用新題庫＋MC 20 秒重 build。注意 generator 本身食舊資料——`deploy/print_page.py:316` 係 `from live_page import quiz_print_sheet`，所以要先改資料源（或新增一個「平台題庫」JSON 做單一真相），唔係單純重跑 build 就會變新題。或者喺 PLAN §11 明文寫「列印包用舊題，平台當晚唔用舊題」——但兩者內容唔可以再各講各。
4. **補齊 §7 路線表**（`PLAN-v3.md:259-270`），至少要覆蓋 §8.2 功能：`POST /api/host/groups`（0/2/3/N 組、搬人）、`/api/host/cards/tally`、`/api/host/rundown/prev|insert`、`/api/host/songs`（CRUD／試播）、`/api/host/quiz`（題庫 CRUD／匯入）、`/api/host/awards`（改人／揭曉）、`/api/host/media/play|pause|stop`、`POST /api/host/submit`（代答）、`GET /api/host/ledger`。
5. **補資料模型欄位**（`PLAN-v3.md:162-179`）：`Submission.roundId`（同 `Room.currentRound` 或 `Card.roundId`）、`Card.category`、`Card.hint`（主持貼士，唔對外）、`Card.bidMode: "points" | "seconds"`、`MediaDeck { deckId, leaseUntil }`。
6. **改 §2 同 §3 表嘅手機卡型描述**（`PLAN-v3.md:56`、`:67`）：改成「手機見到 choice／open／vote／bid 四種卡；有文字輸入同數字鍵盤，冇 canvas／手勢」；同時決定 `Buzz` 去留——要就補 `buzz` 卡型＋一關，唔要就由 §5／§7 刪走（`:101`、`:252`、`:255`）。
7. **認證模型定稿**：寫明 PIN 由邊度嚟（env／開場自動產生／寫入 runbook）、host token 放 Authorization header、Access 兩條 policy 嘅 path、要唔要驗 Access JWT（v3 冇講，PLAN-GPT 有講，`PLAN-GPT.md:16`）。刪 summary 嘅 HOST_KEY／SCREEN_KEY（`summary:76-89`）。

### P1 — 開工同時做（影響驗收範圍／數字可信度）

8. **固定 Node 版本**：v3 明文 pin 一個版本（建議 Node 26 LTS，因為本機已係 v26.8.1 而且 26 已入 LTS：<https://nodejs.org/en/blog/release/v26.13.0>）；同時改 `SESSION:67`「開發機 v26 係 current」呢句（已過時），同 summary `:9-10`／`:200`／`:230` 嘅「Node 24 唯一」政策對齊。
9. **更新 SESSION 記錄**（`SESSION記錄_PLAN-v3定案.md`）：`539 → 585` 行（`:10`、`:153`）、`D1–D27 → D1–D28`（`:156`）、「Code fence 5 → 6 個」（`:167`）、補 D28／§9.4.1 落交付物摘要；或者喺檔頭加「快照時間 2026-11-15 01:49，之後 v3 有更新」。
10. **修規模數字**（`PLAN-v3.md:313`、`:322`）：15 → 14（或寫「10–15 條」）；§9.6 嘅 host 5 同「2–3 host」講清楚邊個係上限邊個係正常值。
11. **補計分缺口**（`PLAN-v3.md:83`、`:536`）：估數字題寫明「最接近嘅玩家 +2；並列最接近用編號細／或平分」；頒獎「允許重複」同「剩餘者」二選一，或者寫明重複開啟時規則覆蓋次序（`:234`）。
12. **補版面規格**（`PLAN-v3.md:279-281`）：加「1 組」排版；分數條 30 人（>12 人兩行之後）點縮，M0／M5 加 30 人排版驗收。
13. **media deck 同步規格補齊**：`deckId`／lease／「同一時間只一個音源」／換機移交（可參考 `PLAN-GPT.md:52` 但唔好照抄 SQLite 部分）；對應 `PLAN-v3.md:289`、`:402`。
14. **自動收卷開關**：加 config（例 `autoCloseOnAllSubmitted: boolean`）＋M1 驗收「關閉時全員答完唔會自動收」（`PLAN-v3.md:81`、`:442`）。
15. **前端框架／build 定案**：`PLAN-v3.md:430` 只有 vite；補一行「前端＝Vite＋（React／Vue／vanilla）」同 PWA 範圍，否則三端實作會各揀一套。

### P2 — 文件衞生（半日可清）

16. `PLAN-v3.md:33` D13 寫返原意：「v2 D13＝後備 server（Windows 機）；v3 廢除，改由 D27 講冇後備 server」。
17. 為「搗蛋鬼版本 A」加一條 D 編號（例如 D29），令 §4 嘅拍板可由 D 表追溯（`PLAN-v3.md:89`）。
18. 統一 `/stage`（刪 `summary:49` 嘅 `/screen`）；統一題數 20（`PLAN.md:224`、`:295`、`PLAN-v2.md:109`、`:376` 加 errata 或標 archived）。
19. `quiz.html:202` 初始題號「1 / 30」改「1 / 20」（要重建 site 先改到，屬 deploy 站改動，唔關新平台）。
20. `PLAN-v3.md:236` Q9 解釋「2^42」改返「2⁴²」（同原檔一致，純排版）。
21. `PLAN-v3.md:313` 「100–200MB RAM」加「（估算，未實測）」，或者 M0 加一條實測記錄。
22. 喺 `game-platform/` 加一個 `README.md`／`00-INDEX.md` 講清楚邊份係規格、邊份係歷史、邊份係另案，避免下次再出現「兩套 task book」。

---

## 附：核對方法、指令與未能確認清單

**用過嘅指令（全部只讀）**：`read`、`grep -rn`、`glob`、`wc -l`、`stat -c`、`ls -la`、`find`、`node --version`、`npm --version`、`command -v`、`curl -I`、`pdftotext … -`、Python（`ast`／`json` 逐題比對 QUIZ vs 附錄 A、重算頒獎例子、解析 D 表／mode enum）。

**未能確認（唔靠估）**：
- NAS 上 docker 容器清單、compose 實際狀態、NAS 檔案權限——冇 NAS SSH 憑證，只驗到 20013 站 HTTP 200 同 nginx 版本。
- Cloudflare Access 兩條 policy 實際設定、Tunnel 行為、Cloudflare WS 100 秒閒置斷線——今次冇 Cloudflare 帳戶存取。
- 「100–200MB RAM」——未實測（冇 server code）。
- iOS Safari 喺 HTTP 下「加入主畫面」全屏嘅具體行為——按文件記錄（`SESSION:80`），未能即場驗機。
- Node 版本政策最終揀邊個——需主持決定（本機只有 v26.8.1；Node 26 已 LTS 係官方資料，唔係估算）。
