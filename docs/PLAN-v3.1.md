# 派對遊戲平台 PLAN v3.1 — 4 關・手機投票／問答・大mon＋主持台

> 場次：2026 HBD《奔跑吧》主題生日派對（約 10 人、**分組彈性 0–N 組**、全粵語）
> 取代：`game-platform/PLAN-v3.md`（v3 保留做歷史）；v2 嘅 Rust 路線、NAS 部署早已廢除
> 狀態：v3.1（**2026-11-16 修訂 2**）— 三模型 final check ＋ 兩輪 QA 後修訂版：9 個 P0 已寫死、每關規則頁已入規格、題庫 canonical 已定案、**Docker 部署目標已寫明**（Windows server `192.168.99.20:30005`）
> 呢份係**唯一權威規格**。`PLAN-GPT.md`／`TASKS-GPT.md` 係另案（Socket.IO＋SQLite），**唔准照做**，只可以借條文；`PLAN.md`／`PLAN-v2.md`／`TASKS.md` 係歷史文件
> 舊站：現有 20013 靜態站（NAS nginx）係另一回事，照舊行；**新平台完全唔依賴 NAS**
> 審查記錄：`PLAN-v3-FINAL-CHECK.md`（三模型裁決）、`check/`（三份原始報告＋規則頁規格）

---

## 0. 一句話

> **一個後端（Windows server 上嘅 Node process）、三個前端（大mon／主持台／手機）、一套 6 種卡嘅引擎，用 rundown 推進 4 個 game。**
> 主持永遠係唯一可以改大mon 嘅人；手機只可以提交，唔可以影響場地畫面。

---

## 1. 決定記錄

| # | 決定 | 狀態 |
|---|---|---|
| D1 | 形態＝**本地網絡 Web app** + PWA（iPad「加到主畫面」即全屏）。唔做 native app | 已確認 |
| D2 | 手機端**只做「投票」同「問答」兩類單向提交**；唔做手機畫板 | 已確認 |
| D3 | 大mon **唯讀**，只跟主持指令，自己永遠唔跳畫面 | 已確認 |
| D4 | 後台＝**rundown 驅動**（下一項／skip／重排） | 已確認 |
| D5 | 計分＝**事件帳簿**，加錯標記作廢（undo），唔刪紀錄 | 已確認 |
| D6 | **v3.1 修訂**：Server＝**屋企 Windows server**，用 **Docker（docker compose）** 部署，host port **30005**；容器內 Node **26** LTS；cloudflared 同機行 Windows service。**server 唔搬去場地**（D31） | 已拍板 |
| D7 | 歌自備（MP3 為主，YouTube／Apple Music link 亦可）；後台先入歌名，link 後補 | 已確認 |
| D8 | 交付日期唔設死；scope 以 M0–M4 全做為目標，逐關交付 | 已確認 |
| D9 | 分組完全彈性：組數 0–N，0 組＝個人戰 | 已確認 |
| D10 | **v3 改**：大mon＝**Windows 或 Mac**，Chrome kiosk，唔跑 server | 已拍板 |
| D11 | **v3.1 改**：對外入口**只有 Cloudflare Tunnel**（server 留屋企，見 D31）；LAN 直連只用喺屋企綵排，唔係場地後路；DDNS＋port forward 砍咗 | 已拍板 |
| D12 | 歌單兩種入歌方式：貼 link 同直接上傳 MP3 | 已確認 |
| D13 | **v3 廢**（被 D27 取代）：冇後備 server | — |
| D14 | **v3.1 改**：語言＝**全棧 TypeScript，Node 26 LTS（fastify + ws）**；production 行 compiled JS；**唔留任何 Rust 分支／平行實作** | 已拍板 |
| D15 | 手機入場自訂名稱＋頭像（emoji＋底色，第一版唔做相片上傳） | 已確認 |
| D16 | 大mon 常駐分數條（主持可一鍵收起）＋全屏分數一鍵模式 | 已確認 |
| D17 | 每位玩家有參賽者編號（1..N，主持可改） | 已確認 |
| D18 | 分數排序可揀：分數↓／↑／編號／名／組 | 已確認 |
| D19 | 結算頁 finale：全屏分數＋統計＋逐個揭曉三獎 | 已確認 |
| D20 | 頒獎＝大獎最高分、2獎最接近中位數、3獎最低分 | 已確認 |
| D21 | 分數可切「當前環節分／總分」 | 已確認 |
| D22 | 問答關＝出題 → 分佈 → 揭曉 三段流水線；題庫後台可編輯 | 已確認 |
| D23 | **v3 新**：Host panel **可多開**（Mac 播歌＋iPad 控台同時）；新增 **media deck view** 做音源，大mon song mode 預設靜音 | 已拍板 |
| D24 | **v3 新**：對外＝**一個 hostname＋path**；Cloudflare Access 鎖 `/host` 同 `/api/host/*`；`/play` `/stage` `/ws` 公開 | 已拍板 |
| D25 | **v3 新**：API namespace 重構——所有 host-only endpoint 收入 `/api/host/*` | 已拍板 |
| D26 | **v3.1 改**：驗收用 `bots.mjs` 模擬 **30 個 approved 玩家**（10 人場 ×3 壓測）＋2 host＋1 stage；先 bots 後真機。30 係名額上限，唔係「仲有餘量」，所以同一輪唔可以再加真機 | 已拍板 |
| D27 | **v3 新**：NAS 喺新平台**完全退役**——唔跑 server、唔做備份；最後防線＝列印包＋手動計分 | 已拍板 |
| D28 | **v3 新**：**Resync／refresh recovery 係核心功能**。斷線自動復原，任何角色都唔應被要求手動 refresh；意外 refresh 後要保留同一身份、最後畫面、未提交草稿同操作進度。Server ACK 前本地資料唔准清 | 已拍板 |
| D29 | **v3.1 新**：搗蛋鬼定案＝**版本 A（潛伏者）**；投票邊界同計分見 §4 | 已拍板 |
| D30 | **v3.1 新**：每關有**規則頁（RulePage）**：開場前大mon 自動顯示、後台可編輯（§6.1／§8.1／§8.4） | 已拍板 |
| D31 | **v3.1 新**：Server **留屋企**；對外只經 Cloudflare Tunnel。LAN 直連只限屋企綵排；場地斷 WAN 嘅後路＝**手機熱點頂 WAN**（Tunnel 唔變）＋列印包手動計分。**部署目標＝`192.168.99.20:30005`（Docker），Tunnel ingress 指 `http://localhost:30005`** | 已拍板 |
| D32 | **v3.1 新**：拍賣估歌**只做 points 模式**；seconds（用分數買秒數）砍走 | 已拍板 |
| D33 | **v3.1 新**：PWA 只做「加到主畫面」全屏 meta；**唔做 service worker／離線 app shell** | 已拍板 |
| D34 | **v3.1 新**：題庫 canonical＝**附錄 A 新版 20 題**（MC 10 題沿用 `deploy/live_page.py` QUIZ 逐字；open 10 題新寫）；print-pack PDF 要由同一份 seed 重 build | 已拍板 |

---

## 2. 為咩「手機只做投票＋問答」係最划算嘅一刀

手機端嘅風險同成本 90% 喺 canvas：iOS Safari pointer 事件、Android 機型差異、筆跡批次上傳、大mon 縮圖牆延遲。砍走佢＝砍走成個 project 最大嘅不確定性。

換到嘅嘢：自動計分、匿名投票、每人身份（分組自動跟）、全場答案分佈圖（大mon 柱狀圖）、出價競投（bid＝投票變體）。**手機端只有有限表單：`choice` 四粒大掣、`vote` 揀人、`bid` 數字鍵盤、`open` 文字框／數字框；冇 canvas、冇自由繪圖、冇複雜手勢。**

---

## 3. 四關 × 三端

| 關 | 大mon（唯讀） | 主持台（可多開） | 手機（單向提交） |
|---|---|---|---|
| **1. 拍賣時間估歌** | 競投走勢、倒數、播放狀態、逐個揭曉（**靜音，只出畫面**） | 開拍／收拍、播放指令（**音源＝唯一 media deck；大mon 永遠唔出聲**） | 出價（數字鍵盤） |
| **2. 一圖多用畫畫猜人** | 原圖、作品牆、單張放大、評審結果 | 上載圖、影相上牆、+1／+2 | 投票「邊張最似」 |
| **3. 搗蛋鬼（版本 A，已拍板）** | 身份已發、投票進度、票數、淘汰 | 派身份、睇全場身份、裁決 | 收秘密身份、投票 |
| **4. 問答** | 題目、倒數、答案分佈、揭曉 | 開卷／收卷／揭曉 | A／B／C／D |

畫畫作答走「紙畫 → 主持影相 → 上牆」，唔走 canvas。

### 3.1 問答關 — 完整流程

| # | 階段 | 大mon | 手機 | 主持台 |
|---|---|---|---|---|
| 1 | `question` | 題目大字＋選項＋倒數＋「已答 7/10」 | 四粒大掣；揀完變「確認送出」 | 「立即收卷」、未答名單 |
| 2 | `tally` | 每個選項下面貼晒揀佢嘅人嘅頭像（**未公佈正解**） | 「已提交，等其他人」 | click 玩家 → 放大問原因 |
| 3 | `reveal` | 正解高亮＋解釋彈出 | 正解＋解釋＋我對定錯 | 「下一題」 |

**關鍵設計**：① tally 同 reveal 一定分開（未公佈答案先可以問「點解揀 C」）；② 兩步確認（揀完要撳「確認送出」，確認後唔可以改，要改由主持重開該題）。

**計時**：伺服器權威 `endsAt`，逐題可改（**MC 預設 20 秒、open 預設 45 秒**）。「全員提交 → 自動收卷」嘅**分母＝開題時鎖定嘅 eligible roster**（見 §6 `Round.eligiblePlayerIds`）：pending／kicked 唔計、offline 照計、late join 下一輪先計；auto-close 開關預設開，關咗就只可以主持手動收。主持可隨時立即收卷。**倒數顯示以 server 時鐘為準**（見 §9.5 clock offset），唔信手機本地時鐘。**估「而家到 12 點有幾多分鐘」呢類題：server 喺收卷 transaction 固定 `closedAt`，用 `Asia/Hong_Kong` 計到下一個 00:00，再 floor 完整分鐘，計完寫入 `actualAnswer`；主持唔可以手改（要改就 void 重開）。**

**計分**：選擇題自動 +N（帳簿 reason「問答 Q3」）；open 主持逐個評（+1／+2／自訂）或一次過全部當答對；**估數字題：最接近者 +2，並列最接近者全部 +2**（`target=player`，`reason="問答 Q14・估數字"`）；時間題嘅 `actualAnswer` 由 server 自動計（見上）。

**題庫**（後台隨時改，唔使改 code）：預設 10 選擇＋10 open（附錄 A），全部係資料（類型／題目／A-D／正解／解釋／主持貼士／秒／分／`openKind`）；加刪改拖曳排序、複製上一題；**「一鍵匯入舊 QUIZ」只匯入 MC 10 題**（open 題只顯示 diff、要主持逐題確認，唔會覆蓋附錄 A 新版 open 題，見 D34）；大mon 同手機永遠唔會見到正解同解釋，直到 reveal。

---

## 4. 搗蛋鬼：**版本 A（潛伏者）— v3.1 定案**（D29）

**玩法**：主持派身份，1 人抽到搗蛋鬼（`Player.secretRole="saboteur"`，只送本人）；搗蛋鬼知道正解但唔可以太明顯；全體進行 2 輪投票揪人。時長 12–15 分。零件＝派身份＋投票＋淘汰＋主持全場視圖（呢個畫面本身就好有戲）。

**投票邊界（寫死）**
- 每輪 eligible＝**未被淘汰嘅玩家**；**唔可以投自己**（前端 disable＋server 拒絕 `W_SELF_VOTE`）；唔提交＝棄權。
- 平票（最高票多過一人）→ host 台顯示平票名單，主持一鍵揀「**重投一次**」或「**主持裁決揀一人**」；裁決要留 activity toast。
- 第一輪被淘汰者：第二輪**唔可以投、唔可以被投**，但保留全部分數同頒獎資格；stage 顯示淘汰名單。
- 兩輪之間由主持用 manual 卡／口頭帶一個小任務（引擎唔強制）。
- 開票前 stage／player **只出投票進度**（已投幾多人），唔出任何個人票；主持台（host-only view）可見逐人票。

