import test from 'node:test';
import assert from 'node:assert/strict';
import { PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { AccountRequestContext } from '../src/account-context.ts';
import { createPlatformClient } from '../src/api.ts';
import { createPlatformEndpoints } from '../src/platform-endpoints.ts';
import { readCompanionBirth, readCompanionBirthReceipt, saveCompanionBirth } from '../src/companion-birth-api.ts';

import { id, receipt, png } from './fixtures/companion-birth.ts';
function harness(transport: typeof fetch) { const context = new AccountRequestContext(); context.changeSession(id(1));
  return { context, client:createPlatformClient(createPlatformEndpoints('https://api.example.invalid'),transport,context).capture() }; }


test('birth transport uses exact bodies, original operation key, fixed account and credential destination', async () => {
  const calls:any[]=[]; const h=harness(async (url,init)=>{
    calls.push({url:String(url),method:init?.method??'GET',headers:new Headers(init?.headers),body:init?.body});
    assert.equal(init?.credentials,'include'); assert.equal(init?.redirect,'error');
    return Response.json(init?.method==='POST'?{kind:'birth_result',receipt,replayed:false}:String(url).endsWith('/'+id(3))?{kind:'found',receipt}:{kind:'not_born'});
  });
  await readCompanionBirth(h.client); await readCompanionBirthReceipt(h.client,id(3));
  const result=await saveCompanionBirth(h.client,{idempotencyKey:id(3),request:{name:' 墨 ',sealChar:'墨'}});
  assert.equal(result.receipt.main.id,id(6)); assert.deepEqual(JSON.parse(calls[2].body),{name:'墨',sealChar:'墨'});
  assert.equal(calls[2].headers.get('Idempotency-Key'),id(3));assert(calls.every(c=>c.headers.get(PLATFORM_ACCOUNT_HEADER)===id(1)));
  assert.equal(calls[0].url,'https://api.example.invalid/api/platform/companion');
});
test('cross-linked and wrong-operation receipts cannot confirm a birth', async () => {
  for(const corrupt of [{...receipt,idempotencyKey:id(9)},{...receipt,main:{...receipt.main,id:id(9)}}]){
    const h=harness(async()=>Response.json({kind:'found',receipt:corrupt}));
    await assert.rejects(readCompanionBirthReceipt(h.client,id(3)));
  }
});
test('seal PNG is fetched with current account headers and bounded bytes, never a public/native credential URL', async()=>{
  let target='';const h=harness(async(url,init)=>{target=String(url);assert.equal(new Headers(init?.headers).get(PLATFORM_ACCOUNT_HEADER),id(1));assert.equal(init?.credentials,'include');assert.equal(init?.redirect,'error');
    return new Response(png,{headers:{'Content-Type':'image/png','Content-Length':String(png.length)}});});
  const blob=await h.client.readCompanionSealPNG(id(5));assert.equal(blob.type,'image/png');assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),png);
  assert.equal(target,'https://api.example.invalid/api/platform/companion/seals/'+id(5)+'/png');assert(!target.includes('?'));
  await assert.rejects(h.client.readCompanionSealPNG('https://other.example.invalid/image'));assert.equal(target,'https://api.example.invalid/api/platform/companion/seals/'+id(5)+'/png');
});
test('malformed, excessive and wrong-type image responses reject and cancel their stream',async()=>{
  for(const fixture of [{bytes:png,type:'image/svg+xml'},{bytes:new Uint8Array(32769),type:'image/png'},{bytes:new Uint8Array(40),type:'image/png',closed:true},{bytes:png,type:'image/png',declared:'90000'}]){
    let cancelled=0;const h=harness(async()=>new Response(new ReadableStream({start(c){c.enqueue(fixture.bytes);if(fixture.closed)c.close();},cancel(){cancelled++;}}),{headers:{'Content-Type':fixture.type,...(fixture.declared?{'Content-Length':fixture.declared}:{})}}));
    await assert.rejects(h.client.readCompanionSealPNG(id(5)));assert.equal(cancelled,fixture.closed?0:1);
  }
});
test('account change cancels pending image reads and rejects transports that ignore AbortSignal',async()=>{
  let finish!:(r:Response)=>void;const pending=new Promise<Response>(r=>{finish=r});let calls=0;
  const h=harness(async()=>{calls++;return pending;});const work=h.client.readCompanionSealPNG(id(5));
  h.context.changeSession(id(8));finish(new Response(png,{headers:{'Content-Type':'image/png'}}));
  await assert.rejects(work,{name:'AbortError'});await assert.rejects(h.client.readCompanionSealPNG(id(5)),{name:'AbortError'});assert.equal(calls,1);
});
test('real account mismatch or expired authentication invalidates the image capture',async()=>{
  for(const [status,code] of [[401,'AUTHENTICATION_REQUIRED'],[409,'ACCOUNT_CONTEXT_CHANGED']] as const){
    const h=harness(async()=>Response.json({error:{code,message:'Fictional refusal'}},{status}));
    await assert.rejects(h.client.readCompanionSealPNG(id(5)));assert.equal(h.client.isCurrent(),false);
  }
});
