import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  availableKinds,
  bundleExists,
  bundleLoadError,
  bundleLoadStartedAt,
  bundleLoading,
  bundleOverview,
  bundlePhase,
  bundlePhaseStartedAt,
  bundleReady,
  currentBundlePath,
  isBundleActive,
  queryResources,
  readPodLogs,
  requireReady,
  resolveBundlePath,
  startBundle,
  stopBundle,
} from "./bundle.js";
import {
  BUNDLES_DIR,
  MAX_UPLOAD_BYTES,
  RESPONSE_SOFT_LIMIT_BYTES,
  UPLOAD_DIR,
  UPLOAD_TTL_MS,
} from "./config.js";
import { errorResult, log, safeRun, textResult, type ToolResult } from "./log.js";
import { uploadBaseUrl } from "./request-context.js";
import { cmdQuote, listBundleFiles, posixShellQuote, sanitizeFilename } from "./uploads.js";

const INSTRUCTIONS = [
  "WORKFLOW:",
  "1. Call list_bundles. If the requested bundle is absent, use prepare_upload and run its returned command.",
  "2. Call start_bundle. If it reports loading, poll cluster_status until ready.",
  "3. Use cluster_overview first for general triage.",
  "4. Use resource_query for Kubernetes objects and pod_logs for container logs.",
  "5. Use full=true only when the complete object is needed; narrow by namespace/name/labels/fields.",
  "6. Call stop_bundle when done.",
  "",
  "The tools read the immutable support bundle directly. There is no live cluster and no kubectl.",
].join("\n");

const elapsedSeconds = (since: number | null): number =>
  since === null ? 0 : Math.max(0, Math.round((Date.now() - since) / 1000));

const withSizeHint = (text: string): string => {
  if (Buffer.byteLength(text) <= RESPONSE_SOFT_LIMIT_BYTES) return text;
  return `${text}\n\n[note: large response; narrow resource_query by namespace, name, labels, or fields.]`;
};

