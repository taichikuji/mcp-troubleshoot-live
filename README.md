# Support Bundle MCP

A Dockerized MCP server for investigating Kubernetes support bundles with an AI assistant.

It reads [Troubleshoot](https://troubleshoot.sh/) support-bundle files directly. It does not boot
etcd or kube-apiserver, import objects, run `kubectl`, or depend on the `troubleshoot-live` binary.

## Run

```bash
cp .env.example .env
docker compose up --build -d
```

Point an MCP client at `http://localhost:3100/mcp`. Cursor configuration:

```json
{
  "mcpServers": {
    "support-bundle": {
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

Both Streamable HTTP (`/mcp`) and legacy SSE (`/sse` + `/messages`) are supported.

## Bundles

The server accepts `.tar.gz`, `.tgz`, and `.tar` bundles in two ways:

1. Put bundles in the host `./bundles` directory mounted at `/bundles`.
2. Ask the AI to investigate a local bundle. `prepare_upload` returns a `curl` command for the
   client machine and stores the upload in temporary staging.

`start_bundle` returns immediately. Poll `cluster_status` while the first extraction and small
resource catalog are built. Reopening the last shared bundle is immediate when its path, size, and
modification time have not changed.

Cold loading still pays the unavoidable cost of decompressing a gzip archive. It does not pay for
an API server boot, CRD establishment, object import, or an in-memory cluster.

## Tools

The server exposes 10 tools:

| Tool | Purpose |
| --- | --- |
| `prepare_upload` | Build an upload command for a local bundle. |
| `list_bundles` | List bundles mounted under `/bundles`. |
| `start_bundle` | Extract and index a bundle in the background. |
| `stop_bundle` | Close the active bundle and clean uploaded data. |
| `cluster_status` | Report `idle`, `extracting`, `indexing`, `ready`, or `failed`. |
| `cluster_overview` | Return nodes, namespaces, not-ready pods, Warning events, and parse diagnostics. |
| `resource_catalog` | Discover collected kinds, API versions, and accepted aliases. |
| `resource_query` | Query and paginate resources by kind, namespace, labels, and dot-path fields. |
| `pod_logs` | Read/search current or previous logs by exact pod or pod labels across containers. |
| `bundle_files` | List, read, or literal-search bounded raw diagnostic files. |

Use `resource_catalog` before guessing version-specific CR names. `resource_query` returns compact
summaries by default and a `nextOffset` when more results exist. Set `full=true` only when the
complete collected object is needed. The reader supports JSON and YAML resources, missing-GVK
inference for standard Troubleshoot paths, configmaps/secrets, nested List resources, and both
pod-log layouts used by Troubleshoot.

Tool responses above 200 KB are rejected with a narrowing hint instead of flooding client context.

## Configuration

See [`.env.example`](./.env.example) for all values.

- `BUNDLES_DIR` — shared bundle library; default `/bundles`.
- `UPLOAD_DIR` — temporary upload staging; default `/tmp/troubleshoot-mcp-uploads`.
- `BUNDLE_CACHE_DIR` — active extraction/cache; default `/tmp/troubleshoot-mcp-cache`.
- `MAX_UPLOAD_BYTES` — compressed upload limit; default 5 GB.
- `MAX_EXTRACTED_BYTES` — expanded archive limit; default 20 GB.
- `MAX_ARCHIVE_FILES` — archive entry limit; default 500,000.
- `UPLOAD_TTL_MS` — idle upload lifetime; default 6 hours.
- `PUBLIC_URL` — optional upload URL override.

## Security

- No authentication is enabled. Expose the service only on localhost or a trusted network.
- Archive names, paths, entry types, expanded bytes, and entry counts are validated before use.
- Extraction runs as the unprivileged `node` user.
- All inspection tools are read-only; there is no cluster or mutating Kubernetes API.

## License

MIT
