import assert from 'node:assert/strict';
import type { Database } from '../../src/database.ts';

interface OwnedMissingSource {
  readonly ownedSchema:string;
  readonly userId:string;
  readonly submissionId:string;
}
interface Constraint {
  name:string; definition:string; deferrable:boolean; deferred:boolean; validated:boolean;
  update_action:string; delete_action:string; match_type:string; local_columns:string[]; parent_columns:string[];
}
interface QueryReader { query(text:string,values?:unknown[]):Promise<{rows:unknown[]}>; }
const quoted = (value:string) => { assert(/^[a-z][a-z0-9_]{0,62}$/.test(value)); return '"'+value+'"'; };
async function incoming(client:QueryReader):Promise<Constraint[]> {
  return (await client.query(`SELECT c.conname AS name,pg_get_constraintdef(c.oid,true) AS definition,
    c.condeferrable AS deferrable,c.condeferred AS deferred,c.convalidated AS validated,
    c.confupdtype AS update_action,c.confdeltype AS delete_action,c.confmatchtype AS match_type,
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ord)
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.ord) AS local_columns,
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(attnum,ord)
      JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY k.ord) AS parent_columns
    FROM pg_constraint c WHERE c.contype='f'
      AND c.conrelid='platform_companion_prebirth_inventory'::regclass
      AND c.confrelid='platform_onboarding_safety_submissions'::regclass ORDER BY c.conname`)).rows as Constraint[];
}
async function sourceJson(client:QueryReader,source:OwnedMissingSource):Promise<string|undefined> {
  const rows=(await client.query(`SELECT row_to_json(s)::text AS json FROM platform_onboarding_safety_submissions s
    WHERE id=$1 AND user_id=$2`,[source.submissionId,source.userId])).rows as {json:string}[];
  assert(rows.length<=1); return rows[0]?.json;
}
async function inventoryJson(client:QueryReader,userId:string):Promise<string> {
  const head=(await client.query(`SELECT row_to_json(h)::text AS json FROM platform_companion_prebirth_heads h WHERE user_id=$1`,[userId])).rows;
  const entries=(await client.query(`SELECT row_to_json(i)::text AS json FROM platform_companion_prebirth_inventory i
    WHERE user_id=$1 ORDER BY revision,id`,[userId])).rows;
  const owner=(await client.query(`SELECT row_to_json(a)::text AS json FROM
    (SELECT id,prebirth_inventory_owner_id FROM platform_users WHERE id=$1) a`,[userId])).rows;
  return JSON.stringify({owner,head,entries});
}

/** Test-only deliberate damage to an owned schema, after proving ordinary SQL
 * deletion is prohibited. No production reader, crypto or safety gate changes.
 * PostgreSQL JSON text preserves the exact original ciphertext and microseconds;
 * JavaScript Date serialization cannot safely restore the whole original row. */
