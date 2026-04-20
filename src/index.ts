import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { execFile, spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { promisify } from "util";
import { existsSync, readdirSync, statSync, unlinkSync } from "fs";
import { join, isAbsolute, resolve as resolvePath } from "path";

const execFileAsync = promisify(execFile);

const KUBECONFIG_PATH = process.env.KUBECONFIG_PATH ?? "/tmp/kubeconfig";
const BUNDLE_PATH = process.env.BUNDLE_PATH;
const BUNDLES_DIR = process.env.BUNDLES_DIR ?? "/bundles";
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const PROXY_ADDRESS = process.env.PROXY_ADDRESS ?? "localhost:8080";
const KUBECTL_TIMEOUT_MS = parseInt(process.env.KUBECTL_TIMEOUT_MS ?? "30000", 10);
// 5 min default: first bundle load triggers envtest binary download (~185 MB)
// before the HTTP proxy starts. On slow networks this can exceed 2 minutes.
const CLUSTER_READY_TIMEOUT_MS = parseInt(
  process.env.CLUSTER_READY_TIMEOUT_MS ?? "300000",
  10
);

let bundleProcess: ChildProcess | null = null;
let bundleReady = false;
let currentBundlePath: string | null = null;

// ---------------------------------------------------------------------------
// kubectl helper
// ---------------------------------------------------------------------------

// Verbs that do not mutate cluster state. Used to gate `kubectl_run`.
const READ_ONLY_VERBS = new Set([
  "get",
  "describe",
  "logs",
  "top",
  "explain",
  "api-resources",
  "api-versions",
  "version",
  "cluster-info",
  "config",
  "auth",
  "events",
  "wait",
]);

// Tokenize a shell-style argument string without invoking a shell. Supports
// single/double quotes and backslash escapes. Throws on unterminated quotes.
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

async function runKubectl(args: string[]): Promise<string> {
  if (!existsSync(KUBECONFIG_PATH)) {
    return "No kubeconfig found. Start a bundle first with the start_bundle tool.";
  }
  try {
    const { stdout, stderr } = await execFileAsync(
      "kubectl",
      [`--kubeconfig=${KUBECONFIG_PATH}`, ...args],
      { timeout: KUBECTL_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }
    );
    return (stdout || stderr).trim();
  } catch (err: unknown) {
    const e = err as { message: string; stderr?: string };
    return `Error: ${e.message}\n${e.stderr ?? ""}`.trim();
  }
}

function nsArgs(namespace: string | undefined, allNamespacesFallback = true): string[] {
  if (namespace) return ["-n", namespace];
  return allNamespacesFallback ? ["-A"] : [];
}

// ---------------------------------------------------------------------------
// troubleshoot-live lifecycle
// ---------------------------------------------------------------------------

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
      [
        "serve",
        bundlePath,
        "--output-kubeconfig",
        KUBECONFIG_PATH,
        "--proxy-address",
        PROXY_ADDRESS,
      ],
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

    child.stdout?.on("data", (d: Buffer) =>
      process.stdout.write(`[troubleshoot-live] ${d}`)
    );
    child.stderr?.on("data", (d: Buffer) =>
      process.stderr.write(`[troubleshoot-live] ${d}`)
    );

    child.on("error", (err) => settle(() => reject(err)));
    child.on("exit", (code, signal) => {
      bundleReady = false;
      bundleProcess = null;
      currentBundlePath = null;
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      console.log(`[MCP] troubleshoot-live exited with ${reason}`);
      settle(() =>
        reject(new Error(`troubleshoot-live exited before becoming ready (${reason})`))
      );
    });

    // Give the process a moment to boot before the caller starts polling.
    setTimeout(() => settle(() => resolve()), 2_000);
  });
}

// Stop the running bundle and wait for the child to exit. Resolves once the
// process is gone (or immediately if nothing is running).
async function stopBundle(timeoutMs = 10_000): Promise<void> {
  const child = bundleProcess;
  if (!child) return;
  console.log("[MCP] Stopping troubleshoot-live…");

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      bundleReady = false;
      bundleProcess = null;
      currentBundlePath = null;
      try {
        if (existsSync(KUBECONFIG_PATH)) unlinkSync(KUBECONFIG_PATH);
      } catch {
        // best-effort cleanup
      }
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

// Resolve a user-supplied bundle reference into an absolute path inside
// BUNDLES_DIR. Accepts either a bare filename ("bundle.tar.gz") or a path
// inside the bundles directory ("/bundles/bundle.tar.gz" or "subdir/x.tgz").
// Refuses anything that escapes BUNDLES_DIR.
function resolveBundlePath(input: string): string {
  const candidate = isAbsolute(input) ? input : join(BUNDLES_DIR, input);
  const abs = resolvePath(candidate);
  const root = resolvePath(BUNDLES_DIR);
  if (!abs.startsWith(root + "/") && abs !== root) {
    throw new Error(
      `Bundle path '${input}' is outside the bundles directory (${BUNDLES_DIR}).`
    );
  }
  return abs;
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
        out.push({
          path: full,
          name: entry,
          sizeBytes: s.size,
          modified: s.mtime.toISOString(),
        });
      }
    }
  };
  walk(BUNDLES_DIR);
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

