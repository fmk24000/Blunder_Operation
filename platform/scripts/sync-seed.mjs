/**
 * seed/ 係 repo 內 canonical seed（committed，乾淨 clone 一定有）；
 * data/ 係 runtime 目錄（gitignored，Docker volume 會蓋住 image 內 /app/data）。
 *
 * 規則：
 *  - data/<name> 存在（本機跑過／有 runtime 資料）→ data/ 為準，覆蓋 seed/
 *  - data/<name> 唔存在（乾淨 clone、CI）→ 保留 seed/ 原檔，唔准丟錯
 */
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
fs.mkdirSync(path.join(root, "seed"), { recursive: true });
let copied = 0;
for (const name of ["quiz.seed.json", "rulepages.seed.json"]) {
  const src = path.join(root, "data", name);
  const dst = path.join(root, "seed", name);
  if (!fs.existsSync(src)) {
    const fallback = fs.existsSync(dst) ? "沿用 seed/ 原檔" : "⚠️ seed/ 都冇，之後讀 seed 會失敗";
    console.log(`[seed] data/${name} 唔存在 → ${fallback}`);
    continue;
  }
  fs.copyFileSync(src, dst);
  copied += 1;
  console.log(`[seed] ${path.relative(root, src)} → ${path.relative(root, dst)}`);
}
if (copied === 0) console.log("[seed] 冇 data/ 覆蓋，用 repo 內 seed/（正常：乾淨 clone／CI）");
