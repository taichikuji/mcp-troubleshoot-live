import { spawn, type ChildProcess } from "child_process";
import { existsSync, rmSync, unlinkSync } from "fs";
import { isAbsolute, join, resolve as resolvePath } from "path";

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

// Bundle state. Only mutated here.
export let bundleReady = false;
export let bundleLoading = false;
export let bundleLoadError: string | null = null;
export let currentBundlePath: string | null = null;
export type BundlePhase =
  | "idle"
  | "spawning"
  | "starting_apiserver"
  | "importing"
  | "ready"
  | "failed";
export let bundlePhase: BundlePhase = "idle";

let bundleProcess: ChildProcess | null = null;

// Ready signal driven off troubleshoot-live's stderr. Reset per start.
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};
let readySignal = deferred<boolean>();

export const isBundleProcessRunning = (): boolean => bundleProcess !== null;

// Resolve to an absolute path under BUNDLES_DIR or UPLOAD_DIR. Rejects traversal.
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

// Wait for the proxy-up stderr line, or give up at the deadline.
export async function waitForCluster(maxWaitMs = CLUSTER_READY_TIMEOUT_MS): Promise<boolean> {
  const timeout = new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), maxWaitMs);
    t.unref();
  });
  return Promise.race([readySignal.promise, timeout]);
}

// Move the phase forward off upstream stderr markers.
function observePhase(line: string): void {
  if (bundlePhase === "ready" || bundlePhase === "failed") return;
  if (line.includes("Running HTTPs proxy service on")) {
    readySignal.resolve(true);
    return;
  }
  if (line.includes("Importing bundle resources")) {
    bundlePhase = "importing";
  } else if (line.includes("Starting k8s server")) {
    bundlePhase = "starting_apiserver";
  }
}

export async function startBundle(bundlePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    log(`[MCP] Starting troubleshoot-live with bundle: ${bundlePath}`);
    cacheClear();
    readySignal = deferred<boolean>();

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

    // Keep recent stderr/stdout so an early-exit error message is useful.
    const outputLines: string[] = [];
    const MAX_OUTPUT_LINES = 100;
    const captureLine = (prefix: string, d: Buffer) => {
      process.stderr.write(`[troubleshoot-live] ${d}`);
      for (const line of d.toString().split("\n")) {
        const content = line.trimEnd();
        if (content.length === 0) continue;
        outputLines.push(`${prefix}: ${content}`);
        if (outputLines.length > MAX_OUTPUT_LINES) outputLines.shift();
        if (prefix === "stderr") observePhase(content);
      }
    };

    child.stdout?.on("data", (d: Buffer) => captureLine("stdout", d));
    child.stderr?.on("data", (d: Buffer) => captureLine("stderr", d));

    // 'spawn' fires only on successful exec; 'error' fires on missing binary.
    child.once("spawn", () => settle(() => resolve()));
    child.on("error", (err) => {
      bundleLoading = false;
      bundleLoadError = err.message;
      bundlePhase = "failed";
      readySignal.resolve(false);
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
      bundlePhase = "failed";
      readySignal.resolve(false);
      settle(() => reject(new Error(msg)));
    });
  });
}

export async function stopBundle(timeoutMs = 10_000): Promise<void> {
  const child = bundleProcess;
  if (!child) return;
  // Grab this before exit fires — the exit handler nulls it.
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
      bundlePhase = "idle";
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
  bundlePhase = "spawning";
}

export function markReady(ok: boolean, expectedPath: string): void {
  // A newer start_bundle/stop_bundle may have superseded this one.
  if (currentBundlePath !== expectedPath) return;
  bundleReady = ok;
  bundleLoading = false;
  bundlePhase = ok ? "ready" : "failed";
  if (!ok && !bundleLoadError) {
    bundleLoadError = `Kubernetes API did not become ready within ${Math.round(
      CLUSTER_READY_TIMEOUT_MS / 1000,
    )}s.`;
  }
}

export function markFailed(msg: string): void {
  bundleLoading = false;
  bundleLoadError = msg;
  bundlePhase = "failed";
}

// Null when ready; otherwise a tool result describing why it isn't.
export function requireReady(): ToolResult | null {
  if (bundleReady) return null;
  if (bundleLoading) {
    return errorResult(
      `Cluster is still loading bundle '${currentBundlePath}' (phase=${bundlePhase}). Poll cluster_status every few seconds until it reports ready, then retry this tool.`,
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
