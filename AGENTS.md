# AGENTS.md

Notes for any AI agent working on this codebase.

---

## What this project is

An MCP server (TypeScript) wrapping [`troubleshoot-live`](https://github.com/mhrabovcin/troubleshoot-live). It boots an envtest Kubernetes apiserver from a support bundle and exposes read-only `kubectl` tools over HTTP so an LLM can triage the bundle conversationally.

- **Transport**: HTTP — Streamable HTTP at `POST /mcp`, legacy SSE at `GET /sse` + `POST /messages`.
- **Runtime**: Node 22, ES modules, TypeScript strict.
- **Deployment**: Docker Compose.

---

## Module layout

```
config.ts        env vars, no side effects
log.ts           log() (stderr), ToolResult, safeRun, textResult, errorResult
schemas.ts       shared Zod schemas
cache.ts         kubectl response cache
kubectl.ts       runKubectl, tokenize, withSizeHint, nsArgs, READ_ONLY_VERBS
uploads.ts       upload sanitization, sweeper, listBundleFiles, PUT handler
request-context.ts  AsyncLocalStorage for per-request base URL
bundle.ts        troubleshoot-live child process lifecycle
tools.ts         createServer, all 16 tool registrations
transport.ts     Express routes
index.ts         startup, /health, signal handling
```

The dependency graph is acyclic. Keep it that way.

---

## Rules

1. **Never write to stdout.** Use `log()` from `log.ts` (`console.error` internally). No `console.log`, `console.warn`, `console.info`, `process.stdout.write`. STDIO transport future-proofing.

2. **Every tool handler must be wrapped** in `safeRun` or `readyTool`. Never raw.

3. **Every kubectl-backed tool must check `requireReady()` first.** `readyTool` does this.

4. **Long-running operations must return immediately.** `start_bundle` returns `status=loading`; the model polls `cluster_status`. Don't block handlers on multi-minute work.

5. **Cache is safe because bundles are immutable.** Never cache kubectl errors.

6. **`kubectl_run` is read-only.** `READ_ONLY_VERBS` in `kubectl.ts` is the security boundary. Don't add mutating verbs.

7. **`tokenize()` is load-bearing.** It's the only thing protecting `kubectl_run` from shell metacharacters. Don't replace it with `args.split(/\s+/)`.

8. **Upload filenames are restricted.** `sanitizeFilename` enforces `[A-Za-z0-9._-]+\.(tar\.gz|tgz|tar)`. Don't loosen it.

9. **Both transports stay.** `/mcp` and `/sse` + `/messages`. Removing SSE breaks older client configs.

10. **Bundle state lives in `bundle.ts` only.** The `let` exports are read-only on the importer side. Mutation goes through `markLoading` / `markReady` / `markFailed`.

---

## Adding a tool

Single kubectl call? Use `registerKubectlTool`:

```typescript
registerKubectlTool(server, "get_configmaps", {
  description: "List configmaps, optionally filtered by namespace.",
  inputSchema: {
    namespace: namespaceSchema.optional().describe("Namespace. Omit for all namespaces."),
  },
  buildArgs: ({ namespace }) => ["get", "configmaps", ...nsArgs(namespace), "-o", "wide"],
});
```

Custom logic? Use `server.registerTool(...)`, wrap in `readyTool` or `safeRun`, return `textResult`/`errorResult`.

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
