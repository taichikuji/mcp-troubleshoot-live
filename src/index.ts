import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { execFile, spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { promisify } from "util";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "fs";
import { join, isAbsolute, resolve as resolvePath } from "path";

const execFileAsync = promisify(execFile);

const KUBECONFIG_PATH = process.env.KUBECONFIG_PATH ?? "/tmp/kubeconfig";
const BUNDLE_PATH = process.env.BUNDLE_PATH;
const BUNDLES_DIR = process.env.BUNDLES_DIR ?? "/bundles";
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const PROXY_ADDRESS = process.env.PROXY_ADDRESS ?? "localhost:8080";
const KUBECTL_TIMEOUT_MS = parseInt(process.env.KUBECTL_TIMEOUT_MS ?? "30000", 10);
// 5 min: first load downloads ~185 MB of envtest binaries before the proxy starts.
const CLUSTER_READY_TIMEOUT_MS = parseInt(process.env.CLUSTER_READY_TIMEOUT_MS ?? "300000", 10);

// Uploads land OUTSIDE BUNDLES_DIR so they never touch the user's host mount.
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "/tmp/troubleshoot-mcp-uploads";
const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES ?? String(5 * 1024 * 1024 * 1024), 10);
const UPLOAD_TTL_MS = parseInt(process.env.UPLOAD_TTL_MS ?? String(6 * 60 * 60 * 1000), 10);
const UPLOAD_SWEEP_INTERVAL_MS = parseInt(process.env.UPLOAD_SWEEP_INTERVAL_MS ?? String(30 * 60 * 1000), 10);
// URL the user's machine uses to reach this MCP. Set when MCP and client are on different hosts.
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;

let bundleProcess: ChildProcess | null = null;
let bundleReady = false;
// Loading flag so cluster_status can report "still loading" — keeps LLM tool-call timeouts (~60s) from blocking on cold loads.
let bundleLoading = false;
let bundleLoadError: string | null = null;
let currentBundlePath: string | null = null;

// Tracks files we own via the upload endpoint; /bundles paths are never deleted.
const uploadedPaths = new Set<string>();

// Verbs that don't mutate cluster state. Gates kubectl_run.
const READ_ONLY_VERBS = new Set([
  "get", "describe", "logs", "top", "explain", "api-resources", "api-versions",
  "version", "cluster-info", "config", "auth", "events", "wait",
]);

// Shell-style tokenizer with single/double quotes and backslash escapes; no shell invocation.
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const ch of input) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (quote) throw new Error(`Unterminated ${quote} quote in arguments`);
  if (current.length) tokens.push(current);
  return tokens;
}

// troubleshoot-live's proxy briefly drops the listener during bundle import.
// Retry transient connection errors; everything else fails fast.
function isTransientKubectlError(stderr: string): boolean {
  return (
    /connection refused/i.test(stderr) ||
    /EOF/.test(stderr) ||
    /Unable to connect to the server/i.test(stderr) ||
    /no route to host/i.test(stderr)
  );
}

async function runKubectl(args: string[]): Promise<string> {
  if (!existsSync(KUBECONFIG_PATH)) {
    return "No kubeconfig found. Start a bundle first with the start_bundle tool.";
  }
  const maxAttempts = 4;
  let lastErr: { message: string; stderr?: string } = { message: "" };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { stdout, stderr } = await execFileAsync(
        "kubectl",
        [`--kubeconfig=${KUBECONFIG_PATH}`, ...args],
        { timeout: KUBECTL_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }
      );
      return (stdout || stderr).trim();
    } catch (err: unknown) {
      lastErr = err as { message: string; stderr?: string };
      const stderr = lastErr.stderr ?? "";
      if (attempt < maxAttempts && isTransientKubectlError(stderr)) {
        // Backoff 250ms, 500ms, 1s; worst-case +1.75s.
        await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)));
        continue;
      }
      break;
    }
  }
  return `Error: ${lastErr.message}\n${lastErr.stderr ?? ""}`.trim();
}

function nsArgs(namespace: string | undefined, allNamespacesFallback = true): string[] {
  if (namespace) return ["-n", namespace];
  return allNamespacesFallback ? ["-A"] : [];
}