**計分同結算（寫死，寫入帳簿）**
- **淘汰條件（唯一，唔准另寫）**：每輪計票後，`validVotes`＝已提交、非棄權嘅票數；候選人＝最高票者。
  - 如果候選人票數 **≥ ⌊validVotes/2⌋+1（嚴格過半）** → 即場淘汰。
  - 如果**唯一最高票但未過半**（例：10 票分 4／3／3）→ **唔會自動淘汰**；主持揀「**重投一次**」或「**裁決淘汰佢**」（裁決＝當作淘汰）。
  - 如果**平票**（最高票多過一人）→ 同上：主持揀重投或裁決一人。
  - `validVotes=0`（全體棄權）→ 當輪冇人淘汰；主持揀重投或直接入下一輪。
- **揪中（第一輪或第二輪都一樣）**：搗蛋鬼**被淘汰**（唔係單睇票數，係睇最終淘汰結果）＝揪中。搗蛋鬼即場淘汰、**公佈身份**（`mode="role-reveal"`，同一 transaction 自動寫入 `revealedRole`）、遊戲即刻完結。**每位投畀搗蛋鬼嘅玩家各 +3**（`target=player`，`reason="搗蛋鬼・揪中"`）；搗蛋鬼冇 +5。
  - 第一輪揪中＝唔使投第二輪，直接結算。
  - 第二輪揪中＝照上面同一條規則。
- **兩輪都揪唔中**：搗蛋鬼 **+5**（`target=player`，`reason="搗蛋鬼・潛伏成功"`），其餘玩家冇分。
- **重投語義（唯一）**：重投＝**新 round**（`{cardId}#{openCount+1}`，`Round.retryOf` 指原 round），原 round 標 `void`；原票**保留但唔計分**；候選人同 eligible 名單不變；**每輪最多重投一次**，再平票一定主持裁決。**+3 只按「決定性一輪」（最終淘汰／揪中嗰輪）嘅票派**，重投 round 一樣照呢條。
- **第一輪淘汰嘅係好人**：第二輪照跑，被淘汰者唔可以投／唔可以被投，但保留分數同頒獎資格。
- 有分組時照個人計（組分自動跟 §6 公式），**唔開 group target**。
- 同一輪重連／重送唔可以重複派分（綁 `roundId`，見 §6／§7）。

---

## 5. 引擎：6 種卡

```
零件
├─ Card       題目／圖片／投票／出價 一張卡 = 一個回合
├─ Round      每次開題（包括重開）一個新 roundId；作答／收卷／計分邊界都綁住佢
├─ Timer      伺服器權威 endsAt + serverNow clock offset（各機誤差 ≤ 0.5s）
├─ Ledger     計分事件帳簿（可 void、可重播）
├─ Rundown    環節清單（下一項／skip／重排／插入）
└─ RulePage   每關規則頁（開場前大mon 顯示、後台可編輯；見 §6.1）
```

| 卡型 | 用喺邊 | 手機見到 |
|---|---|---|
| `choice` | 問答 | A/B/C/D 四粒大按鈕 |
| `open` | 開放題／估數字（`openKind: "text" \| "number"`） | 文字輸入／數字鍵盤 |
| `vote` | 畫畫「最似」、搗蛋鬼投票 | 揀人／揀選項 |
| `bid` | 拍賣估歌出價（**只做 points 模式**，D32） | 數字鍵盤＋出價上限 |
| `media` | 播歌、出圖、作品牆 | 冇（純大mon／media deck） |
| `manual` | 主持手動加減分、計時器 | 冇 |

歌單係獨立嘅庫（bid 卡用 `songId` 引用，media 卡都可以）。**拍賣只做 points 模式（D32）**：「用分數買聽歌秒數」嗰個 seconds 版本砍走，日後要復活先加 `bidMode` 欄同結算規則。

**搶答（Buzz）喺 v3.1 砍走**：四關冇搶答環節，六種卡型亦冇一種會觸發；日後要加就補一個 `buzz` 卡型＋對應關卡，唔好留孤兒規格。

### 5.1 拍賣估歌結算（唯一定義）

- 每人密封出價一次：`0 ≤ 出價 ≤ Card.maxBid`（預設 100）；**出價唔扣分**（純競投估歌權，唔係買）。
- **最高價得標**；**同價 → 先交者贏**（以 server 收到時間排序）。得標者獨得估歌權，其餘玩家冇分、冇扣分。
- 得標者喺 playback 後限時 10 秒內講答案；主持撳 reveal 後 stage 先出歌名（reveal 之前任何 mode 都唔出歌名，見 §7／§8.1）。
- 答對：得標者 **+Card.points**（預設 5，`reason="估歌 S3"`）。答錯：0 分；可選「**次高價者補答**」開關（預設關；開咗補中得一半分，無條件進位）。
- 多輪拍賣＝多張 bid 卡，各自獨立結算；每筆帳簿帶 `gameId`／`roundId`／`reason`，方便賽後對數。

### 5.2 畫畫猜人結算（唯一定義）

- **投票**：每個玩家每輪只可投**一張作品**（可以投自己，照計）；唔投＝棄權。
- **人氣票**：每張作品每得一票，**作者 +1**（`target=player`，`reason="畫畫・人氣票"`）。
- **最似獎**：最高票作品（**並列都算**）每位作者額外 **+2**（`reason="畫畫・最似獎"`）。
- **主持評審**：評審台選中作品後按 1／2／0 → 作者 **+1／+2／void 上一筆**（`reason="畫畫・主持評分"`）；帶 `commandId`，重複撳唔會重複加。
- **入帳時機**：投票同評審都喺 `reveal` 之後一次過入帳；投票階段唔會即時加分（免得見到分數影響投票）。
- **數字例**：10 張作品、10 人各投一票；作品 A 得 3 票 → +3，係最高票再加 +2；作品 B 得 2 票 → +2；其餘各 1 票 → +1。主持再俾 A 作者 +2 → A 作者總共 **+7**。

### 5.3 open 卡輸入規則（`openKind`）

- `openKind="text"`：文字框，≤60 字，空字串拒絕（`W_BAD_SCHEMA`）；最長 45 秒。
- `openKind="number"`：數字鍵盤，**整數或最多 1 位小數**、`0 ≤ x ≤ 999999`、唔准負數；空值拒絕。
- Submission 只用對應欄位：text 卡用 `text`、number 卡用 `amount`；用錯欄位 → `W_INVALID_OPEN_KIND`。
- 題庫 seed 每個 open 題一定要有 `openKind`（附錄 A.2 已標「估數字」／「短答」）。

之後加第 5、6 個 game，只需加一個新 stage 版面，唔使改引擎。

---

## 6. 資料模型（TypeScript；**公開 DTO 共用，server 私有模型分開**）

> **v3.1 修訂**：下面啲 type 係 **server 內部 model 嘅總表**。對外三個 DTO（`HostView`／`StageView`／`PlayerSelfView`）唔係「共用同一個 type」，而係由**明確 allowlist 逐欄投影**出嚟——`secretRole`／`saboteurAnswer`／`correct`／`explanation`／`referenceAnswer`／`actualAnswer`／`hint`／`Song.title`／`revealedRole` 只可以按 §7「披露矩陣」喺指定角色、指定階段出現。**unfiltered server model 永不直送任何 client**（唔准 `...spread` 出去）。

```ts
type Room = {
  id: string; code: string;            // 4 位數字房碼
  phase: "idle" | "lobby" | "playing" | "final" | "award";
  groups: Group[];                     // 0..30（非空組），0 組 = 個人戰
  players: Player[]; rundown: RundownItem[];
  rulePages: RulePage[];               // 每關規則頁（D30／§6.1）
  awards: Award[];
  currentItemId: string | null;
  currentRoundId: string | null;       // 當前開住嘅回合（null＝冇卡開住）
  rounds: Round[];                     // 每個開題（含重開）一筆，見 §6
  stage: StageState; seq: number;      // seq＝傳輸序號（每筆 patch +1）
  revision: number;                    // revision＝業務版本（每次成功 command +1，expectedRevision 用）
  seqEpoch: string;                    // journal 分卷／重啟用，見 §9.7
  audioLease?: AudioLease;             // 唯一音源 lease（持久化，見 §8.2）
};

type Group = { id: string; name: string; color: string; order: number; archived?: boolean };

type Avatar = { kind: "emoji" | "photo"; emoji?: string; color: string; url?: string };

type Player = { id: string; name: string;
  number: number;                      // 參賽者編號 1..N，全房唯一（入場次序，主持可改；撞號拒絕 W_DUP_NUMBER，kick 唔回收號，新玩家派最大號+1）
  groupId: string | null;
  status: "pending" | "approved" | "kicked";
  connected: boolean; lastSeen: number;
  avatar: Avatar;
  secretRole?: string };               // 搗蛋鬼用，唔會 broadcast 去 stage 或其他玩家

type RundownItem = { id: string; index: number; gameId: string;
  title: string; state: "todo" | "running" | "done" | "skipped";
  cardIds: string[];
  rulePageId?: string;                 // 覆寫：呢個 item 用邊頁規則；缺省＝用 gameId 對應嘅 enabled 頁
  rulesText?: string;                  // ≤300 字 fallback（缺頁時顯示） };

type Song = { id: string; index: number;
  title: string;                       // 答案（歌名）—— 大mon 永遠唔會見到
  hint?: string;
  source: { kind: "file" | "youtube" | "apple" | "external";
            url?: string; fileName?: string };
  playlistRef?: string;                // Apple Music 純提示，唔控制播放
  playWindow?: [number, number];
  state: "draft" | "ready" | "played" };

type MediaPlayback = { songId: string; deckId: string | null;   // 唯一 active 音源
  playStartedAt: number;                 // server 時鐘，ms（deck 回 ready ACK 之後才落）
  state: "idle" | "preparing" | "playing" | "paused" | "failed";
  pausedAt?: number;                     // ms
  resumedAt?: number;                    // ms；pause→resume 之後嘅起播時間
  positionMs: number;                    // 已播毫秒：playing＝positionMs＋(now−resumedAt)；paused＝positionMs
  window: [number, number]; by: string };     // 邊個 host 撳嘅（activity toast 用）

type AudioLease = { deckId: string; hostId: string;
  generation: number;                    // 每次轉手 +1；舊 generation 嘅指令一律拒絕
  leaseUntil: number };                  // server 時鐘 ms；一次只一個 active deck；見 §8.2

type Card = { id: string;
  type: "choice" | "open" | "vote" | "bid" | "media" | "manual";
  category?: string;                   // 題庫分類（動物／食物／…），host-only
  prompt: string; imageUrl?: string; mediaUrl?: string;
  options?: string[];
  correct?: number;                    // 正解 index —— 只在 reveal 之後先送去 stage／player
  explanation?: string;
  referenceAnswer?: string;
  hint?: string;                       // 主持貼士（host-only，永遠唔送 stage／player）
  openKind?: "text" | "number";        // open 卡必填：text＝文字框、number＝數字鍵盤（見 §5.3）
  maxBid?: number;                     // bid 卡上限（預設 100）
  seconds: number | null;              // MC 預設 20 秒、open 預設 45 秒
  points: number;
  actualAnswer?: number;               // 估數字題：主持輸入；時間題由 server 自動計（§3.1）
  version: number;                     // 內容版本；每次改題 +1（Round.cardVersion 綁呢個）
  state: "draft" | "open" | "closed" | "tally" | "revealed" };

type Submission = { id: string;                 // submissionId：client 撳「確認送出」嗰刻生成（UUID v4）
  roundId: string; cardId: string; playerId: string; ts: number;
  kind: "choice" | "open" | "vote" | "bid";
  choice?: number; amount?: number; text?: string;
  confirmed: boolean;                  // 兩步確認
  payloadHash: string;                 // 同 ID 但 payload 唔同 → 拒絕（W_ID_PAYLOAD_MISMATCH）
  onBehalfOf?: string; byHost?: boolean;  // 主持代答：記低原玩家
  judged?: { correct: boolean; points: number; by: "auto" | "host" } };

type Round = { id: string;               // 格式 `{cardId}#{openCount}`；重開／重投＝新 round
  cardId: string; cardVersion: number;  // 開題嗰刻嘅 card 版本
  retryOf?: string;                     // 重投／重開時指返原 roundId（原 round 已 void）
  endsAt: number | null;                // server 時鐘
  closedAt: number | null;
  state: "open" | "closed" | "tally" | "revealed" | "void";
  eligiblePlayerIds: string[];          // 開題時鎖定嘅名單（自動收卷分母、代答對象）
  actualAnswer?: number;                // 估數字／時間題計完寫入
  autoClosed?: boolean };               // 自動收卷只能執行一次

