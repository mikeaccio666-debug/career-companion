import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {careerRecordId,parseProductEvent,type ProductEvent} from '@companion/platform-contracts';
import type {PlatformConfig} from './config.ts';
import type {Database} from './database.ts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import {ApiError} from './errors.ts';

/** Call only inside the authenticated source mutation transaction, after a new
 * operation is accepted. Replays do not call this writer or backfill old data. */
export class ProductEvents {
 private readonly enabled:boolean;
 constructor(config:Pick<PlatformConfig,'productEventsEnabled'>){this.enabled=config.productEventsEnabled===true;}
 async record(c:PoolClient,owner:string,operation:string,input:ProductEvent):Promise<void>{
  if(!this.enabled)return;
  const userId=careerRecordId(owner),operationId=careerRecordId(operation),value=parseProductEvent(input);
  const hex=createHash('sha256').update(JSON.stringify(['product-event-v1',userId,operationId,value.event])).digest('hex');
  const id=hex.slice(0,8)+'-'+hex.slice(8,12)+'-8'+hex.slice(13,16)+'-a'+hex.slice(17,20)+'-'+hex.slice(20,32);
  // A conflict is a bug or inconsistent transaction, not permission to silently
  // substitute another payload. Domain receipts handle legitimate retries.
  await c.query("INSERT INTO platform_product_events(id,user_id,event,props,channel) VALUES($1,$2,$3,$4,'web')",[id,userId,value.event,value.props]);
 }
}
export async function* exportProductEvents(c:PoolClient,value:FixedSessionContext,signal?:AbortSignal){
 const s=Object.freeze({userId:careerRecordId(value.userId),tokenHash:value.tokenHash});await authorizeFixedSession(c,s,signal);
 let after:string|null=null;
 for(;;){
  signal?.throwIfAborted();
  const rows=(await c.query('SELECT id,user_id,event,props,channel,occurred_at FROM platform_product_events WHERE user_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 100',[s.userId,after])).rows;
  for(const row of rows){
   try {
    if(row.user_id!==s.userId||row.channel!=='web'||!(row.occurred_at instanceof Date)||!Number.isFinite(row.occurred_at.valueOf()))throw Error();
    const event=parseProductEvent({event:row.event,props:row.props});
    yield Object.freeze({id:careerRecordId(row.id),...event,channel:'web' as const,occurredAt:row.occurred_at.toISOString()});
   }catch{throw new ApiError(503,'PRODUCT_EVENT_EXPORT_UNAVAILABLE','The saved product activity could not be confirmed.');}
  }
  if(rows.length<100)break;after=careerRecordId(rows.at(-1).id);
 }
 await authorizeFixedSession(c,s,signal);signal?.throwIfAborted();
}
/** Keep thirteen UTC calendar months. Runs even after new collection is disabled. */
export async function purgeExpiredProductEvents(db:Database,limit=100):Promise<number>{
 if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid product retention batch.');
 return db.withBoundedTransaction(async c=>{
  const result=await c.query(`DELETE FROM platform_product_events WHERE id IN (
   SELECT id FROM platform_product_events WHERE occurred_at < ((clock_timestamp() AT TIME ZONE 'UTC' - interval '13 months') AT TIME ZONE 'UTC')
   ORDER BY occurred_at,id LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING id`,[limit]);
  return result.rowCount??0;
 });
}
