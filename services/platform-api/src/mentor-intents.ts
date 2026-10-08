import { randomUUID, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { careerRecordId,careerRecordObject,parseMentorIntentCommand,parseMentorIntent,parseMentorServiceOffer,
  mentorServiceInteger,mentorIntentEmail,MENTOR_INTENT_PRIVACY,MENTOR_INTENT_PRIVACY_VERSION,type MentorIntent,type MentorServiceOffer } from '@companion/platform-contracts';
import type { Database } from './database.ts';
import type { PlatformConfig } from './config.ts';
import type { LegalBundle } from './legal-documents.ts';
import type { FixedSessionContext } from './auth.ts';
import { OnboardingStorage } from './onboarding-storage.ts';
import { StaffAccess } from './staff-access.ts';
import type { MentorServiceOffers } from './mentor-service-offers.ts';
import { ApiError } from './errors.ts';
const missing=()=>new ApiError(404,'NOT_FOUND','没有找到这份真人预约意向。');
const invalid=()=>new ApiError(400,'MENTOR_INTENT_INPUT_INVALID','请填写需求并确认运营可见的信息。');
const unavailable=()=>new ApiError(503,'MENTOR_INTENT_STORAGE_UNAVAILABLE','暂时无法确认预约意向，请重新读取。');
const changed=()=>new ApiError(409,'MENTOR_INTENT_REVISION_CHANGED','请先查看最新预约意向。');
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)
  ?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x)).digest('hex');
