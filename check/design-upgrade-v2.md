# 視覺升級 v2 — 診斷、改動、驗證

> 2026-11-19（v2）＋ 2026-11-19 晚（v3）｜範圍：`/`（landing）`/stage` `/host` `/play` 三端視覺；**唔改功能、唔改規格**
> 背景：PLAN-v3.1 §8「只改視覺，class 名同 DOM 結構不變」仍然有效；本輪只加 class、唔改名
> 參考方法：`elayadesign/redesign-skill`（MIT）嘅 audit 清單——字階、單一 accent、同心圓角、
> 暖色投影、states、motion、copy。**冇安裝任何 skill／npm 套件，人手照清單做。**

---

## 1. 診斷（before）

| 位置 | 問題 |
|---|---|
| 全站 | 米白底偏冷灰；卡片「白底＋1px 邊＋陰影」三重疊，層級靠陰影唔係靠大小／間距 |
| 大mon `/stage` | 房碼同 QR 係兩件浮喺中間嘅物件，冇共同容器；分數條係一條死白 bar；小標（「分數」「揭曉」）係一行浮字 |
| 主持台 `/host` | 每個 list 動作都係實心黑／實心紅方塊（出卡一版 7 個黑色「開」、玩家一版 6 個紅色「踢」）→ 視覺噪音，冇主次 |
| 主持台 chips | `phase playing`／`mode idle`／`rev 114`／`approved` 中英混雜，係 debug 文案 |
| 手機 `/play` | 入場後所有卡片**冇左右 padding**（`play-wrap` 只包住入場畫面），390px 機貼邊；`.helptext` 用 26px 正文；emoji 64 格用 inline grid；色板 8 粒會斷成 7+1 |
| 手機 `/play` | disabled 主掣 = 黑色 45% opacity → 一舊灰；倒數係一行黑字 |
| 無障礙 | focus ring 唔一致；`prefers-reduced-motion` 冇處理；disabled 狀態靠 opacity |

## 2. 改咗乜

### 設計 token（`public/app.css` 尾段 v2 layer）
- 色：暖紙底 `#f6f4ed`、暖黑 `#16150f`、**單一 accent 青檸**（`#cdf56e`／`#a8d84a`），其他色只留語意（綠＝正確／紅＝錯／紫＝身份）
- 圓角 scale：12／16／24／32；內層 = 外層 − 內距
- 投影：暖色 `rgba(58,47,24,…)`，光源統一由上而下；**主持台卡片唔用陰影**（只做分組，層級靠背景同標題）
- 質感：極細 grain（SVG turbulence，opacity 4%，黑屏自動關）+ 單色 radial 暖光；**冇彩色漸變背景**
- motion：`cubic-bezier(.22,1,.36,1)`，顏色 200ms／位移 120ms；`prefers-reduced-motion` 全部關
- focus：`outline 2px ink + 青檸 halo`，button／input／select／textarea／a 一致

### 大mon `/stage`
- 房碼＋QR 收埋一張紙卡（`.idle-cols` 卡片化）；房碼改成**黑卡青檸數字**做視覺焦點；QR 加青檸外圈
- 頭像改 squircle（`border-radius: 32%`）——同圓角卡片同一語言，比正圓有辨識度
- 小標做成 pill（青檸圓點 + 字距），唔再係浮字
- 分數板：名次做獎牌圓牌（1 青檸／2 蜜桃／3 淡紫），第一行淡青檸漸層底
- 分數條：玻璃 bar + 每個人變成細 pill、第一名青檸名次牌；**改為可換行**（10 人以上唔會再被切走）
- 內容垂直置中用 `justify-content: safe center`：短畫面（問題／揭曉／分數）居中，長內容（規則頁）照樣由頂開始、唔會切頂
- 規則頁字階收一級（88→80、44→40），1080p 一頁放多兩行

