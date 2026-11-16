# M2 SUMMARY — 估歌關＋media deck＋AudioLease

- 日期：2026-11-16（香港）｜部署：`192.168.99.20:30005`（已含 M2 build）
- 證據：`test.log`（本機 15/15＋部署機 15/15）、`deploy.log`（ps／重啟前後 songs／lease／playback／帳簿）、`api.log`（上傳、media、stage song 歌名披露）

## 1. 做咗乜（§10 M2）

### 歌單
- `song.upsert`：title 1–60 字；先入名（source=external → `state:"draft"` 未齊）、貼 YouTube／Apple／external link（`ready`）、MP3 上傳（source.kind=file，`ready`）
- `song.delete`；`media.play` 只接受 `source.kind="file"`（YouTube／Apple 只係手動提示，D32；回 `W_BAD_SCHEMA`）
- 上傳：`POST /api/host/upload`（multipart）——MP3／m4a magic bytes（ID3／frame sync／ftyp）、≤20MB；圖片 jpg／png／webp magic bytes、≤8MB；media quota 500MB；無語義隨機檔名；`/media/<id>.<ext>` serve。假 MP3（純文字）→ `W_UPLOAD_REJECTED`

### bid 卡（只 points 模式，D32）
- `card.create type=bid`（songId／maxBid 預設 100／seconds／points 預設 5）；`card.open` → stage `bid` mode、手機數字鍵盤
- 出價驗證：整數、`0 ≤ amount ≤ maxBid`，超額拒絕
- 結算 `bid.settle`（§5.1 唯一定義）：最高價得標、**同價先交者贏**（server 收到時間）；答對 +points，答錯 0；可選「次高價補答」＝一半分（無條件進位）；出價唔扣分
- stage 競投走勢：bids 柱狀圖＋人數；close 後出最高價者名；**reveal 前唔會出歌名**

### media deck＋AudioLease（§6／§8.2）
- `lease.acquire`：`{deckId, hostId, generation, leaseUntil}`；同一 deck 續期、不同 deck 接管 → `generation+1`；接管時舊 deck 播放由 server 標 `paused`
- `lease.heartbeat`（generation 對唔上 → `W_NO_AUDIO_LEASE`）；`lease.release`
- `tickLeases`：lease 到期自動釋放；舊 deck 若仲 `playing` → server 標 `paused`（配合 deck 前端自行停播＝防雙響硬保證）
- `media.play`：要先 preload＋用戶解鎖＋**deck.ready ACK**，server 才落 `playStartedAt`（state preparing→playing）；`media.pause`／`resume`／`stop`／`reveal`
- `media.reveal`：揭曉歌名並切 stage `reveal`（`payload.songTitle`）；**reveal 之前 stage 任何 mode 都唔出歌名**（stage song mode title=null）
- 大mon song mode 預設靜音（只顯示第 N 首／進度）；media deck 在 host 頁 `<audio>` 本地出聲；autoplay 被擋顯示「恢復播放」掣

### host 台
- 歌單 tab：上傳 MP3／貼 link／加歌、歌態、播 15 秒／由頭播、pause／resume／stop、揭曉歌名、申請／接管音源、lease／playback 狀態、autoplay 解鎖
- 拍賣卡建立＋結算按鈕（答對／答錯／次高補答）

## 2. §10 M2 驗收（本機 15/15、部署 15/15）

| # | 項目 | 結果 | 證據 |
|---|---|---|---|
| ① | 30 bots 出價次序＋同價 tie-break；maxBid 驗證 | **過** | 30 筆出價全部 accepted；最高 90 有兩個（先交者 wins，settle winner=首位 90 提交者）；120 > maxBid → `W_BAD_SCHEMA` |
| ② | 結算逐筆對帳：得標者 +points、其餘冇變 | **過** | winner +5（reason「估歌 S…」）；再測試答錯＋次高補答 → 次高 +3（ceil 5/2），只有一人分數變 |
| ③ | 倒數各機誤差 ≤0.5s（注入延遲） | **過**（沿用 M0 ⑥ 真測） | `evidence/M0/clock-skew.log`：200ms 單向延遲下兩機倒數極差 101ms |
| ④ | media deck 播 MP3 同 stage 同步 ≤0.5s、大mon 靜音、reveal 前冇歌名 | **部分（server／協議過，真 browser 音訊未自動化）** | deck.ready 後 15ms 轉 playing、playStartedAt 落 server 時鐘、stage song title=null；`media.reveal` 後 stage reveal 出歌名。真 browser 音訊同步（Mac deck）未用 browser e2e 量，列遺留 |
| ⑤ | 同時只一部機出聲：非 lease play 被拒、在線接管、離線接管、舊機唔准復播 | **過** | 非 lease → `W_NO_AUDIO_LEASE`；接管 gen 1→2、舊 deck pause 被拒；lease 到期自動釋放（3.2s tick）後新 deck 接管；舊 generation play → `W_NO_AUDIO_LEASE` |
| ⑥ | autoplay 被擋顯示「等音源 ready」 | **部分** | 協議有 preparing 狀態＋前端「恢復播放」掣＋deck 自行 pause；真 browser autoplay 攔截未自動化 |
| ⑦ | Tunnel 下 WS 30 分鐘最多斷 1 次 5 秒恢復 | **未做（要真 Tunnel／30 分鐘）** | 冇公開 hostname（D31/dashboard）；LAN 內重連測試已過（M0 ⑦／⑪）。列遺留 |
| ⑧ | 同步承諾只限 file | **過** | YouTube song `media.play` → `W_BAD_SCHEMA`；stage 只顯示手動提示 |

