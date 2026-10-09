import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {Database} from '../src/database.ts';
import {hashPassword,type FixedSessionContext} from '../src/auth.ts';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {AccountReauthentication} from '../src/account-reauthentication.ts';
import {SharedMemories} from '../src/shared-memories.ts';
import {SharedMemorySafety} from '../src/shared-memory-safety.ts';
import {purgeExpiredMemoryDeletions} from '../src/memory-retention.ts';
import {FICTIONAL_LEGAL} from './fixtures/student-entry.ts';
import {createCompanionNameSafetyFixture} from './fixtures/companion-name-safety.ts';
import {createMemorySafetyLoopback,MEMORY_PROFILE,memoryReply} from './fixtures/shared-memory-safety.ts';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,memories:SharedMemories,loop:Awaited<ReturnType<typeof createMemorySafetyLoopback>>,disabled:SharedMemorySafety,encoded:string;
const password='Fictional-only-memory-export-password';
before(async()=>{f=await createCompanionNameSafetyFixture();memories=new SharedMemories(f.db,f.config,FICTIONAL_LEGAL);loop=await createMemorySafetyLoopback(f,memories);
 disabled=new SharedMemorySafety(f.db,loop.config,FICTIONAL_LEGAL,memories,loop.makeRuntime({PLATFORM_ALLOW_PROVIDER_CALLS:'0'}),MEMORY_PROFILE);encoded=await hashPassword(password);});
after(async()=>{try{await loop?.close();}finally{await f?.close();}});
async function actor(){const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,encoded]);return who;}
const command=(content='Fictional confirmed preference')=>({operationId:randomUUID(),content,category:'goal_preference',sensitivity:'normal',usePolicy:'normal',speakerScope:null,validUntil:null});
const proof=async(who:FixedSessionContext)=>(await new AccountReauthentication(f.db).verify(who,{purpose:'account_export',password})).token;
const capture=async(who:FixedSessionContext)=>new AccountCoreExport(f.db,f.config).capture(who,await proof(who));
async function risk(who:FixedSessionContext){const saved=await memories.mutate(who,'create',null,command('Fictional Synthetic high marker'));await disabled.runCurrent(who,saved.memory.id);return saved;}
const query=(sql:string,kind='sources')=>sql.startsWith(`SELECT * FROM platform_memory_safety_${kind} WHERE user_id=`);
function instrument(change:(sql:string,rows:Record<string,any>[],client:PoolClient)=>void|Promise<void>):Database{
 return {withBoundedTransaction:<T>(run:(client:PoolClient)=>Promise<T>,options?:{readOnly?:boolean;timeoutMs?:number})=>f.db.withBoundedTransaction(client=>run(new Proxy(client,{get(target,key){
  if(key==='query')return async(sql:string,values:unknown[])=>{const result=await target.query(sql,values);await change(sql,result.rows,target);return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }})),options)} as Database;
}
async function rows(who:FixedSessionContext){const result:unknown[]=[];for(const table of ['platform_memories','platform_memory_safety_sources','platform_memory_safety_blocks','platform_safety_model_usage'])
 result.push((await f.db.query(`SELECT * FROM ${table} WHERE user_id=$1 ORDER BY 1`,[who.userId])).rows);return result;}
const unused=async(who:FixedSessionContext)=>assert((await f.db.query("SELECT consumed_at FROM platform_account_reauthentications WHERE user_id=$1 AND purpose='account_export'",[who.userId])).rows.every(r=>r.consumed_at===null));

test('exports actual full classification and keyword-only blocks privately without model calls or current policy grants',async()=>{
 const who=await actor(),other=await actor(),a=await memories.mutate(who,'create',null,command());await loop.safety.runCurrent(who,a.memory.id);await risk(who);await risk(other);
 const before=await rows(who),calls=loop.bodies.length,sqls:string[]=[],token=await proof(who),data=await new AccountCoreExport(instrument(sql=>{sqls.push(sql);}),f.config).capture(who,token);
 const sources=data.sections.memorySafetySources as any[],blocks=data.sections.memorySafetyBlocks as any[];
 assert.equal(sources.length,2);assert.equal(blocks.length,1);assert.deepEqual(sources.find(x=>x.memoryId===a.memory.id).result.decision,{level:'L0',mode:'full'});
 assert.deepEqual(blocks[0].decision,{level:'L2',mode:'keyword_only'});assert.equal(blocks[0].modelUsage,null);assert(Object.isFrozen(blocks[0].source));
 assert.equal(data.includedTables.length,147);assert.equal(data.remainingTables.length,23);assert.equal(data.complete,false);
 assert(data.includedTables.includes('platform_memory_safety_sources'));assert(data.includedTables.includes('platform_memory_safety_blocks'));
 const text=JSON.stringify(data);for(const secret of [who.tokenHash,other.userId,password,encoded,token,'sessionTokenHash','authVersion','leaseToken','executionToken','ciphertext'])assert(!text.includes(secret));
 for(const source of (await f.db.query('SELECT * FROM platform_memory_safety_sources WHERE user_id=$1',[who.userId])).rows)
  for(const secret of [source.lease_token,source.execution_token].filter(Boolean))assert(!text.includes(secret));
 assert(!sqls.some(sql=>/FROM platform_memory_safety_|FROM platform_safety_model_usage/.test(sql)&&/FOR (SHARE|UPDATE)/.test(sql)));
 assert.deepEqual(await rows(who),before);assert.equal(loop.bodies.length,calls);
});

test('empty and failed pending classifications remain empty or pending; renewed consent is not required for private export',async()=>{
 const who=await actor(),empty=await capture(who);assert.deepEqual(empty.sections.memorySafetySources,[]);assert.deepEqual(empty.sections.memorySafetyBlocks,[]);
 const a=await memories.mutate(who,'create',null,command());await assert.rejects(disabled.runCurrent(who,a.memory.id));
 const before=await rows(who);await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[who.userId]);await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[who.userId]);
 const data=await capture(who),source=data.sections.memorySafetySources[0] as any;assert.equal(source.status,'pending');assert.equal(source.failure,'unavailable');assert.equal(source.result,null);assert.equal(source.leaseUntil,null);assert.deepEqual(data.sections.memorySafetyBlocks,[]);assert.deepEqual(await rows(who),before);
});

