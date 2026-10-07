import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProviderRuntime } from '@companion/ai-core';
import type { ModelStepContext, ProviderStatus } from '@companion/platform-contracts';
import { readConfig } from '../src/config.ts';
import { ApiError } from '../src/errors.ts';
import { MODEL_ROUTE_PURPOSES, modelRouteAvailability, resolveModelRoute } from '../src/model-routing.ts';

const configuration = { PLATFORM_SAFETY_CLASSIFY_PROVIDER:'openai',PLATFORM_CHAT_PROVIDER:'openai' };
const providerEnv = { PLATFORM_ALLOW_PROVIDER_CALLS:'1',OPENAI_API_KEY:'fictional-only',OPENAI_CHAT_MODEL:'fictional-chat',OPENAI_SAFETY_CLASSIFY_MODEL:'fictional-safety' };
const schema = { type:'object',properties:{ level:{ type:'string',enum:['L0','L1','L2'] } },required:['level'],additionalProperties:false };
function status(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return { id:'openai',name:'Fictional provider',enabled:true,keyConfigured:true,capabilities:['chat','agent'],models:['fictional-chat'],modelsByCapability:{ chat:['fictional-chat'],agent:['fictional-chat'] },modelsByPurpose:{ safety_classify:['fictional-safety'] },envVariables:[],...overrides };
}
const catalogue = (providers: ProviderStatus[]) => ({ capabilities:() => providers });
function unavailable(run: () => unknown) {
  assert.throws(run,error => error instanceof ApiError && error.status === 503 && error.code === 'MODEL_ROUTE_UNAVAILABLE' && error.publicMessage === 'The requested capability is unavailable.');
}

test('safety purpose resolves independently and does not enter public five-purpose availability',() => {
  const config = readConfig(configuration),runtime = catalogue([status()]);
  assert.deepEqual(MODEL_ROUTE_PURPOSES,['chat','agent','realtime','transcription','speech']);
  assert.deepEqual(resolveModelRoute(config,runtime,'safety_classify'),{ purpose:'safety_classify',provider:'openai',model:'fictional-safety' });
  assert.deepEqual(resolveModelRoute(config,runtime,'chat'),{ purpose:'chat',provider:'openai',model:'fictional-chat' });
  assert.deepEqual(modelRouteAvailability(config,runtime),{ chat:true,agent:false,realtime:false,transcription:false,speech:false });
  assert.equal(Object.hasOwn(modelRouteAvailability(config,runtime),'safety_classify'),false);
});

test('safety route requires its explicit binding and never borrows flat, legacy or chat models',() => {
  unavailable(() => resolveModelRoute(readConfig({ PLATFORM_CHAT_PROVIDER:'openai' }),catalogue([status()]),'safety_classify'));
  for (const metadata of [undefined,{}, { safety_classify:[] },{ safety_classify:['fictional-one','fictional-two'] },{ safety_classify:['fictional-same','fictional-same'] }]) {
    unavailable(() => resolveModelRoute(readConfig(configuration),catalogue([status({ modelsByPurpose:metadata })]),'safety_classify'));
  }
  unavailable(() => resolveModelRoute(readConfig(configuration),catalogue([status({ modelsByPurpose:undefined,modelsByCapability:undefined,models:['fictional-flat'] })]),'safety_classify'));
});

test('safety route rejects disabled, ambiguous and compatible providers even with explicit safety metadata',() => {
  const config = readConfig(configuration);
  for (const providers of [[],[status({ enabled:false })],[status({ capabilities:['speech'] })],[status(),status()]]) unavailable(() => resolveModelRoute(config,catalogue(providers),'safety_classify'));
  for (const provider of ['openrouter','ark','ollama']) unavailable(() => resolveModelRoute(readConfig({ PLATFORM_SAFETY_CLASSIFY_PROVIDER:provider }),catalogue([status({ id:provider })]),'safety_classify'));
});

test('safety model metadata rejects empty, control, whitespace and oversized values',() => {
  for (const model of ['', ' ', ' fictional-model', 'fictional-model ', 'fictional\nmodel', 'fictional-model\r\n', 'fictional\x7fmodel', 'x'.repeat(151)]) unavailable(() => resolveModelRoute(readConfig(configuration),catalogue([status({ modelsByPurpose:{ safety_classify:[model] } })]),'safety_classify'));
  assert.equal(resolveModelRoute(readConfig(configuration),catalogue([status({ modelsByPurpose:{ safety_classify:['m'.repeat(150)] } })]),'safety_classify').model.length,150);
});

