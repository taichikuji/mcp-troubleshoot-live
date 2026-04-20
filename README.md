# troubleshoot-live MCP

A Dockerized [Model Context Protocol](https://modelcontextprotocol.io/) server
that wraps [`troubleshoot-live`](https://github.com/mhrabovcin/troubleshoot-live)
and exposes a Kubernetes support bundle as a set of `kubectl`-powered tools to
any MCP-aware client (Cursor, Claude Desktop, etc.) over SSE.

`troubleshoot-live` boots an envtest-backed kube-apiserver from a support
bundle. This server runs it inside a container, watches its kubeconfig, and
proxies a curated set of read-only `kubectl` commands as MCP tools so an LLM
can triage the bundle conversationally.

## Features

- 14 typed MCP tools for bundle lifecycle, namespaces, nodes, workloads,
  logs, events, and generic `describe` / `get` / read-only `kubectl_run`.
- Dynamic bundle switching: `list_bundles` / `start_bundle` / `stop_bundle`
  let the AI swap support bundles mid-conversation without restarting the
  container. Optional `BUNDLE_PATH` for auto-load on boot.
- Caches envtest binaries (kube-apiserver + etcd) in a named Docker volume so
  cold starts only happen once per arch.
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
mkdir -p bundles
cp /path/to/your-bundle.tar.gz bundles/

docker compose up --build -d
docker compose logs -f
```

The server starts with no bundle loaded. Drop any number of `.tar.gz` support
bundles into `./bundles/` and ask the AI to pick one — it will discover them
via `list_bundles` and load one with `start_bundle`. You can switch bundles
mid-conversation without restarting the container; the previous cluster is
torn down automatically.

If you want a specific bundle to auto-load on startup, set `BUNDLE_PATH` in
`.env` (e.g. `BUNDLE_PATH=/bundles/default.tar.gz`).

Then point your MCP client at it. For Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "troubleshoot-live": {
      "url": "http://localhost:3100/sse"
    }
  }
}
```

## Configuration

All config is via environment variables. See [`.env.example`](./.env.example)
for the full list. The most useful ones:

| Var | Default | Notes |
| --- | --- | --- |
| `BUNDLE_PATH` | _(unset)_ | If set, auto-loads this bundle on container startup. Otherwise the AI picks one via `list_bundles` / `start_bundle`. |
| `BUNDLES_DIR` | `/bundles` | Directory `list_bundles` scans. Mount your host bundle folder here. |
| `HOST_PORT` | `3100` | Host port mapped to the container's internal port 3000. Change if 3100 conflicts with another service. |
| `PROXY_ADDRESS` | `localhost:8080` | Where `troubleshoot-live` proxies the API. |
| `KUBECONFIG_PATH` | `/tmp/kubeconfig` | Where the kubeconfig is written. |
| `KUBECTL_TIMEOUT_MS` | `30000` | Per-call kubectl timeout. |
| `CLUSTER_READY_TIMEOUT_MS` | `120000` | Bundle readiness timeout. |

Build-time:

| ARG | Default |
| --- | --- |
| `KUBECTL_VERSION` | `v1.29.4` |
| `TROUBLESHOOT_LIVE_VERSION` | `v0.0.20` |

## Tools

| Tool | Purpose |
| --- | --- |
| `list_bundles` | List `.tar.gz` / `.tgz` / `.tar` bundles available under `/bundles`. |
| `start_bundle` | Load a bundle by filename or absolute path. **If a different bundle is already loaded it is unloaded first**, so you can switch bundles mid-conversation without restarting the container. |
| `stop_bundle` | Unload the current bundle and shut down the in-memory cluster. The MCP server stays up. |
| `cluster_status` | Health check, currently loaded bundle, and namespace list. |
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

## Prompting Cursor

Once the MCP server is connected (you'll see `troubleshoot-live` in Cursor's
MCP indicator with a green dot), just talk to the AI in plain English — it
will discover and call the tools on its own. The prompts below are
field-tested starting points; tweak as needed.

### Loading a bundle

> List the support bundles available, then load the most recent one.

The AI will call `list_bundles`, pick the newest by `MODIFIED`, then
`start_bundle`. First load takes ~30–90s on a cold container while envtest
binaries download and the bundle is imported; subsequent loads are seconds.

To target a specific file:

> Load the support bundle named `acme-prod-2026-04-19.tar.gz`.

To auto-load on boot instead, set `BUNDLE_PATH=/bundles/<name>` in `.env` and
`docker compose up -d` — `cluster_status` will show it ready immediately.

### Switching bundles mid-conversation

> Now switch to `acme-staging-2026-04-19.tar.gz` so I can compare.

`start_bundle` tears the old envtest cluster down, starts a new one, and the
conversation continues. Use `stop_bundle` if you just want to free resources.

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

Resource-specific deep dive:

> Describe the deployment `nginx-ingress-controller` in `ingress-nginx`
> and explain its current rollout status. If any replicas are unhealthy,
> show their pod-level events.

Networking / services:

> List all Services with type LoadBalancer that have no external IP yet,
> and check the corresponding Events for clues.

PersistentVolumes:

> Find any PVC stuck in Pending. For each, describe it and explain why
> the bind hasn't happened.

Cross-bundle comparison:

> Compare cluster health between the bundle currently loaded and the next
> one in the list. Load each in turn, capture pod readiness counts per
> namespace, then unload and summarize the diff.

### Pinning the AI to read-only

The server's `kubectl_run` already refuses mutating verbs. To make it
explicit in chat:

> All commands you run must be read-only. Use only `get`, `describe`, and
> `logs` style verbs. Do not attempt to apply, delete, edit, patch, exec,
> cp, drain, or scale anything.

### Inspecting raw YAML

> Show me the full YAML of the configmap `coredns` in `kube-system`.

Behind the scenes that's `get_resource` with `output: yaml`.

### Sanity checks

> What's the status of the troubleshoot-live cluster, and which bundle is
> loaded right now?

That's just `cluster_status` — useful as a first prompt to confirm the
connection is healthy.

## Endpoints

- `GET /sse` — MCP SSE transport.
- `POST /messages?sessionId=…` — MCP message ingress (paired with `/sse`).
- `GET /health` — `{ status, bundleReady, currentBundle, bundlesDir, kubeconfig, autoStartBundle }`.

## Local development

The container is the supported workflow, but if you want to iterate on the TS
code directly:

```bash
npm ci
npm run build
BUNDLE_PATH=/path/to/bundle.tar.gz \
  KUBECONFIG_PATH=/tmp/kubeconfig \
  node dist/index.js
```

You'll need `kubectl` and `troubleshoot-live` on your `PATH`.

## Operations

- `./deploy.sh` — pull latest, rebuild, restart.
- `./deploy.sh --prune` — full teardown (containers, local images, volumes).
- `./deploy.sh --reset` — `git reset --hard` to the remote default branch.

## Security notes

- The MCP server has no authentication; only expose it on `localhost` or
  behind a trusted reverse proxy.
- `kubectl_run` enforces a read-only verb allowlist, but support bundles can
  contain attacker-controlled strings in resource names. All other tools use
  `execFile` with array args so resource names are never interpreted by a
  shell.

## License

MIT.
