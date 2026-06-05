import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  execFile: vi.fn(),
  execFileAsync: vi.fn(),
  existsSync: vi.fn(),
  promisify: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFile: mocks.execFile,
}));

vi.mock("util", () => ({
  promisify: mocks.promisify,
}));

vi.mock("fs", () => ({
  existsSync: mocks.existsSync,
}));

vi.mock("../src/cache.js", () => ({
  cacheGet: mocks.cacheGet,
  cacheSet: mocks.cacheSet,
}));

vi.mock("../src/config.js", () => ({
  KUBECONFIG_PATH: "/mock/kubeconfig",
  KUBECTL_TIMEOUT_MS: 1234,
  RESPONSE_SOFT_LIMIT_BYTES: 20,
}));

type KubectlModule = typeof import("../src/kubectl.js");

let tokenize: KubectlModule["tokenize"];
let nsArgs: KubectlModule["nsArgs"];
let runKubectl: KubectlModule["runKubectl"];

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();

  mocks.existsSync.mockReturnValue(true);
  mocks.cacheGet.mockReturnValue(null);
  mocks.promisify.mockReturnValue(mocks.execFileAsync);
  mocks.execFileAsync.mockResolvedValue({ stdout: "ok", stderr: "" });

  ({ tokenize, nsArgs, runKubectl } = await import("../src/kubectl.js"));
});

describe("tokenize", () => {
  it("splits simple argument strings", () => {
    expect(tokenize("get pods -A")).toEqual(["get", "pods", "-A"]);
  });

  it("handles single and double quoted values", () => {
    expect(tokenize(`get pods --selector "app=web api" --field-selector 'status.phase=Running'`)).toEqual([
      "get",
      "pods",
      "--selector",
      "app=web api",
      "--field-selector",
      "status.phase=Running",
    ]);
  });

  it("respects escapes outside and inside double quotes", () => {
    expect(tokenize(String.raw`get pods app\ name "has \"quotes\""`)).toEqual([
      "get",
      "pods",
      "app name",
      `has "quotes"`,
    ]);
  });
});

describe("nsArgs", () => {
  it("returns namespace args when namespace is provided", () => {
    expect(nsArgs("kube-system")).toEqual(["-n", "kube-system"]);
  });

  it("falls back to all namespaces when namespace is omitted", () => {
    expect(nsArgs(undefined)).toEqual(["-A"]);
    expect(nsArgs(undefined, false)).toEqual([]);
  });
});

describe("runKubectl", () => {
  it("appends --kubeconfig to kubectl arguments", async () => {
    mocks.execFileAsync.mockResolvedValue({ stdout: "pods", stderr: "" });

    await runKubectl(["get", "pods", "-A"]);

    expect(mocks.execFileAsync).toHaveBeenCalledWith(
      "kubectl",
      ["--kubeconfig=/mock/kubeconfig", "get", "pods", "-A"],
      { timeout: 1234, maxBuffer: 10 * 1024 * 1024 },
    );
  });

  it("returns cached output without executing kubectl on cache hit", async () => {
    mocks.cacheGet.mockReturnValue("cached-value");

    const output = await runKubectl(["get", "pods"]);

    expect(output).toBe("cached-value");
    expect(mocks.execFileAsync).not.toHaveBeenCalled();
    expect(mocks.cacheSet).not.toHaveBeenCalled();
  });

  it("stores command output in cache on cache miss", async () => {
    mocks.execFileAsync.mockResolvedValue({ stdout: "fresh-output", stderr: "" });

    const output = await runKubectl(["get", "pods"]);

    expect(output).toBe("fresh-output");
    expect(mocks.cacheSet).toHaveBeenCalledWith(["get", "pods"], "fresh-output");
  });

  it("appends a size hint when response exceeds RESPONSE_SOFT_LIMIT_BYTES", async () => {
    const largeOutput = "x".repeat(2050);
    mocks.execFileAsync.mockResolvedValue({ stdout: largeOutput, stderr: "" });

    const output = await runKubectl(["get", "pods"]);

    expect(output).toContain(largeOutput);
    expect(output).toContain("[note: response is 2 KB.");
    expect(output).toContain("narrow with -n <namespace>, --selector=, --field-selector=");
  });
});
