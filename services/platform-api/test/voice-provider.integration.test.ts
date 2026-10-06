import { PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PlatformProviderRuntime, ProviderStatus, SpeechInput, VoiceSessionInput } from '@companion/platform-contracts';
import { buildApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { Database } from '../src/database.ts';
import { ApiError } from '../src/errors.ts';

const prefix='/api/platform',origin='http://localhost:4321';
const base=readConfig(),schema=`voice_provider_test_${randomUUID().replaceAll('-','')}`,admin=new Database(base.databaseUrl);
const databaseUrl=new URL(base.databaseUrl);databaseUrl.searchParams.set('options',`-c search_path=${schema}`);
const db=new Database(databaseUrl.toString());
let system:Awaited<ReturnType<typeof buildApp>>,directory:string,actorCount=0;
let failSelected=false;
const calls:Array<{kind:string;provider:string;input:unknown}>=[];
const providers:ProviderStatus[]=[
  {id:'openai',name:'Synthetic default voice',enabled:true,keyConfigured:true,capabilities:['speech','transcription','realtime'],models:['synthetic-openai-confirmed'],envVariables:[]},
  {id:'fixture-voice',name:'Synthetic explicit voice',enabled:true,keyConfigured:true,capabilities:['speech','transcription','realtime'],models:['synthetic-explicit-confirmed'],envVariables:[]},
  {id:'ollama',name:'Synthetic text-only local provider',enabled:true,keyConfigured:true,capabilities:['chat','agent'],models:['synthetic-text'],envVariables:[]},
  {id:'disabled-voice',name:'Synthetic disabled voice',enabled:false,keyConfigured:true,capabilities:['speech','transcription','realtime'],models:[],envVariables:[]},
  {id:'speech-only',name:'Synthetic speech-only provider',enabled:true,keyConfigured:true,capabilities:['speech'],models:[],envVariables:[]},
  {id:'kokoro',name:'Synthetic Kokoro speech-only adapter',enabled:true,keyConfigured:true,capabilities:['speech'],models:['kokoro'],modelsByCapability:{speech:['kokoro']},speechLanguages:['en-US'],envVariables:[]},
  {id:'faster-whisper',name:'Synthetic faster-whisper transcription-only adapter',enabled:true,keyConfigured:true,capabilities:['transcription'],models:['whisper-tiny'],modelsByCapability:{transcription:['whisper-tiny']},envVariables:[]},
];
function wav(size=92){const bytes=Buffer.alloc(size);bytes.write('RIFF',0);bytes.writeUInt32LE(size-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(24000,24);bytes.writeUInt32LE(48000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(size-44,40);return bytes;}
async function record(kind:string,provider:string,input:unknown){
  assert.equal((await db.query("SELECT id FROM platform_runtime_leases WHERE kind='voice'")).rowCount,1,'Provider calls require an active voice lease.');
  calls.push({kind,provider,input});
  if(failSelected&&provider==='fixture-voice')throw new ApiError(502,'SYNTHETIC_SELECTED_PROVIDER_FAILED','The selected synthetic provider failed.');
}
const runtime:PlatformProviderRuntime={
  capabilities:()=>providers,
  async *streamChat(){throw new Error('This fixture never calls a chat model.');},
  async executeJob(){throw new Error('This fixture never executes jobs.');},
  async createVoiceSession(input:VoiceSessionInput={}){const provider=input.provider??'openai';await record('realtime',provider,input);return {clientSecret:'synthetic-ephemeral-not-persisted',model:provider==='openai'?'synthetic-openai-confirmed':'synthetic-explicit-confirmed',endpoint:'https://synthetic-provider.invalid/calls'};},
  async transcribe(input,context){const provider=context?.provider??'openai';await record('transcription',provider,{name:input.name,mime:input.mime,bytes:input.bytes.byteLength});return {text:provider==='faster-whisper'&&input.name==='synthetic-silence.wav'?'':`Synthetic ${provider} transcript`};},
  async speech(input:SpeechInput){const provider=input.provider??'openai';await record('speech',provider,input);return {name:'synthetic.wav',mime:'audio/wav',bytes:wav()};},
};
before(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);await db.migrate();directory=await fs.mkdtemp(path.join(os.tmpdir(),'companion-voice-provider-'));
  system=await buildApp({db,config:{...base,databaseUrl:databaseUrl.toString(),storageDir:directory,s3:undefined},runtime,enableQueue:false});
});
after(async()=>{await system?.app.close();await db.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();if(directory)await fs.rm(directory,{recursive:true,force:true});});
interface Actor{user:{id:string};cookie:string;ip:string;}
async function register():Promise<Actor>{
  const ip=`127.8.0.${++actorCount}`;
  const response=await system.app.inject({method:'POST',url:prefix+'/auth/register',remoteAddress:ip,headers:{origin},payload:{name:'Synthetic provider-routing tester',email:`voice-provider-${randomUUID()}@example.invalid`,password:'Synthetic-password-123'}});
  assert.equal(response.statusCode,201,response.body);return {user:response.json().user,cookie:(response.headers['set-cookie'] as string).split(';')[0],ip};
}
async function request(actor:Actor,route:string,payload:Record<string,unknown>){return system.app.inject({method:'POST',url:prefix+route,remoteAddress:actor.ip,headers:{origin,cookie:actor.cookie, [PLATFORM_ACCOUNT_HEADER]: actor.user.id},payload});}
type Part={name:string;value:string;mime?:string}|{name:string;bytes:Buffer;filename?:string;mime?:string};
async function multipart(actor:Actor,parts:Part[],route='/voice/transcribe'){
  const boundary=`synthetic-voice-${randomUUID()}`,chunks:Buffer[]=[];
  for(const part of parts){
    const file='bytes' in part;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${file?`; filename="${part.filename??'synthetic.wav'}"`:''}\r\n${part.mime||file?`Content-Type: ${part.mime??'audio/wav'}\r\n`:''}\r\n`));
    chunks.push(file?part.bytes:Buffer.from(part.value));chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return system.app.inject({method:'POST',url:prefix+route,remoteAddress:actor.ip,headers:{origin,cookie:actor.cookie, [PLATFORM_ACCOUNT_HEADER]: actor.user.id,'content-type':`multipart/form-data; boundary=${boundary}`},payload:Buffer.concat(chunks)});
}
const audio:Part={name:'file',bytes:wav()};
async function state(actor:Actor){return {leases:(await db.query('SELECT count(*)::integer AS n FROM platform_runtime_leases WHERE user_id=$1',[actor.user.id])).rows[0].n,usage:(await db.query('SELECT count(*)::integer AS n FROM platform_usage WHERE user_id=$1',[actor.user.id])).rows[0].n,sessions:(await db.query('SELECT count(*)::integer AS n FROM platform_voice_sessions WHERE user_id=$1',[actor.user.id])).rows[0].n};}

test('unsupported and disabled voice capabilities are rejected before lease acquisition or usage writes',async()=>{
  const actor=await register(),leaseId=randomUUID(),beforeCalls=calls.length;
  await db.query("INSERT INTO platform_runtime_leases(id,user_id,kind,expires_at) VALUES($1,$2,'voice',now()+interval '2 minutes')",[leaseId,actor.user.id]);
  try{
    for(const provider of ['ollama','disabled-voice','unknown-provider']){
      for(const route of ['/voice/session','/voice/speech']){const result=await request(actor,route,{provider,...(route.endsWith('speech')?{text:'Synthetic script'}:{})});assert.equal(result.statusCode,503,result.body);assert.equal(result.json().error.code,'PROVIDER_UNAVAILABLE');}
      const transcript=await multipart(actor,[audio,{name:'provider',value:provider}]);assert.equal(transcript.statusCode,503,transcript.body);
    }
    assert.deepEqual(await state(actor),{leases:1,usage:0,sessions:0});assert.equal(calls.length,beforeCalls);
  }finally{await db.query('DELETE FROM platform_runtime_leases WHERE id=$1',[leaseId]);}
  const only=await register();assert.equal((await request(only,'/voice/session',{provider:'speech-only'})).statusCode,503);assert.equal((await multipart(only,[{name:'provider',value:'speech-only'},audio])).statusCode,503);assert.deepEqual(await state(only),{leases:0,usage:0,sessions:0});assert.equal(calls.length,beforeCalls);
});

test('voice JSON rejects malformed provider values, unknown fields and malformed inputs before runtime state',async()=>{
  const beforeCalls=calls.length;
  const malformed=[null,[],['openai'],{},true,42,'','   ','s'.repeat(81)];
  for(let index=0;index<malformed.length;index+=3){const actor=await register();for(const provider of malformed.slice(index,index+3))for(const route of ['/voice/session','/voice/speech']){const result=await request(actor,route,{provider,...(route.endsWith('speech')?{text:'Synthetic script'}:{})});assert.equal(result.statusCode,400,result.body);}assert.deepEqual(await state(actor),{leases:0,usage:0,sessions:0});}
  const actor=await register();
  for(const [route,payload] of [['/voice/session',{provider:'openai',voiceSettings:{}}],['/voice/session',{provider:'openai',model:[]}],['/voice/session',{provider:'openai',persona:{}}],['/voice/speech',{provider:'openai',text:'Synthetic script',persona:'unexpected'}],['/voice/speech',{provider:'openai',text:[]}],['/voice/speech',{provider:'openai',text:'Synthetic script',voice:[]}]] as const){const result=await request(actor,route,payload);assert.equal(result.statusCode,400,result.body);}
  assert.deepEqual(await state(actor),{leases:0,usage:0,sessions:0});assert.equal(calls.length,beforeCalls);
});

test('explicit realtime selection is passed through and binds verified provider and returned model to usage and history',async()=>{
  const actor=await register(),beforeCalls=calls.length;
  const response=await request(actor,'/voice/session',{provider:'fixture-voice',model:'synthetic-requested-model',persona:'Synthetic interview practice'});assert.equal(response.statusCode,200,response.body);
  assert.deepEqual(calls[beforeCalls],{kind:'realtime',provider:'fixture-voice',input:{provider:'fixture-voice',model:'synthetic-requested-model',persona:'Synthetic interview practice'}});
  const sessionId=response.json().sessionId,session=(await db.query('SELECT provider,model FROM platform_voice_sessions WHERE id=$1',[sessionId])).rows[0];assert.deepEqual(session,{provider:'fixture-voice',model:'synthetic-explicit-confirmed'});
  assert.deepEqual((await db.query('SELECT provider,model,capability FROM platform_usage WHERE user_id=$1',[actor.user.id])).rows,[{provider:'fixture-voice',model:'synthetic-explicit-confirmed',capability:'realtime'}]);
  await request(actor,'/voice/session/release',{sessionId});
  const conversation=await request(actor,'/conversations',{title:'Synthetic provider voice excerpt'});assert.equal(conversation.statusCode,201,conversation.body);
  const saved=await request(actor,`/conversations/${conversation.json().conversation.id}/voice-records`,{clientRecordId:randomUUID(),source:'realtime_transcript',role:'assistant',text:'Synthetic browser-reported excerpt',sessionId});assert.equal(saved.statusCode,201,saved.body);assert.equal(saved.json().record.provider,'fixture-voice');assert.equal(saved.json().record.model,'synthetic-explicit-confirmed');assert.equal(saved.json().record.provenance,'client_submitted');
});

test('explicit speech and either multipart provider position route only to the selected provider under a lease',async()=>{
  const actor=await register(),beforeCalls=calls.length;
  const spoken=await request(actor,'/voice/speech',{provider:'fixture-voice',text:'Synthetic speech text',voice:'synthetic-fixed-voice',model:'synthetic-tts-model'});assert.equal(spoken.statusCode,201,spoken.body);
  assert.deepEqual(calls[beforeCalls],{kind:'speech',provider:'fixture-voice',input:{provider:'fixture-voice',text:'Synthetic speech text',voice:'synthetic-fixed-voice',model:'synthetic-tts-model'}});
  const attachment=spoken.json().attachment;assert.equal(attachment.mime,'audio/wav');assert.equal((await db.query('SELECT user_id FROM platform_uploads WHERE id=$1',[attachment.id])).rows[0].user_id,actor.user.id);
  for(const parts of [[{name:'provider',value:'fixture-voice'},audio],[audio,{name:'provider',value:'fixture-voice'}]] as Part[][]){const result=await multipart(actor,parts);assert.equal(result.statusCode,200,result.body);assert.equal(result.json().text,'Synthetic fixture-voice transcript');}
  assert.deepEqual(calls.slice(beforeCalls).map(call=>[call.kind,call.provider]),[['speech','fixture-voice'],['transcription','fixture-voice'],['transcription','fixture-voice']]);assert.deepEqual(await state(actor),{leases:0,usage:0,sessions:0});
});

test('Kokoro speech selection reaches only its adapter and returns private audio while unavailable input capabilities make no call',async()=>{
  const actor=await register(),beforeCalls=calls.length;
  const spoken=await request(actor,'/voice/speech',{provider:'kokoro',text:'A fictional English narration.'});assert.equal(spoken.statusCode,201,spoken.body);
  assert.deepEqual(calls.slice(beforeCalls),[{kind:'speech',provider:'kokoro',input:{provider:'kokoro',text:'A fictional English narration.',voice:undefined,model:undefined}}]);
  const attachment=spoken.json().attachment;assert.equal(attachment.mime,'audio/wav');
  assert.equal((await db.query('SELECT user_id FROM platform_uploads WHERE id=$1',[attachment.id])).rows[0].user_id,actor.user.id);
  const playback=await system.app.inject({method:'GET',url:attachment.url,remoteAddress:actor.ip,headers:{cookie:actor.cookie, [PLATFORM_ACCOUNT_HEADER]: actor.user.id}});assert.equal(playback.statusCode,200,playback.body);assert.deepEqual(playback.rawPayload,wav());
  assert.deepEqual(await state(actor),{leases:0,usage:0,sessions:0});
  const beforeRejectedCalls=calls.length;
  const realtime=await request(actor,'/voice/session',{provider:'kokoro'});assert.equal(realtime.statusCode,503,realtime.body);assert.equal(realtime.json().error.code,'PROVIDER_UNAVAILABLE');
  for(const parts of [[{name:'provider',value:'kokoro'},audio],[audio,{name:'provider',value:'kokoro'}]] as Part[][]){const transcript=await multipart(actor,parts);assert.equal(transcript.statusCode,503,transcript.body);assert.equal(transcript.json().error.code,'PROVIDER_UNAVAILABLE');}
  assert.equal(calls.length,beforeRejectedCalls);assert.deepEqual(await state(actor),{leases:0,usage:0,sessions:0});
});

test('faster-whisper transcription-only selection preserves either multipart field order without falling back or storing input audio',async()=>{
  const actor=await register(),beforeCalls=calls.length;
  for(const parts of [[{name:'provider',value:'faster-whisper'},audio],[audio,{name:'provider',value:'faster-whisper'}]] as Part[][]){
    const result=await multipart(actor,parts);assert.equal(result.statusCode,200,result.body);assert.deepEqual(result.json(),{text:'Synthetic faster-whisper transcript'});
  }
  assert.deepEqual(calls.slice(beforeCalls),[0,1].map(()=>({kind:'transcription',provider:'faster-whisper',input:{name:'synthetic.wav',mime:'audio/wav',bytes:wav().length}})));
  assert.deepEqual(await state(actor),{leases:0,usage:0,sessions:0});
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM platform_uploads WHERE user_id=$1',[actor.user.id])).rows[0].n,0);
});

test('canonical OGG and FLAC reach the selected transcription adapter in either multipart order without retaining input audio',async()=>{
  const actor=await register(),beforeCalls=calls.length,expected:typeof calls=[];
  for(const [extension,mime,signature] of [['ogg','audio/ogg','OggS'],['flac','audio/flac','fLaC']] as const){
    const bytes=Buffer.from(signature+'Synthetic container fixture.'),file:Part={name:'file',bytes,filename:`recording.${extension}`,mime},provider:Part={name:'provider',value:'faster-whisper'};
    for(const parts of [[file,provider],[provider,file]]){
      const result=await multipart(actor,parts);assert.equal(result.statusCode,200,result.body);assert.deepEqual(result.json(),{text:'Synthetic faster-whisper transcript'});
      expected.push({kind:'transcription',provider:'faster-whisper',input:{name:`recording.${extension}`,mime,bytes:bytes.length}});
    }
  }
  assert.deepEqual(calls.slice(beforeCalls),expected);assert.deepEqual(await state(actor),{leases:0,usage:0,sessions:0});
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM platform_uploads WHERE user_id=$1',[actor.user.id])).rows[0].n,0);
});

test('OGG and FLAC signature or extension mismatches never acquire a voice lease or invoke transcription',async()=>{
  const actor=await register(),beforeCalls=calls.length;
  const ogg=Buffer.from('OggSSynthetic container fixture.'),flac=Buffer.from('fLaCSynthetic container fixture.');
  for(const [filename,mime,bytes] of [
    ['recording.ogg','audio/ogg',flac],['recording.flac','audio/flac',ogg],
    ['recording.flac','audio/ogg',ogg],['recording.ogg','audio/flac',flac],
    ['recording.ogg','audio/ogg',Buffer.from('Ogg')],['recording.flac','audio/flac',Buffer.from('fLa')],
    ['recording.ogg','audio/ogg',Buffer.from(Buffer.from('OggS').map(byte=>byte|0x80))],['recording.flac','audio/flac',Buffer.from(Buffer.from('fLaC').map(byte=>byte|0x80))],
    ['recording.ogg','audio/ogg',Buffer.from('Synthetic nonaudio bytes.')],['recording.flac','audio/flac',Buffer.from('Synthetic nonaudio bytes.')],
  ] as const){
    const result=await multipart(actor,[{name:'file',bytes,filename,mime},{name:'provider',value:'faster-whisper'}]);
    assert.equal(result.statusCode,400,result.body);assert.equal(result.json().error.code,'INVALID_INPUT');
  }
  assert.equal(calls.length,beforeCalls);assert.deepEqual(await state(actor),{leases:0,usage:0,sessions:0});
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM platform_uploads WHERE user_id=$1',[actor.user.id])).rows[0].n,0);
});

test('explicit OGG and FLAC uploads remain private downloads and do not call a voice adapter',async()=>{
  const actor=await register(),other=await register(),beforeCalls=calls.length;
  for(const [extension,mime,signature] of [['ogg','audio/ogg','OggS'],['flac','audio/flac','fLaC']] as const){
    const bytes=Buffer.from(signature+'Synthetic uploaded container fixture.');
    const uploaded=await multipart(actor,[{name:'file',bytes,filename:`fictional.${extension}`,mime}],'/uploads');assert.equal(uploaded.statusCode,201,uploaded.body);
    const attachment=uploaded.json().attachment;assert.equal(attachment.mime,mime);assert.equal(attachment.size,bytes.length);
    const read=await system.app.inject({method:'GET',url:attachment.url,remoteAddress:actor.ip,headers:{cookie:actor.cookie, [PLATFORM_ACCOUNT_HEADER]: actor.user.id}});
    assert.equal(read.statusCode,200,read.body);assert.deepEqual(read.rawPayload,bytes);assert.equal(read.headers['content-type'],mime);
    assert.equal(read.headers['cache-control'],'private, no-store');assert.equal(read.headers['x-content-type-options'],'nosniff');assert.match(String(read.headers['content-disposition']),/^attachment;/);
    const denied=await system.app.inject({method:'GET',url:attachment.url,remoteAddress:other.ip,headers:{cookie:other.cookie, [PLATFORM_ACCOUNT_HEADER]: other.user.id}});assert.equal(denied.statusCode,404,denied.body);
    assert.equal((await system.app.inject({method:'GET',url:attachment.url,remoteAddress:actor.ip})).statusCode,401);
  }
  assert.equal(calls.length,beforeCalls);assert.deepEqual(await state(actor),{leases:0,usage:0,sessions:0});
});

test('faster-whisper silence is an empty successful transcript and unavailable speech or realtime does not call an adapter',async()=>{
  const actor=await register(),beforeCalls=calls.length;
  const silent=await multipart(actor,[{name:'file',bytes:wav(),filename:'synthetic-silence.wav'},{name:'provider',value:'faster-whisper'}]);
  assert.equal(silent.statusCode,200,silent.body);assert.deepEqual(silent.json(),{text:''});
  assert.deepEqual(calls.slice(beforeCalls),[{kind:'transcription',provider:'faster-whisper',input:{name:'synthetic-silence.wav',mime:'audio/wav',bytes:wav().length}}]);
  assert.deepEqual(await state(actor),{leases:0,usage:0,sessions:0});
  const beforeRejectedCalls=calls.length;
  for(const [route,payload] of [['/voice/speech',{provider:'faster-whisper',text:'Synthetic speech should be rejected.'}],['/voice/session',{provider:'faster-whisper'}]] as const){
    const response=await request(actor,route,payload);assert.equal(response.statusCode,503,response.body);assert.equal(response.json().error.code,'PROVIDER_UNAVAILABLE');
  }
  assert.equal(calls.length,beforeRejectedCalls);assert.deepEqual(await state(actor),{leases:0,usage:0,sessions:0});
});

test('omitted provider retains explicit OpenAI defaults for all three existing voice routes',async()=>{
  const actor=await register(),beforeCalls=calls.length;
  const session=await request(actor,'/voice/session',{});assert.equal(session.statusCode,200,session.body);await request(actor,'/voice/session/release',{sessionId:session.json().sessionId});
  const spoken=await request(actor,'/voice/speech',{text:'Synthetic legacy speech'});assert.equal(spoken.statusCode,201,spoken.body);
  const transcript=await multipart(actor,[audio]);assert.equal(transcript.statusCode,200,transcript.body);assert.equal(transcript.json().text,'Synthetic openai transcript');
  assert.deepEqual(calls.slice(beforeCalls).map(call=>[call.kind,call.provider]),[['realtime','openai'],['speech','openai'],['transcription','openai']]);assert.deepEqual(await state(actor),{leases:0,usage:1,sessions:1});
});

test('multipart rejects duplicate providers, unexpected fields, multiple files and truncation before any call',async()=>{
  const actor=await register(),beforeCalls=calls.length;
  const malformed:Part[][]=[
    [audio,{name:'provider',value:'openai'},{name:'provider',value:'openai'}],
    [{name:'provider',value:'openai'},audio,{name:'provider',value:'fixture-voice'}],
    [{name:'unknown',value:'synthetic'},audio],
    [audio,{name:'unknown',value:'synthetic'}],
    [audio,{name:'file',bytes:wav(),filename:'second.wav'}],
    [{name:'unexpected-file',bytes:wav()}],
    [{name:'provider',value:'openai'}],
    [audio,{name:'provider',value:''}],
    [audio,{name:'provider',value:'s'.repeat(81)}],
    [audio,{name:'provider',value:'["openai"]',mime:'application/json'}],
    [audio,{name:'provider',value:'null',mime:'application/json'}],
    [audio,{name:'p'.repeat(100),value:'openai'}],
  ];
  for(const parts of malformed){const result=await multipart(actor,parts);assert([400,413].includes(result.statusCode),result.body);}
  const oversized=await multipart(actor,[{name:'file',bytes:wav(20*1024*1024+1)},{name:'provider',value:'fixture-voice'}]);assert.equal(oversized.statusCode,413,oversized.body);assert.equal(oversized.json().error.code,'FILE_TOO_LARGE');
  assert.deepEqual(await state(actor),{leases:0,usage:0,sessions:0});assert.equal(calls.length,beforeCalls);
  // The exact inclusive upper bound is accepted, with no partial/truncated audio sent upstream.
  const maximum=await multipart(actor,[{name:'provider',value:'fixture-voice'},{name:'file',bytes:wav(20*1024*1024)}]);assert.equal(maximum.statusCode,200,maximum.body);assert.equal((calls.at(-1)!.input as {bytes:number}).bytes,20*1024*1024);
});

test('a selected provider failure releases leases without falling back or falsely issuing a voice session',async()=>{
  const actor=await register(),beforeCalls=calls.length;failSelected=true;
  try{
    const results=[await request(actor,'/voice/session',{provider:'fixture-voice'}),await request(actor,'/voice/speech',{provider:'fixture-voice',text:'Synthetic failure script'}),await multipart(actor,[audio,{name:'provider',value:'fixture-voice'}])];
    for(const result of results){assert.equal(result.statusCode,502,result.body);assert.equal(result.json().error.code,'SYNTHETIC_SELECTED_PROVIDER_FAILED');}
    assert.deepEqual(calls.slice(beforeCalls).map(call=>[call.kind,call.provider]),[['realtime','fixture-voice'],['speech','fixture-voice'],['transcription','fixture-voice']]);assert.deepEqual(await state(actor),{leases:0,usage:1,sessions:0});
    assert.deepEqual((await db.query('SELECT provider FROM platform_usage WHERE user_id=$1',[actor.user.id])).rows,[{provider:'fixture-voice'}]);
  }finally{failSelected=false;}
});

test('speech expression is bounded, preserved for the selected runtime and private to its owner',async()=>{
  const actor=await register(),beforeCalls=calls.length,instructions='Speak calmly, with natural pauses.\nKeep every word of the script.';
  const spoken=await request(actor,'/voice/speech',{provider:'fixture-voice',text:'A fictional practice reply.',voice:'synthetic-fixed-voice',instructions});
  assert.equal(spoken.statusCode,201,spoken.body);
  assert.deepEqual(calls[beforeCalls].input,{provider:'fixture-voice',text:'A fictional practice reply.',voice:'synthetic-fixed-voice',model:undefined,instructions});
  const attachment=spoken.json().attachment,other=await register();
  assert.equal((await system.app.inject({method:'GET',url:attachment.url,remoteAddress:other.ip,headers:{cookie:other.cookie, [PLATFORM_ACCOUNT_HEADER]: other.user.id}})).statusCode,404);
  assert.equal((await system.app.inject({method:'GET',url:attachment.url,remoteAddress:actor.ip,headers:{cookie:actor.cookie, [PLATFORM_ACCOUNT_HEADER]: actor.user.id}})).statusCode,200);
  assert.deepEqual(await state(actor),{leases:0,usage:0,sessions:0});
  const maximum=await request(actor,'/voice/speech',{provider:'fixture-voice',text:'Fictional bounded expression.',instructions:'x'.repeat(2000)});
  assert.equal(maximum.statusCode,201,maximum.body);assert.equal((calls.at(-1)!.input as SpeechInput).instructions?.length,2000);
});

test('malformed speech instructions cannot acquire a voice lease or invoke the runtime',async()=>{
  const actor=await register(),beforeCalls=calls.length;
  for(const instructions of [null,{},[],true,42,'','   ','x'.repeat(2001)]){
    const result=await request(actor,'/voice/speech',{provider:'fixture-voice',text:'Fictional invalid expression.',instructions});
    assert.equal(result.statusCode,400,result.body);
  }
  assert.equal(calls.length,beforeCalls);assert.deepEqual(await state(actor),{leases:0,usage:0,sessions:0});
});

test('realtime voice and turn-taking reach the selected runtime under an owned lease',async()=>{
  for(const turnTaking of ['patient','balanced','quick'] as const){
    const actor=await register(),beforeCalls=calls.length;
    const response=await request(actor,'/voice/session',{provider:'fixture-voice',voice:'synthetic-realtime-voice',persona:'Fictional oral practice.',turnTaking});
    assert.equal(response.statusCode,200,response.body);
    assert.deepEqual(calls[beforeCalls].input,{provider:'fixture-voice',model:undefined,persona:'Fictional oral practice.',voice:'synthetic-realtime-voice',turnTaking});
    const sessionId=response.json().sessionId;
    assert.deepEqual(await state(actor),{leases:1,usage:1,sessions:1});
    await request(actor,'/voice/session/release',{sessionId});
    assert.deepEqual(await state(actor),{leases:0,usage:1,sessions:1});
  }
});

test('malformed realtime voice or turn-taking is rejected before usage and lease writes',async()=>{
  const beforeCalls=calls.length;
  const cases=[...([null,{},[],true,42,'','   ','x'.repeat(101)] as unknown[]).map(voice=>({voice})),...([null,{},[],true,42,'',' patient ','slow'] as unknown[]).map(turnTaking=>({turnTaking}))];
  for(let index=0;index<cases.length;index+=3){
    const actor=await register();
    for(const input of cases.slice(index,index+3)){
      const response=await request(actor,'/voice/session',{provider:'fixture-voice',...input});assert.equal(response.statusCode,400,response.body);
    }
    assert.deepEqual(await state(actor),{leases:0,usage:0,sessions:0});
  }
  assert.equal(calls.length,beforeCalls);
});
