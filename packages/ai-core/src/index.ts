import type { ChatInput, ChatContext, CreateJobInput, JobExecutionContext, JobExecutionResult, PlatformProviderRuntime, VoiceSessionInput, ProviderAttachment, ComfyUITemplateSnapshot, SpeechInput, TranscriptionContext, Capability } from '@companion/platform-contracts';
import { HttpClient, type Fetch, type ResolveHost } from './http.ts';
import { providerStatuses, requireProvider } from './config.ts';
import { streamOpenAI, streamCompatible, streamModelStep, snapshotBackgroundChat, streamBackgroundChat } from './chat.ts';
import { generateOpenAIImage, generateArkVideo, generateFal, generateComfyUI, realtimeOpenAI, transcribeOpenAI, speechOpenAI } from './media.ts';
import { ProviderError, invalid } from './errors.ts';
import { executeBrowser, executeCli } from './executors.ts';
import { executeWorkflow } from './workflow.ts';
import { validateMediaJobInput } from './media-input.ts';
import { captureComfyUITemplate, checkComfyUIServer, validateComfyUITemplateSnapshot } from './comfyui-template.ts';
import { speechKokoro } from './kokoro.ts';
import { transcribeLocal } from './local-transcription.ts';
import { speechJobOptions } from './voice-input.ts';
import { speechElevenLabs } from './elevenlabs.ts';
export { parseExecutionTemplateBinding, validateComfyUITemplateSnapshot } from './comfyui-template.ts';
export { ProviderError } from './errors.ts';
export { cliModelConfiguration, OPENAI_CLI_ENDPOINT } from './cli-model.ts';
export { workflowHash, workflowDefinitionHash } from './workflow.ts';
export { validateMediaReferenceBinding, validateMediaJobInput, validateMediaReferenceImages, isArkSeedance25Model } from './media-input.ts';
export { parseBrowserTaskOptions, browserDefinitionHash } from './browser-actions.ts';

