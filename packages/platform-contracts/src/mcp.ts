import type { ArtifactTextResult } from './index.ts';

export const MCP_ARGUMENT_MAX_BYTES = 16 * 1024;
export const MCP_RESULT_MAX_BYTES = 64 * 1024;

/** A platform grant for a server-reviewed connection, not third-party OAuth. */
export interface McpConnection {
  catalogId: string; name: string; description?: string;
  status: 'available' | 'connected' | 'revoked' | 'unavailable';
  /** True only while this service remains in the current reviewed server catalog. */
  connectable: boolean;
  connectionId?: string; grantVersion?: number;
  toolCount: number; discoveredAt?: string; reason?: string;
}
/** Tool descriptions and schemas are remote data, never permission. */
export interface McpTool {
  name: string; description?: string;
  schemaHash: string; inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  authorization: 'reviewed_read_only';
}
export interface McpPrepareInput {
  connectionId: string; grantVersion: number; toolName: string;
  schemaHash: string; arguments: Record<string, unknown>; goal: string;
}
export interface McpTaskSummary {
  connectionId: string; connectionName: string; catalogId: string;
  grantVersion: number; toolName: string; schemaHash: string;
}
export interface McpResultInput {
  jobId: string; offset?: number; version?: string; maxBytes?: number;
}
export interface McpResult extends Omit<ArtifactTextResult, 'provenance' | 'source'> {
  provenance: 'untrusted_mcp';
  source: ArtifactTextResult['source'] & McpTaskSummary & { generation: number };
}
