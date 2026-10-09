import type {PoolClient} from 'pg';
import {careerRecordId,careerRecordObject} from '@companion/platform-contracts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import {parseAudioTranscriptReferences} from './audio-transcriptions.ts';
import {ApiError,attachments} from './errors.ts';

export const CONVERSATION_EXPORT_TABLES=Object.freeze(['platform_conversations','platform_messages','platform_chat_calls','platform_audio_transcriptions'] as const);
export type ConversationExportSection='conversations'|'messages'|'chatCalls'|'audioTranscriptions';
const unavailable=()=>new ApiError(503,'ACCOUNT_CONVERSATION_EXPORT_UNAVAILABLE','The saved conversation data could not be confirmed.');
const iso=(value:Date|null)=>value===null?null:value.toISOString();
function speaker(value:unknown){
 if(value===null)return null;
 const row=careerRecordObject(value,['displayName','roleLabel','sealChar','ink_token','personaRevision']);
 return {displayName:row.displayName,roleLabel:row.roleLabel,sealChar:row.sealChar,inkToken:row.ink_token,personaRevision:row.personaRevision};
}
function payload(value:unknown){
 if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===0)return {};
 if((value as Record<string,unknown>)?.event==='companion_born'){
  const row=careerRecordObject(value,['event','birthReceiptId','companionId']);
  return {event:'companion_born',birthReceiptId:careerRecordId(row.birthReceiptId),companionId:careerRecordId(row.companionId)};
 }
 const row=careerRecordObject(value,['type','welcomeId','rendering']);
 if(row.type!=='companion_intro'||row.rendering!=='fixed_intro_v1')throw unavailable();
 return {type:'companion_intro',welcomeId:careerRecordId(row.welcomeId),rendering:'fixed_intro_v1'};
}
/** Caller owns the reauthentication transaction. Read saved rows only; no stream
 * recovery, model invocation, live consent check, file fetch or context filter.
 * Every page stays in that transaction's snapshot. */
