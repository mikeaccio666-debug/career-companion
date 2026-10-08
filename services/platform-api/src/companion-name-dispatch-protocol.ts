import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { FixedSessionContext } from './auth.ts';
import type { DataCrypto } from './data-crypto.ts';
import { ApiError } from './errors.ts';
import type { CompanionNameSubmissionRow } from './companion-name-safety.ts';
import { readNameRawSourceInTransaction } from './companion-name-resource-source.ts';
import { companionNameUuid, parseCompanionNameSafetyClaim, type CompanionNameSafetyClaim } from './companion-name-safety-protocol.ts';

export interface CompanionNameNotification { readonly dispatchId:string; readonly taskId:string; readonly submissionId:string; }
export type NameDispatchHold = 'authorization'|'configuration'|'requires_review'|'storage'|'terminal';
export const nameDispatchUnavailable = () => new ApiError(503,'COMPANION_NAMING_UNAVAILABLE','The saved naming operation could not be confirmed.');
export const nameDispatchHeld = () => new ApiError(409,'COMPANION_NAMING_REQUIRES_REVIEW','The saved naming execution cannot be automatically repeated.');
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const initialDigest=(row:DispatchRow)=>sha(row.payload_digest);
function closed(value:unknown, keys:readonly string[]) {
  if(!value || typeof value!=='object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw nameDispatchUnavailable();
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(value).length!==keys.length || Reflect.ownKeys(value).some(key=>typeof key!=='string'||!keys.includes(key))
    || keys.some(key=>!Object.hasOwn(descriptors,key)) || Object.values(descriptors).some(d=>!('value'in d)||!d.enumerable)) throw nameDispatchUnavailable();
  return value as Record<string,unknown>;
}
export function companionNameNotification(value:unknown):Readonly<CompanionNameNotification> {
  try {const x=closed(value,['dispatchId','taskId','submissionId']);return Object.freeze({dispatchId:companionNameUuid(x.dispatchId),taskId:companionNameUuid(x.taskId),submissionId:companionNameUuid(x.submissionId)});}
  catch {throw new ApiError(400,'INVALID_INPUT','Use one saved naming notification.');}
}
export interface DispatchRow {
  id:string;user_id:string;submission_id:string;operation_id:string;entry_id:string;task_id:string;companion_id:string;
  preview_revision:number;submitted_revision:number;expected_identity_revision:number;submitted_auth_version:string;application_operation_id:string;
  payload_digest:string;payload_ciphertext:Buffer;revision:number;last_operation_id:string|null;state_ciphertext:Buffer;accepted_at:Date;
}
interface DispatchSnapshot {
  schemaVersion:1;dispatchId:string;userId:string;submissionId:string;operationId:string;entryId:string;taskId:string;companionId:string;
  previewRevision:1;submittedRevision:number;expectedIdentityRevision:number;applicationOperationId:string;submittedAuthVersion:string;
  originalSessionHash:string;rawRequestDigest:string;sourceCaptureDigest:string;acceptedAt:string;
}
type Kind='claim'|'recover'|'start'|'hold'|'detected'|'application'|'resource';
interface OperationRow {id:string;dispatch_id:string;user_id:string;submission_id:string;revision:number;kind:Kind;
  generation:number|null;lease_token:string|null;execution_token:string|null;previous_digest:string;payload_digest:string;payload_ciphertext:Buffer;}
export interface DispatchOperation {schemaVersion:1;id:string;dispatchId:string;userId:string;submissionId:string;revision:number;kind:Kind;
  generation:number|null;leaseToken:string|null;executionToken:string|null;previousDigest:string;evidence:Record<string,unknown>;}
export interface AuthenticatedNameDispatch {row:DispatchRow;snapshot:Readonly<DispatchSnapshot>;source:CompanionNameSubmissionRow;
  operations:readonly DispatchOperation[];journalDigest:string;hold:NameDispatchHold|null;}
const coordinates=(row:CompanionNameSubmissionRow)=>[row.id,row.user_id,row.operation_id,row.entry_id,row.task_id,row.companion_id,row.preview_revision,
  row.submitted_revision,row.expected_identity_revision,String(row.submitted_auth_version),row.application_operation_id];
