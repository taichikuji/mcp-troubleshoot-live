import { AsyncLocalStorage } from "async_hooks";
import type { Request } from "express";

import { PORT, PUBLIC_URL_OVERRIDE } from "./config.js";

// Per-request base URL so prepare_upload uses the host the client actually
// reached us on. Lives in its own module so both transport.ts (writer) and
// tools.ts (reader) can depend on it without forming a cycle.
export const requestContext = new AsyncLocalStorage<{ baseUrl: string }>();

export function requestBaseUrl(req: Request): string {
  // trust-proxy gets req.protocol from X-Forwarded-Proto, but req.get('host')
  // ignores X-Forwarded-Host — check it explicitly.
  const proto = req.protocol || "http";
  const fwdHost = (req.get("x-forwarded-host") ?? "").split(",")[0]?.trim();
  const host = fwdHost || req.get("host");
  return host ? `${proto}://${host}` : `http://localhost:${PORT}`;
}

export function uploadBaseUrl(): string {
  return PUBLIC_URL_OVERRIDE ?? requestContext.getStore()?.baseUrl ?? `http://localhost:${PORT}`;
}
