import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  existsSync: vi.fn(),
  rmSync: vi.fn(),
  unlinkSync: vi.fn(),
  cacheClear: vi.fn(),
  maybeDeleteUpload: vi.fn(),
}));

vi.mock("child_process", () => ({
  spawn: mocks.spawn,
}));

vi.mock("fs", () => ({
  existsSync: mocks.existsSync,
  rmSync: mocks.rmSync,
  unlinkSync: mocks.unlinkSync,
}));

vi.mock("../src/cache.js", () => ({
  cacheClear: mocks.cacheClear,
}));

vi.mock("../src/uploads.js", () => ({
  maybeDeleteUpload: mocks.maybeDeleteUpload,
}));

vi.mock("../src/config.js", () => ({
  BUNDLES_DIR: "/mock/bundles",
  CLUSTER_READY_TIMEOUT_MS: 5000,
  KUBECONFIG_PATH: "/mock/kubeconfig",
  PROXY_ADDRESS: "127.0.0.1:8443",
  TROUBLESHOOT_LIVE_WORKDIR: "/mock/workdir",
  UPLOAD_DIR: "/mock/uploads",
}));

class MockChildProcess extends EventEmitter {
  public readonly stdout = new EventEmitter();
  public readonly stderr = new EventEmitter();
  public killed = false;

  public kill = vi.fn((_: NodeJS.Signals) => {
    this.killed = true;
    return true;
  });
}

type BundleModule = typeof import("../src/bundle.js");

let bundle: BundleModule;

const createStartedBundleProcess = async (bundlePath: string): Promise<MockChildProcess> => {
  const child = new MockChildProcess();
  mocks.spawn.mockReturnValue(child as unknown as ChildProcess);
  const started = bundle.startBundle(bundlePath);
  child.emit("spawn");
  await started;
  return child;
};

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  bundle = await import("../src/bundle.js");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("resolveBundlePath", () => {
  it("accepts allowed roots and blocks directory traversal", () => {
    expect(bundle.resolveBundlePath("valid-bundle.tar.gz")).toBe("/mock/bundles/valid-bundle.tar.gz");
    expect(bundle.resolveBundlePath("/mock/uploads/uploaded-bundle.tgz")).toBe(
      "/mock/uploads/uploaded-bundle.tgz",
    );

    expect(() => bundle.resolveBundlePath("../../etc/passwd")).toThrow(/outside the allowed roots/);
    expect(() => bundle.resolveBundlePath("/tmp/evil.tar.gz")).toThrow(/outside the allowed roots/);
  });
});

describe("state transitions", () => {
  it("transitions with markLoading, markReady, and markFailed", async () => {
    const path = "/mock/bundles/stateful.tar.gz";
    await createStartedBundleProcess(path);

    bundle.markLoading();
    expect(bundle.bundleLoading).toBe(true);
    expect(bundle.bundleReady).toBe(false);
    expect(bundle.bundleLoadError).toBeNull();
    expect(bundle.bundlePhase).toBe("spawning");

    bundle.markReady(path, bundle.currentBundleGeneration);
    expect(bundle.bundleLoading).toBe(false);
    expect(bundle.bundleReady).toBe(true);
    expect(bundle.bundlePhase).toBe("ready");

    bundle.markLoading();
    bundle.markFailed("explicit failure");
    expect(bundle.bundleLoading).toBe(false);
    expect(bundle.bundlePhase).toBe("failed");
    expect(bundle.bundleLoadError).toBe("explicit failure");
  });

  it("ignores stale markReady calls for different bundle paths", async () => {
    await createStartedBundleProcess("/mock/bundles/current.tar.gz");

    bundle.markLoading();
    bundle.markReady("/mock/bundles/other.tar.gz", bundle.currentBundleGeneration);

    expect(bundle.bundleLoading).toBe(true);
    expect(bundle.bundleReady).toBe(false);
    expect(bundle.bundlePhase).toBe("spawning");
  });
});

