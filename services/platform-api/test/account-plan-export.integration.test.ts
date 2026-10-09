import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {PlatformProviderRuntime} from '@companion/platform-contracts';
import type {Database} from '../src/database.ts';
import type {JobService} from '../src/jobs.ts';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {AccountReauthentication} from '../src/account-reauthentication.ts';
import {GoalPlans,parseGoalPlanInput} from '../src/goal-plans.ts';
import {GoalPlanProposals} from '../src/goal-plan-proposals.ts';
import {goalPlanHash} from '../src/goal-plan-core.ts';
import {hashPassword,type FixedSessionContext} from '../src/auth.ts';
import {createCompanionNameSafetyFixture} from './fixtures/companion-name-safety.ts';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,encoded:string,plans:GoalPlans,proposals:GoalPlanProposals;
const password='Fictional-plan-export-password';let executions=0;
const forbidden=()=>{executions++;throw Error('No provider or executor calls are permitted.');};
const runtime={capabilities:()=>[{id:'fictional',name:'Fictional',enabled:true,keyConfigured:true,capabilities:['agent'],models:['fictional-model']}],streamChat:forbidden,executeJob:forbidden} as unknown as PlatformProviderRuntime;
before(async()=>{f=await createCompanionNameSafetyFixture();encoded=await hashPassword(password);plans=new GoalPlans(f.db,new Proxy({},{get:()=>forbidden}) as JobService,runtime);proposals=new GoalPlanProposals(f.db,plans);});
after(async()=>{assert.equal(executions,0);await f?.close();});
async function actor(){const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,encoded]);return who;}
async function conversation(who:FixedSessionContext){const key=randomUUID();await f.db.query("INSERT INTO platform_conversations(id,user_id,title,mode) VALUES($1,$2,'Fictional plan archive','agent')",[key,who.userId]);return key;}
const definition=(title='Fictional original plan')=>({title,goal:'Compare two fictional career directions',steps:[{kind:'agent_turn',title:'Fictional analysis',instruction:'Preserve these original words 原文',provider:'fictional'}]});
const proof=async(who:FixedSessionContext)=>(await new AccountReauthentication(f.db).verify(who,{purpose:'account_export',password})).token;
const capture=async(who:FixedSessionContext)=>new AccountCoreExport(f.db,f.config).capture(who,await proof(who));
const consumed=async(who:FixedSessionContext)=>(await f.db.query("SELECT consumed_at FROM platform_account_reauthentications WHERE user_id=$1 AND purpose='account_export'",[who.userId])).rows[0].consumed_at;
function instrument(transform:(sql:string,rows:Record<string,any>[])=>void|Promise<void>):Database{return {withBoundedTransaction:<T>(run:(client:PoolClient)=>Promise<T>,options?:{readOnly?:boolean;timeoutMs?:number})=>f.db.withBoundedTransaction(client=>run(new Proxy(client,{get(target,key){
 if(key==='query')return async(sql:string,values:unknown[])=>{const result=await target.query(sql,values);await transform(sql,result.rows);return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
}})),options)} as Database;}
const planRead=(sql:string)=>sql.startsWith('SELECT p.id,p.user_id,p.conversation_id,p.revision,p.status');
const revisionRead=(sql:string)=>sql.startsWith('SELECT plan_id,revision,title,goal,definition_hash');
const stepRead=(sql:string)=>sql.startsWith('SELECT plan_id,revision,step_index,input,input_hash');
async function snapshot(who:FixedSessionContext){return (await f.db.query(`SELECT row_to_json(p)::text AS plan,
 (SELECT jsonb_agg(row_to_json(r) ORDER BY revision) FROM platform_goal_plan_revisions r WHERE r.plan_id=p.id) AS revisions,
 (SELECT jsonb_agg(row_to_json(s) ORDER BY revision,step_index) FROM platform_goal_plan_steps s WHERE s.plan_id=p.id) AS steps,
 (SELECT row_to_json(o) FROM platform_goal_plan_proposals o WHERE o.plan_id=p.id) AS proposal FROM platform_goal_plans p WHERE user_id=$1 ORDER BY id`,[who.userId])).rows;}

test('actual create, update, confirmation, pause and cancellation preserve every original revision without live state evaluation',async context=>{
 context.mock.method(globalThis,'fetch',async()=>{throw Error('No network');});
 const who=await actor(),other=await actor(),conv=await conversation(who),foreign=await plans.create(other.userId,await conversation(other),definition('Fictional foreign plan'));
 const first=await plans.create(who.userId,conv,definition()),updated=await plans.update(who.userId,first.id,{revision:1,...definition('Fictional revised plan')});
 await plans.confirm(who.userId,first.id,{revision:updated.revision});await plans.state(who.userId,first.id,{revision:2,status:'paused'});
 const draft=await plans.create(who.userId,conv,definition('Fictional cancelled draft'));await plans.state(who.userId,draft.id,{revision:1,status:'cancelled'});
 await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[who.userId]);await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[who.userId]);
 const before=await snapshot(who);context.mock.method(plans,'get',forbidden);context.mock.method(runtime,'capabilities',forbidden);
 const result=await capture(who),revisions=result.sections.goalPlanRevisions as any[],steps=result.sections.goalPlanSteps as any[];
 assert.equal(result.sections.goalPlans.length,2);assert.equal(revisions.length,3);assert.equal(steps.length,3);
 assert.equal(revisions.find(r=>r.planId===first.id&&r.revision===1).title,definition().title);assert.equal(revisions.find(r=>r.planId===first.id&&r.revision===1).confirmedAt,null);
 assert.equal(steps.find(r=>r.planId===first.id&&r.revision===1).input.model,undefined);assert.equal(steps.find(r=>r.planId===first.id&&r.revision===2).input.model,'fictional-model');
 assert.deepEqual((result.sections.goalPlans as any[]).map(r=>r.storedStatus).sort(),['cancelled','paused']);assert.deepEqual(await snapshot(who),before);
 for(const privateValue of [other.userId,foreign.id,'Fictional foreign plan',who.tokenHash,encoded,password])assert(!JSON.stringify(result).includes(privateValue));
 assert.equal(result.includedTables.length,94);assert.equal(result.remainingTables.length,66);assert.equal(result.complete,false);assert.equal(result.filesIncluded,false);assert(Object.isFrozen(steps[0].input));
});

