# M5 SUMMARY — finale／頒獎／multi-host／export／runbook＋最終部署

- 日期：2026-11-16｜部署：`192.168.99.20:30005`（最新 build，healthy）｜最終 roomCode **3840**／roomId **room_bacf121ceae3be53**
- 證據：`test.log`（本機 11/11＋部署 11/11）、`deploy.log`（ps／重啟前後 phase award／30 players／ledger 31／awards／revision 70 一致）、`api.log`（ready／play／stage／host／scores／export／重啟後 scores）

## §10 M5 逐條

| # | 項目 | 結果 | 證據 |
|---|---|---|---|
| ① | 常駐分數條（可收起）＋全屏分數一鍵；finale 全屏分數＋統計 | **過** | ticker 收/放後 stage ticker 同步；leaderboard mode 30 人分數；finale stats 總分 465／median 15.5／30 人（本機） |
| ② | 頒獎三獎：大獎最高分、2獎最接近中位數、3獎最低分；逐個揭曉；手動改人 ≤1s | **過** | 分數 1..30：grand=30、second=16（dist 0.5 tie→分高）、third=1；3→2→大逐個 revealed；override manual=true 即時反映；reset 重算 |
| ③ | multi-host activity toast；破壞性操作只有一個成功 | **過** | 兩個 host 都見到 `+1（M5 toast …）`（hostName=M5Host1）；破壞性互斥 M0 ⑩ 已測 |
| ④ | PWA 只做「加到主畫面」meta（唔做 SW，D33） | **過** | `/play` 有 apple-mobile-web-app-capable＋manifest；manifest display=standalone；play.js 冇 serviceWorker |
| ⑤ | runbook 一頁（起機／PIN／房碼／QR／熱點後路／每關 checkpoint／最後防線）＋Cloudflare 上線 flip 清單 | **過** | `platform/RUNBOOK.md`（§1 開場、§2 checkpoint、§3 三種故障、§4.5 Cloudflare flip 清單、§5 維運） |
| ⑥ | `/api/host/export` CSV＋room.json；最終重新部署＋重啟持久化 | **過** | export 200（playersCsv 7 行／ledgerCsv 7 行）；restart 前後 phase/players/ledger/awards/revision 一致；最終持久房重啟後 scores 11/9/7/5/3/1、revision 12 |

## 最終持久房（auditor 用）
- `roomCode=3840`、`roomId=room_bacf121ceae3be53`、6 個玩家分數 11/9/7/5/3/1（total 36、median 6）
- 只讀：`GET /api/scores`、`GET /api/stage/snapshot`（`AUDIT_READONLY=1` 顯式開）；無 token host API 一律 401
- PIN 來源：server `C:\Users\<ssh-user>\hbd\platform\.env`（唔會 print；已輪換）
- 重啟驗分：`docker compose restart` 後 `/api/scores` 不變（`api.log`）

## 遺留（已寫入 DELIVERY-MANIFEST knownLimitations）
- Cloudflare Access 場外實測（外部依賴，dashboard 工序；RUNBOOK flip 清單）
- 真 browser e2e（media deck 音訊同步／refresh 草稿／stage、host refresh）
- 真 ENOSPC（用 FAULT_ENOSPC injection 代替）、規則頁編輯器進階 UI／autoAdvance 前端、Node patch 差異
