import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {Database} from '../src/database.ts';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {AccountReauthentication} from '../src/account-reauthentication.ts';
import {hashPassword,type FixedSessionContext} from '../src/auth.ts';
import {rememberVoiceSession,releaseVoiceSession,saveVoiceRecord} from '../src/voice-history.ts';
import {createCompanionNameSafetyFixture} from './fixtures/companion-name-safety.ts';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,encoded:string;
const password='Fictional-voice-export-password';
before(async()=>{f=await createCompanionNameSafetyFixture();encoded=await hashPassword(password);});
after(async()=>{await f?.close();});
async function actor(){const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,encoded]);return who;}
const proof=async(who:FixedSessionContext)=>(await new AccountReauthentication(f.db).verify(who,{purpose:'account_export',password})).token;
const capture=async(who:FixedSessionContext)=>new AccountCoreExport(f.db,f.config).capture(who,await proof(who));
const consumed=async(who:FixedSessionContext)=>(await f.db.query("SELECT consumed_at FROM platform_account_reauthentications WHERE user_id=$1 AND purpose='account_export'",[who.userId])).rows[0].consumed_at;
async function room(who:FixedSessionContext){const key=randomUUID();await f.db.query("INSERT INTO platform_conversations(id,user_id,title,mode) VALUES($1,$2,'Fictional voice archive','chat')",[key,who.userId]);return key;}
async function session(who:FixedSessionContext,conversationId?:string){const key=randomUUID();await f.db.query("INSERT INTO platform_runtime_leases(id,user_id,kind,expires_at) VALUES($1,$2,'voice',now()+interval '10 minutes')",[key,who.userId]);await rememberVoiceSession(f.db,who.userId,key,'fictional-provider','fictional-realtime',{conversationId});return key;}
async function excerpt(who:FixedSessionContext,conversationId:string,overrides:Record<string,unknown>={}){return (await saveVoiceRecord(f.db,who.userId,conversationId,{clientRecordId:randomUUID(),source:'transcription_excerpt',role:'user',text:'Fictional 我保存的片段 🚀',...overrides})).record;}
async function usage(who:FixedSessionContext,conversationId:string|null=null,messageId:string|null=null,capability='chat'){const key=randomUUID();await f.db.query('INSERT INTO platform_usage(id,user_id,conversation_id,message_id,provider,model,capability) VALUES($1,$2,$3,$4,$5,$6,$7)',[key,who.userId,conversationId,messageId,'fictional-provider',null,capability]);return key;}
async function message(conversationId:string){const key=randomUUID();await f.db.query("INSERT INTO platform_messages(id,conversation_id,role,content) VALUES($1,$2,'user','Fictional historical message')",[key,conversationId]);return key;}
async function upload(who:FixedSessionContext){const key=randomUUID(),storageKey='fictional-private-audio-'+randomUUID();await f.db.query("INSERT INTO platform_uploads(id,user_id,filename,mime,byte_size,storage_key) VALUES($1,$2,'fictional.wav','audio/wav',10,$3)",[key,who.userId,storageKey]);return {id:key,storageKey};}
function instrument(transform:(sql:string,rows:Record<string,any>[])=>void|Promise<void>):Database{return {withBoundedTransaction:<T>(run:(client:PoolClient)=>Promise<T>,options?:{readOnly?:boolean;timeoutMs?:number})=>f.db.withBoundedTransaction(client=>run(new Proxy(client,{get(target,key){
 if(key==='query')return async(sql:string,values:unknown[])=>{const result=await target.query(sql,values);await transform(sql,result.rows);return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
}})),options)} as Database;}
const reads=(sql:string,table:string)=>sql.startsWith('SELECT ')&&sql.includes(`FROM platform_${table} v `);
async function snapshot(who:FixedSessionContext){const result:Record<string,unknown>={};for(const table of ['voice_sessions','voice_records','usage','runtime_leases'])result[table]=(await f.db.query(`SELECT row_to_json(t)::text AS value FROM platform_${table} t WHERE user_id=$1 ORDER BY row_to_json(t)::text`,[who.userId])).rows;return result;}

test('actual saved voice excerpts and sessions export private text and archive-local links without executable IDs or file paths',async()=>{
 const who=await actor(),other=await actor(),conversationId=await room(who),foreignRoom=await room(other),source=await upload(who),voice=await session(who,conversationId);
 const realtime=await excerpt(who,conversationId,{source:'realtime_transcript',role:'assistant',sessionId:voice,attachmentIds:[source.id]}),transcript=await excerpt(who,conversationId),speech=await excerpt(who,conversationId,{source:'speech_excerpt',role:'unknown'});
 const foreignSession=await session(other,foreignRoom),foreignRecord=await excerpt(other,foreignRoom);await usage(other);const before=await snapshot(who),result=await capture(who),s=result.sections;
 assert.equal(s.voiceSessions.length,1);assert.equal(s.voiceRecords.length,3);assert.deepEqual(s.messages,[]);
 const exportedSession=s.voiceSessions[0] as any,records=new Map((s.voiceRecords as any[]).map(r=>[r.id,r]));
 assert.equal(exportedSession.sessionRef,'voice-session-1');assert.equal(exportedSession.conversationId,conversationId);assert.equal(exportedSession.releasedAt,null);
 assert.equal(records.get(realtime.id).sessionRef,exportedSession.sessionRef);assert.equal(records.get(realtime.id).provider,'fictional-provider');assert.equal(records.get(realtime.id).provenance,'client_submitted');assert.equal(records.get(realtime.id).text,realtime.text);
 assert.deepEqual(records.get(realtime.id).attachments,[{id:source.id,availability:'metadata_present'}]);assert.equal(records.get(transcript.id).sessionRef,null);assert.equal(records.get(speech.id).role,'unknown');
 for(const secret of [voice,foreignSession,foreignRecord.id,other.userId,foreignRoom,source.storageKey,who.tokenHash,password,encoded])assert(!JSON.stringify(result).includes(secret));
 assert(Object.isFrozen(records.get(realtime.id).attachments));assert.equal(result.includedTables.length,72);assert.equal(result.complete,false);assert.equal(result.filesIncluded,false);assert.deepEqual(await snapshot(who),before);
});

test('released or expired sessions and withdrawn model consent still permit reading the retained user-selected excerpt',async()=>{
 const who=await actor(),conversationId=await room(who),voice=await session(who),saved=await excerpt(who,conversationId,{source:'realtime_transcript',sessionId:voice});
 await releaseVoiceSession(f.db,who.userId,voice);await f.db.query("UPDATE platform_voice_sessions SET expires_at=now()-interval '2 days',save_until=now()-interval '1 day' WHERE id=$1",[voice]);
 await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[who.userId]);await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[who.userId]);
 const before=await snapshot(who),result=await capture(who),row=result.sections.voiceSessions[0] as any;
 assert.equal(row.conversationId,null);assert.equal(typeof row.releasedAt,'string');assert(Date.parse(row.saveUntil)<Date.now());assert.equal((result.sections.voiceRecords[0] as any).id,saved.id);assert.deepEqual(await snapshot(who),before);
});

