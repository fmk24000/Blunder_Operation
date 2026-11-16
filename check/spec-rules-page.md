# 規格：每關遊戲規則頁（Rule Page）— 大mon 開場顯示＋後台編輯

> 對應需求（用戶原話）：「每個 game 都加留一頁係用黎show 遊戲規則，係開始前要係大mon show，同埋記得係後台比我 edit」
> 呢份係可貼入 PLAN-v3 嘅完整章節草稿；行號引用全部對照 `game-platform/PLAN-v3.md`（585 行版）。
>承接 `check/plan-v3-glm-review.md` B-7a（L93）：B-7a 只提出「rules 內容來源未定義」，本章節將佢收窄成完整規格——內容來源＝**獨立 rules 庫（RulePage[]）**，rundown item 以可選 `rulePageId` 引用，唔採用 B-7a 原建議嘅 `rulesText` 純文字欄（結構化 blocks 先撐到分頁、圖示、計分表；`rulesText` 留俾 fallback）。

---

## 1. 設計摘要（一頁內）

- **每關一頁規則**：預設 4 頁，對應 PLAN-v3 §3（L62–67）四關——拍賣估歌、一圖多用畫畫猜人、搗蛋鬼（版本 A）、問答。
- **以 gameId 綁定**：RulePage.gameId 對應 RundownItem.gameId（L146–148）；rundown item 可加可選 `rulePageId` override。
- **自動觸發**：rundown/next 進入該關時，stage **自動先出 rules mode**；host 撳「開始」先入該關第一張 card。
- **手動顯示**：host 任何時候可以出／收規則頁（唔改 card 流程，Card.state 先至係遊戲進度權威）。
- **後台編輯**：/host 新增規則頁編輯器——新增／編輯／軟刪／排序／複製／重設預設／即時預覽（預覽唔 broadcast）。
- **玩家永遠唔可以改**：所有 rules API 收 `/api/host/*`（D25，L45）；player token 冇任何 rules 寫入權限，stage 亦係唯讀（D3，L23）。

---

## 2. 資料模型（貼入 PLAN-v3 §6）

**存放位置決定：獨立 rules 庫（`Room.rulePages: RulePage[]`）＋RundownItem 引用**。理由：①同一 gameId 嘅 rundown item 可能重複出現（重玩），引用唔使抄內容；②規則文字同流程狀態生命週期唔同（規則賽前編、流程當晚跑），分開 edit UI 干擾細；③歌單已經係同款「獨立庫＋songId 引用」先例（L115），风格一致；④journal replay（L324）一齊落盤，重啟即恢復。

```ts
type RuleBlockType =
  | "heading"      // 小標題（例「點計分」）
  | "paragraph"    // 一段文字
  | "bullets"      // 項目符號（≤6 item）
  | "steps"        // 有序步驟 1. 2. 3.（≤6 item）
  | "callout"      // 重點框（黃底／高亮，例「⚠️ 唔可以睇隔籬」）
  | "kv"           // key-value 短行（例「⏱ 每題：20 秒」）
  | "score-table"  // 計分表（items = ["答對 +1", "答錯 0"] 每行一項）
  | "image";       // emoji 大圖 or 上載圖（url）

type RuleBlock = {
  id: string;
  type: RuleBlockType;
  text?: string;              // heading／paragraph／callout／kv key／image alt 用
  items?: string[];           // bullets／steps／score-table 用（≤6 item）
  value?: string;             // kv 嘅 value（例 key="⏱ 每題" value="20 秒"）
  icon?: string;              // 一個 emoji，行頭顯示（同平台 emoji 圖示一致）
  emphasis?: "normal" | "hot";// hot＝大一級字＋高亮色
};

type RulePage = {
  id: string;
  gameId: string;             // 綁定 RundownItem.gameId（L146）
  title: string;              // ≤16 字（大mon 標題級）
  subtitle?: string;          // ≤24 字（例「估中有分，唔識咪亂猜」）
  blocks: RuleBlock[];        // ≤20
  order: number;              // 編輯器列表排序用
  enabled: boolean;           // false＝rundown 自動觸發時 skip（當冇頁）
  autoAdvanceSeconds: number; // 分頁自動轉頁間隔；0＝純手動（預設 0）
  updatedAt: number;          // server 時鐘 ms
  version: number;            // 每次成功儲存 +1，multi-host 衝突檢查用
  updatedBy: string;          // host 名（activity toast 同名，L285）
  archived?: boolean;         // 軟刪標記
};

// Room 加一個欄位（貼入 L124–132 Room type）：
//   rulePages: RulePage[];
// RundownItem 加可選欄（貼入 L146–148）：
//   rulePageId?: string;       // override：呢個 item 用邊頁；缺省＝用 gameId 自動對應
//   rulesText?: string;        // ≤300 字 fallback 純文字（RulePage 缺頁／parse 失敗時顯示）
```

