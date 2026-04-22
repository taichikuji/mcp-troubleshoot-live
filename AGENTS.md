# AGENTS.md

Notes for any AI agent working on this codebase. Written by an AI for AI; the
human-facing docs live in `README.md`. Read this file completely before making
non-trivial changes.

---

## What this project is

A Model Context Protocol server, in TypeScript, that wraps
[`troubleshoot-live`](https://github.com/mhrabovcin/troubleshoot-live). It boots
an envtest-backed Kubernetes apiserver from a support bundle and exposes a
curated set of read-only `kubectl` operations as MCP tools so an LLM can triage
the bundle conversationally.

- **Transport**: HTTP (Streamable HTTP at `POST /mcp`, legacy SSE at `GET /sse`
  + `POST /messages`). No STDIO transport today, but everything is written so
  STDIO would Just Work — see "Logging" below.
- **Runtime**: Node 22 LTS, ES modules, TypeScript strict.
- **Deployment**: Docker Compose. The MCP server itself runs as the
  unprivileged `node` user.

---

## File map and dependency direction

```
config.ts            (leaf — env vars, no side effects)
log.ts               (leaf — stderr logger, ToolResult, safeRun)
schemas.ts           (leaf except zod — shared Zod schemas)
cache.ts             → config, log
kubectl.ts           → config, cache
uploads.ts           → config, log
request-context.ts   → config            (exists ONLY to break a cycle, see below)
bundle.ts            → cache, config, log, uploads
tools.ts             → bundle, config, kubectl, log, request-context, schemas, uploads
transport.ts         → request-context, tools, mcp-sdk, express
index.ts             → bundle, config, log, transport, uploads
```

The graph is acyclic. Keep it that way. If you find yourself wanting `tools.ts`
to import from `transport.ts`, the symbol you want probably belongs in
`request-context.ts` — that file was extracted precisely because `tools.ts`
needs `uploadBaseUrl()` while `transport.ts` needs `createServer()`.

### Per-file purpose

| File | What lives here | What does NOT live here |
|---|---|---|
| `config.ts` | Every `process.env.X` read. Use the `intEnv` helper. | Anything that does I/O at import time. |
| `log.ts` | `log()` (stderr only), `ToolResult`, `safeRun`, `textResult`, `errorResult`. | Anything tool-specific. |
| `schemas.ts` | Reusable Zod schemas for K8s names, namespaces, durations, kinds. | Tool-specific schemas (those go inline in `tools.ts`). |
| `cache.ts` | The kubectl response cache. FIFO TTL, exported as three functions. | Knowledge of bundle lifecycle. |
| `kubectl.ts` | `runKubectl`, `tokenize`, `withSizeHint`, `nsArgs`, `READ_ONLY_VERBS`. | Bundle state. |
| `uploads.ts` | Upload sanitation, sweeper, `listBundleFiles`, the PUT handler. | Bundle process state. |
| `bundle.ts` | The `troubleshoot-live` child process lifecycle, mutable bundle state, `requireReady`. | HTTP, MCP, or tool registration. |
| `request-context.ts` | `AsyncLocalStorage` for per-request base URL + the `uploadBaseUrl()` resolver. | Anything else. Do not grow this file. |
| `tools.ts` | `createServer`, `INSTRUCTIONS`, `readyTool`, `registerKubectlTool`, all 16 tool registrations. | HTTP wiring. |
| `transport.ts` | Express routes for `/mcp`, `/sse`, `/messages`. Per-request `requestContext.run`. | Tool logic, kubectl, bundle state. |
| `index.ts` | App composition, startup banners, `BUNDLE_PATH` autoload, `/health`, signal handling. | Anything substantive. Should stay thin. |

---

## Hard rules — do not break these

1. **Never write to stdout.** Use `log()` from `log.ts` (which uses
   `console.error`). Do not use `console.log`, `console.warn`, `console.info`,
   or `process.stdout.write`. This is for STDIO-transport future-proofing and
   to keep MCP frame integrity inviolable. The `troubleshoot-live` child
   process output is already piped to `process.stderr` — keep it that way.

2. **Every tool handler must be wrapped.** Either `safeRun(name, fn)` or
   `readyTool(name, fn)` — never raw. Unhandled throws become transport-level
   failures the client cannot recover from.

3. **Every kubectl-backed tool must check `requireReady()` first.** The
   `readyTool` helper does this for you. Do not skip it; calling kubectl
   before the apiserver is ready returns confusing connection errors.

4. **Long-running operations must return immediately.** LLM clients
   (Cursor, Claude) have ~60s tool-call timeouts. `start_bundle` returns
   `status=loading` and the readiness watch runs in the background; the model
   polls `cluster_status`. Do not block tool handlers on multi-minute work.

5. **Cache is safe because the bundle is immutable.** A loaded
   `troubleshoot-live` envtest replay never changes. If you ever add a tool
   that *does* mutate state (don't), it must call `cacheClear()` before
   returning, and you must reconsider whether you want this server to be
   read-only at all.

6. **`kubectl_run` is read-only.** The `READ_ONLY_VERBS` set in `kubectl.ts`
   is the security boundary. Do not add `apply`, `delete`, `patch`, `edit`,
   `exec`, `cp`, `drain`, `scale`, `replace`, `create`, `label`, `annotate`,
   `taint`, `cordon`, `uncordon`, or `rollout`. If a user asks, refuse and
   explain.

7. **`tokenize()` in `kubectl.ts` is load-bearing.** It is the only thing
   protecting `kubectl_run` from a model that puts shell metacharacters into
   the `args` string. Do not replace it with `args.split(/\s+/)`. Do not
   "simplify" it. If you need to extend it (e.g. backtick handling), add a
   test before changing logic.

8. **Filenames in upload paths are restricted.** `sanitizeFilename` strips
   path components and enforces `[A-Za-z0-9._-]+\.(tar\.gz|tgz|tar)`. This is
   defense in depth on top of Express's URL normalization. Don't loosen it.

9. **Both transports stay.** `/mcp` (Streamable HTTP, current MCP standard)
   and `/sse` + `/messages` (legacy). Removing SSE breaks older client
   configs that you cannot detect in advance.

10. **Bundle state lives in `bundle.ts` and only `bundle.ts` mutates it.**
    The `let` exports (`bundleReady`, `bundleLoading`, etc.) are read-only
    on the importer side by language rule. Mutation goes through
    `markLoading` / `markReady` / `markFailed` or directly inside
    `startBundle` / `stopBundle`. Do not export setter functions for them
    just because it feels cleaner.

---

## Conventions

### Adding a new env var

1. Add to `config.ts` using `intEnv` for numeric values.
2. Document in `README.md` under **Configuration**.
3. If it changes default behavior visibly, log its effective value at
   startup in `index.ts`.

### Adding a new MCP tool

If the tool is a single `kubectl` invocation with optional namespace
filtering, use `registerKubectlTool`:

```typescript
registerKubectlTool(server, "get_configmaps", {
  description: "List configmaps, optionally filtered by namespace.",
  inputSchema: {
    namespace: namespaceSchema.optional().describe("Namespace. Omit for all namespaces."),
  },
  buildArgs: ({ namespace }) => ["get", "configmaps", ...nsArgs(namespace), "-o", "wide"],
});
```

If the tool needs custom logic (lifecycle, batching, multi-step), register
manually with `server.registerTool(...)`, wrap the handler in `readyTool`
(if it touches the cluster) or `safeRun` (if not), and return results via
`textResult(...)` or `errorResult(...)` from `log.ts`.

After adding a tool:
- Add a row to the **Tools** table in `README.md`.
- Update the tool count in the **Features** bullet.
- If the tool changes the recommended workflow, update `INSTRUCTIONS` in
  `tools.ts` — that string is what the LLM sees on `initialize`.

### Adding a new endpoint

Mount it in `index.ts` if it's a one-liner (`/health`-style). Put route
handlers in their own module if they have state or are non-trivial (see
`uploads.handleUpload`).

### Validation

Use Zod, prefer the shared schemas in `schemas.ts`. Add new shared schemas
there only if they're used by 2+ tools. Otherwise inline.

### Error handling

- Throwing from a handler is fine — `safeRun` will catch it.
- Returning `errorResult(msg)` is preferred when the failure is *expected*
  (bad input, file not found, cluster not ready). It produces a structured
  error the LLM can recover from.
- `console.error` is reserved for the fatal-path in `index.ts`. Use `log()`
  everywhere else.

---

## Performance contract

The server promises three things to the LLM (documented in `INSTRUCTIONS`):

- **Cache**: identical kubectl calls within `KUBECTL_CACHE_TTL_MS` (5 min
  default) are free. The cache is cleared on bundle switch.
- **Batching**: `cluster_overview` does 4 kubectls in parallel, returns one
  formatted blob.
- **Soft size limit**: responses over `RESPONSE_SOFT_LIMIT_BYTES` (200 KB)
  are returned in full with a "narrow your query" hint appended. Never
  silently truncate.

Do not break these without updating `INSTRUCTIONS` accordingly. The LLM
plans tool sequences based on what's promised here.

---

## Verification workflow

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
   Expect: `/health` returns JSON with `bundleReady:false`; `/mcp` returns
   server capabilities + the full instructions text.

If a containerized end-to-end test is needed, the user runs
`docker compose up --build -d` themselves — don't try to do this from the
agent shell unless the user explicitly asks.

If `npm` is not on PATH, install a portable Node into the user's home with:

```bash
mkdir -p ~/.local/node && cd ~/.local/node \
  && curl -fsSL https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-arm64.tar.xz -o node.tar.xz \
  && tar -xJf node.tar.xz --strip-components=1 && rm node.tar.xz
export PATH="$HOME/.local/node/bin:$PATH"
```

(Adjust the URL for the user's architecture; check `uname -m`.)

---

## Things that look like improvements but aren't

If you find yourself wanting to:

- **Replace `tokenize()` with `args.split(/\s+/)`** — don't. See rule 7.
- **Trim the `INSTRUCTIONS` block** — don't. The verbosity is load-bearing
  for LLM behavior.
- **Remove the legacy `/sse` transport** — don't. See rule 9.
- **Inline `requireReady` into each handler** — don't. The whole point of
  `readyTool` is one consistent "not ready" message.
- **Replace `let` exports in `bundle.ts` with a state object** — don't.
  Live bindings are the lightest-weight ESM idiom for this.
- **Add an authentication layer "for safety"** — discuss with the user
  first. The README explicitly tells operators to gate this behind
  network-level controls. Adding auth changes the deployment story.
- **Cache kubectl errors** — don't. Errors during bundle load are
  transient (proxy hiccup, still-loading state); the next call should retry.
- **Make `start_bundle` block until ready** — don't. See rule 4.
- **Add a `kubectl exec` / `kubectl logs -f` streaming tool** — don't
  without a discussion. The current model is request/response; streaming
  changes the transport contract.
- **"Refactor" `runKubectl` to use a builder pattern** — the current shape
  is intentional. The retry loop, transient-error detection, cache
  read/write, and size-hint application all need to be in one place.

---

## Things that genuinely could be improved (open invitations)

- A real test suite. There isn't one. `tokenize`, `sanitizeFilename`,
  `resolveBundlePath`, and `cache` are all easy unit-test targets and
  would catch the next person who tries to "simplify" them.
- An `tools/list` smoke test in CI that asserts all 16 tools register
  cleanly.
- Structured logs (JSON) behind an env flag, for operators who ship to
  Loki / CloudWatch / Datadog.
- A `tools/list` self-check at startup that fails the process if a tool
  registration throws — currently a broken tool only surfaces on the first
  client call.

If you're given free rein, these are the highest-leverage adds. Do *not*
add them silently in the middle of an unrelated change.

---

## When the user asks something ambiguous

- "Make it faster" → check if `KUBECTL_CACHE_TTL_MS` is doing its job;
  consider whether a new batched tool would help; do not start rewriting
  hot paths.
- "Make it simpler" → the module split has already happened. Further
  consolidation would re-create the original 1.3k-line file. Push back.
- "Add support for X" → ask whether X is read-only first. If it isn't,
  this is the wrong project.
- "Why is this so verbose?" → most verbosity in this codebase is
  intentional (instructions, error messages, defensive comments). Trim
  with a scalpel, not a chainsaw.

---

## Provenance

This file was generated by an AI agent in a refactor session that:
1. Applied MCP TypeScript best practices (stderr logging, error boundaries,
   tightened Zod schemas, `forceConsistentCasingInFileNames`).
2. Added performance optimizations (kubectl response cache, batched
   `cluster_overview` tool, soft response-size hints).
3. Split a single 1.3k-line `index.ts` into 11 focused modules.

The reasoning behind each change is in the git history and in the comments
of the modules themselves. When in doubt, read the comment that's nearest
to the line you want to change before changing it.
