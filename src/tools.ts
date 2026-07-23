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
  listBundleContents,
  queryResources,
  queryPodLogs,
  readBundleContents,
  requireReady,
  resourceCatalog,
  resolveBundlePath,
  searchBundleContents,
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
  "OPEN: list_bundles -> prepare_upload if absent -> start_bundle -> cluster_status until ready.",
  "TRIAGE: cluster_overview first.",
  "DETAIL: resource_query or pod_logs. Use resource_catalog only if kind is unknown; bundle_files last.",
  "PAGE: follow nextOffset/nextLineOffset. Use full=true only when needed.",
  "FINISH: stop_bundle. Data is a static snapshot, not a live cluster.",
].join("\n");

const elapsedSeconds = (since: number | null): number =>
  since === null ? 0 : Math.max(0, Math.round((Date.now() - since) / 1000));

const boundedResult = (text: string): ToolResult => {
  const bytes = Buffer.byteLength(text);
  if (bytes <= RESPONSE_SOFT_LIMIT_BYTES) return textResult(text);
  return errorResult(
    `Response is ${Math.ceil(bytes / 1024)} KB, above the ` +
    `${Math.ceil(RESPONSE_SOFT_LIMIT_BYTES / 1024)} KB safety limit. Narrow the query.`,
  );
};

