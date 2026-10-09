import type {PoolClient} from 'pg';
import {careerRecordId as id,type MentorIntent,type MentorOrder} from '@companion/platform-contracts';
import type {PlatformConfig} from './config.ts';
import {MentorOrders} from './mentor-orders.ts';
import {MentorSlotReservations} from './mentor-slot-reservations.ts';
import {MentorFinancialLedger} from './mentor-financial-ledger.ts';
import {ApiError} from './errors.ts';

export const MENTOR_LEDGER_EXPORT_TABLES=Object.freeze(['platform_mentor_orders','platform_mentor_order_proofs','platform_mentor_slot_reservations',
 'platform_mentor_reservation_proofs','platform_mentor_financial_records','platform_mentor_financial_proofs'] as const);
export type MentorLedgerExportSection='mentorOrders'|'mentorOrderOperations'|'mentorSlotReservations'|'mentorReservationOperations'|'mentorFinancialRecords'|'mentorFinancialOperations';
const unavailable=()=>new ApiError(503,'ACCOUNT_MENTOR_EXPORT_UNAVAILABLE','The saved mentor service history could not be confirmed.');
function orderRecord(r:MentorOrder){
 return {id:r.id,sessionId:r.sessionId,ownerId:r.ownerId,organizationId:r.organizationId,offerId:r.offerId,offerRevision:r.offerRevision,
  priceCents:r.priceCents,currency:r.currency,status:r.status,paymentRef:r.paymentRef,payment:r.payment??null,origin:r.origin,suggestionId:r.suggestionId,
  shownOffer:r.shownOffer,revision:r.revision,lastOperationId:r.lastOperationId,createdAt:r.createdAt,updatedAt:r.updatedAt};
}
/** Invoked only inside the authorized account snapshot, with sessions verified by
 * MentorIntentHistory. Every owner row is enumerated, including orphan proofs;
 * retained finance is scoped through the surviving owner order, never by a code. */
