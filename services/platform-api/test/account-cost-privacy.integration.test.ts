import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CostGuard, type CostDecision, type CostReservation } from '../src/cost-guard.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
const migration = () => readFile(new URL('../migrations/078_deleted_account_cost_aggregates.sql', import.meta.url), 'utf8');
function allowed(r:CostDecision):CostReservation {assert.notEqual(r.decision,'block'); if(r.decision==='block')throw Error(); return r.reservation;}
async function fixture() {
  const f=await createCompanionNameSafetyFixture(), guard=new CostGuard(f.db);
  async function owner() {
    const who=await f.actor(), approver=await f.actor(true);
    await f.db.query(`INSERT INTO platform_cost_user_policy(user_id,policy_key,period,soft_behavior,soft_micros,hard_micros,approved_by,approved_at,effective_from)
      VALUES($1,'fictional-privacy','week','notify',1,1000000,$2,clock_timestamp(),clock_timestamp())`,[who.userId,approver.userId]);
    return who;
  }
  const input=(id:string)=>({userId:id,sourceKind:'job' as const,sourceId:randomUUID(),capability:'background' as const,purpose:'companion_generation',provider:'openai',model:'fictional-companion-model',maxInputTokens:10,maxOutputTokens:5});
  const reserve=async(id:string)=>allowed(await guard.reserve(input(id)));
  const admit=async(r:CostReservation)=>f.db.withBoundedTransaction(c=>guard.admitInTransaction(c,r.binding));
  const settle=async(id:string)=>{const r=await reserve(id);await admit(r);await guard.commit(r.binding,{status:'reported',inputTokens:2,outputTokens:3,cachedInputTokens:0,cacheWriteInputTokens:0});return r;};
  const totals=async()=> (await f.db.query(`SELECT coalesce(sum(cost_micros),0)::text cost,coalesce(sum(estimated_micros),0)::text estimated,
    coalesce(sum(calls),0)::text calls,coalesce(sum(estimated_calls),0)::text uncertain FROM platform_deleted_account_cost_daily`)).rows[0];
  return {...f,guard,owner,input,reserve,admit,settle,totals};
}

