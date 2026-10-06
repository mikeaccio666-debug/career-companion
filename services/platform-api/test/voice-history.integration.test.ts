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
import { VOICE_HISTORY_LIMITS } from '../src/voice-history.ts';

const prefix='/api/platform', origin='http://localhost:4321';
const schema=`voice_history_test_${randomUUID().replaceAll('-','')}`;
const config=readConfig(), admin=new Database(config.databaseUrl);
const url=new URL(config.databaseUrl);url.searchParams.set('options',`-c search_path=${schema}`);
const db=new Database(url.toString());
let system:Awaited<ReturnType<typeof buildApp>>,directory:string,actorCount=0;
const fake:PlatformProviderRuntime={
  capabilities:()=>[{id:'openai',name:'Synthetic voice fixture',keyConfigured:true,enabled:true,capabilities:['realtime','speech','transcription'],models:['synthetic-realtime'],envVariables:[]}],
  async *streamChat(){yield {type:'delta',text:'Synthetic text fixture'};},
  async executeJob(){return {artifacts:[]};},
  async createVoiceSession(){return {clientSecret:'synthetic-ephemeral-do-not-store',model:'synthetic-realtime',endpoint:'https://synthetic-provider.invalid/calls'};},
  async transcribe(){return {text:'Synthetic transcription'};},
  async speech(){return {name:'synthetic.wav',mime:'audio/wav',bytes:new TextEncoder().encode('RIFF0000WAVEsynthetic')};},
};
before(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);await db.migrate();directory=await fs.mkdtemp(path.join(os.tmpdir(),'companion-voice-history-'));
  system=await buildApp({db,config:{...config,databaseUrl:url.toString(),storageDir:directory},runtime:fake,enableQueue:false});
});
after(async()=>{await system?.app.close();await db.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();if(directory)await fs.rm(directory,{recursive:true,force:true});});
interface Actor{user:{id:string};cookie:string;ip:string;}
async function register():Promise<Actor>{
  const ip=`127.0.1.${++actorCount}`;
  const response=await system.app.inject({method:'POST',url:prefix+'/auth/register',remoteAddress:ip,headers:{origin},payload:{name:'Synthetic voice-history tester',email:`voice-${randomUUID()}@example.invalid`,password:'Synthetic-password-123'}});
  assert.equal(response.statusCode,201,response.body);
  return {user:response.json().user,cookie:(response.headers['set-cookie'] as string).split(';')[0],ip};
}
async function request(actor:Actor,method:'GET'|'POST'|'DELETE',route:string,payload?:Record<string,unknown>){return system.app.inject({method,url:prefix+route,remoteAddress:actor.ip,headers:{origin,cookie:actor.cookie},payload});}
async function conversation(actor:Actor){const response=await request(actor,'POST','/conversations',{title:'Synthetic voice excerpts'});assert.equal(response.statusCode,201,response.body);return response.json().conversation;}
function excerpt(overrides:Record<string,unknown>={}){return {clientRecordId:randomUUID(),source:'transcription_excerpt',role:'user',text:'Synthetic excerpt selected by the user',...overrides};}
async function seedRecords(actor:Actor,conversations:string[],count:number,textBytes=1){
  await db.query("INSERT INTO platform_voice_records(id,user_id,conversation_id,client_record_id,source,role,content,content_bytes,request_hash) SELECT gen_random_uuid(),$1,($2::uuid[])[ceil(n::numeric/500)::integer],gen_random_uuid(),'transcription_excerpt','user',repeat('s',$4),$4,'synthetic-seed' FROM generate_series(1,$3) AS n",[actor.user.id,conversations,count,textBytes]);
}

test('explicit voice excerpts remain separate from model messages and enforce two-user ownership',async()=>{
  const alice=await register(),bob=await register(),conv=await conversation(alice);
  const payload=excerpt();
  assert.equal((await request(bob,'POST',`/conversations/${conv.id}/voice-records`,payload)).statusCode,404);
  assert.equal((await request(bob,'GET',`/conversations/${conv.id}/voice-records`)).statusCode,404);
  const saved=await request(alice,'POST',`/conversations/${conv.id}/voice-records`,payload);assert.equal(saved.statusCode,201,saved.body);
  const record=saved.json().record;assert.equal(record.provenance,'client_submitted');assert.equal(record.source,'transcription_excerpt');assert.equal(record.text,payload.text);assert.deepEqual(record.attachments,[]);assert.equal(record.provider,undefined);
  const listed=await request(alice,'GET',`/conversations/${conv.id}/voice-records`);assert.deepEqual(listed.json().records,[record]);
  assert.deepEqual((await request(alice,'GET',`/conversations/${conv.id}`)).json().messages,[]);
  assert.equal((await db.query('SELECT count(*)::integer AS count FROM platform_messages WHERE conversation_id=$1',[conv.id])).rows[0].count,0);
  for(const extra of [{provider:'openai'},{model:'pretend-verified'},{clientSecret:'must-not-store'},{events:[{type:'raw-vendor-event'}]},{provenance:'server_verified'}]){
    const rejected=await request(alice,'POST',`/conversations/${conv.id}/voice-records`,{...excerpt(),...extra});assert.equal(rejected.statusCode,400,rejected.body);
  }
  await request(alice,'DELETE',`/conversations/${conv.id}`);assert.equal((await request(alice,'GET',`/conversations/${conv.id}/voice-records`)).statusCode,404);
  assert.equal((await db.query('SELECT count(*)::integer AS count FROM platform_voice_records WHERE conversation_id=$1',[conv.id])).rows[0].count,0);
});

