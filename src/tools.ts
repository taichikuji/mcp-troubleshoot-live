import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";

import {
  bundleLoadError,
  bundleLoading,
  bundleReady,
  currentBundlePath,
  isBundleProcessRunning,
  markFailed,
  markLoading,
  markReady,
  requireReady,
  resolveBundlePath,
  startBundle,
  stopBundle,
  waitForCluster,
} from "./bundle.js";
import {
  BUNDLES_DIR,
  CLUSTER_READY_TIMEOUT_MS,
  MAX_UPLOAD_BYTES,
  PROXY_ADDRESS,
  UPLOAD_DIR,
  UPLOAD_TTL_MS,
} from "./config.js";
import { nsArgs, READ_ONLY_VERBS, runKubectl, tokenize } from "./kubectl.js";
import { errorResult, log, safeRun, textResult, type ToolResult } from "./log.js";
import { kindSchema, namespaceSchema, resourceNameSchema, sinceSchema } from "./schemas.js";
import { uploadBaseUrl } from "./request-context.js";
import { listBundleFiles, sanitizeFilename, shellQuote } from "./uploads.js";

const INSTRUCTIONS = [
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
  "4. Once ready, prefer `cluster_overview` for the first triage pass — it batches",
  "   nodes, namespaces, not-ready pods, and Warning events in one call. Then drill",
  "   in with `get_pod_logs`, `describe_resource`, `kubectl_run`, etc.",
  "5. When done, call `stop_bundle`. Uploaded bundles are deleted from the server then;",
  "   bundles that lived under /bundles are left alone.",
  "",
  "PERFORMANCE NOTES:",
  "- The loaded bundle is immutable; kubectl results are cached for 5 minutes by",
  "  default (KUBECTL_CACHE_TTL_MS). Repeating the same query within the TTL is free.",
  "  The cache is cleared automatically when the bundle changes.",
  "- Use `cluster_overview` for general health checks; it replaces 3–4 separate calls",
  "  and runs the underlying kubectls in parallel.",
  "- Per-call kubectl timeout is 30 s; transient connection errors retry up to 4×.",
  "- `kubectl_run` accepts at most 64 tokens / 4096 chars and only read-only verbs",
  "  (get, describe, logs, top, explain, api-resources, api-versions, version,",
  "  cluster-info, config, auth, events, wait).",
  "- Responses larger than 200 KB include a hint to narrow the query (with",
  "  --selector, --field-selector, -n, or a single resource name).",
  "",
  "Do NOT run troubleshoot-live or kubectl directly on the user's machine; this MCP",
  "owns the live cluster.",
].join("\n");

// Cluster-ready guard + error boundary for tool handlers.
async function readyTool(name: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  return safeRun(name, async () => requireReady() ?? (await fn()));
}

