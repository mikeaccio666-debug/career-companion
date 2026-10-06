import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  MCP_ARGUMENT_MAX_BYTES, MCP_RESULT_MAX_BYTES,
  type CreateJobInput, type JobExecutionResult, type McpConnection, type McpPrepareInput,
  type McpResult, type McpTaskSummary, type McpTool, type ProviderStatus,
} from '@companion/platform-contracts';
import { workflowHash } from '@companion/ai-core';
import type { Database } from './database.ts';
import type { BlobStorage } from './storage.ts';
import { ApiError, identifier, invalid, notFound, object, string } from './errors.ts';
import { readMcpArtifactTextPage, parseArtifactTextInput } from './artifact-text.ts';
import { mcpCatalogHash, mcpSchemaHash, type McpCatalogConfig, type McpCatalogEntry } from './mcp-config.ts';
import { createMcpTransport } from './mcp-transport.ts';
import type { McpDiscoveredTool, McpTransport } from './mcp-transport-port.ts';
import { compileMcpSchema } from './mcp-schema.ts';

export interface McpTaskBinding extends McpTaskSummary {
  version: 1; policyHash: string; argumentsHash: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>;
}
export interface McpExecutionBinding {
  jobId: string; userId: string; generation: number; leaseToken: string;
  input: CreateJobInput; policy: McpTaskBinding; signal: AbortSignal;
}
export interface McpExecutionResult extends JobExecutionResult { mcpToolError: boolean; }
const hash = /^[a-f0-9]{64}$/;
const toolName = /^[A-Za-z0-9_.-]{1,128}$/;
const grant = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
const changed = () => new ApiError(409, 'MCP_GRANT_CHANGED', 'This MCP connection changed or was revoked. Review a current connection before preparing another task.');
const review = () => new ApiError(409, 'MCP_REVIEW_REQUIRED', 'This MCP call already started. Review its saved result; it cannot be replayed by retry.');

