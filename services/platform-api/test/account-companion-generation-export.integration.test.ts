import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {createProviderRuntime} from '@companion/ai-core';
import type {Database} from '../src/database.ts';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {AccountReauthentication} from '../src/account-reauthentication.ts';
import {hashPassword,type FixedSessionContext} from '../src/auth.ts';
import {createCompanionNameSafetyFixture} from './fixtures/companion-name-safety.ts';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,encoded:string;
const password='Fictional-generation-export-password';
const preview={summary:'先把事情理清楚，再选一个小行动。',samples:['可以先聊聊你想试的方向。','我们先把事情理清楚。','先选一个小行动。']};
before(async()=>{f=await createCompanionNameSafetyFixture();encoded=await hashPassword(password);});
after(async()=>{await f?.close();});
async function actor(){const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,encoded]);return who;}
async function prepare(mode:'model'|'fallback'|'pending'='model',standard=false){
 const who=await actor();if(standard){let draft=(await f.store.save(who,{expectedRevision:0,operationId:randomUUID(),action:{kind:'start',mode:'standard'}})).draft;
  while(draft.currentQuestion){const q=draft.currentQuestion;draft=(await f.store.save(who,{expectedRevision:draft.revision,operationId:randomUUID(),action:q.startsWith('Q')?{kind:'answer',questionId:q,value:'B'}:{kind:'skip',questionId:q}})).draft;}}
 let count=0,failure:unknown;
 const server=http.createServer(async(request,reply)=>{try{assert.equal(request.url,'/v1/responses');assert.equal(request.method,'POST');const parts:Buffer[]=[];for await(const part of request)parts.push(part);const body=JSON.parse(Buffer.concat(parts).toString());assert.equal(body.model,'fictional-companion-model');assert.equal(body.store,false);assert.deepEqual(body.tools,[]);count++;
  reply.writeHead(200,{'content-type':'text/event-stream'});reply.end(`data: ${JSON.stringify({type:'response.completed',response:{status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(mode==='fallback'?{...preview,summary:'保证拿到 offer。'}:preview)}]}],usage:{input_tokens:34,output_tokens:21}}})}\n\ndata: [DONE]\n\n`);
 }catch(error){failure=error;reply.destroy();}});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address==='object');
 const runtime=createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'1',OPENAI_API_KEY:'fictional-loopback-only',OPENAI_COMPANION_GENERATION_MODEL:'fictional-companion-model'},fetch:(target,init)=>{const url=new URL(String(target));assert.equal(url.origin,'https://api.openai.com');assert.equal(url.pathname,'/v1/responses');return fetch(`http://127.0.0.1:${address.port}${url.pathname}`,init);}});
 try{const ready=await f.ready(runtime,{who,generate:mode!=='pending'});if(failure)throw failure;assert.equal(count,mode==='pending'?0:mode==='fallback'?3:1);return {...ready,requestCount:count};}
 finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
