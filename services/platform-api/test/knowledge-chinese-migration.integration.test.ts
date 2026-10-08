import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { Database } from '../src/database.ts';
import { readConfig } from '../src/config.ts';
import { KnowledgeSources } from '../src/knowledge-sources.ts';
import { knowledgeHanBigrams, KNOWLEDGE_HAN_RANGES } from '../src/knowledge-tokenization.ts';
const base=readConfig(process.env), schema='han_upgrade_'+randomUUID().replaceAll('-',''), admin=new Database(base.databaseUrl), url=new URL(base.databaseUrl);
url.searchParams.set('options','-c search_path='+schema); const db=new Database(url.toString()), service=new KnowledgeSources(db);
const owner=randomUUID(), foreign=randomUUID(), id=randomUUID(), foreignId=randomUUID(), tombstoneId=randomUUID(), content='SQL 业务分析：核对变化与证据。𠀀𠀁𠀂';
let sourceBefore:Record<string,unknown>[], passageBefore:Record<string,unknown>;
before(async()=>{
  await admin.query('CREATE SCHEMA '+schema);
  const directory=new URL('../migrations/',import.meta.url), names=(await fs.readdir(directory)).filter(x=>/^\d+.*\.sql$/.test(x)&&x<'066').sort();
  assert(names.includes('065_org_knowledge.sql'));
  await db.transaction(async c=>{
    await c.query('CREATE TABLE platform_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
    for(const name of names) { await c.query(await fs.readFile(new URL(name,directory),'utf8')); await c.query('INSERT INTO platform_migrations(name) VALUES($1)',[name]); }
    for(const who of [owner,foreign]) await c.query("INSERT INTO platform_users(id,email,name,password_hash) VALUES($1,$2,'Fictional upgrade reader','fictional-unused-no-login')",[who,who+'@example.invalid']);
    for(const [source,user] of [[id,owner],[foreignId,foreign]]) {
      await c.query("INSERT INTO platform_knowledge_sources(id,user_id,title,content,revision,passage_count,byte_size,created_at,updated_at) VALUES($1,$2,'虚构旧资料',$3,7,1,$4,'2026-01-01T00:00:00Z','2026-02-01T00:00:00Z')",[source,user,content,Buffer.byteLength(content)]);
      await c.query("INSERT INTO platform_knowledge_passages(source_id,revision,passage_id,passage_index,content) VALUES($1,7,'7:0',0,$2)",[source,content]);
    }
  });
  await db.query("INSERT INTO platform_knowledge_sources(id,user_id,title,content,revision,passage_count,byte_size,deleted_at) VALUES($1,$2,'[removed]',NULL,8,0,0,'2026-02-01T00:00:00Z')",[tombstoneId,owner]);
  sourceBefore=(await db.query('SELECT * FROM platform_knowledge_sources ORDER BY id')).rows;
  passageBefore=(await db.query('SELECT * FROM platform_knowledge_passages WHERE source_id=$1',[id])).rows[0];
  await db.migrate();
});
after(async()=>{await db.close();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.close();});
test('actual 065-to-066 upgrade backfills existing words without changing source/citation metadata and is repeatable',async()=>{
  assert.deepEqual((await db.query('SELECT * FROM platform_knowledge_sources ORDER BY id')).rows,sourceBefore);
  const after=(await db.query('SELECT * FROM platform_knowledge_passages WHERE source_id=$1',[id])).rows[0],{han_search_vector,...old}=after;
  assert.deepEqual(old,passageBefore); assert(han_search_vector.length>0);
  const found=await service.search(owner,{query:'SQL 如何做业务分析'});
  assert.equal(found.matches.length,1);assert.equal(found.matches[0].sourceId,id);assert.equal(found.matches[0].revision,7);assert.equal(found.matches[0].text,content);
  assert.equal((await service.readPassage(owner,{sourceId:id,revision:7,passageId:'7:0'})).text,content);
  assert.deepEqual((await service.search(owner,{query:'业务分析',sourceIds:[foreignId]})).matches,[]);
  assert.deepEqual((await service.search(owner,{query:'业务分析',sourceIds:[tombstoneId]})).matches,[]);
  await assert.rejects(service.get(owner,tombstoneId),(e:any)=>e.status===404);
  await db.migrate(); assert.deepEqual((await db.query('SELECT * FROM platform_knowledge_passages WHERE source_id=$1',[id])).rows[0],after);
  const index=await db.query("SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname='platform_knowledge_passages_han_search'",[schema]);assert.match(index.rows[0].indexdef,/USING gin/);
});
test('database backfill and application tokenizer agree at all frozen Han range boundaries and supplementary characters',async()=>{
  const boundaries=KNOWLEDGE_HAN_RANGES.map(([a,b])=>String.fromCodePoint(a)+String.fromCodePoint(b)).join(' / '),
    samples=[content,boundaries,'系统设计 系统设计 SQL カナ 🌱 业务\n分析','单',"' OR 1=1 -- %_\\\\"];
  for(const text of samples) {
    const sql=(await db.query('SELECT platform_knowledge_han_terms($1) AS terms',[text])).rows[0].terms;
    assert.equal(sql,knowledgeHanBigrams(text).join(' '));
  }
});
