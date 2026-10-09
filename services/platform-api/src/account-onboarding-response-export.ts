import type {PoolClient} from 'pg';
import {careerRecordId as id,careerRecordObject as object,type OnboardingDraft} from '@companion/platform-contracts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import type {PlatformConfig} from './config.ts';
import {ApiError} from './errors.ts';
import {OnboardingStorage} from './onboarding-storage.ts';
import {decodeSafetyResponse,publicSafetyResponse} from './onboarding-safety-responses.ts';
import type {SafetyResponseRow} from './onboarding-safety-response-outbox.ts';
import {captureSafetyPublication,captureFollowup,type SafetyPublicationRow,type SafetyFollowupRow} from './onboarding-safety-followup-protocol.ts';

export const ONBOARDING_RESPONSE_EXPORT_TABLES=Object.freeze(['platform_onboarding_safety_responses','platform_onboarding_safety_publications','platform_onboarding_safety_followups'] as const);
export type OnboardingResponseExportSection='onboardingSafetyResponses'|'onboardingSafetyPublications'|'onboardingSafetyFollowups';
/** Already authenticated private intake sections from this same archive transaction.
 * This is internal composition, not a request-supplied source or execution grant. */
export interface OnboardingResponseArchive {readonly drafts:readonly unknown[];readonly submissions:readonly unknown[]}
type Row=Record<string,any>;
const unavailable=()=>new ApiError(503,'ACCOUNT_ONBOARDING_RESPONSE_EXPORT_UNAVAILABLE','The retained intake response history could not be confirmed.');
function at(value:unknown){if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw unavailable();return value.toISOString();}

/** Export retained history, including expired resources, without recovery, new
 * publication, current policy lookup, or a user acknowledgment manufactured by read. */