### 主持台 `/host`
- 頂欄：青檸方塊 brand、房碼 pill 轉深色、技術 chips 用 mono；`phase/mode/rev` 改中文（階段／畫面／版本）
- 文案統一粵語：`Rundown→流程`、`Skip 呢關→跳過呢關`、`開始 playing→開始遊戲`、`回 Lobby→返大堂`、`去 Final→去結算`、`approved/pending/done/running→已批准／待批准／已完成／進行中`（`gameId` 等技術 id 保留英文）
- tabbar：選中＝白 pill + 底部青檸短線，唔再靠陰影
- 列表動作降噪：`開`、`批准` 改青檸；`踢`、`刪` 改白底紅字（實心紅只留緊急「黑屏」）
- 卡片改 flat（白底＋hairline、無陰影），section 標題加青檸方點

### 手機 `/play`
- **修正結構 bug**：入場後嘅畫面全部包返 `.play-wrap`（390px 唔再貼邊）
- 頭像 8 欄（≤420px 自動 7 欄，觸控目標 ~41px）；色板改 8 欄 grid、圓角方塊
- `.helptext` 由 26px → 14px；`揀個頭像` 改用 `.field-label`
- disabled 主掣改「淺底灰字」而唔係半透明黑；倒數加青檸 pill
- 選項、keypad、底部 bar 統一圓角同按壓回饋

### Landing `/`
- 由連結清單改成 hero：kicker（2026 HBD・香港・約 10 人）＋大標題（青檸 highlight）＋四張入口卡（箭頭 hover 位移）

## 3. 動過嘅檔

| 檔 | 改動 |
|---|---|
| `platform/public/app.css` | 尾部新增 v2 layer（tokens／三端／landing／motion）；原規則保留做 fallback |
| `platform/public/index.html` | landing 重寫（新 class） |
| `platform/public/{stage,host,play}.html` | 只改 cache-busting `?v=20261119p2` |
| `platform/src/client/play.ts` | inline style → class；入場後包 `.play-wrap`；色板 inline 尺寸移入 CSS |
| `platform/src/client/host.ts` | 新增 `PHASE_LABEL`／`RD_STATE`；頂欄 chips 同 rundown 狀態改中文 |

**冇改**：server、protocol、狀態機、任何 class 名、`stage.ts`（unit test 有 assert 佢嘅原始碼 pattern）。

## 4. 驗證

- `npm test`：**57/57 pass**（每次改完 client TS 都重跑）
- 真 render 截圖（headless Chrome，非口供）：
  - `/stage` 1920×1080：idle、question/reveal、scoreboard、rules → `check/design-shots/after-stage-*.png`
  - `/host` 1280×800：控制、玩家 → `after-host-*.png`；1920 登入頁
  - `/play` 390×844：入場頁 → `after-play-join-390.png`
  - landing 1440×900
- 人手流程：入場（pending）→ 主持批准 → 開卡 → 手機答 → 時間到自動收卷 → 揭曉（大mon＋手機）→ 分數板 → 規則頁 全部行得通

## 5. 未做／已知限制

1. **規則頁內容過長**：1080p 一頁仍然會切底（1/2 頁）。呢個係內容長度問題，要靠主持分頁；CSS 唔會幫你壓到無限。
2. **真機未試**：iPad Safari 嘅 safe-area／Chrome kiosk 嘅字型（Windows Microsoft JhengHei）未實機睇；字重 700/800 喺 Windows 會 fallback。
3. **未部署**：改動只喺本機 `platform/public`＋`src`。上線要 sync 去 `C:\Users\fmk-server\hbd\platform` 再 `docker compose up -d --build`（見 §6）。
4. grain overlay 係 fixed 全屏 SVG，kiosk Chrome 冇問題；如果舊機掉 frame，刪 `body::after` 一段就返。

## 6. 上線

```bash
# 本機（改動已 build 好 public/js）
cd game-platform/platform
npx tsc -p tsconfig.client.json     # 只改過 client TS 才需要
node scripts/make-manifest.mjs      # 更新 DELIVERY-MANIFEST.json

# server（Windows）
# 1) sync platform/public、platform/src、platform/dist（如有 rebuild）去 C:\Users\fmk-server\hbd\platform
# 2) cd C:\Users\fmk-server\hbd\platform && docker compose up -d --build
# 3) 大mon 同手機 hard refresh（HTML 已帶 ?v=20261119p2，正常唔需要）
```


---

# v3 — Doubao 淺色底 ＋ 思緒重生體（2026-11-19 晚）

