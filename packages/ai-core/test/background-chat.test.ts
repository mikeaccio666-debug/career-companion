import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { ChatContext, ChatInput, ChatStreamEvent, ModelCallEvent, ProviderRequestAdmission } from '@companion/platform-contracts';
import { createProviderRuntime } from '../src/index.ts';

const schema = () => ({ type: 'object', properties: {
  summary: { type: 'string', minLength: 1, maxLength: 60 },
  samples: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'string', minLength: 1 } },
}, required: ['summary','samples'], additionalProperties: false });
// OpenAI's current guide explicitly lists array cardinality constraints, but
// does not explicitly list string length constraints for the transport schema.
// Those are enforced against the original schema after actual completion.
const wireSchema = () => ({ ...schema(),properties:{ summary:{ type:'string' },samples:{ ...schema().properties.samples,items:{ type:'string' } } } });
const preview = JSON.stringify({ summary: 'A fictional practical companion.', samples: ['One synthetic sentence.','Another synthetic sentence.','A final synthetic sentence.'] });
const input = (overrides: Partial<ChatInput> = {}): ChatInput => ({ provider: 'openai', model: 'synthetic-companion', mode: 'chat',
  messages: [{ role: 'system', content: 'Synthetic server-owned generation policy.' }, { role: 'user', content: 'Synthetic prepared style only.' }], ...overrides });
const admission: ProviderRequestAdmission = async (launch,signal) => launch(signal ?? new AbortController().signal);
const context = (overrides: Partial<ChatContext> = {}): ChatContext => ({ requestAdmission: admission, onModelCall: () => {},
  background: { purpose: 'companion_generation', responseFormat: { name: 'synthetic_preview', schema: schema() }, limits: { maxOutputTokens: 1536 }, timeoutMs: 15000 }, ...overrides });