const proof=async(who:FixedSessionContext)=>(await new AccountReauthentication(f.db).verify(who,{purpose:'account_export',password})).token;
const capture=async(who:FixedSessionContext)=>new AccountCoreExport(f.db,f.config).capture(who,await proof(who));
const consumed=async(who:FixedSessionContext)=>(await f.db.query("SELECT consumed_at FROM platform_account_reauthentications WHERE user_id=$1 AND purpose='account_export'",[who.userId])).rows[0].consumed_at;
function instrument(transform:(sql:string,rows:Record<string,any>[],client:PoolClient)=>void|Promise<void>):Database{
 return {withBoundedTransaction:<T>(run:(client:PoolClient)=>Promise<T>,options?:{readOnly?:boolean;timeoutMs?:number})=>f.db.withBoundedTransaction(client=>run(new Proxy(client,{get(target,key){
  if(key==='query')return async(sql:string,values:unknown[])=>{const result=await target.query(sql,values);await transform(sql,result.rows,target);return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }})),options)} as Database;
}
const table=(sql:string,name:string)=>sql.startsWith(`SELECT * FROM platform_companion_${name} WHERE user_id=`);
function damage(bytes:Buffer){const copy=Buffer.from(bytes);copy[copy.length-1]^=1;return copy;}

test('real answered questionnaire and completed generation export saved personality, source links and actual call accounting',async()=>{
 const p=await prepare('model',true),other=await prepare(),token=await proof(p.who),result=await new AccountCoreExport(f.db,f.config).capture(p.who,token);
 const answers=result.sections.companionAnswers as any[],tasks=result.sections.companionGenerationTasks as any[],revisions=result.sections.companionRevisions as any[],calls=result.sections.companionGenerationCalls as any[];
 assert.equal(answers.length,1);assert.equal(answers[0].fastTrack,false);assert.equal(answers[0].answersPartial.Q1.value,'B');assert.equal(answers[0].answersPartial.Q7.value,'B');
 assert.equal(tasks.length,1);assert.equal(tasks[0].answersId,answers[0].id);assert.equal(tasks[0].id,p.prepared.taskId);assert.equal(tasks[0].status,'completed');assert.equal(tasks[0].sourceReceiptVersion,1);
 assert.equal(revisions.length,1);assert.equal(revisions[0].summary,preview.summary);assert.deepEqual(revisions[0].samples,preview.samples);assert.equal(revisions[0].generatedBy,'model');
 assert.equal(revisions[0].styleCard,tasks[0].prepared.styleCard);assert.deepEqual(revisions[0].dimensions,tasks[0].prepared.dimensions);assert.equal(revisions[0].dimensions.structure,1);
 assert.equal(calls.length,1);assert.deepEqual(revisions[0].callIds,[calls[0].id]);assert.equal(calls[0].status,'complete');assert.equal(calls[0].usageStatus,'reported');assert.equal(calls[0].inputTokens,34);assert.equal(calls[0].outputTokens,21);
 assert.deepEqual(result.sections.companionOutputBlocks,[]);assert.equal(result.includedTables.length,69);assert(result.includedTables.includes('platform_companion_generation_checkpoints'));assert(result.includedTables.includes('platform_companion_source_prefixes'));assert.equal(result.complete,false);
 const text=JSON.stringify(result);for(const secret of [other.who.userId,other.prepared.taskId,p.who.tokenHash,password,encoded,token,'authVersion','seed_ciphertext','payload_ciphertext','lease_token','runtime_lease_id','sourceReceiptDigest','fictional-loopback-only'])assert(!text.includes(secret));
 assert(Object.isFrozen(revisions[0].dimensions));assert(Object.isFrozen(answers[0].answersPartial.Q1));
});

test('fallback remains explicitly marked and exports the three actual validation failures without their rejected text',async()=>{
 const p=await prepare('fallback'),result=await capture(p.who),revision=result.sections.companionRevisions[0] as any,calls=result.sections.companionGenerationCalls as any[],blocks=result.sections.companionOutputBlocks as any[];
 assert.equal(revision.generatedBy,'fallback');assert.equal(calls.length,3);assert.equal(blocks.length,3);assert.equal(revision.callIds.length,3);
 assert(calls.every(c=>c.status==='complete'&&c.validationStatus==='blocked'));assert(blocks.every(b=>revision.callIds.includes(b.callId)&&b.rules.length>0));
 assert(!JSON.stringify(result).includes('保证拿到 offer。'));
});

test('pending, expired running, failed, uncertain and interrupted tasks retain their real state without recovery or invented output',async()=>{
 const p=await prepare('pending');let result=await capture(p.who);assert.equal((result.sections.companionGenerationTasks[0] as any).status,'pending');assert.deepEqual(result.sections.companionRevisions,[]);assert.deepEqual(result.sections.companionGenerationCalls,[]);
 const lease=randomUUID(),runtimeLease=randomUUID();
 await f.db.query("UPDATE platform_companion_generation_tasks SET status='running',generation=1,lease_token=$2,runtime_lease_id=$3,lease_until=clock_timestamp()-interval '1 hour' WHERE id=$1",[p.prepared.taskId,lease,runtimeLease]);
 result=await capture(p.who);const running=result.sections.companionGenerationTasks[0] as any;assert.equal(running.status,'running');assert(Date.parse(running.leaseUntil)<Date.now());assert(!JSON.stringify(result).includes(lease));assert(!JSON.stringify(result).includes(runtimeLease));
 for(const [status,error] of [['failed','COMPANION_GENERATION_UNAVAILABLE'],['uncertain','COMPANION_GENERATION_UNCERTAIN'],['interrupted','COMPANION_GENERATION_INTERRUPTED']]){
  await f.db.query('UPDATE platform_companion_generation_tasks SET status=$2,error_code=$3,lease_token=NULL,runtime_lease_id=NULL,lease_until=NULL,finished_at=clock_timestamp() WHERE id=$1',[p.prepared.taskId,status,error]);
  result=await capture(p.who);assert.equal((result.sections.companionGenerationTasks[0] as any).status,status);assert.equal((result.sections.companionGenerationTasks[0] as any).errorCode,error);assert.deepEqual(result.sections.companionRevisions,[]);
 }
 assert.equal((await f.db.query('SELECT count(*)::int n FROM platform_companion_generation_calls WHERE user_id=$1',[p.who.userId])).rows[0].n,0);
});

test('withdrawn model consent and changed current companion metadata do not recompile historical personality',async()=>{
 const p=await prepare(),before=(await capture(p.who)).sections.companionRevisions;
 await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[p.who.userId]);await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[p.who.userId]);
 await f.db.query("UPDATE platform_companions SET fingerprint=$2 WHERE id=$1",[p.prepared.companionId,'0'.repeat(64)]);
 const queries:string[]=[],db=instrument(sql=>{queries.push(sql);}),result=await new AccountCoreExport(db,{...f.config,dataCrypto:f.crypto}).capture(p.who,await proof(p.who));
 assert.deepEqual(result.sections.companionRevisions,before);assert(!queries.filter(sql=>/FROM platform_companion_(answers|generation_tasks|revisions|generation_calls|output_blocks)/.test(sql)).some(sql=>/FOR (SHARE|UPDATE)/.test(sql)));
});

