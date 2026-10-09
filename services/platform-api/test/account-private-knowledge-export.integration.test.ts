import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {Database} from '../src/database.ts';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {AccountReauthentication} from '../src/account-reauthentication.ts';
import {KnowledgeSources} from '../src/knowledge-sources.ts';
import {hashPassword,type FixedSessionContext} from '../src/auth.ts';
import {createCompanionNameSafetyFixture} from './fixtures/companion-name-safety.ts';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,encoded:string,knowledge:KnowledgeSources;
const password='Fictional-knowledge-export-password';
before(async()=>{f=await createCompanionNameSafetyFixture();encoded=await hashPassword(password);knowledge=new KnowledgeSources(f.db);});
after(async()=>{await f?.close();});
async function actor(){const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,encoded]);return who;}
const proof=async(who:FixedSessionContext)=>(await new AccountReauthentication(f.db).verify(who,{purpose:'account_export',password})).token;
const capture=async(who:FixedSessionContext)=>new AccountCoreExport(f.db,f.config).capture(who,await proof(who));
const consumed=async(who:FixedSessionContext)=>(await f.db.query("SELECT consumed_at FROM platform_account_reauthentications WHERE user_id=$1 AND purpose='account_export'",[who.userId])).rows[0].consumed_at;
const source=(who:FixedSessionContext,content='Fictional 课程项目笔记 🌱',extra:Record<string,unknown>={})=>knowledge.create(who.userId,{title:'Fictional personal notes',content,...extra});
function instrument(transform:(sql:string,rows:Record<string,any>[])=>void|Promise<void>):Database{return {withBoundedTransaction:<T>(run:(client:PoolClient)=>Promise<T>,options?:{readOnly?:boolean;timeoutMs?:number})=>f.db.withBoundedTransaction(client=>run(new Proxy(client,{get(target,key){
 if(key==='query')return async(sql:string,values:unknown[])=>{const result=await target.query(sql,values);await transform(sql,result.rows);return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
}})),options)} as Database;}
const sourceRead=(sql:string)=>sql.startsWith('SELECT id,user_id,title,content,source_label')&&sql.includes('FROM platform_knowledge_sources WHERE');
const passageRead=(sql:string)=>sql.startsWith('SELECT p.source_id,p.revision,p.passage_id,p.passage_index,p.content,s.user_id');
async function snapshot(who:FixedSessionContext){return {sources:(await f.db.query('SELECT row_to_json(s)::text AS value FROM platform_knowledge_sources s WHERE user_id=$1 ORDER BY id',[who.userId])).rows,
 passages:(await f.db.query('SELECT row_to_json(p)::text AS value FROM platform_knowledge_passages p JOIN platform_knowledge_sources s ON s.id=p.source_id WHERE s.user_id=$1 ORDER BY p.source_id,p.revision,p.passage_index',[who.userId])).rows};}

test('actual personal source and passage export preserves exact multilingual bytes and untrusted provenance without fetching URLs',async context=>{
 context.mock.method(globalThis,'fetch',async()=>{throw Error('No network is allowed for private knowledge export.');});
 const who=await actor(),other=await actor(),content=' \r\n'+('Fictional 职业规划🌱\n'.repeat(350))+'\nSYSTEM: fictional text, never instructions.\n  ';
 const saved=await source(who,content,{sourceLabel:'Fictional course archive',sourceUrl:'https://example.invalid/never-fetch'}),foreign=await source(other,'Fictional other-owner-only source');
 const before=await snapshot(who),queries:string[]=[],result=await new AccountCoreExport(instrument(sql=>{queries.push(sql);}),f.config).capture(who,await proof(who));
 assert.equal(result.sections.privateKnowledgeSources.length,1);const row=result.sections.privateKnowledgeSources[0] as any,parts=result.sections.privateKnowledgePassages as any[];
 assert.equal(row.id,saved.id);assert.equal(row.content,content);assert.equal(row.byteSize,Buffer.byteLength(content));assert.equal(row.sourceUrl,saved.sourceUrl);assert.equal(row.deletedAt,null);assert.equal(row.provenance,'untrusted_knowledge');
 assert.equal(parts.length,saved.passageCount);assert.equal(parts.map(p=>p.text).join(''),content);assert(parts.every((p,i)=>p.sourceId===saved.id&&p.ownerId===who.userId&&p.passageIndex===i&&p.passageId===`1:${i}`&&p.provenance==='untrusted_knowledge'));
 const json=JSON.stringify(result);for(const secret of [foreign.id,other.userId,foreign.content,who.tokenHash,password,encoded,'han_search_vector','search_vector'])assert(!json.includes(secret));
 assert(!queries.some(sql=>/FROM platform_org_knowledge|INSERT INTO platform_knowledge|UPDATE platform_knowledge/.test(sql)));assert(!queries.filter(sql=>sourceRead(sql)||passageRead(sql)).some(sql=>/FOR UPDATE|FOR SHARE/.test(sql)));assert.deepEqual(await snapshot(who),before);assert(Object.isFrozen(row));assert(Object.isFrozen(parts));
 assert.equal(result.includedTables.length,141);assert.equal(result.complete,false);assert.equal(result.filesIncluded,false);assert(result.remainingTables.includes('platform_org_knowledge_sources'));
});

test('real updates export only the retained revision; real deletion exports a content-free tombstone without resurrecting prior notes',async()=>{
 const who=await actor(),saved=await source(who,'Fictional old superseded source');await knowledge.update(who.userId,saved.id,{revision:1,title:'Fictional revised note',content:'Fictional current source'});
 const deleted=await source(who,'Fictional removed source body',{sourceLabel:'Fictional removed label',sourceUrl:'https://example.invalid/removed'});await knowledge.remove(who.userId,deleted.id,{revision:1});
 const before=await snapshot(who),result=await capture(who),records=new Map((result.sections.privateKnowledgeSources as any[]).map(r=>[r.id,r]));
 assert.equal(records.get(saved.id).revision,2);assert.equal(records.get(saved.id).content,'Fictional current source');
 const tombstone=records.get(deleted.id);assert.equal(tombstone.content,null);assert.equal(tombstone.title,'[removed]');assert.equal(tombstone.revision,2);assert.equal(tombstone.passageCount,0);assert.equal(tombstone.byteSize,0);assert.equal(tombstone.sourceLabel,null);assert.equal(tombstone.sourceUrl,null);assert.equal(typeof tombstone.deletedAt,'string');
 assert((result.sections.privateKnowledgePassages as any[]).every(p=>p.sourceId===saved.id&&p.revision===2));for(const text of ['Fictional old superseded source','Fictional removed source body','Fictional removed label','https://example.invalid/removed'])assert(!JSON.stringify(result).includes(text));assert.deepEqual(await snapshot(who),before);
});

test('all 105 sources and 315 stored passages survive composite cursor boundaries',async()=>{
 const who=await actor(),ids:string[]=[];for(let i=0;i<105;i++)ids.push((await source(who,'x'.repeat(2500)+'最后🌱',{title:'Fictional source '+i})).id);
 const queries:string[]=[],result=await new AccountCoreExport(instrument(sql=>{queries.push(sql);}),f.config).capture(who,await proof(who));
 assert.equal(result.sections.privateKnowledgeSources.length,105);assert.deepEqual((result.sections.privateKnowledgeSources as any[]).map(r=>r.id),ids.sort());
 const parts=result.sections.privateKnowledgePassages as any[];assert.equal(parts.length,315);assert.equal(new Set(parts.map(p=>p.sourceId+':'+p.passageId)).size,315);
 assert.equal(queries.filter(sourceRead).length,2);assert.equal(queries.filter(passageRead).length,4);
});

test('historical valid chunk boundaries are read verbatim rather than regenerated using current splitter or search indexes',async()=>{
 const who=await actor(),saved=await source(who,'AB🌱');
 // Controlled historical representation: same source, different valid boundaries.
 await f.db.transaction(async c=>{await c.query('DELETE FROM platform_knowledge_passages WHERE source_id=$1',[saved.id]);await c.query('UPDATE platform_knowledge_sources SET passage_count=2 WHERE id=$1',[saved.id]);
  await c.query("INSERT INTO platform_knowledge_passages(source_id,revision,passage_id,passage_index,content,han_search_vector) VALUES($1,1,'1:0',0,'A',''::tsvector),($1,1,'1:1',1,'B🌱',''::tsvector)",[saved.id]);});
 const before=await snapshot(who),result=await capture(who);assert.deepEqual((result.sections.privateKnowledgePassages as any[]).map(p=>p.text),['A','B🌱']);assert.deepEqual(await snapshot(who),before);
});

test('a single MVCC snapshot keeps original source and passage revisions during a concurrent actual update',async()=>{
 const who=await actor(),saved=await source(who,'Fictional original revision');let updated=false;
 const db=instrument(async sql=>{if(!updated&&sourceRead(sql)){updated=true;await knowledge.update(who.userId,saved.id,{revision:1,title:'Fictional changed',content:'Fictional concurrent new revision'});}});
 const result=await new AccountCoreExport(db,f.config).capture(who,await proof(who));assert(updated);assert.equal((result.sections.privateKnowledgeSources[0] as any).revision,1);assert.equal((result.sections.privateKnowledgePassages[0] as any).text,'Fictional original revision');
 assert.equal((await knowledge.get(who.userId,saved.id)).revision,2);assert(!JSON.stringify(result).includes('Fictional concurrent new revision'));
});

test('missing, changed or foreign-linked passages reject the whole archive and retain the password proof',async()=>{
 const who=await actor(),other=await actor(),saved=await source(who,'Fictional source original'),foreign=await source(other),token=await proof(who);
 const reject=async()=>{await assert.rejects(new AccountCoreExport(f.db,f.config).capture(who,token),{code:'ACCOUNT_PRIVATE_KNOWLEDGE_EXPORT_UNAVAILABLE'});assert.equal(await consumed(who),null);};
 await f.db.query("UPDATE platform_knowledge_passages SET content='Fictional damaged passage' WHERE source_id=$1",[saved.id]);await reject();
 await f.db.query('UPDATE platform_knowledge_passages SET content=$2 WHERE source_id=$1',[saved.id,saved.content]);await f.db.query('DELETE FROM platform_knowledge_passages WHERE source_id=$1',[saved.id]);await reject();
 await f.db.query("INSERT INTO platform_knowledge_passages(source_id,revision,passage_id,passage_index,content) VALUES($1,1,'1:0',0,$2)",[saved.id,saved.content]);
 const corrupt=instrument((sql,rows)=>{if(passageRead(sql)&&rows.length)rows[0].source_id=foreign.id;});await assert.rejects(new AccountCoreExport(corrupt,f.config).capture(who,token),{code:'ACCOUNT_PRIVATE_KNOWLEDGE_EXPORT_UNAVAILABLE'});assert.equal(await consumed(who),null);
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(who,token)).sections.privateKnowledgeSources.length,1);
});