async function waitForCluster(maxWaitMs = CLUSTER_READY_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline && bundleProcess !== null) {
    try {
      await execFileAsync(
        "kubectl",
        [`--kubeconfig=${KUBECONFIG_PATH}`, "get", "namespaces"],
        { timeout: 5_000 }
      );
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  return false;
}

async function startBundle(bundlePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`[MCP] Starting troubleshoot-live with bundle: ${bundlePath}`);

    const child = spawn(
      "troubleshoot-live",
      ["serve", bundlePath, "--output-kubeconfig", KUBECONFIG_PATH, "--proxy-address", PROXY_ADDRESS],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    bundleProcess = child;
    currentBundlePath = bundlePath;

    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    // Buffer output so early-exit errors surface to the LLM instead of vanishing into logs.
    const outputLines: string[] = [];
    const MAX_OUTPUT_LINES = 100;
    const captureLine = (prefix: string, d: Buffer) => {
      process.stdout.write(`[troubleshoot-live] ${d}`);
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
      // Wipe extraction dir so re-loading the same bundle doesn't hit "is a directory".
      try { rmSync("/tmp/troubleshoot-live", { recursive: true, force: true }); } catch {}
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      console.log(`[MCP] troubleshoot-live exited with ${reason}`);
      const output = outputLines.join("\n").trim();
      const detail = output ? `\n\nProcess output:\n${output}` : "";
      const msg = `troubleshoot-live exited before becoming ready (${reason})${detail}`;
      // If readyWatch hasn't already flipped state, do it here so cluster_status surfaces the crash.
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

// SIGTERMs the child and waits for exit (or hard-kills after 5s).
async function stopBundle(timeoutMs = 10_000): Promise<void> {
  const child = bundleProcess;
  if (!child) return;
  // Capture before exit fires — startBundle's own exit handler nulls currentBundlePath first.
  const wasPath = currentBundlePath;
  console.log("[MCP] Stopping troubleshoot-live…");

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
      try { if (existsSync(KUBECONFIG_PATH)) unlinkSync(KUBECONFIG_PATH); } catch {}
      try { rmSync("/tmp/troubleshoot-live", { recursive: true, force: true }); } catch {}
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

// Resolve a bundle reference to an absolute path under BUNDLES_DIR or UPLOAD_DIR; rejects escapes.
function resolveBundlePath(input: string): string {
  const candidate = isAbsolute(input) ? input : join(BUNDLES_DIR, input);
  const abs = resolvePath(candidate);
  const roots = [resolvePath(BUNDLES_DIR), resolvePath(UPLOAD_DIR)];
  const ok = roots.some((r) => abs === r || abs.startsWith(r + "/"));
  if (!ok) {
    throw new Error(
      `Bundle path '${input}' is outside the allowed roots (${BUNDLES_DIR}, ${UPLOAD_DIR}).`
    );
  }
  return abs;
}

// Strips path components and restricts to safe charset + known archive extension.
function sanitizeFilename(raw: string): string | null {
  const base = raw.replace(/^.*[\\/]/, "");
  if (!base || base.length > 255) return null;
  if (base.startsWith(".")) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(base)) return null;
  if (!/\.(tar\.gz|tgz|tar)$/i.test(base)) return null;
  return base;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// Wipe + recreate UPLOAD_DIR at startup so a previous crash can't leave orphans.
function initUploadDir(): void {
  try { rmSync(UPLOAD_DIR, { recursive: true, force: true }); } catch {}
  mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Reaps idle uploads older than UPLOAD_TTL_MS. Skips the currently loaded file.
function sweepUploads(): void {
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
        console.log(`[MCP] Reaped idle upload: ${full}`);
      }
    } catch {}
  }
}

// Deletes an upload file iff we own it; /bundles paths are user-owned and skipped.
function maybeDeleteUpload(p: string | null): void {
  if (!p || !uploadedPaths.has(p)) return;
  try {
    unlinkSync(p);
    console.log(`[MCP] Deleted uploaded bundle after stop: ${p}`);
  } catch {}
  uploadedPaths.delete(p);
}

function listBundleFiles(): { path: string; name: string; sizeBytes: number; modified: string }[] {
  if (!existsSync(BUNDLES_DIR)) return [];
  const out: { path: string; name: string; sizeBytes: number; modified: string }[] = [];
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

// Fresh McpServer per session; tool handlers close over the shared module-level state.
const requireReady = (): { content: [{ type: "text"; text: string }]; isError: true } | null => {
  if (bundleReady) return null;
  let text: string;
  if (bundleLoading) {
    text = `Cluster is still loading bundle '${currentBundlePath}'. Poll cluster_status every few seconds until it reports ready, then retry this tool.`;
  } else if (bundleLoadError) {
    text = `Last bundle load failed:\n${bundleLoadError}\nCall start_bundle again or pick a different bundle.`;
  } else {
    text = "Cluster is not ready. Use start_bundle to load a support bundle, or check container logs.";
  }
  return { isError: true, content: [{ type: "text", text }] };
};

function createServer(): McpServer {
  const server = new McpServer(
    { name: "troubleshoot-live-mcp", version: "1.0.0" },
    {
      instructions: [
        "Tools for inspecting Kubernetes support bundles via troubleshoot-live.",
        "",
        "WORKFLOW for investigating a bundle:",
        "1. If the user names a bundle file on THEIR local machine (e.g. ~/Downloads/foo.tar.gz),",
        "   call `prepare_upload` FIRST. It returns a curl command. Run that curl via your",
        "   shell tool on the user's machine. Parse the JSON response and pass the returned",
        "   `path` (or `name`) to `start_bundle`.",
        "2. If the bundle is already on the MCP server, call `list_bundles` to discover names,",
        "   then `start_bundle <name>` directly — no upload needed.",
        "3. `start_bundle` returns IMMEDIATELY with status='loading' (or 'ready' if already",
        "   loaded). Then poll `cluster_status` every few seconds until it reports 'ready'.",
        "   Cold loads can take 1–3 minutes (envtest binary download); warm loads ~5–30s.",
        "   Do NOT call other inspection tools until `cluster_status` says 'ready'.",
        "4. Once ready, use `get_pods`, `get_events`, `get_pod_logs`, `describe_resource`,",
        "   etc. to triage. Use `kubectl_run` for read-only ad-hoc queries.",
        "5. When done, call `stop_bundle`. Uploaded bundles are deleted from the server then;",
        "   bundles that lived under /bundles are left alone.",
        "",
        "Do NOT run troubleshoot-live or kubectl directly on the user's machine; this MCP",
        "owns the live cluster.",
      ].join("\n"),
    }
  );

  server.registerTool(
    "prepare_upload",
    {
      description:
        "Use this FIRST when the user wants to investigate a support bundle that lives on their local machine and is not yet on the MCP server. Returns a `curl` command to push the bundle from the user's machine to the MCP server's upload endpoint. Run that curl via your shell tool, then pass the returned path/name to `start_bundle`. If the bundle already lives in the server's bundles directory, skip this and use `list_bundles` + `start_bundle` instead.",
      inputSchema: {
        local_path: z
          .string()
          .describe(
            "Absolute path to the support bundle on the user's local machine (e.g. /Users/alice/Downloads/foo.tar.gz)."
          ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ local_path }) => {
      const base = local_path.replace(/^.*[\\/]/, "");
      const safe = sanitizeFilename(base);
      if (!safe) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Cannot derive a safe filename from '${base}'. The bundle filename must end in .tar.gz, .tgz, or .tar and contain only letters, digits, '.', '-', '_'. Rename the file locally and retry.`,
            },
          ],
        };
      }
      const url = `${PUBLIC_URL.replace(/\/+$/, "")}/bundles/upload/${encodeURIComponent(safe)}`;
      const cmd = `curl -fsS --upload-file ${shellQuote(local_path)} ${shellQuote(url)}`;
      const ttlH = Math.round(UPLOAD_TTL_MS / 3_600_000);
      const maxGb = (MAX_UPLOAD_BYTES / (1024 * 1024 * 1024)).toFixed(1);
      return {
        content: [
          {
            type: "text",
            text: [
              "Run this exact command on the user's machine via your shell tool:",
              "",
              cmd,
              "",
              "It will print a JSON response shaped like:",
              `  { "path": "${UPLOAD_DIR}/<uuid>-${safe}", "name": "<uuid>-${safe}", "sizeBytes": N }`,
              "",
              `Then call start_bundle with bundle_path set to that "path" (or "name"). The`,
              `uploaded file is auto-deleted when stop_bundle runs, when this container`,
              `restarts, or after ${ttlH}h of inactivity. Max upload size: ${maxGb} GB.`,
            ].join("\n"),
          },
        ],
      };
    }
  );

  server.registerTool(
    "start_bundle",
    {
      description:
        "Load a support bundle into the live cluster. Returns IMMEDIATELY with status='ready' (warm, already loaded) or status='loading' (apiserver not yet up). If status is 'loading', poll `cluster_status` every few seconds until it reports 'ready' before calling other inspection tools. Cold loads take 1–3 minutes (envtest binary download); warm loads ~5–30s. Pass: (a) a bare filename in /bundles, (b) an absolute path under /bundles, or (c) the path/name returned by `prepare_upload`. If the bundle lives only on the user's local machine, call `prepare_upload` FIRST.",
      inputSchema: {
        bundle_path: z
          .string()
          .describe(
            "Filename in /bundles (e.g. 'support-2025-04-01.tar.gz'), absolute path under /bundles, or the 'path'/'name' returned by prepare_upload."
          ),
      },
    },
    async ({ bundle_path }) => {
      let resolved: string;
      try {
        resolved = resolveBundlePath(bundle_path);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: msg }] };
      }
      if (!existsSync(resolved)) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: [
                `Bundle file not found on the MCP server at: ${resolved}`,
                "",
                "Next steps:",
                `  - If the bundle is on the user's local machine, call prepare_upload first`,
                `    (returns a curl command that uploads it to ${UPLOAD_DIR}).`,
                `  - If the bundle should already be on the server, call list_bundles to see`,
                `    what's actually available in ${BUNDLES_DIR}.`,
              ].join("\n"),
            },
          ],
        };
      }

      if (bundleProcess) {
        if (currentBundlePath === resolved && bundleReady) {
          return {
            content: [
              {
                type: "text",
                text: `status=ready. Bundle '${resolved}' is already loaded at ${PROXY_ADDRESS}.`,
              },
            ],
          };
        }
        if (currentBundlePath === resolved && bundleLoading) {
          return {
            content: [
              {
                type: "text",
                text: `status=loading. Bundle '${resolved}' is already being loaded. Poll cluster_status every few seconds until it reports ready.`,
              },
            ],
          };
        }
        console.log(`[MCP] Switching bundles: '${currentBundlePath}' → '${resolved}'`);
        await stopBundle();
      }

      bundleReady = false;
      bundleLoading = true;
      bundleLoadError = null;
      try {
        // Resolves after the 2s grace period; child keeps running in background.
        await startBundle(resolved);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        bundleLoading = false;
        bundleLoadError = msg;
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to start troubleshoot-live: ${msg}` }],
        };
      }

      // Background readiness watch; lets us return immediately so the LLM client doesn't hit its tool-call timeout.
      const startedFor = resolved;
      void (async () => {
        console.log("[MCP] Waiting for Kubernetes API to become ready…");
        const ok = await waitForCluster();
        // Guard: another start_bundle/stop_bundle may have superseded us.
        if (currentBundlePath !== startedFor) return;
        bundleReady = ok;
        bundleLoading = false;
        if (!ok && !bundleLoadError) {
          bundleLoadError = `Kubernetes API did not become ready within ${Math.round(
            CLUSTER_READY_TIMEOUT_MS / 1000
          )}s.`;
        }
      })();

      return {
        content: [
          {
            type: "text",
            text: `status=loading. Bundle '${resolved}' is starting. Poll cluster_status every few seconds until it reports ready before using other inspection tools.`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "stop_bundle",
    {
      description:
        "Unload the currently loaded support bundle and shut down the in-memory cluster. The MCP server itself stays up.",
    },
    async () => {
      if (!bundleProcess) {
        return { content: [{ type: "text", text: "No bundle is currently loaded." }] };
      }
      const wasLoaded = currentBundlePath;
      await stopBundle();
      return {
        content: [
          { type: "text", text: `Unloaded bundle '${wasLoaded}'. Use start_bundle to load another.` },
        ],
      };
    }
  );

  server.registerTool(
    "list_bundles",
    {
      description: `List support bundles available under ${BUNDLES_DIR}. Returns filenames you can pass to start_bundle.`,
    },
    async () => {
      const files = listBundleFiles();
      if (files.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                `No bundles found in ${BUNDLES_DIR}.\n` +
                `If the user has a bundle on their local machine, call prepare_upload to ` +
                `upload it. Otherwise drop .tar.gz support bundles into the host directory ` +
                `mounted at ${BUNDLES_DIR}.`,
            },
          ],
        };
      }
      const lines = files.map((f) => {
        const sizeMb = (f.sizeBytes / 1024 / 1024).toFixed(1);
        const active = f.path === currentBundlePath ? "  ← currently loaded" : "";
        return `${f.path}\t${sizeMb} MB\t${f.modified}${active}`;
      });
      return {
        content: [
          {
            type: "text",
            text: [
              `Found ${files.length} bundle(s) in ${BUNDLES_DIR}:`,
              "",
              "PATH\tSIZE\tMODIFIED",
              ...lines,
            ].join("\n"),
          },
        ],
      };
    }
  );

  server.registerTool(
    "cluster_status",
    {
      description:
        "Report the cluster's load state. Use this to poll after start_bundle. Returns one of: status=ready (use inspection tools now), status=loading (poll again in a few seconds), status=failed (load crashed; includes reason), status=idle (no bundle loaded).",
    },
    async () => {
      if (bundleReady) {
        return {
          content: [
            {
              type: "text",
              text:
                `status=ready\n` +
                `Loaded bundle: ${currentBundlePath}\n\n` +
                (await runKubectl(["get", "namespaces"])),
            },
          ],
        };
      }
      if (bundleLoading) {
        return {
          content: [
            {
              type: "text",
              text: `status=loading\nLoading bundle: ${currentBundlePath}\nPoll cluster_status again in a few seconds. Cold loads can take 1–3 minutes.`,
            },
          ],
        };
      }
      if (bundleLoadError) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `status=failed\nLast load error:\n${bundleLoadError}`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: "status=idle\nNo bundle loaded. Use list_bundles to see available bundles, then start_bundle to load one.",
          },
        ],
      };
    }
  );

  server.registerTool(
    "list_namespaces",
    { description: "List all namespaces in the support bundle cluster." },
    async () =>
      requireReady() ?? {
        content: [{ type: "text", text: await runKubectl(["get", "namespaces", "-o", "wide"]) }],
      }
  );

  server.registerTool(
    "get_nodes",
    { description: "List nodes and their status/conditions." },
    async () =>
      requireReady() ?? {
        content: [{ type: "text", text: await runKubectl(["get", "nodes", "-o", "wide"]) }],
      }
  );

  server.registerTool(
    "get_pods",
    {
      description: "List pods, optionally filtered by namespace.",
      inputSchema: {
        namespace: z
          .string()
          .optional()
          .describe("Kubernetes namespace. Omit to list across all namespaces."),
      },
    },
    async ({ namespace }) =>
      requireReady() ?? {
        content: [
          { type: "text", text: await runKubectl(["get", "pods", ...nsArgs(namespace), "-o", "wide"]) },
        ],
      }
  );

  server.registerTool(
    "get_deployments",
    {
      description: "List deployments, optionally filtered by namespace.",
      inputSchema: {
        namespace: z.string().optional().describe("Namespace. Omit for all namespaces."),
      },
    },
    async ({ namespace }) =>
      requireReady() ?? {
        content: [
          { type: "text", text: await runKubectl(["get", "deployments", ...nsArgs(namespace), "-o", "wide"]) },
        ],
      }
  );

  server.registerTool(
    "get_services",
    {
      description: "List services, optionally filtered by namespace.",
      inputSchema: {
        namespace: z.string().optional().describe("Namespace. Omit for all namespaces."),
      },
    },
    async ({ namespace }) =>
      requireReady() ?? {
        content: [
          { type: "text", text: await runKubectl(["get", "services", ...nsArgs(namespace), "-o", "wide"]) },
        ],
      }
  );

  server.registerTool(
    "get_pod_logs",
    {
      description: "Get logs from a specific pod container.",
      inputSchema: {
        pod: z.string().describe("Pod name"),
        namespace: z.string().describe("Namespace the pod lives in"),
        container: z
          .string()
          .optional()
          .describe("Container name (required only for multi-container pods)"),
        tail: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Number of lines to return from the end of the log (default 100)"),
        previous: z
          .boolean()
          .optional()
          .describe("Return logs from the previously terminated container instance"),
        since: z
          .string()
          .optional()
          .describe("Only return logs newer than a relative duration like 5s, 2m, or 3h"),
        timestamps: z
          .boolean()
          .optional()
          .describe("Include RFC3339 timestamps on each log line"),
      },
    },
    async ({ pod, namespace, container, tail, previous, since, timestamps }) => {
      const ready = requireReady();
      if (ready) return ready;
      const args = ["logs", pod, "-n", namespace, `--tail=${tail ?? 100}`];
      if (container) args.push("-c", container);
      if (previous) args.push("--previous");
      if (since) args.push(`--since=${since}`);
      if (timestamps) args.push("--timestamps");
      return { content: [{ type: "text", text: await runKubectl(args) }] };
    }
  );

  server.registerTool(
    "get_events",
    {
      description: "Get Kubernetes events sorted by time. Useful for spotting warnings and failures.",
      inputSchema: {
        namespace: z
          .string()
          .optional()
          .describe("Namespace to scope events to. Omit for all namespaces."),
        warning_only: z
          .boolean()
          .optional()
          .describe("If true, show only Warning events (filters out Normal)"),
      },
    },
    async ({ namespace, warning_only }) => {
      const ready = requireReady();
      if (ready) return ready;
      const args = ["get", "events", ...nsArgs(namespace), "--sort-by=.lastTimestamp"];
      if (warning_only) args.push("--field-selector=type=Warning");
      return { content: [{ type: "text", text: await runKubectl(args) }] };
    }
  );

  server.registerTool(
    "describe_resource",
    {
      description:
        "Describe any Kubernetes resource (equivalent to kubectl describe). Great for seeing status, conditions, and recent events.",
      inputSchema: {
        kind: z
          .string()
          .describe(
            "Resource kind (e.g. pod, deployment, service, configmap, node, persistentvolumeclaim)"
          ),
        name: z.string().describe("Resource name"),
        namespace: z
          .string()
          .optional()
          .describe("Namespace (not needed for cluster-scoped resources like nodes)"),
      },
    },
    async ({ kind, name, namespace }) => {
      const ready = requireReady();
      if (ready) return ready;
      return {
        content: [
          { type: "text", text: await runKubectl(["describe", kind, name, ...nsArgs(namespace, false)]) },
        ],
      };
    }
  );

  server.registerTool(
    "get_resource",
    {
      description: "Get any Kubernetes resource with a configurable output format.",
      inputSchema: {
        kind: z
          .string()
          .describe(
            "Resource kind or plural (e.g. pods, configmaps, secrets, nodes, persistentvolumes, replicasets)"
          ),
        name: z.string().optional().describe("Specific resource name (omit to list all)"),
        namespace: z
          .string()
          .optional()
          .describe("Namespace (omit for cluster-scoped resources or to list all namespaces)"),
        output: z
          .enum(["wide", "yaml", "json", "name"])
          .optional()
          .describe("Output format (default: wide)"),
      },
    },
    async ({ kind, name, namespace, output }) => {
      const ready = requireReady();
      if (ready) return ready;
      const args = ["get", kind];
      if (name) args.push(name);
      if (namespace) args.push("-n", namespace);
      else if (!name) args.push("-A");
      args.push("-o", output ?? "wide");
      return { content: [{ type: "text", text: await runKubectl(args) }] };
    }
  );

  server.registerTool(
    "kubectl_run",
    {
      description: `Run a read-only kubectl command. The first argument must be one of: ${[
        ...READ_ONLY_VERBS,
      ]
        .sort()
        .join(", ")}. Mutating verbs (apply, delete, edit, patch, exec, cp, drain, scale, etc.) are rejected. Do not include the 'kubectl' prefix.`,
      inputSchema: {
        args: z
          .string()
          .describe(
            "kubectl arguments, e.g. 'get nodes -o yaml' or 'top pods -A' or 'api-resources'"
          ),
      },
    },
    async ({ args }) => {
      const ready = requireReady();
      if (ready) return ready;
      let tokens: string[];
      try {
        tokens = tokenize(args);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `Error parsing args: ${msg}` }] };
      }
      if (tokens.length === 0) {
        return { isError: true, content: [{ type: "text", text: "Error: no kubectl command provided" }] };
      }
      const verb = tokens[0]!.toLowerCase();
      if (!READ_ONLY_VERBS.has(verb)) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Refused: '${verb}' is not in the read-only allowlist. Allowed verbs: ${[
                ...READ_ONLY_VERBS,
              ]
                .sort()
                .join(", ")}.`,
            },
          ],
        };
      }
      return { content: [{ type: "text", text: await runKubectl(tokens) }] };
    }
  );

  return server;
}

