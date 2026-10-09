import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PLATFORM_ACCOUNT_HEADER,parseSharedMemoryRecord } from '@companion/platform-contracts';
import { createProviderRuntime } from '@companion/ai-core';
import { buildApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { hashPassword } from '../src/auth.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
const origin='https://fictional-memory.example.invalid',prefix='/api/platform/memories',password='Fictional-memory-password-123';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,system:Awaited<ReturnType<typeof buildApp>>,calls=0;
before(async()=>{f=await createCompanionNameSafetyFixture();system=await buildApp({db:f.db,legalBundle:FICTIONAL_LEGAL,config:{...readConfig(),dataCrypto:f.crypto,requireVerifiedEmail:true,allowedOrigins:new Set([origin])},enableQueue:false,
 runtime:createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'0'},fetch:async()=>{calls++;throw Error('No external provider is allowed');}})});});
after(async()=>{await system?.app.close();assert.equal(calls,0);await f?.close();});
async function actor(){const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,await hashPassword(password)]);
 const r=await system.app.inject({method:'POST',url:'/api/platform/auth/login',headers:{origin},payload:{email:who.userId+'@example.invalid',password}});assert.equal(r.statusCode,200);
 const raw=r.headers['set-cookie'],cookie=(Array.isArray(raw)?raw[0]:raw)!.split(';')[0];return {id:who.userId,headers:{origin,cookie,[PLATFORM_ACCOUNT_HEADER]:who.userId}};}
const command=()=>({operationId:randomUUID(),content:'Fictional explicitly confirmed preference',category:'communication',sensitivity:'normal',usePolicy:'normal',speakerScope:null,validUntil:null});

test('actual authenticated account-bound HTTP save, read, edit, use observation and delete/undo preserve server revisions and no-store',async()=>{
 const a=await actor(),payload=command();const created=await system.app.inject({method:'POST',url:prefix,headers:a.headers,payload});assert.equal(created.statusCode,201,created.body);
 const first=parseSharedMemoryRecord(created.json().memory);assert.equal(first.ownerId,a.id);assert.equal(first.revision,1);assert.equal(created.headers['cache-control'],'private, no-store');
 const again=await system.app.inject({method:'POST',url:prefix,headers:a.headers,payload});assert.equal(again.statusCode,200);assert.equal(again.json().operation.replayed,true);
 const get=await system.app.inject({url:prefix+'/'+first.id,headers:a.headers});assert.equal(get.statusCode,200);assert.deepEqual(get.json().memory,first);
 const changed=await system.app.inject({method:'PATCH',url:prefix+'/'+first.id,headers:a.headers,payload:{operationId:randomUUID(),expectedRevision:1,usePolicy:'only_if_user_raises'}});assert.equal(changed.statusCode,200);assert.equal(changed.json().memory.revision,2);
 const uses=await system.app.inject({url:prefix+'/'+first.id+'/uses',headers:a.headers});assert.equal(uses.statusCode,200);assert.deepEqual(uses.json(),{memoryId:first.id,uses:[]});
 const removed=await system.app.inject({method:'DELETE',url:prefix+'/'+first.id,headers:a.headers,payload:{operationId:randomUUID(),expectedRevision:2}});assert.equal(removed.statusCode,200);
 assert.equal((await system.app.inject({url:prefix,headers:a.headers})).json().memories.length,0);
 const restore=await system.app.inject({method:'POST',url:prefix+'/'+first.id+'/undo',headers:a.headers,payload:{operationId:randomUUID(),expectedRevision:3,deletionOperationId:removed.json().operation.id}});assert.equal(restore.statusCode,200);assert.equal(restore.json().memory.revision,4);
});

test('real HTTP legacy review requires explicit category and sensitivity, and cannot accept a fabricated source or approval time',async()=>{
 const a=await actor(),id=randomUUID();await f.db.query('INSERT INTO platform_memories(id,user_id,content) VALUES($1,$2,$3)',[id,a.id,'Fictional old needs review']);
 const list=await system.app.inject({url:prefix,headers:a.headers});assert.equal(list.statusCode,200);assert.equal(list.json().memories[0].kind,'needs_review');
 for(const extra of [{},{category:'goal_preference'},{category:'goal_preference',sensitivity:'normal',source:'companion_proposed'},{category:'goal_preference',sensitivity:'normal',confirmedAt:new Date().toISOString()}]){
 const r=await system.app.inject({method:'POST',url:prefix+'/'+id+'/confirm',headers:a.headers,payload:{operationId:randomUUID(),expectedRevision:0,...extra}});assert.equal(r.statusCode,400);
 }
 const ok=await system.app.inject({method:'POST',url:prefix+'/'+id+'/confirm',headers:a.headers,payload:{operationId:randomUUID(),expectedRevision:0,category:'goal_preference',sensitivity:'restricted',editedContent:'Fictional owner-reviewed fact'}});assert.equal(ok.statusCode,200);assert.equal(ok.json().memory.sensitivity,'restricted');
 assert.equal(calls,0);
});

