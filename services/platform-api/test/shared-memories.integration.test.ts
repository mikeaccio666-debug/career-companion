import { createMemorySafetyLoopback } from './fixtures/shared-memory-safety.ts';
import fs from 'node:fs/promises';
import { Database } from '../src/database.ts';
import { readConfig } from '../src/config.ts';
import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { purgeExpiredMemoryDeletions } from '../src/memory-retention.ts';
import { SharedMemories } from '../src/shared-memories.ts';
import { ApiError } from '../src/errors.ts';
import { tokenHash } from '../src/auth.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,service:SharedMemories,detector:Awaited<ReturnType<typeof createMemorySafetyLoopback>>;
before(async()=>{f=await createCompanionNameSafetyFixture();service=new SharedMemories(f.db,f.config,FICTIONAL_LEGAL);detector=await createMemorySafetyLoopback(f,service);});
after(async()=>{try{await detector?.close();}finally{await f?.close();}});
const bad=(status:number)=>(e:unknown)=>e instanceof ApiError&&e.status===status;
const create=(patch:Record<string,unknown>={})=>({operationId:randomUUID(),content:'Fictional owner preference',category:'goal_preference',sensitivity:'normal',usePolicy:'normal',speakerScope:null,validUntil:null,...patch});
const scope=(userId:string,patch:Record<string,unknown>={})=>({ownerId:userId,speaker:'companion' as const,channel:'web' as const,purpose:'chat' as const,now:new Date().toISOString(),intentKeys:[],userRaisedMemoryIds:[],selfSetReminderMemoryIds:[],...patch});
async function counts(userId:string){return (await f.db.query(`SELECT (SELECT count(*)::int FROM platform_memory_operations WHERE user_id=$1) operations,
 (SELECT count(*)::int FROM platform_memory_events WHERE user_id=$1) events,(SELECT count(*)::int FROM platform_memories WHERE user_id=$1) memories,
 (SELECT count(*)::int FROM platform_jobs WHERE user_id=$1) jobs`,[userId])).rows[0];}

test('migration leaves actual old rows unclassified; owner review is required before any team selection',async()=>{
 const who=await f.actor(),id=randomUUID();await f.db.query('INSERT INTO platform_memories(id,user_id,content) VALUES($1,$2,$3)',[id,who.userId,'Fictional old private content']);
 const row=(await f.db.query('SELECT * FROM platform_memories WHERE id=$1',[id])).rows[0];assert.equal(row.category,null);assert.equal(row.sensitivity,null);assert.equal(row.status,null);assert.equal(row.record_revision,0);
 const old=await service.get(who,id);assert.equal(old.kind,'needs_review');assert.equal(old.content,row.content);assert.equal(old.confirmedAt,null);
 const none=await f.db.withBoundedTransaction(c=>service.selectInTransaction(c,who,scope(who.userId)));assert.equal(none.useReferences.length,0);
 await assert.rejects(service.mutate(who,'edit',id,{operationId:randomUUID(),expectedRevision:0,content:'Fictional edit without classification'}),bad(409));
 await assert.rejects(service.mutate(who,'confirm',id,{operationId:randomUUID(),expectedRevision:0}),bad(400));
 const accepted=await service.mutate(who,'confirm',id,{operationId:randomUUID(),expectedRevision:0,category:'goal_preference',sensitivity:'restricted'});
 assert.equal(accepted.memory.kind,'memory');assert.equal(accepted.memory.revision,1);assert.equal(accepted.memory.confidence,'high');assert(accepted.memory.confirmedAt);
 assert.equal((await f.db.query('SELECT content FROM platform_memories WHERE id=$1',[id])).rows[0].content,'');
 const hidden=await f.db.withBoundedTransaction(c=>service.selectInTransaction(c,who,scope(who.userId)));assert.equal(hidden.useReferences.length,0);
 await detector.safety.runCurrent(who,id);
 const raised=await f.db.withBoundedTransaction(c=>service.selectInTransaction(c,who,scope(who.userId,{userRaisedMemoryIds:[id]})));assert.equal(raised.current[0].content,'Fictional old private content');
});

