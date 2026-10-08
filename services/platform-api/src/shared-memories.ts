import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { parseSharedMemoryRecord, parseSharedMemoryCommand, sharedMemoryId, type SharedMemoryRecord, type SharedMemoryCommand, type SharedMemoryCommandKind } from '@companion/platform-contracts';
import { selectCompanionContextMemories, type ContextMemory, type MemoryContextScope } from '@companion/career-core';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { Database } from './database.ts';
import type { PlatformConfig } from './config.ts';
import type { LegalBundle } from './legal-documents.ts';
import { OnboardingStorage } from './onboarding-storage.ts';
import { ApiError } from './errors.ts';
const unavailable=()=>new ApiError(503,'MEMORY_STORAGE_UNAVAILABLE','The saved memory could not be confirmed.');
const changed=()=>new ApiError(409,'MEMORY_REVISION_CHANGED','Read the current memory before changing it.');
const notFound=()=>new ApiError(404,'NOT_FOUND','The memory was not found.');
const bad=()=>new ApiError(400,'MEMORY_INPUT_INVALID','Use an explicit memory category and sensitivity.');
function fixed(value:FixedSessionContext):Readonly<FixedSessionContext> {
  try { const d=Object.getOwnPropertyDescriptors(value);
    if(!value||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Reflect.ownKeys(d).length!==2||!d.userId||!d.tokenHash
      ||Object.values(d).some(x=>!('value' in x)||!x.enumerable)||typeof d.tokenHash.value!=='string'||/^[0-9a-f]{64}$/.exec(d.tokenHash.value)?.[0]!==d.tokenHash.value)throw bad();
    return Object.freeze({userId:sharedMemoryId(d.userId.value),tokenHash:d.tokenHash.value});
  }catch{throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');}
}
function page(value:unknown,ownerId:string):{limit:number;after:readonly [string,string]|null} {
  try { if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw bad();
    const d=Object.getOwnPropertyDescriptors(value);
    if(Reflect.ownKeys(d).some(k=>typeof k!=='string'||!['cursor','limit'].includes(k))||Object.values(d).some(x=>!('value' in x)||!x.enumerable))throw bad();
    const limit=d.limit?.value===undefined?50:Number(d.limit.value);
    if(!Number.isSafeInteger(limit)||limit<1||limit>100||Object.is(limit,-0))throw bad();
    let after:readonly [string,string]|null=null;
    if(d.cursor){const token=d.cursor.value;if(typeof token!=='string'||token.length>240||!/^[A-Za-z0-9_-]+$/.test(token))throw bad();
      const raw=Buffer.from(token,'base64url').toString('utf8'),r=JSON.parse(raw);
      if(!Array.isArray(r)||r.length!==3||canonical(r)!==raw||Buffer.from(raw).toString('base64url')!==token||r[0]!==ownerId||typeof r[1]!=='string'
        ||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(r[1])||new Date(r[1]).toISOString()!==r[1].slice(0,23)+'Z')throw bad();
      after=[r[1],sharedMemoryId(r[2])];
    }return {limit,after};
  }catch{throw bad();}
}
const iso=(x:Date|null):string|null=>x===null?null:x.toISOString();
function canonical(x:any):string { return JSON.stringify(x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v); }
const digest=(x:unknown)=>createHash('sha256').update(canonical(x)).digest('hex');
interface Snapshot { schemaVersion:1; state:Readonly<SharedMemoryRecord>; undoPrevious:Readonly<SharedMemoryRecord>|null; }
interface Receipt { schemaVersion:1; ownerId:string; operationId:string; memoryId:string; action:SharedMemoryCommandKind; commandDigest:string; appliedRevision:number; acceptedAuthVersion:string; createdAt:string; }
/** Owner actions only. Expert proposals and actual turn use receipts require their
 * own authenticated turn adapters; neither HTTP callers nor this service invent them. */
export class SharedMemories {
  private readonly storage:OnboardingStorage;
  constructor(private readonly db:Database,config:Pick<PlatformConfig,'dataCrypto'|'requireVerifiedEmail'>,legal:LegalBundle|null){this.storage=new OnboardingStorage(config,legal);}
  private async authorize(client:PoolClient,s:FixedSessionContext,signal?:AbortSignal) {
    await authorizeFixedSession(client,s,signal);
    const user=(await client.query('SELECT account_kind FROM platform_users WHERE id=$1 FOR NO KEY UPDATE',[s.userId])).rows[0];
    if(user?.account_kind!=='student')throw new ApiError(403,'STUDENT_ACCOUNT_REQUIRED','Use a student account.');
    signal?.throwIfAborted();
  }
  private async time(client:PoolClient) { return (await client.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString() as string; }
  private async row(client:PoolClient,s:FixedSessionContext,id:string) { return (await client.query('SELECT * FROM platform_memories WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,s.userId])).rows[0]; }
  private binding(row:any) { return {table:'platform_memories',column:'record_ciphertext',rowId:row.id,ownerId:row.user_id,revision:row.record_revision}; }
  private async receipt(client:PoolClient,s:FixedSessionContext,row:any):Promise<Receipt> {
    try {
      const text=this.storage.crypto!.openUtf8(row.receipt_ciphertext,{table:'platform_memory_operations',column:'receipt_ciphertext',rowId:row.operation_id,ownerId:s.userId,revision:row.applied_revision});
      const r=JSON.parse(text);
      if(Object.keys(r).sort().join(',')!=='acceptedAuthVersion,action,appliedRevision,commandDigest,createdAt,memoryId,operationId,ownerId,schemaVersion'
        ||canonical(r)!==text||r.schemaVersion!==1||r.ownerId!==s.userId||r.operationId!==row.operation_id||r.memoryId!==row.memory_id
        ||r.action!==row.action||r.appliedRevision!==row.applied_revision||r.createdAt!==iso(row.created_at)
        ||typeof r.acceptedAuthVersion!=='string'||!/^(0|[1-9][0-9]*)$/.test(r.acceptedAuthVersion)
        ||typeof r.commandDigest!=='string'||!/^[0-9a-f]{64}$/.test(r.commandDigest))throw unavailable();
      return Object.freeze(r);
    }catch{throw unavailable();}
  }
  private async decode(client:PoolClient,s:FixedSessionContext,row:any):Promise<Snapshot> {
    try {
      if(row.user_id!==s.userId)throw unavailable();
      if(row.record_revision===0) {
        if(row.record_ciphertext!==null||row.category!==null||row.sensitivity!==null||row.status!==null||row.source!==null||row.confidence!==null
          ||row.use_policy!==null||row.speaker_scope!==null||row.confirmed_at!==null||row.updated_at!==null||row.deleted_at!==null||row.last_operation_id!==null)throw unavailable();
        return {schemaVersion:1,state:parseSharedMemoryRecord({id:row.id,ownerId:s.userId,revision:0,kind:'needs_review',content:row.content,
          category:null,sensitivity:null,source:null,status:null,confidence:null,usePolicy:null,speakerScope:null,quote:null,originConversationId:null,originMessageId:null,
          confirmedAt:null,validUntil:null,reviewDueAt:null,createdAt:iso(row.created_at),updatedAt:iso(row.created_at),deletedAt:null,undoUntil:null,deletionOperationId:null,lastOperationId:null}),undoPrevious:null};
      }
      const text=this.storage.crypto!.openUtf8(row.record_ciphertext,this.binding(row)), raw=JSON.parse(text);
      if(Object.keys(raw).sort().join(',')!=='schemaVersion,state,undoPrevious'||raw.schemaVersion!==1)throw unavailable();
      const state=parseSharedMemoryRecord(raw.state), undoPrevious=raw.undoPrevious===null?null:parseSharedMemoryRecord(raw.undoPrevious);
      const snapshot={schemaVersion:1 as const,state,undoPrevious};
      if(canonical(snapshot)!==text||state.id!==row.id||state.ownerId!==s.userId||state.revision!==row.record_revision||row.content!==''
        ||state.category!==row.category||state.sensitivity!==row.sensitivity||state.source!==row.source||state.status!==row.status||state.confidence!==row.confidence
        ||state.usePolicy!==row.use_policy||state.speakerScope!==row.speaker_scope||state.validUntil!==iso(row.valid_until)||state.reviewDueAt!==iso(row.review_due_at)
        ||state.confirmedAt!==iso(row.confirmed_at)||state.createdAt!==iso(row.created_at)||state.updatedAt!==iso(row.updated_at)
        ||state.deletedAt!==iso(row.deleted_at)||state.undoUntil!==iso(row.undo_until)||state.deletionOperationId!==row.deletion_operation_id||state.lastOperationId!==row.last_operation_id
        ||(state.deletedAt===null)!==(undoPrevious===null))throw unavailable();
      if(undoPrevious&&(undoPrevious.id!==state.id||undoPrevious.ownerId!==state.ownerId||undoPrevious.revision+1!==state.revision||undoPrevious.deletedAt!==null))throw unavailable();
      const latest=(await client.query('SELECT max(applied_revision) AS revision FROM platform_memory_operations WHERE user_id=$1 AND memory_id=$2',[s.userId,state.id])).rows[0];
      if(latest.revision!==state.revision)throw unavailable();
      const op=(await client.query('SELECT * FROM platform_memory_operations WHERE operation_id=$1 AND user_id=$2 FOR SHARE',[state.lastOperationId,s.userId])).rows[0];
      if(!op)throw unavailable();
      const proof=await this.receipt(client,s,op);
      if(proof.memoryId!==state.id||proof.appliedRevision!==state.revision||proof.createdAt!==state.updatedAt)throw unavailable();
      return snapshot;
    }catch{throw unavailable();}
  }
  private async write(client:PoolClient,s:FixedSessionContext,record:SharedMemoryRecord,undoPrevious:SharedMemoryRecord|null) {
    const state=parseSharedMemoryRecord(record), row={id:state.id,user_id:s.userId,record_revision:state.revision};
    const sealed=this.storage.crypto!.sealUtf8(canonical({schemaVersion:1,state,undoPrevious}),this.binding(row));
    const values=[state.id,s.userId,state.revision,sealed,state.category,state.sensitivity,state.source,state.status,state.confidence,state.usePolicy,state.speakerScope,
      state.validUntil,state.reviewDueAt,state.confirmedAt,state.createdAt,state.updatedAt,state.deletedAt,state.undoUntil,state.deletionOperationId,state.lastOperationId];
    const saved=await client.query(`INSERT INTO platform_memories(id,user_id,content,record_revision,record_ciphertext,category,sensitivity,source,status,confidence,use_policy,speaker_scope,
      valid_until,review_due_at,confirmed_at,created_at,updated_at,deleted_at,undo_until,deletion_operation_id,last_operation_id)
      VALUES($1,$2,'',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      ON CONFLICT(id) DO UPDATE SET content='',record_revision=$3,record_ciphertext=$4,category=$5,sensitivity=$6,source=$7,status=$8,confidence=$9,use_policy=$10,
      speaker_scope=$11,valid_until=$12,review_due_at=$13,confirmed_at=$14,updated_at=$16,deleted_at=$17,undo_until=$18,deletion_operation_id=$19,last_operation_id=$20
      WHERE platform_memories.user_id=$2`,values);
    if(saved.rowCount!==1)throw unavailable();return state;
  }
  private async recordOperation(client:PoolClient,s:FixedSessionContext,r:Receipt,actions:readonly string[]) {
    const sealed=this.storage.crypto!.sealUtf8(canonical(r),{table:'platform_memory_operations',column:'receipt_ciphertext',rowId:r.operationId,ownerId:s.userId,revision:r.appliedRevision});
    await client.query('INSERT INTO platform_memory_operations(operation_id,user_id,memory_id,action,applied_revision,receipt_ciphertext,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [r.operationId,s.userId,r.memoryId,r.action,r.appliedRevision,sealed,r.createdAt]);
    for(const action of actions)await client.query("INSERT INTO platform_memory_events(id,user_id,memory_id,operation_id,action,actor,channel,revision,created_at) VALUES($1,$2,$3,$4,$5,'user','web',$6,$7)",[randomUUID(),s.userId,r.memoryId,r.operationId,action,r.appliedRevision,r.createdAt]);
  }
  async get(context:FixedSessionContext,value:unknown,signal?:AbortSignal) {
    let id:string;try{id=sharedMemoryId(value);}catch{throw bad();}
    const s=fixed(context);
    return this.db.withBoundedTransaction(async client=>{await this.authorize(client,s,signal);const row=await this.row(client,s,id);if(!row)throw notFound();const {state}=await this.decode(client,s,row);
      if(state.deletedAt!==null)throw notFound();await authorizeFixedSession(client,s,signal);return state;});
  }
  async list(context:FixedSessionContext,query:unknown={},signal?:AbortSignal) {
    const s=fixed(context),p=page(query,s.userId);
    return this.db.withBoundedTransaction(async client=>{await this.authorize(client,s,signal);
      const rows=(await client.query(`SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS page_timestamp
        FROM platform_memories WHERE user_id=$1 AND deleted_at IS NULL AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid))
        ORDER BY created_at DESC,id DESC LIMIT $4 FOR SHARE`,[s.userId,p.after?.[0]??null,p.after?.[1]??null,p.limit+1])).rows;
      const chosen=rows.slice(0,p.limit),memories=[];for(const row of chosen)memories.push((await this.decode(client,s,row)).state);
      const last=chosen.at(-1),nextCursor=rows.length>p.limit&&last?Buffer.from(canonical([s.userId,last.page_timestamp,last.id])).toString('base64url'):null;
      await authorizeFixedSession(client,s,signal);return Object.freeze({memories:Object.freeze(memories),hasMore:nextCursor!==null,nextCursor});});
  }
  async mutate(context:FixedSessionContext,kind:SharedMemoryCommandKind,memoryId:unknown,input:unknown,signal?:AbortSignal) {
    let command:Readonly<SharedMemoryCommand>,id:string|null;
    try { command=parseSharedMemoryCommand(kind,input);id=kind==='create'?null:sharedMemoryId(memoryId); }catch{throw bad();}
    const s=fixed(context), commandDigest=digest({ownerId:s.userId,kind,id,command});
    return this.db.withBoundedTransaction(async client=>{
      await this.authorize(client,s,signal);
      const existing=(await client.query('SELECT * FROM platform_memory_operations WHERE user_id=$1 AND operation_id=$2 FOR UPDATE',[s.userId,command.operationId])).rows[0];
      if(existing) {
        const receipt=await this.receipt(client,s,existing);
        if(receipt.commandDigest!==commandDigest||receipt.action!==kind||id!==null&&receipt.memoryId!==id)throw new ApiError(409,'MEMORY_OPERATION_CONFLICT','This operation already records a different change.');
        const row=await this.row(client,s,receipt.memoryId);if(!row)throw new ApiError(409,'MEMORY_REMOVED','The memory was removed; this old operation cannot recreate it.');
        const {state}=await this.decode(client,s,row);await authorizeFixedSession(client,s,signal);
        return Object.freeze({memory:state,operation:Object.freeze({id:command.operationId,appliedRevision:receipt.appliedRevision,replayed:true})});
      }
      if(kind!=='delete')await this.storage.authorizeSession(client,s,signal);
      if(!this.storage.crypto)throw unavailable();
      let snapshot:Snapshot|null=null;
      if(id!==null){const row=await this.row(client,s,id);if(!row)throw notFound();snapshot=await this.decode(client,s,row);}
      const previous=snapshot?.state;
      if(previous&&previous.revision!==command.expectedRevision)throw changed();
      if(previous&&previous.revision===2147483647)throw changed();
      if(previous?.deletedAt!==null&&previous!==undefined&&kind!=='undo')throw notFound();
      const auth=(await client.query('SELECT auth_version FROM platform_users WHERE id=$1',[s.userId])).rows[0];
      // All actual source/account locks have been acquired before this clock.
      const now=await this.time(client);
      const base:SharedMemoryRecord=previous??{id:randomUUID(),ownerId:s.userId,revision:0,kind:'needs_review',content:command.content!,category:null,sensitivity:null,source:null,status:null,confidence:null,usePolicy:null,speakerScope:null,
        quote:null,originConversationId:null,originMessageId:null,confirmedAt:null,validUntil:null,reviewDueAt:null,createdAt:now,updatedAt:now,deletedAt:null,undoUntil:null,deletionOperationId:null,lastOperationId:null};
      let next:SharedMemoryRecord,undoPrevious:SharedMemoryRecord|null=null, actions:string[];
      if(kind==='create'||kind==='confirm') {
        if(kind==='confirm'&&base.kind==='memory'&&base.status==='confirmed')throw changed();
        next={...base,kind:'memory',content:(kind==='create'?command.content:command.editedContent)??base.content,category:command.category!,sensitivity:command.sensitivity!,source:kind==='create'||base.kind==='needs_review'||command.editedContent!==undefined&&command.editedContent!==base.content?'user_saved':base.source,status:'confirmed',
          confidence:kind==='create'||base.kind==='needs_review'||command.editedContent!==undefined&&command.editedContent!==base.content||['user_saved','user_stated','imported'].includes(base.source??'')?'high':base.quote!==null?'high':'medium',
          usePolicy:command.usePolicy??base.usePolicy??'normal',speakerScope:command.speakerScope===undefined?base.speakerScope:command.speakerScope,validUntil:command.validUntil===undefined?base.validUntil:command.validUntil,confirmedAt:now,reviewDueAt:null};
        actions=['confirmed'];
      }else if(kind==='edit') {
        if(base.kind!=='memory')throw new ApiError(409,'MEMORY_REVIEW_REQUIRED','Review the old category and sensitivity before sharing it.');
        next={...base,...Object.fromEntries(['content','category','sensitivity','usePolicy','speakerScope','validUntil','status'].filter(k=>Object.hasOwn(command,k)).map(k=>[k,(command as any)[k]]))};
        if(command.content!==undefined&&command.content!==base.content)next={...next,source:'user_saved',confidence:'high',confirmedAt:now};
        else if(base.status!=='confirmed'&&command.status==='confirmed')next={...next,confirmedAt:now};
        actions=['edited'];if(next.sensitivity!==base.sensitivity)actions.push('sensitivity_changed');
      }else if(kind==='delete') {
        if(command.deleteOriginMessage&&base.originMessageId!==null)throw new ApiError(409,'MEMORY_ORIGIN_DELETE_UNAVAILABLE','Original-message deletion requires its message lifecycle adapter.');
        if(base.originMessageId!==null){const excluded=await client.query(`UPDATE platform_messages m SET excluded_from_context=true FROM platform_conversations c WHERE m.id=$1 AND m.conversation_id=$2 AND c.id=m.conversation_id AND c.user_id=$3 AND m.user_id=$3 RETURNING m.id`,[base.originMessageId,base.originConversationId,s.userId]);if(excluded.rowCount!==1)throw unavailable();}
        next={...base,deletedAt:now,undoUntil:new Date(Date.parse(now)+10000).toISOString(),deletionOperationId:command.operationId};undoPrevious=base;actions=['deleted'];
      }else {
        if(base.deletedAt===null||base.deletionOperationId!==command.deletionOperationId||base.undoUntil!<=now||!snapshot?.undoPrevious)throw new ApiError(409,'MEMORY_UNDO_EXPIRED','The memory undo window is no longer available.');
        next={...snapshot.undoPrevious,revision:base.revision,updatedAt:now};actions=['edited'];
      }
      next={...next,revision:base.revision+1,updatedAt:now,lastOperationId:command.operationId};
      let state:Readonly<SharedMemoryRecord>;try{state=parseSharedMemoryRecord(next);}catch{throw bad();}
      await this.recordOperation(client,s,{schemaVersion:1,ownerId:s.userId,operationId:command.operationId,memoryId:state.id,action:kind,commandDigest,
        appliedRevision:state.revision,acceptedAuthVersion:String(auth.auth_version),createdAt:now},actions);
      await this.write(client,s,state,undoPrevious);await authorizeFixedSession(client,s,signal);signal?.throwIfAborted();
      return Object.freeze({memory:state,operation:Object.freeze({id:command.operationId,appliedRevision:state.revision,replayed:false})});
    });
  }
  /** Trusted context caller supplies the genuine speaker/room and current L0;
   * this read returns selection references, never a persisted use or turn grant. */
  async selectInTransaction(client:PoolClient,context:FixedSessionContext,scope:MemoryContextScope,signal?:AbortSignal) {
    context=fixed(context);await this.authorize(client,context,signal);if(scope.ownerId!==context.userId)throw notFound();
    const rows=(await client.query('SELECT * FROM platform_memories WHERE user_id=$1 AND record_ciphertext IS NOT NULL AND deleted_at IS NULL ORDER BY id LIMIT 2001 FOR SHARE',[context.userId])).rows;
    if(rows.length>2000)throw new ApiError(409,'MEMORY_CONTEXT_CAPACITY','The memory context requires a bounded page.');
    const memories:ContextMemory[]=[];
    for(const row of rows){const {state}=await this.decode(client,context,row);if(state.kind!=='memory')continue;
      memories.push({id:state.id,ownerId:state.ownerId,revision:state.revision,category:state.category!,sensitivity:state.sensitivity!,status:state.status!,confidence:state.confidence!,
        usePolicy:state.usePolicy!,content:state.content,confirmedAt:state.confirmedAt,validUntil:state.validUntil,speakerScope:state.speakerScope,intentKeys:[]});}
    const result=selectCompanionContextMemories({scope:{...scope,now:await this.time(client)},memories});await authorizeFixedSession(client,context,signal);return result;
  }
  async uses(context:FixedSessionContext,value:unknown,signal?:AbortSignal) {
    const s=fixed(context);let id:string;try{id=sharedMemoryId(value);}catch{throw bad();}
    return this.db.withBoundedTransaction(async client=>{await this.authorize(client,s,signal);
      const row=await this.row(client,s,id);if(!row)throw notFound();const {state}=await this.decode(client,s,row);if(state.deletedAt!==null)throw notFound();
      const rows=(await client.query(`SELECT id,memory_revision,conversation_id,message_id,speaker,channel,purpose,created_at FROM platform_memory_uses
        WHERE user_id=$1 AND memory_id=$2 AND created_at>=clock_timestamp()-interval '90 days' ORDER BY created_at DESC,id DESC LIMIT 100`,[s.userId,id])).rows;
      await authorizeFixedSession(client,s,signal);return Object.freeze({memoryId:id,uses:Object.freeze(rows.map(r=>Object.freeze({id:r.id,memoryRevision:r.memory_revision,
        conversationId:r.conversation_id,messageId:r.message_id,speaker:r.speaker,channel:r.channel,purpose:r.purpose,createdAt:r.created_at.toISOString()})))});
    });
  }
  /** Privacy maintenance only; retaining content-free operation tombstones prevents
   * a delayed create retry from resurrecting an explicitly forgotten memory. */
  async purgeDeletedForOwner(context:FixedSessionContext,signal?:AbortSignal) {
    context=fixed(context);return this.db.withBoundedTransaction(async client=>{await this.authorize(client,context,signal);
      const result=await client.query('DELETE FROM platform_memories WHERE user_id=$1 AND undo_until<=clock_timestamp() RETURNING id',[context.userId]);
      await authorizeFixedSession(client,context,signal);return result.rowCount??0;});
  }
}
