import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { ChatInput, ModelCallEvent, ModelStepContext, ModelStepEvent, ModelStepResult } from '@companion/platform-contracts';
import { createProviderRuntime, ProviderAdapter, runAgentLoop } from '../src/index.ts';
const definitions = [{ name: 'lookup', description: 'Fictional lookup.', parameters: { type: 'object' } }, { name: 'draft', description: 'Fictional draft.', parameters: { type: 'object' } }];
const input = (provider: string): ChatInput => ({ provider, model: 'synthetic-model', mode: 'chat', messages: [{ role: 'user', content: 'Fictional request.' }] });
const context = (overrides: Partial<ModelStepContext> = {}): ModelStepContext => ({ invocation: {}, tools: definitions, allowedToolNames: ['lookup'], toolChoice: 'auto', limits: { maxOutputTokens: 37 }, callIndex: 1, timeoutMs: 5000, ...overrides });
function write(reply: http.ServerResponse, events: unknown[], end = true) {
  reply.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) { const bytes = Buffer.from(`data: ${JSON.stringify(event)}\r\n\r\n`); for (let offset = 0; offset < bytes.length; offset += 7) reply.write(bytes.subarray(offset, offset + 7)); }
  if (end) reply.end('data: [DONE]\r\n\r\n');
}
async function loopback(handler: (body: Record<string, any>, reply: http.ServerResponse, index: number) => Promise<void> | void, run: (runtime: ReturnType<typeof createProviderRuntime>, bodies: Record<string, any>[]) => Promise<void>) {
  const bodies: Record<string, any>[] = []; let failure: unknown;
  const server = http.createServer(async (request, reply) => { try { const pieces: Buffer[] = []; for await (const chunk of request) pieces.push(chunk); const body = JSON.parse(Buffer.concat(pieces).toString()); bodies.push(body); await handler(body, reply, bodies.length - 1); } catch (error) { failure = error; reply.destroy(); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}`;
  const runtime = createProviderRuntime({ env: { PLATFORM_ALLOW_PROVIDER_CALLS: '1', OPENAI_API_KEY: 'synthetic-only', OPENAI_CHAT_MODEL: 'synthetic-model', OLLAMA_BASE_URL: `${base}/v1`, OLLAMA_CHAT_MODEL: 'synthetic-model' }, fetch: (url, init) => { const destination = new URL(String(url)); assert(['api.openai.com', '127.0.0.1'].includes(destination.hostname)); return fetch(`${base}${destination.pathname}`, init); } });
  try { await run(runtime, bodies); if (failure) throw failure; } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
async function collect(stream: AsyncGenerator<ModelStepEvent, ModelStepResult>) { const events: ModelStepEvent[] = []; while (true) { const next = await stream.next(); if (next.done) return { events, out: next.value }; events.push(next.value); } }
const call = { type: 'function_call', call_id: 'real-fixture-call', name: 'lookup', arguments: '{"term":"fixture"}', status: 'completed' };
const complete = (output: unknown[] = []) => ({ type: 'response.completed', response: { output, usage: { input_tokens: 8, output_tokens: 3 } } });
const compatible = (delta: unknown, finish: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });
for (const provider of ['openai', 'ollama']) {
  test(`${provider}: one real HTTP step reports tool start before argument completion, executes no tool and preserves private continuation`, async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const ledger: ModelCallEvent[] = [];
    await loopback(async (body, reply, index) => {
      assert.equal(body.model, 'synthetic-model'); assert.equal(body.max_output_tokens ?? body.max_tokens, 37);
      if (!index) {
        if (provider === 'openai') { assert.deepEqual(body.tools.map((tool: any) => tool.name), ['lookup', 'draft']); assert.deepEqual(body.tool_choice, { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'lookup' }] }); write(reply, [{ type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } }], false); }
        else { assert.deepEqual(body.tools.map((tool: any) => tool.function.name), ['lookup']); write(reply, [compatible({ reasoning: 'Synthetic private reasoning.', tool_calls: [{ index: 0, id: call.call_id, function: { name: 'lookup', arguments: '{"term":' } }] })], false); }
        await gate;
        const events = provider === 'openai' ? [complete([{ type: 'reasoning', encrypted_content: 'Synthetic encrypted continuation.' }, call])]
          : [compatible({ tool_calls: [{ index: 0, function: { arguments: '"fixture"}' } }] }, 'tool_calls'), { choices: [], usage: { prompt_tokens: 8, completion_tokens: 3 } }];
        reply.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
      } else {
        if (provider === 'openai') { assert(body.input.some((item: any) => item.encrypted_content === 'Synthetic encrypted continuation.')); assert.equal(body.input.at(-2).output, '{"found":true}'); assert.equal(body.input.at(-1).content, 'Fictional interjection.'); }
        else { assert.equal(body.messages.find((message: any) => message.role === 'assistant').reasoning, 'Synthetic private reasoning.'); assert.equal(body.messages.at(-2).content, '{"found":true}'); assert.equal(body.messages.at(-1).content, 'Fictional interjection.'); }
        write(reply, provider === 'openai' ? [{ type: 'response.output_text.delta', delta: 'Visible answer.' }, complete()] : [compatible({ content: 'Visible answer.' }, 'stop'), { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } }]);
      }
    }, async (runtime, bodies) => {
      const invocation = {}, ctx = context({ invocation, onModelCall: event => { ledger.push(event); } }); const stream = runtime.streamModelStep!(input(provider), ctx);
      try { const first = await stream.next(); assert.deepEqual(first.value, { type: 'tool_started', index: 0, callId: call.call_id, name: 'lookup' }); assert.equal(bodies.length, 1); assert.deepEqual(ledger.map(event => event.type), ['started']); release();
        const result = await collect(stream); assert.equal(result.out.calls.length, 1); assert.equal(result.out.calls[0].arguments, '{"term":"fixture"}'); assert.equal(bodies.length, 1); assert.equal(JSON.stringify(result.out).includes('Synthetic'), false);
        const nextInput = { ...input(provider), messages: [...input(provider).messages, { role: 'user' as const, content: 'Fictional interjection.' }] };
        const final = await collect(runtime.streamModelStep!(nextInput, context({ invocation, callIndex: 2, continuation: result.out.continuation, toolResults: [{ callId: call.call_id, result: { found: true } }], onModelCall: event => { ledger.push(event); } })));
        assert.equal(final.out.text, 'Visible answer.'); assert.equal(bodies.length, 2); assert(!JSON.stringify([...result.events, ...final.events, ...ledger]).includes('Synthetic private'));
        await assert.rejects(collect(runtime.streamModelStep!(nextInput, context({ invocation, continuation: result.out.continuation, toolResults: [{ callId: call.call_id, result: {} }] }))), { code: 'INVALID_PROVIDER_INPUT' });
      } finally { release(); await stream.return(undefined as never); }
    });
  });
}
test('new step rejects client model override before HTTP; legacy model override remains compatible', async () => {
  let requests = 0; const runtime = createProviderRuntime({ env: { PLATFORM_ALLOW_PROVIDER_CALLS: '1', OPENAI_API_KEY: 'synthetic-only', OPENAI_CHAT_MODEL: 'synthetic-model' }, fetch: async () => { requests++; return new Response('data: {"type":"response.output_text.delta","delta":"Visible."}\n\ndata: {"type":"response.completed","response":{"output":[]}}\n\n'); } });
  assert.throws(() => runtime.streamModelStep!({ ...input('openai'), model: 'forged' }, context()), { code: 'INVALID_PROVIDER_INPUT' }); assert.equal(requests, 0);
  for await (const _event of runtime.streamChat({ ...input('openai'), model: 'legacy-override' })) { /* Legacy remains explicit. */ } assert.equal(requests, 1);
});
test('provider remains closed even with valid step and synthetic key, no fallback or HTTP', () => {
  let requests = 0; const runtime = createProviderRuntime({ env: { OPENAI_API_KEY: 'synthetic-only', OPENAI_CHAT_MODEL: 'synthetic-model' }, fetch: async () => { requests++; throw new Error('Must remain closed.'); } });
  assert.throws(() => runtime.streamModelStep!(input('openai'), context()), { code: 'PROVIDER_NOT_CONFIGURED' }); assert.equal(requests, 0);
});
test('Responses output budget reports its actual usage before raising new output-limit code', async () => {
  await loopback((_body, reply) => write(reply, [{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 5, output_tokens: 37 } } }]), async runtime => {
    const ledger: ModelCallEvent[] = []; await assert.rejects(collect(runtime.streamModelStep!(input('openai'), context({ onModelCall: event => { ledger.push(event); } }))), { code: 'PROVIDER_OUTPUT_LIMIT' });
    assert.equal(ledger.length, 2); assert(ledger[1].type === 'finished'); assert.equal(ledger[1].status, 'failed'); assert.deepEqual(ledger[1].usage, { status: 'reported', inputTokens: 5, outputTokens: 37 });
  });
});
test('first visible-token timeout aborts actual loopback stream with honest interrupted/missing usage', async () => {
  await loopback((_body, reply) => write(reply, [compatible({ reasoning: 'Only private context.' })], false), async runtime => {
    const ledger: ModelCallEvent[] = []; await assert.rejects(collect(runtime.streamModelStep!(input('ollama'), context({ timeoutMs: 1000, firstTokenTimeoutMs: 30, onModelCall: event => { ledger.push(event); } }))));
    assert.equal(ledger.length, 2); assert(ledger[1].type === 'finished'); assert.equal(ledger[1].status, 'interrupted'); assert.deepEqual(ledger[1].usage, { status: 'missing' });
  });
});

test('opaque continuation is bound to runtime/invocation and atomically claimed, failure releases it for one retry', async () => {
  let unblock!: () => void, resumed!: () => void; const blocked = new Promise<void>(resolve => { unblock = resolve; }), arrived = new Promise<void>(resolve => { resumed = resolve; });
  await loopback(async (_body, reply, index) => {
    if (!index) write(reply, [complete([call])]);
    else if (index === 1) { resumed(); await blocked; write(reply, [{ type: 'response.created' }]); }
    else write(reply, [{ type: 'response.output_text.delta', delta: 'Visible retry.' }, complete()]);
  }, async (runtime, bodies) => {
    const invocation = {}, first = await collect(runtime.streamModelStep!(input('openai'), context({ invocation })));
    const ctx = context({ invocation, continuation: first.out.continuation, toolResults: [{ callId: call.call_id, result: { found: true } }] });
    await assert.rejects(collect(runtime.streamModelStep!(input('openai'), { ...ctx, invocation: {} })), { code: 'INVALID_PROVIDER_INPUT' }); assert.equal(bodies.length, 1);
    const foreign = createProviderRuntime({ env: { PLATFORM_ALLOW_PROVIDER_CALLS: '1', OPENAI_API_KEY: 'synthetic-only', OPENAI_CHAT_MODEL: 'synthetic-model' }, fetch: async () => { throw new Error('No cross-runtime request.'); } });
    await assert.rejects(collect(foreign.streamModelStep!(input('openai'), ctx)), { code: 'INVALID_PROVIDER_INPUT' });
    first.out.calls[0].callId = 'caller-mutated';
    await assert.rejects(collect(runtime.streamModelStep!(input('openai'), { ...ctx, toolResults: [{ callId: 'caller-mutated', result: {} }] })), { code: 'INVALID_PROVIDER_INPUT' });
    const pending = assert.rejects(collect(runtime.streamModelStep!(input('openai'), ctx)), { code: 'PROVIDER_STREAM_INTERRUPTED' }); await arrived;
    try { await assert.rejects(collect(runtime.streamModelStep!(input('openai'), ctx)), { code: 'INVALID_PROVIDER_INPUT' }); assert.equal(bodies.length, 2); } finally { unblock(); }
    await pending;
    const retried = await collect(runtime.streamModelStep!(input('openai'), ctx)); assert.equal(retried.out.text, 'Visible retry.'); assert.equal(bodies.length, 3);
    await assert.rejects(collect(runtime.streamModelStep!(input('openai'), ctx)), { code: 'INVALID_PROVIDER_INPUT' });
  });
});

for (const provider of ['openai', 'ollama']) test(`${provider}: shared loop retries a later interrupted step without repeating the saved draft or losing private protocol context`, async () => {
  const ledger: ModelCallEvent[] = []; let savedDrafts = 0;
  await loopback((body, reply, index) => {
    if (!index) write(reply, provider === 'openai' ? [
      { type: 'response.output_item.added', output_index: 1, item: { ...call, name: 'draft', arguments: '' } },
      complete([{ type: 'reasoning', encrypted_content: 'Fictional encrypted context.' }, { ...call, name: 'draft', arguments: '{}' }]),
    ] : [compatible({ reasoning: 'Fictional private context.', tool_calls: [{ index: 0, id: call.call_id, function: { name: 'draft', arguments: '{}' } }] }, 'tool_calls'), { choices: [], usage: { prompt_tokens: 8, completion_tokens: 3 } }]);
    else if (index === 1) write(reply, provider === 'openai' ? [{ type: 'response.created' }] : [{ choices: [], usage: { prompt_tokens: 9, completion_tokens: 0 } }]);
    else {
      if (provider === 'openai') assert(body.input.some((item: any) => item.encrypted_content === 'Fictional encrypted context.'));
      else assert.equal(body.messages.find((message: any) => message.role === 'assistant').reasoning, 'Fictional private context.');
      write(reply, provider === 'openai' ? [{ type: 'response.output_text.delta', delta: 'Draft already saved.' }, complete()] : [compatible({ content: 'Draft already saved.' }, 'stop'), { choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } }]);
    }
  }, async (runtime, bodies) => {
    const draft = { ...definitions[1], effect: 'draft' as const, progressPhrase: '正在整理虚构草稿…', endsTurn: false }, events = [];
    for await (const event of runAgentLoop(new ProviderAdapter(runtime), input(provider), {
      turnId: 'fictional-internal-turn', purpose: 'companion', limits: { maxRounds: 6, maxToolCalls: 12, maxOutputTokens: 37, timeoutMs: 5000 }, toolDefinitions: [draft], resolveTools: () => [draft],
      executeTool: async () => { savedDrafts++; return { draftId: 'fictional-saved-draft' }; }, drainInterjections: () => [], onModelCall: event => { ledger.push(event); },
    })) events.push(event);
    assert.equal(savedDrafts, 1); assert.equal(bodies.length, 3); assert.deepEqual(bodies[1], bodies[2]);
    assert.deepEqual(ledger.filter(event => event.type === 'started').map(event => [event.index, event.purpose]), [[1, 'companion'], [2, 'companion'], [3, 'companion']]);
    assert.deepEqual(ledger.filter(event => event.type === 'finished').map(event => event.status), ['complete', 'interrupted', 'complete']);
    assert(!JSON.stringify(events).includes('Fictional private')); assert(!JSON.stringify(events).includes('Fictional encrypted')); assert(!JSON.stringify(events).includes('fictional-saved-draft'));
    const progress = events.filter(event => event.type === 'tool_started' || event.type === 'tool_finished'); assert.deepEqual(progress.map(event => event.callId), [call.call_id, call.call_id]);
  });
});

test('explicit step cancellation differs from internal timeout and reports real received usage', async () => {
  await loopback((_body, reply) => write(reply, [{ ...compatible({ content: 'Visible partial.' }), usage: { prompt_tokens: 4, completion_tokens: 1 } }], false), async runtime => {
    const abort = new AbortController(), ledger: ModelCallEvent[] = [], stream = runtime.streamModelStep!(input('ollama'), context({ signal: abort.signal, onModelCall: event => { ledger.push(event); } }));
    const first = await stream.next(); assert(!first.done); assert.equal(first.value.type, 'delta'); abort.abort(); await assert.rejects(stream.next());
    assert(ledger[1].type === 'finished'); assert.equal(ledger[1].status, 'cancelled'); assert.deepEqual(ledger[1].usage, { status: 'reported', inputTokens: 4, outputTokens: 1 });
  });
});

test('legacy tool-event consumer cannot rewrite the already-serialized result replay', async () => {
  await loopback((_body, reply, index) => write(reply, !index ? [complete([call])] : [{ type: 'response.output_text.delta', delta: 'Visible.' }, complete()]), async (runtime, bodies) => {
    for await (const event of runtime.streamChat({ ...input('openai'), mode: 'agent' }, { tools: definitions, executeTool: async () => ({ saved: 'original' }) })) {
      if (event.type === 'tool' && event.result && typeof event.result === 'object') Object.assign(event.result, { saved: 'consumer-change' });
    }
    assert.equal(bodies[1].input.at(-1).output, '{"saved":"original"}');
  });
});
