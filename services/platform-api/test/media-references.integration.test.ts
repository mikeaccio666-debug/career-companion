import { PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CreateJobInput } from '@companion/platform-contracts';
import { createProviderRuntime } from '@companion/ai-core';
import { buildApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { Database } from '../src/database.ts';
import { parseJob, processJob } from '../src/jobs.ts';
import { LocalBlobStorage } from '../src/storage.ts';
import { REFERENCE_IMAGE_BYTES } from '../src/media-references.ts';

const prefix='/api/platform',origin='http://localhost:4321',schema=`media_refs_test_${randomUUID().replaceAll('-','')}`,base=readConfig(),admin=new Database(base.databaseUrl),url=new URL(base.databaseUrl);url.searchParams.set('options',`-c search_path=${schema}`);
const db=new Database(url.toString()),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
let directory:string,storage:LocalBlobStorage,system:Awaited<ReturnType<typeof buildApp>>,actors=0,imageRequests:{url:string;prompt:string;referenceBytes?:Uint8Array}[]=[],sourceArtifactId='',agentAttachmentId='',agentCreatedId='',agentTurn=0,agentMode:'chain'|'foreign'|'nonimage'='chain';
const transport=(async(value:any,init:RequestInit={})=>{
  const target=String(value);
  if(target.endsWith('/images/generations')){const body=JSON.parse(String(init.body));imageRequests.push({url:target,prompt:body.prompt});return Response.json({data:[{b64_json:png.toString('base64')}]});}
  if(target.endsWith('/images/edits')){assert(init.body instanceof FormData);const images=init.body.getAll('image[]');assert.equal(images.length,1);assert(images[0] instanceof Blob);imageRequests.push({url:target,prompt:String(init.body.get('prompt')),referenceBytes:new Uint8Array(await images[0].arrayBuffer())});return Response.json({data:[{b64_json:png.toString('base64')}]});}
  if(target.endsWith('/responses')){
    const body=JSON.parse(String(init.body));agentTurn++;const tool=body.tools.find((tool:any)=>tool.name==='create_job');assert.equal(tool.parameters.properties.attachmentIds.maxItems,10);assert.equal(tool.parameters.properties.attachmentIds.uniqueItems,true);
    const outputs=body.input.filter((item:any)=>item.type==='function_call_output'),last=outputs.length?JSON.parse(outputs.at(-1).output):undefined;
    let name:string,args:Record<string,unknown>;
    if(agentMode!=='chain'){name='get_artifact_reference';args={artifactId:sourceArtifactId};}
    else if(agentTurn===1){name='list_jobs';args={};}
    else if(agentTurn===2){assert(last.jobs.some((job:any)=>job.artifacts.some((artifact:any)=>artifact.id===sourceArtifactId)));name='get_artifact_reference';args={artifactId:sourceArtifactId};}
    else if(agentTurn===3){assert.equal(last.source.artifactId,sourceArtifactId);assert.equal(last.attachment.mime,'image/png');agentAttachmentId=last.attachment.id;name='create_job';args={kind:'image',provider:'openai',prompt:'Fictional Agent edit requested by the user',attachmentIds:[agentAttachmentId]};}
    else{assert.equal(last.job.status,'queued');assert.deepEqual(last.job.attachmentIds,[agentAttachmentId]);agentCreatedId=last.job.id;return new Response(`data: ${JSON.stringify({type:'response.output_text.delta',delta:'Synthetic private-reference task prepared.'})}\n\ndata: ${JSON.stringify({type:'response.completed',response:{output:[]}})}\n\n`,{headers:{'content-type':'text/event-stream'}});}
    return new Response(`data: ${JSON.stringify({type:'response.completed',response:{output:[{type:'function_call',name,call_id:`synthetic-call-${agentTurn}`,arguments:JSON.stringify(args)}]}})}\n\n`,{headers:{'content-type':'text/event-stream'}});
  }
  throw new Error('Unexpected synthetic media route; external model calls are forbidden.');
}) as typeof fetch;
const runtime=createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'1',OPENAI_API_KEY:'fictional-key',OPENAI_IMAGE_MODEL:'synthetic-image',OPENAI_CHAT_MODEL:'synthetic-chat'},fetch:transport});
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await db.migrate();directory=await fs.mkdtemp(path.join(os.tmpdir(),'media-reference-fixtures-'));const template=path.join(directory,'synthetic-template.json');await fs.writeFile(template,JSON.stringify({'1':{class_type:'SyntheticText',inputs:{text:'Synthetic template text'}}}));const comfy=createProviderRuntime({env:{COMFYUI_BASE_URL:'http://127.0.0.1:8188',COMFYUI_WORKFLOW_TEMPLATE:template,COMFYUI_PROMPT_NODE:'1'},fetch:transport});runtime.captureComfyUITemplate=comfy.captureComfyUITemplate;runtime.validateComfyUITemplate=comfy.validateComfyUITemplate;storage=new LocalBlobStorage(directory);system=await buildApp({db,storage,config:{...base,databaseUrl:url.toString(),storageDir:directory},runtime,enableQueue:false});});
after(async()=>{await system?.app.close();await db.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();if(directory)await fs.rm(directory,{recursive:true,force:true});});
async function actor(){const ip=`127.0.4.${++actors}`,response=await system.app.inject({method:'POST',url:prefix+'/auth/register',remoteAddress:ip,headers:{origin},payload:{name:'Fictional image editor',email:`media-${randomUUID()}@example.invalid`,password:'Fictional-password-123'}});assert.equal(response.statusCode,201,response.body);return {user:response.json().user,cookie:(response.headers['set-cookie'] as string).split(';')[0],ip};}
async function request(user:Awaited<ReturnType<typeof actor>>,method:'GET'|'POST',route:string,payload?:Record<string,unknown>){return system.app.inject({method,url:prefix+route,remoteAddress:user.ip,headers:{origin,cookie:user.cookie, [PLATFORM_ACCOUNT_HEADER]: user.user.id},payload});}
async function imageJob(user:Awaited<ReturnType<typeof actor>>,prompt='Fictional original image',ids:string[]=[]){const response=await request(user,'POST','/jobs',{kind:'image',provider:'openai',prompt,attachmentIds:ids});assert.equal(response.statusCode,201,response.body);assert.equal(response.json().job.model,'synthetic-image');const id=response.json().job.id;await processJob(system.jobs,id,1);const job=await system.jobs.get(user.user.id,id);assert.equal(job.status,'succeeded',JSON.stringify(job.error));return job;}
async function seeded(user:Awaited<ReturnType<typeof actor>>,bytes:Uint8Array=png,mime='image/png',declaredSize=bytes.byteLength){
  const item=await system.jobs.create(user.user.id,{kind:'image',provider:'openai',prompt:'Synthetic fixture only; not generated by a model'});await db.query("UPDATE platform_jobs SET status='succeeded' WHERE id=$1",[item.job.id]);const uploadId=randomUUID(),artifactId=randomUUID(),key=randomUUID();await storage.put(key,bytes);
  await db.query('INSERT INTO platform_uploads(id,user_id,filename,mime,byte_size,storage_key) VALUES($1,$2,$3,$4,$5,$6)',[uploadId,user.user.id,mime==='text/plain'?'fixture.txt':'fixture.png',mime,declaredSize,key]);await db.query('INSERT INTO platform_artifacts(id,user_id,job_id,kind,mime,filename,upload_id) VALUES($1,$2,$3,\'image\',$4,$5,$6)',[artifactId,user.user.id,item.job.id,mime,mime==='text/plain'?'fixture.txt':'fixture.png',uploadId]);return {artifactId,uploadId,jobId:item.job.id,key};
}