const app = express();

// Streamable HTTP transport: one McpServer+transport per session.
const sessions = new Map<string, StreamableHTTPServerTransport>();

app.use("/mcp", express.json());
app.all("/mcp", async (req: Request, res: Response) => {
  if (req.method === "GET") {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    if (!sid || !sessions.has(sid)) {
      res.status(400).json({ error: "Missing or invalid Mcp-Session-Id" });
      return;
    }
    await sessions.get(sid)!.handleRequest(req, res);
    return;
  }

  if (req.method === "DELETE") {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    if (sid) {
      const t = sessions.get(sid);
      if (t) { await t.close(); sessions.delete(sid); }
    }
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).set("Allow", "GET, POST, DELETE").json({ error: "Method not allowed" });
    return;
  }

  const sid = req.headers["mcp-session-id"] as string | undefined;
  if (sid && sessions.has(sid)) {
    await sessions.get(sid)!.handleRequest(req, res, req.body);
    return;
  }

  // Unknown sid: 404 so spec-compliant clients re-initialize cleanly.
  if (sid) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  if (!isInitializeRequest(req.body)) {
    res.status(400).json({ error: "Bad Request: missing or unknown mcp-session-id" });
    return;
  }

  const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id: string) => { sessions.set(id, transport); },
  });
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  await createServer().connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Legacy SSE — kept for clients still pointing at /sse. Must not have express.json() in front.
const sseTransports = new Map<string, SSEServerTransport>();