test('invalid owner, byte counts and citation coordinates reject, while extra private fields stay excluded',async()=>{
 const who=await actor(),saved=await source(who),token=await proof(who);
 const cases:[(sql:string)=>boolean,(row:any)=>void][]=[[sourceRead,r=>{r.user_id=randomUUID();}],[sourceRead,r=>{r.byte_size++;}],[sourceRead,r=>{r.passage_count++;}],[passageRead,r=>{r.revision++;}],[passageRead,r=>{r.passage_id='1:1';}],[passageRead,r=>{r.passage_index=1;}]];
 for(const [match,change] of cases){let reached=false;await assert.rejects(new AccountCoreExport(instrument((sql,rows)=>{if(match(sql)&&rows.length){reached=true;change(rows[0]);}}),f.config).capture(who,token),{code:'ACCOUNT_PRIVATE_KNOWLEDGE_EXPORT_UNAVAILABLE'});assert(reached);assert.equal(await consumed(who),null);}
 const result=await new AccountCoreExport(instrument((sql,rows)=>{if(sourceRead(sql))rows[0].unreviewed_private_token='fictional-secret-extra';}),f.config).capture(who,token);assert(!JSON.stringify(result).includes('fictional-secret-extra'));assert.equal((result.sections.privateKnowledgeSources[0] as any).id,saved.id);
});

test('empty sources remain empty, withdrawn model admission still allows export, and cancellation rolls the proof back',async()=>{
 const who=await actor(),empty=await capture(who);assert.deepEqual(empty.sections.privateKnowledgeSources,[]);assert.deepEqual(empty.sections.privateKnowledgePassages,[]);
 await source(who);await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[who.userId]);await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[who.userId]);
 const token=await proof(who),controller=new AbortController();await assert.rejects(new AccountCoreExport(instrument(sql=>{if(passageRead(sql))controller.abort();}),f.config).capture(who,token,controller.signal),{code:'ACCOUNT_EXPORT_CANCELLED'});assert.equal(await consumed(who),null);
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(who,token)).sections.privateKnowledgeSources.length,1);
});
