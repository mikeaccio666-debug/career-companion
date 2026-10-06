import assert from 'node:assert/strict';
import { test } from 'node:test';
import http, { type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { MCP_RESULT_MAX_BYTES } from '@companion/platform-contracts';
import { ApiError } from '../src/errors.ts';
import { mcpSchemaHash, readMcpConfig, type McpCatalogEntry } from '../src/mcp-config.ts';
import { createMcpFetch, publicMcpAddress } from '../src/mcp-fetch.ts';
import { createMcpTransport } from '../src/mcp-transport.ts';

const basicSchema: Record<string, unknown> = {
  type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false,
};
type Message = { jsonrpc: string; id?: number | string; method: string; params?: Record<string, unknown> };
type SeenRequest = { method: string; headers: http.IncomingHttpHeaders; message?: Message };
interface FixtureOptions {
  modern?: boolean;
  schema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  extraTools?: Record<string, unknown>[];
  call?: (res: ServerResponse, message: Message) => void;
  raw?: (res: ServerResponse, request: SeenRequest) => void;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function fixture(options: FixtureOptions = {}) {
  const seen: SeenRequest[] = [];
  const tool = {
    name: 'reviewed_lookup', inputSchema: options.schema ?? basicSchema,
    ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
  };
  const sessionId = 'fictional-mcp-session';
  const server = http.createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request: SeenRequest = { method: req.method ?? 'GET', headers: req.headers };
      if (chunks.length) request.message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Message;
      seen.push(request);
      if (options.raw) { options.raw(res, request); return; }
      if (request.method === 'GET') { res.writeHead(405); res.end(); return; }
      if (request.method === 'DELETE') { res.writeHead(204); res.end(); return; }
      const msg = request.message!;
      const send = (result: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(200, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      };
      if (msg.method === 'server/discover') {
        if (options.modern) send({
          resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} },
          ttlMs: 0, cacheScope: 'private',
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fictional-fixture', version: '0.0.0' } },
        });
        else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }));
        }
      } else if (msg.method === 'initialize') send({
        protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fictional-fixture', version: '0.0.0' },
      }, { 'mcp-session-id': sessionId });
      else if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled') { res.writeHead(202); res.end(); }
      else if (msg.method === 'tools/list') send({
        ...(options.modern ? { resultType: 'complete', ttlMs: 0, cacheScope: 'private' } : {}),
        tools: [tool, ...(options.extraTools ?? [])],
      });
      else if (msg.method === 'tools/call') {
        if (options.call) options.call(res, msg);
        else send({
          ...(options.modern ? { resultType: 'complete' } : {}),
          content: [{ type: 'text', text: 'Fictional lookup result' }], structuredContent: { matched: true },
        });
      } else { res.writeHead(400); res.end(); }
    } catch {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const entry: McpCatalogEntry = {
    id: 'fictional', name: 'Fictional fixture', url: `${origin}/mcp`,
    tools: [{ name: tool.name, schemaHash: mcpSchemaHash(tool.inputSchema, options.outputSchema) }],
  };
  return {
    seen, entry, origin, sessionId,
    transport: createMcpTransport({ entries: [entry], fixtureOrigins: [origin] }),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
const input = (entry: McpCatalogEntry) => ({ name: 'reviewed_lookup', arguments: { query: 'fictional' }, schemaHash: entry.tools[0]!.schemaHash });
const errorCode = (code: string) => (error: unknown) => error instanceof ApiError && error.code === code;
const calls = (seen: SeenRequest[]) => seen.filter((request) => request.message?.method === 'tools/call');

for (const modern of [false, true]) {
  test(`actual SDK ${modern ? 'modern discover' : 'legacy initialize'} discovers, authorizes once, calls and cleans up`, async () => {
    const f = await fixture({ modern });
    try {
      f.entry.bearerToken = 'fictional-service-token';
      const tools = await f.transport.discover(f.entry);
      assert.deepEqual(tools.map((tool) => tool.name), ['reviewed_lookup']);
      assert.equal(calls(f.seen).length, 0);
      let started = 0;
      const result = await f.transport.call(f.entry, input(f.entry), {
        beforeCall: async () => { assert.equal(calls(f.seen).length, 0); started += 1; },
      });
      assert.equal(started, 1); assert.equal(calls(f.seen).length, 1);
      assert.deepEqual(result.structuredContent, { matched: true });
      for (const request of f.seen) {
        assert.equal(request.headers.cookie, undefined);
        assert.equal(request.headers['x-companion-account'], undefined);
        assert.equal(request.headers.authorization, 'Bearer fictional-service-token');
      }
      if (modern) {
        assert.equal(f.seen.filter((request) => request.message?.method === 'initialize').length, 0);
        for (const request of f.seen.filter((request) => request.message)) {
          assert.equal(request.headers['mcp-protocol-version'], '2026-07-28');
          assert.equal(request.headers['mcp-method'], request.message!.method);
        }
        assert.equal(calls(f.seen)[0]!.headers['mcp-name'], 'reviewed_lookup');
        assert.equal(f.seen.filter((request) => request.method === 'DELETE').length, 0);
      } else {
        const deletes = f.seen.filter((request) => request.method === 'DELETE');
        assert.equal(deletes.length, 2);
        assert(deletes.every((request) => request.headers['mcp-session-id'] === f.sessionId));
      }
    } finally { await f.close(); }
  });
}

test('schema drift and a denied durable authorization never reach tools/call', async () => {
  const f = await fixture({ modern: true });
  try {
    let started = 0;
    await assert.rejects(f.transport.call(f.entry, { ...input(f.entry), schemaHash: '0'.repeat(64) }, {
      beforeCall: async () => { started += 1; },
    }), errorCode('MCP_TOOL_CHANGED'));
    assert.equal(started, 0); assert.equal(calls(f.seen).length, 0);
    await assert.rejects(f.transport.call(f.entry, input(f.entry), {
      beforeCall: async () => { throw new ApiError(409, 'FICTIONAL_LEASE_REVOKED', 'The fictional lease was revoked.'); },
    }), errorCode('FICTIONAL_LEASE_REVOKED'));
    assert.equal(calls(f.seen).length, 0);
  } finally { await f.close(); }
});

test('modern reviewed x-mcp-header values match the tool arguments and do not retry header mismatch', async () => {
  const schema = { ...basicSchema, properties: { query: { type: 'string', 'x-mcp-header': 'Query' } } };
  const f = await fixture({ modern: true, schema });
  try {
    await f.transport.call(f.entry, input(f.entry), { beforeCall: async () => {} });
    assert.equal(calls(f.seen)[0]!.headers['mcp-param-query'], 'fictional');
    assert.deepEqual(calls(f.seen)[0]!.message!.params?.arguments, { query: 'fictional' });
  } finally { await f.close(); }
  const rejected = await fixture({ modern: true, schema, call(res, msg) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32020, message: 'Fictional header mismatch' } }));
  } });
  try {
    let started = 0;
    await assert.rejects(rejected.transport.call(rejected.entry, input(rejected.entry), { beforeCall: async () => { started += 1; } }), errorCode('MCP_CONNECTION_FAILED'));
    assert.equal(started, 1); assert.equal(calls(rejected.seen).length, 1);
    assert.equal(rejected.seen.filter((request) => request.message?.method === 'tools/list').length, 1);
  } finally { await rejected.close(); }
});