test('real encrypted owner save is versioned, replayable without another effect, and usable only under actual policy',async()=>{
 const who=await f.actor(),command=create({category:'communication',content:'Fictional: start with one warm-up question'});
 const a=await service.mutate(who,'create',null,command),b=await service.mutate(who,'create',null,Object.fromEntries(Object.entries(command).reverse()));
 assert.equal(a.operation.replayed,false);assert.equal(b.operation.replayed,true);assert.deepEqual(b.memory,a.memory);
 const row=(await f.db.query('SELECT * FROM platform_memories WHERE id=$1',[a.memory.id])).rows[0];assert.equal(row.content,'');assert(!row.record_ciphertext.includes(Buffer.from(command.content)));
 assert.deepEqual(await counts(who.userId),{operations:1,events:1,memories:1,jobs:0});
 await detector.safety.runCurrent(who,a.memory.id);
 const selected=await f.db.withBoundedTransaction(c=>service.selectInTransaction(c,who,scope(who.userId)));assert.equal(selected.stable[0].content,command.content);
 await assert.rejects(service.mutate(who,'create',null,{...command,content:'Fictional changed duplicate'}),bad(409));
});

test('closed owner commands reject fabricated confirmation, source, identity and accessor fields before persistence',async()=>{
 const who=await f.actor();
 for(const command of [create({ownerId:randomUUID()}),create({confirmedAt:new Date().toISOString()}),create({source:'companion_proposed'}),create({confidence:'high'}),create({category:'anything'}),{operationId:randomUUID(),content:'old bare save'},create({speakerScope:'applier'}),create({content:'bad\u0000text'})])
  await assert.rejects(service.mutate(who,'create',null,command),bad(400));
 const getter=create();Object.defineProperty(getter,'content',{get(){throw Error('must never read accessor');},enumerable:true});await assert.rejects(service.mutate(who,'create',null,getter),bad(400));
 assert.deepEqual(await counts(who.userId),{operations:0,events:0,memories:0,jobs:0});
});

test('real owner/session boundary denies another account, revoked session, expiry and staff',async()=>{
 const who=await f.actor(),other=await f.actor(),staff=await f.actor(true),a=await service.mutate(who,'create',null,create());
 await assert.rejects(service.get(other,a.memory.id),bad(404));
 await assert.rejects(service.mutate(other,'delete',a.memory.id,{operationId:randomUUID(),expectedRevision:1}),bad(404));
 await assert.rejects(service.get(staff,a.memory.id),bad(403));
 await assert.rejects(service.get({...who,userId:other.userId},a.memory.id),bad(401));
 await f.db.query("UPDATE platform_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[who.tokenHash]);
 await assert.rejects(service.get(who,a.memory.id),bad(401));
 const revoked=await f.actor();await f.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[revoked.userId]);await assert.rejects(service.list(revoked),bad(401));
});

test('concurrent edits serialize on the real account: exactly one new revision and no lost update',async()=>{
 const who=await f.actor(),a=await service.mutate(who,'create',null,create());
 const edits=await Promise.allSettled(['A','B'].map(x=>service.mutate(who,'edit',a.memory.id,{operationId:randomUUID(),expectedRevision:1,content:'Fictional concurrent '+x})));
 assert.equal(edits.filter(x=>x.status==='fulfilled').length,1);assert.equal(edits.filter(x=>x.status==='rejected'&&bad(409)(x.reason)).length,1);
 const memory=await service.get(who,a.memory.id);assert.equal(memory.revision,2);assert.equal(memory.confidence,'high');assert.equal((await counts(who.userId)).events,2);
});

test('sensitivity and only-if-raised changes take effect on the next genuine selection, with content-free audit events',async()=>{
 const who=await f.actor(),a=await service.mutate(who,'create',null,create());
 await detector.safety.runCurrent(who,a.memory.id);
 const b=await service.mutate(who,'edit',a.memory.id,{operationId:randomUUID(),expectedRevision:1,sensitivity:'restricted',usePolicy:'only_if_user_raises'});
 const quiet=await f.db.withBoundedTransaction(c=>service.selectInTransaction(c,who,scope(who.userId)));assert.equal(quiet.useReferences.length,0);
 const expert=await f.db.withBoundedTransaction(c=>service.selectInTransaction(c,who,scope(who.userId,{speaker:'applier',userRaisedMemoryIds:[a.memory.id]})));assert.equal(expert.useReferences.length,0);
 const voice=await f.db.withBoundedTransaction(c=>service.selectInTransaction(c,who,scope(who.userId,{channel:'voice',userRaisedMemoryIds:[a.memory.id]})));assert.equal(voice.useReferences.length,0);
 const raised=await f.db.withBoundedTransaction(c=>service.selectInTransaction(c,who,scope(who.userId,{userRaisedMemoryIds:[a.memory.id]})));assert.equal(raised.current[0].revision,b.memory.revision);
 const events=(await f.db.query('SELECT * FROM platform_memory_events WHERE user_id=$1',[who.userId])).rows;assert.equal(events.length,3);assert(events.every(e=>!Object.hasOwn(e,'content')));
});