test('legacy default zeros and saved counters remain unverified rather than becoming measured cost or successful calls',async()=>{
 const who=await actor(),conversationId=await room(who),msg=await message(conversationId),chat=await usage(who,conversationId,msg),realtime=await usage(who,null,null,'realtime');
 await f.db.query('UPDATE platform_usage SET input_tokens=42,output_tokens=7,model=$2 WHERE id=$1',[chat,'fictional-old-model']);
 const before=await snapshot(who),result=await capture(who),records=new Map((result.sections.legacyUsage as any[]).map(r=>[r.id,r]));
 assert.equal(records.get(chat).storedInputTokens,42);assert.equal(records.get(chat).storedOutputTokens,7);assert.equal(records.get(chat).messageId,msg);assert.equal(records.get(chat).usageStatus,'not_recorded');
 assert.equal(records.get(realtime).storedInputTokens,0);assert.equal(records.get(realtime).model,null);assert.equal(records.get(realtime).provenance,'legacy_usage_record');
 for(const row of records.values())for(const key of ['costMicros','success','status','measuredInputTokens'])assert(!(key in row));assert.deepEqual(result.sections.costLedger,[]);assert.deepEqual(await snapshot(who),before);
 await f.db.query('DELETE FROM platform_conversations WHERE id=$1',[conversationId]);const detached=(await capture(who)).sections.legacyUsage as any[];
 assert.equal(detached.find(r=>r.id===chat).conversationId,null);assert.equal(detached.find(r=>r.id===chat).messageId,null);
});

