import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createProviderRuntime } from '@companion/ai-core';
import { ApiError } from '../src/errors.ts';
import { insertSession, tokenHash } from '../src/auth.ts';
import { CompanionNamingEntry } from '../src/companion-naming-entry.ts';
import { CompanionNameSafetyRunner } from '../src/companion-name-safety-runner.ts';
import { createCompanionNameSafetyClassifier } from '../src/companion-name-safety-classifier.ts';
import { createCompanionNameSafetyModelUsage } from '../src/safety-model-usage.ts';
import { resolveModelRoute } from '../src/model-routing.ts';
import { assertActiveSafetyDetector } from '../src/safety-detector-profile.ts';
import { companionNameNotification } from '../src/companion-name-dispatch-protocol.ts';
import { withPrebirthLoopback, prebirthDetector } from './fixtures/companion-prebirth.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
import { createNamingDispatchFixture, dispatchBytes, dispatchTables, killedUnstartedClaim,
  waitTrueLeaseExpiry, type NamingDispatchFixture } from './fixtures/companion-name-dispatch.ts';

// Actual isolated PostgreSQL and genuine fictional service paths. No public UI,
// professional review, paid I/O, fabricated grade/result/handled or model quality
// is asserted. Each case owns its schema; the root owns all test execution.
const code=(expected:string)=>(error:unknown)=>error instanceof ApiError&&error.code===expected;
const unavailable=(error:unknown)=>error instanceof ApiError&&error.status===503;
const sqlCode=(expected:string)=>(error:unknown)=>!!error&&typeof error==='object'&&(error as {code?:string}).code===expected;
const notice=(accepted:{acceptance:{dispatchId:string;taskId:string;submissionId:string}})=>companionNameNotification({
  dispatchId:accepted.acceptance.dispatchId,taskId:accepted.acceptance.taskId,submissionId:accepted.acceptance.submissionId,
});
async function withFixture(run:(f:NamingDispatchFixture,runtime:Parameters<typeof createNamingDispatchFixture>[0],requests:Record<string,unknown>[])=>Promise<void>) {
  await withPrebirthLoopback(async(runtime,requests)=>{
    const f=await createNamingDispatchFixture(runtime);
    try {await run(f,runtime,requests);} finally {await f.close();}
  });
}
async function source(f:NamingDispatchFixture,id:string) {
  const row=(await f.db.query('SELECT * FROM platform_companion_name_submissions WHERE id=$1 AND user_id=$2',[id,f.who.userId])).rows[0];assert(row);return row;
}
async function classifications(f:NamingDispatchFixture,id:string) {
  const row=await source(f,id);
  return {request:row.request_ciphertext,claim:row.claim_ciphertext,result:row.result_ciphertext,generation:row.generation,authVersion:row.auth_version,
    leaseToken:row.lease_token,leaseUntil:row.lease_until,executionToken:row.execution_token,detectorRevision:row.detector_revision,level:row.level,mode:row.detector_mode,
    usage:(await f.db.query("SELECT row_to_json(t)::text AS actual FROM platform_safety_model_usage t WHERE source_kind='companion_name' AND submission_id=$1 ORDER BY call_id",[id])).rows};
}
async function ordinaryFailure(f:NamingDispatchFixture,sql:string,values:unknown[],expected:string) {
  const before=await dispatchBytes(f);
  await assert.rejects(f.db.withBoundedTransaction(client=>client.query(sql,values)),sqlCode(expected));
  assert.deepEqual(await dispatchBytes(f),before);
}

