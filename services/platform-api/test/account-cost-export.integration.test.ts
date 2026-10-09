import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {Database} from '../src/database.ts';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {AccountReauthentication} from '../src/account-reauthentication.ts';
import {hashPassword,type FixedSessionContext} from '../src/auth.ts';
import {CostGuard,type CostReservation} from '../src/cost-guard.ts';
import {createCompanionNameSafetyFixture} from './fixtures/companion-name-safety.ts';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,encoded:string,guard:CostGuard;
const password='Fictional-account-cost-export-password';
before(async()=>{f=await createCompanionNameSafetyFixture();encoded=await hashPassword(password);guard=new CostGuard(f.db);});
after(async()=>{await f?.close();});
async function actor(policy=true){const who=await f.actor(),approver=await f.actor(true);await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,encoded]);
 if(policy)await f.db.query(`INSERT INTO platform_cost_user_policy(user_id,policy_key,period,soft_behavior,soft_micros,hard_micros,day_micros,approved_by,approved_at,effective_from)
  VALUES($1,'fictional-export-policy','week','notify',1,1000000,500000,$2,clock_timestamp(),clock_timestamp())`,[who.userId,approver.userId]);
 return {...who,approver:approver.userId};}
const fixed=(who:FixedSessionContext)=>({userId:who.userId,tokenHash:who.tokenHash});
async function reserve(who:FixedSessionContext){const result=await guard.reserve({userId:who.userId,sourceKind:'job',sourceId:randomUUID(),capability:'background',purpose:'companion_generation',provider:'openai',model:'fictional-companion-model',maxInputTokens:10,maxOutputTokens:5});assert.notEqual(result.decision,'block');if(result.decision==='block')throw Error('Expected fictional reservation');return result.reservation;}
const admit=async(r:CostReservation)=>f.db.withBoundedTransaction(client=>guard.admitInTransaction(client,r.binding));
async function settle(who:FixedSessionContext){const r=await reserve(who);await admit(r);await guard.commit(r.binding,{status:'reported',inputTokens:2,outputTokens:3,cachedInputTokens:0,cacheWriteInputTokens:0});return r;}
const proof=async(who:FixedSessionContext)=>(await new AccountReauthentication(f.db).verify(fixed(who),{purpose:'account_export',password})).token;
const capture=async(who:FixedSessionContext)=>new AccountCoreExport(f.db,f.config).capture(fixed(who),await proof(who));
const consumed=async(who:FixedSessionContext)=>(await f.db.query("SELECT consumed_at FROM platform_account_reauthentications WHERE user_id=$1 AND purpose='account_export'",[who.userId])).rows[0].consumed_at;
function instrument(transform:(sql:string,rows:Record<string,any>[])=>void):Database{return {withBoundedTransaction:<T>(run:(client:PoolClient)=>Promise<T>,options?:{readOnly?:boolean;timeoutMs?:number})=>f.db.withBoundedTransaction(client=>run(new Proxy(client,{get(target,key){
 if(key==='query')return async(sql:string,values:unknown[])=>{const result=await target.query(sql,values);transform(sql,result.rows);return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
}})),options)} as Database;}
const table=(sql:string,name:string)=>sql.startsWith(`SELECT * FROM platform_cost_${name} WHERE user_id=`);
async function snapshot(who:FixedSessionContext){const result:Record<string,unknown>={};for(const name of ['user_policy','reservations','ledger'])result[name]=(await f.db.query(`SELECT row_to_json(t)::text AS value FROM platform_cost_${name} t WHERE user_id=$1 ORDER BY row_to_json(t)::text`,[who.userId])).rows;return result;}

// Real accounting state transitions with fictional source IDs/counts. This does
// not claim a model was executed, a source task existed, or a vendor bill was paid.
test('owner cost policy, exact reservation prices and settled usage export without staff or other-account data',async()=>{
 const who=await actor(),other=await actor(),own=await settle(who),foreign=await settle(other),token=await proof(who),result=await new AccountCoreExport(f.db,f.config).capture(fixed(who),token);
 const policy=result.sections.costPolicies[0] as any,reservation=result.sections.costReservations[0] as any,ledger=result.sections.costLedger[0] as any;
 assert.equal(result.sections.costPolicies.length,1);assert.equal(policy.hardMicros,'1000000');assert.equal(policy.dayMicros,'500000');assert.equal(policy.period,'week');assert.equal(policy.softBehavior,'notify');
 assert.equal(result.sections.costReservations.length,1);assert.equal(reservation.id,own.binding.id);assert.equal(reservation.pricing.revision,2);assert.equal(reservation.pricing.input.microsPerUnit,'1.000000');assert.equal(reservation.estimateMicros,'20');
 assert.equal(ledger.reservationId,own.binding.id);assert.equal(ledger.costMicros,'8');assert.equal(ledger.estimated,false);assert.equal(ledger.usageStatus,'reported');assert.deepEqual(ledger.units,{inputTokens:2,outputTokens:3,cachedInputTokens:0,cacheWriteInputTokens:0});
 for(const secret of [who.approver,other.userId,foreign.binding.id,who.tokenHash,password,encoded,token])assert(!JSON.stringify(result).includes(secret));assert(Object.isFrozen(reservation.pricing.input));assert(Object.isFrozen(ledger.units));
 assert.equal(result.includedTables.length,145);for(const name of ['user_policy','reservations','ledger'])assert(!result.remainingTables.includes(`platform_cost_${name}`));assert(result.remainingTables.includes('platform_cost_global_policy'));assert.equal(result.complete,false);
});

test('an account with no cost policy or usage remains empty rather than receiving fabricated zero-cost records',async()=>{
 const who=await actor(false),result=await capture(who);for(const section of ['costPolicies','costReservations','costLedger'] as const)assert.deepEqual(result.sections[section],[]);
});

test('expired pending and admitted reservations, released budget and dispatch risk are exported without automatic settlement',async()=>{
 const who=await actor(),pending=await reserve(who),active=await reserve(who);await admit(active);
 const released=await reserve(who);await guard.release(released.binding);const uncertain=await reserve(who);await f.db.withBoundedTransaction(client=>guard.markDispatchRiskInTransaction(client,uncertain.binding));
 await f.db.query("UPDATE platform_cost_reservations SET expires_at=clock_timestamp()-interval '1 hour' WHERE user_id=$1",[who.userId]);
 const before=await snapshot(who),queries:string[]=[],result=await new AccountCoreExport(instrument(sql=>{queries.push(sql);}),f.config).capture(fixed(who),await proof(who));
 const records=new Map((result.sections.costReservations as any[]).map(row=>[row.id,row]));assert.equal(records.get(pending.binding.id).status,'reserved');assert.equal(records.get(active.binding.id).status,'admitted');assert.equal(records.get(released.binding.id).status,'released');assert.equal(records.get(uncertain.binding.id).status,'reserved');assert.equal(typeof records.get(uncertain.binding.id).dispatchIntentAt,'string');assert.deepEqual(result.sections.costLedger,[]);
 assert.deepEqual(await snapshot(who),before);assert(!queries.filter(sql=>/platform_cost_/.test(sql)).some(sql=>/FOR (UPDATE|SHARE)|UPDATE platform_cost_|INSERT INTO platform_cost_/.test(sql)));
 // Restore expiry only for later test setup: subsequent CostGuard writes may recover expired risk globally.
 await f.db.query("UPDATE platform_cost_reservations SET expires_at=clock_timestamp()+interval '1 hour' WHERE user_id=$1",[who.userId]);
});

test('missing, invalid, expired and dispatch-uncertain costs remain estimates while a reported zero stays distinct',async()=>{
 const who=await actor(),ids:Record<string,string>={};
 for(const status of ['missing','invalid'] as const){const r=await reserve(who);await admit(r);await guard.commit(r.binding,{status});ids[status]=r.binding.id;}
 const zero=await reserve(who);await admit(zero);await guard.commit(zero.binding,{status:'reported',inputTokens:0,outputTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0});ids.zero=zero.binding.id;
 const expired=await reserve(who);await admit(expired);const risk=await reserve(who);await f.db.withBoundedTransaction(client=>guard.markDispatchRiskInTransaction(client,risk.binding));
 await f.db.query("UPDATE platform_cost_reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=ANY($1::uuid[])",[[expired.binding.id,risk.binding.id]]);
 await reserve(who);ids.expired=expired.binding.id;ids.dispatch_uncertain=risk.binding.id;
 const result=await capture(who),ledger=new Map((result.sections.costLedger as any[]).map(row=>[row.reservationId,row]));
 for(const status of ['missing','invalid','expired','dispatch_uncertain']){const row=ledger.get(ids[status]);assert.equal(row.usageStatus,status);assert.equal(row.estimated,true);assert.equal(row.costMicros,'20');assert.deepEqual(row.units,{maxInputTokens:10,maxOutputTokens:5});}
 assert.equal(ledger.get(ids.zero).costMicros,'0');assert.equal(ledger.get(ids.zero).estimated,false);assert.equal(ledger.get(ids.zero).usageStatus,'reported');
});

test('unknown cache breakdown remains absent and conservatively estimated; later price changes do not reprice the archive',async()=>{
 const who=await actor();await f.db.query("UPDATE platform_model_prices SET micros_per_unit=3 WHERE unit='cache_write_input_token'");
 try{
  const r=await reserve(who);await admit(r);await guard.commit(r.binding,{status:'reported',inputTokens:10,outputTokens:5});
  await f.db.query("UPDATE platform_model_prices SET micros_per_unit=99 WHERE unit='cache_write_input_token'");
  const result=await capture(who),row=result.sections.costLedger[0] as any,reservation=result.sections.costReservations[0] as any;
  assert.equal(row.costMicros,'40');assert.equal(row.estimated,true);assert.deepEqual(row.units,{inputTokens:10,outputTokens:5});assert.equal(reservation.pricing.cacheWriteInput.microsPerUnit,'3.000000');assert.equal(reservation.estimateMicros,'40');
 }finally{await f.db.query("UPDATE platform_model_prices SET micros_per_unit=1 WHERE unit='cache_write_input_token'");}
});

test('all actual retained reservations and settlements survive pagination beyond 100 records',async()=>{
 const who=await actor(),ids:string[]=[];for(let i=0;i<105;i++)ids.push((await settle(who)).binding.id);
 const queries:string[]=[],result=await new AccountCoreExport(instrument(sql=>{queries.push(sql);}),f.config).capture(fixed(who),await proof(who));
 assert.deepEqual((result.sections.costReservations as any[]).map(row=>row.id),ids.sort());assert.deepEqual((result.sections.costLedger as any[]).map(row=>row.reservationId),ids.sort());assert.equal(queries.filter(sql=>table(sql,'reservations')).length,2);assert.equal(queries.filter(sql=>table(sql,'ledger')).length,2);
});

test('expired policies and withdrawn model admission remain historical records and do not prevent authenticated export',async()=>{
 const who=await actor();await settle(who);const before=await snapshot(who);
 await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[who.userId]);await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[who.userId]);
 await f.db.query("UPDATE platform_cost_user_policy SET effective_from=clock_timestamp()-interval '2 days',effective_to=clock_timestamp()-interval '1 day',approved_by=NULL WHERE user_id=$1",[who.userId]);
 const result=await capture(who),policy=result.sections.costPolicies[0] as any;assert(Date.parse(policy.effectiveTo)<Date.now());assert.equal(result.sections.costLedger.length,1);const after=await snapshot(who);assert.deepEqual(after.reservations,before.reservations);assert.deepEqual(after.ledger,before.ledger);
});