test('every stored answer snapshot is included across pages, even without a completed generation referencing it',async()=>{
 const p=await prepare('pending'),row=(await f.db.query('SELECT * FROM platform_companion_answers WHERE user_id=$1',[p.who.userId])).rows[0];
 const saved=JSON.parse(f.crypto.openUtf8(row.payload_ciphertext,{table:'platform_companion_answers',column:'payload_ciphertext',rowId:row.id,ownerId:p.who.userId,revision:row.source_revision}));
 // Synthetic retained snapshots exercise pagination only, not production generation authority.
 const ids=[row.id];for(let n=0;n<104;n++){const next=randomUUID();ids.push(next);const bytes=f.crypto.sealUtf8(JSON.stringify({...saved,id:next}),{table:'platform_companion_answers',column:'payload_ciphertext',rowId:next,ownerId:p.who.userId,revision:row.source_revision});await f.db.query('INSERT INTO platform_companion_answers(id,user_id,source_draft_id,source_revision,payload_ciphertext) VALUES($1,$2,$3,$4,$5)',[next,p.who.userId,row.source_draft_id,row.source_revision,bytes]);}
 const queries:string[]=[],db=instrument(sql=>{queries.push(sql);}),result=await new AccountCoreExport(db,f.config).capture(p.who,await proof(p.who));
 assert.deepEqual((result.sections.companionAnswers as any[]).map(x=>x.id),ids.sort());assert.equal(queries.filter(sql=>table(sql,'answers')).length,2);assert.equal(result.sections.companionGenerationTasks.length,1);
});

test('damaged and foreign answer, seed or revision ciphertext fail atomically and keep the reauthentication proof retryable',async()=>{
 const p=await prepare(),other=await prepare(),token=await proof(p.who);
 for(const [name,column] of [['answers','payload_ciphertext'],['generation_tasks','seed_ciphertext'],['revisions','payload_ciphertext']]){
  const foreign=(await f.db.query(`SELECT * FROM platform_companion_${name} WHERE user_id=$1`,[other.who.userId])).rows[0];
  for(const swapped of [false,true]){let reached=false;const db=instrument((sql,rows)=>{if(table(sql,name)&&rows.length){reached=true;rows[0][column]=swapped?foreign[column]:damage(rows[0][column]);}});
   await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),{code:'ACCOUNT_COMPANION_GENERATION_EXPORT_UNAVAILABLE'});assert(reached);assert.equal(await consumed(p.who),null);
  }
 }
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(p.who,token)).sections.companionRevisions.length,1);
});

