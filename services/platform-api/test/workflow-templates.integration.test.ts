import { PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PlatformProviderRuntime } from '@companion/platform-contracts';
import { buildApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { Database } from '../src/database.ts';
import { parseJob } from '../src/jobs.ts';
import { parseWorkflowTemplate, WORKFLOW_TEMPLATE_BYTES } from '../src/workflow-templates.ts';

const prefix='/api/platform',origin='http://localhost:4321',schema=`workflow_templates_test_${randomUUID().replaceAll('-','')}`;
const base=readConfig(),admin=new Database(base.databaseUrl),url=new URL(base.databaseUrl);url.searchParams.set('options',`-c search_path=${schema}`);
const db=new Database(url.toString());let directory:string,system:Awaited<ReturnType<typeof buildApp>>,actors=0;
const unused=async()=>{throw new Error('No model calls are permitted in template fixtures.');};
const runtime:PlatformProviderRuntime={capabilities:()=>[{id:'workflow',name:'Local workflow engine',enabled:true,keyConfigured:true,capabilities:['workflow'],models:[],envVariables:[]},{id:'local-fixture',name:'Synthetic text model',enabled:true,keyConfigured:true,capabilities:['chat'],models:['synthetic-text'],envVariables:[]}],streamChat:async function*(){throw new Error('Unused');},executeJob:unused,createVoiceSession:unused,transcribe:unused,speech:unused};
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await db.migrate();directory=await fs.mkdtemp(path.join(os.tmpdir(),'workflow-template-fixtures-'));system=await buildApp({db,config:{...base,databaseUrl:url.toString(),storageDir:directory},runtime,enableQueue:false});});
after(async()=>{await system?.app.close();await db.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();if(directory)await fs.rm(directory,{recursive:true,force:true});});
interface Actor{user:{id:string};cookie:string;ip:string;}
async function actor():Promise<Actor>{
  const ip=`127.0.2.${++actors}`;const response=await system.app.inject({method:'POST',url:prefix+'/auth/register',remoteAddress:ip,headers:{origin},payload:{name:'Fictional workflow designer',email:`workflow-${randomUUID()}@example.invalid`,password:'Fictional-password-123'}});assert.equal(response.statusCode,201,response.body);return {user:response.json().user,cookie:(response.headers['set-cookie'] as string).split(';')[0],ip};
}
async function request(user:Actor,method:'GET'|'POST'|'PUT'|'DELETE',route:string,payload?:Record<string,unknown>){return system.app.inject({method,url:prefix+route,remoteAddress:user.ip,headers:{origin,cookie:user.cookie, [PLATFORM_ACCOUNT_HEADER]: user.user.id},payload});}
function draft(overrides:Record<string,unknown>={}){return {name:'Fictional article workflow',description:'A saved plan, not an execution.',steps:[{kind:'chat',provider:'not-configured-yet',prompt:'Draft an article: {{input}}'},{kind:'speech',provider:'openai',prompt:'{{previous}}',options:{voice:'marin'}}],...overrides};}

