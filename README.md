# troubleshoot-live MCP

A Dockerized [Model Context Protocol](https://modelcontextprotocol.io/) server
that wraps [`troubleshoot-live`](https://github.com/mhrabovcin/troubleshoot-live)
and exposes a Kubernetes support bundle as a set of `kubectl`-powered tools to
any MCP-aware client (Cursor, Claude Desktop, etc.).

`troubleshoot-live` boots an envtest-backed kube-apiserver from a support
bundle. This server runs it inside a container, watches its kubeconfig, and
proxies a curated set of read-only `kubectl` commands as MCP tools so an LLM
can triage a bundle conversationally — including bundles that live only on
the user's local machine.

## How a bundle gets to the server

The MCP server can only investigate a bundle that exists on its own
filesystem. Two ways to get one there:

| Mode | When to use | What happens |
| --- | --- | --- |
| **B — Upload** *(default)* | Bundle is on the user's machine; MCP runs anywhere reachable by HTTP. | LLM calls `prepare_upload`, gets a `curl` command, runs it via the shell tool. The bundle streams to `/tmp/troubleshoot-mcp-uploads/` inside the container. Auto-deleted on `stop_bundle`, container restart, or after 6 h idle. |
| **A — Local share** *(optional, zero-copy)* | The "user's machine" and the MCP host share a filesystem (e.g. UTM/VirtFS/SMB share, NFS, or just localhost docker). | Bundle file appears in `/bundles` via a docker bind-mount. LLM calls `list_bundles` + `start_bundle` directly. No upload, no copy. |

You can use both at the same time. Mode A is faster for files you already
have laid out; mode B works regardless of where the MCP runs.

## Features

- 16 typed MCP tools for upload, bundle lifecycle, namespaces, nodes,
  workloads, logs, events, batched cluster overview, and generic
  `describe` / `get` / read-only `kubectl_run`.
- `prepare_upload` tool — emits a `curl` command the LLM runs from the
  user's shell to push a local bundle to the server. No `scp`, no manual
  file moves.
- Streaming raw-`PUT` upload endpoint with size cap (5 GB default) and
  guaranteed cleanup: deleted on `stop_bundle`, on container restart, and
  via a TTL reaper.
- Dynamic bundle switching: `list_bundles` / `start_bundle` / `stop_bundle`
  let the AI swap support bundles mid-conversation without restarting the
  container. Optional `BUNDLE_PATH` for auto-load on boot.
- Caches envtest binaries (kube-apiserver + etcd) in a named Docker volume
  so cold starts only happen once per arch.
- Multi-arch Dockerfile (`amd64` + `arm64`) on `node:22-bookworm-slim`,
  runs as the unprivileged `node` user.
- Read-only `kubectl_run` allowlist — mutating verbs (`apply`, `delete`,
  `patch`, `exec`, `cp`, `drain`, `scale`, …) are refused.
- `/health` endpoint and Docker `HEALTHCHECK` for orchestration.
- Graceful shutdown: SIGTERM/SIGINT cleanly stop the `troubleshoot-live`
  child process before exiting.

## Quick start

```bash
cp .env.example .env
docker compose up --build -d
docker compose logs -f
```

No `PUBLIC_URL` setup is needed in normal cases — the server derives the
upload base URL per-request from the client's `Host` header (and
`X-Forwarded-*` if behind a reverse proxy). So Cursor on a Mac talking to an
MCP container on `192.168.64.12:3100` will get told to upload to
`http://192.168.64.12:3100/...` automatically; Cursor talking to
`https://mcp.corp.example.com` (terminated by nginx) will get told to upload
to that same hostname over HTTPS.

Only set `PUBLIC_URL` in `.env` if auto-detection is wrong (e.g. a CDN that
rewrites `Host` without setting `X-Forwarded-*`).

Point your MCP client at the server. For Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "troubleshoot-live": {
      "url": "http://<host>:3100/mcp"
    }
  }
}
```

## Typical workflow

User to Cursor:

> Use the troubleshoot-live MCP to investigate `~/Downloads/acme-prod.tar.gz`.

What happens:

1. LLM calls `prepare_upload({ local_path: "/Users/.../acme-prod.tar.gz" })`.
2. Tool returns a `curl --upload-file ... http://<host>:3100/bundles/upload/acme-prod.tar.gz` command.
3. LLM runs the curl via the shell tool. Server streams the file to
   `/tmp/troubleshoot-mcp-uploads/<uuid>-acme-prod.tar.gz` and returns
   `{ path, name, sizeBytes }`.
