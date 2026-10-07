import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createProviderRuntime, ProviderAdapter, runAgentLoop } from '@companion/ai-core';
import type { AgentEvent, ChatInput, ModelCallEvent } from '@companion/platform-contracts';
import { CapabilityRegistry, type CapabilityScope } from '../src/capabilities.ts';
import { ApiError } from '../src/errors.ts';

type Provider = 'openai' | 'ollama';
type Call = { callId: string; name: string; arguments: string };
const ownerId = 'fictional-career-owner';
const planArgs = { title: 'Inspect one fictional report', steps: ['Compare one reported change.'], references: [] };
const call = (name: string, callId: string, args: Record<string, unknown>): Call => ({ name, callId, arguments: JSON.stringify(args) });
const write = (response: ServerResponse, event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`);

/** Every byte goes to an owned loopback fixture, including the OpenAI-shaped transport. */
async function fixture(provider: Provider, replies: { calls?: Call[]; text?: string }[], onRequest?: (index: number) => void) {
  const requests: any[] = [], calls: ModelCallEvent[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const index = requests.length - 1, reply = replies[index];
      assert(reply, 'No unplanned model request.'); onRequest?.(index);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (provider === 'openai') {
        const functions = (reply.calls ?? []).map((item, i) => ({ type: 'function_call', call_id: item.callId, name: item.name, arguments: item.arguments, status: 'completed' }));
        functions.forEach((item, i) => write(response, { type: 'response.output_item.added', output_index: i + 1, item: { ...item, arguments: '', status: 'in_progress' } }));
        if (reply.text) write(response, { type: 'response.output_text.delta', delta: reply.text });
        write(response, { type: 'response.completed', response: { output: [{ type: 'reasoning', encrypted_content: 'fictional-private-reasoning' }, ...functions], usage: { input_tokens: 8, output_tokens: 3 } } });
      } else {
        write(response, { choices: [{ index: 0, delta: { reasoning: 'fictional-private-reasoning', ...(reply.text ? { content: reply.text } : {}), ...(reply.calls?.length ? { tool_calls: reply.calls.map((item, i) => ({ index: i, id: item.callId, type: 'function', function: { name: item.name, arguments: item.arguments } })) } : {}) }, finish_reason: reply.calls?.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 3 } });
      }
      response.end('data: [DONE]\n\n');
    } catch { response.destroy(new Error('Invalid fictional fixture request.')); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address === 'object');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const runtime = createProviderRuntime({ env: { PLATFORM_ALLOW_PROVIDER_CALLS: '1', OPENAI_API_KEY: 'synthetic-fixture-only', OPENAI_CHAT_MODEL: 'fictional-model', OLLAMA_CHAT_MODEL: 'fictional-model', OLLAMA_BASE_URL: endpoint + '/v1' }, fetch: (url, init) => {
    assert.equal(String(url), provider === 'openai' ? 'https://api.openai.com/v1/responses' : endpoint + '/v1/chat/completions');
    return fetch(endpoint + '/fixture', init);
  } });
  return { requests, calls, adapter: new ProviderAdapter(runtime), close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
function scope(): CapabilityScope {
  return { ownerId, turnId: 'fictional-career-turn', profile: { speaker: 'companion' }, room: { kind: 'main' }, phase: { enabledFeatures: ['P0'], enabledSpeakers: ['companion'], reviewedSkills: ['career-intake'] } };
}
const input = (provider: Provider): ChatInput => ({ provider, model: 'fictional-model', mode: 'chat', messages: [{ role: 'user', content: 'Prepare one small fictional career action.' }] });
async function collect(stream: AsyncIterable<AgentEvent>) { const result: AgentEvent[] = []; for await (const event of stream) result.push(event); return result; }
function toolResult(provider: Provider, request: any, id: string) {
  const item = (provider === 'openai' ? request.input : request.messages).find((item: any) => provider === 'openai' ? item.type === 'function_call_output' && item.call_id === id : item.role === 'tool' && item.tool_call_id === id);
  assert(item, 'The preceding call must receive its ordered result.');
  return JSON.parse(provider === 'openai' ? item.output : item.content);
}
function allowedNames(provider: Provider, request: any): string[] {
  return provider === 'openai' ? (request.tool_choice.tools ?? []).map((tool: any) => tool.name) : (request.tools ?? []).map((tool: any) => tool.function.name);
}

for (const provider of ['openai', 'ollama'] as const) {
  test(`${provider}: real loopback protocol, registry and progressive skill permit a draft only in the next step`, async () => {
    const current = scope(), saved: string[] = [];
    const registry = new CapabilityRegistry({ careerPorts: { readProfile: async read => { assert.equal(read.ownerId, ownerId); return { ownerId, id: 'fictional-profile', revision: 3, state: 'current', normalSummary: 'Fictional confirmed career preferences.', confirmed: { degree: true, graduation: true, roleFamily: true } }; } }, registrations: [
      { id: 'read_profile', reviewed: true, execute: async () => ({ revision: 3 }) },
      { id: 'save_plan_draft', reviewed: true, execute: async (_args, executionScope) => { assert.equal(executionScope.ownerId, ownerId); assert.equal(executionScope.execution.idempotencyKey, 'fictional-career-turn:next-step'); saved.push(executionScope.execution.callId); return { id: 'fictional-draft', revision: 1, status: 'draft' }; } },
    ] });
    const session = registry.session(() => current);
    const f = await fixture(provider, [
      { calls: [call('use_skill', 'load-skill', { id: 'career-intake' }), call('save_plan_draft', 'too-soon', planArgs)] },
      { calls: [call('save_plan_draft', 'next-step', planArgs)] },
      { text: 'A fictional action draft is ready for your review.' },
    ]);
    try {
      const events = await collect(runAgentLoop(f.adapter, input(provider), { turnId: current.turnId, purpose: 'companion_reply', toolDefinitions: session.toolDefinitions, resolveTools: session.resolveTools, resolveLimits: session.limitsForStep, beforeStep: session.beforeStep, executeTool: session.executeTool, drainInterjections: () => [], limits: { maxRounds: 6, maxToolCalls: 12, maxOutputTokens: 1500, timeoutMs: 5000 }, onModelCall: event => { f.calls.push(event); } }));
      assert.equal(f.requests.length, 3); assert.deepEqual(saved, ['next-step']);
      assert(!allowedNames(provider, f.requests[0]).includes('save_plan_draft'));
      assert(allowedNames(provider, f.requests[1]).includes('save_plan_draft'));
      assert.equal(toolResult(provider, f.requests[1], 'too-soon').error.code, 'TOOL_NOT_ALLOWED');
      assert.equal(toolResult(provider, f.requests[1], 'load-skill').activation, 'next_step');
      assert.equal(toolResult(provider, f.requests[2], 'next-step').status, 'draft');
      const procedures = (request: any) => (provider === 'openai' ? request.input : request.messages).filter((message: any) => message.role === 'system' && typeof message.content === 'string' && message.content.startsWith('Server-owned skill procedure'));
      assert.equal(procedures(f.requests[0]).length, 0); assert.equal(procedures(f.requests[1]).length, 1); assert.equal(procedures(f.requests[2]).length, 1);
      assert(!JSON.stringify(events).includes('fictional-private-reasoning'));
      assert(!JSON.stringify(events.filter(event => event.type === 'tool_started' || event.type === 'tool_finished')).includes('save_plan_draft'));
      const started = events.filter(event => event.type === 'tool_started').map(event => event.callId);
      const finished = events.filter(event => event.type === 'tool_finished').map(event => event.callId);
      assert.deepEqual(finished, started);
      assert.equal(f.calls.filter(event => event.type === 'started').length, 3);
      assert.deepEqual(f.calls.filter(event => event.type === 'finished').map(event => [event.status, event.usage]), Array.from({ length: 3 }, () => ['complete', { status: 'reported', inputTokens: 8, outputTokens: 3 }]));
    } finally { await f.close(); }
  });

  test(`${provider}: revocation during a real model step prevents the registered executor from reading data`, async () => {
    const current = scope(); let accessed = 0;
    const registry = new CapabilityRegistry({ registrations: [{ id: 'search_memories', reviewed: true, execute: async () => { accessed++; return {}; } }] });
    const session = registry.session(() => current);
    const f = await fixture(provider, [{ calls: [call('search_memories', 'revoked', { query: 'fictional preference' })] }, { text: 'The requested data is unavailable.' }], index => { if (index === 0) current.phase = { ...current.phase, enabledSpeakers: [] }; });
    try {
      await collect(runAgentLoop(f.adapter, input(provider), { turnId: current.turnId, purpose: 'companion_reply', toolDefinitions: session.toolDefinitions, resolveTools: session.resolveTools, resolveLimits: session.limitsForStep, beforeStep: session.beforeStep, executeTool: session.executeTool, drainInterjections: () => [], limits: { maxRounds: 3, maxToolCalls: 4, maxOutputTokens: 1500, timeoutMs: 5000 } }));
      assert.equal(accessed, 0); assert.equal(f.requests.length, 2);
      assert.equal(toolResult(provider, f.requests[1], 'revoked').error.code, 'TOOL_NOT_ALLOWED');
    } finally { await f.close(); }
  });
}

test('a prepared expert skill narrows the actual eight-round room budget to six tool steps', async () => {
  const current: CapabilityScope = { ...scope(), profile: { speaker: 'guide' }, room: { kind: 'expert_room', expert: 'guide' }, phase: { enabledFeatures: ['P0'], enabledSpeakers: ['guide'], reviewedSkills: ['evidence-story'] } };
  const registry = new CapabilityRegistry({ careerPorts: {
    readProfile: async () => ({ ownerId, id: 'fictional-profile', revision: 3, state: 'current', normalSummary: 'Fictional course preferences.', confirmed: { degree: true, graduation: true, roleFamily: true } }),
    listEvidence: async () => [{ ownerId, id: 'fictional-project', revision: 2, state: 'current', kind: 'project', normalSummary: 'Fictional course project.' }],
  }, registrations: ['read_profile', 'read_evidence', 'save_story_draft'].map(id => ({ id, reviewed: true, execute: async () => ({ found: 'fictional owned record' }) })) });
  const session = registry.session(() => current);
  const f = await fixture('openai', [{ calls: [call('use_skill', 'prepare', { id: 'evidence-story' })] }, ...Array.from({ length: 5 }, (_, i) => ({ calls: [call('read_evidence', `read-${i}`, {})] })), { text: 'The collected fictional evidence is ready; a draft remains to be written.' }]);
  try {
    await collect(runAgentLoop(f.adapter, input('openai'), { turnId: current.turnId, purpose: 'room_turn', toolDefinitions: session.toolDefinitions, resolveTools: session.resolveTools, resolveLimits: session.limitsForStep, beforeStep: session.beforeStep, executeTool: session.executeTool, drainInterjections: () => [], limits: { maxRounds: 8, maxToolCalls: 16, maxOutputTokens: 4000, timeoutMs: 5000 } }));
    assert.equal(f.requests.length, 7); assert.equal(f.requests[6].tool_choice, 'none');
    assert.deepEqual(session.limitsForStep(), { maxRounds: 6, maxToolCalls: 12 });
  } finally { await f.close(); }
});

test('registered authorization failure and forged owner arguments never cross the executor boundary', async () => {
  const current = scope(); let accessed = 0;
  const registry = new CapabilityRegistry({ registrations: [{ id: 'search_memories', reviewed: true, authorize: async () => { throw new ApiError(403, 'TOOL_NOT_ALLOWED', 'Fictional grant was revoked.'); }, execute: async () => { accessed++; return {}; } }] });
  const session = registry.session(() => current); session.beforeStep(input('openai')); session.resolveTools();
  const execution = { turnId: current.turnId, callId: 'fictional-call', idempotencyKey: `${current.turnId}:fictional-call`, effect: 'read' as const };
  await assert.rejects(session.executeTool('search_memories', { query: 'fictional', ownerId: 'different-owner' }, execution), { code: 'TOOL_ARGUMENTS_INVALID' });
  await assert.rejects(session.executeTool('search_memories', { query: 'fictional' }, execution), { code: 'TOOL_NOT_ALLOWED' });
  assert.equal(accessed, 0);
});
