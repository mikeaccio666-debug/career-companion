import type { ProviderStatus } from '@companion/platform-contracts';
import { ProviderError } from './errors.ts';
import { browserFixtureOrigins } from './browser-origins.ts';
import { MEDIA_REFERENCE_MAX_IMAGES, MEDIA_REFERENCE_MAX_BYTES, MEDIA_REFERENCE_MIME_TYPES } from './media-input.ts';
import { kokoroConfiguration } from './kokoro.ts';
import { localTranscriptionConfiguration } from './local-transcription.ts';
import { openAISpeechVoiceOptions, openAIRealtimeVoiceOptions, kokoroVoiceOptions } from './voice-input.ts';
import { elevenLabsConfiguration } from './elevenlabs.ts';
import { configuredComfyUIOutputKind } from './comfyui-template.ts';
import { cliModelConfiguration } from './cli-model.ts';
export function providerStatuses(env:NodeJS.ProcessEnv):ProviderStatus[]{
  const paid=env.PLATFORM_ALLOW_PROVIDER_CALLS==='1';
  const commercial=(id:string,name:string,key:string,capabilities:ProviderStatus['capabilities'],modelKeys:string[],docs:string,extra=true):ProviderStatus=>{
    const configured=Boolean(env[key]);const models=modelKeys.map(k=>env[k]).filter((v):v is string=>Boolean(v));
    return {id,name,keyConfigured:configured,enabled:configured&&paid&&extra,capabilities,models,envVariables:[key,...modelKeys,'PLATFORM_ALLOW_PROVIDER_CALLS'],documentationUrl:docs,reason:!configured?'Configure this provider on the server.':!paid?'Provider calls are disabled for local verification.':!extra?'Configure an account-enabled model or endpoint on the server.':undefined};
  };
  let fixtureOrigins:string[]=[];
  try{fixtureOrigins=browserFixtureOrigins(env.PLATFORM_BROWSER_ALLOWED_ORIGINS);}catch{/* Invalid overrides are never advertised as safe origins. */}
  let kokoroConfigured=false;
  try{kokoroConfiguration(env);kokoroConfigured=true;}catch{/* Invalid or incomplete local configuration cannot enable speech. */}
  let localTranscriptionConfigured=false;
  try{localTranscriptionConfiguration(env);localTranscriptionConfigured=true;}catch{/* No probing or downloads for an absent or invalid local transcription service. */}
  let elevenLabs:ReturnType<typeof elevenLabsConfiguration>|undefined;
  try{elevenLabs=elevenLabsConfiguration(env);}catch{/* Invalid voice/model bindings never enable requests or appear in the public catalog. */}
  let cliModel:ReturnType<typeof cliModelConfiguration>|undefined;
  try{cliModel=cliModelConfiguration(env);}catch{/* Invalid local routes cannot enable the model relay. */}
  const comfyKind = configuredComfyUIOutputKind(env), comfyConfigured = Boolean(comfyKind&&env.COMFYUI_BASE_URL&&env.COMFYUI_WORKFLOW_TEMPLATE&&env.COMFYUI_PROMPT_NODE);
  const statuses:ProviderStatus[] = [
    commercial('openai','OpenAI','OPENAI_API_KEY',['chat','agent','image','speech','transcription','realtime'],['OPENAI_CHAT_MODEL','OPENAI_IMAGE_MODEL','OPENAI_REALTIME_MODEL'],'https://developers.openai.com/api/docs'),
    {id:'elevenlabs',name:'ElevenLabs',keyConfigured:Boolean(elevenLabs),enabled:Boolean(elevenLabs)&&paid,capabilities:['speech'],models:[],
      envVariables:['ELEVENLABS_API_KEY','ELEVENLABS_TTS_MODEL','ELEVENLABS_TTS_VOICE_ID','ELEVENLABS_ALLOW_PROVIDER_HISTORY','PLATFORM_ALLOW_PROVIDER_CALLS'],
      reason:!elevenLabs?'Configure an ElevenLabs key, supported model and server-reviewed voice on the server.':!paid?'Provider calls are disabled for local verification.':undefined,
      documentationUrl:'https://elevenlabs.io/docs/api-reference/text-to-speech/convert',
      ...(elevenLabs?{speechLanguages:['en','zh-CN'],voiceOptions:{speech:{voices:[elevenLabs.voice],defaultVoice:elevenLabs.voice,instructions:false}}}:{})},
    commercial('openrouter','OpenRouter','OPENROUTER_API_KEY',['chat','agent'],['OPENROUTER_CHAT_MODEL'],'https://openrouter.ai/docs',Boolean(env.OPENROUTER_CHAT_MODEL)),
    {id:'ollama',name:'Ollama · local',keyConfigured:Boolean(env.OLLAMA_BASE_URL&&env.OLLAMA_CHAT_MODEL),enabled:Boolean(env.OLLAMA_BASE_URL&&env.OLLAMA_CHAT_MODEL),capabilities:['chat','agent'],models:env.OLLAMA_CHAT_MODEL?[env.OLLAMA_CHAT_MODEL]:[],envVariables:['OLLAMA_BASE_URL','OLLAMA_CHAT_MODEL'],reason:env.OLLAMA_BASE_URL&&env.OLLAMA_CHAT_MODEL?undefined:'Connect a local Ollama server and an installed model.',documentationUrl:'https://docs.ollama.com/api/openai-compatibility'},
    {id:'kokoro',name:'Kokoro · local English',keyConfigured:kokoroConfigured,enabled:kokoroConfigured,capabilities:['speech'],speechLanguages:['en-US'],models:[],envVariables:['KOKORO_BASE_URL','KOKORO_TTS_MODEL','KOKORO_TTS_VOICE'],reason:kokoroConfigured?undefined:'Connect a literal loopback Kokoro service with kokoro-82m and af_heart for American English speech.',documentationUrl:'https://github.com/hexgrad/kokoro'},
    {id:'faster-whisper',name:'Faster Whisper · local',keyConfigured:localTranscriptionConfigured,enabled:localTranscriptionConfigured,capabilities:['transcription'],models:[],envVariables:['FASTER_WHISPER_BASE_URL','FASTER_WHISPER_MODEL'],reason:localTranscriptionConfigured?undefined:'Connect a literal loopback Faster Whisper service with whisper-tiny.',documentationUrl:'https://github.com/SYSTRAN/faster-whisper'},
    commercial('ark','Ark · Seedance','ARK_API_KEY',['chat','agent','video'],['ARK_CHAT_MODEL','ARK_VIDEO_MODEL'],'https://docs.volcengine.com/docs/ark',Boolean(env.ARK_CHAT_MODEL||env.ARK_VIDEO_MODEL)),
    commercial('fal','fal','FAL_KEY',['image','video'],['FAL_IMAGE_ENDPOINT','FAL_VIDEO_ENDPOINT'],'https://fal.ai/docs',Boolean(env.FAL_IMAGE_ENDPOINT||env.FAL_VIDEO_ENDPOINT)),
    {id:'comfyui',name:'ComfyUI · local',keyConfigured:comfyConfigured,enabled:comfyConfigured,capabilities:comfyKind?[comfyKind]:[],models:[],envVariables:['COMFYUI_BASE_URL','COMFYUI_WORKFLOW_TEMPLATE','COMFYUI_PROMPT_NODE','COMFYUI_PROMPT_FIELD','COMFYUI_OUTPUT_KIND'],reason:comfyConfigured?undefined:'Connect ComfyUI and a server-reviewed API workflow with an explicit output kind.',documentationUrl:'https://docs.comfy.org/development/comfyui-server/comms_routes'},
    {id:'browser',name:'Browser',keyConfigured:env.PLATFORM_ENABLE_BROWSER==='1',enabled:env.PLATFORM_ENABLE_BROWSER==='1',browserActionsEnabled:env.PLATFORM_ENABLE_BROWSER==='1'&&env.PLATFORM_ENABLE_BROWSER_ACTIONS==='1',browserFixtureOrigins:fixtureOrigins,capabilities:['browser'],models:[],envVariables:['PLATFORM_ENABLE_BROWSER','PLATFORM_ENABLE_BROWSER_ACTIONS'],reason:env.PLATFORM_ENABLE_BROWSER==='1'?undefined:'Browser tasks are disabled until a browser worker is configured.'},
    {id:'cli',name:'CLI harness',keyConfigured:Boolean(env.PLATFORM_CLI_IMAGE&&env.PLATFORM_CLI_COMMAND&&cliModel?.configured),enabled:env.PLATFORM_ENABLE_CLI==='1'&&env.PLATFORM_CLI_MODEL_RELAY==='1'&&Boolean(env.PLATFORM_CLI_IMAGE&&env.PLATFORM_CLI_COMMAND&&cliModel?.enabled),capabilities:['cli'],models:[],envVariables:['PLATFORM_ENABLE_CLI','PLATFORM_CLI_IMAGE','PLATFORM_CLI_COMMAND','PLATFORM_CLI_MODEL_RELAY','PLATFORM_CLI_MODEL','PLATFORM_CLI_MODEL_PROVIDER','PLATFORM_CLI_OLLAMA_BASE_URL','OLLAMA_CHAT_MODEL','OPENAI_API_KEY','PLATFORM_ALLOW_PROVIDER_CALLS'],reason:'Configure the isolated harness and its server model relay; every task needs user approval.'},
    {id:'workflow',name:'Workflow',keyConfigured:true,enabled:true,capabilities:['workflow'],models:[],envVariables:[]},
  ];
  const setModels=(id:string,mapping:ProviderStatus['modelsByCapability'])=>{const provider=statuses.find(item=>item.id===id)!;provider.modelsByCapability=mapping;provider.models=[...new Set(Object.values(mapping??{}).flat())];};
  setModels('openai',{chat:[env.OPENAI_CHAT_MODEL||'gpt-6-astra'],agent:[env.OPENAI_CHAT_MODEL||'gpt-6-astra'],image:[env.OPENAI_IMAGE_MODEL||'gpt-image-2.5-flare'],speech:[env.OPENAI_TTS_MODEL||'gpt-4o-mini-tts'],transcription:[env.OPENAI_TRANSCRIBE_MODEL||'gpt-transcribe'],realtime:[env.OPENAI_REALTIME_MODEL||'gpt-realtime-2.1']});
  const openai = statuses.find(provider => provider.id === 'openai')!;
  const safetyModel = env.OPENAI_SAFETY_CLASSIFY_MODEL;
  const generationModel = env.OPENAI_COMPANION_GENERATION_MODEL;
  const explicitModel = (value: string | undefined) => value && value.trim() === value && value.length <= 150 && !/[\x00-\x1f\x7f]/.test(value) ? [value] : [];
  // Keep an absent generation binding absent from the legacy public metadata.
  // Background requests still require the dedicated explicit value below.
  openai.modelsByPurpose = { safety_classify: explicitModel(safetyModel),
    ...(generationModel !== undefined ? { companion_generation: explicitModel(generationModel) } : {}) };
  openai.envVariables.push('OPENAI_SAFETY_CLASSIFY_MODEL', 'OPENAI_COMPANION_GENERATION_MODEL');
  setModels('elevenlabs',{speech:elevenLabs?[elevenLabs.model]:[]});
  setModels('openrouter',{chat:env.OPENROUTER_CHAT_MODEL?[env.OPENROUTER_CHAT_MODEL]:[],agent:env.OPENROUTER_CHAT_MODEL?[env.OPENROUTER_CHAT_MODEL]:[]});
  setModels('ollama',{chat:env.OLLAMA_CHAT_MODEL?[env.OLLAMA_CHAT_MODEL]:[],agent:env.OLLAMA_CHAT_MODEL?[env.OLLAMA_CHAT_MODEL]:[]});
  setModels('kokoro',{speech:kokoroConfigured?['kokoro-82m']:[]});
  setModels('faster-whisper',{transcription:localTranscriptionConfigured?['whisper-tiny']:[]});
  setModels('ark',{chat:env.ARK_CHAT_MODEL?[env.ARK_CHAT_MODEL]:[],agent:env.ARK_CHAT_MODEL?[env.ARK_CHAT_MODEL]:[],video:env.ARK_VIDEO_MODEL?[env.ARK_VIDEO_MODEL]:[]});
  setModels('fal',{image:env.FAL_IMAGE_ENDPOINT?[env.FAL_IMAGE_ENDPOINT]:[],video:env.FAL_VIDEO_ENDPOINT?[env.FAL_VIDEO_ENDPOINT]:[]});
  setModels('cli',{cli:cliModel?[cliModel.model]:[]});
  const references=(binding:'openai_edits'|'ark_video'|'fal_input')=>({maxImages:MEDIA_REFERENCE_MAX_IMAGES,maxTotalBytes:MEDIA_REFERENCE_MAX_BYTES,mimeTypes:[...MEDIA_REFERENCE_MIME_TYPES],binding});
  statuses.find(provider=>provider.id==='openai')!.referenceImages={image:references('openai_edits')};
  statuses.find(provider=>provider.id==='ark')!.referenceImages={video:references('ark_video')};
  statuses.find(provider=>provider.id==='fal')!.referenceImages={image:references('fal_input'),video:references('fal_input')};
  const speech=openAISpeechVoiceOptions(env.OPENAI_TTS_MODEL||'gpt-4o-mini-tts',env.OPENAI_TTS_VOICE),realtime=openAIRealtimeVoiceOptions(env.OPENAI_REALTIME_VOICE);
  statuses.find(provider=>provider.id==='openai')!.voiceOptions={...(speech?{speech}:{}),...(realtime?{realtime}:{})};
  statuses.find(provider=>provider.id==='kokoro')!.voiceOptions={speech:kokoroVoiceOptions()};
  return statuses;
}
export function requireProvider(env:NodeJS.ProcessEnv,id:string,capability:ProviderStatus['capabilities'][number]){
  const found=providerStatuses(env).find(p=>p.id===id);
  if(!found||!found.capabilities.includes(capability))throw new ProviderError('PROVIDER_UNSUPPORTED',`This provider does not support ${capability}.`,400);
  if(!found.enabled)throw new ProviderError('PROVIDER_NOT_CONFIGURED',found.reason||'Configure this provider on the server.',503);
}
export function localBase(value:string|undefined,fallback:string){
  const url=new URL(value||fallback);if(url.username||url.password||!['http:','https:'].includes(url.protocol))throw new ProviderError('INVALID_PROVIDER_CONFIG','The server provider URL is invalid.',503);return url.toString().replace(/\/$/,'');
}
export function model(env:NodeJS.ProcessEnv,key:string,requested?:string,fallback?:string){const value=requested||env[key]||fallback;if(!value||value.length>160)throw new ProviderError('MODEL_NOT_CONFIGURED','Configure an account-enabled model on the server.',503);return value;}