const labelSelectorSchema = {
  labels: z.record(z.string()).optional().describe("Exact metadata label matches."),
  label_in: z.record(z.array(z.string()).min(1)).optional(),
  label_not_in: z.record(z.array(z.string()).min(1)).optional(),
  label_exists: z.array(z.string().min(1)).optional(),
  label_not_exists: z.array(z.string().min(1)).optional(),
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
        "Return upload commands for a local support bundle missing from list_bundles.",
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
      description: `List support-bundle paths available under ${BUNDLES_DIR}.`,
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
        "Open and index one bundle. If status=loading, poll cluster_status.",
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
        return textResult(`status=ready, next=cluster_overview\nBundle: ${resolved}`);
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
        ? textResult(`status=ready, next=cluster_overview\nBundle: ${resolved}`)
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
      description: "Check bundle loading state. Poll after start_bundle until status=ready.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => safeRun("cluster_status", async () => {
      if (bundleReady) {
        return textResult(
          `status=ready, phase=ready, next=cluster_overview\nBundle: ${currentBundlePath}\n` +
          `Collected kinds: ${availableKinds().length}`,
        );
      }
      if (bundleLoading) {
        return textResult(
          `status=loading, phase=${bundlePhase}, elapsed=${elapsedSeconds(bundleLoadStartedAt)}s, ` +
          `phaseElapsed=${elapsedSeconds(bundlePhaseStartedAt)}s\nBundle: ${currentBundlePath}`,
        );
      }
      if (bundleLoadError) return errorResult(`status=failed\n${bundleLoadError}`);
      return textResult("status=idle, phase=idle, next=list_bundles");
    }),
  );

  server.registerTool(
    "cluster_overview",
    {
      description:
        "Summarize nodes, namespaces, unhealthy pods, Warning events, and parse diagnostics. Use first.",
      inputSchema: {
        warning_event_limit: z.number().int().positive().max(500).optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ warning_event_limit }) => readyTool("cluster_overview", async () =>
      boundedResult(JSON.stringify(await bundleOverview(warning_event_limit ?? 50), null, 2))),
  );

  server.registerTool(
    "resource_catalog",
    {
      description:
        "List collected resource kinds, API versions, and aliases. Use only when kind is unknown.",
      inputSchema: {
        search: z.string().optional().describe("Optional kind, API group/version, or alias substring."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ search }) => readyTool("resource_catalog", async () =>
      boundedResult(JSON.stringify(resourceCatalog(search), null, 2))),
  );

  server.registerTool(
    "resource_query",
    {
      description:
        "Get collected Kubernetes resources with structured filters. Returns summaries by default; full=true returns complete objects.",
      inputSchema: {
        kind: z.string().min(1).describe("Resource kind, e.g. Pod, Deployment, Event, or a CR kind."),
        api_version: z.string().optional(),
        namespace: z.string().optional(),
        name: z.string().optional(),
        ...labelSelectorSchema,
        fields: z.record(z.string()).optional().describe(
          "Exact dot-path matches, including array indexes such as spec.rules[0].matches[0].",
        ),
        field_not_equals: z.record(z.string()).optional().describe(
          "Dot-path values that must not equal the supplied value.",
        ),
        field_contains: z.record(z.string()).optional().describe(
          "Substring matches on dot-path values.",
        ),
        owner: z.string().optional().describe("OwnerReference name or UID."),
        sort_by: z.string().optional().describe("Dot path used to sort matching resources."),
        sort_desc: z.boolean().optional(),
        offset: z.number().int().nonnegative().optional().describe(
          "Result offset. Use nextOffset from a truncated response.",
        ),
        limit: z.number().int().positive().max(500).optional(),
        full: z.boolean().optional().describe("Return complete collected objects instead of summaries."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({
      kind,
      api_version,
      namespace,
      name,
      labels,
      label_in,
      label_not_in,
      label_exists,
      label_not_exists,
      fields,
      field_not_equals,
      field_contains,
      owner,
      sort_by,
      sort_desc,
      offset,
      limit,
      full,
    }) =>
      readyTool("resource_query", async () => {
        try {
          const result = await queryResources({
            kind,
            apiVersion: api_version,
            namespace,
            name,
            labels,
            labelIn: label_in,
            labelNotIn: label_not_in,
            labelExists: label_exists,
            labelNotExists: label_not_exists,
            fields,
            fieldNotEquals: field_not_equals,
            fieldContains: field_contains,
            owner,
            sortBy: sort_by,
            sortDesc: sort_desc,
            offset,
            limit,
            full,
          });
          return boundedResult(JSON.stringify(result, null, 2));
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      }),
  );

  server.registerTool(
    "pod_logs",
    {
      description:
        "Get or search collected pod logs by namespace, pod, container, or labels. Supports previous logs and pagination.",
      inputSchema: {
        namespace: z.string().min(1).optional(),
        pod: z.string().min(1).optional(),
        container: z.string().min(1).optional(),
        ...labelSelectorSchema,
        search: z.string().min(1).optional().describe("Literal text to find in collected logs."),
        ignore_case: z.boolean().optional().describe("Case-insensitive search; default true."),
        previous: z.boolean().optional().describe("Read collected previous-container logs."),
        tail: z.number().int().positive().max(10_000).optional(),
        offset: z.number().int().nonnegative().optional().describe(
          "Log-file offset. Use nextOffset to continue.",
        ),
        limit: z.number().int().positive().max(100).optional().describe("Maximum log files returned."),
        line_offset: z.number().int().nonnegative().optional().describe(
          "Forward line or matching-line offset; overrides tail.",
        ),
        line_limit: z.number().int().positive().max(10_000).optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({
      namespace,
      pod,
      container,
      labels,
      label_in,
      label_not_in,
      label_exists,
      label_not_exists,
      search,
      ignore_case,
      previous,
      tail,
      offset,
      limit,
      line_offset,
      line_limit,
    }) =>
      readyTool("pod_logs", async () => {
        if (
          !namespace &&
          !pod &&
          !labels &&
          !label_in &&
          !label_not_in &&
          !label_exists &&
          !label_not_exists
        ) {
          return errorResult("Provide namespace, pod, or labels to bound the log query.");
        }
        try {
          return boundedResult(JSON.stringify(await queryPodLogs({
            namespace,
            pod,
            container,
            labels,
            labelIn: label_in,
            labelNotIn: label_not_in,
            labelExists: label_exists,
            labelNotExists: label_not_exists,
            search,
            ignoreCase: ignore_case,
            previous,
            tail,
            offset,
            limit,
            lineOffset: line_offset,
            lineLimit: line_limit,
          }), null, 2));
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      }),
  );

  server.registerTool(
    "bundle_files",
    {
      description:
        "List, read, or search raw diagnostics not available through resource_query or pod_logs. Use last.",
      inputSchema: {
        operation: z.enum(["list", "read", "search"]),
        path: z.string().optional().describe("Relative file path for read, or path prefix for list/search."),
        query: z.string().min(1).optional().describe("Literal content query for search."),
        ignore_case: z.boolean().optional(),
        limit: z.number().int().positive().max(500).optional(),
        max_bytes: z.number().int().positive().max(1024 * 1024).optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ operation, path, query, ignore_case, limit, max_bytes }) =>
      readyTool("bundle_files", async () => {
        try {
          if (operation === "list") {
            return textResult(JSON.stringify(await listBundleContents(path, limit), null, 2));
          }
          if (operation === "read") {
            if (!path) return errorResult("path is required for operation=read");
            return boundedResult(JSON.stringify(
              await readBundleContents(path, max_bytes),
              null,
              2,
            ));
          }
          if (!query) return errorResult("query is required for operation=search");
          return boundedResult(JSON.stringify(
            await searchBundleContents(query, path, limit, ignore_case),
            null,
            2,
          ));
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      }),
  );

  return server;
}
