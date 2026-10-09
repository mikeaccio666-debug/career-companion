import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,readdir,rm,realpath,stat,chmod,symlink } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runLiveLunaPilot,lunaPilotRuntime,LIVE_PILOT_PRICE } from '../evals/live-pilot.ts';
import { evalLiveCommand } from '../evals/live-main.ts';
import { createEvalJournal,type EvalRunManifest } from '../evals/journal.ts';
import { createEvalStudyPlan } from '../evals/study-plan.ts';
const now=()=>new Date('2026-10-09T05:00:00.000Z');
const key='fictional-eval-private-key';
async function fixture(runId='fictional-run'){
 const root=await realpath(await mkdtemp(join(os.tmpdir(),'career-eval-fixture-')));
 return {root,runId,env:{CAREER_EVAL_ALLOW_PAID_CALLS:'1',CAREER_EVAL_OPENAI_API_KEY:key,CAREER_EVAL_RESULTS_DIR:root,
  OPENAI_CHAT_MODEL:'forbidden-more-expensive-model',OPENAI_BASE_URL:'https://example.invalid',PLATFORM_ALLOW_PROVIDER_CALLS:'0',ANTHROPIC_API_KEY:'fictional-unused-secret'},
  close:()=>rm(root,{recursive:true,force:true})};
}
async function records(root:string,runId:string){
 const directory=join(root,runId),files=(await readdir(directory)).sort();
 return Promise.all(files.map(async name=>({name,value:JSON.parse(await readFile(join(directory,name),'utf8'))})));
}
const response=(missingUsage=false)=>new Response([
 {type:'response.output_text.delta',delta:'Fictional private output; never log this.'},
 {type:'response.completed',response:{status:'completed',service_tier:'default',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Fictional private output; never log this.'}]}],
  ...(missingUsage?{}:{usage:{input_tokens:100,output_tokens:30,input_tokens_details:{cached_tokens:0}}})}},
].map(x=>'data: '+JSON.stringify(x)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});

test('real Luna adapter executes the fixed 12 scripts only after durable reservation and saves private content-free records in order',async()=>{
 const f=await fixture();let calls=0;
 try{
  const result=await runLiveLunaPilot(f,{now,runtimeFactory:k=>lunaPilotRuntime(k,async(url,init)=>{
   calls++;assert.equal(String(url),'https://api.openai.com/v1/responses');assert.equal(k,key);
   const request=JSON.parse(init!.body as string);assert.equal(request.model,'gpt-6-luna');assert.equal(request.service_tier,'default');
   assert.equal(request.store,false);assert.deepEqual(request.tools,[]);assert.equal(request.max_output_tokens,2048);assert.equal(init!.redirect,'error');
   assert.equal(new Headers(init!.headers).get('Authorization'),'Bearer '+key);
   const prior=await records(f.root,f.runId);assert.equal(prior.at(-1)!.value.type,'started_reserve');
   assert.equal(prior.filter(x=>x.name.includes('-result')).length,calls-1);
   // Every prior record is readable before this request can launch.
   for(const file of prior)assert.equal((await stat(join(f.root,f.runId,file.name))).mode&0o077,0);
   return response();
  })});
  assert.equal(calls,12);assert.equal(result.status,'completed');assert.equal(result.completedCases,12);
  assert.equal(result.budget.actualSpentMicroUsd,576);assert.equal(result.budget.pendingReservedMicroUsd,0);
  assert.equal(result.productGate,'not_evaluated');assert.equal(result.qualityStatus,'not_scored');
  const saved=await records(f.root,f.runId);assert.equal(saved.length,50);assert(saved[0]!.name.includes('manifest'));assert(saved.at(-1)!.name.includes('report'));
  assert.equal((await stat(join(f.root,f.runId))).mode&0o077,0);
  const text=JSON.stringify(saved);for(const secret of [key,'fictional-unused-secret','Fictional private output; never log this.','forbidden-more-expensive-model','Authorization','messages','persona'])assert(!text.includes(secret));
 }finally{await f.close();}
});

test('unknown usage or HTTP failure stops after one actual request, retaining its durable full reservation',async()=>{
 for(const failure of ['missing','http'] as const){const f=await fixture();let calls=0;
  try{
   const report=await runLiveLunaPilot(f,{now,runtimeFactory:k=>lunaPilotRuntime(k,async()=>{calls++;return failure==='missing'?response(true):new Response('fictional-provider-private-error',{status:429});})});
   assert.equal(calls,1);assert.equal(report.status,'stopped');assert.equal(report.completedCases,0);assert.equal(report.budget.actualSpentMicroUsd,0);
   assert.equal(report.budget.pendingReservedMicroUsd,232036);assert.equal(report.budget.uncertainCalls,1);
   const saved=await records(f.root,f.runId);assert(saved.some(x=>x.value.type==='finished_uncertain'));assert(!JSON.stringify(saved).includes('fictional-provider-private-error'));
  }finally{await f.close();}
 }
});

test('same run cannot be started twice or concurrently and an incomplete directory is never reused',async()=>{
 const f=await fixture();let calls=0;
 const dependencies={now,runtimeFactory:(k:string)=>lunaPilotRuntime(k,async()=>{calls++;return response();})};
 try{
  const outcomes=await Promise.allSettled([runLiveLunaPilot(f,dependencies),runLiveLunaPilot(f,dependencies)]);
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(calls,12);
  await assert.rejects(runLiveLunaPilot(f,dependencies),{code:'EVAL_JOURNAL_UNAVAILABLE'});assert.equal(calls,12);
 }finally{await f.close();}
});