export class AccountOnboardingResponseExport {
 private readonly storage:OnboardingStorage;
 constructor(config:Pick<PlatformConfig,'dataCrypto'|'requireVerifiedEmail'>){this.storage=new OnboardingStorage(config,null);}
 private async *rows(client:PoolClient,owner:string,table:typeof ONBOARDING_RESPONSE_EXPORT_TABLES[number],signal?:AbortSignal){
  const key=table==='platform_onboarding_safety_followups'?'operation_id':'id';let after:string|null=null;
  for(;;){signal?.throwIfAborted();const found:Row[]=(await client.query(`SELECT * FROM ${table} WHERE user_id=$1 AND ($2::uuid IS NULL OR ${key}>$2) ORDER BY ${key} LIMIT 100`,[owner,after])).rows;
   for(const row of found){signal?.throwIfAborted();if(row.user_id!==owner)throw unavailable();id(row[key]);yield row;}
   if(found.length<100)break;after=id(found.at(-1)![key]);
  }
 }
 async *exportInTransaction(client:PoolClient,value:FixedSessionContext,archive:OnboardingResponseArchive,signal?:AbortSignal):AsyncGenerator<{section:OnboardingResponseExportSection;record:unknown}>{
  const raw=object(value,['userId','tokenHash']),who=Object.freeze({userId:id(raw.userId),tokenHash:raw.tokenHash as string});
  if(typeof who.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(who.tokenHash))throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');
  await authorizeFixedSession(client,who,signal);
  try{
   const drafts=new Map(archive.drafts.map(value=>{const draft=value as OnboardingDraft;if(draft.userId!==who.userId)throw unavailable();return [draft.id,draft] as const;}));
   const sources=new Map(archive.submissions.map(value=>{const source=value as Row;if(source.ownerId!==who.userId||!drafts.has(source.draftId))throw unavailable();return [source.id,source] as const;}));
   const responses=new Map<string,{row:Omit<SafetyResponseRow,'payload_ciphertext'>;response:ReturnType<typeof decodeSafetyResponse>|null}>(),sourceIds=new Set<string>();
   for await(const rawRow of this.rows(client,who.userId,'platform_onboarding_safety_responses',signal)){
    const row=rawRow as SafetyResponseRow,source=sources.get(row.submission_id),result=source?.result;
    if(!source||source.status!=='detected'||!result||!['L1','L2'].includes(row.level)||!['pending','ready'].includes(row.status)
     ||row.operation_id!==source.operationId||row.draft_id!==source.draftId||row.question_id!==source.questionId
     ||row.submitted_revision!==source.submittedRevision||row.source_generation!==source.generation||row.detector_revision!==source.detectorRevision
     ||row.level!==source.level||row.detector_mode!==source.detectorMode||result.level!==row.level||result.mode!==row.detector_mode
     ||result.textId!==row.operation_id||result.submittedAtRevision!==row.submitted_revision||result.detectorRevision!==row.detector_revision
     ||sourceIds.has(row.submission_id)||responses.has(row.id))throw unavailable();
    const events=(await client.query(`SELECT id,user_id,source_kind,submission_id,response_id,event_kind,level,detector_revision,detector_mode,created_at,retention_until
      FROM platform_safety_events WHERE response_id=$1`,[row.id])).rows;
    let response:ReturnType<typeof decodeSafetyResponse>|null=null,preparedEvent:unknown=null;
    if(row.status==='pending'){
     if(events.length||[row.payload_ciphertext,row.bundle_revision,row.content_digest,row.review_digest,row.locale,row.prepared_at,row.retention_until].some(x=>x!==null))throw unavailable();
    }else{
     const event=events[0];
     if(events.length!==1||event.user_id!==who.userId||event.submission_id!==row.submission_id||event.response_id!==row.id
      ||event.source_kind!=='onboarding'||event.event_kind!=='response_prepared'||event.level!==row.level||event.detector_revision!==row.detector_revision
      ||event.detector_mode!==row.detector_mode||at(event.created_at)!==at(row.prepared_at)||at(event.retention_until)!==at(row.retention_until)
      ||row.prepared_at!<row.created_at||row.retention_until!<=row.prepared_at!)throw unavailable();
     response=decodeSafetyResponse(this.storage,row);
     preparedEvent={id:id(event.id),kind:event.event_kind,createdAt:at(event.created_at),retentionUntil:at(event.retention_until)};
    }
    const {payload_ciphertext: _cipher,...metadata}=row;
    sourceIds.add(row.submission_id);responses.set(row.id,{row:metadata,response});
    yield {section:'onboardingSafetyResponses',record:{id:row.id,ownerId:who.userId,submissionId:row.submission_id,operationId:row.operation_id,draftId:row.draft_id,
     questionId:row.question_id,submittedRevision:row.submitted_revision,sourceGeneration:row.source_generation,detectorRevision:row.detector_revision,
     level:row.level,detectorMode:row.detector_mode,status:row.status,bundleRevision:row.bundle_revision,contentDigest:row.content_digest,reviewDigest:row.review_digest,
     locale:row.locale,createdAt:at(row.created_at),preparedAt:row.prepared_at===null?null:at(row.prepared_at),retentionUntil:row.retention_until===null?null:at(row.retention_until),
     response:response?publicSafetyResponse(response):null,preparedEvent}};
   }
   for(const source of sources.values())if(source.status==='detected'&&source.level!=='L0'&&!sourceIds.has(source.id))throw unavailable();
   const publications=new Map<string,Omit<SafetyPublicationRow,'payload_ciphertext'>>();
   for await(const rawRow of this.rows(client,who.userId,'platform_onboarding_safety_publications',signal)){
    const row=rawRow as SafetyPublicationRow,source=responses.get(row.response_id);
    if(!source?.response||source.row.status!=='ready'||row.draft_id!==source.row.draft_id||row.submission_id!==source.row.submission_id
     ||row.source_generation!==source.row.source_generation||at(row.retention_until)!==at(source.row.retention_until)||row.published_at<source.row.prepared_at!
     ||row.retention_until<=row.published_at||publications.has(row.id))throw unavailable();
    const saved=captureSafetyPublication(this.storage,row,{row:source.row,response:source.response});const {payload_ciphertext: _cipher,...metadata}=row;publications.set(row.id,metadata);
    yield {section:'onboardingSafetyPublications',record:saved};
   }
   // Keep only relationship metadata for the second-pass chain check. Ciphertext
   // and session/digest credentials are used locally, never placed in output.
   const operations=new Map<string,Omit<SafetyFollowupRow,'payload_ciphertext'>>();
   for await(const rawRow of this.rows(client,who.userId,'platform_onboarding_safety_followups',signal)){
    const row=rawRow as SafetyFollowupRow,draft=drafts.get(row.draft_id),publication=publications.get(row.publication_id);
    if(!draft||!publication||publication.draft_id!==row.draft_id||row.applied_revision>draft.revision||row.expected_revision>row.applied_revision
     ||row.created_at<publication.published_at||!row.handled&&row.created_at>=publication.retention_until||operations.has(row.operation_id))throw unavailable();
    const saved=captureFollowup(this.storage,row),{payload_ciphertext,...links}=row;operations.set(row.operation_id,links);
    yield {section:'onboardingSafetyFollowups',record:{schemaVersion:saved.schemaVersion,operationId:saved.operationId,userId:saved.userId,draftId:saved.draftId,
     publicationId:saved.publicationId,kind:saved.kind,expectedDraftRevision:saved.expectedDraftRevision,appliedRevision:saved.appliedRevision,
     presentationOperationId:saved.presentationOperationId,acknowledgmentOperationId:saved.acknowledgmentOperationId,handled:saved.handled,clarifiedAt:saved.clarifiedAt,
     at:saved.at,resumeStatus:saved.resumeStatus,...(saved.kind==='clarify_exaggeration'?{safe:saved.safe,exaggeration:saved.exaggeration}:{})}};
   }
   const handled=new Set<string>();
   for(const row of operations.values()){
    signal?.throwIfAborted();
    if(row.action_kind==='present'||row.action_kind==='need_support')continue;
    const present=operations.get(row.presentation_operation_id!);
    if(!present||present.action_kind!=='present'||present.publication_id!==row.publication_id||present.draft_id!==row.draft_id||present.session_hash!==row.session_hash
     ||present.presentation_digest!==row.presentation_digest||present.created_at>row.created_at)throw unavailable();
    if(row.action_kind==='acknowledge')continue;
    const ack=operations.get(row.acknowledgment_operation_id!);
    if(!ack||ack.action_kind!=='acknowledge'||ack.publication_id!==row.publication_id||ack.draft_id!==row.draft_id||ack.session_hash!==row.session_hash
     ||ack.presentation_operation_id!==present.operation_id||ack.presentation_digest!==row.presentation_digest||ack.created_at>row.created_at)throw unavailable();
    const submission=publications.get(row.publication_id)!.submission_id;
    if(handled.has(submission))throw unavailable();handled.add(submission);
   }
  }catch{signal?.throwIfAborted();throw unavailable();}
  await authorizeFixedSession(client,who,signal);signal?.throwIfAborted();
 }
}