test('unknown usage fields, incoherent links and missing settlements reject the whole archive and retain the proof',async()=>{
 const who=await actor(),other=await actor(),own=await settle(who),foreign=await settle(other),token=await proof(who);
 const cases:[string,(rows:any[])=>void][]=[['ledger',rows=>{rows.splice(0);}],['ledger',rows=>{rows[0].reservation_id=foreign.binding.id;}],['ledger',rows=>{rows[0].source_id=randomUUID();}],['ledger',rows=>{rows[0].units.rawPrompt='must not escape';}],['ledger',rows=>{rows[0].usage_status='pending';}],['ledger',rows=>{rows[0].units.cachedInputTokens=100;}],['reservations',rows=>{rows[0].pricing_revision=3;}],['reservations',rows=>{rows[0].cached_input_price_id=null;}],['reservations',rows=>{rows[0].user_id=other.userId;}]];
 for(const [name,change] of cases){let reached=false;const db=instrument((sql,rows)=>{if(table(sql,name)&&rows.length){reached=true;change(rows);}});await assert.rejects(new AccountCoreExport(db,f.config).capture(fixed(who),token),{code:'ACCOUNT_COST_EXPORT_UNAVAILABLE'});assert(reached);assert.equal(await consumed(who),null);}
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(fixed(who),token)).sections.costLedger.length,1);assert(own.binding.id);
});