test('generated private images form three independent creation/edit generations without copying source files',async()=>{
  const user=await actor(),before=imageRequests.length,original=await imageJob(user),source=original.artifacts[0];assert.notEqual(source.id,(await db.query('SELECT upload_id FROM platform_artifacts WHERE id=$1',[source.id])).rows[0].upload_id);
  const filesBefore=(await fs.readdir(directory)).filter(entry=>entry!=='workspaces'),countBefore=(await db.query('SELECT count(*)::integer AS count FROM platform_uploads WHERE user_id=$1',[user.user.id])).rows[0].count;
  const ref=await request(user,'GET',`/artifacts/${source.id}/reference-attachment`);assert.equal(ref.statusCode,200,ref.body);const alias=ref.json();assert.deepEqual(alias.source,{artifactId:source.id,jobId:original.id});assert.equal(alias.attachment.url,`/api/platform/uploads/${alias.attachment.id}`);assert.equal(alias.attachment.size,png.length);
  assert.deepEqual((await request(user,'GET',`/artifacts/${source.id}/reference-attachment`)).json(),alias);assert.deepEqual((await fs.readdir(directory)).filter(entry=>entry!=='workspaces'),filesBefore);assert.equal((await db.query('SELECT count(*)::integer AS count FROM platform_uploads WHERE user_id=$1',[user.user.id])).rows[0].count,countBefore);assert.equal(imageRequests.length,before+1);
  const edited=await imageJob(user,'Fictional first edit',[alias.attachment.id]),secondAlias=(await request(user,'GET',`/artifacts/${edited.artifacts[0].id}/reference-attachment`)).json();const third=await imageJob(user,'Fictional second edit',[secondAlias.attachment.id]);assert.equal(new Set([original.id,edited.id,third.id]).size,3);assert.equal(new Set([source.id,edited.artifacts[0].id,third.artifacts[0].id]).size,3);
  assert.deepEqual(imageRequests.slice(before).map(entry=>entry.url.split('/').at(-1)),['generations','edits','edits']);assert.deepEqual(imageRequests[before+1].referenceBytes,new Uint8Array(png));assert.deepEqual(imageRequests[before+2].referenceBytes,new Uint8Array(png));assert.equal((await system.jobs.get(user.user.id,original.id)).artifacts[0].id,source.id);assert.deepEqual((await request(user,'GET',`/artifacts/${source.id}`)).rawPayload,png);
  assert.equal((await db.query('SELECT count(*)::integer AS count FROM platform_uploads WHERE user_id=$1',[user.user.id])).rows[0].count,3);
});

