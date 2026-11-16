# hbd-game-platform（2026 HBD《奔跑吧》派對遊戲平台）

PLAN v3.1 實作：一個 Node 26 process，服務三端（`/stage` 大mon、`/host` 主持台、`/play` 手機）。

## 本機跑

```bash
npm run build        # sync-seed → tsc（server+client）→ DELIVERY-MANIFEST.json
PIN=123456 NODE_ENV=development PORT=3000 npm start
# http://127.0.0.1:3000/stage ／ /host ／ /play ／ /api/ready
```

## 測試

```bash
npm test             # node:test（journal／計分／頒獎／Q14 時間題）
BASE=http://127.0.0.1:3000 PIN=123456 node bots/bots.mjs   # M0：30 bots＋2 host＋1 stage＋caps
BASE=http://127.0.0.1:3000 PIN=123456 node bots/m1.mjs     # M1：問答關＋規則頁（需乾淨房）
BASE=http://127.0.0.1:3000 PIN=123456 node bots/m2.mjs     # M2：估歌＋media deck
BASE=http://127.0.0.1:3000 PIN=123456 node bots/m3.mjs     # M3：畫畫
BASE=http://127.0.0.1:3000 PIN=123456 node bots/m4.mjs     # M4：搗蛋鬼
BASE=http://127.0.0.1:3000 PIN=123456 node bots/skew.mjs   # 時鐘 ±3s skew＋200ms 單向延遲
BASE=http://127.0.0.1:3000 PIN=123456 node bots/fault.mjs  # fault-injection（FAULT_POINT hook）
```

## 部署

見 `RUNBOOK.md`。Docker compose：host 30005 → 容器 3000，`./data`／`./media` volume，healthcheck `/api/ready`。

## 非 §7 表嘅公開只讀 endpoint（auditor 用）

`/api/qr`（大mon QR）、`/api/scores`（分數＋roomId）、`/api/stage/snapshot`（StageView，零秘密）。
`AUDIT_READONLY=0` 可以關 `/api/scores` 同 `/api/stage/snapshot`（正式場如要收埋）。

## 節點版本

`engines: >=26 <27`；本機 v26.8.1、Docker runtime v26.13.1（同 major，見 DELIVERY-MANIFEST.json）。
