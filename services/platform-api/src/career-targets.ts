import type { OwnedCareerTarget } from './career-run-context.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { careerTargetId,careerTargetObject,parseCareerTarget,parseCareerTargetCommand,type CareerTarget,type CareerTargetAction } from '@companion/platform-contracts';
import { authorizeFixedSession,type FixedSessionContext } from './auth.ts';
import type { Database } from './database.ts';
import type { PlatformConfig } from './config.ts';
import type { LegalBundle } from './legal-documents.ts';
import { OnboardingStorage } from './onboarding-storage.ts';
import { ApiError } from './errors.ts';
const unavailable=()=>new ApiError(503,'CAREER_TARGET_STORAGE_UNAVAILABLE','The saved direction could not be confirmed.');
const bad=()=>new ApiError(400,'CAREER_TARGET_INPUT_INVALID','Use an explicit career direction.');
const notFound=()=>new ApiError(404,'NOT_FOUND','The career direction was not found.');
const changed=()=>new ApiError(409,'CAREER_TARGET_REVISION_CHANGED','Read the current direction before changing it.');
const canonical=(v:unknown)=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
interface Receipt {schemaVersion:1;ownerId:string;operationId:string;targetId:string;action:CareerTargetAction;commandDigest:string;appliedRevision:number;acceptedAuthVersion:string;createdAt:string;}
/** Owner actions only. Expert proposals, onboarding projection and agent reads
 * need their own real source adapters; this service creates no execution grant. */
