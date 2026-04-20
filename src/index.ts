import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { exec, spawn, type ChildProcess } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";

const execAsync = promisify(exec);

const KUBECONFIG_PATH = process.env.KUBECONFIG_PATH ?? "/tmp/kubeconfig";
const BUNDLE_PATH = process.env.BUNDLE_PATH;
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const PROXY_ADDRESS = process.env.PROXY_ADDRESS ?? "localhost:8080";

let bundleProcess: ChildProcess | null = null;
let bundleReady = false;

// ---------------------------------------------------------------------------
// kubectl helper
// ---------------------------------------------------------------------------

async function runKubectl(args: string): Promise<string> {
  if (!existsSync(KUBECONFIG_PATH)) {
    return "No kubeconfig found. Start a bundle first with the start_bundle tool.";
  }
  try {
    const { stdout, stderr } = await execAsync(
      `kubectl --kubeconfig=${KUBECONFIG_PATH} ${args}`,
      { timeout: 30_000 }
    );
    return (stdout || stderr).trim();
  } catch (err: unknown) {
    const e = err as { message: string; stderr?: string };
    return `Error: ${e.message}\n${e.stderr ?? ""}`.trim();
  }
}

// ---------------------------------------------------------------------------
// troubleshoot-live lifecycle
// ---------------------------------------------------------------------------

async function waitForCluster(maxWaitMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      await execAsync(
        `kubectl --kubeconfig=${KUBECONFIG_PATH} get namespaces`,
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

    bundleProcess = spawn(
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

    bundleProcess.stdout?.on("data", (d: Buffer) =>
      process.stdout.write(`[troubleshoot-live] ${d}`)
    );
    bundleProcess.stderr?.on("data", (d: Buffer) =>
      process.stderr.write(`[troubleshoot-live] ${d}`)
    );

    bundleProcess.on("error", reject);
    bundleProcess.on("exit", (code) => {
      bundleReady = false;
      bundleProcess = null;
      console.log(`[MCP] troubleshoot-live exited with code ${code}`);
    });

    // Give the process a moment to start before we begin polling
    setTimeout(resolve, 2_000);
  });
}

// ---------------------------------------------------------------------------
// MCP server + tools
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "troubleshoot-live-mcp",
  version: "1.0.0",
});

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

    await startBundle(bundle_path);
    console.log("[MCP] Waiting for Kubernetes API to become ready…");
    bundleReady = await waitForCluster();

    return {
      content: [
        {
          type: "text",
          text: bundleReady
            ? `troubleshoot-live started. Kubernetes API is ready at ${PROXY_ADDRESS}.`
            : "troubleshoot-live started but the API did not become ready within 2 minutes. Check container logs.",
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
          ? `Cluster is running at ${PROXY_ADDRESS}.\n\n${await runKubectl("get namespaces")}`
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
  async () => ({
    content: [{ type: "text", text: await runKubectl("get namespaces -o wide") }],
  })
);

server.tool(
  "get_nodes",
  "List nodes and their status/conditions.",
  {},
  async () => ({
    content: [{ type: "text", text: await runKubectl("get nodes -o wide") }],
  })
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
  async ({ namespace }) => ({
    content: [
      {
        type: "text",
        text: await runKubectl(
          `get pods ${namespace ? `-n ${namespace}` : "-A"} -o wide`
        ),
      },
    ],
  })
);

server.tool(
  "get_deployments",
  "List deployments, optionally filtered by namespace.",
  {
    namespace: z.string().optional().describe("Namespace. Omit for all namespaces."),
  },
  async ({ namespace }) => ({
    content: [
      {
        type: "text",
        text: await runKubectl(
          `get deployments ${namespace ? `-n ${namespace}` : "-A"} -o wide`
        ),
      },
    ],
  })
);

server.tool(
  "get_services",
  "List services, optionally filtered by namespace.",
  {
    namespace: z.string().optional().describe("Namespace. Omit for all namespaces."),
  },
  async ({ namespace }) => ({
    content: [
      {
        type: "text",
        text: await runKubectl(
          `get services ${namespace ? `-n ${namespace}` : "-A"} -o wide`
        ),
      },
    ],
  })
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
      .optional()
      .describe("Number of lines to return from the end of the log (default 100)"),
    previous: z
      .boolean()
      .optional()
      .describe("Return logs from the previously terminated container instance"),
  },
  async ({ pod, namespace, container, tail, previous }) => {
    const parts = [
      "logs",
      pod,
      `-n ${namespace}`,
      `--tail=${tail ?? 100}`,
      container ? `-c ${container}` : "",
      previous ? "--previous" : "",
    ].filter(Boolean);

    return {
      content: [{ type: "text", text: await runKubectl(parts.join(" ")) }],
    };
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
    let cmd = `get events ${namespace ? `-n ${namespace}` : "-A"} --sort-by=.lastTimestamp`;
    if (warning_only) cmd += " --field-selector type=Warning";
    return { content: [{ type: "text", text: await runKubectl(cmd) }] };
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
  async ({ kind, name, namespace }) => ({
    content: [
      {
        type: "text",
        text: await runKubectl(
          `describe ${kind} ${name} ${namespace ? `-n ${namespace}` : ""}`
        ),
      },
    ],
  })
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
    const nsFlag = namespace ? `-n ${namespace}` : name ? "" : "-A";
    const outputFlag = `-o ${output ?? "wide"}`;
    return {
      content: [
        {
          type: "text",
          text: await runKubectl(`get ${kind} ${name ?? ""} ${nsFlag} ${outputFlag}`),
        },
      ],
    };
  }
);

server.tool(
  "kubectl_run",
  "Run any read-only kubectl command. Do not include the 'kubectl' prefix in args.",
  {
    args: z
      .string()
      .describe(
        "kubectl arguments, e.g. 'get nodes -o yaml' or 'top pods -A' or 'api-resources'"
      ),
  },
  async ({ args }) => ({
    content: [{ type: "text", text: await runKubectl(args) }],
  })
);

// ---------------------------------------------------------------------------
// HTTP / SSE transport
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

const transports = new Map<string, SSEServerTransport>();

app.get("/sse", async (req: Request, res: Response) => {
  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);

  res.on("close", () => {
    transports.delete(transport.sessionId);
  });

  await server.connect(transport);
});

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
      await startBundle(BUNDLE_PATH);
      console.log("[MCP] Waiting for Kubernetes API to become ready…");
      bundleReady = await waitForCluster();
      if (bundleReady) {
        console.log("[MCP] Kubernetes API is ready.");
      } else {
        console.warn(
          "[MCP] Warning: Kubernetes API did not become ready within 2 minutes."
        );
      }
    }
  }

  app.listen(PORT, () => {
    console.log(`[MCP] Server listening on port ${PORT}`);
    console.log(`[MCP] Connect Cursor to: http://localhost:${PORT}/sse`);
    console.log(`[MCP] Health check:       http://localhost:${PORT}/health`);
  });
}

main().catch((err) => {
  console.error("[MCP] Fatal error:", err);
  process.exit(1);
});
