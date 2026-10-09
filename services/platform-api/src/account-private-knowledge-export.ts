import type {PoolClient} from 'pg';
import {careerRecordId as id,careerRecordObject as object} from '@companion/platform-contracts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import {ApiError} from './errors.ts';

export const PRIVATE_KNOWLEDGE_EXPORT_TABLES=Object.freeze(['platform_knowledge_sources','platform_knowledge_passages'] as const);
export type PrivateKnowledgeExportSection='privateKnowledgeSources'|'privateKnowledgePassages';
type Row=Record<string,any>;
const unavailable=()=>new ApiError(503,'ACCOUNT_PRIVATE_KNOWLEDGE_EXPORT_UNAVAILABLE','The saved private knowledge records could not be confirmed.');
function at(value:unknown,nullable=false):string|null{if(value===null&&nullable)return null;if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw unavailable();return value.toISOString();}
function text(value:unknown,max:number,nullable=false):string|null{if(value===null&&nullable)return null;if(typeof value!=='string'||!value.length||Array.from(value).length>max)throw unavailable();return value;}
function integer(value:unknown,min:number,max:number):number{if(!Number.isSafeInteger(value)||Object.is(value,-0)||(value as number)<min||(value as number)>max)throw unavailable();return value as number;}
/** Historical owner data only. Never invokes search, URL fetch, ingestion,
 * current tokenization, re-chunking or organization knowledge access. */
export async function* exportPrivateKnowledgeInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal):AsyncGenerator<{section:PrivateKnowledgeExportSection;record:unknown}>{
 const session=object(value,['userId','tokenHash']),who=Object.freeze({userId:id(session.userId),tokenHash:session.tokenHash as string});
 if(typeof who.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(who.tokenHash))throw unavailable();
 await authorizeFixedSession(client,who,signal);
 try{
  const sources=new Map<string,{revision:number;content:string|null;passageCount:number;seen:number;offset:number}>();let after:string|null=null;
  for(;;){
   signal?.throwIfAborted();const rows:Row[]=(await client.query(`SELECT id,user_id,title,content,source_label,source_url,revision,passage_count,byte_size,created_at,updated_at,deleted_at
    FROM platform_knowledge_sources WHERE user_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 100`,[who.userId,after])).rows;
   for(const row of rows){
    signal?.throwIfAborted();if(row.user_id!==who.userId)throw unavailable();
    const key=id(row.id),revision=integer(row.revision,1,2147483647),passageCount=integer(row.passage_count,0,128),bytes=integer(row.byte_size,0,65536),deletedAt=at(row.deleted_at,true);
    const content=text(row.content,65536,true);
    if(deletedAt===null?(content===null||Buffer.byteLength(content)!==bytes||passageCount===0):(content!==null||bytes!==0||passageCount!==0||row.source_label!==null||row.source_url!==null))throw unavailable();
    sources.set(key,{revision,content,passageCount,seen:0,offset:0});
    yield {section:'privateKnowledgeSources',record:{id:key,ownerId:who.userId,title:text(row.title,120),content,sourceLabel:text(row.source_label,200,true),sourceUrl:text(row.source_url,2048,true),
     revision,passageCount,byteSize:bytes,provenance:'untrusted_knowledge',createdAt:at(row.created_at),updatedAt:at(row.updated_at),deletedAt}};
   }
   if(rows.length<100)break;after=id(rows.at(-1)!.id);
  }
  let cursor:readonly[string,number,number]|null=null;
  for(;;){
   signal?.throwIfAborted();const rows:Row[]=(await client.query(`SELECT p.source_id,p.revision,p.passage_id,p.passage_index,p.content,s.user_id
    FROM platform_knowledge_passages p JOIN platform_knowledge_sources s ON s.id=p.source_id
    WHERE s.user_id=$1 AND ($2::uuid IS NULL OR (p.source_id,p.revision,p.passage_index)>($2::uuid,$3::integer,$4::integer))
    ORDER BY p.source_id,p.revision,p.passage_index LIMIT 100`,[who.userId,cursor?.[0]??null,cursor?.[1]??null,cursor?.[2]??null])).rows;
   for(const row of rows){
    signal?.throwIfAborted();if(row.user_id!==who.userId)throw unavailable();const sourceId=id(row.source_id),source=sources.get(sourceId),revision=integer(row.revision,1,2147483647),index=integer(row.passage_index,0,127),content=text(row.content,1200)!;
    if(!source||source.content===null||source.revision!==revision||row.passage_id!==`${revision}:${index}`||index!==source.seen||index>=source.passageCount||!source.content.startsWith(content,source.offset))throw unavailable();
    source.seen++;source.offset+=content.length;
    yield {section:'privateKnowledgePassages',record:{sourceId,ownerId:who.userId,revision,passageId:row.passage_id,passageIndex:index,text:content,provenance:'untrusted_knowledge'}};
   }
   if(rows.length<100)break;const last=rows.at(-1)!;cursor=[id(last.source_id),last.revision,last.passage_index];
  }
  for(const source of sources.values())if(source.seen!==source.passageCount||source.offset!==(source.content?.length??0))throw unavailable();
 }catch(error){signal?.throwIfAborted();throw unavailable();}
 await authorizeFixedSession(client,who,signal);signal?.throwIfAborted();
}
