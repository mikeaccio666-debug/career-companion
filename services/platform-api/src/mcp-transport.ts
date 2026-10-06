import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport, type Tool } from '@modelcontextprotocol/client';
import { MCP_RESULT_MAX_BYTES } from '@companion/platform-contracts';
import { mcpSchemaHash, type McpCatalogConfig, type McpCatalogEntry } from './mcp-config.ts';
import type { McpDiscoveredTool, McpToolResult, McpTransport } from './mcp-transport-port.ts';
import { createMcpFetch } from './mcp-fetch.ts';
import { mcpSchemaValidator, validMcpHeaderSchema } from './mcp-schema.ts';
import { ApiError } from './errors.ts';

async function session<T>(config: McpCatalogConfig, entry: McpCatalogEntry, signal: AbortSignal | undefined,
  operation: (client: Client, options: { signal: AbortSignal; timeout: number; maxTotalTimeout: number; resetTimeoutOnProgress: boolean }) => Promise<T>): Promise<T> {
  const stop = new AbortController();
  const bounded = AbortSignal.any([stop.signal, ...(signal ? [signal] : []), AbortSignal.timeout(15_000)]);
  const client = new Client({ name: 'career-companion-mcp', version: '0.1.0' }, {
    capabilities: {}, enforceStrictCapabilities: true, inputRequired: { autoFulfill: false },
    jsonSchemaValidator: mcpSchemaValidator,
    versionNegotiation: { mode: 'auto', probe: { timeoutMs: 3000, maxRetries: 0 } },
    cachePartition: randomUUID(), defaultCacheTtlMs: 0, listMaxPages: 3,
  });
  const transport = new StreamableHTTPClientTransport(new URL(entry.url), {
    fetch: createMcpFetch(entry, config.fixtureOrigins, bounded),
    requestInit: { credentials: 'omit', redirect: 'error', cache: 'no-store' }, redirectPolicy: 'same-origin',
    ...(entry.bearerToken ? { authProvider: { token: async () => entry.bearerToken! } } : {}),
    onInsufficientScope: 'throw', reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
  });
  const close = () => { stop.abort(); void client.close().catch(() => {}); };
  bounded.addEventListener('abort', close, { once: true });
  const options = { signal: bounded, timeout: 5000, maxTotalTimeout: 15_000, resetTimeoutOnProgress: false };
  try {
    bounded.throwIfAborted(); await client.connect(transport, options);
    const result = await operation(client, options); bounded.throwIfAborted(); return result;
  } catch (error) {
    if (bounded.aborted) throw new ApiError(502, 'MCP_INTERRUPTED', 'The MCP operation was interrupted or timed out.');
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, 'MCP_CONNECTION_FAILED', 'The MCP service did not return a valid supported response. Check the reviewed connection.');
  } finally {
    // Cancellation closes legacy HTTP immediately; normal cleanup is bounded by the same guarded fetch.
    bounded.removeEventListener('abort', close);
    if (!bounded.aborted) { try { await transport.terminateSession(); } catch {} }
    stop.abort(); await client.close().catch(() => {});
  }
}
async function discovered(client: Client, options: { signal: AbortSignal; timeout: number; maxTotalTimeout: number; resetTimeoutOnProgress: boolean }): Promise<Tool[]> {
  const tools: Tool[] = []; let cursor: string | undefined;
  for (let page = 0; page < 3; page++) {
    // The typed SDK request keeps wire validation while our bounded pagination
    // avoids the convenience helper's warnings containing remote tool names.
    const result = await client.request({ method: 'tools/list', ...(cursor ? { params: { cursor } } : {}) }, options);
    tools.push(...result.tools);
    if (tools.length > 128 || Buffer.byteLength(JSON.stringify(tools)) > 256 * 1024 || new Set(tools.map(tool => tool.name)).size !== tools.length) throw new ApiError(502, 'MCP_CATALOG_TOO_LARGE', 'The MCP tool catalog exceeds the reviewed discovery limits.');
    if (!result.nextCursor) return tools.filter(tool => validMcpHeaderSchema(tool.inputSchema as Record<string, unknown>));
    cursor = result.nextCursor;
  }
  throw new ApiError(502, 'MCP_CATALOG_TOO_LARGE', 'The MCP tool catalog exceeds the reviewed discovery limits.');
}
export function createMcpTransport(config: McpCatalogConfig): McpTransport {
  return {
    discover: (entry, signal) => session(config, entry, signal, async (client, options): Promise<McpDiscoveredTool[]> => (await discovered(client, options)).map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema as Record<string, unknown>, ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema as Record<string, unknown> } : {}) }))),
    call: (entry, input, context) => session(config, entry, context.signal, async (client, options): Promise<McpToolResult> => {
      const tool = (await discovered(client, options)).find(tool => tool.name === input.name);
      if (!tool || mcpSchemaHash(tool.inputSchema as Record<string, unknown>, tool.outputSchema as Record<string, unknown> | undefined) !== input.schemaHash || !entry.tools.some(allowed => allowed.name === input.name && allowed.schemaHash === input.schemaHash)) throw new ApiError(409, 'MCP_TOOL_CHANGED', 'The reviewed MCP tool definition changed. Discover and prepare a new task.');
      options.signal.throwIfAborted(); await context.beforeCall(); options.signal.throwIfAborted();
      const result = await client.callTool({ name: input.name, arguments: input.arguments }, { ...options, toolDefinition: tool });
      if (Buffer.byteLength(JSON.stringify(result)) > MCP_RESULT_MAX_BYTES) throw new ApiError(502, 'MCP_RESULT_TOO_LARGE', 'The MCP result exceeds the saved-result limit. Review the external result before preparing another task.');
      return { content: result.content, ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}), ...(result.isError !== undefined ? { isError: result.isError } : {}) };
    }),
  };
}