test('actual proposal origin survives editing and message deletion without requiring an active lease or matching the edited definition',async()=>{
 const who=await actor(),conv=await conversation(who),messageId=randomUUID();
 await f.db.query("INSERT INTO platform_messages(id,conversation_id,role,content,status,lease_until) VALUES($1,$2,'assistant','Fictional proposal','streaming',now()+interval '120 seconds')",[messageId,conv]);
 await f.db.query("INSERT INTO platform_runtime_leases(id,user_id,kind,expires_at) VALUES($1,$2,'chat',now()+interval '120 seconds')",[messageId,who.userId]);
 const result=await proposals.propose(who.userId,{messageId,conversationId:conv},definition());await plans.update(who.userId,result.proposal.planId,{revision:1,...definition('Fictional edited proposal')});
 await f.db.query('DELETE FROM platform_runtime_leases WHERE id=$1',[messageId]);await f.db.query("UPDATE platform_messages SET status='complete',lease_until=NULL WHERE id=$1",[messageId]);
 const archive=await capture(who),row=archive.sections.goalPlanProposals[0] as any;assert.equal(row.planId,result.proposal.planId);assert.equal(row.message.id,messageId);assert.equal(row.message.availability,'metadata_present');
 await f.db.query('DELETE FROM platform_messages WHERE id=$1',[messageId]);assert.equal((await capture(who)).sections.goalPlanProposals.length,1);assert.equal(((await capture(who)).sections.goalPlanProposals[0] as any).message,null);
});

// Retained execution receipts are synthetic state fixtures. They do not claim
// that a real model, external tool or approved task was executed by this test.
async function retained(who:FixedSessionContext){
 const conv=await conversation(who),input={...definition(),steps:[{kind:'agent_turn',title:'Fictional source',instruction:'Original source',provider:'fictional'},
  {kind:'task',title:'Fictional follow-up',task:{kind:'speech',provider:'fictional',prompt:'Original template',options:{voice:'fictional-voice'}},bindings:{prompt:{fromStep:0,source:'analysis_text',mode:'append'}}}]};
 const p=await plans.create(who.userId,conv,input),message=randomUUID(),job=randomUUID(),artifact=randomUUID();
 await f.db.query("INSERT INTO platform_messages(id,conversation_id,role,content,status) VALUES($1,$2,'assistant','Fictional preserved source','complete')",[message,conv]);
 await f.db.query("INSERT INTO platform_jobs(id,user_id,kind,provider,prompt,status,execution_policy) VALUES($1,$2,'speech','fictional','Fictional later task','succeeded',$3)",[job,who.userId,JSON.stringify({secret:'fictional-private-executor-policy'})]);
 await f.db.query("INSERT INTO platform_artifacts(id,user_id,job_id,kind,mime,filename) VALUES($1,$2,$3,'speech','audio/wav','fictional.wav')",[artifact,who.userId,job]);
 const completedAt=new Date().toISOString(),resolved={...(parseGoalPlanInput(input).steps[1] as any).task,prompt:'Original template\nFictional preserved source'},sources=[{source:'analysis_text',fromStep:0,mode:'append',messageId:message,sha256:'a'.repeat(64),byteSize:26}];
 await f.db.query('UPDATE platform_goal_plan_steps SET message_id=$2,bound_at=now(),receipt=$3 WHERE plan_id=$1 AND step_index=0',[p.id,message,JSON.stringify({kind:'agent_turn',messageId:message,completedAt})]);
 await f.db.query('UPDATE platform_goal_plan_steps SET job_id=$2,job_generation=1,bound_at=now(),receipt=$3,resolved_task=$4,input_sources=$5 WHERE plan_id=$1 AND step_index=1',[p.id,job,JSON.stringify({kind:'task',jobId:job,generation:1,artifactIds:[artifact],completedAt}),JSON.stringify(resolved),JSON.stringify(sources)]);
 return {p,conv,message,job,artifact,resolved,sources};
}

