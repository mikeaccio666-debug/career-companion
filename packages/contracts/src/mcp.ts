/** Local MCP adapter failures; never include provider responses or credentials. */
export const MCP_ADAPTER_ERROR_CODES = [
  'MCP_INVALID_CONFIG', 'MCP_INVALID_INPUT', 'MCP_INVALID_RESULT',
  'MCP_TOOL_NOT_ALLOWED', 'MCP_NOT_CONNECTED', 'MCP_UNAUTHORIZED',
  'MCP_UPSTREAM_FAILED', 'MCP_CANCELLED', 'MCP_TIMEOUT',
] as const;
export type McpAdapterErrorCode = typeof MCP_ADAPTER_ERROR_CODES[number];
export type McpAdapterResult<T> = {ok:true; value:T} | {ok:false; error:McpAdapterErrorCode};
