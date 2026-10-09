import { UploadWrites, type StagedUpload } from './upload-writes.ts';
import type { DataCrypto } from './data-crypto.ts';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { BrowserCheckpoint, BrowserCheckpointEvent, BrowserObservation, BrowserTarget, CreateJobInput, JobExecutionResult, PlatformProviderRuntime } from '@companion/platform-contracts';
import { browserDefinitionHash, parseBrowserTaskOptions } from '@companion/ai-core';
import type { Database } from './database.ts';
import type { BlobStorage } from './storage.ts';
import { ApiError, invalid, notFound, object } from './errors.ts';

export interface BrowserBinding { authVersion:string;jobId:string;userId:string;generation:number;leaseToken:string;definitionHash:string;signal:AbortSignal; }
const MAX_JSON_BYTES=512*1024,MAX_TEXT_BYTES=80*1024,MAX_PNG_BYTES=4*1024*1024;
const snapshot=(row:any):BrowserCheckpoint=>({definitionHash:row.definition_hash,revision:row.revision,nextIndex:row.next_index,state:row.state});
export function normalizeBrowserInput(input:CreateJobInput,runtime:PlatformProviderRuntime):CreateJobInput {
  if(input.provider!=='browser')throw invalid('Browser tasks require the isolated browser provider.');
  if(input.attachmentIds?.length)throw invalid('Browser tasks do not accept reference attachments.');
  const options=parseBrowserTaskOptions(input.options);
  if(options.actions?.length&&!runtime.capabilities().find(provider=>provider.id===input.provider)?.browserActionsEnabled)throw new ApiError(503,'BROWSER_ACTIONS_DISABLED','Browser actions are disabled on this server.');
  return {...input,options:{...options}};
}
export async function initializeBrowserCheckpoint(client:PoolClient,jobId:string,input:CreateJobInput){
  const total=parseBrowserTaskOptions(input.options).actions?.length??0;
  if(total)await client.query('INSERT INTO platform_browser_checkpoints(job_id,definition_hash,total_actions) VALUES($1,$2,$3)',[jobId,browserDefinitionHash(input),total]);
}
export async function assertBrowserAuthorized(client:PoolClient|Database,binding:BrowserBinding,lock=false){
  binding.signal.throwIfAborted();
  const result=await client.query(`SELECT j.* FROM platform_jobs j WHERE j.id=$1 AND j.user_id=$2 AND j.generation=$3 AND j.lease_token=$4 AND j.lease_until>clock_timestamp() AND j.status='running' AND j.kind='browser' AND EXISTS(SELECT 1 FROM platform_users u WHERE u.id=j.user_id AND u.auth_version=$6) AND j.requires_approval AND EXISTS(SELECT 1 FROM platform_approvals a WHERE a.job_id=j.id AND a.user_id=j.user_id AND a.generation=j.generation AND a.status='approved' AND a.args->>'browserDefinitionHash'=$5)${lock?' FOR UPDATE OF j':''}`,[binding.jobId,binding.userId,binding.generation,binding.leaseToken,binding.definitionHash,binding.authVersion]);
  if(!result.rowCount)throw new ApiError(409,'BROWSER_AUTH_REVOKED','This browser task is no longer authorized to execute.');
  if(browserDefinitionHash({kind:'browser',provider:result.rows[0].provider,prompt:result.rows[0].prompt,options:result.rows[0].options})!==binding.definitionHash)throw new ApiError(409,'BROWSER_DEFINITION_CHANGED','The reviewed browser plan changed. Prepare another reviewed task.');
  return result.rows[0];
}
export async function loadBrowserCheckpoint(db:Database,binding:BrowserBinding):Promise<BrowserCheckpoint|undefined>{
  await assertBrowserAuthorized(db,binding);
  const result=await db.query('SELECT * FROM platform_browser_checkpoints WHERE job_id=$1',[binding.jobId]);
  if(!result.rowCount)return undefined;
  if(result.rows[0].definition_hash!==binding.definitionHash)throw new ApiError(409,'BROWSER_DEFINITION_CHANGED','The browser journal does not match the reviewed plan.');
  return snapshot(result.rows[0]);
}
export function browserReviewRequired(row:any):boolean{return !row||row.state==='uncertain'||row.revision>0||row.next_index>0;}
export async function markBrowserInterrupted(client:PoolClient,jobId:string,generation:number){
  const found=await client.query('SELECT * FROM platform_browser_checkpoints WHERE job_id=$1 FOR UPDATE',[jobId]);
  if(!found.rowCount||found.rows[0].revision===0||found.rows[0].state==='uncertain')return false;
  const row=found.rows[0],revision=row.revision+1,index=Math.min(row.total_actions-1,row.state==='started'?row.next_index:Math.max(0,row.next_index-1));
  await client.query("UPDATE platform_browser_checkpoints SET state='uncertain',revision=$2,updated_at=now() WHERE job_id=$1",[jobId,revision]);
  await client.query("INSERT INTO platform_browser_action_ledger(job_id,revision,generation,action_index,event_type) VALUES($1,$2,$3,$4,'uncertain')",[jobId,revision,generation,index]);
  return true;
}