test('cancellation while reading the ledger rolls back the password proof and returns no partial cost archive',async()=>{
 const who=await actor();await settle(who);const token=await proof(who),controller=new AbortController(),db=instrument(sql=>{if(table(sql,'ledger'))controller.abort();});
 await assert.rejects(new AccountCoreExport(db,f.config).capture(fixed(who),token,controller.signal),{code:'ACCOUNT_EXPORT_CANCELLED'});assert.equal(await consumed(who),null);
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(fixed(who),token)).sections.costLedger.length,1);
});

test('legacy two-price snapshots and PostgreSQL amounts above Number precision are preserved exactly',async()=>{
 const who=await actor(),r=await settle(who);
 // Controlled retained legacy shape and exact large numeric fixture, not an old deployment or real vendor invoice.
 await f.db.query(`UPDATE platform_cost_reservations SET pricing_revision=1,cached_input_price_id=NULL,cache_write_input_price_id=NULL,
  cached_input_micros_per_unit=NULL,cache_write_input_micros_per_unit=NULL,input_micros_per_unit=0.000001,estimate_micros=9007199254740994 WHERE id=$1`,[r.binding.id]);
 await f.db.query(`UPDATE platform_cost_ledger SET cost_micros=9007199254740993,units='{"inputTokens":2,"outputTokens":3}'::jsonb WHERE reservation_id=$1`,[r.binding.id]);
 const result=await capture(who),row=result.sections.costLedger[0] as any,reservation=result.sections.costReservations[0] as any;
 assert.equal(row.costMicros,'9007199254740993');assert.equal(reservation.estimateMicros,'9007199254740994');assert.equal(reservation.pricing.input.microsPerUnit,'0.000001');assert.equal(reservation.pricing.revision,1);assert.equal(reservation.pricing.cachedInput,null);assert.equal(reservation.pricing.cacheWriteInput,null);assert.deepEqual(row.units,{inputTokens:2,outputTokens:3});
});