type ScoreEvent = { id: string; ts: number;
  target: { type: "player" | "group"; id: string };
  gameId?: string; roundId?: string; cardId?: string;
  submissionId?: string;
  lineage?: { sourceEventIds: string[] };   // 換組搬分時指返原始事件
  delta: number; reason: string;            // 例「問答 Q3」「搗蛋鬼・揪中」
  by: "host" | "auto"; voided?: boolean };

type SortKey = "score-desc" | "score-asc" | "number" | "name" | "group";

type StageState = { mode: "idle" | "rules" | "scoreboard" | "question"
  | "tally" | "reveal" | "draw-wall" | "draw-focus" | "bid" | "vote" | "role-reveal"
  | "song" | "leaderboard" | "finale" | "award" | "timer" | "blackout";
  payload: Record<string, unknown>; lock: boolean;
  prevMode?: "idle" | "rules" | "scoreboard" | "question" | "tally" | "reveal"
  | "draw-wall" | "draw-focus" | "bid" | "vote" | "role-reveal" | "song"
  | "leaderboard" | "finale" | "award" | "timer";   // 收 rules／blackout 後返去邊
  rulePageId?: string;                 // mode="rules" 時顯示邊頁
  ticker: { visible: boolean; scope: "player" | "group";
            range: "current" | "total"; sort: SortKey } };

type Award = { id: "grand" | "second" | "third";
  targetId: string | null; rule: "max" | "nearest-median" | "min";
  manual: boolean; revealed: boolean };

type RuleBlockType = "heading" | "paragraph" | "bullets" | "steps"
  | "callout" | "kv" | "score-table" | "image";

type RuleBlock = { id: string; type: RuleBlockType;
  text?: string;                       // heading／paragraph／callout／kv key／image alt
  items?: string[];                    // bullets／steps／score-table（≤6 item）
  value?: string;                      // kv 嘅 value（例 "20 秒"）
  imageUrl?: string;                   // image block 用：/media/rules/<randomId>（host 上載，見 §9.8）
  icon?: string;                       // 一個 emoji
  emphasis?: "normal" | "hot" };       // hot＝大一級字＋高亮色

type RulePage = { id: string;
  gameId: string;                      // 對應 RundownItem.gameId
  title: string; subtitle?: string;    // ≤16 字／≤24 字
  blocks: RuleBlock[];                 // ≤20
  order: number;                       // 全房唯一
  enabled: boolean;                    // 每個 gameId 最多一頁 enabled
  autoAdvanceSeconds: number;          // 分頁自動轉頁；0＝純手動（預設 0）
  updatedAt: number; version: number; updatedBy: string;
  archived?: boolean };
```

### 狀態機主從（唯一定義）

三套狀態並存，但主從寫死：

| 層 | 角色 | 由邊個推進 | 規則 |
|---|---|---|---|
| `Card.state` | **唯一遊戲進度權威** | card 動作（open／close／tally／reveal） | 只有 server 改；host 手動切 mode **唔會**改佢 |
| `Round.state` | 回合邊界（作答／收卷／計分） | 開題／收卷／作廢 | 每次 open（包括重開）產生新 `roundId`；舊 round 一律 `void` |
| `StageState.mode` | **派生＋可覆寫嘅顯示狀態** | card 動作自動派生／host 手動覆寫 | 唔可以用 mode 推斷遊戲進度 |
| `Room.phase` | 粗粒度生命週期 | 只由 rundown 推進 | todo→running→done/skip；全 done→final；host 撳頒獎→award |

**優先級（高→低）**：`blackout` > `StageState.lock` > host 手動切 mode > card 動作自動派生。
- `lock=true` 時 card 自動派生唔會改 mode（同 §8.1「lock 一開主持改卡都唔影響」一致）；host 手動切 mode 照生效（等於 host 主動覆寫）。
- `mode=question/tally/reveal` 只准喺 `phase=playing` 出現；`phase=final` 凍結所有 card 動作（`W_WRONG_PHASE`）。
- `phase=final` 同 `mode=finale` 係兩件事：`finale` 係顯示版，`final` 係流程狀態。
- snapshot 一次帶 `phase`／`mode`／`card.state`／`round.state` 四樣，**client 唔准自行推導**。

**狀態轉移表（action → 結果，M0 test oracle）**

| action | 前置 | Card.state | Round.state | mode（lock=false） | phase | 錯誤碼 |
|---|---|---|---|---|---|---|
| create card | phase=playing | draft | — | 不變 | playing | `W_WRONG_PHASE` |
| open | phase=playing 且 card 冇開住 | open | 新 round `open` | question | playing | `W_WRONG_PHASE`／`W_ALREADY_STATE` |
| close | round.state=open | closed | closed | tally | playing | `W_ALREADY_STATE` |
| tally | round.state∈{closed,open} | tally | tally | tally | playing | `W_ALREADY_STATE` |
| reveal | round.state∈{closed,tally} | revealed | revealed | reveal | playing | `W_WRONG_PHASE` |
| reopen | card.state=revealed | open | 舊 round→`void`、新 round `open` | question | playing | `W_STALE_COMMAND` |
| void round | round.state≠void | 不變 | void | 不變 | 不變 | `W_ALREADY_STATE` |
| rundown/next | 任何 | 未開 card 保持 draft | 未完成 round→void | rules（新關）或 idle | playing；全 done→final | — |
| award | phase=final | — | — | award | award | `W_WRONG_PHASE` |
| host stage.set | 任何（blackout 期間除外） | 不變 | 不變 | 指定 mode | 不變 | `W_STAGE_LOCKED` |

> `lock=true` 時：自動派生（open／close／tally／reveal／rundown）**唔會改 mode**，其餘欄位照上表；host 手動 `stage.set` 照生效。`blackout=true` 時全部 stage 指令拒絕（`W_STAGE_LOCKED`），收 blackout 後返 `prevMode`。

### 6.1 每關規則頁（RulePage，D30）

- 每關（gameId）有自己一頁規則，內容放 `Room.rulePages`；rundown item 用 `rulePageId` 引用，缺省＝該 gameId 嘅 enabled 頁。
- **自動觸發**：`rundown/next`／`/prev`／`/reorder`／`/skip` 令 `currentItemId` 轉去**另一個 gameId**（包括重玩同一關、跳返之前關）時，server 自動 `stage.set {mode:"rules", payload:{rulePageId, autoAdvanceSeconds, pageIndex:0, totalPages}}`；host 撳「開始呢關」先出第一張卡。**規則頁唔倒數、唔自動離開**。
- **純顯示態**：出／收規則頁唔改任何 `Card.state`／`RundownItem.state`／`Submission`；收頁返 `prevMode`。
- **後台可編輯**：`/host` 規則頁編輯器（見 §8.4）；所有寫入 API 收 `/api/host/rules*`，player token 冇寫入權。
- 缺頁 fallback：顯示 `RundownItem.rulesText`（若有）或 item title＋「等主持開始」，流程照推唔阻。
- 版面／blocks／限制／預設四頁文字：見 §8.1（rules）、§8.4、附錄 B。

### 計分唯一公式（唔准另外寫 group.score 欄位）

```
playerScore(p) = Σ delta  scoreEvents(非 voided, target = player p)
groupScore(g)  = Σ delta  scoreEvents(非 voided, target = group g)
               + Σ playerScore(p) for p.groupId === g
