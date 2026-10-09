import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { Database } from '../src/database.ts';
import { readConfig } from '../src/config.ts';
import { ApiError } from '../src/errors.ts';
import { CostGuard, type CostDecision, type CostReserveInput, type CostReservation, type CostReservationBinding, type CostActualUsage } from '../src/cost-guard.ts';

// Actual isolated loopback PostgreSQL; all policy actors, prices and source IDs
// are fictional accounting fixtures. No provider, execution or enrollment is enabled.
const base = readConfig(),schema = 'cost_dispatch_' + randomUUID().replaceAll('-',''),url = new URL(base.databaseUrl);
assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname));
url.searchParams.set('options','-c search_path=' + schema);
const admin = new Database(base.databaseUrl),db = new Database(url.toString()),guard = new CostGuard(db);
let created = false;
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); created = true; await db.migrate();
  await db.query('CREATE TABLE fictional_commit_failure(id integer UNIQUE DEFERRABLE INITIALLY DEFERRED)'); });
after(async () => { try { await db.close(); } finally { try { if (created) {
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  assert.equal((await admin.query('SELECT nspname FROM pg_namespace WHERE nspname=$1',[schema])).rowCount,0);
} } finally { await admin.close(); } } });
beforeEach(async () => {
  for (const table of ['platform_cost_ledger','platform_cost_reservations','platform_cost_user_policy','platform_cost_global_policy','platform_model_prices','fictional_commit_failure']) await db.query(`DELETE FROM ${table}`);
});
const denied = (error: unknown) => error instanceof ApiError && error.code === 'COST_RECORD_UNCONFIRMED';
async function actor(staff = false) {
  const id = randomUUID();
  await db.query(`INSERT INTO platform_users(id,email,name,password_hash,account_kind)
    VALUES($1,$2,'Fictional dispatch fixture','fictional-unused-hash',$3)`,[id,id+'@example.invalid',staff ? 'staff' : 'student']);
  return id;
}
async function fixture(hard = '1000',soft = '800',behavior = 'notify') {
  const userId = await actor(),approver = await actor(true);
  await db.query(`INSERT INTO platform_cost_global_policy(singleton,month_hard_micros,day_hard_micros,approved_by,approved_at,effective_from)
    VALUES(true,1000000,1000000,$1,clock_timestamp(),clock_timestamp())`,[approver]);
  await db.query(`INSERT INTO platform_cost_user_policy(user_id,policy_key,period,soft_behavior,soft_micros,hard_micros,approved_by,approved_at,effective_from)
    VALUES($1,'fictional-risk-policy','week',$2,$3,$4,$5,clock_timestamp(),clock_timestamp())`,[userId,behavior,soft,hard,approver]);
  for (const [unit,price] of [['input_token','1'],['cached_input_token','1'],['cache_write_input_token','1'],['output_token','2']]) await db.query(`INSERT INTO platform_model_prices(id,provider,model,capability,unit,micros_per_unit,effective_from)
    VALUES($1,'fictional-provider','fictional-model','background',$2,$3,clock_timestamp())`,[randomUUID(),unit,price]);
  return userId;
}
function input(userId: string,options: Partial<CostReserveInput> = {}): CostReserveInput {
  return { userId,sourceKind:'job',sourceId:randomUUID(),capability:'background',purpose:'companion_generation',provider:'fictional-provider',model:'fictional-model',
    maxInputTokens:10,maxOutputTokens:5,...options };
}
function allowed(result: CostDecision): CostReservation { assert.notEqual(result.decision,'block'); if (result.decision === 'block') throw new Error('Expected reservation'); return result.reservation; }
const mark = (r: CostReservation) => db.withBoundedTransaction(client => guard.markDispatchRiskInTransaction(client,r.binding));
const settle = (r: CostReservation,usage: CostActualUsage) => db.withBoundedTransaction(client => guard.settleDispatchRiskInTransaction(client,r.binding,usage));
const release = (r: CostReservation) => db.withBoundedTransaction(client => guard.releaseRiskInTransaction(client,r.binding));
const admit = (r: CostReservation) => db.withBoundedTransaction(client => guard.admitInTransaction(client,r.binding));
const row = async (r: CostReservation) => (await db.query('SELECT * FROM platform_cost_reservations WHERE id=$1',[r.binding.id])).rows[0];
const ledger = async (r: CostReservation) => (await db.query('SELECT * FROM platform_cost_ledger WHERE reservation_id=$1',[r.binding.id])).rows[0];
const expire = (r: CostReservation) => db.query("UPDATE platform_cost_reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[r.binding.id]);

test('migration has no dispatch risk, approval, price or cost defaults',async () => {
  for (const table of ['platform_model_prices','platform_cost_global_policy','platform_cost_user_policy','platform_cost_reservations','platform_cost_ledger']) assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0);
  const column = (await db.query("SELECT column_default,is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name='platform_cost_reservations' AND column_name='dispatch_intent_at'",[schema])).rows[0];
  assert.equal(column.column_default,null); assert.equal(column.is_nullable,'YES');
});

