import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountRequestContext } from '../src/account-context.ts';
import { createPlatformClient } from '../src/api.ts';
import { createPlatformEndpoints } from '../src/platform-endpoints.ts';
import { CompanionBirthController, type CompanionBirthObservation } from '../src/companion-birth-controller.ts';
import { id, receipt } from './fixtures/companion-birth.ts';
const input={name:'墨',sealChar:'墨'};
const active={kind:'active',companion:{kind:'active_companion',companionId:id(4),status:'active',bornAt:receipt.bornAt,currentRevision:1,
  identity:{name:'墨',nameOrigin:'user_typed',sealChar:'墨',inkToken:'dai',sealAssetId:id(5)},relationshipStage:'acquainting',main:receipt.main}};
const flush=async()=>{for(let i=0;i<15;i++)await new Promise<void>(r=>setImmediate(r));};
function harness(transport:(path:string,init:RequestInit)=>Promise<Response>,saved=new Map<string,string>()){
  const context=new AccountRequestContext();context.changeSession(id(1));const calls:{path:string;method:string;key:string|null;body:any}[]=[];
  const client=createPlatformClient(createPlatformEndpoints('https://api.example.invalid'),async(url,init={})=>{
    const path=new URL(String(url)).pathname.replace('/api/platform','');calls.push({path,method:init.method??'GET',key:new Headers(init.headers).get('Idempotency-Key'),body:init.body?JSON.parse(String(init.body)):null});return transport(path,init);
  },context).capture();
  const observations:CompanionBirthObservation[]=[];let now=0,sequence=0;const timers=new Map<number,{at:number;run:()=>void}>();
  const store={read:(a:string)=>saved.get(a)??null,write:(a:string,k:string)=>{saved.set(a,k);},remove:(a:string)=>{saved.delete(a);}};
  const timing={now:()=>now,isVisible:()=>true,isOnline:()=>true,operationId:()=>id(100+ ++sequence),setTimer:(run:()=>void,delay:number)=>{const token=++sequence;timers.set(token,{at:now+delay,run});return token;},clearTimer:(t:unknown)=>{timers.delete(t as number);}};
  const controller=new CompanionBirthController(client,v=>observations.push(v),timing,store);
  return {controller,context,calls,saved,store,timers,latest:()=>observations.at(-1)!,async advance(ms:number){now+=ms;for(const [k,t] of [...timers])if(t.at<=now){timers.delete(k);t.run();await flush();}}};
}
function observed(path:string){return Response.json(path==='/companion'?{kind:'not_born'}:{kind:'not_found'});}

