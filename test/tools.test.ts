import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  catalog: vi.fn(),
  listFiles: vi.fn(),
  overview: vi.fn(),
  query: vi.fn(),
  queryLogs: vi.fn(),
  readFile: vi.fn(),
  requireReady: vi.fn(),
  searchFiles: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));

const state = vi.hoisted(() => ({
  error: null as string | null,
  loading: false,
  path: "/mock/bundles/a.tar.gz" as string | null,
  phase: "ready",
  phaseStarted: null as number | null,
  ready: true,
  started: null as number | null,
}));

vi.mock("../src/bundle.js", () => ({
  availableKinds: () => ["Node", "Pod"],
  bundleExists: () => true,
  get bundleLoadError() { return state.error; },
  get bundleLoadStartedAt() { return state.started; },
  get bundleLoading() { return state.loading; },
  bundleOverview: mocks.overview,
  get bundlePhase() { return state.phase; },
  get bundlePhaseStartedAt() { return state.phaseStarted; },
  get bundleReady() { return state.ready; },
  get currentBundlePath() { return state.path; },
  isBundleActive: () => state.loading || state.ready,
  listBundleContents: mocks.listFiles,
  queryPodLogs: mocks.queryLogs,
  queryResources: mocks.query,
  readBundleContents: mocks.readFile,
  requireReady: mocks.requireReady,
  resourceCatalog: mocks.catalog,
  resolveBundlePath: (path: string) => path,
  searchBundleContents: mocks.searchFiles,
  startBundle: mocks.start,
  stopBundle: mocks.stop,
}));

vi.mock("../src/config.js", () => ({
  BUNDLES_DIR: "/mock/bundles",
  MAX_UPLOAD_BYTES: 1024,
  RESPONSE_SOFT_LIMIT_BYTES: 100_000,
  UPLOAD_DIR: "/mock/uploads",
  UPLOAD_TTL_MS: 60_000,
}));

vi.mock("../src/request-context.js", () => ({
  uploadBaseUrl: () => "https://mcp.example.test",
}));

vi.mock("../src/uploads.js", async () => {
  const actual = await vi.importActual<typeof import("../src/uploads.js")>("../src/uploads.js");
  return {
    ...actual,
    listBundleFiles: () => [],
  };
});

type ToolsModule = typeof import("../src/tools.js");
let createServer: ToolsModule["createServer"];

type RegisteredTool = {
  inputSchema?: unknown;
  callback?: (args: never, extra: never) => Promise<unknown>;
  handler?: (args: never, extra: never) => Promise<unknown>;
};

const tool = (name: string): RegisteredTool => {
  const server = createServer() as unknown as { _registeredTools: Record<string, RegisteredTool> };
  const registered = server._registeredTools[name];
  if (!registered) throw new Error(`Missing tool '${name}'`);
  return registered;
};

const invoke = (registered: RegisteredTool, args: unknown) => {
  const callback = registered.callback ?? registered.handler;
  if (!callback) throw new Error("Tool has no callback");
  return callback(args as never, {} as never);
};

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  state.error = null;
  state.loading = false;
  state.path = "/mock/bundles/a.tar.gz";
  state.phase = "ready";
  state.phaseStarted = null;
  state.ready = true;
  state.started = null;
  mocks.requireReady.mockReturnValue(null);
  mocks.query.mockResolvedValue({
    kind: "Pod",
    total: 1,
    offset: 0,
    returned: 1,
    truncated: false,
    items: [{ kind: "Pod", metadata: { name: "web-0" } }],
  });
  mocks.queryLogs.mockResolvedValue({
    matchedPods: 1,
    returned: 1,
    truncated: false,
    logs: [{ namespace: "default", pod: "web-0", container: "app", text: "line\n" }],
  });
  mocks.catalog.mockReturnValue([{ kind: "Pod", apiVersion: "v1", aliases: ["pod", "pods"] }]);
  mocks.listFiles.mockResolvedValue({ total: 1, returned: 1, files: [{ path: "report.txt" }] });
  ({ createServer } = await import("../src/tools.js"));
});

