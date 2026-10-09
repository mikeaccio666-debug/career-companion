import type {PoolClient} from 'pg';
import {careerRecordId as id,careerRecordObject as object} from '@companion/platform-contracts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import type {PlatformConfig} from './config.ts';
import {ApiError} from './errors.ts';
import {OnboardingStorage} from './onboarding-storage.ts';
import {readIntakeResourceCaptureInTransaction} from './onboarding-resource-source.ts';
import {readIntakePublicationCapture,decodeIntakePublicationOperation,decodeIntakeSafetyFollowup,bodyProjectionCapture,followupStateCapture,publicationGenesis,
 type IntakeSafetyPublicationRow,type IntakeSafetyProjectionRow,type IntakeSafetyFollowupRow,type IntakeSafetyStateRow,type PublicationOperation} from './onboarding-safety-delivery-protocol.ts';
import {deliveryDigest,deliveryRecord,openDelivery} from './safety-delivery-review.ts';
import {publicSafetyResponse} from './safety-response-view.ts';

export const INTAKE_DELIVERY_EXPORT_TABLES=Object.freeze(['platform_onboarding_delivery_v2_heads','platform_onboarding_delivery_v2_operations',
 'platform_onboarding_safety_v2_publications','platform_onboarding_safety_v2_body_projections','platform_onboarding_safety_v2_followup_states',
 'platform_onboarding_safety_v2_followups','platform_onboarding_safety_v2_handled','platform_onboarding_resource_cutovers'] as const);
export type IntakeDeliveryExportSection='intakeDeliveryHeads'|'intakeDeliveryOperations'|'intakeResourcePublications'|'intakeBodyProjections'|'intakeFollowupStates'|'intakeFollowups'|'intakeHandledSources'|'intakeResourceCutovers';
type Table=typeof INTAKE_DELIVERY_EXPORT_TABLES[number];type Row=Record<string,any>;
type Publication=Omit<IntakeSafetyPublicationRow,'payload_ciphertext'>;
const unavailable=()=>new ApiError(503,'ACCOUNT_INTAKE_DELIVERY_EXPORT_UNAVAILABLE','The original intake delivery history could not be confirmed.');
const at=(d:Date)=>{if(!(d instanceof Date)||!Number.isFinite(d.getTime()))throw unavailable();return d.toISOString();};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const keys:Record<Table,string>={platform_onboarding_delivery_v2_heads:'submission_id',platform_onboarding_delivery_v2_operations:'operation_id',
 platform_onboarding_safety_v2_publications:'id',platform_onboarding_safety_v2_body_projections:'id',platform_onboarding_safety_v2_followup_states:'publication_id',
 platform_onboarding_safety_v2_followups:'operation_id',platform_onboarding_safety_v2_handled:'submission_id',platform_onboarding_resource_cutovers:'draft_id'};
/** Pure private historical capture. Publication, display, acknowledgment and
 * explicit handling remain distinct; no live delivery/read/recovery service is called. */
