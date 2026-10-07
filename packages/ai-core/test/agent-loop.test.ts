import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent, AgentLoopContext, AgentToolDefinition, ChatInput, ModelStepContext, ModelStepEvent, ModelStepResult } from '@companion/platform-contracts';
import { ProviderAdapter, ProviderError, runAgentLoop } from '../src/index.ts';
const input: ChatInput = { provider: 'fictional', model: 'fictional', mode: 'chat', messages: [{ role: 'user', content: 'Fictional user.' }] };
const tool = (name: string, effect: AgentToolDefinition['effect'] = 'read', overrides: Partial<AgentToolDefinition> = {}): AgentToolDefinition => ({ name, effect, description: 'Fictional tool.', parameters: { type: 'object' }, progressPhrase: '正在查阅虚构资料…', endsTurn: false, ...overrides });
const call = (name: string, callId = name, args = '{}') => ({ callId, name, arguments: args });
function context(tools: AgentToolDefinition[], overrides: Partial<AgentLoopContext> = {}): AgentLoopContext {
  return { turnId: 'fictional-turn', purpose: 'companion', limits: { maxRounds: 6, maxToolCalls: 12, maxOutputTokens: 1500, timeoutMs: 5000 }, toolDefinitions: tools, resolveTools: () => tools, executeTool: async name => ({ found: name }), drainInterjections: () => [], ...overrides };
}
function scripted(outputs: (ModelStepResult | Error)[], before?: (index: number, ctx: ModelStepContext) => void) {
  const requests: { input: ChatInput; ctx: ModelStepContext }[] = [];
  const adapter = new ProviderAdapter({ async *streamModelStep(value, ctx) { requests.push({ input: structuredClone(value), ctx }); const index = requests.length - 1; before?.(index, ctx); const out = outputs[index]; assert(out, 'No unplanned model call.'); if (out instanceof Error) throw out;
    if (out.text) yield { type: 'delta', text: out.text }; return out;
  } });
  return { adapter, requests };
}
async function collect(stream: AsyncIterable<AgentEvent>) { const events: AgentEvent[] = []; for await (const event of stream) events.push(event); return events; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test('shared loop requires a real single-call adapter and complete tool metadata', async () => {
  assert.throws(() => new ProviderAdapter({}), { code: 'MODEL_STEP_UNAVAILABLE' });
  const f = scripted([{ text: 'Visible.', calls: [] }]); await assert.rejects(collect(runAgentLoop(f.adapter, input, context([{ ...tool('read'), effect: undefined as never }]))), { code: 'INVALID_PROVIDER_INPUT' }); assert.equal(f.requests.length, 0);
});
test('read tools run together, every read settles before serial drafts, result replay stays original call order', async () => {
  const tools = [tool('readA'), tool('draftA', 'draft'), tool('readB'), tool('draftB', 'draft')], gate = deferred(), arrived = deferred(), trace: string[] = [];
  let reads = 0, activeDrafts = 0;
  const f = scripted([{ text: '', calls: tools.map(entry => call(entry.name)) }, { text: 'Completed.', calls: [] }]);
  const task = collect(runAgentLoop(f.adapter, input, context(tools, { executeTool: async (name, _args, execution) => {
    assert.equal(execution.idempotencyKey, `fictional-turn:${name}`); assert.equal(execution.turnId, 'fictional-turn');
    if (name.startsWith('read')) { trace.push(name + ':started'); if (++reads === 2) arrived.resolve(); await gate.promise; trace.push(name + ':done'); }
    else { assert.equal(reads, 2); assert.equal(trace.filter(value => value.endsWith(':done') && value.startsWith('read')).length, 2); assert.equal(++activeDrafts, 1); await Promise.resolve(); trace.push(name); activeDrafts--; }
    return { found: name };
  } })));
  await arrived.promise; assert.equal(trace.length, 2); gate.resolve(); const events = await task;
  assert.deepEqual(trace.slice(-2), ['draftA', 'draftB']); assert.deepEqual(f.requests[1].ctx.toolResults, tools.map(entry => ({ callId: entry.name, result: { found: entry.name } })));
  assert.equal(events.filter(event => event.type === 'tool_finished').length, 4);
});
test('permission changes take effect next step; full definition order never follows mask order or newly loaded skill', async () => {
  const definitions = [tool('use_skill'), tool('new_skill')]; let loaded = false; const executed: string[] = [];
  const f = scripted([{ text: '', calls: [call('use_skill'), call('new_skill', 'too-soon')] }, { text: '', calls: [call('new_skill', 'next-step')] }, { text: 'Done.', calls: [] }]);
  await collect(runAgentLoop(f.adapter, input, context(definitions, { resolveTools: () => loaded ? [...definitions].reverse() : [definitions[0]], executeTool: async name => { executed.push(name); loaded = true; return {}; } })));
  assert.deepEqual(executed, ['use_skill', 'new_skill']); assert.deepEqual(f.requests.map(request => request.ctx.tools.map(entry => entry.name)), Array.from({ length: 3 }, () => ['use_skill', 'new_skill']));
  assert.equal((f.requests[1].ctx.toolResults![1].result as any).error.code, 'TOOL_NOT_ALLOWED'); assert.deepEqual(f.requests[1].ctx.allowedToolNames, ['use_skill', 'new_skill']);
});
test('ordinary tool errors are bounded correction data; two equivalent parameter failures remove the tool', async () => {
  const tools = [tool('read')], f = scripted([{ text: '', calls: [call('read', 'first', '{"a":1,"b":2}')] }, { text: '', calls: [call('read', 'second', '{"b":2,"a":1}')] }, { text: 'Unavailable.', calls: [] }]); let executed = 0;
  await collect(runAgentLoop(f.adapter, input, context(tools, { executeTool: async () => { executed++; throw new Error('Synthetic private error detail.'); } })));
  assert.equal(executed, 2); assert.deepEqual(f.requests[2].ctx.allowedToolNames, []); assert.equal((f.requests[1].ctx.toolResults![0].result as any).error.code, 'TOOL_EXECUTION_FAILED'); assert(!JSON.stringify(f.requests[1].ctx.toolResults).includes('Synthetic'));
});
test('invalid JSON, act and unknown tools do not execute and receive one original call-id correction each', async () => {
  const tools = [tool('read'), tool('act', 'act')], f = scripted([{ text: '', calls: [call('read', 'bad', '['), call('act'), call('unknown')] }, { text: 'Explain.', calls: [] }]); let executed = 0;
  await collect(runAgentLoop(f.adapter, input, context(tools, { executeTool: async () => { executed++; return {}; } })));
  assert.equal(executed, 0); assert.deepEqual(f.requests[1].ctx.toolResults!.map(result => result.callId), ['bad', 'act', 'unknown']); assert(!f.requests[0].ctx.allowedToolNames!.includes('act'));
});
test('consult limit, depth and mandatory endTurn preserve every result while blocking recursive consultation', async () => {
  const tools = [tool('consult', 'consult'), tool('draft', 'draft')]; const executed: string[] = [];
  const f = scripted([{ text: '', calls: [call('consult', 'one'), call('consult', 'two'), call('draft')] }]);
  const events = await collect(runAgentLoop(f.adapter, input, context(tools, { executeTool: async name => { executed.push(name); return {}; } })));
  assert.deepEqual(executed, ['consult', 'draft']); assert.equal(f.requests.length, 1); assert.equal(events.filter(event => event.type === 'tool_finished' && !event.ok).length, 1);
  const nested = scripted([{ text: '', calls: [call('consult')] }, { text: 'No recursive consultation.', calls: [] }]); await collect(runAgentLoop(nested.adapter, input, context(tools, { consultDepth: 1, executeTool: async () => { throw new Error('Must not execute.'); } }))); assert.deepEqual(nested.requests[0].ctx.allowedToolNames, ['draft']);
});
test('maxRounds counts all allowed rounds, then one tools-disabled completion; maxToolCalls skips excess calls', async () => {
  const tools = [tool('read')], f = scripted([{ text: '', calls: [call('read', 'one')] }, { text: '', calls: [call('read', 'two')] }, { text: 'Done and remaining.', calls: [] }]);
  await collect(runAgentLoop(f.adapter, input, context(tools, { limits: { maxRounds: 2, maxToolCalls: 12, maxOutputTokens: 10, timeoutMs: 5000 } })));
  assert.deepEqual(f.requests.map(request => request.ctx.toolChoice), ['auto', 'auto', 'none']); assert.deepEqual(f.requests[2].ctx.allowedToolNames, []);
  let executed = 0; const limited = scripted([{ text: '', calls: [call('read', 'one'), call('read', 'two')] }, { text: 'Remaining.', calls: [] }]);
  await collect(runAgentLoop(limited.adapter, input, context(tools, { limits: { maxRounds: 6, maxToolCalls: 1, maxOutputTokens: 10, timeoutMs: 5000 }, executeTool: async () => { executed++; return {}; } })));
  assert.equal(executed, 1); assert.equal((limited.requests[1].ctx.toolResults![1].result as any).error.code, 'TOOL_BUDGET_EXCEEDED'); assert.equal(limited.requests[1].ctx.toolChoice, 'none');
});
test('provider calls despite toolChoice none never execute, even if catalogue contains the tool', async () => {
  const f = scripted([{ text: 'Nothing was executed.', calls: [call('read')] }]); let executed = 0;
  await collect(runAgentLoop(f.adapter, input, context([tool('read')], { limits: { maxRounds: 1, maxToolCalls: 0, maxOutputTokens: 10, timeoutMs: 5000 }, executeTool: async () => { executed++; return {}; } })));
  assert.equal(executed, 0); assert.equal(f.requests[0].ctx.toolChoice, 'none');
});
test('final-answer interjection adds exactly one tools-disabled step and leaves later interjections for another turn', async () => {
  const f = scripted([{ text: 'First.', calls: [] }, { text: 'Incorporated.', calls: [] }]); let drains = 0;
  await collect(runAgentLoop(f.adapter, input, context([], { drainInterjections: () => { drains++; return [{ role: 'user', content: 'Fictional interruption.' }]; } })));
  assert.equal(drains, 1); assert.equal(f.requests.length, 2); assert.equal(f.requests[1].input.messages.findLast(message => message.role === 'user')!.content, 'Fictional interruption.'); assert.equal(f.requests[1].ctx.toolChoice, 'none');
});
test('tool timeout and result-size metadata actually limit non-cooperative reads and result context', async () => {
  const definitions = [tool('pending', 'read', { timeoutMs: 20 }), tool('huge', 'read', { maxResultChars: 10 })], f = scripted([{ text: '', calls: definitions.map(entry => call(entry.name)) }, { text: 'Unavailable.', calls: [] }]);
  await collect(runAgentLoop(f.adapter, input, context(definitions, { executeTool: async name => name === 'pending' ? new Promise(() => {}) : { private: 'x'.repeat(100) } })));
  assert.deepEqual(f.requests[1].ctx.toolResults!.map(result => (result.result as any).error.code), ['TOOL_TIMEOUT', 'TOOL_RESULT_TOO_LARGE']);
});
test('fatal accounting/lease failures abort peer reads and prevent drafts or another step', async () => {
  for (const code of ['USAGE_RECORD_UNCONFIRMED', 'LEASE_LOST']) {
    const definitions = [tool('pending'), tool('fatal'), tool('draft', 'draft')], f = scripted([{ text: '', calls: definitions.map(entry => call(entry.name)) }]); let drafted = 0, peerSignal: AbortSignal | undefined;
    const task = collect(runAgentLoop(f.adapter, input, context(definitions, { executeTool: async (name, _args, execution) => { if (name === 'pending') { peerSignal = execution.signal; return new Promise(() => {}); } if (name === 'fatal') throw new ProviderError(code, 'Fictional fatal error.'); drafted++; return {}; } })));
    await assert.rejects(task, { code }); assert.equal(drafted, 0); assert.equal(f.requests.length, 1); assert.equal(peerSignal?.aborted, true);
  }
});
test('explicit cancellation exits a non-cooperative model generator and a pending tool without waiting', async () => {
  const abort = new AbortController(), entered = deferred();
  const adapter = new ProviderAdapter({ async *streamModelStep() { entered.resolve(); await new Promise(() => {}); return { text: '', calls: [] }; } });
  const rejected = assert.rejects(collect(runAgentLoop(adapter, input, context([], { signal: abort.signal }))), { name: 'AbortError' }); await entered.promise; abort.abort(); await rejected;
  const secondAbort = new AbortController(), toolEntered = deferred(), f = scripted([{ text: '', calls: [call('pending')] }]);
  const second = assert.rejects(collect(runAgentLoop(f.adapter, input, context([tool('pending')], { signal: secondAbort.signal, executeTool: async () => { toolEntered.resolve(); return new Promise(() => {}); } }))), { name: 'AbortError' }); await toolEntered.promise; secondAbort.abort(); await second;
});
test('all trusted hooks are bounded by the whole turn deadline, never a new per-step budget', async () => {
  for (const key of ['assertActive', 'beforeStep', 'resolveTools', 'drainInterjections'] as const) {
    const f = scripted([{ text: 'Visible.', calls: [] }]), ctx = context([], { limits: { maxRounds: 6, maxToolCalls: 12, maxOutputTokens: 10, timeoutMs: 30 } });
    Object.assign(ctx, { [key]: () => new Promise(() => {}) });
    await assert.rejects(collect(runAgentLoop(f.adapter, input, ctx)), { code: 'AGENT_DEADLINE' }); assert(f.requests.length <= 1);
  }
});
test('early progress uses normalized provider call index when reasoning precedes the function', async () => {
  const adapter = new ProviderAdapter({ async *streamModelStep() { yield { type: 'tool_started', index: 2, callId: 'actual', name: 'consult' }; return { text: '', calls: [{ ...call('consult', 'actual'), index: 2 }] }; } });
  const events = await collect(runAgentLoop(adapter, input, context([tool('consult', 'consult')])));
  assert.deepEqual(events.filter(event => event.type === 'tool_started' || event.type === 'tool_finished').map(event => event.callId), ['actual', 'actual']);
});

test('execution-time permission denial stays a safe, actionable TOOL_NOT_ALLOWED code without private detail', async () => {
  const f = scripted([{ text: '', calls: [call('read')] }, { text: 'Missing authorization.', calls: [] }]);
  await collect(runAgentLoop(f.adapter, input, context([tool('read')], { executeTool: async () => { throw new ProviderError('TOOL_NOT_ALLOWED', 'Synthetic secret server details.', 403); } })));
  assert.equal((f.requests[1].ctx.toolResults![0].result as any).error.code, 'TOOL_NOT_ALLOWED'); assert(!JSON.stringify(f.requests[1].ctx.toolResults).includes('Synthetic'));
});
test('retry before visible output uses one new actual call index and the remaining whole-turn deadline', async () => {
  const requests: ModelStepContext[] = [];
  const adapter = new ProviderAdapter({ async *streamModelStep(_value, ctx) { requests.push(ctx); if (requests.length === 1) { await new Promise(resolve => setTimeout(resolve, 40)); throw new ProviderError('PROVIDER_UNREACHABLE', 'Fictional connection failure.'); } yield { type: 'delta', text: 'Recovered.' }; return { text: 'Recovered.', calls: [] }; } });
  await collect(runAgentLoop(adapter, input, context([], { limits: { maxRounds: 6, maxToolCalls: 12, maxOutputTokens: 10, timeoutMs: 3000 } })));
  assert.deepEqual(requests.map(request => request.callIndex), [1, 2]); assert(requests[1].timeoutMs < requests[0].timeoutMs - 900);
});
test('visible output or disallowed errors do not trigger a hidden provider retry', async () => {
  for (const code of ['PROVIDER_NOT_CONFIGURED', 'USAGE_RECORD_UNCONFIRMED', 'PROVIDER_UNREACHABLE']) {
    let calls = 0; const adapter = new ProviderAdapter({ async *streamModelStep() { calls++; if (code === 'PROVIDER_UNREACHABLE') yield { type: 'delta', text: 'Already visible.' }; throw new ProviderError(code, 'Fictional failure.'); } });
    await assert.rejects(collect(runAgentLoop(adapter, input, context([]))), { code }); assert.equal(calls, 1);
  }
});

test('non-cooperative model deadlines keep the selected budget even when the wall clock has not advanced', async t => {
  // A timer may fire before the next absolute millisecond; its selected budget still owns the timeout.
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  for (const entry of [
    { timeoutMs: 30, callTimeoutMs: undefined, advanceMs: 0, code: 'AGENT_DEADLINE' },
    { timeoutMs: 30, callTimeoutMs: 30, advanceMs: 0, code: 'AGENT_DEADLINE' },
    { timeoutMs: 200, callTimeoutMs: 20, advanceMs: 0, code: 'PROVIDER_INTERRUPTED' },
    { timeoutMs: 200, callTimeoutMs: 20, advanceMs: 201, code: 'AGENT_DEADLINE' },
  ]) {
    let calls = 0; const adapter = new ProviderAdapter({ async *streamModelStep() { calls++; if (entry.advanceMs) t.mock.timers.tick(entry.advanceMs); await new Promise(() => {}); return { text: '', calls: [] }; } });
    await assert.rejects(collect(runAgentLoop(adapter, input, context([], { callTimeoutMs: entry.callTimeoutMs,
      limits: { maxRounds: 6, maxToolCalls: 12, maxOutputTokens: 10, timeoutMs: entry.timeoutMs } }))), { code: entry.code });
    assert.equal(calls, 1);
  }
});
test('background-purpose loop permits only read/draft/none regardless of an over-broad directory mask', async () => {
  const tools = [tool('read'), tool('draft', 'draft'), tool('plan', 'none'), tool('consult', 'consult'), tool('ask', 'ask_user'), tool('background', 'background')];
  const f = scripted([{ text: 'Background summary.', calls: [] }]);
  await collect(runAgentLoop(f.adapter, input, context(tools, { purpose: 'background' })));
  assert.deepEqual(f.requests[0].ctx.allowedToolNames, ['read', 'draft', 'plan']);
});

test('prepared skill budgets intersect the profile after activation and can never expand the turn limits', async () => {
  let loaded = false;
  const tools = [tool('read')], f = scripted([...Array.from({ length: 6 }, (_, index) => ({ text: '', calls: [call('read', 'call-' + index)] })), { text: 'Completed portion and remaining work.', calls: [] }]);
  await collect(runAgentLoop(f.adapter, input, context(tools, { limits: { maxRounds: 8, maxToolCalls: 16, maxOutputTokens: 1500, timeoutMs: 5000 }, resolveLimits: () => loaded ? { maxRounds: 6, maxToolCalls: 12, maxOutputTokens: 99, timeoutMs: 10_000 } : undefined, executeTool: async () => { loaded = true; return {}; } })));
  assert.equal(f.requests.length, 7); assert.equal(f.requests[6].ctx.toolChoice, 'none'); assert.equal(f.requests[1].ctx.limits.maxOutputTokens, 99); assert(f.requests[1].ctx.timeoutMs <= 5000);
  assert.match(f.requests[6].input.messages.at(-1)!.content, /what work is completed and what remains/);
});
test('a deadline reached between steps grants only one bounded tools-disabled final completion', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const tools = [tool('read')], f = scripted([{ text: '', calls: [call('read')] }, { text: 'Completed and remaining.', calls: [] }]);
  await collect(runAgentLoop(f.adapter, input, context(tools, { limits: { maxRounds: 6, maxToolCalls: 12, maxOutputTokens: 10, timeoutMs: 50 }, finalTimeoutMs: 200, executeTool: async () => { t.mock.timers.tick(51); return {}; } })));
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1].ctx.toolChoice, 'none'); assert(f.requests[1].ctx.timeoutMs <= 200); assert.match(f.requests[1].input.messages.at(-1)!.content, /turn deadline/);
});
test('a fragmented tool start has a matching finish; a pre-output retry closes its failed attempt progress', async () => {
  let count = 0; const toolA = tool('read');
  const adapter = new ProviderAdapter({ async *streamModelStep() { count++; if (count < 3) { yield { type: 'tool_started', index: 0 }; if (count === 1) throw new ProviderError('PROVIDER_STREAM_INTERRUPTED', 'Fictional interruption.'); return { text: '', calls: [{ ...call('read', 'actual-later-id'), index: 0 }] }; } yield { type: 'delta', text: 'Done.' }; return { text: 'Done.', calls: [] }; } });
  const events = await collect(runAgentLoop(adapter, input, context([toolA]))), progress = events.filter(event => event.type === 'tool_started' || event.type === 'tool_finished');
  assert.deepEqual(progress.map(event => event.callId), ['step-1-attempt-1-tool-0', 'step-1-attempt-1-tool-0', 'step-1-attempt-2-tool-0', 'step-1-attempt-2-tool-0']); assert.equal(progress[1].type === 'tool_finished' && progress[1].ok, false); assert.equal(progress[3].type === 'tool_finished' && progress[3].ok, true);
});

test('new loop rejects oversized/control-character tool identifiers before execution or progress publication', async () => {
  for (const forged of [{ ...call('read'), callId: 'x'.repeat(241) }, { ...call('read'), callId: 'bad\nidentifier' }, call('x'.repeat(129)), call('bad\nname')]) {
    const f = scripted([{ text: '', calls: [forged] }]); let executed = 0;
    await assert.rejects(collect(runAgentLoop(f.adapter, input, context([tool('read')], { executeTool: async () => { executed++; return {}; } }))), { code: 'INVALID_PROVIDER_INPUT' }); assert.equal(executed, 0);
  }
});
