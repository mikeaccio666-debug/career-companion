import type { OwnedCareerResume } from './career-run-context.ts';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { workflowHash } from '@companion/ai-core';
import { ownerResumeActionAllowed,validateOwnerResumePayload } from '@companion/career-core';
import { careerRecordObject,careerRecordId,parseResumeReviewCommand,parseResumeReviewItem,resumeReviewInteger,type ResumeReviewItem,type ResumeReviewPayload,type ResumeReviewAction,type ResumeReviewView } from '@companion/platform-contracts';
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
type Action=ResumeReviewAction|'expire'|'supersede';
interface Receipt {schemaVersion:1;ownerId:string;operationId:string;itemId:string;action:Action;generation:number;requestDigest:string;recordDigest:string|null;acceptedAuthVersion:string;createdAt:string;}
/** Owner originals only. Nothing here generates model facts, executes a
 * delivery, registers tools or records a fake expert/model authorization. */
export class ResumeOriginalReview {
 private readonly storage:OnboardingStorage;
 constructor(private readonly db:Database,config:Pick<PlatformConfig,'dataCrypto'|'requireVerifiedEmail'>,legal:LegalBundle|null){this.storage=new OnboardingStorage(config,legal);}
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
 private async payload(client:PoolClient,context:FixedSessionContext,id:string,revision:number):Promise<Readonly<ResumeReviewPayload>>{
  try{const row=(await client.query('SELECT * FROM platform_pending_item_revisions WHERE user_id=$1 AND item_id=$2 AND revision=$3 FOR SHARE',[context.userId,id,revision])).rows[0];if(!row)throw unavailable();
   const raw=this.storage.crypto!.openUtf8(row.ciphertext,{table:'platform_pending_item_revisions',column:'ciphertext',rowId:id,ownerId:context.userId,revision}),payload=validateOwnerResumePayload(JSON.parse(raw));
   if(canonical(payload)!==raw||payload.source_refs[0].id!==id||row.author!=='user'||row.payload_digest!==workflowHash(payload)||row.base_revision!==(revision===1?null:revision-1))throw unavailable();return payload;
  }catch{throw unavailable();}
 }
 private async decode(client:PoolClient,context:FixedSessionContext,row:any):Promise<Readonly<ResumeReviewView>>{
  try{const raw=this.storage.crypto!.openUtf8(row.record_ciphertext,{table:'platform_pending_items',column:'record_ciphertext',rowId:row.id,ownerId:context.userId,revision:row.generation}),item=parseResumeReviewItem(JSON.parse(raw)),latest=await this.latest(client,context,row.id);
   if(canonical(item)!==raw||item.id!==row.id||item.ownerId!==context.userId||item.kind!==row.kind||item.status!==row.status||item.finalAction!==row.final_action||item.track!==row.track||item.revision!==row.current_revision||item.generation!==row.generation||item.lastOperationId!==row.last_operation_id||item.createdAt!==row.created_at.toISOString()||item.updatedAt!==row.updated_at.toISOString()||item.expiresAt!==row.expires_at.toISOString()||latest.action==='delete'||latest.generation!==item.generation||latest.operationId!==item.lastOperationId||latest.recordDigest!==workflowHash(item)||latest.createdAt!==item.updatedAt)throw unavailable();
   const resume=(await client.query('SELECT * FROM platform_career_resume_versions WHERE user_id=$1 AND id=$2 FOR SHARE',[context.userId,item.resumeVersionId])).rows[0];
   if(!resume||resume.pending_item_id!==item.id||resume.track!==item.track||resume.status!==item.resumeStatus||resume.source!==item.source||resume.upload_id!==null||resume.revision!==item.revision||resume.content_digest!==item.payloadDigest||resume.created_at.toISOString()!==item.createdAt||resume.updated_at.toISOString()!==item.updatedAt)throw unavailable();
   const payload=await this.payload(client,context,item.id,item.revision);if(workflowHash(payload)!==item.payloadDigest)throw unavailable();await this.payload(client,context,item.id,1);
   if(item.status==='approved'){
    const decision=(await client.query('SELECT * FROM platform_pending_item_decisions WHERE user_id=$1 AND operation_id=$2 FOR SHARE',[context.userId,item.approvalOperationId])).rows[0],receiptRow=(await client.query('SELECT * FROM platform_pending_item_operations WHERE user_id=$1 AND operation_id=$2 FOR SHARE',[context.userId,item.approvalOperationId])).rows[0];
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
  await client.query('INSERT INTO platform_career_resume_versions(id,user_id,pending_item_id,track,status,source,revision,content_digest,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,revision=EXCLUDED.revision,content_digest=EXCLUDED.content_digest,updated_at=EXCLUDED.updated_at',[item.resumeVersionId,context.userId,item.id,item.track,item.resumeStatus,item.source,item.revision,item.payloadDigest,item.createdAt,item.updatedAt]);
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
 async readForPreparationInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal):Promise<readonly Readonly<OwnedCareerResume>[]>{
  const context=this.fixed(value);await this.authorize(client,context,signal);await this.storage.authorizeSession(client,context,signal);
  const rows=(await client.query('SELECT * FROM platform_pending_items WHERE user_id=$1 ORDER BY id LIMIT 501 FOR SHARE',[context.userId])).rows;
  if(rows.length>500)throw unavailable();
  const labels={swe:'软件工程',mle:'机器学习工程',ds:'数据科学',da:'数据分析',de:'数据工程',hw:'硬件等本专业方向',other:'其他方向'};
  const records:Readonly<OwnedCareerResume>[]=[];
  for(const row of rows){
   signal?.throwIfAborted();const {item}=await this.decode(client,context,row);
   if(item.status!=='approved'||item.resumeStatus!=='active')continue;
   records.push(Object.freeze({ownerId:context.userId,id:item.resumeVersionId,revision:item.revision,state:'current',status:'active',track:item.track,approvedAt:item.approvedAt!,normalSummary:'本人已确认的简历；岗位方向：'+labels[item.track]+'。'}));
  }
  await authorizeFixedSession(client,context,signal);signal?.throwIfAborted();return Object.freeze(records);
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
 async operation(value:FixedSessionContext,key:unknown,signal?:AbortSignal){
  const context=this.fixed(value);let id:string;try{id=careerRecordId(key);}catch{throw bad();}
  return this.db.withBoundedTransaction(async client=>{const auth=await this.authorize(client,context,signal),row=(await client.query('SELECT * FROM platform_pending_item_operations WHERE user_id=$1 AND operation_id=$2 FOR SHARE',[context.userId,id])).rows[0];if(!row)throw missing();const proof=await this.receipt(client,context,row),current=await this.row(client,context,proof.itemId);let view:Readonly<ResumeReviewView>|null=null;if(current)view=await this.current(client,context,current,auth,signal);else if((await this.latest(client,context,proof.itemId)).action!=='delete')throw unavailable();await authorizeFixedSession(client,context,signal);return Object.freeze({view,operation:Object.freeze({id,itemId:proof.itemId,action:proof.action,replayed:true})});});
 }
 async mutate(value:FixedSessionContext,action:ResumeReviewAction,key:unknown,input:unknown,channel:'web'|'discord'|'extension',signal?:AbortSignal){
  const context=this.fixed(value);let command:ReturnType<typeof parseResumeReviewCommand>,requested:string|null;
  try{command=parseResumeReviewCommand(action,input);requested=action==='create'?null:careerRecordId(key);}catch{throw bad();}
  if(channel!=='web')throw new ApiError(403,'WEB_CONFIRMATION_REQUIRED','Review this version on the website.');
  const digest=workflowHash({action,itemId:requested,command});
  return this.db.withBoundedTransaction(async client=>{
   const auth=await this.authorize(client,context,signal),prior=(await client.query('SELECT * FROM platform_pending_item_operations WHERE user_id=$1 AND operation_id=$2 FOR SHARE',[context.userId,command.operationId])).rows[0];
   if(prior){const proof=await this.receipt(client,context,prior);if(proof.requestDigest!==digest||proof.action!==action||requested!==null&&proof.itemId!==requested)throw new ApiError(409,'PENDING_OPERATION_CONFLICT','The saved operation has different content.');
    const row=await this.row(client,context,proof.itemId);let view:Readonly<ResumeReviewView>|null=null;if(row)view=await this.current(client,context,row,auth,signal);else if((await this.latest(client,context,proof.itemId)).action!=='delete')throw unavailable();
    await authorizeFixedSession(client,context,signal);return Object.freeze({view,operation:Object.freeze({id:command.operationId,itemId:proof.itemId,replayed:true})});
   }
   let base:Readonly<ResumeReviewView>|null=null;
   if(action!=='create'){const row=await this.row(client,context,requested!);if(!row)throw missing();base=await this.current(client,context,row,auth,signal);
    if(base.item.revision!==command.expectedRevision||base.item.payloadDigest!==command.payloadDigest)throw changed();
    if(!ownerResumeActionAllowed(base.item,action))throw new ApiError(409,'PENDING_STATE_CHANGED','Use the current review action. Confirmed originals require a new draft object.');
   }
   if(action!=='delete'&&action!=='decline'&&action!=='archive')await this.storage.authorizeSession(client,context,signal);
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
    const payload=action==='create'?validateOwnerResumePayload({text:command.text,claims:[],source_refs:[{kind:'owner_resume_input',id,revision:1}]}):action==='edit'?validateOwnerResumePayload({...base!.payload,text:command.text}):base!.payload;
    const approving=action==='approve',already=base?.item.status==='approved',status=approving?'approved':action==='decline'?'declined':action==='reopen'?'pending':base?.item.status??'pending';
    const expiresAt=action==='create'||action==='reopen'?new Date(Date.parse(at)+7*24*60*60*1000).toISOString():base!.item.expiresAt;
    const item=parseResumeReviewItem({id,ownerId:context.userId,resumeVersionId,kind:'resume_version',finalAction:'none',draftedBy:null,title:'简历版本',label:command.label??base!.item.label,track,sequence,source:derivedFrom?'derived':'paste',uploadId:null,derivedFrom,status,resumeStatus:action==='archive'||status!=='pending'&&status!=='approved'?'archived':status==='approved'?(already?base!.item.resumeStatus:'active'):'draft',revision,generation,payloadDigest:workflowHash(payload),sensitivity:'sensitive',
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
   await authorizeFixedSession(client,context,signal);signal?.throwIfAborted();return Object.freeze({view,operation:Object.freeze({id:command.operationId,itemId:requested??view!.item.id,replayed:false})});
  });
 }
}
