# 交付報告 — 2026 HBD《奔跑吧》派對遊戲平台

> 日期：2026-11-16｜部署：Windows server `192.168.99.20` Docker，host port **30005** → 容器 3000

## 1. 而家可以點用

| 入口 | 網址 | 說明 |
|---|---|---|
| 大mon | `http://192.168.99.20:30005/stage` | Chrome kiosk，1920×1080，唯讀 |
| 主持台 | `http://192.168.99.20:30005/host` | **PIN：19891117**（8 位；可喺 server `.env` 改，支援 6–12 位數字） |
| 手機 | `http://192.168.99.20:30005/play?code=3840` | 掃大mon QR 或直接用房碼 **3840** |

- 房碼：**3840**（`/api/ready` 可查）；目前房間已清空（0 玩家），20 題附錄 A seed 已載入。
- 主持台分頁：**玩家／分組／分數／題庫／規則頁／歌單／狀態**。
  - **改問題（題目）** → `/host` →「題庫」：加／改／刪／排序、openKind、參考答案、分類；「一鍵匯入舊 QUIZ」只匯 MC 10 題唔會蓋 open 題；改完即時生效。
  - **入歌** → `/host` →「歌單」：先入歌名，再上傳 MP3（≤20MB）或補 YouTube／Apple link（只做手動提示，唔保證同步）；media deck 用一部 host 機駁喇叭申請/接管音源。
  - **每關規則頁** → `/host` →「規則頁」：四關預設文字（附錄 B），大mon 入關自動顯示。
- 題庫大量換：`server C:\Users\fmk-server\hbd\platform\data\quiz.seed.json`（純資料；只影響新房間）。

## 1.1 UI 風格（2026-11-19 更新：視覺 v2）

- **v2 方向**：暖紙底 `#f6f4ed` ＋ 暖黑 `#16150f` ＋ **單一青檸 accent**（`#cdf56e`／`#a8d84a`）；平面色塊＋極細 grain，冇彩色漸變背景；圓角 12/16/24/32、內層＝外層−內距；投影帶暖色、光源統一由頂落。
- **大mon**：房碼＋QR 收埋一張紙卡，房碼改黑卡青檸數字做焦點；頭像改 squircle；小標變 pill；分數板名次做獎牌圓牌；分數條改玻璃 bar＋可換行（10 人以上唔再被切）；短畫面垂直置中（`safe center`），規則頁照樣由頂開始。
- **主持台**：頂欄品牌方塊＋mono 技術 chips，`階段／畫面／版本／已完成／進行中` 全部中文；tabbar 選中＝白 pill＋青檸底線；列表動作降噪（`開`／`批准` 青檸、`踢`／`刪` 白底紅字，實心紅只留緊急黑屏）；卡片改 flat（白底＋hairline，無陰影）。
- **手機**：修正「入場後卡片貼邊」嘅結構問題（全部包返 `.play-wrap`）；頭像 8 欄（≤420px 7 欄）、色板 8 格圓角方塊；`.helptext` 26px→14px；disabled 主掣改淺底灰字；倒數加 pill。
- **Landing**：改成 hero＋四張入口卡。
- 上一版（2026-11-16）嘅 shadcn／iOS 風同兩個修正（CSP inline style、`?v=` cache-busting）保留；`?v=20261119p2`。
- **v3（2026-11-19 晚）**：底色改跟 `design/Doubao Copy` 淺色版（冷調 `#f7f9fc`＋白卡＋`#e7eaef` hairline＋Doubao primary 藍 `#0065fd`；取消大部分陰影、掣改 pill、tabbar 選中用黑 pill）；大字體改 `思緒重生體`（WOFF2 1.43MB，`/fonts/reborn.woff2`，**只限大mon**；主持台／手機／landing 用系統字，待另揀。數字 fallback 系統字以免哥德 0 睇落似方格）。
- 診斷、改動清單、截圖同未做項目：`check/design-upgrade-v2.md`（v2＋v3）、`check/design-shots/`（`after-*`＝v2／暖色版，`after3-*`＝v3／Doubao＋Reborn）。

## 2. 實測結果（機器驗證，非口供）