function snapshot(row:DispatchRow,token:string,rawDigest:string,captureDigest:string):DispatchSnapshot {
  return {schemaVersion:1,dispatchId:row.id,userId:row.user_id,submissionId:row.submission_id,operationId:row.operation_id,entryId:row.entry_id,
    taskId:row.task_id,companionId:row.companion_id,previewRevision:1,submittedRevision:row.submitted_revision,expectedIdentityRevision:row.expected_identity_revision,
    applicationOperationId:row.application_operation_id,submittedAuthVersion:String(row.submitted_auth_version),originalSessionHash:token,
    rawRequestDigest:rawDigest,sourceCaptureDigest:captureDigest,acceptedAt:row.accepted_at.toISOString()};
}
function state(row:DispatchRow,journalDigest:string) {
  return {schemaVersion:1,dispatchId:row.id,userId:row.user_id,submissionId:row.submission_id,revision:row.revision,lastOperationId:row.last_operation_id,journalDigest};
}
function sealState(crypto:DataCrypto,row:DispatchRow,digest:string) {
  return crypto.sealUtf8(JSON.stringify(state(row,digest)),{table:'platform_companion_name_dispatches',column:'state_ciphertext',rowId:row.id,ownerId:row.user_id,revision:row.revision});
}
function requireCrypto(crypto:DataCrypto|undefined):DataCrypto {if(!crypto)throw nameDispatchUnavailable();return crypto;}
export async function readNameDispatchInTransaction(client:PoolClient,maybeCrypto:DataCrypto|undefined,value:CompanionNameNotification,signal?:AbortSignal):Promise<AuthenticatedNameDispatch> {
  const crypto=requireCrypto(maybeCrypto), notification=companionNameNotification(value);
  const raw=await readNameRawSourceInTransaction(client,crypto,notification.submissionId,signal);
  const source=raw.source as CompanionNameSubmissionRow&{first_name_dispatch_id:string|null};
  const row=(await client.query<DispatchRow>('SELECT * FROM platform_companion_name_dispatches WHERE id=$1 AND user_id=$2 AND task_id=$3 AND submission_id=$4 FOR UPDATE',
    [notification.dispatchId,source.user_id,notification.taskId,source.id])).rows[0];
  if(!row || source.first_name_dispatch_id!==row.id || JSON.stringify(coordinates(source))!==JSON.stringify([row.submission_id,row.user_id,row.operation_id,row.entry_id,row.task_id,row.companion_id,row.preview_revision,row.submitted_revision,row.expected_identity_revision,String(row.submitted_auth_version),row.application_operation_id]))throw nameDispatchUnavailable();
  let capture:Readonly<DispatchSnapshot>;
  try {
    const text=crypto.openUtf8(row.payload_ciphertext,{table:'platform_companion_name_dispatches',column:'payload_ciphertext',rowId:row.id,ownerId:row.user_id,revision:row.submitted_revision});
    const data=closed(JSON.parse(text),['schemaVersion','dispatchId','userId','submissionId','operationId','entryId','taskId','companionId','previewRevision','submittedRevision','expectedIdentityRevision','applicationOperationId','submittedAuthVersion','originalSessionHash','rawRequestDigest','sourceCaptureDigest','acceptedAt']);
    const expected=snapshot(row,raw.sourceCapture.submittedSessionHash,sha(source.request_ciphertext),sha(JSON.stringify(raw.sourceCapture)));
    if(text!==JSON.stringify(expected)||sha(text)!==row.payload_digest || data.originalSessionHash!==raw.sourceCapture.submittedSessionHash)throw nameDispatchUnavailable();
    capture=Object.freeze(expected);
  } catch {throw nameDispatchUnavailable();}
  const rows=(await client.query<OperationRow>('SELECT * FROM platform_companion_name_dispatch_operations WHERE dispatch_id=$1 AND user_id=$2 ORDER BY revision,id FOR SHARE',[row.id,row.user_id])).rows;
  const ops:DispatchOperation[]=[];let digest=initialDigest(row),hold:NameDispatchHold|null=null;
  try {
    if(rows.length!==row.revision)throw nameDispatchUnavailable();
    for(const op of rows) {
      const text=crypto.openUtf8(op.payload_ciphertext,{table:'platform_companion_name_dispatch_operations',column:'payload_ciphertext',rowId:op.id,ownerId:row.user_id,revision:op.revision});
      const data=closed(JSON.parse(text),['schemaVersion','id','dispatchId','userId','submissionId','revision','kind','generation','leaseToken','executionToken','previousDigest','evidence']);
      const item:DispatchOperation={schemaVersion:1,id:op.id,dispatchId:row.id,userId:row.user_id,submissionId:row.submission_id,revision:op.revision,
        kind:op.kind,generation:op.generation,leaseToken:op.lease_token,executionToken:op.execution_token,previousDigest:digest,evidence:data.evidence as Record<string,unknown>};
      if(op.revision!==ops.length+1||op.previous_digest!==digest||sha(text)!==op.payload_digest||text!==JSON.stringify(item))throw nameDispatchUnavailable();
      validateOperation(item,capture,ops);
      if(item.kind==='hold')hold=item.evidence.reason as NameDispatchHold;
      else hold=null;
      ops.push(Object.freeze(item));digest=sha(digest+op.payload_digest);
    }
    if(row.last_operation_id!==(ops.at(-1)?.id??null) || crypto.openUtf8(row.state_ciphertext,{table:'platform_companion_name_dispatches',column:'state_ciphertext',rowId:row.id,ownerId:row.user_id,revision:row.revision})!==JSON.stringify(state(row,digest)))throw nameDispatchUnavailable();
  } catch {throw nameDispatchUnavailable();}
  await verifyActualSource(client,source,ops,hold);
  const outbox=(await client.query('SELECT dispatch_id FROM platform_companion_name_dispatch_outbox WHERE dispatch_id=$1 AND user_id=$2 AND task_id=$3 AND submission_id=$4 FOR UPDATE',[row.id,row.user_id,row.task_id,row.submission_id])).rows;
  if(outbox.length!==1)throw nameDispatchUnavailable();
  signal?.throwIfAborted();return {row,snapshot:capture,source,operations:ops,journalDigest:digest,hold};
}
async function verifyActualSource(client:PoolClient,source:CompanionNameSubmissionRow,ops:readonly DispatchOperation[],hold:NameDispatchHold|null) {
  const claimed=ops.filter(x=>x.kind==='claim'||x.kind==='recover').at(-1),started=ops.find(x=>x.kind==='start'),classified=ops.filter(x=>x.kind==='detected').at(-1);
  if(!claimed) {
    if(source.status!=='pending'||source.generation!==0||source.claim_ciphertext||source.auth_version!==null||source.detector_revision!==null||source.execution_token
      ||(await client.query("SELECT call_id FROM platform_safety_model_usage WHERE source_kind='companion_name' AND submission_id=$1 LIMIT 1 FOR SHARE",[source.id])).rowCount)throw nameDispatchUnavailable();
    return;
  }
  const claim=parseCompanionNameSafetyClaim(claimed.evidence.claim);
  if(source.generation!==claim.generation||String(source.auth_version)!==claim.authVersion||source.detector_revision!==claim.detectorRevision
    ||!source.claim_ciphertext||sha(source.claim_ciphertext)!==claimed.evidence.claimCipherDigest)throw nameDispatchUnavailable();
  if(source.status==='pending') {
    if(hold!=='requires_review'||source.lease_token!==null||source.lease_until!==null||source.execution_token!==null||classified)throw nameDispatchUnavailable();
  } else {
    const lease=(await client.query<{lease_exact:string}>('SELECT EXTRACT(EPOCH FROM lease_until)::text AS lease_exact FROM platform_companion_name_submissions WHERE id=$1',[source.id])).rows[0];
    if(source.lease_token!==claim.leaseToken||lease?.lease_exact!==claimed.evidence.leaseUntil||source.execution_token!==(started?.executionToken??null))throw nameDispatchUnavailable();
  }
  if(source.status==='detected') {
    if(!started||!classified||!source.result_ciphertext||sha(source.result_ciphertext)!==classified.evidence.resultDigest
      ||source.level!==classified.evidence.level||source.detector_mode!==classified.evidence.mode)throw nameDispatchUnavailable();
  } else if(classified||source.result_ciphertext||source.level!==null||source.detector_mode!==null)throw nameDispatchUnavailable();
  const applied=ops.filter(x=>x.kind==='application').at(-1);
  if(applied&&(!source.application_ciphertext||sha(source.application_ciphertext)!==applied.evidence.applicationDigest
    ||source.application_status!==applied.evidence.status||source.applied_identity_revision!==applied.evidence.identityRevision||source.rejected_category!==applied.evidence.rejectedCategory))throw nameDispatchUnavailable();
}
function validateOperation(op:DispatchOperation,snapshot:DispatchSnapshot,previous:readonly DispatchOperation[]) {
  if(op.kind==='claim'||op.kind==='recover') {
    const x=closed(op.evidence,['claim','claimCipherDigest','leaseUntil']),claim=parseCompanionNameSafetyClaim(x.claim);
    if(!/^[0-9a-f]{64}$/.test(String(x.claimCipherDigest))||!/^\d+(\.\d+)?$/.test(String(x.leaseUntil))
      || claim.submissionId!==snapshot.submissionId||claim.userId!==snapshot.userId||claim.operationId!==snapshot.operationId
      ||claim.entryId!==snapshot.entryId||claim.taskId!==snapshot.taskId||claim.companionId!==snapshot.companionId||claim.previewRevision!==1
      ||claim.submittedAtRevision!==snapshot.submittedRevision||claim.expectedIdentityRevision!==snapshot.expectedIdentityRevision||claim.authVersion!==snapshot.submittedAuthVersion
      ||claim.generation!==op.generation||claim.leaseToken!==op.leaseToken||op.executionToken!==null)throw nameDispatchUnavailable();
    const old=previous.filter(x=>x.kind==='claim'||x.kind==='recover').at(-1);
    if(op.kind==='claim' ? previous.some(x=>x.kind!=='hold'||x.evidence.reason!=='configuration')||claim.generation!==1 : !old||old.generation!==claim.generation
      ||previous.some(x=>x.kind==='start')||parseCompanionNameSafetyClaim(old.evidence.claim).detectorRevision!==claim.detectorRevision)throw nameDispatchUnavailable();
  } else if(op.kind==='start') {
    const x=closed(op.evidence,['claim','executionToken']),claim=parseCompanionNameSafetyClaim(x.claim),old=previous.filter(x=>x.kind==='claim'||x.kind==='recover').at(-1);
    if(!old||previous.some(x=>x.kind==='start')||JSON.stringify(claim)!==JSON.stringify(old.evidence.claim)||op.generation!==claim.generation
      ||op.leaseToken!==claim.leaseToken||op.executionToken!==companionNameUuid(x.executionToken))throw nameDispatchUnavailable();
  } else {
    if(op.generation!==null||op.leaseToken!==null||op.executionToken!==null)throw nameDispatchUnavailable();
    if(op.kind==='hold') {const x=closed(op.evidence,['reason']);if(!['authorization','configuration','requires_review','storage','terminal'].includes(String(x.reason)))throw nameDispatchUnavailable();}
    else if(op.kind==='detected') {
      const x=closed(op.evidence,['generation','resultDigest','level','mode']);if(!previous.some(x=>x.kind==='start')||x.generation!==previous.find(x=>x.kind==='start')!.generation
        ||!['L0','L1','L2'].includes(String(x.level))||!['full','keyword_only'].includes(String(x.mode))||x.level==='L0'&&x.mode!=='full'||!/^[0-9a-f]{64}$/.test(String(x.resultDigest)))throw nameDispatchUnavailable();
    } else if(op.kind==='application') {const x=closed(op.evidence,['status','applicationDigest','identityRevision','rejectedCategory']);if(!previous.some(x=>x.kind==='detected')||!['applied','name_rejected','superseded','not_eligible'].includes(String(x.status))||!/^[0-9a-f]{64}$/.test(String(x.applicationDigest)))throw nameDispatchUnavailable();}
    else if(op.kind==='resource') {const x=closed(op.evidence,['responseId','captureDigest']);if(!previous.some(x=>x.kind==='detected')||!/^[0-9a-f]{64}$/.test(String(x.captureDigest)))throw nameDispatchUnavailable();companionNameUuid(x.responseId);}
    else throw nameDispatchUnavailable();
  }
}
export async function acceptNameDispatchInTransaction(client:PoolClient,maybeCrypto:DataCrypto|undefined,submissionId:string,signal?:AbortSignal):Promise<AuthenticatedNameDispatch> {
  const crypto=requireCrypto(maybeCrypto),raw=await readNameRawSourceInTransaction(client,crypto,submissionId,signal),source=raw.source as CompanionNameSubmissionRow&{first_name_dispatch_id:string|null};
  if(source.first_name_dispatch_id) return readNameDispatchInTransaction(client,crypto,{dispatchId:source.first_name_dispatch_id,taskId:source.task_id,submissionId:source.id},signal);
  // Existing legacy raw sources are never relabelled as a newly accepted intent.
  if(source.generation!==0||source.status!=='pending'||source.claim_ciphertext||source.execution_token||source.result_ciphertext)throw nameDispatchHeld();
  const at=(await client.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0].at;
  const row:DispatchRow={id:randomUUID(),user_id:source.user_id,submission_id:source.id,operation_id:source.operation_id,entry_id:source.entry_id,task_id:source.task_id,
    companion_id:source.companion_id,preview_revision:1,submitted_revision:source.submitted_revision,expected_identity_revision:source.expected_identity_revision,
    submitted_auth_version:String(source.submitted_auth_version),application_operation_id:source.application_operation_id,payload_digest:'',payload_ciphertext:Buffer.alloc(0),revision:0,last_operation_id:null,state_ciphertext:Buffer.alloc(0),accepted_at:at};
  const capture=snapshot(row,raw.sourceCapture.submittedSessionHash,sha(source.request_ciphertext),sha(JSON.stringify(raw.sourceCapture))),text=JSON.stringify(capture);
  row.payload_digest=sha(text);row.payload_ciphertext=crypto.sealUtf8(text,{table:'platform_companion_name_dispatches',column:'payload_ciphertext',rowId:row.id,ownerId:row.user_id,revision:row.submitted_revision});
  row.state_ciphertext=sealState(crypto,row,initialDigest(row));
  await client.query(`INSERT INTO platform_companion_name_dispatches(id,user_id,submission_id,operation_id,entry_id,task_id,companion_id,preview_revision,submitted_revision,
    expected_identity_revision,submitted_auth_version,application_operation_id,payload_digest,payload_ciphertext,state_ciphertext,accepted_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,$12,$13,$14,$15)`,[row.id,row.user_id,row.submission_id,row.operation_id,row.entry_id,row.task_id,row.companion_id,row.submitted_revision,
      row.expected_identity_revision,row.submitted_auth_version,row.application_operation_id,row.payload_digest,row.payload_ciphertext,row.state_ciphertext,at]);
  await client.query('UPDATE platform_companion_name_submissions SET first_name_dispatch_id=$2 WHERE id=$1 AND first_name_dispatch_id IS NULL',[source.id,row.id]);
  await client.query('INSERT INTO platform_companion_name_dispatch_outbox(dispatch_id,user_id,task_id,submission_id) VALUES($1,$2,$3,$4)',[row.id,row.user_id,row.task_id,row.submission_id]);
  return readNameDispatchInTransaction(client,crypto,{dispatchId:row.id,taskId:row.task_id,submissionId:row.submission_id},signal);
}
async function append(client:PoolClient,crypto:DataCrypto,dispatch:AuthenticatedNameDispatch,kind:Kind,evidence:Record<string,unknown>,claim?:CompanionNameSafetyClaim,executionToken?:string) {
  const row=dispatch.row;if(row.revision===2147483647)throw nameDispatchUnavailable();
  const op:DispatchOperation={schemaVersion:1,id:randomUUID(),dispatchId:row.id,userId:row.user_id,submissionId:row.submission_id,revision:row.revision+1,kind,
    generation:claim?.generation??null,leaseToken:claim?.leaseToken??null,executionToken:executionToken??null,previousDigest:dispatch.journalDigest,evidence};
  validateOperation(op,dispatch.snapshot,dispatch.operations);const text=JSON.stringify(op),digest=sha(text);
  const ciphertext=crypto.sealUtf8(text,{table:'platform_companion_name_dispatch_operations',column:'payload_ciphertext',rowId:op.id,ownerId:row.user_id,revision:op.revision});
  await client.query(`INSERT INTO platform_companion_name_dispatch_operations(id,dispatch_id,user_id,submission_id,revision,kind,generation,lease_token,execution_token,previous_digest,payload_digest,payload_ciphertext)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[op.id,row.id,row.user_id,row.submission_id,op.revision,kind,op.generation,op.leaseToken,op.executionToken,op.previousDigest,digest,ciphertext]);
  const next={...row,revision:op.revision,last_operation_id:op.id},stateCipher=sealState(crypto,next,sha(dispatch.journalDigest+digest));
  const updated=await client.query('UPDATE platform_companion_name_dispatches SET revision=$3,last_operation_id=$4,state_ciphertext=$5 WHERE id=$1 AND user_id=$2 AND revision=$6 RETURNING id',
    [row.id,row.user_id,next.revision,op.id,stateCipher,row.revision]);if(!updated.rowCount)throw nameDispatchUnavailable();
  await client.query('UPDATE platform_companion_name_dispatch_outbox SET held_reason=$2 WHERE dispatch_id=$1',
    [row.id,kind==='hold'?evidence.reason:kind==='application'||kind==='resource'?'terminal':null]);
}
/** Legacy NULL is untouched. Managed core ports cannot borrow a later login. */
export async function managedNameClaimGate(client:PoolClient,maybeCrypto:DataCrypto|undefined,row:CompanionNameSubmissionRow,fixed:FixedSessionContext,detectorRevision:number,signal?:AbortSignal) {
  const anchor=(row as CompanionNameSubmissionRow&{first_name_dispatch_id?:string|null}).first_name_dispatch_id;
  if(!anchor)return null;
  const crypto=requireCrypto(maybeCrypto),d=await readNameDispatchInTransaction(client,crypto,{dispatchId:anchor,taskId:row.task_id,submissionId:row.id},signal);
  if(d.snapshot.originalSessionHash!==fixed.tokenHash||d.snapshot.userId!==fixed.userId||String(row.submitted_auth_version)!==d.snapshot.submittedAuthVersion)throw nameDispatchHeld();
  if((await client.query("SELECT call_id FROM platform_safety_model_usage WHERE source_kind='companion_name' AND submission_id=$1 LIMIT 1 FOR SHARE",[row.id])).rowCount||d.operations.some(x=>x.kind==='start'))throw nameDispatchHeld();
  if(!d.operations.some(x=>x.kind==='claim'||x.kind==='recover')) {
    if(d.operations.some(x=>x.kind!=='hold'||x.evidence.reason!=='configuration'))throw nameDispatchHeld();
    if(row.status!=='pending'||row.generation!==0||row.claim_ciphertext||row.auth_version!==null||row.detector_revision!==null)throw nameDispatchHeld();return {dispatch:d,recovery:false};
  }
  const previous=d.operations.filter(x=>x.kind==='claim'||x.kind==='recover').at(-1);
  if(!previous||row.status!=='running'||row.execution_token!==null||row.result_ciphertext!==null||row.generation!==previous.generation
    ||row.lease_token!==previous.leaseToken||String(row.auth_version)!==d.snapshot.submittedAuthVersion||row.detector_revision!==detectorRevision
    ||!row.claim_ciphertext||sha(row.claim_ciphertext)!==previous.evidence.claimCipherDigest)throw nameDispatchHeld();
  const lease=(await client.query<{lease_exact:string;expired:boolean}>('SELECT EXTRACT(EPOCH FROM lease_until)::text AS lease_exact,lease_until<=clock_timestamp() AS expired FROM platform_companion_name_submissions WHERE id=$1 FOR UPDATE',[row.id])).rows[0];
  if(!lease?.expired||lease.lease_exact!==previous.evidence.leaseUntil)throw nameDispatchHeld();return {dispatch:d,recovery:true};
}
export async function recordManagedNameClaim(client:PoolClient,maybeCrypto:DataCrypto|undefined,gate:Awaited<ReturnType<typeof managedNameClaimGate>>,claim:CompanionNameSafetyClaim,signal?:AbortSignal) {
  if(!gate)return;const crypto=requireCrypto(maybeCrypto);
  const row=(await client.query<CompanionNameSubmissionRow&{lease_exact:string}>('SELECT *,EXTRACT(EPOCH FROM lease_until)::text AS lease_exact FROM platform_companion_name_submissions WHERE id=$1 FOR UPDATE',[claim.submissionId])).rows[0];
  if(!row?.claim_ciphertext||row.generation!==claim.generation||row.lease_token!==claim.leaseToken)throw nameDispatchUnavailable();
  await append(client,crypto,gate.dispatch,gate.recovery?'recover':'claim',{claim,claimCipherDigest:sha(row.claim_ciphertext),leaseUntil:row.lease_exact},claim);signal?.throwIfAborted();
}
export async function assertManagedNameExecution(client:PoolClient,maybeCrypto:DataCrypto|undefined,row:CompanionNameSubmissionRow,claim:CompanionNameSafetyClaim,fixed:FixedSessionContext,executionToken?:string,signal?:AbortSignal) {
  const anchor=(row as CompanionNameSubmissionRow&{first_name_dispatch_id?:string|null}).first_name_dispatch_id;if(!anchor)return null;
  const d=await readNameDispatchInTransaction(client,maybeCrypto,{dispatchId:anchor,taskId:row.task_id,submissionId:row.id},signal);
  const lastClaim=d.operations.filter(x=>x.kind==='claim'||x.kind==='recover').at(-1),start=d.operations.find(x=>x.kind==='start');
  if(d.snapshot.originalSessionHash!==fixed.tokenHash||d.snapshot.submittedAuthVersion!==claim.authVersion||!lastClaim
    ||JSON.stringify(lastClaim.evidence.claim)!==JSON.stringify(claim)||!row.claim_ciphertext||sha(row.claim_ciphertext)!==lastClaim.evidence.claimCipherDigest)throw nameDispatchHeld();
  const lease=(await client.query<{lease_exact:string}>('SELECT EXTRACT(EPOCH FROM lease_until)::text AS lease_exact FROM platform_companion_name_submissions WHERE id=$1',[row.id])).rows[0];
  if(lease?.lease_exact!==lastClaim.evidence.leaseUntil)throw nameDispatchHeld();
  if(executionToken ? !start||start.executionToken!==executionToken||JSON.stringify(start.evidence.claim)!==JSON.stringify(claim) : !!start)throw nameDispatchHeld();
  return d;
}
export async function recordManagedNameStart(client:PoolClient,maybeCrypto:DataCrypto|undefined,d:AuthenticatedNameDispatch|null,claim:CompanionNameSafetyClaim,executionToken:string,signal?:AbortSignal) {
  if(d)await append(client,requireCrypto(maybeCrypto),d,'start',{claim,executionToken},claim,executionToken);signal?.throwIfAborted();
}
/** Worker-owned status journal; derived from real saved stages, never an execution grant. */
export async function recordNameDispatchStage(client:PoolClient,maybeCrypto:DataCrypto|undefined,d:AuthenticatedNameDispatch,kind:'hold'|'detected'|'application'|'resource',evidence:Record<string,unknown>,signal?:AbortSignal) {
  const last=d.operations.at(-1);if(last?.kind===kind&&JSON.stringify(last.evidence)===JSON.stringify(evidence))return;
  await append(client,requireCrypto(maybeCrypto),d,kind,evidence);signal?.throwIfAborted();
}
