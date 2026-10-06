import { MCP_RESULT_MAX_BYTES, type Approval, type Job, type McpConnection, type McpPrepareInput, type McpResult, type McpResultInput, type McpTool } from '@companion/platform-contracts';
import { mcpApprovalPlan, mcpArgumentsFingerprint, parseMcpSummary } from './mcp-editor.ts';

export type McpTransport = <T>(path: string, init?: RequestInit) => Promise<T>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function idPath(id: string) { if (!uuid.test(id)) throw new Error('外部连接 ID 无效。'); return `/mcp/connections/${encodeURIComponent(id)}`; }
function connection(value: McpConnection): McpConnection {
  if (!value || typeof value.catalogId !== 'string' || !value.catalogId || typeof value.name !== 'string' || typeof value.connectable !== 'boolean' || !['available', 'connected', 'revoked', 'unavailable'].includes(value.status) || !Number.isSafeInteger(value.toolCount) || value.toolCount < 0 || value.status === 'connected' && (!value.connectionId || !uuid.test(value.connectionId) || !Number.isSafeInteger(value.grantVersion) || value.grantVersion! < 1)) throw new Error('服务没有返回完整的外部连接状态。');
  return value;
}
/** A fixed account transport is required. This client never contacts an external MCP URL itself. */
export function createMcpClient(transport: McpTransport) {
  async function call<T>(path: string, init: RequestInit = {}): Promise<T> { init.signal?.throwIfAborted(); const result = await transport<T>(path, init); init.signal?.throwIfAborted(); return result; }
  return {
    async list(signal?: AbortSignal): Promise<McpConnection[]> { const data = await call<{ connections: McpConnection[] }>('/mcp/connections', { signal }); if (!Array.isArray(data?.connections)) throw new Error('服务没有返回外部连接目录。'); return data.connections.map(connection); },
    async connect(catalogId: string, signal?: AbortSignal): Promise<McpConnection> {
      if (!catalogId || catalogId.length > 200 || /[\u0000-\u001f\u007f]/.test(catalogId)) throw new Error('请选择服务器目录中的连接。');
      const data = await call<{ connection: McpConnection }>('/mcp/connections', { method: 'POST', body: JSON.stringify({ catalogId }), signal }); const result = connection(data?.connection); if (result.catalogId !== catalogId) throw new Error('服务返回了不同的连接，请刷新目录确认。'); return result;
    },
    async revoke(id: string, expectedGrantVersion: number, signal?: AbortSignal): Promise<McpConnection> {
      const path = idPath(id); if (!Number.isSafeInteger(expectedGrantVersion) || expectedGrantVersion < 1) throw new Error('授权版本无效，请刷新连接状态。');
      const data = await call<{ connection: McpConnection }>(path, { method: 'DELETE', body: JSON.stringify({ expectedGrantVersion }), signal }); const result = connection(data?.connection); if (result.connectionId !== id || result.status !== 'revoked') throw new Error('撤销结果未确认，请刷新连接状态。'); return result;
    },
    async tools(id: string, signal?: AbortSignal): Promise<{ connection: McpConnection; tools: McpTool[] }> {
      const data = await call<{ connection: McpConnection; tools: McpTool[] }>(`${idPath(id)}/tools`, { signal }); connection(data?.connection); if (data.connection.connectionId !== id) throw new Error('工具目录不属于当前选择的连接。');
      if (!Array.isArray(data.tools) || data.tools.some((tool) => !tool || typeof tool.name !== 'string' || !tool.name || typeof tool.schemaHash !== 'string' || !tool.schemaHash || tool.authorization !== 'reviewed_read_only' || !tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema))) throw new Error('服务没有返回服务器已审阅的工具列表。');
      return data;
    },
    async prepare(input: McpPrepareInput, signal?: AbortSignal): Promise<{ job: Job; approval: Approval }> {
      const data = await call<{ job: Job; approval: Approval }>('/mcp/tasks', { method: 'POST', body: JSON.stringify(input), signal });
      if (!data?.job || !uuid.test(data.job.id) || data.job.kind !== 'mcp' || data.job.status !== 'needs_approval' || !parseMcpSummary(data.job.mcp) || !data.approval || !uuid.test(data.approval.id) || data.approval.jobId !== data.job.id || data.approval.status !== 'pending') throw new Error('准备结果未能确认，请先查看任务记录，避免重复准备。');
      const summary = data.job.mcp!, plan = mcpApprovalPlan(data.approval);
      if (!plan || summary.connectionId !== input.connectionId || summary.grantVersion !== input.grantVersion || summary.toolName !== input.toolName || summary.schemaHash !== input.schemaHash || data.job.prompt !== input.goal || plan.goal !== input.goal || mcpArgumentsFingerprint(plan.arguments) !== mcpArgumentsFingerprint(input.arguments) || Object.entries(summary).some(([key, value]) => plan.summary[key as keyof typeof summary] !== value)) throw new Error('准备返回的审批与目标或参数不一致，请先检查任务记录，避免重复准备。');
      return data;
    },
    async result(input: McpResultInput, signal?: AbortSignal): Promise<McpResult> {
      if (!uuid.test(input.jobId)) throw new Error('外部工具任务 ID 无效。');
      const params = new URLSearchParams();
      if (input.offset !== undefined) { if (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > MCP_RESULT_MAX_BYTES || !input.version) throw new Error('结果页码需要精确版本。'); params.set('offset', String(input.offset)); }
      if (input.version !== undefined) { if (!input.version || input.version.length > 202) throw new Error('结果版本无效。'); params.set('version', input.version); }
      if (input.maxBytes !== undefined) { if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 4 || input.maxBytes > 16384) throw new Error('结果分页大小无效。'); params.set('maxBytes', String(input.maxBytes)); }
      const query = params.toString(), data = await call<{ result: McpResult }>(`/mcp/tasks/${encodeURIComponent(input.jobId)}/result${query ? `?${query}` : ''}`, { signal }), value = data?.result;
      if (!value || value.provenance !== 'untrusted_mcp' || value.encoding !== 'utf-8' || value.source?.jobId !== input.jobId || !uuid.test(value.source.artifactId) || !parseMcpSummary(value.source) || !Number.isSafeInteger(value.source.generation) || value.source.generation < 1 || typeof value.text !== 'string' || new TextEncoder().encode(value.text).byteLength > 16384 || typeof value.version !== 'string' || !value.version || value.version.length > 202 || value.offset !== (input.offset ?? 0) || input.version !== undefined && value.version !== input.version || !Number.isSafeInteger(value.source.size) || value.source.size < 0 || value.source.size > MCP_RESULT_MAX_BYTES || value.truncated !== (value.nextOffset !== null) || value.nextOffset !== null && (!Number.isSafeInteger(value.nextOffset) || value.nextOffset <= value.offset || value.nextOffset > value.source.size)) throw new Error('服务返回的结果来源或版本不完整，请重新读取。');
      return value;
    },
  };
}