test('B01 raw text, inventory, accepted original-session capsule and outbox share one COMMIT; semantic rejection is later genuine full L0',async()=>{
  await withFixture(async(f,_runtime,requests)=>{
    const input=f.command('\n  伙伴甲 \r\n'),calls=requests.length;
    const accepted=await f.naming.accept(f.who,input),id=accepted.acceptance.submissionId;
    assert.equal(accepted.progress.phase,'queued');assert.equal(accepted.progress.resource,'not_determined');
    const raw=await source(f,id),capsule=JSON.parse(f.crypto.openUtf8(raw.request_ciphertext,{table:'platform_companion_name_submissions',column:'request_ciphertext',rowId:id,ownerId:f.who.userId,revision:1}));
    assert.equal(capsule.request.name,input.name);assert.deepEqual(capsule.request,input);
    const dispatch=(await f.db.query('SELECT * FROM platform_companion_name_dispatches WHERE id=$1',[accepted.acceptance.dispatchId])).rows[0];
    const intent=JSON.parse(f.crypto.openUtf8(dispatch.payload_ciphertext,{table:'platform_companion_name_dispatches',column:'payload_ciphertext',rowId:dispatch.id,ownerId:f.who.userId,revision:1}));
    assert.equal(intent.originalSessionHash,f.who.tokenHash);assert.equal(intent.submittedAuthVersion,'0');
    assert.equal(raw.first_name_dispatch_id,dispatch.id);
    assert.equal((await f.db.query("SELECT count(*)::int AS n FROM platform_companion_prebirth_inventory WHERE user_id=$1 AND kind='name_submission' AND name_submission_id=$2",[f.who.userId,id])).rows[0].n,1);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_companion_name_dispatch_outbox WHERE dispatch_id=$1',[dispatch.id])).rows[0].n,1);
    assert.equal(requests.length,calls);
    await f.naming.executeNotification(notice(accepted));
    const completed=await f.naming.readOperation(f.who,input.operationId);assert(completed);
    assert.deepEqual(completed.progress.detection,{status:'detected',generation:1,level:'L0',mode:'full'});
    assert.deepEqual(completed.progress.application,{status:'name_rejected',rejectedCategory:'length',identityRevision:null});
    assert.equal(completed.progress.phase,'detected');assert.equal(completed.progress.hold,null);
    assert.equal(requests.length,calls+1);
    assert.equal((await f.db.query('SELECT held_reason FROM platform_companion_name_dispatch_outbox WHERE dispatch_id=$1',[dispatch.id])).rows[0].held_reason,'terminal');
    const saved=await dispatchBytes(f);await f.naming.executeNotification(notice(accepted));
    await f.naming.read(f.who);await f.naming.readOperation(f.who,input.operationId);
    assert.deepEqual(await dispatchBytes(f),saved);assert.equal(requests.length,calls+1);
    for(const table of ['platform_companion_identity_drafts','platform_conversations','platform_jobs'])
      assert.equal((await f.db.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1`,[f.who.userId])).rows[0].n,0);
  });
});

test('B02 concurrent exact accepts commit one source and conflicting raw/CAS never mint another acceptance',async()=>{
  await withFixture(async(f,_runtime,requests)=>{
    const input=f.command(),calls=requests.length;
    const [first,replay]=await Promise.all([f.naming.accept(f.who,input),f.naming.accept(f.who,{...input})]);
    assert.equal(first.acceptance.dispatchId,replay.acceptance.dispatchId);assert.equal(first.acceptance.submissionId,replay.acceptance.submissionId);
    assert.deepEqual([first.acceptance.operation.replayed,replay.acceptance.operation.replayed].sort(),[false,true]);
    const saved=await dispatchBytes(f);
    await assert.rejects(f.naming.accept(f.who,{...input,name:'Changed raw'}),code('COMPANION_NAME_OPERATION_CONFLICT'));
    await assert.rejects(f.naming.accept(f.who,f.command('舟')),code('COMPANION_NAME_ENTRY_REVISION_CHANGED'));
    assert.deepEqual(await dispatchBytes(f),saved);assert.equal(requests.length,calls);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_companion_name_dispatches WHERE user_id=$1',[f.who.userId])).rows[0].n,1);
  });
});

test('B03 a real deferred FK fails at COMMIT and rolls back source, enrollment, anchor, acceptance and outbox together',async()=>{
  await withFixture(async(f,_runtime,requests)=>{
    const name='dispatch_commit_'+randomUUID().replaceAll('-',''),missingOwner=randomUUID(),before=await dispatchBytes(f),calls=requests.length;
    await f.db.query(`CREATE TABLE ${name}(dispatch_id uuid PRIMARY KEY REFERENCES platform_companion_name_dispatches(id),
      required_owner uuid NOT NULL REFERENCES platform_users(id) DEFERRABLE INITIALLY DEFERRED)`);
    await f.db.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.user_id='${f.who.userId}'::uuid THEN INSERT INTO ${name}(dispatch_id,required_owner) VALUES(NEW.dispatch_id,'${missingOwner}'::uuid); END IF; RETURN NEW; END $$`);
    await f.db.query(`CREATE TRIGGER ${name} AFTER INSERT ON platform_companion_name_dispatch_outbox FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    try {
      await assert.rejects(f.naming.accept(f.who,f.command()),sqlCode('23503'));
      assert.deepEqual(await dispatchBytes(f),before);assert.equal(requests.length,calls);
      assert.equal((await f.db.query(`SELECT count(*)::int AS n FROM ${name}`)).rows[0].n,0);
    } finally {await f.db.query(`DROP TRIGGER ${name} ON platform_companion_name_dispatch_outbox`);await f.db.query(`DROP FUNCTION ${name}()`);await f.db.query(`DROP TABLE ${name}`);}
    assert.equal((await f.naming.accept(f.who,f.command())).acceptance.operation.replayed,false);
  });
});

test('B12 concurrent duplicate notifications classify once; malformed or foreign coordinates change no evidence',async()=>{
  await withFixture(async(f,_runtime,requests)=>{
    const input=f.command(),accepted=await f.naming.accept(f.who,input),calls=requests.length,n=notice(accepted);
    const saved=await dispatchBytes(f);
    await assert.rejects(f.naming.executeNotification({...n,handled:true}),code('INVALID_INPUT'));
    await assert.rejects(f.naming.executeNotification({...n,taskId:randomUUID()}),unavailable);
    assert.deepEqual(await dispatchBytes(f),saved);
    await Promise.all([f.naming.executeNotification(n),f.naming.executeNotification(n)]);
    const completed=await f.naming.readOperation(f.who,input.operationId);assert.equal(completed?.progress.application.status,'applied');
    assert.equal(requests.length,calls+1);assert.equal((await source(f,n.submissionId)).generation,1);
    const classified=await dispatchBytes(f);await Promise.all([f.naming.read(f.who),f.naming.readOperation(f.who,input.operationId)]);
    assert.deepEqual(await dispatchBytes(f),classified);assert.equal(requests.length,calls+1);
  });
});

test('B08 a genuine expired unstarted lease renews the same generation and old concrete claims lose their fence',async()=>{
  await withFixture(async(f,_runtime,requests)=>{
    const accepted=await f.naming.accept(f.who,f.command()),n=notice(accepted),raw=(await source(f,n.submissionId)).request_ciphertext,calls=requests.length;
    const first=await f.safety.claimSubmission(f.who,{taskId:f.taskId,submissionId:n.submissionId,detectorRevision:prebirthDetector.revision,leaseMs:100});assert(first);
    await waitTrueLeaseExpiry(f,n.submissionId);
    const second=await f.safety.claimSubmission(f.who,{taskId:f.taskId,submissionId:n.submissionId,detectorRevision:prebirthDetector.revision,leaseMs:100});assert(second);
    assert.equal(second.generation,first.generation);assert.notEqual(second.leaseToken,first.leaseToken);
    let reached=false;
    await assert.rejects(f.safety.process(first,async()=>{reached=true;throw new Error('Stale claim must not reach classifier');},undefined,
      async client=>{await assertActiveSafetyDetector(client,prebirthDetector);}),code('COMPANION_NAME_SAFETY_CLAIM_CHANGED'));
    assert.equal(reached,false);assert.equal(requests.length,calls);
    await waitTrueLeaseExpiry(f,n.submissionId);await f.naming.executeNotification(n);
    assert.equal((await source(f,n.submissionId)).generation,1);assert.deepEqual((await source(f,n.submissionId)).request_ciphertext,raw);
    assert.equal(requests.length,calls+1);
    assert.deepEqual((await f.db.query('SELECT kind FROM platform_companion_name_dispatch_operations WHERE dispatch_id=$1 ORDER BY revision',[n.dispatchId])).rows.map(row=>row.kind),
      ['claim','recover','recover','start','detected','application']);
  });
});

test('B08 real child claim COMMIT followed by SIGKILL recovers without manufacturing a start, lease time or new generation',async()=>{
  await withFixture(async(f,_runtime,requests)=>{
    const accepted=await f.naming.accept(f.who,f.command()),n=notice(accepted),calls=requests.length;
    const killed=await killedUnstartedClaim(f,n.submissionId);assert.equal(killed.signal,'SIGKILL');assert(killed.pid!==undefined&&Number.isInteger(killed.pid)&&killed.pid>1);
    assert.equal((await f.db.query("SELECT count(*)::int AS n FROM platform_companion_name_dispatch_operations WHERE dispatch_id=$1 AND kind='start'",[n.dispatchId])).rows[0].n,0);
    assert.equal((await f.db.query("SELECT count(*)::int AS n FROM platform_safety_model_usage WHERE source_kind='companion_name' AND submission_id=$1",[n.submissionId])).rows[0].n,0);
    await waitTrueLeaseExpiry(f,n.submissionId);await f.naming.executeNotification(n);
    const current=await source(f,n.submissionId);assert.equal(current.generation,killed.claim.generation);assert.notEqual(current.lease_token,killed.claim.leaseToken);
    assert.equal(current.status,'detected');assert.equal(current.application_status,'applied');assert.equal(requests.length,calls+1);
  });
});

test('B09 a real completed provider call whose result is deliberately lost remains held after ordinary fail and every old port',async()=>{
  await withFixture(async(f,runtime,requests)=>{
    const accepted=await f.naming.accept(f.who,f.command()),n=notice(accepted),calls=requests.length;
    const claim=await f.safety.claimSubmission(f.who,{taskId:f.taskId,submissionId:n.submissionId,detectorRevision:prebirthDetector.revision});assert(claim);
    let guard:((client:import('pg').PoolClient,signal?:AbortSignal)=>Promise<void>)|undefined;
    await assert.rejects(f.safety.process(claim,async(input,admission,execution)=>{
      const usage=createCompanionNameSafetyModelUsage(f.db,claim,resolveModelRoute(f.config,runtime,'safety_classify'),f.config.safetyDailyModelCallLimit,execution);
      const actual=createCompanionNameSafetyClassifier({claim,profile:prebirthDetector,config:f.config,runtime,usage});guard=actual.guard;
      const decision=await actual.classify(input,admission);assert.deepEqual(decision,{level:'L0',mode:'full'});
      throw new Error('Controlled loss after actual validated provider completion');
    },undefined,async(client,signal)=>{if(guard)await guard(client,signal);else await assertActiveSafetyDetector(client,prebirthDetector,signal);}),/Controlled loss after actual validated provider completion/);
    await f.safety.fail(claim,'unavailable');
    const row=await source(f,n.submissionId);assert.equal(row.status,'pending');assert.equal(row.generation,1);assert.equal(row.execution_token,null);assert.equal(row.result_ciphertext,null);assert.equal(row.level,null);
    const usage=(await f.db.query("SELECT status,usage_status,admitted_at IS NOT NULL AS admitted,finished_at IS NOT NULL AS finished FROM platform_safety_model_usage WHERE source_kind='companion_name' AND submission_id=$1",[row.id])).rows;
    assert.deepEqual(usage,[{status:'complete',usage_status:'reported',admitted:true,finished:true}]);assert.equal(requests.length,calls+1);
    const saved=await dispatchBytes(f);
    await assert.rejects(f.safety.claimSubmission(f.who,{taskId:f.taskId,submissionId:row.id,detectorRevision:prebirthDetector.revision}),code('COMPANION_NAMING_REQUIRES_REVIEW'));
    await assert.rejects(f.safety.claim(f.who,{taskId:f.taskId,detectorRevision:prebirthDetector.revision}),code('COMPANION_NAMING_REQUIRES_REVIEW'));
    await assert.rejects(f.runner.runSubmission(f.who,{taskId:f.taskId,submissionId:row.id}),code('COMPANION_NAMING_REQUIRES_REVIEW'));
    await assert.rejects(f.runner.runNext(f.who,{taskId:f.taskId}),code('COMPANION_NAMING_REQUIRES_REVIEW'));
    await f.naming.executeNotification(n);await f.naming.read(f.who);
    assert.deepEqual(await dispatchBytes(f),saved);assert.equal(requests.length,calls+1);
    const observed=await f.naming.readOperation(f.who,accepted.acceptance.operation.id);assert.equal(observed?.progress.phase,'held');assert.equal(observed?.progress.hold,'requires_review');
  });
});

test('B10 actual latest full L0 survives an older pending barrier and later applies with zero reclassification of the saved source',async()=>{
  await withFixture(async(f,_runtime,requests)=>{
    const old=await f.naming.accept(f.who,f.command('Old note')),latest=await f.naming.accept(f.who,f.command('Juno',1));
    await f.runner.runAcceptedSubmission(f.who,notice(latest));
    const classified=await classifications(f,latest.acceptance.submissionId),calls=requests.length;
    await f.naming.executeNotification(notice(latest));
    assert.equal((await f.naming.readOperation(f.who,latest.acceptance.operation.id))?.progress.hold,'requires_review');
    assert.deepEqual(await classifications(f,latest.acceptance.submissionId),classified);assert.equal(requests.length,calls);
    await f.runner.runAcceptedSubmission(f.who,notice(old));const resolvedCalls=requests.length;
    await f.naming.executeNotification(notice(latest));
    assert.equal((await f.naming.readOperation(f.who,latest.acceptance.operation.id))?.progress.application.status,'applied');
    assert.deepEqual(await classifications(f,latest.acceptance.submissionId),classified);assert.equal(requests.length,resolvedCalls);
    for(const table of ['platform_conversations','platform_jobs','platform_companion_identity_selections'])
      assert.equal((await f.db.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1`,[f.who.userId])).rows[0].n,0);
  });
});

