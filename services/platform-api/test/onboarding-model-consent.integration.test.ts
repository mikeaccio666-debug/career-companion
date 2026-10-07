import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createProviderRuntime } from '@companion/ai-core';
import type { ModelStepContext, ModelStepEvent, ModelStepResult, PlatformProviderRuntime } from '@companion/platform-contracts';
import { tokenHash, type FixedSessionContext } from '../src/auth.ts';
import { readConfig } from '../src/config.ts';
import { readDataCrypto } from '../src/data-crypto.ts';
import { Database } from '../src/database.ts';
import { ApiError } from '../src/errors.ts';
import { requireModelConsent } from '../src/model-consent.ts';
import { OnboardingEntry } from '../src/onboarding-entry.ts';
import { expectedSafetyProfileDigests, parseSafetyDetectorProfile } from '../src/safety-detector-profile.ts';
import { FICTIONAL_LEGAL, seedFictionalActiveLegal, seedFictionalConsent } from './fixtures/student-entry.ts';
import { fictionalBundle } from './fixtures/onboarding-followup.ts';

// Actual consent wrapper + onboarding composition + strict Responses/SSE adapter + isolated PG.
// All accounts, resources and classifier output are fictional. Every HTTP request is redirected to our loopback server.
const base=readConfig(),schema='onboarding_model_consent_'+randomUUID().replaceAll('-',''),url=new URL(base.databaseUrl);
assert(process.env.PLATFORM_DATABASE_URL,'Supply a dedicated verification database URL.');
assert(['127.0.0.1','localhost','[::1]'].includes(url.hostname));
assert.notEqual(url.port,'5442','Preserve the local development database.');
url.searchParams.set('options','-c search_path='+schema);
const admin=new Database(base.databaseUrl),db=new Database(url.toString());
const bundle=fictionalBundle();
const config={...base,dataCrypto:readDataCrypto({PLATFORM_DATA_KEY:'92'.repeat(32)})!,requireVerifiedEmail:true,
  modelRoutes:{safety_classify:{provider:'openai'}},safetyDailyModelCallLimit:5};
const profileContent={schemaVersion:1,revision:53,instructions:'Fictional wrapped-adapter QA policy only.',
  algorithm:'literal_substring_v1',lexicon:[{id:'fictional-low',language:'en',level:'L1',phrases:['Fictional persistent distress marker']},
    {id:'fictional-high',language:'zh',level:'L2',phrases:['虚构最高风险标记']}],mergeRule:'highest_level',fallbackNoHit:'unavailable',
  review:{reference:'fictional-wrapper-fixture-not-professional-review',approvedAt:'2026-10-07T00:00:00.000Z'}};
const profile=parseSafetyDetectorProfile({...profileContent,...expectedSafetyProfileDigests(profileContent)});
const providerEnv={PLATFORM_ALLOW_PROVIDER_CALLS:'1',OPENAI_API_KEY:'fictional-loopback-only',
  OPENAI_CHAT_MODEL:'fictional-general-chat',OPENAI_SAFETY_CLASSIFY_MODEL:'fictional-wrapped-safety'};
