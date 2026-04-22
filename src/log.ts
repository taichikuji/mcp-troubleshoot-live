// MCP best practice: NEVER log to stdout. STDIO transport multiplexes
// JSON-RPC frames over stdout, so any stray stdout write corrupts the
// channel. HTTP transports tolerate stdout, but we keep one rule everywhere
// to avoid drift.
export const log = (...args: unknown[]): void => {
  console.error(...args);
};

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

// Tool-level error boundary. Any unexpected throw inside a handler becomes a
// well-formed `isError` result instead of a transport-level failure.
export async function safeRun(
  name: string,
  fn: () => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[MCP] Tool '${name}' threw:`, err);
    return {
      isError: true,
      content: [{ type: "text", text: `Internal error in ${name}: ${msg}` }],
    };
  }
}

export const textResult = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
});

export const errorResult = (text: string): ToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
});
