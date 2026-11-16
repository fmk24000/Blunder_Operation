/** data/ 係 canonical seed；Docker build context 用 seed/（因為 volume ./data 會蓋住 image 內 /app/data） */
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
fs.mkdirSync(path.join(root, "seed"), { recursive: true });
for (const name of ["quiz.seed.json", "rulepages.seed.json"]) {
  const src = path.join(root, "data", name);
  const dst = path.join(root, "seed", name);
  fs.copyFileSync(src, dst);
  console.log(`[seed] ${path.relative(root, src)} → ${path.relative(root, dst)}`);
}