**約束（server 儲存時驗證，違反回 `W_RULES_LIMIT`）**

| 約束 | 上限 |
|---|---|
| 每頁 blocks | ≤ 20 |
| 每 block `text`／每 item | ≤ 120 字（中英同計） |
| 全頁文字總和（text+items+value） | ≤ 1200 字 |
| `image` block 圖檔 | ≤ 1MB，jpg/png/webp |
| `bullets`/`steps`/`score-table` items | ≤ 6 |
| 每房 RulePage 總數（未 archived） | ≤ 30 |
| `gameId`＋`order` | 唯一性：同一 gameId 只可以有一頁 `enabled:true` 做「預設頁」；多頁時 rundown 自動觸發揀 `order` 最細嗰頁 |

**缺省值**：新建頁 `enabled:true`、`autoAdvanceSeconds:0`、`version:1`、`blocks:[]`、`icon` 每類預設（heading 📌、bullets •、steps 🔢、kv ℹ️、score-table 🏆、callout ⚠️）。Server 起動時若 rules 庫空（新 journal），seed 附錄 B 四頁。

---

## 3. 觸發同生命週期

1. **rundown/next 進入某關（自動）**：`POST /api/host/rundown/next`（L266）令 currentItemId 轉去新 gameId 嘅 item 時，server 自動發 `stage.set {mode:"rules", payload:{rulePageId, autoAdvanceSeconds}}`（target mode 規則見下）。Stage 出規則頁；host 撳「開始呢關」（＝出第一張 card）先轉入遊戲 mode。**規則頁唔倒數、唔自動收**——唯一例外係 `autoAdvanceSeconds > 0` 時只管「頁內分頁」每 N 秒自動轉，轉完尾頁停喺尾頁，永遠唔會自動離開 rules mode。
2. **host 手動「顯示規則」掣**：任何 phase 任何 mode 都可以撳；再撳＝收。**只改 StageState，唔改任何 Card.state、RundownItem.state、 Submission**——Card.state（L173）係遊戲進度唯一權威，rules 純粹係顯示態 overlay。收規則頁後 stage 返回**入 rules 前嘅 mode**（server 記 `prevMode`；若 prevMode 係 blackout 就留 rules，見第 5 點）。
3. **mode 邊度可以出現**：`phase=playing` 同 `phase=final` 都可以出 rules（final 俾 host 補講規則／重溫計分）；`phase=idle`/`lobby`/`award` 拒絕（回 `W_WRONG_PHASE`）。`StageState.lock=true`（L191）時：**rundown 自動觸發唔會 override lock**（同 L277「lock 一開主持改卡都唔影響」一致），但 host 經 `/api/host/stage/rules` 手動顯示會照樣生效（host 主動指令大過 lock，等同 host 解 lock 嘅意圖）。
4. **blackout**：blackout 優先級最高——blackout 期間 rules 指令被拒（`W_STAGE_LOCKED`）；收 blackout 後 stage 返 blackout 前嘅 mode（若係 rules 就返 rules）。
5. **重玩同一關**：rundown item 再入 running（同一 gameId 第二個 item 或 host 跳返），照樣自動出規則頁（同一頁或 `rulePageId` 指定另一頁，例如決勝版規則）。規則頁唔記「已讀」狀態。
6. **缺頁 fallback**：currentItemId 對應 gameId 冇 enabled 頁 → server log `warn`（pino，帶 gameId），stage 顯示 RundownItem.rulesText（若有）或 item title 大字＋「等主持開始」；流程照推進唔阻。

