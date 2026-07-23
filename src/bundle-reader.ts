import { createReadStream, createWriteStream } from "fs";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
} from "fs/promises";
import { basename, dirname, join, posix, relative, resolve, sep } from "path";
import { pipeline } from "stream/promises";
import { createGunzip } from "zlib";

import tar from "tar-stream";
import { parse as parseYaml } from "yaml";

import { MAX_ARCHIVE_FILES, MAX_EXTRACTED_BYTES } from "./config.js";

type KubeObject = Record<string, unknown>;

type ResourceSource = {
  path: string;
  kind: string;
  apiVersion?: string;
  special?: "configmap" | "secret";
};

export type ResourceQuery = {
  kind: string;
  apiVersion?: string;
  namespace?: string;
  name?: string;
  labels?: Record<string, string>;
  fields?: Record<string, string>;
  limit?: number;
  full?: boolean;
};

export type ResourceQueryResult = {
  kind: string;
  total: number;
  returned: number;
  truncated: boolean;
  items: KubeObject[];
};

const SKIP_RESOURCE_FILES = new Set([
  "groups.json",
  "pod-disruption-budgets-info.json",
  "resources.json",
]);

const PATH_GVK: Array<[RegExp, string, string]> = [
  [/^cronjobs\/[^/]+\.(json|ya?ml)$/i, "CronJob", "batch/v1"],
  [/^deployments\/[^/]+\.(json|ya?ml)$/i, "Deployment", "apps/v1"],
  [/^events\/[^/]+\.(json|ya?ml)$/i, "Event", "v1"],
  [/^ingress\/[^/]+\.(json|ya?ml)$/i, "Ingress", "networking.k8s.io/v1"],
  [/^jobs\/[^/]+\.(json|ya?ml)$/i, "Job", "batch/v1"],
  [/^limitranges\/[^/]+\.(json|ya?ml)$/i, "LimitRange", "v1"],
  [/^nodes\.(json|ya?ml)$/i, "Node", "v1"],
  [/^pods\/[^/]+\.(json|ya?ml)$/i, "Pod", "v1"],
  [/^pvcs\/[^/]+\.(json|ya?ml)$/i, "PersistentVolumeClaim", "v1"],
  [/^pvs\.(json|ya?ml)$/i, "PersistentVolume", "v1"],
  [/^replicasets\/[^/]+\.(json|ya?ml)$/i, "ReplicaSet", "apps/v1"],
  [/^services\/[^/]+\.(json|ya?ml)$/i, "Service", "v1"],
  [/^statefulsets\/[^/]+\.(json|ya?ml)$/i, "StatefulSet", "apps/v1"],
  [/^storage-classes\.(json|ya?ml)$/i, "StorageClass", "storage.k8s.io/v1"],
];

const asObject = (value: unknown): KubeObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as KubeObject
    : null;

const nested = (object: KubeObject, path: string): unknown => {
  let value: unknown = object;
  for (const part of path.split(".")) {
    const current = asObject(value);
    if (!current) return undefined;
    value = current[part];
  }
  return value;
};

const metadata = (object: KubeObject): KubeObject => asObject(object.metadata) ?? {};

const normalizeKind = (kind: string): string => kind.toLowerCase().replace(/[^a-z0-9]/g, "");

const aliasesFor = (kind: string): string[] => {
  const singular = normalizeKind(kind);
  const plural = singular.endsWith("s") ? `${singular}es` : `${singular}s`;
  return [singular, plural];
};

const parseObjectList = (value: unknown): KubeObject[] => {
  if (Array.isArray(value)) return value.map(asObject).filter((v): v is KubeObject => v !== null);
  const object = asObject(value);
  if (!object) return [];
  if (Array.isArray(object.items)) {
    return object.items.map(asObject).filter((v): v is KubeObject => v !== null);
  }
  return object.metadata || object.apiVersion || object.kind ? [object] : [];
};