test('saved inputs, source provenance and receipts remain historical after result deletion and task version changes',async()=>{
 const who=await actor(),s=await retained(who);await f.db.query('UPDATE platform_jobs SET generation=2 WHERE id=$1',[s.job]);
 const before=await snapshot(who),result=await capture(who),rows=result.sections.goalPlanSteps as any[];
 assert.deepEqual(rows[1].resolvedTask,s.resolved);assert.deepEqual(rows[1].inputSources,s.sources);assert.equal(rows[1].receipt.generation,1);assert(!JSON.stringify(result).includes('fictional-private-executor-policy'));assert.deepEqual(await snapshot(who),before);
 await f.db.query('DELETE FROM platform_artifacts WHERE id=$1',[s.artifact]);await f.db.query('DELETE FROM platform_jobs WHERE id=$1',[s.job]);await f.db.query('DELETE FROM platform_messages WHERE id=$1',[s.message]);
 const missing=(await capture(who)).sections.goalPlanSteps as any[];assert.equal(missing[1].jobId,null);assert.equal(missing[0].messageId,null);assert.equal(missing[1].receipt.jobId,s.job);assert.deepEqual(missing[1].resolvedTask,s.resolved);
 assert(missing.flatMap(r=>r.references).every(r=>r.availability==='not_found'));assert.equal(missing[1].inputSources[0].messageId,s.message);
});

test('105 plans and 105 revisions exceed normal UI limits but export all history in stable pages',async()=>{
 const who=await actor(),convs=await Promise.all([conversation(who),conversation(who),conversation(who)]),ids:string[]=[];
 for(let i=0;i<105;i++)ids.push((await plans.create(who.userId,convs[Math.floor(i/50)],definition('Fictional plan '+i))).id);
 for(let revision=1;revision<105;revision++)await plans.update(who.userId,ids[0],{revision,...definition('Fictional revision '+(revision+1))});
 const queries:string[]=[],result=await new AccountCoreExport(instrument(sql=>{queries.push(sql);}),f.config).capture(who,await proof(who));
 assert.deepEqual((result.sections.goalPlans as any[]).map(r=>r.id),ids.sort());assert.equal(result.sections.goalPlanRevisions.length,209);assert.equal(result.sections.goalPlanSteps.length,209);assert.equal(queries.filter(planRead).length,2);
 assert.equal(Math.max(...(result.sections.goalPlanRevisions as any[]).map(r=>r.revision)),105);
});

test('actual cross-owner plan conversations, proposal parents, jobs and artifacts reject the entire archive and preserve proof',async()=>{
 const who=await actor(),other=await actor(),s=await retained(who),foreign=await retained(other),token=await proof(who);
 const reject=async()=>{await assert.rejects(new AccountCoreExport(f.db,f.config).capture(who,token),{code:'ACCOUNT_PLAN_EXPORT_UNAVAILABLE'});assert.equal(await consumed(who),null);};
 await f.db.query('UPDATE platform_goal_plans SET conversation_id=$2 WHERE id=$1',[s.p.id,foreign.conv]);await reject();await f.db.query('UPDATE platform_goal_plans SET conversation_id=$2 WHERE id=$1',[s.p.id,s.conv]);
 await f.db.query('UPDATE platform_jobs SET user_id=$2 WHERE id=$1',[s.job,other.userId]);await reject();await f.db.query('UPDATE platform_jobs SET user_id=$2 WHERE id=$1',[s.job,who.userId]);
 await f.db.query('UPDATE platform_artifacts SET user_id=$2 WHERE id=$1',[s.artifact,other.userId]);await reject();await f.db.query('UPDATE platform_artifacts SET user_id=$2 WHERE id=$1',[s.artifact,who.userId]);
 await f.db.query('INSERT INTO platform_goal_plan_proposals(plan_id,user_id,conversation_id,input_hash) VALUES($1,$2,$3,$4)',[foreign.p.id,who.userId,s.conv,'b'.repeat(64)]);await reject();await f.db.query('DELETE FROM platform_goal_plan_proposals WHERE plan_id=$1',[foreign.p.id]);
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(who,token)).sections.goalPlans.length,1);
});