for (const modern of [false, true]) {
  test(`${modern ? 'modern' : 'legacy'} cancellation closes the real HTTP response and never retries the tool`, async () => {
    const entered = deferred(), closed = deferred(), stop = new AbortController();
    const f = await fixture({ modern, call(res) {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': fictional keepalive\n\n');
      res.once('close', closed.resolve); entered.resolve();
    } });
    try {
      let started = 0;
      const operation = f.transport.call(f.entry, input(f.entry), { signal: stop.signal, beforeCall: async () => { started += 1; } });
      const failure = assert.rejects(operation, errorCode('MCP_INTERRUPTED'));
      await entered.promise; stop.abort(); await failure;
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([closed.promise, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Cancelled MCP HTTP response remained open')), 1_000);
        })]);
      } finally { if (timer) clearTimeout(timer); }
      assert.equal(started, 1); assert.equal(calls(f.seen).length, 1);
      if (modern) assert.equal(f.seen.filter((request) => request.message?.method === 'notifications/cancelled').length, 0);
    } finally { await f.close(); }
  });
}

test('session fetch rejects redirects, forbidden platform headers, unapproved URLs and oversized request bodies before dispatch', async () => {
  const f = await fixture({ raw(res) { res.writeHead(302, { location: '/unreviewed' }); res.end(); } });
  try {
    const fetch = createMcpFetch(f.entry, [f.origin], new AbortController().signal);
    const forbiddenHeaders: Record<string, string>[] = [
      { cookie: 'fictional-platform-cookie' }, { 'x-companion-account': 'fictional-account' }, { authorization: 'Bearer undefined' },
    ];
    for (const headers of forbiddenHeaders) {
      await assert.rejects(fetch(f.entry.url, { headers }), errorCode('MCP_ENDPOINT_REJECTED'));
    }
    await assert.rejects(fetch(`${f.origin}/unreviewed`), errorCode('MCP_ENDPOINT_REJECTED'));
    await assert.rejects(fetch(f.entry.url, { method: 'POST', body: 'x'.repeat(65_537) }), errorCode('MCP_ENDPOINT_REJECTED'));
    assert.equal(f.seen.length, 0);
    await assert.rejects(fetch(f.entry.url), errorCode('MCP_ENDPOINT_REJECTED'));
    assert.equal(f.seen.length, 1); assert.equal(f.seen[0]!.headers['accept-encoding'], 'identity');
  } finally { await f.close(); }
});

