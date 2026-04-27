// Never use stdout — STDIO transport multiplexes JSON-RPC over it.
export const log = (...args: unknown[]): void => {
  console.error(...args);
};

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

// Converts unexpected throws into well-formed isError results.
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
