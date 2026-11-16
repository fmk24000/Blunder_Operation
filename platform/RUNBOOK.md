# RUNBOOK — 2026 HBD《奔跑吧》派對遊戲平台

> 一頁搞掂：起機、PIN、房碼、開場 QR、手機熱點後路、每關 checkpoint、最後防線。
> 規格：`game-platform/PLAN-v3.1.md`（唯一權威）。部署：Windows server `192.168.99.20`，Docker compose，host port **30005 → 容器 3000**。

## 1. 開場前（T-60 分鐘）

| # | 做咩 | 指令／位置 |
|---|---|---|
| 1 | server 起機 | SSH 上 server：`cd C:\Users\<ssh-user>\hbd\platform && docker compose up -d` |
| 2 | 驗 ready | `curl http://127.0.0.1:30005/api/ready` → 200＋`ready:true` |
| 3 | 睇房碼／PIN | `curl http://127.0.0.1:30005/api/ready` 有 `roomCode`；PIN 喺 server `platform/.env`（`PIN=`；預設 **<PIN>**，支援 6–12 位數字） |
| 4 | 大mon | Chrome `--kiosk http://192.168.99.20:30005/stage`（1920×1080，永不睡眠） |
| 5 | 主持台 | `/host`，輸入 PIN；Mac 一部做 media deck（駁喇叭），iPad 一部控制 |
| 6 | 手機試連 | 全部人掃大mon QR（`/play?code=XXXX`）→ 入名＋頭像 → 主持 approve |
| 7 | 音源試播 | 歌單 tab → 揀歌 →「申請／接管音源」→ 播放一次，確認大mon 靜音、喇叭有聲 |
| 8 | 備份 | `/host` → 狀態 →「寫入 server data/export」；USB 抄走 `platform/data/export/` |

## 2. 每關 checkpoint（每關完結即撳 export，抄一張紙）

| 關 | 大mon 出咩 | 完成定義 | 紙本 checkpoint |
|---|---|---|---|
| 1 拍賣估歌 | 競投走勢＋倒數→揭曉歌名 | 每首歌結算完成、分數對帳 | 抄低每首歌得標者同得分 |
| 2 畫畫猜人 | 作品牆→投票→評審 | 所有作品投完票、主持評審完 | 抄低每張作品作者同票數 |
| 3 搗蛋鬼 | 身份頁→兩輪投票→身份揭曉 | 揪中／兩輪完，+3／+5 已入帳 | 抄低每輪票數同淘汰者 |
| 4 問答 | 題目→分佈→揭曉 | 20 題完（MC 10＋open 10） | 抄低每人累計分（帳簿 export） |

## 3. 故障處理（三種分清楚）

1. **場地 Wi-Fi／WAN 死**（server 正常）：主持機開手機熱點，所有手機＋大mon 轉連熱點；Tunnel 由屋企出，唔受影響。
2. **屋企 WAN／Cloudflare Tunnel 死**：對外全斷，冇 remote 後路 → 即刻切**列印包＋主持手動計分**（每關 checkpoint 已有）。
3. **屋企 server 死**：同上，列印包＋手動計分。server 返生後 `docker compose up -d`，journal 自動 replay 返最後狀態。

## 4. 最後防線

- 列印包（題目／規則／分數紙）喺會場；主持手動計分表用紙筆。
- 手機／大mon 全部斷都照玩得：主持讀題、紙筆計分、完場人手計三獎（最高分／最接近中位數／最低分）。
- 唔好喺遊戲中途 `docker compose down`（會斷線 5–20 秒；`restart: unless-stopped` 會自動起返，client 會自動重連）。

## 4.5 上線 flip 清單（Cloudflare）

**已完成（2026-11-16）**：Tunnel Public Hostname `partyhollye.our1tb.com` → `http://localhost:30005`；公網實測 `/api/ready` 200、`/play` `/stage` `/host` 200、WS 101、`/api/host/snapshot` 401；`PUBLIC_ORIGINS` 已包含 `https://partyhollye.our1tb.com`。

**仲要做（Access）**：
1. ✅ Tunnel Public Hostname（已完成）。
2. Access → Applications：加 `/host` 同 `/api/host/*` 兩條 policy（email allowlist；每部 host 機一次 setup）。
3. server `platform/.env`：`ACCESS_REQUIRED=1`；確認 `PUBLIC_ORIGINS` 有 `https://partyhollye.our1tb.com,http://192.168.99.20:30005`。
4. `docker compose up -d --force-recreate`（env 變更）；`curl http://127.0.0.1:30005/api/ready`＝200。
5. 場外 4G 實測：`/play` `/stage` 開得；`/api/host/snapshot` 冇 token → 401／Access 擋；`/host` 要 email OTP。
6. 開場前所有 host 機預先 login 一次，確認 Access session 有效。

> 未做第 2 步 = `/host` 同 `/api/host/*` 只靠 PIN（PIN 已經係 `<PIN>`）。

### 4.6 連線名額（W_ROOM_FULL）

spec §9.6：**stage 2 條、host 5 條、player 30 approved／pending 10、總 socket 60**。
多人測試時如果開多過 2 個大mon tab，第 3 個會收 `W_ROOM_FULL`（連線名額已滿）——關閉多餘 tab 就會自動重連（client 4003 會 backoff 重試，唔使 refresh）。

## 5. 常用維運

```bash
# server 上
cd C:\Users\<ssh-user>\hbd\platform
docker compose ps
docker compose logs -f --tail 100
docker compose restart platform          # 分數仍在（volume ./data）
docker compose up -d --build             # 更新
curl http://127.0.0.1:30005/api/ready
curl http://127.0.0.1:30005/api/scores   # 只讀分數（auditor 用）
```

- journal：`platform/data/journal/room-<id>/`（manifest＋segment，checksum＋fsync）。
- 匯出：`GET /api/host/export?format=csv`／`?format=room`（要 host token），或 `/host` 狀態 tab 一鍵下載。
- token TTL 8 小時；主持台 token 過期會自動要求 PIN 重 login（Access cookie 通常仍有效）。
- 公開只讀 endpoint（非 §7 表，auditor／runbook 用）：`/api/qr`（QR）、`/api/scores`（分數）、`/api/stage/snapshot`（StageView）；後兩者 `AUDIT_READONLY=0` 可關。
- Node：engines `>=26 <27`；本機 v26.8.1、容器 v26.13.1（同 major）。交付檔案清單＋sha256：`platform/DELIVERY-MANIFEST.json`。
- 持久測試房（auditor，2026-11-16 最終 seed）：**roomCode 3840／roomId room_bacf121ceae3be53**，6 玩家分數 11/9/7/5/3/1；PIN 喺 server `.env`；只讀攞分 `GET /api/scores`（AUDIT_READONLY=1 顯式開）、`GET /api/stage/snapshot`；重啟後分數仍在（見 `evidence/M5/api.log`）。
