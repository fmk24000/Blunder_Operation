/** 交付 manifest：列出 code／config／seed／public 檔案＋sha256（review 封包漏檔時可對照） */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const includeDirs = ["src", "public", "data", "seed", "scripts", "bots", "test"];
const includeFiles = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.client.json",
  "Dockerfile",
  "docker-compose.yml",
  ".dockerignore",
  ".env.example",
  ".nvmrc",
  "RUNBOOK.md",
  "README.md",
];
function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === "dist" || ent.name === ".cache" || ent.name === ".npm-cache") continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else out.push(full);
  }
}
const files = [];
for (const d of includeDirs) {
  const full = path.join(root, d);
  if (fs.existsSync(full)) walk(full, files);
}
for (const f of includeFiles) {
  const full = path.join(root, f);
  if (fs.existsSync(full)) files.push(full);
}
const manifest = {
  app: "hbd-game-platform",
  generatedAt: new Date().toISOString(),
  node: process.version,
  engines: ">=26 <27",
  note: "Docker runtime: node:26-alpine（實際容器 v26.13.1；本機 v26.8.1，同屬 Node 26 LTS major）",
  knownLimitations: [
    "⑧ Cloudflare Access 場外實測：外部依賴（Tunnel hostname＋兩條 Access policy 要用戶 dashboard 做），程式已支援 ACCESS_REQUIRED=1／Cf-Access-Jwt-Assertion；RUNBOOK 有上線 flip 清單。",
    "真 browser e2e（media deck 音訊同步／refresh 草稿／stage／host refresh）未自動化：server 協議與時序已測，需排練時真機手動一次。",
    "真 ENOSPC 測試：沙盒冇細 volume／mount 權限，用 env-gated FAULT_ENOSPC 注入驗 error path（production 拒啟動 FAULT_*）。",
    "規則頁編輯器仍 raw JSON blocks（8 種 block 專屬 UI／本地 1920×1080 預覽／beforeunload 未做）；server 限制／衝突／權限已齊。",
    "stage autoAdvanceSeconds 自動翻頁前端未實作（四關預設 0＝手動；server payload 有值）。",
    "Node patch：本機 v26.8.1、容器 v26.13.1（同 major，engines >=26 <27）。",
  ],
  specClarifications: [
    "§5.1 密封出價：bidding 階段 stage 唔會收到／顯示任何個別出價金額（StageView 只有 bidCount／eligibleCount）；bid.settle 之後先顯示得標者＋金額。",
    "§3 競投走勢＝參與度（已出價人數／總人數），唔係逐筆金額走勢。",
    "§8.2 播 15 秒＝真承諾：window 到期由 server tick（≤250ms）自動 pause，deck client 亦用 server 時鐘自行停。",
    "§8.2 在線接管簡化（2026-11-16 lead 拍板）：實作即時 pause 舊 deck（<100ms）＋generation+1，冇等 2 秒 ACK；另 forceOnline 必須驗舊 host connection 在線（15s freshness），否則一律走失聯 margin。較規格更安全、唔會雙響。",
    "§4 搗蛋鬼版本 A 冇『正解』可送：vote 卡冇 referenceAnswer，PlayerSelfView.roleInfo.saboteurAnswer 永遠 undefined（版本 A 唔適用；日後加解謎版才補）。",
    "以上均為 2026-11-16 lead 拍板之規格澄清，M2-M4 review 以此為準；PLAN-v3.1 原文不變。",
  ],
  files: files
    .sort()
    .map((f) => ({ path: path.relative(root, f).replace(/\\/g, "/"), bytes: fs.statSync(f).size, sha256: crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex") })),
};
fs.writeFileSync(path.join(root, "DELIVERY-MANIFEST.json"), JSON.stringify(manifest, null, 2));
console.log(`[manifest] ${manifest.files.length} files → DELIVERY-MANIFEST.json`);
