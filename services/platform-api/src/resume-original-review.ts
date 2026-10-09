import {ProductEvents} from './product-events.ts';
import { todayWeekWindow, type TodayWeekWindow } from '@companion/platform-contracts';
import type { BlobStorage } from './storage.ts';
import { readResumeFileText,type OwnedResumeFile } from './resume-file-text.ts';
import type { OwnedCareerResume } from './career-run-context.ts';
import { createHash,randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { workflowHash } from '@companion/ai-core';
import { compareOwnerResumeText,ownerResumeActionAllowed,validateOwnerResumePayload } from '@companion/career-core';
import { CAREER_ROLE_FAMILIES,parseResumeReviewDiff,careerRecordObject,careerRecordId,parseResumeReviewCommand,parseResumeReviewItem,parseResumeUploadCommand,resumeReviewInteger,type ResumeReviewItem,type ResumeReviewPayload,type ResumeReviewAction,type ResumeUploadSnapshot,type ResumeReviewCommand,type ResumeReviewView } from '@companion/platform-contracts';
import { authorizeFixedSession,type FixedSessionContext } from './auth.ts';
import type { Database } from './database.ts';
import type { PlatformConfig } from './config.ts';
import type { LegalBundle } from './legal-documents.ts';
import { OnboardingStorage } from './onboarding-storage.ts';
import { ApiError } from './errors.ts';
const bad=()=>new ApiError(400,'RESUME_REVIEW_INPUT_INVALID','Use the current original resume fields.');
const unavailable=()=>new ApiError(503,'RESUME_REVIEW_UNAVAILABLE','The saved resume review could not be confirmed.');
const missing=()=>new ApiError(404,'NOT_FOUND','The resume review was not found.');
const changed=()=>new ApiError(409,'PENDING_ITEM_CHANGED','The content changed. Read the current version before deciding.');
const canonical=(value:unknown)=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export const RESUME_EXPORT_TABLES=Object.freeze({
 platform_pending_items:'pendingItems',platform_pending_item_revisions:'pendingItemRevisions',
 platform_pending_item_decisions:'pendingItemDecisions',platform_pending_item_operations:'pendingItemOperations',
 platform_career_resume_versions:'careerResumes',platform_career_resume_counters:'careerResumeCounters',
} as const);
export type ResumeExportSection=typeof RESUME_EXPORT_TABLES[keyof typeof RESUME_EXPORT_TABLES];
type Action=ResumeReviewAction|'expire'|'supersede';
interface Receipt {schemaVersion:1;ownerId:string;operationId:string;itemId:string;action:Action;generation:number;requestDigest:string;recordDigest:string|null;acceptedAuthVersion:string;createdAt:string;}
interface PreparationProofs {latest:Map<string,any>;resumes:Map<string,any>;payloads:Map<string,any>;decisions:Map<string,any>;approvals:Map<string,any>;}
/** Owner originals only. Nothing here generates model facts, executes a
 * delivery, registers tools or records a fake expert/model authorization. */
export class ResumeOriginalReview {
 private readonly storage:OnboardingStorage;
 private readonly productEvents:ProductEvents;
 constructor(private readonly db:Database,config:Pick<PlatformConfig,'dataCrypto'|'requireVerifiedEmail'|'productEventsEnabled'>,legal:LegalBundle|null,private readonly uploads?:BlobStorage){this.storage=new OnboardingStorage(config,legal);this.productEvents=new ProductEvents(config);}
 private fixed(value:FixedSessionContext){try{const v=careerRecordObject(value,['userId','tokenHash']);if(typeof v.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(v.tokenHash))throw bad();return Object.freeze({userId:careerRecordId(v.userId),tokenHash:v.tokenHash});}catch{throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');}}
 private async authorize(client:PoolClient,context:FixedSessionContext,signal?:AbortSignal){await authorizeFixedSession(client,context,signal);const row=(await client.query('SELECT account_kind,auth_version FROM platform_users WHERE id=$1 FOR NO KEY UPDATE',[context.userId])).rows[0];if(row?.account_kind!=='student')throw new ApiError(403,'STUDENT_ACCOUNT_REQUIRED','Use a student account.');if(!this.storage.crypto)throw unavailable();signal?.throwIfAborted();return String(row.auth_version);}
 private async receipt(client:PoolClient,context:FixedSessionContext,row:any):Promise<Receipt>{
  try{const raw=this.storage.crypto!.openUtf8(row.receipt_ciphertext,{table:'platform_pending_item_operations',column:'receipt_ciphertext',rowId:row.operation_id,ownerId:context.userId,revision:row.generation}),r=careerRecordObject(JSON.parse(raw),['schemaVersion','ownerId','operationId','itemId','action','generation','requestDigest','recordDigest','acceptedAuthVersion','createdAt']);
   if(canonical(r)!==raw||r.schemaVersion!==1||r.ownerId!==context.userId||r.operationId!==row.operation_id||r.itemId!==row.item_id||r.action!==row.action||r.generation!==row.generation||r.createdAt!==row.created_at.toISOString()||typeof r.requestDigest!=='string'||!/^[0-9a-f]{64}$/.test(r.requestDigest)||r.recordDigest!==null&&(typeof r.recordDigest!=='string'||!/^[0-9a-f]{64}$/.test(r.recordDigest))||typeof r.acceptedAuthVersion!=='string'||!/^(0|[1-9][0-9]*)$/.test(r.acceptedAuthVersion))throw unavailable();
   return r as unknown as Receipt;
  }catch{throw unavailable();}
 }
 private async latest(client:PoolClient,context:FixedSessionContext,id:string){const row=(await client.query('SELECT * FROM platform_pending_item_operations WHERE user_id=$1 AND item_id=$2 ORDER BY generation DESC LIMIT 1 FOR SHARE',[context.userId,id])).rows[0];if(!row)throw unavailable();return this.receipt(client,context,row);}
 private async row(client:PoolClient,context:FixedSessionContext,id:string,byResume=false){return (await client.query(byResume?'SELECT p.* FROM platform_pending_items p JOIN platform_career_resume_versions r ON r.pending_item_id=p.id AND r.user_id=p.user_id WHERE p.user_id=$1 AND r.id=$2 FOR UPDATE OF p':'SELECT * FROM platform_pending_items WHERE user_id=$1 AND id=$2 FOR UPDATE',[context.userId,id])).rows[0];}
 private decodePayload(context:FixedSessionContext,id:string,revision:number,row:any):Readonly<ResumeReviewPayload>{
  try{
   if(!row||row.user_id!==context.userId||row.item_id!==id||row.revision!==revision)throw unavailable();
   const raw=this.storage.crypto!.openUtf8(row.ciphertext,{table:'platform_pending_item_revisions',column:'ciphertext',rowId:id,ownerId:context.userId,revision}),payload=validateOwnerResumePayload(JSON.parse(raw));
   if(canonical(payload)!==raw||payload.source_refs[0].id!==id||row.author!=='user'||row.payload_digest!==workflowHash(payload)||row.base_revision!==(revision===1?null:revision-1))throw unavailable();return payload;
  }catch{throw unavailable();}
 }
 private async payload(client:PoolClient,context:FixedSessionContext,id:string,revision:number,proofs?:PreparationProofs):Promise<Readonly<ResumeReviewPayload>>{
  const row=proofs?proofs.payloads.get(id+':'+revision):(await client.query('SELECT * FROM platform_pending_item_revisions WHERE user_id=$1 AND item_id=$2 AND revision=$3 FOR SHARE',[context.userId,id,revision])).rows[0];
  return this.decodePayload(context,id,revision,row);
 }
 /** Archive input in the caller's authenticated snapshot. Never calls current(),
  * which can expire drafts. Originals retain their sensitivity and file bindings;
  * this projection does not read blob bytes or confer execution permission. */
 async *exportInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal):AsyncGenerator<{section:ResumeExportSection;record:unknown}>{
  const context=this.fixed(value);await this.authorize(client,context,signal);
  const sequences=new Map<string,number>();let after:string|null=null;
  for(;;){
   signal?.throwIfAborted();
   const rows:Record<string,any>[]=(await client.query('SELECT * FROM platform_pending_items WHERE user_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 100',[context.userId,after])).rows;
   for(const row of rows){
    signal?.throwIfAborted();const {item,payload}=await this.decode(client,context,row);
    sequences.set(item.track,Math.max(sequences.get(item.track)??0,item.sequence));
    yield {section:'pendingItems',record:item};
    // decode validated this exact unique pending-item/resume row pair.
    yield {section:'careerResumes',record:{id:item.resumeVersionId,pendingItemId:item.id,track:item.track,status:item.resumeStatus,
     source:item.source,uploadId:item.uploadId,revision:item.revision,contentDigest:item.payloadDigest,createdAt:item.createdAt,updatedAt:item.updatedAt}};
    let revision=0;
    for(;;){
     signal?.throwIfAborted();
     const history=(await client.query('SELECT * FROM platform_pending_item_revisions WHERE user_id=$1 AND item_id=$2 AND revision>$3 ORDER BY revision LIMIT 100',[context.userId,item.id,revision])).rows;
     for(const saved of history){
      signal?.throwIfAborted();
      if(saved.revision!==revision+1||saved.revision>item.revision)throw unavailable();
      const body=this.decodePayload(context,item.id,saved.revision,saved),createdAt=saved.created_at.toISOString();
      if(canonical(body.source_refs)!==canonical(payload.source_refs)||createdAt<item.createdAt||createdAt>item.updatedAt)throw unavailable();
      yield {section:'pendingItemRevisions',record:{itemId:item.id,revision:saved.revision,payload:body,payloadDigest:saved.payload_digest,
       author:'user',baseRevision:saved.base_revision,createdAt}};
      revision=saved.revision;
     }
     if(history.length<100)break;
    }
    if(revision!==item.revision)throw unavailable();
    let generation=0;
    for(;;){
     signal?.throwIfAborted();
     const decisions=(await client.query(`SELECT d.*,o.receipt_ciphertext,o.action,o.created_at AS operation_created_at
      FROM platform_pending_item_decisions d JOIN platform_pending_item_operations o
      ON o.user_id=d.user_id AND o.operation_id=d.operation_id AND o.item_id=d.item_id AND o.generation=d.generation
      WHERE d.user_id=$1 AND d.item_id=$2 AND d.generation>$3 ORDER BY d.generation LIMIT 100`,[context.userId,item.id,generation])).rows;
     for(const decision of decisions){
      signal?.throwIfAborted();
      const receipt=await this.receipt(client,context,{...decision,created_at:decision.operation_created_at});
      const action=decision.decision==='approved'?'approve':decision.decision==='declined'?'decline':null;
      const expectedDigest=workflowHash({action,itemId:item.id,command:{operationId:decision.operation_id,expectedRevision:decision.revision,payloadDigest:decision.payload_digest}});
      if(!action||receipt.action!==action||receipt.requestDigest!==expectedDigest||receipt.recordDigest===null||decision.channel!=='web'||
       decision.generation<=generation||decision.generation>item.generation||decision.revision>item.revision||
       decision.created_at.toISOString()!==receipt.createdAt)throw unavailable();
      const body=await this.payload(client,context,item.id,decision.revision);
      if(workflowHash(body)!==decision.payload_digest)throw unavailable();
      yield {section:'pendingItemDecisions',record:{itemId:item.id,operationId:decision.operation_id,generation:decision.generation,
       revision:decision.revision,payloadDigest:decision.payload_digest,decision:decision.decision,channel:'web',createdAt:receipt.createdAt}};
      generation=decision.generation;
     }
     if(decisions.length<100)break;
    }
   }
   if(rows.length<100)break;after=rows.at(-1)!.id;
  }
  // Includes delete receipts whose bodies and decisions have been forgotten.
  after=null;
  for(;;){
   signal?.throwIfAborted();
   const rows:Record<string,any>[]=(await client.query('SELECT * FROM platform_pending_item_operations WHERE user_id=$1 AND ($2::uuid IS NULL OR operation_id>$2) ORDER BY operation_id LIMIT 100',[context.userId,after])).rows;
   for(const row of rows){signal?.throwIfAborted();const r=await this.receipt(client,context,row);
    yield {section:'pendingItemOperations',record:{id:r.operationId,itemId:r.itemId,action:r.action,generation:r.generation,createdAt:r.createdAt}};
   }
   if(rows.length<100)break;after=rows.at(-1)!.operation_id;
  }
  let trackAfter:string|null=null;
  for(;;){
   signal?.throwIfAborted();
   const rows:Record<string,any>[]=(await client.query('SELECT track,sequence FROM platform_career_resume_counters WHERE user_id=$1 AND ($2::text IS NULL OR track>$2) ORDER BY track LIMIT 100',[context.userId,trackAfter])).rows;
   for(const row of rows){
    if(!CAREER_ROLE_FAMILIES.includes(row.track)||!Number.isSafeInteger(row.sequence)||row.sequence<1||row.sequence<(sequences.get(row.track)??0))throw unavailable();
    sequences.delete(row.track);yield {section:'careerResumeCounters',record:{track:row.track,sequence:row.sequence}};
   }
   if(rows.length<100)break;trackAfter=rows.at(-1)!.track;
  }
  if(sequences.size)throw unavailable();
  await authorizeFixedSession(client,context,signal);signal?.throwIfAborted();
 }
 private async decode(client:PoolClient,context:FixedSessionContext,row:any,proofs?:PreparationProofs):Promise<Readonly<ResumeReviewView>>{
  try{const raw=this.storage.crypto!.openUtf8(row.record_ciphertext,{table:'platform_pending_items',column:'record_ciphertext',rowId:row.id,ownerId:context.userId,revision:row.generation}),item=parseResumeReviewItem(JSON.parse(raw)),latest=proofs?await this.receipt(client,context,proofs.latest.get(row.id)):await this.latest(client,context,row.id);
   if(canonical(item)!==raw||item.id!==row.id||item.ownerId!==context.userId||item.kind!==row.kind||item.status!==row.status||item.finalAction!==row.final_action||item.track!==row.track||item.revision!==row.current_revision||item.generation!==row.generation||item.lastOperationId!==row.last_operation_id||item.createdAt!==row.created_at.toISOString()||item.updatedAt!==row.updated_at.toISOString()||item.expiresAt!==row.expires_at.toISOString()||latest.action==='delete'||latest.generation!==item.generation||latest.operationId!==item.lastOperationId||latest.recordDigest!==workflowHash(item)||latest.createdAt!==item.updatedAt)throw unavailable();
   const resume=proofs?proofs.resumes.get(item.resumeVersionId):(await client.query('SELECT * FROM platform_career_resume_versions WHERE user_id=$1 AND id=$2 FOR SHARE',[context.userId,item.resumeVersionId])).rows[0];
   if(!resume||resume.pending_item_id!==item.id||resume.track!==item.track||resume.status!==item.resumeStatus||resume.source!==item.source||resume.upload_id!==item.uploadId||resume.revision!==item.revision||resume.content_digest!==item.payloadDigest||resume.created_at.toISOString()!==item.createdAt||resume.updated_at.toISOString()!==item.updatedAt)throw unavailable();
   const payload=await this.payload(client,context,item.id,item.revision,proofs);if(workflowHash(payload)!==item.payloadDigest)throw unavailable();const original=await this.payload(client,context,item.id,1,proofs);if(item.uploadSource){const ref=payload.source_refs[1];if(ref?.id!==item.uploadId||ref?.sha256!==item.uploadSource.sha256||ref?.storageVersion!==item.uploadSource.storageVersion||createHash('sha256').update(original.text).digest('hex')!==item.uploadSource.textSha256)throw unavailable();}else if(payload.source_refs[1])throw unavailable();
   if(item.status==='approved'){
    const decision=proofs?proofs.decisions.get(item.approvalOperationId!):(await client.query('SELECT * FROM platform_pending_item_decisions WHERE user_id=$1 AND operation_id=$2 FOR SHARE',[context.userId,item.approvalOperationId])).rows[0],receiptRow=proofs?proofs.approvals.get(item.approvalOperationId!):(await client.query('SELECT * FROM platform_pending_item_operations WHERE user_id=$1 AND operation_id=$2 FOR SHARE',[context.userId,item.approvalOperationId])).rows[0];
    if(!decision||!receiptRow)throw unavailable();const proof=await this.receipt(client,context,receiptRow);
    if(proof.itemId!==item.id||proof.action!=='approve'||proof.createdAt!==item.approvedAt||decision.item_id!==item.id||decision.generation!==proof.generation||decision.revision!==item.approvedRevision||decision.payload_digest!==item.approvedDigest||decision.decision!=='approved'||decision.channel!=='web'||decision.created_at.toISOString()!==item.approvedAt)throw unavailable();
   }
   return Object.freeze({item,payload});
  }catch{throw unavailable();}
 }
 private async save(client:PoolClient,context:FixedSessionContext,item:Readonly<ResumeReviewItem>,payload:Readonly<ResumeReviewPayload>,receipt:Receipt,newPayload:boolean){
  const encryptedReceipt=this.storage.crypto!.sealUtf8(canonical(receipt),{table:'platform_pending_item_operations',column:'receipt_ciphertext',rowId:receipt.operationId,ownerId:context.userId,revision:item.generation});
  await client.query('INSERT INTO platform_pending_item_operations(user_id,operation_id,item_id,action,generation,created_at,receipt_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7)',[context.userId,receipt.operationId,item.id,receipt.action,item.generation,receipt.createdAt,encryptedReceipt]);
  const record=this.storage.crypto!.sealUtf8(canonical(item),{table:'platform_pending_items',column:'record_ciphertext',rowId:item.id,ownerId:context.userId,revision:item.generation});
  await client.query("INSERT INTO platform_pending_items(id,user_id,kind,status,final_action,track,current_revision,generation,last_operation_id,record_ciphertext,created_at,updated_at,expires_at) VALUES($1,$2,'resume_version',$3,'none',$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,current_revision=EXCLUDED.current_revision,generation=EXCLUDED.generation,last_operation_id=EXCLUDED.last_operation_id,record_ciphertext=EXCLUDED.record_ciphertext,updated_at=EXCLUDED.updated_at,expires_at=EXCLUDED.expires_at",[item.id,context.userId,item.status,item.track,item.revision,item.generation,item.lastOperationId,record,item.createdAt,item.updatedAt,item.expiresAt]);
  if(newPayload){const cipher=this.storage.crypto!.sealUtf8(canonical(payload),{table:'platform_pending_item_revisions',column:'ciphertext',rowId:item.id,ownerId:context.userId,revision:item.revision});
   await client.query("INSERT INTO platform_pending_item_revisions(user_id,item_id,revision,ciphertext,payload_digest,author,base_revision,created_at) VALUES($1,$2,$3,$4,$5,'user',$6,$7)",[context.userId,item.id,item.revision,cipher,item.payloadDigest,item.revision===1?null:item.revision-1,item.updatedAt]);
  }
  await client.query('INSERT INTO platform_career_resume_versions(id,user_id,pending_item_id,track,status,source,upload_id,revision,content_digest,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,revision=EXCLUDED.revision,content_digest=EXCLUDED.content_digest,updated_at=EXCLUDED.updated_at',[item.resumeVersionId,context.userId,item.id,item.track,item.resumeStatus,item.source,item.uploadId,item.revision,item.payloadDigest,item.createdAt,item.updatedAt]);
 }
 private async transition(client:PoolClient,context:FixedSessionContext,base:Readonly<ResumeReviewView>,action:'expire'|'supersede',at:string,auth:string,supersededBy:string|null=null){
  const operationId=randomUUID(),item=parseResumeReviewItem({...base.item,status:action==='expire'?'expired':'superseded',resumeStatus:'archived',supersededBy,generation:base.item.generation+1,lastOperationId:operationId,updatedAt:at});
  const receipt:Receipt={schemaVersion:1,ownerId:context.userId,operationId,itemId:item.id,action,generation:item.generation,requestDigest:workflowHash({action,itemId:item.id,previousGeneration:base.item.generation,supersededBy}),recordDigest:workflowHash(item),acceptedAuthVersion:auth,createdAt:at};
  await this.save(client,context,item,base.payload,receipt,false);return Object.freeze({item,payload:base.payload});
 }
 private async current(client:PoolClient,context:FixedSessionContext,row:any,auth:string,signal?:AbortSignal){
  let view=await this.decode(client,context,row);const now=(await client.query('SELECT clock_timestamp() at')).rows[0].at.toISOString();
  if(view.item.status==='pending'&&view.item.expiresAt<=now)view=await this.transition(client,context,view,'expire',now,auth);
  await authorizeFixedSession(client,context,signal);signal?.throwIfAborted();return view;
 }
 /** Actual owner-confirmed source coordinates only. The private label and
  * every original body stay out of preparation metadata and model summaries. */
 private async readPreparationAndDailySources(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal){
  const context=this.fixed(value);await this.authorize(client,context,signal);await this.storage.authorizeSession(client,context,signal);
  const rows=(await client.query('SELECT * FROM platform_pending_items WHERE user_id=$1 ORDER BY id LIMIT 501 FOR SHARE',[context.userId])).rows;
  if(rows.length>500)throw unavailable();
  const ids=rows.map(r=>r.id);
  // All proofs come from this real transaction, never caller-provided DTOs.
  // The latest operation is selected independently of the mutable projection.
  const latest=(await client.query('SELECT o.* FROM unnest($2::uuid[]) c(id) JOIN LATERAL (SELECT operation_id FROM platform_pending_item_operations WHERE user_id=$1 AND item_id=c.id ORDER BY generation DESC LIMIT 1) chosen ON true JOIN platform_pending_item_operations o ON o.user_id=$1 AND o.operation_id=chosen.operation_id FOR SHARE OF o',[context.userId,ids])).rows;
  const versions=(await client.query('SELECT * FROM platform_career_resume_versions WHERE user_id=$1 AND pending_item_id=ANY($2::uuid[]) FOR SHARE',[context.userId,ids])).rows;
  const payloads=(await client.query('SELECT r.* FROM platform_pending_item_revisions r JOIN platform_pending_items p ON p.user_id=r.user_id AND p.id=r.item_id WHERE r.user_id=$1 AND r.item_id=ANY($2::uuid[]) AND (r.revision=1 OR r.revision=p.current_revision) FOR SHARE OF r',[context.userId,ids])).rows;
  // At most one decision per generation; fetch only the actual first approval
  // named in the authenticated metadata, not all historical decisions.
  let approvalIds:string[];try{approvalIds=rows.map(row=>{signal?.throwIfAborted();const raw=this.storage.crypto!.openUtf8(row.record_ciphertext,{table:'platform_pending_items',column:'record_ciphertext',rowId:row.id,ownerId:context.userId,revision:row.generation});return parseResumeReviewItem(JSON.parse(raw)).approvalOperationId;}).filter((id):id is string=>id!==null);}catch(error){signal?.throwIfAborted();throw unavailable();}
  const decisions=(await client.query('SELECT * FROM platform_pending_item_decisions WHERE user_id=$1 AND operation_id=ANY($2::uuid[]) FOR SHARE',[context.userId,approvalIds])).rows;
  const approvals=(await client.query('SELECT * FROM platform_pending_item_operations WHERE user_id=$1 AND operation_id=ANY($2::uuid[]) FOR SHARE',[context.userId,approvalIds])).rows;
  const proofs:PreparationProofs={latest:new Map(latest.map(r=>[r.item_id,r])),resumes:new Map(versions.map(r=>[r.id,r])),payloads:new Map(payloads.map(r=>[r.item_id+':'+r.revision,r])),decisions:new Map(decisions.map(r=>[r.operation_id,r])),approvals:new Map(approvals.map(r=>[r.operation_id,r]))};
  const labels={swe:'软件工程',mle:'机器学习工程',ds:'数据科学',da:'数据分析',de:'数据工程',hw:'硬件等本专业方向',other:'其他方向'};
  const records:Readonly<OwnedCareerResume>[]=[];const reviews=[];
  for(const row of rows){
   signal?.throwIfAborted();const {item}=await this.decode(client,context,row,proofs);
   reviews.push(Object.freeze({id:item.id,ownerId:context.userId,resumeVersionId:item.resumeVersionId,revision:item.revision,generation:item.generation,status:item.status,resumeStatus:item.resumeStatus,track:item.track,expiresAt:item.expiresAt,approvedRevision:item.approvedRevision,approvedAt:item.approvedAt,approvalOperationId:item.approvalOperationId,lastOperationId:item.lastOperationId,sensitivity:item.sensitivity}));
   if(item.status!=='approved'||item.resumeStatus!=='active')continue;
   records.push(Object.freeze({ownerId:context.userId,id:item.resumeVersionId,revision:item.revision,state:'current',status:'active',track:item.track,approvedAt:item.approvedAt!,normalSummary:'本人已确认的简历；岗位方向：'+labels[item.track]+'。'}));
  }
  await authorizeFixedSession(client,context,signal);signal?.throwIfAborted();return Object.freeze({resumes:Object.freeze(records),reviews:Object.freeze(reviews)});
 }
 async readForPreparationInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal):Promise<readonly Readonly<OwnedCareerResume>[]>{return (await this.readPreparationAndDailySources(client,value,signal)).resumes;}
 /** All authenticated review states, not only approved resumes; no source text. */
 async readForDailyPlanningInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal){return this.readPreparationAndDailySources(client,value,signal);}

 /** Historical owner approvals of retained originals; later archival/supersession
  * do not erase effort, while deletion removes the record from this view. */
 async readWeeklyApprovalsInTransaction(client:PoolClient,value:FixedSessionContext,window:TodayWeekWindow,signal?:AbortSignal){
  const context=this.fixed(value);await this.authorize(client,context,signal);
  const w=todayWeekWindow(window.capturedAt,window.timeZone);if(w.weekStart!==window.weekStart||w.localDate!==window.localDate)throw bad();
  const rows=(await client.query(`SELECT o.*,d.revision,d.payload_digest,d.decision,d.channel,d.created_at AS decision_at
   FROM platform_pending_item_operations o JOIN platform_pending_items p ON p.user_id=o.user_id AND p.id=o.item_id
   LEFT JOIN platform_pending_item_decisions d ON d.user_id=o.user_id AND d.operation_id=o.operation_id
    AND d.item_id=o.item_id AND d.generation=o.generation
   WHERE o.user_id=$1 AND o.action='approve' AND (o.created_at AT TIME ZONE $2)::date >= $3::date
    AND o.created_at<=$4::timestamptz ORDER BY o.created_at,o.operation_id LIMIT 1001 FOR SHARE OF o,p`,
   [context.userId,w.timeZone,w.weekStart,w.capturedAt])).rows;
  if(rows.length>1000)throw unavailable();
  const records=new Map<string,Readonly<ResumeReviewView>>(),confirmed=new Set<string>();
  for(const row of rows){
   signal?.throwIfAborted();const receipt=await this.receipt(client,context,row);
   let view=records.get(receipt.itemId);
   if(!view){const current=await this.row(client,context,receipt.itemId);if(!current)throw unavailable();view=await this.decode(client,context,current);records.set(receipt.itemId,view);}
   const item=view.item;
   // A new operation ID can legitimately acknowledge an already-approved
   // original. write() retains the first decision and does not create another.
   // Authenticate that acknowledgement, but never treat its time as new work.
   if(receipt.action!=='approve'||receipt.recordDigest===null||item.approvalOperationId===null
    ||item.approvedRevision===null||item.approvedDigest===null||item.approvedAt===null
    ||receipt.generation>item.generation||receipt.createdAt<item.approvedAt||receipt.createdAt>item.updatedAt
    ||receipt.requestDigest!==workflowHash({action:'approve',itemId:receipt.itemId,
     command:{operationId:receipt.operationId,expectedRevision:item.approvedRevision,payloadDigest:item.approvedDigest}}))throw unavailable();
   if(receipt.operationId!==item.approvalOperationId){
    if(row.decision!==null||row.decision_at!==null)throw unavailable();
    continue;
   }
   if(row.decision!=='approved'||row.channel!=='web'||row.decision_at?.toISOString()!==receipt.createdAt
    ||row.revision!==item.approvedRevision||row.payload_digest!==item.approvedDigest
    ||workflowHash(await this.payload(client,context,receipt.itemId,row.revision))!==row.payload_digest)throw unavailable();
   confirmed.add(receipt.itemId);
  }
  if(records.size>500)throw unavailable();await authorizeFixedSession(client,context,signal);signal?.throwIfAborted();
  return Object.freeze({ownerId:context.userId,count:confirmed.size});
 }
 async get(value:FixedSessionContext,key:unknown,byResume=false,signal?:AbortSignal){const context=this.fixed(value);let id:string;try{id=careerRecordId(key);}catch{throw bad();}
  return this.db.withBoundedTransaction(async client=>{const auth=await this.authorize(client,context,signal),row=await this.row(client,context,id,byResume);if(!row)throw missing();return this.current(client,context,row,auth,signal);});
 }
 async list(value:FixedSessionContext,query:unknown={},signal?:AbortSignal){const context=this.fixed(value);let after:string|null,status:string|null;
  try{const q=careerRecordObject(query,[],['after','status']);after=Object.hasOwn(q,'after')?careerRecordId(q.after):null;status=Object.hasOwn(q,'status')?q.status as string:null;if(status!==null&&!['pending','approved','declined','expired','superseded'].includes(status))throw bad();}catch{throw bad();}
  return this.db.withBoundedTransaction(async client=>{
   const auth=await this.authorize(client,context,signal);
   // Expiration is authenticated server clock work, never a send. At most 20
   // pending records exist; reconcile all before status-filtered pagination.
   const due=(await client.query("SELECT * FROM platform_pending_items WHERE user_id=$1 AND status='pending' AND expires_at<=clock_timestamp() FOR UPDATE",[context.userId])).rows;
   if(due.length>20)throw unavailable();for(const row of due)await this.current(client,context,row,auth,signal);
   let cursor:any=null;if(after){cursor=await this.row(client,context,after);if(!cursor)throw missing();await this.current(client,context,cursor,auth,signal);}
   const rows=(await client.query('SELECT * FROM platform_pending_items WHERE user_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51 FOR SHARE',[context.userId,status,cursor?.created_at??null,after])).rows,items=[];
   for(const row of rows.slice(0,50)){signal?.throwIfAborted();items.push((await this.current(client,context,row,auth,signal)).item);}
   await authorizeFixedSession(client,context,signal);return Object.freeze({items:Object.freeze(items),nextAfter:rows.length>50?items.at(-1)!.id:null});
  });
 }
 async revision(value:FixedSessionContext,key:unknown,revision:unknown,signal?:AbortSignal){const context=this.fixed(value);let id:string,r:number;try{id=careerRecordId(key);r=resumeReviewInteger(revision);}catch{throw bad();}
  return this.db.withBoundedTransaction(async client=>{const auth=await this.authorize(client,context,signal),row=await this.row(client,context,id);if(!row)throw missing();const view=await this.current(client,context,row,auth,signal);if(r>view.item.revision)throw missing();const payload=await this.payload(client,context,id,r);await authorizeFixedSession(client,context,signal);return Object.freeze({itemId:id,ownerId:context.userId,revision:r,payload,payloadDigest:workflowHash(payload)});});
 }
 /** Private history comparison in one transaction. A diff never confirms a
  * version, classifies facts or grants access to another saved object. */
 async diff(value:FixedSessionContext,key:unknown,input:unknown,signal?:AbortSignal){
  const context=this.fixed(value);let id:string,from:number,to:number;
  try{const q=careerRecordObject(input,['from','to']);id=careerRecordId(key);from=resumeReviewInteger(q.from);to=resumeReviewInteger(q.to);if(from>=to)throw bad();}catch{throw bad();}
  return this.db.withBoundedTransaction(async client=>{
   const auth=await this.authorize(client,context,signal),row=await this.row(client,context,id);if(!row)throw missing();
   const current=await this.current(client,context,row,auth,signal);if(to>current.item.revision)throw missing();
   const before=await this.payload(client,context,id,from),after=to===current.item.revision?current.payload:await this.payload(client,context,id,to);
   if(canonical(before.source_refs)!==canonical(current.payload.source_refs))throw unavailable();
   let result:ReturnType<typeof parseResumeReviewDiff>;
   try{result=parseResumeReviewDiff({itemId:id,ownerId:context.userId,currentRevision:current.item.revision,from:{revision:from,payloadDigest:workflowHash(before)},to:{revision:to,payloadDigest:workflowHash(after)},sourceRefs:before.source_refs,text:compareOwnerResumeText(before,after),unresolvedClaims:[]});}catch{throw unavailable();}
   await authorizeFixedSession(client,context,signal);signal?.throwIfAborted();return result;
  });
 }
 async operation(value:FixedSessionContext,key:unknown,signal?:AbortSignal){
  const context=this.fixed(value);let id:string;try{id=careerRecordId(key);}catch{throw bad();}
  return this.db.withBoundedTransaction(async client=>{const auth=await this.authorize(client,context,signal),row=(await client.query('SELECT * FROM platform_pending_item_operations WHERE user_id=$1 AND operation_id=$2 FOR SHARE',[context.userId,id])).rows[0];if(!row)throw missing();const proof=await this.receipt(client,context,row),current=await this.row(client,context,proof.itemId);let view:Readonly<ResumeReviewView>|null=null;if(current)view=await this.current(client,context,current,auth,signal);else if((await this.latest(client,context,proof.itemId)).action!=='delete')throw unavailable();await authorizeFixedSession(client,context,signal);return Object.freeze({view,operation:Object.freeze({id,itemId:proof.itemId,action:proof.action,replayed:true})});});
 }
 private async replay(client:PoolClient,context:FixedSessionContext,auth:string,action:ResumeReviewAction,requested:string|null,operationId:string,digest:string,signal?:AbortSignal){
  const prior=(await client.query('SELECT * FROM platform_pending_item_operations WHERE user_id=$1 AND operation_id=$2 FOR SHARE',[context.userId,operationId])).rows[0];
   if(prior){const proof=await this.receipt(client,context,prior);if(proof.requestDigest!==digest||proof.action!==action||requested!==null&&proof.itemId!==requested)throw new ApiError(409,'PENDING_OPERATION_CONFLICT','The saved operation has different content.');
    const row=await this.row(client,context,proof.itemId);let view:Readonly<ResumeReviewView>|null=null;if(row)view=await this.current(client,context,row,auth,signal);else if((await this.latest(client,context,proof.itemId)).action!=='delete')throw unavailable();
    await authorizeFixedSession(client,context,signal);return Object.freeze({view,operation:Object.freeze({id:operationId,itemId:proof.itemId,replayed:true})});
   }

  return null;
 }
 private async ownedUpload(client:PoolClient,context:FixedSessionContext,id:string):Promise<Readonly<OwnedResumeFile>>{
  const row=(await client.query('SELECT * FROM platform_uploads WHERE id=$1 AND user_id=$2 FOR SHARE',[id,context.userId])).rows[0];if(!row)throw missing();
  const size=Number(row.byte_size);if(!['application/pdf','text/plain','text/markdown'].includes(row.mime)||!Number.isSafeInteger(size)||size<1||size>20*1024*1024||typeof row.filename!=='string'||!row.filename.length||row.filename.length>200||/[\x00-\x1f\x7f]/.test(row.filename)||typeof row.storage_key!=='string'||!row.storage_key.length||row.storage_key.length>240)throw new ApiError(415,'RESUME_UPLOAD_UNSUPPORTED','请使用 PDF、TXT 或 Markdown，也可以直接粘贴。');
  return Object.freeze({id:row.id,userId:context.userId,storageKey:row.storage_key,filename:row.filename,mime:row.mime,size,createdAt:row.created_at.toISOString()});
 }
 async listUploads(value:FixedSessionContext,input:unknown={},signal?:AbortSignal){
  const context=this.fixed(value);let after:string|null;try{const q=careerRecordObject(input,[],['after']);after=Object.hasOwn(q,'after')?careerRecordId(q.after):null;}catch{throw bad();}
  return this.db.withBoundedTransaction(async client=>{await this.authorize(client,context,signal);if(after)await this.ownedUpload(client,context,after);
   const rows=(await client.query("SELECT u.id FROM platform_uploads u WHERE u.user_id=$1 AND u.mime IN ('application/pdf','text/plain','text/markdown') AND ($2::uuid IS NULL OR (u.created_at,u.id)<(SELECT c.created_at,c.id FROM platform_uploads c WHERE c.user_id=$1 AND c.id=$2)) ORDER BY u.created_at DESC,u.id DESC LIMIT 51",[context.userId,after])).rows,files=[];
   for(const row of rows.slice(0,50)){signal?.throwIfAborted();const f=await this.ownedUpload(client,context,row.id);files.push(Object.freeze({id:f.id,name:f.filename,mime:f.mime,size:f.size,createdAt:f.createdAt}));}
   await authorizeFixedSession(client,context,signal);return Object.freeze({files:Object.freeze(files),nextAfter:rows.length>50?files.at(-1)!.id:null});
  });
 }
 async createFromUpload(value:FixedSessionContext,input:unknown,signal?:AbortSignal){
  const context=this.fixed(value);let command:ReturnType<typeof parseResumeUploadCommand>;try{command=parseResumeUploadCommand(input);}catch{throw bad();}
  const digest=workflowHash({action:'create',itemId:null,command});
  const initial=await this.db.withBoundedTransaction(async client=>{const auth=await this.authorize(client,context,signal),replay=await this.replay(client,context,auth,'create',null,command.operationId,digest,signal);if(replay)return {replay,file:null};await this.storage.authorizeSession(client,context,signal);return {replay:null,file:await this.ownedUpload(client,context,command.uploadId)};});
  if(initial.replay)return initial.replay;if(!this.uploads)throw new ApiError(503,'RESUME_FILE_READER_UNAVAILABLE','文件读取尚未配置，请直接粘贴原稿。');
  const captured=await readResumeFileText(this.uploads,initial.file!,command.sha256,signal);
  const prepared=parseResumeReviewCommand('create',{operationId:command.operationId,expectedRevision:0,track:command.track,label:command.label,text:captured.text});
  return this.write(context,'create',null,prepared,digest,signal,{file:initial.file!,source:captured.source});
 }
 async mutate(value:FixedSessionContext,action:ResumeReviewAction,key:unknown,input:unknown,channel:'web'|'discord'|'extension',signal?:AbortSignal){
  const context=this.fixed(value);let command:ReturnType<typeof parseResumeReviewCommand>,requested:string|null;
  try{command=parseResumeReviewCommand(action,input);requested=action==='create'?null:careerRecordId(key);}catch{throw bad();}
  if(channel!=='web')throw new ApiError(403,'WEB_CONFIRMATION_REQUIRED','Review this version on the website.');
  const digest=workflowHash({action,itemId:requested,command});
  return this.write(context,action,requested,command,digest,signal);
 }
 private async write(context:FixedSessionContext,action:ResumeReviewAction,requested:string|null,command:Readonly<ResumeReviewCommand>,digest:string,signal?:AbortSignal,upload?:{file:Readonly<OwnedResumeFile>;source:Readonly<ResumeUploadSnapshot>}){
  return this.db.withBoundedTransaction(async client=>{
   const auth=await this.authorize(client,context,signal);
   const replay=await this.replay(client,context,auth,action,requested,command.operationId,digest,signal);if(replay)return replay;
   let base:Readonly<ResumeReviewView>|null=null;
   if(action!=='create'){const row=await this.row(client,context,requested!);if(!row)throw missing();base=await this.current(client,context,row,auth,signal);
    if(base.item.revision!==command.expectedRevision||base.item.payloadDigest!==command.payloadDigest)throw changed();
    if(!ownerResumeActionAllowed(base.item,action))throw new ApiError(409,'PENDING_STATE_CHANGED','Use the current review action. Confirmed originals require a new draft object.');
   }
   if(action!=='delete'&&action!=='decline'&&action!=='archive')await this.storage.authorizeSession(client,context,signal);
   if(upload){const current=await this.ownedUpload(client,context,upload.file.id);if(canonical(current)!==canonical(upload.file))throw new ApiError(409,'RESUME_UPLOAD_CHANGED','文件信息已变化，请重新读取。');}
   const at=(await client.query('SELECT clock_timestamp() at')).rows[0].at.toISOString();
   if(action==='approve'&&base?.item.status==='pending'&&base.item.expiresAt<=at)throw new ApiError(409,'PENDING_ITEM_EXPIRED','This version expired. Reopen it before confirming.');
   let view:Readonly<ResumeReviewView>|null=null;
   if(action==='delete'){
    const generation=base!.item.generation+1,receipt:Receipt={schemaVersion:1,ownerId:context.userId,operationId:command.operationId,itemId:requested!,action,generation,requestDigest:digest,recordDigest:null,acceptedAuthVersion:auth,createdAt:at};
    const cipher=this.storage.crypto!.sealUtf8(canonical(receipt),{table:'platform_pending_item_operations',column:'receipt_ciphertext',rowId:receipt.operationId,ownerId:context.userId,revision:generation});
    await client.query('INSERT INTO platform_pending_item_operations(user_id,operation_id,item_id,action,generation,created_at,receipt_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7)',[context.userId,receipt.operationId,receipt.itemId,action,generation,at,cipher]);
    await client.query('DELETE FROM platform_pending_items WHERE user_id=$1 AND id=$2',[context.userId,requested]);
   }else{
    let id=base?.item.id??randomUUID(),resumeVersionId=base?.item.resumeVersionId??randomUUID(),sequence=base?.item.sequence??0,derivedFrom=base?.item.derivedFrom??null,track=base?.item.track??command.track!;
    if(action==='create'){
     if((await client.query('SELECT count(*)::int count FROM platform_pending_items WHERE user_id=$1',[context.userId])).rows[0].count>=500)throw new ApiError(409,'RESUME_CAPACITY','Remove an old version before saving another.');
     const pending=(await client.query("SELECT * FROM platform_pending_items WHERE user_id=$1 AND status='pending' ORDER BY id FOR UPDATE",[context.userId])).rows;
     const same=[];let livePending=0;for(const row of pending){const p=await this.current(client,context,row,auth,signal);if(p.item.status==='pending'){livePending++;if(p.item.track===track)same.push(p);}}
     if(livePending-same.length>=20)throw new ApiError(409,'PENDING_CAPACITY','Review the existing pending items first.');
     if(command.derivedFromId){const row=await this.row(client,context,command.derivedFromId,true);if(!row)throw missing();const source=await this.current(client,context,row,auth,signal);if(source.item.status!=='approved'||source.item.track!==track)throw new ApiError(409,'RESUME_SOURCE_UNCONFIRMED','Use an actual confirmed version from this track.');derivedFrom={id:source.item.resumeVersionId,pendingItemId:source.item.id,revision:source.item.revision,approvedDigest:source.item.approvedDigest!};}
     sequence=(await client.query('INSERT INTO platform_career_resume_counters(user_id,track,sequence) VALUES($1,$2,1) ON CONFLICT(user_id,track) DO UPDATE SET sequence=platform_career_resume_counters.sequence+1 RETURNING sequence',[context.userId,track])).rows[0].sequence;
     // Replacement is part of this genuine user create transaction; failed
     // creation rolls back every predecessor transition and sequence counter.
     for(const prior of same)await this.transition(client,context,prior,'supersede',at,auth,id);
    }
    const revision=(base?.item.revision??0)+(action==='create'||action==='edit'||action==='reopen'?1:0),generation=(base?.item.generation??0)+1;
    const payload=action==='create'?validateOwnerResumePayload({text:command.text,claims:[],source_refs:[{kind:'owner_resume_input',id,revision:1},...(upload?[{kind:'resume_upload',id:upload.source.uploadId,sha256:upload.source.sha256,storageVersion:upload.source.storageVersion}]:[])]}):action==='edit'?validateOwnerResumePayload({...base!.payload,text:command.text}):base!.payload;
    const approving=action==='approve',already=base?.item.status==='approved',status=approving?'approved':action==='decline'?'declined':action==='reopen'?'pending':base?.item.status??'pending';
    const expiresAt=action==='create'||action==='reopen'?new Date(Date.parse(at)+7*24*60*60*1000).toISOString():base!.item.expiresAt;
    const item=parseResumeReviewItem({id,ownerId:context.userId,resumeVersionId,kind:'resume_version',finalAction:'none',draftedBy:null,title:'简历版本',label:command.label??base!.item.label,track,sequence,source:derivedFrom?'derived':upload?'upload':base?.item.source??'paste',uploadId:upload?.source.uploadId??base?.item.uploadId??null,...(upload?{uploadSource:upload.source}:base?.item.uploadSource?{uploadSource:base.item.uploadSource}:{}),derivedFrom,status,resumeStatus:action==='archive'||status!=='pending'&&status!=='approved'?'archived':status==='approved'?(already?base!.item.resumeStatus:'active'):'draft',revision,generation,payloadDigest:workflowHash(payload),sensitivity:'sensitive',
     approvedRevision:approving?revision:base?.item.approvedRevision??null,approvedDigest:approving?workflowHash(payload):base?.item.approvedDigest??null,approvedAt:approving?(already?base!.item.approvedAt:at):base?.item.approvedAt??null,approvedChannel:approving?'web':base?.item.approvedChannel??null,approvalOperationId:approving?(already?base!.item.approvalOperationId:command.operationId):base?.item.approvalOperationId??null,
     supersededBy:null,expiresAt,createdAt:base?.item.createdAt??at,updatedAt:at,lastOperationId:command.operationId});
    // Provenance must still resolve at confirmation. A missing original after
    // forget does not get silently replaced with a different source.
    if(approving&&item.derivedFrom){const sourceRow=await this.row(client,context,item.derivedFrom.id,true);if(!sourceRow)throw new ApiError(409,'DEPENDENCY_CHANGED','The source version was removed.');const source=await this.current(client,context,sourceRow,auth,signal);if(source.item.status!=='approved'||source.item.revision!==item.derivedFrom.revision||source.item.payloadDigest!==item.derivedFrom.approvedDigest)throw new ApiError(409,'DEPENDENCY_CHANGED','The source version changed.');}
    const receipt:Receipt={schemaVersion:1,ownerId:context.userId,operationId:command.operationId,itemId:id,action,generation,requestDigest:digest,recordDigest:workflowHash(item),acceptedAuthVersion:auth,createdAt:at};
    await this.save(client,context,item,payload,receipt,action==='create'||action==='edit'||action==='reopen');
    if(action==='decline'||approving&&!already)await client.query('INSERT INTO platform_pending_item_decisions(user_id,item_id,operation_id,generation,revision,payload_digest,decision,channel,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,\'web\',$8)',[context.userId,id,command.operationId,generation,revision,item.payloadDigest,approving?'approved':'declined',at]);
    view=Object.freeze({item,payload});
   }
   if(action==='create'&&view)await this.productEvents.record(client,context.userId,command.operationId,{event:'resume_version_created',props:{source:view.item.source}});
   await authorizeFixedSession(client,context,signal);signal?.throwIfAborted();return Object.freeze({view,operation:Object.freeze({id:command.operationId,itemId:requested??view!.item.id,replayed:false})});
  });
 }
}
