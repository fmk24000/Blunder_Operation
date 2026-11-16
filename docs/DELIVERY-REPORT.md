# 交付報告 — 《關於我初試策劃壽星黑歷史這檔事》派對遊戲平台

> 日期：2026-11-16｜部署：Windows server `192.168.99.20` Docker，host port **30005** → 容器 3000

## 1. 而家可以點用

| 入口 | 網址 | 說明 |
|---|---|---|
| 大mon | `http://192.168.99.20:30005/stage` | Chrome kiosk，1920×1080，唯讀 |
| 主持台 | `http://192.168.99.20:30005/host` | **PIN：<PIN>**（8 位；可喺 server `.env` 改，支援 6–12 位數字） |
| 手機 | `http://192.168.99.20:30005/play?code=3840` | 掃大mon QR 或直接用房碼 **3840** |

- 房碼：**3840**（`/api/ready` 可查）；目前房間已清空（0 玩家），20 題附錄 A seed 已載入。
- 主持台分頁：**玩家／分組／分數／題庫／規則頁／歌單／狀態**。
  - **改問題（題目）** → `/host` →「題庫」：加／改／刪／排序、openKind、參考答案、分類；「一鍵匯入舊 QUIZ」只匯 MC 10 題唔會蓋 open 題；改完即時生效。
  - **入歌** → `/host` →「歌單」：先入歌名，再上傳 MP3（≤20MB）或補 YouTube／Apple link（只做手動提示，唔保證同步）；media deck 用一部 host 機駁喇叭申請/接管音源。
  - **每關規則頁** → `/host` →「規則頁」：四關預設文字（附錄 B），大mon 入關自動顯示。
- 題庫大量換：`server C:\Users\<ssh-user>\hbd\platform\data\quiz.seed.json`（純資料；只影響新房間）。

## 1.1 UI 風格（2026-11-16 晚更新）

- 全站改成 **shadcn / iOS 風**：米白底 `#f6f5f1`、白色圓角卡、hairline 邊、青檸 accent `#c9f26e`、黑色 primary CTA、iOS SF 字體 stack（-apple-system／SF Pro／PingFang HK）。
- 大mon：白色房碼卡＋QR 卡、lime 高亮標題、規則頁 lime 標題條。
- 主持台：白色 sticky bar、segmented tabbar、lime 選中狀態。
- 手機：白色卡、lime 選中頭像、黑色「入場」。
- 修好兩個實際問題：① CSP 原本封鎖 inline style（令頭像顏色／顏色選擇器失效）→ `style-src` 加 `'unsafe-inline'`（script 仍然嚴格 `'self'`）② 靜態檔加 `Cache-Control: no-cache`＋`?v=` 版號，更新部署後前端即刻見到新樣式。

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
- 交付清單：`game-platform/platform/DELIVERY-MANIFEST.json`（59 檔＋sha256＋6 條規格澄清＋6 條已知限制）
- Runbook：`game-platform/platform/RUNBOOK.md`
- 測試證據：`game-platform/evidence/<M0..M5>/`
- Review／審計報告：`game-platform/check/`
- 部署：server `C:\Users\<ssh-user>\hbd\platform`（`docker compose up -d --build`；更新＝重新 sync＋up --build）
