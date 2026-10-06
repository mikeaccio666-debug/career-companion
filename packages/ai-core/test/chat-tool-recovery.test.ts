import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatContext, ChatStreamEvent, ModelCallEvent } from '@companion/platform-contracts';
import { createProviderRuntime, ProviderError } from '../src/index.ts';

type Provider = 'openai' | 'ollama';
const tool = { name: 'lookup', description: 'Read fictional fixture data.', parameters: { type: 'object', properties: { term: { type: 'string' } }, required: ['term'] } };
const input = (provider: Provider) => ({ provider, mode: 'agent' as const, messages: [{ role: 'user' as const, content: 'Read fictional data.' }] });
const call = (provider: Provider, args: string, name = 'lookup', id = 'fictional-call', index = 0) => provider === 'openai'
  ? { type: 'function_call', name, call_id: id, arguments: args }
  : { index, id, type: 'function', function: { name, arguments: args } };
function reply(provider: Provider, options: { calls?: unknown[]; text?: string; reasoning?: string } = {}) {
  return provider === 'openai'
    ? [...(options.text === undefined ? [] : [{ type: 'response.output_text.delta', delta: options.text }]), { type: 'response.completed', response: { output: [...(options.reasoning ? [{ type: 'reasoning', encrypted_content: options.reasoning }] : []), ...(options.calls ?? [])], usage: { input_tokens: 8, output_tokens: 3 } } }]
    : [{ choices: [{ index: 0, delta: { ...(options.text === undefined ? {} : { content: options.text }), ...(options.reasoning ? { reasoning: options.reasoning } : {}), ...(options.calls ? { tool_calls: options.calls } : {}) }, finish_reason: options.calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 3 } }];
}
function fixture(provider: Provider, replies: unknown[][]) {
  const requests: any[] = [], calls: ModelCallEvent[] = [];
  const runtime = createProviderRuntime({ env: { PLATFORM_ALLOW_PROVIDER_CALLS: '1', OPENAI_API_KEY: 'synthetic-only', OPENAI_CHAT_MODEL: 'fictional-model', OLLAMA_BASE_URL: 'http://127.0.0.1:11434/v1', OLLAMA_CHAT_MODEL: 'fictional-model' }, fetch: async (url, init) => {
    assert.equal(String(url), provider === 'openai' ? 'https://api.openai.com/v1/responses' : 'http://127.0.0.1:11434/v1/chat/completions');
    requests.push(JSON.parse(String(init?.body))); assert(requests.length <= replies.length, 'No unplanned fixture request.');
    const bytes = new TextEncoder().encode(replies[requests.length - 1]!.map(event => 'data: ' + JSON.stringify(event) + '\r\n\r\n').join('') + 'data: [DONE]\r\n\r\n');
    return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 37) controller.enqueue(bytes.subarray(i, i + 37)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const stream = (ctx: ChatContext = {}) => runtime.streamChat(input(provider), { tools: [tool], onModelCall: event => { calls.push(event); }, ...ctx });
  return { requests, calls, stream };
}
async function collect(source: AsyncIterable<ChatStreamEvent>, events: ChatStreamEvent[] = []) { for await (const event of source) events.push(event); return events; }
const finishes = (calls: ModelCallEvent[]) => calls.filter(call => call.type === 'finished');
function toolResult(provider: Provider, request: any) { const item = (provider === 'openai' ? request.input : request.messages).at(-1); return { id: provider === 'openai' ? item.call_id : item.tool_call_id, value: JSON.parse(provider === 'openai' ? item.output : item.content) }; }

test('Responses: explicitly unfinished function calls never execute or receive syntax correction despite completed response', async () => {
  for (const status of ['incomplete', 'in_progress']) for (const args of ['{"term":"fictional-private-marker"}', '{"term":"fictional-private-marker"']) {
    const f = fixture('openai', [reply('openai', { calls: [{ ...call('openai', args), status }] })]), events: ChatStreamEvent[] = []; let executed = 0;
    await assert.rejects(collect(f.stream({ executeTool: async () => { executed++; return {}; } }), events), { code: 'INCOMPLETE_TOOL_CALL' });
    assert.equal(executed, 0); assert.equal(f.requests.length, 1); assert(!events.some(event => event.type === 'tool')); assert(!JSON.stringify(events).includes('fictional-private-marker'));
    assert.equal(finishes(f.calls)[0].status, 'complete'); assert.deepEqual(finishes(f.calls)[0].usage, { status: 'reported', inputTokens: 8, outputTokens: 3 });
  }
});
test('Responses: explicitly completed function calls execute normally and preserve completion status in replay', async () => {
  const f = fixture('openai', [reply('openai', { calls: [{ ...call('openai', '{"term":"fictional"}'), status: 'completed' }] }), reply('openai', { text: 'Visible fixture answer.' })]); let executed = 0;
  const events = await collect(f.stream({ executeTool: async (_name, args) => { assert.deepEqual(args, { term: 'fictional' }); executed++; return { found: true }; } }));
  assert.equal(executed, 1); assert.equal(f.requests.length, 2); assert.equal(f.requests[1].input.at(-2).status, 'completed');
  assert.deepEqual(events.filter(event => event.type === 'delta'), [{ type: 'delta', text: 'Visible fixture answer.' }]);
});

for (const provider of ['openai', 'ollama'] as const) {
  test(`${provider}: malformed JSON receives a bounded correction result, then valid arguments execute once and produce text`, async () => {
    const invalid = '{"term":"fictional-private-marker"';
    const f = fixture(provider, [reply(provider, { calls: [call(provider, invalid, 'lookup', 'bad')] }), reply(provider, { calls: [call(provider, '{"term":"fixed"}', 'lookup', 'fixed')] }), reply(provider, { text: 'Visible fixture answer.' })]);
    const executed: unknown[] = [], events = await collect(f.stream({ executeTool: async (_name, args) => { executed.push(args); return { found: true }; } }));
    assert.deepEqual(executed, [{ term: 'fixed' }]); assert.equal(f.requests.length, 3);
    const correction = toolResult(provider, f.requests[1]); assert.equal(correction.id, 'bad'); assert.equal(correction.value.error.code, 'INVALID_TOOL_ARGUMENTS');
    assert.match(correction.value.error.message, /no tool was executed/); assert(Buffer.byteLength(JSON.stringify(correction.value)) < 512);
    const badEvents = events.filter(event => event.type === 'tool' && event.callId === 'bad'); assert.equal(badEvents.length, 1);
    assert.deepEqual((badEvents[0] as any).input, {}); assert(!JSON.stringify(events).includes('fictional-private-marker'));
    assert.deepEqual(events.filter(event => event.type === 'delta'), [{ type: 'delta', text: 'Visible fixture answer.' }]);
    assert.deepEqual(finishes(f.calls).map(call => [call.status, call.usage]), Array.from({ length: 3 }, () => ['complete', { status: 'reported', inputTokens: 8, outputTokens: 3 }]));
  });
  test(`${provider}: arrays, scalar JSON and prose are correction errors without extracting or executing input`, async () => {
    for (const args of ['[{"term":"fictional"}]', 'null', 'true', '"fictional"', '42', 'Use this JSON: {"term":"fictional"}', '[' + ' '.repeat(63_999)]) {
      const f = fixture(provider, [reply(provider, { calls: [call(provider, args)] }), reply(provider, { text: 'Cannot use that input.' })]); let executed = 0;
      await collect(f.stream({ executeTool: async () => { executed++; return {}; } })); assert.equal(executed, 0);
      assert.equal(toolResult(provider, f.requests[1]).value.error.code, 'INVALID_TOOL_ARGUMENTS');
    }
  });
  test(`${provider}: unknown tools, missing call identities and oversized arguments remain terminal without execution`, async () => {
    for (const [name, id, args, code] of [['unregistered', 'id', '{', 'TOOL_NOT_ALLOWED'], ['lookup', '', '{}', 'INVALID_PROVIDER_INPUT'], ['', 'id', '{}', 'INVALID_PROVIDER_INPUT'], ['lookup', 'id', 'x'.repeat(64_001), 'INVALID_PROVIDER_INPUT']]) {
      const f = fixture(provider, [reply(provider, { calls: [call(provider, args!, name!, id!)] })]); let executed = 0;
      await assert.rejects(collect(f.stream({ executeTool: async () => { executed++; return {}; } })), { code }); assert.equal(executed, 0); assert.equal(f.requests.length, 1);
      assert.equal(finishes(f.calls).length, 1); assert.deepEqual(finishes(f.calls)[0].usage, { status: 'reported', inputTokens: 8, outputTokens: 3 });
    }
  });
  test(`${provider}: permission failures are not converted into correction results`, async () => {
    const denied = new ProviderError('TOOL_NOT_ALLOWED', 'Fictional permission denied.', 403), f = fixture(provider, [reply(provider, { calls: [call(provider, '{}')] })]); let executed = 0;
    await assert.rejects(collect(f.stream({ executeTool: async () => { executed++; throw denied; } })), error => error === denied);
    assert.equal(executed, 1); assert.equal(f.requests.length, 1); assert.equal(finishes(f.calls)[0].status, 'complete');
  });
  test(`${provider}: cancellation after a correction result cannot execute or start another provider turn`, async () => {
    const f = fixture(provider, [reply(provider, { calls: [call(provider, '[')] })]), abort = new AbortController(); let executed = 0;
    await assert.rejects((async () => { for await (const event of f.stream({ signal: abort.signal, executeTool: async () => { executed++; return {}; } })) if (event.type === 'tool') abort.abort(); })(), { name: 'AbortError' });
    assert.equal(executed, 0); assert.equal(f.requests.length, 1); assert.equal(finishes(f.calls)[0].status, 'complete');
  });
  test(`${provider}: cancellation before argument processing or after a valid tool announcement prevents execution`, async () => {
    for (const [args, abortOn] of [['[', 'usage'], ['{}', 'tool']]) {
      const f = fixture(provider, [reply(provider, { calls: [call(provider, args!)] })]), abort = new AbortController(); let executed = 0;
      const events: ChatStreamEvent[] = [];
      await assert.rejects((async () => { for await (const event of f.stream({ signal: abort.signal, executeTool: async () => { executed++; return {}; } })) { events.push(event); if (event.type === abortOn) abort.abort(); } })(), { name: 'AbortError' });
      assert.equal(executed, 0); assert.equal(f.requests.length, 1); assert(!events.some(event => event.type === 'tool' && event.result !== undefined));
      assert.equal(finishes(f.calls)[0].status, 'complete');
    }
  });
  test(`${provider}: empty, whitespace or reasoning-only completed calls fail publicly while retaining real usage`, async () => {
    for (const options of [{}, { text: ' \n\t' }, { reasoning: 'Synthetic private reasoning, never a visible answer.' }]) {
      const f = fixture(provider, [reply(provider, options)]), events: ChatStreamEvent[] = [];
      await assert.rejects(collect(f.stream(), events), (error: unknown) => error instanceof ProviderError && error.code === 'EMPTY_PROVIDER_RESPONSE' && !error.message.includes('Synthetic'));
      assert(!JSON.stringify(events).includes('Synthetic private reasoning')); assert.equal(f.requests.length, 1); assert.equal(finishes(f.calls)[0].status, 'failed');
      assert.deepEqual(finishes(f.calls)[0].usage, { status: 'reported', inputTokens: 8, outputTokens: 3 });
    }
  });
  test(`${provider}: final empty output after a saved tool result fails without replaying or undoing that result`, async () => {
    const f = fixture(provider, [reply(provider, { text: ' ', calls: [call(provider, '{}')] }), reply(provider)]); let saved = 0;
    await assert.rejects(collect(f.stream({ executeTool: async () => { saved++; return { proposal: { planId: 'fictional-saved-draft', status: 'draft' } }; } })), { code: 'EMPTY_PROVIDER_RESPONSE' });
    assert.equal(saved, 1); assert.equal(f.requests.length, 2); assert.equal(toolResult(provider, f.requests[1]).value.proposal.planId, 'fictional-saved-draft');
    assert.deepEqual(finishes(f.calls).map(call => call.status), ['complete', 'failed']);
  });
  test(`${provider}: backend safe error envelopes continue naturally without runtime retrying a tool`, async () => {
    const f = fixture(provider, [reply(provider, { calls: [call(provider, '{"term":"missing"}')] }), reply(provider, { text: 'Please correct the missing source.' })]); let executed = 0;
    await collect(f.stream({ executeTool: async () => { executed++; return { error: { code: 'INVALID_INPUT', message: 'Fictional missing field.' } }; } }));
    assert.equal(executed, 1); assert.equal(f.requests.length, 2); assert.equal(toolResult(provider, f.requests[1]).value.error.code, 'INVALID_INPUT');
  });
  test(`${provider}: syntax correction attempts consume the existing six-turn and sixteen-call limits`, async () => {
    const turns = fixture(provider, Array.from({ length: 6 }, () => reply(provider, { calls: [call(provider, '[')] }))); let executed = 0;
    await assert.rejects(collect(turns.stream({ executeTool: async () => { executed++; return {}; } })), { code: 'AGENT_TURN_LIMIT' }); assert.equal(turns.requests.length, 6);
    const batch = fixture(provider, [reply(provider, { calls: Array.from({ length: 17 }, (_, i) => call(provider, '[', 'lookup', 'call-' + i, i)) })]), events: ChatStreamEvent[] = [];
    await assert.rejects(collect(batch.stream({ executeTool: async () => { executed++; return {}; } }), events), { code: 'TOOL_LIMIT' });
    assert.equal(events.filter(event => event.type === 'tool').length, 16); assert.equal(executed, 0); assert.equal(batch.requests.length, 1);
  });
}
