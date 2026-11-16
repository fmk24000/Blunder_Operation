/**
 * JSONL journal：manifest＋segment＋checksum＋fsync（PLAN-v3.1 §9.1.1）
 *
 * 每行格式：`<json payload>|<sha256(payload)>\n`
 *   payload = {v:1, seq, ts, type:"tx", data:{records:[{t,d}], receipt?}}
 * - append → write → fsync → 之後才 ACK／broadcast
 * - 啟動時 checksum 對唔上嘅尾行 truncate 到上一個完整 record（log warn）
 * - segment 超過 8MB 自動轉卷，manifest 記 activeSegment
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CommandReceipt } from "../shared/types.js";

export type Mutation = { t: string; d: Record<string, unknown> };
export type JournalEnvelope = {
  v: 1;
  seq: number;
  ts: number;
  type: "tx";
  data: { records: Mutation[]; receipt?: CommandReceipt; bumpRevision?: boolean };
};

const SEGMENT_MAX_BYTES = 8 * 1024 * 1024;

export type Manifest = {
  schemaVersion: 1;
  roomId: string;
  activeSegment: number;
  nextSeq: number;
  createdAt: number;
  updatedAt: number;
  app: string;
};

export type LoadResult = {
  envelopes: JournalEnvelope[];
  nextSeq: number;
  truncated: number;
  segments: number[];
};

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export class Journal {
  readonly dir: string;
  private manifest: Manifest;
  private fd: number | null = null;
  private segment = 1;
  private seq: number;
  private closed = false;

  constructor(dir: string, roomId: string) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    const manifestPath = path.join(dir, "manifest.json");
    let manifest: Manifest | null = null;
    if (fs.existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
      } catch {
        console.warn("[journal] manifest.json 壞咗，重建");
      }
    }
    const now = Date.now();
    this.manifest = manifest ?? {
      schemaVersion: 1,
      roomId,
      activeSegment: 1,
      nextSeq: 0,
      createdAt: now,
      updatedAt: now,
      app: "hbd-game-platform",
    };
    this.segment = this.manifest.activeSegment;
    this.seq = this.manifest.nextSeq;
    this.writeManifest();
  }

  get activeSegment(): number {
    return this.segment;
  }
  get nextSeq(): number {
    return this.seq;
  }

  private segmentPath(seg: number): string {
    return path.join(this.dir, `segment-${String(seg).padStart(4, "0")}.jsonl`);
  }

  private writeManifest(): void {
    this.manifest.activeSegment = this.segment;
    this.manifest.nextSeq = this.seq;
    this.manifest.updatedAt = Date.now();
    const tmp = path.join(this.dir, "manifest.json.tmp");
    const target = path.join(this.dir, "manifest.json");
    fs.writeFileSync(tmp, JSON.stringify(this.manifest, null, 2));
    fs.renameSync(tmp, target);
    // fsync manifest 檔
    try {
      const fd = fs.openSync(target, "r");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }

  load(): LoadResult {
    const segments: number[] = [];
    for (let seg = 1; seg <= this.segment; seg++) {
      if (fs.existsSync(this.segmentPath(seg))) segments.push(seg);
    }
    if (segments.length === 0) segments.push(this.segment);
    const envelopes: JournalEnvelope[] = [];
    let truncated = 0;
    let lastSeq = 0;

    for (const seg of segments) {
      const file = this.segmentPath(seg);
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, "");
        continue;
      }
      const raw = fs.readFileSync(file, "utf8");
      const lines = raw.split("\n");
      // split 之後最後一個元素係 "" 或殘尾
      const outLines: string[] = [];
      let bad = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (line === "") continue;
        const isLast = i === lines.length - 1 || (i === lines.length - 2 && lines[lines.length - 1] === "");
        const parsed = this.parseLine(line);
        if (!parsed) {
          bad = true;
          truncated++;
          console.warn(`[journal] segment ${seg} 第 ${i + 1} 行 checksum／JSON 壞 → truncate 之後全部（尾行黨）`);
          break;
        }
        if (parsed.seq <= lastSeq) {
          bad = true;
          truncated++;
          console.warn(`[journal] segment ${seg} 第 ${i + 1} 行 seq ${parsed.seq} <= ${lastSeq} → truncate`);
          break;
        }
        lastSeq = parsed.seq;
        outLines.push(line);
        envelopes.push(parsed);
        if (isLast) break;
      }
      if (bad || outLines.length !== lines.filter((l) => l !== "").length) {
        // 重寫成乾淨內容（truncate）
        const clean = outLines.length ? outLines.join("\n") + "\n" : "";
        fs.writeFileSync(file, clean);
        truncated++; // 至少記錄一次截斷事件（尾行）
      }
    }
    this.seq = Math.max(lastSeq + 1, this.seq);
    if (!fs.existsSync(this.segmentPath(this.segment))) fs.writeFileSync(this.segmentPath(this.segment), "");
    this.writeManifest();
    return { envelopes, nextSeq: this.seq, truncated, segments };
  }

  private parseLine(line: string): JournalEnvelope | null {
    const idx = line.lastIndexOf("|");
    if (idx <= 0) return null;
    const payload = line.slice(0, idx);
    const checksum = line.slice(idx + 1);
    if (sha256(payload) !== checksum) return null;
    try {
      const env = JSON.parse(payload) as JournalEnvelope;
      if (env.v !== 1 || env.type !== "tx" || typeof env.seq !== "number") return null;
      if (!Array.isArray(env.data?.records)) return null;
      return env;
    } catch {
      return null;
    }
  }

  private ensureFd(): void {
    if (this.closed) throw new Error("journal closed");
    if (this.fd !== null) return;
    this.fd = fs.openSync(this.segmentPath(this.segment), "a");
  }

  /** write + fsync 一筆 transaction，回傳 journal seq（測試用 fault hook 由 env 控制，production 預設關） */
  append(records: Mutation[], receipt?: CommandReceipt, faultPoint?: string, bumpRevision?: boolean): number {
    if (records.length === 0) throw new Error("empty tx");

    const env: JournalEnvelope = {
      v: 1,
      seq: this.seq,
      ts: Date.now(),
      type: "tx",
      data: receipt ? { records, receipt, ...(bumpRevision ? { bumpRevision: true } : {}) } : { records, ...(bumpRevision ? { bumpRevision: true } : {}) },
    };
    const payload = JSON.stringify(env);
    const line = `${payload}|${sha256(payload)}\n`;
    const buf = Buffer.from(line, "utf8");
    this.ensureFd();
    const fd = this.fd as number;
    fs.writeSync(fd, buf);
    if (faultPoint === "after-write-before-fsync" && (globalThis as { __hbdReady?: boolean }).__hbdReady) {
      process.kill(process.pid, "SIGKILL");
    }
    fs.fsyncSync(fd);
    this.seq += 1;
    // 轉卷
    try {
      const size = fs.fstatSync(fd).size;
      if (size >= SEGMENT_MAX_BYTES) {
        fs.closeSync(fd);
        this.fd = null;
        this.segment += 1;
        this.writeManifest();
        this.ensureFd();
      }
    } catch {
      /* ignore */
    }
    return env.seq;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.fd !== null) {
      try {
        fs.fsyncSync(this.fd);
        fs.closeSync(this.fd);
      } catch {
        /* ignore */
      }
      this.fd = null;
    }
    this.writeManifest();
  }
}