// ---------------------------------------------------------------------------
// MCP server factory
// ---------------------------------------------------------------------------
// A fresh McpServer is created per transport session (/mcp and /sse) so
// concurrent clients each get their own instance. All tool handlers close
// over the shared module-level state (bundleProcess, bundleReady).

const requireReady = (): { content: [{ type: "text"; text: string }] } | null =>
  bundleReady
    ? null
    : {
        content: [
          {
            type: "text",
            text: "Cluster is not ready. Use start_bundle to load a support bundle, or check container logs.",
          },
        ],
      };

function createServer(): McpServer {
  const server = new McpServer({
    name: "troubleshoot-live-mcp",
    version: "1.0.0",
  });

  // --- Bundle lifecycle ---

  server.registerTool(
    "start_bundle",
    {
      description:
        "Load a support bundle into the live cluster. If a different bundle is already loaded it will be unloaded first (~5–60s). Pass either a bare filename ('foo.tar.gz') or an absolute path under /bundles. Use list_bundles to see what's available.",
      inputSchema: {
        bundle_path: z
          .string()
          .describe(
            "Filename inside /bundles (e.g. 'support-2025-04-01.tar.gz') or absolute path under /bundles"
          ),
      },
    },
    async ({ bundle_path }) => {
      let resolved: string;
      try {
        resolved = resolveBundlePath(bundle_path);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: msg }] };
      }
      if (!existsSync(resolved)) {
        return {
          content: [
            {
              type: "text",
              text: `Bundle file not found: ${resolved}. Use list_bundles to see what's available in ${BUNDLES_DIR}.`,
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
                text: `Bundle '${resolved}' is already loaded and ready at ${PROXY_ADDRESS}.`,
              },
            ],
          };
        }
        console.log(`[MCP] Switching bundles: '${currentBundlePath}' → '${resolved}'`);
        await stopBundle();
      }

      bundleReady = false;
      try {
        await startBundle(resolved);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to start troubleshoot-live: ${msg}` }],
        };
      }
      console.log("[MCP] Waiting for Kubernetes API to become ready…");
      bundleReady = await waitForCluster();

      return {
        content: [
          {
            type: "text",
            text: bundleReady
              ? `Bundle '${resolved}' loaded. Kubernetes API is ready — use the cluster inspection tools to query resources.`
              : `Bundle '${resolved}' started but the API did not become ready in time. Check container logs.`,
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
          {
            type: "text",
            text: `Unloaded bundle '${wasLoaded}'. Use start_bundle to load another.`,
          },
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
              text: `No bundles found in ${BUNDLES_DIR}. Drop .tar.gz support bundles into ./bundles/ on the host.`,
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
        "Check whether the troubleshoot-live cluster is running and responsive. Returns the loaded bundle and namespace list on success.",
    },
    async () => {
      if (!bundleReady) {
        return {
          content: [
            {
              type: "text",
              text: "Cluster is not running. Use list_bundles to see available bundles, then start_bundle to load one.",
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text:
              `Cluster is running.\n` +
              `Loaded bundle: ${currentBundlePath}\n\n` +
              (await runKubectl(["get", "namespaces"])),
          },
        ],
      };
    }
  );

  // --- Namespace & node overview ---

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

  // --- Workloads ---

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
          {
            type: "text",
            text: await runKubectl(["get", "pods", ...nsArgs(namespace), "-o", "wide"]),
          },
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
          {
            type: "text",
            text: await runKubectl(["get", "deployments", ...nsArgs(namespace), "-o", "wide"]),
          },
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
          {
            type: "text",
            text: await runKubectl(["get", "services", ...nsArgs(namespace), "-o", "wide"]),
          },
        ],
      }
  );

  // --- Logs ---

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

  // --- Events ---

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

  // --- Generic describe / get ---

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
          {
            type: "text",
            text: await runKubectl(["describe", kind, name, ...nsArgs(namespace, false)]),
          },
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
        return { content: [{ type: "text", text: `Error parsing args: ${msg}` }] };
      }
      if (tokens.length === 0) {
        return { content: [{ type: "text", text: "Error: no kubectl command provided" }] };
      }
      const verb = tokens[0]!.toLowerCase();
      if (!READ_ONLY_VERBS.has(verb)) {
        return {
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

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

const app = express();

// Streamable HTTP (current standard) — one McpServer+transport per session.
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

  // POST — existing session or new session initialisation
  const sid = req.headers["mcp-session-id"] as string | undefined;
  if (sid && sessions.has(sid)) {
    await sessions.get(sid)!.handleRequest(req, res, req.body);
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

// Legacy SSE transport — kept for backwards compatibility with Cursor's
// current mcp.json which points to /sse. SSEServerTransport reads the raw
// request body itself, so express.json() must NOT run before /messages.
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

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    bundleReady,
    currentBundle: currentBundlePath,
    bundlesDir: BUNDLES_DIR,
    kubeconfig: KUBECONFIG_PATH,
    autoStartBundle: BUNDLE_PATH ?? null,
  });
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (BUNDLE_PATH) {
    if (!existsSync(BUNDLE_PATH)) {
      console.warn(
        `[MCP] BUNDLE_PATH is set to "${BUNDLE_PATH}" but the file was not found.`
      );
      console.warn(
        "[MCP] Starting MCP server anyway — use the start_bundle tool to load a bundle."
      );
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
