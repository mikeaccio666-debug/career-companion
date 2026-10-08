import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { InjectOptions } from 'fastify';
import type { CreateJobInput, GoalPlan, GoalPlanInput, PlatformProviderRuntime } from '@companion/platform-contracts';
import { PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { buildApp } from '../src/app.ts';
import { hashPassword, tokenHash, type FixedSessionContext } from '../src/auth.ts';
import { readConfig } from '../src/config.ts';
import { ApiError } from '../src/errors.ts';
import { authorizeGoalPlanTask } from '../src/goal-plan-bindings.ts';
import { createPrebirthFixture, withPrebirthLoopback, type PrebirthFixture } from './fixtures/companion-prebirth.ts';
import { readyBirth } from './fixtures/companion-birth.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';

// Real PostgreSQL, session authentication, legacy plan confirmation and native
// birth persistence. The SQL room migration below is an attack fixture, never
// product permission. Fictional provider declarations validate task templates;
// every execution method is forbidden. Birth provider I/O is owned loopback.
const origin='https://fictional-main-plan.example.invalid',prefix='/api/platform';
const password='Fictional-main-boundary-password-only';
let fixture:PrebirthFixture,system:Awaited<ReturnType<typeof buildApp>>,providerCalls=0;
type Actor={who:FixedSessionContext;cookie:string};
type Method='GET'|'POST'|'PUT';
const forbidden=async():Promise<never>=>{providerCalls++;throw new Error('No provider execution is permitted in main plan boundary tests.');};
const runtime:PlatformProviderRuntime={
  capabilities:()=>[{id:'synthetic',name:'Fictional plan-template fixture',keyConfigured:true,enabled:true,
    capabilities:['speech'],models:['fictional-speech'],modelsByCapability:{speech:['fictional-speech']},envVariables:[]}],
  async *streamChat(){await forbidden();},
  executeJob:forbidden,createVoiceSession:forbidden,transcribe:forbidden,speech:forbidden,
};
const definition:GoalPlanInput={title:'Fictional legacy task plan',goal:'Review one fictional task before execution.',
  steps:[{kind:'task',title:'Fictional speech task',task:{kind:'speech',provider:'synthetic',prompt:'Fictional QA text only.'}}]};

before(async()=>{
  fixture=await createPrebirthFixture();
  system=await buildApp({db:fixture.db,legalBundle:FICTIONAL_LEGAL,runtime,enableQueue:false,
    config:{...readConfig(),dataCrypto:fixture.crypto,requireVerifiedEmail:true,workbenchEnabled:true,
      accountEmail:undefined,allowedOrigins:new Set([origin]),companionIdentityBundlePath:undefined,
      companionIdentityReviewPath:undefined,companionSealGlyphs:undefined},
    requestLimits:{policies:{api:{max:2000,windowSeconds:60},control:{max:2000,windowSeconds:60},
      'auth-login':{max:1000,windowSeconds:60}}},
  });
});
after(async()=>{try{if(system)await system.app.close();}finally{if(fixture)await fixture.close();}});

async function actor():Promise<Actor>{
  const who=await fixture.actor(),email=who.userId+'@example.invalid';
  await fixture.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,await hashPassword(password)]);
  const response=await system.app.inject({method:'POST',url:prefix+'/auth/login',headers:{origin},payload:{email,password}});
  assert.equal(response.statusCode,200,response.body);
  const rawHeader=response.headers['set-cookie'],setCookie=Array.isArray(rawHeader)?rawHeader[0]:rawHeader;
  assert(typeof setCookie==='string');const cookie=setCookie.split(';')[0],raw=cookie.slice(cookie.indexOf('=')+1);
  return {who:{userId:who.userId,tokenHash:tokenHash(raw)},cookie};
}
function request(who:Actor,method:Method,route:string,payload?:InjectOptions['payload']){
  return system.app.inject({method,url:prefix+route,
    headers:{origin,cookie:who.cookie,[PLATFORM_ACCOUNT_HEADER]:who.who.userId},
    ...(payload===undefined?{}:{payload})});
}
async function createPlan(who:Actor,conversationId:string):Promise<GoalPlan>{
  const response=await request(who,'POST',`/conversations/${conversationId}/goal-plans`,definition);
  assert.equal(response.statusCode,201,response.body);assert.equal(response.json().plan.status,'draft');
  return response.json().plan;
}
async function confirm(who:Actor,plan:GoalPlan):Promise<GoalPlan>{
  const response=await request(who,'POST',`/goal-plans/${plan.id}/confirm`,{revision:plan.revision});
  assert.equal(response.statusCode,200,response.body);assert.equal(response.json().plan.status,'active');
  return response.json().plan;
}