test('account deletion erases call/source identities and merges exact costs without touching another owner',async()=>{
  const f=await fixture();try{
    const a=await f.owner(),b=await f.owner(),live=await f.owner();
    const r=await f.settle(a.userId);await f.settle(a.userId);await f.settle(b.userId);const kept=await f.settle(live.userId);
    await f.db.query('DELETE FROM platform_users WHERE id=ANY($1::uuid[])',[[a.userId,b.userId]]);
    assert.deepEqual(await f.totals(),{cost:'24',estimated:'0',calls:'3',uncertain:'0'});
    assert.equal((await f.db.query('SELECT 1 FROM platform_cost_reservations WHERE id=$1',[r.binding.id])).rowCount,0);
    assert.equal((await f.db.query('SELECT 1 FROM platform_cost_ledger WHERE reservation_id=$1',[r.binding.id])).rowCount,0);
    assert.equal((await f.db.query('SELECT user_id FROM platform_cost_ledger WHERE reservation_id=$1',[kept.binding.id])).rows[0].user_id,live.userId);
    const columns=(await f.db.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='platform_deleted_account_cost_daily' ORDER BY ordinal_position")).rows.map(r=>r.column_name);
    assert.deepEqual(columns,['day','capability','cost_micros','estimated_micros','calls','estimated_calls']);
    await assert.rejects(f.guard.commit(r.binding,{status:'reported',inputTokens:1,outputTokens:1}));
    await assert.rejects(f.admit(r));assert.deepEqual(await f.totals(),{cost:'24',estimated:'0',calls:'3',uncertain:'0'});
  }finally{await f.close();}
});

test('unknown dispatched expenditure remains conservative while never-dispatched reservations disappear free',async()=>{
  const f=await fixture();try{
    const a=await f.owner(),live=await f.owner();
    const admitted=await f.reserve(a.userId);await f.admit(admitted);
    const uncertain=await f.reserve(a.userId);await f.db.withBoundedTransaction(c=>f.guard.markDispatchRiskInTransaction(c,uncertain.binding));
    await f.reserve(a.userId);const released=await f.reserve(a.userId);await f.guard.release(released.binding);
    await f.db.query('DELETE FROM platform_users WHERE id=$1',[a.userId]);
    assert.deepEqual(await f.totals(),{cost:'40',estimated:'40',calls:'2',uncertain:'2'});
    await f.db.query('UPDATE platform_cost_global_policy SET month_hard_micros=59,day_hard_micros=1000');
    const month=await f.guard.reserve(f.input(live.userId));assert.equal(month.decision,'block');assert.equal((month as any).reason,'global_month_limit');
    await f.db.query('UPDATE platform_cost_global_policy SET month_hard_micros=1000,day_hard_micros=59');
    const day=await f.guard.reserve(f.input(live.userId));assert.equal(day.decision,'block');assert.equal((day as any).reason,'global_day_limit');
    await f.db.query('UPDATE platform_cost_global_policy SET day_hard_micros=60');
    await f.db.query('UPDATE platform_cost_user_policy SET hard_micros=20 WHERE user_id=$1',[live.userId]);
    const last=await f.reserve(live.userId);
    await f.db.query('UPDATE platform_cost_global_policy SET day_hard_micros=59');await assert.rejects(f.admit(last));
    assert.equal((await f.db.query('SELECT count(*)::int n FROM platform_cost_reservations')).rows[0].n,1);
  }finally{await f.close();}
});

test('failed account deletion rolls back aggregation, source erasure and account deletion atomically',async()=>{
  const f=await fixture();try{
    const a=await f.owner(),r=await f.settle(a.userId);
    await assert.rejects(f.db.withBoundedTransaction(async c=>{await c.query('DELETE FROM platform_users WHERE id=$1',[a.userId]);throw Error('Fictional interrupted privacy transaction');}));
    assert.deepEqual(await f.totals(),{cost:'0',estimated:'0',calls:'0',uncertain:'0'});
    assert.equal((await f.db.query('SELECT 1 FROM platform_users WHERE id=$1',[a.userId])).rowCount,1);
    assert.equal((await f.db.query('SELECT 1 FROM platform_cost_ledger WHERE reservation_id=$1',[r.binding.id])).rowCount,1);
    await f.db.query('DELETE FROM platform_users WHERE id=$1',[a.userId]);assert.equal((await f.totals()).cost,'8');
  }finally{await f.close();}
});

test('migration compacts actual legacy null-owner rows exactly once and preserves their UTC accounting date',async()=>{
  const f=await fixture();try{
    const a=await f.owner(),r=await f.settle(a.userId);
    await f.db.query("UPDATE platform_cost_ledger SET created_at='2026-01-01T00:30:00Z' WHERE reservation_id=$1",[r.binding.id]);
    await f.db.query('DROP TRIGGER privacy_delete_account_costs ON platform_users');
    await f.db.query('DELETE FROM platform_users WHERE id=$1',[a.userId]);
    assert.equal((await f.db.query('SELECT user_id FROM platform_cost_ledger WHERE reservation_id=$1',[r.binding.id])).rows[0].user_id,null);
    for(let i=0;i<2;i++)await f.db.transaction(async c=>{await c.query("SET LOCAL TIME ZONE 'America/Los_Angeles'");await c.query(await migration());});
    assert.deepEqual(await f.totals(),{cost:'8',estimated:'0',calls:'1',uncertain:'0'});
    assert.equal((await f.db.query('SELECT day::text FROM platform_deleted_account_cost_daily')).rows[0].day,'2026-01-01');
    assert.equal((await f.db.query('SELECT 1 FROM platform_cost_ledger')).rowCount,0);
    assert.equal((await f.db.query('SELECT 1 FROM platform_cost_reservations')).rowCount,0);
  }finally{await f.close();}
});

test('another owner cannot spend budget released by a concurrent deletion or double-count a concurrent settlement',async()=>{
  const f=await fixture();try{
    const a=await f.owner(),b=await f.owner(),r=await f.reserve(a.userId);await f.admit(r);
    await f.db.query('UPDATE platform_cost_global_policy SET month_hard_micros=39');
    const outcomes=await Promise.allSettled([
      f.db.withBoundedTransaction(c=>c.query('DELETE FROM platform_users WHERE id=$1',[a.userId])),
      f.guard.commit(r.binding,{status:'missing'}),
      f.guard.reserve(f.input(b.userId))
    ] as const);
    // A lock conflict is allowed to fail closed. Finish the actual deletion if
    // its bounded transaction lost that race; no new reservation may slip in.
    await f.db.query('DELETE FROM platform_users WHERE id=$1',[a.userId]);
    const admission=outcomes[2];if(admission.status==='fulfilled')assert.equal(admission.value.decision,'block');
    assert.deepEqual(await f.totals(),{cost:'20',estimated:'20',calls:'1',uncertain:'1'});
    assert.equal((await f.db.query('SELECT 1 FROM platform_cost_reservations')).rowCount,0);
  }finally{await f.close();}
});
