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

With 8 focused tools, you can triage conversationally — even when the bundle only lives on your local machine.

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

1. **Upload directly** (default) — tell the AI: *"investigate `~/Downloads/bundle.tar.gz`"*. It uses `prepare_upload` to push the file over.
2. **Shared folder** — if your MCP host and machine share a filesystem (Docker bind-mount, UTM share, etc.), drop the bundle in `/bundles`. The AI finds it with `list_bundles`.

## What can I ask?

* *"Give me a 1-paragraph summary of the cluster's overall health: node conditions, namespaces with not-ready pods, and recent Warning events."*
* *"List all pods in CrashLoopBackOff across all namespaces. For the worst offender, pull the logs and tell me what's failing."*
* *"Find any PVC stuck in Pending and explain why it hasn't bound."*

## What tools does it have?

It comes packed with 8 focused tools to help you out!

| Tool | Purpose |
| --- | --- |
| `prepare_upload` | Uploads a local bundle to the server. |
| `list_bundles` | Lists bundles already in `/bundles`. |
| `start_bundle` | Loads a bundle into the live cluster. |
| `stop_bundle` | Unloads the current bundle and cleans up. |
| `cluster_status` | Reports if the cluster is `idle`, `loading`, `ready`, or `failed`. |
| `cluster_overview` | **Batched triage tool!** Gets nodes, namespaces, not-ready pods, and warnings in one go. |
| `kubectl_run` | Read-only kubectl for all queries — supports `grep` filter param. |
| `help` | Print the recommended investigation workflow and usage notes. |

## Configuration

Everything is configured via environment variables. See [`.env.example`](./.env.example) for the full list.

**Performance:**
* **Response cache** — `kubectl` results are cached for 5 minutes (`KUBECTL_CACHE_TTL_MS`). Bundles are immutable, so identical queries are free.
* **Batched triage** — `cluster_overview` runs 4 kubectls in parallel and returns them as one blob.
* **Soft size limit** — responses over 200 KB get a narrowing hint appended. Nothing is silently truncated.

## Security

* **No authentication by default.** Only expose this on `localhost` or a trusted network.
* **Read-only by design.** `kubectl_run` enforces a strict allowlist. Mutating verbs (`apply`, `delete`, `exec`, etc.) are blocked.

## License

This project is licensed under the [MIT License](LICENSE).