test('wire byte cap applies to a chunked response without Content-Length and compressed responses are refused', async () => {
  const f = await fixture({ raw(res) { res.writeHead(200, { 'content-type': 'application/json' }); res.write('x'.repeat(280_000)); res.end(); } });
  try {
    const response = await createMcpFetch(f.entry, [f.origin], new AbortController().signal)(f.entry.url);
    await assert.rejects(response.text(), errorCode('MCP_RESPONSE_TOO_LARGE'));
  } finally { await f.close(); }
  const compressed = await fixture({ raw(res) { res.writeHead(200, { 'content-encoding': 'gzip' }); res.end('fictional'); } });
  try {
    await assert.rejects(createMcpFetch(compressed.entry, [compressed.origin], new AbortController().signal)(compressed.entry.url), errorCode('MCP_ENDPOINT_REJECTED'));
  } finally { await compressed.close(); }
});

test('a valid oversized tool result is refused once after invocation and does not repeat external execution', async () => {
  const f = await fixture({ modern: true, call(res, msg) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { resultType: 'complete', content: [{ type: 'text', text: 'x'.repeat(MCP_RESULT_MAX_BYTES) }] } }));
  } });
  try {
    let started = 0;
    await assert.rejects(f.transport.call(f.entry, input(f.entry), { beforeCall: async () => { started += 1; } }), errorCode('MCP_RESULT_TOO_LARGE'));
    assert.equal(started, 1); assert.equal(calls(f.seen).length, 1);
  } finally { await f.close(); }
});

test('private/special DNS addresses and production fixture bypasses fail the static connection policy', () => {
  for (const address of ['0.0.0.0', '10.0.0.1', '127.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '::', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002::1', '3fff::1']) assert.equal(publicMcpAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(publicMcpAddress(address), true, address);
  assert.throws(() => readMcpConfig({ NODE_ENV: 'production', PLATFORM_MCP_FIXTURE_ORIGINS: 'http://127.0.0.1:9999' }), /Production/);
  const entry: McpCatalogEntry = { id: 'fixture', name: 'Fixture', url: 'https://127.0.0.1/mcp', tools: [] };
  assert.throws(() => createMcpFetch(entry, [], new AbortController().signal), errorCode('MCP_ENDPOINT_REJECTED'));
  assert.throws(() => createMcpFetch({ ...entry, url: 'http://127.0.0.1:9999/mcp' }, [], new AbortController().signal), errorCode('MCP_ENDPOINT_REJECTED'));
});

test('manual SDK tools/list does not log remote invalid-header tool names', async () => {
  const f = await fixture({ modern: true, extraTools: [{
    name: 'FICTIONAL_PRIVATE_REMOTE_TOOL', inputSchema: { type: 'object', properties: { data: { type: 'object', 'x-mcp-header': 'Invalid' } } },
  }] });
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    await f.transport.discover(f.entry);
    assert.deepEqual(warnings, []);
    assert.equal(calls(f.seen).length, 0);
  } finally { console.warn = originalWarn; await f.close(); }
});

