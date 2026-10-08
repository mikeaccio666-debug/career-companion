import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createProviderRuntime } from '@companion/ai-core';
import { PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { buildApp } from '../src/app.ts';
import { hashPassword, tokenHash, type FixedSessionContext } from '../src/auth.ts';
import { readConfig } from '../src/config.ts';
import { createPrebirthFixture, withPrebirthLoopback, type PrebirthFixture } from './fixtures/companion-prebirth.ts';
import { readyBirth } from './fixtures/companion-birth.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
import { ApiError } from '../src/errors.ts';

// Actual HTTP authentication, isolated PostgreSQL and native birth persistence.
// Every identity, credential, review and glyph is fictional QA input. Provider
// calls after preparation are forbidden; no third-party endpoint is contacted.
const origin='https://fictional-birth-http.example.invalid',prefix='/api/platform';
const password='Fictional-birth-HTTP-password-only';
let fixture:PrebirthFixture,system:Awaited<ReturnType<typeof buildApp>>,providerCalls=0;
type Actor={who:FixedSessionContext;cookie:string;email:string};
before(async()=>{
  fixture=await createPrebirthFixture();
  const runtime=createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'1',OPENAI_API_KEY:'fictional-no-provider-call',
    OPENAI_CHAT_MODEL:'fictional-chat',OPENAI_REALTIME_MODEL:'fictional-realtime'},
    fetch:async()=>{providerCalls++;throw new Error('No provider call is permitted in birth HTTP tests.');}});
  const config={...readConfig(),dataCrypto:fixture.crypto,requireVerifiedEmail:true,workbenchEnabled:true,
    allowedOrigins:new Set([origin]),companionIdentityBundlePath:undefined,companionIdentityReviewPath:undefined,
    companionSealGlyphs:undefined,modelRoutes:{chat:{provider:'openai'},agent:{provider:'openai'},realtime:{provider:'openai'}}};
  system=await buildApp({db:fixture.db,config,legalBundle:FICTIONAL_LEGAL,runtime,enableQueue:false});
});
after(async()=>{try{if(system)await system.app.close();}finally{if(fixture)await fixture.close();}});

async function login(userId:string,email:string):Promise<Actor>{
  const response=await system.app.inject({method:'POST',url:prefix+'/auth/login',headers:{origin},payload:{email,password}});
  assert.equal(response.statusCode,200);
  const header=response.headers['set-cookie'],setCookie=Array.isArray(header)?header[0]:header;
  assert(typeof setCookie==='string');const cookie=setCookie.split(';')[0],raw=cookie.slice(cookie.indexOf('=')+1);
  return {who:{userId,tokenHash:tokenHash(raw)},cookie,email};
}
async function actor():Promise<Actor>{
  const who=await fixture.actor(),email=who.userId+'@example.invalid';
  await fixture.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,await hashPassword(password)]);
  return login(who.userId,email);
}
function headers(who:Actor,extra:Record<string,string|string[]>={}){return {origin,cookie:who.cookie,[PLATFORM_ACCOUNT_HEADER]:who.who.userId,...extra};}
async function birthRows(userId:string){
  const rows:Record<string,unknown>={};
  for(const table of ['platform_companion_birth_receipts','platform_companion_birth_assets','platform_conversations','platform_jobs','platform_goal_plans','platform_usage','platform_runtime_leases'])
    rows[table]=(await fixture.db.query(`SELECT * FROM ${table} WHERE user_id=$1 ORDER BY id`,[userId])).rows;
  rows.messages=(await fixture.db.query('SELECT m.* FROM platform_messages m JOIN platform_conversations c ON c.id=m.conversation_id WHERE c.user_id=$1 ORDER BY m.id',[userId])).rows;
  return rows;
}

