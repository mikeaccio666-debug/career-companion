import {readNameResourceSourceInTransaction} from './companion-name-resource-source.ts';
import type {CompanionNameSafetyResponseRow} from './companion-name-safety-response-outbox.ts';
import type {PoolClient} from 'pg';
import {careerRecordId as id,careerRecordObject as object} from '@companion/platform-contracts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import type {PlatformConfig} from './config.ts';
import {ApiError} from './errors.ts';
import {OnboardingStorage} from './onboarding-storage.ts';
import {readNameOriginalCaptureInTransaction,readNameSafetyResponseRecord} from './companion-name-safety-responses.ts';
import {readNamePublicationCapture,decodeNamePublicationOperation,decodeNameSafetyFollowup,bodyProjectionCapture,followupStateCapture,publicationGenesis,
 type NameSafetyPublicationRow,type NameSafetyProjectionRow,type NameSafetyFollowupRow,type NameSafetyStateRow,type PublicationOperation} from './companion-name-safety-delivery-protocol.ts';
import {openDelivery} from './safety-delivery-review.ts';
import {publicSafetyResponse} from './safety-response-view.ts';

export const NAME_DELIVERY_EXPORT_TABLES=Object.freeze(['platform_companion_name_safety_responses','platform_companion_name_delivery_heads','platform_companion_name_delivery_operations',
 'platform_companion_name_safety_publications','platform_companion_name_safety_body_projections','platform_companion_name_safety_followup_states',
 'platform_companion_name_safety_followups','platform_companion_name_safety_handled'] as const);
export type NameDeliveryExportSection='nameSafetyResponses'|'nameDeliveryHeads'|'nameDeliveryOperations'|'nameResourcePublications'|'nameBodyProjections'|'nameFollowupStates'|'nameFollowups'|'nameHandledSources';
type Table=typeof NAME_DELIVERY_EXPORT_TABLES[number];type Row=Record<string,any>;
type Publication=Omit<NameSafetyPublicationRow,'payload_ciphertext'>;
const unavailable=()=>new ApiError(503,'ACCOUNT_NAME_DELIVERY_EXPORT_UNAVAILABLE','The original name delivery history could not be confirmed.');
const at=(d:Date)=>{if(!(d instanceof Date)||!Number.isFinite(d.getTime()))throw unavailable();return d.toISOString();};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const keys:Record<Table,string>={platform_companion_name_safety_responses:'id',platform_companion_name_delivery_heads:'submission_id',platform_companion_name_delivery_operations:'operation_id',
 platform_companion_name_safety_publications:'id',platform_companion_name_safety_body_projections:'id',platform_companion_name_safety_followup_states:'publication_id',
 platform_companion_name_safety_followups:'operation_id',platform_companion_name_safety_handled:'submission_id'};
/** Pure private historical capture. Publication, display, acknowledgment and
 * explicit handling remain distinct; no live delivery/read/recovery service is called. */
