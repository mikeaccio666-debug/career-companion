import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MCP_ARGUMENT_MAX_BYTES } from '@companion/platform-contracts';
import { parseJob } from '../src/jobs.ts';
import { mcpApprovalMatches, mcpDefinitionHash, mcpJobInput, mcpSummary, parseMcpPrepare, type McpTaskBinding } from '../src/mcp-connections.ts';
import { mcpSchemaHash } from '../src/mcp-config.ts';
import { workflowHash } from '@companion/ai-core';

const schema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false };
const prepared = () => ({ connectionId: randomUUID(), grantVersion: 1, toolName: 'fictional_search', schemaHash: mcpSchemaHash(schema), arguments: { query: 'Fictional career question' }, goal: 'Review fictional data only' });

test('MCP preparation is strict, bounded JSON with a fixed grant and schema', () => {
  const value = prepared();
  assert.deepEqual(parseMcpPrepare(value), value);
  assert.equal(parseMcpPrepare({ ...value, connectionId: value.connectionId.toUpperCase() }).connectionId, value.connectionId);
  for (const changed of [
    { ...value, url: 'https://fictional.invalid/' }, { ...value, grantVersion: 0 }, { ...value, grantVersion: '1' },
    { ...value, schemaHash: 'f'.repeat(63) }, { ...value, toolName: 'tool with spaces' }, { ...value, arguments: [] },
    { ...value, arguments: { query: Infinity } }, { ...value, arguments: JSON.parse('{"__proto__":{"fictional":true}}') },
    { ...value, arguments: { query: 'x'.repeat(MCP_ARGUMENT_MAX_BYTES) } }, { ...value, goal: 'x'.repeat(20_001) },
  ]) assert.throws(() => parseMcpPrepare(changed));
  let nested: any = 'fictional'; for (let index = 0; index < 26; index++) nested = { nested };
  assert.throws(() => parseMcpPrepare({ ...value, arguments: nested }));
});

test('generic job input rejects MCP model, attachments, templates and unknown execution options', () => {
  const input = mcpJobInput(prepared());
  assert.equal(parseJob(input).kind, 'mcp');
  for (const changed of [ { ...input, model: 'fictional-model' }, { ...input, attachmentIds: [] },
    { ...input, executionTemplate: { version: 1, hash: '0'.repeat(64) } },
    { ...input, options: { ...input.options, endpoint: 'https://fictional.invalid/' } },
  ]) assert.throws(() => { const parsed = parseJob(changed); parseMcpPrepare({ ...parsed.options, goal: parsed.prompt }); });
});

test('MCP approvals bind both server summary and exact reviewed parameters', () => {
  const value = prepared(), input = mcpJobInput(value);
  const policy: McpTaskBinding = { version: 1, connectionId: value.connectionId, catalogId: 'fictional-catalog', connectionName: 'Fictional fixture',
    grantVersion: 1, toolName: value.toolName, schemaHash: value.schemaHash, policyHash: '0'.repeat(64), inputSchema: schema, argumentsHash: workflowHash(value.arguments) };
  const row = { kind: 'mcp', provider: 'mcp', prompt: input.prompt, options: input.options, execution_policy: { mcp: policy } };
  const args = { ...input, mcp: mcpSummary(policy), mcpDefinitionHash: mcpDefinitionHash(input, policy) };
  assert.equal(mcpApprovalMatches(row, args), true);
  for (const changed of [ { ...args, mcp: { ...args.mcp, grantVersion: 2 } }, { ...args, mcp: { ...args.mcp, connectionId: randomUUID() } },
    { ...args, options: { ...args.options, arguments: { query: 'Different fictional query' } } }, { ...args, prompt: 'Different fictional goal' },
    { ...args, mcpDefinitionHash: 'f'.repeat(64) }, { ...args, model: 'fictional-model' },
  ]) assert.equal(mcpApprovalMatches(row, changed), false);
  assert.equal(mcpApprovalMatches({ ...row, execution_policy: { mcp: { ...policy, policyHash: '1'.repeat(64) } } }, args), false);
});
