import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  bundleLoadError,
  bundleLoading,
  bundlePhase,
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
  MAX_UPLOAD_BYTES,
  PROXY_ADDRESS,
  UPLOAD_DIR,
  UPLOAD_TTL_MS,
} from "./config.js";
import { READ_ONLY_VERBS, runKubectl, tokenize } from "./kubectl.js";
import { errorResult, log, safeRun, textResult, type ToolResult } from "./log.js";
import { uploadBaseUrl } from "./request-context.js";
import { listBundleFiles, sanitizeFilename, shellQuote } from "./uploads.js";

const INSTRUCTIONS = [
  "WORKFLOW:",
  "1. Always call list_bundles first. If the bundle is present, go to step 3.",
  "2. Bundle on user machine: prepare_upload → run returned curl on user machine → pass path to start_bundle.",
  "3. start_bundle returns immediately. Poll cluster_status until status=ready. Do NOT inspect before then.",
  "4. First triage: cluster_overview (nodes, namespaces, not-ready pods, warnings — one call).",
  "5. All further queries: kubectl_run. Always pass --tail=N when fetching logs.",
  "6. When done: stop_bundle.",
  "",
  "RULES:",
  "- kubectl_run only: read-only verbs, no shell pipes — use --selector/--field-selector or the grep param.",
  "- Large responses (>200 KB) include a narrowing hint.",
  "- Do NOT run kubectl or troubleshoot-live directly on the user's machine.",
].join("\n");

// Per-phase poll hint surfaced through cluster_status.
const PHASE_HINTS: Record<string, string> = {
  spawning: "troubleshoot-live just started. Poll again in ~2s.",
  starting_apiserver:
    "envtest apiserver booting. ~5–15s warm; up to ~2min on first-ever run (one-off ~185 MB binary download). Poll every 5s.",
  importing:
    "apiserver up; importing bundle resources (CRDs, namespaces, pods, events). ~30s–2min for large bundles. Poll every 5–10s.",
  ready: "ready.",
  failed: "load failed. See bundleLoadError.",
  idle: "no bundle loaded.",
};

// Cluster-ready guard + error boundary for tool handlers.
async function readyTool(name: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  return safeRun(name, async () => requireReady() ?? (await fn()));
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
        "Use this when the user wants to investigate a support bundle that lives on their local machine and is not yet on the MCP server. BEFORE calling this, always call `list_bundles` first — the bundle may already be present, saving upload time. Returns a `curl` command to push the bundle from the user's machine to the MCP server's upload endpoint. Run that curl via your shell tool, then pass the returned path/name to `start_bundle`.",
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
        "Load a support bundle into the live cluster. Returns IMMEDIATELY with status='ready' (warm, already loaded) or status='loading' (apiserver not yet up). If status is 'loading', poll `cluster_status` every few seconds until it reports 'ready' before calling other inspection tools — `cluster_status` includes a `phase` field that tells you which stage is in flight. Pass: (a) a bare filename in /bundles, (b) an absolute path under /bundles, or (c) the path/name returned by `prepare_upload`. If the bundle lives only on the user's local machine, call `prepare_upload` FIRST.",
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
        `status=loading, phase=${bundlePhase}. Bundle '${resolved}' is starting. Poll cluster_status every few seconds until it reports ready before using other inspection tools.`,
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
        "Report the cluster's load state. Use this to poll after start_bundle. Returns one of: status=ready (use inspection tools now), status=loading (poll again in a few seconds; includes a `phase` field), status=failed (load crashed; includes reason), status=idle (no bundle loaded).",
    },
    async () => safeRun("cluster_status", async () => {
      if (bundleReady) {
        return textResult(
          `status=ready, phase=ready\nLoaded bundle: ${currentBundlePath}\n\n` +
            (await runKubectl(["get", "namespaces"])),
        );
      }
      if (bundleLoading) {
        return textResult(
          `status=loading, phase=${bundlePhase}\nLoading bundle: ${currentBundlePath}\n${PHASE_HINTS[bundlePhase]}`,
        );
      }
      if (bundleLoadError) {
        return errorResult(`status=failed, phase=failed\nLast load error:\n${bundleLoadError}`);
      }
      return textResult(
        "status=idle, phase=idle\nNo bundle loaded. Use list_bundles to see available bundles, then start_bundle to load one.",
      );
    }),
  );

  // ── Batched triage ─────────────────────────────────────────────────────

  server.registerTool(
    "cluster_overview",
    {
      description:
        "Batch tool: returns nodes, namespaces, not-ready pods across all namespaces, and recent Warning events in a single call. Use this FIRST for general triage — it saves 4 round-trips and caches all results for follow-up calls.",
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

  // ── Targeted queries ───────────────────────────────────────────────────

  server.registerTool(
    "kubectl_run",
    {
      description: `Run a read-only kubectl command. The first argument must be one of: ${[
        ...READ_ONLY_VERBS,
      ]
        .sort()
        .join(", ")}. Mutating verbs (apply, delete, edit, patch, exec, cp, drain, scale, etc.) are rejected. Do not include the 'kubectl' prefix. Shell pipes (|) and operators are NOT supported — use --selector, --field-selector, or the 'grep' parameter to filter output instead.`,
      inputSchema: {
        args: z
          .string()
          .min(1)
          .max(4096)
          .describe(
            "kubectl arguments, e.g. 'get nodes -o yaml' or 'top pods -A' or 'api-resources'",
          ),
        grep: z
          .string()
          .optional()
          .describe(
            "Filter output lines to those matching this string or regex pattern. Applied after kubectl runs. Use instead of shell pipes.",
          ),
        grep_ignore_case: z
          .boolean()
          .optional()
          .describe("If true, the grep filter is case-insensitive (default false)."),
      },
    },
    async ({ args, grep, grep_ignore_case }) => readyTool("kubectl_run", async () => {
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
      let output = await runKubectl(tokens);
      if (grep) {
        let pattern: RegExp;
        try {
          pattern = new RegExp(grep, grep_ignore_case ? "i" : "");
        } catch {
          return errorResult(`Invalid grep pattern: ${grep}`);
        }
        const lines = output.split("\n");
        const filtered = lines.filter((line) => pattern.test(line));
        output = filtered.length > 0 ? filtered.join("\n") : "(no lines matched filter)";
      }
      return textResult(output);
    }),
  );

  server.registerTool(
    "help",
    {
      description:
        "Return the recommended workflow and usage notes for this MCP server. Call this if you are unsure which tool to use next or want to review the investigation workflow.",
    },
    async () => safeRun("help", async () => textResult(INSTRUCTIONS)),
  );

  return server;
}
