import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CLI_INPUT_MAX_FILE_BYTES, CLI_INPUT_MAX_TOTAL_BYTES } from '@companion/platform-contracts';
import { parseGoalPlanInput } from '../src/goal-plans.ts';
import { goalPlanInputDiagnostic } from '../src/goal-plan-input-diagnostics.ts';
import { parseGoalPlanTaskBindings, readGoalPlanFile, readGoalPlanSourceFile, resolveGoalPlanInputs, verifyGoalPlanInputSources } from '../src/goal-plan-inputs.ts';
import { LocalBlobStorage } from '../src/storage.ts';

const task=(kind='cli'):any=>({kind:'task',title:'Fictional task',task:{kind,provider:kind==='cli'?'cli':'synthetic',prompt:'Use the reviewed fictional files.'}});
const draft=(steps:any[])=>({title:'Fictional file plan',goal:'Combine fictional materials.',steps});
test('file bindings allow only earlier ordinary task files for CLI and never accept caller identities',()=>{
  const valid={artifactFiles:[{fromStep:0},{fromStep:0,artifactIndex:2}]};
  assert.deepEqual(parseGoalPlanTaskBindings(valid),valid);
  for(const binding of [{artifactFiles:[]},{artifactFiles:[{fromStep:0},{fromStep:0,artifactIndex:0}]},{artifactFiles:[{fromStep:0,artifactIndex:64}]},
    {artifactFiles:[{fromStep:0,artifactId:randomUUID()}]},{artifactFiles:[{fromStep:'0'}]},{artifactFiles:Array.from({length:5},(_,artifactIndex)=>({fromStep:0,artifactIndex}))}]) assert.throws(()=>parseGoalPlanTaskBindings(binding),{code:'INVALID_INPUT'});
  for(const kind of ['image','video','speech','workflow']) assert.throws(()=>parseGoalPlanInput(draft([task(),{...task(kind),bindings:valid}])));
  for(const kind of ['browser','mcp']) assert.throws(()=>parseGoalPlanInput(draft([task(kind),{...task(),bindings:valid}])));
  assert.throws(()=>parseGoalPlanInput(draft([task(),{...task(),bindings:{artifactFiles:[{fromStep:1}]}}])));
  const target=task();target.task.attachmentIds=Array.from({length:3},()=>randomUUID());target.bindings=valid;
  assert.throws(()=>parseGoalPlanInput(draft([task(),target])),{code:'INVALID_INPUT'});
});
test('file binding failures expose only bounded code-owned repair paths',()=>{
  const input=draft([task(),{...task(),bindings:{artifactFiles:[{fromStep:0,artifactIndex:64}]}}]);
  let error:unknown;try{parseGoalPlanInput(input);}catch(caught){error=caught;}
  assert.deepEqual(goalPlanInputDiagnostic(error),{path:'steps[1].bindings.artifactFiles[0].artifactIndex',reason:'out_of_range',expected:'integer_0_63'});
  input.steps[1].bindings.artifactFiles=[{fromStep:1}];try{parseGoalPlanInput(input);}catch(caught){error=caught;}
  assert.deepEqual(goalPlanInputDiagnostic(error),{path:'steps[1].bindings.artifactFiles[0].fromStep',reason:'out_of_range',expected:'earlier_step_index'});
});