test('historical classification survives an edited body and changed detector policy without being relabelled',async()=>{
 const who=await actor(),a=await memories.mutate(who,'create',null,command());await loop.safety.runCurrent(who,a.memory.id);
 await memories.mutate(who,'edit',a.memory.id,{operationId:randomUUID(),expectedRevision:1,content:'Fictional newer content still unclassified'});
 await f.db.query('UPDATE platform_safety_detector_policy SET revision=revision+1 WHERE singleton=true');
 try{const data=await capture(who),source=data.sections.memorySafetySources[0] as any;assert.equal(source.submittedAtRevision,1);assert.equal(source.policyRevision,MEMORY_PROFILE.revision);assert.equal(source.result.decision.level,'L0');assert.equal((data.sections.memories[0] as any).state.revision,2);}
 finally{await loop.activate();}
});

test('expired running work is exported as running and never reclaimed by the archive',async()=>{
 const who=await actor(),a=await memories.mutate(who,'create',null,command());loop.setHandler(async(_b,r)=>{await memories.mutate(who,'edit',a.memory.id,{operationId:randomUUID(),expectedRevision:1,content:'Fictional changed during classifier'});memoryReply(r);});
 try{await assert.rejects(loop.safety.runCurrent(who,a.memory.id));}finally{loop.setHandler((_b,r)=>memoryReply(r));}
 await f.db.query("UPDATE platform_memory_safety_sources SET lease_until=clock_timestamp()-interval '1 day' WHERE user_id=$1",[who.userId]);
 const before=await rows(who),data=await capture(who);assert.equal((data.sections.memorySafetySources[0] as any).status,'running');assert.equal((data.sections.memorySafetySources[0] as any).result,null);assert.deepEqual(await rows(who),before);
});

