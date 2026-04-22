# troubleshoot-live MCP: Talk to your Kubernetes support bundles!

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.8-blue?logo=typescript" />
  <img src="https://img.shields.io/github/license/taichikuji/mcp-troubleshoot-live?color=FF3351&logo=github" />
  <img src="https://img.shields.io/github/commit-activity/w/taichikuji/mcp-troubleshoot-live?label=commits&logo=github" />
</p>

## What is this project exactly?

This project is a Dockerized [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that wraps [`troubleshoot-live`](https://github.com/mhrabovcin/troubleshoot-live). 

It boots an envtest-backed Kubernetes apiserver straight from a support bundle and gives your favorite AI assistant (like Cursor or Claude Desktop) a set of read-only `kubectl` tools to investigate it!

## Why make this?

Digging through Kubernetes support bundles manually can be tedious. I wanted to make a tool that lets you just *talk* to your bundle! 

By giving an LLM access to 16 curated `kubectl` tools, you can triage a bundle conversationally—even if the bundle only lives on your local machine! After putting this together, I'm really glad with how much faster debugging has become.

## How do I make it work?

It's super simple to get started! Just use Docker Compose:

```bash
cp .env.example .env
docker compose up --build -d
docker compose logs -f
```

Then, point your MCP client (like Cursor) at the server. For Cursor, add this to your `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "troubleshoot-live": {
      "url": "http://localhost:3100/mcp"
    }
  }
}
```
*(Note: If you're running this on a different host, change `localhost` to your host's IP!)*

## How do bundles get to the server?

The MCP server needs the bundle on its own filesystem to read it. There are two neat ways to do this:

1. **Upload it directly!** (Default) If the bundle is on your machine, just tell the AI: *"Use the troubleshoot-live MCP to investigate `~/Downloads/bundle.tar.gz`"*. The AI will use the `prepare_upload` tool to grab it for you!
2. **Share a local folder!** If your MCP host and your machine share a filesystem (like a Docker bind-mount or UTM share), just drop the bundle in the `/bundles` folder. The AI can find it using `list_bundles`!

## What can I ask it?

Once connected, just talk to it in plain English! Here are some cool things you can ask:

* *"Give me a 1-paragraph summary of the cluster's overall health: node conditions, namespaces with not-ready pods, and recent Warning events."*
* *"List all pods across all namespaces in CrashLoopBackOff. For the worst offender, pull the logs and tell me what's failing!"*
* *"Find any PVC stuck in Pending and explain why it hasn't bound."*

## What tools does it have?

It comes packed with 16 typed MCP tools to help you out!

| Tool | Purpose |
| --- | --- |
| `prepare_upload` | Uploads a local bundle to the server. |
| `list_bundles` | Lists bundles already in `/bundles`. |
| `start_bundle` | Loads a bundle into the live cluster. |
| `stop_bundle` | Unloads the current bundle and cleans up. |
| `cluster_status` | Reports if the cluster is `idle`, `loading`, `ready`, or `failed`. |
| `cluster_overview` | **Batched triage tool!** Gets nodes, namespaces, not-ready pods, and warnings in one go. |
| `list_namespaces` | `kubectl get namespaces -o wide` |
| `get_nodes` | `kubectl get nodes -o wide` |
| `get_pods` | List pods (optionally by namespace). |
| `get_deployments` | List deployments. |
| `get_services` | List services. |
| `get_pod_logs` | Grab pod logs (supports `tail`, `previous`, `since`). |
| `get_events` | Get events sorted by time. |
| `describe_resource` | `kubectl describe <kind> <name>` |
| `get_resource` | Generic `kubectl get` with custom output formats. |
| `kubectl_run` | Read-only escape hatch for custom queries! |

## Configuration & Performance

Everything is configured via environment variables. Check out [`.env.example`](./.env.example) for the full list!

**Performance is a priority:**
* **Response cache**: `kubectl` results are cached for 5 minutes (`KUBECTL_CACHE_TTL_MS`). Since bundles are immutable, identical queries are served instantly from memory!
* **Batched triage**: The `cluster_overview` tool collapses 4 calls into one, running them in parallel.
* **Soft limits**: Huge responses (over 200 KB) get a helpful hint appended, telling the AI how to narrow its search without silently truncating data.

## Security

* **No authentication by default!** Only expose this on `localhost` or a trusted network.
* **Read-only by design!** The `kubectl_run` tool enforces a strict read-only allowlist. Mutating verbs (`apply`, `delete`, `exec`, etc.) are blocked.

## License

This project is licensed under the [MIT License](LICENSE).