test('birth HTTP authenticates the actual session and account, rejects caller authority and ambiguous keys before creating any birth',async()=>{
  const who=await actor(),foreign=await actor(),key=randomUUID(),body={name:'Juno',sealChar:'如'},before=await birthRows(who.who.userId);
  assert.equal((await system.app.inject({method:'POST',url:prefix+'/companion/birth',headers:{origin,'idempotency-key':key},payload:body})).statusCode,401);
  const mismatch=await system.app.inject({method:'POST',url:prefix+'/companion/birth',headers:headers(who,{[PLATFORM_ACCOUNT_HEADER]:foreign.who.userId,'idempotency-key':key}),payload:body});
  assert.equal(mismatch.statusCode,409);assert.equal(mismatch.json().error.code,'ACCOUNT_CONTEXT_CHANGED');
  const invalidKeys:Record<string,string|string[]>[]=[{}, {'idempotency-key':[key,key]}, {'idempotency-key':key+', '+key}, {'idempotency-key':key.toUpperCase()}];
  for(const extra of invalidKeys){
    const response=await system.app.inject({method:'POST',url:prefix+'/companion/birth',headers:headers(who,extra),payload:body});
    assert.equal(response.statusCode,400);assert.equal(response.json().error.code,'INVALID_INPUT');
  }
  for(const supplied of [{...body,persona:'Fictional caller-owned persona'},{...body,userId:foreign.who.userId},{...body,voicePreset:'fictional'},{...body,idempotencyKey:key}]){
    assert.equal((await system.app.inject({method:'POST',url:prefix+'/companion/birth',headers:headers(who,{'idempotency-key':key}),payload:supplied})).statusCode,400);
  }
  const notReady=await system.app.inject({method:'POST',url:prefix+'/companion/birth',headers:headers(who,{'idempotency-key':key}),payload:body});
  assert.equal(notReady.statusCode,400);assert.equal(notReady.json().error.code,'PERSONA_NOT_ACCEPTED');
  assert.deepEqual(await birthRows(who.who.userId),before);assert.equal(providerCalls,0);
});

test('birth HTTP current state and receipt reads are account scoped and remain available without current email, terms, policy or glyph configuration',async()=>{
  const who=await actor(),foreign=await actor(),key=randomUUID();
  const notBorn=await system.app.inject({url:prefix+'/companion',headers:headers(who)});
  assert.equal(notBorn.statusCode,200);assert.deepEqual(notBorn.json(),{kind:'not_born'});
  assert.equal(notBorn.headers['cache-control'],'private, no-store');
  const absent=await system.app.inject({url:prefix+'/companion/birth/receipts/'+key,headers:headers(who)});
  assert.equal(absent.statusCode,200);assert.deepEqual(absent.json(),{kind:'not_found'});
  for(const url of [prefix+'/companion?userId='+foreign.who.userId,prefix+'/companion/birth/receipts/'+key+'?ownerId='+foreign.who.userId])
    assert.equal((await system.app.inject({url,headers:headers(who)})).statusCode,400);
  await withPrebirthLoopback(async(runtime,requests)=>{
    const f=await readyBirth(fixture,runtime,{who:who.who}),created=await f.service.birth(who.who,f.body,f.key);
    assert.equal(created.replayed,false);const stable=await birthRows(who.who.userId);
    await fixture.db.query('UPDATE platform_users SET auth_version=auth_version+1,email_verified_at=NULL WHERE id=$1',[who.who.userId]);
    await fixture.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[who.who.userId]);
    const fresh=await login(who.who.userId,who.email);
    const read=await system.app.inject({url:prefix+'/companion',headers:headers(fresh)});
    assert.equal(read.statusCode,200);assert.equal(read.json().kind,'active');
    const saved=await system.app.inject({url:prefix+'/companion/birth/receipts/'+f.key,headers:headers(fresh)});
    assert.equal(saved.statusCode,200);assert.deepEqual(saved.json(),{kind:'found',receipt:created.receipt});
    const replay=await system.app.inject({method:'POST',url:prefix+'/companion/birth',headers:headers(fresh,{'idempotency-key':f.key}),payload:f.body});
    assert.equal(replay.statusCode,200);assert.deepEqual(replay.json(),{...created,replayed:true});assert.equal(replay.headers['cache-control'],'private, no-store');
    const other=await system.app.inject({url:prefix+'/companion/birth/receipts/'+f.key,headers:headers(foreign)});
    assert.equal(other.statusCode,200);assert.deepEqual(other.json(),{kind:'not_found'});
    assert.equal((await system.app.inject({url:prefix+'/companion',headers:headers(who)})).statusCode,401);
    assert.deepEqual(await birthRows(who.who.userId),stable);assert.equal(requests.length,2);assert.equal(providerCalls,0);
  });
});

