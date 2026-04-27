import { execFile, spawn, type ChildProcess } from "child_process";
import { existsSync, rmSync, unlinkSync } from "fs";
import { isAbsolute, join, resolve as resolvePath } from "path";
import { promisify } from "util";

import { cacheClear } from "./cache.js";
import {
  BUNDLES_DIR,
  CLUSTER_READY_TIMEOUT_MS,
  KUBECONFIG_PATH,
  PROXY_ADDRESS,
  TROUBLESHOOT_LIVE_WORKDIR,
  UPLOAD_DIR,
} from "./config.js";
import { errorResult, log, type ToolResult } from "./log.js";
import { maybeDeleteUpload } from "./uploads.js";

const execFileAsync = promisify(execFile);

// Bundle state — only mutated in this file.
export let bundleReady = false;
export let bundleLoading = false;
export let bundleLoadError: string | null = null;
export let currentBundlePath: string | null = null;

let bundleProcess: ChildProcess | null = null;

export const isBundleProcessRunning = (): boolean => bundleProcess !== null;

// Resolves to an absolute path under BUNDLES_DIR or UPLOAD_DIR; rejects path traversal.
export function resolveBundlePath(input: string): string {
  const candidate = isAbsolute(input) ? input : join(BUNDLES_DIR, input);
  const abs = resolvePath(candidate);
  const roots = [resolvePath(BUNDLES_DIR), resolvePath(UPLOAD_DIR)];
  const ok = roots.some((r) => abs === r || abs.startsWith(r + "/"));
  if (!ok) {
    throw new Error(
      `Bundle path '${input}' is outside the allowed roots (${BUNDLES_DIR}, ${UPLOAD_DIR}).`,
    );
  }
  return abs;
}

export async function waitForCluster(maxWaitMs = CLUSTER_READY_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline && bundleProcess !== null) {
    try {
      await execFileAsync(
        "kubectl",
        [`--kubeconfig=${KUBECONFIG_PATH}`, "get", "namespaces"],
        { timeout: 5_000 },
      );
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  return false;
}

export async function startBundle(bundlePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    log(`[MCP] Starting troubleshoot-live with bundle: ${bundlePath}`);
    cacheClear();

    const child = spawn(
      "troubleshoot-live",
      ["serve", bundlePath, "--output-kubeconfig", KUBECONFIG_PATH, "--proxy-address", PROXY_ADDRESS],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    bundleProcess = child;
    currentBundlePath = bundlePath;

    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    // Buffer output so early-exit errors surface to the LLM.
    const outputLines: string[] = [];
    const MAX_OUTPUT_LINES = 100;
    const captureLine = (prefix: string, d: Buffer) => {
      process.stderr.write(`[troubleshoot-live] ${d}`);
      for (const line of d.toString().split("\n")) {
        const content = line.trimEnd();
        if (content.length === 0) continue;
        outputLines.push(`${prefix}: ${content}`);
        if (outputLines.length > MAX_OUTPUT_LINES) outputLines.shift();
      }
    };

    child.stdout?.on("data", (d: Buffer) => captureLine("stdout", d));
    child.stderr?.on("data", (d: Buffer) => captureLine("stderr", d));

    child.on("error", (err) => {
      bundleLoading = false;
      bundleLoadError = err.message;
      settle(() => reject(err));
    });
    child.on("exit", (code, signal) => {
      bundleReady = false;
      bundleProcess = null;
      currentBundlePath = null;
      try { rmSync(TROUBLESHOOT_LIVE_WORKDIR, { recursive: true, force: true }); } catch {}
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      log(`[MCP] troubleshoot-live exited with ${reason}`);
      const output = outputLines.join("\n").trim();
      const detail = output ? `\n\nProcess output:\n${output}` : "";
      const msg = `troubleshoot-live exited before becoming ready (${reason})${detail}`;
      if (bundleLoading) {
        bundleLoading = false;
        bundleLoadError = msg;
      }
      settle(() => reject(new Error(msg)));
    });

    // Brief grace period before the caller starts polling.
    setTimeout(() => settle(() => resolve()), 2_000);
  });
}

export async function stopBundle(timeoutMs = 10_000): Promise<void> {
  const child = bundleProcess;
  if (!child) return;
  // Capture before exit fires — the exit handler in startBundle nulls currentBundlePath first.
  const wasPath = currentBundlePath;
  log("[MCP] Stopping troubleshoot-live…");

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      bundleReady = false;
      bundleLoading = false;
      bundleLoadError = null;
      bundleProcess = null;
      currentBundlePath = null;
      cacheClear();
      try { if (existsSync(KUBECONFIG_PATH)) unlinkSync(KUBECONFIG_PATH); } catch {}
      try { rmSync(TROUBLESHOOT_LIVE_WORKDIR, { recursive: true, force: true }); } catch {}
      maybeDeleteUpload(wasPath);
      resolve();
    };

    child.once("exit", finish);
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 5_000);
    killTimer.unref();
    const giveUp = setTimeout(finish, timeoutMs);
    giveUp.unref();
  });
}

export function markLoading(): void {
  bundleReady = false;
  bundleLoading = true;
  bundleLoadError = null;
}

export function markReady(ok: boolean, expectedPath: string): void {
  // Another start_bundle/stop_bundle may have superseded us.
  if (currentBundlePath !== expectedPath) return;
  bundleReady = ok;
  bundleLoading = false;
  if (!ok && !bundleLoadError) {
    bundleLoadError = `Kubernetes API did not become ready within ${Math.round(
      CLUSTER_READY_TIMEOUT_MS / 1000,
    )}s.`;
  }
}

export function markFailed(msg: string): void {
  bundleLoading = false;
  bundleLoadError = msg;
}

// Returns null if ready, otherwise a tool result with a clear "not ready" message.
export function requireReady(): ToolResult | null {
  if (bundleReady) return null;
  if (bundleLoading) {
    return errorResult(
      `Cluster is still loading bundle '${currentBundlePath}'. Poll cluster_status every few seconds until it reports ready, then retry this tool.`,
    );
  }
  if (bundleLoadError) {
    return errorResult(
      `Last bundle load failed:\n${bundleLoadError}\nCall start_bundle again or pick a different bundle.`,
    );
  }
  return errorResult(
    "Cluster is not ready. Use start_bundle to load a support bundle, or check container logs.",
  );
}