function boundedText(value:unknown,label:string,bytes:number):string{
  if(typeof value!=='string'||Buffer.byteLength(value,'utf8')>bytes||value.includes('\u0000'))throw invalid(`Invalid browser observation ${label}.`);return value;
}
function observationUrl(value:unknown):string{
  const text=boundedText(value,'URL',4096);let url:URL;try{url=new URL(text);}catch{throw invalid('Invalid browser observation URL.');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw invalid('Invalid browser observation URL.');return url.href;
}
function observedTarget(value:unknown):BrowserTarget{
  const target=object(value),name=boundedText(target.name,'target name',800);
  if(!name.trim()||name.length>200||/[\u0000-\u001f\u007f]/.test(name)||Object.keys(target).some(key=>!['by','name','role'].includes(key)))throw invalid('Invalid browser observation target.');
  if(target.by==='label'&&target.role===undefined)return {by:'label',name};
  if(target.by==='role'&&typeof target.role==='string'&&['link','button','textbox','combobox'].includes(target.role))return {by:'role',role:target.role as 'link'|'button'|'textbox'|'combobox',name};
  throw invalid('Invalid browser observation target.');
}
export function parseBrowserObservation(value:unknown):BrowserObservation{
  const observation=object(value),fields=['version','provenance','requestedUrl','url','title','text','completedActions','targets'];
  if(Object.keys(observation).some(key=>!fields.includes(key))||observation.version!==1||observation.provenance!=='untrusted_page'||!Number.isSafeInteger(observation.completedActions)||Number(observation.completedActions)<0||Number(observation.completedActions)>12||!Array.isArray(observation.targets)||observation.targets.length>40)throw invalid('Invalid browser observation.');
  const title=boundedText(observation.title,'title',2000);if(title.length>500)throw invalid('Invalid browser observation title.');
  const targets=observation.targets.map(value=>{const item=object(value);if(Object.keys(item).some(key=>!['target','action'].includes(key))||typeof item.action!=='string'||!['click','fill','select'].includes(item.action))throw invalid('Invalid browser observation action.');const target=observedTarget(item.target);if(target.by==='role'&&!(item.action==='click'?['link','button']:item.action==='fill'?['textbox']:['combobox']).includes(target.role))throw invalid('The browser target does not match its observed action.');return {target,action:item.action as 'click'|'fill'|'select'};});
  return {version:1,provenance:'untrusted_page',requestedUrl:observationUrl(observation.requestedUrl),url:observationUrl(observation.url),title,text:boundedText(observation.text,'text',64*1024),completedActions:Number(observation.completedActions),targets};
}
export function validateBrowserResult(result:JobExecutionResult,input:CreateJobInput,completedActions:number){
  if(!Array.isArray(result.artifacts)||result.artifacts.length!==3||result.providerTaskId!==undefined)throw invalid('Browser results require the private text, PNG and structured observation artifacts.');
  const expected=new Map([['browser-snapshot.txt','text/plain'],['browser-screenshot.png','image/png'],['browser-observation.json','application/json']]);
  let observation:BrowserObservation|undefined;
  for(const artifact of result.artifacts){
    if(!expected.has(artifact.name)||artifact.mime!==expected.get(artifact.name)||!(artifact.bytes instanceof Uint8Array)||!artifact.bytes.length)throw invalid('Invalid browser result artifact.');
    expected.delete(artifact.name);
    const limit=artifact.mime==='image/png'?MAX_PNG_BYTES:artifact.mime==='application/json'?MAX_JSON_BYTES:MAX_TEXT_BYTES;
    if(artifact.bytes.byteLength>limit)throw new ApiError(413,'BROWSER_RESULT_TOO_LARGE','The browser result exceeds its private storage limit.');
    if(artifact.mime==='image/png'){
      if(!Buffer.from(artifact.bytes.subarray(0,8)).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw invalid('Invalid browser screenshot.');
    }else{
      let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(artifact.bytes);}catch{throw invalid('Invalid UTF-8 browser result.');}
      if(artifact.mime==='application/json'){try{observation=parseBrowserObservation(JSON.parse(text));}catch{throw invalid('Invalid structured browser observation.');}}
      else if(result.text!==text)throw invalid('The browser text result does not match its private snapshot.');
    }
  }
  const plan=parseBrowserTaskOptions(input.options);
  if(!observation||observation.requestedUrl!==new URL(plan.url).href||observation.completedActions!==completedActions)throw invalid('The browser observation does not match this task step.');
  return observation;
}
async function discardUnpublished(writes:UploadWrites,files:StagedUpload[]){for(const file of files)await writes.abandon(file);}
export async function applyBrowserCheckpoint(db:Database,storage:BlobStorage,crypto:DataCrypto|undefined,binding:BrowserBinding,event:BrowserCheckpointEvent):Promise<BrowserCheckpoint>{
  const writes=new UploadWrites(db,crypto,storage);
  const job=await assertBrowserAuthorized(db,binding),input:CreateJobInput={kind:'browser',provider:job.provider,prompt:job.prompt,options:job.options};
  if(event.definitionHash!==binding.definitionHash||!Number.isSafeInteger(event.expectedRevision)||event.expectedRevision<0||!Number.isSafeInteger(event.index)||event.index<0||event.index>11||!['started','completed'].includes(event.type))throw invalid('Invalid browser checkpoint transition.');
  if(event.type==='completed')validateBrowserResult(event.result,input,event.index+1);
  const files:{staged:StagedUpload;uploadId:string;artifactId:string;artifact:JobExecutionResult['artifacts'][number]}[]=[];
  try{
    if(event.type==='completed')for(const artifact of event.result.artifacts){binding.signal.throwIfAborted();const staged=await writes.stage(binding.userId,{filename:artifact.name,mime:artifact.mime,bytes:artifact.bytes},async c=>{await assertBrowserAuthorized(c,binding,true);},binding.signal);files.push({staged,uploadId:staged.id,artifactId:randomUUID(),artifact});}
    return await db.transaction(async client=>{
      await assertBrowserAuthorized(client,binding,true);
      const found=await client.query('SELECT * FROM platform_browser_checkpoints WHERE job_id=$1 FOR UPDATE',[binding.jobId]);const row=found.rows[0];
      if(!row||row.definition_hash!==binding.definitionHash)throw new ApiError(409,'BROWSER_DEFINITION_CHANGED','The browser journal does not match the reviewed plan.');
      if(row.revision!==event.expectedRevision)throw new ApiError(409,'BROWSER_CHECKPOINT_CONFLICT','The browser journal advanced in another execution.');
      if(event.index!==row.next_index||event.index>=row.total_actions||row.state!==(event.type==='started'?'ready':'started'))throw new ApiError(409,'BROWSER_REVIEW_REQUIRED','This browser action cannot be replayed or completed out of order.');
      for(const file of files){
        await writes.publishInTransaction(client,file.staged);
        await client.query('INSERT INTO platform_artifacts(id,user_id,job_id,kind,mime,filename,upload_id,metadata) VALUES($1,$2,$3,\'browser\',$4,$5,$6,$7)',[file.artifactId,binding.userId,binding.jobId,file.artifact.mime,file.artifact.name,file.uploadId,JSON.stringify({browserAction:event.index,browserGeneration:binding.generation,definitionHash:binding.definitionHash,partialCompleted:true,browserObservation:file.artifact.name==='browser-observation.json'})]);
      }
      const revision=row.revision+1,nextIndex=row.next_index+(event.type==='completed'?1:0),state=event.type==='started'?'started':nextIndex===row.total_actions?'completed':'ready';
      const saved=await client.query('UPDATE platform_browser_checkpoints SET revision=$2,next_index=$3,state=$4,updated_at=now() WHERE job_id=$1 AND revision=$5 RETURNING *',[binding.jobId,revision,nextIndex,state,event.expectedRevision]);
      if(!saved.rowCount)throw new ApiError(409,'BROWSER_CHECKPOINT_CONFLICT','The browser journal advanced in another execution.');
      await client.query('INSERT INTO platform_browser_action_ledger(job_id,revision,generation,action_index,event_type) VALUES($1,$2,$3,$4,$5)',[binding.jobId,revision,binding.generation,event.index,event.type]);
      await client.query('UPDATE platform_jobs SET progress=$2,updated_at=now() WHERE id=$1',[binding.jobId,Math.round(nextIndex/row.total_actions*95)]);
      return snapshot(saved.rows[0]);
    });
  }catch(error){await discardUnpublished(writes,files.map(file=>file.staged));throw error;}
}
function truncateUtf8(value:string,bytes:number){return Buffer.from(value).subarray(0,bytes).toString('utf8').replace(/\ufffd$/,'');}
export async function getBrowserObservation(db:Database,storage:BlobStorage,userId:string,jobId:string){
  const found=await db.query(`SELECT a.id,a.created_at,a.metadata,u.storage_key,u.byte_size,j.prompt,j.provider,j.options FROM platform_artifacts a JOIN platform_uploads u ON u.id=a.upload_id JOIN platform_jobs j ON j.id=a.job_id WHERE j.id=$1 AND j.user_id=$2 AND j.kind='browser' AND a.user_id=$2 AND u.user_id=$2 AND a.filename='browser-observation.json' AND a.mime='application/json' AND a.metadata->>'browserObservation'='true' AND EXISTS(SELECT 1 FROM platform_approvals p WHERE p.job_id=j.id AND p.user_id=j.user_id AND p.status='approved' AND p.generation=(a.metadata->>'browserGeneration')::integer AND p.args->>'browserDefinitionHash'=a.metadata->>'definitionHash') ORDER BY coalesce((a.metadata->>'browserAction')::integer,-1) DESC,a.created_at DESC,a.id DESC LIMIT 1`,[jobId,userId]);
  if(!found.rowCount)throw notFound();const row=found.rows[0];
  if(Number(row.byte_size)>MAX_JSON_BYTES||browserDefinitionHash({kind:'browser',provider:row.provider,prompt:row.prompt,options:row.options})!==row.metadata.definitionHash)throw invalid('This browser observation does not match an approved plan.');
  const bytes=await storage.get(row.storage_key);if(bytes.byteLength>MAX_JSON_BYTES)throw invalid('The saved browser observation is too large.');
  let observation:BrowserObservation;try{observation=parseBrowserObservation(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}catch{throw invalid('The saved browser observation is invalid.');}
  const plan=parseBrowserTaskOptions(row.options),expected=row.metadata.browserAction===undefined?0:Number(row.metadata.browserAction)+1;
  if(observation.requestedUrl!==new URL(plan.url).href||observation.completedActions!==expected||expected>(plan.actions?.length??0))throw invalid('The saved browser observation does not match its receipt.');
  const bounded={jobId,artifactId:row.id,savedAt:new Date(row.created_at).toISOString(),observation:{...observation,text:truncateUtf8(observation.text,12*1024),targets:observation.targets.slice(0,20)},textTruncated:Buffer.byteLength(observation.text)>12*1024};
  // Escaped page text can be larger than its UTF-8 byte count; stay below the Agent adapter's encoded-result limit.
  while(JSON.stringify(bounded).length>48_000){bounded.observation.text=truncateUtf8(bounded.observation.text,Math.floor(Buffer.byteLength(bounded.observation.text)/2));bounded.textTruncated=true;}
  return bounded;
}
