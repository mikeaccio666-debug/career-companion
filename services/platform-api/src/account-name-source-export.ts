import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {careerRecordId as id,careerRecordObject as object} from '@companion/platform-contracts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import type {PlatformConfig} from './config.ts';
import {ApiError} from './errors.ts';
import {identityArchiveValidator,type IdentityGenerationArchive} from './account-companion-identity-export.ts';
import {captureArchivedNameRequest,authenticateArchivedNameClaim,readNameResourceSourceInTransaction} from './companion-name-resource-source.ts';
import {parseCompanionNameSafetyClaim} from './companion-name-safety-protocol.ts';
import type {CompanionNameSubmissionRow} from './companion-name-safety.ts';
export const NAME_SOURCE_EXPORT_TABLES=Object.freeze(['platform_companion_name_entries','platform_companion_name_submissions','platform_companion_name_identity_receipts','platform_companion_name_identity_provenance'] as const);
export type NameSourceExportSection='companionNameEntries'|'companionNameSubmissions'|'companionNameIdentityReceipts'|'companionNameIdentityProvenance';
export interface NameSourceArchive {readonly generation:IdentityGenerationArchive;readonly identities:readonly unknown[];readonly identityOperations:readonly unknown[]}
type Row=Record<string,any>;
const unavailable=()=>new ApiError(503,'ACCOUNT_NAME_SOURCE_EXPORT_UNAVAILABLE','The original naming sources and outcomes could not be confirmed.');
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
const at=(d:Date)=>{if(!(d instanceof Date)||!Number.isFinite(d.getTime()))throw unavailable();return d.toISOString();};
/** Exact original inputs and observed outcomes only; archive data never grants
 * a classifier lease, permission to apply a name, or permission to share risk text. */
