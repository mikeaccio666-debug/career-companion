import { createHash,randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { careerRecordId,careerRecordObject,parseFeedbackSubmission,parseFeedbackUpdate,parseProductFeedback,type ProductFeedback,FEEDBACK_STATUSES } from '@companion/platform-contracts';
import { authorizeFixedSession,type FixedSessionContext } from './auth.ts';
import type { Database } from './database.ts';
import type { PlatformConfig } from './config.ts';
import { ApiError } from './errors.ts';
import { StaffAccess } from './staff-access.ts';
import { ProductEvents } from './product-events.ts';
import { accountExportRows } from './account-export-rows.ts';
const canonical=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const digest=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const unavailable=()=>new ApiError(503,'FEEDBACK_UNAVAILABLE','Feedback is temporarily unavailable.');
const bad=()=>new ApiError(400,'FEEDBACK_INPUT_INVALID','Check the feedback fields.');
const missing=()=>new ApiError(404,'NOT_FOUND','The feedback was not found.');
const conflict=()=>new ApiError(409,'FEEDBACK_CHANGED','Refresh the feedback before changing it.');
const input=<T>(f:()=>T):T=>{try{return f();}catch{throw bad();}};
function fixed(value:FixedSessionContext):Readonly<FixedSessionContext>{
 try{const s=careerRecordObject(value,['userId','tokenHash']);if(typeof s.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(s.tokenHash))throw bad();
 return Object.freeze({userId:careerRecordId(s.userId),tokenHash:s.tokenHash});}catch{throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');}
}
type Receipt={ownerId:string;organizationId:string;feedbackId:string;operationId:string;revision:number;commandDigest:string;recordDigest:string;createdAt:string};
type Row=Record<string,any>;
/** Only text the student explicitly shares. This service has no transcript,
 * model, email or knowledge-export dependency. Staff access is audited. */
export class ProductFeedbackService {
 private readonly staff:StaffAccess;
 private readonly events:ProductEvents;
 private readonly crypto:PlatformConfig['dataCrypto'];
 private readonly organizationId:string|undefined;
 constructor(private readonly db:Database,config:Pick<PlatformConfig,'dataCrypto'|'supportOrganizationId'|'productEventsEnabled'>){
  this.crypto=config.dataCrypto;this.organizationId=config.supportOrganizationId===undefined?undefined:careerRecordId(config.supportOrganizationId);this.staff=new StaffAccess(db);this.events=new ProductEvents(config);
 }
 private configured(){if(!this.crypto||!this.organizationId)throw unavailable();return this.organizationId;}
 private async owner(c:PoolClient,s:FixedSessionContext,signal?:AbortSignal){
  await authorizeFixedSession(c,s,signal);
  const row=(await c.query('SELECT account_kind FROM platform_users WHERE id=$1 FOR NO KEY UPDATE',[s.userId])).rows[0];
  if(row?.account_kind!=='student')throw new ApiError(403,'STUDENT_ACCOUNT_REQUIRED','Use a student account.');
  if(!this.crypto)throw unavailable();signal?.throwIfAborted();
 }
 private receipt(row:Row):Receipt{
  try{const raw=this.crypto!.openUtf8(row.receipt_ciphertext,{table:'platform_product_feedback_operations',column:'receipt_ciphertext',rowId:row.operation_id,ownerId:row.user_id,revision:row.applied_revision});
   const v=careerRecordObject(JSON.parse(raw),['ownerId','organizationId','feedbackId','operationId','revision','commandDigest','recordDigest','createdAt']);
   if(raw!==canonical(v)||v.ownerId!==row.user_id||v.operationId!==row.operation_id||v.feedbackId!==row.feedback_id||v.revision!==row.applied_revision||v.createdAt!==row.created_at.toISOString()
    ||typeof v.commandDigest!=='string'||!/^[0-9a-f]{64}$/.test(v.commandDigest)||typeof v.recordDigest!=='string'||!/^[0-9a-f]{64}$/.test(v.recordDigest))throw unavailable();
   careerRecordId(v.organizationId);return v as unknown as Receipt;
  }catch{throw unavailable();}
 }
 private async decode(c:PoolClient,row:Row):Promise<Readonly<ProductFeedback>>{
  try{const raw=this.crypto!.openUtf8(row.record_ciphertext,{table:'platform_product_feedback',column:'record_ciphertext',rowId:row.id,ownerId:row.user_id,revision:row.revision});
   const p=parseProductFeedback(JSON.parse(raw));
   if(raw!==canonical(p)||p.id!==row.id||p.ownerId!==row.user_id||p.organizationId!==row.org_id||p.revision!==row.revision||p.lastOperationId!==row.last_operation_id||p.status!==row.status
    ||p.createdAt!==row.created_at.toISOString()||p.updatedAt!==row.updated_at.toISOString())throw unavailable();
   const r=(await c.query('SELECT * FROM platform_product_feedback_operations WHERE user_id=$1 AND feedback_id=$2 ORDER BY applied_revision DESC LIMIT 1 FOR SHARE',[p.ownerId,p.id])).rows[0];
   if(!r)throw unavailable();const proof=this.receipt(r);
   if(proof.organizationId!==p.organizationId||proof.revision!==p.revision||proof.operationId!==p.lastOperationId||proof.recordDigest!==digest(p)||proof.createdAt!==p.updatedAt)throw unavailable();
   return p;
  }catch{throw unavailable();}
 }
 private async persist(c:PoolClient,p:Readonly<ProductFeedback>,commandDigest:string){
  const cipher=this.crypto!.sealUtf8(canonical(p),{table:'platform_product_feedback',column:'record_ciphertext',rowId:p.id,ownerId:p.ownerId,revision:p.revision});
  await c.query(`INSERT INTO platform_product_feedback(id,user_id,org_id,revision,last_operation_id,status,record_ciphertext,created_at,updated_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,last_operation_id=EXCLUDED.last_operation_id,
   status=EXCLUDED.status,record_ciphertext=EXCLUDED.record_ciphertext,updated_at=EXCLUDED.updated_at`,
   [p.id,p.ownerId,p.organizationId,p.revision,p.lastOperationId,p.status,cipher,p.createdAt,p.updatedAt]);
  const r:Receipt={ownerId:p.ownerId,organizationId:p.organizationId,feedbackId:p.id,operationId:p.lastOperationId,revision:p.revision,commandDigest,recordDigest:digest(p),createdAt:p.updatedAt};
  const sealed=this.crypto!.sealUtf8(canonical(r),{table:'platform_product_feedback_operations',column:'receipt_ciphertext',rowId:r.operationId,ownerId:r.ownerId,revision:r.revision});
  await c.query('INSERT INTO platform_product_feedback_operations(user_id,operation_id,feedback_id,applied_revision,receipt_ciphertext,created_at) VALUES($1,$2,$3,$4,$5,$6)',[r.ownerId,r.operationId,r.feedbackId,r.revision,sealed,r.createdAt]);
 }
 private result(feedback:Readonly<ProductFeedback>,operation:Receipt|undefined,replayed:boolean){
  return Object.freeze({feedback,operation:Object.freeze({id:operation?.operationId??feedback.lastOperationId,appliedRevision:operation?.revision??feedback.revision,replayed})});
 }
 async submit(value:FixedSessionContext,body:unknown,signal?:AbortSignal){
  const s=fixed(value),command=input(()=>parseFeedbackSubmission(body)),org=this.configured(),commandDigest=digest({actor:s.userId,kind:'submit',command});
  return this.db.withBoundedTransaction(async c=>{
   await this.owner(c,s,signal);
   const prior=(await c.query('SELECT * FROM platform_product_feedback_operations WHERE user_id=$1 AND operation_id=$2 FOR SHARE',[s.userId,command.operationId])).rows[0];
   if(prior){const r=this.receipt(prior);if(r.commandDigest!==commandDigest)throw conflict();
    const row=(await c.query('SELECT * FROM platform_product_feedback WHERE user_id=$1 AND id=$2 FOR SHARE',[s.userId,r.feedbackId])).rows[0];
    if(!row)throw unavailable();const feedback=await this.decode(c,row);await authorizeFixedSession(c,s,signal);signal?.throwIfAborted();return this.result(feedback,r,true);
   }
   // Do not say "submitted" when no active support organization/operator exists.
   const orgRow=(await c.query("SELECT id FROM platform_orgs WHERE id=$1 AND status='active' FOR SHARE",[org])).rows[0];if(!orgRow)throw unavailable();
   const recipient=(await c.query(`SELECT r.user_id FROM platform_org_roles r JOIN platform_users u ON u.id=r.user_id
    WHERE r.org_id=$1 AND r.status='active' AND r.role IN ('ops','org_admin') AND u.account_kind='staff' ORDER BY r.user_id LIMIT 1 FOR SHARE OF r,u`,[org])).rows[0];if(!recipient)throw unavailable();
   if((await c.query('SELECT count(*)::int count FROM platform_product_feedback WHERE user_id=$1',[s.userId])).rows[0].count>=500)throw new ApiError(409,'FEEDBACK_CAPACITY','The feedback limit has been reached.');
   const at=(await c.query('SELECT clock_timestamp() at')).rows[0].at.toISOString();
   const {operationId,...fields}=command;
   const p=parseProductFeedback({...fields,id:randomUUID(),ownerId:s.userId,organizationId:org,revision:1,lastOperationId:operationId,status:'submitted',triage:null,createdAt:at,updatedAt:at,updates:[]});
   await this.persist(c,p,commandDigest);await this.events.record(c,s.userId,command.operationId,{event:'feedback_submitted',props:{category:command.category}});await authorizeFixedSession(c,s,signal);signal?.throwIfAborted();return this.result(p,undefined,false);
  });
 }
 async get(value:FixedSessionContext,id:unknown,signal?:AbortSignal){
  const s=fixed(value),key=input(()=>careerRecordId(id));
  return this.db.withBoundedTransaction(async c=>{await this.owner(c,s,signal);
   const row=(await c.query('SELECT * FROM platform_product_feedback WHERE user_id=$1 AND id=$2 FOR SHARE',[s.userId,key])).rows[0];if(!row)throw missing();
   const result=await this.decode(c,row);await authorizeFixedSession(c,s,signal);signal?.throwIfAborted();return result;
  });
 }
 async list(value:FixedSessionContext,after:unknown=null,signal?:AbortSignal){
  const s=fixed(value),cursor=after===null?null:input(()=>careerRecordId(after));
  return this.db.withBoundedTransaction(async c=>{await this.owner(c,s,signal);
   const rows=(await c.query('SELECT * FROM platform_product_feedback WHERE user_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 51 FOR SHARE',[s.userId,cursor])).rows;
   const records=[];for(const row of rows.slice(0,50)){signal?.throwIfAborted();records.push(await this.decode(c,row));}
   await authorizeFixedSession(c,s,signal);signal?.throwIfAborted();return Object.freeze({records:Object.freeze(records),nextCursor:rows.length>50?records.at(-1)!.id:null});
  });
 }
 async inbox(value:FixedSessionContext,after:unknown=null,status:unknown=null,signal?:AbortSignal){
  const s=fixed(value),org=this.configured(),cursor=after===null?null:input(()=>careerRecordId(after));
  if(status!==null&&(typeof status!=='string'||!FEEDBACK_STATUSES.includes(status as any)))throw bad();
  return this.staff.readWithAccess(s,org,{roles:['ops','org_admin'],action:'product_feedback_viewed'},async c=>{
   const rows=(await c.query('SELECT * FROM platform_product_feedback WHERE org_id=$1 AND ($2::uuid IS NULL OR id>$2) AND ($3::text IS NULL OR status=$3) ORDER BY id LIMIT 51 FOR SHARE',[org,cursor,status])).rows;
   const records=[];for(const row of rows.slice(0,50)){signal?.throwIfAborted();records.push(await this.decode(c,row));}
   return {value:Object.freeze({records:Object.freeze(records),nextCursor:rows.length>50?records.at(-1)!.id:null}),recordCount:records.length};
  },signal);
 }
 async update(value:FixedSessionContext,id:unknown,body:unknown,signal?:AbortSignal){
  const s=fixed(value),org=this.configured(),key=input(()=>careerRecordId(id)),command=input(()=>parseFeedbackUpdate(body)),commandDigest=digest({actor:s.userId,kind:'update',key,command});
  return this.staff.readWithAccess(s,org,{roles:['ops','org_admin'],action:'product_feedback_updated',targetId:key,exclusiveOrganization:true},async c=>{
   const row=(await c.query('SELECT * FROM platform_product_feedback WHERE org_id=$1 AND id=$2 FOR UPDATE',[org,key])).rows[0];if(!row)throw missing();
   const current=await this.decode(c,row);
   const prior=(await c.query('SELECT * FROM platform_product_feedback_operations WHERE user_id=$1 AND operation_id=$2 FOR SHARE',[current.ownerId,command.operationId])).rows[0];
   if(prior){const r=this.receipt(prior);if(r.commandDigest!==commandDigest)throw conflict();return {value:this.result(current,r,true),recordCount:1};}
   if(command.expectedRevision!==current.revision)throw conflict();if(current.revision>=101)throw new ApiError(409,'FEEDBACK_CAPACITY','The feedback update limit has been reached.');
   const at=(await c.query('SELECT clock_timestamp() at')).rows[0].at.toISOString(),revision=current.revision+1;
   const p=parseProductFeedback({...current,revision,lastOperationId:command.operationId,status:command.status,triage:command.triage,updatedAt:at,
    updates:[...current.updates,{revision,status:command.status,triage:command.triage,reply:command.reply,at}]});
   await this.persist(c,p,commandDigest);signal?.throwIfAborted();return {value:this.result(p,undefined,false),recordCount:1};
  },signal);
 }
 async *exportInTransaction(c:PoolClient,value:FixedSessionContext,signal?:AbortSignal){
  const s=fixed(value);await this.owner(c,s,signal);
  for await(const row of accountExportRows(c,s.userId,'platform_product_feedback',signal))yield {section:'productFeedback' as const,record:await this.decode(c,row)};
  for await(const row of accountExportRows(c,s.userId,'platform_product_feedback_operations',signal)){
   const r=this.receipt(row);yield {section:'productFeedbackOperations' as const,record:{id:r.operationId,feedbackId:r.feedbackId,revision:r.revision,createdAt:r.createdAt}};
  }
  await authorizeFixedSession(c,s,signal);signal?.throwIfAborted();
 }
}