async function parseResourceFile(path: string): Promise<KubeObject[]> {
  const data = await readFile(path, "utf8");
  const parsed = /\.ya?ml$/i.test(path) ? parseYaml(data) : JSON.parse(data);
  return parseObjectList(parsed);
}

function safeArchivePath(name: string, destination: string): string {
  if (!name || name.includes("\0") || name.includes("\\") || posix.isAbsolute(name)) {
    throw new Error(`Unsafe archive path: ${JSON.stringify(name)}`);
  }
  const normalized = posix.normalize(name).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe archive path: ${JSON.stringify(name)}`);
  }
  const output = resolve(destination, normalized);
  const root = resolve(destination);
  if (output !== root && !output.startsWith(`${root}${sep}`)) {
    throw new Error(`Archive path escapes extraction directory: ${JSON.stringify(name)}`);
  }
  return output;
}

export async function extractBundleArchive(
  archivePath: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  await mkdir(destination, { recursive: true });
  const extract = tar.extract();
  let entries = 0;
  let bytes = 0;

  extract.on("entry", (header, stream, next) => {
    void (async () => {
      entries += 1;
      if (entries > MAX_ARCHIVE_FILES) {
        throw new Error(`Archive contains more than ${MAX_ARCHIVE_FILES} entries`);
      }
      const output = safeArchivePath(header.name, destination);
      if (header.type === "directory") {
        await mkdir(output, { recursive: true });
        stream.once("end", next);
        stream.resume();
        return;
      }
      if (header.type !== "file") {
        throw new Error(`Unsupported archive entry type '${header.type}' at '${header.name}'`);
      }
      bytes += header.size ?? 0;
      if (bytes > MAX_EXTRACTED_BYTES) {
        throw new Error(`Archive expands beyond ${MAX_EXTRACTED_BYTES} bytes`);
      }
      await mkdir(dirname(output), { recursive: true });
      await pipeline(stream, createWriteStream(output, { mode: 0o600 }));
      next();
    })().catch((err: unknown) => extract.destroy(err as Error));
  });

  const source = createReadStream(archivePath);
  const input = /\.(tar\.gz|tgz)$/i.test(archivePath) ? source.pipe(createGunzip()) : source;
  try {
    await pipeline(input, extract, { signal });
  } catch (err) {
    await rm(destination, { recursive: true, force: true });
    throw err;
  }
}

async function walkFiles(root: string, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    signal?.throwIfAborted();
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(path, signal));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function locateBundleRoot(extracted: string, signal?: AbortSignal): Promise<string> {
  const candidates: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    signal?.throwIfAborted();
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      signal?.throwIfAborted();
      if (!entry.isDirectory()) continue;
      const child = join(dir, entry.name);
      if (entry.name === "cluster-resources") candidates.push(dir);
      else await visit(child);
    }
  };
  await visit(extracted);
  candidates.sort((a, b) => a.length - b.length);
  if (!candidates[0]) throw new Error("Archive does not contain a cluster-resources directory");
  return candidates[0];
}

function inferPathGVK(path: string): { kind: string; apiVersion: string } | null {
  if (/^namespaces\.(json|ya?ml)$/i.test(path)) return { kind: "Namespace", apiVersion: "v1" };
  if (/^custom-resource-definitions\.(json|ya?ml)$/i.test(path)) {
    return { kind: "CustomResourceDefinition", apiVersion: "apiextensions.k8s.io/v1" };
  }
  for (const [pattern, kind, apiVersion] of PATH_GVK) {
    if (pattern.test(path)) return { kind, apiVersion };
  }
  return null;
}

export class BundleReader {
  readonly root: string;
  readonly extractionDir: string;
  readonly diagnostics: string[] = [];

  private readonly sources = new Map<string, Set<ResourceSource>>();
  private readonly parsed = new Map<string, KubeObject[]>();

  private constructor(root: string, extractionDir: string) {
    this.root = root;
    this.extractionDir = extractionDir;
  }

  static async open(
    archivePath: string,
    extractionDir: string,
    onIndexing: () => void,
    signal?: AbortSignal,
  ): Promise<BundleReader> {
    try {
      await extractBundleArchive(archivePath, extractionDir, signal);
      onIndexing();
      const root = await locateBundleRoot(extractionDir, signal);
      const reader = new BundleReader(root, extractionDir);
      await reader.index(signal);
      return reader;
    } catch (err) {
      await rm(extractionDir, { recursive: true, force: true });
      throw err;
    }
  }

  private addSource(source: ResourceSource, extraAlias?: string): void {
    const aliases = new Set([...aliasesFor(source.kind), normalizeKind(extraAlias ?? "")]);
    for (const alias of aliases) {
      if (!alias) continue;
      const entries = this.sources.get(alias) ?? new Set<ResourceSource>();
      entries.add(source);
      this.sources.set(alias, entries);
    }
  }

  private async index(signal?: AbortSignal): Promise<void> {
    const resourcesRoot = join(this.root, "cluster-resources");
    for (const path of await walkFiles(resourcesRoot, signal)) {
      signal?.throwIfAborted();
      if (!/\.(json|ya?ml)$/i.test(path)) continue;
      const rel = relative(resourcesRoot, path).split(sep).join("/");
      const file = basename(path);
      if (
        SKIP_RESOURCE_FILES.has(file) ||
        /-errors\.(json|ya?ml)$/i.test(file) ||
        rel.startsWith("auth-cani-list/") ||
        rel.startsWith("pod-disruption-budgets/")
      ) continue;

      const inferred = inferPathGVK(rel);
      if (inferred) {
        this.addSource({ path, ...inferred }, rel.split("/")[0]);
        continue;
      }

      try {
        const [first] = await parseResourceFile(path);
        if (typeof first?.kind !== "string") continue;
        this.addSource({
          path,
          kind: first.kind,
          apiVersion: typeof first.apiVersion === "string" ? first.apiVersion : undefined,
        }, rel.split("/")[0]);
      } catch (err) {
        this.diagnostics.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    for (const [directory, kind, special] of [
      ["configmaps", "ConfigMap", "configmap"],
      ["secrets", "Secret", "secret"],
    ] as const) {
      const root = join(this.root, directory);
      try {
        for (const path of await walkFiles(root, signal)) {
          this.addSource({ path, kind, apiVersion: "v1", special });
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
  }

  private async load(source: ResourceSource): Promise<KubeObject[]> {
    const cached = this.parsed.get(source.path);
    if (cached) return cached;

    let objects: KubeObject[];
    if (source.special) {
      const value = asObject(JSON.parse(await readFile(source.path, "utf8")));
      if (!value) objects = [];
      else {
        const object: KubeObject = {
          apiVersion: "v1",
          kind: source.kind,
          metadata: {
            name: value.name,
            namespace: value.namespace,
          },
        };
        if (source.special === "configmap" && asObject(value.data)) object.data = value.data;
        objects = [object];
      }
    } else {
      objects = await parseResourceFile(source.path);
      for (const object of objects) {
        if (typeof object.kind !== "string") object.kind = source.kind;
        if (typeof object.apiVersion !== "string" && source.apiVersion) {
          object.apiVersion = source.apiVersion;
        }
      }
    }

    this.parsed.set(source.path, objects);
    if (this.parsed.size > 32) this.parsed.delete(this.parsed.keys().next().value!);
    return objects;
  }

  availableKinds(): string[] {
    const kinds = new Set<string>();
    for (const entries of this.sources.values()) {
      for (const source of entries) kinds.add(source.kind);
    }
    return [...kinds].sort();
  }

  async query(query: ResourceQuery): Promise<ResourceQueryResult> {
    const sources = this.sources.get(normalizeKind(query.kind));
    if (!sources) {
      throw new Error(
        `Unknown resource kind '${query.kind}'. Available kinds: ${this.availableKinds().join(", ")}`,
      );
    }
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 50_000);
    const matches: KubeObject[] = [];

    for (const source of sources) {
      for (const object of await this.load(source)) {
        const meta = metadata(object);
        if (query.apiVersion && object.apiVersion !== query.apiVersion) continue;
        if (query.namespace && meta.namespace !== query.namespace) continue;
        if (query.name && meta.name !== query.name) continue;
        if (
          query.labels &&
          Object.entries(query.labels).some(([key, value]) => asObject(meta.labels)?.[key] !== value)
        ) continue;
        if (
          query.fields &&
          Object.entries(query.fields).some(([key, value]) => String(nested(object, key)) !== value)
        ) continue;
        matches.push(object);
      }
    }

    const items = matches.slice(0, limit).map((object) => query.full ? object : this.summarize(object));
    return {
      kind: query.kind,
      total: matches.length,
      returned: items.length,
      truncated: matches.length > items.length,
      items,
    };
  }

  private summarize(object: KubeObject): KubeObject {
    const meta = metadata(object);
    const summary: KubeObject = {
      apiVersion: object.apiVersion,
      kind: object.kind,
      metadata: {
        name: meta.name,
        namespace: meta.namespace,
        labels: meta.labels,
        ownerReferences: meta.ownerReferences,
      },
    };
    if (object.status !== undefined) summary.status = object.status;
    return summary;
  }

  async podLogs(namespace: string, pod: string, container: string, tail = 200): Promise<string> {
    const candidates = [
      join(this.root, "pod-logs", namespace, `${pod}-${container}.log`),
      join(this.root, "cluster-resources", "pods", "logs", namespace, pod, `${container}.log`),
    ];
    let data: string | null = null;
    for (const path of candidates) {
      try {
        data = await readFile(path, "utf8");
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    if (data === null) {
      throw new Error(`Logs not found for ${namespace}/${pod} container '${container}'`);
    }
    const trailingNewline = /\r?\n$/.test(data);
    const lines = data.replace(/\r?\n$/, "").split(/\r?\n/);
    const output = lines.slice(-Math.min(Math.max(tail, 1), 10_000)).join("\n");
    return trailingNewline ? `${output}\n` : output;
  }

  async overview(warningLimit = 50): Promise<KubeObject> {
    const optionalQuery = (kind: string, full = false): Promise<ResourceQueryResult> =>
      this.sources.has(normalizeKind(kind))
        ? this.query({ kind, limit: 50_000, full })
        : Promise.resolve({ kind, total: 0, returned: 0, truncated: false, items: [] });
    const [nodes, namespaces, pods, events] = await Promise.all([
      optionalQuery("Node"),
      optionalQuery("Namespace"),
      optionalQuery("Pod"),
      optionalQuery("Event", true),
    ]);
    const notReadyPods = pods.items.filter((pod) => {
      const phase = nested(pod, "status.phase");
      if (phase !== "Running" && phase !== "Succeeded") return true;
      const statuses = nested(pod, "status.containerStatuses");
      return Array.isArray(statuses) && statuses.some((status) => asObject(status)?.ready === false);
    });
    const warnings = events.items
      .filter((event) => event.type === "Warning")
      .sort((a, b) => String(a.lastTimestamp ?? "").localeCompare(String(b.lastTimestamp ?? "")))
      .slice(-Math.min(Math.max(warningLimit, 1), 500));
    return {
      nodes: nodes.items,
      namespaces: namespaces.items,
      notReadyPods,
      warningEvents: warnings,
      diagnostics: this.diagnostics,
    };
  }

  async destroy(): Promise<void> {
    this.parsed.clear();
    await rm(this.extractionDir, { recursive: true, force: true });
  }
}