test('artifact references and new model inputs require the same owner for artifact, upload and source job',async()=>{
  const alice=await actor(),bob=await actor(),source=await seeded(alice),before=imageRequests.length;assert.equal((await request(bob,'GET',`/artifacts/${source.artifactId}/reference-attachment`)).statusCode,404);assert.equal((await request(bob,'GET',`/uploads/${source.uploadId}`)).statusCode,404);assert.equal((await request(bob,'POST','/jobs',{kind:'image',provider:'openai',prompt:'Must not dispatch',attachmentIds:[source.uploadId]})).statusCode,404);
  assert.equal((await request(alice,'POST','/jobs',{kind:'image',provider:'openai',prompt:'Artifact UUID is not an upload UUID',attachmentIds:[source.artifactId]})).statusCode,404);assert.equal(imageRequests.length,before);
  await db.query('UPDATE platform_jobs SET user_id=$2 WHERE id=$1',[source.jobId,bob.user.id]);assert.equal((await request(alice,'GET',`/artifacts/${source.artifactId}/reference-attachment`)).statusCode,404);
  const another=await seeded(alice);await db.query('UPDATE platform_uploads SET user_id=$2 WHERE id=$1',[another.uploadId,bob.user.id]);assert.equal((await request(alice,'GET',`/artifacts/${another.artifactId}/reference-attachment`)).statusCode,404);
  const anonymous=await system.app.inject({method:'GET',url:prefix+`/artifacts/${another.artifactId}/reference-attachment`});assert.equal(anonymous.statusCode,401);
});