test('B11 actual classified L2 prepares its independent fixed capture after original session/terms deletion and unavailable resource configuration',async()=>{
  await withFixture(async(f,_runtime,requests)=>{
    const absent=f.namingWith(prebirthDetector,undefined),accepted=await absent.accept(f.who,f.command('Fictional prebirth high marker')),n=notice(accepted),calls=requests.length;
    await absent.executeNotification(n);const classified=await classifications(f,n.submissionId);
    assert.equal(classified.level,'L2');assert.equal(classified.mode,'keyword_only');assert.equal(requests.length,calls);
    assert.equal((await absent.readOperation(f.who,accepted.acceptance.operation.id))?.progress.resource,'unavailable');
    await f.db.query('DELETE FROM platform_sessions WHERE user_id=$1 AND token_hash=$2',[f.who.userId,f.who.tokenHash]);
    await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[f.who.userId]);
    await f.naming.executeNotification(n);
    assert.deepEqual(await classifications(f,n.submissionId),classified);assert.equal(requests.length,calls);
    const session=await insertSession(f.db,f.config,f.who.userId),viewer={userId:f.who.userId,tokenHash:tokenHash(session.token)};
    const read=await f.naming.readOperation(viewer,accepted.acceptance.operation.id);assert.equal(read?.progress.resource,'ready');assert.equal(read?.progress.hold,null);
    assert.equal((await f.db.query("SELECT count(*)::int AS n FROM platform_safety_events WHERE name_submission_id=$1 AND event_kind='response_prepared'",[n.submissionId])).rows[0].n,1);
    for(const table of ['platform_companion_name_safety_publications','platform_companion_name_safety_handled'])
      assert.equal((await f.db.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1`,[f.who.userId])).rows[0].n,0);
    const saved=await dispatchBytes(f);await f.naming.executeNotification(n);await f.naming.readOperation(viewer,accepted.acceptance.operation.id);
    assert.deepEqual(await dispatchBytes(f),saved);assert.equal(requests.length,calls);
  });
});

test('B14 first configuration hold retains raw g0 and later real configured profile performs one first claim',async()=>{
  await withFixture(async(f,_runtime,requests)=>{
    const absent=f.namingWith(null,f.original),accepted=await absent.accept(f.who,f.command()),n=notice(accepted),calls=requests.length;
    await absent.executeNotification(n);const raw=await source(f,n.submissionId);
    assert.equal(raw.status,'pending');assert.equal(raw.generation,0);assert.equal(raw.level,null);assert.equal(raw.claim_ciphertext,null);
    assert.equal((await absent.readOperation(f.who,accepted.acceptance.operation.id))?.progress.hold,'configuration_unavailable');assert.equal(requests.length,calls);
    await f.naming.executeNotification(n);
    assert.equal((await f.naming.readOperation(f.who,accepted.acceptance.operation.id))?.progress.application.status,'applied');
    assert.equal(requests.length,calls+1);
    assert.deepEqual((await f.db.query('SELECT kind FROM platform_companion_name_dispatch_operations WHERE dispatch_id=$1 ORDER BY revision',[n.dispatchId])).rows.map(row=>row.kind),
      ['hold','claim','start','detected','application']);
  });
});

test('B14 original session deletion retains evidence; a later genuine login only observes and cannot borrow raw execution authority',async()=>{
  await withFixture(async(f,_runtime,requests)=>{
    const input=f.command(),accepted=await f.naming.accept(f.who,input),n=notice(accepted),before=await dispatchBytes(f),calls=requests.length;
    await f.db.query('DELETE FROM platform_sessions WHERE user_id=$1 AND token_hash=$2',[f.who.userId,f.who.tokenHash]);
    assert.deepEqual(await dispatchBytes(f),before);
    const login=await insertSession(f.db,f.config,f.who.userId),later={userId:f.who.userId,tokenHash:tokenHash(login.token)};
    assert.notEqual(later.tokenHash,f.who.tokenHash);
    assert.equal((await f.naming.readOperation(later,input.operationId))?.acceptance.dispatchId,n.dispatchId);
    assert.deepEqual(await dispatchBytes(f),before);assert.equal(requests.length,calls);
    await f.naming.executeNotification(n);
    assert.equal((await f.naming.readOperation(later,input.operationId))?.progress.hold,'authorization_required');
    const held=await dispatchBytes(f);
    await assert.rejects(f.safety.claimSubmission(later,{taskId:f.taskId,submissionId:n.submissionId,detectorRevision:prebirthDetector.revision}),code('COMPANION_NAMING_REQUIRES_REVIEW'));
    assert.deepEqual(await dispatchBytes(f),held);assert.equal(requests.length,calls);
    const replay=await f.naming.accept(later,input);assert.equal(replay.acceptance.operation.replayed,true);
    const stored=(await f.db.query('SELECT * FROM platform_companion_name_dispatches WHERE id=$1',[n.dispatchId])).rows[0];
    assert.equal(JSON.parse(f.crypto.openUtf8(stored.payload_ciphertext,{table:'platform_companion_name_dispatches',column:'payload_ciphertext',rowId:stored.id,ownerId:f.who.userId,revision:1})).originalSessionHash,f.who.tokenHash);
    const fresh=await f.naming.accept(later,f.command('舟',1));assert.notEqual(fresh.acceptance.dispatchId,n.dispatchId);
    const row=await source(f,fresh.acceptance.submissionId);
    assert.equal(JSON.parse(f.crypto.openUtf8(row.request_ciphertext,{table:'platform_companion_name_submissions',column:'request_ciphertext',rowId:row.id,ownerId:f.who.userId,revision:2})).submittedSessionHash,later.tokenHash);
    assert.equal(requests.length,calls);
  });
});

test('B14 pending managed full L0 cannot apply through old ports using a later genuine session, before or after original logout',async()=>{
  await withFixture(async(f,_runtime,requests)=>{
    const accepted=await f.naming.accept(f.who,f.command()),n=notice(accepted);
    await f.runner.runAcceptedSubmission(f.who,n);
    const actual=await source(f,n.submissionId);assert.equal(actual.level,'L0');assert.equal(actual.detector_mode,'full');assert.equal(actual.application_status,'pending');
    const login=await insertSession(f.db,f.config,f.who.userId),later={userId:f.who.userId,tokenHash:tokenHash(login.token)},calls=requests.length;
    const input={taskId:f.taskId,submissionId:n.submissionId},before=await dispatchBytes(f);
    assert.notEqual(later.tokenHash,f.who.tokenHash);
    for(const apply of [()=>f.safety.apply(later,input),()=>f.prebirth.apply(later,input)])
      await assert.rejects(apply(),code('AUTH_REQUIRED'));
    assert.deepEqual(await dispatchBytes(f),before);assert.equal(requests.length,calls);
    await f.db.query('DELETE FROM platform_sessions WHERE user_id=$1 AND token_hash=$2',[f.who.userId,f.who.tokenHash]);
    for(const apply of [()=>f.safety.apply(later,input),()=>f.prebirth.apply(later,input)])
      await assert.rejects(apply(),code('AUTH_REQUIRED'));
    assert.deepEqual(await dispatchBytes(f),before);assert.equal(requests.length,calls);
    assert.equal((await f.naming.readOperation(later,accepted.acceptance.operation.id))?.progress.application.status,'pending');
  });
});

test('B14 already saved managed application permits later-session old-port read-only replay without borrowing original execution',async()=>{
  await withFixture(async(f,_runtime,requests)=>{
    const accepted=await f.naming.accept(f.who,f.command()),n=notice(accepted);
    await f.naming.executeNotification(n);
    const current=await source(f,n.submissionId);assert.equal(current.application_status,'applied');
    const login=await insertSession(f.db,f.config,f.who.userId),later={userId:f.who.userId,tokenHash:tokenHash(login.token)};
    await f.db.query('DELETE FROM platform_sessions WHERE user_id=$1 AND token_hash=$2',[f.who.userId,f.who.tokenHash]);
    const before=await dispatchBytes(f),calls=requests.length,input={taskId:f.taskId,submissionId:n.submissionId};
    const replay=await f.safety.apply(later,input);assert.equal(replay.replayed,true);assert.equal(replay.status,'applied');
    const composed=await f.prebirth.apply(later,input);assert.equal(composed.replayed,true);assert.equal(composed.status,'applied');
    assert.deepEqual(await dispatchBytes(f),before);assert.equal(requests.length,calls);
  });
});

test('B13 complete populated049 SQL replays twice in each isolated schema with scoped constraints and no source/journal byte changes',async()=>{
  await withPrebirthLoopback(async(runtime,requests)=>{
    const fixtures: NamingDispatchFixture[]=[];
    try {
      const sql=await readFile(new URL('../migrations/049_companion_name_dispatch.sql',import.meta.url),'utf8');
      for(let index=0;index<2;index++) {
        const f=await createNamingDispatchFixture(runtime);fixtures.push(f);
        const accepted=await f.naming.accept(f.who,f.command());await f.naming.executeNotification(notice(accepted));
        const before=await dispatchBytes(f),calls=requests.length;
        await f.db.withBoundedTransaction(async client=>{await client.query(sql);await client.query(sql);});
        assert.deepEqual(await dispatchBytes(f),before);assert.equal(requests.length,calls);
        const constraint=(await f.db.query("SELECT count(*)::int AS n FROM pg_constraint WHERE conname='companion_name_first_dispatch_anchor' AND conrelid='platform_companion_name_submissions'::regclass")).rows[0];
        assert.equal(constraint.n,1);
        assert.equal((await f.db.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname='companion_name_dispatch_append_guard' AND tgrelid='platform_companion_name_dispatches'::regclass")).rows[0].n,1);
      }
      assert.notEqual(fixtures[0].schema,fixtures[1].schema);
    } finally {for(const f of fixtures.reverse())await f.close();}
  });
});

test('B13/B15 ordinary anchor, journal, typed-source and explicit-NULL negatives reject without changing real stored evidence',async()=>{
  await withFixture(async(f,_runtime,requests)=>{
    const accepted=await f.naming.accept(f.who,f.command()),n=notice(accepted);await f.naming.executeNotification(n);const calls=requests.length;
    await ordinaryFailure(f,'UPDATE platform_companion_name_submissions SET first_name_dispatch_id=NULL WHERE id=$1',[n.submissionId],'23514');
    await ordinaryFailure(f,'UPDATE platform_companion_name_submissions SET first_name_dispatch_id=$2 WHERE id=$1',[n.submissionId,randomUUID()],'23514');
    await ordinaryFailure(f,'DELETE FROM platform_companion_name_dispatches WHERE id=$1',[n.dispatchId],'23514');
    await ordinaryFailure(f,'DELETE FROM platform_companion_name_dispatch_operations WHERE dispatch_id=$1',[n.dispatchId],'23514');
    await ordinaryFailure(f,'UPDATE platform_companion_name_dispatch_operations SET payload_digest=repeat(\'0\',64) WHERE dispatch_id=$1',[n.dispatchId],'23514');
    await ordinaryFailure(f,'UPDATE platform_companion_name_dispatches SET revision=revision-1 WHERE id=$1',[n.dispatchId],'23514');
    for(const [kind,generation,leaseToken,executionToken] of [['claim',null,null,null],['recover',1,null,null],['start',1,randomUUID(),null],['hold',1,null,null]] as const) {
      await ordinaryFailure(f,`INSERT INTO platform_companion_name_dispatch_operations(id,dispatch_id,user_id,submission_id,revision,kind,generation,lease_token,execution_token,previous_digest,payload_digest,payload_ciphertext)
        SELECT $2,id,user_id,submission_id,revision+1,$3,$4,$5,$6,repeat('0',64),repeat('1',64),payload_ciphertext FROM platform_companion_name_dispatches WHERE id=$1`,
      [n.dispatchId,randomUUID(),kind,generation,leaseToken,executionToken],'23514');
    }
    const legacy=await f.safety.submit(f.who,f.command('舟',1,1)),raw=await source(f,legacy.submissionId);
    assert.equal(raw.first_name_dispatch_id,null);
    await ordinaryFailure(f,`INSERT INTO platform_companion_name_dispatches(id,user_id,submission_id,operation_id,entry_id,task_id,companion_id,preview_revision,submitted_revision,
      expected_identity_revision,submitted_auth_version,application_operation_id,payload_digest,payload_ciphertext,state_ciphertext)
      SELECT $2,s.user_id,s.id,s.operation_id,s.entry_id,$3,s.companion_id,1,s.submitted_revision,s.expected_identity_revision,s.submitted_auth_version,s.application_operation_id,
        d.payload_digest,d.payload_ciphertext,d.state_ciphertext FROM platform_companion_name_submissions s JOIN platform_companion_name_dispatches d ON d.id=$1 WHERE s.id=$4`,
    [n.dispatchId,randomUUID(),randomUUID(),raw.id],'23503');
    await ordinaryFailure(f,`INSERT INTO platform_companion_name_dispatches(id,user_id,submission_id,operation_id,entry_id,task_id,companion_id,preview_revision,submitted_revision,
      expected_identity_revision,submitted_auth_version,application_operation_id,payload_digest,payload_ciphertext,state_ciphertext)
      SELECT $2,s.user_id,s.id,s.operation_id,s.entry_id,NULL,s.companion_id,1,s.submitted_revision,s.expected_identity_revision,s.submitted_auth_version,s.application_operation_id,
        d.payload_digest,d.payload_ciphertext,d.state_ciphertext FROM platform_companion_name_submissions s JOIN platform_companion_name_dispatches d ON d.id=$1 WHERE s.id=$3`,
    [n.dispatchId,randomUUID(),raw.id],'23502');
    const before=await dispatchBytes(f);await assert.rejects(f.naming.accept(f.who,f.command('舟',1,1)),code('COMPANION_NAME_ENTRY_REVISION_CHANGED'));
    await assert.rejects(f.naming.accept(f.who,{taskId:f.taskId,expectedEntryRevision:1,expectedIdentityRevision:1,operationId:raw.operation_id,name:'舟'}),code('COMPANION_NAME_OPERATION_CONFLICT'));
    assert.deepEqual(await dispatchBytes(f),before);assert.equal(requests.length,calls);
  });
});

test('B15 controlled owned-schema journal-tail loss keeps nonNULL anchor and authentic head; readers return503 and never reseed',async()=>{
  await withFixture(async(f,_runtime,requests)=>{
    const input=f.command(),accepted=await f.naming.accept(f.who,input),n=notice(accepted);await f.naming.executeNotification(n);const calls=requests.length;
    const row=(await f.db.query('SELECT id,row_to_json(t)::text AS exact FROM platform_companion_name_dispatch_operations t WHERE dispatch_id=$1 ORDER BY revision DESC LIMIT 1',[n.dispatchId])).rows[0];assert(row);
    const fk=(await f.db.query("SELECT conname,pg_get_constraintdef(oid) AS definition,condeferrable,condeferred,convalidated FROM pg_constraint WHERE conname='companion_name_dispatch_actual_tip' AND conrelid='platform_companion_name_dispatches'::regclass")).rows[0];assert(fk);
    const original=await dispatchBytes(f);
    // Privileged controlled damage is separate from the ordinary deletion
    // rejection above. Drop only the actual incoming tip FK and this owned guard.
    await f.db.query('ALTER TABLE platform_companion_name_dispatches DROP CONSTRAINT companion_name_dispatch_actual_tip');
    await f.db.query('ALTER TABLE platform_companion_name_dispatch_operations DISABLE TRIGGER companion_name_dispatch_operation_append_guard');
    try {
      await f.db.query('DELETE FROM platform_companion_name_dispatch_operations WHERE id=$1',[row.id]);
      const damaged=await dispatchBytes(f);
      await assert.rejects(f.naming.read(f.who),unavailable);await assert.rejects(f.naming.readOperation(f.who,input.operationId),unavailable);
      await assert.rejects(f.naming.accept(f.who,input),unavailable);await assert.rejects(f.naming.executeNotification(n),unavailable);
      assert.deepEqual(await dispatchBytes(f),damaged);assert.equal(requests.length,calls);
      assert.equal((await source(f,n.submissionId)).first_name_dispatch_id,n.dispatchId);
    } finally {
      await f.db.query('INSERT INTO platform_companion_name_dispatch_operations SELECT * FROM json_populate_record(NULL::platform_companion_name_dispatch_operations,$1::json)',[row.exact]);
      await f.db.query('ALTER TABLE platform_companion_name_dispatch_operations ENABLE TRIGGER companion_name_dispatch_operation_append_guard');
      await f.db.query('ALTER TABLE platform_companion_name_dispatches ADD CONSTRAINT companion_name_dispatch_actual_tip '+fk.definition);
    }
    assert.deepEqual(await dispatchBytes(f),original);
    const restored=(await f.db.query("SELECT conname,pg_get_constraintdef(oid) AS definition,condeferrable,condeferred,convalidated FROM pg_constraint WHERE conname='companion_name_dispatch_actual_tip' AND conrelid='platform_companion_name_dispatches'::regclass")).rows[0];assert.deepEqual(restored,fk);
    assert.equal((await f.naming.readOperation(f.who,input.operationId))?.progress.application.status,'applied');
  });
});

test('B15 controlled authenticated-head byte damage is unavailable without repairing or advancing any source',async()=>{
  await withFixture(async(f,_runtime,requests)=>{
    const input=f.command(),accepted=await f.naming.accept(f.who,input),n=notice(accepted);await f.naming.executeNotification(n);const calls=requests.length;
    const row=(await f.db.query('SELECT state_ciphertext FROM platform_companion_name_dispatches WHERE id=$1',[n.dispatchId])).rows[0];
    const original=await dispatchBytes(f),corrupt=Buffer.from(row.state_ciphertext);corrupt[corrupt.length-1]^=1;
    await f.db.query('ALTER TABLE platform_companion_name_dispatches DISABLE TRIGGER companion_name_dispatch_append_guard');
    try {
      await f.db.query('UPDATE platform_companion_name_dispatches SET state_ciphertext=$2 WHERE id=$1',[n.dispatchId,corrupt]);
      const damaged=await dispatchBytes(f);
      await assert.rejects(f.naming.readOperation(f.who,input.operationId),unavailable);await assert.rejects(f.naming.executeNotification(n),unavailable);
      assert.deepEqual(await dispatchBytes(f),damaged);assert.equal(requests.length,calls);
    } finally {await f.db.query('UPDATE platform_companion_name_dispatches SET state_ciphertext=$2 WHERE id=$1',[n.dispatchId,row.state_ciphertext]);await f.db.query('ALTER TABLE platform_companion_name_dispatches ENABLE TRIGGER companion_name_dispatch_append_guard');}
    assert.deepEqual(await dispatchBytes(f),original);
  });
});

test('B13 real account-root deletion cascades accepted source and complete journals after session deletion leaves them intact',async()=>{
  await withFixture(async(f,_runtime,requests)=>{
    const accepted=await f.naming.accept(f.who,f.command());await f.naming.executeNotification(notice(accepted));const before=await dispatchBytes(f),calls=requests.length;
    await f.db.query('DELETE FROM platform_sessions WHERE user_id=$1',[f.who.userId]);assert.deepEqual(await dispatchBytes(f),before);
    await f.db.withBoundedTransaction(client=>client.query('DELETE FROM platform_users WHERE id=$1',[f.who.userId]));
    for(const table of dispatchTables) assert.equal((await f.db.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1`,[f.who.userId])).rows[0].n,0);
    assert.equal(requests.length,calls);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_users WHERE id=$1',[f.ready.authority.reviewer.userId])).rows[0].n,1);
  });
});