async function fixture(run:(context:any)=>Promise<void>) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'goal-file-input-')),storage=new LocalBlobStorage(directory);
  const userId=randomUUID(),jobId=randomUUID(),artifactId=randomUUID(),attachmentId=randomUUID(),key=randomUUID(),bytes=Buffer.from([0,1,2,3,254,255]);
  const saved:any={job_id:jobId,mime:'video/mp4',filename:'fictional.mp4',upload_id:attachmentId,upload_mime:'video/mp4',upload_filename:'fictional.mp4',byte_size:bytes.length,job_kind:'video',generation:1,status:'succeeded'};
  const upload:any={id:attachmentId,filename:saved.filename,mime:saved.mime,byte_size:bytes.length,storage_key:key};
  const db:any={query:async(sql:string,args:any[])=>({rowCount:1,rows:args[1]!==userId?[]:sql.includes('JOIN platform_jobs')?(args[0]===artifactId?[saved]:[]):args[0]===attachmentId?[upload]:[]})};
  const row={receipt:{kind:'task',jobId,generation:1,artifactIds:[randomUUID(),artifactId]},artifacts:[{id:artifactId,mime:saved.mime}]};
  try{await storage.put(key,bytes);await run({directory,storage,userId,jobId,artifactId,attachmentId,key,bytes,saved,upload,db,row});}
  finally{await fs.rm(directory,{recursive:true,force:true});}
}
test('file indexes use the full exact receipt order and a missing artifact never remaps an index',async()=>fixture(async context=>{
  const {db,storage,userId,row,artifactId,attachmentId,bytes}=context;
  const target={...task(),bindings:{artifactFiles:[{fromStep:0,artifactIndex:1}]}};
  const resolved=await resolveGoalPlanInputs(db,storage,userId,target,[row]);
  assert.deepEqual(resolved.input.attachmentIds,[attachmentId]);assert.equal(resolved.inputSources[0].source,'artifact_file');
  assert.equal((resolved.inputSources[0] as any).artifactId,artifactId);assert.equal((resolved.inputSources[0] as any).artifactIndex,1);
  assert.equal(resolved.inputSources[0].sha256,createHash('sha256').update(bytes).digest('hex'));
  await assert.rejects(resolveGoalPlanInputs(db,storage,userId,{...task(),bindings:{artifactFiles:[{fromStep:0}]}},[row]),{code:'GOAL_PLAN_BLOCKED'});
  await assert.rejects(resolveGoalPlanInputs(db,storage,randomUUID(),target,[row]),{code:'GOAL_PLAN_BLOCKED'});
  context.saved.generation=2;await assert.rejects(resolveGoalPlanInputs(db,storage,userId,target,[row]),{code:'GOAL_PLAN_BLOCKED'});
}));
test('saved binary inputs pin name, MIME and SHA and reject changes before each execution read',async()=>fixture(async context=>{
  const {db,storage,userId,row,upload,attachmentId,key,directory}=context;
  const resolved=await resolveGoalPlanInputs(db,storage,userId,{...task(),bindings:{artifactFiles:[{fromStep:0,artifactIndex:1}]}},[row]),source:any=resolved.inputSources[0];
  assert.deepEqual(await readGoalPlanSourceFile(db,storage,userId,source),await readGoalPlanFile(db,storage,userId,attachmentId));
  const job={user_id:userId,attachment_ids:[attachmentId],execution_policy:{goalPlanInput:{inputSources:[source]}}};
  await verifyGoalPlanInputSources(db,storage,job);
  await assert.rejects(verifyGoalPlanInputSources(db,storage,{...job,attachment_ids:[]}),{code:'GOAL_PLAN_INPUT_CHANGED'});
  upload.filename='renamed.mp4';await assert.rejects(readGoalPlanSourceFile(db,storage,userId,source),{code:'GOAL_PLAN_INPUT_CHANGED'});upload.filename=source.name;
  await fs.writeFile(path.join(directory,key),Buffer.from([0,1,2,3,254,253]));
  await assert.rejects(readGoalPlanSourceFile(db,storage,userId,source),{code:'GOAL_PLAN_INPUT_CHANGED'});
  const abort=new AbortController();abort.abort();await assert.rejects(readGoalPlanFile(db,storage,userId,attachmentId,abort.signal),{name:'AbortError'});
}));
test('file limits reject oversized metadata before storage reads and count static plus bound bytes',async()=>fixture(async context=>{
  const {db,storage,userId,row,saved,upload,attachmentId}=context;
  upload.byte_size=CLI_INPUT_MAX_FILE_BYTES+1;await assert.rejects(readGoalPlanFile(db,{} as any,userId,attachmentId),{code:'GOAL_PLAN_BLOCKED'});upload.byte_size=6;
  const target={...task(),task:{...task().task,attachmentIds:[attachmentId,randomUUID()]},bindings:{artifactFiles:[{fromStep:0,artifactIndex:1}]}};
  const mock:any={query:async(sql:string,args:any[])=>sql.startsWith('SELECT byte_size')?{rows:[{byte_size:CLI_INPUT_MAX_FILE_BYTES}]}:db.query(sql,args)};
  assert.equal(CLI_INPUT_MAX_TOTAL_BYTES,2*CLI_INPUT_MAX_FILE_BYTES);
  await assert.rejects(resolveGoalPlanInputs(mock,{} as any,userId,target,[row]),{code:'GOAL_PLAN_BLOCKED'});
  saved.upload_mime='audio/wav';await assert.rejects(resolveGoalPlanInputs(db,storage,userId,{...task(),bindings:{artifactFiles:[{fromStep:0,artifactIndex:1}]}},[row]),{code:'GOAL_PLAN_BLOCKED'});
}));
test('duplicate private uploads from static and bound sources cannot produce a frozen task',async()=>fixture(async({db,storage,userId,row,attachmentId})=>{
  await assert.rejects(resolveGoalPlanInputs(db,storage,userId,{...task(),task:{...task().task,attachmentIds:[attachmentId]},bindings:{artifactFiles:[{fromStep:0,artifactIndex:1}]}},[row]),{code:'INVALID_INPUT'});
}));
