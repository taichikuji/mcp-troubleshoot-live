import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createWriteStream: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
  rmSync: vi.fn(),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock("fs", () => ({
  createWriteStream: mocks.createWriteStream,
  existsSync: mocks.existsSync,
  mkdirSync: mocks.mkdirSync,
  readdirSync: mocks.readdirSync,
  rmSync: mocks.rmSync,
  statSync: mocks.statSync,
  unlinkSync: mocks.unlinkSync,
}));

vi.mock("../src/config.js", () => ({
  BUNDLES_DIR: "/mock/bundles",
  MAX_UPLOAD_BYTES: 100 * 1024 * 1024,
  UPLOAD_DIR: "/mock/uploads",
  UPLOAD_TTL_MS: 60_000,
}));

vi.mock("../src/log.js", () => ({
  log: vi.fn(),
}));

type UploadsModule = typeof import("../src/uploads.js");

let sanitizeFilename: UploadsModule["sanitizeFilename"];
let maybeDeleteUpload: UploadsModule["maybeDeleteUpload"];
let sweepUploads: UploadsModule["sweepUploads"];
let uploadedPaths: UploadsModule["uploadedPaths"];
let posixShellQuote: UploadsModule["posixShellQuote"];
let cmdQuote: UploadsModule["cmdQuote"];

beforeEach(async () => {
  vi.useRealTimers();
  vi.resetModules();
  vi.clearAllMocks();

  mocks.existsSync.mockReturnValue(true);
  mocks.readdirSync.mockReturnValue([]);

  ({
    sanitizeFilename,
    maybeDeleteUpload,
    sweepUploads,
    uploadedPaths,
    posixShellQuote,
    cmdQuote,
  } = await import("../src/uploads.js"));
  uploadedPaths.clear();
});

describe("sanitizeFilename", () => {
  it("allows valid tarball names", () => {
    expect(sanitizeFilename("bundle.tar.gz")).toBe("bundle.tar.gz");
    expect(sanitizeFilename("cluster_snapshot-1.2.3.tgz")).toBe("cluster_snapshot-1.2.3.tgz");
    expect(sanitizeFilename("ARCHIVE.TAR")).toBe("ARCHIVE.TAR");
  });

  it("rejects traversal-like and invalid filenames", () => {
    expect(sanitizeFilename("../file")).toBeNull();
    expect(sanitizeFilename("bundle.zip")).toBeNull();
    expect(sanitizeFilename(".hidden.tar.gz")).toBeNull();
  });
});

describe("shell-specific quoting", () => {
  it("quotes POSIX shell arguments safely", () => {
    expect(posixShellQuote("/tmp/a b/bundle.tar.gz")).toBe("'/tmp/a b/bundle.tar.gz'");
    expect(posixShellQuote("/tmp/O'Brien/bundle.tar.gz")).toBe("'/tmp/O'\\''Brien/bundle.tar.gz'");
  });

  it("quotes CMD arguments safely for double quotes", () => {
    expect(cmdQuote("C:\\Users\\Alice\\bundle.tar.gz")).toBe("\"C:\\Users\\Alice\\bundle.tar.gz\"");
    expect(cmdQuote("C:\\temp\\x\"y\\bundle.tar.gz")).toBe("\"C:\\temp\\x\"\"y\\bundle.tar.gz\"");
  });
});

describe("maybeDeleteUpload", () => {
  it("deletes and forgets uploaded paths tracked in uploadedPaths", () => {
    const tracked = "/mock/uploads/u-1.tar.gz";
    uploadedPaths.add(tracked);

    maybeDeleteUpload(tracked);

    expect(mocks.unlinkSync).toHaveBeenCalledWith(tracked);
    expect(uploadedPaths.has(tracked)).toBe(false);
  });

  it("ignores untracked paths", () => {
    maybeDeleteUpload("/mock/uploads/not-tracked.tar.gz");

    expect(mocks.unlinkSync).not.toHaveBeenCalled();
    expect(uploadedPaths.size).toBe(0);
  });
});

describe("sweepUploads", () => {
  it("reaps stale uploads but keeps current and fresh files", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));

    const stale = "/mock/uploads/old.tar.gz";
    const fresh = "/mock/uploads/new.tgz";
    const current = "/mock/uploads/current.tar.gz";
    const now = Date.now();

    mocks.readdirSync.mockReturnValue(["old.tar.gz", "new.tgz", "current.tar.gz"]);
    mocks.statSync.mockImplementation((p: string) => {
      if (p === stale) return { isFile: () => true, mtimeMs: now - 60_001 };
      if (p === fresh) return { isFile: () => true, mtimeMs: now - 1000 };
      if (p === current) return { isFile: () => true, mtimeMs: now - 60_001 };
      return { isFile: () => false, mtimeMs: now };
    });

    uploadedPaths.add(stale);
    uploadedPaths.add(fresh);
    uploadedPaths.add(current);

    sweepUploads(current);

    expect(mocks.unlinkSync).toHaveBeenCalledTimes(1);
    expect(mocks.unlinkSync).toHaveBeenCalledWith(stale);
    expect(uploadedPaths.has(stale)).toBe(false);
    expect(uploadedPaths.has(fresh)).toBe(true);
    expect(uploadedPaths.has(current)).toBe(true);
  });
});
