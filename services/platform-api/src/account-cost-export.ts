import type {PoolClient} from 'pg';
import {careerRecordId as id,careerRecordObject as object} from '@companion/platform-contracts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import {ApiError} from './errors.ts';

export const COST_EXPORT_TABLES=Object.freeze(['platform_cost_user_policy','platform_cost_reservations','platform_cost_ledger'] as const);
export type CostExportSection='costPolicies'|'costReservations'|'costLedger';
type Row=Record<string,any>;
const unavailable=()=>new ApiError(503,'ACCOUNT_COST_EXPORT_UNAVAILABLE','The saved account cost records could not be confirmed.');
function at(value:unknown,nullable=false):string|null{if(value===null&&nullable)return null;if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw unavailable();return value.toISOString();}
function count(value:unknown,min=0,max=2147483647):number{if(!Number.isSafeInteger(value)||Object.is(value,-0)||(value as number)<min||(value as number)>max)throw unavailable();return value as number;}
function money(value:unknown):string{if(typeof value!=='string'||!/^(0|[1-9][0-9]*)$/.test(value))throw unavailable();return value;}
function price(priceId:unknown,rate:unknown){if(typeof rate!=='string'||!/^[0-9]+(?:\.[0-9]+)?$/.test(rate)||BigInt(rate.replace('.',''))<=0n)throw unavailable();return {priceId:id(priceId),microsPerUnit:rate};}
function oneOf(value:unknown,values:readonly string[]):string{if(typeof value!=='string'||!values.includes(value))throw unavailable();return value;}
function text(value:unknown,max:number):string{if(typeof value!=='string'||value.length<1||value.length>max)throw unavailable();return value;}
function source(row:Row){
 if(!(row.capability==='chat'&&row.source_kind==='chat_call'||row.capability==='background'&&row.source_kind==='job'))throw unavailable();
 return {sourceKind:row.source_kind,sourceId:id(row.source_id),capability:row.capability,purpose:text(row.purpose,80),provider:text(row.provider,80),model:text(row.model,150)};
}
function pricing(row:Row){
 if(![1,2].includes(row.pricing_revision))throw unavailable();
 const cached=[row.cached_input_price_id,row.cache_write_input_price_id,row.cached_input_micros_per_unit,row.cache_write_input_micros_per_unit];
 if(row.pricing_revision===1&&cached.some(value=>value!==null))throw unavailable();
 return {revision:row.pricing_revision,input:price(row.input_price_id,row.input_micros_per_unit),output:price(row.output_price_id,row.output_micros_per_unit),
  cachedInput:row.pricing_revision===1?null:price(row.cached_input_price_id,row.cached_input_micros_per_unit),
  cacheWriteInput:row.pricing_revision===1?null:price(row.cache_write_input_price_id,row.cache_write_input_micros_per_unit)};
}
function units(row:Row){
 const known=row.usage_status==='reported',saved=known?object(row.units,['inputTokens','outputTokens'],['cachedInputTokens','cacheWriteInputTokens']):object(row.units,['maxInputTokens','maxOutputTokens']);
 for(const value of Object.values(saved))count(value);
 if(known&&(Number(saved.cachedInputTokens??0)+Number(saved.cacheWriteInputTokens??0)>Number(saved.inputTokens)))throw unavailable();
 // Omitted cache counts remain omitted. They are not evidence of zero usage.
 return {...saved};
}
async function* rows(client:PoolClient,owner:string,table:typeof COST_EXPORT_TABLES[number],signal?:AbortSignal){
 const key=table==='platform_cost_user_policy'?'user_id':table==='platform_cost_ledger'?'reservation_id':'id';let after:string|null=null;
 for(;;){signal?.throwIfAborted();const found:Row[]=(await client.query(`SELECT * FROM ${table} WHERE user_id=$1 AND ($2::uuid IS NULL OR ${key}>$2) ORDER BY ${key} LIMIT 100`,[owner,after])).rows;
  for(const row of found){signal?.throwIfAborted();if(row.user_id!==owner)throw unavailable();yield row;}
  if(found.length<100)break;after=id(found.at(-1)![key]);
 }
}
/** Historical money projection only. Never calls CostGuard: even its reserve
 * path may settle expired dispatch risk, which an archive must not mutate. */
