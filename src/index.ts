import { existsSync, rmSync } from "fs";

import express, { type Request, type Response } from "express";

import {
  bundleLoadError,
  bundleLoading,
  bundleReady,
  currentBundlePath,
  markReady,
  startBundle,
  stopBundle,
  waitForCluster,
} from "./bundle.js";
import {
  BUNDLES_DIR,
  BUNDLE_PATH,
  KUBECONFIG_PATH,
  KUBECTL_CACHE_MAX_ENTRIES,
  KUBECTL_CACHE_TTL_MS,
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
    autoStartBundle: BUNDLE_PATH ?? null,
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
  log(
    KUBECTL_CACHE_TTL_MS > 0
      ? `[MCP] kubectl cache: TTL ${Math.round(KUBECTL_CACHE_TTL_MS / 1000)}s, max ${KUBECTL_CACHE_MAX_ENTRIES} entries (cleared on bundle switch)`
      : `[MCP] kubectl cache: disabled (KUBECTL_CACHE_TTL_MS=0)`,
  );

  const sweepTimer = setInterval(() => sweepUploads(currentBundlePath), UPLOAD_SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  if (BUNDLE_PATH) {
    if (!existsSync(BUNDLE_PATH)) {
      log(`[MCP] BUNDLE_PATH is set to "${BUNDLE_PATH}" but the file was not found.`);
      log("[MCP] Starting MCP server anyway — use the start_bundle tool to load a bundle.");
    } else {
      try {
        await startBundle(BUNDLE_PATH);
        log("[MCP] Waiting for Kubernetes API to become ready…");
        const ok = await waitForCluster();
        markReady(ok, BUNDLE_PATH);
        log(ok ? "[MCP] Kubernetes API is ready." : "[MCP] Warning: Kubernetes API did not become ready in time.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[MCP] Failed to auto-start bundle: ${msg}`);
      }
    }
  }

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
