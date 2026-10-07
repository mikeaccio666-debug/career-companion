import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { ChatInput, ModelCallEvent, ModelStepContext, ModelStepEvent, ModelStepResult, ProviderRequestAdmission } from '@companion/platform-contracts';
import { createProviderRuntime } from '../src/index.ts';

const schema = () => ({ type: 'object', properties: { level: { type: 'string', enum: ['L0','L1','L2'] } }, required: ['level'], additionalProperties: false });
const input = (overrides: Partial<ChatInput> = {}): ChatInput => ({ provider: 'openai', model: 'synthetic-safety', mode: 'chat', messages: [{ role: 'user', content: 'Fictional intake text.' }], ...overrides });
const context = (overrides: Partial<ModelStepContext> = {}): ModelStepContext => ({ invocation: {}, purpose: 'safety_classify', responseFormat: { name: 'synthetic_safety', schema: schema() }, tools: [], toolChoice: 'none', limits: { maxOutputTokens: 100 }, timeoutMs: 700, callIndex: 1, ...overrides });
const env = { PLATFORM_ALLOW_PROVIDER_CALLS: '1', OPENAI_API_KEY: 'synthetic-only', OPENAI_CHAT_MODEL: 'synthetic-chat', OPENAI_SAFETY_CLASSIFY_MODEL: 'synthetic-safety' };
const message = (text: unknown, overrides: Record<string,unknown> = {}) => ({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }], ...overrides });
const completed = (output: unknown = [message('{"level":"L0"}')]) => ({ type: 'response.completed', response: { status: 'completed', output, usage: { input_tokens: 12, output_tokens: 7 } } });
function write(reply: http.ServerResponse, events: unknown[], end = true) {
  reply.writeHead(200,{ 'content-type':'text/event-stream' });
  for (const event of events) reply.write(`data: ${JSON.stringify(event)}\r\n\r\n`);
  if (end) reply.end('data: [DONE]\r\n\r\n');
}
async function collect(stream: AsyncGenerator<ModelStepEvent,ModelStepResult>, events: ModelStepEvent[] = []) {
  try { while (true) { const next = await stream.next(); if (next.done) return { events, result: next.value }; events.push(next.value); } }
  finally { await stream.return(undefined as never); }
}
async function loopback(handler: (body: Record<string,any>,reply: http.ServerResponse) => Promise<void> | void,
  run: (runtime: ReturnType<typeof createProviderRuntime>, bodies: Record<string,any>[]) => Promise<void>) {
  const bodies: Record<string,any>[] = []; let failure: unknown;
  const server = http.createServer(async (request,reply) => {
    try { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body); await handler(body,reply); }
    catch (error) { failure = error; reply.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const runtime = createProviderRuntime({ env, fetch: (url,init) => { assert.equal(new URL(String(url)).origin,'https://api.openai.com'); return fetch(base + new URL(String(url)).pathname,init); } });
  try { await run(runtime,bodies); if (failure) throw failure; }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('actual Responses safety request uses its explicit model, strict schema and 100-token tools-disabled budget',async () => {
  let admissions = 0; const ledger: ModelCallEvent[] = [];
  const gate: ProviderRequestAdmission = async (launch,signal) => { admissions++; return launch(signal ?? new AbortController().signal); };
  await loopback((body,reply) => {
    assert.equal(body.model,'synthetic-safety'); assert.equal(body.max_output_tokens,100);
    assert.deepEqual(body.tools,[]); assert.equal(body.tool_choice,'none'); assert.equal(body.store,false);
    assert.deepEqual(body.text,{ format: { type:'json_schema', name:'synthetic_safety', schema:schema(), strict:true } });
    write(reply,[completed()]);
  },async (runtime,bodies) => {
    const result = await collect(runtime.streamModelStep!(input(),context({ requestAdmission:gate,onModelCall:event => { ledger.push(event); } })));
    assert.equal(result.result.text,'{"level":"L0"}'); assert.deepEqual(result.result.calls,[]);
    assert.equal(result.result.continuation,undefined); assert.equal(Object.hasOwn(result.result,'continuation'),false);
    assert.deepEqual(result.events.filter(event => event.type === 'delta'),[{ type:'delta',text:'{"level":"L0"}' }]);
    assert.equal(bodies.length,1); assert.equal(admissions,1);
    assert.deepEqual(ledger,[{ type:'started',callId:ledger[0].callId,index:1,provider:'openai',model:'synthetic-safety',purpose:'safety_classify' },
      { type:'finished',callId:ledger[0].callId,status:'complete',usage:{ status:'reported',inputTokens:12,outputTokens:7 } }]);
    const status = runtime.capabilities().find(provider => provider.id === 'openai')!;
    assert.deepEqual(status.modelsByPurpose,{ safety_classify:['synthetic-safety'] });
    assert.deepEqual(status.modelsByCapability?.chat,['synthetic-chat']); assert(!status.models.includes('synthetic-safety'));
  });
});

test('structured deltas stay held until authoritative completion; partial delta is not appended twice',async () => {
  let release!: () => void, seen!: () => void; const held = new Promise<void>(resolve => { release = resolve; }), arrived = new Promise<void>(resolve => { seen = resolve; });
  await loopback(async (_body,reply) => { write(reply,[{ type:'response.output_text.delta',delta:'{"level":' }],false); seen(); await held; reply.end(`data: ${JSON.stringify(completed())}\n\n`); },async runtime => {
    const events: ModelStepEvent[] = []; const pending = collect(runtime.streamModelStep!(input(),context()),events); await arrived;
    assert.equal(events.length,0); release(); const result = await pending; assert.equal(result.result.text,'{"level":"L0"}');
    assert.deepEqual(events.filter(event => event.type === 'delta'),[{ type:'delta',text:'{"level":"L0"}' }]);
  });
});

test('schema snapshot cannot change during a trusted accounting await',async () => {
  const format = { name:'synthetic_safety',schema:schema() };
  await loopback((body,reply) => { assert.deepEqual(body.text.format.schema,schema()); write(reply,[completed()]); },async runtime => {
    const result = await collect(runtime.streamModelStep!(input(),context({ responseFormat:format,onModelCall:event => { if (event.type === 'started') { format.schema.properties.level.enum.push('forged'); format.name = 'changed'; } } })));
    assert.equal(result.result.text,'{"level":"L0"}');
  });
});

test('runtime freezes the checked safety model and budget before starting its lazy generator',async () => {
  await loopback((body,reply) => { assert.equal(body.model,'synthetic-safety'); assert.equal(body.max_output_tokens,100); assert.equal(body.input[0].content,'Fictional intake text.'); write(reply,[completed()]); },async runtime => {
    const request = input(),ctx = context(),stream = runtime.streamModelStep!(request,ctx);
    request.model = 'synthetic-chat'; request.provider = 'ollama'; request.messages[0].content = 'Changed after binding.';
    ctx.purpose = 'companion_reply'; ctx.limits.maxOutputTokens = 10000; ctx.tools.push({ name:'invented',description:'Fictional',parameters:{} });
    assert.equal((await collect(stream)).result.text,'{"level":"L0"}');
  });
});

test('nullable branches and closed nested arrays validate a provider-neutral schema',async () => {
  const nested = { type:'object',properties:{ choice:{ anyOf:[{ type:'null' },{ type:'object',properties:{ roles:{ type:'array',items:{ type:'string',enum:['swe','ds'] } } },required:['roles'],additionalProperties:false }] } },required:['choice'],additionalProperties:false };
  for (const text of ['{"choice":null}','{"choice":{"roles":["swe","ds"]}}']) await loopback((_body,reply) => write(reply,[completed([message(text)])]),async runtime => {
    const result = await collect(runtime.streamModelStep!(input(),context({ responseFormat:{ name:'nested',schema:nested } }))); assert.equal(result.result.text,text);
  });
});

for (const [label,events,code] of [
  ['refusal delta after valid JSON',[{ type:'response.output_text.delta',delta:'{"level":"L0"}' },{ type:'response.refusal.delta',delta:'Synthetic private refusal.' }],'PROVIDER_REFUSAL'],
  ['refusal done',[{ type:'response.refusal.done',refusal:'Synthetic private refusal.' }],'PROVIDER_REFUSAL'],
  ['completed refusal',[completed([message('',{ content:[{ type:'refusal',refusal:'Synthetic private refusal.' }] })])],'PROVIDER_REFUSAL'],
  ['incomplete after valid JSON',[{ type:'response.output_text.delta',delta:'{"level":"L0"}' },{ type:'response.incomplete',response:{ incomplete_details:{ reason:'max_output_tokens' },usage:{ input_tokens:12,output_tokens:100 } } }],'PROVIDER_OUTPUT_LIMIT'],
  ['failed after valid JSON',[{ type:'response.output_text.delta',delta:'{"level":"L0"}' },{ type:'response.failed',response:{ usage:{ input_tokens:12,output_tokens:7 } } }],'PROVIDER_GENERATION_FAILED'],
  ['EOF after valid JSON',[{ type:'response.output_text.delta',delta:'{"level":"L0"}' }],'PROVIDER_STREAM_INTERRUPTED'],
  ['invalid JSON',[completed([message('{"level":')])],'INVALID_PROVIDER_RESPONSE'],
  ['wrong enum',[completed([message('{"level":"invented"}')])],'INVALID_PROVIDER_RESPONSE'],
  ['additional field',[completed([message('{"level":"L0","userId":"invented"}')])],'INVALID_PROVIDER_RESPONSE'],
  ['missing field',[completed([message('{}')])],'INVALID_PROVIDER_RESPONSE'],
  ['nonobject JSON',[completed([message('null')])],'INVALID_PROVIDER_RESPONSE'],
  ['nonstring output',[completed([message(7)])],'INVALID_PROVIDER_RESPONSE'],
  ['nonarray output',[completed({ invented:true })],'INVALID_PROVIDER_RESPONSE'],
  ['completed tool output',[completed([{ type:'function_call',call_id:'synthetic',name:'invented',arguments:'{}',status:'completed' }])],'INVALID_PROVIDER_RESPONSE'],
  ['tool start',[{ type:'response.output_item.added',item:{ type:'function_call',call_id:'synthetic',name:'invented' } }],'INVALID_PROVIDER_RESPONSE'],
  ['oversized output',[completed([message(' '.repeat(32769))])],'INVALID_PROVIDER_RESPONSE'],
  ['delta after completion',[completed(),{ type:'response.output_text.delta',delta:'Synthetic malformed private tail.' }],'INVALID_PROVIDER_RESPONSE'],
  ['tool result after completion',[completed(),{ type:'response.output_item.done',item:{ type:'function_call',call_id:'synthetic',name:'invented',arguments:'{}',status:'completed' } }],'INVALID_PROVIDER_RESPONSE'],
  ['second completion',[completed(),completed()],'INVALID_PROVIDER_RESPONSE'],
  ['refusal after completion',[completed(),{ type:'response.refusal.delta',delta:'Synthetic private refusal.' }],'INVALID_PROVIDER_RESPONSE'],
] as const) test(`structured ${label} refuses completion without publishing deltas or tool events`,async () => {
  const ledger: ModelCallEvent[] = [], published: ModelStepEvent[] = [];
  await loopback((_body,reply) => write(reply,[...events]),async runtime => {
    await assert.rejects(collect(runtime.streamModelStep!(input(),context({ onModelCall:event => { ledger.push(event); } })),published),{ code });
    assert.deepEqual(published,[]); assert.equal(ledger.length,2); assert.equal(ledger[1].type,'finished');
    if (ledger[1].type === 'finished') assert.notEqual(ledger[1].status,'complete');
    assert(!JSON.stringify(ledger).includes('private refusal'));
  });
});

test('actual loopback cancellation interrupts a held stream and reports unknown usage honestly',async () => {
  let arrived!: () => void; const seen = new Promise<void>(resolve => { arrived = resolve; });
  const controller = new AbortController(),ledger: ModelCallEvent[] = [],events: ModelStepEvent[] = [];
  await loopback((_body,reply) => { write(reply,[{ type:'response.output_text.delta',delta:'{"level":' }],false); arrived(); },async runtime => {
    const rejected = assert.rejects(collect(runtime.streamModelStep!(input(),context({ signal:controller.signal,onModelCall:event => { ledger.push(event); } })),events));
    await seen; controller.abort(); await rejected; assert.deepEqual(events,[]);
    assert.equal(ledger.length,2); assert(ledger[1].type === 'finished'); assert.equal(ledger[1].status,'cancelled'); assert.deepEqual(ledger[1].usage,{ status:'missing' });
  });
});

test('cancellation during terminal accounting suppresses the already validated result',async () => {
  let started!: () => void,release!: () => void; const accounting = new Promise<void>(resolve => { started = resolve; }),held = new Promise<void>(resolve => { release = resolve; });
  const controller = new AbortController(),events: ModelStepEvent[] = [],ledger: ModelCallEvent[] = [];
  await loopback((_body,reply) => write(reply,[completed()]),async runtime => {
    const pending = assert.rejects(collect(runtime.streamModelStep!(input(),context({ signal:controller.signal,onModelCall:async event => { ledger.push(event); if (event.type === 'finished') { started(); await held; } } })),events));
    await accounting; assert.equal(events.length,0); controller.abort(); release(); await pending;
    assert.equal(events.length,0); assert.equal(ledger.length,2); assert(ledger[1].type === 'finished');
    // Provider completion and its reported usage remain true; cancellation prevents local publication.
    assert.equal(ledger[1].status,'complete'); assert.deepEqual(ledger[1].usage,{ status:'reported',inputTokens:12,outputTokens:7 });
  });
});

test('commercial flag, missing explicit safety model and model overrides refuse before actual HTTP',async () => {
  let calls = 0;
  for (const [configuration,request,ctx,code] of [
    [{ ...env,PLATFORM_ALLOW_PROVIDER_CALLS:'0' },input(),context(),'PROVIDER_NOT_CONFIGURED'],
    [{ ...env,OPENAI_SAFETY_CLASSIFY_MODEL:'' },input({ model:'synthetic-chat' }),context(),'PROVIDER_STRUCTURED_OUTPUT_UNAVAILABLE'],
    [{ ...env,OPENAI_SAFETY_CLASSIFY_MODEL:'synthetic-safety\n' },input(),context(),'PROVIDER_STRUCTURED_OUTPUT_UNAVAILABLE'],
    [env,input({ model:'synthetic-chat' }),context(),'INVALID_PROVIDER_INPUT'],
    [env,input(),context({ responseFormat:undefined }),'INVALID_PROVIDER_INPUT'],
    [env,input(),context({ limits:{ maxOutputTokens:101 } }),'INVALID_PROVIDER_INPUT'],
    [env,input(),context({ timeoutMs:1001 }),'INVALID_PROVIDER_INPUT'],
    [env,input(),context({ toolChoice:'auto' }),'INVALID_PROVIDER_INPUT'],
    [env,input(),context({ tools:[{ name:'invented',description:'Fictional',parameters:{} }] }),'INVALID_PROVIDER_INPUT'],
    [env,input(),context({ continuation:{} }),'INVALID_PROVIDER_INPUT'],
  ] as const) {
    const runtime = createProviderRuntime({ env:configuration,fetch:async () => { calls++; throw new Error('No delivery expected.'); } });
    await assert.rejects(async () => collect(runtime.streamModelStep!(request,ctx)),{ code });
  }
  assert.equal(calls,0);
});

test('unverified compatible structured adapters refuse before accounting or HTTP',async () => {
  let calls = 0,started = 0;
  const runtime = createProviderRuntime({ env:{ ...env,OPENROUTER_API_KEY:'synthetic-only',OPENROUTER_CHAT_MODEL:'synthetic-chat',ARK_API_KEY:'synthetic-only',ARK_CHAT_MODEL:'synthetic-chat',OLLAMA_BASE_URL:'http://127.0.0.1:11434/v1',OLLAMA_CHAT_MODEL:'synthetic-chat' },fetch:async () => { calls++; throw new Error('No delivery.'); } });
  for (const provider of ['openrouter','ark','ollama']) for (const purpose of ['safety_classify','companion_reply']) await assert.rejects(async () => collect(runtime.streamModelStep!(input({ provider,model:'synthetic-chat' }),context({ purpose,onModelCall:() => { started++; } }))),{ code:'PROVIDER_STRUCTURED_OUTPUT_UNAVAILABLE' });
  assert.equal(calls,0); assert.equal(started,0);
});

test('strict format rejects unsupported or non-JSON schema inputs before accounting or HTTP',async () => {
  let calls = 0,started = 0,getterReads = 0;
  const runtime = createProviderRuntime({ env,fetch:async () => { calls++; throw new Error('No delivery.'); } });
  const cyclic: Record<string,unknown> = {}; cyclic.type = 'object'; cyclic.properties = cyclic;
  const getter = { type:'object',get properties() { getterReads++; return {}; },required:[],additionalProperties:false };
  const formats: unknown[] = [
    { name:'invalid\n',schema:schema() },{ name:'a'.repeat(65),schema:schema() },{ name:'ok',schema:schema(),strict:false },
    { name:'ok',schema:cyclic },{ name:'ok',schema:getter },{ name:'ok',schema:{ ...schema(),unknown:true } },
    { name:'ok',schema:{ ...schema(),additionalProperties:true } },{ name:'ok',schema:{ ...schema(),required:[] } },
    { name:'ok',schema:{ ...schema(),description:undefined } },{ name:'ok',schema:{ ...schema(),description:()=>{} } },
    { name:'ok',schema:{ ...schema(),enum:[1n] } },{ name:'ok',schema:{ ...schema(),enum:[Infinity] } },
    { name:'ok',schema:{ type:'object',properties:{ level:{ type:'invented' } },required:['level'],additionalProperties:false } },
    { name:'ok',schema:{ ...schema(),description:'x'.repeat(32769) } },
  ];
  for (const responseFormat of formats) await assert.rejects(async () => collect(runtime.streamModelStep!(input(),context({ responseFormat:responseFormat as ModelStepContext['responseFormat'],onModelCall:() => { started++; } }))),{ code:'INVALID_PROVIDER_INPUT' });
  assert.equal(calls,0); assert.equal(started,0); assert.equal(getterReads,0);
});