function jsonValue(value: unknown, depth = 0): void {
  if (depth > 24) throw invalid('MCP JSON nesting exceeds the supported limit.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const item of value) jsonValue(item, depth + 1); return; }
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid('MCP values must be plain JSON data.');
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw invalid('Unsupported MCP JSON property.');
    jsonValue(item, depth + 1);
  }
}
function boundedJson(value: unknown, limit: number): string {
  jsonValue(value);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, 'utf8') > limit) throw new ApiError(413, 'MCP_DATA_TOO_LARGE', 'The MCP data exceeds its supported size.');
  return encoded;
}
function checkedSchema(schema: unknown): Record<string, unknown> {
  const value = object(schema);
  boundedJson(value, 16 * 1024);
  function refs(item: unknown): void {
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (['$ref', '$dynamicRef', '$recursiveRef'].includes(key) && (typeof child !== 'string' || !child.startsWith('#'))) throw invalid('MCP schemas cannot load external references.');
      refs(child);
    }
  }
  refs(value);
  try { compileMcpSchema(value); } catch { throw invalid('The reviewed MCP schema is unsupported.'); }
  return value;
}
function validateArguments(schema: Record<string, unknown>, args: Record<string, unknown>): void {
  boundedJson(args, MCP_ARGUMENT_MAX_BYTES);
  let validate;
  try { validate = compileMcpSchema(checkedSchema(schema)); } catch { throw invalid('The reviewed MCP schema is unsupported.'); }
  if (!validate(args)) throw invalid('MCP arguments do not match the reviewed tool schema.');
}
export function parseMcpPrepare(value: unknown): McpPrepareInput {
  const data = object(value);
  if (Object.keys(data).some(key => !['connectionId', 'grantVersion', 'toolName', 'schemaHash', 'arguments', 'goal'].includes(key))) throw invalid('Unsupported MCP preparation field.');
  if (!grant(data.grantVersion) || typeof data.toolName !== 'string' || !toolName.test(data.toolName) || typeof data.schemaHash !== 'string' || !hash.test(data.schemaHash)) throw invalid('Choose an exact MCP grant, tool and schema version.');
  const args = object(data.arguments); boundedJson(args, MCP_ARGUMENT_MAX_BYTES);
  return { connectionId: identifier(data.connectionId).toLowerCase(), grantVersion: data.grantVersion, toolName: data.toolName, schemaHash: data.schemaHash, arguments: args, goal: string(data.goal, 'goal', 20_000) };
}
export function mcpJobInput(value: unknown): CreateJobInput {
  const data = parseMcpPrepare(value);
  const { goal, ...options } = data;
  return { kind: 'mcp', provider: 'mcp', prompt: goal, options };
}
export function parseMcpJob(input: CreateJobInput): McpPrepareInput {
  if (input.kind !== 'mcp' || input.provider !== 'mcp' || input.model !== undefined || input.executionTemplate !== undefined || input.attachmentIds?.length) throw invalid('MCP tasks accept only a reviewed connection, tool and JSON arguments.');
  const options = object(input.options);
  if (Object.keys(options).some(key => !['connectionId', 'grantVersion', 'toolName', 'schemaHash', 'arguments'].includes(key))) throw invalid('Unsupported MCP task option.');
  return parseMcpPrepare({ ...options, goal: input.prompt });
}
export function mcpSummary(policy: McpTaskBinding): McpTaskSummary {
  return { connectionId: policy.connectionId, connectionName: policy.connectionName, catalogId: policy.catalogId,
    grantVersion: policy.grantVersion, toolName: policy.toolName, schemaHash: policy.schemaHash };
}
export function mcpDefinitionHash(input: CreateJobInput, policy: McpTaskBinding): string {
  return workflowHash({ version: 1, kind: 'mcp', provider: 'mcp', prompt: input.prompt, options: input.options, policy });
}
export function mcpApprovalMatches(row: any, args: any): boolean {
  try {
    const policy: McpTaskBinding = row.execution_policy?.mcp;
    if (!policy || policy.version !== 1 || !args?.mcp) return false;
    const input: CreateJobInput = { kind: 'mcp', provider: row.provider, prompt: row.prompt, options: row.options };
    const approved: CreateJobInput = { kind: args.kind, provider: args.provider, prompt: args.prompt, options: args.options,
      ...(args.model !== undefined ? { model: args.model } : {}), ...(args.attachmentIds !== undefined ? { attachmentIds: args.attachmentIds } : {}),
      ...(args.executionTemplate !== undefined ? { executionTemplate: args.executionTemplate } : {}) };
    parseMcpJob(approved);
    return mcpDefinitionHash(approved, policy) === mcpDefinitionHash(input, policy) && args.mcpDefinitionHash === mcpDefinitionHash(input, policy) && workflowHash(args.mcp) === workflowHash(mcpSummary(policy));
  } catch { return false; }
}

