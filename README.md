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

- 12 typed MCP tools for namespaces, nodes, workloads, logs, events, and
  generic `describe` / `get` / read-only `kubectl_run`.
- Auto-starts a bundle from `BUNDLE_PATH`, or load one on demand with the
  `start_bundle` tool.
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
cp /path/to/your-bundle.tar.gz bundles/bundle.tar.gz

docker compose up --build -d
docker compose logs -f
```

When you see `Kubernetes API is ready.` the server is good to go.

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
| `BUNDLE_PATH` | `/bundles/bundle.tar.gz` | Auto-start bundle. Unset to skip. |
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
| `start_bundle` | Load a bundle on demand (only needed if `BUNDLE_PATH` is unset). |
| `cluster_status` | Health check + namespace list. |
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

- `GET /sse` — MCP SSE transport.
- `POST /messages?sessionId=…` — MCP message ingress (paired with `/sse`).
- `GET /health` — `{ status, bundleReady, kubeconfig, bundlePath }`.

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