test('saved workflow templates are owner-isolated and can use providers that are not configured',async()=>{
  const alice=await actor(),bob=await actor();const created=await request(alice,'POST','/workflow-templates',draft());assert.equal(created.statusCode,201,created.body);const template=created.json().template;
  assert.equal(template.revision,1);assert.equal(template.steps[0].provider,'not-configured-yet');assert.equal(template.name,'Fictional article workflow');
  assert.deepEqual((await request(alice,'GET','/workflow-templates')).json().templates,[template]);assert.deepEqual((await request(bob,'GET','/workflow-templates')).json().templates,[]);
  assert.equal((await request(bob,'PUT',`/workflow-templates/${template.id}`,{...draft(),revision:1})).statusCode,404);
  assert.equal((await request(bob,'DELETE',`/workflow-templates/${template.id}`)).statusCode,404);
  const csrf=await system.app.inject({method:'PUT',url:prefix+`/workflow-templates/${template.id}`,headers:{origin:'https://fictional-evil.invalid',cookie:alice.cookie, [PLATFORM_ACCOUNT_HEADER]: alice.user.id},payload:{...draft(),revision:1}});assert.equal(csrf.statusCode,403);
  const anonymous=await system.app.inject({method:'GET',url:prefix+'/workflow-templates'});assert.equal(anonymous.statusCode,401);
  const removed=await request(alice,'DELETE',`/workflow-templates/${template.id}`);assert.equal(removed.statusCode,200);assert.deepEqual((await request(alice,'GET','/workflow-templates')).json().templates,[]);
  assert((await db.query('SELECT deleted_at FROM platform_workflow_templates WHERE id=$1',[template.id])).rows[0].deleted_at);
  assert.equal((await request(alice,'PUT',`/workflow-templates/${template.id}`,{...draft(),revision:1})).statusCode,404);
});

test('optimistic revisions permit one concurrent update and preserve the accepted plan',async()=>{
  const user=await actor(),created=await request(user,'POST','/workflow-templates',draft()),id=created.json().template.id;
  const saved=await Promise.all(['First fictional revision','Second fictional revision'].map(name=>request(user,'PUT',`/workflow-templates/${id}`,{...draft({name}),revision:1})));
  assert.deepEqual(saved.map(response=>response.statusCode).sort(),[200,409]);assert.equal(saved.find(response=>response.statusCode===409)!.json().error.code,'WORKFLOW_TEMPLATE_REVISION_CONFLICT');
  const accepted=saved.find(response=>response.statusCode===200)!.json().template;assert.equal(accepted.revision,2);
  assert.deepEqual((await request(user,'GET','/workflow-templates')).json().templates,[accepted]);
  const next=await request(user,'PUT',`/workflow-templates/${id}`,{...draft({description:''}),revision:2});assert.equal(next.statusCode,200);assert.equal(next.json().template.revision,3);assert.equal(next.json().template.description,undefined);
});

test('templates reject credentials, unsupported fields and invalid plan boundaries before storing them',async()=>{
  const user=await actor();const step={kind:'image',provider:'fal',model:'fictional/image',prompt:'Draw {{input}}'};
  const cases=[draft({apiKey:'fictional-key'}),draft({steps:[]}),draft({steps:Array.from({length:9},()=>step)}),draft({name:'s'.repeat(101)}),draft({description:'s'.repeat(1001)}),draft({steps:[{...step,prompt:'s'.repeat(20001)}]}),draft({steps:[{...step,provider:'https://fictional-provider.invalid'}]}),draft({steps:[{...step,model:'s'.repeat(151)}]}),draft({steps:[{...step,kind:'cli'}]}),draft({steps:[{...step,headers:{authorization:'fictional-key'}}]}),draft({steps:[{...step,options:{actions:[{click:'submit'}]}}]}),draft({steps:[{...step,options:{input:{nested:{OPENAI_API_KEY:'fictional-key'}}}}]}),draft({steps:[{...step,options:{input:{nested:{base_url:'https://fictional-server.invalid'}}}}]})];
  for(const input of cases){const response=await request(user,'POST','/workflow-templates',input);assert.equal(response.statusCode,400,response.body);}
  const oversized=draft({steps:Array.from({length:8},()=>({...step,prompt:'s'.repeat(20000)}))});assert(Buffer.byteLength(JSON.stringify(oversized))>WORKFLOW_TEMPLATE_BYTES);assert.equal((await request(user,'POST','/workflow-templates',oversized)).statusCode,413);
  assert.deepEqual((await request(user,'GET','/workflow-templates')).json().templates,[]);
  const valid=draft({steps:[{...step,options:{input:{num_images:1,extra:{style:'fictional'}}}},{kind:'video',provider:'ark',prompt:'Animate {{input}}',options:{duration:5,seed:42,resolution:'720p',aspectRatio:'16:9'}}]});assert.equal((await request(user,'POST','/workflow-templates',valid)).statusCode,201);
});