---

## 4. 大mon 畫面規格（1920×1080 kiosk）

貼上（§8.1 L277「rules」一詞展開成）：

> **rules**：內容＝rulePages 庫入面 currentItemId 對應頁（§6 RulePage；缺頁 fallback 見規格第 3.6 條）。版面：頂部左「第 N 關」badge（48px 圓角底）＋關名 title（≥96px 粗體，≤16 字）＋subtitle（56px 灰字）；主體 blocks 由上到下排，heading 64px、paragraph/bullets/kv 內文 ≥48px、bullets/steps 行距 1.6 倍、score-table 每行 56px 附 emoji；callout 黃底黑字大框（64px）。深色高對比、**冇滾動條**（同 L277 全域要求）。**常駐分數條照顯示**（bottom 96px，主內容 padding-bottom 112px，同 L279 一致）；**唔顯示 QR**（規則頁要全神貫注，QR 淨係 idle mode 出，L277）；如果嗰關有「呢關關鍵：入房 QR」呢類需要，host 自己加 image block 影 QR 截圖。主持人名唔顯示（大mon 唯讀冇操作提示，D3）。圖示一律 emoji。

- **分頁策略（寫死：自動分頁＋host 可插手）**：一頁 blocks 顯示唔晒（主體高度 > 1080−112−標題區 260px ≈ 700px）→ 按視覺高度切成 sub-page；每 sub-page 停 `autoAdvanceSeconds` 秒（預設 0＝唔自動，等同淨得一版）；右下角（分數條上方）顯示「2/3」頁碼（32px）；host 台有「上一頁／下一頁」掣隨時插手，插手後自動計時重設。
- **最大字數計算**：48px 內文、行高 1.5＝72px/行；主體 700px ≈ 9 行安全區；每行 48px 字約 34 個全形字 → 每版安全上限 ≈ 300 字；全頁 1200 字上限即 ≤ 4 sub-page，同「≤20 blocks」約束互鎖。

**kiosk 佈局數值表（rules mode 版面，1920×1080）**：

| 區域 | 位置 | 尺寸／字級 |
|---|---|---|
| 關卡 badge「第 N 關」 | 頂部左，x=64 y=48 | 高 72px 圓角、字 40px |
| title | badge 右側／下方 | ≥96px 粗體、≤16 字 |
| subtitle | title 下方 | 56px、#9aa 字色 |
| 主體 blocks 區 | y≈300 起 | 闊 1792px（左右 padding 64px） |
| heading block | — | 64px、左邊 4px 橫線裝飾 |
| paragraph／bullets／kv | — | ≥48px、行距 1.5、bullets 行距 1.6 |
| score-table 每行 | — | 56px、行尾右對齉分數、🏆 行頭 |
| callout | — | 全闊框、黃底 #ffd54f 黑字 64px |
| 分頁碼「2/3」 | 右下 x=1792 bottom=128 | 32px（分數條上方 32px） |
| 常駐分數條 | bottom 96px | 同 L279，rules mode 照顯示 |
| 主內容安全底 | padding-bottom | 112px（L279 同款） |

**渲染規則**：blocks 順 `order` 直排；`emphasis:"hot"` 嗰個 block 字級 +12px 並轉主題色（#ffd54f）；emoji icon 一律 56px 行頭置頂對齊；所有文字 `text-wrap:balance` 防單字成行；sub-page 切頁用 opacity 0.3s 淡入，唔准滑動。

---

## 5. 主持台編輯器規格（/host 第 14 項）

貼上（§8.2 L299 後加）：