test('modified definitions, missing revisions, unknown receipts and mismatched sources never release a partial archive',async()=>{
 const who=await actor(),s=await retained(who);await plans.update(who.userId,s.p.id,{revision:1,...definition('Fictional next revision')});const token=await proof(who);
 const cases:[(sql:string)=>boolean,(rows:any[])=>void][]=[
  [planRead,r=>{r[0].user_id=randomUUID();}], [revisionRead,r=>{r[0].title='Unbound changed title';}], [revisionRead,r=>{r.shift();}],
  [stepRead,r=>{r[0].step_index=1;}], [stepRead,r=>{r[0].receipt.extra='fictional-secret';}],
  [stepRead,r=>{r[1].receipt.jobId=randomUUID();}], [stepRead,r=>{r[1].input_sources[0].messageId=randomUUID();}],
  [stepRead,r=>{r[1].input_sources[0].fromStep=1;}], [stepRead,r=>{r[1].resolved_task.extra='fictional-private';}],
 ];
 for(const [match,change] of cases){let reached=false;await assert.rejects(new AccountCoreExport(instrument((sql,rows)=>{if(!reached&&match(sql)&&rows.length){reached=true;change(rows);}}),f.config).capture(who,token),{code:'ACCOUNT_PLAN_EXPORT_UNAVAILABLE'});assert(reached);assert.equal(await consumed(who),null);}
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(who,token)).sections.goalPlanRevisions.length,2);
});

test('cancelled and oversized captures roll back reauthentication; empty history remains empty',async()=>{
 const who=await actor(),empty=await capture(who);assert.deepEqual(empty.sections.goalPlans,[]);assert.deepEqual(empty.sections.goalPlanSteps,[]);
 const conv=await conversation(who);await plans.create(who.userId,conv,{...definition(),goal:'Fictional'.repeat(750)});const token=await proof(who),abort=new AbortController();
 await assert.rejects(new AccountCoreExport(instrument(sql=>{if(stepRead(sql))abort.abort();}),f.config).capture(who,token,abort.signal),{code:'ACCOUNT_EXPORT_CANCELLED'});assert.equal(await consumed(who),null);
 await assert.rejects(new AccountCoreExport(f.db,f.config,{maxBytes:6000}).capture(who,token),{code:'ACCOUNT_EXPORT_TOO_LARGE'});assert.equal(await consumed(who),null);
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(who,token)).sections.goalPlans.length,1);
});

test('all supported task definitions retain saved user inputs without provider availability or attachment reads',async()=>{
 const who=await actor(),conv=await conversation(who),steps:any[]=['image','video','speech','browser','cli','workflow','mcp'].map(kind=>({kind:'task',title:'Fictional '+kind,
  task:{kind,provider:kind==='mcp'?'mcp':'fictional-unavailable',prompt:'Fictional original '+kind,
   options:kind==='mcp'?{connectionId:randomUUID(),grantVersion:1,toolName:'fictional_lookup',schemaHash:'b'.repeat(64),arguments:{query:'Fictional original arguments'}}:
    kind==='workflow'?{steps:[{kind:'speech',provider:'fictional-unavailable',prompt:'Fictional nested prompt'}]}:
     kind==='browser'?{url:'https://fictional.example.invalid',actions:[]}:{fictionalUserOption:'saved-original-option'},
   ...(kind==='image'?{attachmentIds:[randomUUID()]}:{})}}));
 const draft={...definition(),steps},p=await plans.create(who.userId,conv,draft),result=await capture(who);
 const rows=result.sections.goalPlanSteps as any[];assert.deepEqual(rows.map(row=>row.input),JSON.parse(JSON.stringify(parseGoalPlanInput(draft).steps)));assert(rows.every(row=>row.planId===p.id&&row.resolvedTask===null&&row.receipt===null));
});