```

1. 個人答對 → target=player，組分自動跟住升
2. 組獎勵 → target=group
3. 「全場 +1」→ 展開成每位在場玩家一筆（唔設 all target）
4. Undo＝voided:true，重算即還原，歷史永遠保留
5. 每筆必有 reason（例「問答 Q7」），方便賽後對數

### 換組語義

搬一個有分嘅人時，主持台一定問：「分數跟人走」（預設）或「分數留返原組」（佢嘅 player 事件轉成一筆 group 事件寫入原組，個人由 0 開始）。支援「上半場分隊、下半場個人戰」。

**帳簿可重播契約（一次搬組＝一個 journal transaction）**：①原 player 事件 `voided:true`（唔刪）→②一筆 `target=group` 補償事件，`lineage.sourceEventIds` 指返原事件→③`player.groupId` 改動→④activity toast。同一 `commandId` 重送回原結果；多次搬組＋undo＋export→replay 之後要對得返數（M0 驗收）。

### 頒獎計算

| 獎 | 規則 |
|---|---|
| 大獎 | 最高分 |
| 2獎 | 距離中位數最近 |
| 3獎 | 最低分 |

```
median  = n 奇數 → 中間嗰個；n 偶數 → 中間兩個平均
dist(x) = |score(x) − median|
大獎 ＝ max（同分→編號細）
2獎 ＝ 剩餘者 dist 最小（同 dist→分數高；再同→編號細）
3獎 ＝ 剩餘者 min（同分→編號細）
```

邊界寫死：n 奇數 → 中位數嗰位 dist=0 直接贏 2獎（合法預期）；全部同分 → 大獎編號最細，2/3獎按編號；大獎先派，2獎一定落喺剩餘者。**n<3 逐個獎列明**：n=0 三獎全缺；n=1 只有大獎；n=2 大獎＋3獎（2獎從缺）；n≥3 三獎齊。三個可調項：tie-break、允許重複開關、個人／按組。**「允許重複」優先級**：預設**關**（跟上面「剩餘者」規則）；開咗就取消剩餘者限制，三個獎各自由全體獨立揀（可同一人得兩個獎），tie-break 照舊。**中途離場**：主持逐個標記「唔計入頒獎」，唔影響中位數；結算前列出「計幾多人、中位數幾多」，一按鎖定。主持台同時顯示平均、中位數、每人 dist、自動結果、「手動改」掣。

**例子（10 人）**：分數 5 8 12 15 18 22 25 30 33 40 → 中位數 20；大獎 40；2獎 18/22 同 dist=2 → 分高 → 22；3獎 → 5。

---

## 7. 協議

### WebSocket `/ws`（token 喺 hello 首訊息，**唔行 URL query**，避免落 proxy log）

| 方向 | 訊息 | 說明 |
|---|---|---|
| C→S | `hello` {role, code, sessionToken, clientInstanceId, lastSeq} | sessionToken 用嚟恢復身份；clientInstanceId 區分新舊 socket。**role 只作提示，server 以 session 為準** |
| S→C | `hello.ok` {role, playerId?, serverNow, seqEpoch} | 確認身份；之後先送 snapshot |
| S→C | `snapshot` {seq, seqEpoch, serverNow, stateHash, view} | **每次連線／重連都送 role-filtered snapshot**；細房間唔維護複雜 delta replay，確保一次恢復完整 |
| C→S | `resync` {lastSeq, stateHash} | 正常連線期間發現跳號／hash 不符即主動要求 snapshot |
| S→C | `patch` {baseSeq, seq, serverNow, ops[]} | `score.append`／`card.update`／`round.update`／`stage.set`／`submission.add`／`rundown.set`／`rules.update`／`award.update`／`media.play` |
| C→S | `submit` {roundId, submissionId, payloadHash, payload} | 同一玩家同一 round 只收一份最終答案；重送同一 ID 回原收據 |
| S→C | `submit.result` {roundId, submissionId, status, receipt?} | **journal 落盤之後先 ACK**；過期／已收卷明確拒絕（`W_ROUND_CLOSED`） |
| C→S | `ping` {clientT0} | clock offset 取樣（見 §9.5） |
| S→C | `pong` {clientT0, serverNow} | client 用 `(T1−T0)` 計 RTT、取最低 RTT 樣本 |
| S→C | `error` {code, message} | 穩定 error code（見下）；message 只作 debug，前端只准 switch `code` |

**穩定 error code 清單（前端只准 switch code，唔准 parse message）**：
`W_BAD_MSG`／`W_BAD_SCHEMA`／`W_ROOM_FULL`／`W_ROOM_LOCKED`／`W_WRONG_PHASE`／`W_STALE_COMMAND`／`W_CMD_PAYLOAD_MISMATCH`／`W_ID_PAYLOAD_MISMATCH`／`W_ROUND_CLOSED`／`W_ALREADY_STATE`／`W_SELF_VOTE`／`W_DUP_NUMBER`／`W_TOKEN_EXPIRED`／`W_FORBIDDEN_ROLE`／`W_RATE_LIMIT`／`W_UPLOAD_REJECTED`／`W_RULES_LIMIT`／`W_RULES_CONFLICT`／`W_INVALID_OPEN_KIND`／`W_NO_AUDIO_LEASE`／`W_AUDIO_READY_TIMEOUT`／`W_STAGE_LOCKED`。
> 呢個清單係**封閉集合**：新增 error code 一定要先加落呢度。malformed JSON → `W_BAD_MSG`；**結構／型別 schema 錯** → `W_BAD_SCHEMA`；**唯一例外**：payload 結構合法但同 `Card.openKind` 唔匹配（例如 number 卡送 `text`）→ `W_INVALID_OPEN_KIND`。

**角色／保密規則（v3.1 改寫，取代舊「永遠唔送」）**

三個 DTO：`HostView`（主持全部）、`StageView`（只顯示）、`PlayerSelfView`（自己＋公開）。**server 私有 model 唔會直接 spread 出去**（見 §6 開頭）。披露矩陣：

| 資料 | HostView | StageView | PlayerSelfView | 幾時開始 |
|---|---|---|---|---|
| `secretRole` | ✅ 全部人 | ❌ | ✅ **只送本人** | 派身份後 |
| `saboteurAnswer`（潛伏者專用正解） | ✅ | ❌ | ✅ **只送搗蛋鬼本人** | 派身份後 |
| `correct`／`explanation` | ✅ | ✅ 只 reveal 後 | ✅ 只 reveal 後 | `card.state="revealed"` |
| `referenceAnswer`／`actualAnswer` | ✅ | ✅ 只 reveal 後 | ✅ 只 reveal 後 | 同上 |
| `hint`（主持貼士） | ✅ | ❌ 永遠 | ❌ 永遠 | — |
| `Song.title` | ✅ | ✅ **只 `mode="reveal"` 且主持撳咗 reveal** | ❌ | 主持 reveal |
| `revealedRole`（公開身份） | ✅ | ✅ 揪中結算即出 | ✅ 揪中結算即出 | 揪中 transaction 自動寫入＋自動切 `role-reveal`（唔等主持再撳） |
| 個人票／個人答案 | ✅ | ❌（只出進度／aggregate） | ✅ 只自己 | — |

- **`role-reveal` 唔可以用 `secretRole` 直接 broadcast**：要另外寫 `revealedRole`（公開欄）；**揪中結算嘅同一個 transaction 自動寫入 `revealedRole` 並自動切 `mode="role-reveal"`**，主持唔需要另撳（想延後畫面可以用 lock／blackout，但資料已經公開咗）。
- **搗蛋鬼要知正解**：唔係放寬 `correct` 畀所有人，而係派身份時另外送 `saboteurAnswer` 只俾佢本人。
- stage／player 收到嘅每個 payload 都過 role filter；M1/M2/M4 sniffer 要覆蓋首連、重連、HTTP、build 產物、localStorage、export，並測 reveal 前後兩個階段。

### HTTP（host-only 全部入 `/api/host/*`，一個 Access policy 蓋晒）

| Method | Path | 權限 | 用途 |
|---|---|---|---|
| POST | `/api/host/login` | Cloudflare Access＋PIN | 換 host token（TTL 8 小時，可調） |
| POST | `/api/join` | 公開（rate limit） | {code, name, avatar} → playerToken |
| PATCH | `/api/host/players/:id` | host token | 改名／分組／approve／kick／改編號 |
| POST | `/api/host/groups`・`/groups/assign` | host token | 一鍵 0/2/3/N 組、搬人、改組名 |
| POST | `/api/host/cards`・`/:id/open`・`/:id/close`・`/:id/tally`・`/:id/reveal`・`/:id/reopen` | host token | 出卡流程（`reopen`＝新 round，舊 round void） |
| POST | `/api/host/quiz`（CRUD）・`/quiz/import`・`/quiz/reorder` | host token | 題庫編輯／一鍵匯入（只 MC，或 diff 保留新 open 題） |
| POST | `/api/host/score`・`/score/:eventId/void` | host token | 加減分／undo |
| GET | `/api/host/ledger` | host token | 帳簿逐筆查詢（按 gameId／player／group 篩） |
| POST | `/api/host/rundown/next`・`/prev`・`/skip`・`/reorder`・`/insert` | host token | 推進流程 |
| POST | `/api/host/stage`・`/stage/lock`・`/stage/blackout`・`/stage/rules` | host token | 切大mon／規則頁顯示 |
| POST | `/api/host/media/play`・`/pause`・`/stop`・`/lease` | host token | 播歌指令＋音源 lease |
| POST | `/api/host/rules`（CRUD）・`/rules/reorder`・`/rules/preview` | host token | 每關規則頁編輯（§8.4） |
| POST | `/api/host/awards`・`/awards/:id/override`・`/awards/reveal` | host token | 頒獎面板 |
| POST | `/api/host/submit` | host token | 主持代答（`onBehalfOf`＋留痕） |
| POST | `/api/host/upload` | host token | 畫作／圖片／MP3（驗 magic bytes／size／quota） |
| GET | `/api/host/export` | host token | CSV＋room.json＋quiz.seed.json |
| GET | `/api/health`／`/api/ready` | 公開 | 生存／journal 載入完成＋port 就緒 |

**主持命令 envelope（所有改狀態命令，HTTP 同 WS 共用）**
`{ commandId, hostId, roomId, targetId, expectedRevision?, expectedRoundId?, payload }`
- 同 `commandId` 同 payload → **回原結果**（idempotent，重送安全）
- 同 `commandId` 但 payload 唔同 → 拒絕 `W_CMD_PAYLOAD_MISMATCH`
- `expectedRevision`／`expectedRoundId` 對唔上 → 回目前狀態 `W_STALE_COMMAND`（host 台靜默更新畫面，唔彈 error）
- 破壞性動作（open／close／reveal／reopen／next）用 `expectedRevision` 互斥，**兩個 host 同時撳只有一個成功**；非破壞性（score 加減、stage set）可疊加但一樣要 `commandId`
- server 按房串列化；**command＋狀態＋分錄＋receipt 同一筆 journal 落盤之後**才 ACK／broadcast
- **`revision` vs `seq`**：`seq` 係傳輸序號（每筆 patch +1，client 用嚟驗 baseSeq）；`revision` 係業務版本（每個成功 command +1）。snapshot／patch／hello.ok 三樣都帶 `revision`，**`expectedRevision` 填 snapshot 收到嗰個 `revision`**。
- **重開（reopen）計分規則（唯一定義）**：①只可以 reopen 同一張 card 最近一個 round；②舊 round 設 `state="void"`；③舊 round 內 `by="auto"` 嘅 ScoreEvent 全部 `voided:true`（自動分作廢）；④`by="host"` 嘅手動分**預設保留**，主持可以喺 reopen 對話框逐筆揀 void；⑤舊 round 嘅提交、收據、計分歷史**全部保留**（唔刪）；⑥開新 round（`{cardId}#{openCount+1}`）、`card.version` +1；⑦全部同一個 journal transaction 落盤先 ACK。

**Token 同 Origin**
- token：高熵隨機（≥256-bit）、server 只存 hash、TTL 8 小時、可撤銷、可 logout；HTTP 用 `Authorization: Bearer`（唔用 cookie 做授權，避免 CSRF）。
- 如用 cookie 存 Access session：`HttpOnly; Secure; SameSite=Strict`。
- 所有 WS 握手同改狀態 HTTP 檢查 `Origin` 對唔對得上公開 hostname。
- **role 由 server 按 session 決定，唔信 client 自報。**
- **LAN 綵排例外**：屋企 LAN（冇 Cloudflare）可以用 `DEV_LAN_MODE=1` 跳過 Access 檢查（login 只靠 PIN），**同時**要喺 `LAN_ORIGINS` 設 `http://192.168.x.x:3000`（同區網段先准）；`DEV_LAN_MODE` 下 Origin 檢查改為對照 `LAN_ORIGINS` 白名單。**production 啟動時見到 `DEV_LAN_MODE=1` 就拒絕啟動**；正式場一定行 Tunnel＋Access。

---

## 8. 畫面規格

### 8.1 大mon `/stage`（1920×1080 kiosk，零控制）
字級 ≥ 48px、深色高對比、冇滾動條、lock 一開主持改卡都唔影響。17 個 mode：idle（logo＋QR＋房碼＋頭像牆）、**rules（每關規則頁，見下）**、scoreboard、question、tally（貼人未公佈正解）、reveal（正解＋解釋；**歌名只喺呢個 mode、主持撳 reveal 之後才出**）、song（第 N 題＋進度，**唔出歌名，預設靜音**）、draw-wall、draw-focus、bid、vote、role-reveal、leaderboard、finale、award、timer、blackout。

**常駐分數條**：所有 mode 都喺度（blackout／finale 除外），底部 96px；每格＝頭像＋編號＋名＋分；排序／範圍／個人組由主持揀；超過 12 人縮字轉兩行；主內容 padding-bottom 112px 永遠唔遮題目；主持一鍵收放。

**rules（每關規則頁，D30）**：內容＝currentItemId 對應嘅 `RulePage`（缺頁 fallback 見 §6.1）。頂部左「第 N 關」badge（高 72px、字 40px）＋關名 title（≥96px 粗體、≤16 字）＋subtitle（56px、#9aa）；主體 blocks 由 y≈300 起、闊 1792px，heading 64px、paragraph／bullets／kv ≥48px、score-table 每行 56px、callout 黃底黑字 64px。**常駐分數條照顯示**、**唔出 QR**（QR 只喺 idle 出）。冇滾動條：內容超過約 700px 就自動分頁，右下角顯示「2/3」（32px，`pageIndex`／`totalPages` 由 server 計入 stage payload，**各機一致**），host 台可以插手上一頁／下一頁；每版停 `autoAdvanceSeconds` 秒（預設 0＝手動），尾頁停低唔會自動離開 rules mode。詳細數值表同限制見 §8.4。

**finale**：上半全屏分數（↓）＋頂部統計（總分／平均／中位數／人數）；下半三個獎位「?」；主持逐個揭曉 3獎→2獎→大獎（放大＋頭像＋分數＋得獎原因）。分數版面自動適應組數（0 組個人榜／1 組單欄大卡／2 組兩條／3–4 組四欄／5+ 橫排；>12 人縮字轉兩行，30 人上限要實測）。

### 8.2 主持台 `/host`（iPad 1280＋Mac 1920 都排得落；**可多開**）

多開語義：各自 login 各自 token，操作以**最後指令為準**，冇 conflict lock；每個 host 動作 broadcast activity toast（「Mac·阿Ken 撳咗播歌」），防止兩個主持互搶。

1. **Rundown 條**：下一項／上一項／skip／重排／環節倒數
2. **大mon 控制條**：17 mode 一按切、lock、blackout、房碼／QR、分數條開關＋排序
3. **Media deck**（估歌關用）：歌單＋大粒 play/pause＋「播 15 秒／由頭播」；**本地出聲**（Mac/Windows host 機駁喇叭）；**唯一 active 音源（`AudioLease`）**——media deck 開關時申請 lease 綁 `deckId`，只有 lease 持有者嘅 play/pause/stop 有效，其他 host 撳會收 `W_NO_AUDIO_LEASE`（掣變灰＋顯示「而家由邊部機出聲」）；「接管音源」＝申請轉移。lease **每 10 秒 heartbeat 續期**，30 秒冇心跳即自動釋放（`Room.audioLease` 持久化落 journal，帶 `generation`）。
- **deck 自我到期停播（關鍵）**：deck 拿到 `leaseUntil` 之後，用 server clock offset＋monotonic clock 自己計時；**即使收唔到 server 任何指令，最遲喺 `leaseUntil` 自動 pause／靜音**。呢條係防雙響嘅硬保證。
- **在線接管**：server 叫舊 deck stop，等 ACK（最多 2 秒），然後 `generation+1` 發新 lease。
- **失聯接管**：唔等永遠唔會到嘅 ACK；等舊 lease 到期 + **5 秒安全 margin**，之後 `generation+1` 發新 lease。舊 deck 返線時 generation 已過期，所有指令被拒，**唔准復播**。**play 要先 preload＋用戶解鎖＋ready ACK，server 才落 `playStartedAt`**；背景 tab 會被 throttle → 頁要 `wakeLock`＋轉背景即顯示警告。大mon 同時只出畫面（預設靜音）
4. **名單**：頭像＋名＋連線燈；approve／踢人／改名／改頭像
5. **分組工具**：一鍵 0/2/3/N 組；組名顏色隨意；拖拉搬人、批量、隨機平均；搬有分嘅人問「跟人走／留返原組」
6. **出卡**：開卷／收卷／切 tally／揭曉；「已答 7/10」＋未答名單
7. **題庫編輯器**：類型｜題目｜A-D｜正解｜解釋｜主持貼士｜秒｜分｜`openKind`；複製上一題；「一鍵匯入舊 QUIZ」**只匯入 MC 10 題**，open 題顯示 diff 由主持逐題確認（唔會蓋走附錄 A 新版）
8. **歌單**：#｜歌名（答案）｜提示｜來源｜檔案／link｜試播；三種入歌（MP3 上傳／YouTube link／Apple Music link）；可先入歌名後補（「未齊」標記）
9. **評審台**：作品牆→放大→+1/+2（鍵盤 1/2/3/0）
10. **計分帳簿**：個人/各組、總分同按關卡兩視圖、每筆事件、Ctrl+Z
11. **統計條**：平均／中位數／最高最低／總分
12. **頒獎面板**：自動三獎＋每人 dist；每獎「改人」＋「揭曉」；次序固定 3→2→大
13. **連線健康**：邊部機甩線（可以代答）＋host token 剩餘時間（少過 30 分鐘提示續期）
14. **規則頁編輯器**（D30）：新增／編輯／排序／複製／重設做預設頁／即時預覽（1920×1080 比例，**預覽唔 broadcast**）；8 種 block 編輯；字數／item 上限即時提示；離開前 beforeunload 警告；multi-host 用 `version` 做衝突檢查（409 → 載入最新再改）
15. **音源狀態**：邊部機持 lease、ready／playing／failed、一鍵接管

### 8.3 手機 `/play`（豎向、單手）

**入場（目標 10 秒）**：掃 QR 自動帶房碼 → 揀名（≤12 字）→ 揀頭像（emoji×48＋8 底色，或隨機）→ 入場，大mon idle 即刻多個頭像。

**主畫面**：一張大卡——四粒大掣（choice）／揀人（vote）／數字鍵盤（bid／估數字）／文字框（open）／「等主持」。**底部**：自己頭像、我分、我組分、連線燈。**reveal 前唔會見到**：其他人答案、正解、解釋、主持資料、大mon 控制；**reveal 之後**只會見到正解／解釋同自己結果（見 §7 披露矩陣）。

**Session／輸入保證**：sessionToken、已選未確認答案同 open 題草稿自動保存。reload 自動 resume 同一玩家，唔會重複 join；已提交答案以 server snapshot 為準，未提交草稿以本機保存為準。斷線只影響送出，唔影響已輸入內容。

---

### 8.4 每關規則頁：資料、版面同編輯器（D30）

**資料**：`Room.rulePages: RulePage[]`（§6）；8 種 block（heading／paragraph／bullets／steps／callout／kv／score-table／image）；每頁綁 `gameId`，rundown item 可 `rulePageId` override。

**限制（server 儲存時驗證，違反回 `W_RULES_LIMIT`）**

| 項目 | 上限 |
|---|---|
| 每頁 blocks | ≤ 20 |
| 每個 block `text`／每 item | ≤ 120 字 |
| 全頁文字總和 | ≤ 1200 字 |
| `image` block | ≤ 1MB，jpg／png／webp |
| `bullets`／`steps`／`score-table` items | ≤ 6 |
| 每房 RulePage 總數（未 archived） | ≤ 30 |
| `order` | 全房唯一；每個 gameId 最多一頁 `enabled` |

**大mon 版面（1920×1080）**

| 區域 | 尺寸 |
|---|---|
| 「第 N 關」badge（頂左 x=64 y=48） | 高 72px、字 40px |
| 關名 title | ≥96px 粗體、≤16 字 |
| subtitle | 56px、#9aa |
| 主體 blocks 區 | y≈300 起、闊 1792px（左右 padding 64px） |
| heading | 64px＋左邊 4px 橫線 |
| paragraph／bullets／kv | ≥48px、行距 1.5；bullets 1.6 |
| score-table 每行 | 56px、右對分數、🏆 行頭 |
| callout | 全闊黃底（#ffd54f）黑字 64px |
| 分頁碼「2/3」 | 右下、32px（分數條上方） |
| 常駐分數條 | bottom 96px（照顯示） |
| 主內容安全底 | padding-bottom 112px |

**分頁**：主體高度超過約 700px 就按視覺高度切 sub-page；每版停 `autoAdvanceSeconds` 秒（0＝手動）；host 台「上一頁／下一頁」插手後計時重設；尾頁停低唔會自動離開 rules mode。

**觸發**：`rundown/next` 入新關自動出（`lock=true` 時自動觸發唔會 override lock）；host 任何時候可手動出／收；`phase=idle/lobby/award` 拒絕（`W_WRONG_PHASE`）；blackout 期間拒絕（`W_STAGE_LOCKED`）；收頁返 `prevMode`。

**編輯器**：見 §8.2 第 14 項；API 見 §7；預設四頁文字見附錄 B。

## 9. 技術選型與部署（v3.1 定案：全棧 TypeScript＋Node 26 LTS，server 留屋企）

**形態**：一個 Node 26 LTS process（TypeScript compile 做 JS）＋前端 build 產物，同一 origin 服務三端。正常場次約 **13–14 條 WS**（10 手機＋大mon＋2–3 host）；驗收要壓到 **30 approved 玩家＋2 host＋1 stage**（D26）。「100–200MB RAM」係**估算，未實測**，M0／M2 要交 RSS 數據。

### 9.1 揀型

| 層 | 揀 | 為咩 |
|---|---|---|
| 語言 | **TypeScript（strict）** | 前後端同一套 type（§6 直接 copy 過去），零翻譯 |
| HTTP＋WS | fastify＋@fastify/websocket | REST 同 WS 同一 process 同一 router |
| 靜態 | @fastify/static | 前端由 server 一併 serve，same-origin 冇 CORS |
| 廣播 | in-process Set&lt;WebSocket&gt;＋seq | 15 條連線，唔使任何 messaging library |
| 日誌 | pino（每 request/connection correlation ID；**永不記 token**） | 出事有 timeline |
| 持久化 | JSONL append（journal） | 零 DB、可重播、可審計 |
| 測試 | node:test＋**bots.mjs**（模擬 30 client） | 驗收唔使日日攞 30 部真機 |

**Runtime pin（v3.1）**：全部環境（開發機、CI、Windows server、後備包）統一 **Node 26 LTS**（本機已有 v26.8.1；Node 26 已入 LTS）。`package.json` 寫 `engines.node`，`.nvmrc`／Windows portable `node.exe` 綁同一 patch 版本，交付 manifest 記錄。

**Production 禁令（啟動檢查）**：NODE_ENV=production 時①行 dist/ compiled JS（**禁止 tsx watch／ts-node 行 production**）②缺 PIN 或用緊 default PIN → **拒絕啟動** ③`engines.node` 唔對 → 拒絕啟動。開發先准 tsx watch。

**PIN 來源**：開場時由 server 自動產生 6 位數字 PIN（或 `.env` 預先設定），印喺 runbook／主持卡；**唔可以 hardcode**，`PIN=000000` 一律拒絕。

### 9.1.1 持久化同 crash durability（v3.1 補）

- Journal 係**唯一真相**：`data/journal/room-<roomId>/manifest.json` ＋ `segment-0001.jsonl`、`segment-0002.jsonl`…；manifest 記住啟用緊邊個 segment、下一個 seq、schema version。
- 每筆 record 有 envelope：`{v, seq, ts, type, data, checksum}`；**checksum 對唔上嘅尾行**（通常係 crash／斷電造成）啟動時 truncate 到上一個完整 record，並 log `warn`，唔可以令 server 永遠 ready 唔到。
- **ACK 前必須 fsync**：`append → write → fsync → ACK/broadcast`（或者 `fsync` 每個 batch，最長 200ms 一次，但 ACK 要等所屬 batch fsync 完）。講清楚就係：**「持久化後先 ACK」＝要 fsync，唔係寫入 OS buffer 就當**。
- 跨日／重啟：唔用「按日期開新檔」做主分割，用 room＋segment；`seqEpoch` 改變代表換過 segment，client 見到 `seq < lastSeq` 或 epoch 變就丟棄本地並以 snapshot 為準。
- fault-injection 驗收（M0）：append 前 kill、write 後 fsync 前 kill、ACK 前 kill、disk full、人為壞尾行——五個 case 重啟後狀態一致。

**單 instance 邊界（寫明）**：房間狀態＝memory＋journal replay。**唔准開多個 process／多 instance**——多開會入錯房、斷線接唔返。Cloudflare Tunnel 指住一個 port 就夠。日後真有 CPU hotspot：先算法優化或 worker_threads，有 profile 數據先再講，唔預設任何橫向擴展。

### 9.2 邊部機做咩

| 角色 | 機 | 做咩 |
|---|---|---|
| **主 server（唯一）** | 屋企 **Windows server**（`192.168.99.20`） | **Docker Compose** 行一個 app container（容器內 Node 26 LTS，`restart: unless-stopped`），host port **30005 → 容器 3000**；cloudflared 行 Windows service；journal／媒體用 host volume 持久化。**唔會搬去場地（D31）** |
| 大mon | Windows 或 Mac | Chrome --kiosk 開 /stage；唔跑 server |
| 主持台 | 任何 browser（iPad／Mac／Windows），**可多開** | /host；Mac 嗰個可以兼任 media deck 音源 |

**冇後備 server（D27）**：Windows server 係單點。對策喺 §11。**Windows update 自動重啟要事先關**（設 active hours／派對當日暫停更新）。

**Server 留屋企（D31）嘅直接後果**：場地冇 LAN 直連呢條後路——`192.168.x.x` 唔可路由。場地只有「經 Cloudflare Tunnel」一條路；Tunnel／屋企 WAN 死＝對外全斷，後路只剩（i）手機熱點頂場地 WAN（Tunnel 由屋企出，呢個只救「場地 Wi-Fi 壞」）（ii）列印包＋手動計分（救「屋企 WAN／server 死」）。Runbook 要分清楚呢兩種故障。

### 9.3 對外入口（一個 hostname＋path）

```
hbd.你嘅域名        Cloudflare Tunnel → http://localhost:30005（Windows server 上 Docker port mapping；容器內 3000；同一個 origin，全部相對路徑）
├─ /play         公開   QR 直接入：房碼＋主持 approve 把關
├─ /stage        公開   kiosk 開即用；只有顯示資料（分數／票數／答案頭像／規則頁），冇控制權
├─ /host         Cloudflare Access（email allowlist；每部 host 機 setup 一次）
├─ /api/join     公開（rate limit）
├─ /api/health   公開（生存）
├─ /api/ready    公開（journal 載入完成＋port 就緒）
├─ /api/host/*   Cloudflare Access ＋ PIN → host token；所有 host-only 操作
└─ /ws           公開（token 喺 hello 首訊息，唔喺 URL）
```

**點解唔開幾個 subdomain**：①same-origin 冇 CORS／跨域 WS 問題；②QR 短（hbd.xx/play?code=1234）；③Access 兩條 policy（/host、/api/host）就蓋晒所有敏感嘢；④玩家 /play 一定要公開——10 個賓客逐個過 Zero Trust login 係災難，佢哋嘅關卡係房碼＋approve。

**`/stage` 公開嘅範圍（明文接受）**：任何人知道 hostname 都開得到 `/stage`，睇到分數、票數、答案頭像、規則頁。**原始個人票、秘密身份、正解（reveal 前）永遠唔會出現喺 stage payload**（§7 角色規則）。如果要加一層，開場前可以喺 Cloudflare 加一條 `/stage` Access policy（但每部 stage 機要 login 一次）。

**後路（v3.1 改，D31）**：server 留屋企，所以**場地冇 LAN 直連**。三種故障分開處理：
1. **場地 Wi-Fi／WAN 死**：主持機開手機熱點，所有手機同大mon 轉連熱點（server 喺屋企，Tunnel 照出）——**唯一可以「現場自救」嘅情境**；runbook 要預先寫熱點 SSID／密碼。
2. **屋企 WAN／Cloudflare Tunnel 死**：對外全斷，冇 remote 後路；即刻切列印包＋主持手動計分（每關 checkpoint 見 §11）。
3. **屋企 server 死**：同上，列印包＋手動計分。

**綵排先可以用 LAN**：喺屋企用 `http://192.168.x.x:3000` 直連測試（同一個 origin 邏輯唔變）。iOS Safari 喺 HTTP 都可以「加入主畫面」全屏（要 HTTPS 嘅只係 service worker；v3.1 唔做 SW，見 D33）。

### 9.4 WS 一律當佢會斷（重連係核心功能，唔係補充測試）

- 30 秒 ping/pong 心跳；指數退避重連（0.5→1→2→4s，上限 10s）；斷線時大mon 顯示「連線中」，唔會白畫面
- 首連、重連或有缺漏時都攞完整 role-filtered snapshot。正常在線嘅 patch 以已應用嘅 snapshot 做基線，無須儲存舊 patch 作重播。
- **Race 條款（寫入 M0 驗收）**：
  1. 舊 socket 遲 disconnect **唔可以踢走新 socket**——新 hello 成功先替換 playerId＋clientInstanceId 嘅 socket 映射，舊線之後斷當冇事
  2. 連線 timeout 只更新在線狀態；已獲批玩家持有效 session 可以隨時恢復。同時喺幾個 tab 開就按有效 socket 集合判 presence；過期、被踢或撤銷先拒絕 resume。
  3. client 用最新 snapshot 建立新基線；舊 socket 及遲返嘅 snapshot 唔可以覆蓋更新畫面。正常在線如保留 patch，必須驗 baseSeq；因角色過濾而未派發嘅事件唔當掉包。
- **Process restart 誠實聲明**：journal replay 令重啟後返到重啟前狀態；重啟期間 server 唔會 ACK submit。Client 保留未 ACK 操作並以同一 idempotency key 重送，server 只處理一次；client 對 auth failure／server restart 分開處理

### 9.4.1 Resync：唔靠人手 refresh（D28）

**三條保證**

1. **Server 已 ACK**：狀態改動、idempotency key 同原收據要作同一筆 journal 記錄，持久化後先 ACK。重啟回放同時重建 session、房間狀態及收據索引；重送先以原身份查舊收據，再判新提交是否仍可接受。
2. **草稿同待確認操作**：未撳確認嘅輸入只會恢復草稿。撳咗確認就先本機保存原 payload 同 idempotency key。重連／refresh 後先查原收據；未收到而原回合仍開放先重送同一 ID。已過期或指令版本已變就顯示結果並保留內容俾用戶查看。主持命令同樣綁定原目標及預期階段／版本。
3. **最後已知畫面唔會清空**：斷線只加「連線中／最後更新時間」提示；stage 繼續顯示最後畫面與分數，唔准白屏或自動返回 idle。新 snapshot 驗證完成後先一次性替換。

**自動復原流程**

```text
心跳／socket close 偵測斷線
  → 保留最後畫面，顯示非阻擋式「連線中」
  → 0.5/1/2/4/10s + jitter 自動重連，唔彈「請 refresh」
  → hello 帶持久化 sessionToken
  → server 驗證身份、換新 socket，舊 socket 遲斷唔影響新 socket
  → 每次連線先送完整 role-filtered snapshot（小房間直接送完整 view）
  → client 以 snapshot.seq 為新基線，之後先接受更新 patch
  → 校回 serverNow／endsAt，恢復當前 card、stage、rundown、分數同私人身份
  → 查未 ACK 操作嘅原收據；仍可提交先按原 idempotency key 重送
```

正常連線時，client 發現 patch `baseSeq` 同已應用版本對唔上，或者自己嘅 view hash 同 Server 對應 view 不符，亦要自動 `resync`，**唔准繼續用懷疑有缺漏嘅畫面**。

**意外 refresh 後要保留嘅嘢**

| 內容 | 保存位置 | 恢復行為 |
|---|---|---|
| Player／host session token | 本機持久化 storage | resume 同一身份；refresh 唔會再造一個玩家 |
| 已選未確認 choice、bid 輸入、open 題文字草稿 | 本機按 roomId＋playerId＋roundId 保存 | 開返同一題仍見到原內容；server 確認後先清除 |
| 主持題庫／rundown 未儲存草稿 | 本機 draft | 還原編輯內容；正式 server state 仍以最後儲存版為準 |
| 最後 role-filtered view | 本機按房、角色同身份保存可安全離線顯示嘅資料 | 離線／reload 時先顯示「最後更新…」，連得返就由新 snapshot 原子替換 |
| stage mode、ticker、rundown、分數 | server journal | 重新連線即恢復，唔會因 stage 機 refresh 而 reset |
| 已 cache MP3、media deck 身份 | 本機 media cache＋deckId＋`leaseUntil` | **唔保證離線繼續出聲**：cached 檔可以照載入，但 **deck 最遲喺 `leaseUntil` 一定要自行 pause／靜音**；返線 generation 已過期就要重新申請 lease 先可以再播（server 決定邊部機出聲） |
| 播放位置 | server `playStartedAt`／`positionMs`＋本機 cached Blob | 用 server 記住嘅 `positionMs` 計回應播毫秒；瀏覽器如阻止 autoplay，只顯示一個大「恢復播放」掣，屬 browser 限制 |

**資料安全邊界（v3.1：唔做 service worker，D33）**：已撤銷或換身份就清除舊 view；私人身份、正解及主持資料須重新驗權先顯示。**網頁仍然開住**時斷線，可以顯示最後 role-filtered view（應用層持久化，例如 IndexedDB／sessionStorage），收到新 snapshot 先原子替換；**完全閂咗頁再離線開係唔會得**——呢個係刻意取捨，唔屬於 D28 承諾範圍。`/api`、snapshot、patch 一律 `Cache-Control: no-store`，唔可以由 HTTP cache 回舊答案。App 更新喺安全時段提示，唔會遊戲中途強制 reload。

**手機鎖屏／背景**：`visibilitychange`／`online` 一返前台立即主動 resync；唔等下一次 ping。若伺服器已收卷，手機顯示正確 closed 狀態，唔可以再用舊倒數提交。

### 9.5 Clock offset（各機倒數誤差 ≤0.5s 嘅正確做法）

唔可以信手機本地時鐘（偏 5 秒就違反 M2 驗收）。**v3.1 用 NTP 式取樣，唔用單程差值**：

```
client 連線時送 3 次 ping {clientT0}
server 回 pong {clientT0, serverNow}          // server 收到嗰刻
client: T1 = 收到嗰刻（performance.now 或 Date.now）
        rtt_i   = T1 − clientT0
        offset_i = serverNow + rtt_i/2 − T1
取 rtt 最細嗰個樣本嘅 offset 做基準
之後每 60 秒用 WS pong 重校；offset 突變 > 300ms 才採用新值（防跳鐘）
```

- 所有倒數用 `endsAt − (monotonicNow + offset)`；**走秒用 `performance.now()`**，唔用 `Date.now()`。
- 播歌同步用 `playStartedAt` 同一條 offset；另外要記 deck `ready` 回報同實際播放位置（硬件／decode 有延遲，唔係一條公式搞掂）。
- `visibilitychange`／`online` 返前台即刻重校，唔等 60 秒。
- **M0 驗收**：(i) 人手校歪一部機時鐘 ±3 秒，倒數仍一致；(ii) 用 proxy 注入 200ms 單向延遲，兩機倒數差仍 ≤0.5 秒。

### 9.6 WS 自我保護（平到你笑，但一定要有）

- `maxPayload` 64KB（bid／open 文字遠細過呢個數）
- 每 connection input rate limit（例 10 訊息/秒，超 → close 4008）
- outbound queue 上限＋slow consumer 斷線（大mon lag 唔可以拖死 server）
- 上限（v3.1 寫死）：room **1** 個、**approved players 30**、**pending 10**、**host 連線 5**、**stage 連線 2**、**總 socket 60**；重連期間舊 socket 未斷可以短暫重疊，但唔可以計入 approved 名額。第 31 個 approved 玩家／第 11 個 pending／第 6 條 host／第 3 條 stage／第 61 個總 socket → `W_ROOM_FULL`
- **Origin 檢查**：WS 握手驗 `Origin` 對唔對得上公開 hostname，唔對即拒（防跨站 WS）
- malformed JSON／schema 不合 → 穩定 error code（W_BAD_MSG），同一連線三次踢
- 唔開 per-message compression

### 9.7 Process lifecycle

- `/api/health`＝process 生存；`/api/ready`＝journal 載入完成＋port 就緒（cloudflared／monitor 用）
- 停止（SIGTERM／`docker compose stop`）：停接新連線 → broadcast shutdown 訊息俾全部 client → 5 秒內 flush journal → 退出；重啟由 Docker `restart: unless-stopped` 負責（開機自啟要 Docker Desktop 開機啟動）
- `uncaughtException`：pino 記低（連 correlation ID）然後 **exit**，由 service manager 拉返起——**唔好靜靜哋繼續行**

### 9.8 部署與運維

- Build：tsc → dist/；前端 vite build → server 一併 serve；**image／dist 喺屋企 build 好，派對當日零下載**；前端框架要喺開工前定（Vite＋React／Vue／vanilla 三揀一，寫入 `package.json`）
- **Docker（部署目標）**：`Dockerfile` multi-stage（builder `node:26-alpine`＋pnpm build；runtime `node:26-alpine` 只帶 `dist/`＋production `node_modules/`）；`docker-compose.yml`：`ports: ["30005:3000"]`、`volumes: ["./data:/app/data","./media:/app/media"]`、`restart: unless-stopped`、`healthcheck` 打 `/api/ready`；`NODE_ENV=production`、`PORT=3000`、`PIN` 由 `.env` 或啟動自動產生。更新＝`docker compose up -d --build`；rollback＝保留上一個 image tag
- 離線／派對當日：屋企 build 好 image → `docker save | ssh … docker load`，或者 server 上面 build 一次之後唔再 pull；**當日零下載**
- cloudflared 保持 Windows service（LocalSystem）；Node 26 portable `node.exe` 只留作最後手動後備
- Journal：`data/journal/room-<id>/`（manifest＋segments，見 §9.1.1）；MP3／圖：`data/media/`；開場前同**每關完結** `/api/host/export` 落 USB 一份
- **上傳安全**：驗 magic bytes、size（圖 ≤ 8MB／MP3 ≤ 20MB）、像素上限、MP3 時長、quota；圖片轉安全派生檔；媒體用無語義隨機 ID；`Content-Disposition: inline` 但要 `X-Content-Type-Options: nosniff`；全站 CSP（`default-src 'self'`，冇 inline script）
- Runbook 一頁：起機、PIN、房碼、開場 QR、手機熱點後路、每關 checkpoint、最後防線（列印包＋手動計分）

### 9.9 部署目標同環境（2026-11-16 實測）

| 項目 | 實測值 |
|---|---|
| 主機 | Windows `<server-host>`，LAN `192.168.99.20`；SSH port 22（user `<ssh-user>`，憑證放 `<ssh-credentials-dir>/`，**唔准 commit／外傳**） |
| 容器 | Docker **29.9.2** ＋ Compose **v5.6.1**（Docker Desktop／WSL2，Linux containers） |
| 對外 port | **30005**（實測 free；`30005:3000` port mapping） |
| 磁碟 | C: 約 **95 GB free** |
| Tunnel | cloudflared 已用 **Windows service（LocalSystem）** 行緊，token 模式（dashboard-managed，冇本地 `config.yml`） |
| 互聯網 | 出街 443 OK（Docker Hub 可拉 image） |

**部署前仲差 Cloudflare 一步（SSH 做唔到，要 dashboard 權限）**：Zero Trust → Networks → Tunnels → 揀現有 tunnel → Public Hostname → 加 `hbd.<你嘅域名>` → service `http://localhost:30005`；然後 Access → Applications 加 `/host`、`/api/host/*` 兩條 policy。

**驗收（M0 一部分）**：`docker compose up -d` 後 `curl http://127.0.0.1:30005/api/ready`＝200；`docker compose restart` 後分數仍在（volume）；`docker compose down && up -d` 後 client 自動重連；公開 hostname 驗 `/play` `/stage` 開得、`/host` 要 Access。

---

## 10. 里程碑與驗收（先 bots.mjs，後真機）

| 關 | 內容 | 驗收標準（要實測，每條有起終點同量度方法） |
|---|---|---|
| **M0 骨架＋部署底** | server（fastify＋ws＋static）、Access 兩條 policy、PIN、join（名＋頭像）、rundown、idle/scoreboard、計分帳簿、分組、`/api/host/*`、**host command envelope**、clock offset（RTT 取樣）、reconnect race、**journal durability**、**bots.mjs** | ① 30 approved bots＋2 host＋1 stage 同時連；**join p95 ≤ 5 秒**、全部 15 秒內完成；第 31 個 approved／第 11 個 pending／第 61 個總 socket → `W_ROOM_FULL`（五個 cap 逐個測）。② host 撳加 10 分 → stage 收到 patch **≤1 秒**（instrumented event 計）、渲染完成 ≤3 秒。③ 重啟 server（正常 SIGTERM 同 `kill -9` 各一次）分數仍在；**ACK 過嘅分一筆都唔可以失**。④ 狀態四元組：open→close→tally→reveal 每步 `phase/mode/card.state/round.state` 符合 §6 狀態機表。⑤ 0/1/2/4 組排版；搬 12 分人兩種語義；**多次搬組＋undo＋export→replay 後帳簿對得返數**（§6 換組契約）。⑥ 校歪一部機 ±3 秒＋proxy 注入 200ms 單向延遲，兩機倒數差 **≤0.5 秒**。⑦ 舊 socket 遲斷、跨 tab presence、timeout 後 resume。⑧ 場外 4G 開 `/api/host/*` 被 Cloudflare 擋；有 cookie＋PIN 先有 token（**LAN 唔適用，D31**）。⑨ production 禁令：缺 PIN／default PIN／`engines.node` 唔對 → 拒啟動。⑩ 主持命令冪等：同 `commandId` 重送回原結果、同 ID 異 payload 拒；**兩個 host 同時撳 next 只行一次**。⑪ **D28 恢復矩陣全過**：唔使 refresh 自動復線、confirm 前後 refresh、stage refresh、host refresh、server restart、30 bots 隨機斷線重連；每筆提交／計分只出現一次；落盤後未 ACK 就 refresh；**重開同一題後舊提交不得入新輪（roundId）**。⑫ fault-injection 五個 case（append 前／fsync 前／ACK 前 kill、disk full、壞尾行）。⑬ **Docker 部署**：`docker compose up -d` 後 `/api/ready` 200、`restart` 後分數仍在、`down/up` 後 client 自動重連、host port 30005 對得上、image 用 `docker save/load` 離線可搬 |
| **M1 問答關＋規則頁** | 題庫編輯器（含一鍵匯入 MC）、question→tally→reveal、兩步確認、MC 20 秒＋自動收卷（分母＝eligible roster）、逐選項貼人、解釋彈出、open 評分、`actualAnswer` 估數字、Q14 時間題、**每關規則頁 M1 版（顯示＋編輯＋rundown 自動觸發）** | ① 30 bots 同時答 20 秒題，30 份 receipt 齊、零重複、零漏。② tally 階段 WS／HTTP／build 三路 sniffer：**冇正解／解釋外洩**；reveal 之後先出。③ 全員答完即刻自動收（分母正確）；**關閉 auto-close 時全員答完唔會自動收**。④ 揭曉後分數逐筆同帳簿對上。⑤ 題庫改完即刻生效；**「一鍵匯入」唔會蓋走新版 open 題**（diff 提示）。⑥ 估數字入 `actualAnswer` → 最接近者 +2、並列全 +2。⑦ Q14 用 `closedAt`＋`Asia/Hong_Kong` 計，跨 23:59:59／00:00:00 兩個 fixture 正確。⑧ 重開同一題：新 `roundId`、舊 round void、舊分按規則作廢、舊提交入唔到新輪。⑨ **規則頁**：rundown 入關（含重玩／跳返）2 秒內出 rules mode、host 一鍵出／收、後台改完 1 秒內更新、超字數被拒 `W_RULES_LIMIT`、**沒有 enabled 頁時 fallback 到 rulesText／item title 而唔阻流程**、**兩個 host 同時改同一頁 → 第二個收 `W_RULES_CONFLICT` 並載入最新**、分頁 `pageIndex／totalPages` 各機一致、**重啟後規則頁仍在** |
| **M2 估歌關＋media deck** | 歌單（先入名後補 link，MP3 為主）、bid 卡（**只 points 模式**）、倒數、競投走勢、結算、**media deck＋AudioLease** | ① 30 bots 出價次序＋同價 tie-break（先交者贏）正確；`maxBid` 驗證拒超額。② **結算逐筆對帳**：得標者答對 +points、答錯 0、其餘冇變（跑一輪完整數字例）。③ 倒數各機誤差 ≤0.5s（注入延遲版本）。④ **media deck（Mac）播 MP3 同 stage 畫面同步 ≤0.5s**、大mon 預設靜音；**任何 mode（reveal 前）唔會出現歌名**（sniffer）。⑤ **同時只一部機出聲**：兩部 host 一齊撳 play，只有 lease 持有者成功、另一部收 `W_NO_AUDIO_LEASE`；在線接管測試；**離線接管測試**：舊機播歌中斷網 30+ 秒 → 舊機自行停（`leaseUntil` 到）、新機接管、全場唔會雙響、舊機返線唔准復播。⑥ autoplay 被擋 → stage 顯示「等音源 ready」，唔會假裝播放。⑦ Tunnel 下 WS 連 30 分鐘，最多斷 1 次且 5 秒內自動恢復、狀態無誤即算過（斷幾多次都要記）。⑧ 同步承諾只限 `source.kind='file'`；YouTube／Apple 只係手動提示（D7＋D32） |
| **M3 畫畫關** | 上載／影相上牆、作品牆、放大、評審、vote「最似」 | ① 30 bots 並發上載 30 張 ≤1MB 圖，server 15 秒內全部上牆（測 throughput）。② 真機演示：主持連續影相上牆 10 張，中途零錯誤、唔使 refresh（**唔設秒數**，因為係人手操作）。③ **計分逐筆對**：人氣票 ×1＋最高票額外 +2＋主持 +1/+2，同帳簿一致。④ 主持 +1/+2 一 click＝該作品作者得分（唔係評審），重複 click 用 `commandId` 去重。⑤ 上載驗 magic bytes／size／quota，偽裝檔被拒 `W_UPLOAD_REJECTED` |
| **M4 搗蛋鬼（版本 A）** | 派身份、私人身份頁、兩輪投票、淘汰、平票裁決、主持全場視圖、計分 | ① **身份只送到本人**（WS／HTTP／build sniffer）。② 開票前 stage 只出投票進度，**冇任何個人票**。③ bots 跑兩輪劇本，含一輪**刻意平票** → 主持裁決後計分正確。④ **投自己被 server 拒**（`W_SELF_VOTE`）。⑤ 第一輪被淘汰者第二輪唔可以投／唔可以被投，但保留分數。⑥ 計分逐筆對：揪中每位投票者 +3、搗蛋鬼冇 +5；兩輪都揪唔中 → 搗蛋鬼 +5。⑦ 重連唔漏身份；重開同一輪唔重複派分 |
| **M5 結算與收尾** | 常駐分數條、leaderboard、finale、頒獎面板、multi-host activity toast、**PWA 加主畫面 meta（唔做 SW）**、排練腳本、runbook | ① 17 mode 1920×1080 幾何驗收（bounds／overflow 唔靠肉眼）：包括 1／2／3／4／5+ 組、30 人分數條、長名。② 頒獎：bots 跑 9／10／11 人＋隨機剔除 2 人＋全同分＋n=1／2／3 邊界，三獎同 §6 演算法逐個核。③ 手動改人畫面即刻跟（≤1 秒）。④ 斷網 10 秒自動重連回到同分（stage／手機／host 各做一次）。⑤ 兩個 host 同時開，activity toast 可見、破壞性操作只有一個成功。⑥ 規則頁四關齊、編輯器可用、預設文字同附錄 B 一致 |

**交貨線（v3.1 定案）**：**M0–M1 一定要交**（計分＋問答＋規則頁，已完全取代舊 scoreboard.html＋quiz.html）；**M2–M4 逐關加**（每關獨立可出貨，唔使等齊）；**M5 只保留 finale＋頒獎＋runbook＋排練**，其餘（17 mode 逐個打磨、PWA）可以砍。

---

## 11. 風險與對策（v3.1：server 留屋企，冇後備 server，如實寫）

| 風險 | 影響 | 對策 |
|---|---|---|
| **Windows server 死（單點，D27）** | 全場停 | 開場前＋**每關完結** `/api/host/export` 落 USB，並抄一張 verified score checkpoint（紙）；**列印包＋主持手動計分係最後防線**（PDF 要先用新版題庫重 build，見 §9.8）；Windows update 自動重啟事先關；NSSM crash 自拉 |
| 10 部手機同一 Wi-Fi 唔穩／AP isolation | 手機甩線 | 開場前 15 分鐘全員試連；主持台見甩線名單可代答；router 關 AP isolation |
| 有人亂改名／亂入 | 場面亂 | 主持 approve＋鎖房 |
| 主持按錯大mon | 尷尬 | blackout 一鍵黑屏＋lock＋Undo |
| **Cloudflare／Tunnel 或屋企 WAN 死** | 外部入唔到，**冇 remote 後路**（D31 server 留屋企） | 立即切列印包＋手動計分（每關 checkpoint 已有）；如果係**場地** Wi-Fi 死而屋企正常 → 主持機開手機熱點，全部裝置轉連熱點即恢復（runbook 寫死 SSID／密碼） |
| Cloudflare WS 100 秒閒置斷線 | 手機掉線 | 30 秒心跳＋指數退避；斷線顯示「連線中」 |
| YouTube 廣告／載入慢 | 估歌節奏亂 | 預設 MP3；YouTube 只係手動後備（唔保證秒級同步，D32）；主持有「跳過」 |
| Apple Music 冇播放控制 API | 控制唔到進度 | 只做純提示，唔受 `media.play` 控制；主持自己按（§11 同 v3 一致） |
| **Browser 擋 autoplay** | 全場睇倒數但聽唔到歌 | media deck 要先 preload＋用戶解鎖＋ready ACK 才落 `playStartedAt`；未 ready 時 stage 顯示「等音源」；runbook 開場前試播一次 |
| **裝置睡眠／Auto-Lock** | 大mon 黑屏、音源停、iPad 鎖機 | 所有機設「永不睡眠」；Mac media deck 用獨立 window 保持前景＋`wakeLock`；iPad 引導式存取；runbook 列晒電源／螢幕設定 |
| **場地 Wi-Fi 唔穩／AP isolation** | 手機甩線 | 開場前 15 分鐘全員試連；主持台見甩線名單可代答；router 關 AP isolation；必要時全部轉手機熱點 |
| **Cloudflare Access OTP 收唔到** | 主持開唔到場 | 開場前所有 host 機預先 login 一次並確認 session 有效期；預備一個後備 email；runbook 寫明 |
| **主持 token 中途過期** | 主持台突然冇權限 | token TTL 8 小時、少過 30 分鐘提示續期；過期自動行 PIN 重換（Access cookie 通常仍有效） |
| **Docker Desktop／WSL2 更新或重啟** | container 停、對外斷 | 關 Docker Desktop 自動更新；設開機自啟；`restart: unless-stopped`；開場前 `docker compose up -d`＋`/api/ready` 驗一次；保留上一個 image tag 以便 rollback |
| 時間不足 | 趕唔切 | 出貨線 M0–M1，逐關加 |

---

## 12. 完工定義（DoD）

1. 三個網址（/stage /host /play）經 Tunnel 實機跑順（場外 4G 同場地 Wi-Fi 各驗一次），開機自啟，零命令行操作
2. 主持全程唔使精準滑鼠點擊都控制到大mon
3. 任何時候畫面分數＝journal replay 結果
4. 流程文件更新成新網址；runbook 一頁（起機、PIN、房碼、QR、手機熱點後路、每關 checkpoint、最後防線）
5. 賽前一鍵 /api/host/export 出 CSV＋room.json
6. 個人戰↔N 組 10 秒內切嚟切去，分數唔亂
7. **Production 檢查全過**：行 compiled JS、Node 版本 pin 生效、PIN 冇 default（缺咗／default 拒啟動）、單 instance 聲明成立、Access 鎖 /host＋/api/host/* 場外實測生效、WS 保護 config 開齊（maxPayload／rate limit／slow consumer／上限／Origin）
8. **全程唔使手動 refresh**（連線級）：斷線自動 resync；意外 refresh 後同一玩家／主持身份、最後畫面、答題進度、未提交草稿都仲喺度；server ACK 前資料唔清；重複重送唔會重複計分。**唔包括**完全離線開新頁（v3.1 唔做 service worker，D33）

---

## 附錄 A：初始題庫（20 題；MC 10 題沿用 `deploy/live_page.py` QUIZ 逐字，open 10 題係新版改寫；`deploy/site/crew/quiz.html` 係 QUIZ 嘅投影版，唔係呢份題庫嘅來源）

> 全部粵語出題、香港／世界冷知識，已避開普通話諧音同內地梗。只係起始資料，後台隨時加減改。
> **題庫暫定（2026-11-16）**：主持仲諗緊最終題目，之後再提供。開發期用呢份附錄做 seed；題庫設計成純資料（`data/quiz.seed.json`），換題只改資料、唔使改 code。
> **v3.1 題庫 canonical（D34）**：以呢份附錄為準。舊 QUIZ 嘅 8 條開放題（影相數／電量／血管／餐飯／長頸鹿頸／貓紙箱／打喊露／車牌）唔再使用；「一鍵匯入」只匯入 MC 10 題，open 題要人手確認，唔可以覆蓋新題。

| | 舊版 quiz.html | 新版平台 |
|---|---|---|
| 作答 | 兩隊搶答／寫白板 | 每人自己手機答 |
| MC 時限 | 30 秒 | 20 秒 |
| 開放題時限 | 45 秒 | 45 秒 |
| 計分 | 主持手動 | 自動（MC）＋主持評分（open）＋估數字自動排最近 |

### A.1 選擇題（10 題・每題 1 分・20 秒）

**Q1｜動物**　長頸鹿條脷係咩顏色？
- A 粉紅色　B 紫黑色　C 草綠色　D 透明
- ✅ **B** — 紫黑色可以防曬，仲可以伸到 50 厘米長，方便捲樹葉。

**Q2｜動物**　北極熊嘅皮膚其實係咩顏色？
- A 白色　B 黑色　C 粉紅色　D 透明
- ✅ **B** — 毛係透明中空，睇落白色；皮膚其實係黑色，方便吸熱。

**Q3｜動物**　袋鼠可唔可以倒退行？
- A 可以，仲好快　B 可以，但好慢　C 完全唔可以　D 只可以倒退跳
- ✅ **C** — 袋鼠腳踝結構唔容許向後行，所以澳洲國徽揀佢代表「永遠向前」。

**Q4｜食物**　一罈蜂蜜放咗 3000 年，仲食唔食得？
- A 一定壞咗　B 食得，蜂蜜唔會變壞　C 會變醋　D 會變石頭
- ✅ **B** — 埃及古墓出土嘅蜂蜜，考古學家話仲食得。含水量低＋酸性強，細菌好難生存。

**Q5｜太空**　太空人喺太空站去廁所，主要靠咩？
- A 用水沖　B 用吸力（好似吸塵機）　C 著尿片　D 去太空船外面
- ✅ **B** — 太空冇重力，要靠氣流將排泄物吸走。

**Q6｜食物**　世界上最貴嘅香料（按重量計）係？
- A 黑胡椒　B 番紅花　C 雲呢拿　D 肉桂
- ✅ **B** — 番紅花要人手逐朵摘花蕊，一公斤要大約 15 萬朵花。

**Q7｜動物**　蝸牛有幾多隻牙？
- A 0 隻　B 4 隻　C 大約 1 萬隻　D 32 隻
- ✅ **C** — 蝸牛嘅牙生喺「齒舌」上面，肉眼睇唔到，但真係過萬隻。

**Q8｜動物**　樹懶幾耐先去一次大便？
- A 一日三次　B 大約一星期一次　C 一個月一次　D 成世都唔去
- ✅ **B** — 樹懶新陳代謝極慢，一星期先落地一次，而且落地面對佢嚟講好危險。

**Q9｜數學**　一張 A4 紙對摺 42 次，會有幾厚？
- A 一本書咁厚　B 一層樓咁高　C 超過地球到月球　D 一座山咁高
- ✅ **C** — 0.1 毫米 × 2⁴² ≈ 44 萬公里；地球到月球約 38 萬公里。

**Q10｜科學**　你身體入面大部分原子，原本嚟自邊度？
- A 地球核心　B 爆炸咗嘅恆星　C 太陽　D 海水
- ✅ **B** — 「我哋都係星塵」——碳、氧、鐵等元素都係喺恆星內部製造出嚟。

### A.2 開放題（10 題・每題 2 分・45 秒）

> 全部即時有答案。玩家手機自己打答案。兩種判定：**估數字**＝主持即場輸入真實答案 → 自動排最接近（actualAnswer）；**短答**＝主持睇晒答案，關鍵詞對就 +2。

**Q11｜估數字・即場**　全場所有人嘅手機加埋，總共裝咗幾多個 App？
- 主持貼士：iPhone 同 Android 都喺「設定」睇得到。

**Q12｜估數字・即場**　全場所有人嘅鞋碼加埋，係幾多號？（即刻問隔籬）
- 主持貼士：用歐碼相加；有人唔知自己碼就當 42。

**Q13｜估數字・即場**　全場所有人嘅身高加埋，係幾多米？
- 主持貼士：一齊報數，主持即場加總。

**Q14｜估數字・即場**　由而家呢一刻到今晚 12 點，仲有幾多分鐘？
- 主持貼士：答案隨時間變，**以收卷嗰刻 server 時間為準**（大mon 顯示嘅時間）。

**Q15｜估數字・常識**　香港人平均每日用手機幾多個鐘？
- 參考答案：約 **4 小時**
- 主持貼士：講「多過你以為」做提示。

**Q16｜短答・人體**　一個成年人身體有幾多塊骨頭？
- 參考答案：**206 塊**
- 主持貼士：初生嬰兒有 300 塊左右，長大後融合。

**Q17｜短答・常識**　一杯標準 espresso 大約用幾多克咖啡粉？
- 參考答案：**7–9 克**
- 主持貼士：答 5–15 克之間都算中。

**Q18｜短答・香港**　香港最高嘅山叫咩名？
- 參考答案：**大帽山**（957 米）
- 主持貼士：唔係太平山（552 米）。

**Q19｜短答・廣東話**　廣東話「一匹布咁長」，一匹布實際有幾長？
- 參考答案：古制一匹＝四丈＝四十尺，大約 **13 米**
- 主持貼士：所以「一匹布咁長」真係好長。

**Q20｜估數字・即場**　全場所有人嘅銀包加埋，總共有幾多張紙幣？（唔使講金額）
- 主持貼士：數張數唔數金額，通常個數細到全場嘩然。

**匯入後預設**：MC 20 秒／1 分；開放 45 秒／2 分；全環節 30 分（同舊版一致）。

---

## 附錄 B：四關預設規則頁文字（RulePage seed，可直接用，後台隨時改）

> 每個 game 一頁、`enabled:true`、`autoAdvanceSeconds:0`（手動翻頁）。以下用 block 概念分段；實際存 JSON，由後台編輯器維護。放晒入 `Room.rulePages`，journal 一齊落盤。

### B.1 拍賣估歌

- **title**：拍賣估歌　**subtitle**：出價最高，聽完先估
- **heading**：玩法
- **steps**：
  1. 每人在自己手機輸入出價（0 至 100）
  2. 最高價者獨得估歌權（同價：先交者贏）
  3. 聽一段歌，10 秒內講出歌名
  4. 主持揭曉歌名同分數
- **score-table**：答對 ＋5｜答錯 0｜冇得標 冇分
- **callout**：出價唔會扣分，放心報高！

### B.2 一圖多用畫畫猜人

- **title**：畫畫猜人　**subtitle**：畫得似唔似，全場投票
- **heading**：玩法
- **steps**：
  1. 每人喺紙上畫（限時 1 分鐘）
  2. 主持影相、上載上牆
  3. 大家喺手機投「邊張最似」
  4. 主持逐張評審加分
- **score-table**：每得一票 ＋1｜最高票作品額外 ＋2｜主持評審 ＋1 或 ＋2
- **callout**：一人一票，投咗唔可以改。

### B.3 搗蛋鬼（版本 A）

- **title**：搗蛋鬼　**subtitle**：有內鬼，兩輪揪人
- **heading**：玩法
- **steps**：
  1. 每人收一個秘密身份（只有你自己睇到）
  2. 第一輪投票：最高票**而且過半**先淘汰；唔過半或平票由主持裁決／重投一次
  3. 第二輪再投（規則同上）
  4. 兩輪都揪唔中就係搗蛋鬼贏
- **callout**：唔可以投自己；重投每輪最多一次。
- **score-table**：揪中（每位投中者）＋3｜兩輪都揪唔中（搗蛋鬼）＋5

### B.4 問答

- **title**：常識問答　**subtitle**：每人自己答，答案唔會漏
- **heading**：玩法
- **steps**：
  1. 大mon 出題，手機揀 A／B／C／D
  2. 揀完撳「確認送出」，確認後唔可以改
  3. 時間到自動收卷（或主持立即收卷）
  4. 大mon 先出分佈，主持再揭曉正解
- **score-table**：MC 答對 ＋1（20 秒）｜開放題 ＋2（45 秒）｜估數字最接近 ＋2
- **callout**：唔好睇隔籬；答案一經確認就作實。

## v2 → v3 → v3.1 改動摘要

1. **技術棧定案**：Rust 全線移除；全棧 TypeScript＋Node LTS 單 process（D14）
2. **後台定案**：Windows server（Node service＋cloudflared 同機）；NAS 完全退役，冇後備 server（D6/D27）
3. **新增 media deck**：host 可多開，音源由 host 機擔任，大mon song mode 預設靜音（D23）
4. **路由定案**：一個 hostname＋path；Cloudflare Access 鎖 /host＋/api/host/*；API namespace 重構（D24/D25）
5. **Hardening 吸收自外部 review**：WS 保護（maxPayload／rate limit／slow consumer／上限）、reconnect race 三條款、clock offset、graceful shutdown、production 禁令、單 instance 聲明、correlation ID
6. **驗收升級**：bots.mjs 30 clients 先行；tally／身份／歌名三個 sniffer 檢查；校歪時鐘測試（D26）
7. **執漏**：mode enum result→tally/reveal；卡型 5→6（補 open）；「36 題」修正做 20 題（來源 live_page.py QUIZ）；Q14 時間基準寫死；搗蛋鬼版本 A 正式拍板；砍走 v2 未排期嘅「local-only 模式」空頭支票

### v3 → v3.1（2026-11-16，三模型 final check 後）

1. **9 個 P0 寫死**：①唯一權威（§開頭）②題庫 canonical（D34、附錄 A）③網絡拓撲（D31、§9.2–9.3）④三個 game 計分（§4 搗蛋鬼、§5.1 拍賣、§5.2 畫畫；另 §3.1／§5.3 估數字同 open 輸入）⑤狀態機主從（§6）⑥Round／roundId（§6、§7）⑦host command envelope＋角色 DTO（§7）⑧media deck 唯一音源（§6、§8.2）⑨每關規則頁（D30、§6.1、§8.4、附錄 B）
2. **新增決定**：D29（搗蛋鬼版本 A）、D30（規則頁）、D31（server 留屋企＋熱點後路）、D32（拍賣只 points）、D33（唔做 SW）、D34（題庫 canonical）
3. **範圍砍**：seconds 拍賣、service worker／離線 app shell、YouTube／Apple 秒級同步（降級做手動）、Buzz 搶答（孤兒規格）
4. **協議升級**：host command envelope（idempotent＋expectedRevision）、穩定 error code 清單、ping／pong RTT 校時、roundId／payloadHash、Origin 檢查、token 規格（≥256-bit、hash、8 小時）
5. **資料模型**：Room 加 rounds／rulePages／currentRoundId／seqEpoch；新增 `Round`、`RulePage`、`RuleBlock`、`AudioLease`；Submission 加 roundId／payloadHash／onBehalfOf；ScoreEvent 加 roundId／submissionId／lineage；MediaPlayback 加 deckId／state／pausedAt／resumedAt／positionMs
6. **部署同持久化**：Node 26 LTS pin、journal manifest＋segment＋checksum＋fsync、fault-injection 驗收、上傳安全、每關 export checkpoint
7. **驗收全部量化**：join p95、patch ≤1 秒、倒數 ≤0.5 秒（注入延遲）、fault-injection 五 case、狀態四元組、計分逐筆對帳
8. **題庫／列印包**：附錄 A 定為 canonical；舊 QUIZ 8 條開放題退役；print-pack 要由同一 seed 重 build
