import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { parseSafetyQuestionReserveCommand, parseSafetyQuestionClaimCommand, parseSafetyQuestionPresentCommand } from '@companion/platform-contracts';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { Database } from './database.ts';
import type { DataCrypto } from './data-crypto.ts';
import { ApiError } from './errors.ts';
import { CompanionNameSafetyDelivery } from './companion-name-safety-delivery.ts';
import { deliveryDigest, deliveryInteger, deliveryRecord, deliveryStorageUnavailable, deliveryUuid, sealDelivery } from './safety-delivery-review.ts';
import { questionOperationCapture, questionOperationCore, questionScopeCapture, readQuestionJournal, readQuestionLegacy, readLegacyQuestionPublications, writeQuestionScope,
  type QuestionOccurrenceRow, type QuestionOperationRow, type QuestionScopeRow } from './safety-question-delivery-protocol.ts';

const changed=()=>new ApiError(409,'SAFETY_QUESTION_SCOPE_REVISION_CHANGED','Read the current question delivery state.');
const conflict=()=>new ApiError(409,'SAFETY_QUESTION_OPERATION_CONFLICT','Use a new question operation identifier.');
const unavailable=()=>new ApiError(409,'SAFETY_QUESTION_NOT_AVAILABLE','A current reviewed L2 resource question is required.');
const uncertain=()=>new ApiError(409,'SAFETY_QUESTION_DELIVERY_UNCERTAIN','An earlier question may already have been displayed. The resource body remains available.');
const reserved=()=>new ApiError(409,'SAFETY_QUESTION_RESERVED','Another active display controller owns this question reservation.');
const scopeTable='platform_safety_question_scopes',occurrenceTable='platform_safety_question_occurrences',operationTable='platform_safety_question_operations';
type Journal=Awaited<ReturnType<typeof readQuestionJournal>>;
type Publication=Awaited<ReturnType<CompanionNameSafetyDelivery['readPublicationInTransaction']>>;
function parsed<T>(run:()=>T):T{try{return run();}catch{throw new ApiError(400,'INVALID_INPUT','Use a valid question operation.');}}
const occurrenceColumns=['id','user_id','draft_id','publication_id','submission_id','source_generation','occurrence','generation','phase','reservation_id','reservation_digest',
  'session_hash','render_owner_id','reserved_until','display_until','evidence_until','grant_id','grant_digest','question_digest','claimed_at','receipt_received_at'] as const;

/** Internal exclusive delivery. A reservation/claim is never an asked declaration.
 * The future UI must render only the committed claim inside its display window;
 * grant expiry cannot establish that a client never rendered the response. */