> 14. **規則頁編輯器**：左列規則頁清單（gameId badge＋title＋enabled 掣＋order）；右邊編輯區＝title/subtitle＋blocks 列表。操作：新增頁／軟刪（archived，可還原）／排序（上下掣，唔做拖曳——iPad 先天手勢衝突）／複製頁（「(副本)」後綴，gameId 要手動改）／**重設預設**（還原做附錄 B 原文，要確認 dialog，原預設 seed 長駐 code 入面唔會刪）。Block 編輯：新增 block（揀類型）、上下移、刪除、類型切換（text/items 保留遷移）。**即時預覽**：內嵌 1280×720 canvas（1920×1080 按 2/3 縮），像素比例 1:1 模擬大mon；預覽純本地渲染，**唔 broadcast**——要撳「顯示上大mon」先經 `/api/host/stage/rules` 廣播。字數上限：每個輸入框右下角顯示「87/120」；超限＝儲存掣 disabled＋紅框＋「超字數，儲唔到」。未儲存離開（切頁／關 tab）→ beforeunload 警告。Ctrl+Z 支援單 block 刪除／移動 undo（≤20 步）。審計：列表每頁顯示 updatedAt（HH:mm）＋updatedBy；multi-host 衝突：PATCH 帶 client 讀取時嘅 version，server 比對唔符 → 回 409 `W_RULES_VERSION_CONFLICT`，host 台彈「其他人已改，重新載入定覆蓋？」（重新載入＝丟草稿攞新版；覆蓋＝帶新 version 再 submit）。

**編輯器操作流程細節**：

| 動作 | 觸發 | 行為 |
|---|---|---|
| 新增 block | 「+」掣（每個 block 下方都有，插入喺嗰個之後） | 彈 8 類型揀選（emoji 圖示＋類名）；新建 block 即入編輯態 |
| 上落移 | block 右上 ↑↓ | 即時預覽同步；到頂／底掣 disabled |
| 刪除 | block 右上 🗑 | 即時預覽同步；Ctrl+Z 可還原 |
| 類型切換 | block 右上類型 dropdown | text↔items 盡量遷移（paragraph→bullets＝按句號切 items）；遷移唔到嘅內容放返 text |
| 儲存 | 「儲存」掣（Cmd/Ctrl+S 快捷） | 先 client 驗約束（字數／items 數）→ PATCH 帶 baseVersion；成功後列表 updatedAt 閃綠 1s |
| 顯示上大mon | 「顯示」掣（儲存成功後先 enabled） | POST `/api/host/stage/rules`；broadcast activity toast「阿Ken 顯示咗規則頁」（L285 語義） |
| 預覽分頁 | 預覽區左右箭咀 | 只影響本機預覽，唔影響 stage 當前 pageIndex |
| 收規則頁 | 大mon 控制條「收起規則」 | show:false → stage 返 prevMode |

**iPad 相容**：編輯區輸入框 minimum 44px 觸控目標；上下掣優先拖曳（已寫死唔做 drag）；beforeunload 喺 iPad Safari 唔可靠——切頁警告改用 app 內 route guard（偵測 dirty state 彈確認 dialog），關 tab 就接受丟失（草稿另存本機 draft，重開還原，L399 語義）。

---

## 6. API＋WS（沿用 §7 namespace，D25）

**HTTP 新增 rows（貼入 L259–270 表）**：

| Method | Path | 權限 | 用途 |
|---|---|---|---|
| GET | `/api/host/rules` | host token | 列表（含 archived，body：`{archived?:boolean}`） |
| GET | `/api/host/rules/:id` | host token | 單頁全文 |
| POST | `/api/host/rules` | host token | 新增（body：RulePage 減 id/version/updatedAt） |
| PATCH | `/api/host/rules/:id` | host token | 改內容；body 必帶 `baseVersion`；成功 version+1 |
| DELETE | `/api/host/rules/:id` | host token | 軟刪（archived:true） |
| POST | `/api/host/rules/:id/reorder` | host token | body `{order:number}` |
| POST | `/api/host/rules/:id/reset` | host token | 重設做附錄 B 預設（原 id 不變） |
| POST | `/api/host/stage/rules` | host token | body `{rulePageId, pageIndex?, show:boolean}`；show=false 收規則頁返 prevMode |

回應 schema：成功＝完整 RulePage（或 `{ok:true}`）；錯誤＝`{error:{code,message}}`。錯誤碼：`W_RULES_NOT_FOUND`（404）、`W_RULES_LIMIT`（400，超 §2 約束）、`W_RULES_VERSION_CONFLICT`（409）、`W_WRONG_PHASE`（409，§3.3）、`W_BAD_MSG`（400 schema 不合，L253）。

