import { KUBECTL_CACHE_MAX_ENTRIES, KUBECTL_CACHE_TTL_MS } from "./config.js";

// FIFO TTL cache keyed by argv. Cleared on bundle switch. LRU buys nothing at 256 entries.
type CacheEntry = { value: string; expiresAt: number };

const cache = new Map<string, CacheEntry>();

const cacheKey = (args: string[]): string => args.join("\x1f");

export function cacheGet(args: string[]): string | null {
  if (KUBECTL_CACHE_TTL_MS <= 0) return null;
  const key = cacheKey(args);
  const e = cache.get(key);
  if (!e) return null;
  if (e.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return e.value;
}

export function cacheSet(args: string[], value: string): void {
  if (KUBECTL_CACHE_TTL_MS <= 0) return;
  if (cache.size >= KUBECTL_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value; // Map iterates insertion order
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(cacheKey(args), {
    value,
    expiresAt: Date.now() + KUBECTL_CACHE_TTL_MS,
  });
}

export function cacheClear(): void {
  cache.clear();
}