test('B14 provider-disabled reviewed keyword L2 stays truthful; no-hit never produces a fake result or automatically replays its started attempt',async()=>{
  await withFixture(async(f,_runtime,requests)=>{
    const disabled=createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'0'},fetch:()=>{throw new Error('Disabled provider must not be invoked.');}});
    const runner=new CompanionNameSafetyRunner(f.safety,f.config,disabled,prebirthDetector);
    const naming=new CompanionNamingEntry(f.db,f.config,FICTIONAL_LEGAL,f.safety,runner,f.prebirth,f.original),calls=requests.length;
    const risk=await naming.accept(f.who,f.command('Fictional prebirth high marker'));await naming.executeNotification(notice(risk));
    const grade=await source(f,risk.acceptance.submissionId);assert.equal(grade.level,'L2');assert.equal(grade.detector_mode,'keyword_only');assert.equal(requests.length,calls);
    const nohit=await naming.accept(f.who,f.command('Juno',1));await naming.executeNotification(notice(nohit));
    const unknown=await source(f,nohit.acceptance.submissionId);assert.equal(unknown.status,'pending');assert.equal(unknown.level,null);assert.equal(unknown.result_ciphertext,null);assert.equal(unknown.generation,1);
    const held=await naming.readOperation(f.who,nohit.acceptance.operation.id);assert.equal(held?.progress.hold,'requires_review');
    await f.naming.executeNotification(notice(nohit));assert.equal(requests.length,calls);
    assert.equal((await f.db.query("SELECT count(*)::int AS n FROM platform_safety_model_usage WHERE source_kind='companion_name' AND user_id=$1",[f.who.userId])).rows[0].n,0);
  });
});
