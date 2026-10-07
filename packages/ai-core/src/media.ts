import { isIP } from 'node:net';
import type { CreateJobInput, GeneratedArtifact, JobExecutionContext, JobExecutionResult, ProviderAttachment, SpeechInput, VoiceSessionInput, VoiceSessionResult } from '@companion/platform-contracts';
import { HttpClient, jsonPost, readBytes, waitPoll } from './http.ts';
import { model, localBase } from './config.ts';
import { ProviderError, invalid } from './errors.ts';
import { mediaImageMime, validateMediaJobInput, validateMediaReferenceImages, validateMediaReferenceBinding, validateArkModelOptions, openAIImageSize } from './media-input.ts';
import { checkComfyUIServer, validateComfyUITemplateSnapshot } from './comfyui-template.ts';
import { validatedComfyOutput } from './comfyui-output.ts';
import { validateSpeechInput, openAISpeechParameters, openAIRealtimeParameters } from './voice-input.ts';
export { validateMediaReferenceBinding } from './media-input.ts';

function str(value:unknown){return typeof value==='string'?value:undefined;}
function safePathPart(value:unknown){if(typeof value!=='string'||!/^[a-zA-Z0-9_.-]{1,200}$/.test(value)||value==='..')throw new ProviderError('INVALID_PROVIDER_RESPONSE','The provider returned an invalid task or file identifier.');return value;}
function artifact(name:string,mime:string,bytes:Uint8Array):GeneratedArtifact{return {name,mime,bytes};}
function base64(value:unknown){if(typeof value!=='string'||!value.length||value.length>140*1024*1024||!/^[a-zA-Z0-9+/=\s]+$/.test(value))throw new ProviderError('INVALID_PROVIDER_RESPONSE','The provider returned invalid image data.');return new Uint8Array(Buffer.from(value,'base64'));}
async function privateReferences(input:CreateJobInput,ctx:JobExecutionContext):Promise<ProviderAttachment[]>{
  validateMediaJobInput(input);const refs:ProviderAttachment[]=[];
  if(input.attachmentIds?.length&&!ctx.readAttachment)invalid('Attachment storage is unavailable.');
  for(const id of input.attachmentIds??[]){ctx.signal?.throwIfAborted();refs.push(await ctx.readAttachment!(id));validateMediaReferenceImages(refs);}ctx.signal?.throwIfAborted();
  return refs;
}
async function privateReferenceImages(input:CreateJobInput,ctx:JobExecutionContext){
  return (await privateReferences(input,ctx)).map(ref=>`data:${ref.mime};base64,${Buffer.from(ref.bytes).toString('base64')}`);
}
function imageArtifact(bytes:Uint8Array,index:number,declaredMime?:unknown):GeneratedArtifact{
  const mime=mediaImageMime(bytes);
  if(!mime||declaredMime!==undefined&&(typeof declaredMime!=='string'||declaredMime.split(';',1)[0].trim().toLowerCase()!==mime))throw new ProviderError('INVALID_PROVIDER_RESPONSE','The provider returned unsupported image bytes or inconsistent image metadata.');
  const extension=mime==='image/jpeg'?'jpg':mime==='image/webp'?'webp':'png';
  return artifact(`image-${index+1}.${extension}`,mime,bytes);
}
function blob(item:ProviderAttachment){return new Blob([new Uint8Array(item.bytes)],{type:item.mime});}
export async function generateOpenAIImage(http:HttpClient,env:NodeJS.ProcessEnv,input:CreateJobInput,ctx:JobExecutionContext):Promise<JobExecutionResult>{
  validateMediaJobInput(input);const options=input.options??{};
  const selected=model(env,'OPENAI_IMAGE_MODEL',input.model,'gpt-image-2.5-flare'),size=openAIImageSize(selected,options.aspectRatio),refs=await privateReferences(input,ctx);let result:any;
  if(refs.length){const form=new FormData();form.append('model',selected);form.append('prompt',input.prompt);form.append('size',size);for(const [index,ref] of refs.entries()){const ext=ref.mime==='image/jpeg'?'jpg':ref.mime==='image/webp'?'webp':'png';form.append('image[]',blob(ref),`reference-${index+1}.${ext}`);}result=await http.json('https://api.openai.com/v1/images/edits',{method:'POST',headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`},body:form,signal:ctx.signal},32*1024*1024);}
  else result=await http.json('https://api.openai.com/v1/images/generations',jsonPost({model:selected,prompt:input.prompt,size,n:1},env.OPENAI_API_KEY!,ctx.signal),32*1024*1024);
  if(!Array.isArray(result.data)||!result.data.length)throw new ProviderError('INVALID_PROVIDER_RESPONSE','The provider returned no generated image.');
  return {artifacts:result.data.slice(0,4).map((image:any,index:number)=>imageArtifact(base64(image.b64_json),index,'image/png'))};
}
export async function transcribeOpenAI(http:HttpClient,env:NodeJS.ProcessEnv,input:ProviderAttachment,signal?:AbortSignal){
  if(!input.mime.startsWith('audio/')&&!['video/mp4','video/webm','application/octet-stream'].includes(input.mime))invalid('Upload an audio recording.');
  if(input.bytes.byteLength>25*1024*1024)invalid('The recording exceeds the 25 MB transcription limit.');
  const form=new FormData();form.append('model',model(env,'OPENAI_TRANSCRIBE_MODEL',undefined,'gpt-transcribe'));form.append('file',blob(input),input.name);
  const result=await http.json('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`},body:form,signal});
  if(typeof result.text!=='string')throw new ProviderError('INVALID_PROVIDER_RESPONSE','The transcription provider returned no text.');return {text:result.text};
}
export async function speechOpenAI(http:HttpClient,env:NodeJS.ProcessEnv,input:SpeechInput,signal?:AbortSignal):Promise<GeneratedArtifact>{
  validateSpeechInput(input);
  const selected=model(env,'OPENAI_TTS_MODEL',input.model,'gpt-4o-mini-tts'),parameters=openAISpeechParameters(input,selected,env.OPENAI_TTS_VOICE);
  const response=await http.request('https://api.openai.com/v1/audio/speech',jsonPost({model:selected,input:input.text,...parameters,response_format:'mp3'},env.OPENAI_API_KEY!,signal));
  return artifact('speech.mp3','audio/mpeg',await readBytes(response,30*1024*1024));
}
export async function realtimeOpenAI(http:HttpClient,env:NodeJS.ProcessEnv,input:VoiceSessionInput={},signal?:AbortSignal):Promise<VoiceSessionResult>{
  const parameters=openAIRealtimeParameters(input,env.OPENAI_REALTIME_VOICE);
  const selected=model(env,'OPENAI_REALTIME_MODEL',input.model,'gpt-realtime-2.1');
  const transcription=env.OPENAI_REALTIME_TRANSCRIBE_MODEL;
  if(transcription==='gpt-transcribe')invalid('Select a WebRTC-compatible input transcription model; gpt-transcribe committed-turn transcription requires WebSocket.');
  const audio={output:{voice:parameters.voice},...(transcription||parameters.turnDetection?{input:{...(transcription?{transcription:{model:transcription}}:{}),...(parameters.turnDetection?{turn_detection:parameters.turnDetection}:{})}}:{})};
  let result:any;
  try{
    result=await http.json('https://api.openai.com/v1/realtime/client_secrets',jsonPost({session:{type:'realtime',model:selected,instructions:input.persona||'Have a clear, helpful conversation with the user.',audio}},env.OPENAI_API_KEY!,signal));
    if(signal?.aborted)throw new ProviderError('PROVIDER_INTERRUPTED','The voice-session request was interrupted.');
  }catch(error){if(signal?.aborted)throw new ProviderError('PROVIDER_INTERRUPTED','The voice-session request was interrupted.');throw error;}
  const secret=result.value??result.client_secret?.value;if(typeof secret!=='string'||!secret)throw new ProviderError('INVALID_PROVIDER_RESPONSE','The provider returned no temporary voice credential.');
  return {clientSecret:secret,model:selected,endpoint:'https://api.openai.com/v1/realtime/calls',expiresAt:result.expires_at??result.client_secret?.expires_at,inputTranscriptionEnabled:Boolean(transcription)};
}
function privateAddress(address:string){
  if(isIP(address)===4){const [a,b]=address.split('.').map(Number);return a===0||a===10||a===127||a===169&&b===254||a===172&&b!>=16&&b!<=31||a===192&&b===168||a===100&&b!>=64&&b!<=127||a!>=224;}
  const low=address.toLowerCase();return low==='::'||low==='::1'||low.startsWith('fc')||low.startsWith('fd')||low.startsWith('fe8')||low.startsWith('fe9')||low.startsWith('fea')||low.startsWith('feb')||low.startsWith('::ffff:');
}
export async function downloadMedia(http:HttpClient,env:NodeJS.ProcessEnv,urlValue:unknown,name:string,mime:string,signal?:AbortSignal):Promise<GeneratedArtifact>{
  if(typeof urlValue!=='string')throw new ProviderError('INVALID_PROVIDER_RESPONSE','The provider returned no media URL.');let url:URL;try{url=new URL(urlValue);}catch{throw new ProviderError('INVALID_PROVIDER_RESPONSE','The provider returned an invalid media URL.');}
  const allowed=['fal.media','volces.com','volccdn.com','byteimg.com','bytescm.com','higgsfield.ai',...(env.PLATFORM_PROVIDER_MEDIA_HOSTS||'').split(',').map(x=>x.trim()).filter(Boolean)];
  if(url.protocol!=='https:'||url.username||url.password||isIP(url.hostname)||!allowed.some(host=>url.hostname===host||url.hostname.endsWith(`.${host}`)))throw new ProviderError('UNTRUSTED_MEDIA_URL','The provider returned a media host that is not allowed. Configure verified CDN hosts on the server.');
  const addresses=await http.resolveHost(url.hostname);if(!addresses.length||addresses.some(item=>privateAddress(item.address)))throw new ProviderError('UNTRUSTED_MEDIA_URL','The provider media URL resolves to a restricted network.');
  // Known provider CDN domains only, redirects disabled. Production workers also require an outbound network policy.
  const response=await http.request(url,{signal});return artifact(name,mime,await readBytes(response));
}
function pollConfig(env:NodeJS.ProcessEnv){return {interval:Math.max(50,Math.min(10_000,Number(env.PLATFORM_POLL_INTERVAL_MS)||2000)),attempts:Math.max(1,Math.min(1800,Number(env.PLATFORM_POLL_ATTEMPTS)||600))};}
export async function generateArkVideo(http:HttpClient,env:NodeJS.ProcessEnv,input:CreateJobInput,ctx:JobExecutionContext):Promise<JobExecutionResult>{
  const base=localBase(env.ARK_BASE_URL,'https://ark.cn-beijing.volces.com/api/v3');const endpoint=`${base}/contents/generations/tasks`;let id=ctx.previousProviderTaskId;
  if(!id){const options=input.options??{},selected=model(env,'ARK_VIDEO_MODEL',input.model);validateMediaJobInput(input);validateArkModelOptions(selected,options,input.attachmentIds?.length??0);const refs=await privateReferenceImages(input,ctx);
    validateMediaReferenceBinding('ark','video',options,refs.length);
    const referenceMode=options.referenceMode??(refs.length===1?'first_frame':refs.length===2?'first_last_frame':'reference_image');
    const content:Record<string,unknown>[]=[{type:'text',text:input.prompt}];
    refs.forEach((url,index)=>content.push({type:'image_url',image_url:{url},role:referenceMode==='first_last_frame'?(index===0?'first_frame':'last_frame'):referenceMode}));
    const body:Record<string,unknown>={model:selected,content};
    if(options.aspectRatio!==undefined)body.ratio=options.aspectRatio;
    if(options.duration!==undefined)body.duration=options.duration;
    if(options.seed!==undefined)body.seed=options.seed;
    if(options.resolution!==undefined)body.resolution=options.resolution;
    const result=await http.json(endpoint,jsonPost(body,env.ARK_API_KEY!,ctx.signal));id=safePathPart(result.id);await ctx.onProviderTask?.(id);
  } else safePathPart(id);
  const polling=pollConfig(env);
  for(let attempt=0;attempt<polling.attempts;attempt++){
    ctx.signal?.throwIfAborted();const task=await http.json(`${endpoint}/${id}`,{headers:{Authorization:`Bearer ${env.ARK_API_KEY}`},signal:ctx.signal});
    if(task.status==='succeeded'){const media=await downloadMedia(http,env,task.content?.video_url,'video.mp4','video/mp4',ctx.signal);return {artifacts:[media],providerTaskId:id};}
    if(['failed','cancelled','expired'].includes(task.status))throw new ProviderError('VIDEO_GENERATION_FAILED','The video provider failed or cancelled the task. Review the provider dashboard before starting another task.');
    if(!['queued','running'].includes(task.status))throw new ProviderError('INVALID_PROVIDER_RESPONSE','The video provider returned an unknown task status.');
    await ctx.onProgress?.(task.status==='queued'?10:Math.min(90,25+attempt));await waitPoll(polling.interval,ctx.signal);
  }
  throw new ProviderError('PROVIDER_TASK_PENDING','The provider task is still running. Retry this task to resume checking the same provider task.',504);
}
type FalHandle={id:string;status:string;response:string;cancel:string};
function falUrl(value:unknown){if(typeof value!=='string')throw new ProviderError('INVALID_PROVIDER_RESPONSE','fal returned an invalid queue URL.');const url=new URL(value);if(url.origin!=='https://queue.fal.run'||url.username||url.password)throw new ProviderError('INVALID_PROVIDER_RESPONSE','fal returned an untrusted queue URL.');return url.toString();}
function encodeFal(task:FalHandle){return `fal:${Buffer.from(JSON.stringify(task)).toString('base64url')}`;}
function decodeFal(value:string):FalHandle{try{const task=JSON.parse(Buffer.from(value.slice(4),'base64url').toString());safePathPart(task.id);return {id:task.id,status:falUrl(task.status),response:falUrl(task.response),cancel:falUrl(task.cancel)};}catch{throw new ProviderError('INVALID_PROVIDER_TASK','The saved fal task cannot be resumed.',409);}}
export async function generateFal(http:HttpClient,env:NodeJS.ProcessEnv,input:CreateJobInput,ctx:JobExecutionContext):Promise<JobExecutionResult>{
  const selected=model(env,input.kind==='video'?'FAL_VIDEO_ENDPOINT':'FAL_IMAGE_ENDPOINT',input.model);
  if(!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_/-]+$/.test(selected)||selected.includes('..'))invalid('Configure a valid fal model endpoint.');
  let task:FalHandle;
  if(ctx.previousProviderTaskId){if(!ctx.previousProviderTaskId.startsWith('fal:'))invalid('The saved task belongs to another provider.');task=decodeFal(ctx.previousProviderTaskId);}
  else{const options=input.options??{};const supplied=options.input;if(supplied!==undefined&&(!supplied||typeof supplied!=='object'||Array.isArray(supplied)))invalid('fal input must be an object matching the selected model schema.');
    // Model-specific fields belong under options.input. Never forward internal task metadata or a provider URL supplied by a client.
    const body:Record<string,unknown>={...(supplied as Record<string,unknown>??{}),prompt:input.prompt};
    const refs=await privateReferenceImages(input,ctx),field=options.referenceField??'image_url';
    validateMediaReferenceBinding('fal',input.kind,options,refs.length);
    if(refs.length)body[String(field)]=field==='image_urls'?refs:refs[0];
    const encoded=JSON.stringify(body);if(Buffer.byteLength(encoded)>32*1024*1024)invalid('The media request exceeds its delivery size limit.');
    const result=await http.json(`https://queue.fal.run/${selected}`,{method:'POST',headers:{Authorization:`Key ${env.FAL_KEY}`,'Content-Type':'application/json','X-Fal-No-Retry':'1'},body:encoded,signal:ctx.signal});
    task={id:safePathPart(result.request_id),status:falUrl(result.status_url),response:falUrl(result.response_url),cancel:falUrl(result.cancel_url)};await ctx.onProviderTask?.(encodeFal(task));}
  const headers={Authorization:`Key ${env.FAL_KEY}`};const polling=pollConfig(env);
  try{for(let attempt=0;attempt<polling.attempts;attempt++){
    const status=await http.json(task.status,{headers,signal:ctx.signal});if(status.status==='COMPLETED'){
      if(status.error)throw new ProviderError('MEDIA_GENERATION_FAILED','The media provider could not generate this result.');const result=await http.json(task.response,{headers,signal:ctx.signal});const artifacts:GeneratedArtifact[]=[];
      if(input.kind==='video')artifacts.push(await downloadMedia(http,env,result.video?.url,'video.mp4',result.video?.content_type||'video/mp4',ctx.signal));
      else{if(!Array.isArray(result.images)||!result.images.length)throw new ProviderError('INVALID_PROVIDER_RESPONSE','The image provider returned no images.');for(const [index,item]of result.images.slice(0,4).entries()){const downloaded=await downloadMedia(http,env,item.url,'image','application/octet-stream',ctx.signal);artifacts.push(imageArtifact(downloaded.bytes,index,item.content_type));}}
      return {artifacts,providerTaskId:encodeFal(task)};
    }
    if(!['IN_QUEUE','IN_PROGRESS'].includes(status.status))throw new ProviderError('INVALID_PROVIDER_RESPONSE','The media provider returned an unknown task status.');await ctx.onProgress?.(status.status==='IN_QUEUE'?10:Math.min(90,25+attempt));await waitPoll(polling.interval,ctx.signal);
  }}catch(error){if(ctx.signal?.aborted)await http.json(task.cancel,{method:'PUT',headers,signal:AbortSignal.timeout(5000)}).catch(()=>{});throw error;}
  throw new ProviderError('PROVIDER_TASK_PENDING','The provider task is still running. Retry this task to resume checking the same provider task.',504);
}
export async function generateComfyUI(http:HttpClient,env:NodeJS.ProcessEnv,input:CreateJobInput,ctx:JobExecutionContext):Promise<JobExecutionResult>{
  if(input.attachmentIds?.length)invalid('This ComfyUI template does not bind uploaded references.');
  if(input.model)invalid('The ComfyUI model is part of its server-reviewed template.');
  if(!ctx.comfyuiTemplate||!input.executionTemplate)throw new ProviderError('COMFYUI_TEMPLATE_UNBOUND','This task has no saved generation template version. Prepare a new reviewed task.',409);
  const snapshot=validateComfyUITemplateSnapshot(ctx.comfyuiTemplate,input.executionTemplate);checkComfyUIServer(snapshot,env);
  if(snapshot.outputKind!==input.kind)throw new ProviderError('COMFYUI_OUTPUT_KIND_MISMATCH','The reviewed generation template does not produce the requested media kind. Prepare a new reviewed task.',409);
  const base=snapshot.baseUrl;let id=ctx.previousProviderTaskId;
  if(!id){const template=structuredClone(snapshot.graph) as Record<string,{inputs:Record<string,unknown>}>;
    template[snapshot.promptNode].inputs[snapshot.promptField]=input.prompt;
    try {
      const response=await http.json(`${base}/prompt`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:template,client_id:ctx.jobId}),signal:ctx.signal});
      if(response.error)throw new ProviderError('COMFYUI_REJECTED','ComfyUI rejected the configured workflow.');
      id=safePathPart(response.prompt_id);await ctx.onProviderTask?.(id);
    } catch(error) {
      if(error instanceof ProviderError&&error.code==='COMFYUI_REJECTED')throw error;
      // A response or durable handle ACK can be lost after ComfyUI accepted the graph.
      // No automatic second POST is safe until the queued result is reconciled.
      throw new ProviderError('COMFYUI_SUBMISSION_UNCERTAIN','The generation request may have been accepted but its saved task was not confirmed. Review the server queue before starting another request.',409);
    }
  }else safePathPart(id);
  const polling=pollConfig(env);
  for(let attempt=0;attempt<polling.attempts;attempt++){
    const history=await http.json(`${base}/history/${id}`,{signal:ctx.signal});const result=history[id!];
    if(result){if(result.status?.status_str==='error')throw new ProviderError('COMFYUI_FAILED','The ComfyUI workflow failed.');if(result.status?.completed){const artifacts:GeneratedArtifact[]=[];
      const outputs=result.outputs===undefined?{}:result.outputs;
      if(!outputs||typeof outputs!=='object'||Array.isArray(outputs))throw new ProviderError('COMFYUI_OUTPUT_INVALID','The generation server returned invalid output metadata.');
      // Stock PreviewVideo uses images for MP4/WebM. In that collection, the extension
      // only selects download candidates; the actual bytes and HTTP MIME must match.
      // Other video nodes use videos/gifs. Poster images are never downloaded for video.
      for(const output of Object.values(outputs) as any[]){
        if(!output||typeof output!=='object'||Array.isArray(output))throw new ProviderError('COMFYUI_OUTPUT_INVALID','The generation server returned invalid output metadata.');
        const selected=snapshot.outputKind==='image'?[[output.images,false] as const]:[[output.videos,false] as const,[output.gifs,false] as const,[output.images,true] as const];
        for(const [list,videoImages] of selected){
          if(list===undefined)continue;
          if(!Array.isArray(list))throw new ProviderError('COMFYUI_OUTPUT_INVALID','The generation server returned invalid output metadata.');
          for(const item of list){
            if(artifacts.length>=8)break;
            if(!item||typeof item!=='object'||Array.isArray(item))throw new ProviderError('COMFYUI_OUTPUT_INVALID','The generation server returned invalid output metadata.');
            if(item.type!=='output')continue;
            if(videoImages){
              if(typeof item.filename!=='string')throw new ProviderError('COMFYUI_OUTPUT_INVALID','The generation server returned invalid output metadata.');
              if(!/\.(?:mp4|webm)$/i.test(item.filename))continue;
            }
            const name=safePathPart(item.filename);
            const query=new URLSearchParams({filename:name,subfolder:typeof item.subfolder==='string'?item.subfolder:'',type:'output'});
            if(query.get('subfolder')?.includes('..'))throw new ProviderError('INVALID_PROVIDER_RESPONSE','ComfyUI returned an invalid output path.');
            const response=await http.request(`${base}/view?${query}`,{signal:ctx.signal});
            artifacts.push(validatedComfyOutput(snapshot.outputKind,await readBytes(response),response.headers.get('content-type'),artifacts.length));
          }
        }
      }
      if(!artifacts.length)throw new ProviderError('COMFYUI_NO_OUTPUT','The configured workflow produced no supported media output.');return {artifacts,providerTaskId:id};
    }}
    await ctx.onProgress?.(Math.min(90,10+attempt));await waitPoll(polling.interval,ctx.signal);
  }
  throw new ProviderError('PROVIDER_TASK_PENDING','The ComfyUI task is still running. Retry this task to resume checking the same task.',504);
}