4. LLM calls `start_bundle({ bundle_path: "<returned path>" })`. It returns
   **immediately** with `status=loading` (cold load) or `status=ready` (warm).
5. LLM polls `cluster_status` every few seconds until it reports `status=ready`.
   Cold loads take 1–3 minutes (envtest binary download); warm loads ~5–30s.
   This polling pattern keeps the LLM client from hitting its tool-call
   timeout (Cursor/Claude default ~60s).
6. Once ready, the LLM typically calls `cluster_overview` first for a batched
   triage pass (nodes + namespaces + not-ready pods + Warning events in one
   round-trip), then drills in with `get_pod_logs`, `describe_resource`,
   `kubectl_run`, etc. Inspection tools called while a load is still in
   progress refuse with a "still loading" hint.
7. When done, `stop_bundle` shuts the cluster down and deletes the uploaded
   file. The MCP server itself stays up for the next bundle.

## Option A: zero-copy via local filesystem share

If the bundle is already accessible to the MCP host (same filesystem, NFS,
SMB, UTM share, or just `localhost` docker), skip the upload entirely and
mount it as `/bundles`:

### A.1 — Docker on the same host as the user

Already the default — `docker-compose.yml` mounts `./bundles` → `/bundles`.
Drop bundles in `./bundles/` next to `docker-compose.yml`. The LLM finds
them via `list_bundles`.

### A.2 — Mac host, MCP in a UTM (Ubuntu) VM

UTM can share a Mac directory into the VM via VirtFS (QEMU backend) or
VirtioFS (Apple Virtualization backend). One-time setup:

1. **UTM** → VM Settings → **Sharing** → add a Directory Share (e.g.
   `~/Downloads`), set the mount tag to `bundles`. Save and reboot the VM.

2. **Inside the Ubuntu VM**, mount the share. For QEMU/VirtFS add to
   `/etc/fstab`:

   ```
   bundles  /mnt/mac-bundles  9p  trans=virtio,version=9p2000.L,rw,_netdev,uid=1000,gid=1000  0 0
   ```

   Then `sudo mkdir -p /mnt/mac-bundles && sudo mount -a`.

   For VirtioFS (UTM Apple Virtualization), use:

   ```
   bundles  /mnt/mac-bundles  virtiofs  defaults,_netdev  0 0
   ```

3. **Edit `docker-compose.yml`** — replace the `./bundles:/bundles` line
   with the share path:

   ```yaml
   volumes:
     - /mnt/mac-bundles:/bundles:ro
   ```

   `:ro` is recommended — `troubleshoot-live` only reads bundles.

4. `docker compose up -d`. Now any `.tar.gz` in `~/Downloads` shows up via
   `list_bundles` and loads with zero copying.

### A.3 — Other shares

NFS, SMB, sshfs all work the same way: mount on the MCP host, change the
left side of the `:` in the `docker-compose.yml` volume mount.

## Configuration

All config is via environment variables. See [`.env.example`](./.env.example)
for the full list. The most useful ones:

