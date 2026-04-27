import { execFile } from "child_process";
import { existsSync } from "fs";
import { promisify } from "util";

import { cacheGet, cacheSet } from "./cache.js";
import { KUBECONFIG_PATH, KUBECTL_TIMEOUT_MS, RESPONSE_SOFT_LIMIT_BYTES } from "./config.js";

const execFileAsync = promisify(execFile);

// Verbs that don't mutate cluster state. Gates kubectl_run.
export const READ_ONLY_VERBS = new Set([
  "get", "describe", "logs", "top", "explain", "api-resources", "api-versions",
  "version", "cluster-info", "config", "auth", "events", "wait",
]);

// Shell-style tokenizer (quotes + backslash, no shell invocation).
// Only thing protecting kubectl_run from shell metacharacters — don't simplify it.
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const ch of input) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (quote) throw new Error(`Unterminated ${quote} quote in arguments`);
  if (current.length) tokens.push(current);
  return tokens;
}

// The proxy briefly drops the listener during bundle import — retry on these.
function isTransientKubectlError(stderr: string): boolean {
  return (
    /connection refused/i.test(stderr) ||
    /EOF/.test(stderr) ||
    /Unable to connect to the server/i.test(stderr) ||
    /no route to host/i.test(stderr)
  );
}

// Appends a narrowing hint on large responses. Never silently truncates.
export function withSizeHint(text: string): string {
  if (text.length <= RESPONSE_SOFT_LIMIT_BYTES) return text;
  const kb = (text.length / 1024).toFixed(0);
  return (
    text +
    `\n\n[note: response is ${kb} KB. If this is too large for your context, ` +
    `narrow with -n <namespace>, --selector=, --field-selector=, or get a single resource by name.]`
  );
}

export function nsArgs(namespace: string | undefined, allNamespacesFallback = true): string[] {
  if (namespace) return ["-n", namespace];
  return allNamespacesFallback ? ["-A"] : [];
}

export async function runKubectl(args: string[]): Promise<string> {
  if (!existsSync(KUBECONFIG_PATH)) {
    return "No kubeconfig found. Start a bundle first with the start_bundle tool.";
  }
  const cached = cacheGet(args);
  if (cached !== null) return withSizeHint(cached);

  const maxAttempts = 4;
  let lastErr: { message: string; stderr?: string } = { message: "" };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { stdout, stderr } = await execFileAsync(
        "kubectl",
        [`--kubeconfig=${KUBECONFIG_PATH}`, ...args],
        { timeout: KUBECTL_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      );
      const out = (stdout || stderr).trim();
      cacheSet(args, out);
      return withSizeHint(out);
    } catch (err: unknown) {
      lastErr = err as { message: string; stderr?: string };
      const stderr = lastErr.stderr ?? "";
      if (attempt < maxAttempts && isTransientKubectlError(stderr)) {
        await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1))); // 250ms, 500ms, 1s
        continue;
      }
      break;
    }
  }
  return `Error: ${lastErr.message}\n${lastErr.stderr ?? ""}`.trim();
}