test('output schema drift prevents durable authorization and external invocation', async () => {
  const f = await fixture({ modern: true, outputSchema: { type: 'object', properties: { matched: { type: 'boolean' } } } });
  try {
    const oldHash = mcpSchemaHash(basicSchema);
    assert.notEqual(f.entry.tools[0]!.schemaHash, oldHash);
    f.entry.tools[0]!.schemaHash = oldHash;
    let started = 0;
    await assert.rejects(f.transport.call(f.entry, input(f.entry), { beforeCall: async () => { started += 1; } }), errorCode('MCP_TOOL_CHANGED'));
    assert.equal(started, 0); assert.equal(calls(f.seen).length, 0);
  } finally { await f.close(); }
});

test('a reviewed tool with an invalid header declaration is discarded before durable authorization', async () => {
  const f = await fixture({ modern: true, schema: {
    type: 'object', properties: { query: { type: 'object', 'x-mcp-header': 'Query' } },
  } });
  try {
    let started = 0;
    const warnings: unknown[][] = [], originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      assert.deepEqual(await f.transport.discover(f.entry), []);
      await assert.rejects(f.transport.call(f.entry, input(f.entry), { beforeCall: async () => { started += 1; } }), errorCode('MCP_TOOL_CHANGED'));
      assert.equal(started, 0); assert.equal(calls(f.seen).length, 0); assert.deepEqual(warnings, []);
    } finally { console.warn = originalWarn; }
  } finally { await f.close(); }
});

for (const value of [null, false]) {
  test(`modern SDK preserves schema-valid structuredContent=${String(value)}`, async () => {
    const f = await fixture({ modern: true, outputSchema: { type: value === null ? 'null' : 'boolean' }, call(res, msg) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { resultType: 'complete', content: [], structuredContent: value } }));
    } });
    try {
      const result = await f.transport.call(f.entry, input(f.entry), { beforeCall: async () => {} });
      assert(Object.hasOwn(result, 'structuredContent'));
      assert.equal(result.structuredContent, value); assert.equal(calls(f.seen).length, 1);
    } finally { await f.close(); }
  });
}

test('explicit SDK output validator never logs untrusted schema format values', async () => {
  const f = await fixture({ modern: true, outputSchema: {
    type: 'object', properties: { matched: { type: 'boolean' }, note: { type: 'string', format: 'FICTIONAL_PRIVATE_FORMAT' } },
  } });
  const warnings: unknown[][] = [];
  const originalWarn = console.warn, originalError = console.error;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  console.error = (...args: unknown[]) => { warnings.push(args); };
  try {
    const result = await f.transport.call(f.entry, input(f.entry), { beforeCall: async () => {} });
    assert.deepEqual(result.structuredContent, { matched: true }); assert.deepEqual(warnings, []);
  } finally { console.warn = originalWarn; console.error = originalError; await f.close(); }
});

test('pre-aborted context and revocation during beforeCall never invoke the external tool', async () => {
  const f = await fixture({ modern: true });
  try {
    const early = new AbortController(); early.abort(); let started = 0;
    await assert.rejects(f.transport.call(f.entry, input(f.entry), {
      signal: early.signal, beforeCall: async () => { started += 1; },
    }), errorCode('MCP_INTERRUPTED'));
    assert.equal(started, 0); assert.equal(f.seen.length, 0);
    const during = new AbortController();
    await assert.rejects(f.transport.call(f.entry, input(f.entry), {
      signal: during.signal, beforeCall: async () => { started += 1; during.abort(); },
    }), errorCode('MCP_INTERRUPTED'));
    assert.equal(started, 1); assert.equal(calls(f.seen).length, 0);
  } finally { await f.close(); }
});