test('a committed intent retains exact accounting source without producing admission, receipt, lease or execution',async () => {
  const userId = await fixture(),r = allowed(await guard.reserve(input(userId))),before = await row(r);
  await mark(r); const held = await row(r); assert(held.dispatch_intent_at instanceof Date); assert.equal(held.status,'reserved'); assert.equal(held.admitted_at,null);
  assert.equal(held.expires_at.toISOString(),before.expires_at.toISOString()); assert.equal(await ledger(r),undefined);
  await mark(r); assert.equal((await row(r)).dispatch_intent_at.toISOString(),held.dispatch_intent_at.toISOString());
  for (const table of ['platform_runtime_leases','platform_jobs','platform_chat_calls']) assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1`,[userId])).rows[0].n,0);
  await assert.rejects(guard.commit(r.binding,{ status:'reported',inputTokens:0,outputTokens:0 }),denied);
  await assert.rejects(guard.release(r.binding),denied);
});

test('uncommitted intent rolls back and ordinary untouched expiry still releases without expenditure',async () => {
  const userId = await fixture('20','10'),r = allowed(await guard.reserve(input(userId))),failure = new Error('Synthetic marker transaction rollback');
  await assert.rejects(db.withBoundedTransaction(async client => { await guard.markDispatchRiskInTransaction(client,r.binding); throw failure; }),error => error === failure);
  assert.equal((await row(r)).dispatch_intent_at,null); await expire(r);
  allowed(await guard.reserve(input(userId))); assert.equal((await row(r)).status,'released'); assert.equal(await ledger(r),undefined);
});

test('expired committed intent is conservatively charged instead of releasing the same hard budget',async () => {
  const userId = await fixture('20','10'),r = allowed(await guard.reserve(input(userId))); await mark(r); const intent = (await row(r)).dispatch_intent_at;
  await expire(r); const next = await guard.reserve(input(userId)); assert.equal(next.decision,'block');
  if (next.decision === 'block') assert.equal(next.reason,'user_hard_limit');
  const charged = await ledger(r),settled = await row(r); assert.equal(charged.cost_micros,'20'); assert.equal(charged.estimated,true); assert.equal(charged.usage_status,'dispatch_uncertain');
  assert.equal(charged.created_at.toISOString(),intent.toISOString()); assert.equal(settled.status,'committed'); assert.equal(settled.admitted_at.toISOString(),intent.toISOString());
  await assert.rejects(admit(r),denied); await assert.rejects(mark(r),denied); await assert.rejects(release(r),denied); await assert.rejects(guard.release(r.binding),denied);
  await guard.reserve(input(userId)); assert.equal((await db.query('SELECT count(*)::int AS n FROM platform_cost_ledger WHERE reservation_id=$1',[r.binding.id])).rows[0].n,1);
});

test('actual fresh-admission COMMIT failure after loopback dispatch preserves prior committed risk for recovery',async () => {
  const userId = await fixture('20','10'),request = input(userId,{ reservationId:randomUUID() }),r = allowed(await guard.reserve(request)); await mark(r);
  await db.query('INSERT INTO fictional_commit_failure(id) VALUES(1)');
  let launches = 0,pending: Promise<Response> | undefined;
  const server = http.createServer((_request,reply) => { launches++; reply.end('Fictional transport response.'); });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve)); const address = server.address(); assert(address && typeof address === 'object');
  try {
    await assert.rejects(db.withBoundedTransaction(async client => {
      assert.notEqual((await guard.reserveInTransaction(client,request)).decision,'block');
      await guard.admitInTransaction(client,r.binding);
      pending = fetch(`http://127.0.0.1:${address.port}/fictional-dispatch`,{ method:'POST',body:'Synthetic accounting boundary.' });
      // The INSERT succeeds; the actual PostgreSQL COMMIT rejects the deferred
      // duplicate after dispatch. No mocked database or paid model is involved.
      await client.query('INSERT INTO fictional_commit_failure(id) VALUES(1)');
      return { pending };
    }),{ code:'23505' });
    assert(pending); const response = await pending; await response.body?.cancel(); assert.equal(launches,1);
    const rolledBack = await row(r); assert.equal(rolledBack.status,'reserved'); assert.equal(rolledBack.admitted_at,null); assert(rolledBack.dispatch_intent_at);
    assert.equal(await ledger(r),undefined); await expire(r); assert.equal((await guard.reserve(input(userId))).decision,'block');
    assert.equal((await ledger(r)).usage_status,'dispatch_uncertain'); assert.equal((await ledger(r)).cost_micros,'20');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('risk settlement with genuinely reported zero differs from unknown spending and cannot grant admission',async () => {
  const userId = await fixture(),r = allowed(await guard.reserve(input(userId))); await mark(r);
  assert.deepEqual(await settle(r,{ status:'reported',inputTokens:0,outputTokens:0 }),{ costMicros:'0',estimated:false });
  const charged = await ledger(r); assert.equal(charged.usage_status,'reported'); assert.equal(charged.estimated,false); assert.equal(charged.cost_micros,'0'); assert.equal((await row(r)).status,'committed');
  assert.deepEqual(await settle(r,{ status:'reported',inputTokens:0,outputTokens:0 }),{ costMicros:'0',estimated:false });
  await assert.rejects(settle(r,{ status:'missing' }),denied); await assert.rejects(admit(r),denied); await assert.rejects(release(r),denied);
});

