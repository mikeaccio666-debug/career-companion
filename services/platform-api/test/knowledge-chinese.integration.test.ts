import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PLATFORM_ACCOUNT_HEADER, type KnowledgeSearchResult } from '@companion/platform-contracts';
import { createProviderRuntime } from '@companion/ai-core';
import { Database } from '../src/database.ts';
import { readConfig } from '../src/config.ts';
import { buildApp } from '../src/app.ts';
import { KnowledgeSources } from '../src/knowledge-sources.ts';
import { LocalBlobStorage } from '../src/storage.ts';
import { FICTIONAL_LEGAL, fictionalRegistration, seedFictionalActiveLegal } from './fixtures/student-entry.ts';
const cases: {key:string;content:string;query:string}[] = JSON.parse(await fs.readFile(new URL('./fixtures/private-knowledge-chinese.json', import.meta.url), 'utf8'));
const base=readConfig({...process.env,PLATFORM_REQUIRE_INVITE:'1'}), schema='chinese_recall_'+randomUUID().replaceAll('-','');
const admin=new Database(base.databaseUrl), url=new URL(base.databaseUrl); url.searchParams.set('options','-c search_path='+schema);
const db=new Database(url.toString()), service=new KnowledgeSources(db);
let app:Awaited<ReturnType<typeof buildApp>>, directory:string, actor:{id:string;headers:Record<string,string>}, foreign:typeof actor, providerCalls=0;
const expected=new Map<string,string>();
async function register() {
  const input=await fictionalRegistration(db,{name:'Fictional retrieval reader',email:randomUUID()+'@example.invalid',password:'Fictional-retrieval-password-123'});
  const r=await app.app.inject({method:'POST',url:'/api/platform/auth/register',headers:{origin:'http://localhost:4321'},payload:input});
  assert.equal(r.statusCode,201,r.body); const id=r.json().user.id;
  const raw=r.headers['set-cookie'], cookie=(Array.isArray(raw)?raw[0]:raw)!.split(';')[0];
  return {id,headers:{origin:'http://localhost:4321',cookie,[PLATFORM_ACCOUNT_HEADER]:id}};
}
async function search(query:string, who=actor, extra:Record<string,unknown>={}) {
  const r=await app.app.inject({method:'POST',url:'/api/platform/knowledge-search',headers:who.headers,payload:{query,limit:5,...extra}});
  assert.equal(r.statusCode,200,r.body); assert.equal(r.headers['cache-control'],'private, no-store');
  return r.json() as KnowledgeSearchResult;
}
before(async()=>{
  await admin.query('CREATE SCHEMA '+schema); await db.migrate(); await seedFictionalActiveLegal(db);
  directory=await fs.mkdtemp(path.join(os.tmpdir(),'chinese-recall-fixture-')); await fs.chmod(directory,0o700);
  app=await buildApp({db,legalBundle:FICTIONAL_LEGAL,config:{...base,databaseUrl:url.toString(),storageDir:directory,requireVerifiedEmail:false},storage:new LocalBlobStorage(directory),
    runtime:createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'0'},fetch:async()=>{providerCalls++;throw Error('Provider transport must remain unused.');}}),enableQueue:false});
  actor=await register(); foreign=await register();
  assert.equal(cases.length,30);
  for(const item of cases) expected.set(item.key,(await service.create(actor.id,{title:'虚构学习记录 · '+item.key,content:item.content})).id);
  // Foreign copies are stronger literal matches and must be filtered before ranking/limit.
  for(const item of cases) await service.create(foreign.id,{title:'虚构另一账号资料',content:item.query+'\n'+item.content});
});
after(async()=>{
  await app?.app.close(); await db.close(); await admin.query('DROP SCHEMA '+schema+' CASCADE'); await admin.close();
  if(directory) await fs.rm(directory,{recursive:true,force:true});
});
test('30 labeled Chinese and mixed queries meet recall@5 without source-ID hints or foreign passage leakage',async()=>{
  let hits=0; const misses:string[]=[];
  for(const item of cases) {
    const result=await search(item.query);
    assert(result.matches.every(x=>[...expected.values()].includes(x.sourceId)));
    assert(result.matches.every(x=>x.provenance==='untrusted_knowledge'&&x.revision===1));
    if(result.matches.some(x=>x.sourceId===expected.get(item.key)))hits++;else misses.push(item.key);
  }
  console.log('Fictional Chinese recall@5: '+hits+'/30; misses: '+misses.join(','));
  assert(hits/30>=0.8,'Chinese recall@5 below 0.8');
  assert.equal(providerCalls,0);
});

test('mixed query constraints, singleton Han and wildcard/operator text cannot be dropped to widen matching',async()=>{
  for(const query of ['SQL 职业方向','职业方向 missingword','职业方向 %missing_',"职业方向 ' OR 1=1 --",'职业方向 龘']) assert.deepEqual((await search(query)).matches,[]);
  assert.deepEqual((await search('职业方向',actor,{sourceIds:[(await service.list(foreign.id))[0].id]})).matches,[]);
  const singleton=await service.create(actor.id,{title:'虚构单字笔记',content:'云 / 单'});
  assert.equal((await search('云',actor,{sourceIds:[singleton.id]})).matches[0].sourceId,singleton.id);
  assert.deepEqual((await search('云 missingword',actor,{sourceIds:[singleton.id]})).matches,[]);
});
test('actual HTTP updates replace the index and preserve revision conflicts; deletion removes all retrieval terms',async()=>{
  const saved=await service.create(actor.id,{title:'虚构更新记录',content:'观测量子纠缠实验'});
  const headers=actor.headers;
  let r=await app.app.inject({method:'PUT',url:'/api/platform/knowledge-sources/'+saved.id,headers,payload:{title:'虚构更新记录',content:'复核航海罗盘方向',revision:1}});
  assert.equal(r.statusCode,200,r.body);
  assert.deepEqual((await search('量子纠缠',actor,{sourceIds:[saved.id]})).matches,[]);
  const fresh=await search('怎样复核航海罗盘',actor,{sourceIds:[saved.id]}); assert.equal(fresh.matches[0].revision,2);assert.equal(fresh.matches[0].text,'复核航海罗盘方向');
  await assert.rejects(service.readPassage(actor.id,{sourceId:saved.id,revision:1,passageId:'1:0'}),(e:any)=>e.code==='KNOWLEDGE_REVISION_CONFLICT');
  r=await app.app.inject({method:'DELETE',url:'/api/platform/knowledge-sources/'+saved.id,headers,payload:{revision:2}});
  assert.equal(r.statusCode,200,r.body);assert.deepEqual((await search('航海罗盘',actor,{sourceIds:[saved.id]})).matches,[]);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM platform_knowledge_passages WHERE source_id=$1',[saved.id])).rows[0].count,0);
  assert.equal(providerCalls,0);
});