test('disk failure after dispatch cannot refund the reservation, retry the request or fabricate a successful report',async()=>{
 const f=await fixture();let calls=0;
 try{
  await assert.rejects(runLiveLunaPilot(f,{now,runtimeFactory:k=>lunaPilotRuntime(k,async()=>{
   calls++;await chmod(join(f.root,f.runId),0o500);return response();
  })}),{code:'EVAL_JOURNAL_UNAVAILABLE'});
  assert.equal(calls,1);await chmod(join(f.root,f.runId),0o700);
  const saved=await records(f.root,f.runId);assert.equal(saved.length,2);assert.equal(saved[1]!.value.type,'started_reserve');assert.equal(saved[1]!.value.reservedMicroUsd,232036);
  await assert.rejects(runLiveLunaPilot(f,{now}),{code:'EVAL_JOURNAL_UNAVAILABLE'});
 }finally{await chmod(join(f.root,f.runId),0o700).catch(()=>{});await f.close();}
});

test('cancellation interrupts the actual transport, retains uncertain billing and does not launch a second script',async()=>{
 const f=await fixture(),controller=new AbortController();let calls=0;
 try{
  const report=await runLiveLunaPilot({...f,signal:controller.signal},{now,runtimeFactory:k=>lunaPilotRuntime(k,async(_url,init)=>{
   calls++;controller.abort();throw new Error('fictional-aborted-private-error');
  })});
  assert.equal(calls,1);assert.equal(report.status,'stopped');assert.equal(report.stopReason,'cancelled');assert.equal(report.budget.pendingReservedMicroUsd,232036);
  assert(!JSON.stringify(await records(f.root,f.runId)).includes('fictional-aborted-private-error'));
 }finally{await f.close();}
});

test('invalid switches, absent private key, expired tariff and unsafe output root all fail before constructing a runtime',async()=>{
 const f=await fixture();let constructed=0;const dependencies={now,runtimeFactory:()=>{constructed++;throw new Error('must not construct');}};
 try{
  for(const env of [{...f.env,CAREER_EVAL_ALLOW_PAID_CALLS:'0'},{...f.env,CAREER_EVAL_OPENAI_API_KEY:''}])await assert.rejects(runLiveLunaPilot({...f,env},dependencies));
  await assert.rejects(runLiveLunaPilot(f,{...dependencies,now:()=>new Date(LIVE_PILOT_PRICE.expiresAt)}),{code:'EVAL_PRICE_UNCONFIRMED'});
  assert.deepEqual(await readdir(f.root),[]);
  await chmod(f.root,0o755);await assert.rejects(runLiveLunaPilot(f,dependencies),{code:'EVAL_JOURNAL_UNAVAILABLE'});await chmod(f.root,0o700);
  const link=join(f.root,'link');await symlink(f.root,link);await assert.rejects(runLiveLunaPilot({...f,env:{...f.env,CAREER_EVAL_RESULTS_DIR:link}},dependencies),{code:'EVAL_JOURNAL_UNAVAILABLE'});
  assert.equal(constructed,0);
  const env=new Proxy({}, {get(){throw new Error('Must not inspect credentials for invalid arguments');}});
  for(const args of [[],['--live','anthropic-opus','--run-id','test'],['--live','openai-luna','--run-id','../secret'],['--live','openai-luna','--run-id','ok','--model','gpt-6-astra']])
   assert.deepEqual(await evalLiveCommand(args,env),{exitCode:2,result:{status:'rejected',code:'EVAL_LIVE_ARGUMENTS_INVALID'}});
 }finally{await chmod(f.root,0o700);await f.close();}
});

test('journal rejects accidental content fields and refuses all later writes rather than logging private input',async()=>{
 const f=await fixture(),study=createEvalStudyPlan();
 const manifest:EvalRunManifest={schemaVersion:1,scope:'isolated_provider_loop_pilot',runId:f.runId,studyDigest:study.digest,promptDigest:study.promptDigest,corpusDigest:study.corpusDigest,
  provider:'openai',model:'gpt-6-luna',serviceTier:'default',capMicroUsd:1000000,priceSnapshotId:LIVE_PILOT_PRICE.id,createdAt:now().toISOString(),pilotCaseIds:study.pilotCaseIds,productGate:'not_evaluated',qualityStatus:'not_scored'};
 try{
  const journal=await createEvalJournal(f.root,manifest);
  await assert.rejects(journal.persistLedger({type:'batch_stopped',runId:f.runId,reason:'cancelled',atMs:now().getTime(),body:'fictional private message'} as any),{code:'EVAL_JOURNAL_UNAVAILABLE'});
  await assert.rejects(journal.persistLedger({type:'batch_stopped',runId:f.runId,reason:'cancelled',atMs:now().getTime()}),{code:'EVAL_JOURNAL_UNAVAILABLE'});
  const saved=await records(f.root,f.runId);assert.equal(saved.length,1);assert(!JSON.stringify(saved).includes('fictional private message'));
 }finally{await f.close();}
});

test('actual CLI requires its own opt-in even when the main app commercial flag and other credentials are set',async()=>{
 const cli=fileURLToPath(new URL('../evals/live-main.ts',import.meta.url));
 const result=spawnSync(process.execPath,['--import','tsx',cli,'--live','openai-luna','--run-id','fictional-cli'],{
  encoding:'utf8',timeout:10000,env:{...process.env,PLATFORM_ALLOW_PROVIDER_CALLS:'1',OPENAI_API_KEY:key,CAREER_EVAL_ALLOW_PAID_CALLS:'0'},
 });
 assert.equal(result.status,1);assert.deepEqual(JSON.parse(result.stdout),{status:'stopped',code:'EVAL_LIVE_DISABLED'});
 assert(!result.stdout.includes(key));assert.equal(result.stderr,'');
});
