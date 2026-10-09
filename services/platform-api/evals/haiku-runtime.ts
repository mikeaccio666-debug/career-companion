import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { chatInstructions,ProviderError } from '@companion/ai-core';
import { parseModelCallUsage,type PlatformProviderRuntime,type ModelCallUsage,type ModelCallEvent,type ModelStepResult } from '@companion/platform-contracts';

const unavailable=()=>new ProviderError('PROVIDER_STREAM_INTERRUPTED','The isolated Haiku response could not be confirmed.',502);
function validCount(value:unknown):value is number{return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&!Object.is(value,-0)&&value<=2147483647;}
/** Claude input_tokens excludes cached input. Never treat an absent breakdown
 * as measured zero, or reasoning output as free. */
export function haikuUsage(usage:Anthropic.Usage):ModelCallUsage{
 const {input_tokens:input,output_tokens:output,cache_creation_input_tokens:write,cache_read_input_tokens:read}=usage;
 if([input,output,write,read].some(v=>v===undefined||v===null))return {status:'missing'};
 if(!validCount(input)||!validCount(output)||!validCount(write)||!validCount(read))return {status:'invalid'};
 try{return parseModelCallUsage({status:'reported',inputTokens:input+write+read,outputTokens:output,cachedInputTokens:read,cacheWriteInputTokens:write});}
 catch{return {status:'invalid'};}
}
function mappedError(error:unknown,aborted:boolean){
 if(error instanceof ProviderError)return error;
 if(aborted)return new ProviderError('STREAM_CANCELLED','The isolated model call stopped.',499);
 if(error instanceof Anthropic.APIUserAbortError)return unavailable();
 if(error instanceof Anthropic.NotFoundError||error instanceof Anthropic.AuthenticationError||error instanceof Anthropic.PermissionDeniedError)return new ProviderError('PROVIDER_AUTH_FAILED','Check model access and credentials.',502);
 if(error instanceof Anthropic.RateLimitError)return new ProviderError('PROVIDER_RATE_LIMIT','The model service is rate limited.',429);
 if(error instanceof Anthropic.APIConnectionError)return new ProviderError('PROVIDER_UNREACHABLE','The model service could not be reached.',502);
 if(error instanceof Anthropic.APIError)return new ProviderError('PROVIDER_REJECTED','The model service rejected the request.',502);
 return unavailable();
}
/** Native SDK, fixed text-only evaluation route. This adapter has no account,
 * tool, continuation, structured-output or production admission capability. */
