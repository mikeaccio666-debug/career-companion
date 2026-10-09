import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import type { Database } from '../src/database.ts';
import { execFileSync,spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
import { auditAccountDataCoverage,readAccountSchemaInventory } from '../src/account-data-coverage.ts';
import { ACCOUNT_DATA_SCHEMA } from '../src/account-data-schema.ts';

let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>;
before(async()=>{f=await createCompanionNameSafetyFixture();});
after(async()=>{await f?.close();});
const inspect=async(client:Pick<Database,'query'>=f.db)=>auditAccountDataCoverage(await readAccountSchemaInventory(client));
async function rolledBack(run:(client:PoolClient)=>Promise<void>){
  const rollback=new Error('fictional catalog rollback');
  await assert.rejects(f.db.transaction(async client=>{await run(client);throw rollback;}),error=>error===rollback);
}

test('all 166 migrated tables are reviewed, but the inventory does not claim a complete account export',async()=>{
  const inventory=await readAccountSchemaInventory(f.db),report=auditAccountDataCoverage(inventory);
  assert.equal(new Set(ACCOUNT_DATA_SCHEMA.map(entry=>entry.table)).size,ACCOUNT_DATA_SCHEMA.length);
  assert.equal(report.schemaStatus,'reviewed',JSON.stringify(report.tables.filter(row=>row.schemaStatus!=='reviewed')));
  assert.equal(report.tableCount,166);assert.equal(report.excludedTables,7);assert.equal(report.requiredProjections,159);
  assert.equal(report.exportReady,false);assert.equal(report.exportStatus,'not_implemented');
  for(const column of inventory.columns.filter(column=>column.column_name==='user_id')){
    const entry=report.tables.find(entry=>entry.table===column.table_name)!;
    assert.equal(entry.exportStatus,['platform_knowledge_access_log','platform_user_entitlements'].includes(entry.table)?'excluded_product_policy':'blocked_projection_required');assert(entry.reason.length>30);
  }
  assert(Object.isFrozen(report));assert(Object.isFrozen(report.tables));
});

test('catalog-only inspection cannot include a fictional owner’s name, email, password or data rows',async()=>{
  const owner=await f.actor(false,'Fictional private coverage owner');
  const queries:string[]=[];
  const client=new Proxy(f.db,{get(target,key){
    if(key==='query')return async(sql:string,values:unknown[])=>{queries.push(sql);return target.query(sql,values);};
    return Reflect.get(target,key);
  }});
  const report=await inspect(client),serialized=JSON.stringify(report);
  assert.equal(queries.length,2);assert(queries.every(sql=>/FROM (information_schema\.columns|pg_constraint)/.test(sql)));
  assert(!serialized.includes(owner.userId));assert(!serialized.includes('Fictional private coverage owner'));
  assert(!serialized.includes('fictional-unused-hash'));assert(!serialized.includes('@example.invalid'));
});

test('new direct and indirect owner tables both block coverage even when they have no registered policy',async()=>{
  await rolledBack(async client=>{
    await client.query('CREATE TABLE platform_fictional_direct(user_id uuid REFERENCES platform_users(id),content text)');
    await client.query('CREATE TABLE platform_fictional_indirect(job_id uuid REFERENCES platform_jobs(id),content text)');
    const report=await inspect(client);assert.equal(report.schemaStatus,'blocked');
    for(const name of ['platform_fictional_direct','platform_fictional_indirect']){
      const row=report.tables.find(entry=>entry.table===name)!;
      assert.equal(row.schemaStatus,'unreviewed');assert.equal(row.exportStatus,'blocked_schema_review');assert.equal(row.policy,null);
    }
  });
});

test('an added credential column on an otherwise excluded table removes its exclusion until reviewed',async()=>{
  await rolledBack(async client=>{
    await client.query('ALTER TABLE platform_worker_heartbeats ADD COLUMN fictional_private_token text');
    const report=await inspect(client),row=report.tables.find(entry=>entry.table==='platform_worker_heartbeats')!;
    assert.equal(row.schemaStatus,'changed');assert.equal(row.exportStatus,'blocked_schema_review');
    assert.equal(report.excludedTables,6);assert.equal(report.schemaStatus,'blocked');
  });
});

test('losing an actual ownership FK is detected even without any column change',async()=>{
  await rolledBack(async client=>{
    const name=(await client.query(`SELECT k.conname FROM pg_constraint k
      JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=current_schema() AND c.relname='platform_request_limits' AND k.contype='f'`)).rows[0].conname;
    assert.match(name,/^[a-z_]+$/);
    await client.query(`ALTER TABLE platform_request_limits DROP CONSTRAINT "${name}"`);
    const report=await inspect(client),row=report.tables.find(entry=>entry.table==='platform_request_limits')!;
    assert.equal(row.schemaStatus,'changed');assert.equal(report.schemaStatus,'blocked');
  });
});

test('missing tables and an empty schema cannot be mistaken for zero personal data',async()=>{
  await rolledBack(async client=>{
    await client.query('DROP TABLE platform_worker_heartbeats');
    const report=await inspect(client);
    assert.equal(report.schemaStatus,'blocked');
    assert.equal(report.tables.find(entry=>entry.table==='platform_worker_heartbeats')!.schemaStatus,'missing');
  });
  const empty=auditAccountDataCoverage({columns:[],fks:[]});
  assert.equal(empty.tableCount,166);assert.equal(empty.schemaStatus,'blocked');assert.equal(empty.exportReady,false);
});

test('reviewed indirect, credential, orphan file and financial tables retain their explicit coverage requirements',async()=>{
  const report=await inspect(),rows=new Map(report.tables.map(entry=>[entry.table,entry]));
  for(const name of ['platform_goal_plan_steps','platform_job_attempts','platform_knowledge_passages'])
    assert.equal(rows.get(name)!.policy,'indirect_owner_projection');
  for(const name of ['platform_users','platform_sessions','platform_invites','platform_account_reauthentications'])
    assert.equal(rows.get(name)!.policy,'credential_projection');
  for(const name of ['platform_upload_write_events','platform_upload_removals','platform_companion_birth_assets'])
    assert.equal(rows.get(name)!.policy,'file_projection');
  for(const name of ['platform_mentor_financial_records','platform_mentor_financial_proofs']){
    assert.equal(rows.get(name)!.policy,'financial_review');assert.equal(rows.get(name)!.exportStatus,'blocked_projection_required');
  }
});

test('real CLI reads the migrated fixture schema and still reports export not implemented',async()=>{
  const url=new URL(readConfig().databaseUrl);url.searchParams.set('options','-c search_path='+f.schema);
  const cli=fileURLToPath(new URL('../src/account-data-coverage-main.ts',import.meta.url));
  const output=execFileSync(process.execPath,['--import','tsx',cli],{encoding:'utf8',timeout:10000,
    env:{...process.env,PLATFORM_DATABASE_URL:url.toString(),PLATFORM_ALLOW_PROVIDER_CALLS:'0'}});
  const report=JSON.parse(output);
  assert.equal(report.tableCount,166);assert.equal(report.schemaStatus,'reviewed');assert.equal(report.exportReady,false);
  assert.equal(report.exportStatus,'not_implemented');assert(!output.includes(url.toString()));
});

test('CLI rejects arguments before config or database access and does not echo supplied values',()=>{
  const cli=fileURLToPath(new URL('../src/account-data-coverage-main.ts',import.meta.url));
  const child=spawnSync(process.execPath,['--import','tsx',cli,'fictional-private-argument'],{encoding:'utf8',timeout:10000,
    env:{...process.env,PLATFORM_DATABASE_URL:'fictional-invalid-private-database-url'}});
  assert.equal(child.status,2);assert.deepEqual(JSON.parse(child.stdout),{status:'rejected',code:'ACCOUNT_COVERAGE_NO_ARGUMENTS'});
  assert.equal(child.stderr,'');assert(!child.stdout.includes('fictional-private'));
});


test('product exclusions are personal, named and do not exempt related organization or mentor records',async()=>{
  const report=await inspect(),rows=new Map(report.tables.map(row=>[row.table,row]));
  assert.deepEqual(report.tables.filter(row=>row.exportStatus==='excluded_product_policy').map(row=>row.table),['platform_knowledge_access_log','platform_user_entitlements']);
  for(const table of ['platform_knowledge_access_log','platform_user_entitlements']){
    const row=rows.get(table)!;assert.equal(row.policy,'product_exclusion');
    assert.equal(row.policyReference,'docs/product/04-manteng-assets.md#411-账号删除与导出');assert.match(row.reason,/delet/);
  }
  for(const table of ['platform_org_content_state_proofs','platform_org_content_operations','platform_mentor_sessions'])
    assert.equal(rows.get(table)!.exportStatus,'blocked_projection_required');
  assert.equal(report.exportReady,false);
});

test('each product exemption loses effect after column or ownership changes, and missing tables still block',async()=>{
  for(const table of ['platform_knowledge_access_log','platform_user_entitlements']){
    await rolledBack(async client=>{
      await client.query(`ALTER TABLE ${table} ADD COLUMN fictional_new_personal_data text`);
      const report=await inspect(client),row=report.tables.find(row=>row.table===table)!;
      assert.equal(row.schemaStatus,'changed');assert.equal(row.exportStatus,'blocked_schema_review');assert.equal(report.excludedTables,6);
    });
    await rolledBack(async client=>{
      const name=(await client.query(`SELECT k.conname FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_class p ON p.oid=k.confrelid
        WHERE n.nspname=current_schema() AND c.relname=$1 AND p.relname='platform_users' AND k.contype='f'`,[table])).rows[0].conname;
      assert.match(name,/^[a-z_]+$/);await client.query(`ALTER TABLE ${table} DROP CONSTRAINT "${name}"`);
      const row=(await inspect(client)).tables.find(row=>row.table===table)!;
      assert.equal(row.schemaStatus,'changed');assert.equal(row.exportStatus,'blocked_schema_review');
    });
    await rolledBack(async client=>{
      await client.query(`DROP TABLE ${table}`);const row=(await inspect(client)).tables.find(row=>row.table===table)!;
      assert.equal(row.schemaStatus,'missing');assert.equal(row.exportStatus,'blocked_schema_review');
    });
  }
});