test('delete removes every context reference immediately; exact 10-second owner undo restores as a new revision',async()=>{
 const who=await f.actor(),a=await service.mutate(who,'create',null,create()),command={operationId:randomUUID(),expectedRevision:1};
 const deleted=await service.mutate(who,'delete',a.memory.id,command);assert.equal(Date.parse(deleted.memory.undoUntil!)-Date.parse(deleted.memory.deletedAt!),10000);
 await assert.rejects(service.get(who,a.memory.id),bad(404));assert.equal((await service.list(who)).memories.length,0);
 const selection=await f.db.withBoundedTransaction(c=>service.selectInTransaction(c,who,scope(who.userId)));assert.equal(selection.useReferences.length,0);
 const restored=await service.mutate(who,'undo',a.memory.id,{operationId:randomUUID(),expectedRevision:2,deletionOperationId:command.operationId});
 assert.equal(restored.memory.revision,3);assert.equal(restored.memory.deletedAt,null);assert.equal(restored.memory.content,a.memory.content);
 const duplicate=await service.mutate(who,'delete',a.memory.id,command);assert.equal(duplicate.operation.replayed,true);assert.equal(duplicate.memory.revision,3);
 assert.equal((await service.get(who,a.memory.id)).revision,3);
});

test('deleting and undoing an unreviewed old row never guesses privacy, category or confirmation',async()=>{
 const who=await f.actor(),id=randomUUID();await f.db.query('INSERT INTO platform_memories(id,user_id,content) VALUES($1,$2,$3)',[id,who.userId,'Fictional old unknown sensitivity']);
 const del=await service.mutate(who,'delete',id,{operationId:randomUUID(),expectedRevision:0});
 const undo=await service.mutate(who,'undo',id,{operationId:randomUUID(),expectedRevision:1,deletionOperationId:del.operation.id});
 assert.equal(undo.memory.kind,'needs_review');assert.equal(undo.memory.revision,2);assert.equal(undo.memory.sensitivity,null);assert.equal(undo.memory.confirmedAt,null);
 assert.equal((await f.db.withBoundedTransaction(c=>service.selectInTransaction(c,who,scope(who.userId)))).useReferences.length,0);
});

test('withdrawn legal/email admission preserves private observation and forgetting, but blocks new confirmation and undo',async()=>{
 const who=await f.actor(),a=await service.mutate(who,'create',null,create());await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[who.userId]);await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[who.userId]);
 assert.equal((await service.get(who,a.memory.id)).content,a.memory.content);
 await assert.rejects(service.mutate(who,'edit',a.memory.id,{operationId:randomUUID(),expectedRevision:1,sensitivity:'sensitive'}),bad(403));
 const del=await service.mutate(who,'delete',a.memory.id,{operationId:randomUUID(),expectedRevision:1});
 await assert.rejects(service.mutate(who,'undo',a.memory.id,{operationId:randomUUID(),expectedRevision:2,deletionOperationId:del.operation.id}),bad(403));
});

test('ciphertext or mutable metadata damage closes reads and team selection instead of repairing or downgrading privacy',async()=>{
 for(const mutation of ['cipher','metadata']) {
  const who=await f.actor(),a=await service.mutate(who,'create',null,create());
  if(mutation==='cipher')await f.db.query('UPDATE platform_memories SET record_ciphertext=set_byte(record_ciphertext,octet_length(record_ciphertext)-1,get_byte(record_ciphertext,octet_length(record_ciphertext)-1) # 1) WHERE id=$1',[a.memory.id]);
  else await f.db.query("UPDATE platform_memories SET sensitivity='restricted' WHERE id=$1",[a.memory.id]);
  await assert.rejects(service.get(who,a.memory.id),bad(503));await assert.rejects(f.db.withBoundedTransaction(c=>service.selectInTransaction(c,who,scope(who.userId))),bad(503));
 }
});