test('missing attachments keep their references without resurrecting audio; foreign attachments reject the archive',async()=>{
 const who=await actor(),other=await actor(),conversationId=await room(who),source=await upload(who),foreign=await upload(other),saved=await excerpt(who,conversationId,{attachmentIds:[source.id]});
 await f.db.query('DELETE FROM platform_uploads WHERE id=$1',[source.id]);const result=await capture(who);assert.deepEqual((result.sections.voiceRecords[0] as any).attachments,[{id:source.id,availability:'not_found'}]);
 await f.db.query('UPDATE platform_voice_records SET attachment_ids=$2 WHERE id=$1',[saved.id,JSON.stringify([foreign.id])]);const token=await proof(who);
 await assert.rejects(new AccountCoreExport(f.db,f.config).capture(who,token),{code:'ACCOUNT_VOICE_USAGE_EXPORT_UNAVAILABLE'});assert.equal(await consumed(who),null);
 await f.db.query('UPDATE platform_voice_records SET attachment_ids=$2 WHERE id=$1',[saved.id,'[]']);assert.equal((await new AccountCoreExport(f.db,f.config).capture(who,token)).sections.voiceRecords.length,1);
});

test('all three tables paginate past 100 rows and preserve exact large ordinals, with no live lease ID in the archive',async()=>{
 const who=await actor(),conversationId=await room(who),ids:string[]=[],sessions:string[]=[];
 for(let i=0;i<105;i++){const voice=await session(who,conversationId);sessions.push(voice);ids.push((await excerpt(who,conversationId,{source:'realtime_transcript',sessionId:voice})).id);await usage(who);}
 await f.db.query('UPDATE platform_voice_records SET ordinal=9007199254740993 WHERE id=$1',[ids[0]]);
 const queries:string[]=[],result=await new AccountCoreExport(instrument(sql=>{queries.push(sql);}),f.config).capture(who,await proof(who));
 for(const section of ['voiceSessions','voiceRecords','legacyUsage'] as const)assert.equal(result.sections[section].length,105);
 const refs=new Set((result.sections.voiceSessions as any[]).map(r=>r.sessionRef));assert.equal(refs.size,105);assert((result.sections.voiceRecords as any[]).every(r=>refs.has(r.sessionRef)));
 assert.equal((result.sections.voiceRecords as any[]).find(r=>r.id===ids[0]).ordinal,'9007199254740993');
 for(const table of ['voice_sessions','voice_records','usage'])assert.equal(queries.filter(sql=>reads(sql,table)).length,2);
 const json=JSON.stringify(result);assert(sessions.every(key=>!json.includes(key)));
});

