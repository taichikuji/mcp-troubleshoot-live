import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  overview: vi.fn(),
  query: vi.fn(),
  readLogs: vi.fn(),
  requireReady: vi.fn(),
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
  queryResources: mocks.query,
  readPodLogs: mocks.readLogs,
  requireReady: mocks.requireReady,
  resolveBundlePath: (path: string) => path,
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
    returned: 1,
    truncated: false,
    items: [{ kind: "Pod", metadata: { name: "web-0" } }],
  });
  mocks.readLogs.mockResolvedValue("line\n");
  ({ createServer } = await import("../src/tools.js"));
});

describe("structured bundle tools", () => {
  it("registers resource_query with bounded structured inputs", () => {
    const schema = tool("resource_query").inputSchema as z.ZodTypeAny;
    expect(schema.safeParse({
      kind: "Pod",
      namespace: "default",
      labels: { app: "web" },
      fields: { "status.phase": "Running" },
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
      fields: { "status.phase": "Running" },
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
      fields: { "status.phase": "Running" },
      limit: 1,
      full: true,
    });
  });

  it("reads logs without kubectl", async () => {
    const result = await invoke(tool("pod_logs"), {
      namespace: "default",
      pod: "web-0",
      container: "app",
      tail: 50,
    }) as { content: { text: string }[] };

    expect(result.content[0]?.text).toBe("line\n");
    expect(mocks.readLogs).toHaveBeenCalledWith("default", "web-0", "app", 50);
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
