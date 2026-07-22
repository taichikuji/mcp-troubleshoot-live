import { rmSync } from "fs";

import express, { type Request, type Response } from "express";

import {
  bundleLoadError,
  bundleLoading,
  bundleReady,
  currentBundlePath,
  stopBundle,
} from "./bundle.js";
import {
  BUNDLES_DIR,
  CLUSTER_READY_TIMEOUT_MS,
  KUBECONFIG_PATH,
  KUBECTL_CACHE_MAX_ENTRIES,
  MAX_UPLOAD_BYTES,
  PORT,
  PUBLIC_URL_OVERRIDE,
  TROUBLESHOOT_LIVE_WORKDIR,
  UPLOAD_DIR,
  UPLOAD_SWEEP_INTERVAL_MS,
  UPLOAD_TTL_MS,
} from "./config.js";
import { log } from "./log.js";
import { mountMcpRoutes } from "./transport.js";
import { handleUpload, initUploadDir, sweepUploads } from "./uploads.js";

const app = express();
app.set("trust proxy", true); // Honor X-Forwarded-Proto/Host

mountMcpRoutes(app);

app.put("/bundles/upload/:name", handleUpload);

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    bundleReady,
    bundleLoading,
    bundleLoadError,
    currentBundle: currentBundlePath,
    bundlesDir: BUNDLES_DIR,
    uploadDir: UPLOAD_DIR,
    kubeconfig: KUBECONFIG_PATH,
  });
});

async function main(): Promise<void> {
  initUploadDir();
  try { rmSync(TROUBLESHOOT_LIVE_WORKDIR, { recursive: true, force: true }); } catch {}

  log(
    `[MCP] Upload dir: ${UPLOAD_DIR} (max ${(MAX_UPLOAD_BYTES / 1024 / 1024 / 1024).toFixed(1)} GB, TTL ${Math.round(UPLOAD_TTL_MS / 3_600_000)}h)`,
  );
  log(
    PUBLIC_URL_OVERRIDE
      ? `[MCP] Upload base URL pinned via PUBLIC_URL=${PUBLIC_URL_OVERRIDE}`
      : `[MCP] Upload base URL: auto-detected from each MCP request's Host header (set PUBLIC_URL to override)`,
  );
  log(`[MCP] kubectl cache: max ${KUBECTL_CACHE_MAX_ENTRIES} entries (cleared on bundle switch)`);
  log(
    `[MCP] Bundle load timeout: ${Math.round(CLUSTER_READY_TIMEOUT_MS / 1000)}s ` +
      "(timed-out child processes are stopped)",
  );

  const sweepTimer = setInterval(() => sweepUploads(currentBundlePath), UPLOAD_SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  const httpServer = app.listen(PORT, () => {
    log(`[MCP] Server listening on port ${PORT}`);
    log(`[MCP] Connect Cursor to: http://localhost:${PORT}/mcp`);
    log(`[MCP] Health check:       http://localhost:${PORT}/health`);
  });

  const shutdown = async (signal: string) => {
    log(`[MCP] Received ${signal}, shutting down…`);
    await stopBundle().catch(() => {});
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8_000).unref();
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[MCP] Fatal error:", err);
  process.exit(1);
});