const env = { PLATFORM_ALLOW_PROVIDER_CALLS: '1', OPENAI_API_KEY: 'synthetic-only', OPENAI_CHAT_MODEL: 'synthetic-chat', OPENAI_COMPANION_GENERATION_MODEL: 'synthetic-companion' };
const message = (text: unknown, overrides: Record<string,unknown> = {}) => ({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }], ...overrides });
const completed = (output: unknown = [message(preview)], usage: unknown = { input_tokens: 18, output_tokens: 37 }) => ({ type: 'response.completed', response: { status: 'completed', output, usage } });
function write(reply: http.ServerResponse, events: unknown[], end = true) {
  reply.writeHead(200,{ 'content-type':'text/event-stream' });
  for (const event of events) reply.write(`data: ${JSON.stringify(event)}\r\n\r\n`);
  if (end) reply.end('data: [DONE]\r\n\r\n');
}
async function collect(stream: AsyncIterable<ChatStreamEvent>, events: ChatStreamEvent[] = []) {
  for await (const event of stream) events.push(event);
  return events;
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

test('streamChat background launches one explicit tools-disabled Responses request with real accounting and admission',async () => {
  const ledger: ModelCallEvent[] = [], order: string[] = [];
  await loopback((body,reply) => {
    order.push('http'); assert.equal(body.model,'synthetic-companion'); assert.equal(body.store,false); assert.equal(body.stream,true);
    assert.deepEqual(body.tools,[]); assert.equal(body.tool_choice,'none'); assert.equal(body.max_output_tokens,1536);
    assert.deepEqual(body.text,{ format: { type:'json_schema', name:'synthetic_preview', schema:wireSchema(), strict:true } });
    assert(!Object.hasOwn(body,'previous_response_id')); assert(!Object.hasOwn(body,'conversation'));
    write(reply,[{ type:'response.output_text.delta',delta:preview.slice(0,10) },completed()]);
  },async (runtime,bodies) => {
    const events = await collect(runtime.streamChat(input(),context({ requestAdmission:async (launch,signal) => { order.push('admission'); return launch(signal!); },
      onModelCall:event => { ledger.push(event); order.push(event.type); } })));
    assert.deepEqual(events,[{ type:'delta',text:preview },{ type:'usage',inputTokens:18,outputTokens:37 }]);
    assert.equal(bodies.length,1); assert.deepEqual(order,['started','admission','http','finished']);
    assert.deepEqual(ledger,[{ type:'started',callId:ledger[0].callId,index:1,provider:'openai',model:'synthetic-companion',purpose:'companion_generation' },
      { type:'finished',callId:ledger[0].callId,status:'complete',usage:{ status:'reported',inputTokens:18,outputTokens:37 } }]);
    assert.deepEqual(runtime.capabilities().find(provider => provider.id === 'openai')?.modelsByPurpose?.companion_generation,['synthetic-companion']);
  });
});

test('checked background input, schema, model, callback and limits cannot change before the lazy stream or during accounting',async () => {
  const ledger: ModelCallEvent[] = [], request = input(),ctx = context(),format = ctx.background!.responseFormat;
  ctx.onModelCall = event => { ledger.push(event); format.schema.properties = {}; ctx.background!.timeoutMs = 1; request.messages[0].content = 'Changed during accounting.'; };
  await loopback((body,reply) => {
    assert.equal(body.model,'synthetic-companion'); assert.equal(body.max_output_tokens,1536); assert.equal(body.input[0].content,'Synthetic server-owned generation policy.');
    assert.deepEqual(body.text.format.schema,wireSchema()); write(reply,[completed()]);
  },async runtime => {
    const stream = runtime.streamChat(request,ctx);
    request.provider = 'ollama'; request.model = 'synthetic-chat'; request.messages[0].content = 'Changed before iteration.';
    ctx.background!.purpose = 'invented' as never; ctx.background!.limits.maxOutputTokens = 10000; ctx.requestAdmission = async () => { throw new Error('Mutated admission must not run.'); };
    ctx.onModelCall = () => { throw new Error('Mutated accounting must not run.'); };
    const events = await collect(stream); assert.equal(events[0].type,'delta'); assert.equal(ledger.length,2);
  });
});

test('uncompleted background deltas remain private until actual terminal accounting finishes',async () => {
  let arrived!: () => void,release!: () => void,accounting!: () => void,finish!: () => void;
  const seen = new Promise<void>(resolve => { arrived = resolve; }),held = new Promise<void>(resolve => { release = resolve; });
  const accounted = new Promise<void>(resolve => { accounting = resolve; }),finishHeld = new Promise<void>(resolve => { finish = resolve; });
  await loopback(async (_body,reply) => { write(reply,[{ type:'response.output_text.delta',delta:preview }],false); arrived(); await held; reply.end(`data: ${JSON.stringify(completed())}\n\n`); },async runtime => {
    const events: ChatStreamEvent[] = [],pending = collect(runtime.streamChat(input(),context({ onModelCall:async event => { if (event.type === 'finished') { accounting(); await finishHeld; } } })),events);
    await seen; assert.equal(events.length,0); release(); await accounted; assert.equal(events.length,0); finish(); await pending;
    assert.deepEqual(events.filter(event => event.type === 'delta'),[{ type:'delta',text:preview }]);
  });
});

for (const [label,events,code] of [
  ['refusal',[{ type:'response.output_text.delta',delta:preview },completed([message('',{ content:[{ type:'refusal',refusal:'Synthetic private refusal.' }] })])],'PROVIDER_REFUSAL'],
  ['refusal delta',[{ type:'response.refusal.delta',delta:'Synthetic private refusal.' }],'PROVIDER_REFUSAL'],
  ['incomplete',[{ type:'response.output_text.delta',delta:preview },{ type:'response.incomplete',response:{ incomplete_details:{ reason:'max_output_tokens' },usage:{ input_tokens:18,output_tokens:1536 } } }],'PROVIDER_OUTPUT_LIMIT'],
  ['failed',[{ type:'response.failed',response:{ error:{ message:'Synthetic private failure.' },usage:{ input_tokens:18,output_tokens:4 } } }],'PROVIDER_GENERATION_FAILED'],
  ['EOF',[{ type:'response.output_text.delta',delta:preview }],'PROVIDER_STREAM_INTERRUPTED'],
  ['invalid JSON',[completed([message('Synthetic private malformed output.')])],'INVALID_PROVIDER_RESPONSE'],
  ['wrong array length',[completed([message(JSON.stringify({ summary:'Synthetic',samples:['one','two'] }))])],'INVALID_PROVIDER_RESPONSE'],
  ['blank summary',[completed([message(JSON.stringify({ summary:'',samples:['one','two','three'] }))])],'INVALID_PROVIDER_RESPONSE'],
  ['oversized summary',[completed([message(JSON.stringify({ summary:'x'.repeat(61),samples:['one','two','three'] }))])],'INVALID_PROVIDER_RESPONSE'],
  ['extra property',[completed([message(JSON.stringify({ summary:'Synthetic',samples:['one','two','three'],persona:'Synthetic private persona.' }))])],'INVALID_PROVIDER_RESPONSE'],
  ['tools',[{ type:'response.output_item.added',item:{ type:'function_call',call_id:'synthetic',name:'invented' } }],'INVALID_PROVIDER_RESPONSE'],
  ['tool final',[completed([{ type:'function_call',call_id:'synthetic',name:'invented',arguments:'{}',status:'completed' }])],'INVALID_PROVIDER_RESPONSE'],
  ['invalid completion status',[{ type:'response.completed',response:{ status:'incomplete',output:[message(preview)] } }],'INVALID_PROVIDER_RESPONSE'],
  ['trailing output',[completed(),{ type:'response.output_text.delta',delta:'Synthetic private tail.' }],'INVALID_PROVIDER_RESPONSE'],
] as const) test(`background ${label} is not successful and publishes no partial result`,async () => {
  const ledger: ModelCallEvent[] = [],published: ChatStreamEvent[] = [];
  await loopback((_body,reply) => write(reply,[...events]),async runtime => {
    await assert.rejects(collect(runtime.streamChat(input(),context({ onModelCall:event => { ledger.push(event); } })),published),error => {
      assert.equal((error as { code:string }).code,code); assert(!String(error).includes('Synthetic private')); return true;
    });
    assert.deepEqual(published,[]); assert.equal(ledger.length,2); assert(ledger[1].type === 'finished'); assert.notEqual(ledger[1].status,'complete');
    assert(!JSON.stringify(ledger).includes('Synthetic private'));
    if (label === 'incomplete') assert.deepEqual(ledger[1].usage,{ status:'reported',inputTokens:18,outputTokens:1536 });
    if (label === 'failed') assert.deepEqual(ledger[1].usage,{ status:'reported',inputTokens:18,outputTokens:4 });
  });
});

test('absent and invalid actual usage stay unknown instead of reported zero',async () => {
  for (const [usage,expected] of [[undefined,'missing'],[{ input_tokens:-1,output_tokens:0 },'invalid']] as const) {
    const ledger: ModelCallEvent[] = [];
    await loopback((_body,reply) => write(reply,[{ type:'response.completed',response:{ status:'completed',output:[message(preview)],...(usage === undefined ? {} : { usage }) } }]),async runtime => {
      const events = await collect(runtime.streamChat(input(),context({ onModelCall:event => { ledger.push(event); } })));
      assert.equal(events.length,1); assert(ledger[1].type === 'finished'); assert.equal(ledger[1].status,'complete'); assert.deepEqual(ledger[1].usage,{ status:expected });
    });
  }
});

test('disabled provider, missing dedicated model and overrides fail before accounting, admission and HTTP',async () => {
  let calls = 0,started = 0,admissions = 0;
  for (const [configuration,request,code] of [
    [{ ...env,PLATFORM_ALLOW_PROVIDER_CALLS:'0' },input(),'PROVIDER_NOT_CONFIGURED'],
    [{ ...env,OPENAI_API_KEY:'' },input(),'PROVIDER_NOT_CONFIGURED'],
    [{ ...env,OPENAI_COMPANION_GENERATION_MODEL:undefined },input(),'PROVIDER_STRUCTURED_OUTPUT_UNAVAILABLE'],
    [{ ...env,OPENAI_COMPANION_GENERATION_MODEL:'' },input(),'PROVIDER_STRUCTURED_OUTPUT_UNAVAILABLE'],
    [{ ...env,OPENAI_COMPANION_GENERATION_MODEL:'synthetic-companion\n' },input(),'PROVIDER_STRUCTURED_OUTPUT_UNAVAILABLE'],
    [env,input({ model:'synthetic-chat' }),'INVALID_PROVIDER_INPUT'],
    [env,input({ provider:'ollama' }),'PROVIDER_STRUCTURED_OUTPUT_UNAVAILABLE'],
  ] as const) {
    const runtime = createProviderRuntime({ env:configuration,fetch:async () => { calls++; throw new Error('No delivery.'); } });
    assert.throws(() => runtime.streamChat(request,context({ requestAdmission:async (launch,signal) => { admissions++; return launch(signal!); },onModelCall:() => { started++; } })),{ code });
  }
  assert.equal(calls,0); assert.equal(started,0); assert.equal(admissions,0);
});

test('background rejects persona, tools, continuation, absent hooks and unsafe closed input without invoking getters',async () => {
  let calls = 0,getterReads = 0;
  const runtime = createProviderRuntime({ env,fetch:async () => { calls++; throw new Error('No delivery.'); } });
  const requests: unknown[] = [input({ persona:'Synthetic persona' }),input({ memories:[] }),input({ attachments:[] }),input({ mode:'agent' }),
    input({ messages:[{ role:'user',content:'Synthetic',attachments:[] }] }),{ ...input(),get model() { getterReads++; return 'synthetic-companion'; } }];
  for (const request of requests) assert.throws(() => runtime.streamChat(request as ChatInput,context()),{ code:'INVALID_PROVIDER_INPUT' });
  const contexts: unknown[] = [context({ requestAdmission:undefined }),context({ onModelCall:undefined }),context({ tools:[] }),context({ executeTool:async () => ({}) }),
    { ...context(),continuation:{} },{ ...context(),get background() { getterReads++; return context().background; } },
    context({ background:{ ...context().background!,limits:{ maxOutputTokens:1537 } } }),
    context({ background:{ ...context().background!,timeoutMs:15001 } }),context({ background:{ ...context().background!,purpose:'invented' as never } })];
  for (const ctx of contexts) assert.throws(() => runtime.streamChat(input(),ctx as ChatContext),{ code:'INVALID_PROVIDER_INPUT' });
  assert.equal(calls,0); assert.equal(getterReads,0);
});

test('strict bounded schema rejects incompatible keyword types, negative bounds and open or unknown input before accounting',async () => {
  let calls = 0,started = 0;
  const runtime = createProviderRuntime({ env,fetch:async () => { calls++; throw new Error('No delivery.'); } });
  const schemas = [
    { ...schema(),unexpected:true },{ ...schema(),additionalProperties:true },
    { ...schema(),properties:{ ...schema().properties,summary:{ type:'string',minLength:-1 } } },
    { ...schema(),properties:{ ...schema().properties,summary:{ type:'string',maxLength:32769 } } },
    { ...schema(),properties:{ ...schema().properties,summary:{ type:'string',minLength:4,maxLength:3 } } },
    { ...schema(),properties:{ ...schema().properties,summary:{ type:'string',minItems:1 } } },
    { ...schema(),properties:{ ...schema().properties,samples:{ type:'array',items:{ type:'string' },minItems:0.5 } } },
  ];
  for (const value of schemas) assert.throws(() => runtime.streamChat(input(),context({ onModelCall:() => { started++; },background:{ ...context().background!,responseFormat:{ name:'synthetic',schema:value } } })),{ code:'INVALID_PROVIDER_INPUT' });
  assert.equal(calls,0); assert.equal(started,0);
});

test('actual admission refusal prevents HTTP delivery and accounting does not invent successful usage',async () => {
  let calls = 0; const ledger: ModelCallEvent[] = [],rejected = new Error('Synthetic authorization revoked');
  const runtime = createProviderRuntime({ env,fetch:async () => { calls++; throw new Error('No delivery.'); } });
  await assert.rejects(collect(runtime.streamChat(input(),context({ requestAdmission:async () => { throw rejected; },onModelCall:event => { ledger.push(event); } }))),error => error === rejected);
  assert.equal(calls,0); assert.equal(ledger.length,2); assert(ledger[1].type === 'finished'); assert.notEqual(ledger[1].status,'complete'); assert.deepEqual(ledger[1].usage,{ status:'missing' });
});

test('an admission that fabricates a response without launching is rejected',async () => {
  let calls = 0;
  const runtime = createProviderRuntime({ env,fetch:async () => { calls++; throw new Error('No delivery.'); } });
  const forged: ProviderRequestAdmission = async <T>() => new Response(`data: ${JSON.stringify(completed())}\n\n`,{ status:200 }) as T;
  await assert.rejects(collect(runtime.streamChat(input(),context({ requestAdmission:forged }))),{ code:'PROVIDER_ADMISSION_INVALID' });
  assert.equal(calls,0);
});

test('an admission cannot replace the actual launched response with a fabricated successful one',async () => {
  const events: ChatStreamEvent[] = [];
  await loopback((_body,reply) => write(reply,[completed()]),async (runtime,bodies) => {
    const forged: ProviderRequestAdmission = async <T>(launch: (signal: AbortSignal) => Promise<T>,signal?: AbortSignal) => {
      await launch(signal!);
      return new Response(`data: ${JSON.stringify(completed())}\n\n`,{ status:200 }) as T;
    };
    await assert.rejects(collect(runtime.streamChat(input(),context({ requestAdmission:forged })),events),{ code:'PROVIDER_ADMISSION_INVALID' });
    assert.equal(bodies.length,1); assert.equal(events.length,0);
  });
});

test('an admission cannot dispatch a second request for one background call',async () => {
  await loopback((_body,reply) => write(reply,[completed()]),async (runtime,bodies) => {
    const repeated: ProviderRequestAdmission = async <T>(launch: (signal: AbortSignal) => Promise<T>,signal?: AbortSignal) => {
      await launch(signal!);
      return launch(signal!);
    };
    await assert.rejects(collect(runtime.streamChat(input(),context({ requestAdmission:repeated }))),{ code:'PROVIDER_ADMISSION_INVALID' });
    assert.equal(bodies.length,1);
  });
});

test('wire projection preserves schema properties named like length keywords and local bounds count Unicode code points',async () => {
  const bounded = { type:'object',properties:{ minLength:{ type:'string',minLength:1,maxLength:1 } },required:['minLength'],additionalProperties:false };
  await loopback((body,reply) => {
    assert.deepEqual(body.text.format.schema,{ ...bounded,properties:{ minLength:{ type:'string' } } });
    write(reply,[completed([message('{"minLength":"😀"}')])]);
  },async runtime => {
    const events = await collect(runtime.streamChat(input(),context({ background:{ ...context().background!,responseFormat:{ name:'synthetic_unicode',schema:bounded } } })));
    assert.deepEqual(events.filter(event => event.type === 'delta'),[{ type:'delta',text:'{"minLength":"😀"}' }]);
  });
});

test('a bounded background timeout cancels actual loopback HTTP and retains unknown usage',async () => {
  const ledger: ModelCallEvent[] = [],events: ChatStreamEvent[] = [];
  await loopback((_body,reply) => write(reply,[{ type:'response.output_text.delta',delta:preview }],false),async runtime => {
    await assert.rejects(collect(runtime.streamChat(input(),context({ background:{ ...context().background!,timeoutMs:60 },
      // A faulty server admission cannot remove the original transport deadline.
      requestAdmission:async launch => launch(new AbortController().signal),onModelCall:event => { ledger.push(event); } })),events));
    assert.deepEqual(events,[]); assert(ledger[1].type === 'finished'); assert.equal(ledger[1].status,'interrupted'); assert.deepEqual(ledger[1].usage,{ status:'missing' });
  });
});

test('cancellation while terminal accounting persists keeps real usage but suppresses the result',async () => {
  let arrived!: () => void,release!: () => void; const seen = new Promise<void>(resolve => { arrived = resolve; }),held = new Promise<void>(resolve => { release = resolve; });
  const abort = new AbortController(),ledger: ModelCallEvent[] = [],events: ChatStreamEvent[] = [];
  await loopback((_body,reply) => write(reply,[completed()]),async runtime => {
    const rejected = assert.rejects(collect(runtime.streamChat(input(),context({ signal:abort.signal,onModelCall:async event => { ledger.push(event); if (event.type === 'finished') { arrived(); await held; } } })),events));
    await seen; abort.abort(); release(); await rejected; assert.deepEqual(events,[]); assert(ledger[1].type === 'finished');
    assert.equal(ledger[1].status,'complete'); assert.deepEqual(ledger[1].usage,{ status:'reported',inputTokens:18,outputTokens:37 });
  });
});
