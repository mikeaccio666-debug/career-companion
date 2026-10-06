import type { McpCatalogEntry } from './mcp-config.ts';

export interface McpDiscoveredTool {
  name: string; description?: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>;
}
export interface McpToolResult {
  content: unknown[]; structuredContent?: unknown; isError?: boolean;
}
export interface McpTransport {
  discover(entry: McpCatalogEntry, signal?: AbortSignal): Promise<McpDiscoveredTool[]>;
  /** Discovery is repeated in the same client. beforeCall durably authorizes tools/call. */
  call(entry: McpCatalogEntry, input: { name: string; arguments: Record<string, unknown>; schemaHash: string },
    context: { signal?: AbortSignal; beforeCall: () => Promise<void> }): Promise<McpToolResult>;
}
