import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mcpCatalogHash, mcpSchemaHash, readMcpConfig } from '../src/mcp-config.ts';
import { compileMcpSchema, validMcpHeaderSchema } from '../src/mcp-schema.ts';

const inputSchema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false };
const entry = () => ({ id: 'fictional_research', name: 'Fictional research service', url: 'https://mcp.example.invalid/mcp', tools: [{ name: 'lookup', schemaHash: mcpSchemaHash(inputSchema) }] });
async function withCatalog(run: (file: string, write: (value: unknown) => Promise<void>) => Promise<void>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-mcp-config-'));
  const file = path.join(directory, 'catalog.json');
  const write = (value: unknown) => fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
  try { await write({ version: 1, entries: [entry()] }); await run(file, write); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}
test('MCP remains unavailable without an explicit reviewed server catalog', () => {
  assert.deepEqual(readMcpConfig({}), { entries: [], fixtureOrigins: [] });
  assert.throws(() => readMcpConfig({ PLATFORM_MCP_CATALOG_FILE: '' }));
});
test('catalog stores exact reviewed definitions and server service credentials affect frozen policy', async () => {
  await withCatalog(async (file, write) => {
    await write({ version: 1, entries: [{ ...entry(), bearerEnv: 'MCP_FIXTURE_SERVICE_TOKEN' }] });
    const config = readMcpConfig({ PLATFORM_MCP_CATALOG_FILE: file, MCP_FIXTURE_SERVICE_TOKEN: 'synthetic-service-token' });
    assert.equal(config.entries[0].tools[0].schemaHash, mcpSchemaHash(inputSchema));
    assert.notEqual(mcpCatalogHash(config.entries[0]), mcpCatalogHash({ ...config.entries[0], bearerToken: 'synthetic-rotated-token' }));
    assert.throws(() => readMcpConfig({ PLATFORM_MCP_CATALOG_FILE: file }));
    assert.throws(() => readMcpConfig({ PLATFORM_MCP_CATALOG_FILE: file, MCP_FIXTURE_SERVICE_TOKEN: 'synthetic\ninvalid' }));
  });
});
test('unreviewed catalog fields, duplicate identities and unsafe endpoints fail before connection', async () => {
  await withCatalog(async (file, write) => {
    for (const item of [
      { ...entry(), id: undefined }, { ...entry(), tools: [] }, { ...entry(), command: 'not-supported' },
      ...['http://mcp.example.invalid/mcp', 'https://127.0.0.1/mcp', 'https://mcp.example.invalid/mcp?token=synthetic', 'https://user:synthetic@mcp.example.invalid/mcp'].map(url => ({ ...entry(), url })),
    ]) { await write({ version: 1, entries: [item] }); assert.throws(() => readMcpConfig({ PLATFORM_MCP_CATALOG_FILE: file })); }
    await write({ version: 1, entries: [entry(), entry()] }); assert.throws(() => readMcpConfig({ PLATFORM_MCP_CATALOG_FILE: file }));
  });
});
test('loopback fixture opt-in cannot become a production connection policy', async () => {
  await withCatalog(async (file, write) => {
    await write({ version: 1, entries: [{ ...entry(), url: 'http://127.0.0.1:19198/mcp' }] });
    const env = { PLATFORM_MCP_CATALOG_FILE: file, PLATFORM_MCP_FIXTURE_ORIGINS: 'http://127.0.0.1:19198' };
    assert.equal(readMcpConfig(env).entries.length, 1);
    assert.throws(() => readMcpConfig({ PLATFORM_MCP_CATALOG_FILE: file }));
    assert.throws(() => readMcpConfig({ ...env, NODE_ENV: 'production' }));
    assert.throws(() => readMcpConfig({ ...env, PLATFORM_MCP_FIXTURE_ORIGINS: 'http://mcp.example.invalid:19198' }));
  });
});
test('schema snapshots include declared output schema and validators enforce both supported dialects without rewriting data', () => {
  const output = { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] };
  assert.notEqual(mcpSchemaHash(inputSchema), mcpSchemaHash(inputSchema, output));
  assert.notEqual(mcpSchemaHash(inputSchema, output), mcpSchemaHash(inputSchema, { ...output, additionalProperties: false }));
  for (const $schema of ['http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2020-12/schema']) {
    const valid = compileMcpSchema({ $schema, type: 'object', properties: { email: { type: 'string', format: 'email' }, count: { type: 'integer', default: 1 } }, required: ['email'], additionalProperties: false });
    const data = { email: 'fictional@example.invalid' }; assert.equal(valid(data), true); assert.deepEqual(data, { email: 'fictional@example.invalid' });
    assert.equal(valid({ email: 'invalid-email' }), false); assert.equal(valid({ email: 'fictional@example.invalid', count: '1' }), false);
  }
  assert.throws(() => compileMcpSchema({ $schema: 'https://unknown.example.invalid/schema', type: 'object' }));
  assert.throws(() => compileMcpSchema({ $ref: 'https://unknown.example.invalid/schema' }));
});

test('MCP header declarations are primitive, unique and statically reachable before a call is authorized', () => {
  assert.equal(validMcpHeaderSchema({ type: 'object', properties: { query: { type: 'string', 'x-mcp-header': 'Query' } } }), true);
  assert.equal(validMcpHeaderSchema({ type: 'string', 'x-mcp-header': 'Root' }), false);
  assert.equal(validMcpHeaderSchema({ properties: { first: { type: 'string', 'x-mcp-header': 'Query' }, second: { type: 'string', 'x-mcp-header': 'query' } } }), false);
  assert.equal(validMcpHeaderSchema({ properties: { first: { type: 'object', 'x-mcp-header': 'Query' } } }), false);
  assert.equal(validMcpHeaderSchema({ properties: { first: { type: 'number', 'x-mcp-header': 'Query' } } }), false);
  for (const keyword of ['items', 'oneOf', 'allOf', 'additionalProperties', '$defs']) {
    const annotation = { type: 'object', properties: { query: { type: 'string', 'x-mcp-header': 'Query' } } };
    const nested = keyword === '$defs' ? { sample: annotation } : keyword === 'oneOf' || keyword === 'allOf' ? [annotation] : annotation;
    assert.equal(validMcpHeaderSchema({ [keyword]: nested }), false);
  }
});
