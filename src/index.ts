import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { execFile, spawn, type ChildProcess } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";

const execFileAsync = promisify(execFile);

const KUBECONFIG_PATH = process.env.KUBECONFIG_PATH ?? "/tmp/kubeconfig";
const BUNDLE_PATH = process.env.BUNDLE_PATH;
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const PROXY_ADDRESS = process.env.PROXY_ADDRESS ?? "localhost:8080";
const KUBECTL_TIMEOUT_MS = parseInt(process.env.KUBECTL_TIMEOUT_MS ?? "30000", 10);
const CLUSTER_READY_TIMEOUT_MS = parseInt(
  process.env.CLUSTER_READY_TIMEOUT_MS ?? "120000",
  10
);

let bundleProcess: ChildProcess | null = null;
let bundleReady = false;

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
  while (Date.now() < deadline) {
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

function stopBundle(): void {
  if (!bundleProcess) return;
  console.log("[MCP] Stopping troubleshoot-live…");
  bundleProcess.kill("SIGTERM");
  // Best-effort SIGKILL fallback if it doesn't die in 5s.
  const child = bundleProcess;
  setTimeout(() => {
    if (!child.killed) child.kill("SIGKILL");
  }, 5_000).unref();
}

// ---------------------------------------------------------------------------
// MCP server + tools
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "troubleshoot-live-mcp",
  version: "1.0.0",
});

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

// --- Bundle lifecycle ---

server.tool(
  "start_bundle",
  "Start troubleshoot-live with a support bundle file. Call this first if the server did not auto-start with BUNDLE_PATH.",
  {
    bundle_path: z
      .string()
      .describe(
        "Absolute path to the support bundle .tar.gz inside the container (e.g. /bundles/my-bundle.tar.gz)"
      ),
  },
  async ({ bundle_path }) => {
    if (bundleProcess) {
      return {
        content: [
          {
            type: "text",
            text: "troubleshoot-live is already running. Restart the container to load a different bundle.",
          },
        ],
      };
    }
    if (!existsSync(bundle_path)) {
      return {
        content: [{ type: "text", text: `Bundle file not found at path: ${bundle_path}` }],
      };
    }

    try {
      await startBundle(bundle_path);
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
            ? `troubleshoot-live started. Kubernetes API is ready at ${PROXY_ADDRESS}.`
            : "troubleshoot-live started but the API did not become ready in time. Check container logs.",
        },
      ],
    };
  }
);

server.tool(
  "cluster_status",
  "Check whether the troubleshoot-live cluster is running and responsive. Returns namespace list on success.",
  {},
  async () => ({
    content: [
      {
        type: "text",
        text: bundleReady
          ? `Cluster is running at ${PROXY_ADDRESS}.\n\n${await runKubectl(["get", "namespaces"])}`
          : "Cluster is not running. Use start_bundle to load a support bundle.",
      },
    ],
  })
);

// --- Namespace & node overview ---

server.tool(
  "list_namespaces",
  "List all namespaces in the support bundle cluster.",
  {},
  async () =>
    requireReady() ?? {
      content: [{ type: "text", text: await runKubectl(["get", "namespaces", "-o", "wide"]) }],
    }
);

server.tool(
  "get_nodes",
  "List nodes and their status/conditions.",
  {},
  async () =>
    requireReady() ?? {
      content: [{ type: "text", text: await runKubectl(["get", "nodes", "-o", "wide"]) }],
    }
);

// --- Workloads ---

server.tool(
  "get_pods",
  "List pods, optionally filtered by namespace.",
  {
    namespace: z
      .string()
      .optional()
      .describe("Kubernetes namespace. Omit to list across all namespaces."),
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

server.tool(
  "get_deployments",
  "List deployments, optionally filtered by namespace.",
  {
    namespace: z.string().optional().describe("Namespace. Omit for all namespaces."),
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

server.tool(
  "get_services",
  "List services, optionally filtered by namespace.",
  {
    namespace: z.string().optional().describe("Namespace. Omit for all namespaces."),
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

server.tool(
  "get_pod_logs",
  "Get logs from a specific pod container.",
  {
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

server.tool(
  "get_events",
  "Get Kubernetes events sorted by time. Useful for spotting warnings and failures.",
  {
    namespace: z
      .string()
      .optional()
      .describe("Namespace to scope events to. Omit for all namespaces."),
    warning_only: z
      .boolean()
      .optional()
      .describe("If true, show only Warning events (filters out Normal)"),
  },
  async ({ namespace, warning_only }) => {
    const ready = requireReady();
    if (ready) return ready;
    const args = [
      "get",
      "events",
      ...nsArgs(namespace),
      "--sort-by=.lastTimestamp",
    ];
    if (warning_only) args.push("--field-selector=type=Warning");
    return { content: [{ type: "text", text: await runKubectl(args) }] };
  }
);

// --- Generic describe / get ---

server.tool(
  "describe_resource",
  "Describe any Kubernetes resource (equivalent to kubectl describe). Great for seeing status, conditions, and recent events.",
  {
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

server.tool(
  "get_resource",
  "Get any Kubernetes resource with a configurable output format.",
  {
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
  async ({ kind, name, namespace, output }) => {
    const ready = requireReady();
    if (ready) return ready;
    const args = ["get", kind];
    if (name) args.push(name);
    // When asking for a specific named resource without a namespace, don't add -A.
    if (namespace) args.push("-n", namespace);
    else if (!name) args.push("-A");
    args.push("-o", output ?? "wide");
    return { content: [{ type: "text", text: await runKubectl(args) }] };
  }
);

server.tool(
  "kubectl_run",
  `Run a read-only kubectl command. The first argument must be one of: ${[
    ...READ_ONLY_VERBS,
  ]
    .sort()
    .join(", ")}. Mutating verbs (apply, delete, edit, patch, exec, cp, drain, scale, etc.) are rejected. Do not include the 'kubectl' prefix.`,
  {
    args: z
      .string()
      .describe(
        "kubectl arguments, e.g. 'get nodes -o yaml' or 'top pods -A' or 'api-resources'"
      ),
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

// ---------------------------------------------------------------------------
// HTTP / SSE transport
// ---------------------------------------------------------------------------

const app = express();

const transports = new Map<string, SSEServerTransport>();

app.get("/sse", async (_req: Request, res: Response) => {
  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);

  res.on("close", () => {
    transports.delete(transport.sessionId);
  });

  await server.connect(transport);
});

// IMPORTANT: do NOT install express.json() globally — SSEServerTransport reads
// the raw request stream itself. Mounting a JSON body parser before this route
// would consume the body and hang every tool call.
app.post("/messages", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports.get(sessionId);
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
    kubeconfig: KUBECONFIG_PATH,
    bundlePath: BUNDLE_PATH ?? null,
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
    console.log(`[MCP] Connect Cursor to: http://localhost:${PORT}/sse`);
    console.log(`[MCP] Health check:       http://localhost:${PORT}/health`);
  });

  const shutdown = (signal: string) => {
    console.log(`[MCP] Received ${signal}, shutting down…`);
    stopBundle();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[MCP] Fatal error:", err);
  process.exit(1);
});
