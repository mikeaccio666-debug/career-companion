import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { GoalPlans, parseGoalPlanInput } from '../src/goal-plans.ts';
import { assertGoalPlanImageBytes, boundPrompt, parseGoalPlanTaskBindings, readGoalPlanImage, resolveGoalPlanInputs } from '../src/goal-plan-inputs.ts';
import { LocalBlobStorage } from '../src/storage.ts';
import { readFullArtifactText } from '../src/artifact-text.ts';
import { GOAL_PLAN_MAX_BYTES } from '@companion/platform-contracts';

const task=(kind='cli'):any=>({kind:'task',title:'Fictional task',task:{kind,provider:kind==='cli'?'cli':'openai',prompt:'Base fictional instruction',options:{}}});
const analysis:any={kind:'agent_turn',title:'Fictional analysis',instruction:'Compare fictional evidence',provider:'synthetic'};
const plan=(steps:any[])=>({title:'Fictional plan',goal:'Fictional outcome',steps});
test('binding source and mode require string literals instead of coercible arrays',()=>{
  for(const source of [['analysis_text'],['artifact_text'],{toString:()=> 'analysis_text'},null,1])assert.throws(()=>parseGoalPlanTaskBindings({prompt:{fromStep:0,source,mode:'replace'}}),{code:'INVALID_INPUT'});
  for(const mode of [['append'],['replace'],{toString:()=> 'replace'},null,1])assert.throws(()=>parseGoalPlanTaskBindings({prompt:{fromStep:0,source:'artifact_text',mode}}),{code:'INVALID_INPUT'});
});
test('plan state rejects coercible non-string statuses before starting a transaction',async()=>{
  const service=new GoalPlans({transaction:()=>{assert.fail('An invalid state must not access the database.');}} as any,{} as any,{} as any);
  for(const status of [['active'],['paused'],['cancelled'],{toString:()=> 'active'},null,1])await assert.rejects(service.state(randomUUID(),randomUUID(),{revision:1,status}),{code:'INVALID_INPUT'});
});
test('a valid near-limit draft must be revalidated after frozen model defaults enlarge its definition',()=>{
  const input=plan(Array.from({length:4},()=>({...task('image'),task:{kind:'image',provider:'openai',prompt:'中'.repeat(16_000),options:{}}})));
  const parsed=parseGoalPlanInput(input),size=Buffer.byteLength(JSON.stringify(parsed),'utf8');let remaining=GOAL_PLAN_MAX_BYTES-10-size;
  for(const step of input.steps){const count=Math.min(4000,remaining);step.task.prompt+='x'.repeat(count);remaining-=count;}assert.equal(remaining,0);
  const draft=parseGoalPlanInput(input);assert.equal(Buffer.byteLength(JSON.stringify(draft),'utf8'),GOAL_PLAN_MAX_BYTES-10);
  const steps=draft.steps.map(step=>step.kind==='task'?{...step,task:{...step.task,model:'fictional-image'}}:step);
  assert.throws(()=>parseGoalPlanInput({...draft,steps}),{code:'GOAL_PLAN_INPUT_LIMIT'});
});
test('bindings reject arbitrary identities, forward indexes, duplicate image indexes and unsupported prompt semantics',()=>{
  for(const bindings of [{prompt:{fromStep:0,source:'analysis_text',mode:'replace',messageId:randomUUID()}},{prompt:{fromStep:0,source:'analysis_text',mode:'replace',artifactIndex:0}},
    {referenceImages:[{fromStep:0},{fromStep:0,imageIndex:0}]},{referenceImages:[{fromStep:0,imageIndex:64}]},{referenceImages:[]},{}])assert.throws(()=>parseGoalPlanTaskBindings(bindings));
  for(const fromStep of [-1,1,2])assert.throws(()=>parseGoalPlanInput(plan([analysis,{...task(),bindings:{prompt:{fromStep,source:'analysis_text',mode:'replace'}}}])));
  for(const kind of ['workflow','browser','mcp'])assert.throws(()=>parseGoalPlanInput(plan([analysis,{...task(kind),bindings:{prompt:{fromStep:0,source:'analysis_text',mode:'replace'}}}])));
  for(const sourceKind of ['browser','mcp'])assert.throws(()=>parseGoalPlanInput(plan([task(sourceKind),{...task(),bindings:{prompt:{fromStep:0,source:'artifact_text',mode:'append'}}}])));
  assert.throws(()=>parseGoalPlanInput(plan([task(),{...task('image'),task:{...task('image').task,attachmentIds:Array.from({length:4},()=>randomUUID())},bindings:{referenceImages:[{fromStep:0}]}}])));
  assert.deepEqual(parseGoalPlanInput(plan([analysis,{...task(),bindings:{prompt:{fromStep:0,source:'analysis_text',mode:'replace'}}}])).steps[1],{...task(),task:{...task().task,attachmentIds:[],model:undefined},bindings:{prompt:{fromStep:0,source:'analysis_text',mode:'replace'}}});
});
test('full prompt binding preserves Unicode and boundary content, never silently truncates',()=>{
  const source=' \n中文🙂\n ';
  assert.equal(boundPrompt('Base',source,'replace'),source);assert.equal(boundPrompt('Base',source,'append'),'Base\n\n'+source);
  assert.equal(boundPrompt('Base','x'.repeat(20_000),'replace').length,20_000);
  assert.throws(()=>boundPrompt('Base','x'.repeat(20_001),'replace'),{code:'GOAL_PLAN_SOURCE_TOO_LARGE'});
  assert.throws(()=>boundPrompt('Base',' '.repeat(4),'replace'),{code:'GOAL_PLAN_SOURCE_TOO_LARGE'});
});
test('analysis binding uses the bound successful message and preserves full text',async()=>{
  const messageId=randomUUID(),text='Fictional\n中文🙂\nEvidence';
  const source={receipt:{kind:'agent_turn',messageId},message:{id:messageId,status:'complete',content:text}};
  const step={...task('speech'),bindings:{prompt:{fromStep:0,source:'analysis_text',mode:'append'}}};
  const result=await resolveGoalPlanInputs({} as PoolClient,{} as LocalBlobStorage,randomUUID(),step,[source]);
  assert.equal(result.input.prompt,'Base fictional instruction\n\n'+text);assert.equal(result.inputSources[0].sha256,createHash('sha256').update(text).digest('hex'));
  assert.equal(result.inputSources[0].byteSize,Buffer.byteLength(text));
  await assert.rejects(resolveGoalPlanInputs({} as PoolClient,{} as LocalBlobStorage,randomUUID(),step,[{...source,message:{...source.message,id:randomUUID()}}]),{code:'GOAL_PLAN_BLOCKED'});
});
test('whole artifact reader and binding keep content past the 16KiB public page in receipt order',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'goal-input-whole-'));const storage=new LocalBlobStorage(directory);
  try{
    const userId=randomUUID(),jobId=randomUUID(),firstId=randomUUID(),lastId=randomUUID(),key=randomUUID(),text='X'.repeat(17_000)+'中文🙂END';
    await storage.put(key,Buffer.from(text));
    const db={query:async(sql:string)=>({rows:sql.startsWith('SELECT a.id FROM')?[]:[{id:firstId,job_id:jobId,filename:'fictional.txt',mime:'text/plain',upload_mime:'text/plain',byte_size:Buffer.byteLength(text),storage_key:key,job_kind:'cli'}],rowCount:1})} as unknown as PoolClient;
    const row={receipt:{kind:'task',jobId,generation:1,artifactIds:[firstId,lastId]},artifacts:[{id:lastId,mime:'text/plain'},{id:firstId,mime:'text/plain'}]};
    const step={...task(),bindings:{prompt:{fromStep:0,source:'artifact_text',mode:'replace'}}};
    const full=await readFullArtifactText(db,storage,userId,firstId);assert.equal(full.text,text);
    const result=await resolveGoalPlanInputs(db,storage,userId,step,[row]);assert.equal(result.input.prompt,text);assert.equal((result.inputSources[0] as any).artifactId,firstId);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('whole artifact reader preserves binary, invalid UTF8 and dedicated source exclusions',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'goal-input-invalid-'));const storage=new LocalBlobStorage(directory);
  try{
    for(const [bytes,kind,code] of [[Buffer.from([0xff,0xfe]),'cli','ARTIFACT_TEXT_INVALID'],[Buffer.from('%PDF-1.7'),'cli','ARTIFACT_TEXT_INVALID'],[Buffer.from('fictional'),'browser','ARTIFACT_TEXT_UNSUPPORTED'],[Buffer.from('fictional'),'mcp','ARTIFACT_TEXT_UNSUPPORTED']] as const){
      const key=randomUUID();await storage.put(key,bytes);const db={query:async()=>({rowCount:1,rows:[{id:randomUUID(),job_id:randomUUID(),filename:'fictional.txt',mime:'text/plain',upload_mime:'text/plain',byte_size:bytes.length,storage_key:key,job_kind:kind}]})} as unknown as PoolClient;
      await assert.rejects(readFullArtifactText(db,storage,randomUUID(),randomUUID()),{code});
    }
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('strong image read and frozen SHA reject same-size valid PNG replacement',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'goal-input-image-'));const storage=new LocalBlobStorage(directory);
  try{
    const key=randomUUID(),attachmentId=randomUUID(),bytes=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);await storage.put(key,bytes);
    const db={query:async()=>({rowCount:1,rows:[{id:attachmentId,filename:'fictional.png',mime:'image/png',byte_size:bytes.length,storage_key:key}]})} as unknown as PoolClient;
    const image=await readGoalPlanImage(db,storage,randomUUID(),attachmentId);
    const source:any={source:'reference_image',fromStep:0,imageIndex:0,jobId:randomUUID(),generation:1,artifactId:randomUUID(),attachmentId,mime:'image/png',byteSize:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
    assertGoalPlanImageBytes(source,image);const changed=Buffer.from(bytes);changed[11]=1;await fs.writeFile(path.join(directory,key),changed);
    await assert.rejects(readGoalPlanImage(db,storage,randomUUID(),attachmentId).then(image=>assertGoalPlanImageBytes(source,image)),{code:'GOAL_PLAN_INPUT_CHANGED'});
    const abort=new AbortController();abort.abort();await assert.rejects(readGoalPlanImage(db,storage,randomUUID(),attachmentId,abort.signal),{name:'AbortError'});
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