test('pagination keeps genuine microseconds and UUID ties, rejects foreign cursor and never truncates the remaining review path',async()=>{
 const who=await f.actor(),other=await f.actor();
 for(const ending of ['101','101','102','103'])await f.db.query("INSERT INTO platform_memories(id,user_id,content,created_at) VALUES($1,$2,'Fictional old paged memory',$3::timestamptz)",[randomUUID(),who.userId,'2026-10-01T12:34:56.123'+ending+'Z']);
 const first=await service.list(who,{limit:2});assert.equal(first.memories.length,2);assert(first.nextCursor);
 const second=await service.list(who,{limit:2,cursor:first.nextCursor});assert.equal(second.memories.length,2);assert.equal(second.nextCursor,null);
 assert.equal(new Set([...first.memories,...second.memories].map(x=>x.id)).size,4);
 await assert.rejects(service.list(other,{cursor:first.nextCursor}),bad(400));
 await assert.rejects(service.list(who,{limit:101}),bad(400));await assert.rejects(service.list(who,{ownerId:other.userId}),bad(400));
});

test('older over-context-budget memory can be explicitly shortened and reviewed rather than silently truncating its source',async()=>{
 const who=await f.actor(),id=randomUUID(),old='F'.repeat(3000);await f.db.query('INSERT INTO platform_memories(id,user_id,content) VALUES($1,$2,$3)',[id,who.userId,old]);
 await assert.rejects(service.mutate(who,'confirm',id,{operationId:randomUUID(),expectedRevision:0,category:'experience',sensitivity:'normal'}),bad(400));assert.equal((await service.get(who,id)).content,old);
 const fixed=await service.mutate(who,'confirm',id,{operationId:randomUUID(),expectedRevision:0,category:'experience',sensitivity:'normal',editedContent:'Fictional owner-reviewed shorter fact'});assert.equal(fixed.memory.content,'Fictional owner-reviewed shorter fact');
});

