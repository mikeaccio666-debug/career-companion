import { createHash, randomUUID } from 'node:crypto';
import type { ModelRelayRequest } from '@companion/platform-contracts';
import type { Database } from './database.ts';
import { ApiError } from './errors.ts';

export interface ModelRelayBinding {
  jobId: string; userId: string; generation: number; leaseToken: string; signal: AbortSignal;
}
export interface ModelRelayOptions { env?: NodeJS.ProcessEnv; fetch?: typeof globalThis.fetch; }
export interface ModelRelayPolicy {
  model: string; maxRequests: number; maxTokens: number; dailyTokens: number; maxOutputTokens: number;
}

const MAX_INPUT_BYTES=256*1024, MAX_RESPONSE_BYTES=8*1024*1024;
const fields=new Set(['model','input','instructions','tools','tool_choice','parallel_tool_calls','reasoning','text','include','stream','store','max_output_tokens','prompt_cache_key','prompt_cache_retention','service_tier','metadata','client_metadata','safety_identifier','temperature','top_p','stream_options','background']);
const inputTypes=new Set(['message','reasoning','function_call','function_call_output','custom_tool_call','custom_tool_call_output','compaction']);
function bad(message:string):never {throw new ApiError(400,'MODEL_RELAY_INVALID_REQUEST',message);}
function record(value:unknown):value is Record<string,unknown> {return !!value&&typeof value==='object'&&!Array.isArray(value);}
function limit(env:NodeJS.ProcessEnv,key:string,fallback:number,min:number,max:number){
  const value=Number(env[key]??fallback);
  if(!Number.isSafeInteger(value)||value<min||value>max)throw new ApiError(503,'MODEL_RELAY_CONFIG_INVALID','Check the server model relay limits.');
  return value;
}
export function configuredModelRelayPolicy(env:NodeJS.ProcessEnv=process.env):ModelRelayPolicy {
  const model=env.PLATFORM_CLI_MODEL||env.OPENAI_CHAT_MODEL||'gpt-6-astra';
  if(model.length>160)throw new ApiError(503,'MODEL_RELAY_CONFIG_INVALID','Check the server relay model.');
  return {model,maxRequests:limit(env,'PLATFORM_CLI_RELAY_MAX_REQUESTS',16,1,64),maxTokens:limit(env,'PLATFORM_CLI_RELAY_MAX_TOKENS',131072,4096,16*1024*1024),dailyTokens:limit(env,'PLATFORM_CLI_RELAY_DAILY_TOKENS',524288,4096,64*1024*1024),maxOutputTokens:limit(env,'PLATFORM_CLI_RELAY_MAX_OUTPUT_TOKENS',4096,256,16384)};
}
function localTools(value:unknown,depth=0):void {
  if(value===undefined)return;
  if(!Array.isArray(value)||value.length>128||depth>3)bad('The model relay accepts bounded local tool definitions.');
  for(const tool of value){
    if(!record(tool))bad('Invalid tool definition.');
    if(tool.type==='namespace'){if(typeof tool.name!=='string')bad('Invalid tool namespace.');localTools(tool.tools,depth+1);}
    else if(!['function','custom'].includes(String(tool.type))||typeof tool.name!=='string')bad('Only tools executed inside the task container are permitted.');
  }
}
function textInput(value:unknown):void {
  if(typeof value==='string')return;
  if(!Array.isArray(value)||value.length>500)bad('The model relay requires bounded stateless input.');
  for(const item of value){
    if(!record(item)|| (item.type!==undefined&&!inputTypes.has(String(item.type))))bad('Unsupported model input item.');
    if(item.type===undefined||item.type==='message'){
      if(!['user','assistant','system','developer'].includes(String(item.role)))bad('Invalid message role.');
      if(typeof item.content==='string')continue;
      if(!Array.isArray(item.content)||item.content.length>100)bad('Invalid message content.');
      for(const content of item.content){if(!record(content)||!['input_text','output_text','refusal'].includes(String(content.type))||typeof (content.type==='refusal'?content.refusal:content.text)!=='string')bad('CLI model inputs currently support text only.');}
    }else if((item.type==='function_call_output'||item.type==='custom_tool_call_output')&&typeof item.output!=='string')bad('Local tool outputs must be text.');
  }
}
function prepare(env:NodeJS.ProcessEnv,request:ModelRelayRequest,userId:string,approvedPolicy?:ModelRelayPolicy){
  if(env.PLATFORM_CLI_MODEL_RELAY!=='1'||env.PLATFORM_ALLOW_PROVIDER_CALLS!=='1'||!env.OPENAI_API_KEY)throw new ApiError(503,'MODEL_RELAY_DISABLED','Configure and explicitly enable the server model relay.');
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(request.requestId)||!record(request.body))bad('Invalid model relay request.');
  const selected=env.PLATFORM_CLI_MODEL||env.OPENAI_CHAT_MODEL||'gpt-6-astra';
  if(selected.length>160)throw new ApiError(503,'MODEL_RELAY_CONFIG_INVALID','Check the server relay model.');
  if(request.body.model!==undefined&&request.body.model!==selected)bad('The model is fixed by the server for this task.');
  for(const key of Object.keys(request.body))if(!fields.has(key))bad('This model request field is not supported by the task relay.');
  if(request.body.background===true)bad('Background provider execution is not permitted.');
  if(request.body.stream!==undefined&&typeof request.body.stream!=='boolean')bad('Invalid streaming option.');
  textInput(request.body.input);localTools(request.body.tools);
  if(record(request.body.tool_choice)&&!['function','custom','allowed_tools'].includes(String(request.body.tool_choice.type)))bad('Hosted tool selection is not permitted.');
  if(record(request.body.tool_choice)&&request.body.tool_choice.type==='allowed_tools')localTools(request.body.tool_choice.tools);
  if(request.body.include!==undefined&&(!Array.isArray(request.body.include)||request.body.include.some(value=>value!=='reasoning.encrypted_content')))bad('Unsupported additional response data.');
  const maxOutput=Math.min(limit(env,'PLATFORM_CLI_RELAY_MAX_OUTPUT_TOKENS',4096,256,16384),approvedPolicy?.maxOutputTokens??16384);
  const requested=request.body.max_output_tokens;
  if(requested!==undefined&&(!Number.isSafeInteger(requested)||Number(requested)<1))bad('Invalid output token limit.');
  const body:Record<string,unknown>&{max_output_tokens:number}={...request.body,model:selected,store:false,background:false,service_tier:'default',max_output_tokens:Math.min(Number(requested??maxOutput),maxOutput),safety_identifier:createHash('sha256').update(userId).digest('hex')};
  delete (body as Record<string,unknown>).metadata;
  // Official Codex supplies client metadata; it is not needed by this task's model request.
  delete (body as Record<string,unknown>).client_metadata;
  const encoded=JSON.stringify(body),bytes=Buffer.byteLength(encoded);
  if(bytes>MAX_INPUT_BYTES)throw new ApiError(413,'MODEL_RELAY_INPUT_LIMIT','The CLI model context exceeds the request size limit.');
  // A deliberately conservative byte-based input reservation; never refund ambiguous calls.
  const reserved=bytes+1024+body.max_output_tokens;
  return {body,encoded,model:selected,reserved,maxOutput:body.max_output_tokens};
}
async function authorize(db:Database,binding:ModelRelayBinding,model:string){
  const result=await db.query("SELECT j.id FROM platform_jobs j WHERE j.id=$1 AND j.user_id=$2 AND j.generation=$3 AND j.lease_token=$4 AND j.lease_until>now() AND j.status='running' AND j.kind='cli' AND j.provider='cli' AND j.model=$5 AND j.requires_approval AND EXISTS(SELECT 1 FROM platform_approvals a WHERE a.job_id=j.id AND a.user_id=j.user_id AND a.generation=j.generation AND a.status='approved')",[binding.jobId,binding.userId,binding.generation,binding.leaseToken,model]);
  if(!result.rowCount)throw new ApiError(409,'MODEL_RELAY_AUTH_REVOKED','The task is no longer authorized to use the model.');
}
function inspectOutput(bytes:Uint8Array,stream:boolean,maxOutput:number,reserved:number){
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  let completed:Record<string,unknown>|undefined;
  if(stream){
    for(const block of text.split(/\r?\n\r?\n/)){
      const data=block.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
      if(!data||data==='[DONE]')continue;
      const event=JSON.parse(data);
      if(!record(event))throw new Error('Invalid event');
      if(['error','response.failed','response.incomplete'].includes(String(event.type)))throw new ApiError(502,'MODEL_RELAY_PROVIDER_FAILED','The model response did not complete.');
      if(event.type==='response.completed'&&record(event.response)&&event.response.status==='completed'&&!event.response.error)completed=event.response;
    }
  }else{const result=JSON.parse(text);if(record(result)&&result.status==='completed'&&!result.error)completed=result;}
  if(!completed||!record(completed.usage))throw new ApiError(502,'MODEL_RELAY_UNCERTAIN','The provider result could not be confirmed. Review before retrying.');
  const input=completed.usage.input_tokens,output=completed.usage.output_tokens;
  if(!Number.isSafeInteger(input)||!Number.isSafeInteger(output)||Number(input)<0||Number(output)<0||Number(output)>maxOutput||Number(input)+Number(output)>reserved)throw new ApiError(502,'MODEL_RELAY_USAGE_INVALID','The provider returned unexpected usage. Review the task before retrying.');
  return {input:Number(input),output:Number(output)};
}

