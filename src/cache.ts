import { KUBECTL_CACHE_MAX_ENTRIES } from "./config.js";

// FIFO cache keyed by argv. Cleared on bundle switch. LRU buys nothing at 256 entries.
const cache = new Map<string, string>();

const cacheKey = (args: string[]): string => args.join("\x1f");

export function cacheGet(args: string[]): string | null {
  return cache.get(cacheKey(args)) ?? null;
}

export function cacheSet(args: string[], value: string): void {
  if (KUBECTL_CACHE_MAX_ENTRIES <= 0) return;
  if (cache.size >= KUBECTL_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value; // Map iterates insertion order
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(cacheKey(args), value);
}

export function cacheClear(): void {
  cache.clear();
}
