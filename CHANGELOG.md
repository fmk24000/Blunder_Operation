# Changelog

## v0.1.1 — 2026-11-16

首個公開版本（派對遊戲平台）。

### Added
- 三端：大mon `/stage`（唯讀 kiosk）、主持台 `/host`（PIN login，可多開）、手機 `/play`（QR 入場）。
- 四關遊戲：拍賣估歌（密封出價＋media deck＋AudioLease）、畫畫猜人、搗蛋鬼（版本 A）、常識問答。
- 每關規則頁：大mon 入關自動顯示、後台可編輯（`W_RULES_LIMIT`／`W_RULES_CONFLICT`）。
- 計分事件帳簿＋undo（void，不刪紀錄）＋換組＋頒獎三獎＋`/api/host/export`（CSV＋room.json）。
- JSONL journal（manifest＋segment＋sha256＋fsync＋壞尾行 truncate＋replay），重啟／kill -9 分數不失。
- WS 自動重連＋resync、clock offset（RTT）、commandId 冪等、reconnect race、5 種連線名額。
- Docker multi-stage（node:26-alpine）＋ docker compose（30005:3000、volume、healthcheck）。
- 30 bots 驗收腳本（M0–M5）＋ fault injection／clock skew 測試。
- shadcn／iOS 風 UI；大mon 超過 2 條連線時自動踢走最舊（新連線優先，舊機收 4010 並提示）。

### Security
- PIN 必須由環境變數提供（缺／default 拒啟動），支援 6–12 位數字。
- 全站 CSP、host-only API 全部收入 `/api/host/*`、rate limit、Origin 檢查。
- 本 repo 不含任何真實 PIN／密碼／憑證。