/** Only the claimed worker receives this callback. There is no public relay HTTP route or container API key. */
export function createJobModelRelay(db:Database,binding:ModelRelayBinding,options:ModelRelayOptions={}): (request:ModelRelayRequest)=>Promise<Response> {
  const env={...(options.env??process.env)},fetch=options.fetch??globalThis.fetch;
  return async request=>{
    binding.signal.throwIfAborted();request.signal.throwIfAborted();
    let prepared=prepare(env,request,binding.userId);const auditId=randomUUID(),currentPolicy=configuredModelRelayPolicy(env);
    await db.transaction(async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtext('platform-model-relay:'||$1))",[binding.userId]);
      const job=await client.query("SELECT id,model,execution_policy FROM platform_jobs WHERE id=$1 AND user_id=$2 AND generation=$3 AND lease_token=$4 AND lease_until>now() AND status='running' AND kind='cli' AND provider='cli' AND requires_approval FOR UPDATE",[binding.jobId,binding.userId,binding.generation,binding.leaseToken]);
      if(!job.rowCount)throw new ApiError(409,'MODEL_RELAY_AUTH_REVOKED','The task is no longer authorized to use the model.');
      const approval=await client.query("SELECT id,args FROM platform_approvals WHERE job_id=$1 AND user_id=$2 AND generation=$3 AND status='approved'",[binding.jobId,binding.userId,binding.generation]);
      if(!approval.rowCount)throw new ApiError(409,'MODEL_RELAY_AUTH_REVOKED','The task has no current approval for model access.');
      const policy=job.rows[0].execution_policy?.modelRelay;
      if(!record(policy)||policy.model!==prepared.model||job.rows[0].model!==prepared.model||approval.rows[0].args.model!==prepared.model||!record(approval.rows[0].args.modelRelayLimits)||Object.keys(currentPolicy).some(key=>approval.rows[0].args.modelRelayLimits[key]!==policy[key])||['maxRequests','maxTokens','dailyTokens','maxOutputTokens'].some(key=>!Number.isSafeInteger(policy[key])||Number(policy[key])<1))throw new ApiError(409,'MODEL_RELAY_POLICY_CHANGED','The approved task model and limits no longer match. Create a new reviewed task.');
      const approvedPolicy=policy as unknown as ModelRelayPolicy;
      prepared=prepare(env,request,binding.userId,approvedPolicy);
      const maxCalls=Math.min(currentPolicy.maxRequests,approvedPolicy.maxRequests),maxTokens=Math.min(currentPolicy.maxTokens,approvedPolicy.maxTokens),dailyTokens=Math.min(currentPolicy.dailyTokens,approvedPolicy.dailyTokens);
      const existing=await client.query('SELECT id FROM platform_model_relay_requests WHERE job_id=$1 AND generation=$2 AND request_id=$3',[binding.jobId,binding.generation,request.requestId]);
      if(existing.rowCount)throw new ApiError(409,'MODEL_RELAY_DUPLICATE','This model request was already accepted. Automatic replay is disabled.');
      const total=await client.query('SELECT count(*)::integer AS count,coalesce(sum(reserved_tokens),0)::bigint AS tokens FROM platform_model_relay_requests WHERE job_id=$1',[binding.jobId]);
      const day=await client.query("SELECT coalesce(sum(reserved_tokens),0)::bigint AS tokens FROM platform_model_relay_requests WHERE user_id=$1 AND created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",[binding.userId]);
      if(total.rows[0].count>=maxCalls||Number(total.rows[0].tokens)+prepared.reserved>maxTokens||Number(day.rows[0].tokens)+prepared.reserved>dailyTokens)throw new ApiError(429,'MODEL_RELAY_BUDGET_LIMIT','This task or account reached its model relay allowance.');
      await client.query("INSERT INTO platform_model_relay_requests(id,user_id,job_id,generation,request_id,model,reserved_tokens,status) VALUES($1,$2,$3,$4,$5,$6,$7,'reserved')",[auditId,binding.userId,binding.jobId,binding.generation,request.requestId,prepared.model,prepared.reserved]);
    });
    const revoked=new AbortController(),signal=AbortSignal.any([binding.signal,request.signal,revoked.signal,AbortSignal.timeout(120_000)]);
    let checking=false;
    const heartbeat=setInterval(()=>{if(checking)return;checking=true;void authorize(db,binding,prepared.model).catch(()=>revoked.abort()).finally(()=>{checking=false;});},1000);heartbeat.unref();
    let upstream:Response|undefined,attempted=false;
    try{
      await authorize(db,binding,prepared.model);signal.throwIfAborted();attempted=true;
      upstream=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${env.OPENAI_API_KEY}`},body:prepared.encoded,redirect:'error',signal});
      if(!upstream.ok){await upstream.body?.cancel();if(upstream.status>=500)throw new ApiError(502,'MODEL_RELAY_UNCERTAIN','The provider could not confirm the result. Review before retrying.');throw new ApiError(upstream.status===429?429:502,'MODEL_RELAY_PROVIDER_REJECTED','Check the model account, access and available credits.');}
      const contentType=(upstream.headers.get('content-type')??'').split(';')[0].trim().toLowerCase();
      const stream=prepared.body.stream===true;
      if(contentType!==(stream?'text/event-stream':'application/json')||!upstream.body)throw new ApiError(502,'MODEL_RELAY_UNCERTAIN','The provider response format could not be confirmed.');
      if(Number(upstream.headers.get('content-length')??0)>MAX_RESPONSE_BYTES)throw new ApiError(413,'MODEL_RELAY_OUTPUT_LIMIT','The model response exceeded its size limit.');
      const chunks:Uint8Array[]=[],reader=upstream.body.getReader();let total=0;
      try{while(true){signal.throwIfAborted();const part=await reader.read();if(part.done)break;total+=part.value.length;if(total>MAX_RESPONSE_BYTES)throw new ApiError(413,'MODEL_RELAY_OUTPUT_LIMIT','The model response exceeded its size limit.');chunks.push(part.value);}}
      finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      const bytes=new Uint8Array(total);let position=0;for(const chunk of chunks){bytes.set(chunk,position);position+=chunk.length;}
      const usage=inspectOutput(bytes,stream,prepared.maxOutput,prepared.reserved);
      await authorize(db,binding,prepared.model);signal.throwIfAborted();
      await db.query("UPDATE platform_model_relay_requests SET status='succeeded',input_tokens=$2,output_tokens=$3,finished_at=now() WHERE id=$1",[auditId,usage.input,usage.output]);
      return new Response(bytes,{status:200,headers:{'Content-Type':contentType,'Cache-Control':'no-store'}});
    }catch(error){
      await upstream?.body?.cancel().catch(()=>{});
      const safe=error instanceof ApiError?error:new ApiError(502,'MODEL_RELAY_UNCERTAIN','The provider result could not be confirmed. Review before retrying.');
      await db.query("UPDATE platform_model_relay_requests SET status=$2,error_code=$3,finished_at=now() WHERE id=$1",[auditId,!attempted||safe.code==='MODEL_RELAY_PROVIDER_REJECTED'?'failed':'uncertain',safe.code]).catch(()=>{});
      throw safe;
    }finally{clearInterval(heartbeat);}
  };
}