export class AccountNameDeliveryExport {
 private readonly storage:OnboardingStorage;
 constructor(config:Pick<PlatformConfig,'dataCrypto'|'requireVerifiedEmail'>){this.storage=new OnboardingStorage(config,null);}
 private async *rows(client:PoolClient,owner:string,table:Table,signal?:AbortSignal,publicationId?:string){
  const key=publicationId&&table==='platform_companion_name_safety_followups'?'applied_revision':keys[table],kind=key==='applied_revision'?'int':'uuid';let after:string|number|null=null;
  for(;;){signal?.throwIfAborted();const found:Row[]=(await client.query(`SELECT * FROM ${table} WHERE user_id=$1 AND ($2::${kind} IS NULL OR ${key}>$2)
    ${publicationId?'AND publication_id=$3':''} ORDER BY ${key} LIMIT 100`,publicationId?[owner,after,publicationId]:[owner,after])).rows;
   for(const row of found){signal?.throwIfAborted();if(row.user_id!==owner)throw unavailable();yield row;}
   if(found.length<100)break;after=found.at(-1)![key];
  }
 }
 async *exportInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal):AsyncGenerator<{section:NameDeliveryExportSection;record:unknown}>{
  const raw=object(value,['userId','tokenHash']),who=Object.freeze({userId:id(raw.userId),tokenHash:raw.tokenHash as string});
  if(typeof who.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(who.tokenHash))throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');
  await authorizeFixedSession(client,who,signal);
  try{
   const crypto=this.storage.crypto,publications=new Map<string,Publication>(),sources=new Map<string,{first:string|null;editions:Map<number,string>;latest:number}>();
   const handledOperations=new Map<string,Omit<NameSafetyFollowupRow,'payload_ciphertext'>>(),counts={states:0,projections:0,followups:0};
   // Only eight original source captures are cached; old sources are revalidated
   // if revisited, never omitted from the archive to limit memory use.
   const originals=new Map<string,NonNullable<Awaited<ReturnType<typeof readNameOriginalCaptureInTransaction>>>>();
   const responseIds=new Set<string>();
   for await(const rawResponse of this.rows(client,who.userId,'platform_companion_name_safety_responses',signal)){
    if(!crypto)throw unavailable();const r=rawResponse as CompanionNameSafetyResponseRow;
    const target=await readNameResourceSourceInTransaction(client,crypto,r.submission_id,signal,false);
    if(target.source.user_id!==who.userId||responseIds.has(r.id)||!['pending','ready'].includes(r.status))throw unavailable();
    const capture=await readNameSafetyResponseRecord(client,crypto,r,target,signal,false);
    if(r.prepared_at&&(r.prepared_at<r.created_at||!r.retention_until||r.retention_until<=r.prepared_at))throw unavailable();
    if(r.status==='pending'&&[r.payload_ciphertext,r.bundle_revision,r.content_digest,r.review_digest,r.locale,r.locale_origin,r.prepared_at,r.retention_until].some(x=>x!==null))throw unavailable();
    responseIds.add(r.id);
    yield {section:'nameSafetyResponses',record:{id:r.id,ownerId:who.userId,submissionId:r.submission_id,operationId:r.operation_id,entryId:r.entry_id,
     taskId:r.task_id,companionId:r.companion_id,previewRevision:r.preview_revision,submittedRevision:r.submitted_revision,expectedIdentityRevision:r.expected_identity_revision,
     sourceGeneration:r.source_generation,detectorRevision:r.detector_revision,level:r.level,detectorMode:r.detector_mode,status:r.status,bundleRevision:r.bundle_revision,
     contentDigest:r.content_digest,reviewDigest:r.review_digest,locale:r.locale,localeOrigin:r.locale_origin,localeProof:capture?.localeProof??null,
     response:capture?publicSafetyResponse(capture.response):null,createdAt:at(r.created_at),preparedAt:r.prepared_at?at(r.prepared_at):null,retentionUntil:r.retention_until?at(r.retention_until):null}};
   }
   for await(const row of this.rows(client,who.userId,'platform_companion_name_safety_publications',signal)){
    if(!crypto)throw unavailable();const p=row as NameSafetyPublicationRow;
    let original=originals.get(p.submission_id);
    if(!original){original=await readNameOriginalCaptureInTransaction(client,crypto,p.submission_id,signal,false)??undefined;if(!original)throw unavailable();
     if(originals.size>=8)originals.delete(originals.keys().next().value!);originals.set(p.submission_id,original);}
    const decoded=await readNamePublicationCapture(client,crypto,p,original,false),{payload_ciphertext:_cipher,...metadata}=p;
    if(publications.has(p.id)||!responseIds.has(p.response_id))throw unavailable();publications.set(p.id,metadata);
    let source=sources.get(p.submission_id);if(!source){const anchor=(await client.query('SELECT first_safety_publication_id FROM platform_companion_name_submissions WHERE id=$1 AND user_id=$2',[p.submission_id,who.userId])).rows[0];if(!anchor)throw unavailable();source={first:anchor.first_safety_publication_id,editions:new Map(),latest:0};sources.set(p.submission_id,source);}
    if(source.editions.has(p.edition))throw unavailable();source.editions.set(p.edition,p.id);source.latest=Math.max(source.latest,p.edition);
    yield {section:'nameResourcePublications',record:{id:p.id,ownerId:p.user_id,submissionId:p.submission_id,responseId:p.response_id,draftId:p.logical_draft_id,
     sourceGeneration:p.source_generation,detectorRevision:p.detector_revision,level:p.level,detectorMode:p.detector_mode,edition:p.edition,publicationOperationId:p.publication_operation_id,
     assetId:p.asset_id,bodyDigest:p.body_digest,questionDigest:p.question_digest,locale:decoded.original.row.locale,response:publicSafetyResponse(decoded.response),
     preparedAt:at(p.prepared_at),publishedAt:at(p.published_at),retentionUntil:at(p.retention_until),evidenceRetentionUntil:at(p.evidence_retention_until)}};
    const states=(await client.query<NameSafetyStateRow>('SELECT * FROM platform_companion_name_safety_followup_states WHERE publication_id=$1 AND user_id=$2',[p.id,who.userId])).rows;
    const state=states[0];if(states.length!==1||!same(openDelivery(crypto,'platform_companion_name_safety_followup_states',p.id,who.userId,state.revision,state.payload_ciphertext),followupStateCapture(state,p)))throw unavailable();counts.states++;
    yield {section:'nameFollowupStates',record:{publicationId:p.id,ownerId:who.userId,revision:state.revision,latestOperationId:state.latest_operation_id}};
    const projections=new Map<string,Omit<NameSafetyProjectionRow,'payload_ciphertext'>>();
    for await(const rawProjection of this.rows(client,who.userId,'platform_companion_name_safety_body_projections',signal,p.id)){
     const r=rawProjection as NameSafetyProjectionRow;
     if(r.publication_id!==p.id||r.edition!==p.edition||r.body_digest!==p.body_digest||r.issued_at<p.published_at||r.issued_at>=p.retention_until
      ||!same(openDelivery(crypto,'platform_companion_name_safety_body_projections',r.id,who.userId,1,r.payload_ciphertext),bodyProjectionCapture(r,decoded.body))||projections.has(r.id))throw unavailable();
     const {payload_ciphertext:_cipher,...links}=r;projections.set(r.id,links);counts.projections++;
     yield {section:'nameBodyProjections',record:{id:r.id,ownerId:who.userId,publicationId:p.id,edition:r.edition,bodyDigest:r.body_digest,issuedAt:at(r.issued_at),body:decoded.body}};
    }
    const operations=new Map<string,Omit<NameSafetyFollowupRow,'payload_ciphertext'>>();let revision=0,digest=publicationGenesis(p),previousTime=p.published_at,latest:string|null=null;
    for await(const rawOperation of this.rows(client,who.userId,'platform_companion_name_safety_followups',signal,p.id)){
     const r=rawOperation as NameSafetyFollowupRow;
     if(r.publication_id!==p.id||r.submission_id!==p.submission_id||r.source_generation!==p.source_generation||r.expected_revision!==revision||r.applied_revision!==revision+1
      ||r.previous_digest!==digest||r.created_at<previousTime||r.created_at<p.published_at||operations.has(r.operation_id))throw unavailable();
     const capture=decodeNameSafetyFollowup(crypto,p,r);
     if(r.kind==='present_body_evidence'){if(r.created_at<p.retention_until||r.created_at>=p.evidence_retention_until)throw unavailable();}
     else if(!r.handled&&r.created_at>=p.retention_until)throw unavailable();
     if(r.kind!=='need_support'){
      const projection=projections.get(r.body_projection_id!);
      if(!projection||projection.session_hash!==r.session_hash||projection.body_digest!==r.body_digest||projection.issued_at>r.created_at)throw unavailable();
      if(r.kind!=='present_body'&&r.kind!=='present_body_evidence'){
       const present=operations.get(r.presentation_operation_id!);
       if(!present||present.kind!=='present_body'||present.session_hash!==r.session_hash||present.body_projection_id!==r.body_projection_id||present.presentation_digest!==r.presentation_digest)throw unavailable();
       if(r.handled){const ack=operations.get(r.acknowledgment_operation_id!);if(!ack||ack.kind!=='acknowledge'||ack.session_hash!==r.session_hash
        ||ack.presentation_operation_id!==present.operation_id||ack.body_projection_id!==present.body_projection_id||ack.presentation_digest!==present.presentation_digest)throw unavailable();}
      }
     }
     const {payload_ciphertext:_cipher,...links}=r;operations.set(r.operation_id,links);
     if(r.handled){if(handledOperations.has(p.submission_id))throw unavailable();handledOperations.set(p.submission_id,links);}
     revision++;digest=r.journal_digest;previousTime=r.created_at;latest=r.operation_id;counts.followups++;
     const request=capture.request as Row,action=request.action as Row,authority=capture.authority as Row;
     yield {section:'nameFollowups',record:{ownerId:who.userId,operationId:r.operation_id,publicationId:p.id,submissionId:p.submission_id,sourceGeneration:p.source_generation,
      kind:r.kind,expectedRevision:r.expected_revision,appliedRevision:r.applied_revision,bodyProjectionId:r.body_projection_id,bodyDigest:r.body_digest,
      presentationOperationId:r.presentation_operation_id,acknowledgmentOperationId:r.acknowledgment_operation_id,handled:r.handled,clarifiedAt:r.clarified_at?at(r.clarified_at):null,
      at:at(r.created_at),legalVersion:authority.legalVersion,request:{operationId:request.operationId,publicationId:request.publicationId,expectedPublicationRevision:request.expectedPublicationRevision,
       action:{kind:action.kind,...(action.kind==='present_body'?{bodyProjectionId:action.bodyProjectionId}:{}),...(action.kind==='clarify_exaggeration'?{safe:true,exaggeration:true}:{})}}}};
    }
    if(revision!==state.revision||latest!==state.latest_operation_id||digest!==state.journal_digest)throw unavailable();
   }
   const heads=new Set<string>();
   for await(const r of this.rows(client,who.userId,'platform_companion_name_delivery_heads',signal)){
    if(!crypto)throw unavailable();const source=sources.get(r.submission_id),first=source?.editions.get(1),latest=source?.editions.get(r.revision),p=publications.get(latest??'');
    const capture={schemaVersion:1,submissionId:r.submission_id,userId:r.user_id,sourceGeneration:r.source_generation,detectorRevision:r.detector_revision,level:r.level,mode:r.detector_mode,revision:r.revision,latestPublicationId:r.latest_publication_id};
    if(!source||!p||source.editions.size!==r.revision||source.latest!==r.revision||source.first!==first||r.latest_publication_id!==latest
     ||r.source_generation!==p.source_generation||r.detector_revision!==p.detector_revision||r.level!==p.level||r.detector_mode!==p.detector_mode
     ||!same(openDelivery(crypto,'platform_companion_name_delivery_heads',r.submission_id,who.userId,r.revision,r.payload_ciphertext),capture)||heads.has(r.submission_id))throw unavailable();
    heads.add(r.submission_id);yield {section:'nameDeliveryHeads',record:capture};
   }
   if(heads.size!==sources.size)throw unavailable();
   const creators=new Set<string>();
   for await(const row of this.rows(client,who.userId,'platform_companion_name_delivery_operations',signal)){
    const r=row as PublicationOperation,p=publications.get(r.publication_id);if(!p||r.submission_id!==p.submission_id||r.source_generation!==p.source_generation||r.created_at<p.published_at)throw unavailable();
    const request=decodeNamePublicationOperation(crypto!,r),creator=r.operation_id===p.publication_operation_id;
    if(creator){if(r.expected_edition!==p.edition-1||at(r.created_at)!==at(p.published_at)||creators.has(p.id))throw unavailable();creators.add(p.id);}
    else if(r.expected_edition!==p.edition&&!(r.kind==='publish'&&r.expected_edition===0))throw unavailable();
    yield {section:'nameDeliveryOperations',record:{ownerId:who.userId,operationId:r.operation_id,submissionId:r.submission_id,sourceGeneration:r.source_generation,publicationId:r.publication_id,
     kind:r.kind,expectedEdition:r.expected_edition,at:at(r.created_at),request}};
   }
   if(creators.size!==publications.size)throw unavailable();
   const handled=new Set<string>();
   for await(const r of this.rows(client,who.userId,'platform_companion_name_safety_handled',signal)){
    const op=handledOperations.get(r.submission_id),p=publications.get(r.publication_id);
    if(!op||!p||op.operation_id!==r.operation_id||op.publication_id!==r.publication_id||op.kind!==r.kind||p.submission_id!==r.submission_id||p.source_generation!==r.source_generation
     ||p.detector_revision!==r.detector_revision||p.level!==r.level||p.detector_mode!==r.detector_mode||handled.has(r.submission_id))throw unavailable();handled.add(r.submission_id);
    yield {section:'nameHandledSources',record:{ownerId:who.userId,submissionId:r.submission_id,sourceGeneration:r.source_generation,detectorRevision:r.detector_revision,level:r.level,
     detectorMode:r.detector_mode,publicationId:r.publication_id,operationId:r.operation_id,kind:r.kind}};
   }
   if(handled.size!==handledOperations.size)throw unavailable();
   // Catch missing entire roots or foreign-owned child rows; pagination alone
   // cannot prove coverage of indirectly attached state/projection/history tables.
   const audit=(await client.query(`SELECT
    (SELECT count(*)::int FROM platform_companion_name_safety_responses WHERE user_id=$1) AS responses,
    EXISTS(SELECT 1 FROM platform_companion_name_submissions s LEFT JOIN platform_companion_name_safety_responses r ON r.submission_id=s.id AND r.user_id=s.user_id
      WHERE s.user_id=$1 AND s.status='detected' AND s.level IN ('L1','L2') AND r.id IS NULL) AS missing_response,
    (SELECT count(*)::int FROM platform_companion_name_safety_followup_states WHERE user_id=$1) AS states,
    (SELECT count(*)::int FROM platform_companion_name_safety_body_projections WHERE user_id=$1) AS projections,
    (SELECT count(*)::int FROM platform_companion_name_safety_followups WHERE user_id=$1) AS followups,
    EXISTS(SELECT 1 FROM platform_companion_name_submissions s LEFT JOIN platform_companion_name_delivery_heads h ON h.submission_id=s.id AND h.user_id=s.user_id
      WHERE s.user_id=$1 AND s.first_safety_publication_id IS NOT NULL AND h.submission_id IS NULL) AS missing_head,
    EXISTS(SELECT 1 FROM platform_companion_name_safety_responses WHERE user_id=$1 AND created_at>clock_timestamp()
     UNION ALL SELECT 1 FROM platform_companion_name_safety_followups WHERE user_id=$1 AND created_at>clock_timestamp()
     UNION ALL SELECT 1 FROM platform_companion_name_safety_body_projections WHERE user_id=$1 AND issued_at>clock_timestamp()
     UNION ALL SELECT 1 FROM platform_companion_name_delivery_operations WHERE user_id=$1 AND created_at>clock_timestamp()) AS future`,[who.userId])).rows[0];
   if(audit.responses!==responseIds.size||audit.missing_response||audit.states!==counts.states||audit.projections!==counts.projections||audit.followups!==counts.followups||audit.missing_head||audit.future)throw unavailable();
  }catch{signal?.throwIfAborted();throw unavailable();}
  await authorizeFixedSession(client,who,signal);signal?.throwIfAborted();
 }
}