test('a concurrent actual draft update does not mix revisions into the export transaction snapshot',async()=>{
 const who=await actor(),conv=await conversation(who),p=await plans.create(who.userId,conv,definition());let changed=false,update:Promise<void>|undefined,updateError:unknown;
 const result=await new AccountCoreExport(instrument(async sql=>{if(!changed&&planRead(sql)){changed=true;update=plans.update(who.userId,p.id,{revision:1,...definition('Fictional concurrent edit')}).then(()=>{},error=>{updateError=error;});}}),f.config).capture(who,await proof(who));
 await update;assert.equal(updateError,undefined);assert(changed);assert.equal((result.sections.goalPlans[0] as any).currentRevision,1);assert.equal(result.sections.goalPlanRevisions.length,1);assert.equal((result.sections.goalPlanRevisions[0] as any).title,definition().title);
 assert.equal((await plans.get(who.userId,p.id)).revision,2);
});

test('artifact text, image and file provenance preserve original metadata and reject foreign upload ownership',async()=>{
 const who=await actor(),other=await actor(),conv=await conversation(who),sourceIds:string[]=[];
 for(const kind of ['artifact_text','reference_image','artifact_file']){
  const targetKind=kind==='reference_image'?'image':'cli',binding=kind==='artifact_text'?{prompt:{fromStep:0,source:'artifact_text',mode:'replace'}}:kind==='reference_image'?{referenceImages:[{fromStep:0}]}:{artifactFiles:[{fromStep:0}]};
  const draft={...definition(),steps:[{kind:'task',title:'Fictional source task',task:{kind:'speech',provider:'fictional',prompt:'Fictional source'}},
   {kind:'task',title:'Fictional target task',task:{kind:targetKind,provider:'fictional',prompt:'Fictional target'},bindings:binding}]},parsed=parseGoalPlanInput(draft),p=await plans.create(who.userId,conv,draft);
  const job=randomUUID(),artifact=randomUUID(),upload=randomUUID(),target=randomUUID(),completedAt=new Date().toISOString(),mime=kind==='reference_image'?'image/png':'text/plain';sourceIds.push(upload);
  for(const key of [job,target])await f.db.query("INSERT INTO platform_jobs(id,user_id,kind,provider,prompt,status) VALUES($1,$2,'speech','fictional','Fictional retained input','succeeded')",[key,who.userId]);
  await f.db.query("INSERT INTO platform_uploads(id,user_id,filename,mime,byte_size,storage_key) VALUES($1,$2,'fictional.txt',$3,7,$4)",[upload,who.userId,mime,'fictional-unread-private-path-'+upload]);
  await f.db.query("INSERT INTO platform_artifacts(id,user_id,job_id,kind,mime,filename,upload_id) VALUES($1,$2,$3,'speech',$4,'fictional.txt',$5)",[artifact,who.userId,job,mime,upload]);
  await f.db.query('UPDATE platform_goal_plan_steps SET job_id=$2,job_generation=1,bound_at=now(),receipt=$3 WHERE plan_id=$1 AND step_index=0',[p.id,job,JSON.stringify({kind:'task',jobId:job,generation:1,artifactIds:[artifact],completedAt})]);
  const source={source:kind,fromStep:0,jobId:job,generation:1,artifactId:artifact,mime,sha256:'c'.repeat(64),byteSize:7,
   ...(kind==='artifact_text'?{mode:'replace',artifactIndex:0}:kind==='reference_image'?{imageIndex:0,attachmentId:upload}:{artifactIndex:0,attachmentId:upload,name:'fictional.txt'})};
  await f.db.query('UPDATE platform_goal_plan_steps SET job_id=$2,job_generation=1,bound_at=now(),resolved_task=$3,input_sources=$4 WHERE plan_id=$1 AND step_index=1',[p.id,target,JSON.stringify((parsed.steps[1] as any).task),JSON.stringify([source])]);
 }
 const before=await snapshot(who),result=await capture(who),sources=(result.sections.goalPlanSteps as any[]).flatMap(r=>r.inputSources??[]);assert.equal(sources.length,3);assert.deepEqual(sources.map(s=>s.source).sort(),['artifact_file','artifact_text','reference_image']);assert.deepEqual(await snapshot(who),before);assert(!JSON.stringify(result).includes('fictional-unread-private-path'));
 const token=await proof(who);await f.db.query('UPDATE platform_uploads SET user_id=$2 WHERE id=$1',[sourceIds[0],other.userId]);
 await assert.rejects(new AccountCoreExport(f.db,f.config).capture(who,token),{code:'ACCOUNT_PLAN_EXPORT_UNAVAILABLE'});assert.equal(await consumed(who),null);
 await f.db.query('UPDATE platform_uploads SET user_id=$2 WHERE id=$1',[sourceIds[0],who.userId]);assert.equal((await new AccountCoreExport(f.db,f.config).capture(who,token)).sections.goalPlans.length,3);
});