test('clear coordinates, missing referenced calls and unknown encrypted fields cannot override saved source identity',async()=>{
 const p=await prepare(),token=await proof(p.who);
 for(const name of ['answers','generation_tasks','revisions','generation_calls']){const db=instrument((sql,rows)=>{if(table(sql,name)&&rows.length){if(name==='generation_calls')rows.splice(0);else if(name==='answers')rows[0].source_draft_id=randomUUID();else if(name==='generation_tasks')rows[0].auth_version='999';else rows[0].generated_by='fallback';}});
  await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),{code:'ACCOUNT_COMPANION_GENERATION_EXPORT_UNAVAILABLE'});assert.equal(await consumed(p.who),null);
 }
 const db=instrument((sql,rows)=>{if(table(sql,'revisions')&&rows.length){const row=rows[0],binding={table:'platform_companion_revisions',column:'payload_ciphertext',rowId:row.companion_id,ownerId:p.who.userId,revision:row.revision};const original=JSON.parse(f.crypto.openUtf8(row.payload_ciphertext,binding));row.payload_ciphertext=f.crypto.sealUtf8(JSON.stringify({...original,privateUnknown:'not an exported field'}),binding);}});
 await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),{code:'ACCOUNT_COMPANION_GENERATION_EXPORT_UNAVAILABLE'});assert.equal(await consumed(p.who),null);
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(p.who,token)).sections.companionRevisions.length,1);
});

test('unknown historical cache counts stay unknown and cancellation returns no partial archive',async()=>{
 const p=await prepare();await f.db.query('UPDATE platform_companion_generation_calls SET cached_input_tokens=NULL,cache_write_input_tokens=NULL WHERE user_id=$1',[p.who.userId]);
 const result=await capture(p.who),call=result.sections.companionGenerationCalls[0] as any;assert.equal(call.cachedInputTokens,null);assert.equal(call.cacheWriteInputTokens,null);
 const token=await proof(p.who),controller=new AbortController(),db=instrument(sql=>{if(table(sql,'revisions'))controller.abort();});
 await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token,controller.signal),{code:'ACCOUNT_EXPORT_CANCELLED'});assert.equal(await consumed(p.who),null);
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(p.who,token)).sections.companionRevisions.length,1);
});


test('a legacy-shaped seed read stays explicitly legacy without writing or inventing provenance',async()=>{
 const p=await prepare('pending'),row=(await f.db.query('SELECT * FROM platform_companion_generation_tasks WHERE id=$1',[p.prepared.taskId])).rows[0];
 const binding={table:'platform_companion_generation_tasks',column:'seed_ciphertext',rowId:row.id,ownerId:p.who.userId,revision:row.source_revision};
 const original=JSON.parse(f.crypto.openUtf8(row.seed_ciphertext,binding));delete original.sourceReceiptVersion;delete original.sourceReceiptDigest;
 // Simulate retained pre-manifest task and absent-manifest reads after owned SQL reads.
 // Current storage correctly prevents downgrading a task with a bound manifest.
 const db=instrument((sql,rows)=>{if(table(sql,'source_prefixes'))rows.splice(0);if(table(sql,'generation_tasks')&&rows.length){rows[0].source_receipt_version=null;rows[0].seed_ciphertext=f.crypto.sealUtf8(JSON.stringify(original),binding);}});
 const before=(await f.db.query('SELECT count(*)::int n FROM platform_companion_source_prefixes WHERE user_id=$1',[p.who.userId])).rows[0].n;
 const result=await new AccountCoreExport(db,f.config).capture(p.who,await proof(p.who));assert.equal((result.sections.companionGenerationTasks[0] as any).sourceReceiptVersion,null);
 assert.equal((await f.db.query('SELECT source_receipt_version FROM platform_companion_generation_tasks WHERE id=$1',[row.id])).rows[0].source_receipt_version,row.source_receipt_version);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM platform_companion_source_prefixes WHERE user_id=$1',[p.who.userId])).rows[0].n,before);
 assert.equal(result.sections.companionGenerationCalls.length,0);
});

test('foreign cost reservation references are rejected before any private call metadata can escape',async()=>{
 const p=await prepare(),other=await prepare(),foreign=(await f.db.query('SELECT reservation_id FROM platform_companion_generation_calls WHERE user_id=$1',[other.who.userId])).rows[0].reservation_id,token=await proof(p.who);
 const db=instrument((sql,rows)=>{if(table(sql,'generation_calls')&&rows.length)rows[0].reservation_id=foreign;});
 await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),{code:'ACCOUNT_COMPANION_GENERATION_EXPORT_UNAVAILABLE'});assert.equal(await consumed(p.who),null);
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(p.who,token)).sections.companionGenerationCalls.length,1);
});