test('mount, reconnect and StrictMode restart are read-only and create no operation',async()=>{
  const h=harness(async p=>observed(p));h.controller.start();await flush();h.controller.stop();h.controller.start();await flush();h.controller.resume();await flush();
  assert.equal(h.latest().viewer?.kind,'not_born');assert(h.calls.every(c=>c.method==='GET'));assert.equal(h.saved.size,0);h.controller.stop();
});
test('explicit confirmation freezes the original request and prevents duplicate clicks',async()=>{
  let own:any=null;const h=harness(async(p,init)=>{if(init.method==='POST'){own={...receipt,idempotencyKey:new Headers(init.headers).get('Idempotency-Key')};return Response.json({kind:'birth_result',receipt:own,replayed:false});}return Response.json(p==='/companion'?(own?active:{kind:'not_born'}):{kind:'found',receipt:own});});
  h.controller.start();await flush();const mutable={...input};assert(h.controller.submit(mutable));mutable.name='舟';assert.equal(h.controller.submit(input),false);await flush();
  assert.equal(h.calls.filter(c=>c.method==='POST').length,1);assert.deepEqual(h.calls.find(c=>c.method==='POST')!.body,input);assert.equal(h.latest().acceptance,'saved');assert.equal(h.latest().viewer?.kind,'active');h.controller.stop();
});
test('lost commit response recovers its actual own receipt without another POST',async()=>{
  let own:any=null;const h=harness(async(p,init)=>{if(init.method==='POST'){own={...receipt,idempotencyKey:new Headers(init.headers).get('Idempotency-Key')};throw new TypeError('Fictional response lost');}return Response.json(p==='/companion'?(own?active:{kind:'not_born'}):{kind:'found',receipt:own});});
  h.controller.start();await flush();h.controller.submit(input);await flush();assert.equal(h.latest().acceptance,'saved');assert.equal(h.calls.filter(c=>c.method==='POST').length,1);h.controller.stop();h.controller.start();await flush();assert.equal(h.calls.filter(c=>c.method==='POST').length,1);h.controller.stop();
});
test('absent receipt remains uncertain across a full controller remount; only explicit retry reuses the original key',async()=>{
  const transport=async(p:string,init:RequestInit)=>init.method==='POST'?Promise.reject(new TypeError('Fictional response lost')):observed(p);
  const first=harness(transport);first.controller.start();await flush();first.controller.submit(input);await flush();const key=first.calls.find(c=>c.method==='POST')!.key;assert.equal(first.latest().acceptance,'unknown');first.controller.stop();
  const next=harness(transport,first.saved);next.controller.start();await flush();assert.equal(next.latest().acceptance,'unknown');assert.equal(next.controller.submit(input),false);assert.equal(next.calls.filter(c=>c.method==='POST').length,0);
  assert(next.controller.retry(input));await flush();assert.equal(next.calls.find(c=>c.method==='POST')!.key,key);next.controller.stop();
});
test('wrong operation in a response never establishes a confirmed receipt or current room',async()=>{
  const h=harness(async(p,init)=>init.method==='POST'?Response.json({kind:'birth_result',receipt,replayed:false}):p==='/companion'?observed(p):Response.json({kind:'found',receipt}));
  h.controller.start();await flush();h.controller.submit(input);await flush();assert.equal(h.latest().acceptance,'unknown');assert.equal(h.latest().receipt,null);assert.equal(h.calls.filter(c=>c.method==='POST').length,1);h.controller.stop();
});
test('account changes clear UI observations and reject late POST completions',async()=>{
  let resolve!:(r:Response)=>void;const pending=new Promise<Response>(r=>{resolve=r});const h=harness(async(p,init)=>init.method==='POST'?pending:observed(p));
  h.controller.start();await flush();h.controller.submit(input);const key=h.calls.find(c=>c.method==='POST')!.key;h.context.changeSession(id(9));resolve(Response.json({kind:'birth_result',receipt:{...receipt,idempotencyKey:key},replayed:false}));await flush();
  assert.equal(h.latest().viewer,null);assert.equal(h.latest().receipt,null);assert.equal(h.controller.submit(input),false);assert.equal(h.timers.size,0);
});
test('exact glyph refusal allows a later explicit confirmation and retains the useful failure after a successful GET',async()=>{
  const h=harness(async(p,init)=>init.method==='POST'?Response.json({error:{code:'COMPANION_SEAL_GLYPH_UNAVAILABLE',message:'Fictional unavailable'}},{status:503}):observed(p));
  h.controller.start();await flush();h.controller.submit(input);await flush();assert.equal(h.latest().acceptance,'idle');assert.match(h.latest().error,/印章暂时无法准备/);assert.equal(h.saved.size,0);assert(h.controller.submit(input));await flush();assert.equal(h.calls.filter(c=>c.method==='POST').length,2);h.controller.stop();
});
test('quota refusals pause all requests and cannot automatically repeat a write',async()=>{
  const h=harness(async(p,init)=>init.method==='POST'?Response.json({error:{code:'REQUEST_LIMIT_REACHED',message:'Fictional quota'}},{status:429,headers:{'Retry-After':'2'}}):observed(p));
  h.controller.start();await flush();h.controller.submit(input);await flush();assert.equal(h.controller.submit(input),false);const count=h.calls.length;await h.advance(59000);assert.equal(h.calls.length,count);await h.advance(1000);assert.equal(h.calls.filter(c=>c.method==='POST').length,1);h.controller.stop();
});
test('operation persistence failure prevents a POST and leaves real read-only progress usable',async()=>{
  const h=harness(async p=>observed(p));h.store.write=()=>{throw new Error('Fictional disabled storage');};h.controller.start();await flush();assert.equal(h.controller.submit(input),false);assert(h.calls.every(c=>c.method==='GET'));assert.match(h.latest().error,/暂时无法准备/);h.controller.stop();
});
test('another-device companion is observed without inferring it from this device’s missing receipt',async()=>{
  const saved=new Map([[id(1),id(3)]]);const h=harness(async p=>p==='/companion'?Response.json(active):observed(p),saved);h.controller.start();await flush();assert.equal(h.latest().viewer?.kind,'active');assert.equal(h.latest().receipt,null);assert.equal(h.controller.submit(input),false);assert.equal(h.timers.size,0);h.controller.stop();
});