for (const status of ['missing','invalid'] as const) test(`dispatch risk with ${status} usage retains estimated cost and allows one late actual correction`,async () => {
  const userId = await fixture(),r = allowed(await guard.reserve(input(userId))); await mark(r);
  assert.deepEqual(await settle(r,{ status }),{ costMicros:'20',estimated:true });
  assert.deepEqual(await settle(r,{ status }),{ costMicros:'20',estimated:true }); assert.equal((await ledger(r)).usage_status,status);
  await db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[userId]);
  await db.query('UPDATE platform_cost_global_policy SET effective_to=clock_timestamp()'); await db.query('UPDATE platform_model_prices SET micros_per_unit=99');
  assert.deepEqual(await settle(r,{ status:'reported',inputTokens:2,outputTokens:1 }),{ costMicros:'4',estimated:false });
  assert.deepEqual(await settle(r,{ status:'reported',inputTokens:2,outputTokens:1 }),{ costMicros:'4',estimated:false });
  await assert.rejects(settle(r,{ status:'reported',inputTokens:3,outputTokens:1 }),denied); await assert.rejects(settle(r,{ status }),denied);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM platform_cost_ledger WHERE reservation_id=$1',[r.binding.id])).rows[0].n,1);
});

test('recovered uncertainty can become explicit missing and then late actual without double accounting',async () => {
  const userId = await fixture(),r = allowed(await guard.reserve(input(userId))); await mark(r); await expire(r); await guard.reserve(input(userId));
  assert.equal((await ledger(r)).usage_status,'dispatch_uncertain');
  assert.deepEqual(await settle(r,{ status:'missing' }),{ costMicros:'20',estimated:true }); assert.equal((await ledger(r)).usage_status,'missing');
  assert.deepEqual(await settle(r,{ status:'reported',inputTokens:5,outputTokens:2 }),{ costMicros:'9',estimated:false });
  assert.equal((await ledger(r)).cost_micros,'9'); assert.equal((await db.query('SELECT count(*)::int AS n FROM platform_cost_ledger WHERE reservation_id=$1',[r.binding.id])).rows[0].n,1);
});