app.get("/sse", async (_req: Request, res: Response) => {
  const transport = new SSEServerTransport("/messages", res);
  sseTransports.set(transport.sessionId, transport);
  res.on("close", () => sseTransports.delete(transport.sessionId));
  await createServer().connect(transport);
});

app.post("/messages", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  const transport = sseTransports.get(sessionId);
  if (!transport) {
    res.status(400).json({ error: `Unknown session ID: ${sessionId}` });
    return;
  }
  await transport.handlePostMessage(req, res);
});

// Raw PUT upload — streams straight to disk; never sits behind a body parser.
app.put("/bundles/upload/:name", (req: Request, res: Response) => {
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

  // Disable per-request timeouts; large bundles over slow networks take time.
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
  // Client aborted mid-stream: 'close' fires without 'error'/'end', so without this a partial file orphans until the TTL sweep.
  req.on("close", () => {
    if (!req.complete) abort(499, "Client closed connection before upload completed");
  });
  ws.on("error", (err) => abort(500, err.message));
  ws.on("finish", () => {
    if (aborted) return;
    uploadedPaths.add(dest);
    console.log(`[MCP] Received upload: ${dest} (${bytes} bytes)`);
    res.status(201).json({ path: dest, name: `${id}-${safe}`, sizeBytes: bytes });
  });

  req.pipe(ws);
});

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
  // Wipe leftover extraction dirs from a previous crash.
  try { rmSync("/tmp/troubleshoot-live", { recursive: true, force: true }); } catch {}
  console.log(
    `[MCP] Upload dir: ${UPLOAD_DIR} (max ${(MAX_UPLOAD_BYTES / 1024 / 1024 / 1024).toFixed(1)} GB, TTL ${Math.round(UPLOAD_TTL_MS / 3_600_000)}h)`
  );
  console.log(`[MCP] Public URL for uploads: ${PUBLIC_URL}`);
  const sweepTimer = setInterval(sweepUploads, UPLOAD_SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  if (BUNDLE_PATH) {
    if (!existsSync(BUNDLE_PATH)) {
      console.warn(`[MCP] BUNDLE_PATH is set to "${BUNDLE_PATH}" but the file was not found.`);
      console.warn("[MCP] Starting MCP server anyway — use the start_bundle tool to load a bundle.");
    } else {
      try {
        await startBundle(BUNDLE_PATH);
        console.log("[MCP] Waiting for Kubernetes API to become ready…");
        bundleReady = await waitForCluster();
        if (bundleReady) {
          console.log("[MCP] Kubernetes API is ready.");
        } else {
          console.warn("[MCP] Warning: Kubernetes API did not become ready in time.");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[MCP] Failed to auto-start bundle: ${msg}`);
      }
    }
  }

  const httpServer = app.listen(PORT, () => {
    console.log(`[MCP] Server listening on port ${PORT}`);
    console.log(`[MCP] Connect Cursor to: http://localhost:${PORT}/mcp`);
    console.log(`[MCP] Health check:       http://localhost:${PORT}/health`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[MCP] Received ${signal}, shutting down…`);
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