test('references reject non-images, oversized data, mismatched size metadata and incorrect file signatures before generation',async()=>{
  const user=await actor(),before=imageRequests.length;
  for(const [bytes,mime,size,status] of [[Buffer.from('Synthetic text'),'text/plain',14,415],[png,'image/png',REFERENCE_IMAGE_BYTES+1,413],[png,'image/png',png.length+1,409],[Buffer.from('not a PNG'),'image/png',9,409]] as const){
    const source=await seeded(user,bytes,mime,size),alias=await request(user,'GET',`/artifacts/${source.artifactId}/reference-attachment`);assert.equal(alias.statusCode,status,alias.body);const job=await request(user,'POST','/jobs',{kind:'image',provider:'openai',prompt:'Must reject invalid reference',attachmentIds:[source.uploadId]});assert.equal(job.statusCode,status,job.body);
  }
  const source=await seeded(user);await db.query("UPDATE platform_artifacts SET mime='image/jpeg' WHERE id=$1",[source.artifactId]);assert.equal((await request(user,'GET',`/artifacts/${source.artifactId}/reference-attachment`)).statusCode,409);assert.equal(imageRequests.length,before);
});

test('media provider reference metadata, count, total size and binding are enforced before accepting a task',async()=>{
  const user=await actor(),one=await seeded(user),two=await seeded(user),before=imageRequests.length,original=runtime.capabilities;
  try{
    runtime.capabilities=()=>original().map(provider=>provider.id==='openai'?{...provider,referenceImages:undefined}:provider);
    assert.equal((await request(user,'POST','/jobs',{kind:'image',provider:'openai',prompt:'No reference support',attachmentIds:[one.uploadId]})).statusCode,400);
    const without=await request(user,'POST','/jobs',{kind:'image',provider:'openai',prompt:'No refs still accepted'});assert.equal(without.statusCode,201);await system.jobs.cancel(user.user.id,without.json().job.id);
    runtime.capabilities=()=>original().map(provider=>provider.id==='openai'?{...provider,referenceImages:{image:{maxImages:1,maxTotalBytes:REFERENCE_IMAGE_BYTES,mimeTypes:['image/png'],binding:'openai_edits' as const}}}:provider);
    assert.equal((await request(user,'POST','/jobs',{kind:'image',provider:'openai',prompt:'Too many refs',attachmentIds:[one.uploadId,two.uploadId]})).statusCode,400);
    runtime.capabilities=()=>original().map(provider=>provider.id==='openai'?{...provider,referenceImages:{image:{maxImages:4,maxTotalBytes:png.length,mimeTypes:['image/png'],binding:'openai_edits' as const}}}:provider);
    assert.equal((await request(user,'POST','/jobs',{kind:'image',provider:'openai',prompt:'Too much combined data',attachmentIds:[one.uploadId,two.uploadId]})).statusCode,413);
    runtime.capabilities=()=>original().map(provider=>provider.id==='openai'?{...provider,referenceImages:{image:{maxImages:4,maxTotalBytes:REFERENCE_IMAGE_BYTES,mimeTypes:['image/jpeg'],binding:'openai_edits' as const}}}:provider);
    assert.equal((await request(user,'POST','/jobs',{kind:'image',provider:'openai',prompt:'Unsupported policy MIME',attachmentIds:[one.uploadId]})).statusCode,415);
    runtime.capabilities=()=>original().map(provider=>provider.id==='comfyui'?{...provider,enabled:true,keyConfigured:true}:provider);assert.equal((await request(user,'POST','/jobs',{kind:'image',provider:'comfyui',prompt:'Template cannot consume refs',attachmentIds:[one.uploadId]})).statusCode,400);
    runtime.capabilities=original;assert.equal((await request(user,'POST','/jobs',{kind:'image',provider:'openai',prompt:'No duplicates',attachmentIds:[one.uploadId,one.uploadId]})).statusCode,400);assert.throws(()=>parseJob({kind:'cli',provider:'cli',prompt:'No duplicate tool inputs',attachmentIds:[one.uploadId,one.uploadId]}));assert.throws(()=>parseJob({kind:'image',provider:'openai',prompt:'Too many schema inputs',attachmentIds:Array.from({length:5},()=>randomUUID())}));const cliIds=Array.from({length:5},()=>randomUUID());assert.deepEqual(parseJob({kind:'cli',provider:'cli',prompt:'Fictional five CLI attachments',attachmentIds:cliIds}).attachmentIds,cliIds);
  }finally{runtime.capabilities=original;}
  assert.equal(imageRequests.length,before);
});