test('late actual session invalidation rolls back the new memory, operation and event together',async()=>{
 const who=await f.actor(),name='memory_test_'+randomUUID().replaceAll('-','');
 await f.db.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE platform_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=NEW.user_id; RETURN NEW; END $$`);
 await f.db.query(`CREATE TRIGGER ${name} AFTER INSERT ON platform_memories FOR EACH ROW EXECUTE FUNCTION ${name}()`);
 try {await assert.rejects(service.mutate(who,'create',null,create()),bad(401));assert.deepEqual(await counts(who.userId),{operations:0,events:0,memories:0,jobs:0});}
 finally{await f.db.query(`DROP TRIGGER ${name} ON platform_memories`);await f.db.query(`DROP FUNCTION ${name}()`);}
 assert.equal((await service.list(who)).memories.length,0);
});

test('real account deletion cascades all private memories, audit events and operation tombstones',async()=>{
 const who=await f.actor();await service.mutate(who,'create',null,create());await f.db.query('DELETE FROM platform_users WHERE id=$1',[who.userId]);
 assert.deepEqual(await counts(who.userId),{operations:0,events:0,memories:0,jobs:0});await assert.rejects(service.list(who),bad(401));
});

test('genuine undo expiry physically purges content and stale create replay cannot resurrect it',async()=>{
 const who=await f.actor(),command=create(),a=await service.mutate(who,'create',null,command);
 await detector.safety.runCurrent(who,a.memory.id);
 const deleted=await service.mutate(who,'delete',a.memory.id,{operationId:randomUUID(),expectedRevision:1});
 await new Promise(resolve=>setTimeout(resolve,10100));
 await assert.rejects(service.mutate(who,'undo',a.memory.id,{operationId:randomUUID(),expectedRevision:2,deletionOperationId:deleted.operation.id}),bad(409));
 const active=await service.mutate(who,'create',null,create({content:'Fictional active memory retained by cleanup'}));
 const fresh=await service.mutate(who,'create',null,create({content:'Fictional still-undoable memory'}));
 const recent=await service.mutate(who,'delete',fresh.memory.id,{operationId:randomUUID(),expectedRevision:1});
 const expired=(await f.db.query('SELECT count(*)::int n FROM platform_memories WHERE deleted_at IS NOT NULL AND undo_until<=clock_timestamp()')).rows[0].n;assert(expired>=1);
 assert.equal(await purgeExpiredMemoryDeletions(f.db,1),1);assert.equal(await purgeExpiredMemoryDeletions(f.db),expired-1);
 assert.equal((await service.get(who,active.memory.id)).content,active.memory.content);
 assert.equal((await f.db.query('SELECT id FROM platform_memories WHERE id=$1',[fresh.memory.id])).rowCount,1);
 await service.mutate(who,'undo',fresh.memory.id,{operationId:randomUUID(),expectedRevision:2,deletionOperationId:recent.operation.id});
 assert.equal((await f.db.query('SELECT id FROM platform_memories WHERE id=$1',[a.memory.id])).rowCount,0);
 assert.equal((await f.db.query('SELECT id FROM platform_memory_safety_sources WHERE memory_id=$1',[a.memory.id])).rowCount,0);assert.equal((await f.db.query("SELECT call_id FROM platform_safety_model_usage WHERE memory_id=$1 AND status='complete'",[a.memory.id])).rowCount,1);
 assert.equal((await f.db.query('SELECT id FROM platform_memory_events WHERE memory_id=$1',[a.memory.id])).rowCount,2);
 await assert.rejects(service.mutate(who,'create',null,command),bad(409));
 assert.equal((await counts(who.userId)).memories,2);
});

test('an authentic older snapshot cannot roll back a newer real privacy change or erase immutable command receipts',async()=>{
 const who=await f.actor(),first=await service.mutate(who,'create',null,create());const row=(await f.db.query('SELECT * FROM platform_memories WHERE id=$1',[first.memory.id])).rows[0];
 await service.mutate(who,'edit',first.memory.id,{operationId:randomUUID(),expectedRevision:1,sensitivity:'restricted'});
 await f.db.query('UPDATE platform_memories SET record_revision=$2,record_ciphertext=$3,sensitivity=$4,last_operation_id=$5,updated_at=$6 WHERE id=$1',[first.memory.id,row.record_revision,row.record_ciphertext,row.sensitivity,row.last_operation_id,row.updated_at]);
 await assert.rejects(service.get(who,first.memory.id),bad(503));
 await assert.rejects(f.db.query('DELETE FROM platform_memory_operations WHERE user_id=$1',[who.userId]));
});


test('053 upgrades genuine pre-existing rows and rerunning the migration preserves their unreviewed source',async()=>{
 const base=readConfig(),schema='memory_upgrade_'+randomUUID().replaceAll('-',''),url=new URL(base.databaseUrl);
 assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname));assert.notEqual(url.port,'5442');url.searchParams.set('options','-c search_path='+schema);
 const admin=new Database(base.databaseUrl),db=new Database(url.toString()),directory=new URL('../migrations/',import.meta.url);let created=false;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);created=true;
  const names=(await fs.readdir(directory)).filter(n=>/^\d+.*\.sql$/.test(n)&&n<'053').sort();
  await db.transaction(async c=>{
   await c.query('CREATE TABLE platform_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
   for(const name of names){await c.query(await fs.readFile(new URL(name,directory),'utf8'));await c.query('INSERT INTO platform_migrations(name) VALUES($1)',[name]);}
  });
  const owner=randomUUID(),id=randomUUID();await db.query("INSERT INTO platform_users(id,email,name,password_hash,account_kind) VALUES($1,$2,'Fictional migration owner','fictional-unused','student')",[owner,owner+'@example.invalid']);
  await db.query("INSERT INTO platform_memories(id,user_id,content,created_at) VALUES($1,$2,'Fictional pre-existing private memory','2026-09-01T12:34:56.123456Z')",[id,owner]);
  const before=(await db.query('SELECT id,user_id,content,created_at FROM platform_memories WHERE id=$1',[id])).rows[0];
  await db.migrate();await db.migrate();
  // Exercise the SQL itself twice as well as the migration ledger; no rewrite is allowed.
  const sql=await fs.readFile(new URL('053_shared_memories.sql',directory),'utf8');await db.transaction(c=>c.query(sql));
  const row=(await db.query('SELECT * FROM platform_memories WHERE id=$1',[id])).rows[0];
  assert.deepEqual({id:row.id,user_id:row.user_id,content:row.content,created_at:row.created_at},before);
  for(const key of ['category','sensitivity','source','status','confidence','confirmed_at','updated_at','record_ciphertext'])assert.equal(row[key],null);
  assert.equal(row.record_revision,0);assert.equal((await db.query('SELECT count(*)::int n FROM platform_memory_operations')).rows[0].n,0);
 }finally{await db.close();try{if(created)await admin.query(`DROP SCHEMA ${schema} CASCADE`);}finally{await admin.close();}}
});
