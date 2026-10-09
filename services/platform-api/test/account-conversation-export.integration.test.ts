import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {Database} from '../src/database.ts';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {CONVERSATION_EXPORT_TABLES} from '../src/account-conversation-export.ts';
import {AccountReauthentication} from '../src/account-reauthentication.ts';
import {hashPassword,type FixedSessionContext} from '../src/auth.ts';
import {CompanionWelcomeService} from '../src/companion-welcome.ts';
import {CompanionBirthOriginStore} from '../src/companion-birth-origin-store.ts';
import {createPrebirthFixture,withPrebirthLoopback} from './fixtures/companion-prebirth.ts';
import {readyBirth} from './fixtures/companion-birth.ts';
import {FICTIONAL_LEGAL} from './fixtures/student-entry.ts';
let f:Awaited<ReturnType<typeof createPrebirthFixture>>,encoded:string;
const password='Fictional-conversation-export-password';
before(async()=>{f=await createPrebirthFixture();encoded=await hashPassword(password);});
after(async()=>{await f?.close();});
async function actor(){const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,encoded]);return who;}
async function proof(who:FixedSessionContext){return (await new AccountReauthentication(f.db).verify(who,{purpose:'account_export',password})).token;}
const capture=async(who:FixedSessionContext)=>new AccountCoreExport(f.db,f.config).capture(who,await proof(who));
async function conversation(who:FixedSessionContext){const id=randomUUID();await f.db.query("INSERT INTO platform_conversations(id,user_id,title,mode,persona) VALUES($1,$2,'Fictional private room','agent','Fictional saved style')",[id,who.userId]);return id;}
async function message(room:string,content='Fictional private history',status='complete',role='user'){
 const id=randomUUID();await f.db.query('INSERT INTO platform_messages(id,conversation_id,role,content,status,excluded_from_context) VALUES($1,$2,$3,$4,$5,true)',[id,room,role,content,status]);return id;
}
async function upload(who:FixedSessionContext){const id=randomUUID(),storageKey='fictional-private-storage-'+randomUUID();await f.db.query("INSERT INTO platform_uploads(id,user_id,filename,mime,byte_size,storage_key) VALUES($1,$2,'fictional-audio.wav','audio/wav',10,$3)",[id,who.userId,storageKey]);return {id,storageKey};}
async function transcript(who:FixedSessionContext,source:string,text='Fictional 原始转录 🚀'){
 const id=randomUUID();await f.db.query(`INSERT INTO platform_audio_transcriptions(id,user_id,client_request_id,source_upload_id,source_sha256,source_name,source_mime,source_size,provider,model,content,content_bytes)
 VALUES($1,$2,$3,$4,$5,'fictional-audio.wav','audio/wav',10,'faster-whisper','whisper-tiny',$6,$7)`,[id,who.userId,randomUUID(),source,'a'.repeat(64),text,Buffer.byteLength(text)]);return id;
}
async function call(who:FixedSessionContext,room:string|null,msg:string|null){const id=randomUUID();await f.db.query("INSERT INTO platform_chat_calls(id,user_id,conversation_id,message_id,call_index,provider,model) VALUES($1,$2,$3,$4,1,'openai','fictional-model')",[id,who.userId,room,msg]);return id;}
function instrument(afterQuery:(sql:string,client:PoolClient)=>Promise<void>):Database{
 return {withBoundedTransaction:<T>(run:(client:PoolClient)=>Promise<T>,options?:{readOnly?:boolean;timeoutMs?:number})=>f.db.withBoundedTransaction(client=>run(new Proxy(client,{get(target,key){
  if(key==='query')return async(sql:string,values:unknown[])=>{const result=await target.query(sql,values);await afterQuery(sql,target);return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }})),options)} as Database;
}

test('export includes owned legacy content, excluded messages, raw statuses, audio review and reported usage without credentials or file locations',async()=>{
 const a=await actor(),b=await actor(),room=await conversation(a),foreignRoom=await conversation(b),foreignMessage=await message(foreignRoom,'Fictional foreign secret');
 const source=await upload(a),receipt=await transcript(a,source.id),msg=await message(room),running=await message(room,'Fictional partial stream','streaming','assistant');
 await f.db.query('UPDATE platform_messages SET attachments=$2,audio_transcripts=$3 WHERE id=$1',[msg,JSON.stringify([source.id]),JSON.stringify([{receiptId:receipt,reviewedText:'Fictional 用户改写后的转录'}])]);
 const callId=await call(a,room,running);await f.db.query("UPDATE platform_chat_calls SET status='complete',usage_status='reported',input_tokens=100,output_tokens=7,cached_input_tokens=20,cache_write_input_tokens=10,finished_at=clock_timestamp() WHERE id=$1",[callId]);
 const result=await capture(a),s=result.sections;
 assert.equal(s.conversations.length,1);assert.equal(s.messages.length,2);assert.equal(s.audioTranscriptions.length,1);assert.equal(s.chatCalls.length,1);
 const exported=(s.messages as any[]).find(x=>x.id===msg);assert.equal(exported.content,'Fictional private history');assert.equal(exported.excludedFromContext,true);assert.equal(typeof exported.ordinal,'string');
 assert.deepEqual(exported.attachments,[{id:source.id,availability:'metadata_present'}]);assert.equal(exported.audioTranscripts[0].reviewedText,'Fictional 用户改写后的转录');
 assert.equal((s.audioTranscriptions[0] as any).text,'Fictional 原始转录 🚀');assert.equal((s.chatCalls[0] as any).cachedInputTokens,20);
 assert.equal((s.messages as any[]).find(x=>x.id===running).status,'streaming');
 for(const table of CONVERSATION_EXPORT_TABLES){assert(result.includedTables.includes(table));assert(!result.remainingTables.includes(table));}
 assert.equal(result.includedTables.length,142);assert(result.includedTables.includes('platform_companion_welcome'));assert(result.remainingTables.includes('platform_companion_birth_assets'));assert.equal(result.complete,false);assert.equal(result.filesIncluded,false);
 const text=JSON.stringify(result);for(const secret of [a.tokenHash,encoded,password,b.userId,foreignRoom,foreignMessage,'Fictional foreign secret',source.storageKey,'lease_until'])assert(!text.includes(secret));
 assert(Object.isFrozen(exported.audioTranscripts));
});

test('all four tables paginate independently past 100 rows and preserve bigint ordinal precision',async()=>{
 const a=await actor(),source=await upload(a),rooms=Array.from({length:105},()=>randomUUID()),messages=Array.from({length:105},()=>randomUUID());
 await f.db.query("INSERT INTO platform_conversations(id,user_id,title,mode) SELECT x,$1,'Fictional room','chat' FROM unnest($2::uuid[]) x",[a.userId,rooms]);
 await f.db.query("INSERT INTO platform_messages(id,conversation_id,role,content) SELECT x,$1,'user','Fictional historical message' FROM unnest($2::uuid[]) x",[rooms[0],messages]);
 await f.db.query("UPDATE platform_messages SET ordinal=9007199254740993 WHERE id=$1",[messages[0]]);
 for(let i=0;i<105;i++){await transcript(a,source.id,'Fictional paged transcript '+i);await call(a,rooms[0],messages[i]);}
 const {sections:s}=await capture(a);assert.equal(s.conversations.length,105);assert.equal(s.messages.length,105);assert.equal(s.chatCalls.length,105);assert.equal(s.audioTranscriptions.length,105);
 assert.equal((s.messages as any[]).find(x=>x.id===messages[0]).ordinal,'9007199254740993');
});

test('live and detached calls are exported as saved without running recovery or inventing zero usage',async()=>{
 const a=await actor(),room=await conversation(a),msg=await message(room,'Fictional still streaming','streaming','assistant'),live=await call(a,room,msg);
 const deletedRoom=await conversation(a),deletedMsg=await message(deletedRoom),detached=await call(a,deletedRoom,deletedMsg);await f.db.query('DELETE FROM platform_conversations WHERE id=$1',[deletedRoom]);
 const rows=(await capture(a)).sections.chatCalls as any[];
 assert.equal(rows.find(x=>x.id===live).status,'running');assert.equal(rows.find(x=>x.id===live).usageStatus,'pending');assert.equal(rows.find(x=>x.id===live).inputTokens,null);
 assert.equal(rows.find(x=>x.id===detached).conversationId,null);assert.equal(rows.find(x=>x.id===detached).messageId,null);assert.equal(rows.find(x=>x.id===detached).finishedAt,null);
 assert.equal((await f.db.query('SELECT status FROM platform_chat_calls WHERE id=$1',[live])).rows[0].status,'running');
});

test('deleted attachment and transcript references retain reviewed text with explicit missing status, without resurrecting files',async()=>{
 const a=await actor(),room=await conversation(a),msg=await message(room),source=await upload(a),receipt=await transcript(a,source.id);
 await f.db.query('UPDATE platform_messages SET attachments=$2,audio_transcripts=$3 WHERE id=$1',[msg,JSON.stringify([source.id]),JSON.stringify([{receiptId:receipt,reviewedText:'Fictional retained review'}])]);
 await f.db.query('DELETE FROM platform_uploads WHERE id=$1',[source.id]);const {sections:s}=await capture(a),m=s.messages[0] as any;
 assert.deepEqual(m.attachments,[{id:source.id,availability:'not_found'}]);assert.deepEqual(m.audioTranscripts,[{receiptId:receipt,reviewedText:'Fictional retained review',availability:'not_found'}]);assert.equal(s.audioTranscriptions.length,0);
});

test('foreign references and unsupported payloads fail atomically and leave the proof retryable',async()=>{
 const a=await actor(),b=await actor(),room=await conversation(a),msg=await message(room),foreign=await upload(b),receipt=await transcript(b,foreign.id),foreignRoom=await conversation(b),foreignMsg=await message(foreignRoom);
 const token=await proof(a),captureWithProof=()=>new AccountCoreExport(f.db,f.config).capture(a,token);
 const expectFailure=async()=>{await assert.rejects(captureWithProof(),{code:'ACCOUNT_CONVERSATION_EXPORT_UNAVAILABLE'});assert.equal((await f.db.query('SELECT consumed_at FROM platform_account_reauthentications WHERE user_id=$1',[a.userId])).rows[0].consumed_at,null);};
 await f.db.query('UPDATE platform_messages SET attachments=$2 WHERE id=$1',[msg,JSON.stringify([foreign.id.toUpperCase()])]);await expectFailure();
 await f.db.query('UPDATE platform_messages SET attachments=$2,audio_transcripts=$3 WHERE id=$1',[msg,'[]',JSON.stringify([{receiptId:receipt,reviewedText:'Fictional foreign reference'}])]);await expectFailure();
 await f.db.query('UPDATE platform_messages SET audio_transcripts=$2,payload=$3 WHERE id=$1',[msg,'[]',JSON.stringify({unreviewed_secret:'Fictional future secret'})]);await expectFailure();
 await f.db.query("UPDATE platform_messages SET payload='{}' WHERE id=$1",[msg]);const corrupt=await call(a,foreignRoom,foreignMsg);await expectFailure();await f.db.query('DELETE FROM platform_chat_calls WHERE id=$1',[corrupt]);
 const foreignSourceReceipt=await transcript(a,foreign.id);await expectFailure();await f.db.query('DELETE FROM platform_audio_transcriptions WHERE id=$1',[foreignSourceReceipt]);
 assert.equal((await captureWithProof()).sections.messages.length,1);
});

test('one MVCC snapshot excludes a concurrent insertion after the first message page',async()=>{
 const a=await actor(),room=await conversation(a),ids=Array.from({length:110},()=>randomUUID());
 await f.db.query("INSERT INTO platform_messages(id,conversation_id,role,content) SELECT x,$1,'user','Fictional snapshot message' FROM unnest($2::uuid[]) x",[room,ids]);
 let inserted=false,late='';const db=instrument(async sql=>{if(!inserted&&sql.includes('FROM platform_messages m JOIN platform_conversations')){inserted=true;late=await message(room,'Fictional later message');}});
 const result=await new AccountCoreExport(db,f.config).capture(a,await proof(a));assert(inserted);assert.equal(result.sections.messages.length,110);assert(!JSON.stringify(result).includes(late));
 assert.equal((await f.db.query('SELECT count(*)::int n FROM platform_messages WHERE conversation_id=$1',[room])).rows[0].n,111);
});

test('message-size limit and cancellation during a page return no partial export and roll back proof use',async()=>{
 const a=await actor(),room=await conversation(a);await message(room,'Fictional large history '.repeat(200));const token=await proof(a);
 await assert.rejects(new AccountCoreExport(f.db,f.config,{maxBytes:2000}).capture(a,token),{code:'ACCOUNT_EXPORT_TOO_LARGE'});
 const controller=new AbortController(),db=instrument(async sql=>{if(sql.includes('FROM platform_messages m JOIN platform_conversations'))controller.abort();});
 await assert.rejects(new AccountCoreExport(db,f.config).capture(a,token,controller.signal),{code:'ACCOUNT_EXPORT_CANCELLED'});
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(a,token)).sections.messages.length,1);
});

