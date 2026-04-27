import { randomUUID } from "crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "fs";
import { join } from "path";

import type { Request, Response } from "express";

import { BUNDLES_DIR, MAX_UPLOAD_BYTES, UPLOAD_DIR, UPLOAD_TTL_MS } from "./config.js";
import { log } from "./log.js";

// Files owned via the upload endpoint; /bundles paths are never in here.
export const uploadedPaths = new Set<string>();

export function sanitizeFilename(raw: string): string | null {
  const base = raw.replace(/^.*[\\/]/, "");
  if (!base || base.length > 255) return null;
  if (base.startsWith(".")) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(base)) return null;
  if (!/\.(tar\.gz|tgz|tar)$/i.test(base)) return null;
  return base;
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function initUploadDir(): void {
  try { rmSync(UPLOAD_DIR, { recursive: true, force: true }); } catch {}
  mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Deletes idle uploads older than UPLOAD_TTL_MS, skipping the currently loaded one.
export function sweepUploads(currentBundlePath: string | null): void {
  if (!existsSync(UPLOAD_DIR)) return;
  const now = Date.now();
  for (const entry of readdirSync(UPLOAD_DIR)) {
    const full = join(UPLOAD_DIR, entry);
    if (full === currentBundlePath) continue;
    try {
      const s = statSync(full);
      if (!s.isFile()) continue;
      if (now - s.mtimeMs > UPLOAD_TTL_MS) {
        unlinkSync(full);
        uploadedPaths.delete(full);
        log(`[MCP] Reaped idle upload: ${full}`);
      }
    } catch {}
  }
}

export function maybeDeleteUpload(p: string | null): void {
  if (!p || !uploadedPaths.has(p)) return;
  try {
    unlinkSync(p);
    log(`[MCP] Deleted uploaded bundle after stop: ${p}`);
  } catch {}
  uploadedPaths.delete(p);
}

export type BundleFile = {
  path: string;
  name: string;
  sizeBytes: number;
  modified: string;
};

export function listBundleFiles(): BundleFile[] {
  if (!existsSync(BUNDLES_DIR)) return [];
  const out: BundleFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      let s;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        walk(full);
      } else if (s.isFile() && /\.(tar\.gz|tgz|tar)$/i.test(entry)) {
        out.push({ path: full, name: entry, sizeBytes: s.size, modified: s.mtime.toISOString() });
      }
    }
  };
  walk(BUNDLES_DIR);
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

// Streams directly to disk; not behind a body parser.
export function handleUpload(req: Request, res: Response): void {
  const safe = sanitizeFilename(req.params.name ?? "");
  if (!safe) {
    res.status(400).json({
      error:
        "Invalid filename. Must end in .tar.gz, .tgz, or .tar and contain only letters, digits, '.', '-', '_'.",
    });
    return;
  }

  const declared = parseInt(req.headers["content-length"] ?? "0", 10);
  if (declared && declared > MAX_UPLOAD_BYTES) {
    res.status(413).json({ error: `File too large; max ${MAX_UPLOAD_BYTES} bytes` });
    return;
  }

  req.setTimeout(0);
  res.setTimeout(0);

  const id = randomUUID();
  const dest = join(UPLOAD_DIR, `${id}-${safe}`);
  const ws = createWriteStream(dest);
  let bytes = 0;
  let aborted = false;

  const abort = (status: number, message: string) => {
    if (aborted) return;
    aborted = true;
    try { ws.destroy(); } catch {}
    try { unlinkSync(dest); } catch {}
    if (!res.headersSent) res.status(status).json({ error: message });
  };

  req.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_UPLOAD_BYTES) {
      abort(413, `File too large; max ${MAX_UPLOAD_BYTES} bytes`);
      req.destroy();
    }
  });
  req.on("error", (err) => abort(500, err.message));
  // 'close' fires without 'error'/'end' on client abort; clean up the partial file.
  req.on("close", () => {
    if (!req.complete) abort(499, "Client closed connection before upload completed");
  });
  ws.on("error", (err) => abort(500, err.message));
  ws.on("finish", () => {
    if (aborted) return;
    uploadedPaths.add(dest);
    log(`[MCP] Received upload: ${dest} (${bytes} bytes)`);
    res.status(201).json({ path: dest, name: `${id}-${safe}`, sizeBytes: bytes });
  });

  req.pipe(ws);
}