export class AccountIntakeDeliveryExport {
 private readonly storage:OnboardingStorage;
 constructor(config:Pick<PlatformConfig,'dataCrypto'|'requireVerifiedEmail'>){this.storage=new OnboardingStorage(config,null);}
 private async *rows(client:PoolClient,owner:string,table:Table,signal?:AbortSignal,publicationId?:string){
  const key=publicationId&&table==='platform_onboarding_safety_v2_followups'?'applied_revision':keys[table],kind=key==='applied_revision'?'int':'uuid';let after:string|number|null=null;
  for(;;){signal?.throwIfAborted();const found:Row[]=(await client.query(`SELECT * FROM ${table} WHERE user_id=$1 AND ($2::${kind} IS NULL OR ${key}>$2)
    ${publicationId?'AND publication_id=$3':''} ORDER BY ${key} LIMIT 100`,publicationId?[owner,after,publicationId]:[owner,after])).rows;
   for(const row of found){signal?.throwIfAborted();if(row.user_id!==owner)throw unavailable();yield row;}
   if(found.length<100)break;after=found.at(-1)![key];
  }
 }
 async *exportInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal):AsyncGenerator<{section:IntakeDeliveryExportSection;record:unknown}>{
  const raw=object(value,['userId','tokenHash']),who=Object.freeze({userId:id(raw.userId),tokenHash:raw.tokenHash as string});
  if(typeof who.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(who.tokenHash))throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');
  await authorizeFixedSession(client,who,signal);
  try{
   const crypto=this.storage.crypto,publications=new Map<string,Publication>(),sources=new Map<string,{first:string|null;editions:Map<number,string>;latest:number}>();
   const handledOperations=new Map<string,Omit<IntakeSafetyFollowupRow,'payload_ciphertext'>>(),counts={states:0,projections:0,followups:0};
   // Only eight original source captures are cached; old sources are revalidated
   // if revisited, never omitted from the archive to limit memory use.
   const originals=new Map<string,NonNullable<Awaited<ReturnType<typeof readIntakeResourceCaptureInTransaction>>>>();
   for await(const row of this.rows(client,who.userId,'platform_onboarding_safety_v2_publications',signal)){
    if(!crypto)throw unavailable();const p=row as IntakeSafetyPublicationRow;
    let original=originals.get(p.submission_id);
    if(!original){original=await readIntakeResourceCaptureInTransaction(client,crypto,p.submission_id,signal,false)??undefined;if(!original)throw unavailable();
     if(originals.size>=8)originals.delete(originals.keys().next().value!);originals.set(p.submission_id,original);}
    const decoded=await readIntakePublicationCapture(client,this.storage,p,original,false),{payload_ciphertext:_cipher,...metadata}=p;
    if(publications.has(p.id))throw unavailable();publications.set(p.id,metadata);
    let source=sources.get(p.submission_id);if(!source){const anchor=(await client.query('SELECT first_safety_v2_publication_id FROM platform_onboarding_safety_submissions WHERE id=$1 AND user_id=$2',[p.submission_id,who.userId])).rows[0];if(!anchor)throw unavailable();source={first:anchor.first_safety_v2_publication_id,editions:new Map(),latest:0};sources.set(p.submission_id,source);}
    if(source.editions.has(p.edition))throw unavailable();source.editions.set(p.edition,p.id);source.latest=Math.max(source.latest,p.edition);
    yield {section:'intakeResourcePublications',record:{id:p.id,ownerId:p.user_id,submissionId:p.submission_id,responseId:p.response_id,draftId:p.logical_draft_id,
     sourceGeneration:p.source_generation,detectorRevision:p.detector_revision,level:p.level,detectorMode:p.detector_mode,edition:p.edition,publicationOperationId:p.publication_operation_id,
     assetId:p.asset_id,bodyDigest:p.body_digest,questionDigest:p.question_digest,locale:decoded.original.row.locale,response:publicSafetyResponse(decoded.response),
     preparedAt:at(p.prepared_at),publishedAt:at(p.published_at),retentionUntil:at(p.retention_until),evidenceRetentionUntil:at(p.evidence_retention_until)}};
    const states=(await client.query<IntakeSafetyStateRow>('SELECT * FROM platform_onboarding_safety_v2_followup_states WHERE publication_id=$1 AND user_id=$2',[p.id,who.userId])).rows;
    const state=states[0];if(states.length!==1||!same(openDelivery(crypto,'platform_onboarding_safety_v2_followup_states',p.id,who.userId,state.revision,state.payload_ciphertext),followupStateCapture(state,p)))throw unavailable();counts.states++;
    yield {section:'intakeFollowupStates',record:{publicationId:p.id,ownerId:who.userId,revision:state.revision,latestOperationId:state.latest_operation_id}};
    const projections=new Map<string,Omit<IntakeSafetyProjectionRow,'payload_ciphertext'>>();
    for await(const rawProjection of this.rows(client,who.userId,'platform_onboarding_safety_v2_body_projections',signal,p.id)){
     const r=rawProjection as IntakeSafetyProjectionRow;
     if(r.publication_id!==p.id||r.edition!==p.edition||r.body_digest!==p.body_digest||r.issued_at<p.published_at||r.issued_at>=p.retention_until
      ||!same(openDelivery(crypto,'platform_onboarding_safety_v2_body_projections',r.id,who.userId,1,r.payload_ciphertext),bodyProjectionCapture(r,decoded.body))||projections.has(r.id))throw unavailable();
     const {payload_ciphertext:_cipher,...links}=r;projections.set(r.id,links);counts.projections++;
     yield {section:'intakeBodyProjections',record:{id:r.id,ownerId:who.userId,publicationId:p.id,edition:r.edition,bodyDigest:r.body_digest,issuedAt:at(r.issued_at),body:decoded.body}};
    }
    const operations=new Map<string,Omit<IntakeSafetyFollowupRow,'payload_ciphertext'>>();let revision=0,digest=publicationGenesis(p),previousTime=p.published_at,latest:string|null=null;
    for await(const rawOperation of this.rows(client,who.userId,'platform_onboarding_safety_v2_followups',signal,p.id)){
     const r=rawOperation as IntakeSafetyFollowupRow;
     if(r.publication_id!==p.id||r.submission_id!==p.submission_id||r.source_generation!==p.source_generation||r.expected_revision!==revision||r.applied_revision!==revision+1
      ||r.previous_digest!==digest||r.created_at<previousTime||r.created_at<p.published_at||operations.has(r.operation_id))throw unavailable();
     const capture=decodeIntakeSafetyFollowup(crypto,p,r);
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
     yield {section:'intakeFollowups',record:{ownerId:who.userId,operationId:r.operation_id,publicationId:p.id,submissionId:p.submission_id,sourceGeneration:p.source_generation,
      kind:r.kind,expectedRevision:r.expected_revision,appliedRevision:r.applied_revision,bodyProjectionId:r.body_projection_id,bodyDigest:r.body_digest,
      presentationOperationId:r.presentation_operation_id,acknowledgmentOperationId:r.acknowledgment_operation_id,handled:r.handled,clarifiedAt:r.clarified_at?at(r.clarified_at):null,
      at:at(r.created_at),legalVersion:authority.legalVersion,request:{operationId:request.operationId,publicationId:request.publicationId,expectedPublicationRevision:request.expectedPublicationRevision,
       action:{kind:action.kind,...(action.kind==='present_body'?{bodyProjectionId:action.bodyProjectionId}:{}),...(action.kind==='clarify_exaggeration'?{safe:true,exaggeration:true}:{})}}}};
    }
    if(revision!==state.revision||latest!==state.latest_operation_id||digest!==state.journal_digest)throw unavailable();
   }
   const heads=new Set<string>();
   for await(const r of this.rows(client,who.userId,'platform_onboarding_delivery_v2_heads',signal)){
    if(!crypto)throw unavailable();const source=sources.get(r.submission_id),first=source?.editions.get(1),latest=source?.editions.get(r.revision),p=publications.get(latest??'');
    const capture={schemaVersion:1,submissionId:r.submission_id,userId:r.user_id,sourceGeneration:r.source_generation,detectorRevision:r.detector_revision,level:r.level,mode:r.detector_mode,revision:r.revision,latestPublicationId:r.latest_publication_id};
    if(!source||!p||source.editions.size!==r.revision||source.latest!==r.revision||source.first!==first||r.latest_publication_id!==latest
     ||r.source_generation!==p.source_generation||r.detector_revision!==p.detector_revision||r.level!==p.level||r.detector_mode!==p.detector_mode
     ||!same(openDelivery(crypto,'platform_onboarding_delivery_v2_heads',r.submission_id,who.userId,r.revision,r.payload_ciphertext),capture)||heads.has(r.submission_id))throw unavailable();
    heads.add(r.submission_id);yield {section:'intakeDeliveryHeads',record:capture};
   }
   if(heads.size!==sources.size)throw unavailable();
   const creators=new Set<string>();
   for await(const row of this.rows(client,who.userId,'platform_onboarding_delivery_v2_operations',signal)){
    const r=row as PublicationOperation,p=publications.get(r.publication_id);if(!p||r.submission_id!==p.submission_id||r.source_generation!==p.source_generation||r.created_at<p.published_at)throw unavailable();
    const request=decodeIntakePublicationOperation(this.storage,r),creator=r.operation_id===p.publication_operation_id;
    if(creator){if(r.expected_edition!==p.edition-1||at(r.created_at)!==at(p.published_at)||creators.has(p.id))throw unavailable();creators.add(p.id);}
    else if(r.expected_edition!==p.edition&&!(r.kind==='publish'&&r.expected_edition===0))throw unavailable();
    yield {section:'intakeDeliveryOperations',record:{ownerId:who.userId,operationId:r.operation_id,submissionId:r.submission_id,sourceGeneration:r.source_generation,publicationId:r.publication_id,
     kind:r.kind,expectedEdition:r.expected_edition,at:at(r.created_at),request}};
   }
   if(creators.size!==publications.size)throw unavailable();
   const handled=new Set<string>();
   for await(const r of this.rows(client,who.userId,'platform_onboarding_safety_v2_handled',signal)){
    const op=handledOperations.get(r.submission_id),p=publications.get(r.publication_id);
    if(!op||!p||op.operation_id!==r.operation_id||op.publication_id!==r.publication_id||op.kind!==r.kind||p.submission_id!==r.submission_id||p.source_generation!==r.source_generation
     ||p.detector_revision!==r.detector_revision||p.level!==r.level||p.detector_mode!==r.detector_mode||handled.has(r.submission_id))throw unavailable();handled.add(r.submission_id);
    yield {section:'intakeHandledSources',record:{ownerId:who.userId,submissionId:r.submission_id,sourceGeneration:r.source_generation,detectorRevision:r.detector_revision,level:r.level,
     detectorMode:r.detector_mode,publicationId:r.publication_id,operationId:r.operation_id,kind:r.kind}};
   }
   if(handled.size!==handledOperations.size)throw unavailable();
   const cutovers=new Set<string>();
   for await(const r of this.rows(client,who.userId,'platform_onboarding_resource_cutovers',signal)){
    if(!crypto)throw unavailable();const raw=openDelivery(crypto,'platform_onboarding_resource_cutovers',r.draft_id,who.userId,1,r.payload_ciphertext),d=deliveryRecord(raw,['schemaVersion','userId','draftId','recordedAt','legacyDigest','legacy']);
    const legacy=(await client.query<{id:string;value:string}>('SELECT p.id,row_to_json(p)::text AS value FROM platform_onboarding_safety_publications p WHERE p.user_id=$1 AND p.draft_id=$2 ORDER BY p.id',[who.userId,r.draft_id])).rows.map(row=>({id:row.id,transportDigest:deliveryDigest(row.value)}));
    const capture={schemaVersion:1,userId:who.userId,draftId:r.draft_id,recordedAt:at(r.recorded_at),legacyDigest:deliveryDigest(JSON.stringify(legacy)),legacy};
    if(!same(raw,capture)||r.legacy_digest!==capture.legacyDigest||!same(d.legacy,legacy)||cutovers.has(r.draft_id))throw unavailable();cutovers.add(r.draft_id);
    yield {section:'intakeResourceCutovers',record:capture};
   }
   for(const p of publications.values())if(!cutovers.has(p.logical_draft_id))throw unavailable();
   // Catch missing entire roots or foreign-owned child rows; pagination alone
   // cannot prove coverage of indirectly attached state/projection/history tables.
   const audit=(await client.query(`SELECT
    (SELECT count(*)::int FROM platform_onboarding_safety_v2_followup_states WHERE user_id=$1) AS states,
    (SELECT count(*)::int FROM platform_onboarding_safety_v2_body_projections WHERE user_id=$1) AS projections,
    (SELECT count(*)::int FROM platform_onboarding_safety_v2_followups WHERE user_id=$1) AS followups,
    EXISTS(SELECT 1 FROM platform_onboarding_safety_submissions s LEFT JOIN platform_onboarding_delivery_v2_heads h ON h.submission_id=s.id AND h.user_id=s.user_id
      WHERE s.user_id=$1 AND s.first_safety_v2_publication_id IS NOT NULL AND h.submission_id IS NULL) AS missing_head,
    EXISTS(SELECT 1 FROM platform_onboarding_drafts d FULL JOIN platform_onboarding_resource_cutovers c ON c.draft_id=d.id AND c.user_id=d.user_id
      WHERE (d.user_id=$1 OR c.user_id=$1) AND (d.safety_resource_v2_draft_id IS DISTINCT FROM c.draft_id)) AS bad_cutover,
    EXISTS(SELECT 1 FROM platform_onboarding_safety_v2_followups WHERE user_id=$1 AND created_at>clock_timestamp()
     UNION ALL SELECT 1 FROM platform_onboarding_safety_v2_body_projections WHERE user_id=$1 AND issued_at>clock_timestamp()
     UNION ALL SELECT 1 FROM platform_onboarding_delivery_v2_operations WHERE user_id=$1 AND created_at>clock_timestamp()
     UNION ALL SELECT 1 FROM platform_onboarding_resource_cutovers WHERE user_id=$1 AND recorded_at>clock_timestamp()) AS future`,[who.userId])).rows[0];
   if(audit.states!==counts.states||audit.projections!==counts.projections||audit.followups!==counts.followups||audit.missing_head||audit.bad_cutover||audit.future)throw unavailable();
  }catch{signal?.throwIfAborted();throw unavailable();}
  await authorizeFixedSession(client,who,signal);signal?.throwIfAborted();
 }
}
