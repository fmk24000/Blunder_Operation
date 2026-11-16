# 遊戲平台文件索引（先睇呢份）

> 更新：2026-11-16｜用途：避免再次出現「兩套 Plan／兩套 Task Book」令實作跟錯版本
> 場次：《關於我初試策劃壽星黑歷史這檔事》主題生日派對（約 10 人、全粵語、香港）

## 1. 權威規格（唯一）

| 文件 | 狀態 |
|---|---|
| **`PLAN-v3.1.md`** | ✅ **正式規格，唯一權威**。派工、實作、驗收全部以佢為準（969 行，D1–D34；Docker 部署目標 `192.168.99.20:30005`） |

## 2. 現行工作文件

| 文件 | 內容 |
|---|---|
| `PLAN-v3-FINAL-CHECK.md` | 三模型 final check 裁決：9 P0／16 P1／8 P2／7 個要主持拍板嘅決策 |
| `check/plan-v3-glm-review.md` | GLM-5.3（z.ai）plan 深度審查原始報告 |
| `check/plan-v3-kimi-review.md` | kimi-k3.1-pro 獨立對抗式 review 原始報告 |
| `check/plan-v3-facts.md` | 事實／一致性核對 61 條（✅17／⚠️18／❌26） |
| `check/spec-rules-page.md` | 每關規則頁（大mon 開場顯示＋後台編輯）完整規格 |
| `check/plan-v31-qa.md` | PLAN-v3.1 第一輪 QA（kimi）：9 P0 核對＋F-01…F-20 |
| `check/plan-v31-qa2.md` | PLAN-v3.1 第二輪聚焦 QA（kimi）：F-01～F-06 覆核＋Q2-01…Q2-06 |
| `TASKS-print-pack-rebuild.md` | 列印包（最後防線）重 build 工作單 |

## 3. 歷史文件（唔准照做，只作追溯／diff）

| 文件 | 狀態 |
|---|---|
| `PLAN-v3.md` | 🕓 v3.1 之前嘅版本（585 行＋2 行歷史標頭＝587 行）——用嚟睇 v3.1 改咗乜 |
| `PLAN-v2.md`、`PLAN.md`、`TASKS.md` | 📜 更早期歷史（v1 五關＋撕名牌、v2 Rust／NAS 路線） |
| `SESSION記錄_PLAN-v3定案.md` | 🕓 2026-11-15 01:49 快照（寫「539 行／D1–D27／5 個 code block」——已過時） |
| `../game-platform-node-ts-session-summary.md` | 🕓 上一輪 Node/TS 方向總結。部分結論已被取代，例如：建議「唔用 Cloudflare Access」（v3.1 用 Access）、「統一 Node 24」（v3.1 pin Node 26 LTS）、「NAS snapshot failover」（已退役） |

## 4. 另案（唔准照做，只可以借條文）

| 文件 | 點解唔可以照做 |
|---|---|
| `PLAN-GPT.md`、`TASKS-GPT.md` | ⚠️ 用 **Socket.IO＋SQLite**；v3.1 用 **fastify＋@fastify/websocket＋JSONL journal**。可以借：一次性跨機恢復碼、`commandId` 去重、舊輪作廢重計、音源 lease、RTT 校時、runtime schema 嘅寫法 |

## 5. 派工前狀態（2026-11-16）

- `PLAN-v3.1.md` 已寫死 9 個 P0（見 `PLAN-v3-FINAL-CHECK.md` §2）。
- v3.1 已過 kimi QA 第一輪（`check/plan-v31-qa.md`：4/9 P0 通過＋20 條新發現）；之後已按 QA 修 F-01–F-20 出一輪（v3.1 現時 940 行）。
- 第二輪 QA 已做（`check/plan-v31-qa2.md`），Q2-01…Q2-06 已修；同時加入 Docker 部署目標（§9.9）。
- 下一步：派工實作（新 session：builder deepseek／checker glm／auditor kimi）→ 部署 `192.168.99.20:30005`。
- 兩個仍然要做嘅實物工序：① `TASKS-print-pack-rebuild.md`（列印包重 build）② Cloudflare Access 兩條 policy（`/host`、`/api/host/*`）＋固定 hostname＋Tunnel 實機設定。

## 6. 一條規則

> 任何新文件，如果同 `PLAN-v3.1.md` 有衝突，**一律以 v3.1 為準**；要改規格就改 v3.1（或出 v3.2），唔好另開一份「平行 plan」。