test('retained block remains exportable after genuine deletion retention purges the original memory and source',async()=>{
 const who=await actor(),a=await memories.mutate(who,'create',null,command('Fictional Synthetic low marker'));await loop.safety.runCurrent(who,a.memory.id);
 await memories.mutate(who,'delete',a.memory.id,{operationId:randomUUID(),expectedRevision:1});
 await new Promise(resolve=>setTimeout(resolve,10100));await purgeExpiredMemoryDeletions(f.db);
 const before=await rows(who),data=await capture(who);assert.deepEqual(data.sections.memories,[]);assert.deepEqual(data.sections.memorySafetySources,[]);assert.equal(data.sections.memorySafetyBlocks.length,1);const block=data.sections.memorySafetyBlocks[0] as any;assert.equal(block.memoryId,a.memory.id);assert.deepEqual(block.decision,{level:'L1',mode:'full'});assert.equal(block.modelUsage.inputTokens,34);assert.equal(block.modelUsage.outputTokens,8);assert.deepEqual(await rows(who),before);
});

test('all 105 sources and retained blocks cross page boundaries without truncation or extra calls',async()=>{
 const who=await actor(),calls=loop.bodies.length;for(let n=0;n<105;n++)await risk(who);
 const sqls:string[]=[],data=await new AccountCoreExport(instrument(sql=>{sqls.push(sql);}),f.config).capture(who,await proof(who));
 assert.equal(data.sections.memorySafetySources.length,105);assert.equal(data.sections.memorySafetyBlocks.length,105);assert.equal(new Set((data.sections.memorySafetyBlocks as any[]).map(x=>x.sourceId)).size,105);
 assert.equal(sqls.filter(sql=>query(sql)).length,2);assert.equal(sqls.filter(sql=>query(sql,'blocks')).length,2);assert.equal(loop.bodies.length,calls);
});

test('damaged or foreign ciphertext, missing blocks and mismatched measured usage reject the whole archive without consuming proof',async()=>{
 const who=await actor(),foreign=await actor();await risk(who);await risk(foreign);const token=await proof(who);
 for(const [kind,column] of [['sources','source_ciphertext'],['sources','claim_ciphertext'],['sources','result_ciphertext'],['blocks','receipt_ciphertext']]){
  const other=(await f.db.query(`SELECT * FROM platform_memory_safety_${kind} WHERE user_id=$1`,[foreign.userId])).rows[0];
  for(const swap of [false,true]){let reached=false;const db=instrument((sql,found)=>{if(query(sql,kind)&&found.length){reached=true;const copy=Buffer.from(found[0][column]);copy[copy.length-1]^=1;found[0][column]=swap?other[column]:copy;}});
   await assert.rejects(new AccountCoreExport(db,f.config).capture(who,token),{code:'ACCOUNT_MEMORY_SAFETY_EXPORT_UNAVAILABLE'});assert(reached);await unused(who);
  }
 }
 const missing=instrument((sql,found)=>{if(query(sql,'blocks'))found.splice(0);});await assert.rejects(new AccountCoreExport(missing,f.config).capture(who,token),{code:'ACCOUNT_MEMORY_SAFETY_EXPORT_UNAVAILABLE'});await unused(who);
 const full=await actor(),a=await memories.mutate(full,'create',null,command());await loop.safety.runCurrent(full,a.memory.id);const fullToken=await proof(full);
 const altered=instrument((sql,found)=>{if(sql.includes('EXTRACT(EPOCH FROM admitted_at)')&&sql.includes('FROM platform_safety_model_usage')&&found.length)found[0].input_tokens++;});
 await assert.rejects(new AccountCoreExport(altered,f.config).capture(full,fullToken),{code:'ACCOUNT_MEMORY_SAFETY_EXPORT_UNAVAILABLE'});await unused(full);
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(who,token)).sections.memorySafetyBlocks.length,1);
});

test('late session invalidation, cancellation and archive size limit roll back proof consumption and release no result',async()=>{
 const who=await actor();await risk(who);const token=await proof(who);
 const revoked=instrument(async(sql,_rows,client)=>{if(query(sql,'blocks'))await client.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[who.userId]);});
 await assert.rejects(new AccountCoreExport(revoked,f.config).capture(who,token));await unused(who);
 const abort=new AbortController(),cancelled=instrument(sql=>{if(query(sql))abort.abort(new Error('Fictional archive cancellation'));});
 await assert.rejects(new AccountCoreExport(cancelled,f.config).capture(who,token,abort.signal));await unused(who);
 await assert.rejects(new AccountCoreExport(f.db,f.config,{maxBytes:1024}).capture(who,token),{code:'ACCOUNT_EXPORT_TOO_LARGE'});await unused(who);
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(who,token)).sections.memorySafetySources.length,1);
});
