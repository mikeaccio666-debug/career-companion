import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Database } from '../src/database.ts';
import { readConfig } from '../src/config.ts';
import { ApiError } from '../src/errors.ts';
import { CostGuard, type CostDecision, type CostReserveInput, type CostReservation } from '../src/cost-guard.ts';

// Real loopback PostgreSQL, isolated money policies and fictional counts. No provider calls or production approvals.
const base = readConfig(), schema = 'cost_guard_' + randomUUID().replaceAll('-', ''), url = new URL(base.databaseUrl);
assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Use only loopback fictional PostgreSQL.');
url.searchParams.set('options', '-c search_path=' + schema);
const admin = new Database(base.databaseUrl), db = new Database(url.toString()), guard = new CostGuard(db);
let created = false;
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); created = true; await db.migrate(); });
after(async () => { try { await db.close(); } finally { try { if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.close(); } } });
beforeEach(async () => {
  await db.query('DELETE FROM platform_deleted_account_cost_daily'); await db.query('DELETE FROM platform_cost_ledger'); await db.query('DELETE FROM platform_cost_reservations');
  await db.query('DELETE FROM platform_cost_user_policy'); await db.query('DELETE FROM platform_cost_global_policy');
  await db.query('DELETE FROM platform_model_prices');
});
const denied = (error: unknown) => error instanceof ApiError && error.code === 'COST_RECORD_UNCONFIRMED';
async function actor(staff = false) {
  const id = randomUUID();
  await db.query(`INSERT INTO platform_users(id,email,name,password_hash,account_kind)
    VALUES($1,$2,'Fictional cost fixture','fictional-unused-hash',$3)`, [id, id + '@example.invalid', staff ? 'staff' : 'student']); return id;
}
async function policies(userId: string, hard = '1000', soft = '800', day: string | null = null, softBehavior = 'notify', period = 'week') {
  const approver = await actor(true);
  await db.query(`INSERT INTO platform_cost_global_policy(singleton,month_hard_micros,day_hard_micros,approved_by,approved_at,effective_from)
    VALUES(true,1000000,1000000,$1,clock_timestamp(),clock_timestamp()) ON CONFLICT(singleton) DO NOTHING`, [approver]);
  await db.query(`INSERT INTO platform_cost_user_policy(user_id,policy_key,period,soft_behavior,soft_micros,hard_micros,day_micros,approved_by,approved_at,effective_from)
    VALUES($1,'fictional-explicit-policy',$2,$3,$4,$5,$6,$7,clock_timestamp(),clock_timestamp())`, [userId, period, softBehavior, soft, hard, day, approver]);
}
async function prices(capability = 'background', input = '1', output = '2') {
  for (const [unit, price] of [['input_token', input], ['cached_input_token', input], ['cache_write_input_token', input], ['output_token', output]]) await db.query(`INSERT INTO platform_model_prices(id,provider,model,capability,unit,micros_per_unit,effective_from)
    VALUES($1,'fictional-provider','fictional-model',$2,$3,$4,clock_timestamp())`, [randomUUID(), capability, unit, price]);
}
function input(userId: string, options: Partial<CostReserveInput> = {}): CostReserveInput {
  return { userId, sourceKind: 'job', sourceId: randomUUID(), capability: 'background', purpose: 'companion_generation',
    provider: 'fictional-provider', model: 'fictional-model', maxInputTokens: 10, maxOutputTokens: 5, ...options };
}
function allowed(result: CostDecision): CostReservation {
  assert.notEqual(result.decision, 'block'); if (result.decision === 'block') throw new Error('Expected real reservation.'); return result.reservation;
}
async function admit(r: CostReservation) { await db.withBoundedTransaction(client => guard.admitInTransaction(client, r.binding)); }
async function finish(userId: string, inputTokens = 10, outputTokens = 5) {
  const r = allowed(await guard.reserve(input(userId))); await admit(r); await guard.commit(r.binding, { status: 'reported', inputTokens, outputTokens }); return r;
}
async function fixture(hard = '1000', soft = '800', day: string | null = null, behavior = 'notify', period = 'week') {
  const userId = await actor(); await policies(userId, hard, soft, day, behavior, period); await prices(); return userId;
}
async function row(r: CostReservation) { return (await db.query('SELECT * FROM platform_cost_reservations WHERE id=$1', [r.binding.id])).rows[0]; }
async function ledger(r: CostReservation) { return (await db.query('SELECT * FROM platform_cost_ledger WHERE reservation_id=$1', [r.binding.id])).rows[0]; }