// Compare complete protected rows after each denied operation, including plan
// status/revision, bindings and ciphertext. HTTP rate-limit counters are outside
// this assertion because authenticating and checking a request consumes them.
async function protectedRows(userIds:string[]){
  const rows:Record<string,unknown>={};
  for(const table of ['platform_jobs','platform_approvals','platform_usage','platform_runtime_leases',
    'platform_goal_plans','platform_companion_birth_receipts','platform_companion_birth_assets','platform_conversations'])
    rows[table]=(await fixture.db.query(`SELECT * FROM ${table} WHERE user_id=ANY($1::uuid[]) ORDER BY id`,[userIds])).rows;
  rows.outbox=(await fixture.db.query(`SELECT o.* FROM platform_job_outbox o JOIN platform_jobs j ON j.id=o.job_id
    WHERE j.user_id=ANY($1::uuid[]) ORDER BY o.job_id,o.generation`,[userIds])).rows;
  rows.messages=(await fixture.db.query(`SELECT m.* FROM platform_messages m JOIN platform_conversations c ON c.id=m.conversation_id
    WHERE c.user_id=ANY($1::uuid[]) ORDER BY m.id`,[userIds])).rows;
  rows.revisions=(await fixture.db.query(`SELECT r.* FROM platform_goal_plan_revisions r JOIN platform_goal_plans p ON p.id=r.plan_id
    WHERE p.user_id=ANY($1::uuid[]) ORDER BY r.plan_id,r.revision`,[userIds])).rows;
  rows.steps=(await fixture.db.query(`SELECT s.* FROM platform_goal_plan_steps s JOIN platform_goal_plans p ON p.id=s.plan_id
    WHERE p.user_id=ANY($1::uuid[]) ORDER BY s.plan_id,s.revision,s.step_index`,[userIds])).rows;
  return rows;
}

async function mainAttackFixture(loopbackRuntime:PlatformProviderRuntime){
  const who=await actor(),foreign=await actor(),ready=await readyBirth(fixture,loopbackRuntime,{who:who.who});
  const birth=await ready.service.birth(who.who,ready.body,ready.key),mainId=birth.receipt.main.id;
  const conversation=await request(who,'POST','/conversations',{title:'Fictional legacy execution room',mode:'chat'});
  assert.equal(conversation.statusCode,201,conversation.body);const legacyId=conversation.json().conversation.id;
  assert.equal((await fixture.db.query('SELECT kind FROM platform_conversations WHERE id=$1',[legacyId])).rows[0].kind,'legacy');
  const draft=await createPlan(who,legacyId),active=await confirm(who,await createPlan(who,legacyId));

  // Positive control: exactly this valid template can reach the actual job and
  // approval transaction while it still belongs to an ordinary legacy room.
  // No approval is granted, no queue is enabled, and no provider is executed.
  const control=await confirm(who,await createPlan(who,legacyId));
  const continued=await request(who,'POST',`/goal-plans/${control.id}/continue`,{revision:control.revision,stepIndex:0});
  assert.equal(continued.statusCode,200,continued.body);assert.equal(continued.json().kind,'task');
  assert.equal(continued.json().job.status,'needs_approval');assert.equal(continued.json().approval.status,'pending');
  assert.equal((await fixture.db.query('SELECT count(*)::integer AS n FROM platform_jobs WHERE user_id=$1',[who.who.userId])).rows[0].n,1);
  assert.equal((await fixture.db.query('SELECT count(*)::integer AS n FROM platform_approvals WHERE user_id=$1',[who.who.userId])).rows[0].n,1);
  assert.equal((await fixture.db.query(`SELECT count(*)::integer AS n FROM platform_job_outbox o
    JOIN platform_jobs j ON j.id=o.job_id WHERE j.user_id=$1`,[who.who.userId])).rows[0].n,0);
  assert.equal(providerCalls,0);

  // Simulate an old/malformed persisted reference. This changes only the two
  // attack plans; the genuine main, immutable origin and positive control stay
  // intact. The checked API must reject this reference before execution effects.
  const migrated=await fixture.db.query(`UPDATE platform_goal_plans SET conversation_id=$2
    WHERE id=ANY($1::uuid[]) AND user_id=$3 RETURNING id`,[[draft.id,active.id],mainId,who.who.userId]);
  assert.equal(migrated.rowCount,2);
  return {who,foreign,mainId,plans:[draft,active],userIds:[who.who.userId,foreign.who.userId]};
}

