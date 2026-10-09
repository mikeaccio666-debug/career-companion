import type {PoolClient} from 'pg';
import {careerRecordId as id,careerRecordObject as object} from '@companion/platform-contracts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import {ApiError} from './errors.ts';

export const MCP_EXPORT_TABLES=Object.freeze(['platform_mcp_connections','platform_mcp_receipts'] as const);
export type McpExportSection='mcpConnections'|'mcpReceipts';
type Row=Record<string,any>;
const unavailable=()=>new ApiError(503,'ACCOUNT_MCP_EXPORT_UNAVAILABLE','The saved MCP connection metadata could not be confirmed.');
function at(value:unknown,nullable=false):string|null{if(value===null&&nullable)return null;if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw unavailable();return value.toISOString();}
function text(value:unknown,max:number):string{if(typeof value!=='string'||!value.length||value.length>max)throw unavailable();return value;}
function positive(value:unknown):number{if(!Number.isSafeInteger(value)||(value as number)<1||(value as number)>2147483647)throw unavailable();return value as number;}
function choice(value:unknown,values:readonly string[]):string{if(typeof value!=='string'||!values.includes(value))throw unavailable();return value;}
function toolName(value:unknown):string{if(typeof value!=='string'||!/^[A-Za-z0-9_.-]{1,128}$/.test(value))throw unavailable();return value;}
function toolMetadata(value:unknown){
 if(!Array.isArray(value)||value.length>100)throw unavailable();const names=new Set<string>();
 return value.map(item=>{
  const tool=object(item,['name','inputSchema','schemaHash','authorization'],['description','outputSchema']),name=toolName(tool.name);
  if(names.has(name)||tool.authorization!=='reviewed_read_only'||typeof tool.schemaHash!=='string'||!/^[a-f0-9]{64}$/.test(tool.schemaHash))throw unavailable();names.add(name);
  // Definition schemas and their defaults are server-reviewed configuration,
  // not user inputs. Never spread them or their binding hashes into an archive.
  for(const field of ['inputSchema','outputSchema'])if(field==='inputSchema'||field in tool){const schema=tool[field];if(!schema||typeof schema!=='object'||Array.isArray(schema))throw unavailable();}
  return {name,...('description' in tool?{description:text(tool.description,2000)}:{}),authorization:'reviewed_read_only',provenance:'untrusted_mcp_definition'};
 });
}
/** Historical metadata only. Never consults the live catalog, discovers tools,
 * replays RPCs, recovers a job, or releases saved artifact contents. */
export async function* exportMcpInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal):AsyncGenerator<{section:McpExportSection;record:unknown}>{
 const session=object(value,['userId','tokenHash']),who=Object.freeze({userId:id(session.userId),tokenHash:session.tokenHash as string});
 if(typeof who.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(who.tokenHash))throw unavailable();
 await authorizeFixedSession(client,who,signal);
 try{
  const connections=new Set<string>();let after:string|null=null;
  for(;;){
   signal?.throwIfAborted();const rows:Row[]=(await client.query(`SELECT id,user_id,catalog_id,name,status,grant_version,tools,discovered_at,updated_at
    FROM platform_mcp_connections WHERE user_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 100`,[who.userId,after])).rows;
   for(const row of rows){signal?.throwIfAborted();if(row.user_id!==who.userId)throw unavailable();const key=id(row.id);connections.add(key);
    yield {section:'mcpConnections',record:{id:key,ownerId:who.userId,catalogId:text(row.catalog_id,150),name:text(row.name,200),storedStatus:choice(row.status,['connected','revoked']),
     grantVersion:positive(row.grant_version),tools:toolMetadata(row.tools),discoveredAt:at(row.discovered_at),updatedAt:at(row.updated_at)}};
   }
   if(rows.length<100)break;after=id(rows.at(-1)!.id);
  }
  after=null;
  for(;;){
   signal?.throwIfAborted();const rows:Row[]=(await client.query(`SELECT r.job_id,r.user_id,r.connection_id,r.generation,r.grant_version,r.tool_name,r.status,r.artifact_id,r.error_code,r.started_at,r.finished_at,
    j.user_id AS job_owner,j.kind AS job_kind,a.user_id AS artifact_owner,a.job_id AS artifact_job
    FROM platform_mcp_receipts r LEFT JOIN platform_jobs j ON j.id=r.job_id LEFT JOIN platform_artifacts a ON a.id=r.artifact_id
    WHERE r.user_id=$1 AND ($2::uuid IS NULL OR r.job_id>$2) ORDER BY r.job_id LIMIT 100`,[who.userId,after])).rows;
   for(const row of rows){
    signal?.throwIfAborted();if(row.user_id!==who.userId||row.job_owner!==who.userId||row.job_kind!=='mcp'||!connections.has(id(row.connection_id)))throw unavailable();
    const status=choice(row.status,['started','completed','tool_error','uncertain']),artifactId=row.artifact_id===null?null:id(row.artifact_id),finishedAt=at(row.finished_at,true);
    if((status==='completed'||status==='tool_error')!==(artifactId!==null)||(status==='started')!==(finishedAt===null))throw unavailable();
    if(artifactId!==null&&(row.artifact_owner!==who.userId||row.artifact_job!==row.job_id))throw unavailable();
    const errorCode=row.error_code===null?null:text(row.error_code,150);if(errorCode!==null&&!/^[A-Z][A-Z0-9_]*$/.test(errorCode))throw unavailable();
    yield {section:'mcpReceipts',record:{jobId:id(row.job_id),ownerId:who.userId,connectionId:row.connection_id,generation:positive(row.generation),grantVersion:positive(row.grant_version),
     toolName:toolName(row.tool_name),storedStatus:status,artifactId,resultIncluded:false,errorCode,startedAt:at(row.started_at),finishedAt}};
   }
   if(rows.length<100)break;after=id(rows.at(-1)!.job_id);
  }
 }catch(error){signal?.throwIfAborted();throw unavailable();}
 await authorizeFixedSession(client,who,signal);signal?.throwIfAborted();
}
