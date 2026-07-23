# AGENTS.md

Notes for any AI agent working on this codebase.

---

## What this project is

An MCP server (TypeScript) that reads Troubleshoot Kubernetes support bundles directly. It extracts and catalogs immutable bundle files, then exposes structured resource and pod-log tools for LLM triage. There is no Kubernetes API server, `kubectl`, or `troubleshoot-live` runtime.

- **Transport**: HTTP — Streamable HTTP at `POST /mcp`, legacy SSE at `GET /sse` + `POST /messages`.
- **Runtime**: Node 22, ES modules, TypeScript strict.
- **Deployment**: Docker Compose.

---

## Module layout

```
config.ts        env vars, no side effects
log.ts           log() (stderr), ToolResult, safeRun, textResult, errorResult
bundle-reader.ts secure extraction, resource catalog/query, logs
uploads.ts       upload sanitization, sweeper, listBundleFiles, PUT handler
request-context.ts  AsyncLocalStorage for per-request base URL
bundle.ts        active reader lifecycle and bundle state
tools.ts         createServer, all 10 tool registrations
transport.ts     Express routes
index.ts         startup, /health, signal handling
```

The dependency graph is acyclic. Keep it that way.

---

## Rules

1. **Never write to stdout.** Use `log()` from `log.ts` (`console.error` internally). No `console.log`, `console.warn`, `console.info`, `process.stdout.write`. STDIO transport future-proofing.

2. **Every tool handler must be wrapped** in `safeRun` or `readyTool`. Never raw.

3. **Every bundle-backed tool must check `requireReady()` first.** `readyTool` does this.

4. **Long-running operations must return immediately.** `start_bundle` returns `status=loading`; the model polls `cluster_status`. Don't block handlers on multi-minute work.

5. **Cache is safe because bundles are immutable.** Shared-bundle reuse is keyed by path, size, and mtime.

6. **Archive extraction is a trust boundary.** Reject traversal, links, unsupported entry types, excessive expanded bytes, and excessive file counts.

7. **Keep queries structured.** Do not add shell commands or emulate free-form kubectl syntax.

8. **Upload filenames are restricted.** `sanitizeFilename` enforces `[A-Za-z0-9._-]+\.(tar\.gz|tgz|tar)`. Don't loosen it.

9. **Both transports stay.** `/mcp` and `/sse` + `/messages`. Removing SSE breaks older client configs.

10. **Bundle state lives in `bundle.ts` only.** The `let` exports are read-only on the importer side.

---

## Adding a tool

Use `server.registerTool(...)`, wrap the handler in `readyTool` or `safeRun`, and return
`textResult`/`errorResult`.

After adding a tool: update the **Tools** table in `README.md`, update the tool count, and update `INSTRUCTIONS` in `tools.ts` if it changes the recommended workflow.

---

## Adding an env var

1. Add to `config.ts` using `intEnv` for numbers.
2. Document in `README.md` under **Configuration**.
3. Log the effective value at startup in `index.ts` if it changes visible behavior.

---

## Verification

After any change:

1. `npm run build` — must pass with zero output.
2. Read lints on changed files — must be zero.
3. Boot smoke test:
   ```bash
   PORT=13099 node dist/index.js &
   sleep 1
   curl -fsS http://localhost:13099/health
   curl -fsS -X POST http://localhost:13099/mcp \
     -H 'Content-Type: application/json' \
     -H 'Accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
   kill %1
   ```
   `/health` returns JSON with `bundleReady:false`; `/mcp` returns server capabilities.

If `npm` is not on PATH:

```bash
mkdir -p ~/.local/node && cd ~/.local/node \
  && curl -fsSL https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-arm64.tar.xz -o node.tar.xz \
  && tar -xJf node.tar.xz --strip-components=1 && rm node.tar.xz
export PATH="$HOME/.local/node/bin:$PATH"
```

---

# Context Glossary

## ClientMachine
The machine where the operator and AI client run, and where a local support bundle may originate before transfer.

## McpHost
The machine running this MCP server process and exposing its HTTP endpoints.

## BundleLibrary
A durable bundle catalog on the `McpHost`, mapped to `/bundles`, containing support bundles available for direct loading.

## UploadStaging
A temporary staging area on the `McpHost`, mapped to `UPLOAD_DIR`, where uploaded bundles are stored before load and cleanup.
