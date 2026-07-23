import { mkdir, rm, writeFile } from "fs/promises";

import { beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = "/tmp/direct-bundle-state-test";

const mocks = vi.hoisted(() => ({
  destroy: vi.fn(async () => {}),
  maybeDeleteUpload: vi.fn(),
  open: vi.fn(),
}));

vi.mock("../src/bundle-reader.js", () => ({
  BundleReader: {
    open: mocks.open,
  },
}));

vi.mock("../src/config.js", () => ({
  BUNDLE_CACHE_DIR: `${ROOT}/cache`,
  BUNDLES_DIR: `${ROOT}/bundles`,
  UPLOAD_DIR: `${ROOT}/uploads`,
}));

vi.mock("../src/uploads.js", () => ({
  maybeDeleteUpload: mocks.maybeDeleteUpload,
}));

type BundleModule = typeof import("../src/bundle.js");
let bundle: BundleModule;

const reader = {
  availableKinds: () => ["Pod"],
  destroy: mocks.destroy,
  overview: vi.fn(),
  podLogs: vi.fn(),
  query: vi.fn(),
};

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(`${ROOT}/bundles`, { recursive: true });
  await mkdir(`${ROOT}/uploads`, { recursive: true });
  await writeFile(`${ROOT}/bundles/fixture.tar.gz`, "archive");
  bundle = await import("../src/bundle.js");
  bundle.initBundleCache();
});

describe("bundle paths and lifecycle", () => {
  it("accepts bundle roots and rejects traversal", () => {
    expect(bundle.resolveBundlePath("fixture.tar.gz")).toBe(`${ROOT}/bundles/fixture.tar.gz`);
    expect(() => bundle.resolveBundlePath("../../etc/passwd")).toThrow("outside the allowed roots");
  });

  it("returns immediately while loading, then reopens a shared bundle from cache", async () => {
    let finish!: (value: typeof reader) => void;
    mocks.open.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const path = `${ROOT}/bundles/fixture.tar.gz`;

    await expect(bundle.startBundle(path)).resolves.toBe("loading");
    expect(bundle.bundlePhase).toBe("extracting");
    finish(reader);
    await vi.waitFor(() => expect(bundle.bundleReady).toBe(true));

    await bundle.stopBundle();
    expect(bundle.bundlePhase).toBe("idle");
    await expect(bundle.startBundle(path)).resolves.toBe("ready");
    expect(mocks.open).toHaveBeenCalledTimes(1);
  });

  it("deletes uploaded archives and their extracted reader on stop", async () => {
    const path = `${ROOT}/uploads/upload.tar.gz`;
    await writeFile(path, "archive");
    mocks.open.mockResolvedValue(reader);

    await bundle.startBundle(path);
    await vi.waitFor(() => expect(bundle.bundleReady).toBe(true));
    await bundle.stopBundle();

    expect(mocks.destroy).toHaveBeenCalled();
    expect(mocks.maybeDeleteUpload).toHaveBeenCalledWith(path);
  });
});