| Var | Default | Notes |
| --- | --- | --- |
| `HOST_PORT` | `3100` | Host port mapped to the container's internal port 3000. |
| `PUBLIC_URL` | _(unset; auto-detected per-request)_ | Override for the upload base URL shown by `prepare_upload`. Default behavior derives it from each MCP request's `Host` (with `X-Forwarded-*` honored behind a proxy). Set only if auto-detection is wrong. |
| `BUNDLE_PATH` | _(unset)_ | If set, auto-loads this bundle on container startup. |
| `BUNDLES_DIR` | `/bundles` | Directory `list_bundles` scans (mode A). |
| `UPLOAD_DIR` | `/tmp/troubleshoot-mcp-uploads` | Where uploaded bundles land (mode B). Wiped on container restart. |
| `MAX_UPLOAD_BYTES` | `5368709120` (5 GB) | Per-upload size cap. |
| `UPLOAD_TTL_MS` | `21600000` (6 h) | Idle uploaded bundles older than this are reaped. The currently loaded bundle is always preserved. |
| `UPLOAD_SWEEP_INTERVAL_MS` | `1800000` (30 min) | How often the reaper runs. |
| `PROXY_ADDRESS` | `localhost:8080` | Where `troubleshoot-live` proxies the API inside the container. |
| `KUBECONFIG_PATH` | `/tmp/kubeconfig` | Where the kubeconfig is written. |
| `KUBECTL_TIMEOUT_MS` | `30000` | Per-call kubectl timeout. |
| `CLUSTER_READY_TIMEOUT_MS` | `300000` | Bundle readiness timeout. |
| `KUBECTL_CACHE_TTL_MS` | `300000` (5 min) | Per-bundle cache TTL for `kubectl` results. The loaded bundle is immutable, so identical queries within the TTL are served from memory. The cache is cleared automatically on `start_bundle` / `stop_bundle`. Set to `0` to disable. |
| `KUBECTL_CACHE_MAX_ENTRIES` | `256` | FIFO eviction cap on the cache. |
| `RESPONSE_SOFT_LIMIT_BYTES` | `204800` (200 KB) | Threshold above which tool responses get a non-truncating "narrow your query" hint appended. The full payload is still returned. |

Build-time:

| ARG | Default |
| --- | --- |
| `KUBECTL_VERSION` | `v1.29.4` |
| `TROUBLESHOOT_LIVE_VERSION` | `v0.0.20` |

## Tools

| Tool | Purpose |
| --- | --- |
| `prepare_upload` | Returns a `curl` command the LLM runs from the user's shell to push a local bundle to the server. Call FIRST when the bundle lives only on the user's machine. |
| `list_bundles` | List `.tar.gz` / `.tgz` / `.tar` bundles already in `/bundles` (mode A). |
| `start_bundle` | Load a bundle by filename in `/bundles`, absolute path under `/bundles`, or path/name returned by `prepare_upload`. Returns immediately with `status=loading` or `status=ready` — poll `cluster_status` until ready. Switching unloads the previous bundle automatically. |
| `stop_bundle` | Unload the current bundle, shut down the in-memory cluster, and delete the file IF it was uploaded. |
| `cluster_status` | Reports one of `idle` / `loading` / `ready` / `failed` (with crash detail). Use to poll after `start_bundle` and to confirm the cluster is responsive. On `ready` also returns the namespace list. |
| `cluster_overview` | Batched triage tool. One call returns nodes, namespaces, not-ready pods across all namespaces, and recent Warning events. Underlying kubectls run in parallel and all four results are cached. Prefer this over running `get_nodes` + `list_namespaces` + `get_pods` + `get_events` separately. Optional `warning_event_limit` (default 50, max 500) caps the warning tail. |
| `list_namespaces` | `kubectl get namespaces -o wide`. |
| `get_nodes` | `kubectl get nodes -o wide`. |
| `get_pods` | List pods, optionally scoped to a namespace. |
| `get_deployments` | List deployments, optionally scoped. |
| `get_services` | List services, optionally scoped. |
| `get_pod_logs` | Pod logs with `tail`, `previous`, `since`, `timestamps`. |
| `get_events` | Events sorted by time, optionally `Warning`-only. |
| `describe_resource` | `kubectl describe <kind> <name> [-n ns]`. |
| `get_resource` | Generic `kubectl get` with `wide`/`yaml`/`json`/`name` output. |
| `kubectl_run` | Read-only escape hatch with a verb allowlist. |

## Endpoints

- `POST /mcp` — MCP Streamable HTTP transport (current standard).
- `GET /sse` + `POST /messages?sessionId=…` — legacy MCP SSE transport.
- `PUT /bundles/upload/:name` — raw bundle upload. `name` must match
  `[A-Za-z0-9._-]+\.(tar\.gz|tgz|tar)`. Returns `201 {path, name, sizeBytes}`.
  Partial uploads are deleted if the client aborts mid-stream.
- `GET /health` — `{ status, bundleReady, bundleLoading, bundleLoadError, currentBundle, bundlesDir, uploadDir, kubeconfig, autoStartBundle }`.

## Prompting Cursor

Once connected (`troubleshoot-live` shows a green dot in Cursor's MCP
indicator), talk in plain English. The tool descriptions tell the LLM
when to upload and when not to, but you can be explicit:

### From a local file

