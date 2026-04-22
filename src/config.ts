// All env-var-driven configuration in one place. No side effects beyond
// reading process.env, so importing this module is free.

const intEnv = (name: string, def: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : def;
};

export const KUBECONFIG_PATH = process.env.KUBECONFIG_PATH ?? "/tmp/kubeconfig";
export const BUNDLE_PATH = process.env.BUNDLE_PATH;
export const BUNDLES_DIR = process.env.BUNDLES_DIR ?? "/bundles";
export const PORT = intEnv("PORT", 3000);
export const PROXY_ADDRESS = process.env.PROXY_ADDRESS ?? "localhost:8080";
export const KUBECTL_TIMEOUT_MS = intEnv("KUBECTL_TIMEOUT_MS", 30_000);
// 5 min: first load downloads ~185 MB of envtest binaries before the proxy starts.
export const CLUSTER_READY_TIMEOUT_MS = intEnv("CLUSTER_READY_TIMEOUT_MS", 300_000);

// Uploads land OUTSIDE BUNDLES_DIR so they never touch the user's host mount.
export const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "/tmp/troubleshoot-mcp-uploads";
export const MAX_UPLOAD_BYTES = intEnv("MAX_UPLOAD_BYTES", 5 * 1024 * 1024 * 1024);
export const UPLOAD_TTL_MS = intEnv("UPLOAD_TTL_MS", 6 * 60 * 60 * 1000);
export const UPLOAD_SWEEP_INTERVAL_MS = intEnv("UPLOAD_SWEEP_INTERVAL_MS", 30 * 60 * 1000);

// Override for the upload base URL; normally derived per-request from Host
// (+ X-Forwarded-*). Empty string treated as unset.
export const PUBLIC_URL_OVERRIDE = (process.env.PUBLIC_URL ?? "").trim() || null;

// Bundle is immutable per load, so caching identical kubectl calls is always safe.
export const KUBECTL_CACHE_TTL_MS = intEnv("KUBECTL_CACHE_TTL_MS", 300_000);
export const KUBECTL_CACHE_MAX_ENTRIES = intEnv("KUBECTL_CACHE_MAX_ENTRIES", 256);

// Soft cap on response size returned to the LLM. Above this we append a
// truncation hint so the model knows to narrow its query. We don't truncate
// the kubectl maxBuffer (still 10 MB) — we just tell the model.
export const RESPONSE_SOFT_LIMIT_BYTES = intEnv("RESPONSE_SOFT_LIMIT_BYTES", 200 * 1024);

// Working dir troubleshoot-live extracts bundles into. Wiped on stop / startup.
export const TROUBLESHOOT_LIVE_WORKDIR = "/tmp/troubleshoot-live";