export class AccountNameSourceExport {
 constructor(private readonly config:Pick<PlatformConfig,'dataCrypto'>){}
 private async *rows(client:PoolClient,owner:string,table:typeof NAME_SOURCE_EXPORT_TABLES[number],signal?:AbortSignal){
  const composite=table==='platform_companion_name_identity_provenance',key=composite?'draft_id':table==='platform_companion_name_identity_receipts'?'operation_id':'id';let after:string|null=null,revision=0;
  for(;;){signal?.throwIfAborted();const found:Row[]=(await client.query(`SELECT * FROM ${table} WHERE user_id=$1 AND ($2::uuid IS NULL OR ${composite?'(draft_id,identity_revision)>($2::uuid,$3::int)':key+'>$2'})
    ORDER BY ${key}${composite?',identity_revision':''} LIMIT 100`,composite?[owner,after,revision]:[owner,after])).rows;
   for(const row of found){signal?.throwIfAborted();if(row.user_id!==owner)throw unavailable();yield row;}
   if(found.length<100)break;after=id(found.at(-1)![key]);if(composite)revision=found.at(-1)!.identity_revision;
  }
 }
 async *exportInTransaction(client:PoolClient,value:FixedSessionContext,archive:NameSourceArchive,signal?:AbortSignal):AsyncGenerator<{section:NameSourceExportSection;record:unknown}>{
  const raw=object(value,['userId','tokenHash']),who=Object.freeze({userId:id(raw.userId),tokenHash:raw.tokenHash as string});
  if(typeof who.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(who.tokenHash))throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');
  await authorizeFixedSession(client,who,signal);
  try{
   const crypto=this.config.dataCrypto,validator=identityArchiveValidator(client,who.userId,archive.generation),previews=new Map<string,Row>();
   for(const value of archive.generation.revisions){const r=value as Row,original=validator.originals.get(r.taskId);if(!original)throw unavailable();
    previews.set(r.taskId,{preview:{summary:r.summary,samples:r.samples,companionId:r.companionId,revision:1,generatedBy:r.generatedBy,inkToken:r.inkToken,styleCard:r.styleCard,quirks:r.quirks},dimensions:r.dimensions,source:original.source});}
   const identities=new Map(archive.identities.map(value=>{const r=value as Row;if(r.userId!==who.userId)throw unavailable();return [r.id,r] as const;}));
   const commands=new Map(archive.identityOperations.map(value=>{const r=value as Row;if(r.ownerId!==who.userId)throw unavailable();return [r.command.operationId,r] as const;}));
   const open=(row:Row,table:string,column:string,key:string,revision:number)=>{if(!crypto)throw unavailable();return crypto.openUtf8(row[column],{table,column,rowId:key,ownerId:who.userId,revision});};
   const entries=new Map<string,{row:Row;preview:Row;versions:Map<number,string>}>();
   for await(const r of this.rows(client,who.userId,'platform_companion_name_entries',signal)){
    const preview=previews.get(r.task_id);if(!preview||r.companion_id!==preview.source.companionId||r.preview_revision!==1||!Number.isInteger(r.revision)||r.revision<1||entries.has(r.id))throw unavailable();
    const payload={schemaVersion:1,id:r.id,userId:who.userId,taskId:r.task_id,companionId:r.companion_id,previewRevision:1,revision:r.revision,latestSubmissionId:r.latest_submission_id,previewCapture:preview};
    if(open(r,'platform_companion_name_entries','payload_ciphertext',r.id,r.revision)!==JSON.stringify(payload))throw unavailable();
    const {payload_ciphertext:_cipher,...metadata}=r;entries.set(r.id,{row:metadata,preview,versions:new Map()});
    yield {section:'companionNameEntries',record:{...payload,createdAt:at(r.created_at),updatedAt:at(r.updated_at)}};
   }
   const applied=new Map<string,{operationId:string;draftId:string;revision:number;generation:number;applicationHash:string;identity:Row}>();
   for await(const rawRow of this.rows(client,who.userId,'platform_companion_name_submissions',signal)){
    if(!crypto)throw unavailable();const row=rawRow as CompanionNameSubmissionRow,entry=entries.get(row.entry_id);
    if(!entry||row.task_id!==entry.row.task_id||row.companion_id!==entry.row.companion_id||row.preview_revision!==1||row.submitted_revision<1||row.submitted_revision>entry.row.revision
     ||entry.versions.has(row.submitted_revision)||!['pending','running','detected'].includes(row.status)||!Number.isInteger(row.generation)||row.generation<0
     ||![null,'unavailable','timeout','invalid_result'].includes(row.failure))throw unavailable();
    const capture=captureArchivedNameRequest(crypto,row);if(!same(capture.payload.previewCapture,entry.preview))throw unavailable();entry.versions.set(row.submitted_revision,row.id);
    if(row.generation===0){if(row.status!=='pending'||row.failure!==null||[row.auth_version,row.lease_token,row.lease_until,row.execution_token,row.detector_revision,row.claim_ciphertext].some(x=>x!==null))throw unavailable();}
    else if(row.status==='pending'){
     if(row.lease_token!==null||row.lease_until!==null||row.execution_token!==null)throw unavailable();
     const saved=JSON.parse(open(rawRow,'platform_companion_name_submissions','claim_ciphertext',row.id,row.generation)),claim=parseCompanionNameSafetyClaim(saved.claim);
     // Failed work retains its original sealed claim after releasing the lease.
     // Authenticate that original token locally without turning it into a new lease.
     authenticateArchivedNameClaim(crypto,{...row,lease_token:claim.leaseToken},capture.payload);
    }else{if(row.failure!==null||row.lease_token===null||row.lease_until===null)throw unavailable();authenticateArchivedNameClaim(crypto,row,capture.payload);}
    let result:Row|null=null,resultCapture:unknown=null;
    if(row.status==='detected'){
     if(row.failure!==null)throw unavailable();const verified=await readNameResourceSourceInTransaction(client,crypto,row.id,signal,false);
     // Verify the same ciphertext just authenticated by the source reader,
     // rather than interpreting an independently captured result unchecked.
     if(verified.source.user_id!==who.userId||verified.source.generation!==row.generation
      ||!verified.source.result_ciphertext!.equals(row.result_ciphertext!))throw unavailable();
     resultCapture=JSON.parse(open(rawRow,'platform_companion_name_submissions','result_ciphertext',row.id,row.generation));
     if(!same(verified.decision,(resultCapture as Row).decision)||!same((resultCapture as Row).sourceCapture,capture.payload))throw unavailable();
     result={decision:verified.decision,modelUsage:(resultCapture as Row).modelUsage};
    }else if([row.result_ciphertext,row.level,row.detector_mode].some(x=>x!==null))throw unavailable();
    const application={status:row.application_status,rejectedCategory:row.rejected_category,appliedIdentityRevision:row.applied_identity_revision};let identityCapture:Row|null=null;
    if(row.application_status==='pending'){if([row.application_ciphertext,row.rejected_category,row.applied_identity_revision].some(x=>x!==null))throw unavailable();}
    else{
     if(row.status!=='detected'||!result||!['applied','name_rejected','superseded','not_eligible'].includes(row.application_status))throw unavailable();
     const text=open(rawRow,'platform_companion_name_submissions','application_ciphertext',row.id,row.generation),data=JSON.parse(text);
     if(text!==JSON.stringify({schemaVersion:1,submissionId:row.id,userId:who.userId,generation:row.generation,sourceCapture:capture.payload,resultCapture,application,identityCapture:data.identityCapture}))throw unavailable();
     if(row.application_status==='applied'){
      const captured=data.identityCapture,draft=identities.get(captured?.id),operation=commands.get(row.application_operation_id);
      if(!draft||!operation||row.level!=='L0'||row.detector_mode!=='full'||row.rejected_category!==null||row.applied_identity_revision!==row.expected_identity_revision+1
       ||captured.revision!==row.applied_identity_revision||captured.userId!==who.userId||captured.taskId!==row.task_id||captured.companionId!==row.companion_id
       ||operation.draftId!==draft.id||operation.appliedRevision!==row.applied_identity_revision||operation.command.taskId!==row.task_id
       ||operation.command.name!==capture.payload.request.name.trim().normalize('NFC')||captured.name!==operation.command.name||captured.revision>draft.revision)throw unavailable();
      identityCapture=await validator.snapshot({id:draft.id,user_id:who.userId,task_id:row.task_id,companion_id:row.companion_id,preview_revision:1,revision:captured.revision,
       bundle_revision:captured.bundleRevision,content_digest:captured.contentDigest,review_digest:captured.reviewDigest},JSON.stringify(captured));
      const {createdAt:_created,updatedAt:_updated,...current}=draft;
      if(captured.revision===draft.revision&&!same(identityCapture,current))throw unavailable();
      applied.set(row.id,{operationId:row.application_operation_id,draftId:draft.id,revision:captured.revision,generation:row.generation,applicationHash:digest(text),identity:identityCapture});
     }else{
      if(data.identityCapture!==null||row.applied_identity_revision!==null)throw unavailable();
      if(row.application_status==='name_rejected'){
       if(row.level!=='L0'||row.detector_mode!=='full'||!['family_or_partner','team_or_org','same_as_user','abusive','public_figure','length'].includes(row.rejected_category!))throw unavailable();
      }else if(row.rejected_category!==null||(row.application_status==='superseded'?row.level!=='L0':row.level==='L0'))throw unavailable();
     }
    }
    yield {section:'companionNameSubmissions',record:{id:row.id,ownerId:who.userId,operationId:row.operation_id,entryId:row.entry_id,taskId:row.task_id,companionId:row.companion_id,
     previewRevision:1,submittedRevision:row.submitted_revision,expectedIdentityRevision:row.expected_identity_revision,applicationOperationId:row.application_operation_id,
     request:capture.payload.request,status:row.status,generation:row.generation,detectorRevision:row.detector_revision,level:row.level,detectorMode:row.detector_mode,
     failure:row.failure,leaseUntil:row.lease_until?at(row.lease_until):null,result,application,identityCapture,createdAt:at(rawRow.created_at),updatedAt:at(rawRow.updated_at)}};
   }
   for(const {row,versions} of entries.values())if(versions.size!==row.revision||versions.get(row.revision)!==row.latest_submission_id)throw unavailable();
   const receipts=new Set<string>(),provenance=new Set<string>();
   for(const table of ['platform_companion_name_identity_receipts','platform_companion_name_identity_provenance'] as const){
    const receipt=table==='platform_companion_name_identity_receipts',seen=receipt?receipts:provenance;
    for await(const r of this.rows(client,who.userId,table,signal)){
     const saved=applied.get(r.submission_id);if(!saved||seen.has(r.submission_id)||r.operation_id!==saved.operationId||r.draft_id!==saved.draftId||r.identity_revision!==saved.revision
      ||r.generation!==saved.generation||r.level!=='L0'||r.detector_mode!=='full')throw unavailable();
     const payload={schemaVersion:1,userId:who.userId,operationId:r.operation_id,draftId:r.draft_id,identityRevision:r.identity_revision,submissionId:r.submission_id,generation:r.generation,identityCapture:saved.identity};
     const text=open(r,table,'payload_ciphertext',receipt?r.operation_id:r.draft_id,r.identity_revision);
     if(receipt?text!==JSON.stringify(payload):digest(text)!==saved.applicationHash)throw unavailable();seen.add(r.submission_id);
     yield {section:receipt?'companionNameIdentityReceipts':'companionNameIdentityProvenance',record:{...payload,level:r.level,detectorMode:r.detector_mode,currentForIdentity:identities.get(r.draft_id)!.revision===r.identity_revision,createdAt:at(r.created_at)}};
    }
   }
   if(receipts.size!==applied.size||provenance.size!==applied.size)throw unavailable();
  }catch{signal?.throwIfAborted();throw unavailable();}
  await authorizeFixedSession(client,who,signal);signal?.throwIfAborted();
 }
}