test('active-template capacity remains atomic under concurrent creation and deletion frees capacity',async()=>{
  const user=await actor();await db.query("INSERT INTO platform_workflow_templates(id,user_id,name,steps) SELECT gen_random_uuid(),$1,'Fictional seeded plan',$2 FROM generate_series(1,99)",[user.user.id,JSON.stringify(draft().steps)]);
  const results=await Promise.all([request(user,'POST','/workflow-templates',draft()),request(user,'POST','/workflow-templates',draft())]);assert.deepEqual(results.map(response=>response.statusCode).sort(),[201,413]);
  const created=results.find(response=>response.statusCode===201)!.json().template;assert.equal((await request(user,'GET','/workflow-templates')).json().templates.length,100);
  await request(user,'DELETE',`/workflow-templates/${created.id}`);assert.equal((await request(user,'POST','/workflow-templates',draft())).statusCode,201);
});

test('image references reject duplicate selections and invalid provider bindings before saving',async()=>{
  const user=await actor(),source={kind:'image',provider:'openai',prompt:'Create fictional source images'},target={kind:'video',provider:'ark',prompt:'Animate fictional references'};
  for(const step of [
    {...target,referenceImages:[{fromStep:0},{fromStep:0,imageIndex:0}]},
    {...target,referenceImages:[{fromStep:0}],options:{referenceMode:'first_last_frame'}},
    {...target,referenceImages:[{fromStep:0},{fromStep:0,imageIndex:1}],options:{referenceMode:'first_frame'}},
    {...target,provider:'fal',referenceImages:[{fromStep:0},{fromStep:0,imageIndex:1}],options:{referenceField:'image_url'}},
    {...target,provider:'comfyui',referenceImages:[{fromStep:0}]},
    {...target,options:{resolution:['720p']}},
  ])assert.equal((await request(user,'POST','/workflow-templates',draft({steps:[source,step]}))).statusCode,400);
  assert.deepEqual((await request(user,'GET','/workflow-templates')).json().templates,[]);
  const refs=[{fromStep:0},{fromStep:0,imageIndex:1}],saved=await request(user,'POST','/workflow-templates',draft({steps:[source,{...target,referenceImages:refs,options:{referenceMode:'first_last_frame'}}]}));
  assert.equal(saved.statusCode,201,saved.body);assert.deepEqual(saved.json().template.steps[1].referenceImages,refs);
});

test('saved bounded plans larger than the old options limit can be reviewed as fixed job snapshots',async()=>{
  const user=await actor(),input=draft({steps:Array.from({length:3},()=>({kind:'chat',provider:'local-fixture',model:'synthetic-text',prompt:'s'.repeat(15000)}))});const template=(await request(user,'POST','/workflow-templates',input)).json().template;
  assert(Buffer.byteLength(JSON.stringify({steps:template.steps}))>20000);
  const job=await request(user,'POST','/jobs',{kind:'workflow',provider:'workflow',prompt:'Fictional input',options:{steps:template.steps}});assert.equal(job.statusCode,201,job.body);assert.equal(job.json().job.status,'needs_approval');assert.deepEqual(job.json().approval.args.options.steps,template.steps);
  await request(user,'PUT',`/workflow-templates/${template.id}`,{...draft(),revision:1});const stored=(await request(user,'GET',`/jobs/${job.json().job.id}`)).json().job;assert.deepEqual(stored.options.steps,template.steps);
  assert.throws(()=>parseJob({kind:'image',provider:'openai',prompt:'Synthetic image',options:{input:'s'.repeat(20001)}}));
  assert.throws(()=>parseWorkflowTemplate({...draft(),revision:1}));assert.throws(()=>parseWorkflowTemplate(draft(),true));
});