test('voice-save idempotency is atomic and cannot replace a different excerpt or conversation',async()=>{
  const actor=await register(),conv=await conversation(actor),payload=excerpt();
  const results=await Promise.all([request(actor,'POST',`/conversations/${conv.id}/voice-records`,payload),request(actor,'POST',`/conversations/${conv.id}/voice-records`,payload)]);
  assert.deepEqual(results.map(result=>result.statusCode).sort(),[200,201]);assert.equal(results[0].json().record.id,results[1].json().record.id);
  assert.equal((await request(actor,'POST',`/conversations/${conv.id}/voice-records`,{...payload,text:'A different synthetic excerpt'})).statusCode,409);
  const other=await conversation(actor);assert.equal((await request(actor,'POST',`/conversations/${other.id}/voice-records`,payload)).statusCode,409);
  assert.equal((await request(actor,'GET',`/conversations/${conv.id}/voice-records`)).json().records.length,1);
});

test('realtime records bind an issued owner session and remain explicitly unverified after release',async()=>{
  const alice=await register(),bob=await register(),conv=await conversation(alice),bobsConversation=await conversation(bob);
  const session=await request(alice,'POST','/voice/session',{});assert.equal(session.statusCode,200,session.body);const sessionId=session.json().sessionId;
  const marker=(await db.query('SELECT * FROM platform_voice_sessions WHERE id=$1',[sessionId])).rows[0];assert.equal(marker.user_id,alice.user.id);assert.equal(marker.model,'synthetic-realtime');assert(!JSON.stringify(marker).includes('synthetic-ephemeral-do-not-store'));assert(!JSON.stringify(marker).includes('synthetic-provider.invalid'));
  const payload=excerpt({source:'realtime_transcript',role:'assistant',text:'Synthetic final browser-reported turn',sessionId});
  assert.equal((await request(bob,'POST',`/conversations/${bobsConversation.id}/voice-records`,payload)).statusCode,404);
  assert.equal((await request(alice,'POST',`/conversations/${conv.id}/voice-records`,excerpt({source:'realtime_transcript'}))).statusCode,400);
  assert.equal((await request(alice,'POST',`/conversations/${conv.id}/voice-records`,{...payload,sessionId:randomUUID()})).statusCode,404);
  await request(bob,'POST','/voice/session/release',{sessionId});assert.equal((await db.query('SELECT id FROM platform_runtime_leases WHERE id=$1',[sessionId])).rowCount,1);
  await request(alice,'POST','/voice/session/release',{sessionId});assert.equal((await db.query('SELECT id FROM platform_runtime_leases WHERE id=$1',[sessionId])).rowCount,0);
  assert((await db.query('SELECT released_at FROM platform_voice_sessions WHERE id=$1',[sessionId])).rows[0].released_at);
  const saved=await request(alice,'POST',`/conversations/${conv.id}/voice-records`,payload);assert.equal(saved.statusCode,201,saved.body);assert.equal(saved.json().record.provenance,'client_submitted');assert.equal(saved.json().record.provider,'openai');assert.equal(saved.json().record.model,'synthetic-realtime');
  await db.query("INSERT INTO platform_runtime_leases(id,user_id,kind,expires_at) VALUES($1,$2,'voice',now()+interval '1 minute')",[sessionId,bob.user.id]);
  assert.equal((await request(alice,'POST',`/conversations/${conv.id}/voice-records`,{...payload,clientRecordId:randomUUID()})).statusCode,404);
  await db.query('DELETE FROM platform_runtime_leases WHERE id=$1',[sessionId]);await db.query("UPDATE platform_voice_sessions SET save_until=now()-interval '1 second' WHERE id=$1",[sessionId]);
  assert.equal((await request(alice,'POST',`/conversations/${conv.id}/voice-records`,{...payload,clientRecordId:randomUUID()})).statusCode,409);
  assert.equal((await request(alice,'POST',`/conversations/${conv.id}/voice-records`,payload)).statusCode,200);
});