> Use the troubleshoot-live MCP to investigate `~/Downloads/acme-prod.tar.gz`.

> Investigate the support bundle at `/Users/me/cases/12345/bundle.tgz`.

### From a server-side bundle (mode A)

> List the support bundles available, then load the most recent one.

> Load the support bundle named `acme-prod-2026-04-19.tar.gz`.

### Switching bundles mid-conversation

> Now switch to `acme-staging.tar.gz` so I can compare.

`start_bundle` tears the old envtest cluster down and kicks off a new one,
returning immediately. The LLM polls `cluster_status` until the new bundle
reports `ready` and then continues the conversation. Use `stop_bundle` to free
resources (and delete the upload, if it was one).

### Triage prompts

General health sweep:

> Give me a 1-paragraph summary of the cluster's overall health: node
> conditions, namespaces with not-ready pods, recent Warning events, and
> anything obviously broken.

Pod-level investigation:

> In the `kube-system` namespace, find any pod that isn't in Running/Ready
> state. For each one, show the last 100 lines of logs and any related
> Warning events from the last hour. Suggest a likely root cause.

CrashLoopBackOff hunt:

> List all pods across all namespaces in CrashLoopBackOff or Error state.
> For the worst offender, pull `kubectl describe`, current logs, and
> `--previous` logs. Tell me what's failing.

Networking / services:

> List all Services with type LoadBalancer that have no external IP yet,
> and check the corresponding Events for clues.

PersistentVolumes:

> Find any PVC stuck in Pending. For each, describe it and explain why
> the bind hasn't happened.

### Pinning the AI to read-only

The server's `kubectl_run` already refuses mutating verbs. To make it
explicit in chat:

> All commands you run must be read-only. Use only `get`, `describe`, and
> `logs` style verbs. Do not attempt to apply, delete, edit, patch, exec,
> cp, drain, or scale anything. Do NOT run kubectl on my local machine —
> always go through the troubleshoot-live MCP.

## Performance

- **Response cache**: `kubectl` results are cached per-bundle for 5 minutes
  (`KUBECTL_CACHE_TTL_MS`). The loaded bundle is an immutable envtest replay,
  so repeated identical queries inside a session are served from memory. The
  cache is cleared automatically when `start_bundle` switches bundles or
  `stop_bundle` unloads. Set `KUBECTL_CACHE_TTL_MS=0` to disable.
- **Batched triage**: `cluster_overview` collapses 3–4 separate calls into
  one and runs the underlying `kubectl` invocations in parallel
  (`Promise.all`).
- **Soft response limit**: payloads above `RESPONSE_SOFT_LIMIT_BYTES`
  (default 200 KB) are returned in full, with a "narrow your query" hint
  appended so the LLM knows to scope future calls with `-n`, `--selector`,
  `--field-selector`, or a single resource name.
- **Stderr-only logging**: all server diagnostics (including forwarded
  `troubleshoot-live` output) go to stderr. Stdout is reserved for any
  future STDIO-transport mode where MCP frames must not be interleaved with
  log noise.

## Local development

The container is the supported workflow, but if you want to iterate on the
TS code directly:

```bash
npm ci
npm run build
PUBLIC_URL=http://localhost:3000 \
  node dist/index.js
```

You'll need `kubectl` and `troubleshoot-live` on your `PATH`.

## Operations

- `./deploy.sh` — pull latest, rebuild, restart.
- `./deploy.sh --prune` — full teardown (containers, local images, volumes).
- `./deploy.sh --reset` — `git reset --hard` to the remote default branch.

## Security notes

- The MCP server has **no authentication**. Only expose it on `localhost`
  or a trusted network (LAN, VPN, behind a reverse proxy with auth).
- The upload endpoint accepts `.tar.gz` / `.tgz` / `.tar` files up to
  `MAX_UPLOAD_BYTES` from anyone who can reach the port. If the network
  is untrusted, put auth in front.
- `kubectl_run` enforces a read-only verb allowlist, but support bundles
  can contain attacker-controlled strings in resource names. All other
  tools use `execFile` with array args so resource names are never
  interpreted by a shell.
- Filenames in upload paths are restricted to `[A-Za-z0-9._-]+` and must
  end in a known archive extension. Any path components are stripped
  before the file lands in `UPLOAD_DIR`.

## License

MIT.