// Registers a kubectl tool with an optional namespace param, cutting boilerplate.
type KubectlToolOpts<S extends ZodRawShape> = {
  description: string;
  inputSchema?: S;
  buildArgs: (params: z.infer<z.ZodObject<S>>) => string[];
};
function registerKubectlTool<S extends ZodRawShape>(
  server: McpServer,
  name: string,
  opts: KubectlToolOpts<S>,
): void {
  server.registerTool(
    name,
    {
      description: opts.description,
      ...(opts.inputSchema ? { inputSchema: opts.inputSchema } : {}),
    },
    // Cast needed: SDK doesn't export the generic cleanly; Zod still validates at runtime.
    (async (params: z.infer<z.ZodObject<S>>) =>
      readyTool(name, async () => textResult(await runKubectl(opts.buildArgs(params))))) as never,
  );
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "troubleshoot-live-mcp", version: "1.0.0" },
    { instructions: INSTRUCTIONS },
  );

  // ── Lifecycle / discovery ──────────────────────────────────────────────

  server.registerTool(
    "prepare_upload",
    {
      description:
        "Use this FIRST when the user wants to investigate a support bundle that lives on their local machine and is not yet on the MCP server. Returns a `curl` command to push the bundle from the user's machine to the MCP server's upload endpoint. Run that curl via your shell tool, then pass the returned path/name to `start_bundle`. If the bundle already lives in the server's bundles directory, skip this and use `list_bundles` + `start_bundle` instead.",
      inputSchema: {
        local_path: z
          .string()
          .describe(
            "Absolute path to the support bundle on the user's local machine (e.g. /Users/alice/Downloads/foo.tar.gz).",
          ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ local_path }) => safeRun("prepare_upload", async () => {
      const base = local_path.replace(/^.*[\\/]/, "");
      const safe = sanitizeFilename(base);
      if (!safe) {
        return errorResult(
          `Cannot derive a safe filename from '${base}'. The bundle filename must end in .tar.gz, .tgz, or .tar and contain only letters, digits, '.', '-', '_'. Rename the file locally and retry.`,
        );
      }
      const url = `${uploadBaseUrl().replace(/\/+$/, "")}/bundles/upload/${encodeURIComponent(safe)}`;
      const cmd = `curl -fsS --upload-file ${shellQuote(local_path)} ${shellQuote(url)}`;
      const ttlH = Math.round(UPLOAD_TTL_MS / 3_600_000);
      const maxGb = (MAX_UPLOAD_BYTES / (1024 * 1024 * 1024)).toFixed(1);
      return textResult([
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
      ].join("\n"));
    }),
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
            "Filename in /bundles (e.g. 'support-2025-04-01.tar.gz'), absolute path under /bundles, or the 'path'/'name' returned by prepare_upload.",
          ),
      },
    },
    async ({ bundle_path }) => safeRun("start_bundle", async () => {
      let resolved: string;
      try {
        resolved = resolveBundlePath(bundle_path);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
      const fs = await import("fs");
      if (!fs.existsSync(resolved)) {
        return errorResult([
          `Bundle file not found on the MCP server at: ${resolved}`,
          "",
          "Next steps:",
          `  - If the bundle is on the user's local machine, call prepare_upload first`,
          `    (returns a curl command that uploads it to ${UPLOAD_DIR}).`,
          `  - If the bundle should already be on the server, call list_bundles to see`,
          `    what's actually available in ${BUNDLES_DIR}.`,
        ].join("\n"));
      }

      if (isBundleProcessRunning()) {
        if (currentBundlePath === resolved && bundleReady) {
          return textResult(`status=ready. Bundle '${resolved}' is already loaded at ${PROXY_ADDRESS}.`);
        }
        if (currentBundlePath === resolved && bundleLoading) {
          return textResult(
            `status=loading. Bundle '${resolved}' is already being loaded. Poll cluster_status every few seconds until it reports ready.`,
          );
        }
        log(`[MCP] Switching bundles: '${currentBundlePath}' → '${resolved}'`);
        await stopBundle();
      }

      markLoading();
      try {
        // Resolves after the 2s grace period; child keeps running in background.
        await startBundle(resolved);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        markFailed(msg);
        return errorResult(`Failed to start troubleshoot-live: ${msg}`);
      }

      // Watch in background so we return immediately and avoid tool-call timeouts.
      const startedFor = resolved;
      void (async () => {
        log("[MCP] Waiting for Kubernetes API to become ready…");
        const ok = await waitForCluster();
        markReady(ok, startedFor);
      })();

      return textResult(
        `status=loading. Bundle '${resolved}' is starting. Poll cluster_status every few seconds until it reports ready before using other inspection tools.`,
      );
    }),
  );

  server.registerTool(
    "stop_bundle",
    {
      description:
        "Unload the currently loaded support bundle and shut down the in-memory cluster. The MCP server itself stays up.",
    },
    async () => safeRun("stop_bundle", async () => {
      if (!isBundleProcessRunning()) {
        return textResult("No bundle is currently loaded.");
      }
      const wasLoaded = currentBundlePath;
      await stopBundle();
      return textResult(`Unloaded bundle '${wasLoaded}'. Use start_bundle to load another.`);
    }),
  );

  server.registerTool(
    "list_bundles",
    {
      description: `List support bundles available under ${BUNDLES_DIR}. Returns filenames you can pass to start_bundle.`,
    },
    async () => safeRun("list_bundles", async () => {
      const files = listBundleFiles();
      if (files.length === 0) {
        return textResult(
          `No bundles found in ${BUNDLES_DIR}.\n` +
            `If the user has a bundle on their local machine, call prepare_upload to ` +
            `upload it. Otherwise drop .tar.gz support bundles into the host directory ` +
            `mounted at ${BUNDLES_DIR}.`,
        );
      }
      const lines = files.map((f) => {
        const sizeMb = (f.sizeBytes / 1024 / 1024).toFixed(1);
        const active = f.path === currentBundlePath ? "  ← currently loaded" : "";
        return `${f.path}\t${sizeMb} MB\t${f.modified}${active}`;
      });
      return textResult([
        `Found ${files.length} bundle(s) in ${BUNDLES_DIR}:`,
        "",
        "PATH\tSIZE\tMODIFIED",
        ...lines,
      ].join("\n"));
    }),
  );

  server.registerTool(
    "cluster_status",
    {
      description:
        "Report the cluster's load state. Use this to poll after start_bundle. Returns one of: status=ready (use inspection tools now), status=loading (poll again in a few seconds), status=failed (load crashed; includes reason), status=idle (no bundle loaded).",
    },
    async () => safeRun("cluster_status", async () => {
      if (bundleReady) {
        return textResult(
          `status=ready\nLoaded bundle: ${currentBundlePath}\n\n` +
            (await runKubectl(["get", "namespaces"])),
        );
      }
      if (bundleLoading) {
        return textResult(
          `status=loading\nLoading bundle: ${currentBundlePath}\nPoll cluster_status again in a few seconds. Cold loads can take 1–3 minutes.`,
        );
      }
      if (bundleLoadError) {
        return errorResult(`status=failed\nLast load error:\n${bundleLoadError}`);
      }
      return textResult(
        "status=idle\nNo bundle loaded. Use list_bundles to see available bundles, then start_bundle to load one.",
      );
    }),
  );

  // ── Batched triage ─────────────────────────────────────────────────────

  server.registerTool(
    "cluster_overview",
    {
      description:
        "Batch tool: returns nodes, namespaces, not-ready pods across all namespaces, and recent Warning events in a single call. Use this FIRST for general triage instead of running list_namespaces + get_nodes + get_pods + get_events separately. Saves 3+ round-trips and caches all four results for follow-up calls.",
      inputSchema: {
        warning_event_limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Cap on Warning events to include (default 50)."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ warning_event_limit }) => readyTool("cluster_overview", async () => {
      const [nodes, namespaces, notReadyPods, warnEvents] = await Promise.all([
        runKubectl(["get", "nodes", "-o", "wide"]),
        runKubectl(["get", "namespaces"]),
        runKubectl([
          "get", "pods", "-A", "-o", "wide",
          "--field-selector=status.phase!=Running,status.phase!=Succeeded",
        ]),
        runKubectl([
          "get", "events", "-A",
          "--field-selector=type=Warning",
          "--sort-by=.lastTimestamp",
        ]),
      ]);
      const cap = warning_event_limit ?? 50;
      // Keep the header row and last `cap` data rows; slicing from the end alone would drop the header.
      const warnLines = warnEvents.split("\n");
      const [warnHeader, ...warnRows] = warnLines;
      const trimmedWarn =
        warnRows.length <= cap
          ? warnEvents
          : [warnHeader, ...warnRows.slice(-cap)].join("\n");
      return textResult([
        "=== NODES ===",
        nodes,
        "",
        "=== NAMESPACES ===",
        namespaces,
        "",
        "=== NOT-READY PODS (all namespaces) ===",
        notReadyPods || "(none)",
        "",
        `=== WARNING EVENTS (last ${cap}) ===`,
        trimmedWarn || "(none)",
      ].join("\n"));
    }),
  );

  // ── Standard kubectl read tools ────────────────────────────────────────

  registerKubectlTool(server, "list_namespaces", {
    description: "List all namespaces in the support bundle cluster.",
    buildArgs: () => ["get", "namespaces", "-o", "wide"],
  });

  registerKubectlTool(server, "get_nodes", {
    description: "List nodes and their status/conditions.",
    buildArgs: () => ["get", "nodes", "-o", "wide"],
  });

  registerKubectlTool(server, "get_pods", {
    description: "List pods, optionally filtered by namespace.",
    inputSchema: {
      namespace: namespaceSchema
        .optional()
        .describe("Kubernetes namespace. Omit to list across all namespaces."),
    },
    buildArgs: ({ namespace }) => ["get", "pods", ...nsArgs(namespace), "-o", "wide"],
  });

  registerKubectlTool(server, "get_deployments", {
    description: "List deployments, optionally filtered by namespace.",
    inputSchema: {
      namespace: namespaceSchema.optional().describe("Namespace. Omit for all namespaces."),
    },
    buildArgs: ({ namespace }) => ["get", "deployments", ...nsArgs(namespace), "-o", "wide"],
  });

  registerKubectlTool(server, "get_services", {
    description: "List services, optionally filtered by namespace.",
    inputSchema: {
      namespace: namespaceSchema.optional().describe("Namespace. Omit for all namespaces."),
    },
    buildArgs: ({ namespace }) => ["get", "services", ...nsArgs(namespace), "-o", "wide"],
  });

  registerKubectlTool(server, "get_pod_logs", {
    description: "Get logs from a specific pod container.",
    inputSchema: {
      pod: resourceNameSchema.describe("Pod name"),
      namespace: namespaceSchema.describe("Namespace the pod lives in"),
      container: resourceNameSchema
        .optional()
        .describe("Container name (required only for multi-container pods)"),
      tail: z
        .number()
        .int()
        .positive()
        .max(100_000)
        .optional()
        .describe("Number of lines to return from the end of the log (default 100, max 100000)"),
      previous: z
        .boolean()
        .optional()
        .describe("Return logs from the previously terminated container instance"),
      since: sinceSchema
        .optional()
        .describe("Only return logs newer than a relative duration like 5s, 2m, or 3h"),
      timestamps: z
        .boolean()
        .optional()
        .describe("Include RFC3339 timestamps on each log line"),
    },
    buildArgs: ({ pod, namespace, container, tail, previous, since, timestamps }) => {
      const args = ["logs", pod, "-n", namespace, `--tail=${tail ?? 100}`];
      if (container) args.push("-c", container);
      if (previous) args.push("--previous");
      if (since) args.push(`--since=${since}`);
      if (timestamps) args.push("--timestamps");
      return args;
    },
  });

  registerKubectlTool(server, "get_events", {
    description: "Get Kubernetes events sorted by time. Useful for spotting warnings and failures.",
    inputSchema: {
      namespace: namespaceSchema
        .optional()
        .describe("Namespace to scope events to. Omit for all namespaces."),
      warning_only: z
        .boolean()
        .optional()
        .describe("If true, show only Warning events (filters out Normal)"),
    },
    buildArgs: ({ namespace, warning_only }) => {
      const args = ["get", "events", ...nsArgs(namespace), "--sort-by=.lastTimestamp"];
      if (warning_only) args.push("--field-selector=type=Warning");
      return args;
    },
  });

  registerKubectlTool(server, "describe_resource", {
    description:
      "Describe any Kubernetes resource (equivalent to kubectl describe). Great for seeing status, conditions, and recent events.",
    inputSchema: {
      kind: kindSchema.describe(
        "Resource kind (e.g. pod, deployment, service, configmap, node, persistentvolumeclaim)",
      ),
      name: resourceNameSchema.describe("Resource name"),
      namespace: namespaceSchema
        .optional()
        .describe("Namespace (not needed for cluster-scoped resources like nodes)"),
    },
    buildArgs: ({ kind, name, namespace }) => ["describe", kind, name, ...nsArgs(namespace, false)],
  });

  registerKubectlTool(server, "get_resource", {
    description: "Get any Kubernetes resource with a configurable output format.",
    inputSchema: {
      kind: kindSchema.describe(
        "Resource kind or plural (e.g. pods, configmaps, secrets, nodes, persistentvolumes, replicasets)",
      ),
      name: resourceNameSchema.optional().describe("Specific resource name (omit to list all)"),
      namespace: namespaceSchema
        .optional()
        .describe("Namespace (omit for cluster-scoped resources or to list all namespaces)"),
      output: z
        .enum(["wide", "yaml", "json", "name"])
        .optional()
        .describe("Output format (default: wide)"),
    },
    buildArgs: ({ kind, name, namespace, output }) => {
      const args = ["get", kind];
      if (name) args.push(name);
      if (namespace) args.push("-n", namespace);
      else if (!name) args.push("-A");
      args.push("-o", output ?? "wide");
      return args;
    },
  });

  // ── Power-user escape hatch ────────────────────────────────────────────

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
          .min(1)
          .max(4096)
          .describe(
            "kubectl arguments, e.g. 'get nodes -o yaml' or 'top pods -A' or 'api-resources'",
          ),
      },
    },
    async ({ args }) => readyTool("kubectl_run", async () => {
      let tokens: string[];
      try {
        tokens = tokenize(args);
      } catch (err) {
        return errorResult(`Error parsing args: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (tokens.length === 0) {
        return errorResult("Error: no kubectl command provided");
      }
      if (tokens.length > 64) {
        return errorResult("Error: too many arguments (max 64).");
      }
      const verb = tokens[0]!.toLowerCase();
      if (!READ_ONLY_VERBS.has(verb)) {
        return errorResult(
          `Refused: '${verb}' is not in the read-only allowlist. Allowed verbs: ${[
            ...READ_ONLY_VERBS,
          ]
            .sort()
            .join(", ")}.`,
        );
      }
      return textResult(await runKubectl(tokens));
    }),
  );

  return server;
}