describe("requireReady", () => {
  it("returns null only when ready and error results otherwise", async () => {
    const idle = bundle.requireReady();
    expect(idle?.isError).toBe(true);
    expect(idle?.content[0]?.text).toContain("Cluster is not ready");

    const path = "/mock/bundles/require-ready.tar.gz";
    await createStartedBundleProcess(path);

    bundle.markLoading();
    const loading = bundle.requireReady();
    expect(loading?.isError).toBe(true);
    expect(loading?.content[0]?.text).toContain("still loading bundle");
    expect(loading?.content[0]?.text).toContain("phase=spawning");

    bundle.markReady(path, bundle.currentBundleGeneration);
    expect(bundle.requireReady()).toBeNull();

    bundle.markLoading();
    bundle.markFailed("explicit failure");
    const failed = bundle.requireReady();
    expect(failed?.isError).toBe(true);
    expect(failed?.content[0]?.text).toContain("Last bundle load failed");
  });
});

describe("startBundle + waitForCluster", () => {
  it("spawns troubleshoot-live with expected arguments", async () => {
    const path = "/mock/bundles/spawn-check.tar.gz";
    await createStartedBundleProcess(path);

    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).toHaveBeenCalledWith(
      "troubleshoot-live",
      [
        "serve",
        path,
        "--output-kubeconfig",
        "/mock/kubeconfig",
        "--proxy-address",
        "127.0.0.1:8443",
      ],
      { stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
  });

  it("advances bundlePhase from stderr and resolves waitForCluster", async () => {
    const child = await createStartedBundleProcess("/mock/bundles/phases.tar.gz");

    const readyWait = bundle.waitForCluster(250);

    child.stderr.emit("data", Buffer.from("Starting k8s server\n"));
    expect(bundle.bundlePhase).toBe("starting_apiserver");

    child.stderr.emit("data", Buffer.from("Importing bundle resources\n"));
    expect(bundle.bundlePhase).toBe("importing");

    child.stderr.emit("data", Buffer.from("Running HTTPs proxy service on 127.0.0.1:8443\n"));
    await expect(readyWait).resolves.toBe(true);
  });

  it("returns false when waitForCluster times out without ready signal", async () => {
    await createStartedBundleProcess("/mock/bundles/timeout.tar.gz");
    await expect(bundle.waitForCluster(5)).resolves.toBe(false);
  });

  it("stops a timed-out process and preserves the failure", async () => {
    const path = "/mock/uploads/timeout-abort.tar.gz";
    const child = await createStartedBundleProcess(path);
    bundle.markLoading();
    child.stderr.emit("data", Buffer.from("Importing bundle resources\n"));

    const aborted = bundle.abortTimedOutBundle(path, bundle.currentBundleGeneration);
    expect(child.kill).toHaveBeenCalledWith("SIGINT");
    child.emit("exit", null, "SIGINT");
    await aborted;

    expect(bundle.isBundleProcessRunning()).toBe(false);
    expect(bundle.bundlePhase).toBe("failed");
    expect(bundle.bundleLoadError).toContain("timed out");
    expect(bundle.bundleLoadError).toContain("phase=importing");
    expect(bundle.bundleLoadError).toContain("Do not retry");
  });

  it("does not stop a newer bundle generation", async () => {
    const path = "/mock/bundles/generation.tar.gz";
    const child = await createStartedBundleProcess(path);
    const staleGeneration = bundle.currentBundleGeneration - 1;

    await bundle.abortTimedOutBundle(path, staleGeneration);

    expect(child.kill).not.toHaveBeenCalled();
    expect(bundle.isBundleProcessRunning()).toBe(true);
  });

  it("escalates to SIGKILL when graceful stop hangs", async () => {
    vi.useFakeTimers();
    const child = await createStartedBundleProcess("/mock/bundles/hung.tar.gz");

    const stopped = bundle.stopBundle(10_000);
    expect(child.kill).toHaveBeenCalledWith("SIGINT");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    child.emit("exit", null, "SIGKILL");
    await stopped;
  });
});
