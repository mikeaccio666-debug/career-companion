import { CareerProfiles } from './career-profiles.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { parseNameSafetyPublicationCommand, parseNameSafetyResourceCommand, type NameSafetyPublicationCommand,
  type NameSafetyResourceState } from '@companion/platform-contracts';
import { renderSafetyResponse } from '@companion/career-core';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { Database } from './database.ts';
import type { PlatformConfig } from './config.ts';
import type { LegalBundle } from './legal-documents.ts';
import { OnboardingStorage } from './onboarding-storage.ts';
import { ApiError } from './errors.ts';
import { readIntakeResourceSourceInTransaction, readIntakeResourceCaptureInTransaction, prepareIntakeResourceCaptureInTransaction, readLegacyHandledIntakeTargetInTransaction } from './onboarding-resource-source.ts';
import { ensureIntakeResourceCutover } from './onboarding-resource-cutover.ts';
import { resumeOnboardingDraft } from '@companion/career-core';
import { parseSafetyResponseBundle, type SafetyResponseBundle } from './safety-response-bundle.ts';
import { publicSafetyResponseBody } from './safety-response-view.ts';
import { acquireDeliveryReviewCoordinator, assertActiveDeliveryAssets, deliveryDigest, deliveryInteger, deliveryRecord,
  deliveryStorageUnavailable, deliveryUnavailable, deliveryUuid, openDelivery, parseSafetyDeliveryReview,
  readArchivedDeliveryActivation, readArchivedDeliveryAssets, sealDelivery, type SafetyDeliveryReview } from './safety-delivery-review.ts';
import { bodyProjectionCapture, followupCapture, followupDigest, followupStateCapture, publicationCoordinates, publicationGenesis,
  readIntakeSafetyJournal, readIntakePublicationCapture, resourceCanonicalInput, writeIntakeSafetyState, type IntakeSafetyFollowupRow, type IntakeSafetyProjectionRow,
  type IntakeSafetyPublicationRow, type IntakeSafetyStateRow } from './onboarding-safety-delivery-protocol.ts';

export type IntakeSafetyResourceAction = Readonly<{kind:'present_body';bodyProjectionId:string}> | Readonly<{kind:'acknowledge'|'continue_intake';presentationReceipt:string}> | Readonly<{kind:'clarify_exaggeration';presentationReceipt:string;safe:true;exaggeration:true}> | Readonly<{kind:'need_support'}>;
export interface IntakeSafetyResourceCommand {readonly operationId:string;readonly publicationId:string;readonly expectedPublicationRevision:number;readonly action:IntakeSafetyResourceAction;}
export function parseIntakeSafetyResourceCommand(value:unknown):Readonly<IntakeSafetyResourceCommand> {
  const d=deliveryRecord(value,['operationId','publicationId','expectedPublicationRevision','action']);
  const kind=d.action&&typeof d.action==='object'?Object.getOwnPropertyDescriptor(d.action,'kind'):undefined;
  if(!kind||!('value'in kind)||kind.value==='continue_naming')throw new ApiError(400,'INVALID_INPUT','Use an actual intake resource action.');
  const action=kind.value==='continue_intake'?{...deliveryRecord(d.action,['kind','presentationReceipt']),kind:'continue_naming'}:d.action;
  const command=parseNameSafetyResourceCommand({...d,action});
  const parsedAction=command.action;
  switch(parsedAction.kind){
    case 'continue_naming':return Object.freeze({...command,action:Object.freeze({kind:'continue_intake' as const,presentationReceipt:parsedAction.presentationReceipt})});
    case 'acknowledge':return Object.freeze({...command,action:Object.freeze({kind:'acknowledge' as const,presentationReceipt:parsedAction.presentationReceipt})});
    case 'present_body':return Object.freeze({...command,action:Object.freeze({kind:'present_body' as const,bodyProjectionId:parsedAction.bodyProjectionId})});
    case 'need_support':return Object.freeze({...command,action:Object.freeze({kind:'need_support' as const})});
    case 'clarify_exaggeration':return Object.freeze({...command,action:Object.freeze({kind:'clarify_exaggeration' as const,presentationReceipt:parsedAction.presentationReceipt,safe:true as const,exaggeration:true as const})});
  }
}
const publicationTable='platform_onboarding_safety_v2_publications',headTable='platform_onboarding_delivery_v2_heads',requestTable='platform_onboarding_delivery_v2_operations';
const conflict=()=>new ApiError(409,'SAFETY_DELIVERY_OPERATION_CONFLICT','Use a new resource operation identifier.');
const changed=()=>new ApiError(409,'SAFETY_DELIVERY_PUBLICATION_REVISION_CHANGED','Read the current resource state before continuing.');
const expired=()=>new ApiError(409,'SAFETY_DELIVERY_RESPONSE_EXPIRED','A current reviewed resource edition is required.');
interface HeadRow {submission_id:string;user_id:string;source_generation:number;detector_revision:number;level:'L1'|'L2';detector_mode:'full'|'keyword_only';revision:number;latest_publication_id:string|null;payload_ciphertext:Buffer;}
interface PublicationOperation {user_id:string;operation_id:string;submission_id:string;source_generation:number;publication_id:string;kind:'publish'|'recover';expected_edition:number;session_hash:string;payload_ciphertext:Buffer;created_at:Date;}
type OriginalCapture=NonNullable<Awaited<ReturnType<typeof readIntakeResourceCaptureInTransaction>>>;
const capturedHead=(r:HeadRow)=>({schemaVersion:1,submissionId:r.submission_id,userId:r.user_id,sourceGeneration:r.source_generation,
  detectorRevision:r.detector_revision,level:r.level,mode:r.detector_mode,revision:r.revision,latestPublicationId:r.latest_publication_id});
