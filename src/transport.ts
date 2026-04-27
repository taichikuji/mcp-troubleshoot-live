import { randomUUID } from "crypto";

import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type Express, type Request, type Response } from "express";

import { requestBaseUrl, requestContext } from "./request-context.js";
import { createServer } from "./tools.js";

// One McpServer+transport per session.
const sessions = new Map<string, StreamableHTTPServerTransport>();
// Legacy SSE — kept for older client configs pointing at /sse.
const sseTransports = new Map<string, SSEServerTransport>();

async function handleStreamableHttp(req: Request, res: Response): Promise<void> {
  if (req.method === "GET") {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    if (!sid || !sessions.has(sid)) {
      res.status(400).json({ error: "Missing or invalid Mcp-Session-Id" });
      return;
    }
    await sessions.get(sid)!.handleRequest(req, res);
    return;
  }

  if (req.method === "DELETE") {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    if (sid) {
      const t = sessions.get(sid);
      if (t) { await t.close(); sessions.delete(sid); }
    }
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).set("Allow", "GET, POST, DELETE").json({ error: "Method not allowed" });
    return;
  }

  const sid = req.headers["mcp-session-id"] as string | undefined;
  if (sid && sessions.has(sid)) {
    await sessions.get(sid)!.handleRequest(req, res, req.body);
    return;
  }

    // 404 so spec-compliant clients re-initialize cleanly.
    if (sid) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  if (!isInitializeRequest(req.body)) {
    res.status(400).json({ error: "Bad Request: missing or unknown mcp-session-id" });
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id: string) => { sessions.set(id, transport); },
  });
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  await createServer().connect(transport);
  await transport.handleRequest(req, res, req.body);
}

export function mountMcpRoutes(app: Express): void {
  app.use("/mcp", express.json());

  app.all("/mcp", async (req: Request, res: Response) => {
    await requestContext.run({ baseUrl: requestBaseUrl(req) }, () => handleStreamableHttp(req, res));
  });

  app.get("/sse", async (_req: Request, res: Response) => {
    const transport = new SSEServerTransport("/messages", res);
    sseTransports.set(transport.sessionId, transport);
    res.on("close", () => sseTransports.delete(transport.sessionId));
    await createServer().connect(transport);
  });

  app.post("/messages", async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string;
    const transport = sseTransports.get(sessionId);
    if (!transport) {
      res.status(400).json({ error: `Unknown session ID: ${sessionId}` });
      return;
    }
    await requestContext.run({ baseUrl: requestBaseUrl(req) }, async () => {
      await transport.handlePostMessage(req, res);
    });
  });
}
