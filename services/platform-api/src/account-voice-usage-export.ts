import type {PoolClient} from 'pg';
import {careerRecordId as id,careerRecordObject as object} from '@companion/platform-contracts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import {ApiError,attachments} from './errors.ts';

export const VOICE_USAGE_EXPORT_TABLES=Object.freeze(['platform_voice_sessions','platform_voice_records','platform_usage'] as const);
export type VoiceUsageExportSection='voiceSessions'|'voiceRecords'|'legacyUsage';
type Row=Record<string,any>;
const unavailable=()=>new ApiError(503,'ACCOUNT_VOICE_USAGE_EXPORT_UNAVAILABLE','The saved voice and legacy usage records could not be confirmed.');
function at(value:unknown,nullable=false):string|null{if(value===null&&nullable)return null;if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw unavailable();return value.toISOString();}
function text(value:unknown,max:number,nullable=false):string|null{if(value===null&&nullable)return null;if(typeof value!=='string'||!value.length||value.length>max)throw unavailable();return value;}
function count(value:unknown):number{if(!Number.isSafeInteger(value)||Object.is(value,-0)||(value as number)<0||(value as number)>2147483647)throw unavailable();return value as number;}
function choice(value:unknown,values:readonly string[]):string{if(typeof value!=='string'||!values.includes(value))throw unavailable();return value;}
function ordinal(value:unknown):string{if(typeof value!=='string'||!/^[1-9][0-9]*$/.test(value))throw unavailable();return value;}
function conversation(row:Row,owner:string):string|null{if(row.conversation_id===null)return null;if(row.conversation_owner!==owner)throw unavailable();return id(row.conversation_id);}
const queries={
 platform_voice_sessions:`SELECT v.id,v.user_id,v.conversation_id,v.provider,v.model,v.created_at,v.expires_at,v.save_until,v.released_at,c.user_id AS conversation_owner
  FROM platform_voice_sessions v LEFT JOIN platform_conversations c ON c.id=v.conversation_id`,
 platform_voice_records:`SELECT v.id,v.user_id,v.conversation_id,v.client_record_id,v.source,v.role,v.provenance,v.content,v.content_bytes,v.session_id,v.provider,v.model,v.attachment_ids,v.ordinal::text,v.created_at,c.user_id AS conversation_owner
  FROM platform_voice_records v LEFT JOIN platform_conversations c ON c.id=v.conversation_id`,
 platform_usage:`SELECT v.id,v.user_id,v.conversation_id,v.message_id,v.provider,v.model,v.capability,v.input_tokens,v.output_tokens,v.created_at,
  c.user_id AS conversation_owner,mc.user_id AS message_owner,m.user_id AS message_direct_owner,m.conversation_id AS message_conversation
  FROM platform_usage v LEFT JOIN platform_conversations c ON c.id=v.conversation_id
  LEFT JOIN platform_messages m ON m.id=v.message_id LEFT JOIN platform_conversations mc ON mc.id=m.conversation_id`,
} as const;
async function* pages(client:PoolClient,owner:string,table:typeof VOICE_USAGE_EXPORT_TABLES[number],signal?:AbortSignal){
 let after:string|null=null;
 for(;;){signal?.throwIfAborted();const found:Row[]=(await client.query(`${queries[table]} WHERE v.user_id=$1 AND ($2::uuid IS NULL OR v.id>$2) ORDER BY v.id LIMIT 100`,[owner,after])).rows;
  for(const row of found){signal?.throwIfAborted();if(row.user_id!==owner)throw unavailable();}
  yield found;
  if(found.length<100)break;after=id(found.at(-1)!.id);
 }
}
async function* rows(client:PoolClient,owner:string,table:typeof VOICE_USAGE_EXPORT_TABLES[number],signal?:AbortSignal){for await(const page of pages(client,owner,table,signal))yield* page;}
/** Reads saved excerpts and counters only. No live voice-session creation,
 * usage recovery, recording, provider call or model-context promotion. */