test('a genuinely born main cannot enter old chat, voice, delete or generic plan execution even with the workbench enabled',async()=>{
  await withPrebirthLoopback(async(runtime,requests)=>{
    const who=await actor(),f=await readyBirth(fixture,runtime,{who:who.who}),created=await f.service.birth(who.who,f.body,f.key),id=created.receipt.main.id;
    const before=await birthRows(who.who.userId),plan={title:'Fictional old plan',goal:'Fictional task only',steps:[{kind:'task',title:'Fictional browser',task:{kind:'browser',provider:'browser',prompt:'Fictional no-op'}}]};
    for(const [method,url,payload] of [
      ['GET',prefix+'/conversations/'+id,undefined],['DELETE',prefix+'/conversations/'+id,undefined],
      ['POST',prefix+'/conversations/'+id+'/messages',{content:'Fictional first reply'}],
      ['GET',prefix+'/conversations/'+id+'/voice-records',undefined],
      ['POST',prefix+'/voice/session',{conversationId:id}],
      ['POST',prefix+'/conversations/'+id+'/goal-plans',plan],
    ] as const){
      const response=await system.app.inject({method,url,headers:headers(who),...(payload===undefined?{}:{payload})});
      assert.equal(response.statusCode,409,url);assert.equal(response.json().error.code,'COMPANION_ROOM_REQUIRED',url);
    }
    await assert.rejects(system.goalPlans.create(who.who.userId,id,plan),error=>error instanceof ApiError&&error.code==='COMPANION_ROOM_REQUIRED');
    const listed=await system.app.inject({url:prefix+'/conversations',headers:headers(who)});
    assert.equal(listed.statusCode,200);assert.deepEqual(listed.json(),{conversations:[]});
    assert.deepEqual(await birthRows(who.who.userId),before);assert.equal(requests.length,2);assert.equal(providerCalls,0);
  });
});

test('saved PNG and SVG HTTP delivery authenticates the owner and serves original private bytes after fresh login without current write admission',async()=>{
  await withPrebirthLoopback(async(runtime,requests)=>{
    const who=await actor(),foreign=await actor(),f=await readyBirth(fixture,runtime,{who:who.who});
    const created=await f.service.birth(who.who,f.body,f.key),assetId=created.receipt.identity.sealAssetId;
    const row=(await fixture.db.query('SELECT * FROM platform_companion_birth_assets WHERE id=$1 AND user_id=$2',[assetId,who.who.userId])).rows[0];
    const binding={table:'platform_companion_birth_assets',rowId:assetId,ownerId:who.who.userId,revision:1};
    const expected={
      svg:Buffer.from(fixture.crypto.openUtf8(row.svg_ciphertext,{...binding,column:'svg_ciphertext'}),'utf8'),
      png:Buffer.from(fixture.crypto.openUtf8(row.png_base64_ciphertext,{...binding,column:'png_base64_ciphertext'}),'base64'),
    };
    const before=await birthRows(who.who.userId),url=prefix+'/companion/seals/'+assetId;
    assert.equal((await system.app.inject({url:url+'/png'})).statusCode,401);
    assert.equal((await system.app.inject({url:url+'/png',headers:headers(foreign)})).statusCode,404);
    assert.equal((await system.app.inject({url:prefix+'/companion/seals/'+randomUUID()+'/png',headers:headers(who)})).statusCode,404);
    assert.equal((await system.app.inject({url:url+'/png',headers:headers(who,{[PLATFORM_ACCOUNT_HEADER]:foreign.who.userId})})).statusCode,409);
    for(const target of [url+'/jpeg',url+'/png?ownerId='+foreign.who.userId,prefix+'/companion/seals/not-a-uuid/png'])
      assert.equal((await system.app.inject({url:target,headers:headers(who)})).statusCode,400);
    assert.equal((await system.app.inject({url:url+'/png',headers:headers(who,{range:'bytes=0-10'})})).statusCode,400);
    await fixture.db.query('UPDATE platform_users SET auth_version=auth_version+1,email_verified_at=NULL WHERE id=$1',[who.who.userId]);
    await fixture.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[who.who.userId]);
    const fresh=await login(who.who.userId,who.email);
    for(const format of ['png','svg'] as const){
      const image=await system.app.inject({url:url+'/'+format,headers:headers(fresh)});
      assert.equal(image.statusCode,200);assert.deepEqual(image.rawPayload,expected[format]);
      assert.match(String(image.headers['content-type']),format==='png'?/^image\/png/:/^image\/svg\+xml/);
      assert.equal(image.headers['cache-control'],'private, no-store');
      assert.equal(image.headers['x-content-type-options'],'nosniff');
      assert.equal(image.headers['content-security-policy'],"default-src 'none'; sandbox");
    }
    assert.equal((await system.app.inject({url:url+'/png',headers:headers(who)})).statusCode,401);
    assert.deepEqual(await birthRows(who.who.userId),before);assert.equal(requests.length,2);assert.equal(providerCalls,0);
  });
});
