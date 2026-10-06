import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { McpConnection, McpResult, McpTool } from '@companion/platform-contracts';
import { PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { createPlatformClient } from '../src/api.ts';
import { createPlatformEndpoints } from '../src/platform-endpoints.ts';
import { AccountRequestContext } from '../src/account-context.ts';
import { createMcpClient } from '../src/mcp-api.ts';

const id = '10000000-0000-4000-8000-000000000001', jobId = '10000000-0000-4000-8000-000000000002', accountA = '10000000-0000-4000-8000-000000000003';
const connection: McpConnection = { catalogId: 'fictional', name: 'Fictional source', status: 'connected', connectable: true, connectionId: id, grantVersion: 2, toolCount: 1 };
const tool: McpTool = { name: 'fictional_lookup', schemaHash: 'a'.repeat(64), inputSchema: { type: 'object' }, authorization: 'reviewed_read_only' };
const summary = { connectionId: id, connectionName: connection.name, catalogId: connection.catalogId, grantVersion: 2, toolName: tool.name, schemaHash: tool.schemaHash };
const prepareInput = { connectionId: id, grantVersion: 2, toolName: tool.name, schemaHash: tool.schemaHash, arguments: { query: 'Fictional' }, goal: 'Read fictional facts.' };
const { goal: prepareGoal, ...prepareOptions } = prepareInput;
const prepared = { job: { id: jobId, kind: 'mcp', status: 'needs_approval', prompt: prepareGoal, mcp: summary }, approval: { id, jobId, status: 'pending', args: { kind: 'mcp', provider: 'mcp', prompt: prepareGoal, options: prepareOptions, mcp: summary, mcpDefinitionHash: 'b'.repeat(64) } } };
const result: McpResult = { source: { ...summary, artifactId: id, jobId, name: 'mcp-result.json', mime: 'application/json', size: 100, generation: 1 }, provenance: 'untrusted_mcp', encoding: 'utf-8', version: 'fictional-version', offset: 0, nextOffset: 30, truncated: true, text: 'Fictional first page of data.' };

test('MCP connection, discovery, preparation and paged reads use real private HTTP under the captured account, without execution/approval calls', async () => {
  const observed: { path: string; method: string; body: any; account?: string | string[] }[] = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    observed.push({ path: request.url!, method: request.method!, body: body ? JSON.parse(body) : null, account: request.headers[PLATFORM_ACCOUNT_HEADER] });
    const url = new URL(request.url!, 'http://127.0.0.1');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(url.pathname.endsWith('/tools') ? { connection, tools: [tool] } : url.pathname.endsWith('/result') ? { result: { ...result, ...(url.searchParams.has('offset') ? { offset: 30, nextOffset: null, truncated: false } : {}) } } : url.pathname.endsWith('/mcp/tasks') ? prepared : request.method === 'GET' ? { connections: [connection] } : { connection: request.method === 'DELETE' ? { ...connection, status: 'revoked', grantVersion: 3 } : connection }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const context = new AccountRequestContext(); context.changeSession(accountA); const bound = createPlatformClient(createPlatformEndpoints(`http://127.0.0.1:${address.port}`), undefined, context).capture(); const api = createMcpClient(bound.request);
  try {
    assert.equal((await api.list())[0].catalogId, 'fictional'); await api.connect('fictional'); await api.tools(id);
    const input = prepareInput;
    assert.equal((await api.prepare(input)).job.status, 'needs_approval'); await api.result({ jobId }); await api.result({ jobId, offset: 30, version: result.version }); await api.revoke(id, 2);
    assert.deepEqual(observed.map(({ method, path }) => [method, path]), [['GET', '/api/platform/mcp/connections'], ['POST', '/api/platform/mcp/connections'], ['GET', `/api/platform/mcp/connections/${id}/tools`], ['POST', '/api/platform/mcp/tasks'], ['GET', `/api/platform/mcp/tasks/${jobId}/result`], ['GET', `/api/platform/mcp/tasks/${jobId}/result?offset=30&version=fictional-version`], ['DELETE', `/api/platform/mcp/connections/${id}`]]);
    assert.deepEqual(observed[3].body, input); assert.deepEqual(observed[6].body, { expectedGrantVersion: 2 }); assert.equal(observed.every((entry) => entry.account === accountA), true);
    assert.equal(observed.some(({ path }) => /tools\/call|decision|\/retry/.test(path)), false);
    context.changeSession('10000000-0000-4000-8000-000000000004'); await assert.rejects(api.list()); assert.equal(observed.length, 7);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('pre-aborted and later cancelled discovery cannot publish private tools even when transport ignores cancellation', async () => {
  let calls = 0, resolve!: (value: unknown) => void;
  const api = createMcpClient(<T>() => { calls++; return new Promise<T>((done) => { resolve = done as any; }); });
  const before = new AbortController(); before.abort(); await assert.rejects(api.tools(id, before.signal), { name: 'AbortError' }); assert.equal(calls, 0);
  const controller = new AbortController(), pending = api.tools(id, controller.signal); controller.abort(); resolve({ connection, tools: [tool] }); await assert.rejects(pending, { name: 'AbortError' });
});

test('bad identifiers, revisions, pagination and malformed successful responses fail explicitly', async () => {
  let calls = 0; const api = createMcpClient(async <T>() => { calls++; return {} as T; });
  await assert.rejects(api.tools('not-an-id')); await assert.rejects(api.revoke(id, 0)); await assert.rejects(api.result({ jobId, offset: 1 })); await assert.rejects(api.result({ jobId, maxBytes: 16385 })); assert.equal(calls, 0);
  await assert.rejects(api.list(), /连接目录/); await assert.rejects(api.connect('fictional'), /连接状态/); await assert.rejects(api.tools(id), /连接状态/); await assert.rejects(api.result({ jobId }), /来源或版本/);
});

test('connection recovery uses explicit catalog presence returned over the account-bound API', async () => {
  const changed = { ...connection, status: 'unavailable', reason: 'Same fictional explanation.' };
  const api = createMcpClient(async <T>() => ({ connections: [changed, { ...changed, catalogId: 'removed', connectable: false }] }) as T);
  const items = await api.list(); assert.equal(items[0].connectable, true); assert.equal(items[1].connectable, false);
  const missing = createMcpClient(async <T>() => ({ connections: [{ ...changed, connectable: undefined }] }) as T);
  await assert.rejects(missing.list(), /完整的外部连接状态/);
});

test('result source, provenance and exact pagination version cannot be silently replaced', async () => {
  for (const change of [{ provenance: 'trusted' }, { source: { ...result.source, jobId: id } }, { version: 'other-version' }, { offset: 1 }, { nextOffset: -1 }]) {
    const api = createMcpClient(async <T>() => ({ result: { ...result, ...change } }) as T);
    await assert.rejects(api.result({ jobId, offset: 0, version: result.version }), /来源或版本/);
  }
});

test('preparation rejects mismatched frozen tool/arguments rather than presenting another task as this request', async () => {
  const options = prepared.approval.args.options;
  const valid = createMcpClient(async <T>() => prepared as T); assert.equal((await valid.prepare(prepareInput)).job.id, jobId);
  for (const change of [{ arguments: { query: 'other data' } }, { toolName: 'other_tool' }, { grantVersion: 3 }]) {
    const api = createMcpClient(async <T>() => ({ ...prepared, approval: { ...prepared.approval, args: { ...prepared.approval.args, options: { ...options, ...change } } } }) as T);
    await assert.rejects(api.prepare(prepareInput), /不一致/);
  }
});
