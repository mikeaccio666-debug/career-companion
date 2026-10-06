import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { ChatContext, ChatInput, ChatStreamEvent } from '@companion/platform-contracts';
import { createProviderRuntime, ProviderError } from '../src/index.ts';

const turnLimit = 256 * 1024, streamLimit = 512 * 1024;
const input: ChatInput = { provider: 'ollama', mode: 'agent', messages: [{ role: 'user', content: 'Read fictional data with the provided tool.' }] };
const tool = { name: 'lookup', description: 'Read fictional fixture data.', parameters: { type: 'object', properties: { term: { type: 'string' } }, required: ['term'], additionalProperties: false } };
const chunk = (delta: Record<string, unknown>, finish: string | null = null, index = 0) => ({ choices: [{ index, delta, finish_reason: finish }] });
const call = (id: string, term: string, index = 0) => ({ index, id, type: 'function', function: { name: 'lookup', arguments: JSON.stringify({ term }) } });
const encoded = (events: unknown[]) => Buffer.from(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n');
function response(events: unknown[], packetBytes = 16384) {
  const bytes = encoded(events);
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += packetBytes) controller.enqueue(bytes.subarray(i, i + packetBytes));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
function fixture(replies: unknown[][], provider = 'ollama', packetBytes = 16384) {
  const bodies: any[] = [], urls: string[] = [];
  const runtime = createProviderRuntime({ env: { OLLAMA_BASE_URL: 'http://127.0.0.1:11434/v1', OLLAMA_CHAT_MODEL: 'synthetic-fixture', PLATFORM_ALLOW_PROVIDER_CALLS: '1', OPENROUTER_API_KEY: 'fictional-only', OPENROUTER_CHAT_MODEL: 'synthetic-fixture', ARK_API_KEY: 'fictional-only', ARK_CHAT_MODEL: 'synthetic-fixture' }, fetch: (async (url, init) => {
    urls.push(String(url)); bodies.push(JSON.parse(String(init?.body)));
    assert(bodies.length <= replies.length, 'The fixture must not make an unexpected request.');
    return response(replies[bodies.length - 1]!, packetBytes);
  }) as typeof fetch });
  return { runtime, bodies, urls, input: { ...input, provider } };
}
async function collect(stream: AsyncIterable<ChatStreamEvent>) { const result: ChatStreamEvent[] = []; for await (const item of stream) result.push(item); return result; }
function context(executions: { name: string; args: Record<string, unknown> }[]): ChatContext { return { tools: [tool], executeTool: async (name, args) => { executions.push({ name, args }); return { found: args.term }; } }; }
const limitError = (error: unknown) => error instanceof ProviderError && error.code === 'PROVIDER_REASONING_LIMIT' && error.status === 413 && !error.message.includes('🌱');

test('split UTF-8 reasoning and split tool arguments are replayed for multiple tools and turns, never exposed as events', async () => {
  const first = 'Synthetic private 中文🌱 context.', second = 'Synthetic second context.';
  const f = fixture([
    [chunk({ role: 'assistant', content: '', reasoning: 'Synthetic private 中' }), chunk({ reasoning: '文🌱 context.' }),
      chunk({ tool_calls: [{ index: 0, id: 'one', function: { name: 'look', arguments: '{"term":' } }, call('two', 'second', 1)] }),
      chunk({ tool_calls: [{ index: 0, function: { name: 'up', arguments: '"first"}' } }] }, 'tool_calls')],
    [chunk({ reasoning: second, content: '', tool_calls: [call('three', 'third')] }, 'tool_calls')],
    [chunk({ reasoning: 'Synthetic final internal context.', content: '' }), chunk({ content: 'Visible answer.' }, 'stop')],
  ], 'ollama', 1);
  const executions: { name: string; args: Record<string, unknown> }[] = [];
  const events = await collect(f.runtime.streamChat(f.input, context(executions)));
  assert.deepEqual(executions, ['first', 'second', 'third'].map(term => ({ name: 'lookup', args: { term } })));
  const assistant = (body: any) => body.messages.filter((message: any) => message.role === 'assistant');
  assert.equal(assistant(f.bodies[1])[0].reasoning, first); assert.equal(assistant(f.bodies[1])[0].content, null);
  assert.equal(assistant(f.bodies[1])[0].tool_calls.length, 2); assert.equal(f.bodies[1].messages.filter((message: any) => message.role === 'tool').length, 2);
  assert.deepEqual(assistant(f.bodies[2]).map((message: any) => message.reasoning), [first, second]);
  assert.equal(f.bodies[2].messages.at(-1).tool_call_id, 'three');
  assert.deepEqual(events.filter(event => event.type === 'delta'), [{ type: 'delta', text: 'Visible answer.' }]);
  assert(!JSON.stringify(events).includes(first)); assert(!JSON.stringify(events).includes(second));
  assert.deepEqual(f.input.messages, input.messages); assert(!JSON.stringify(f.input).includes('reasoning'));
});

test('real localhost HTTP compatible transport replays only its private reasoning to the next tool request', async () => {
  const bodies: any[] = [], privateText = 'Synthetic localhost reasoning 中文🌱.';
  const server = http.createServer(async (request, reply) => {
    const bytes: Buffer[] = []; for await (const part of request) bytes.push(part); bodies.push(JSON.parse(Buffer.concat(bytes).toString()));
    reply.writeHead(200, { 'content-type': 'text/event-stream' });
    const output = encoded(bodies.length === 1 ? [chunk({ content: '', reasoning: privateText, tool_calls: [call('local', 'fixture')] }, 'tool_calls')] : [chunk({ content: 'Actual localhost fixture response.' }, 'stop')]);
    for (let i = 0; i < output.length; i += 3) reply.write(output.subarray(i, i + 3)); reply.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  try {
    const runtime = createProviderRuntime({ env: { OLLAMA_BASE_URL: `http://127.0.0.1:${port}/v1`, OLLAMA_CHAT_MODEL: 'synthetic-fixture' } });
    const executions: { name: string; args: Record<string, unknown> }[] = [], events = await collect(runtime.streamChat(input, context(executions)));
    assert.equal(bodies.length, 2); assert.equal(bodies[1].messages.find((message: any) => message.role === 'assistant').reasoning, privateText);
    assert.equal(executions.length, 1); assert.deepEqual(events.filter(event => event.type === 'delta'), [{ type: 'delta', text: 'Actual localhost fixture response.' }]);
    assert(!JSON.stringify(events).includes(privateText));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('no-tool replies keep reasoning private and omit empty or non-string content deltas', async () => {
  const f = fixture([[chunk({ reasoning: 'Synthetic private context.', content: '' }), chunk({ content: null }), chunk({ content: 1 }), chunk({ content: 'Visible.' }), chunk({}, 'stop')]]);
  const events = await collect(f.runtime.streamChat({ ...f.input, mode: 'chat' }));
  assert.deepEqual(events, [{ type: 'delta', text: 'Visible.' }]); assert.equal(f.bodies.length, 1);
  assert(!JSON.stringify(f.bodies[0]).includes('Synthetic private context.'));
});

for (const provider of ['ark', 'openrouter']) test(`${provider} does not interpret or replay Ollama reasoning fields`, async () => {
  const f = fixture([[chunk({ reasoning: 'x'.repeat(turnLimit + 1), reasoning_content: 'Synthetic unsupported field.', tool_calls: [call('foreign', 'fixture')] }, 'tool_calls')], [chunk({ content: 'Visible.' }, 'stop')]], provider);
  const executions: { name: string; args: Record<string, unknown> }[] = [], events = await collect(f.runtime.streamChat(f.input, context(executions)));
  assert.equal(executions.length, 1); const assistant = f.bodies[1].messages.find((message: any) => message.role === 'assistant');
  assert.equal(assistant.reasoning, undefined); assert.equal(assistant.reasoning_content, undefined);
  assert.deepEqual(events.filter(event => event.type === 'delta'), [{ type: 'delta', text: 'Visible.' }]);
});

test('UTF-8 byte limits reject a multi-byte turn before any collected tool can execute', async () => {
  const f = fixture([[chunk({ tool_calls: [call('blocked', 'not-executed')] }), chunk({ reasoning: '🌱'.repeat(turnLimit / 4) }), chunk({ reasoning: '🌱' }, 'tool_calls')]]);
  const executions: { name: string; args: Record<string, unknown> }[] = [], exposed: ChatStreamEvent[] = [];
  await assert.rejects((async () => { for await (const event of f.runtime.streamChat(f.input, context(executions))) exposed.push(event); })(), limitError);
  assert.equal(executions.length, 0); assert.deepEqual(exposed, []); assert.equal(f.bodies.length, 1);
});

test('exact UTF-8 byte limits are inclusive and split surrogate fragments are counted as the accumulated string', async () => {
  const prefix = 'x'.repeat(turnLimit - 4), f = fixture([
    [chunk({ reasoning: prefix }), chunk({ reasoning: '\ud83c' }), chunk({ reasoning: '\udf31', tool_calls: [call('boundary', 'fixture')] }, 'tool_calls')],
    [chunk({ content: 'Visible.' }, 'stop')],
  ]);
  const executions: { name: string; args: Record<string, unknown> }[] = [], events = await collect(f.runtime.streamChat(f.input, context(executions)));
  const replay = f.bodies[1].messages.find((message: any) => message.role === 'assistant').reasoning;
  assert.equal(Buffer.byteLength(replay), turnLimit); assert.equal(replay, prefix + '🌱'); assert.equal(executions.length, 1);
  assert.deepEqual(events.filter(event => event.type === 'delta'), [{ type: 'delta', text: 'Visible.' }]);
});

test('the stream-wide byte budget stops new tools on the overflowing turn without truncating saved context', async () => {
  const text = '🌱'.repeat(turnLimit / 4), f = fixture([
    [chunk({ reasoning: text, tool_calls: [call('one', 'first')] }, 'tool_calls')],
    [chunk({ reasoning: text, tool_calls: [call('two', 'second')] }, 'tool_calls')],
    [chunk({ tool_calls: [call('blocked', 'third')] }), chunk({ reasoning: 'x' }, 'tool_calls')],
  ]);
  const executions: { name: string; args: Record<string, unknown> }[] = [], events: ChatStreamEvent[] = [];
  await assert.rejects((async () => { for await (const event of f.runtime.streamChat(f.input, context(executions))) events.push(event); })(), limitError);
  assert.deepEqual(executions.map(item => item.args.term), ['first', 'second']); assert(!JSON.stringify(events).includes('blocked'));
  assert.equal(f.bodies.length, 3); const replay = f.bodies[2].messages.filter((message: any) => message.role === 'assistant');
  assert.equal(replay.reduce((size: number, message: any) => size + Buffer.byteLength(message.reasoning), 0), streamLimit);
});

test('new stream invocations never inherit prior reasoning or its byte budget', async () => {
  const text = 'x'.repeat(turnLimit), f = fixture([
    [chunk({ reasoning: text, tool_calls: [call('one', 'first')] }, 'tool_calls')],
    [chunk({ reasoning: text, tool_calls: [call('two', 'second')] }, 'tool_calls')],
    [chunk({ content: 'First.' }, 'stop')],
    [chunk({ reasoning: text, content: 'Second.' }, 'stop')],
  ]);
  const executions: { name: string; args: Record<string, unknown> }[] = [];
  await collect(f.runtime.streamChat(f.input, context(executions)));
  const second = await collect(f.runtime.streamChat({ ...f.input, mode: 'chat' }));
  assert.deepEqual(second, [{ type: 'delta', text: 'Second.' }]); assert(!f.bodies[3].messages.some((message: any) => Object.hasOwn(message, 'reasoning')));
});

test('non-string official reasoning fails safely before tools; unrelated fields and empty strings are not replayed', async () => {
  for (const value of [null, 1, true, [], { private: 'Synthetic invalid context.' }]) {
    const f = fixture([[chunk({ reasoning: value, tool_calls: [call('blocked', 'fixture')] }, 'tool_calls')]]), executions: { name: string; args: Record<string, unknown> }[] = [];
    await assert.rejects(collect(f.runtime.streamChat(f.input, context(executions))), (error: unknown) => error instanceof ProviderError && error.code === 'INVALID_PROVIDER_RESPONSE' && !error.message.includes('Synthetic'));
    assert.equal(executions.length, 0);
  }
  const f = fixture([[chunk({ reasoning: '', content: '', reasoning_content: 'Synthetic unknown context.', thinking: 'Synthetic unknown context.', tool_calls: [call('allowed', 'fixture')] }, 'tool_calls')], [chunk({ content: 'Visible.' }, 'stop')]]);
  const executions: { name: string; args: Record<string, unknown> }[] = [], events = await collect(f.runtime.streamChat(f.input, context(executions)));
  assert.equal(executions.length, 1); assert(!Object.hasOwn(f.bodies[1].messages.find((message: any) => message.role === 'assistant'), 'reasoning'));
  assert(!JSON.stringify(f.bodies[1]).includes('Synthetic unknown context.')); assert.deepEqual(events.filter(event => event.type === 'delta'), [{ type: 'delta', text: 'Visible.' }]);
});

test('cancelling a real HTTP reasoning-only stream aborts the connection without exposing context or invoking a tool', async () => {
  let arrived!: () => void, closed!: () => void;
  const received = new Promise<void>(resolve => { arrived = resolve; }), connectionClosed = new Promise<void>(resolve => { closed = resolve; });
  const server = http.createServer(async (request, reply) => {
    for await (const _part of request) { /* Consume the fictional request body. */ }
    reply.writeHead(200, { 'content-type': 'text/event-stream' }); reply.write(`data: ${JSON.stringify(chunk({ reasoning: 'Synthetic pending private context.', content: '' }))}\n\n`);
    reply.once('close', closed); arrived();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port, controller = new AbortController();
  try {
    const runtime = createProviderRuntime({ env: { OLLAMA_BASE_URL: `http://127.0.0.1:${port}/v1`, OLLAMA_CHAT_MODEL: 'synthetic-fixture' } });
    const executions: { name: string; args: Record<string, unknown> }[] = [], events: ChatStreamEvent[] = [];
    const task = (async () => { for await (const event of runtime.streamChat(input, { ...context(executions), signal: controller.signal })) events.push(event); })();
    const rejected = assert.rejects(task, (error: any) => error.name === 'AbortError' || error.code === 'PROVIDER_INTERRUPTED');
    await received; controller.abort(); await rejected; await connectionClosed;
    assert.deepEqual(events, []); assert.equal(executions.length, 0);
  } finally { controller.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