- `docker ps`：`hbd-platform Up (healthy) 0.0.0.0:30005->3000/tcp`；`/api/ready`=200、`/api/health`=200。
- 三端 `/stage` `/host` `/play`：LAN 直連全部 200；真 browser 開 /stage（QR＋房碼＋分數條渲染正常）同 /play（入名＋頭像＋入場）已截圖確認。
- **Cloudflare Tunnel 公網實測（https://partyhollye.our1tb.com）**：`/api/ready` 200（room 3840）、`/play` `/stage` `/host` 200、**WS handshake 101**（wss 通）、`/api/host/snapshot` 401（冇 token）、`/api/join` 經公網成功加入（pending）；HTTP/2＋CSP header 正常。
- 重啟持久化：`docker compose restart` 前後 `room 3840 revision 12 scores [11,9,7,5,3,1]` 一致（Lead 親手跑）。
- 測試總數：M0 bots 22/22、M1 28/28、M2 22/22、M3 10/10、M4 9/9、M5 11/11（本機＋部署各跑一次）；skew 101ms（唔校時對照 3000ms）、fault injection 5/5、unit 9/9。
- 四關＋規則頁／計分帳簿／undo／換組／頒獎／export 全部有原始 log：`game-platform/evidence/M0..M5/`。

## 3. 三模型分工（實際執行）

| 角色 | 模型 | 做咗乜 | 證據 |
|---|---|---|---|
| builder | `dsh-opencode-go/deepseek-v4.1-flash` | M0–M5 實作＋測試＋Docker 部署 | `game-platform/platform/`、`evidence/` |
| checker | 真實 **GLM-5.3**（API） | M0／M1／M2-M4 review；r2 覆核 P0 清零 | `check/glm-review-M0-r2.md`、`glm-review-M1-r2.md`、`glm-review-M2M4.md`（meta `response_model=glm-5.3`、`finish_reason=stop`） |
| auditor | 依用戶指示由 Kimi 轉 **`deepseek-v4-pro`** | 最終獨立驗收＋DoD §12 逐項 | `check/audit-final-deepseek-v4-pro.md`（meta `response_model=deepseek-v4-pro`） |

GLM review 期間修正咗 10+ 個真 P0（Q14 自動派分、主持手改答案、bid 雙重結算、deck 遲 10 秒停播導致雙響、revision 重啟歸零、trustProxy 繞 rate limit、PIN 洩漏入封包等）。

## 4. 未完成（要你拍板／要你嘅 dashboard 權限）

1. **Cloudflare Access（DoD §12.7 最後一項）**：Tunnel 已由用戶設定，Lead 已實測公網通（見 §2）。**未做 Access**，所以現時 `/host` 同 `/api/host/*` 只靠 PIN 把關。你要喺 Cloudflare dashboard 做：
   1. ~~Zero Trust → Tunnels → Public Hostname~~ ✅ 已完成：`partyhollye.our1tb.com` → `http://localhost:30005`
   2. Access → Applications：`/host` 同 `/api/host/*` 兩條 policy（email allowlist）
   3. server `.env`：`ACCESS_REQUIRED=1`、`PUBLIC_ORIGINS=https://hbd.<域名>,http://192.168.99.20:30005` → `docker compose up -d --force-recreate`
   4. 場外 4G＋場地 Wi-Fi 各驗一次（`/play` `/stage` 開得、`/host` 要 Access、`/api/host/*` 冇 token 401）
   （詳見 `platform/RUNBOOK.md §4.5` 上線 flip 清單）
2. **題目**：你話仲諗緊——而家 20 題附錄 A seed 已入，你決定後可以喺主持台「題庫」改，或換 `data/quiz.seed.json`。
3. 真機音響／影相 demo（M2④／M3②）、Tunnel 30 分鐘 WS 長連：要真機排練時做（`RUNBOOK.md §1` 有步驟）。
4. 未做自動化：真 browser 草稿 refresh e2e（已人手截圖基本流程）、真 ENOSPC（用 injection 代替）。

## 5. 重要位置

- 規格：`game-platform/PLAN-v3.1.md`（唯一權威，冇改過）
- 交付清單：`game-platform/platform/DELIVERY-MANIFEST.json`（61 檔＋sha256＋6 條規格澄清＋6 條已知限制）
- Runbook：`game-platform/platform/RUNBOOK.md`
- 測試證據：`game-platform/evidence/<M0..M5>/`
- Review／審計報告：`game-platform/check/`
- 部署：server `C:\Users\fmk-server\hbd\platform`（`docker compose up -d --build`；更新＝重新 sync＋up --build）
