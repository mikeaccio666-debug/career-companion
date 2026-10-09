import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {careerRecordId as id,careerRecordObject as object} from '@companion/platform-contracts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import type {PlatformConfig} from './config.ts';
import {ApiError} from './errors.ts';
import {readNameDispatchInTransaction,type DispatchOperation} from './companion-name-dispatch-protocol.ts';
import {readArchivedPrebirthInventory} from './companion-prebirth-protocol.ts';

export const PREBIRTH_DISPATCH_EXPORT_TABLES=Object.freeze(['platform_companion_name_dispatches','platform_companion_name_dispatch_operations',
 'platform_companion_name_dispatch_outbox','platform_companion_prebirth_heads','platform_companion_prebirth_inventory'] as const);
export type PrebirthDispatchExportSection='nameDispatches'|'nameDispatchOperations'|'nameDispatchOutbox'|'prebirthHeads'|'prebirthInventory';
type Row=Record<string,any>;
const unavailable=()=>new ApiError(503,'ACCOUNT_PREBIRTH_DISPATCH_EXPORT_UNAVAILABLE','The original prebirth and naming task history could not be confirmed.');
const at=(d:Date)=>{if(!(d instanceof Date)||!Number.isFinite(d.getTime()))throw unavailable();return d.toISOString();};
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const holds=['authorization','configuration','requires_review','storage','terminal'];
function evidence(op:DispatchOperation){
 const e=op.evidence;
 switch(op.kind){
  case 'claim':case 'recover':return {detectorRevision:(e.claim as Row).detectorRevision,leaseUntilEpoch:e.leaseUntil};
  case 'start':return {};
  case 'hold':return {reason:e.reason};
  case 'detected':return {generation:e.generation,level:e.level,mode:e.mode};
  case 'application':return {status:e.status,identityRevision:e.identityRevision,rejectedCategory:e.rejectedCategory};
  case 'resource':return {responseId:e.responseId};
 }
}
/** Historical records only. The caller supplies already authenticated response
 * sections from the same owner snapshot. Queue metadata grants no execution. */