test('positive no-launch handling may release only marked reserved risk and cannot release actual admitted spending',async () => {
  const userId = await fixture(),r = allowed(await guard.reserve(input(userId))); await assert.rejects(release(r),denied); await mark(r);
  await release(r); const released = await row(r); assert.equal(released.status,'released'); assert.equal(released.dispatch_intent_at,null); assert.equal(released.admitted_at,null); assert.equal(await ledger(r),undefined);
  await guard.release(r.binding); await assert.rejects(settle(r,{ status:'missing' }),denied);
  const dispatched = allowed(await guard.reserve(input(userId))); await mark(dispatched); await admit(dispatched);
  await assert.rejects(release(dispatched),denied); await assert.rejects(guard.release(dispatched.binding),denied);
  assert.deepEqual(await guard.commit(dispatched.binding,{ status:'reported',inputTokens:1,outputTokens:1 }),{ costMicros:'3',estimated:false });
});

test('marked reservation retry still sees fresh degrade, budget, current price and approval decisions',async () => {
  const userId = await fixture('1000','15','degrade'),request = input(userId,{ reservationId:randomUUID() }),r = allowed(await guard.reserve(request)); await mark(r);
  const other = allowed(await guard.reserve(input(userId))); await admit(other); await guard.commit(other.binding,{ status:'reported',inputTokens:10,outputTokens:5 });
  assert.equal((await guard.reserve(request)).decision,'degrade'); assert.equal((await row(r)).status,'reserved');
  await db.query('UPDATE platform_cost_user_policy SET hard_micros=20 WHERE user_id=$1',[userId]);
  const cap = await guard.reserve(request); assert.equal(cap.decision,'block'); if (cap.decision === 'block') assert.equal(cap.reason,'user_hard_limit');
  await assert.rejects(admit(r),denied); await db.query('UPDATE platform_cost_user_policy SET hard_micros=1000 WHERE user_id=$1',[userId]);
  await db.query('UPDATE platform_model_prices SET micros_per_unit=99'); await assert.rejects(guard.reserve(request),denied); await assert.rejects(admit(r),denied);
  await db.query('UPDATE platform_cost_global_policy SET effective_to=clock_timestamp()'); assert.deepEqual(await guard.reserve(request),{ decision:'block',reason:'global_policy_unavailable' });
  assert.equal((await row(r)).status,'reserved'); assert.equal((await row(r)).admitted_at,null); await release(r);
});

test('intent and settlement reject every mismatched binding without invoking getters or modifying real risk',async () => {
  const userId = await fixture(),r = allowed(await guard.reserve(input(userId))); await mark(r); const held = await row(r); let reads = 0;
  const wrong: unknown[] = [{ ...r.binding,id:randomUUID() },{ ...r.binding,userId:await actor() },{ ...r.binding,sourceId:randomUUID() },
    { ...r.binding,purpose:'different_purpose' },{ ...r.binding,provider:'other-fictional-provider' },{ ...r.binding,model:'other-fictional-model' },
    { ...r.binding,capability:'chat',sourceKind:'chat_call' },{ ...r.binding,extra:true },{ ...r.binding,get sourceId() { reads++; return r.binding.sourceId; } }];
  for (const value of wrong) {
    await assert.rejects(db.withBoundedTransaction(client => guard.markDispatchRiskInTransaction(client,value as CostReservationBinding)),denied);
    await assert.rejects(db.withBoundedTransaction(client => guard.settleDispatchRiskInTransaction(client,value as CostReservationBinding,{ status:'missing' })),denied);
    await assert.rejects(db.withBoundedTransaction(client => guard.releaseRiskInTransaction(client,value as CostReservationBinding)),denied);
  }
  assert.equal(reads,0); assert.equal((await row(r)).dispatch_intent_at.toISOString(),held.dispatch_intent_at.toISOString()); assert.equal((await row(r)).status,'reserved'); assert.equal(await ledger(r),undefined);
});

test('unmarked, expired, admitted and released rows cannot create a new dispatch-risk marker or risk settlement',async () => {
  const userId = await fixture(),untouched = allowed(await guard.reserve(input(userId)));
  await assert.rejects(settle(untouched,{ status:'missing' }),denied); await assert.rejects(release(untouched),denied);
  await expire(untouched); await assert.rejects(mark(untouched),denied);
  const dispatched = allowed(await guard.reserve(input(userId))); await admit(dispatched); await assert.rejects(mark(dispatched),denied); await assert.rejects(settle(dispatched,{ status:'missing' }),denied);
  const released = allowed(await guard.reserve(input(userId))); await guard.release(released.binding); await assert.rejects(mark(released),denied); await assert.rejects(settle(released,{ status:'missing' }),denied);
});