test('only authorized audio can accompany excerpts, with attachment count and combined byte limits',async()=>{
  const alice=await register(),bob=await register(),conv=await conversation(alice);
  const audio=(await request(alice,'POST','/voice/speech',{text:'Synthetic speech script'})).json().attachment;
  const bobsAudio=(await request(bob,'POST','/voice/speech',{text:'Another synthetic speech script'})).json().attachment;
  const saved=await request(alice,'POST',`/conversations/${conv.id}/voice-records`,excerpt({source:'speech_excerpt',role:'assistant',text:'Synthetic speech script',attachmentIds:[audio.id]}));assert.equal(saved.statusCode,201,saved.body);assert.equal(saved.json().record.attachments[0].id,audio.id);
  assert.equal((await request(alice,'POST',`/conversations/${conv.id}/voice-records`,excerpt({attachmentIds:[bobsAudio.id]}))).statusCode,404);
  assert.equal((await request(alice,'POST',`/conversations/${conv.id}/voice-records`,excerpt({attachmentIds:[audio.id,audio.id]}))).statusCode,400);
  assert.equal((await request(alice,'POST',`/conversations/${conv.id}/voice-records`,excerpt({attachmentIds:[audio.id,randomUUID(),randomUUID()]}))).statusCode,400);
  const otherAudio=(await request(alice,'POST','/voice/speech',{text:'Synthetic second script'})).json().attachment;
  await db.query('UPDATE platform_uploads SET byte_size=$2 WHERE id=ANY($1::uuid[])',[[audio.id,otherAudio.id],11*1024*1024]);
  assert.equal((await request(alice,'POST',`/conversations/${conv.id}/voice-records`,excerpt({attachmentIds:[audio.id,otherAudio.id]}))).statusCode,413);
  await db.query("UPDATE platform_uploads SET mime='text/plain',byte_size=20 WHERE id=$1",[otherAudio.id]);
  assert.equal((await request(alice,'POST',`/conversations/${conv.id}/voice-records`,excerpt({attachmentIds:[otherAudio.id]}))).statusCode,400);
  assert.equal((await request(alice,'POST',`/conversations/${conv.id}/voice-records`,excerpt({text:'s'.repeat(VOICE_HISTORY_LIMITS.textCharacters+1)}))).statusCode,400);
});

test('conversation record limits serialize concurrent saves, while exact retries remain valid',async()=>{
  const actor=await register(),conv=await conversation(actor);await seedRecords(actor,[conv.id],VOICE_HISTORY_LIMITS.conversationRecords-1);
  const payload=excerpt();const results=await Promise.all([request(actor,'POST',`/conversations/${conv.id}/voice-records`,payload),request(actor,'POST',`/conversations/${conv.id}/voice-records`,excerpt())]);
  assert.deepEqual(results.map(result=>result.statusCode).sort(),[201,413]);const saved=results.find(result=>result.statusCode===201)!.json().record;
  assert.equal((await request(actor,'POST',`/conversations/${conv.id}/voice-records`,{clientRecordId:saved.clientRecordId,source:saved.source,role:saved.role,text:saved.text})).statusCode,200);
  assert.equal((await request(actor,'GET',`/conversations/${conv.id}/voice-records`)).json().records.length,VOICE_HISTORY_LIMITS.conversationRecords);
});

test('cumulative text and per-user record limits apply across conversations',async()=>{
  const conversationActor=await register(),conv=await conversation(conversationActor);await seedRecords(conversationActor,[conv.id],131,8000);
  await seedRecords(conversationActor,[conv.id],1,575);
  assert.equal((await request(conversationActor,'POST',`/conversations/${conv.id}/voice-records`,excerpt({text:'ss'}))).statusCode,413);
  assert.equal((await request(conversationActor,'POST',`/conversations/${conv.id}/voice-records`,excerpt({text:'s'}))).statusCode,201);
  const countActor=await register(),countConversations=[];for(let index=0;index<20;index++)countConversations.push((await conversation(countActor)).id);
  await seedRecords(countActor,countConversations,VOICE_HISTORY_LIMITS.userRecords);const fresh=await conversation(countActor);
  assert.equal((await request(countActor,'POST',`/conversations/${fresh.id}/voice-records`,excerpt())).statusCode,413);
  const bytesActor=await register(),byteConversations=[];for(let index=0;index<6;index++)byteConversations.push((await conversation(bytesActor)).id);
  await seedRecords(bytesActor,byteConversations,2621,8000);await seedRecords(bytesActor,[byteConversations[5]],1,3520);const freshBytes=await conversation(bytesActor);
  assert.equal((await request(bytesActor,'POST',`/conversations/${freshBytes.id}/voice-records`,excerpt({text:'s'}))).statusCode,413);
});