export async function withControlledMissingIntakeSafetySource<T>(db:Database,source:OwnedMissingSource,run:()=>Promise<T>):Promise<T> {
  assert(/^companion_(generation|draft|intake)_[0-9a-f]{32}$/.test(source.ownedSchema));
  for(const id of [source.userId,source.submissionId]) assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id));
  // Check the actual client's endpoint; a localhost Docker port may legitimately
  // expose the container's private address through inet_server_addr().
  const databaseUrl=db.pool.options.connectionString; assert(databaseUrl);
  const endpoint=new URL(databaseUrl);
  assert(['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname),'Use only the actual loopback PostgreSQL endpoint.');
  const identity=(await db.query('SELECT current_schema() AS schema')).rows[0];
  assert.equal(identity.schema,source.ownedSchema);
  const original=await sourceJson(db,source); assert(original);
  const actual=JSON.parse(original) as {status:string;level:string;detector_mode:string};
  assert.equal(actual.status,'detected'); assert.equal(actual.level,'L0'); assert.equal(actual.detector_mode,'full');
  // These three fixtures use admitted synthetic classification without a usage
  // ledger or response descendant. Refuse a wider destructive cascade setup.
  const descendants=(await db.query(`SELECT
    (SELECT count(*)::int FROM platform_safety_model_usage WHERE source_kind='onboarding' AND submission_id=$1) AS calls,
    (SELECT count(*)::int FROM platform_onboarding_safety_responses WHERE submission_id=$1) AS responses`,[source.submissionId])).rows[0];
  assert.deepEqual(descendants,{calls:0,responses:0});
  const constraints=await incoming(db); assert.equal(constraints.length,1);
  const constraint=constraints[0];
  assert.deepEqual(constraint.local_columns,['intake_submission_id','user_id','intake_operation_id','intake_draft_id','intake_question_id','intake_revision']);
  assert.deepEqual(constraint.parent_columns,['id','user_id','operation_id','draft_id','question_id','submitted_revision']);
  assert.equal(constraint.deferrable,true); assert.equal(constraint.deferred,true); assert.equal(constraint.validated,true);
  assert.equal(constraint.update_action,'a'); assert.equal(constraint.delete_action,'a'); assert.equal(constraint.match_type,'s');
  assert(constraint.definition.startsWith('FOREIGN KEY (')); assert(!constraint.definition.includes(';'));
  const originalInventory=await inventoryJson(db,source.userId);
  await assert.rejects(db.withBoundedTransaction(async client=>{
    assert.equal((await client.query('DELETE FROM platform_onboarding_safety_submissions WHERE id=$1 AND user_id=$2',[source.submissionId,source.userId])).rowCount,1);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  }),error=>(error as {code?:string;constraint?:string}).code==='23503' && (error as {constraint?:string}).constraint===constraint.name);
  assert.equal(await sourceJson(db,source),original,'Ordinary rejected deletion changed the original source.');
  assert.equal(await inventoryJson(db,source.userId),originalInventory,'Ordinary rejected deletion changed the complete inventory.');
  assert.deepEqual(await incoming(db),constraints);

  let result:T|undefined, failure:unknown, failed=false;
  try {
    await db.withBoundedTransaction(async client=>{
      await client.query(`ALTER TABLE platform_companion_prebirth_inventory DROP CONSTRAINT ${quoted(constraint.name)}`);
      assert.equal((await client.query('DELETE FROM platform_onboarding_safety_submissions WHERE id=$1 AND user_id=$2',[source.submissionId,source.userId])).rowCount,1);
    });
    assert.equal(await sourceJson(db,source),undefined);
    assert.equal(await inventoryJson(db,source.userId),originalInventory,'Controlled source damage must preserve the independent inventory.');
    result=await run(); // Original reader/error/rollback/backfill assertions remain here.
  } catch(error) { failed=true; failure=error; }
  finally {
    try {
      await db.withBoundedTransaction(async client=>{
        // A leaked replacement fails this plain INSERT/unique constraint. Never
        // ON CONFLICT overwrite it and conceal a broken reader rollback.
        const current=await sourceJson(client,source);
        if(current===undefined) await client.query(`INSERT INTO platform_onboarding_safety_submissions
          SELECT (json_populate_record(NULL::platform_onboarding_safety_submissions,$1::json)).*`,[original]);
        else assert.equal(current,original,'The original source changed during the missing-reader test.');
        const remaining=await incoming(client);
        if(remaining.length===0) await client.query(`ALTER TABLE platform_companion_prebirth_inventory ADD CONSTRAINT ${quoted(constraint.name)} ${constraint.definition}`);
        else assert.deepEqual(remaining,constraints);
        assert.equal(await sourceJson(client,source),original,'The complete original source was not restored byte for byte.');
        assert.equal(await inventoryJson(client,source.userId),originalInventory,'Independent inventory evidence changed during controlled damage.');
        assert.deepEqual(await incoming(client),constraints,'Actual FK name, definition and flags were not restored.');
      });
    } catch(cleanup) {
      if(failed) throw new AggregateError([failure,cleanup],'The original missing-reader assertion and owned-fixture restoration both failed.');
      throw cleanup;
    }
  }
  if(failed) throw failure;
  return result as T;
}
