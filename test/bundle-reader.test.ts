import { createWriteStream } from "fs";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { pipeline } from "stream/promises";
import { createGzip } from "zlib";

import tar from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";

import { BundleReader, extractBundleArchive } from "../src/bundle-reader.js";

const temporary: string[] = [];

async function archive(entries: Record<string, string>): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "bundle-reader-test-"));
  temporary.push(dir);
  const path = join(dir, "fixture.tar.gz");
  const pack = tar.pack();
  const writing = pipeline(pack, createGzip(), createWriteStream(path));
  for (const [name, body] of Object.entries(entries)) pack.entry({ name }, body);
  pack.finalize();
  await writing;
  return { dir, path };
}

const list = (items: object[]): string => JSON.stringify({ items });

async function fixture(): Promise<{ reader: BundleReader; dir: string }> {
  const { dir, path } = await archive({
    "fixture/cluster-resources/nodes.json": list([{
      metadata: { name: "node-1" },
      status: { conditions: [{ type: "Ready", status: "True" }] },
    }]),
    "fixture/cluster-resources/namespaces.json": list([{
      metadata: { name: "default" },
      status: { phase: "Active" },
    }]),
    "fixture/cluster-resources/pods/default.json": list([
      {
        metadata: { name: "web-0", namespace: "default", labels: { app: "web" } },
        spec: { containers: [{ name: "app" }] },
        status: { phase: "Running", containerStatuses: [{ ready: true }] },
      },
      {
        metadata: {
          name: "worker-0",
          namespace: "default",
          labels: { app: "worker", "app.kubernetes.io/name": "worker" },
        },
        spec: { containers: [{ name: "worker" }] },
        status: { phase: "Pending", containerStatuses: [{ ready: false }] },
      },
    ]),
    "fixture/cluster-resources/events/default.json": list([{
      metadata: { name: "warning-1", namespace: "default" },
      type: "Warning",
      reason: "FailedScheduling",
      lastTimestamp: "2026-07-23T10:00:00Z",
    }]),
    "fixture/cluster-resources/custom-resource-definitions.json": list([{
      apiVersion: "apiextensions.k8s.io/v1",
      kind: "CustomResourceDefinition",
      metadata: { name: "gadgets.example.test" },
      spec: {
        group: "example.test",
        names: { kind: "Gadget", plural: "gadgets", singular: "gadget", shortNames: ["gd"] },
      },
    }]),
    "fixture/cluster-resources/widgets/default.json": list([{
      apiVersion: "example.test/v1",
      kind: "Widget",
      metadata: { name: "sample", namespace: "default" },
      spec: { rules: [{ matches: [{ header: "unified-enpoint-test" }] }] },
      status: { healthy: false },
    }]),
    "fixture/cluster-resources/gadgets/default.json": JSON.stringify([{
      apiVersion: "example.test/v1",
      kind: "GadgetList",
      items: [{
        apiVersion: "example.test/v1",
        kind: "Gadget",
        metadata: { name: "nested", namespace: "default" },
      }],
    }]),
    "fixture/cluster-resources/custom/bad.json": "{broken",
    "fixture/configmaps/default/app.json": JSON.stringify({
      name: "app",
      namespace: "default",
      data: { mode: "test" },
    }),
    "fixture/secrets/default/token.json": JSON.stringify({
      name: "token",
      namespace: "default",
    }),
    "fixture/pod-logs/default/web-0-app.log": "one\ntwo\nthree\n",
    "fixture/cluster-resources/pods/logs/default/worker-0/worker.log": "alpha\nbeta\n",
    "fixture/cluster-resources/pods/logs/default/worker-0/worker-previous.log": "old failure\n",
    "fixture/host-collectors/system/node-1/cpu.txt": "CPU healthy\nrequest failed with 404\n",
  });
  const extraction = join(dir, "extracted");
  const reader = await BundleReader.open(path, extraction, () => {});
  return { reader, dir };
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("BundleReader", () => {
  it("queries inferred and custom resources with structured filters", async () => {
    const { reader } = await fixture();

    const pods = await reader.query({
      kind: "pods",
      namespace: "default",
      labels: { "app.kubernetes.io/name": "worker" },
      fields: { "status.phase": "Pending" },
      full: true,
    });
    expect(pods.total).toBe(1);
    expect(pods.items[0]?.kind).toBe("Pod");
    expect(pods.items[0]?.apiVersion).toBe("v1");
    const firstPage = await reader.query({ kind: "Pod", limit: 1 });
    expect(firstPage).toMatchObject({ total: 2, offset: 0, truncated: true, nextOffset: 1 });
    await expect(reader.query({ kind: "Pod", limit: 1, offset: firstPage.nextOffset }))
      .resolves.toMatchObject({ total: 2, offset: 1, truncated: false });

    const widgets = await reader.query({ kind: "Widget", name: "sample", full: true });
    expect(widgets.total).toBe(1);
    expect(widgets.items[0]?.apiVersion).toBe("example.test/v1");
    await expect(reader.query({
      kind: "Widget",
      fieldContains: { "spec.rules[0].matches[0].header": "enpoint" },
    })).resolves.toMatchObject({ total: 1 });

    expect(reader.resourceCatalog("gadget")).toEqual([{
      kind: "Gadget",
      apiVersion: "example.test/v1",
      aliases: expect.arrayContaining(["gadget", "gadgets"]),
    }]);
    await expect(reader.query({ kind: "gadgets", full: true })).resolves.toMatchObject({
      total: 1,
      items: [expect.objectContaining({ kind: "Gadget" })],
    });
    await expect(reader.query({ kind: "gadgets.example.test" })).resolves.toMatchObject({
      total: 1,
    });

    const configMaps = await reader.query({ kind: "ConfigMap", name: "app", full: true });
    expect(configMaps.items[0]?.data).toEqual({ mode: "test" });
    expect(reader.diagnostics[0]).toContain("custom/bad.json");
  });

  it("builds an overview and reads both pod-log layouts", async () => {
    const { reader } = await fixture();
    const overview = await reader.overview(10);

    expect(overview.notReadyPods).toHaveLength(1);
    expect(overview.warningEvents).toHaveLength(1);
    await expect(reader.podLogs("default", "web-0", "app", 2)).resolves.toBe("two\nthree\n");
    await expect(reader.podLogs("default", "worker-0", "worker", 1)).resolves.toBe("beta\n");
    await expect(reader.queryPodLogs({
      namespace: "default",
      labels: { app: "worker" },
      search: "BETA",
    })).resolves.toMatchObject({
      matchedPods: 1,
      logs: [{ pod: "worker-0", container: "worker", text: "beta\n" }],
    });
    await expect(reader.queryPodLogs({
      namespace: "default",
      pod: "worker-0",
      previous: true,
      search: "failure",
    })).resolves.toMatchObject({
      logs: [{ pod: "worker-0", container: "worker", text: "old failure\n" }],
    });
  });

  it("lists, reads, and searches bounded raw bundle files", async () => {
    const { reader } = await fixture();

    await expect(reader.listFiles("host-collectors")).resolves.toMatchObject({
      total: 1,
      files: [{ path: "host-collectors/system/node-1/cpu.txt" }],
    });
    await expect(reader.readBundleFile("host-collectors/system/node-1/cpu.txt")).resolves
      .toMatchObject({ text: "CPU healthy\nrequest failed with 404\n", truncated: false });
    await expect(reader.searchFiles("FAILED WITH 404", "host-collectors")).resolves.toMatchObject({
      matches: [{ path: "host-collectors/system/node-1/cpu.txt", line: 2 }],
    });
    await expect(reader.readBundleFile("../outside")).rejects.toThrow("Unsafe bundle path");
  });

  it("rejects archive traversal before writing outside the destination", async () => {
    const { dir, path } = await archive({
      "../escape.txt": "nope",
      "fixture/cluster-resources/nodes.json": "[]",
    });
    const extraction = join(dir, "unsafe");

    await expect(extractBundleArchive(path, extraction)).rejects.toThrow("Unsafe archive path");
    await expect(readFile(join(dir, "escape.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