test('real foreign conversation, message and session links fail even when individual database foreign keys permit them',async()=>{
 const who=await actor(),other=await actor(),ownRoom=await room(who),foreignRoom=await room(other),ownMessage=await message(ownRoom),foreignMessage=await message(foreignRoom),ownVoice=await session(who,ownRoom),foreignVoice=await session(other,foreignRoom);
 const saved=await excerpt(who,ownRoom,{source:'realtime_transcript',sessionId:ownVoice}),legacy=await usage(who,ownRoom,ownMessage),token=await proof(who);
 const reject=async()=>{await assert.rejects(new AccountCoreExport(f.db,f.config).capture(who,token),{code:'ACCOUNT_VOICE_USAGE_EXPORT_UNAVAILABLE'});assert.equal(await consumed(who),null);};
 await f.db.query('UPDATE platform_voice_sessions SET conversation_id=$2 WHERE id=$1',[ownVoice,foreignRoom]);await reject();await f.db.query('UPDATE platform_voice_sessions SET conversation_id=$2 WHERE id=$1',[ownVoice,ownRoom]);
 await f.db.query('UPDATE platform_voice_records SET session_id=$2 WHERE id=$1',[saved.id,foreignVoice]);await reject();await f.db.query('UPDATE platform_voice_records SET session_id=$2 WHERE id=$1',[saved.id,ownVoice]);
 await f.db.query('UPDATE platform_voice_records SET conversation_id=$2 WHERE id=$1',[saved.id,foreignRoom]);await reject();await f.db.query('UPDATE platform_voice_records SET conversation_id=$2 WHERE id=$1',[saved.id,ownRoom]);
 await f.db.query('UPDATE platform_usage SET message_id=$2 WHERE id=$1',[legacy,foreignMessage]);await reject();await f.db.query('UPDATE platform_usage SET message_id=$2 WHERE id=$1',[legacy,ownMessage]);
 await f.db.query('UPDATE platform_usage SET conversation_id=$2 WHERE id=$1',[legacy,foreignRoom]);await reject();await f.db.query('UPDATE platform_usage SET conversation_id=$2 WHERE id=$1',[legacy,ownRoom]);
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(who,token)).sections.voiceRecords.length,1);
});

test('one database snapshot excludes concurrent later voice records and does not rewrite saved history',async()=>{
 const who=await actor(),conversationId=await room(who);for(let i=0;i<105;i++)await excerpt(who,conversationId);let late='',inserted=false;
 const db=instrument(async sql=>{if(!inserted&&reads(sql,'voice_records')){inserted=true;late=(await excerpt(who,conversationId,{text:'Fictional later excerpt'})).id;}});
 const result=await new AccountCoreExport(db,f.config).capture(who,await proof(who));assert(inserted);assert.equal(result.sections.voiceRecords.length,105);assert(!JSON.stringify(result).includes(late));
 assert.equal((await f.db.query('SELECT count(*)::int n FROM platform_voice_records WHERE user_id=$1',[who.userId])).rows[0].n,106);
});

test('damaged content, speaker attribution and routing are rejected; unreviewed extra fields are never serialized',async()=>{
 const who=await actor(),conversationId=await room(who),voice=await session(who,conversationId);await excerpt(who,conversationId,{source:'realtime_transcript',sessionId:voice});await usage(who);const token=await proof(who);
 const cases:[string,(row:any)=>void][]=[['voice_records',r=>{r.content_bytes++;}],['voice_records',r=>{r.provenance='server_verified';}],['voice_records',r=>{r.model='changed-model';}],['voice_records',r=>{r.role='system';}],['voice_sessions',r=>{r.user_id=randomUUID();}],['usage',r=>{r.input_tokens=-1;}]];
 for(const [table,change] of cases){let reached=false;await assert.rejects(new AccountCoreExport(instrument((sql,rows)=>{if(reads(sql,table)&&rows.length){reached=true;change(rows[0]);}}),f.config).capture(who,token),{code:'ACCOUNT_VOICE_USAGE_EXPORT_UNAVAILABLE'});assert(reached);assert.equal(await consumed(who),null);}
 const result=await new AccountCoreExport(instrument((sql,rows)=>{if(reads(sql,'voice_records'))rows[0].request_hash='fictional-secret-not-for-export';}),f.config).capture(who,token);assert(!JSON.stringify(result).includes('fictional-secret-not-for-export'));
});

test('empty histories are not invented and cancellation while reading voice data rolls the proof back',async()=>{
 const who=await actor(),empty=await capture(who);for(const section of ['voiceSessions','voiceRecords','legacyUsage'] as const)assert.deepEqual(empty.sections[section],[]);
 const conversationId=await room(who);await excerpt(who,conversationId);const controller=new AbortController(),token=await proof(who);
 await assert.rejects(new AccountCoreExport(instrument(sql=>{if(reads(sql,'voice_records'))controller.abort();}),f.config).capture(who,token,controller.signal),{code:'ACCOUNT_EXPORT_CANCELLED'});assert.equal(await consumed(who),null);
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(who,token)).sections.voiceRecords.length,1);
});
