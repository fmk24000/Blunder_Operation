# M3 SUMMARY — 畫畫關（上載／作品牆／放大／評審／vote 最似）

- 日期：2026-11-16｜部署：`192.168.99.20:30005`（最新 build）
- 證據：`test.log`（本機 10/10＋部署機 10/10）、`deploy.log`（重啟前後 30 張作品／畫畫帳簿 16 筆／revision 113 一致）、`api.log`（作品媒體 serve、stage 投影、帳簿摘要）

## 做咗乜（§10 M3）
- 上載：`POST /api/host/upload`（multipart）圖片 jpg／png／webp magic bytes、≤8MB、quota 500MB、無語義隨機檔名、`/media/<id>.<ext>` serve；偽裝檔／超大檔 → `W_UPLOAD_REJECTED`
- 作品牆（stage draw-wall）＋放大（draw-focus）；投票卡 `voteMode:"works"`（card.options＝作品 asset ids）；手機投「邊張最似」（一人一票、可以投自己）
- 評審：`draw.judge` 主持 +1／+2／0（0＝void 上一筆，歷史保留）；`commandId` 去重（重複撳唔會重複加）
- 計分 §5.2（唯一定義，reveal 之後一次過入帳）：人氣票每票作者 +1、最高票作品作者額外 +2（並列都算）、主持評審另加；全部綁 roundId／submissionId

## 驗收（本機 10/10、部署 10/10）
| # | 項目 | 結果 | 證據 |
|---|---|---|---|
| ① | 30 bots 並發上載 30 張 ≤1MB 圖，15 秒內全部上牆 | **過** | uploads=30/30、上牆 2ms（本機）／部署同樣 10/10 |
| ② | 作品牆／放大／投票進度；開放投票期間唔出票數 | **過** | works=30、countsZero=true、draw-focus↔draw-wall 切換 |
| ③ | 計分逐筆對：人氣票 ×1＋最高票 +2 | **過** | 人氣票總和 30、作者0=10／作者1=8、最似獎 1 筆 +2 落最高票作者 |
| ④ | 主持 +1／+2＝該作品作者得分、commandId 去重、0＝void | **過** | 同 commandId 撳兩次只有 1 筆；按 0 後 alive=0＋voided 紀錄仍在 |
| ⑤ | 上載 magic bytes／size／quota，偽裝檔 `W_UPLOAD_REJECTED` | **過** | 假 jpg／9MB 圖 → 415 `W_UPLOAD_REJECTED` |

## 遺留
- 真機「主持連續影相上牆 10 張」屬人手操作（runbook 已列），未自動化。
- 作品牆幾何（30 張 1920×1080 排版）留 M5 幾何驗收；M3 只驗功能。