export class McpConnections {
  readonly transport: McpTransport;
  constructor(readonly db: Database, readonly config: McpCatalogConfig = { entries: [], fixtureOrigins: [] }, transport?: McpTransport, private readonly storage?: BlobStorage) {
    this.transport = transport ?? createMcpTransport(config);
  }
  capability(): ProviderStatus {
    const enabled = this.config.entries.length > 0;
    return { id: 'mcp', name: 'Reviewed MCP tools', enabled, keyConfigured: enabled, capabilities: ['mcp'], models: [], envVariables: [],
      reason: enabled ? 'Server-reviewed read-only tools require a personal platform connection and per-task approval. This is not third-party OAuth.' : 'No reviewed MCP catalog is configured.' };
  }
  private entry(id: string): McpCatalogEntry | undefined { return this.config.entries.find(entry => entry.id === id); }
  private connection(row: any, entry?: McpCatalogEntry): McpConnection {
    const connected = row?.status === 'connected' && !!entry && row.policy_hash === mcpCatalogHash(entry);
    return { catalogId: entry?.id ?? row.catalog_id, name: entry?.name ?? row.name, connectable: Boolean(entry),
      ...(entry?.description ? { description: entry.description } : {}),
      status: row?.status === 'revoked' ? 'revoked' : row ? connected ? 'connected' : 'unavailable' : 'available',
      ...(row ? { connectionId: row.id, grantVersion: row.grant_version, discoveredAt: new Date(row.discovered_at).toISOString() } : {}),
      toolCount: connected ? row.tools.length : 0,
      ...(row && !connected && row.status !== 'revoked' ? { reason: 'The reviewed server configuration changed. Connect again to review its current tools.' } : {}) };
  }
  async list(userId: string): Promise<McpConnection[]> {
    const saved = await this.db.query('SELECT * FROM platform_mcp_connections WHERE user_id=$1 ORDER BY catalog_id', [userId]);
    const rows = new Map(saved.rows.map(row => [row.catalog_id, row]));
    const result = this.config.entries.map(entry => { const row = rows.get(entry.id); rows.delete(entry.id); return this.connection(row, entry); });
    return [...result, ...[...rows.values()].map(row => this.connection(row))];
  }
  private discovered(entry: McpCatalogEntry, found: McpDiscoveredTool[]): McpTool[] {
    if (!Array.isArray(found) || found.length > 100 || new Set(found.map(tool => tool.name)).size !== found.length) throw new ApiError(502, 'MCP_DISCOVERY_INVALID', 'The MCP tool discovery was invalid.');
    return entry.tools.map(approved => {
      const tool = found.find(item => item.name === approved.name);
      if (!tool || typeof tool.name !== 'string' || !toolName.test(tool.name)) throw new ApiError(409, 'MCP_SCHEMA_CHANGED', 'A reviewed MCP tool is missing or changed.');
      const inputSchema = checkedSchema(tool.inputSchema);
      const outputSchema = tool.outputSchema === undefined ? undefined : checkedSchema(tool.outputSchema);
      if (mcpSchemaHash(inputSchema, outputSchema) !== approved.schemaHash) throw new ApiError(409, 'MCP_SCHEMA_CHANGED', 'A reviewed MCP tool schema changed.');
      if (tool.description !== undefined && (typeof tool.description !== 'string' || tool.description.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(tool.description))) throw new ApiError(502, 'MCP_DISCOVERY_INVALID', 'The MCP tool description was invalid.');
      return { name: tool.name, ...(tool.description ? { description: tool.description } : {}), inputSchema, ...(outputSchema === undefined ? {} : { outputSchema }), schemaHash: approved.schemaHash, authorization: 'reviewed_read_only' as const };
    });
  }
  async connect(userId: string, value: unknown, signal?: AbortSignal): Promise<McpConnection> {
    const data = object(value);
    if (Object.keys(data).some(key => key !== 'catalogId') || typeof data.catalogId !== 'string') throw invalid('Choose one server-reviewed MCP catalog.');
    const configured = this.entry(data.catalogId); if (!configured) throw notFound();
    const entry = structuredClone(configured), policyHash = mcpCatalogHash(entry);
    // Capture this inbound intent before discovery. A later revoke/connect must win over a stale RPC.
    const prior = (await this.db.query('SELECT id,grant_version,status,policy_hash FROM platform_mcp_connections WHERE user_id=$1 AND catalog_id=$2', [userId, entry.id])).rows[0];
    signal?.throwIfAborted();
    const tools = this.discovered(entry, await this.transport.discover(entry, signal));
    boundedJson(tools, MCP_RESULT_MAX_BYTES);
    signal?.throwIfAborted();
    return this.db.transaction(async client => {
      await client.query('SELECT id FROM platform_users WHERE id=$1 FOR NO KEY UPDATE', [userId]);
      if (!this.entry(entry.id) || mcpCatalogHash(this.entry(entry.id)!) !== policyHash) throw changed();
      const old = (await client.query('SELECT * FROM platform_mcp_connections WHERE user_id=$1 AND catalog_id=$2 FOR UPDATE', [userId, entry.id])).rows[0];
      if (!!old !== !!prior || old && ['id', 'grant_version', 'status', 'policy_hash'].some(key => old[key] !== prior[key])) throw changed();
      if (old?.grant_version === 2_147_483_647) throw changed();
      signal?.throwIfAborted();
      const result = await client.query(`INSERT INTO platform_mcp_connections(id,user_id,catalog_id,name,status,grant_version,policy_hash,tools,discovered_at)
        VALUES($1,$2,$3,$4,'connected',$5,$6,$7,now()) ON CONFLICT(user_id,catalog_id) DO UPDATE SET
        name=excluded.name,status='connected',grant_version=excluded.grant_version,policy_hash=excluded.policy_hash,tools=excluded.tools,discovered_at=now(),updated_at=now() RETURNING *`,
      [old?.id ?? randomUUID(), userId, entry.id, entry.name, old ? old.grant_version + 1 : 1, policyHash, JSON.stringify(tools)]);
      return this.connection(result.rows[0], entry);
    });
  }
  async revoke(userId: string, id: string, value: unknown): Promise<McpConnection> {
    const data = object(value);
    if (Object.keys(data).some(key => key !== 'expectedGrantVersion') || !grant(data.expectedGrantVersion)) throw invalid('Use the current MCP grant version when revoking.');
    return this.db.transaction(async client => {
      // Do not lock jobs here: worker transactions consistently lock job before connection.
      const row = (await client.query('SELECT * FROM platform_mcp_connections WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, userId])).rows[0];
      if (!row) throw notFound();
      if (row.grant_version !== data.expectedGrantVersion || row.grant_version === 2_147_483_647) throw changed();
      const result = await client.query("UPDATE platform_mcp_connections SET status='revoked',grant_version=grant_version+1,updated_at=now() WHERE id=$1 RETURNING *", [id]);
      return this.connection(result.rows[0], this.entry(row.catalog_id));
    });
  }
  private async current(client: Database | PoolClient, userId: string, id: string, lock = false): Promise<{ row: any; entry: McpCatalogEntry }> {
    const row = (await client.query(`SELECT * FROM platform_mcp_connections WHERE id=$1 AND user_id=$2${lock ? ' FOR UPDATE' : ''}`, [id, userId])).rows[0];
    if (!row) throw notFound();
    const entry = this.entry(row.catalog_id);
    if (row.status !== 'connected' || !entry || row.policy_hash !== mcpCatalogHash(entry)) throw changed();
    return { row, entry };
  }
  async tools(userId: string, id: string): Promise<{ connection: McpConnection; tools: McpTool[] }> {
    const { row, entry } = await this.current(this.db, userId, id);
    return { connection: this.connection(row, entry), tools: row.tools };
  }
  async agentTools(userId: string, value: unknown) {
    const data = object(value);
    if (Object.keys(data).some(key => key !== 'connectionId')) throw invalid('Unsupported MCP tool-list field.');
    if (data.connectionId !== undefined) return this.tools(userId, identifier(data.connectionId));
    const connections = await this.list(userId);
    return { connections };
  }
  async normalize(client: Database | PoolClient, userId: string, input: CreateJobInput): Promise<McpTaskBinding> {
    const prepared = parseMcpJob(input), { row, entry } = await this.current(client, userId, prepared.connectionId, true);
    if (row.grant_version !== prepared.grantVersion) throw changed();
    const tool: McpTool | undefined = row.tools.find((tool: McpTool) => tool.name === prepared.toolName && tool.schemaHash === prepared.schemaHash);
    if (!tool || !entry.tools.some(item => item.name === tool.name && item.schemaHash === tool.schemaHash) || mcpSchemaHash(tool.inputSchema, tool.outputSchema) !== tool.schemaHash) throw new ApiError(409, 'MCP_SCHEMA_CHANGED', 'Choose the current reviewed MCP tool schema.');
    validateArguments(tool.inputSchema, prepared.arguments);
    return { version: 1, connectionId: row.id, connectionName: entry.name, catalogId: entry.id, grantVersion: row.grant_version,
      toolName: tool.name, schemaHash: tool.schemaHash, inputSchema: structuredClone(tool.inputSchema), ...(tool.outputSchema === undefined ? {} : { outputSchema: structuredClone(tool.outputSchema) }), policyHash: row.policy_hash, argumentsHash: workflowHash(prepared.arguments) };
  }
  async validateBinding(client: Database | PoolClient, row: any): Promise<McpTaskBinding> {
    const policy: McpTaskBinding | undefined = row.execution_policy?.mcp;
    if (!policy || policy.version !== 1) throw new ApiError(409, 'MCP_DEFINITION_CHANGED', 'The MCP task has no current reviewed binding.');
    const input: CreateJobInput = { kind: 'mcp', provider: row.provider, prompt: row.prompt, options: row.options };
    const current = await this.normalize(client, row.user_id, input);
    if (workflowHash(current) !== workflowHash(policy)) throw new ApiError(409, 'MCP_DEFINITION_CHANGED', 'The MCP task binding changed after preparation.');
    return policy;
  }
  async started(client: Database | PoolClient, jobId: string): Promise<boolean> {
    return !!(await client.query('SELECT job_id FROM platform_mcp_receipts WHERE job_id=$1', [jobId])).rowCount;
  }
  async assertAuthorized(client: Database | PoolClient, binding: McpExecutionBinding): Promise<void> {
    binding.signal.throwIfAborted();
    const row = (await client.query(`SELECT *,lease_until>now() AS lease_active FROM platform_jobs WHERE id=$1 AND user_id=$2 FOR UPDATE`, [binding.jobId, binding.userId])).rows[0];
    if (!row || row.kind !== 'mcp' || row.status !== 'running' || row.generation !== binding.generation || row.lease_token !== binding.leaseToken || !row.lease_active || !row.requires_approval) throw new ApiError(409, 'MCP_AUTH_REVOKED', 'This MCP task no longer has a current execution lease.');
    const policy = await this.validateBinding(client, row);
    if (mcpDefinitionHash(binding.input, binding.policy) !== mcpDefinitionHash({ kind: 'mcp', provider: row.provider, prompt: row.prompt, options: row.options }, policy)) throw new ApiError(409, 'MCP_DEFINITION_CHANGED', 'The reviewed MCP task changed.');
    const approvals = await client.query("SELECT args FROM platform_approvals WHERE job_id=$1 AND user_id=$2 AND generation=$3 AND status='approved'", [binding.jobId, binding.userId, binding.generation]);
    if (!approvals.rows.some(approval => mcpApprovalMatches(row, approval.args))) throw new ApiError(409, 'MCP_AUTH_REVOKED', 'The current MCP task is no longer approved.');
  }
  async execute(binding: McpExecutionBinding): Promise<McpExecutionResult> {
    await this.db.transaction(client => this.assertAuthorized(client, binding));
    const entry = this.entry(binding.policy.catalogId); if (!entry) throw changed();
    const prepared = parseMcpJob(binding.input);
    const result = await this.transport.call(structuredClone(entry), { name: prepared.toolName, arguments: prepared.arguments, schemaHash: prepared.schemaHash }, {
      signal: binding.signal,
      beforeCall: () => this.db.transaction(async client => {
        await this.assertAuthorized(client, binding);
        if (await this.started(client, binding.jobId)) throw review();
        await client.query(`INSERT INTO platform_mcp_receipts(job_id,user_id,connection_id,generation,grant_version,tool_name,schema_hash,definition_hash,arguments_hash,status)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'started')`, [binding.jobId, binding.userId, binding.policy.connectionId, binding.generation, binding.policy.grantVersion,
          binding.policy.toolName, binding.policy.schemaHash, mcpDefinitionHash(binding.input, binding.policy), binding.policy.argumentsHash]);
      }),
    });
    if (!result || !Array.isArray(result.content) || result.isError !== undefined && typeof result.isError !== 'boolean') throw new ApiError(502, 'MCP_RESULT_INVALID', 'The MCP tool returned an invalid result.');
    if (binding.policy.outputSchema && result.isError !== true && (result.structuredContent === undefined || !compileMcpSchema(binding.policy.outputSchema)(result.structuredContent))) throw new ApiError(502, 'MCP_RESULT_INVALID', 'The MCP result did not match its reviewed output schema.');
    const text = boundedJson({ version: 1, provenance: 'untrusted_mcp', content: result.content,
      ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }), isError: result.isError === true }, MCP_RESULT_MAX_BYTES);
    binding.signal.throwIfAborted();
    return { artifacts: [{ name: 'mcp-result.json', mime: 'application/json', bytes: Buffer.from(text, 'utf8') }], mcpToolError: result.isError === true };
  }
  async assertPublication(client: PoolClient, binding: McpExecutionBinding): Promise<void> {
    await this.assertAuthorized(client, binding);
    const receipt = (await client.query('SELECT * FROM platform_mcp_receipts WHERE job_id=$1 FOR UPDATE', [binding.jobId])).rows[0];
    if (!receipt || receipt.status !== 'started' || receipt.user_id !== binding.userId || receipt.generation !== binding.generation || receipt.connection_id !== binding.policy.connectionId || receipt.grant_version !== binding.policy.grantVersion || receipt.tool_name !== binding.policy.toolName || receipt.schema_hash !== binding.policy.schemaHash || receipt.definition_hash !== mcpDefinitionHash(binding.input, binding.policy) || receipt.arguments_hash !== binding.policy.argumentsHash) throw review();
  }
  async complete(client: PoolClient, binding: McpExecutionBinding, artifactId: string, bytes: Uint8Array, toolError: boolean): Promise<void> {
    const saved = await client.query(`UPDATE platform_mcp_receipts SET status=$3,artifact_id=$4,response_hash=$5,error_code=$6,finished_at=now()
      WHERE job_id=$1 AND generation=$2 AND status='started' RETURNING job_id`, [binding.jobId, binding.generation, toolError ? 'tool_error' : 'completed', artifactId,
      createHash('sha256').update(bytes).digest('hex'), toolError ? 'MCP_TOOL_ERROR' : null]);
    if (!saved.rowCount) throw review();
  }
  async interrupt(client: PoolClient, jobId: string, generation: number, code: string): Promise<boolean> {
    const result = await client.query("UPDATE platform_mcp_receipts SET status='uncertain',error_code=$3,finished_at=now() WHERE job_id=$1 AND generation=$2 AND status='started' RETURNING job_id", [jobId, generation, code]);
    return !!result.rowCount || !!(await client.query("SELECT job_id FROM platform_mcp_receipts WHERE job_id=$1 AND status='uncertain'", [jobId])).rowCount;
  }
  async result(userId: string, value: unknown, signal?: AbortSignal): Promise<McpResult> {
    const data = object(value);
    if (Object.keys(data).some(key => !['jobId', 'offset', 'version', 'maxBytes'].includes(key))) throw invalid('Unsupported MCP result field.');
    const jobId = identifier(data.jobId);
    const found = await this.db.query(`SELECT j.*,r.generation AS mcp_generation,r.definition_hash AS mcp_definition_hash,r.artifact_id,r.response_hash,
      r.connection_id AS receipt_connection_id,r.grant_version AS receipt_grant_version,r.tool_name AS receipt_tool_name,r.schema_hash AS receipt_schema_hash,r.arguments_hash AS receipt_arguments_hash,
      a.metadata,u.byte_size FROM platform_jobs j JOIN platform_mcp_receipts r ON r.job_id=j.id JOIN platform_artifacts a ON a.id=r.artifact_id
      JOIN platform_uploads u ON u.id=a.upload_id WHERE j.id=$1 AND j.user_id=$2 AND j.kind='mcp' AND r.user_id=$2 AND a.user_id=$2 AND a.job_id=j.id
      AND u.user_id=$2 AND r.status IN ('completed','tool_error')`, [jobId, userId]);
    if (!found.rowCount) throw notFound();
    const row = found.rows[0], policy: McpTaskBinding | undefined = row.execution_policy?.mcp;
    if (!policy || row.receipt_connection_id !== policy.connectionId || row.receipt_grant_version !== policy.grantVersion || row.receipt_tool_name !== policy.toolName || row.receipt_schema_hash !== policy.schemaHash || row.receipt_arguments_hash !== policy.argumentsHash || row.metadata?.mcpDefinitionHash !== row.mcp_definition_hash || row.metadata?.mcpGeneration !== row.mcp_generation || workflowHash(row.metadata?.mcp) !== workflowHash(mcpSummary(policy)) || Number(row.byte_size) > MCP_RESULT_MAX_BYTES || mcpDefinitionHash({ kind: 'mcp', provider: row.provider, prompt: row.prompt, options: row.options }, policy) !== row.mcp_definition_hash) throw new ApiError(409, 'MCP_RESULT_CHANGED', 'The saved MCP result does not match its reviewed task.');
    const approvals = await this.db.query("SELECT args FROM platform_approvals WHERE job_id=$1 AND user_id=$2 AND generation=$3 AND status='approved'", [jobId, userId, row.mcp_generation]);
    if (!approvals.rows.some(approval => mcpApprovalMatches(row, approval.args))) throw new ApiError(409, 'MCP_RESULT_UNAPPROVED', 'The saved MCP result has no matching historical approval.');
    const input = parseArtifactTextInput({ artifactId: row.artifact_id, ...Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'jobId')) });
    const page = await readMcpArtifactTextPage(this.db, this.storageRequired(), userId, input, { jobId, responseHash: row.response_hash }, signal);
    return { ...page, provenance: 'untrusted_mcp', source: { ...page.source, ...mcpSummary(policy), generation: row.mcp_generation } };
  }
  private storageRequired(): BlobStorage { if (!this.storage) throw new ApiError(503, 'MCP_STORAGE_UNAVAILABLE', 'Private MCP result storage is unavailable.'); return this.storage; }
}