const decision={level:'L0',resolution:{kind:'answer',questionId:'study',value:{degreeField:'ds_statistics',programChoice:null}}};
let created=false;
before(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);created=true;await db.migrate();await seedFictionalActiveLegal(db);
  const owner=await actor();
  await db.query(`INSERT INTO platform_safety_detector_policy(singleton,revision,content_digest,review_digest,activated_at,activated_by)
    VALUES(true,$1,$2,$3,clock_timestamp(),$4)`,[profile.revision,profile.digest,profile.reviewDigest,owner.userId]);
  await db.query(`INSERT INTO platform_safety_response_policy(singleton,revision,content_digest,review_digest,activated_at,activated_by)
    VALUES(true,$1,$2,$3,clock_timestamp(),$4)`,[bundle.revision,bundle.contentDigest,bundle.reviewDigest,owner.userId]);
});
after(async()=>{
  try{await db.close();}
  finally{try{if(created){await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    assert.equal((await admin.query('SELECT nspname FROM pg_namespace WHERE nspname=$1',[schema])).rowCount,0);}}
    finally{await admin.close();}}
});
async function actor():Promise<FixedSessionContext>{
  const userId=randomUUID(),hash=tokenHash(randomUUID());
  await db.query(`INSERT INTO platform_users(id,email,name,password_hash,account_kind,email_verified_at)
    VALUES($1,$2,'Fictional wrapped-intake student','fictional-unused-password','student',clock_timestamp())`,[userId,userId+'@example.invalid']);
  await db.query(`INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at)
    VALUES($1,$2,0,clock_timestamp()+interval '1 hour')`,[userId,hash]);
  await seedFictionalConsent(db,userId);return {userId,tokenHash:hash};
}
const code=(expected:string)=>(error:unknown)=>error instanceof ApiError&&error.code===expected;
interface Observation {order:string[];callIds:string[];steps:number;requests:number;}
async function loopback(run:(entry:OnboardingEntry,wrapped:PlatformProviderRuntime,observation:Observation)=>Promise<void>,
  afterStarted?:(callId:string)=>Promise<void>) {
  const observation:Observation={order:[],callIds:[],steps:0,requests:0};let failure:unknown;
  const server=http.createServer(async(request,reply)=>{
    try{
      observation.requests++;observation.order.push('loopback_received');
      assert.equal(request.url,'/v1/responses');
      const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(chunk);
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(body.model,'fictional-wrapped-safety');assert.equal(body.tool_choice,'none');assert.deepEqual(body.tools,[]);
      assert.equal(body.store,false);assert.equal(body.text.format.strict,true);assert.equal(body.max_output_tokens,100);
      const event={type:'response.completed',response:{status:'completed',output:[{type:'message',role:'assistant',status:'completed',
        content:[{type:'output_text',text:JSON.stringify(decision)}]}],usage:{input_tokens:17,output_tokens:12}}};
      reply.writeHead(200,{'content-type':'text/event-stream'});reply.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
    }catch(error){failure=error;reply.destroy();}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert(address&&typeof address==='object');
  const local=`http://127.0.0.1:${address.port}`;
  const core=createProviderRuntime({env:providerEnv,fetch:(target,init)=>{
    const remote=new URL(String(target));assert.equal(remote.origin,'https://api.openai.com');assert.equal(remote.pathname,'/v1/responses');
    observation.order.push('transport_launched');return fetch(local+remote.pathname,init);
  }});
  const runtime:PlatformProviderRuntime={...core,
    streamModelStep(input,context):AsyncGenerator<ModelStepEvent,ModelStepResult>{
      observation.steps++;
      assert.equal(context.purpose,'safety_classify');assert(context.onModelCall);assert(context.requestAdmission);
      return core.streamModelStep!(input,{...context,
        onModelCall:async event=>{
          observation.order.push(event.type);await context.onModelCall!(event);
          const persisted=(await db.query('SELECT * FROM platform_safety_model_usage WHERE call_id=$1',[event.callId])).rows[0];assert(persisted);
          if(event.type==='started'){
            assert.equal(persisted.status,'prepared');assert.equal(persisted.admitted_at,null);
            observation.callIds.push(event.callId);observation.order.push('started_committed');
            if(afterStarted)await afterStarted(event.callId);
          }else observation.order.push('finished_committed');
        },
        requestAdmission:async(launch,signal)=>{
          observation.order.push('actual_admission_requested');
          return context.requestAdmission!(async admitted=>{
            admitted.throwIfAborted();observation.order.push('actual_transport_admitted');return launch(admitted);
          },signal);
        },
      });
    },
  };
  const wrapped=requireModelConsent(runtime),entry=new OnboardingEntry(db,config,FICTIONAL_LEGAL,wrapped,profile,bundle);
  try{await run(entry,wrapped,observation);if(failure)throw failure;}
  finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
async function pending(entry:OnboardingEntry,who:FixedSessionContext){
  const initial=await entry.save(who,{operationId:randomUUID(),expectedRevision:0,action:{kind:'start',mode:'standard'}});
  assert.equal((await entry.read(who)).freeTextAvailable,true);
  return entry.save(who,{operationId:randomUUID(),expectedRevision:initial.draft.revision,
    action:{kind:'text',questionId:'study',text:'Fictional DS student, with no configured keyword signal.'}});
}

test('wrapped actual onboarding commits started before real admission and advances ordinary text through full L0',async()=>{
  const who=await actor();
  await loopback(async(entry,_wrapped,observation)=>{
    const saved=await pending(entry,who),state=await entry.retrySafety(who);
    assert.equal(state.draft?.state,'collecting');assert.equal(state.draft?.currentQuestion,'graduation');
    assert.equal(state.draft?.revision,saved.draft.revision+1);assert.equal(state.draft?.answersPartial.study?.kind,'answered');
    assert.equal(observation.steps,1);assert.equal(observation.requests,1);
    assert.deepEqual(observation.order,['started','started_committed','actual_admission_requested','actual_transport_admitted','transport_launched','loopback_received','finished','finished_committed']);
    const source=(await db.query('SELECT * FROM platform_onboarding_safety_submissions WHERE user_id=$1',[who.userId])).rows[0];
    assert.equal(source.status,'detected');assert.equal(source.level,'L0');assert.equal(source.detector_mode,'full');assert(source.result_ciphertext instanceof Buffer);
    const usage=(await db.query('SELECT * FROM platform_safety_model_usage WHERE user_id=$1',[who.userId])).rows;
    assert.equal(usage.length,1);assert.equal(usage[0].call_id,observation.callIds[0]);assert.equal(usage[0].submission_id,source.id);
    assert.equal(usage[0].operation_id,saved.operation.id);assert.equal(usage[0].generation,source.generation);assert.equal(usage[0].detector_revision,profile.revision);
    assert.equal(usage[0].status,'complete');assert.equal(usage[0].usage_status,'reported');assert.equal(usage[0].input_tokens,17);assert.equal(usage[0].output_tokens,12);
    assert(usage[0].admitted_at instanceof Date);assert(usage[0].finished_at instanceof Date);
    assert(usage[0].created_at<=usage[0].admitted_at);assert(usage[0].admitted_at<=usage[0].finished_at);
    await entry.retrySafety(who);assert.equal(observation.requests,1);
  });
});

test('wrapped onboarding rejects missing consent and rechecks consent revoked after the actual started receipt',async()=>{
  const beforeCall=await actor();
  await loopback(async(entry,_wrapped,observation)=>{
    await pending(entry,beforeCall);await db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[beforeCall.userId]);
    await assert.rejects(entry.retrySafety(beforeCall),code('TERMS_CONFIRMATION_REQUIRED'));
    assert.equal(observation.steps,0);assert.equal(observation.requests,0);
    assert.equal((await db.query('SELECT * FROM platform_safety_model_usage WHERE user_id=$1',[beforeCall.userId])).rowCount,0);
  });
  const duringCall=await actor();
  await loopback(async(entry,_wrapped,observation)=>{
    const saved=await pending(entry,duringCall);
    await assert.rejects(entry.retrySafety(duringCall),code('TERMS_CONFIRMATION_REQUIRED'));
    assert.equal(observation.steps,1);assert.equal(observation.requests,0);
    assert(observation.order.includes('started_committed'));assert(observation.order.includes('actual_admission_requested'));
    assert.equal(observation.order.includes('actual_transport_admitted'),false);
    const source=(await db.query('SELECT * FROM platform_onboarding_safety_submissions WHERE user_id=$1',[duringCall.userId])).rows[0];
    assert.equal(source.level,null);assert.equal(source.result_ciphertext,null);assert.notEqual(source.status,'detected');
    const usage=(await db.query('SELECT * FROM platform_safety_model_usage WHERE user_id=$1',[duringCall.userId])).rows[0];
    assert(usage);assert.equal(usage.admitted_at,null);
    await seedFictionalConsent(db,duringCall.userId);
    const draft=await entry.drafts.read(duringCall);assert.equal(draft?.revision,saved.draft.revision);assert.equal(draft?.state,'safety_pending');
  },async()=>{await db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[duringCall.userId]);});
});

test('wrapped step with no trusted admission never reaches the actual adapter or transport',async()=>{
  await loopback(async(_entry,wrapped,observation)=>{
    const context:ModelStepContext={tools:[],toolChoice:'none',limits:{maxOutputTokens:100},callIndex:1,timeoutMs:700,invocation:{},purpose:'safety_classify'};
    const stream=wrapped.streamModelStep!({provider:'openai',model:'fictional-wrapped-safety',mode:'chat',messages:[{role:'user',content:'Fictional note'}]},context);
    await assert.rejects(stream.next(),code('TERMS_CONFIRMATION_REQUIRED'));
    assert.equal(observation.steps,0);assert.equal(observation.requests,0);assert.deepEqual(observation.order,[]);
  });
});

test('a claim lease expiring after the persisted started receipt still fences wrapped model launch',async()=>{
  const who=await actor();
  await loopback(async(entry,_wrapped,observation)=>{
    const saved=await pending(entry,who),state=await entry.retrySafety(who);
    assert.equal(observation.steps,1);assert.equal(observation.requests,0);assert.equal(observation.order.includes('actual_transport_admitted'),false);
    assert.equal(state.draft?.state,'safety_pending');assert.equal(state.draft?.revision,saved.draft.revision);
    const source=(await db.query('SELECT * FROM platform_onboarding_safety_submissions WHERE user_id=$1',[who.userId])).rows[0];
    assert.equal(source.level,null);assert.equal(source.result_ciphertext,null);
    assert.equal((await db.query('SELECT admitted_at FROM platform_safety_model_usage WHERE user_id=$1',[who.userId])).rows[0].admitted_at,null);
  },async()=>{await db.query("UPDATE platform_onboarding_safety_submissions SET lease_until=clock_timestamp()-interval '1 second' WHERE user_id=$1",[who.userId]);});
});