describe("structured bundle tools", () => {
  it("registers resource_query with bounded structured inputs", () => {
    const schema = tool("resource_query").inputSchema as z.ZodTypeAny;
    expect(schema.safeParse({
      kind: "Pod",
      namespace: "default",
      labels: { app: "web" },
      label_in: { tier: ["frontend", "edge"] },
      label_not_in: { track: ["canary"] },
      label_exists: ["app"],
      label_not_exists: ["disabled"],
      fields: { "status.phase": "Running" },
      field_not_equals: { "status.phase": "Pending" },
      field_contains: { "metadata.name": "web" },
      offset: 10,
      limit: 100,
      full: true,
    }).success).toBe(true);
    expect(schema.safeParse({ kind: "Pod", limit: 501 }).success).toBe(false);
  });

  it("passes structured filters to the direct reader", async () => {
    const result = await invoke(tool("resource_query"), {
      kind: "Pod",
      api_version: "v1",
      namespace: "default",
      name: "web-0",
      labels: { app: "web" },
      label_in: { tier: ["frontend"] },
      label_not_in: { track: ["canary"] },
      label_exists: ["app"],
      label_not_exists: ["disabled"],
      fields: { "status.phase": "Running" },
      field_not_equals: { "status.phase": "Pending" },
      field_contains: { "metadata.name": "web" },
      offset: 2,
      limit: 1,
      full: true,
    }) as { content: { text: string }[] };

    expect(JSON.parse(result.content[0]!.text).total).toBe(1);
    expect(mocks.query).toHaveBeenCalledWith({
      kind: "Pod",
      apiVersion: "v1",
      namespace: "default",
      name: "web-0",
      labels: { app: "web" },
      labelIn: { tier: ["frontend"] },
      labelNotIn: { track: ["canary"] },
      labelExists: ["app"],
      labelNotExists: ["disabled"],
      fields: { "status.phase": "Running" },
      fieldNotEquals: { "status.phase": "Pending" },
      fieldContains: { "metadata.name": "web" },
      owner: undefined,
      sortBy: undefined,
      sortDesc: undefined,
      offset: 2,
      limit: 1,
      full: true,
    });
  });

  it("fans out log searches through structured selectors", async () => {
    const result = await invoke(tool("pod_logs"), {
      namespace: "default",
      labels: { app: "web" },
      label_exists: ["app"],
      search: "404",
      tail: 50,
      offset: 2,
      line_offset: 100,
      line_limit: 25,
    }) as { content: { text: string }[] };

    expect(JSON.parse(result.content[0]!.text).returned).toBe(1);
    expect(mocks.queryLogs).toHaveBeenCalledWith({
      namespace: "default",
      pod: undefined,
      container: undefined,
      labels: { app: "web" },
      labelIn: undefined,
      labelNotIn: undefined,
      labelExists: ["app"],
      labelNotExists: undefined,
      search: "404",
      ignoreCase: undefined,
      previous: undefined,
      tail: 50,
      offset: 2,
      limit: undefined,
      lineOffset: 100,
      lineLimit: 25,
    });
  });

  it("discovers resources and exposes bounded raw files", async () => {
    const catalog = await invoke(tool("resource_catalog"), { search: "pod" }) as {
      content: { text: string }[];
    };
    expect(JSON.parse(catalog.content[0]!.text)[0].kind).toBe("Pod");
    expect(mocks.catalog).toHaveBeenCalledWith("pod");

    const files = await invoke(tool("bundle_files"), {
      operation: "list",
      path: "host-collectors",
    }) as { content: { text: string }[] };
    expect(JSON.parse(files.content[0]!.text).total).toBe(1);
    expect(mocks.listFiles).toHaveBeenCalledWith("host-collectors", undefined);
  });

  it("rejects oversized tool responses before they flood client context", async () => {
    mocks.query.mockResolvedValue({
      kind: "Pod",
      total: 1,
      offset: 0,
      returned: 1,
      truncated: false,
      items: [{ data: "x".repeat(100_000) }],
    });

    const result = await invoke(tool("resource_query"), {
      kind: "Pod",
      full: true,
    }) as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("safety limit");
  });
});

describe("upload and status contracts", () => {
  it("keeps the one-line cross-platform upload contract", async () => {
    const result = await invoke(tool("prepare_upload"), {
      local_path: "/Users/alice/Local O'Brien/bundle.tar.gz",
    }) as { content: { text: string }[] };
    const text = result.content[0]!.text;
    const payload = JSON.parse(text);

    expect(text).not.toContain("\n");
    expect(payload.uploadUrl).toBe("https://mcp.example.test/bundles/upload/bundle.tar.gz");
    expect(payload.commands.windows.shell).toContain("curl.exe -fsS --upload-file");
    expect(payload.commands.unix.sh).toContain("O'\\''Brien");
  });

  it("reports extraction progress without cluster phases", async () => {
    vi.spyOn(Date, "now").mockReturnValue(100_000);
    state.ready = false;
    state.loading = true;
    state.phase = "indexing";
    state.started = 88_000;
    state.phaseStarted = 95_000;

    const result = await invoke(tool("cluster_status"), {}) as { content: { text: string }[] };
    expect(result.content[0]?.text).toContain(
      "status=loading, phase=indexing, elapsed=12s, phaseElapsed=5s",
    );
  });
});