test('safety metadata must be an actual explicit purpose map rather than an array or inherited property',() => {
  const array = Object.assign([],{ safety_classify:['fictional-safety'] });
  const inherited = Object.create({ safety_classify:['fictional-safety'] });
  for (const invalid of [array,inherited]) unavailable(() => resolveModelRoute(readConfig(configuration),catalogue([status({ modelsByPurpose:invalid as ProviderStatus['modelsByPurpose'] })]),'safety_classify'));
  let accesses = 0;
  const entryGetter = Object.defineProperty({},'safety_classify',{ enumerable:true,get() { accesses++; return ['fictional-safety']; } });
  const mapGetter = Object.defineProperty(status(),'modelsByPurpose',{ enumerable:true,get() { accesses++; return { safety_classify:['fictional-safety'] }; } });
  for (const provider of [status({ modelsByPurpose:entryGetter }),mapGetter]) unavailable(() => resolveModelRoute(readConfig(configuration),catalogue([provider]),'safety_classify'));
  assert.equal(accesses,0);
  const explicitNullRecord = Object.assign(Object.create(null),{ safety_classify:['fictional-safety'] });
  assert.equal(resolveModelRoute(readConfig(configuration),catalogue([status({ modelsByPurpose:explicitNullRecord })]),'safety_classify').model,'fictional-safety');
});

test('actual server route feeds the independently configured runtime model over loopback HTTP',async () => {
  const bodies: Record<string,any>[] = [];
  const server = http.createServer(async (request,reply) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk); bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    reply.writeHead(200,{ 'content-type':'text/event-stream' });
    reply.end(`data: ${JSON.stringify({ type:'response.completed',response:{ status:'completed',output:[{ type:'message',role:'assistant',status:'completed',content:[{ type:'output_text',text:'{"level":"L0"}' }] }],usage:{ input_tokens:9,output_tokens:7 } } })}\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve)); const address = server.address(); assert(address && typeof address === 'object');
  const runtime = createProviderRuntime({ env:providerEnv,fetch:(url,init) => { assert.equal(new URL(String(url)).origin,'https://api.openai.com'); return fetch(`http://127.0.0.1:${address.port}/v1/responses`,init); } });
  try {
    const route = resolveModelRoute(readConfig(configuration),runtime,'safety_classify');
    const context: ModelStepContext = { invocation:{},purpose:route.purpose,responseFormat:{ name:'fictional_safety',schema },tools:[],toolChoice:'none',limits:{ maxOutputTokens:100 },callIndex:1,timeoutMs:700,requestAdmission:async (launch,signal) => launch(signal ?? new AbortController().signal) };
    const step = runtime.streamModelStep!({ provider:route.provider,model:route.model,mode:'chat',messages:[{ role:'user',content:'Fictional intake text.' }] },context);
    while (!(await step.next()).done) { /* Server collects validated output only. */ }
    assert.equal(bodies.length,1); assert.equal(bodies[0].model,'fictional-safety'); assert.equal(bodies[0].max_output_tokens,100); assert.deepEqual(bodies[0].tools,[]); assert.equal(bodies[0].text.format.strict,true);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('actual unavailable configurations and compatible routes stop before HTTP',() => {
  let calls = 0;
  const forbidden: typeof fetch = async () => { calls++; throw new Error('Fictional request must not launch.'); };
  for (const [configEnv,runtimeEnv] of [
    [{},providerEnv],
    [configuration,{ ...providerEnv,OPENAI_SAFETY_CLASSIFY_MODEL:'' }],
    [configuration,{ ...providerEnv,OPENAI_SAFETY_CLASSIFY_MODEL:'fictional-safety\n' }],
    [configuration,{ ...providerEnv,PLATFORM_ALLOW_PROVIDER_CALLS:'0' }],
    [configuration,{ ...providerEnv,OPENAI_API_KEY:'' }],
    [{ PLATFORM_SAFETY_CLASSIFY_PROVIDER:'openrouter' },{ ...providerEnv,OPENROUTER_API_KEY:'fictional-only',OPENROUTER_CHAT_MODEL:'fictional-chat' }],
    [{ PLATFORM_SAFETY_CLASSIFY_PROVIDER:'ollama' },{ ...providerEnv,OLLAMA_BASE_URL:'http://127.0.0.1:11434/v1',OLLAMA_CHAT_MODEL:'fictional-chat' }],
  ] as const) unavailable(() => resolveModelRoute(readConfig(configEnv),createProviderRuntime({ env:runtimeEnv,fetch:forbidden }),'safety_classify'));
  assert.equal(calls,0);
});