export class AccountPrebirthDispatchExport {
 constructor(private readonly config:Pick<PlatformConfig,'dataCrypto'>){}
 async *exportInTransaction(client:PoolClient,value:FixedSessionContext,archive:{nameSafetyResponses:readonly unknown[]},signal?:AbortSignal):AsyncGenerator<{section:PrebirthDispatchExportSection;record:unknown}>{
  const raw=object(value,['userId','tokenHash']),who={userId:id(raw.userId),tokenHash:raw.tokenHash as string};
  if(typeof who.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(who.tokenHash))throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');
  await authorizeFixedSession(client,who,signal);
  try{
   const counts={heads:0,inventory:0,dispatches:0,operations:0,outbox:0};
   const owner=(await client.query('SELECT prebirth_inventory_owner_id FROM platform_users WHERE id=$1',[who.userId])).rows[0];
   if(!owner)throw unavailable();
   if(owner.prebirth_inventory_owner_id!==null){
    const inventory=await readArchivedPrebirthInventory(client,this.config.dataCrypto,who.userId,signal);
    if(!inventory.head)throw unavailable();counts.heads++;
    yield {section:'prebirthHeads',record:inventory.head};
    for(const record of inventory.records){signal?.throwIfAborted();counts.inventory++;yield {section:'prebirthInventory',record};}
   }
   const responses=new Map<string,Row>();
   for(const value of archive.nameSafetyResponses){const r=value as Row;if(r.ownerId!==who.userId||responses.has(r.id))throw unavailable();responses.set(r.id,r);}
   let after:string|null=null;
   for(;;){
    signal?.throwIfAborted();
    const page=(await client.query('SELECT * FROM platform_companion_name_dispatches WHERE user_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 100',[who.userId,after])).rows;
    for(const listed of page){
     if(listed.user_id!==who.userId)throw unavailable();
     const dispatch=await readNameDispatchInTransaction(client,this.config.dataCrypto,{dispatchId:listed.id,taskId:listed.task_id,submissionId:listed.submission_id},signal,false),r=dispatch.row;
     if(r.user_id!==who.userId||r.id!==listed.id)throw unavailable();counts.dispatches++;
     yield {section:'nameDispatches',record:{id:r.id,ownerId:r.user_id,submissionId:r.submission_id,operationId:r.operation_id,entryId:r.entry_id,
      taskId:r.task_id,companionId:r.companion_id,previewRevision:r.preview_revision,submittedRevision:r.submitted_revision,
      expectedIdentityRevision:r.expected_identity_revision,applicationOperationId:r.application_operation_id,revision:r.revision,
      latestOperationId:r.last_operation_id,acceptedAt:at(r.accepted_at),journalHold:dispatch.hold}};
     let previousAt=r.accepted_at;
     for(const op of dispatch.operations){
      signal?.throwIfAborted();
      const actual=(await client.query('SELECT id,dispatch_id,user_id,submission_id,revision,created_at FROM platform_companion_name_dispatch_operations WHERE id=$1 AND user_id=$2',[op.id,who.userId])).rows[0];
      if(!actual||actual.id!==op.id||actual.dispatch_id!==r.id||actual.user_id!==who.userId||actual.submission_id!==r.submission_id
       ||actual.revision!==op.revision||actual.created_at<previousAt)throw unavailable();
      previousAt=actual.created_at;
      if(op.kind==='resource'){
       const original=responses.get(String(op.evidence.responseId));
       const response=(await client.query('SELECT id,user_id,submission_id,source_generation,payload_ciphertext FROM platform_companion_name_safety_responses WHERE id=$1 AND user_id=$2',[op.evidence.responseId,who.userId])).rows[0];
       if(!original||original.status!=='ready'||original.submissionId!==r.submission_id||!response||response.user_id!==who.userId||response.id!==original.id
        ||response.submission_id!==r.submission_id||response.source_generation!==dispatch.source.generation||response.source_generation!==original.sourceGeneration
        ||!Buffer.isBuffer(response.payload_ciphertext)||sha(response.payload_ciphertext)!==op.evidence.captureDigest)throw unavailable();
      }
      counts.operations++;yield {section:'nameDispatchOperations',record:{id:op.id,ownerId:who.userId,dispatchId:r.id,submissionId:r.submission_id,
       revision:op.revision,kind:op.kind,generation:op.generation,evidence:evidence(op),recordedAt:at(actual.created_at)}};
     }
     const outbox=(await client.query('SELECT * FROM platform_companion_name_dispatch_outbox WHERE dispatch_id=$1 AND user_id=$2',[r.id,who.userId])).rows;
     const o=outbox[0];
     if(outbox.length!==1||o.dispatch_id!==r.id||o.user_id!==who.userId||o.task_id!==r.task_id||o.submission_id!==r.submission_id
      ||o.created_at<r.accepted_at||o.dispatched_at!==null&&o.dispatched_at<o.created_at||o.held_reason!==null&&!holds.includes(o.held_reason))throw unavailable();
     counts.outbox++;yield {section:'nameDispatchOutbox',record:{dispatchId:r.id,ownerId:who.userId,taskId:r.task_id,submissionId:r.submission_id,
      kind:'notification_metadata',heldReason:o.held_reason,createdAt:at(o.created_at),lastDispatchedAt:o.dispatched_at===null?null:at(o.dispatched_at)}};
    }
    if(page.length<100)break;after=id(page.at(-1).id);
   }
   const audit=(await client.query(`SELECT
    (SELECT count(*)::int FROM platform_companion_prebirth_heads WHERE user_id=$1) AS heads,
    (SELECT count(*)::int FROM platform_companion_prebirth_inventory WHERE user_id=$1) AS inventory,
    (SELECT count(*)::int FROM platform_companion_name_dispatches WHERE user_id=$1) AS dispatches,
    (SELECT count(*)::int FROM platform_companion_name_dispatch_operations WHERE user_id=$1) AS operations,
    (SELECT count(*)::int FROM platform_companion_name_dispatch_outbox WHERE user_id=$1) AS outbox,
    EXISTS(SELECT 1 FROM platform_companion_name_submissions s LEFT JOIN platform_companion_name_dispatches d ON d.id=s.first_name_dispatch_id AND d.user_id=s.user_id
     WHERE s.user_id=$1 AND s.first_name_dispatch_id IS NOT NULL AND d.id IS NULL) AS missing_dispatch,
    EXISTS(SELECT 1 FROM platform_companion_prebirth_heads WHERE user_id=$1 AND adopted_at>clock_timestamp()
     UNION ALL SELECT 1 FROM platform_companion_prebirth_inventory WHERE user_id=$1 AND enrolled_at>clock_timestamp()
     UNION ALL SELECT 1 FROM platform_companion_name_dispatches WHERE user_id=$1 AND accepted_at>clock_timestamp()
     UNION ALL SELECT 1 FROM platform_companion_name_dispatch_operations WHERE user_id=$1 AND created_at>clock_timestamp()
     UNION ALL SELECT 1 FROM platform_companion_name_dispatch_outbox WHERE user_id=$1 AND (created_at>clock_timestamp() OR dispatched_at>clock_timestamp())) AS future`,[who.userId])).rows[0];
   if(!audit||Object.entries(counts).some(([key,count])=>audit[key]!==count)||audit.missing_dispatch||audit.future)throw unavailable();
  }catch{signal?.throwIfAborted();throw unavailable();}
  await authorizeFixedSession(client,who,signal);signal?.throwIfAborted();
 }
}
