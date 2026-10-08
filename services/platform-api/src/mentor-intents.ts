import type { BlobStorage } from './storage.ts';
import { captureMentorReceiptEvidence,parseMentorReceiptEvidence,type MentorReceiptEvidence } from './mentor-receipt-evidence.ts';
import { authorizeMentorStaffSource } from './mentor-staff-source.ts';
import { MentorOrders } from './mentor-orders.ts';
import { MentorSlotReservations } from './mentor-slot-reservations.ts';
import type { MentorCapacity } from './mentor-capacity.ts';
import { parseConfirmedMentorCapacity,type ConfirmedMentorCapacity } from './mentor-confirmed-capacity.ts';
import { randomUUID, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { careerRecordId,careerRecordObject,parseMentorIntentCommand,parseMentorIntent,parseMentorServiceOffer,
  mentorServiceInteger,mentorIntentEmail,parseMentorMatchCommand,type MentorMatchCommand,parseMentorSchedulingCommand,type MentorSchedulingCommand,MENTOR_INTENT_PRIVACY,MENTOR_INTENT_PRIVACY_VERSION,type MentorIntent,type MentorServiceOffer } from '@companion/platform-contracts';
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
interface OperationRow {user_id:string;org_id:string;operation_id:string;session_id:string;action:'create'|'cancel'|'match'|'schedule'|'cancel_scheduled'|'complete';applied_revision:number;created_at:Date;receipt_ciphertext:Buffer;}
interface Receipt {
  schemaVersion:1|2|3;ownerId:string;orgId:string;operationId:string;sessionId:string;action:'create'|'cancel'|'match'|'schedule'|'cancel_scheduled'|'complete';appliedRevision:number;
  command:unknown;commandDigest:string;recordDigest:string;acceptedAuthVersion:string;createdAt:string;acceptedOffer:MentorServiceOffer|null;actorId?:string;actorAuthVersion?:string;acceptedCapacity?:Readonly<ConfirmedMentorCapacity>;confirmationEvidence?:readonly Readonly<MentorReceiptEvidence>[];
}
export interface MentorIntentOperation {readonly id:string;readonly sessionId:string;readonly appliedRevision:number;readonly replayed:boolean;}
/** Explicit owner intent, not booking or paid suggestion. Ops see only the fields the owner confirms. */
export class MentorIntents {
  private readonly store:OnboardingStorage;private readonly staff:StaffAccess;private readonly organizationId:string|undefined;private readonly orders:MentorOrders;private readonly reservations:MentorSlotReservations;
  constructor(private readonly db:Database,config:Pick<PlatformConfig,'dataCrypto'|'requireVerifiedEmail'|'mentorOrganizationId'>,legal:LegalBundle|null,
    private readonly offers:Pick<MentorServiceOffers,'listInTransaction'>&Partial<Pick<MentorServiceOffers,'currentForStaffInTransaction'>>,staff?:StaffAccess,
    private readonly capacity?:Pick<MentorCapacity,'confirmedInTransaction'>,private readonly blobs?:Pick<BlobStorage,'stat'>){
    this.store=new OnboardingStorage(config,legal);this.staff=staff??new StaffAccess(db);this.orders=new MentorOrders(config);this.reservations=new MentorSlotReservations(config);
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
        ['schemaVersion','ownerId','orgId','operationId','sessionId','action','appliedRevision','command','commandDigest','recordDigest','acceptedAuthVersion','createdAt','acceptedOffer'],['actorId','actorAuthVersion','acceptedCapacity','confirmationEvidence']);
      const isScheduling=row.action==='schedule'||row.action==='cancel_scheduled'||row.action==='complete';
      if((isScheduling?v.schemaVersion!==3:row.action==='match'?v.schemaVersion!==2:v.schemaVersion!==1)||v.ownerId!==row.user_id||v.orgId!==row.org_id||v.operationId!==row.operation_id||v.sessionId!==row.session_id||
        v.action!==row.action||v.appliedRevision!==row.applied_revision||v.createdAt!==row.created_at.toISOString()||
        typeof v.acceptedAuthVersion!=='string'||!/^\d+$/.test(v.acceptedAuthVersion)||typeof v.recordDigest!=='string'||!/^[0-9a-f]{64}$/.test(v.recordDigest))throw Error();
      const command=row.action==='create'?parseMentorIntentCommand(v.command):row.action==='match'?parseMentorMatchCommand(v.command):isScheduling?parseMentorSchedulingCommand(v.command):this.cancelCommand(v.command);
      if(command.operationId!==row.operation_id||v.commandDigest!==digest(command)||
        (row.action==='create'?row.applied_revision!==1:row.applied_revision!==('expectedRevision' in command?command.expectedRevision+1:0)))throw Error();
      if(isScheduling){
        const cmd=parseMentorSchedulingCommand(command);
        if(cmd.action!==row.action||cmd.sessionId!==row.session_id||v.acceptedOffer!==null||typeof v.actorAuthVersion!=='string'||!/^\d+$/.test(v.actorAuthVersion)||
          !Array.isArray(v.confirmationEvidence)||v.confirmationEvidence.length!==(cmd.action==='schedule'?2:1))throw Error();
        const actorId=careerRecordId(v.actorId),evidence=v.confirmationEvidence.map(parseMentorReceiptEvidence),at=row.created_at.toISOString();
        if(evidence.some(e=>e.ownerId!==actorId)||cmd.action==='schedule'&&(evidence[0].ref!==cmd.userConfirmationRef||evidence[1].ref!==cmd.mentorConfirmationRef||cmd.confirmedAt>at)||
          cmd.action!=='schedule'&&(evidence[0].ref!==cmd.evidenceRef||(cmd.action==='complete'?cmd.completedAt:cmd.occurredAt)>at||v.acceptedCapacity!==undefined))throw Error();
        const capacity=cmd.action==='schedule'?parseConfirmedMentorCapacity(v.acceptedCapacity):undefined;
        return {...v,command:cmd,actorId,confirmationEvidence:evidence,...(capacity?{acceptedCapacity:capacity}:{})} as unknown as Receipt;
      }
      if(v.confirmationEvidence!==undefined)throw Error();
      let acceptedOffer:MentorServiceOffer|null=null;
      if(row.action==='create'){
        const cmd=parseMentorIntentCommand(command);acceptedOffer=parseMentorServiceOffer(v.acceptedOffer);
        if(acceptedOffer.id!==cmd.offerId||acceptedOffer.revision!==cmd.offerRevision||acceptedOffer.organizationId!==row.org_id||acceptedOffer.availability!=='available'||acceptedOffer.validFrom>row.created_at.toISOString()||acceptedOffer.validUntil<=row.created_at.toISOString()||
          !acceptedOffer.earliestSlotAt||acceptedOffer.earliestSlotAt<=row.created_at.toISOString()||acceptedOffer.updatedAt>row.created_at.toISOString())throw Error();
      }else if(row.action==='match'){
        acceptedOffer=parseMentorServiceOffer(v.acceptedOffer);
        if(typeof v.actorAuthVersion!=='string'||!/^\d+$/.test(v.actorAuthVersion)||acceptedOffer.organizationId!==row.org_id)throw Error();
        const cmd=parseMentorMatchCommand(command),capacity=parseConfirmedMentorCapacity(v.acceptedCapacity);
        if(cmd.sessionId!==row.session_id||cmd.slotId!==capacity.slot.recordId||cmd.slotRevision!==capacity.slotRevision||capacity.profile.signedAt>(v.createdAt as string)||capacity.slot.confirmedAt>(v.createdAt as string))throw Error();
        return {...v,command,acceptedOffer,actorId:careerRecordId(v.actorId),acceptedCapacity:capacity} as unknown as Receipt;
      }else if(v.acceptedOffer!==null)throw Error();
      if(v.actorId!==undefined||v.actorAuthVersion!==undefined||v.acceptedCapacity!==undefined)throw Error();
      return {...v,command,acceptedOffer} as unknown as Receipt;
    }catch{throw unavailable();}
  }
  private async decode(c:PoolClient,row:SessionRow):Promise<MentorIntent> {
    try {
      const r=parseMentorIntent(this.open('mentor_intent',row.id,row.user_id,row.revision,row.payload_ciphertext));
      if(r.id!==row.id||r.ownerId!==row.user_id||r.organizationId!==row.org_id||r.offerId!==row.offer_id||r.offerRevision!==row.offer_revision||
        r.kind!==row.kind||r.durationMin!==row.duration_min||r.status!==row.status||r.revision!==row.revision||r.lastOperationId!==row.last_operation_id||
        r.createdAt!==row.created_at.toISOString()||r.updatedAt!==row.updated_at.toISOString()||
        row.mentor_id!==r.mentorId||row.order_id!==r.orderId||[row.packet_id,row.review_id].some(v=>v!==null)||
        (row.scheduled_at?.toISOString()??null)!==(r.scheduled?r.assignment!.startsAt:null))throw Error();
      const operations=(await c.query<OperationRow>('SELECT * FROM platform_mentor_intent_operations WHERE session_id=$1 AND user_id=$2 ORDER BY applied_revision FOR SHARE',[r.id,r.ownerId])).rows;
      if(operations.length!==r.revision||operations.some((o,i)=>o.org_id!==r.organizationId||o.applied_revision!==i+1))throw Error();
      const proofs=operations.map(o=>this.receipt(o)),first=proofs[0],last=proofs.at(-1)!;
      if(last.recordDigest!==digest(r)||last.operationId!==r.lastOperationId||last.appliedRevision!==r.revision||last.createdAt!==r.updatedAt||
        first.action!=='create'||first.createdAt!==r.createdAt)throw Error();
      const initial=parseMentorIntentCommand(first.command),accepted=first.acceptedOffer!;
      if(initial.offerId!==r.offerId||initial.offerRevision!==r.offerRevision||initial.contactName!==r.contactName||initial.intentNote!==r.intentNote||
        accepted.kind!==r.kind||accepted.durationMin!==r.durationMin)throw Error();
      const match=proofs.find(p=>p.action==='match');
      if(r.assignment){
        if(!match||match.appliedRevision!==2||r.status==='matched'&&last.action!=='match'||r.status==='scheduled'&&last.action!=='schedule'||r.status==='completed'&&last.action!=='complete'||
          r.status==='cancelled'&&last.action!==(r.scheduled?'cancel_scheduled':'cancel')||!r.orderId||!r.mentorId)throw Error();
        const source=match.acceptedCapacity!,cmd=parseMentorMatchCommand(match.command),a=r.assignment;
        if(source.profile.mentorId!==r.mentorId||source.profile.displayName!==a.mentorDisplayName||source.profile.recordId!==a.profileId||source.profileRevision!==a.profileRevision||
          source.slot.recordId!==a.slotId||source.slotRevision!==a.slotRevision||source.slot.startsAt!==a.startsAt||source.slot.endsAt<a.endsAt||
          source.slot.timeZone!==a.timeZone||source.slot.service!==r.kind||match.createdAt!==a.matchedAt||cmd.priceCents>accepted.priceCents||
          cmd.priceCents>match.acceptedOffer!.priceCents||match.acceptedOffer!.kind!==r.kind||match.acceptedOffer!.durationMin!==r.durationMin)throw Error();
        const scheduling=proofs.find(p=>p.action==='schedule');
        if(r.scheduled){
          if(!scheduling||scheduling.appliedRevision!==3||digest(scheduling.acceptedCapacity)!==digest(source))throw Error();
          const command=parseMentorSchedulingCommand(scheduling.command);
          if(command.action!=='schedule'||command.meetingUrl!==r.scheduled.meetingUrl||command.confirmedAt!==r.scheduled.confirmedAt||
            r.scheduled.confirmedAt<a.matchedAt||scheduling.createdAt>=a.startsAt)throw Error();
          if(r.status==='cancelled'){const cancelled=parseMentorSchedulingCommand(last.command);
            if(cancelled.action!=='cancel_scheduled'||cancelled.occurredAt<scheduling.createdAt)throw Error();}
          if(r.status==='completed'){const completed=parseMentorSchedulingCommand(last.command);
            if(completed.action!=='complete'||completed.completedAt!==r.completedAt||completed.completedAt<a.endsAt)throw Error();}
        }else if(scheduling)throw Error();
        const order=await this.orders.readInTransaction(c,r.ownerId,r.orderId,match.operationId),reservation=await this.reservations.readInTransaction(c,r.ownerId,r.id);
        if(order.sessionId!==r.id||order.organizationId!==r.organizationId||order.offerId!==r.offerId||order.offerRevision!==r.offerRevision||order.priceCents!==cmd.priceCents||
          digest(order.shownOffer)!==digest(accepted)||order.createdAt!==match.createdAt||
          (!order.payment&&(order.lastOperationId!==(r.status==='cancelled'?r.lastOperationId:match.operationId)||
            order.updatedAt!==(r.status==='cancelled'?r.updatedAt:match.createdAt)||(r.status==='cancelled'?order.status!=='void':order.status!=='quoted')))||reservation.mentorId!==r.mentorId||reservation.orgId!==r.organizationId||
          reservation.slotId!==a.slotId||reservation.slotRevision!==a.slotRevision||reservation.startsAt!==source.slot.startsAt||reservation.endsAt!==source.slot.endsAt||
          reservation.lastOperationId!==(r.status==='cancelled'?r.lastOperationId:match.operationId)||
          reservation.updatedAt!==(r.status==='cancelled'?r.updatedAt:match.createdAt)||(r.status==='cancelled'?reservation.status!=='released':reservation.status!=='held'))throw Error();
      }else if(match||r.scheduled||r.status==='matched'||r.status==='scheduled'||r.status==='completed'||last.action!==(r.status==='requested'?'create':'cancel'))throw Error();
      return r;
    }catch{throw unavailable();}
  }
  private cancelCommand(input:unknown) {
    const v=careerRecordObject(input,['operationId','expectedRevision']);
    return Object.freeze({operationId:careerRecordId(v.operationId),expectedRevision:mentorServiceInteger(v.expectedRevision,1,2147483646)});
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
        if(current.revision!==cmd.expectedRevision||!['requested','matched'].includes(current.status))throw changed();
        record=parseMentorIntent({...current,status:'cancelled',revision:current.revision+1,updatedAt:await this.at(c),lastOperationId:command.operationId});
        if(current.assignment){await this.reservations.releaseInTransaction(c,record,signal);await this.orders.voidInTransaction(c,record,signal);}
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
        const saved=await c.query('UPDATE platform_mentor_sessions SET status=$3,revision=$4,last_operation_id=$5,updated_at=$6,payload_ciphertext=$7 WHERE id=$1 AND user_id=$2 AND revision=$8',
          [record.id,context.userId,record.status,record.revision,record.lastOperationId,record.updatedAt,this.seal('mentor_intent',record.id,context.userId,record.revision,record),record.revision-1]);
        if(saved.rowCount!==1)throw changed();
      }
      await this.store.authorizeSession(c,context,signal);signal?.throwIfAborted();
      return Object.freeze({session:record,operation:Object.freeze({id:command.operationId,sessionId:record.id,appliedRevision:record.revision,replayed:false})});
    });
  }
  /** P0 explicit operator invocation; no public matching issuer or fabricated owner session. */
  async match(session:FixedSessionContext,organizationId:string,input:unknown,signal?:AbortSignal){
    const context=fixed(session),org=careerRecordId(organizationId);let cmd:Readonly<MentorMatchCommand>;
    try{cmd=parseMentorMatchCommand(input);}catch{throw invalid();}
    return this.staff.readWithAccess<Readonly<{sessionId:string;status:MentorIntent['status'];revision:number;appliedRevision:number;replayed:boolean}>>(context,org,{roles:['ops','org_admin'],action:'mentor_intent_matched',targetId:cmd.sessionId},async c=>{
      // SHARE preserves catalog reads while preventing source edits. A separate nonce
      // lock serializes retries without taking an org UPDATE before the student lock.
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['mentor_match:'+org+':'+cmd.operationId]);
      const old=(await c.query<OperationRow>("SELECT * FROM platform_mentor_intent_operations WHERE org_id=$1 AND operation_id=$2 AND action='match' FOR SHARE",[org,cmd.operationId])).rows[0];
      if(old){
        const p=this.receipt(old);
        if(p.sessionId!==cmd.sessionId||p.actorId!==context.userId||p.commandDigest!==digest(cmd))throw new ApiError(409,'MENTOR_INTENT_OPERATION_CONFLICT','操作编号已用于其他请求。');
        await this.store.authorizeAccount(c,p.ownerId,undefined,signal);const current=await this.read(c,p.ownerId,p.sessionId);
        return {value:Object.freeze({sessionId:current.id,status:current.status,revision:current.revision,appliedRevision:p.appliedRevision,replayed:true}),recordCount:1};
      }
      if(this.organizationId!==org||!this.capacity||!this.offers.currentForStaffInTransaction)throw new ApiError(503,'MENTOR_MATCH_UNAVAILABLE','真人匹配尚未配置。');
      const target=(await c.query<SessionRow>('SELECT * FROM platform_mentor_sessions WHERE org_id=$1 AND id=$2',[org,cmd.sessionId])).rows[0];if(!target)throw missing();
      // Owner -> session order matches user cancellation, without minting a student login.
      const authVersion=await this.store.authorizeAccount(c,target.user_id,undefined,signal);
      const row=(await c.query<SessionRow>('SELECT * FROM platform_mentor_sessions WHERE org_id=$1 AND id=$2 AND user_id=$3 FOR UPDATE',[org,cmd.sessionId,target.user_id])).rows[0];if(!row)throw missing();
      const current=await this.decode(c,row);if(current.status!=='requested'||current.revision!==cmd.expectedRevision)throw changed();
      const initial=(await c.query<OperationRow>("SELECT * FROM platform_mentor_intent_operations WHERE user_id=$1 AND session_id=$2 AND action='create' FOR SHARE",[current.ownerId,current.id])).rows[0];
      const original=this.receipt(initial).acceptedOffer!,offer=await this.offers.currentForStaffInTransaction(c,context,org,current.offerId,signal);
      const capacity=await this.capacity.confirmedInTransaction(c,context,org,cmd.slotId,cmd.slotRevision,signal),slot=capacity.slot,at=await this.at(c);
      if(offer.kind!==current.kind||offer.durationMin!==current.durationMin||slot.service!==current.kind||
        Date.parse(slot.endsAt)-Date.parse(slot.startsAt)<current.durationMin*60000||slot.startsAt<offer.earliestSlotAt!||slot.startsAt<=at||original.validUntil<=at)
        throw new ApiError(409,'MENTOR_MATCH_SOURCE_CHANGED','导师、服务或时段已有变化，请先重新确认。');
      if(cmd.priceCents>Math.min(original.priceCents,offer.priceCents))throw new ApiError(409,'MENTOR_QUOTE_TOO_HIGH','报价不能高于用户当时看到的价格或当前公开价格。');
      const record=parseMentorIntent({...current,status:'matched',mentorId:capacity.profile.mentorId,orderId:randomUUID(),revision:2,lastOperationId:cmd.operationId,updatedAt:at,
        assignment:{mentorDisplayName:capacity.profile.displayName,slotId:slot.recordId,slotRevision:capacity.slotRevision,profileId:capacity.profile.recordId,profileRevision:capacity.profileRevision,
          startsAt:slot.startsAt,endsAt:new Date(Date.parse(slot.startsAt)+current.durationMin*60000).toISOString(),timeZone:slot.timeZone,matchedAt:at}});
      await this.reservations.holdInTransaction(c,context,record,{slotId:slot.recordId,slotRevision:capacity.slotRevision,startsAt:slot.startsAt,endsAt:slot.endsAt},signal);
      await this.orders.quoteInTransaction(c,context,record,original,cmd.priceCents,signal);
      const actorAuthVersion=String((await c.query('SELECT auth_version FROM platform_users WHERE id=$1',[context.userId])).rows[0].auth_version);
      const receipt:Receipt={schemaVersion:2,ownerId:record.ownerId,orgId:org,operationId:cmd.operationId,sessionId:record.id,action:'match',appliedRevision:2,
        command:cmd,commandDigest:digest(cmd),recordDigest:digest(record),acceptedAuthVersion:authVersion,createdAt:at,acceptedOffer:offer,
        actorId:context.userId,actorAuthVersion,acceptedCapacity:capacity};
      await c.query(`INSERT INTO platform_mentor_intent_operations(user_id,org_id,operation_id,session_id,action,applied_revision,created_at,receipt_ciphertext) VALUES($1,$2,$3,$4,'match',2,$5,$6)`,
        [record.ownerId,org,cmd.operationId,record.id,at,this.seal('mentor_intent_operation',cmd.operationId,record.ownerId,2,receipt)]);
      const saved=await c.query(`UPDATE platform_mentor_sessions SET status='matched',mentor_id=$3,order_id=$4,revision=2,last_operation_id=$5,updated_at=$6,payload_ciphertext=$7
        WHERE id=$1 AND user_id=$2 AND status='requested' AND revision=1`,[record.id,record.ownerId,record.mentorId,record.orderId,cmd.operationId,at,this.seal('mentor_intent',record.id,record.ownerId,2,record)]);
      if(saved.rowCount!==1)throw changed();
      await this.store.authorizeAccount(c,record.ownerId,authVersion,signal);
      const finalAt=await this.at(c);if(slot.startsAt<=finalAt||original.validUntil<=finalAt||offer.validUntil<=finalAt||offer.earliestSlotAt!<=finalAt)
        throw new ApiError(409,'MENTOR_MATCH_SOURCE_CHANGED','导师、服务或时段已有变化，请先重新确认。');
      signal?.throwIfAborted();return {value:Object.freeze({sessionId:record.id,status:record.status,revision:record.revision,appliedRevision:2,replayed:false}),recordCount:1};
    },signal);
  }
  /** P0 operator confirmation of the existing matched window. No calendar or meeting request is made. */
  async recordSchedule(session:FixedSessionContext,organizationId:string,input:unknown,signal?:AbortSignal){
    const context=fixed(session),org=careerRecordId(organizationId);let cmd:MentorSchedulingCommand;
    try{cmd=parseMentorSchedulingCommand(input);}catch{throw new ApiError(400,'MENTOR_SCHEDULING_INPUT_INVALID','请记录实际双方确认的预约或取消凭据。');}
    return this.staff.readWithAccess<Readonly<{sessionId:string;status:MentorIntent['status'];revision:number;appliedRevision:number;replayed:boolean}>>(context,org,
      {roles:['ops','org_admin'],action:'mentor_schedule_recorded',targetId:cmd.sessionId},async c=>{
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['mentor_scheduling:'+org+':'+cmd.operationId]);
      const old=(await c.query<OperationRow>("SELECT * FROM platform_mentor_intent_operations WHERE org_id=$1 AND operation_id=$2 AND action IN ('schedule','cancel_scheduled','complete') FOR SHARE",[org,cmd.operationId])).rows[0];
      if(old){const p=this.receipt(old);
        if(p.sessionId!==cmd.sessionId||p.action!==cmd.action||p.actorId!==context.userId||p.commandDigest!==digest(cmd))throw new ApiError(409,'MENTOR_INTENT_OPERATION_CONFLICT','操作编号已用于其他请求。');
        await this.store.authorizeAccount(c,p.ownerId,undefined,signal);const current=await this.read(c,p.ownerId,p.sessionId);
        return {value:Object.freeze({sessionId:current.id,status:current.status,revision:current.revision,appliedRevision:p.appliedRevision,replayed:true}),recordCount:1};
      }
      if(this.organizationId!==org||!this.capacity||!this.blobs)throw new ApiError(503,'MENTOR_SCHEDULING_UNAVAILABLE','真人排期尚未配置。');
      const accepted=await this.financeInTransaction(c,context,org,cmd.sessionId,signal),current=accepted.record;
      if(current.revision!==cmd.expectedRevision||current.status!==(cmd.action==='schedule'?'matched':'scheduled'))throw changed();
      let capacity:Readonly<ConfirmedMentorCapacity>|undefined;const evidence:Readonly<MentorReceiptEvidence>[]=[];
      if(cmd.action==='schedule'){
        capacity=await this.capacity.confirmedInTransaction(c,context,org,current.assignment!.slotId,current.assignment!.slotRevision,signal);
        if(digest(capacity)!==digest(accepted.capacity))throw new ApiError(409,'MENTOR_SCHEDULING_SOURCE_CHANGED','导师或时段已有变化，请重新确认。');
        evidence.push(await captureMentorReceiptEvidence(c,this.blobs,context.userId,cmd.userConfirmationRef,signal,'scheduling'),
          await captureMentorReceiptEvidence(c,this.blobs,context.userId,cmd.mentorConfirmationRef,signal,'scheduling'));
      }else evidence.push(await captureMentorReceiptEvidence(c,this.blobs,context.userId,cmd.evidenceRef,signal,'scheduling'));
      const at=await this.at(c);
      if(cmd.action==='complete'&&(cmd.completedAt<current.assignment!.endsAt||cmd.completedAt>at)||
        cmd.action==='schedule'&&(cmd.confirmedAt<current.assignment!.matchedAt||cmd.confirmedAt>at||current.assignment!.startsAt<=at)||
        cmd.action==='cancel_scheduled'&&(cmd.occurredAt<current.updatedAt||cmd.occurredAt>at))throw new ApiError(409,'MENTOR_SCHEDULING_TIME_INVALID','确认时间与真实预约记录不一致。');
      const record=parseMentorIntent({...current,status:cmd.action==='schedule'?'scheduled':cmd.action==='complete'?'completed':'cancelled',revision:current.revision+1,updatedAt:at,lastOperationId:cmd.operationId,
        ...(cmd.action==='schedule'?{scheduled:{confirmedAt:cmd.confirmedAt,meetingUrl:cmd.meetingUrl}}:cmd.action==='complete'?{completedAt:cmd.completedAt}:{})});
      if(cmd.action==='cancel_scheduled'){await this.reservations.releaseInTransaction(c,record,signal);await this.orders.voidInTransaction(c,record,signal);}
      const actorAuthVersion=String((await c.query('SELECT auth_version FROM platform_users WHERE id=$1',[context.userId])).rows[0].auth_version);
      const receipt:Receipt={schemaVersion:3,ownerId:record.ownerId,orgId:org,operationId:cmd.operationId,sessionId:record.id,action:cmd.action,appliedRevision:record.revision,
        command:cmd,commandDigest:digest(cmd),recordDigest:digest(record),acceptedAuthVersion:accepted.authVersion,createdAt:at,acceptedOffer:null,
        actorId:context.userId,actorAuthVersion,confirmationEvidence:Object.freeze(evidence),...(capacity?{acceptedCapacity:capacity}:{})};
      await c.query(`INSERT INTO platform_mentor_intent_operations(user_id,org_id,operation_id,session_id,action,applied_revision,created_at,receipt_ciphertext)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[record.ownerId,org,cmd.operationId,record.id,cmd.action,record.revision,at,this.seal('mentor_intent_operation',cmd.operationId,record.ownerId,record.revision,receipt)]);
      const result=await c.query(`UPDATE platform_mentor_sessions SET status=$3,scheduled_at=$4,revision=$5,last_operation_id=$6,updated_at=$7,payload_ciphertext=$8
        WHERE id=$1 AND user_id=$2 AND revision=$9`,[record.id,record.ownerId,record.status,record.assignment!.startsAt,record.revision,cmd.operationId,at,
        this.seal('mentor_intent',record.id,record.ownerId,record.revision,record),current.revision]);
      if(result.rowCount!==1)throw changed();await this.store.authorizeAccount(c,record.ownerId,accepted.authVersion,signal);
      if(cmd.action==='schedule'&&record.assignment!.startsAt<=await this.at(c))throw new ApiError(409,'MENTOR_SCHEDULING_TIME_INVALID','这个时段已开始，请重新确认。');
      signal?.throwIfAborted();return {value:Object.freeze({sessionId:record.id,status:record.status,revision:record.revision,appliedRevision:record.revision,replayed:false}),recordCount:1};
    },signal);
  }
  /** Caller-owned audited finance transaction; actual owner lock, not a minted owner login. */
  async financeInTransaction(c:PoolClient,actor:FixedSessionContext,org:string,id:string,signal?:AbortSignal){
    await authorizeMentorStaffSource(c,actor,org,signal);
    if(this.organizationId!==org)throw new ApiError(503,'MENTOR_PAYMENT_UNAVAILABLE','真人账务记录尚未配置。');
    const target=(await c.query<SessionRow>('SELECT * FROM platform_mentor_sessions WHERE org_id=$1 AND id=$2',[org,id])).rows[0];if(!target)throw missing();
    const authVersion=await this.store.authorizeAccount(c,target.user_id,undefined,signal);
    const row=(await c.query<SessionRow>('SELECT * FROM platform_mentor_sessions WHERE org_id=$1 AND id=$2 AND user_id=$3 FOR UPDATE',[org,id,target.user_id])).rows[0];if(!row)throw missing();
    const record=await this.decode(c,row);if(!record.orderId||!record.assignment)throw new ApiError(409,'MENTOR_PAYMENT_UNAVAILABLE','请先完成真实导师匹配和报价。');
    const original=(await c.query<OperationRow>("SELECT * FROM platform_mentor_intent_operations WHERE user_id=$1 AND session_id=$2 AND action='match' FOR SHARE",[record.ownerId,record.id])).rows[0];
    const match=this.receipt(original);return Object.freeze({record,authVersion,capacity:match.acceptedCapacity!,quoteOperationId:match.operationId});
  }
  async ownedInTransaction(c:PoolClient,session:FixedSessionContext,id:string,signal?:AbortSignal){
    const context=fixed(session);await this.store.authorizeSession(c,context,signal);
    const record=await this.read(c,context.userId,careerRecordId(id));
    await this.store.authorizeSession(c,context,signal);return record;
  }
  async revalidateFinanceOwner(c:PoolClient,owner:string,version:string,signal?:AbortSignal){await this.store.authorizeAccount(c,owner,version,signal);}
  async getOrder(session:FixedSessionContext,id:string,signal?:AbortSignal){
    const context=fixed(session),key=careerRecordId(id);return this.db.withBoundedTransaction(async c=>{
      await this.store.authorizeSession(c,context,signal);const record=await this.read(c,context.userId,key);if(!record.orderId)throw missing();
      const order=await this.orders.readInTransaction(c,context.userId,record.orderId);
      await this.store.authorizeSession(c,context,signal);signal?.throwIfAborted();return Object.freeze({session:record,order});
    });
  }
  async opsOrders(session:FixedSessionContext,organizationId:string,input:unknown={},signal?:AbortSignal){
    const context=fixed(session),org=careerRecordId(organizationId),after=this.after(input);
    return this.staff.readWithAccess(context,org,{roles:['ops','org_admin'],action:'mentor_orders_viewed'},async c=>{
      const anchor=after?(await c.query<SessionRow>('SELECT * FROM platform_mentor_sessions WHERE org_id=$1 AND id=$2 AND order_id IS NOT NULL FOR SHARE',[org,after])).rows[0]:null;
      if(after&&!anchor)throw missing();if(anchor)await this.decode(c,anchor);
      const rows=(await c.query<SessionRow>(`SELECT * FROM platform_mentor_sessions WHERE org_id=$1 AND order_id IS NOT NULL
        AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51 FOR SHARE`,[org,anchor?.created_at??null,anchor?.id??null])).rows;
      const orders=[];for(const row of rows.slice(0,50)){
        signal?.throwIfAborted();const r=await this.decode(c,row),o=await this.orders.readInTransaction(c,r.ownerId,r.orderId!);
        orders.push(Object.freeze({id:o.id,sessionId:o.sessionId,status:o.status,priceCents:o.priceCents,currency:o.currency,createdAt:o.createdAt,updatedAt:o.updatedAt}));
      }
      signal?.throwIfAborted();return {value:Object.freeze({orders:Object.freeze(orders),nextCursor:rows.length>50?orders.at(-1)!.sessionId:null}),recordCount:orders.length};
    },signal);
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