test('migration seeds no price, approved budget, cohort or reservation; absent policy is a truthful block', async () => {
  for (const table of ['platform_model_prices', 'platform_cost_global_policy', 'platform_cost_user_policy', 'platform_cost_reservations', 'platform_cost_ledger']) {
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);
  }
  const revision = (await db.query("SELECT column_default,is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name='platform_cost_reservations' AND column_name='pricing_revision'", [schema])).rows[0];
  assert.equal(revision.column_default, null); assert.equal(revision.is_nullable, 'NO');
  const userId = await actor(); assert.deepEqual(await guard.reserve(input(userId)), { decision: 'block', reason: 'global_policy_unavailable' });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM platform_cost_reservations')).rows[0].n, 0);
});
test('explicit user policy and unambiguous current route prices are mandatory; they confer no enrollment or execution', async () => {
  const userId = await actor(), other = await actor(); await policies(other); await prices();
  assert.deepEqual(await guard.reserve(input(userId)), { decision: 'block', reason: 'user_policy_unavailable' });
  await policies(userId); await db.query("DELETE FROM platform_model_prices WHERE unit='output_token'");
  assert.deepEqual(await guard.reserve(input(userId)), { decision: 'block', reason: 'price_unavailable' });
  await prices(); assert.deepEqual(await guard.reserve(input(userId)), { decision: 'block', reason: 'price_unavailable' });
  await db.query('DELETE FROM platform_model_prices'); await prices();
  const r = allowed(await guard.reserve(input(userId))); assert.equal((await row(r)).status, 'reserved'); assert.equal(await ledger(r), undefined);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM platform_runtime_leases WHERE user_id=$1', [userId])).rows[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM platform_jobs WHERE user_id=$1', [userId])).rows[0].n, 0);
});
test('reservation IDs are immutable and idempotent only for the exact closed owner/source/route/count binding', async () => {
  const userId = await fixture(), request = input(userId, { reservationId: randomUUID() });
  const r = allowed(await guard.reserve(request)); assert.deepEqual(allowed(await guard.reserve(request)), r);
  for (const changed of [{ sourceId: randomUUID() }, { userId: await actor() }, { model: 'other-fictional-model' }, { maxInputTokens: 11 }, { purpose: 'different_purpose' }]) {
    await assert.rejects(guard.reserve({ ...request, ...changed }), denied);
  }
  assert.equal(r.estimateMicros, '20'); assert.equal(typeof r.estimateMicros, 'string');
  await assert.rejects(guard.commit(r.binding, { status: 'reported', inputTokens: 1, outputTokens: 1 }), denied);
  await admit(r); await assert.rejects(admit(r), denied); await assert.rejects(guard.reserve(request), denied);
});
test('concurrent owner and cross-owner reservations cannot overspend user or global month hard budgets', async () => {
  const userId = await fixture('20', '10');
  const first = await Promise.all([guard.reserve(input(userId)), guard.reserve(input(userId))]);
  assert.equal(first.filter(r => r.decision !== 'block').length, 1); assert.equal(first.filter(r => r.decision === 'block' && r.reason === 'user_hard_limit').length, 1);
  await db.query('DELETE FROM platform_cost_reservations'); await db.query('UPDATE platform_cost_global_policy SET month_hard_micros=20');
  const other = await actor(); await policies(other, '20', '10');
  const cross = await Promise.all([guard.reserve(input(userId)), guard.reserve(input(other))]);
  assert.equal(cross.filter(r => r.decision !== 'block').length, 1); assert.equal(cross.filter(r => r.decision === 'block' && r.reason === 'global_month_limit').length, 1);
  assert.equal((await db.query('SELECT sum(estimate_micros)::text AS n FROM platform_cost_reservations')).rows[0].n, '20');
});
test('only never-admitted expiry/release frees a reservation; admitted unknown expenditure is charged conservatively', async () => {
  const userId = await fixture('20', '10'), r = allowed(await guard.reserve(input(userId)));
  await db.query("UPDATE platform_cost_reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [r.binding.id]);
  const next = allowed(await guard.reserve(input(userId))); assert.equal((await row(r)).status, 'released'); assert.equal(await ledger(r), undefined);
  await admit(next); await assert.rejects(guard.release(next.binding), denied);
  await db.query("UPDATE platform_cost_reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [next.binding.id]);
  const capped = await guard.reserve(input(userId)); assert.equal(capped.decision, 'block');
  const cost = await ledger(next); assert.equal(cost.cost_micros, '20'); assert.equal(cost.estimated, true); assert.equal(cost.usage_status, 'expired');
  assert.equal((await row(next)).status, 'committed'); await assert.rejects(admit(next), denied);
  await guard.commit(next.binding, { status: 'missing' }); assert.equal((await ledger(next)).usage_status, 'missing');
});
test('unknown missing/invalid cost is never zero; genuine reported zero and late reported counts remain distinct', async () => {
  const userId = await fixture();
  for (const status of ['missing', 'invalid'] as const) {
    const r = allowed(await guard.reserve(input(userId))); await admit(r);
    assert.deepEqual(await guard.commit(r.binding, { status }), { costMicros: '20', estimated: true });
    await guard.commit(r.binding, { status }); assert.equal((await ledger(r)).estimated, true);
    await db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [userId]);
    assert.deepEqual(await guard.commit(r.binding, { status: 'reported', inputTokens: 0, outputTokens: 0 }), { costMicros: '0', estimated: false });
    await guard.commit(r.binding, { status: 'reported', inputTokens: 0, outputTokens: 0 });
    await assert.rejects(guard.commit(r.binding, { status }), denied);
    assert.equal((await row(r)).status, 'committed'); await assert.rejects(admit(r), denied);
  }
});
test('real price snapshot survives later pricing changes and charges counts above estimate without discarding expenditure', async () => {
  const userId = await fixture('30', '10'), r = allowed(await guard.reserve(input(userId))); await admit(r);
  await db.query('UPDATE platform_model_prices SET micros_per_unit=99');
  assert.deepEqual(await guard.commit(r.binding, { status: 'reported', inputTokens: 50, outputTokens: 10 }), { costMicros: '70', estimated: false });
  const next = await guard.reserve(input(userId)); assert.equal(next.decision, 'block');
  assert.equal((await ledger(r)).cost_micros, '70');
});
test('pending reservations count toward hard only; completed soft/day cost degrades only configured policies', async () => {
  const userId = await fixture('1000', '15', '15', 'degrade');
  const held = await guard.reserve(input(userId)); assert.equal(held.decision, 'ok');
  const held2 = await guard.reserve(input(userId)); assert.equal(held2.decision, 'ok');
  await finish(userId);
  const next = await guard.reserve(input(userId)); assert.equal(next.decision, 'degrade');
  assert.deepEqual(next.reasons, ['user_soft_limit', 'user_day_limit']);
  await db.query("UPDATE platform_cost_user_policy SET soft_behavior='notify',day_micros=NULL WHERE user_id=$1", [userId]);
  const notify = await guard.reserve(input(userId)); assert.equal(notify.decision, 'ok');
  assert.deepEqual(notify.reasons, ['user_soft_limit']);
});
test('same-id reservation replay preserves current degrade and warnings without extending expiry or charging twice', async () => {
  const userId = await fixture('1000', '15', '15', 'degrade'), request = input(userId, { reservationId: randomUUID() });
  const r = allowed(await guard.reserve(request)); await finish(userId);
  const replay = await guard.reserve(request); assert.equal(replay.decision, 'degrade');
  assert.deepEqual(replay.reasons, ['user_soft_limit', 'user_day_limit']); assert.deepEqual(replay.reservation, r);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM platform_cost_reservations WHERE status='reserved'")).rows[0].n, 1);
  await assert.rejects(guard.reserve({ ...request, ttlSeconds: 121 }), denied);
});
test('ordinary simultaneous cross-user calls cannot exceed the global day hard budget', async () => {
  const first = await fixture(), second = await actor(); await policies(second);
  await db.query('UPDATE platform_cost_global_policy SET day_hard_micros=20');
  const result = await Promise.all([guard.reserve(input(first)), guard.reserve(input(second))]);
  assert.equal(result.filter(r => r.decision !== 'block').length, 1);
  assert.equal(result.filter(r => r.decision === 'block' && r.reason === 'global_day_limit').length, 1);
  assert.equal((await db.query("SELECT sum(estimate_micros)::text AS n FROM platform_cost_reservations WHERE status='reserved'")).rows[0].n, '20');
});
test('UTC day and week boundaries exclude prior completed costs but carry unfinished admitted and reserved money', async () => {
  const userId = await fixture('40', '10', '10', 'degrade'), finished = await finish(userId);
  await db.query("UPDATE platform_cost_ledger SET created_at=(date_trunc('week',clock_timestamp() AT TIME ZONE 'UTC')-interval '1 microsecond') AT TIME ZONE 'UTC' WHERE reservation_id=$1", [finished.binding.id]);
  const pending = allowed(await guard.reserve(input(userId))); await db.query("UPDATE platform_cost_reservations SET created_at=clock_timestamp()-interval '40 days' WHERE id=$1", [pending.binding.id]);
  const otherPending = allowed(await guard.reserve(input(userId))); await admit(otherPending);
  await db.query("UPDATE platform_cost_reservations SET created_at=clock_timestamp()-interval '40 days' WHERE id=$1", [otherPending.binding.id]);
  const cap = await guard.reserve(input(userId)); assert.equal(cap.decision, 'block'); if (cap.decision === 'block') assert.equal(cap.reason, 'user_hard_limit');
  await guard.release(pending.binding); await guard.commit(otherPending.binding, { status: 'reported', inputTokens: 1, outputTokens: 0 });
  const cost = await ledger(otherPending), source = await row(otherPending); assert.equal(cost.created_at.toISOString(), source.admitted_at.toISOString());
  const current = await guard.reserve(input(userId)); assert.equal(current.decision, 'ok');
});
test('global day limit sees completed cost and 80 percent monthly usage creates an internal warning', async () => {
  const userId = await fixture(); await db.query('UPDATE platform_cost_global_policy SET month_hard_micros=25,day_hard_micros=1000');
  await finish(userId);
  const warning = await guard.reserve(input(userId, { maxInputTokens: 1, maxOutputTokens: 1 })); assert.equal(warning.decision, 'ok');
  assert.deepEqual(warning.reasons, ['global_budget_warning']);
  await guard.release(allowed(warning).binding); await db.query('UPDATE platform_cost_global_policy SET day_hard_micros=20');
  const daily = await guard.reserve(input(userId, { maxInputTokens: 1, maxOutputTokens: 1 })); assert.equal(daily.decision, 'block');
  if (daily.decision === 'block') { assert.equal(daily.reason, 'global_day_limit'); assert.equal(daily.resumeAt, (await db.query("SELECT (date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC')+interval '1 day') AT TIME ZONE 'UTC' AS t")).rows[0].t.toISOString()); }
});
test('admission rechecks current approved policy and reduced hard budget while settlement remains recordable after policy revocation', async () => {
  const userId = await fixture(), r = allowed(await guard.reserve(input(userId)));
  await db.query('UPDATE platform_cost_user_policy SET hard_micros=10,soft_micros=10 WHERE user_id=$1', [userId]);
  await assert.rejects(admit(r), denied); assert.equal((await row(r)).status, 'reserved');
  await db.query('UPDATE platform_cost_user_policy SET hard_micros=1000 WHERE user_id=$1', [userId]); await admit(r);
  await db.query('UPDATE platform_cost_global_policy SET effective_to=clock_timestamp()');
  assert.deepEqual(await guard.commit(r.binding, { status: 'reported', inputTokens: 2, outputTokens: 1 }), { costMicros: '4', estimated: false });
  assert.deepEqual(await guard.reserve(input(userId)), { decision: 'block', reason: 'global_policy_unavailable' });
});
test('expired, changed, future, wrong-route and ambiguous active prices cannot admit a formerly reserved request', async () => {
  const userId = await fixture();
  for (const update of ["effective_to=clock_timestamp()", "micros_per_unit=0.5", "provider='other-fictional-provider'",
    "model='other-fictional-model'", "unit='cached_input_token'", "effective_from=clock_timestamp()+interval '1 day'"]) {
    const r = allowed(await guard.reserve(input(userId)));
    await db.query(`UPDATE platform_model_prices SET ${update} WHERE id=$1`, [(await row(r)).input_price_id]);
    await assert.rejects(admit(r), denied); assert.equal((await row(r)).status, 'reserved');
    assert.equal(await ledger(r), undefined); await guard.release(r.binding);
    await db.query('DELETE FROM platform_cost_reservations'); await db.query('DELETE FROM platform_model_prices'); await prices();
  }
  const ambiguous = allowed(await guard.reserve(input(userId)));
  await db.query(`INSERT INTO platform_model_prices(id,provider,model,capability,unit,micros_per_unit,effective_from)
    VALUES($1,'fictional-provider','fictional-model','background','input_token',0.5,clock_timestamp())`, [randomUUID()]);
  await assert.rejects(admit(ambiguous), denied); assert.equal((await row(ambiguous)).status, 'reserved');
});
test('actual admission holds policy and full-price-table locks through its transaction, blocking price phantoms and policy changes', { timeout: 10_000 }, async () => {
  const userId = await fixture(), r = allowed(await guard.reserve(input(userId))), holder = await db.pool.connect();
  let open = false, priceInsert: Promise<unknown> | undefined, policyUpdate: Promise<unknown> | undefined;
  try {
    await holder.query('BEGIN'); open = true;
    const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await guard.admitInTransaction(holder, r.binding);
    priceInsert = db.query(`INSERT INTO platform_model_prices(id,provider,model,capability,unit,micros_per_unit,effective_from)
      VALUES($1,'fictional-provider','fictional-model','background','input_token',0.5,clock_timestamp())`, [randomUUID()]); priceInsert.catch(() => {});
    policyUpdate = db.query('UPDATE platform_cost_user_policy SET hard_micros=2000 WHERE user_id=$1', [userId]); policyUpdate.catch(() => {});
    let blocked = 0;
    for (let attempt = 0; attempt < 100; attempt++) {
      const waiting = await db.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))
        AND (query LIKE 'INSERT INTO platform_model_prices%' OR query LIKE 'UPDATE platform_cost_user_policy%')`, [pid]);
      blocked = waiting.rows[0].n; if (blocked === 2) break; await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.equal(blocked, 2, 'Both real operator writes must wait on the admission transaction.');
    assert.equal((await row(r)).status, 'reserved');
    await holder.query('COMMIT'); open = false; await Promise.all([priceInsert, policyUpdate]);
    assert.equal((await row(r)).status, 'admitted');
  } finally {
    try { if (open) await holder.query('ROLLBACK'); } finally { holder.release(); await Promise.allSettled([...(priceInsert ? [priceInsert] : []), ...(policyUpdate ? [policyUpdate] : [])]); }
  }
});
test('a global policy expiring during a proven price-lock wait is rejected at the terminal admission CAS', { timeout: 10_000 }, async () => {
  const userId = await fixture(), r = allowed(await guard.reserve(input(userId))), holder = await db.pool.connect();
  let open = false, pending: Promise<void> | undefined;
  try {
    await holder.query('BEGIN'); open = true;
    const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await holder.query('UPDATE platform_model_prices SET model=model WHERE id=$1', [(await row(r)).input_price_id]);
    await db.query("UPDATE platform_cost_global_policy SET effective_to=clock_timestamp()+interval '250 milliseconds'");
    pending = admit(r); pending.catch(() => {});
    let priceBlocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const waiting = await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query='LOCK TABLE platform_model_prices IN SHARE MODE' AND $1=ANY(pg_blocking_pids(pid))", [pid]);
      if (waiting.rowCount) { priceBlocked = true; break; } await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert(priceBlocked, 'The actual price-table lock must be waiting on the operator transaction.');
    let expired = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      expired = (await db.query('SELECT effective_to<=clock_timestamp() AS expired FROM platform_cost_global_policy')).rows[0].expired;
      if (expired) break; await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert(expired, 'The real PostgreSQL policy clock must expire before the price lock is released.');
    await holder.query('COMMIT'); open = false; await assert.rejects(pending, denied);
    assert.equal((await row(r)).status, 'reserved'); assert.equal((await row(r)).admitted_at, null); assert.equal(await ledger(r), undefined);
  } finally {
    try { if (open) await holder.query('ROLLBACK'); } finally { holder.release(); await Promise.allSettled(pending ? [pending] : []); }
  }
});
test('expired admitted unknowns settle to the actual admission UTC period, while only unfinished money carries into the next period', async () => {
  const userId = await fixture('20', '10'), r = allowed(await guard.reserve(input(userId))); await admit(r);
  await db.query(`UPDATE platform_cost_reservations SET admitted_at=(date_trunc('week',clock_timestamp() AT TIME ZONE 'UTC')-interval '1 microsecond') AT TIME ZONE 'UTC',
    expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [r.binding.id]);
  const next = allowed(await guard.reserve(input(userId))); assert.equal((await row(r)).status, 'committed');
  const previous = await ledger(r); assert.equal(previous.cost_micros, '20'); assert.equal(previous.estimated, true);
  assert.equal(previous.created_at.toISOString(), (await row(r)).admitted_at.toISOString());
  assert.equal((await row(next)).status, 'reserved');
  await guard.commit(r.binding, { status: 'reported', inputTokens: 5, outputTokens: 0 }); assert.equal((await ledger(r)).cost_micros, '5');
});
test('wrong owner/source/provider/model/purpose binding can never admit, release or settle another reservation', async () => {
  const userId = await fixture(), other = await actor(), r = allowed(await guard.reserve(input(userId)));
  for (const change of [{ userId: other }, { sourceId: randomUUID() }, { model: 'other-model' }, { provider: 'other-provider' }, { purpose: 'other_purpose' }]) {
    const wrong = { ...r.binding, ...change };
    await assert.rejects(db.withBoundedTransaction(client => guard.admitInTransaction(client, wrong)), denied);
    await assert.rejects(guard.release(wrong), denied); await assert.rejects(guard.commit(wrong, { status: 'missing' }), denied);
  }
  await admit(r); await guard.commit(r.binding, { status: 'missing' });
  await assert.rejects(db.query('UPDATE platform_cost_ledger SET user_id=$2 WHERE reservation_id=$1', [r.binding.id, other]), (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === '23503');
  assert.equal((await ledger(r)).user_id, userId);
});
test('deleted owners retain anonymous estimated expenditure without relaxing any stale owner binding', async () => {
  const userId = await fixture(), r = allowed(await guard.reserve(input(userId))); await admit(r);
  await guard.commit(r.binding, { status: 'missing' });
  await db.query('DELETE FROM platform_users WHERE id=$1', [userId]);
  assert.equal(await ledger(r), undefined); assert.equal(await row(r), undefined);
  const cost = (await db.query('SELECT cost_micros::text,estimated_micros::text FROM platform_deleted_account_cost_daily')).rows[0];
  assert.equal(cost.cost_micros, '20'); assert.equal(cost.estimated_micros, '20');
  await assert.rejects(guard.commit(r.binding, { status: 'reported', inputTokens: 1, outputTokens: 1 }), denied);
  await assert.rejects(admit(r), denied); await assert.rejects(guard.release(r.binding), denied);
  assert.deepEqual((await db.query('SELECT cost_micros::text,estimated_micros::text FROM platform_deleted_account_cost_daily')).rows[0], cost);
});
test('reservation and settlement COMMIT failure returns no money receipt and rolls back every partial row', async () => {
  const userId = await fixture(); let made = false;
  try {
    await db.query(`CREATE FUNCTION fictional_cost_commit_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Fictional rejected cost COMMIT'; END $$`); made = true;
    await db.query(`CREATE CONSTRAINT TRIGGER fictional_cost_reservation_commit AFTER INSERT ON platform_cost_reservations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fictional_cost_commit_reject()`);
    await assert.rejects(guard.reserve(input(userId)));
    assert.equal((await db.query('SELECT count(*)::int AS n FROM platform_cost_reservations')).rows[0].n, 0);
    await db.query('DROP TRIGGER fictional_cost_reservation_commit ON platform_cost_reservations');
    const r = allowed(await guard.reserve(input(userId))); await admit(r);
    await db.query(`CREATE CONSTRAINT TRIGGER fictional_cost_ledger_commit AFTER INSERT ON platform_cost_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fictional_cost_commit_reject()`);
    await assert.rejects(guard.commit(r.binding, { status: 'reported', inputTokens: 1, outputTokens: 1 }));
    assert.equal((await row(r)).status, 'admitted'); assert.equal(await ledger(r), undefined);
  } finally { if (made) await db.query('DROP FUNCTION fictional_cost_commit_reject() CASCADE'); }
});
test('aborted operations roll back and a dispatched request cannot be released after expiry', async () => {
  const userId = await fixture(), r = allowed(await guard.reserve(input(userId))), controller = new AbortController(); controller.abort();
  await assert.rejects(db.withBoundedTransaction(client => guard.admitInTransaction(client, r.binding, controller.signal)), { name: 'AbortError' });
  assert.equal((await row(r)).status, 'reserved'); await admit(r);
  await db.query("UPDATE platform_cost_reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [r.binding.id]);
  await assert.rejects(guard.release(r.binding), denied); assert.equal((await row(r)).status, 'admitted');
  await guard.commit(r.binding, { status: 'invalid' }); assert.equal((await ledger(r)).estimated, true);
});

async function distinctCachePrices() {
  await db.query("UPDATE platform_model_prices SET micros_per_unit=CASE unit WHEN 'cached_input_token' THEN 0.1 WHEN 'cache_write_input_token' THEN 3 ELSE micros_per_unit END");
}
test('new reservations require both cache prices and reserve write surcharges before any admission', async () => {
  const userId = await fixture('30', '15'); await distinctCachePrices();
  const deniedCost = await guard.reserve(input(userId)); assert.equal(deniedCost.decision, 'block');
  assert(deniedCost.decision === 'block' && deniedCost.reason === 'user_hard_limit');
  await db.query('UPDATE platform_cost_user_policy SET hard_micros=100 WHERE user_id=$1', [userId]);
  for (const unit of ['cached_input_token', 'cache_write_input_token']) {
    await db.query('UPDATE platform_model_prices SET effective_to=clock_timestamp() WHERE unit=$1', [unit]);
    assert.deepEqual(await guard.reserve(input(userId)), { decision: 'block', reason: 'price_unavailable' });
    await db.query('UPDATE platform_model_prices SET effective_to=NULL WHERE unit=$1', [unit]);
  }
  const r = allowed(await guard.reserve(input(userId))); assert.equal(r.estimateMicros, '40'); assert.equal((await row(r)).pricing_revision, 2);
  await db.query("UPDATE platform_model_prices SET micros_per_unit=4 WHERE unit='cache_write_input_token'");
  await assert.rejects(admit(r), denied); assert.equal((await row(r)).status, 'reserved');
});
test('complete cached usage settles from captured rates after prices change and retries remain idempotent', async () => {
  const userId = await fixture(); await distinctCachePrices(); const r = allowed(await guard.reserve(input(userId))); await admit(r);
  await db.query('UPDATE platform_model_prices SET micros_per_unit=99');
  const usage = { status: 'reported' as const, inputTokens: 10, outputTokens: 5, cachedInputTokens: 6, cacheWriteInputTokens: 2 };
  assert.deepEqual(await guard.commit(r.binding, usage), { costMicros: '19', estimated: false });
  assert.deepEqual(await guard.commit(r.binding, usage), { costMicros: '19', estimated: false });
  assert.deepEqual((await ledger(r)).units, { inputTokens: 10, outputTokens: 5, cachedInputTokens: 6, cacheWriteInputTokens: 2 });
  await assert.rejects(guard.commit(r.binding, { ...usage, cachedInputTokens: 5 }), denied);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM platform_cost_ledger WHERE reservation_id=$1', [r.binding.id])).rows[0].n, 1);
});
test('partial cache estimates may gain evidence but cannot rewrite or lose previously reported counts', async () => {
  const userId = await fixture(); await distinctCachePrices(); const r = allowed(await guard.reserve(input(userId))); await admit(r);
  const base = { status: 'reported' as const, inputTokens: 10, outputTokens: 5 };
  assert.deepEqual(await guard.commit(r.binding, base), { costMicros: '40', estimated: true });
  assert.deepEqual(await guard.commit(r.binding, { ...base, cachedInputTokens: 6 }), { costMicros: '23', estimated: true });
  await assert.rejects(guard.commit(r.binding, base), denied);
  await assert.rejects(guard.commit(r.binding, { ...base, inputTokens: 11, cachedInputTokens: 6 }), denied);
  await assert.rejects(guard.commit(r.binding, { ...base, cachedInputTokens: 5 }), denied);
  assert.deepEqual(await guard.commit(r.binding, { ...base, cachedInputTokens: 6, cacheWriteInputTokens: 2 }), { costMicros: '19', estimated: false });
});
test('late cache evidence corrects expired spending once without granting a new call', async () => {
  const userId = await fixture(); await distinctCachePrices(); const r = allowed(await guard.reserve(input(userId))); await admit(r);
  await db.query("UPDATE platform_cost_reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [r.binding.id]);
  await guard.reserve(input(userId)); assert.equal((await ledger(r)).cost_micros, '40'); assert.equal((await ledger(r)).usage_status, 'expired');
  assert.deepEqual(await guard.commit(r.binding, { status: 'reported', inputTokens: 10, outputTokens: 5, cachedInputTokens: 6, cacheWriteInputTokens: 2 }), { costMicros: '19', estimated: false });
  await assert.rejects(admit(r), denied);
});
test('historical pricing remains readable but cannot admit a new call under old two-price rules', async () => {
  const userId = await fixture(); const r = allowed(await guard.reserve(input(userId)));
  await db.query('UPDATE platform_cost_reservations SET pricing_revision=1,cached_input_price_id=NULL,cache_write_input_price_id=NULL,cached_input_micros_per_unit=NULL,cache_write_input_micros_per_unit=NULL WHERE id=$1', [r.binding.id]);
  await assert.rejects(admit(r), denied);
  await db.query("UPDATE platform_cost_reservations SET status='admitted',admitted_at=clock_timestamp() WHERE id=$1", [r.binding.id]);
  assert.deepEqual(await guard.commit(r.binding, { status: 'reported', inputTokens: 10, outputTokens: 5 }), { costMicros: '20', estimated: false });
  const saved = await ledger(r); assert.deepEqual(saved.units, { inputTokens: 10, outputTokens: 5 });
});