function fixed(v:FixedSessionContext) {
  try {const o=careerRecordObject(v,['userId','tokenHash']);if(typeof o.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(o.tokenHash))throw Error();
    return Object.freeze({userId:careerRecordId(o.userId),tokenHash:o.tokenHash});}catch{throw new ApiError(401,'AUTH_REQUIRED','请重新登录。');}
}
interface SessionRow {
  id:string;user_id:string;org_id:string;offer_id:string;offer_revision:number;kind:string;duration_min:number;status:string;
  mentor_id:string|null;order_id:string|null;packet_id:string|null;scheduled_at:Date|null;review_id:string|null;
  revision:number;last_operation_id:string;created_at:Date;updated_at:Date;payload_ciphertext:Buffer;
}
interface OperationRow {user_id:string;org_id:string;operation_id:string;session_id:string;action:'create'|'cancel';applied_revision:number;created_at:Date;receipt_ciphertext:Buffer;}
interface Receipt {
  schemaVersion:1;ownerId:string;orgId:string;operationId:string;sessionId:string;action:'create'|'cancel';appliedRevision:number;
  command:unknown;commandDigest:string;recordDigest:string;acceptedAuthVersion:string;createdAt:string;acceptedOffer:MentorServiceOffer|null;
}
export interface MentorIntentOperation {readonly id:string;readonly sessionId:string;readonly appliedRevision:number;readonly replayed:boolean;}
/** Explicit owner intent, not booking or paid suggestion. Ops see only the fields the owner confirms. */
export class MentorIntents {
  private readonly store:OnboardingStorage;private readonly staff:StaffAccess;private readonly organizationId:string|undefined;
  constructor(private readonly db:Database,config:Pick<PlatformConfig,'dataCrypto'|'requireVerifiedEmail'|'mentorOrganizationId'>,legal:LegalBundle|null,
    private readonly offers:Pick<MentorServiceOffers,'listInTransaction'>,staff?:StaffAccess){
    this.store=new OnboardingStorage(config,legal);this.staff=staff??new StaffAccess(db);
    this.organizationId=config.mentorOrganizationId===undefined?undefined:careerRecordId(config.mentorOrganizationId);
  }
  private seal(table:string,id:string,owner:string,revision:number,value:unknown) {
    try {if(!this.store.crypto)throw Error();return this.store.crypto.sealUtf8(JSON.stringify(value),{table,column:'payload',rowId:id,ownerId:owner,revision});}catch{throw unavailable();}
  }
  private open(table:string,id:string,owner:string,revision:number,cipher:Buffer):unknown {
    try {if(!this.store.crypto)throw Error();return JSON.parse(this.store.crypto.openUtf8(cipher,{table,column:'payload',rowId:id,ownerId:owner,revision}));}catch{throw unavailable();}
  }
  private receipt(row:OperationRow):Receipt {
    try {
      const v=careerRecordObject(this.open('mentor_intent_operation',row.operation_id,row.user_id,row.applied_revision,row.receipt_ciphertext),
        ['schemaVersion','ownerId','orgId','operationId','sessionId','action','appliedRevision','command','commandDigest','recordDigest','acceptedAuthVersion','createdAt','acceptedOffer']);
      if(v.schemaVersion!==1||v.ownerId!==row.user_id||v.orgId!==row.org_id||v.operationId!==row.operation_id||v.sessionId!==row.session_id||
        v.action!==row.action||v.appliedRevision!==row.applied_revision||v.createdAt!==row.created_at.toISOString()||
        typeof v.acceptedAuthVersion!=='string'||!/^\d+$/.test(v.acceptedAuthVersion)||typeof v.recordDigest!=='string'||!/^[0-9a-f]{64}$/.test(v.recordDigest))throw Error();
      const command=row.action==='create'?parseMentorIntentCommand(v.command):this.cancelCommand(v.command);
      if(command.operationId!==row.operation_id||v.commandDigest!==digest(command)||
        (row.action==='create'?row.applied_revision!==1:row.applied_revision!==2))throw Error();
      let acceptedOffer:MentorServiceOffer|null=null;
      if(row.action==='create'){
        const cmd=parseMentorIntentCommand(command);acceptedOffer=parseMentorServiceOffer(v.acceptedOffer);
        if(acceptedOffer.id!==cmd.offerId||acceptedOffer.revision!==cmd.offerRevision||acceptedOffer.organizationId!==row.org_id||acceptedOffer.availability!=='available'||acceptedOffer.validFrom>row.created_at.toISOString()||acceptedOffer.validUntil<=row.created_at.toISOString()||
          !acceptedOffer.earliestSlotAt||acceptedOffer.earliestSlotAt<=row.created_at.toISOString()||acceptedOffer.updatedAt>row.created_at.toISOString())throw Error();
      }else if(v.acceptedOffer!==null)throw Error();
      return {...v,command,acceptedOffer} as unknown as Receipt;
    }catch{throw unavailable();}
  }
  private async decode(c:PoolClient,row:SessionRow):Promise<MentorIntent> {
    try {
      const r=parseMentorIntent(this.open('mentor_intent',row.id,row.user_id,row.revision,row.payload_ciphertext));
      if(r.id!==row.id||r.ownerId!==row.user_id||r.organizationId!==row.org_id||r.offerId!==row.offer_id||r.offerRevision!==row.offer_revision||
        r.kind!==row.kind||r.durationMin!==row.duration_min||r.status!==row.status||r.revision!==row.revision||r.lastOperationId!==row.last_operation_id||
        r.createdAt!==row.created_at.toISOString()||r.updatedAt!==row.updated_at.toISOString()||
        [row.mentor_id,row.order_id,row.packet_id,row.scheduled_at,row.review_id].some(v=>v!==null))throw Error();
      const operations=(await c.query<OperationRow>('SELECT * FROM platform_mentor_intent_operations WHERE session_id=$1 AND user_id=$2 ORDER BY applied_revision FOR SHARE',[r.id,r.ownerId])).rows;
      if(operations.length!==r.revision||operations.some(o=>o.org_id!==r.organizationId))throw Error();
      const first=this.receipt(operations[0]),last=this.receipt(operations.at(-1)!);
      if(last.recordDigest!==digest(r)||last.operationId!==r.lastOperationId||last.appliedRevision!==r.revision||last.createdAt!==r.updatedAt||
        first.action!=='create'||first.createdAt!==r.createdAt)throw Error();
      const initial=parseMentorIntentCommand(first.command),accepted=first.acceptedOffer!;
      if(initial.offerId!==r.offerId||initial.offerRevision!==r.offerRevision||initial.contactName!==r.contactName||initial.intentNote!==r.intentNote||
        accepted.kind!==r.kind||accepted.durationMin!==r.durationMin)throw Error();
      return r;
    }catch{throw unavailable();}
  }
  private cancelCommand(input:unknown) {
    const v=careerRecordObject(input,['operationId','expectedRevision']);
    return Object.freeze({operationId:careerRecordId(v.operationId),expectedRevision:mentorServiceInteger(v.expectedRevision,1,1)});
  }
  private async read(c:PoolClient,owner:string,id:string) {
    const row=(await c.query<SessionRow>('SELECT * FROM platform_mentor_sessions WHERE id=$1 AND user_id=$2 FOR SHARE',[id,owner])).rows[0];
    if(!row)throw missing();return this.decode(c,row);
  }
  private async at(c:PoolClient):Promise<string>{return (await c.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString();}
  async entry(session:FixedSessionContext,signal?:AbortSignal) {
    const context=fixed(session);
    return this.db.withBoundedTransaction(async c=>{
      await this.store.authorizeSession(c,context,signal);
      const email=mentorIntentEmail((await c.query('SELECT email FROM platform_users WHERE id=$1',[context.userId])).rows[0].email);
      const offers=this.organizationId?await this.offers.listInTransaction(c,context,this.organizationId,signal):Object.freeze([]);
      await this.store.authorizeSession(c,context,signal);signal?.throwIfAborted();
      return Object.freeze({configured:this.organizationId!==undefined,contactEmail:email,privacyVersion:MENTOR_INTENT_PRIVACY_VERSION,intentPrivacy:MENTOR_INTENT_PRIVACY,offers});
    });
  }
  async get(session:FixedSessionContext,id:string,signal?:AbortSignal) {
    const context=fixed(session),key=careerRecordId(id);return this.db.withBoundedTransaction(async c=>{
      await this.store.authorizeSession(c,context,signal);const result=await this.read(c,context.userId,key);
      await this.store.authorizeSession(c,context,signal);signal?.throwIfAborted();return result;
    });
  }
  async list(session:FixedSessionContext,input:unknown={},signal?:AbortSignal) {
    const context=fixed(session),after=this.after(input);
    return this.db.withBoundedTransaction(async c=>{
      await this.store.authorizeSession(c,context,signal);
      const anchor=after?await this.read(c,context.userId,after):null;
      const rows=(await c.query<SessionRow>(`SELECT * FROM platform_mentor_sessions WHERE user_id=$1
        AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51 FOR SHARE`,
        [context.userId,anchor?.createdAt??null,anchor?.id??null])).rows;
      const sessions:MentorIntent[]=[];for(const row of rows.slice(0,50)){signal?.throwIfAborted();sessions.push(await this.decode(c,row));}
      await this.store.authorizeSession(c,context,signal);signal?.throwIfAborted();
      return Object.freeze({sessions:Object.freeze(sessions),nextCursor:rows.length>50?sessions.at(-1)!.id:null});
    });
  }
  private after(input:unknown):string|null {
    try{const v=careerRecordObject(input,[],['after']);return v.after===undefined?null:careerRecordId(v.after);}catch{throw invalid();}
  }
  async observe(session:FixedSessionContext,operationId:string,signal?:AbortSignal) {
    const context=fixed(session),key=careerRecordId(operationId);return this.db.withBoundedTransaction(async c=>{
      await this.store.authorizeSession(c,context,signal);
      const row=(await c.query<OperationRow>('SELECT * FROM platform_mentor_intent_operations WHERE user_id=$1 AND operation_id=$2 FOR SHARE',[context.userId,key])).rows[0];
      if(!row)throw missing();const p=this.receipt(row),result=await this.read(c,context.userId,p.sessionId);
      await this.store.authorizeSession(c,context,signal);signal?.throwIfAborted();
      return Object.freeze({session:result,operation:Object.freeze({id:key,sessionId:result.id,appliedRevision:p.appliedRevision,replayed:true})});
    });
  }
  async create(session:FixedSessionContext,input:unknown,signal?:AbortSignal) {
    let command:ReturnType<typeof parseMentorIntentCommand>;try{command=parseMentorIntentCommand(input);}catch{throw invalid();}
    return this.mutate(session,'create',command,undefined,signal);
  }
  async cancel(session:FixedSessionContext,id:string,input:unknown,signal?:AbortSignal) {
    let command:ReturnType<MentorIntents['cancelCommand']>;try{command=this.cancelCommand(input);}catch{throw invalid();}
    return this.mutate(session,'cancel',command,careerRecordId(id),signal);
  }
  private async mutate(session:FixedSessionContext,action:'create'|'cancel',command:{readonly operationId:string},id:string|undefined,signal?:AbortSignal) {
    const context=fixed(session);
    return this.db.withBoundedTransaction(async c=>{
      const authVersion=await this.store.authorizeSession(c,context,signal);
      const old=(await c.query<OperationRow>('SELECT * FROM platform_mentor_intent_operations WHERE user_id=$1 AND operation_id=$2 FOR SHARE',[context.userId,command.operationId])).rows[0];
      if(old){
        const p=this.receipt(old);
        if(p.action!==action||p.commandDigest!==digest(command)||id!==undefined&&p.sessionId!==id)throw new ApiError(409,'MENTOR_INTENT_OPERATION_CONFLICT','操作编号已用于其他请求。');
        const current=await this.read(c,context.userId,p.sessionId);
        await this.store.authorizeSession(c,context,signal);signal?.throwIfAborted();
        return Object.freeze({session:current,operation:Object.freeze({id:command.operationId,sessionId:current.id,appliedRevision:p.appliedRevision,replayed:true})});
      }
      let record:MentorIntent,acceptedOffer:MentorServiceOffer|null=null;
      if(action==='create'){
        if(!this.organizationId)throw new ApiError(503,'MENTOR_SERVICE_UNAVAILABLE','真人服务尚未配置。');
        const cmd=parseMentorIntentCommand(command);
        const offers=await this.offers.listInTransaction(c,context,this.organizationId,signal),offer=offers.find(o=>o.id===cmd.offerId);
        if(!offer)throw new ApiError(409,'MENTOR_SERVICE_UNAVAILABLE','服务已变更，请重新查看。');
        if(offer.revision!==cmd.offerRevision)throw new ApiError(409,'MENTOR_SERVICE_OFFER_CHANGED','服务信息已更新，请重新查看并确认。');
        const at=await this.at(c);
        if(offer.availability!=='available'||!offer.earliestSlotAt||offer.earliestSlotAt<=at||offer.validUntil<=at)throw new ApiError(409,'MENTOR_SERVICE_UNAVAILABLE','目前没有确认的可约时段。');
        const email=mentorIntentEmail((await c.query('SELECT email FROM platform_users WHERE id=$1',[context.userId])).rows[0].email);
        record=parseMentorIntent({id:randomUUID(),ownerId:context.userId,organizationId:this.organizationId,offerId:offer.id,offerRevision:offer.revision,
          kind:offer.kind,durationMin:offer.durationMin,contactName:cmd.contactName,contactEmail:email,intentNote:cmd.intentNote,status:'requested',
          orderId:null,mentorId:null,privacyVersion:MENTOR_INTENT_PRIVACY_VERSION,visibilityConfirmedAt:at,revision:1,createdAt:at,updatedAt:at,lastOperationId:command.operationId});
        acceptedOffer=offer;
      }else{
        const row=(await c.query<SessionRow>('SELECT * FROM platform_mentor_sessions WHERE user_id=$1 AND id=$2 FOR UPDATE',[context.userId,id])).rows[0];
        if(!row)throw missing();const current=await this.decode(c,row),cmd=this.cancelCommand(command);
        if(current.revision!==cmd.expectedRevision||current.status!=='requested')throw changed();
        record=parseMentorIntent({...current,status:'cancelled',revision:2,updatedAt:await this.at(c),lastOperationId:command.operationId});
      }
      const receipt:Receipt={schemaVersion:1,ownerId:context.userId,orgId:record.organizationId,operationId:command.operationId,sessionId:record.id,
        action,appliedRevision:record.revision,command,commandDigest:digest(command),recordDigest:digest(record),acceptedAuthVersion:authVersion,createdAt:record.updatedAt,acceptedOffer};
      await c.query(`INSERT INTO platform_mentor_intent_operations(user_id,org_id,operation_id,session_id,action,applied_revision,created_at,receipt_ciphertext)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[context.userId,record.organizationId,command.operationId,record.id,action,record.revision,record.updatedAt,
          this.seal('mentor_intent_operation',command.operationId,context.userId,record.revision,receipt)]);
      if(action==='create'){
        await c.query(`INSERT INTO platform_mentor_sessions(id,user_id,org_id,offer_id,offer_revision,kind,duration_min,status,revision,last_operation_id,created_at,updated_at,payload_ciphertext)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[record.id,context.userId,record.organizationId,record.offerId,record.offerRevision,
            record.kind,record.durationMin,record.status,record.revision,record.lastOperationId,record.createdAt,record.updatedAt,this.seal('mentor_intent',record.id,context.userId,record.revision,record)]);
      }else{
        const saved=await c.query('UPDATE platform_mentor_sessions SET status=$3,revision=$4,last_operation_id=$5,updated_at=$6,payload_ciphertext=$7 WHERE id=$1 AND user_id=$2 AND revision=1',
          [record.id,context.userId,record.status,record.revision,record.lastOperationId,record.updatedAt,this.seal('mentor_intent',record.id,context.userId,record.revision,record)]);
        if(saved.rowCount!==1)throw changed();
      }
      await this.store.authorizeSession(c,context,signal);signal?.throwIfAborted();
      return Object.freeze({session:record,operation:Object.freeze({id:command.operationId,sessionId:record.id,appliedRevision:record.revision,replayed:false})});
    });
  }
  async opsList(session:FixedSessionContext,organizationId:string,input:unknown={},signal?:AbortSignal) {
    const context=fixed(session),org=careerRecordId(organizationId),after=this.after(input);
    return this.staff.readWithAccess(context,org,{roles:['ops','org_admin'],action:'mentor_intents_viewed'},async c=>{
      const anchor=after?(await c.query<SessionRow>('SELECT * FROM platform_mentor_sessions WHERE org_id=$1 AND id=$2 FOR SHARE',[org,after])).rows[0]:null;
      if(after&&!anchor)throw missing();if(anchor)await this.decode(c,anchor);
      const rows=(await c.query<SessionRow>(`SELECT * FROM platform_mentor_sessions WHERE org_id=$1
        AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51 FOR SHARE`,
        [org,anchor?.created_at??null,anchor?.id??null])).rows;
      const intents=[];for(const row of rows.slice(0,50)){
        signal?.throwIfAborted();const s=await this.decode(c,row);
        intents.push(Object.freeze({id:s.id,contactName:s.contactName,contactEmail:s.contactEmail,intentNote:s.intentNote,kind:s.kind,
          status:s.status,durationMin:s.durationMin,createdAt:s.createdAt}));
      }
      signal?.throwIfAborted();return {value:Object.freeze({intents:Object.freeze(intents),nextCursor:rows.length>50?intents.at(-1)!.id:null}),recordCount:intents.length};
    },signal);
  }
}