export function haikuPilotRuntime(key:string,fetch:typeof globalThis.fetch=globalThis.fetch):Pick<PlatformProviderRuntime,'streamModelStep'>{
 const client=new Anthropic({apiKey:key,authToken:null,baseURL:'https://api.anthropic.com',maxRetries:0,timeout:45000,logLevel:'off',
  fetch:async(url,init)=>{
   if(String(url)!=='https://api.anthropic.com/v1/messages'||init?.method!=='POST'||typeof init.body!=='string')throw unavailable();
   const body=JSON.parse(init.body);
   if(body.model!=='claude-haiku-5-5'||body.service_tier!=='standard_only'||body.inference_geo!=='global'||body.max_tokens!==2048||body.stream!==true||
    body.thinking?.type!=='adaptive'||body.output_config?.effort!=='low'||body.tools!==undefined||body.fallbacks!==undefined||body.cache_control!==undefined)throw unavailable();
   return fetch(url,{...init,redirect:'error'});
  }});
 return {
  async *streamModelStep(input,context){
   if(input.provider!=='anthropic'||input.model!=='claude-haiku-5-5'||input.mode!=='agent'||typeof input.persona!=='string'||
    input.attachments?.length||input.memories?.length||context.tools.length||context.allowedToolNames?.length||context.toolChoice!=='none'||
    context.continuation!==undefined||context.toolResults!==undefined||context.responseFormat!==undefined||context.requestAdmission!==undefined||
    context.callIndex!==1||!['companion_reply','expert_consult'].includes(context.purpose??'')||context.reasoningEffort!=='low'||
    context.limits.maxOutputTokens!==2048||!Number.isSafeInteger(context.timeoutMs)||context.timeoutMs<1||context.timeoutMs>45000||
    context.firstTokenTimeoutMs!==undefined&&(!Number.isSafeInteger(context.firstTokenTimeoutMs)||context.firstTokenTimeoutMs<1||context.firstTokenTimeoutMs>30000)||
    typeof context.onModelCall!=='function'||!input.messages.length||input.messages.length>200)throw new ProviderError('PROVIDER_UNSUPPORTED','Use the isolated text pilot configuration.',400);
   const messages:Anthropic.MessageParam[]=[],systemParts=[chatInstructions(input)];
   // The Messages API takes system instructions separately. Preserve all text;
   // do not disguise a system instruction as a user or assistant utterance.
   for(const message of input.messages){
    if(typeof message.content!=='string'||message.content.length>100000||message.attachments?.length)throw unavailable();
    if(message.role==='system')systemParts.push(message.content);
    else if(message.role==='user'||message.role==='assistant')messages.push({role:message.role,content:message.content});
    else throw unavailable();
   }
   if(messages[0]?.role!=='user'||messages.at(-1)?.role!=='user')throw unavailable();
   const system=systemParts.join('\n\n'),account=context.onModelCall,purpose=context.purpose,callId=randomUUID(),external=context.signal;
   const controller=new AbortController(),signal=external?AbortSignal.any([external,controller.signal]):controller.signal;
   let stream:ReturnType<typeof client.messages.stream>|undefined,started=false;
   let status:Extract<ModelCallEvent,{type:'finished'}>['status']='interrupted',usage:ModelCallUsage={status:'missing'},text='',bytes=0;
   let startSeen=false,stopSeen=false,finalUsageSeen=false;
   const timer=setTimeout(()=>controller.abort(),context.timeoutMs),firstTimer=context.firstTokenTimeoutMs===undefined?undefined:setTimeout(()=>controller.abort(),context.firstTokenTimeoutMs);
   try{
    signal.throwIfAborted();await account({type:'started',callId,index:1,provider:'anthropic',model:'claude-haiku-5-5',purpose});started=true;signal.throwIfAborted();
    stream=client.messages.stream({model:'claude-haiku-5-5',max_tokens:2048,system,messages,thinking:{type:'adaptive'},output_config:{effort:'low'},
     service_tier:'standard_only',inference_geo:'global'},{signal,maxRetries:0,timeout:context.timeoutMs});
    for await(const event of stream){
     signal.throwIfAborted();bytes+=Buffer.byteLength(JSON.stringify(event));if(bytes>2*1024*1024||stopSeen)throw unavailable();
     if(event.type==='message_start'){
      if(startSeen||event.message.model!=='claude-haiku-5-5'||event.message.role!=='assistant')throw unavailable();startSeen=true;
     }else if(event.type==='message_delta'){
      if(!startSeen||!validCount(event.usage.output_tokens))throw unavailable();
      if(typeof event.delta.stop_reason==='string')finalUsageSeen=true;
     }else if(event.type==='message_stop'){if(!startSeen||!finalUsageSeen)throw unavailable();stopSeen=true;}
     else if(event.type==='content_block_start'){
      const block=event.content_block;
      if(!['text','thinking','redacted_thinking'].includes(block.type))throw new ProviderError('PROVIDER_UNSUPPORTED','The text pilot cannot execute tools.',502);
      if(block.type==='text'&&block.text){text+=block.text;if(firstTimer)clearTimeout(firstTimer);yield {type:'delta',text:block.text};}
     }else if(event.type==='content_block_delta'&&event.delta.type==='text_delta'){
      if(!startSeen)throw unavailable();text+=event.delta.text;
      if(event.delta.text){if(firstTimer)clearTimeout(firstTimer);yield {type:'delta',text:event.delta.text};}
     }
    }
    const message:Anthropic.Message=await stream.finalMessage();
    if(!stopSeen||!finalUsageSeen||message.model!=='claude-haiku-5-5')throw unavailable();
    usage=haikuUsage(message.usage);
    if(message.usage.service_tier!=='standard'||message.usage.inference_geo!=='global'){usage={status:'invalid'};throw unavailable();}
    if(message.stop_reason==='max_tokens')throw new ProviderError('PROVIDER_OUTPUT_LIMIT','The model reached its output limit.',502);
    if(message.stop_reason!=='end_turn'||message.content.some(block=>!['text','thinking','redacted_thinking'].includes(block.type))||
     message.content.filter(block=>block.type==='text').map(block=>block.text).join('')!==text||!text.trim())throw unavailable();
    signal.throwIfAborted();status='complete';
    return {text,calls:[]} satisfies ModelStepResult;
   }catch(error){status=external?.aborted?'cancelled':signal.aborted?'interrupted':'failed';throw mappedError(error,external?.aborted??false);}
   finally{
    clearTimeout(timer);if(firstTimer)clearTimeout(firstTimer);stream?.abort();
    if(started)await account({type:'finished',callId,status:signal.aborted?(external?.aborted?'cancelled':'interrupted'):status,usage});
   }
  },
 };
}