export class AccountMentorLedgerExport {
 private readonly orders:MentorOrders;private readonly reservations:MentorSlotReservations;private readonly financial:MentorFinancialLedger;
 constructor(config:Pick<PlatformConfig,'dataCrypto'>){this.orders=new MentorOrders(config);this.reservations=new MentorSlotReservations(config);this.financial=new MentorFinancialLedger(config);}
 async *exportInTransaction(c:PoolClient,owner:string,sessions:ReadonlyMap<string,MentorIntent>,signal?:AbortSignal):AsyncGenerator<{section:MentorLedgerExportSection;record:unknown}>{
  const orders=new Map<string,Awaited<ReturnType<MentorOrders['readHistoryInTransaction']>>>();let after:string|null=null;
  for(;;){
   signal?.throwIfAborted();const rows:{id:string;user_id:string;session_id:string;org_id:string;revision:number}[]=(await c.query<{id:string;user_id:string;session_id:string;org_id:string;revision:number}>('SELECT id,user_id,session_id,org_id,revision FROM platform_mentor_orders WHERE user_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 100',[owner,after])).rows;
   for(const row of rows){signal?.throwIfAborted();const parent=sessions.get(row.session_id);
    if(row.user_id!==owner||!parent||parent.orderId!==row.id||parent.organizationId!==row.org_id||orders.has(row.id))throw unavailable();
    const history=await this.orders.readHistoryInTransaction(c,owner,id(row.id)),r=history.order;
    if(r.ownerId!==owner||r.sessionId!==parent.id||r.organizationId!==row.org_id||r.revision!==row.revision)throw unavailable();
    orders.set(r.id,history);yield {section:'mentorOrders',record:orderRecord(r)};
    for(const op of history.operations){signal?.throwIfAborted();const cmd=op.command;
     yield {section:'mentorOrderOperations',record:{orderId:op.orderId,sessionId:op.sessionId,ownerId:op.ownerId,organizationId:op.organizationId,
      revision:op.revision,operationId:op.operationId,createdAt:op.createdAt,action:op.action,
      command:cmd?{action:cmd.action,operationId:cmd.operationId,sessionId:cmd.sessionId,expectedRevision:cmd.expectedRevision,amountCents:cmd.amountCents,
       externalRef:cmd.externalRef,occurredAt:cmd.occurredAt}:null}};
    }
   }
   if(rows.length<100)break;after=id(rows.at(-1)!.id);
  }
  if([...sessions.values()].filter(s=>s.orderId!==null).length!==orders.size)throw unavailable();
  // Enumerate proofs by their own owner, so a foreign or missing parent cannot
  // silently disappear behind a join to the records above.
  let proofAfter:readonly[string,number]|null=null,proofCount=0;
  for(;;){
   signal?.throwIfAborted();const rows:{order_id:string;user_id:string;org_id:string;revision:number;operation_id:string;created_at:Date;action:string|null}[]=(await c.query<{order_id:string;user_id:string;org_id:string;revision:number;operation_id:string;created_at:Date;action:string|null}>(`SELECT order_id,user_id,org_id,revision,operation_id,created_at,action FROM platform_mentor_order_proofs
    WHERE user_id=$1 AND ($2::uuid IS NULL OR (order_id,revision)>($2::uuid,$3::integer)) ORDER BY order_id,revision LIMIT 100`,[owner,proofAfter?.[0]??null,proofAfter?.[1]??null])).rows;
   for(const row of rows){signal?.throwIfAborted();const op=orders.get(row.order_id)?.operations[row.revision-1];
    if(!op||row.user_id!==owner||row.org_id!==op.organizationId||row.operation_id!==op.operationId||row.created_at.toISOString()!==op.createdAt||
     (row.action??(row.revision===1?'quote':'void'))!==op.action)throw unavailable();proofCount++;
   }
   if(rows.length<100)break;proofAfter=[id(rows.at(-1)!.order_id),rows.at(-1)!.revision];
  }
  if(proofCount!==[...orders.values()].reduce((n,h)=>n+h.operations.length,0))throw unavailable();
  const reservations=new Map<string,Awaited<ReturnType<MentorSlotReservations['readHistoryInTransaction']>>>();after=null;
  for(;;){
   signal?.throwIfAborted();const rows:{session_id:string;user_id:string;org_id:string;revision:number}[]=(await c.query<{session_id:string;user_id:string;org_id:string;revision:number}>(`SELECT session_id,user_id,org_id,revision FROM platform_mentor_slot_reservations
    WHERE user_id=$1 AND ($2::uuid IS NULL OR session_id>$2) ORDER BY session_id LIMIT 100`,[owner,after])).rows;
   for(const row of rows){signal?.throwIfAborted();const parent=sessions.get(row.session_id),order=parent?.orderId?orders.get(parent.orderId):undefined;
    if(row.user_id!==owner||!parent||!order||parent.organizationId!==row.org_id||reservations.has(row.session_id))throw unavailable();
    const history=await this.reservations.readHistoryInTransaction(c,owner,id(row.session_id)),r=history.reservation,first=history.operations[0],last=history.operations.at(-1)!;
    if(r.ownerId!==owner||r.orgId!==row.org_id||r.revision!==row.revision||first.operationId!==order.operations[0].operationId||first.createdAt!==parent.assignment?.matchedAt||
     r.status==='released'&&(parent.status!=='cancelled'||last.operationId!==parent.lastOperationId||last.createdAt!==parent.updatedAt))throw unavailable();
    reservations.set(r.sessionId,history);
    yield {section:'mentorSlotReservations',record:{sessionId:r.sessionId,ownerId:r.ownerId,organizationId:r.orgId,startsAt:r.startsAt,endsAt:r.endsAt,
     status:r.status,revision:r.revision,lastOperationId:r.lastOperationId,updatedAt:r.updatedAt}};
    for(const op of history.operations)yield {section:'mentorReservationOperations',record:op};
   }
   if(rows.length<100)break;after=id(rows.at(-1)!.session_id);
  }
  if(reservations.size!==orders.size)throw unavailable();
  proofAfter=null;proofCount=0;
  for(;;){
   signal?.throwIfAborted();const rows:{session_id:string;user_id:string;org_id:string;revision:number;operation_id:string;created_at:Date}[]=(await c.query<{session_id:string;user_id:string;org_id:string;revision:number;operation_id:string;created_at:Date}>(`SELECT session_id,user_id,org_id,revision,operation_id,created_at FROM platform_mentor_reservation_proofs
    WHERE user_id=$1 AND ($2::uuid IS NULL OR (session_id,revision)>($2::uuid,$3::integer)) ORDER BY session_id,revision LIMIT 100`,[owner,proofAfter?.[0]??null,proofAfter?.[1]??null])).rows;
   for(const row of rows){signal?.throwIfAborted();const op=reservations.get(row.session_id)?.operations[row.revision-1];
    if(!op||row.user_id!==owner||row.org_id!==op.organizationId||row.operation_id!==op.operationId||row.created_at.toISOString()!==op.createdAt)throw unavailable();proofCount++;
   }
   if(rows.length<100)break;proofAfter=[id(rows.at(-1)!.session_id),rows.at(-1)!.revision];
  }
  if(proofCount!==[...reservations.values()].reduce((n,h)=>n+h.operations.length,0))throw unavailable();
  const finances=new Map<string,Awaited<ReturnType<MentorFinancialLedger['historyInTransaction']>>>();after=null;
  for(;;){
   signal?.throwIfAborted();const rows:{id:string;revision:number}[]=(await c.query<{id:string;revision:number}>(`SELECT f.id,f.revision FROM platform_mentor_financial_records f JOIN platform_mentor_orders o ON o.id=f.id
    WHERE o.user_id=$1 AND ($2::uuid IS NULL OR f.id>$2) ORDER BY f.id LIMIT 100`,[owner,after])).rows;
   for(const row of rows){signal?.throwIfAborted();const order=orders.get(row.id);
    if(!order?.order.payment||finances.has(row.id))throw unavailable();
    const history=await this.financial.historyInTransaction(c,order.order,order.operations.flatMap(op=>op.command?[op.command]:[]));
    if(history.record.revision!==row.revision)throw unavailable();finances.set(row.id,history);
    yield {section:'mentorFinancialRecords',record:history.record};
    for(const op of history.operations){signal?.throwIfAborted();yield {section:'mentorFinancialOperations',record:op};}
   }
   if(rows.length<100)break;after=id(rows.at(-1)!.id);
  }
  if(finances.size!==[...orders.values()].filter(h=>h.order.payment).length)throw unavailable();
  proofAfter=null;proofCount=0;
  for(;;){
   signal?.throwIfAborted();const rows:{record_id:string;revision:number;action:string}[]=(await c.query<{record_id:string;revision:number;action:string}>(`SELECT f.record_id,f.revision,f.action FROM platform_mentor_financial_proofs f JOIN platform_mentor_orders o ON o.id=f.record_id
    WHERE o.user_id=$1 AND ($2::uuid IS NULL OR (f.record_id,f.revision)>($2::uuid,$3::integer)) ORDER BY f.record_id,f.revision LIMIT 100`,[owner,proofAfter?.[0]??null,proofAfter?.[1]??null])).rows;
   for(const row of rows){signal?.throwIfAborted();const op=finances.get(row.record_id)?.operations[row.revision-1];if(!op||row.action!==op.action)throw unavailable();proofCount++;}
   if(rows.length<100)break;proofAfter=[id(rows.at(-1)!.record_id),rows.at(-1)!.revision];
  }
  if(proofCount!==[...finances.values()].reduce((n,h)=>n+h.operations.length,0))throw unavailable();
  signal?.throwIfAborted();
 }
}