**WS patch ops 新增（貼入 L249 ops 清單）**：`stage.set` 已覆蓋 `mode:"rules"`＋`payload:{rulePageId, pageIndex, autoAdvanceSeconds, totalPages}`；新增 op `rules.update {rulePage}`——**只 broadcast 去 host 頻道**（另一位 host 正開緊編輯器即刻見到人哋改咗）；stage 收 `stage.set` 全 payload（渲染要即時）；**player 唔收 rules.update，stage 唔收草稿**（草稿只存在 host 編輯器本機，L399 同款語義）。

---

## 7. 預設 4 關規則文字（廣東話初稿＝附錄 B 種子）

**B1｜拍賣時間估歌**（對 §3 L64、§5 L115 bid points/seconds）
- 🎤 每題用自己手機出價，價高者得估歌權（points 模式）／買聽歌秒數（seconds 模式，出價越高播得越長）
- 🔢 手機數字鍵盤出價，有上限
- 🎵 大mon 只出畫面唔出聲，音樂喺主持部機播；**全程唔會出歌名**
- 🏆 唔使分都玩得：冇人出價就跳
- ⏱ 倒數以大mon 時鐘為準
- 💡 貼士：秒數模式留啲分買尾段，通常尾段先到副歌

**B2｜一圖多用畫畫猜人**（對 §3 L65）
- ✏️ 紙畫題目→主持影相上大mon 作品牆
- 🗳 全場用手機投「邊張最似」
- 🏆 最似嗰張嘅作者得分（主持評審 +1/+2）
- 🙅 唔准寫字、唔准寫名
- 💡 貼士：畫特徵唔畫全貌，越簡單越易中

**B3｜搗蛋鬼（版本 A）**（對 §4 L89–91）
- 🕵️ 1 人係搗蛋鬼：知答案但要扮唔知
- 📱 秘密身份只送到你自己手機
- 🗳 全場 2 輪投票揪人
- 🏆 揪中：每位投中者 +3；搗蛋鬼生存到最後 +5
- ⏱ 全關約 12–15 分鐘
- 💡 貼士：講多錯多，自然啲好

**B4｜問答**（對 §3.1 L71–83）
- 📱 每人自己手機答，選擇題 20 秒、開放題 45 秒
- ✅ 兩步確認：揀完撳「確認送出」，送咗就唔可以改
- 📊 全場答完先一齊睇分佈，之後先揭正解
- 🏆 選擇題自動計分；估數字題最接近真實答案贏
- ⏱ 倒數以大mon（server）時間為準
- 💡 貼士：唔識都要答，冇負分

（每頁 export 做附錄 B JSON seed，gameId 對 rundown 預設 gameId。）

**附錄 B JSON 種子示例（B4 問答頁完整版，其餘三頁同結構）**：

```json
{
  "id": "rule-quiz-default",
  "gameId": "game4-quiz",
  "title": "問答時間",
  "subtitle": "自己手機答，唔准睇隔籬",
  "order": 4,
  "enabled": true,
  "autoAdvanceSeconds": 0,
  "blocks": [
    { "id": "b1", "type": "kv", "icon": "📱", "text": "點答", "value": "每人自己手機，選擇題 20 秒、開放題 45 秒" },
    { "id": "b2", "type": "steps", "icon": "✅", "items": ["揀答案", "撳「確認送出」", "送咗就唔可以改"] },
    { "id": "b3", "type": "callout", "icon": "⚠️", "text": "兩步確認：撳咗確認先算交卷！", "emphasis": "hot" },
    { "id": "b4", "type": "paragraph", "icon": "📊", "text": "全場答完先一齊睇答案分佈，之後先揭正解同解釋" },
    { "id": "b5", "type": "score-table", "icon": "🏆", "items": ["選擇題答對：自動計分", "估數字題：最接近真實答案贏", "開放題：主持評分"] },
    { "id": "b6", "type": "paragraph", "icon": "💡", "text": "貼士：唔識都要答，冇負分，倒數以大mon 時間為準" }
  ]
}
```

---

## 8. 對 PLAN-v3 要改邊幾行（diff 表，唔改原檔）