export async function* exportCostsInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal):AsyncGenerator<{section:CostExportSection;record:unknown}>{
 const session=object(value,['userId','tokenHash']),who=Object.freeze({userId:id(session.userId),tokenHash:session.tokenHash as string});
 if(typeof who.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(who.tokenHash))throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');
 await authorizeFixedSession(client,who,signal);
 try{
  for await(const row of rows(client,who.userId,'platform_cost_user_policy',signal)){
   const soft=money(row.soft_micros),hard=money(row.hard_micros),day=row.day_micros===null?null:money(row.day_micros);
   if(BigInt(soft)<=0n||BigInt(hard)<BigInt(soft)||day!==null&&BigInt(day)<=0n)throw unavailable();
   yield {section:'costPolicies',record:{ownerId:who.userId,policyKey:text(row.policy_key,80),period:oneOf(row.period,['week','month']),
    softBehavior:oneOf(row.soft_behavior,['notify','degrade']),softMicros:soft,hardMicros:hard,dayMicros:day,
    approvedAt:at(row.approved_at),effectiveFrom:at(row.effective_from),effectiveTo:at(row.effective_to,true)}};
  }
  const reservations=new Map<string,Row>();
  for await(const row of rows(client,who.userId,'platform_cost_reservations',signal)){
   const key=id(row.id),status=oneOf(row.status,['reserved','admitted','committed','released']);
   const admitted=at(row.admitted_at,true),finished=at(row.finished_at,true),dispatch=at(row.dispatch_intent_at,true);
   if(status==='reserved'&&(admitted!==null||finished!==null)||status==='admitted'&&(admitted===null||finished!==null)
    ||status==='committed'&&(admitted===null||finished===null)||status==='released'&&(admitted!==null||finished===null||dispatch!==null))throw unavailable();
   reservations.set(key,row);
   yield {section:'costReservations',record:{id:key,ownerId:who.userId,...source(row),pricing:pricing(row),
    maxInputTokens:count(row.max_input_tokens),maxOutputTokens:count(row.max_output_tokens),estimateMicros:money(row.estimate_micros),
    ttlSeconds:count(row.ttl_seconds,1,3600),status,expiresAt:at(row.expires_at),admittedAt:admitted,finishedAt:finished,
    dispatchIntentAt:dispatch,createdAt:at(row.created_at)}};
  }
  const settled=new Set<string>();
  for await(const row of rows(client,who.userId,'platform_cost_ledger',signal)){
   const key=id(row.reservation_id),reservation=reservations.get(key);
   if(!reservation||reservation.status!=='committed'||settled.has(key)||['user_id','capability','source_kind','source_id','provider','model','purpose'].some(k=>row[k]!==reservation[k]))throw unavailable();
   oneOf(row.usage_status,['reported','missing','invalid','expired','dispatch_uncertain']);
   if(typeof row.estimated!=='boolean'||row.usage_status!=='reported'&&!row.estimated)throw unavailable();
   const measured=units(row);
   if(row.usage_status!=='reported'&&(measured.maxInputTokens!==reservation.max_input_tokens||measured.maxOutputTokens!==reservation.max_output_tokens
    ||row.cost_micros!==reservation.estimate_micros))throw unavailable();
   settled.add(key);
   yield {section:'costLedger',record:{reservationId:key,ownerId:who.userId,...source(row),units:measured,costMicros:money(row.cost_micros),
    estimated:row.estimated,usageStatus:row.usage_status,createdAt:at(row.created_at),settledAt:at(row.settled_at)}};
  }
  for(const [key,row] of reservations)if(row.status==='committed'&&!settled.has(key))throw unavailable();
 }catch(error){signal?.throwIfAborted();throw unavailable();}
 await authorizeFixedSession(client,who,signal);signal?.throwIfAborted();
}