## 3. 遺留

1. 真 browser media deck 音訊同步（Mac／iPad 實機）未自動化；server 端 playStartedAt／positionMs／lease 機制已實測。建議排練前 Mac 播一次＋大mon 睇時間差（runbook 已列）。
2. Tunnel 長連測試冇條件做（冇公開 hostname）。
3. YouTube／Apple 只做純提示（D32 已寫死），唔會自動控制播放。

## 4. M2 pre-review P0／規格拍板（2026-11-16 追加；已清）

| 項目 | 修正 | 證據（test-m2-local／deployed 20/20） |
|---|---|---|
| **P0-1 防重複結算** | `bid.settle` 每次先 void 同一 round 舊 host 結算分（`voidedPrevious` 回報）再派新；答對／次高補答／答錯 0 都不會雙派 | 「P0-1 防重複結算」voidedPrevious=1、aliveEvents=1、winner 由 0→5（唔會 10） |
| **P0-2 deck 自我停播精準** | host deck 改精準 `setTimeout(leaseUntil − serverNow)`（唔再用 10s interval）；到期即 pause 並顯示狀態；heartbeat 另用 10s interval | 程式改動＋`scheduleLeasePause()`；m2 在線接管測試 old deck 1ms 內 paused |
| **P0-3 接管 margin** | `lease.acquire`：舊 lease 未到期 → 要 `forceOnline:true`（在線接管，舊 deck 收到 patch 即停，實測 1ms）；失聯接管要等 `releasedAt + 5s` margin（否則 `W_NO_AUDIO_LEASE`＋剩餘秒數） | 「在線接管」gen 1→2、oldStopped=1ms；「失聯接管」到期後即刻拒、margin 1.5s 後成功 |
| **規格澄清 1（lead 拍板）** | 密封出價：StageView **永不送**個別出價金額（`bids`／`topBids` 移除）；bidding 階段只出 bidCount／eligibleCount＋倒數；settle 後只出得標者＋金額（winnerName／winnerAmount）。已寫入 `DELIVERY-MANIFEST.json` specClarifications | 「密封出價」bids 唔存在、bidCount=30/30；settle 後 winner=M2Bot01/90、仍冇其他金額 |
| **規格澄清 2（lead 拍板）** | 「播 15 秒」真承諾：server tick（≤250ms）按 window 自動 pause，deck client 亦用 server 時鐘自行停 | 「window 到期 server 自動 pause」1044ms 內 paused、positionMs=800 |
| P1 `media.play` 防覆寫 | preparing／playing 時再 play → `W_ALREADY_STATE` | 已測 |
| P1 `W_AUDIO_READY_TIMEOUT` | playback `readyDeadline`（env `AUDIO_READY_TIMEOUT_MS`，預設 15s）；deck 唔 ready → `state:"failed"`＋stage 提示 | deployed failed in 15325ms、本機 1608ms |
| P1 `deck.ready` 驗 hostId | deck.ready 要 lease.hostId 吻合先接受 | 程式＋WS 測試 |
| P1 歌名 sniffer 擴展 | reveal 前 song mode／任何 mode／`/api/stage/snapshot` 都冇歌名 | 「reveal 前任何 mode 都唔出歌名」 |
| P1 真 browser 音訊同步／Tunnel 30 分鐘 | 外部依賴／真機，未自動化 | 已列遺留（lead 用真 browser e2e 覆核） |

## 5. M2-M4 review 後 P1（2026-11-16 最終一輪；已清）

- **forceOnline 驗在線**：`lease.acquire forceOnline` 前用 `hub.isHostOnline(hostId, 15s freshness)` 驗舊 host connection；舊 deck 斷網時一律拒（`W_NO_AUDIO_LEASE`），強制走 `releasedAt+5s` margin。Test：M2 22/22（新增「舊 deck 唔在線 → forceOnline 拒絕」＋「bid round open 時 media.play → W_WRONG_PHASE、stage 保持 bid」）。
- **規格澄清（manifest 已加）**：在線接管簡化為即時 pause（<100ms）＋generation+1，無等 2s ACK（較規格安全）；搗蛋鬼版本 A 冇 saboteurAnswer（vote 卡冇 referenceAnswer）。
- 本機 M2 22/22（原 20 項＋2 新）；deploy 後最終房 room 3840 未被測試污染，restart 前後 scores [11,9,7,5,3,1]／revision 12 不變（見 M5/deploy.log）。