async function readyTool(name: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  return safeRun(name, async () => requireReady() ?? await fn());
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "support-bundle-mcp", version: "2.0.0" },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "prepare_upload",
    {
      description:
        "Prepare an upload command for a support bundle on the user's machine. Call list_bundles first.",
      inputSchema: {
        local_path: z.string().describe("Absolute local path to a .tar.gz, .tgz, or .tar bundle."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ local_path }) => safeRun("prepare_upload", async () => {
      const base = local_path.replace(/^.*[\\/]/, "");
      const safe = sanitizeFilename(base);
      if (!safe) {
        return errorResult(
          `Cannot derive a safe filename from '${base}'. Rename it to use only letters, digits, '.', '-', or '_' and a .tar.gz, .tgz, or .tar suffix.`,
        );
      }
      const url = `${uploadBaseUrl().replace(/\/+$/, "")}/bundles/upload/${encodeURIComponent(safe)}`;
      return textResult(JSON.stringify({
        schemaVersion: 2,
        commands: {
          windows: { shell: `curl.exe -fsS --upload-file ${cmdQuote(local_path)} ${cmdQuote(url)}` },
          unix: { sh: `curl -fsS --upload-file ${posixShellQuote(local_path)} ${posixShellQuote(url)}` },
        },
        uploadUrl: url,
        limits: { maxSizeBytes: MAX_UPLOAD_BYTES, ttlMs: UPLOAD_TTL_MS },
      }));
    }),
  );

  server.registerTool(
    "list_bundles",
    {
      description: `List support bundles available under ${BUNDLES_DIR}.`,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => safeRun("list_bundles", async () => {
      const files = listBundleFiles();
      if (files.length === 0) {
        return textResult(
          `No bundles found in ${BUNDLES_DIR}. Use prepare_upload for a bundle on the user's machine.`,
        );
      }
      return textResult([
        "PATH\tSIZE\tMODIFIED",
        ...files.map((file) => {
          const active = file.path === currentBundlePath ? "\tactive" : "";
          return `${file.path}\t${(file.sizeBytes / 1024 / 1024).toFixed(1)} MB\t${file.modified}${active}`;
        }),
      ].join("\n"));
    }),
  );

  server.registerTool(
    "start_bundle",
    {
      description:
        "Open and index a support bundle. Returns immediately; poll cluster_status when status=loading.",
      inputSchema: {
        bundle_path: z.string().describe("Bundle filename, or an absolute path returned by upload."),
      },
    },
    async ({ bundle_path }) => safeRun("start_bundle", async () => {
      let resolved: string;
      try {
        resolved = resolveBundlePath(bundle_path);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
      if (!bundleExists(resolved)) {
        return errorResult(
          `Bundle not found at ${resolved}. Use list_bundles or prepare_upload first.`,
        );
      }
      if (currentBundlePath === resolved && bundleReady) {
        return textResult(`status=ready. Bundle '${resolved}' is already open.`);
      }
      if (currentBundlePath === resolved && bundleLoading) {
        return textResult(`status=loading, phase=${bundlePhase}. Poll cluster_status.`);
      }
      if (isBundleActive()) {
        log(`[MCP] Switching bundles: '${currentBundlePath}' -> '${resolved}'`);
        await stopBundle();
      }
      const status = await startBundle(resolved);
      return status === "ready"
        ? textResult(`status=ready. Bundle '${resolved}' opened from cache.`)
        : textResult(`status=loading, phase=${bundlePhase}. Poll cluster_status until ready.`);
    }),
  );

  server.registerTool(
    "stop_bundle",
    { description: "Close the active support bundle." },
    async () => safeRun("stop_bundle", async () => {
      if (!isBundleActive()) return textResult("No bundle is currently open.");
      const path = currentBundlePath;
      await stopBundle();
      return textResult(`Closed bundle '${path}'.`);
    }),
  );

  server.registerTool(
    "cluster_status",
    {
      description: "Report bundle extraction/indexing state and available resource kinds.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => safeRun("cluster_status", async () => {
      if (bundleReady) {
        return textResult(
          `status=ready, phase=ready\nBundle: ${currentBundlePath}\nKinds: ${availableKinds().join(", ")}`,
        );
      }
      if (bundleLoading) {
        return textResult(
          `status=loading, phase=${bundlePhase}, elapsed=${elapsedSeconds(bundleLoadStartedAt)}s, ` +
          `phaseElapsed=${elapsedSeconds(bundlePhaseStartedAt)}s\nBundle: ${currentBundlePath}`,
        );
      }
      if (bundleLoadError) return errorResult(`status=failed\n${bundleLoadError}`);
      return textResult("status=idle, phase=idle\nUse list_bundles, then start_bundle.");
    }),
  );

  server.registerTool(
    "cluster_overview",
    {
      description:
        "First-pass triage: nodes, namespaces, not-ready pods, Warning events, and parse diagnostics.",
      inputSchema: {
        warning_event_limit: z.number().int().positive().max(500).optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ warning_event_limit }) => readyTool("cluster_overview", async () =>
      textResult(withSizeHint(JSON.stringify(await bundleOverview(warning_event_limit ?? 50), null, 2)))),
  );

  server.registerTool(
    "resource_query",
    {
      description:
        "Query Kubernetes resources directly from the bundle. Exact structured filters replace kubectl syntax. Summary output is default; use full=true for complete objects.",
      inputSchema: {
        kind: z.string().min(1).describe("Resource kind, e.g. Pod, Deployment, Event, or a CR kind."),
        api_version: z.string().optional(),
        namespace: z.string().optional(),
        name: z.string().optional(),
        labels: z.record(z.string()).optional().describe("Exact metadata label matches."),
        fields: z.record(z.string()).optional().describe("Exact dot-path matches, e.g. status.phase."),
        limit: z.number().int().positive().max(500).optional(),
        full: z.boolean().optional().describe("Return complete collected objects instead of summaries."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ kind, api_version, namespace, name, labels, fields, limit, full }) =>
      readyTool("resource_query", async () => {
        try {
          const result = await queryResources({
            kind,
            apiVersion: api_version,
            namespace,
            name,
            labels,
            fields,
            limit,
            full,
          });
          return textResult(withSizeHint(JSON.stringify(result, null, 2)));
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      }),
  );

  server.registerTool(
    "pod_logs",
    {
      description: "Read collected container logs from either standard support-bundle log layout.",
      inputSchema: {
        namespace: z.string().min(1),
        pod: z.string().min(1),
        container: z.string().min(1),
        tail: z.number().int().positive().max(10_000).optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ namespace, pod, container, tail }) => readyTool("pod_logs", async () => {
      try {
        return textResult(withSizeHint(await readPodLogs(namespace, pod, container, tail ?? 200)));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }),
  );

  return server;
}