export async function* exportVoiceUsageInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal):AsyncGenerator<{section:VoiceUsageExportSection;record:unknown}>{
 const session=object(value,['userId','tokenHash']),who=Object.freeze({userId:id(session.userId),tokenHash:session.tokenHash as string});
 if(typeof who.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(who.tokenHash))throw unavailable();
 await authorizeFixedSession(client,who,signal);
 try{
  const ownerId=who.userId,sessions=new Map<string,{ref:string;conversationId:string|null;provider:string;model:string}>();
  for await(const row of rows(client,ownerId,'platform_voice_sessions',signal)){
   // Stored session IDs are also execution lease IDs. Archive-local references
   // preserve excerpt links without serializing those live identifiers.
   const key=id(row.id),saved={ref:`voice-session-${sessions.size+1}`,conversationId:conversation(row,ownerId),provider:text(row.provider,80)!,model:text(row.model,150)!};sessions.set(key,saved);
   yield {section:'voiceSessions',record:{sessionRef:saved.ref,ownerId,conversationId:saved.conversationId,provider:saved.provider,model:saved.model,
    createdAt:at(row.created_at),expiresAt:at(row.expires_at),saveUntil:at(row.save_until),releasedAt:at(row.released_at,true)}};
  }
  for await(const page of pages(client,ownerId,'platform_voice_records',signal)){
   const prepared=page.map(row=>({row,ids:attachments(row.attachment_ids).map(value=>value.toLowerCase())}));
   const uploadIds=[...new Set(prepared.flatMap(item=>item.ids))];
   const uploads=new Map<string,Row>((await client.query('SELECT id,user_id FROM platform_uploads WHERE id=ANY($1::uuid[])',[uploadIds])).rows.map(row=>[row.id,row]));
   for(const {row,ids} of prepared){
   signal?.throwIfAborted();
   const conversationId=conversation(row,ownerId),source=choice(row.source,['realtime_transcript','transcription_excerpt','speech_excerpt']);
   if(conversationId===null||row.provenance!=='client_submitted'||typeof row.content!=='string'||!row.content||Buffer.byteLength(row.content)!==count(row.content_bytes))throw unavailable();
   let sessionRef:string|null=null;
   if(source==='realtime_transcript'){
    const saved=sessions.get(id(row.session_id));
    if(!saved||saved.conversationId!==null&&saved.conversationId!==conversationId||saved.provider!==row.provider||saved.model!==row.model)throw unavailable();sessionRef=saved.ref;
   }else if(row.session_id!==null||row.provider!==null||row.model!==null)throw unavailable();
   if(new Set(ids).size!==ids.length)throw unavailable();
   const references=ids.map(key=>{const upload=uploads.get(key);if(upload&&upload.user_id!==ownerId)throw unavailable();return {id:key,availability:upload?'metadata_present':'not_found'};});
   yield {section:'voiceRecords',record:{id:id(row.id),ownerId,conversationId,clientRecordId:id(row.client_record_id),source,role:choice(row.role,['user','assistant','unknown']),
    provenance:'client_submitted',text:row.content,contentBytes:row.content_bytes,sessionRef,provider:row.provider,model:row.model,attachments:references,ordinal:ordinal(row.ordinal),createdAt:at(row.created_at)}};
  }
  }
  for await(const row of rows(client,ownerId,'platform_usage',signal)){
   const conversationId=conversation(row,ownerId),messageId=row.message_id===null?null:id(row.message_id);
   if(messageId!==null&&(row.message_owner!==ownerId||row.message_direct_owner!==null&&row.message_direct_owner!==ownerId||row.message_conversation!==conversationId))throw unavailable();
   yield {section:'legacyUsage',record:{id:id(row.id),ownerId,conversationId,messageId,provider:text(row.provider,80),model:text(row.model,150,true),capability:text(row.capability,80),
    provenance:'legacy_usage_record',usageStatus:'not_recorded',storedInputTokens:count(row.input_tokens),storedOutputTokens:count(row.output_tokens),createdAt:at(row.created_at)}};
  }
 }catch(error){signal?.throwIfAborted();throw unavailable();}
 await authorizeFixedSession(client,who,signal);signal?.throwIfAborted();
}
