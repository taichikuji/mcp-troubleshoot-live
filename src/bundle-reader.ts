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

type LabelQuery = {
  labels?: Record<string, string>;
  labelIn?: Record<string, string[]>;
  labelNotIn?: Record<string, string[]>;
  labelExists?: string[];
  labelNotExists?: string[];
};

type LogSource = {
  path: string;
  relativePath: string;
  namespace: string;
  pod: string;
  container: string;
  previous: boolean;
};

export type ResourceQuery = LabelQuery & {
  kind: string;
  apiVersion?: string;
  namespace?: string;
  name?: string;
  fields?: Record<string, string>;
  fieldNotEquals?: Record<string, string>;
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

export type PodLogQuery = LabelQuery & {
  namespace?: string;
  pod?: string;
  container?: string;
  search?: string;
  ignoreCase?: boolean;
  previous?: boolean;
  tail?: number;
  offset?: number;
  limit?: number;
  lineOffset?: number;
  lineLimit?: number;
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

const hasLabelQuery = (query: LabelQuery): boolean =>
  Boolean(
    query.labels ||
    query.labelIn ||
    query.labelNotIn ||
    query.labelExists?.length ||
    query.labelNotExists?.length,
  );

const matchesLabels = (labels: KubeObject, query: LabelQuery): boolean => {
  if (
    query.labels &&
    Object.entries(query.labels).some(([key, value]) => labels[key] !== value)
  ) return false;
  if (
    query.labelIn &&
    Object.entries(query.labelIn).some(([key, values]) =>
      typeof labels[key] !== "string" || !values.includes(labels[key] as string)
    )
  ) return false;
  if (
    query.labelNotIn &&
    Object.entries(query.labelNotIn).some(([key, values]) =>
      typeof labels[key] === "string" && values.includes(labels[key] as string)
    )
  ) return false;
  if (query.labelExists?.some((key) => typeof labels[key] !== "string")) return false;
  if (query.labelNotExists?.some((key) => typeof labels[key] === "string")) return false;
  return true;
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
      // Troubleshoot archives contain convenience links for named log collectors.
      // Never materialize links; canonical log files are stored separately.
      if (header.type === "symlink" || header.type === "link") {
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
  private readonly sourceAliases = new Map<ResourceSource, Set<string>>();
  private readonly parsed = new Map<string, KubeObject[]>();
  private readonly logSources: LogSource[] = [];

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

  private addAlias(source: ResourceSource, alias: string): void {
    const normalized = normalizeKind(alias);
    if (!normalized) return;
    const entries = this.sources.get(normalized) ?? new Set<ResourceSource>();
    entries.add(source);
    this.sources.set(normalized, entries);
    const aliases = this.sourceAliases.get(source) ?? new Set<string>();
    aliases.add(alias.toLowerCase());
    this.sourceAliases.set(source, aliases);
  }

  private addSource(source: ResourceSource, extraAlias?: string): void {
    for (const alias of [...aliasesFor(source.kind), extraAlias ?? ""]) {
      this.addAlias(source, alias);
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
    await this.addDiscoveryAliases(resourcesRoot);
    await this.indexPodLogs(signal);
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
        for (const alias of namesAndAliases) {
          for (const target of targets) this.addAlias(target, alias);
        }
      }
    }
  }

  private async addDiscoveryAliases(resourcesRoot: string): Promise<void> {
    try {
      const lists = JSON.parse(await readFile(join(resourcesRoot, "resources.json"), "utf8"));
      if (!Array.isArray(lists)) return;
      for (const value of lists) {
        const list = asObject(value);
        if (!list || typeof list.groupVersion !== "string" || !Array.isArray(list.resources)) {
          continue;
        }
        const group = list.groupVersion.includes("/") ? list.groupVersion.split("/")[0]! : "";
        for (const resourceValue of list.resources) {
          const resource = asObject(resourceValue);
          if (
            !resource ||
            typeof resource.kind !== "string" ||
            typeof resource.name !== "string" ||
            resource.name.includes("/")
          ) continue;
          const targets = this.sources.get(normalizeKind(resource.kind));
          if (!targets) continue;
          const aliases = [
            resource.name,
            resource.singularName,
            ...(Array.isArray(resource.shortNames) ? resource.shortNames : []),
          ].filter((alias): alias is string => typeof alias === "string" && alias.length > 0);
          if (group) {
            aliases.push(`${resource.name}.${group}`);
            if (typeof resource.singularName === "string" && resource.singularName) {
              aliases.push(`${resource.singularName}.${group}`);
            }
          }
          for (const source of targets) {
            if (source.apiVersion && source.apiVersion !== list.groupVersion) continue;
            for (const alias of aliases) this.addAlias(source, alias);
          }
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.diagnostics.push(
          `cluster-resources/resources.json: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async indexPodLogs(signal?: AbortSignal): Promise<void> {
    const logsRoot = join(this.root, "cluster-resources", "pods", "logs");
    try {
      for (const path of await walkFiles(logsRoot, signal)) {
        const rel = relative(logsRoot, path).split(sep).join("/");
        const parts = rel.split("/");
        if (parts.length !== 3 || !parts[2]!.endsWith(".log")) continue;
        const file = parts[2]!;
        if (file.endsWith("-logs-errors.log")) continue;
        const previous = file.endsWith("-previous.log");
        const container = file.slice(0, previous ? -"-previous.log".length : -".log".length);
        if (!container) continue;
        this.logSources.push({
          path,
          relativePath: relative(this.root, path).split(sep).join("/"),
          namespace: parts[0]!,
          pod: parts[1]!,
          container,
          previous,
        });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
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
    const unique = new Map<string, {
      kind: string;
      apiVersion?: string;
      aliases: Set<string>;
    }>();
    for (const [source, sourceAliases] of this.sourceAliases) {
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
        [...entry.aliases].some((alias) => normalizeKind(alias).includes(needle))
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
        if (!matchesLabels(asObject(meta.labels) ?? {}, query)) continue;
        if (
          query.fields &&
          Object.entries(query.fields).some(([key, value]) => String(nested(object, key)) !== value)
        ) continue;
        if (
          query.fieldNotEquals &&
          Object.entries(query.fieldNotEquals).some(([key, value]) =>
            String(nested(object, key)) === value
          )
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

  private async exactLogSource(
    namespace: string,
    pod: string,
    container: string,
    previous: boolean,
  ): Promise<LogSource | null> {
    const suffix = `${container}${previous ? "-previous" : ""}.log`;
    const paths = [
      join(this.root, "pod-logs", namespace, `${pod}-${suffix}`),
      join(this.root, "cluster-resources", "pods", "logs", namespace, pod, suffix),
    ];
    for (const path of paths) {
      try {
        if (!(await stat(path)).isFile()) continue;
        return {
          path,
          relativePath: relative(this.root, path).split(sep).join("/"),
          namespace,
          pod,
          container,
          previous,
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    return null;
  }

  async queryPodLogs(query: PodLogQuery): Promise<{
    matchedPods: number;
    total: number;
    offset: number;
    returned: number;
    truncated: boolean;
    nextOffset?: number;
    logs: Array<{
      namespace: string;
      pod: string;
      container: string;
      previous: boolean;
      path: string;
      totalLines: number;
      matchedLines?: number;
      lineOffset: number;
      returnedLines: number;
      nextLineOffset?: number;
      text: string;
    }>;
  }> {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const tail = Math.min(Math.max(query.tail ?? 200, 1), 10_000);
    const offset = Math.max(query.offset ?? 0, 0);
    const lineLimit = Math.min(Math.max(query.lineLimit ?? 200, 1), 10_000);
    const previous = query.previous ?? false;
    const podItems = this.sources.has(normalizeKind("Pod"))
      ? (await this.query({
        kind: "Pod",
        namespace: query.namespace,
        name: query.pod,
        labels: query.labels,
        labelIn: query.labelIn,
        labelNotIn: query.labelNotIn,
        labelExists: query.labelExists,
        labelNotExists: query.labelNotExists,
        limit: 50_000,
        full: true,
      })).items
      : [];
    const selectedPods = new Set<string>();
    const candidates = new Map<string, LogSource>();
    const addCandidate = (source: LogSource): void => {
      candidates.set(source.path, source);
    };

    for (const podObject of podItems) {
      const meta = metadata(podObject);
      const namespace = String(meta.namespace ?? "default");
      const pod = String(meta.name ?? "");
      selectedPods.add(`${namespace}\0${pod}`);
      const spec = asObject(podObject.spec) ?? {};
      const containerNames = [
        ...(Array.isArray(spec.initContainers) ? spec.initContainers : []),
        ...(Array.isArray(spec.containers) ? spec.containers : []),
        ...(Array.isArray(spec.ephemeralContainers) ? spec.ephemeralContainers : []),
      ].map((container) => String(asObject(container)?.name ?? "")).filter(Boolean);
      for (const container of query.container ? [query.container] : containerNames) {
        const source = await this.exactLogSource(namespace, pod, container, previous);
        if (source) addCandidate(source);
      }
    }

    for (const source of this.logSources) {
      if (source.previous !== previous) continue;
      if (query.namespace && source.namespace !== query.namespace) continue;
      if (query.pod && source.pod !== query.pod) continue;
      if (query.container && source.container !== query.container) continue;
      if (hasLabelQuery(query) && !selectedPods.has(`${source.namespace}\0${source.pod}`)) continue;
      addCandidate(source);
    }
    if (query.namespace && query.pod && query.container) {
      const source = await this.exactLogSource(
        query.namespace,
        query.pod,
        query.container,
        previous,
      );
      if (source) addCandidate(source);
    }

    const ordered = [...candidates.values()].sort((a, b) =>
      `${a.namespace}/${a.pod}/${a.container}/${a.relativePath}`.localeCompare(
        `${b.namespace}/${b.pod}/${b.container}/${b.relativePath}`,
      )
    );
    const page = ordered.slice(offset, offset + limit);
    const logs = [];
    for (const source of page) {
      const data = await readFile(source.path, "utf8");
      const trailingNewline = /\r?\n$/.test(data);
      const body = data.replace(/\r?\n$/, "");
      const allLines = body ? body.split(/\r?\n/) : [];
      const needle = query.search &&
        (query.ignoreCase === false ? query.search : query.search.toLowerCase());
      const filtered = needle
        ? allLines.filter((line) =>
          (query.ignoreCase === false ? line : line.toLowerCase()).includes(needle)
        )
        : allLines;
      if (query.search && filtered.length === 0) continue;
      const lineOffset = query.lineOffset === undefined
        ? Math.max(filtered.length - tail, 0)
        : Math.max(query.lineOffset, 0);
      const lines = filtered.slice(
        lineOffset,
        lineOffset + (query.lineOffset === undefined ? tail : lineLimit),
      );
      const nextLineOffset = lineOffset + lines.length;
      let text = lines.join("\n");
      if (text && (trailingNewline || query.search)) text += "\n";
      logs.push({
        namespace: source.namespace,
        pod: source.pod,
        container: source.container,
        previous: source.previous,
        path: source.relativePath,
        totalLines: allLines.length,
        ...(query.search ? { matchedLines: filtered.length } : {}),
        lineOffset,
        returnedLines: lines.length,
        ...(nextLineOffset < filtered.length ? { nextLineOffset } : {}),
        text,
      });
    }
    const nextOffset = offset + page.length;
    return {
      matchedPods: new Set(ordered.map((source) => `${source.namespace}\0${source.pod}`)).size,
      total: ordered.length,
      offset,
      returned: logs.length,
      truncated: nextOffset < ordered.length,
      ...(nextOffset < ordered.length ? { nextOffset } : {}),
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