export class SafetyQuestionDelivery {
  private readonly reservationMs:number;private readonly displayMs:number;
  constructor(private readonly db:Database,private readonly crypto:DataCrypto|undefined,private readonly delivery:CompanionNameSafetyDelivery,
    timing:Readonly<{reservationMs:number;displayMs:number}>={reservationMs:15000,displayMs:15000}){
    this.reservationMs=deliveryInteger(timing.reservationMs,10,60000);this.displayMs=deliveryInteger(timing.displayMs,10,60000);
  }
  private async target(client:PoolClient,fixed:FixedSessionContext,id:string,signal?:AbortSignal):Promise<Publication>{
    if(!this.crypto)throw deliveryStorageUnavailable();const p=await this.delivery.readPublicationInTransaction(client,fixed,id,signal);
    if(p.row.level!=='L2'||!p.response.question||p.row.question_digest!==deliveryDigest(p.response.question))throw unavailable();return p;
  }
  private async clock(client:PoolClient){return (await client.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0].at;}
  private async scope(client:PoolClient,p:Publication,initialize:boolean){
    const anchor=(await client.query<{name_question_scope_draft_id:string|null}>('SELECT name_question_scope_draft_id FROM platform_onboarding_drafts WHERE id=$1 AND user_id=$2 FOR UPDATE',[p.row.logical_draft_id,p.row.user_id])).rows[0];
    if(!anchor)throw deliveryStorageUnavailable();
    let scope=(await client.query<QuestionScopeRow>('SELECT * FROM platform_safety_question_scopes WHERE user_id=$1 AND draft_id=$2 FOR UPDATE',[p.row.user_id,p.row.logical_draft_id])).rows[0];
    if(scope){if(anchor.name_question_scope_draft_id!==scope.draft_id)throw deliveryStorageUnavailable();return readQuestionJournal(client,this.crypto!,scope);}
    if(anchor.name_question_scope_draft_id!==null||(await client.query(`SELECT 1 FROM platform_safety_question_operations WHERE user_id=$1 AND draft_id=$2
      UNION ALL SELECT 1 FROM platform_safety_question_occurrences WHERE user_id=$1 AND draft_id=$2
      UNION ALL SELECT 1 FROM platform_safety_legacy_exposures WHERE user_id=$1 AND draft_id=$2 LIMIT 1`,[p.row.user_id,p.row.logical_draft_id])).rowCount)throw deliveryStorageUnavailable();
    if(!initialize)return null;
    const at=await this.clock(client),old=await readLegacyQuestionPublications(client,this.crypto!,p.row.user_id,p.row.logical_draft_id);
    for(const row of old){const capture={schemaVersion:1,userId:p.row.user_id,draftId:p.row.logical_draft_id,publicationId:row.id,recordedAt:at.toISOString(),kind:'legacy_possible_exposure',proofDigest:row.proofDigest};
      await client.query('INSERT INTO platform_safety_legacy_exposures(user_id,draft_id,publication_id,recorded_at,payload_ciphertext) VALUES($1,$2,$3,$4,$5)',
        [p.row.user_id,p.row.logical_draft_id,row.id,at,sealDelivery(this.crypto!,'platform_safety_legacy_exposures',row.id,p.row.user_id,1,capture)]);}
    const legacy=await readQuestionLegacy(client,this.crypto!,p.row.user_id,p.row.logical_draft_id);
    scope={user_id:p.row.user_id,draft_id:p.row.logical_draft_id,revision:0,latest_operation_id:null,
      journal_digest:deliveryDigest(JSON.stringify({userId:p.row.user_id,draftId:p.row.logical_draft_id,legacyDigest:legacy.digest})),payload_ciphertext:Buffer.alloc(0)};
    scope.payload_ciphertext=sealDelivery(this.crypto!,scopeTable,scope.draft_id,scope.user_id,0,questionScopeCapture(scope,legacy.digest));
    await client.query('INSERT INTO platform_safety_question_scopes(user_id,draft_id,revision,latest_operation_id,journal_digest,payload_ciphertext) VALUES($1,$2,0,NULL,$3,$4)',[scope.user_id,scope.draft_id,scope.journal_digest,scope.payload_ciphertext]);
    const anchored=await client.query('UPDATE platform_onboarding_drafts SET name_question_scope_draft_id=id WHERE id=$1 AND user_id=$2 AND name_question_scope_draft_id IS NULL RETURNING id',[scope.draft_id,scope.user_id]);
    if(anchored.rowCount!==1)throw deliveryStorageUnavailable();return readQuestionJournal(client,this.crypto!,scope);
  }
  private state(j:Journal|null,p:Publication,legacy=false){const occurrences=j?.actual??[],last=occurrences.filter(x=>x.receipt_received_at).sort((a,b)=>b.receipt_received_at!.getTime()-a.receipt_received_at!.getTime())[0];
    return {publicationId:p.row.id,submissionId:p.row.submission_id,scopeRevision:j?.scope.revision??0,
      possibleLegacyExposure:j?j.legacy.rows.length>0:legacy,deliveryUncertain:occurrences.some(x=>x.phase==='claimed'),
      receiptReceivedAt:last?.receipt_received_at?.toISOString()??null,
      sourcePhase:occurrences.filter(x=>x.submission_id===p.row.submission_id&&x.source_generation===p.row.source_generation).sort((a,b)=>b.occurrence-a.occurrence)[0]?.phase??null};}
  async read(context:FixedSessionContext,value:unknown,signal?:AbortSignal){
    const fixed=Object.freeze({...context}),id=parsed(()=>deliveryUuid(deliveryRecord(value,['publicationId']).publicationId));
    return this.db.withBoundedTransaction(async client=>{const p=await this.target(client,fixed,id,signal),j=await this.scope(client,p,false);
      const old=!j&&(await readLegacyQuestionPublications(client,this.crypto!,fixed.userId,p.row.logical_draft_id)).length>0;
      await authorizeFixedSession(client,fixed,signal);signal?.throwIfAborted();return this.state(j,p,old);});
  }
  private exact(j:Journal,fixed:FixedSessionContext,operationId:string,kind:QuestionOperationRow['kind'],request:unknown){
    const old=j.rows.find(x=>x.operation_id===operationId);if(!old)return null;const capture=j.captures.get(old.operation_id);
    if(!capture||old.kind!==kind||old.session_hash!==fixed.tokenHash||JSON.stringify(capture.request)!==JSON.stringify(request))throw conflict();return {row:old,capture};
  }
  private async assertOperationUnused(client:PoolClient,userId:string,operationId:string){
    if((await client.query('SELECT 1 FROM platform_safety_question_operations WHERE user_id=$1 AND operation_id=$2',[userId,operationId])).rowCount)throw conflict();
  }
  private assertAllowance(j:Journal,p:Publication,at:Date){
    const firstSignal=!j.actual.some(x=>x.submission_id===p.row.submission_id&&x.source_generation===p.row.source_generation&&(x.phase==='claimed'||x.phase==='declared'));
    if(firstSignal)return;
    if(j.actual.some(x=>x.phase==='claimed')||j.legacy.rows.length)throw uncertain();
    const lastAsked=j.actual.filter(x=>x.receipt_received_at).sort((a,b)=>b.receipt_received_at!.getTime()-a.receipt_received_at!.getTime())[0];
    if(lastAsked&&at.getTime()-lastAsked.receipt_received_at!.getTime()<86400000)
      throw new ApiError(409,'SAFETY_QUESTION_ALREADY_ASKED','This conversation already received a question within 24 hours.');
  }
  private async commit(client:PoolClient,j:Journal,fixed:FixedSessionContext,operationId:string,kind:QuestionOperationRow['kind'],request:unknown,
    after:QuestionOccurrenceRow,at:Date,secret:string|null=null,question:string|null=null){
    if(j.scope.revision>=2147483646)throw changed();await this.assertOperationUnused(client,fixed.userId,operationId);
    const values=occurrenceColumns.map(k=>after[k]);
    if(j.actual.some(x=>x.id===after.id)){
      const assignments=occurrenceColumns.slice(1).map((k,i)=>`${k}=$${i+2}`).join(',');
      const updated=await client.query(`UPDATE ${occurrenceTable} SET ${assignments} WHERE id=$1 AND user_id=$2 RETURNING id`,values);if(updated.rowCount!==1)throw deliveryStorageUnavailable();
    }else await client.query(`INSERT INTO ${occurrenceTable}(${occurrenceColumns.join(',')}) VALUES(${values.map((_,i)=>`$${i+1}`).join(',')})`,values);
    const op:QuestionOperationRow={user_id:fixed.userId,operation_id:operationId,draft_id:j.scope.draft_id,occurrence_id:after.id,kind,
      expected_revision:j.scope.revision,applied_revision:j.scope.revision+1,session_hash:fixed.tokenHash,render_owner_id:after.render_owner_id,
      previous_digest:j.scope.journal_digest,journal_digest:'',payload_ciphertext:Buffer.alloc(0),created_at:at};
    op.journal_digest=deliveryDigest(JSON.stringify(questionOperationCore(op,request,after,secret,question)));
    op.payload_ciphertext=sealDelivery(this.crypto!,operationTable,op.operation_id,op.user_id,op.applied_revision,questionOperationCapture(op,request,after,secret,question));
    await client.query(`INSERT INTO ${operationTable}(user_id,operation_id,draft_id,occurrence_id,kind,expected_revision,applied_revision,session_hash,render_owner_id,previous_digest,journal_digest,payload_ciphertext,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[op.user_id,op.operation_id,op.draft_id,op.occurrence_id,op.kind,op.expected_revision,op.applied_revision,op.session_hash,op.render_owner_id,op.previous_digest,op.journal_digest,op.payload_ciphertext,op.created_at]);
    const next={...j.scope,revision:op.applied_revision,latest_operation_id:op.operation_id,journal_digest:op.journal_digest};
    const saved=await writeQuestionScope(client,this.crypto!,next,j.legacy.digest);return {op,journal:await readQuestionJournal(client,this.crypto!,saved)};
  }
  async reserve(context:FixedSessionContext,value:unknown,signal?:AbortSignal){const fixed=Object.freeze({...context}),request=parsed(()=>parseSafetyQuestionReserveCommand(value));
    return this.db.withBoundedTransaction(async client=>{const p=await this.target(client,fixed,request.publicationId,signal),j=(await this.scope(client,p,true))!;
      const replay=this.exact(j,fixed,request.operationId,'reserve',request);
      if(replay){const after=replay.capture.after as ReturnType<typeof import('./safety-question-delivery-protocol.ts')['questionOccurrenceCapture']>;
        await authorizeFixedSession(client,fixed,signal);signal?.throwIfAborted();return {occurrenceId:after.id as string,reservationId:after.reservation_id as string,generation:after.generation as number,
          reservedUntil:after.reservedUntil,scopeRevision:j.scope.revision,operation:{id:replay.row.operation_id,appliedRevision:replay.row.applied_revision,replayed:true}};}
      if(request.expectedQuestionScopeRevision!==j.scope.revision)throw changed();const at=await this.clock(client);if(p.row.retention_until<=at)throw unavailable();
      const sources=j.actual.filter(x=>x.submission_id===p.row.submission_id&&x.source_generation===p.row.source_generation).sort((a,b)=>b.occurrence-a.occurrence),last=sources[0];
      if(last?.phase==='claimed')throw uncertain();if(last?.phase==='reserved'&&last.reserved_until>at)throw reserved();
      this.assertAllowance(j,p,at);
      const token=randomBytes(32).toString('base64url'),until=new Date(Math.min(at.getTime()+this.reservationMs,p.row.retention_until.getTime()));
      const after:QuestionOccurrenceRow={id:last?.phase==='reserved'?last.id:randomUUID(),user_id:fixed.userId,draft_id:p.row.logical_draft_id,publication_id:p.row.id,
        submission_id:p.row.submission_id,source_generation:p.row.source_generation,occurrence:last?.phase==='reserved'?last.occurrence:(last?.occurrence??0)+1,
        generation:last?.phase==='reserved'?last.generation+1:1,phase:'reserved',reservation_id:randomUUID(),reservation_digest:deliveryDigest(token),session_hash:fixed.tokenHash,
        render_owner_id:request.renderOwnerId,reserved_until:until,display_until:null,evidence_until:null,grant_id:null,grant_digest:null,question_digest:p.row.question_digest!,claimed_at:null,receipt_received_at:null};
      const result=await this.commit(client,j,fixed,request.operationId,'reserve',request,after,at);
      if(until<=await this.clock(client))throw reserved();await authorizeFixedSession(client,fixed,signal);signal?.throwIfAborted();
      return {occurrenceId:after.id,reservationId:after.reservation_id,reservationToken:token,generation:after.generation,reservedUntil:until.toISOString(),scopeRevision:result.journal.scope.revision,
        operation:{id:result.op.operation_id,appliedRevision:result.op.applied_revision,replayed:false}};});
  }
  private async locate(client:PoolClient,fixed:FixedSessionContext,occurrenceId:string,signal?:AbortSignal){
    const found=(await client.query<QuestionOccurrenceRow>('SELECT * FROM platform_safety_question_occurrences WHERE id=$1 AND user_id=$2',[occurrenceId,fixed.userId])).rows[0];
    if(!found)throw new ApiError(404,'NOT_FOUND','The question delivery is not available.');
    const p=await this.target(client,fixed,found.publication_id,signal),j=await this.scope(client,p,false);if(!j)throw deliveryStorageUnavailable();
    const occurrence=j.actual.find(x=>x.id===occurrenceId);if(!occurrence)throw deliveryStorageUnavailable();return {p,j,occurrence};
  }
  async claim(context:FixedSessionContext,value:unknown,signal?:AbortSignal){const fixed=Object.freeze({...context}),request=parsed(()=>parseSafetyQuestionClaimCommand(value));
    const canonical={operationId:request.operationId,occurrenceId:request.occurrenceId,reservationId:request.reservationId,reservationDigest:deliveryDigest(request.reservationToken),generation:request.generation,renderOwnerId:request.renderOwnerId};
    return this.db.withBoundedTransaction(async client=>{const {p,j,occurrence:o}=await this.locate(client,fixed,request.occurrenceId,signal),replay=this.exact(j,fixed,request.operationId,'claim',canonical),at=await this.clock(client);
      if(replay){const original=replay.capture.after as ReturnType<typeof import('./safety-question-delivery-protocol.ts')['questionOccurrenceCapture']>;
        const live=o.phase==='claimed'&&o.grant_id===original.grant_id&&o.session_hash===fixed.tokenHash&&o.render_owner_id===request.renderOwnerId&&o.display_until!>at&&p.row.retention_until>at;
        await authorizeFixedSession(client,fixed,signal);signal?.throwIfAborted();return {occurrenceId:o.id,grantId:original.grant_id as string,scopeRevision:j.scope.revision,status:live?'display_granted' as const:o.phase==='declared'?'declared' as const:'delivery_uncertain' as const,
          ...(live?{grantPresentationToken:replay.capture.secret as string,question:replay.capture.question as string,displayUntil:o.display_until!.toISOString()}:{}),
          operation:{id:replay.row.operation_id,appliedRevision:replay.row.applied_revision,replayed:true}};}
      if(o.phase!=='reserved'||o.session_hash!==fixed.tokenHash||o.render_owner_id!==request.renderOwnerId||o.reservation_id!==request.reservationId
        ||o.reservation_digest!==canonical.reservationDigest||o.generation!==request.generation||o.reserved_until<=at)throw reserved();
      if(p.row.retention_until<=at||p.row.evidence_retention_until<=at)throw unavailable();
      // The scope may have changed after reservation through another genuine
      // L2 source. Re-check routine allowance before first transport, while the
      // real scope is locked. Exact committed claim retries never re-draw it.
      this.assertAllowance(j,p,at);const token=randomBytes(32).toString('base64url');
      const after:QuestionOccurrenceRow={...o,phase:'claimed',grant_id:randomUUID(),grant_digest:deliveryDigest(token),claimed_at:at,
        display_until:new Date(Math.min(at.getTime()+this.displayMs,p.row.retention_until.getTime())),evidence_until:p.row.evidence_retention_until};
      const result=await this.commit(client,j,fixed,request.operationId,'claim',canonical,after,at,token,p.response.question!);
      if(after.display_until!<=await this.clock(client))throw unavailable();await authorizeFixedSession(client,fixed,signal);signal?.throwIfAborted();
      return {occurrenceId:o.id,grantId:after.grant_id!,grantPresentationToken:token,question:p.response.question!,displayUntil:after.display_until!.toISOString(),
        scopeRevision:result.journal.scope.revision,status:'display_granted' as const,operation:{id:result.op.operation_id,appliedRevision:result.op.applied_revision,replayed:false}};});
  }
  async present(context:FixedSessionContext,value:unknown,signal?:AbortSignal){const fixed=Object.freeze({...context}),request=parsed(()=>parseSafetyQuestionPresentCommand(value));
    const canonical={operationId:request.operationId,occurrenceId:request.occurrenceId,grantId:request.grantId,grantDigest:deliveryDigest(request.grantPresentationToken),renderOwnerId:request.renderOwnerId};
    return this.db.withBoundedTransaction(async client=>{const {j,occurrence:o}=await this.locate(client,fixed,request.occurrenceId,signal),replay=this.exact(j,fixed,request.operationId,'present',canonical);
      if(replay){await authorizeFixedSession(client,fixed,signal);signal?.throwIfAborted();return {occurrenceId:o.id,receiptReceivedAt:replay.row.created_at.toISOString(),scopeRevision:j.scope.revision,
        operation:{id:replay.row.operation_id,appliedRevision:replay.row.applied_revision,replayed:true}};}
      const at=await this.clock(client);if(o.phase!=='claimed'||o.session_hash!==fixed.tokenHash||o.render_owner_id!==request.renderOwnerId||o.grant_id!==request.grantId||o.grant_digest!==canonical.grantDigest)throw uncertain();
      if(!o.evidence_until||o.evidence_until<=at)throw unavailable();
      const result=await this.commit(client,j,fixed,request.operationId,'present',canonical,{...o,phase:'declared',receipt_received_at:at},at);
      await authorizeFixedSession(client,fixed,signal);signal?.throwIfAborted();return {occurrenceId:o.id,receiptReceivedAt:at.toISOString(),scopeRevision:result.journal.scope.revision,
        operation:{id:result.op.operation_id,appliedRevision:result.op.applied_revision,replayed:false}};});
  }
}