const publicationRequestCapture=(r:PublicationOperation,request:NameSafetyPublicationCommand)=>({schemaVersion:1,userId:r.user_id,operationId:r.operation_id,
  submissionId:r.submission_id,sourceGeneration:r.source_generation,publicationId:r.publication_id,kind:r.kind,expectedEdition:r.expected_edition,
  sessionHash:r.session_hash,at:r.created_at.toISOString(),request});
function parsed<T>(run:()=>T):T{try{return run();}catch{throw new ApiError(400,'INVALID_INPUT','Use a valid resource operation.');}}
function idInput(value:unknown,key:'publicationId'|'submissionId'):string{return parsed(()=>deliveryUuid(deliveryRecord(value,[key])[key]));}

/** Source-specific resource lifecycle. Transport uses the caller's fixed real
 * session; body delivery never grants model, tool or clinical clearance. */
export class OnboardingSafetyDelivery {
  private readonly profiles:CareerProfiles;
  private readonly storage:OnboardingStorage;private readonly bundle:SafetyResponseBundle|null;private readonly review:SafetyDeliveryReview|null;
  constructor(private readonly db:Database,config:Pick<PlatformConfig,'dataCrypto'|'requireVerifiedEmail'>,legal:LegalBundle|null,
    bundle:SafetyResponseBundle|null,review:SafetyDeliveryReview|null){
    this.profiles=new CareerProfiles(db,config,legal);
    this.storage=new OnboardingStorage(config,legal);this.bundle=bundle===null?null:parseSafetyResponseBundle(bundle);this.review=review===null?null:parseSafetyDeliveryReview(review);
  }
  private async admission(client:PoolClient,fixed:FixedSessionContext,signal?:AbortSignal){
    await authorizeFixedSession(client,fixed,signal);const a=(await client.query<{account_kind:string}>('SELECT account_kind FROM platform_users WHERE id=$1 FOR NO KEY UPDATE',[fixed.userId])).rows[0];
    if(!a||a.account_kind!=='student')throw new ApiError(403,'STUDENT_ACCOUNT_REQUIRED','Use a student account for private resources.');
    if(!this.storage.crypto)throw deliveryStorageUnavailable();await authorizeFixedSession(client,fixed,signal);
  }
  private async target(client:PoolClient,userId:string,submissionId:string,signal?:AbortSignal){
    if(!(await client.query('SELECT id FROM platform_onboarding_safety_submissions WHERE id=$1 AND user_id=$2',[submissionId,userId])).rowCount)throw new ApiError(404,'NOT_FOUND','The resource is not available.');
    const target=await readIntakeResourceSourceInTransaction(client,this.storage.crypto,submissionId,signal);
    if(target.decision.level==='L0')return null;
    return readIntakeResourceCaptureInTransaction(client,this.storage.crypto,submissionId,signal);
  }
  private async decodePublication(client:PoolClient,r:IntakeSafetyPublicationRow,original:OriginalCapture){
    return readIntakePublicationCapture(client,this.storage,r,original);
  }
  private decodeRequest(row:PublicationOperation){
    const raw=openDelivery(this.storage.crypto!,requestTable,row.operation_id,row.user_id,1,row.payload_ciphertext);
    const data=deliveryRecord(raw,['schemaVersion','userId','operationId','submissionId','sourceGeneration','publicationId','kind','expectedEdition','sessionHash','at','request']);
    const request=parseNameSafetyPublicationCommand(data.request);
    if(request.operationId!==row.operation_id||request.submissionId!==row.submission_id||request.expectedEdition!==row.expected_edition
      ||JSON.stringify(raw)!==JSON.stringify(publicationRequestCapture(row,request)))throw deliveryStorageUnavailable();return request;
  }
  private async head(client:PoolClient,original:OriginalCapture){
    const target=original.target,r=(await client.query<HeadRow>('SELECT * FROM platform_onboarding_delivery_v2_heads WHERE submission_id=$1 FOR UPDATE',[target.source.id])).rows[0];
    const anchor=(await client.query<{first_safety_v2_publication_id:string|null}>('SELECT first_safety_v2_publication_id FROM platform_onboarding_safety_submissions WHERE id=$1 AND user_id=$2 FOR UPDATE',[target.source.id,target.source.user_id])).rows[0];
    const pubs=(await client.query<IntakeSafetyPublicationRow>('SELECT * FROM platform_onboarding_safety_v2_publications WHERE submission_id=$1 ORDER BY edition FOR UPDATE',[target.source.id])).rows;
    if(!anchor)throw deliveryStorageUnavailable();
    if(!r){if(pubs.length||anchor.first_safety_v2_publication_id!==null)throw deliveryStorageUnavailable();return {row:null,publications:pubs};}
    if(anchor.first_safety_v2_publication_id!==pubs[0]?.id)throw deliveryStorageUnavailable();
    if(r.user_id!==target.source.user_id||r.source_generation!==target.source.generation||r.detector_revision!==target.source.detector_revision
      ||r.level!==target.decision.level||r.detector_mode!==target.decision.mode||pubs.length!==r.revision||r.latest_publication_id!==(pubs.at(-1)?.id??null)
      ||JSON.stringify(openDelivery(this.storage.crypto!,headTable,r.submission_id,r.user_id,r.revision,r.payload_ciphertext))!==JSON.stringify(capturedHead(r)))throw deliveryStorageUnavailable();
    for(let i=0;i<pubs.length;i++){if(pubs[i].edition!==i+1)throw deliveryStorageUnavailable();await this.decodePublication(client,pubs[i],original);}
    return {row:r,publications:pubs};
  }
  private async writeRequest(client:PoolClient,row:PublicationOperation,request:NameSafetyPublicationCommand){
    const cipher=sealDelivery(this.storage.crypto!,requestTable,row.operation_id,row.user_id,1,publicationRequestCapture(row,request));
    await client.query(`INSERT INTO platform_onboarding_delivery_v2_operations(user_id,operation_id,submission_id,source_generation,publication_id,kind,expected_edition,session_hash,payload_ciphertext,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[row.user_id,row.operation_id,row.submission_id,row.source_generation,row.publication_id,row.kind,row.expected_edition,row.session_hash,cipher,row.created_at]);
  }
  private async publishOrRecover(context:FixedSessionContext,value:unknown,kind:PublicationOperation['kind'],signal?:AbortSignal){
    const fixed=Object.freeze({...context}),request=parsed(()=>parseNameSafetyPublicationCommand(value));
    // Archive-only retry need not depend on a policy mutex. If this observation
    // disappears, do not switch to new capture while holding an account lock.
    const exists=kind==='publish'&&(await this.db.query('SELECT id FROM platform_onboarding_safety_v2_publications WHERE user_id=$1 AND submission_id=$2 LIMIT 1',[fixed.userId,request.submissionId])).rowCount!==0;
    return this.db.withBoundedTransaction(async client=>{
      if(!exists)await acquireDeliveryReviewCoordinator(client,signal);await this.admission(client,fixed,signal);
      if(!(await client.query('SELECT id FROM platform_onboarding_safety_submissions WHERE id=$1 AND user_id=$2',[request.submissionId,fixed.userId])).rowCount)throw new ApiError(404,'NOT_FOUND','The resource is not available.');
      const source=await readIntakeResourceSourceInTransaction(client,this.storage.crypto,request.submissionId,signal);if(source.decision.level==='L0')return null;
      const ready=(await client.query<{status:string}>('SELECT status FROM platform_onboarding_safety_responses WHERE submission_id=$1',[request.submissionId])).rows[0];
      if(ready?.status==='pending'){
        if(exists)throw deliveryStorageUnavailable();
        const assets=await assertActiveDeliveryAssets(client,this.storage.crypto!,this.bundle,this.review,signal);
        await prepareIntakeResourceCaptureInTransaction(client,this.storage.crypto,request.submissionId,assets.bundle,signal);
      }
      const original=await this.target(client,fixed.userId,request.submissionId,signal);if(!original)throw deliveryStorageUnavailable();
      await ensureIntakeResourceCutover(client,this.storage.crypto!,fixed.userId,original.target.source.draft_id);
      const {row:oldHead,publications}=await this.head(client,original),latest=publications.at(-1);
      const previous=(await client.query<PublicationOperation>('SELECT * FROM platform_onboarding_delivery_v2_operations WHERE user_id=$1 AND operation_id=$2 FOR UPDATE',[fixed.userId,request.operationId])).rows[0];
      if(previous){if(previous.kind!==kind||previous.session_hash!==fixed.tokenHash||JSON.stringify(this.decodeRequest(previous))!==JSON.stringify(request))throw conflict();
        const p=publications.find(x=>x.id===previous.publication_id);if(!p)throw deliveryStorageUnavailable();await authorizeFixedSession(client,fixed,signal);
        return {publicationId:p.id,submissionId:p.submission_id,edition:p.edition,replayed:true};}
      if(exists&&!latest)throw deliveryStorageUnavailable();
      const live=latest?(await client.query<{live:boolean}>('SELECT $1::timestamptz>clock_timestamp() AS live',[latest.retention_until])).rows[0].live:false;
      if(request.expectedEdition!==(oldHead?.revision??0)&&!(kind==='publish'&&request.expectedEdition===0&&latest))throw changed();
      if(latest&&(live||kind==='publish')){
        const at=(await client.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0].at;
        await this.writeRequest(client,{user_id:fixed.userId,operation_id:request.operationId,submission_id:request.submissionId,source_generation:original.target.source.generation,
          publication_id:latest.id,kind,expected_edition:request.expectedEdition,session_hash:fixed.tokenHash,payload_ciphertext:Buffer.alloc(0),created_at:at},request);
        await authorizeFixedSession(client,fixed,signal);signal?.throwIfAborted();return {publicationId:latest.id,submissionId:latest.submission_id,edition:latest.edition,replayed:false};
      }
      if(exists)throw deliveryStorageUnavailable();
      const assets=await assertActiveDeliveryAssets(client,this.storage.crypto!,this.bundle,this.review,signal),t=original.target;
      const times=(await client.query<{at:Date;until:Date;evidence:Date}>(`SELECT t.at,t.at+($1::int*interval '1 day') AS until,t.at+($2::int*interval '1 day') AS evidence
        FROM (SELECT clock_timestamp() AS at) t`,[assets.bundle.retentionDays,assets.review.evidenceRetentionDays])).rows[0];
      const locale=original.row.locale!,response=renderSafetyResponse({level:t.decision.level as 'L1'|'L2',locale,templateFromBundle:assets.bundle.locales[locale],contactsFromBundle:assets.bundle.resources.contacts,
        outsideUsTranslation:assets.bundle.resources.outsideUs[locale],companionName:locale==='en'?'Your companion':'你的主理人',userName:'',askSafetyQuestion:t.decision.level==='L2'});
      const p:IntakeSafetyPublicationRow={id:randomUUID(),user_id:fixed.userId,submission_id:request.submissionId,response_id:original.row.id,source_generation:t.source.generation,
        detector_revision:t.source.detector_revision!,level:t.decision.level as 'L1'|'L2',detector_mode:t.decision.mode,logical_draft_id:t.source.draft_id,
        edition:(oldHead?.revision??0)+1,publication_operation_id:request.operationId,asset_id:assets.id,activation_user_id:assets.activation.userId,activation_operation_id:assets.activation.operationId,
        activation_kind:'activate',body_digest:deliveryDigest(JSON.stringify(publicSafetyResponseBody(response))),question_digest:response.question===undefined?null:deliveryDigest(response.question),
        payload_ciphertext:Buffer.alloc(0),prepared_at:times.at,published_at:times.at,retention_until:times.until,evidence_retention_until:times.evidence};
      p.payload_ciphertext=sealDelivery(this.storage.crypto!,publicationTable,p.id,p.user_id,1,{schemaVersion:1,...publicationCoordinates(p),activation:assets.activation,locale,response});
      await client.query(`INSERT INTO platform_onboarding_safety_v2_publications(id,user_id,submission_id,response_id,source_generation,detector_revision,level,detector_mode,
        logical_draft_id,edition,publication_operation_id,asset_id,activation_user_id,activation_operation_id,body_digest,question_digest,payload_ciphertext,prepared_at,published_at,retention_until,evidence_retention_until)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18,$19,$20)`,
        [p.id,p.user_id,p.submission_id,p.response_id,p.source_generation,p.detector_revision,p.level,p.detector_mode,p.logical_draft_id,p.edition,p.publication_operation_id,p.asset_id,
          p.activation_user_id,p.activation_operation_id,p.body_digest,p.question_digest,p.payload_ciphertext,p.prepared_at,p.retention_until,p.evidence_retention_until]);
      await this.writeRequest(client,{user_id:fixed.userId,operation_id:request.operationId,submission_id:p.submission_id,source_generation:p.source_generation,publication_id:p.id,
        kind,expected_edition:request.expectedEdition,session_hash:fixed.tokenHash,payload_ciphertext:Buffer.alloc(0),created_at:times.at},request);
      if(!oldHead){const anchored=await client.query('UPDATE platform_onboarding_safety_submissions SET first_safety_v2_publication_id=$2 WHERE id=$1 AND first_safety_v2_publication_id IS NULL RETURNING id',[p.submission_id,p.id]);if(anchored.rowCount!==1)throw deliveryStorageUnavailable();}
      const head:HeadRow={submission_id:p.submission_id,user_id:p.user_id,source_generation:p.source_generation,detector_revision:p.detector_revision,level:p.level,detector_mode:p.detector_mode,
        revision:p.edition,latest_publication_id:p.id,payload_ciphertext:Buffer.alloc(0)};
      head.payload_ciphertext=sealDelivery(this.storage.crypto!,headTable,p.submission_id,p.user_id,head.revision,capturedHead(head));
      if(oldHead){const saved=await client.query(`UPDATE platform_onboarding_delivery_v2_heads SET revision=$2,latest_publication_id=$3,payload_ciphertext=$4
        WHERE submission_id=$1 AND revision=$5 RETURNING submission_id`,[p.submission_id,head.revision,p.id,head.payload_ciphertext,oldHead.revision]);if(saved.rowCount!==1)throw changed();}
      else await client.query(`INSERT INTO platform_onboarding_delivery_v2_heads(submission_id,user_id,source_generation,detector_revision,level,detector_mode,revision,latest_publication_id,payload_ciphertext)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[head.submission_id,head.user_id,head.source_generation,head.detector_revision,head.level,head.detector_mode,head.revision,head.latest_publication_id,head.payload_ciphertext]);
      const state:IntakeSafetyStateRow={publication_id:p.id,user_id:p.user_id,revision:0,latest_operation_id:null,journal_digest:publicationGenesis(p),payload_ciphertext:Buffer.alloc(0)};
      state.payload_ciphertext=sealDelivery(this.storage.crypto!,'platform_onboarding_safety_v2_followup_states',p.id,p.user_id,0,followupStateCapture(state,p));
      await client.query('INSERT INTO platform_onboarding_safety_v2_followup_states(publication_id,user_id,revision,latest_operation_id,journal_digest,payload_ciphertext) VALUES($1,$2,0,NULL,$3,$4)',[p.id,p.user_id,state.journal_digest,state.payload_ciphertext]);
      await this.head(client,original);await authorizeFixedSession(client,fixed,signal);signal?.throwIfAborted();return {publicationId:p.id,submissionId:p.submission_id,edition:p.edition,replayed:false};
    });
  }
  publish(context:FixedSessionContext,value:unknown,signal?:AbortSignal){return this.publishOrRecover(context,value,'publish',signal);}
  recover(context:FixedSessionContext,value:unknown,signal?:AbortSignal){return this.publishOrRecover(context,value,'recover',signal);}
  /** Same actual transaction, resource viewer only; usable as question's authentic target port. */
  async readPublicationInTransaction(client:PoolClient,fixed:FixedSessionContext,id:string,signal?:AbortSignal){
    await this.admission(client,fixed,signal);const p=(await client.query<IntakeSafetyPublicationRow>('SELECT * FROM platform_onboarding_safety_v2_publications WHERE id=$1 AND user_id=$2 FOR UPDATE',[deliveryUuid(id),fixed.userId])).rows[0];
    if(!p)throw new ApiError(404,'NOT_FOUND','The resource is not available.');const original=await this.target(client,fixed.userId,p.submission_id,signal);if(!original)throw deliveryStorageUnavailable();
    const decoded=await this.decodePublication(client,p,original),journal=await readIntakeSafetyJournal(client,this.storage.crypto!,p,decoded.body);
    return {...decoded,journal};
  }
  private async stateView(client:PoolClient,record:Awaited<ReturnType<OnboardingSafetyDelivery['readPublicationInTransaction']>>):Promise<NameSafetyResourceState>{
    const p=record.row,live=(await client.query<{live:boolean}>('SELECT $1::timestamptz>clock_timestamp() AS live',[p.retention_until])).rows[0].live;
    return {publicationId:p.id,submissionId:p.submission_id,edition:p.edition,revision:record.journal.state.revision,status:live?'ready':'expired',level:p.level,mode:p.detector_mode,
      preparedAt:p.prepared_at.toISOString(),publishedAt:p.published_at.toISOString(),retentionUntil:p.retention_until.toISOString(),
      presented:record.journal.operations.some(x=>x.kind==='present_body'||x.kind==='present_body_evidence'),acknowledged:record.journal.operations.some(x=>x.kind==='acknowledge'),
      handled:await this.verifyHandledInTransaction(client,p.user_id,p.submission_id),clarifiedAt:record.journal.operations.find(x=>x.kind==='clarify_exaggeration')?.clarified_at?.toISOString()??null};
  }
  async read(context:FixedSessionContext,value:unknown,signal?:AbortSignal){const fixed=Object.freeze({...context}),id=idInput(value,'publicationId');
    return this.db.withBoundedTransaction(async client=>{const r=await this.readPublicationInTransaction(client,fixed,id,signal),state=await this.stateView(client,r);
      await authorizeFixedSession(client,fixed,signal);signal?.throwIfAborted();return state;});}
  async issueBodyProjection(context:FixedSessionContext,value:unknown,signal?:AbortSignal){const fixed=Object.freeze({...context}),id=idInput(value,'publicationId');
    return this.db.withBoundedTransaction(async client=>{const r=await this.readPublicationInTransaction(client,fixed,id,signal),state=await this.stateView(client,r);if(state.status!=='ready')throw expired();
      const at=(await client.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0].at,p:IntakeSafetyProjectionRow={id:randomUUID(),user_id:fixed.userId,publication_id:id,
        edition:r.row.edition,body_digest:r.row.body_digest,session_hash:fixed.tokenHash,issued_at:at,payload_ciphertext:Buffer.alloc(0)};
      p.payload_ciphertext=sealDelivery(this.storage.crypto!,'platform_onboarding_safety_v2_body_projections',p.id,p.user_id,1,bodyProjectionCapture(p,r.body));
      await client.query('INSERT INTO platform_onboarding_safety_v2_body_projections(id,user_id,publication_id,edition,body_digest,session_hash,issued_at,payload_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[p.id,p.user_id,p.publication_id,p.edition,p.body_digest,p.session_hash,p.issued_at,p.payload_ciphertext]);
      if(!(await client.query<{live:boolean}>('SELECT $1::timestamptz>clock_timestamp() AS live',[r.row.retention_until])).rows[0].live)throw expired();
      await authorizeFixedSession(client,fixed,signal);signal?.throwIfAborted();return {publicationId:id,submissionId:r.row.submission_id,revision:r.journal.state.revision,bodyProjectionId:p.id,body:r.body,retentionUntil:r.row.retention_until.toISOString()};});}
  async act(context:FixedSessionContext,value:unknown,signal?:AbortSignal){const fixed=Object.freeze({...context}),request=parsed(()=>parseIntakeSafetyResourceCommand(value)),input=resourceCanonicalInput(request);
    return this.db.withBoundedTransaction(async client=>{
      const handling=request.action.kind==='continue_intake'||request.action.kind==='clarify_exaggeration';
      const authVersion=handling?await this.storage.authorizeSession(client,fixed,signal):null;
      const record=await this.readPublicationInTransaction(client,fixed,request.publicationId,signal),p=record.row,h=record.journal;
      const old=(await client.query<IntakeSafetyFollowupRow>('SELECT * FROM platform_onboarding_safety_v2_followups WHERE user_id=$1 AND operation_id=$2 FOR UPDATE',[fixed.userId,request.operationId])).rows[0];
      if(old){const capture=h.captures.get(old.operation_id);if(!capture||old.session_hash!==fixed.tokenHash||JSON.stringify(capture.request)!==JSON.stringify(input))throw conflict();
        await authorizeFixedSession(client,fixed,signal);signal?.throwIfAborted();return {state:await this.stateView(client,record),operation:{id:old.operation_id,appliedRevision:old.applied_revision,replayed:true}};}
      if(request.expectedPublicationRevision!==h.state.revision)throw changed();const live=(await client.query<{at:Date;live:boolean;evidence:boolean}>('SELECT clock_timestamp() AS at,$1::timestamptz>clock_timestamp() AS live,$2::timestamptz>clock_timestamp() AS evidence',[p.retention_until,p.evidence_retention_until])).rows[0];
      let token:string|undefined,projection:IntakeSafetyProjectionRow|undefined,present:IntakeSafetyFollowupRow|undefined,ack:IntakeSafetyFollowupRow|undefined;
      const action=request.action;
      if(action.kind==='present_body'){
        projection=h.projections.find(x=>x.id===action.bodyProjectionId&&x.session_hash===fixed.tokenHash);if(!projection)throw new ApiError(409,'SAFETY_DELIVERY_PRESENTATION_REQUIRED','Use your actual body display projection.');
        if(!live.live&&!live.evidence)throw expired();if(live.live)token=randomBytes(32).toString('base64url');
      }else if('presentationReceipt'in request.action){const digest=deliveryDigest(request.action.presentationReceipt);present=h.operations.find(x=>x.kind==='present_body'&&x.session_hash===fixed.tokenHash&&x.presentation_digest===digest);
        if(!present)throw new ApiError(409,'SAFETY_DELIVERY_PRESENTATION_REQUIRED','Present the exact resource body before acknowledging it.');projection=h.projections.find(x=>x.id===present!.body_projection_id);
        if(handling){ack=h.operations.find(x=>x.kind==='acknowledge'&&x.session_hash===fixed.tokenHash&&x.presentation_operation_id===present!.operation_id&&x.presentation_digest===digest);
          if(!ack)throw new ApiError(409,'SAFETY_DELIVERY_ACKNOWLEDGMENT_REQUIRED','Acknowledge this resource before explicitly continuing.');if(h.handled||await readLegacyHandledIntakeTargetInTransaction(client,this.storage,record.target.source))throw new ApiError(409,'SAFETY_DELIVERY_STATE_CHANGED','This source has already been explicitly handled.');}
        else if(!live.live)throw expired();
      }else if(!live.live)throw expired();
      const op:IntakeSafetyFollowupRow={user_id:fixed.userId,operation_id:request.operationId,publication_id:p.id,submission_id:p.submission_id,source_generation:p.source_generation,
        kind:request.action.kind==='present_body'&&!live.live?'present_body_evidence':request.action.kind,expected_revision:h.state.revision,applied_revision:h.state.revision+1,
        session_hash:fixed.tokenHash,body_projection_id:projection?.id??null,body_digest:projection?.body_digest??null,
        presentation_digest:token?deliveryDigest(token):present?.presentation_digest??null,presentation_operation_id:present?.operation_id??null,acknowledgment_operation_id:ack?.operation_id??null,
        presentation_kind:present?'present_body':null,acknowledgment_kind:ack?'acknowledge':null,handled:handling,clarified_at:request.action.kind==='clarify_exaggeration'?live.at:null,
        created_at:live.at,previous_digest:h.state.journal_digest,journal_digest:'',payload_ciphertext:Buffer.alloc(0)};
      const authority={authVersion,legalVersion:handling?this.storage.bundle!.version:null};op.journal_digest=followupDigest(op,input,authority);
      op.payload_ciphertext=sealDelivery(this.storage.crypto!,'platform_onboarding_safety_v2_followups',op.operation_id,op.user_id,op.applied_revision,followupCapture(op,input,authority));
      await client.query(`INSERT INTO platform_onboarding_safety_v2_followups(user_id,operation_id,publication_id,submission_id,source_generation,kind,expected_revision,applied_revision,session_hash,
        body_projection_id,body_digest,presentation_digest,presentation_operation_id,acknowledgment_operation_id,presentation_kind,acknowledgment_kind,handled,clarified_at,created_at,previous_digest,journal_digest,payload_ciphertext)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [op.user_id,op.operation_id,op.publication_id,op.submission_id,op.source_generation,op.kind,op.expected_revision,op.applied_revision,op.session_hash,op.body_projection_id,op.body_digest,
          op.presentation_digest,op.presentation_operation_id,op.acknowledgment_operation_id,op.presentation_kind,op.acknowledgment_kind,op.handled,op.clarified_at,op.created_at,op.previous_digest,op.journal_digest,op.payload_ciphertext]);
      if(handling)await client.query(`INSERT INTO platform_onboarding_safety_v2_handled(submission_id,user_id,source_generation,detector_revision,level,detector_mode,publication_id,operation_id,kind)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[p.submission_id,p.user_id,p.source_generation,p.detector_revision,p.level,p.detector_mode,p.id,op.operation_id,op.kind]);
      await writeIntakeSafetyState(client,this.storage.crypto!,p,{...h.state,revision:op.applied_revision,latest_operation_id:op.operation_id,journal_digest:op.journal_digest});
      record.journal=await readIntakeSafetyJournal(client,this.storage.crypto!,p,record.body);
      if(!handling&&op.kind!=='present_body_evidence'&&!(await client.query<{live:boolean}>('SELECT $1::timestamptz>clock_timestamp() AS live',[p.retention_until])).rows[0].live)throw expired();
      if(op.kind==='present_body_evidence'&&!(await client.query<{live:boolean}>('SELECT $1::timestamptz>clock_timestamp() AS live',[p.evidence_retention_until])).rows[0].live)throw expired();
      if(handling){
        await this.storage.authorizeSession(client,fixed,signal);
        const draftRow=await this.storage.row(client,fixed.userId);if(!draftRow||draftRow.id!==p.logical_draft_id)throw deliveryStorageUnavailable();
        const draft=this.storage.decode(draftRow),sources=await this.storage.recover(client,draft),handled=await this.storage.handledSources(client,draft,sources);
        const safety=this.storage.safetyState(sources,handled);
        if(safety.status==='clear'){
          let next=draft;
          if(draft.state==='safety_paused')next=resumeOnboardingDraft(draft,{expectedRevision:draft.revision,at:op.created_at.toISOString()});
          else if(draft.state==='safety_pending'){
            const current=sources.find(x=>x.operation_id===draft.pendingText!.id);
            if(!current||current.status!=='detected'||current.level!=='L0'||current.detector_mode!=='full')throw deliveryStorageUnavailable();
            next=resumeOnboardingDraft(draft,{expectedRevision:draft.revision,at:op.created_at.toISOString(),currentTextResult:this.storage.decodeResult(current)});
          }
          if(next!==draft){
            await this.storage.write(client,draft,next);
            await this.profiles.projectIntakeInTransaction(client,draft,next,authVersion!,signal);
          }
        }
      }
      await authorizeFixedSession(client,fixed,signal);signal?.throwIfAborted();return {state:await this.stateView(client,record),operation:{id:op.operation_id,appliedRevision:op.applied_revision,replayed:false},...(token?{presentationReceipt:token}:{})};
    });
  }
  /** Authentic source-specific handled fact only. Caller still owns all current execution admission. */
  async verifyHandledInTransaction(client:PoolClient,userId:string,submissionId:string,signal?:AbortSignal):Promise<boolean>{
    const t=await readIntakeResourceSourceInTransaction(client,this.storage.crypto,submissionId,signal);if(t.source.user_id!==userId)throw deliveryStorageUnavailable();
    const legacy=await readLegacyHandledIntakeTargetInTransaction(client,this.storage,t.source);
    const h=(await client.query<{publication_id:string}>('SELECT publication_id FROM platform_onboarding_safety_v2_handled WHERE submission_id=$1 AND user_id=$2 FOR SHARE',[submissionId,userId])).rows[0];if(!h)return legacy;
    const p=(await client.query<IntakeSafetyPublicationRow>('SELECT * FROM platform_onboarding_safety_v2_publications WHERE id=$1 AND user_id=$2 FOR UPDATE',[h.publication_id,userId])).rows[0];
    if(!p)throw deliveryStorageUnavailable();const original=await readIntakeResourceCaptureInTransaction(client,this.storage.crypto,submissionId,signal);if(!original)throw deliveryStorageUnavailable();
    const record=await this.decodePublication(client,p,original),journal=await readIntakeSafetyJournal(client,this.storage.crypto!,p,record.body);
    return !!journal.handled&&journal.operations.some(x=>x.handled&&x.operation_id===journal.handled!.operation_id);
  }
}
