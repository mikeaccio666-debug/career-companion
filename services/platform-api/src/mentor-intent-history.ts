import type {PoolClient} from 'pg';
import {careerRecordId,careerRecordObject,parseMentorIntentCommand,parseMentorIntent,parseMentorServiceOffer,
 mentorServiceInteger,parseMentorMatchCommand,parseMentorSchedulingCommand,type MentorIntent,type MentorServiceOffer} from '@companion/platform-contracts';
import type {PlatformConfig} from './config.ts';
import {parseMentorReceiptEvidence,type MentorReceiptEvidence} from './mentor-receipt-evidence.ts';
import {parseConfirmedMentorCapacity,type ConfirmedMentorCapacity} from './mentor-confirmed-capacity.ts';
import {MentorOrders} from './mentor-orders.ts';
import {MentorSlotReservations} from './mentor-slot-reservations.ts';
import {MentorLedgerCrypto,mentorLedgerDigest as digest} from './mentor-ledger-crypto.ts';
import {ApiError} from './errors.ts';
const unavailable=()=>new ApiError(503,'MENTOR_INTENT_STORAGE_UNAVAILABLE','暂时无法确认预约意向，请重新读取。');
export interface SessionRow {
  id:string;user_id:string;org_id:string;offer_id:string;offer_revision:number;kind:string;duration_min:number;status:string;
  mentor_id:string|null;order_id:string|null;packet_id:string|null;scheduled_at:Date|null;review_id:string|null;
  revision:number;last_operation_id:string;created_at:Date;updated_at:Date;payload_ciphertext:Buffer;
}
export interface OperationRow {user_id:string;org_id:string;operation_id:string;session_id:string;action:'create'|'cancel'|'match'|'schedule'|'cancel_scheduled'|'complete';applied_revision:number;created_at:Date;receipt_ciphertext:Buffer;}
export interface Receipt {
  schemaVersion:1|2|3;ownerId:string;orgId:string;operationId:string;sessionId:string;action:'create'|'cancel'|'match'|'schedule'|'cancel_scheduled'|'complete';appliedRevision:number;
  command:unknown;commandDigest:string;recordDigest:string;acceptedAuthVersion:string;createdAt:string;acceptedOffer:MentorServiceOffer|null;actorId?:string;actorAuthVersion?:string;acceptedCapacity?:Readonly<ConfirmedMentorCapacity>;confirmationEvidence?:readonly Readonly<MentorReceiptEvidence>[];
}
/** Historical integrity only. No current terms, staff role, offer availability,
 * capacity selection, file reads or writes. Callers supply their own authorization. */
export class MentorIntentHistory {
 private readonly crypto:MentorLedgerCrypto;private readonly orders:MentorOrders;private readonly reservations:MentorSlotReservations;
 constructor(config:Pick<PlatformConfig,'dataCrypto'>){this.crypto=new MentorLedgerCrypto(config);this.orders=new MentorOrders(config);this.reservations=new MentorSlotReservations(config);}
 private open(table:string,id:string,owner:string,revision:number,cipher:Buffer){return this.crypto.open(table,id,owner,revision,cipher);}
  receipt(row:OperationRow):Receipt {
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
  async decode(c:PoolClient,row:SessionRow):Promise<MentorIntent> {
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
}