test('foreign account, stale window identity, bad query and CSRF origin cannot disclose or write memory records',async()=>{
 const a=await actor(),b=await actor(),create=await system.app.inject({method:'POST',url:prefix,headers:a.headers,payload:command()}),id=create.json().memory.id;
 assert.equal((await system.app.inject({url:prefix+'/'+id,headers:b.headers})).statusCode,404);
 assert.equal((await system.app.inject({method:'DELETE',url:prefix+'/'+id,headers:b.headers,payload:{operationId:randomUUID(),expectedRevision:1}})).statusCode,404);
 assert.equal((await system.app.inject({url:prefix,headers:{...b.headers,[PLATFORM_ACCOUNT_HEADER]:a.id}})).statusCode,409);
 assert.equal((await system.app.inject({url:prefix+'?userId='+b.id,headers:a.headers})).statusCode,400);
 assert.equal((await system.app.inject({method:'POST',url:prefix,headers:{...a.headers,origin:'https://evil.invalid'},payload:command()})).statusCode,403);
 assert.equal((await system.app.inject({url:prefix})).statusCode,401);
});

test('operation observation authenticates the original receipt and current state without writing or leaking deleted content',async()=>{
 const a=await actor(),b=await actor(),payload=command();
 const saved=await system.app.inject({method:'POST',url:prefix,headers:a.headers,payload});assert.equal(saved.statusCode,201);
 const id=saved.json().memory.id,url=prefix+'/operations/'+payload.operationId;
 const snapshot=async()=>({records:(await f.db.query('SELECT * FROM platform_memories WHERE user_id=$1',[a.id])).rows,
  operations:(await f.db.query('SELECT * FROM platform_memory_operations WHERE user_id=$1 ORDER BY applied_revision',[a.id])).rows,
  events:(await f.db.query('SELECT * FROM platform_memory_events WHERE user_id=$1 ORDER BY id',[a.id])).rows});
 const before=await snapshot(),seen=await system.app.inject({url,headers:a.headers});
 assert.equal(seen.statusCode,200,seen.body);assert.equal(seen.headers['cache-control'],'private, no-store');
 assert.equal(seen.json().operation.id,payload.operationId);assert.deepEqual(seen.json().memory,saved.json().memory);assert.deepEqual(await snapshot(),before);
 const foreign=await system.app.inject({url,headers:b.headers}),missing=await system.app.inject({url:prefix+'/operations/'+randomUUID(),headers:b.headers});
 assert.equal(foreign.statusCode,404);assert.deepEqual(foreign.json(),missing.json());
 assert.equal((await system.app.inject({url,headers:{...a.headers,[PLATFORM_ACCOUNT_HEADER]:b.id}})).statusCode,409);
 assert.equal((await system.app.inject({url:url+'?ownerId='+a.id,headers:a.headers})).statusCode,400);
 assert.equal((await system.app.inject({url})).statusCode,401);
 const edit=await system.app.inject({method:'PATCH',url:prefix+'/'+id,headers:a.headers,payload:{operationId:randomUUID(),expectedRevision:1,content:'Fictional later content'}});assert.equal(edit.statusCode,200);
 const later=await system.app.inject({url,headers:a.headers});assert.equal(later.json().memory.revision,2);assert.equal(later.json().operation.appliedRevision,1);
 const deletion=await system.app.inject({method:'DELETE',url:prefix+'/'+id,headers:a.headers,payload:{operationId:randomUUID(),expectedRevision:2}});assert.equal(deletion.statusCode,200);
 const removed=await system.app.inject({url,headers:a.headers});assert.equal(removed.statusCode,200);assert.equal(removed.json().memory,null);assert.equal(removed.json().removal.purged,false);assert.equal(removed.json().removal.revision,3);
 assert(!removed.body.includes(payload.content));assert(!removed.body.includes('Fictional later content'));assert(!removed.body.includes('commandDigest'));
});
