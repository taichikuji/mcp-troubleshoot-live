# troubleshoot-live MCP

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.8-blue?logo=typescript" />
  <img src="https://img.shields.io/github/license/taichikuji/mcp-troubleshoot-live?color=FF3351&logo=github" />
  <img src="https://img.shields.io/github/commit-activity/w/taichikuji/mcp-troubleshoot-live?label=commits&logo=github" />
</p>

## What is this?

A Dockerized [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that wraps [`troubleshoot-live`](https://github.com/mhrabovcin/troubleshoot-live).

It boots an envtest Kubernetes apiserver from a support bundle and gives your AI assistant (Cursor, Claude Desktop, etc.) a set of read-only `kubectl` tools to investigate it.

## Why?

Digging through Kubernetes support bundles manually is tedious. I wanted to just *talk* to my bundle instead.

With 7 focused tools, you can triage conversationally — even when the bundle only lives on your local machine.

## How do I use it?

```bash
cp .env.example .env
docker compose up --build -d
docker compose logs -f
```

Then point your MCP client at the server. For Cursor, add this to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "troubleshoot-live": {
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

If you're running on a different host, swap `localhost` for the host's IP.

## How do bundles get to the server?

Two ways:

1. **Upload directly** (default) — tell the AI: *"investigate `~/Downloads/bundle.tar.gz`"*. It calls `prepare_upload`, which returns a one-line JSON payload with upload commands (`windows.shell`, `unix.sh`) plus metadata (`uploadUrl`, size/TTL limits). `windows.shell` uses `curl.exe` to avoid the older PowerShell `curl` alias behavior. `unix.sh` works for Linux and macOS.
2. **Shared folder** — if your MCP host and machine share a filesystem (Docker bind-mount, UTM share, etc.), drop the bundle in `/bundles`. The AI finds it with `list_bundles`.

`prepare_upload` response contract:

```json
{"schemaVersion":2,"commands":{"windows":{"shell":"curl.exe -fsS --upload-file \"C:\\path\\file.tar.gz\" \"http://host/bundles/upload/file.tar.gz\""},"unix":{"sh":"curl -fsS --upload-file '/path/file.tar.gz' 'http://host/bundles/upload/file.tar.gz'"}},"uploadUrl":"http://host/bundles/upload/file.tar.gz","limits":{"maxSizeBytes":5368709120,"ttlMs":21600000}}
```

## What can I ask?

* *"Give me a 1-paragraph summary of the cluster's overall health: node conditions, namespaces with not-ready pods, and recent Warning events."*
* *"List all pods in CrashLoopBackOff across all namespaces. For the worst offender, pull the logs and tell me what's failing."*
* *"Find any PVC stuck in Pending and explain why it hasn't bound."*

## What tools does it have?

It comes packed with 7 focused tools to help you out!

| Tool | Purpose |
| --- | --- |
| `prepare_upload` | Uploads a local bundle to the server. |
| `list_bundles` | Lists bundles already in `/bundles`. |
| `start_bundle` | Loads a bundle into the live cluster. |
| `stop_bundle` | Unloads the current bundle and cleans up. |
| `cluster_status` | Reports if the cluster is `idle`, `loading`, `ready`, or `failed`. |
| `cluster_overview` | **Batched triage tool!** Gets nodes, namespaces, not-ready pods, and warnings in one go. |
| `kubectl_run` | Read-only kubectl for all queries — supports `grep` filter param. |

## Configuration

Everything is configured via environment variables. See [`.env.example`](./.env.example) for the full list.

**Performance:**
* **Response cache** — up to 256 `kubectl` results are cached and cleared on bundle switch. Bundles are immutable, so identical queries are free.
* **Batched triage** — `cluster_overview` runs 4 kubectls in parallel and returns them as one blob.
* **Soft size limit** — responses over 200 KB get a narrowing hint appended. Nothing is silently truncated.

**Bundle loading:**
* Allocate at least **4 GB RAM** to the MCP host; **8 GB** is recommended for large NKP bundles. `kube-apiserver` and `etcd` can exhaust a 2 GB host before import completes.
* The image temporarily pins troubleshoot-live **v0.2.0**. Version v0.2.1 hard-codes eight import workers and can cause swap thrashing on small hosts; neither release exposes a worker-count setting.
* A load exceeding `CLUSTER_READY_TIMEOUT_MS` is terminated and reported as failed. Clients should not retry the same bundle automatically.
* Upgrade beyond v0.2.0 when upstream exposes configurable import concurrency and skips pod log files before resource parsing. See the [upstream issue proposal](./TROUBLESHOOT_LIVE_UPSTREAM_ISSUE.md).

## Security

* **No authentication by default.** Only expose this on `localhost` or a trusted network.
* **Read-only by design.** `kubectl_run` enforces a strict allowlist. Mutating verbs (`apply`, `delete`, `exec`, etc.) are blocked.

## License

This project is licensed under the [MIT License](LICENSE).