test('old draft and confirmed plans moved to a genuinely born main reject every HTTP plan path before protected writes',async()=>{
  await withPrebirthLoopback(async(loopbackRuntime,requests)=>{
    const attack=await mainAttackFixture(loopbackRuntime),before=await protectedRows(attack.userIds);
    for(const plan of attack.plans){
      const cases:[Method,string,InjectOptions['payload']?][]=[
        ['GET',`/goal-plans/${plan.id}`],
        ['PUT',`/goal-plans/${plan.id}`,{...definition,revision:plan.revision}],
        ['POST',`/goal-plans/${plan.id}/confirm`,{revision:plan.revision}],
        ['POST',`/goal-plans/${plan.id}/state`,{revision:plan.revision,status:'paused'}],
        ['POST',`/goal-plans/${plan.id}/continue`,{revision:plan.revision,stepIndex:0}],
      ];
      for(const [method,route,payload] of cases){
        const own=await request(attack.who,method,route,payload);
        assert.equal(own.statusCode,409,`${plan.status} ${method} ${route}: ${own.body}`);
        assert.equal(own.json().error.code,'COMPANION_ROOM_REQUIRED',`${plan.status} ${method} ${route}`);
        assert.deepEqual(await protectedRows(attack.userIds),before,`${method} ${route} must not mutate protected rows`);
        const foreign=await request(attack.foreign,method,route,payload);
        assert.equal(foreign.statusCode,404,`${method} ${route}: ${foreign.body}`);
        assert.equal(foreign.json().error.code,'NOT_FOUND');
        assert.deepEqual(await protectedRows(attack.userIds),before,`${method} ${route} must preserve owner isolation`);
        assert.equal(providerCalls,0);
      }
    }
    for(const [method,route,payload] of [
      ['GET',`/conversations/${attack.mainId}/goal-plans`],
      ['POST',`/conversations/${attack.mainId}/goal-plans`,definition],
    ] as [Method,string,InjectOptions['payload']?][]){
      const own=await request(attack.who,method,route,payload);
      assert.equal(own.statusCode,409,own.body);assert.equal(own.json().error.code,'COMPANION_ROOM_REQUIRED');
      const foreign=await request(attack.foreign,method,route,payload);
      assert.equal(foreign.statusCode,404,foreign.body);assert.equal(foreign.json().error.code,'NOT_FOUND');
      assert.deepEqual(await protectedRows(attack.userIds),before);
    }
    assert.equal(requests.length,2);assert.equal(providerCalls,0);
  });
});

test('direct goal-plan job admission and binding authorization also reject migrated main plans without side effects',async()=>{
  await withPrebirthLoopback(async(loopbackRuntime,requests)=>{
    const attack=await mainAttackFixture(loopbackRuntime),before=await protectedRows(attack.userIds);
    let admissionCalls=0,mcpValidationCalls=0;
    for(const plan of attack.plans){
      const step=plan.steps[0].input;assert.equal(step.kind,'task');assert(step.kind==='task');
      const input:CreateJobInput=step.task,planOrigin={planId:plan.id,revision:plan.revision,stepIndex:0};
      for(const [who,status,code] of [
        [attack.who,409,'COMPANION_ROOM_REQUIRED'],[attack.foreign,404,'NOT_FOUND'],
      ] as const){
        const rejected=(error:unknown)=>error instanceof ApiError&&error.status===status&&error.code===code;
        await assert.rejects(system.jobs.create(who.who.userId,input,undefined,undefined,planOrigin,
          ()=>{admissionCalls++;}),rejected);
        assert.deepEqual(await protectedRows(attack.userIds),before,'direct job admission must not persist a child task or approval');
        await assert.rejects(fixture.db.transaction(client=>authorizeGoalPlanTask(client,who.who.userId,planOrigin,input,
          async()=>{mcpValidationCalls++;})),rejected);
        assert.deepEqual(await protectedRows(attack.userIds),before,'binding authorization must not alter the migrated plan');
        assert.equal(admissionCalls,0);assert.equal(mcpValidationCalls,0);assert.equal(providerCalls,0);
      }
    }
    assert.equal(requests.length,2);assert.equal(providerCalls,0);
  });
});