test('media jobs freeze declared capability defaults before preflight without inventing a ComfyUI model',async()=>{
  const user=await actor(),source=await seeded(user),original=runtime.capabilities,before=imageRequests.length;
  try{
    runtime.capabilities=()=>original().map(provider=>provider.id==='openai'?{...provider,modelsByCapability:{...provider.modelsByCapability,image:['gpt-image-2.5-flare']}}:provider.id==='ark'?{...provider,enabled:true,keyConfigured:true,modelsByCapability:{video:['doubao-seedance-2-5-260128']}}:provider.id==='comfyui'?{...provider,enabled:true,keyConfigured:true}:provider);
    const image=await request(user,'POST','/jobs',{kind:'image',provider:'openai',prompt:'Fictional frozen image model',options:{aspectRatio:'16:9'}});assert.equal(image.statusCode,201,image.body);assert.equal(image.json().job.model,'gpt-image-2.5-flare');await system.jobs.cancel(user.user.id,image.json().job.id);
    const ark=await request(user,'POST','/jobs',{kind:'video',provider:'ark',prompt:'Reject before creating a paid first-frame task',attachmentIds:[source.uploadId],options:{aspectRatio:'16:9'}});assert.equal(ark.statusCode,400,ark.body);
    const comfy=await request(user,'POST','/jobs',{kind:'image',provider:'comfyui',prompt:'Fictional server template draft'});assert.equal(comfy.statusCode,201,comfy.body);assert.equal(comfy.json().job.model,undefined);await system.jobs.cancel(user.user.id,comfy.json().job.id);
    assert.equal(imageRequests.length,before);
  }finally{runtime.capabilities=original;}
});

test('actual Agent adapter can list an owned artwork, resolve its reference and create a new edit with original private bytes',async()=>{
  const user=await actor(),source=await seeded(user),before=imageRequests.length;sourceArtifactId=source.artifactId;agentTurn=0;agentMode='chain';const conversation=(await request(user,'POST','/conversations',{mode:'agent'})).json().conversation;
  const response=await request(user,'POST',`/conversations/${conversation.id}/messages`,{content:'Please make one new fictional image edit from my saved artwork.',provider:'openai',mode:'agent'});assert.match(response.body,/event: done/);assert.equal(agentTurn,4);assert.equal(agentAttachmentId,source.uploadId);assert(agentCreatedId);assert.equal(imageRequests.length,before);
  await processJob(system.jobs,agentCreatedId,1);assert.equal((await system.jobs.get(user.user.id,agentCreatedId)).status,'succeeded');assert.deepEqual(imageRequests.at(-1)?.referenceBytes,new Uint8Array(png));assert.equal((await system.jobs.get(user.user.id,source.jobId)).artifacts[0].id,source.artifactId);
  const foreign=await actor(),foreignConversation=(await request(foreign,'POST','/conversations',{mode:'agent'})).json().conversation;agentTurn=0;agentMode='foreign';const denied=await request(foreign,'POST',`/conversations/${foreignConversation.id}/messages`,{content:'Synthetic denied reference attempt',provider:'openai',mode:'agent'});assert.match(denied.body,/NOT_FOUND/);assert.equal(agentTurn,1);assert.equal((await system.jobs.list(foreign.user.id)).length,0);
  const nonimage=await seeded(user,Buffer.from('Fictional text'),'text/plain');sourceArtifactId=nonimage.artifactId;agentTurn=0;agentMode='nonimage';const invalid=await request(user,'POST',`/conversations/${conversation.id}/messages`,{content:'Synthetic nonimage reference attempt',provider:'openai',mode:'agent'});assert.match(invalid.body,/REFERENCE_IMAGE_UNSUPPORTED/);assert.equal(agentTurn,1);assert.equal(imageRequests.length,before+1);
});