test('actual companion birth and welcome messages preserve typed sources and the separately decoded introduction',async()=>{
 const a=await actor();await withPrebirthLoopback(async(runtime,calls)=>{
  const ready=await readyBirth(f,runtime,{who:a});await ready.service.birth(a,ready.body,ready.key);
  const welcome=await new CompanionWelcomeService(f.db,f.config,FICTIONAL_LEGAL,new CompanionBirthOriginStore(f.crypto),ready.prebirth).open(a,{expectedCompanionId:ready.ready.prepared.companionId});
  const result=await capture(a),messages=result.sections.messages as any[];assert.equal(messages.length,2);assert.equal((result.sections.conversations[0] as any).kind,'main');
  assert(messages.some(m=>m.payload.event==='companion_born'));const intro=messages.find(m=>m.payload.type==='companion_intro');
  assert.equal(intro.id,welcome.intro.id);assert.equal(intro.content,'');assert.equal(intro.payload.welcomeId,welcome.id);assert.equal(intro.speakerSnapshot.displayName,welcome.intro.speaker.name);assert.deepEqual((result.sections.companionWelcomes[0] as any).intro,welcome.intro);
  assert(result.includedTables.includes('platform_companion_welcome'));assert(result.remainingTables.includes('platform_companion_birth_assets'));assert(!JSON.stringify(result).includes('intro_ciphertext'));assert.equal(calls.length,2);
 });
});
