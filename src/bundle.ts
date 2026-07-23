import { existsSync, mkdirSync, rmSync } from "fs";
import { stat } from "fs/promises";
import { isAbsolute, join, resolve as resolvePath, sep } from "path";

import { BundleReader, type ResourceQuery, type ResourceQueryResult } from "./bundle-reader.js";
import { BUNDLE_CACHE_DIR, BUNDLES_DIR, UPLOAD_DIR } from "./config.js";
import { errorResult, log, type ToolResult } from "./log.js";
import { maybeDeleteUpload } from "./uploads.js";

export type BundlePhase = "idle" | "extracting" | "indexing" | "ready" | "failed";

export let bundleReady = false;
export let bundleLoading = false;
export let bundleLoadError: string | null = null;
export let currentBundlePath: string | null = null;
export let currentBundleGeneration = 0;
export let bundleLoadStartedAt: number | null = null;
export let bundlePhaseStartedAt: number | null = null;
export let bundlePhase: BundlePhase = "idle";

let activeReader: BundleReader | null = null;
let activeFingerprint: string | null = null;
let loadAbort: AbortController | null = null;
let cachedShared: {
  path: string;
  fingerprint: string;
  reader: BundleReader;
} | null = null;

const isUpload = (path: string): boolean =>
  resolvePath(path).startsWith(`${resolvePath(UPLOAD_DIR)}${sep}`);

const setPhase = (phase: BundlePhase): void => {
  bundlePhase = phase;
  bundlePhaseStartedAt = Date.now();
};

const fingerprint = async (path: string): Promise<string> => {
  const info = await stat(path);
  return `${resolvePath(path)}:${info.size}:${info.mtimeMs}`;
};

export function initBundleCache(): void {
  rmSync(BUNDLE_CACHE_DIR, { recursive: true, force: true });
  mkdirSync(BUNDLE_CACHE_DIR, { recursive: true });
}

export function resolveBundlePath(input: string): string {
  const candidate = isAbsolute(input) ? input : join(BUNDLES_DIR, input);
  const absolute = resolvePath(candidate);
  const roots = [resolvePath(BUNDLES_DIR), resolvePath(UPLOAD_DIR)];
  if (!roots.some((root) => absolute === root || absolute.startsWith(`${root}${sep}`))) {
    throw new Error(
      `Bundle path '${input}' is outside the allowed roots (${BUNDLES_DIR}, ${UPLOAD_DIR}).`,
    );
  }
  return absolute;
}

export const isBundleActive = (): boolean =>
  bundleLoading || bundleReady || currentBundlePath !== null;

export async function startBundle(path: string): Promise<"ready" | "loading"> {
  const expectedFingerprint = await fingerprint(path);
  const generation = ++currentBundleGeneration;
  bundleLoadStartedAt = Date.now();
  bundleLoadError = null;
  currentBundlePath = path;

  if (
    cachedShared &&
    cachedShared.path === path &&
    cachedShared.fingerprint === expectedFingerprint
  ) {
    activeReader = cachedShared.reader;
    activeFingerprint = cachedShared.fingerprint;
    cachedShared = null;
    bundleReady = true;
    bundleLoading = false;
    setPhase("ready");
    return "ready";
  }

  if (cachedShared) {
    void cachedShared.reader.destroy().catch((err: unknown) => {
      log("[MCP] Failed to remove old bundle cache:", err);
    });
    cachedShared = null;
  }

  bundleReady = false;
  bundleLoading = true;
  setPhase("extracting");
  loadAbort = new AbortController();
  const extractionDir = join(BUNDLE_CACHE_DIR, `bundle-${generation}`);
  const signal = loadAbort.signal;

  void BundleReader.open(
    path,
    extractionDir,
    () => {
      if (currentBundleGeneration === generation) setPhase("indexing");
    },
    signal,
  ).then((reader) => {
    if (currentBundleGeneration !== generation || currentBundlePath !== path) {
      void reader.destroy();
      return;
    }
    activeReader = reader;
    activeFingerprint = expectedFingerprint;
    loadAbort = null;
    bundleReady = true;
    bundleLoading = false;
    setPhase("ready");
    log(`[MCP] Bundle ready: ${path}`);
  }).catch((err: unknown) => {
    if (currentBundleGeneration !== generation || signal.aborted) return;
    bundleReady = false;
    bundleLoading = false;
    loadAbort = null;
    bundleLoadError = err instanceof Error ? err.message : String(err);
    setPhase("failed");
    log(`[MCP] Bundle load failed:`, err);
  });

  return "loading";
}

export async function stopBundle(): Promise<void> {
  const path = currentBundlePath;
  const reader = activeReader;
  const readerFingerprint = activeFingerprint;
  ++currentBundleGeneration;
  loadAbort?.abort();
  loadAbort = null;
  activeReader = null;
  activeFingerprint = null;
  bundleReady = false;
  bundleLoading = false;
  bundleLoadError = null;
  currentBundlePath = null;
  bundleLoadStartedAt = null;
  bundlePhaseStartedAt = null;
  bundlePhase = "idle";

  if (!path) return;
  if (reader && !isUpload(path)) {
    cachedShared = { path, fingerprint: readerFingerprint ?? "", reader };
  } else {
    void reader?.destroy().catch((err: unknown) => {
      log("[MCP] Failed to remove uploaded bundle cache:", err);
    });
  }
  if (isUpload(path)) maybeDeleteUpload(path);
}

export function requireReady(): ToolResult | null {
  if (bundleReady && activeReader) return null;
  if (bundleLoading) {
    return errorResult(
      `Bundle '${currentBundlePath}' is still loading (phase=${bundlePhase}). Poll cluster_status until it reports ready.`,
    );
  }
  if (bundleLoadError) {
    return errorResult(`Last bundle load failed:\n${bundleLoadError}`);
  }
  return errorResult("No bundle is ready. Use list_bundles, then start_bundle.");
}

const reader = (): BundleReader => {
  if (!activeReader || !bundleReady) throw new Error("No bundle is ready");
  return activeReader;
};

export const queryResources = (query: ResourceQuery): Promise<ResourceQueryResult> =>
  reader().query(query);

export const readPodLogs = (
  namespace: string,
  pod: string,
  container: string,
  tail: number,
): Promise<string> => reader().podLogs(namespace, pod, container, tail);

export const bundleOverview = (warningLimit: number): Promise<Record<string, unknown>> =>
  reader().overview(warningLimit);

export const availableKinds = (): string[] => reader().availableKinds();

export const bundleExists = (path: string): boolean => existsSync(path);
