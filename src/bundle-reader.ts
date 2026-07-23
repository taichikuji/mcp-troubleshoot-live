import { createReadStream, createWriteStream } from "fs";
import {
  mkdir,
  open,
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
  fieldContains?: Record<string, string>;
  owner?: string;
  sortBy?: string;
  sortDesc?: boolean;
  offset?: number;
  limit?: number;
  full?: boolean;
};

export type ResourceQueryResult = {
  kind: string;
  total: number;
  offset: number;
  returned: number;
  truncated: boolean;
  nextOffset?: number;
  items: KubeObject[];
};

export type PodLogQuery = {
  namespace?: string;
  pod?: string;
  container?: string;
  labels?: Record<string, string>;
  search?: string;
  ignoreCase?: boolean;
  previous?: boolean;
  tail?: number;
  limit?: number;
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
  for (const part of path.replace(/\[(\d+)\]/g, ".$1").split(".")) {
    if (Array.isArray(value) && /^\d+$/.test(part)) {
      value = value[Number(part)];
    } else {
      const current = asObject(value);
      if (!current) return undefined;
      value = current[part];
    }
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
  if (Array.isArray(value)) return value.flatMap(parseObjectList);
  const object = asObject(value);
  if (!object) return [];
  if (Array.isArray(object.items)) {
    return object.items.flatMap(parseObjectList);
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
        const discovered = new Map<string, ResourceSource>();
        for (const object of await parseResourceFile(path)) {
          if (typeof object.kind !== "string") continue;
          const apiVersion = typeof object.apiVersion === "string" ? object.apiVersion : undefined;
          discovered.set(`${object.kind}|${apiVersion ?? ""}`, {
            path,
            kind: object.kind,
            apiVersion,
          });
        }
        for (const source of discovered.values()) this.addSource(source, rel.split("/")[0]);
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
    await this.addCrdAliases();
  }

  private async addCrdAliases(): Promise<void> {
    const crdSources = this.sources.get(normalizeKind("CustomResourceDefinition"));
    if (!crdSources) return;
    for (const source of crdSources) {
      for (const crd of await this.load(source)) {
        const spec = asObject(crd.spec);
        const names = asObject(spec?.names);
        const kind = typeof names?.kind === "string" ? names.kind : "";
        const targets = this.sources.get(normalizeKind(kind));
        if (!targets) continue;
        const group = typeof spec?.group === "string" ? spec.group : "";
        const namesAndAliases = [
          names?.plural,
          names?.singular,
          ...(Array.isArray(names?.shortNames) ? names.shortNames : []),
        ].filter((value): value is string => typeof value === "string" && value.length > 0);
        if (group) {
          namesAndAliases.push(...namesAndAliases.slice(0, 2).map((name) => `${name}.${group}`));
        }
        for (const alias of namesAndAliases.map(normalizeKind)) {
          const entries = this.sources.get(alias) ?? new Set<ResourceSource>();
          for (const target of targets) entries.add(target);
          this.sources.set(alias, entries);
        }
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

  resourceCatalog(search?: string): Array<{
    kind: string;
    apiVersion?: string;
    aliases: string[];
  }> {
    const aliases = new Map<ResourceSource, Set<string>>();
    for (const [alias, sources] of this.sources) {
      for (const source of sources) {
        const values = aliases.get(source) ?? new Set<string>();
        values.add(alias);
        aliases.set(source, values);
      }
    }
    const unique = new Map<string, {
      kind: string;
      apiVersion?: string;
      aliases: Set<string>;
    }>();
    for (const [source, sourceAliases] of aliases) {
      const key = `${source.kind}|${source.apiVersion ?? ""}`;
      const entry = unique.get(key) ?? {
        kind: source.kind,
        apiVersion: source.apiVersion,
        aliases: new Set<string>(),
      };
      for (const alias of sourceAliases) entry.aliases.add(alias);
      unique.set(key, entry);
    }
    const needle = normalizeKind(search ?? "");
    return [...unique.values()]
      .filter((entry) =>
        !needle ||
        normalizeKind(entry.kind).includes(needle) ||
        normalizeKind(entry.apiVersion ?? "").includes(needle) ||
        [...entry.aliases].some((alias) => alias.includes(needle))
      )
      .map((entry) => ({
        kind: entry.kind,
        apiVersion: entry.apiVersion,
        aliases: [...entry.aliases].sort(),
      }))
      .sort((a, b) => a.kind.localeCompare(b.kind));
  }

  async query(query: ResourceQuery): Promise<ResourceQueryResult> {
    const requestedKind = normalizeKind(query.kind);
    const sources = this.sources.get(requestedKind);
    if (!sources) {
      const suggestions = this.resourceCatalog(query.kind).slice(0, 10).map((entry) => entry.kind);
      throw new Error(
        `Unknown resource kind '${query.kind}'.` +
        (suggestions.length ? ` Possible matches: ${suggestions.join(", ")}.` : "") +
        " Use resource_catalog to discover collected kinds and aliases.",
      );
    }
    const offset = Math.max(query.offset ?? 0, 0);
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 50_000);
    const matches: KubeObject[] = [];

    for (const source of sources) {
      for (const object of await this.load(source)) {
        if (normalizeKind(String(object.kind ?? source.kind)) !== normalizeKind(source.kind)) continue;
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
        if (
          query.fieldContains &&
          Object.entries(query.fieldContains).some(([key, value]) =>
            !String(nested(object, key) ?? "").includes(value)
          )
        ) continue;
        if (query.owner) {
          const owners = meta.ownerReferences;
          if (
            !Array.isArray(owners) ||
            !owners.some((owner) => {
              const reference = asObject(owner);
              return reference?.name === query.owner || reference?.uid === query.owner;
            })
          ) continue;
        }
        matches.push(object);
      }
    }
    if (query.sortBy) {
      matches.sort((a, b) => {
        const comparison = String(nested(a, query.sortBy!) ?? "")
          .localeCompare(String(nested(b, query.sortBy!) ?? ""), undefined, { numeric: true });
        return query.sortDesc ? -comparison : comparison;
      });
    }

    const items = matches
      .slice(offset, offset + limit)
      .map((object) => query.full ? object : this.summarize(object));
    const nextOffset = offset + items.length;
    return {
      kind: query.kind,
      total: matches.length,
      offset,
      returned: items.length,
      truncated: nextOffset < matches.length,
      ...(nextOffset < matches.length ? { nextOffset } : {}),
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

  async podLogs(
    namespace: string,
    pod: string,
    container: string,
    tail = 200,
    previous = false,
  ): Promise<string> {
    const suffix = `${container}${previous ? "-previous" : ""}.log`;
    const candidates = [
      join(this.root, "pod-logs", namespace, `${pod}-${suffix}`),
      join(this.root, "cluster-resources", "pods", "logs", namespace, pod, suffix),
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

  async queryPodLogs(query: PodLogQuery): Promise<{
    matchedPods: number;
    returned: number;
    truncated: boolean;
    logs: Array<{ namespace: string; pod: string; container: string; text: string }>;
  }> {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const tail = Math.min(Math.max(query.tail ?? 200, 1), 10_000);
    const pods = await this.query({
      kind: "Pod",
      namespace: query.namespace,
      name: query.pod,
      labels: query.labels,
      limit: 50_000,
      full: true,
    });
    const candidates: Array<{ namespace: string; pod: string; container: string }> = [];
    for (const podObject of pods.items) {
      const meta = metadata(podObject);
      const namespace = String(meta.namespace ?? "default");
      const pod = String(meta.name ?? "");
      const spec = asObject(podObject.spec) ?? {};
      const containerNames = [
        ...(Array.isArray(spec.initContainers) ? spec.initContainers : []),
        ...(Array.isArray(spec.containers) ? spec.containers : []),
        ...(Array.isArray(spec.ephemeralContainers) ? spec.ephemeralContainers : []),
      ].map((container) => String(asObject(container)?.name ?? "")).filter(Boolean);
      for (const container of query.container ? [query.container] : containerNames) {
        candidates.push({ namespace, pod, container });
      }
    }
    if (candidates.length === 0 && query.namespace && query.pod && query.container) {
      candidates.push({
        namespace: query.namespace,
        pod: query.pod,
        container: query.container,
      });
    }

    const logs: Array<{ namespace: string; pod: string; container: string; text: string }> = [];
    let truncated = false;
    for (const candidate of candidates) {
      if (logs.length >= limit) {
        truncated = true;
        break;
      }
      try {
        let text = await this.podLogs(
          candidate.namespace,
          candidate.pod,
          candidate.container,
          query.search ? 10_000 : tail,
          query.previous,
        );
        if (query.search) {
          const needle = query.ignoreCase === false ? query.search : query.search.toLowerCase();
          const lines = text.replace(/\r?\n$/, "").split(/\r?\n/).filter((line) => {
            const candidateLine = query.ignoreCase === false ? line : line.toLowerCase();
            return candidateLine.includes(needle);
          });
          text = lines.slice(-tail).join("\n");
          if (text) text += "\n";
        }
        if (!query.search || text) logs.push({ ...candidate, text });
      } catch (err) {
        if (!(err instanceof Error) || !err.message.startsWith("Logs not found")) throw err;
      }
    }
    return {
      matchedPods: pods.total,
      returned: logs.length,
      truncated,
      logs,
    };
  }

  private resolveBundleFile(path: string): string {
    if (!path || path.includes("\0") || path.includes("\\") || posix.isAbsolute(path)) {
      throw new Error(`Unsafe bundle path: ${JSON.stringify(path)}`);
    }
    const normalized = posix.normalize(path).replace(/^\.\//, "");
    if (!normalized || normalized === "." || normalized.split("/").includes("..")) {
      throw new Error(`Unsafe bundle path: ${JSON.stringify(path)}`);
    }
    const absolute = resolve(this.root, normalized);
    if (!absolute.startsWith(`${resolve(this.root)}${sep}`)) {
      throw new Error(`Bundle path escapes bundle root: ${JSON.stringify(path)}`);
    }
    return absolute;
  }

  async listFiles(prefix = "", limit = 200): Promise<{
    total: number;
    returned: number;
    truncated: boolean;
    files: Array<{ path: string; sizeBytes: number }>;
  }> {
    const normalizedPrefix = prefix.replace(/^\/+/, "");
    const paths = (await walkFiles(this.root))
      .map((path) => relative(this.root, path).split(sep).join("/"))
      .filter((path) => path.startsWith(normalizedPrefix))
      .sort();
    const selected = paths.slice(0, Math.min(Math.max(limit, 1), 500));
    const files = await Promise.all(selected.map(async (path) => ({
      path,
      sizeBytes: (await stat(this.resolveBundleFile(path))).size,
    })));
    return {
      total: paths.length,
      returned: files.length,
      truncated: paths.length > files.length,
      files,
    };
  }

  async readBundleFile(path: string, maxBytes = 200 * 1024): Promise<{
    path: string;
    sizeBytes: number;
    truncated: boolean;
    text: string;
  }> {
    const absolute = this.resolveBundleFile(path);
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error(`Not a file: ${path}`);
    const bytesToRead = Math.min(info.size, Math.min(Math.max(maxBytes, 1), 1024 * 1024));
    const buffer = Buffer.alloc(bytesToRead);
    const handle = await open(absolute, "r");
    try {
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
      const content = buffer.subarray(0, bytesRead);
      if (content.includes(0)) throw new Error(`Bundle file is binary: ${path}`);
      return {
        path,
        sizeBytes: info.size,
        truncated: info.size > bytesRead,
        text: content.toString("utf8"),
      };
    } finally {
      await handle.close();
    }
  }

  async searchFiles(
    query: string,
    prefix = "",
    limit = 100,
    ignoreCase = true,
  ): Promise<{
    scannedFiles: number;
    scannedBytes: number;
    truncated: boolean;
    matches: Array<{ path: string; line: number; text: string }>;
  }> {
    if (!query) throw new Error("Search query cannot be empty");
    const normalizedPrefix = prefix.replace(/^\/+/, "");
    const paths = (await walkFiles(this.root))
      .map((path) => relative(this.root, path).split(sep).join("/"))
      .filter((path) => path.startsWith(normalizedPrefix))
      .sort();
    const maxMatches = Math.min(Math.max(limit, 1), 500);
    const needle = ignoreCase ? query.toLowerCase() : query;
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let scannedFiles = 0;
    let scannedBytes = 0;
    let truncated = false;

    for (const path of paths) {
      const absolute = this.resolveBundleFile(path);
      const info = await stat(absolute);
      if (info.size > 2 * 1024 * 1024) continue;
      if (scannedBytes + info.size > 64 * 1024 * 1024) {
        truncated = true;
        break;
      }
      const content = await readFile(absolute);
      if (content.includes(0)) continue;
      scannedFiles += 1;
      scannedBytes += content.length;
      for (const [index, line] of content.toString("utf8").split(/\r?\n/).entries()) {
        const candidate = ignoreCase ? line.toLowerCase() : line;
        if (!candidate.includes(needle)) continue;
        matches.push({ path, line: index + 1, text: line.slice(0, 1000) });
        if (matches.length >= maxMatches) {
          truncated = true;
          return { scannedFiles, scannedBytes, truncated, matches };
        }
      }
    }
    return { scannedFiles, scannedBytes, truncated, matches };
  }

  async overview(warningLimit = 50): Promise<KubeObject> {
    const optionalQuery = (kind: string, full = false): Promise<ResourceQueryResult> =>
      this.sources.has(normalizeKind(kind))
        ? this.query({ kind, limit: 50_000, full })
        : Promise.resolve({
          kind,
          total: 0,
          offset: 0,
          returned: 0,
          truncated: false,
          items: [],
        });
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