| 位置（§／行號） | 而家寫咩 | 改成咩 | P |
|---|---|---|---|
| §6 L124–132 Room type | 冇 rulePages | `rulePages: RulePage[];` 加喺 rundown 後 | P0 |
| §6 L146–148 RundownItem | 冇 rulePageId | 加 `rulePageId?: string; rulesText?: string;` | P0 |
| §6 L198 後 | — | 插入本章 §2 全段 type（RuleBlockType/RuleBlock/RulePage＋約束表） | P0 |
| §7 L249 patch ops | `score.append／card.update／stage.set／submission.add／rundown.set／media.play` | 尾加 `／rules.update`；stage.set payload 加 `{rulePageId, pageIndex, autoAdvanceSeconds, totalPages}` | P1 |
| §7 L259–270 HTTP 表 | 冇 rules rows | 加本章 §6 八行（GET/POST/PATCH/DELETE/reorder/reset/stage/rules） | P0 |
| §8.1 L277 | 「rules」一詞 | 展開成本章 §4 貼上段（完整 rules mode 規格） | P0 |
| §8.2 L299 後 | 13 項 | 加第 14 項「規則頁編輯器」＝本章 §5 貼上段 | P0 |
| §10 L441 M0 驗收 | — | 加「rules 庫 seed＋journal 持久化＋缺頁 fallback＋W_RULES_VERSION_CONFLICT」 | P1 |
| §10 L442 M1 驗收 | — | 加「rundown/next 進問答關 2 秒內出規則頁；host 改完按顯示 1 秒內更新」 | P0 |
| L575 附錄 A 後 | — | 追加「附錄 B：預設 4 關規則頁」（本章 §7 JSON） | P1 |
| §9.8 L432 | export 內容 | export room.json 已含 rulePages（順手註明） | P2 |

---

## 9. 驗收標準（可客觀驗）

1. 新 journal 起動 server，4 頁預設規則全部載入；刪走 game3 頁再 rundown/next 入搗蛋鬼，server log 出 warning（含 gameId）而 stage 顯示 fallback 文字。
2. bots 模擬 rundown/next 由 game1 去 game2：stage 喺 **2 秒內**收到 `stage.set mode=rules` 並顯示規則頁（bot 量 patch RTT）。
3. host 改 title 撳「顯示上大mon」，stage **1 秒內**轉新內容；另一位 host 編輯器同時收到 `rules.update`。
4. 兩個 host 同時改同一頁，後儲存嗰位收 409 `W_RULES_VERSION_CONFLICT` 並見衝突 dialog。
5. 超字數（text 121 字）儲存被拒（`W_RULES_LIMIT`），儲存掣 disabled 先、server 二驗在後。
6. rules mode 下常駐分數條仍顯示（bottom 96px）、主內容 padding-bottom 112px 唔被遮、冇滾動條、冇 QR。
7. 30 bots 同時在線＋stage rules mode 廣播，30 秒內零 WS 心跳超時（M0 bots.mjs 場景，D26）。
8. server 重啟後（journal replay）規則頁內容、enabled、version 全部仍在，stage 重連即顯示同一版。

---

## 10. 風險同裁剪建議

**必須保留（活動核心）**：一頁 per game、gameId 自動對應、rundown/next 自動先出、host 手動出／收、編輯器（改字＋預覽）、缺頁 fallback、journal 持久化。呢啲冇咗就違反用戶原話需求。

**可砍（時間唔夠）**：①`image` block＋圖片上傳（emoji + kv 已夠表達，砍埋 1MB 限制煩惱）；②自動分頁 autoAdvanceSeconds（預設本來 0＝手動；砍咗即一頁硬限 300 字內，附錄 B 已符合）；③每 game 多頁（一 game 一頁寫死，rulePageId override 留 schema 唔做 UI）；④複製頁／重設預設（seed 喺 code 入面，賽前 export 咗就得）；⑤Ctrl+Z（host 小心啲就得）。**砍序：①→⑤→④→②→③**；M1 尾就要出最少「seed 4 頁＋自動觸發＋手動顯示＋基本編輯」，因為四關都靠你開場。

**風險**：最大風險係 multi-host 衝突處理同 beforeunload 草稿丟失夾埋（兩個 host 都未儲存）——version 檢查只護到已儲存衝突，草稿層面接受最後儲存為準（同 L285「最後指令為準」一致），唔加 lock。
