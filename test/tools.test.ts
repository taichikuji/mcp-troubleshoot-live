import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runKubectl: vi.fn(),
  requireReady: vi.fn(),
}));

const bundleState = vi.hoisted(() => ({
  bundleLoadError: null as string | null,
  bundleLoading: false,
  bundlePhase: "idle",
  bundleReady: false,
  currentBundlePath: null as string | null,
}));

vi.mock("../src/bundle.js", () => ({
  get bundleLoadError() {
    return bundleState.bundleLoadError;
  },
  get bundleLoading() {
    return bundleState.bundleLoading;
  },
  get bundlePhase() {
    return bundleState.bundlePhase;
  },
  get bundleReady() {
    return bundleState.bundleReady;
  },
  get currentBundlePath() {
    return bundleState.currentBundlePath;
  },
  isBundleProcessRunning: vi.fn(() => false),
  markFailed: vi.fn(),
  markLoading: vi.fn(),
  markReady: vi.fn(),
  requireReady: mocks.requireReady,
  resolveBundlePath: vi.fn((p: string) => p),
  startBundle: vi.fn(),
  stopBundle: vi.fn(),
  waitForCluster: vi.fn(),
}));

vi.mock("../src/config.js", () => ({
  BUNDLES_DIR: "/mock/bundles",
  MAX_UPLOAD_BYTES: 1024,
  PROXY_ADDRESS: "127.0.0.1:8443",
  UPLOAD_DIR: "/mock/uploads",
  UPLOAD_TTL_MS: 60_000,
}));

vi.mock("../src/kubectl.js", async () => {
  const actual = await vi.importActual<typeof import("../src/kubectl.js")>("../src/kubectl.js");
  return {
    ...actual,
    runKubectl: mocks.runKubectl,
  };
});

type ToolsModule = typeof import("../src/tools.js");
let createServer: ToolsModule["createServer"];

type RegisteredTool = {
  inputSchema?: unknown;
  callback?: (args: unknown, extra: unknown) => Promise<unknown>;
  handler?: (args: unknown, extra: unknown) => Promise<unknown>;
};

const getRegisteredTool = (name: string) => {
  const server = createServer() as unknown as { _registeredTools: Record<string, unknown> };
  const tool = server._registeredTools[name] as RegisteredTool | undefined;
  if (!tool) throw new Error(`Missing tool '${name}'`);
  return tool;
};

const invokeTool = (tool: RegisteredTool, args: unknown, extra: unknown = {}) => {
  const callback = typeof tool.callback === "function" ? tool.callback : undefined;
  const handler = typeof tool.handler === "function" ? tool.handler : undefined;
  const invoke = callback ?? handler;
  if (!invoke) {
    throw new Error("Tool has no callable callback/handler");
  }
  return invoke(args, extra);
};

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();

  bundleState.bundleLoadError = null;
  bundleState.bundleLoading = false;
  bundleState.bundlePhase = "ready";
  bundleState.bundleReady = true;
  bundleState.currentBundlePath = "/mock/bundles/a.tar.gz";

  mocks.requireReady.mockReturnValue(null);
  mocks.runKubectl.mockResolvedValue([
    "NAME READY STATUS",
    "web-0 1/1 Running",
    "worker-0 0/1 CrashLoopBackOff",
  ].join("\n"));

  ({ createServer } = await import("../src/tools.js"));
});

describe("kubectl_run tool schema + parsing", () => {
  it("enforces args schema bounds", () => {
    const kubectlRun = getRegisteredTool("kubectl_run");
    const schema = kubectlRun.inputSchema as z.ZodTypeAny;

    expect(schema.safeParse({ args: "get pods -A" }).success).toBe(true);
    expect(schema.safeParse({ args: "" }).success).toBe(false);
    expect(schema.safeParse({ args: "x".repeat(4097) }).success).toBe(false);
  });

  it("filters kubectl output using grep and preserves parsing behavior", async () => {
    const kubectlRun = getRegisteredTool("kubectl_run");
    const result = (await invokeTool(
      kubectlRun,
      { args: "get pods -A", grep: "CrashLoopBackOff", grep_ignore_case: false },
      {},
    )) as { content: { text: string }[]; isError?: boolean };

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe("worker-0 0/1 CrashLoopBackOff");
    expect(mocks.runKubectl).toHaveBeenCalledWith(["get", "pods", "-A"]);
  });

  it("rejects invalid grep regex without calling external binaries", async () => {
    const kubectlRun = getRegisteredTool("kubectl_run");
    const result = (await invokeTool(
      kubectlRun,
      { args: "get pods -A", grep: "[" },
      {},
    )) as { content: { text: string }[]; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Invalid grep pattern");
    expect(mocks.runKubectl).toHaveBeenCalledWith(["get", "pods", "-A"]);
  });
});