export async function* exportConversationsInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal):AsyncGenerator<{section:ConversationExportSection;record:unknown}>{
 const raw=careerRecordObject(value,['userId','tokenHash']),who={userId:careerRecordId(raw.userId),tokenHash:raw.tokenHash as string};
 if(typeof who.tokenHash!=='string'||!/^[a-f0-9]{64}$/.test(who.tokenHash))throw unavailable();
 await authorizeFixedSession(client,who,signal);
 try{
  let after:string|null=null;
  for(;;){
   signal?.throwIfAborted();
   const rows:Record<string,any>[]=(await client.query(`SELECT id,title,mode,persona,kind,companion_id,birth_receipt_id,created_at,updated_at
    FROM platform_conversations WHERE user_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 100`,[who.userId,after])).rows;
   for(const row of rows){signal?.throwIfAborted();yield {section:'conversations',record:{id:row.id,title:row.title,mode:row.mode,persona:row.persona,
    kind:row.kind,companionId:row.companion_id,birthReceiptId:row.birth_receipt_id,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)}};}
   if(rows.length<100)break;after=careerRecordId(rows.at(-1)!.id);
  }
  // Legacy messages have no user_id: only their owned parent establishes access.
  after=null;
  for(;;){
   signal?.throwIfAborted();
   const rows:Record<string,any>[]=(await client.query(`SELECT m.id,m.conversation_id,m.ordinal::text,m.role,m.content,m.status,m.provider,m.model,m.attachments,m.audio_transcripts,
    m.room_kind,m.user_id,m.companion_id,m.kind,m.speaker_kind,m.speaker_key,m.speaker_ref,m.speaker_snapshot,m.payload,m.channel,m.birth_receipt_id,m.excluded_from_context,m.created_at
    FROM platform_messages m JOIN platform_conversations c ON c.id=m.conversation_id
    WHERE c.user_id=$1 AND ($2::uuid IS NULL OR m.id>$2) ORDER BY m.id LIMIT 100`,[who.userId,after])).rows;
   const prepared=rows.map(row=>({row,ids:attachments(row.attachments).map(id=>id.toLowerCase()),audio:parseAudioTranscriptReferences(row.audio_transcripts)}));
   const uploadIds=[...new Set(prepared.flatMap(x=>x.ids))],receiptIds=[...new Set(prepared.flatMap(x=>x.audio.map(a=>a.receiptId)))];
   const uploads=new Map<string,any>((await client.query('SELECT id,user_id FROM platform_uploads WHERE id=ANY($1::uuid[])',[uploadIds])).rows.map(row=>[row.id,row]));
   const receipts=new Map<string,any>((await client.query('SELECT id,user_id,source_upload_id FROM platform_audio_transcriptions WHERE id=ANY($1::uuid[])',[receiptIds])).rows.map(row=>[row.id,row]));
   for(const {row,ids,audio} of prepared){
    signal?.throwIfAborted();if(row.user_id!==null&&row.user_id!==who.userId)throw unavailable();
    const attachmentReferences=ids.map(id=>{const source=uploads.get(id);if(source&&source.user_id!==who.userId)throw unavailable();return {id,availability:source?'metadata_present':'not_found'};});
    const audioReferences=audio.map(reference=>{const source=receipts.get(reference.receiptId);
     if(source&&(source.user_id!==who.userId||!ids.includes(source.source_upload_id)))throw unavailable();
     return {...reference,availability:source?'receipt_present':'not_found'};});
    yield {section:'messages',record:{id:row.id,conversationId:row.conversation_id,ordinal:row.ordinal,role:row.role,content:row.content,status:row.status,
     provider:row.provider,model:row.model,attachments:attachmentReferences,audioTranscripts:audioReferences,roomKind:row.room_kind,companionId:row.companion_id,
     kind:row.kind,speakerKind:row.speaker_kind,speakerKey:row.speaker_key,speakerRef:row.speaker_ref,speakerSnapshot:speaker(row.speaker_snapshot),payload:payload(row.payload),
     channel:row.channel,birthReceiptId:row.birth_receipt_id,excludedFromContext:row.excluded_from_context,createdAt:iso(row.created_at)}};
   }
   if(rows.length<100)break;after=careerRecordId(rows.at(-1)!.id);
  }
  after=null;
  for(;;){
   signal?.throwIfAborted();
   const rows:Record<string,any>[]=(await client.query(`SELECT a.id,a.client_request_id,a.source_upload_id,a.source_sha256,a.source_name,a.source_mime,a.source_size,a.provider,a.model,a.content,a.content_bytes,a.created_at,
    u.user_id AS source_owner FROM platform_audio_transcriptions a LEFT JOIN platform_uploads u ON u.id=a.source_upload_id
    WHERE a.user_id=$1 AND ($2::uuid IS NULL OR a.id>$2) ORDER BY a.id LIMIT 100`,[who.userId,after])).rows;
   for(const row of rows){signal?.throwIfAborted();if(row.source_owner!==who.userId||Buffer.byteLength(row.content)!==row.content_bytes)throw unavailable();
    yield {section:'audioTranscriptions',record:{id:row.id,requestId:row.client_request_id,sourceUploadId:row.source_upload_id,sourceSha256:row.source_sha256,
     sourceName:row.source_name,sourceMime:row.source_mime,sourceSize:row.source_size,provider:row.provider,model:row.model,text:row.content,contentBytes:row.content_bytes,
     provenance:'untrusted_audio_transcript',createdAt:iso(row.created_at)}};
   }
   if(rows.length<100)break;after=careerRecordId(rows.at(-1)!.id);
  }
  after=null;
  for(;;){
   signal?.throwIfAborted();
   const rows:Record<string,any>[]=(await client.query(`SELECT a.id,a.conversation_id,a.message_id,a.call_index,a.provider,a.model,a.status,a.usage_status,a.input_tokens,a.output_tokens,
    a.cached_input_tokens,a.cache_write_input_tokens,a.created_at,a.finished_at,c.user_id AS conversation_owner,mc.user_id AS message_owner,m.conversation_id AS message_conversation
    FROM platform_chat_calls a LEFT JOIN platform_conversations c ON c.id=a.conversation_id
    LEFT JOIN platform_messages m ON m.id=a.message_id LEFT JOIN platform_conversations mc ON mc.id=m.conversation_id
    WHERE a.user_id=$1 AND ($2::uuid IS NULL OR a.id>$2) ORDER BY a.id LIMIT 100`,[who.userId,after])).rows;
   for(const row of rows){signal?.throwIfAborted();
    if(row.conversation_id!==null&&row.conversation_owner!==who.userId||row.message_id!==null&&(row.message_owner!==who.userId||row.message_conversation!==row.conversation_id))throw unavailable();
    yield {section:'chatCalls',record:{id:row.id,conversationId:row.conversation_id,messageId:row.message_id,callIndex:row.call_index,provider:row.provider,model:row.model,
     status:row.status,usageStatus:row.usage_status,inputTokens:row.input_tokens,outputTokens:row.output_tokens,cachedInputTokens:row.cached_input_tokens,
     cacheWriteInputTokens:row.cache_write_input_tokens,createdAt:iso(row.created_at),finishedAt:iso(row.finished_at)}};
   }
   if(rows.length<100)break;after=careerRecordId(rows.at(-1)!.id);
  }
  await authorizeFixedSession(client,who,signal);signal?.throwIfAborted();
 }catch(error){if(signal?.aborted)throw error;throw unavailable();}
}
