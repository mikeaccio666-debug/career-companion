import type {PoolClient} from 'pg';
import {careerRecordId as id,careerRecordObject as object} from '@companion/platform-contracts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import type {PlatformConfig} from './config.ts';
import {ApiError} from './errors.ts';
import {memoryCanonical as canonical,memoryObject,openMemorySource,parseMemorySafetyClaim,memorySafetyResult,readMemorySafetyBlock} from './shared-memory-safety-protocol.ts';

export const MEMORY_SAFETY_EXPORT_TABLES=Object.freeze(['platform_memory_safety_sources','platform_memory_safety_blocks'] as const);
export type MemorySafetyExportSection='memorySafetySources'|'memorySafetyBlocks';
const unavailable=()=>new ApiError(503,'ACCOUNT_MEMORY_SAFETY_EXPORT_UNAVAILABLE','The retained memory classification records could not be confirmed.');
type Row=Record<string,any>;
function at(value:unknown){if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw unavailable();return value.toISOString();}
/** Historical classification is not current permission to share a memory. This
 * reader neither claims work nor checks/activates the current detector policy. */
export class AccountMemorySafetyExport {
 constructor(private readonly config:Pick<PlatformConfig,'dataCrypto'>){}
 private async *rows(client:PoolClient,owner:string,table:typeof MEMORY_SAFETY_EXPORT_TABLES[number],signal?:AbortSignal){
  let after:string|null=null;
  for(;;){signal?.throwIfAborted();const found:Row[]=(await client.query(`SELECT * FROM ${table} WHERE user_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 100`,[owner,after])).rows;
   for(const row of found){signal?.throwIfAborted();if(row.user_id!==owner)throw unavailable();id(row.id);yield row;}
   if(found.length<100)break;after=id(found.at(-1)!.id);
  }
 }
 async *exportInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal):AsyncGenerator<{section:MemorySafetyExportSection;record:unknown}>{
  const raw=object(value,['userId','tokenHash']),who=Object.freeze({userId:id(raw.userId),tokenHash:raw.tokenHash as string});
  if(typeof who.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(who.tokenHash))throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');
  await authorizeFixedSession(client,who,signal);
  try{
   const crypto=this.config.dataCrypto,sources=new Map<string,{source:unknown;result:Awaited<ReturnType<typeof memorySafetyResult>>|null}>(),blocks=new Set<string>();
   for await(const row of this.rows(client,who.userId,'platform_memory_safety_sources',signal)){
    if(!crypto)throw unavailable();
    const source=openMemorySource(crypto,row);
    const operation=(await client.query('SELECT applied_revision FROM platform_memory_operations WHERE user_id=$1 AND memory_id=$2 AND operation_id=$3',[who.userId,source.memoryId,source.operationId])).rows[0];
    if(operation?.applied_revision!==source.submittedAtRevision||!['pending','running','detected'].includes(row.status)
     ||!Number.isSafeInteger(row.generation)||row.generation<0||row.generation>2147483647||![null,'unavailable'].includes(row.failure))throw unavailable();
    if(row.generation===0){
     if(row.status!=='pending'||[row.auth_version,row.lease_token,row.lease_until,row.execution_token,row.detector_revision,row.claim_ciphertext,row.result_ciphertext,row.level,row.detector_mode].some(x=>x!==null))throw unavailable();
    }else{
     const text=crypto.openUtf8(row.claim_ciphertext,{table:'platform_memory_safety_sources',column:'claim_ciphertext',rowId:row.id,ownerId:who.userId,revision:row.generation});
     const saved=memoryObject(JSON.parse(text),['claim','sessionTokenHash','source']),claim=parseMemorySafetyClaim(saved.claim);
     if(canonical(saved)!==text||canonical(saved.source)!==canonical(source)||typeof saved.sessionTokenHash!=='string'||!/^[0-9a-f]{64}$/.test(saved.sessionTokenHash)
      ||claim.userId!==who.userId||claim.submissionId!==row.id||claim.memoryId!==row.memory_id||claim.operationId!==row.operation_id
      ||claim.submittedAtRevision!==row.submitted_revision||claim.generation!==row.generation||claim.authVersion!==String(row.auth_version)
      ||claim.detectorRevision!==row.detector_revision||claim.detectorRevision!==source.policyRevision
      ||(row.lease_token!==null&&claim.leaseToken!==row.lease_token))throw unavailable();
     if(row.status!=='pending'&&(row.lease_token===null||row.lease_until===null))throw unavailable();
    }
    if(row.status!=='detected'&&[row.result_ciphertext,row.level,row.detector_mode].some(x=>x!==null))throw unavailable();
    const result=row.status==='detected'?await memorySafetyResult(client,crypto,row,source,false):null;
    sources.set(row.id,{source,result});
    yield {section:'memorySafetySources',record:{...source,status:row.status,generation:row.generation,detectorRevision:row.detector_revision,
     failure:row.failure,leaseUntil:row.lease_until===null?null:at(row.lease_until),result}};
   }
   for await(const row of this.rows(client,who.userId,'platform_memory_safety_blocks',signal)){
    if(!crypto)throw unavailable();const record=await readMemorySafetyBlock(client,crypto,who.userId,row,false),saved=sources.get(record.sourceId);
    if(blocks.has(record.sourceId)||saved&&(canonical(saved.source)!==canonical(record.source)||canonical(saved.result)!==canonical({decision:record.decision,policy:record.policy})))throw unavailable();
    // A retained receipt may outlive its memory/source. Do not restore either.
    blocks.add(record.sourceId);yield {section:'memorySafetyBlocks',record};
   }
   for(const [key,saved] of sources)if(saved.result&&saved.result.decision.level!=='L0'&&!blocks.has(key))throw unavailable();
  }catch{signal?.throwIfAborted();throw unavailable();}
  await authorizeFixedSession(client,who,signal);signal?.throwIfAborted();
 }
}
