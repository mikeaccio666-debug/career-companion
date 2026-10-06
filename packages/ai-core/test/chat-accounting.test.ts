import test from 'node:test';
import assert from 'node:assert/strict';
import http, { type ServerResponse } from 'node:http';
import type { ChatStreamEvent, ModelCallEvent } from '@companion/platform-contracts';
import { createProviderRuntime } from '../src/index.ts';

const env = {
  PLATFORM_ALLOW_PROVIDER_CALLS: '1',
  OPENAI_API_KEY: 'synthetic-openai-key', OPENAI_CHAT_MODEL: 'synthetic-responses-model',
  OPENROUTER_API_KEY: 'synthetic-router-key', OPENROUTER_CHAT_MODEL: 'synthetic-router-model',
  ARK_API_KEY: 'synthetic-ark-key', ARK_CHAT_MODEL: 'synthetic-ark-model',
  OLLAMA_CHAT_MODEL: 'synthetic-local-model',
};
const input = (provider: string, mode: 'chat' | 'agent' = 'chat') => ({ provider, mode, messages: [{ role: 'user' as const, content: 'Synthetic private prompt; never copy into accounting.' }] });
const completed = (usage?: unknown, output: unknown[] = []) => ({ type: 'response.completed', response: { output, ...(usage === undefined ? {} : { usage }) } });
const compatible = (content = 'Synthetic reply', finish_reason: string | null = 'stop') => ({ choices: [{ index: 0, delta: { content }, finish_reason }] });
function frames(response: ServerResponse, events: unknown[], end = true) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of events) {
    const bytes = Buffer.from(`data: ${JSON.stringify(event)}\n\n`);
    response.write(bytes.subarray(0, 9)); response.write(bytes.subarray(9));
  }
  if (end) response.end('data: [DONE]\n\n');
}
async function collect(source: AsyncIterable<ChatStreamEvent>) {
  const result: ChatStreamEvent[] = []; for await (const event of source) result.push(event); return result;
}
type Fixture = { runtime: ReturnType<typeof createProviderRuntime>; requests: Record<string, any>[] };
async function loopback(handler: (body: Record<string, any>, response: ServerResponse, index: number) => void | Promise<void>, run: (fixture: Fixture) => Promise<void>) {
  const requests: Record<string, any>[] = [];
  let failure: unknown;
  const server = http.createServer(async (request, response) => {
    try {
      let text = ''; for await (const bytes of request) text += bytes;
      const body = JSON.parse(text); requests.push(body);
      await handler(body, response, requests.length - 1);
    } catch (error) { failure = error; response.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  // All provider transports use actual HTTP on a loopback fixture, including
  // synthetic commercial-provider protocols. No request reaches a provider.
  const runtime = createProviderRuntime({ env: { ...env, OLLAMA_BASE_URL: `${base}/v1` }, fetch: async (url, init) => {
    const destination = new URL(String(url));
    assert(['api.openai.com', 'openrouter.ai', 'ark.cn-beijing.volces.com', '127.0.0.1'].includes(destination.hostname));
    return globalThis.fetch(`${base}${destination.pathname}`, init);
  } });
  try { await run({ runtime, requests }); if (failure) throw failure; }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
function recorder(events: ModelCallEvent[]) { return (event: ModelCallEvent) => { events.push(event); }; }
function finish(events: ModelCallEvent[]) { const event = events.at(-1); assert(event?.type === 'finished'); return event; }
function usages(events: ChatStreamEvent[]) { return events.filter(event => event.type === 'usage'); }

test('Responses accounting admits each real HTTP turn, deduplicates whole-call usage and excludes private context', async () => {
  const calls: ModelCallEvent[] = [];
  const fn = { type: 'function_call', call_id: 'synthetic-provider-id', name: 'lookup', arguments: '{"private":"synthetic-tool-input"}' };
  await loopback((_body, response, index) => {
    assert.equal(calls.at(-1)?.type, 'started');
    frames(response, index === 0 ? [completed({ input_tokens: 10, output_tokens: 2 }, [{ type: 'reasoning', encrypted_content: 'synthetic-private-reasoning' }, fn]), completed({ input_tokens: 10, output_tokens: 2 }, [{ type: 'reasoning', encrypted_content: 'synthetic-private-reasoning' }, fn])]
      : [{ type: 'response.output_text.delta', delta: 'Synthetic final text' }, completed({ input_tokens: 0, output_tokens: 2_147_483_647 })]);
  }, async ({ runtime, requests }) => {
    const result = await collect(runtime.streamChat(input('openai', 'agent'), { onModelCall: recorder(calls), tools: [{ name: 'lookup', description: 'Synthetic lookup', parameters: { type: 'object' } }], executeTool: async () => ({ text: 'synthetic-private-tool-result' }) }));
    assert.deepEqual(calls.map(call => call.type), ['started', 'finished', 'started', 'finished']);
    const starts = calls.filter(call => call.type === 'started');
    assert.deepEqual(starts.map(call => [call.index, call.provider, call.model]), [[1, 'openai', env.OPENAI_CHAT_MODEL], [2, 'openai', env.OPENAI_CHAT_MODEL]]);
    assert.notEqual(starts[0].callId, starts[1].callId);
    for (const call of starts) assert.match(call.callId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.deepEqual(usages(result), [{ type: 'usage', inputTokens: 10, outputTokens: 2 }, { type: 'usage', inputTokens: 0, outputTokens: 2_147_483_647 }]);
    assert.equal(requests[1].input.at(-1).type, 'function_call_output');
    assert.equal(requests[1].input.at(-2).call_id, 'synthetic-provider-id');
    assert(!JSON.stringify(calls).includes('private')); assert(!JSON.stringify(calls).includes('synthetic-provider-id'));
    for (const call of calls) assert.deepEqual(Object.keys(call).sort(), call.type === 'started' ? ['callId', 'index', 'model', 'provider', 'type'] : ['callId', 'status', 'type', 'usage']);
  });
});

test('Ollama accounting covers both tool turns and explicitly requests final usage', async () => {
  const calls: ModelCallEvent[] = [];
  await loopback((body, response, index) => {
    assert.deepEqual(body.stream_options, { include_usage: true });
    frames(response, index === 0 ? [{ choices: [{ index: 0, delta: { reasoning: 'Synthetic hidden context', tool_calls: [{ index: 0, id: 'synthetic-tool-id', function: { name: 'lookup', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: null }, { choices: [], usage: { prompt_tokens: 8, completion_tokens: 4 } }, { choices: [], usage: { prompt_tokens: 8, completion_tokens: 4 } }]
      : [compatible(), { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }]);
  }, async ({ runtime, requests }) => {
    const result = await collect(runtime.streamChat(input('ollama', 'agent'), { onModelCall: recorder(calls), tools: [{ name: 'lookup', description: 'Synthetic lookup', parameters: { type: 'object' } }], executeTool: async () => ({ found: true }) }));
    assert.deepEqual(usages(result).map(event => [event.inputTokens, event.outputTokens]), [[8, 4], [12, 3]]);
    assert.equal(calls.length, 4); assert.equal(finish(calls).status, 'complete');
    assert.equal(requests[1].messages.at(-2).reasoning, 'Synthetic hidden context');
    assert(!JSON.stringify(calls).includes('Synthetic hidden context'));
  });
});

test('Ark requests final usage without cumulative chunk statistics; OpenRouter accepts its final nonempty choice', async () => {
  for (const provider of ['ark', 'openrouter']) {
    const calls: ModelCallEvent[] = [];
    await loopback((body, response) => {
      assert.deepEqual(body.stream_options, provider === 'ark' ? { include_usage: true } : undefined);
      frames(response, [compatible(), { choices: provider === 'openrouter' ? [{ index: 0, delta: {}, finish_reason: 'stop' }] : [], usage: { prompt_tokens: 6, completion_tokens: 2 } }]);
    }, async ({ runtime }) => {
      const result = await collect(runtime.streamChat(input(provider), { onModelCall: recorder(calls) }));
      assert.deepEqual(usages(result), [{ type: 'usage', inputTokens: 6, outputTokens: 2 }]);
      assert.deepEqual(finish(calls).usage, { status: 'reported', inputTokens: 6, outputTokens: 2 });
    });
  }
});

test('successful responses with absent or null statistics retain missing usage instead of fabricated zero', async () => {
  for (const provider of ['openai', 'ollama']) {
    const calls: ModelCallEvent[] = [];
    await loopback((_body, response) => frames(response, provider === 'openai' ? [{ type: 'response.output_text.delta', delta: 'Synthetic reply' }, completed()] : [{ ...compatible(), usage: null }]), async ({ runtime }) => {
      const result = await collect(runtime.streamChat(input(provider), { onModelCall: recorder(calls) }));
      assert.deepEqual(usages(result), []); assert.deepEqual(finish(calls).usage, { status: 'missing' }); assert.equal(finish(calls).status, 'complete');
    });
  }
});

test('invalid usage is sticky, never rounded, coerced, clamped or published', async () => {
  const invalidReports = [{}, { input: 1 }, { input: '1', output: 2 }, { input: 1.5, output: 2 }, { input: -1, output: 2 }, { input: 1, output: 2_147_483_648 }, { input: true, output: 1 }, [], 'synthetic-invalid', 0];
  for (const provider of ['openai', 'ollama']) for (const report of invalidReports) {
    const object = typeof report === 'object' && !Array.isArray(report) ? report as Record<string, unknown> : undefined;
    const raw = object ? (provider === 'openai' ? { input_tokens: object.input, output_tokens: object.output } : { prompt_tokens: object.input, completion_tokens: object.output }) : report;
    const calls: ModelCallEvent[] = [];
    await loopback((_body, response) => frames(response, provider === 'openai' ? [{ type: 'response.output_text.delta', delta: 'Synthetic reply' }, completed(raw), completed({ input_tokens: 1, output_tokens: 2 })] : [compatible(), { choices: [], usage: raw }, { choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } }]), async ({ runtime }) => {
      const result = await collect(runtime.streamChat(input(provider), { onModelCall: recorder(calls) }));
      assert.deepEqual(usages(result), []); assert.deepEqual(finish(calls).usage, { status: 'invalid' }); assert.equal(finish(calls).status, 'complete');
    });
  }
});

test('different whole-call reports conflict rather than being added or silently replaced', async () => {
  for (const provider of ['openai', 'ollama']) {
    const calls: ModelCallEvent[] = [];
    await loopback((_body, response) => frames(response, provider === 'openai' ? [{ type: 'response.output_text.delta', delta: 'Synthetic reply' }, completed({ input_tokens: 1, output_tokens: 2 }), completed({ input_tokens: 1, output_tokens: 3 })] : [compatible(), { choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } }, { choices: [], usage: { prompt_tokens: 1, completion_tokens: 3 } }]), async ({ runtime }) => {
      const result = await collect(runtime.streamChat(input(provider), { onModelCall: recorder(calls) }));
      assert.deepEqual(usages(result), []); assert.deepEqual(finish(calls).usage, { status: 'invalid' });
    });
  }
});

test('Responses failed and incomplete terminal events retain real usage without exposing provider errors', async () => {
  for (const type of ['response.failed', 'response.incomplete']) {
    const calls: ModelCallEvent[] = [];
    await loopback((_body, response) => frames(response, [{ type, response: { usage: { input_tokens: 9, output_tokens: 1 }, error: { message: 'Synthetic private provider detail' } } }]), async ({ runtime }) => {
      await assert.rejects(collect(runtime.streamChat(input('openai'), { onModelCall: recorder(calls) })), { code: 'PROVIDER_GENERATION_FAILED' });
      assert.deepEqual(finish(calls), { type: 'finished', callId: calls[0].callId, status: 'failed', usage: { status: 'reported', inputTokens: 9, outputTokens: 1 } });
      assert(!JSON.stringify(calls).includes('Synthetic private provider detail'));
    });
  }
});

test('compatible output limit settles as failed after reading final usage', async () => {
  const calls: ModelCallEvent[] = [];
  await loopback((_body, response) => frames(response, [compatible('Synthetic partial text', 'length'), { choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } }]), async ({ runtime }) => {
    await assert.rejects(collect(runtime.streamChat(input('ollama'), { onModelCall: recorder(calls) })), { code: 'PROVIDER_OUTPUT_LIMIT' });
    assert.equal(finish(calls).status, 'failed'); assert.deepEqual(finish(calls).usage, { status: 'reported', inputTokens: 9, outputTokens: 4 });
  });
});

test('compatible error chunk can retain reported usage independently of its failed outcome', async () => {
  const calls: ModelCallEvent[] = [];
  await loopback((_body, response) => frames(response, [{ error: { message: 'Synthetic private provider detail' }, usage: { prompt_tokens: 5, completion_tokens: 2 } }]), async ({ runtime }) => {
    await assert.rejects(collect(runtime.streamChat(input('ollama'), { onModelCall: recorder(calls) })), { code: 'PROVIDER_GENERATION_FAILED' });
    assert.equal(finish(calls).status, 'failed'); assert.deepEqual(finish(calls).usage, { status: 'reported', inputTokens: 5, outputTokens: 2 });
  });
});

test('interrupted protocol preserves a prior valid report while refusing a completed reply', async () => {
  const calls: ModelCallEvent[] = [];
  await loopback((_body, response) => frames(response, [{ choices: [], usage: { prompt_tokens: 7, completion_tokens: 1 } }]), async ({ runtime }) => {
    await assert.rejects(collect(runtime.streamChat(input('ollama'), { onModelCall: recorder(calls) })), { code: 'PROVIDER_STREAM_INTERRUPTED' });
    assert.equal(finish(calls).status, 'interrupted'); assert.deepEqual(finish(calls).usage, { status: 'reported', inputTokens: 7, outputTokens: 1 });
  });
});

test('actual HTTP cancellation settles a started call and retains previously received usage', async () => {
  const calls: ModelCallEvent[] = [], controller = new AbortController();
  await loopback((_body, response) => frames(response, [{ ...compatible('Synthetic partial text', null), usage: { prompt_tokens: 7, completion_tokens: 1 } }], false), async ({ runtime }) => {
    const iterator = runtime.streamChat(input('ollama'), { signal: controller.signal, onModelCall: recorder(calls) })[Symbol.asyncIterator]();
    assert.deepEqual((await iterator.next()).value, { type: 'delta', text: 'Synthetic partial text' });
    controller.abort(); await assert.rejects(iterator.next());
    assert.equal(finish(calls).status, 'cancelled'); assert.deepEqual(finish(calls).usage, { status: 'reported', inputTokens: 7, outputTokens: 1 });
    assert.equal(calls.length, 2);
  });
});

test('consumer early return runs accounting finally without yielding fictitious completion', async () => {
  for (const provider of ['openai', 'ollama']) {
    const calls: ModelCallEvent[] = [];
    await loopback((_body, response) => frames(response, provider === 'openai' ? [{ type: 'response.output_text.delta', delta: 'Synthetic partial' }] : [compatible('Synthetic partial', null)], false), async ({ runtime }) => {
      const iterator = runtime.streamChat(input(provider), { onModelCall: recorder(calls) })[Symbol.asyncIterator]();
      assert.equal((await iterator.next()).value?.type, 'delta');
      assert(iterator.return); await iterator.return();
      assert.equal(calls.length, 2); assert.equal(finish(calls).status, 'interrupted'); assert.deepEqual(finish(calls).usage, { status: 'missing' });
    });
  }
});

test('failed admission hook prevents any upstream HTTP request', async () => {
  for (const provider of ['openai', 'ollama']) {
    const rejected = new Error('Synthetic admission rejection');
    await loopback((_body, response) => frames(response, []), async ({ runtime, requests }) => {
      const calls: ModelCallEvent[] = [];
      await assert.rejects(collect(runtime.streamChat(input(provider), { onModelCall: async event => { calls.push(event); throw rejected; } })), error => error === rejected);
      assert.equal(requests.length, 0); assert.equal(calls.length, 1); assert.equal(calls[0].type, 'started');
    });
  }
});

test('finished hook failure is propagated and prevents further agent tools or model calls', async () => {
  const rejected = new Error('Synthetic accounting persistence rejection'), calls: ModelCallEvent[] = []; let tools = 0;
  await loopback((_body, response) => frames(response, [completed({ input_tokens: 2, output_tokens: 1 }, [{ type: 'function_call', call_id: 'synthetic-id', name: 'lookup', arguments: '{}' }])]), async ({ runtime, requests }) => {
    await assert.rejects(collect(runtime.streamChat(input('openai', 'agent'), { tools: [{ name: 'lookup', description: 'Synthetic lookup', parameters: { type: 'object' } }], executeTool: async () => { tools++; return {}; }, onModelCall: async event => { calls.push(event); if (event.type === 'finished') throw rejected; } })), error => error === rejected);
    assert.equal(requests.length, 1); assert.equal(tools, 0); assert.equal(calls.length, 2); assert.equal(finish(calls).status, 'complete');
  });
});

test('tool failure does not erase a completed provider call or fabricate another invocation', async () => {
  const calls: ModelCallEvent[] = [], rejected = new Error('Synthetic tool failure');
  await loopback((_body, response) => frames(response, [completed({ input_tokens: 2, output_tokens: 1 }, [{ type: 'function_call', call_id: 'synthetic-id', name: 'lookup', arguments: '{}' }])]), async ({ runtime, requests }) => {
    await assert.rejects(collect(runtime.streamChat(input('openai', 'agent'), { tools: [{ name: 'lookup', description: 'Synthetic lookup', parameters: { type: 'object' } }], executeTool: async () => { throw rejected; }, onModelCall: recorder(calls) })), error => error === rejected);
    assert.equal(requests.length, 1); assert.equal(calls.length, 2); assert.equal(finish(calls).status, 'complete'); assert.deepEqual(finish(calls).usage, { status: 'reported', inputTokens: 2, outputTokens: 1 });
  });
});

test('already aborted invocations are rejected before admission and upstream HTTP', async () => {
  const controller = new AbortController(); controller.abort();
  for (const provider of ['openai', 'ollama']) await loopback((_body, response) => frames(response, []), async ({ runtime, requests }) => {
    const calls: ModelCallEvent[] = [];
    await assert.rejects(collect(runtime.streamChat(input(provider), { signal: controller.signal, onModelCall: recorder(calls) })));
    assert.equal(requests.length, 0); assert.equal(calls.length, 0);
  });
});