export interface RuntimeOptions { env?:NodeJS.ProcessEnv; fetch?:Fetch; resolveHost?:ResolveHost; }
function requireVoiceProvider(env:NodeJS.ProcessEnv,requested:string|undefined,capability:Extract<Capability,'speech'|'transcription'|'realtime'>){
  const provider=requested===undefined?'openai':requested;
  if(typeof provider!=='string'||!/^[a-z][a-z0-9_-]{0,99}$/.test(provider))invalid('Select a valid voice provider.');
  requireProvider(env,provider,capability);
  // A future catalog entry alone does not install an audio or WebRTC adapter.
  if(provider!=='openai'&&!(['kokoro','elevenlabs'].includes(provider)&&capability==='speech')&&!(provider==='faster-whisper'&&capability==='transcription'))throw new ProviderError('PROVIDER_UNSUPPORTED','No voice adapter is available for this provider.',400);
  return provider;
}
export function createProviderRuntime(options:RuntimeOptions={}):PlatformProviderRuntime{
  const env={...(options.env??process.env)};const http=new HttpClient(options.fetch??globalThis.fetch,options.resolveHost);
  let comfyuiTemplate: ComfyUITemplateSnapshot | undefined;
  try { comfyuiTemplate = captureComfyUITemplate(env); } catch { /* An invalid local template disables this provider without stopping the platform. */ }
  const runtime:PlatformProviderRuntime={
    capabilities:()=>providerStatuses(env).map(provider => provider.id === 'comfyui' ? { ...provider,
      enabled: Boolean(comfyuiTemplate), keyConfigured: Boolean(comfyuiTemplate), capabilities: comfyuiTemplate?.outputKind ? [comfyuiTemplate.outputKind] : [],
      ...(comfyuiTemplate ? { executionTemplate: { version: 1 as const, hash: comfyuiTemplate.hash }, reason: undefined } : { reason: 'Connect ComfyUI and a valid server-reviewed API workflow, then restart the services.' }),
    } : provider),
    captureComfyUITemplate() {
      if (!comfyuiTemplate) throw new ProviderError('INVALID_COMFYUI_TEMPLATE', 'Configure a valid server-reviewed ComfyUI API workflow, then restart the services.', 503);
      return structuredClone(comfyuiTemplate);
    },
    validateComfyUITemplate(snapshot, binding) {
      const checked=validateComfyUITemplateSnapshot(snapshot,binding);
      if(!comfyuiTemplate)throw new ProviderError('INVALID_COMFYUI_TEMPLATE','Configure a valid server-reviewed ComfyUI API workflow and output kind, then restart the services.',503);
      if(checked.outputKind!==comfyuiTemplate.outputKind)throw new ProviderError('COMFYUI_OUTPUT_KIND_MISMATCH','The reviewed generation template does not match the current output kind. Prepare a new reviewed task.',409);
      checkComfyUIServer(checked,env);
    },
    streamChat(input:ChatInput,context:ChatContext={}){
      if ('background' in context) {
        const saved = snapshotBackgroundChat(input,context);
        if (saved.input.provider !== 'openai') throw new ProviderError('PROVIDER_STRUCTURED_OUTPUT_UNAVAILABLE','No verified structured output adapter is available for this provider.',503);
        requireProvider(env,saved.input.provider,'chat');
        const configured = providerStatuses(env).find(provider => provider.id === 'openai')?.modelsByPurpose?.[saved.context.background!.purpose];
        if (!configured || configured.length !== 1) throw new ProviderError('PROVIDER_STRUCTURED_OUTPUT_UNAVAILABLE','Configure an explicit server model for this background purpose.',503);
        if (saved.input.model !== configured[0]) invalid('Background generation must use the configured server model.');
        return streamBackgroundChat(http,env,saved.input,saved.context);
      }
      requireProvider(env,input.provider,input.mode==='agent'?'agent':'chat');
      if(!input.messages.length||input.messages.length>200)invalid('A conversation must contain between 1 and 200 context messages.');
      return input.provider==='openai'?streamOpenAI(http,env,input,context):streamCompatible(http,env,input,context);
    },
    streamModelStep(input,context){
      const safety = context.purpose === 'safety_classify';
      if ((safety || context.responseFormat !== undefined) && input.provider !== 'openai') throw new ProviderError('PROVIDER_STRUCTURED_OUTPUT_UNAVAILABLE','No verified structured output adapter is available for this provider.',503);
      requireProvider(env,input.provider,context.tools.length?'agent':'chat');
      const status=providerStatuses(env).find(provider=>provider.id===input.provider);
      const configured=safety?status?.modelsByPurpose?.safety_classify:status?.modelsByCapability?.chat;
      if(safety&&(!configured||configured.length!==1))throw new ProviderError('PROVIDER_STRUCTURED_OUTPUT_UNAVAILABLE','Configure an explicit server safety classification model.',503);
      if(!configured||configured.length!==1||input.model!==configured[0])invalid('The model step must use the configured server model.');
      if(safety&&(!context.responseFormat||context.tools.length||context.toolChoice!=='none'||context.limits.maxOutputTokens>100||context.timeoutMs>1000||context.continuation!==undefined||context.toolResults!==undefined))invalid('Safety classification requires one bounded structured step without tools or continuation.');
      if(!input.messages.length||input.messages.length>200)invalid('A conversation must contain between 1 and 200 context messages.');
      if(safety||context.responseFormat!==undefined)return streamModelStep(http,env,{...input,messages:input.messages.map(message=>({...message}))},
        {...context,tools:[...context.tools],limits:{...context.limits},...(context.allowedToolNames?{allowedToolNames:[...context.allowedToolNames]}:{})});
      return streamModelStep(http,env,input,context);
    },
    async executeJob(input:CreateJobInput,context:JobExecutionContext):Promise<JobExecutionResult>{
      if(input.executionTemplate&&input.provider!=='comfyui')invalid('Only ComfyUI generation tasks use a server template version.');
      if(input.provider==='comfyui'){
        if(!comfyuiTemplate)throw new ProviderError('INVALID_COMFYUI_TEMPLATE','Configure a valid server-reviewed ComfyUI API workflow and output kind, then restart the services.',503);
        if(comfyuiTemplate.outputKind!==input.kind)throw new ProviderError('COMFYUI_OUTPUT_KIND_MISMATCH','The current generation template does not produce the requested media kind. Prepare a new reviewed task.',409);
      }
      if(input.provider==='comfyui'&&context.comfyuiTemplate&&input.executionTemplate){
        const saved=validateComfyUITemplateSnapshot(context.comfyuiTemplate,input.executionTemplate);
        if(saved.outputKind!==input.kind)throw new ProviderError('COMFYUI_OUTPUT_KIND_MISMATCH','The reviewed generation template does not produce the requested media kind. Prepare a new reviewed task.',409);
      }
      requireProvider(env,input.provider,input.kind);context.signal?.throwIfAborted();
      if(!input.prompt||input.prompt.length>20_000)invalid('A task prompt must contain between 1 and 20000 characters.');
      if(input.kind==='workflow'&&input.provider==='workflow')return executeWorkflow(runtime,input,context);
      if(input.kind==='image'||input.kind==='video')validateMediaJobInput(input);
      if(input.provider==='browser'&&input.kind==='browser')return executeBrowser(input,context,env);
      if(input.provider==='cli'&&input.kind==='cli')return executeCli(input,context,env);
      if(input.provider==='openai'&&input.kind==='image')return generateOpenAIImage(http.withAdmission(context.requestAdmission),env,input,context);
      if(input.kind==='speech'){
        return {artifacts:[await runtime.speech({provider:input.provider,text:input.prompt,model:input.model,...speechJobOptions(input.options)},{signal:context.signal,requestAdmission:context.requestAdmission})]};
      }
      if(input.provider==='ark'&&input.kind==='video')return generateArkVideo(http.withAdmission(context.requestAdmission),env,input,context);
      if(input.provider==='fal'&&['image','video'].includes(input.kind))return generateFal(http.withAdmission(context.requestAdmission),env,input,context);
      if(input.provider==='comfyui')return generateComfyUI(http.withAdmission(context.requestAdmission),env,input,context);
      throw new ProviderError('PROVIDER_UNSUPPORTED','No executor is available for this task.',400);
    },
    async createVoiceSession(input:VoiceSessionInput={},context={}){requireVoiceProvider(env,input.provider,'realtime');return realtimeOpenAI(http.withAdmission(context.requestAdmission),env,input,context.signal);},
    async transcribe(input:ProviderAttachment,context:TranscriptionContext={}){const provider=requireVoiceProvider(env,context.provider,'transcription');return provider==='faster-whisper'?transcribeLocal(http.withAdmission(context.requestAdmission),env,input,context):transcribeOpenAI(http.withAdmission(context.requestAdmission),env,input,context.signal);},
    async speech(input:SpeechInput,context={}){const provider=requireVoiceProvider(env,input.provider,'speech');
      if(provider==='elevenlabs')return speechElevenLabs(http.withAdmission(context.requestAdmission),env,input,context.signal);
      return provider==='kokoro'?speechKokoro(http.withAdmission(context.requestAdmission),env,input,context.signal):speechOpenAI(http.withAdmission(context.requestAdmission),env,input,context.signal);},
  };return runtime;
}

export { ProviderAdapter, runAgentLoop } from './agent-loop.ts';

export { chatInstructions } from './chat-instructions.ts';