> 要求：底色改跟 `design/Doubao Copy`，但要**淺色**；全站字體用 `思緒重生體`。

## v3.1 對照

| 項目 | Doubao（參考） | 本專案 v3 |
|---|---|---|
| 底 | `#ffffff` 主區、`#eff1f4` 側欄 | `--bg #f7f9fc`（冷調淺色，大mon 唔刺眼）、卡片 `#fff` |
| Primary | `#0065fd` | `--lime` 直接改值 `#0065fd`（所有 accent 一次過變藍） |
| 文字 | `#0e1115` / `#333942` / `#7f8d9f` | 同 |
| 邊 | `#e7eaef` hairline | 同；**取消大部分陰影**（border 分層） |
| 圓角 | 19.2px | 12／18／24；掣＝pill（999） |
| 選中 | 黑色 pill（分類 tab） | 主持台 tabbar active＝黑 pill 白字 |
| 陰影 | 幾乎冇 | 只留卡片 1–2px 淡陰影 |

## v3.2 字體

- 檔：`platform/public/fonts/reborn.woff2`（由 `思緒重生體/MMF-RebornFont-V1.2-Normal-swzjlg.otf` 轉 WOFF2，1.9MB → **1.43MB**）
- `@font-face` 宣告 `font-weight: 100 900`（單一字重，避免瀏覽器合成假粗體）＋ `font-display: swap`；HTML `<link rel=preload>`
- `--font` 同 `--mono` 都用 Reborn；`font-synthesis: none`
- **數字例外**：呢隻字嘅 0–9 係哥德體（0 會似方格，2/3/6 細字時易睇錯），所以 `unicode-range` 排除 `U+0030–U+0039`，數字 fallback 去系統字；`body{font-weight:600}` 令 fallback 數字同中文字重睇齊
- 覆蓋率：cmap 5,731 字，本專案所有中文（題庫／規則／界面）100% 有；缺字只有 emoji／符號（▶◀✅ 等），照舊 fallback

## v3.3 元件

- 掣：pill（Doubao primary 藍／secondary 淺灰／ghost 白底 hairline；破壞性只留緊急黑屏實心紅）
- 主持台：tabbar＝灰底 pill 容器＋選中黑 pill；mode tiles 改圓角卡（唔跟 pill），active＝淺藍底＋深藍字（唔再成版實心藍）
- 大mon：房碼黑卡白字、稱號藍色 highlight、分數板白卡 hairline、第一名淺藍底、ticker 玻璃白；規則頁字階再收一級（1080p 一頁放得落）
- 手機：卡片白底 hairline、選項圓角卡、主掣藍 pill、emoji tile 淺灰
- 規則頁：`.rules-body` 加底部淡出 mask（內容偶爾過長都唔會硬切）

## v3.4 驗證

- `npm test` 57/57
- 1920×1080：待機／分數板／規則頁；1280×800：控制／玩家；390×844：入場；1440×900：landing
- 截圖：`check/design-shots/after3-*.png`

## v3.5 注意

1. **字體授權**：用戶已購買、**可商用**（`Trial` 檔只係 beta preview 一併下載，冇用）。
2. **字重**：字型只有一個字重 → **只限大mon `/stage` 使用**（v3.6）；主持台／手機／landing 用系統字（SF／PingFang），因為單一字重喺細字同表單會太重。其餘三端字體待用戶之後另揀。
3. **載入**：字型 1.43MB，**只有 `/stage` preload**（主持台／手機／landing 唔會下載）；大mon 係 LAN 直連，冇 4G 問題。
4. **數字**：見 v3.2——如果你想連數字都用返字型原本嘅哥德數字，刪 `unicode-range` 一行就係（但 0 會似方格）。


## v3.6 字體收窄（2026-11-19 晚）

- 只有 `body.stage` 用 `--font-reborn`；`--font`／`--mono` 回復系統字
- `stage.html` 保留 `<link rel=preload>`，其餘三頁移除（手機唔會白載 1.43MB）
- `.pill` 改 `font-family: inherit`，主持台技術 chips 回復 mono
- 大mon 內文 `font-weight: 600`（中文唔受影響，主要令 fallback 數字同中文視重一致）
