const intEnv = (name: string, def: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : def;
};

export const BUNDLES_DIR = process.env.BUNDLES_DIR ?? "/bundles";
export const PORT = intEnv("PORT", 3000);

// Uploads go outside BUNDLES_DIR so they never touch the user's host mount.
export const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "/tmp/troubleshoot-mcp-uploads";
export const MAX_UPLOAD_BYTES = intEnv("MAX_UPLOAD_BYTES", 5 * 1024 * 1024 * 1024);
export const UPLOAD_TTL_MS = intEnv("UPLOAD_TTL_MS", 6 * 60 * 60 * 1000);
export const UPLOAD_SWEEP_INTERVAL_MS = intEnv("UPLOAD_SWEEP_INTERVAL_MS", 30 * 60 * 1000);
export const BUNDLE_CACHE_DIR = process.env.BUNDLE_CACHE_DIR ?? "/tmp/troubleshoot-mcp-cache";
export const MAX_EXTRACTED_BYTES = intEnv(
  "MAX_EXTRACTED_BYTES",
  20 * 1024 * 1024 * 1024,
);
export const MAX_ARCHIVE_FILES = intEnv("MAX_ARCHIVE_FILES", 500_000);

// Normally derived per-request from Host + X-Forwarded-*; set this to pin it.
export const PUBLIC_URL_OVERRIDE = (process.env.PUBLIC_URL ?? "").trim() || null;

// Responses over this size are rejected so one tool call cannot exhaust client context.
export const RESPONSE_SOFT_LIMIT_BYTES = intEnv("RESPONSE_SOFT_LIMIT_BYTES", 200 * 1024);