export class CareerTargets {
 private readonly storage:OnboardingStorage;
 constructor(private readonly db:Database,config:Pick<PlatformConfig,'dataCrypto'|'requireVerifiedEmail'>,legal:LegalBundle|null){this.storage=new OnboardingStorage(config,legal);}
 private fixed(value:FixedSessionContext){try{const v=careerTargetObject(value,['userId','tokenHash']);if(typeof v.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(v.tokenHash))throw bad();return Object.freeze({userId:careerTargetId(v.userId),tokenHash:v.tokenHash});}catch{throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');}}
 private async authorize(client:PoolClient,context:FixedSessionContext,signal?:AbortSignal){
  await authorizeFixedSession(client,context,signal);const row=(await client.query('SELECT account_kind,auth_version FROM platform_users WHERE id=$1 FOR NO KEY UPDATE',[context.userId])).rows[0];
  if(row?.account_kind!=='student')throw new ApiError(403,'STUDENT_ACCOUNT_REQUIRED','Use a student account.');
  if(!this.storage.crypto)throw unavailable();signal?.throwIfAborted();return row;
 }
 private async receipt(client:PoolClient,context:FixedSessionContext,row:any):Promise<Receipt>{
  try{const raw=this.storage.crypto!.openUtf8(row.receipt_ciphertext,{table:'platform_career_target_operations',column:'receipt_ciphertext',rowId:row.operation_id,ownerId:context.userId,revision:row.applied_revision});
   const r=careerTargetObject(JSON.parse(raw),['schemaVersion','ownerId','operationId','targetId','action','commandDigest','appliedRevision','acceptedAuthVersion','createdAt']);
   if(canonical(r)!==raw||r.schemaVersion!==1||r.ownerId!==context.userId||r.operationId!==row.operation_id||r.targetId!==row.target_id||r.action!==row.action||r.appliedRevision!==row.applied_revision||r.createdAt!==row.created_at.toISOString()
    ||typeof r.commandDigest!=='string'||!/^[0-9a-f]{64}$/.test(r.commandDigest)||typeof r.acceptedAuthVersion!=='string'||!/^(0|[1-9][0-9]*)$/.test(r.acceptedAuthVersion))throw unavailable();
   return r as unknown as Receipt;
  }catch{throw unavailable();}
 }
 private async latest(client:PoolClient,context:FixedSessionContext,id:string){const row=(await client.query('SELECT * FROM platform_career_target_operations WHERE user_id=$1 AND target_id=$2 ORDER BY applied_revision DESC LIMIT 1 FOR SHARE',[context.userId,id])).rows[0];if(!row)throw unavailable();return this.receipt(client,context,row);}
 private async record(client:PoolClient,context:FixedSessionContext,row:any):Promise<Readonly<CareerTarget>>{
  try{const raw=this.storage.crypto!.openUtf8(row.record_ciphertext,{table:'platform_career_targets',column:'record_ciphertext',rowId:row.id,ownerId:context.userId,revision:row.revision}),target=parseCareerTarget(JSON.parse(raw)),latest=await this.latest(client,context,row.id);
   if(canonical(target)!==raw||target.id!==row.id||target.ownerId!==context.userId||target.roleFamily!==row.role_family||target.priority!==row.priority||target.status!==row.status||target.proposedBy!==row.proposed_by||target.revision!==row.revision||target.createdAt!==row.created_at.toISOString()||target.updatedAt!==row.updated_at.toISOString()||target.lastOperationId!==row.last_operation_id
    ||latest.action==='delete'||latest.appliedRevision!==target.revision||latest.operationId!==target.lastOperationId||latest.createdAt!==target.updatedAt)throw unavailable();return target;
  }catch{throw unavailable();}
 }
 private async row(client:PoolClient,context:FixedSessionContext,id:string){return (await client.query('SELECT * FROM platform_career_targets WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,context.userId])).rows[0];}
 async get(value:FixedSessionContext,key:unknown,signal?:AbortSignal){const context=this.fixed(value);let id:string;try{id=careerTargetId(key);}catch{throw bad();}
  return this.db.withBoundedTransaction(async client=>{await this.authorize(client,context,signal);const row=await this.row(client,context,id);if(!row)throw notFound();const target=await this.record(client,context,row);await authorizeFixedSession(client,context,signal);return target;});
 }
 /** Read-only recovery of an accepted operation. Never replays a write or
  * resurrects the source after deletion; admission withdrawal still allows
  * the owner to inspect existing private records. */
 async observe(value:FixedSessionContext,key:unknown,signal?:AbortSignal){
  const context=this.fixed(value);let id:string;try{id=careerTargetId(key);}catch{throw bad();}
  return this.db.withBoundedTransaction(async client=>{
   await this.authorize(client,context,signal);
   const operation=(await client.query('SELECT * FROM platform_career_target_operations WHERE user_id=$1 AND operation_id=$2 FOR SHARE',[context.userId,id])).rows[0];
   if(!operation)throw notFound();
   const r=await this.receipt(client,context,operation),row=await this.row(client,context,r.targetId);
   let target:Readonly<CareerTarget>|null=null;
   if(row)target=await this.record(client,context,row);else if((await this.latest(client,context,r.targetId)).action!=='delete')throw unavailable();
   await authorizeFixedSession(client,context,signal);signal?.throwIfAborted();
   return Object.freeze({target,operation:Object.freeze({id:r.operationId,targetId:r.targetId,appliedRevision:r.appliedRevision,replayed:true})});
  });
 }
 async list(value:FixedSessionContext,query:unknown={},signal?:AbortSignal){const context=this.fixed(value);try{careerTargetObject(query,[]);}catch{throw bad();}
  return this.db.withBoundedTransaction(async client=>{await this.authorize(client,context,signal);const rows=(await client.query('SELECT * FROM platform_career_targets WHERE user_id=$1 ORDER BY priority,created_at,id LIMIT 101 FOR SHARE',[context.userId])).rows;
   if(rows.length>100)throw new ApiError(409,'CAREER_TARGET_CAPACITY','Reduce the saved direction list before continuing.');const targets=[];for(const row of rows){signal?.throwIfAborted();targets.push(await this.record(client,context,row));}await authorizeFixedSession(client,context,signal);return Object.freeze({targets:Object.freeze(targets)});
  });
 }
 /** Preparation index only. Free titles/locations are not passed to a model,
  * and this actual read does not classify a message or grant execution. */
 async readForPreparationInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal):Promise<readonly OwnedCareerTarget[]>{
  const context=this.fixed(value);await this.authorize(client,context,signal);await this.storage.authorizeSession(client,context,signal);
  const rows=(await client.query('SELECT * FROM platform_career_targets WHERE user_id=$1 ORDER BY priority,created_at,id LIMIT 101 FOR SHARE',[context.userId])).rows;
  if(rows.length>100)throw new ApiError(409,'CAREER_TARGET_CAPACITY','Reduce the saved direction list before continuing.');
  const labels={swe:'Software Engineering',mle:'Machine Learning Engineering',ds:'Data Science',da:'Data Analytics',de:'Data Engineering',hw:'Hardware',other:'其他方向'},result:OwnedCareerTarget[]=[];
  for(const row of rows){signal?.throwIfAborted();const target=await this.record(client,context,row);if(target.status!=='active'&&target.status!=='exploring')continue;
   result.push(Object.freeze({ownerId:context.userId,id:target.id,revision:target.revision,state:'current',status:target.status,normalSummary:`岗位家族：${labels[target.roleFamily]}；本人记录状态：${target.status==='active'?'暂定主攻':'探索中'}。`}));
  }
  await authorizeFixedSession(client,context,signal);return Object.freeze(result);
 }
 async mutate(value:FixedSessionContext,action:CareerTargetAction,key:unknown,input:unknown,signal?:AbortSignal){
  const context=this.fixed(value);let command:ReturnType<typeof parseCareerTargetCommand>,requested:string|null;
  try{command=parseCareerTargetCommand(action,input);requested=action==='create'?null:careerTargetId(key);}catch{throw bad();}
  const digest=createHash('sha256').update(canonical({action,targetId:requested,command})).digest('hex');
  return this.db.withBoundedTransaction(async client=>{
   const auth=await this.authorize(client,context,signal),priorRow=(await client.query('SELECT * FROM platform_career_target_operations WHERE user_id=$1 AND operation_id=$2 FOR SHARE',[context.userId,command.operationId])).rows[0];
   if(priorRow){const r=await this.receipt(client,context,priorRow);if(r.commandDigest!==digest||r.action!==action||requested!==null&&r.targetId!==requested)throw new ApiError(409,'CAREER_TARGET_OPERATION_CONFLICT','The direction operation was already used.');
    const row=await this.row(client,context,r.targetId);let target:Readonly<CareerTarget>|null=null;if(row)target=await this.record(client,context,row);else if((await this.latest(client,context,r.targetId)).action!=='delete')throw unavailable();
    await authorizeFixedSession(client,context,signal);return Object.freeze({target,operation:Object.freeze({id:r.operationId,targetId:r.targetId,appliedRevision:r.appliedRevision,replayed:true})});
   }
   const id=requested??randomUUID();let base:Readonly<CareerTarget>|null=null;
   if(action!=='create'){const row=await this.row(client,context,id);if(!row)throw notFound();base=await this.record(client,context,row);if(base.revision!==command.expectedRevision)throw changed();}
   // Forgetting remains available after current terms/email are withdrawn.
   if(action!=='delete')await this.storage.authorizeSession(client,context,signal);
   if(action==='create'&&(await client.query('SELECT count(*)::int count FROM platform_career_targets WHERE user_id=$1',[context.userId])).rows[0].count>=100)throw new ApiError(409,'CAREER_TARGET_CAPACITY','Save at most 100 directions.');
   const revision=(base?.revision??0)+1;if(revision>2147483647)throw changed();const at=(await client.query('SELECT clock_timestamp() at')).rows[0].at.toISOString();
   let target:Readonly<CareerTarget>|null=null;
   if(action!=='delete'){
    const fields=Object.fromEntries(['roleFamily','title','locations','priority','reviewOn'].filter(k=>Object.hasOwn(command,k)).map(k=>[k,(command as any)[k]]));
    target=parseCareerTarget({...base,...(action==='create'?{reviewOn:null}:{}),...fields,id,ownerId:context.userId,status:action==='create'?'exploring':action==='status'?command.status:base!.status,source:'user_entered',proposedBy:null,revision,createdAt:base?.createdAt??at,updatedAt:at,lastOperationId:command.operationId});
   }
   const receipt:Receipt={schemaVersion:1,ownerId:context.userId,operationId:command.operationId,targetId:id,action,commandDigest:digest,appliedRevision:revision,acceptedAuthVersion:String(auth.auth_version),createdAt:at};
   const sealed=this.storage.crypto!.sealUtf8(canonical(receipt),{table:'platform_career_target_operations',column:'receipt_ciphertext',rowId:receipt.operationId,ownerId:context.userId,revision});
   await client.query('INSERT INTO platform_career_target_operations(user_id,operation_id,target_id,action,applied_revision,created_at,receipt_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7)',[context.userId,command.operationId,id,action,revision,at,sealed]);
   if(target){const encrypted=this.storage.crypto!.sealUtf8(canonical(target),{table:'platform_career_targets',column:'record_ciphertext',rowId:id,ownerId:context.userId,revision});
    await client.query(`INSERT INTO platform_career_targets(id,user_id,role_family,priority,status,proposed_by,revision,last_operation_id,record_ciphertext,created_at,updated_at) VALUES($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,$10)
     ON CONFLICT(id) DO UPDATE SET role_family=EXCLUDED.role_family,priority=EXCLUDED.priority,status=EXCLUDED.status,revision=EXCLUDED.revision,last_operation_id=EXCLUDED.last_operation_id,record_ciphertext=EXCLUDED.record_ciphertext,updated_at=EXCLUDED.updated_at`,[id,context.userId,target.roleFamily,target.priority,target.status,revision,command.operationId,encrypted,target.createdAt,at]);
   }else await client.query('DELETE FROM platform_career_targets WHERE id=$1 AND user_id=$2',[id,context.userId]);
   await authorizeFixedSession(client,context,signal);signal?.throwIfAborted();return Object.freeze({target,operation:Object.freeze({id:command.operationId,targetId:id,appliedRevision:revision,replayed:false})});
  });
 }
}
