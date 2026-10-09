import {beforeEach,afterEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {createCompanionNameSafetyFixture} from './fixtures/companion-name-safety.ts';
import {knowledgeAccessFixture} from './fixtures/knowledge-access-retention.ts';
import {purgeExpiredKnowledgeAccess} from '../src/knowledge-access-retention.ts';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,library:Awaited<ReturnType<typeof knowledgeAccessFixture>>;
beforeEach(async()=>{f=await createCompanionNameSafetyFixture();library=await knowledgeAccessFixture(f);});
afterEach(async()=>{await library?.close();await f?.close();});
async function expire(ids:string[]){await f.db.query("UPDATE platform_knowledge_access_log SET created_at=statement_timestamp()-interval '181 days',retention_until=statement_timestamp()-interval '1 day' WHERE id=ANY($1::uuid[])",[ids]);}
test('expiry cleanup removes real licensed-access history without changing content or current rights',async()=>{
 const expired=await library.access(),current=await library.access();await expire([expired]);
 const original=await f.db.query('SELECT * FROM platform_knowledge_access_log WHERE id=$1',[current]);
 assert.equal((await f.db.query("SELECT retention_until=created_at+interval '180 days' AS valid FROM platform_knowledge_access_log WHERE id=$1",[current])).rows[0].valid,true);
 const tables=['platform_content_licenses','platform_user_entitlements','platform_org_knowledge_sources','platform_org_knowledge_passages','platform_org_content_operations','platform_org_content_state_proofs','platform_staff_audit'];
 const before=await Promise.all(tables.map(table=>f.db.query('SELECT count(*)::int n FROM '+table)));
 assert.equal(await purgeExpiredKnowledgeAccess(f.db),1);assert.equal(await purgeExpiredKnowledgeAccess(f.db),0);
 assert.deepEqual((await f.db.query('SELECT * FROM platform_knowledge_access_log WHERE id=$1',[current])).rows,original.rows);
 assert.equal((await f.db.query('SELECT * FROM platform_knowledge_access_log WHERE id=$1',[expired])).rowCount,0);
 for(let i=0;i<tables.length;i++)assert.deepEqual((await f.db.query('SELECT count(*)::int n FROM '+tables[i])).rows,before[i].rows);
 // Removing a log does not remove permission; a fresh actual read has its own new retention deadline.
 const newer=await library.access();assert.notEqual(newer,current);assert.equal(await purgeExpiredKnowledgeAccess(f.db),0);
});
test('bounded concurrent batches skip locked records and later clean them without deleting future records',async()=>{
 const ids:string[]=[];for(let i=0;i<6;i++)ids.push(await library.access());await expire(ids);
 const future=await library.access();let unlock!:()=>void,locked!:()=>void;
 const acquired=new Promise<void>(r=>{locked=r;}),gate=new Promise<void>(r=>{unlock=r;});
 const transaction=f.db.transaction(async c=>{await c.query('SELECT id FROM platform_knowledge_access_log WHERE id=$1 FOR UPDATE',[ids[0]]);locked();await gate;});
 await acquired;
 try{const counts=await Promise.all([purgeExpiredKnowledgeAccess(f.db,2),purgeExpiredKnowledgeAccess(f.db,2)]);assert.deepEqual(counts,[2,2]);assert.equal(await purgeExpiredKnowledgeAccess(f.db,2),1);assert.equal(await purgeExpiredKnowledgeAccess(f.db,2),0);}
 finally{unlock();await transaction;}
 assert.equal(await purgeExpiredKnowledgeAccess(f.db,2),1);
 assert.deepEqual((await f.db.query('SELECT id FROM platform_knowledge_access_log')).rows,[{id:future}]);
});
test('invalid batches do not touch storage and the expiry index survives repeated migrations',async()=>{
 for(const limit of [0,-1,101,NaN,Infinity,1.5])await assert.rejects(purgeExpiredKnowledgeAccess({withBoundedTransaction(){throw Error('Database must not be accessed');}} as any,limit),/Invalid knowledge retention batch/);
 const id=await library.access();await expire([id]);
 await f.db.migrate();
 const indexes=await f.db.query("SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname='org_knowledge_access_expiry'");
 assert.equal(indexes.rowCount,1);assert.match(indexes.rows[0].indexdef,/\(retention_until, id\)/);
 assert.equal(await purgeExpiredKnowledgeAccess(f.db),1);
});
