import type {PoolClient} from 'pg';
import {careerRecordId as id,careerRecordObject as object} from '@companion/platform-contracts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import type {PlatformConfig} from './config.ts';
import {ApiError} from './errors.ts';
import {readQuestionJournal,occurrenceFromCapture,type QuestionScopeRow,type QuestionOccurrenceRow} from './safety-question-delivery-protocol.ts';

export const SHARED_SAFETY_EXPORT_TABLES=Object.freeze(['platform_safety_events','platform_safety_question_scopes','platform_safety_question_occurrences','platform_safety_question_operations','platform_safety_legacy_exposures'] as const);
export type SharedSafetyExportSection='safetyResponseEvents'|'safetyQuestionScopes'|'safetyQuestionOccurrences'|'safetyQuestionOperations'|'safetyLegacyExposures';
/** Only decoded sections already authenticated in the SAME owner snapshot. */
export interface SharedSafetyArchive {readonly onboardingSafetyResponses:readonly unknown[];readonly nameSafetyResponses:readonly unknown[];
 readonly onboardingDrafts:readonly unknown[];readonly intakeResourcePublications:readonly unknown[];readonly nameResourcePublications:readonly unknown[];readonly intakeResourceCutovers:readonly unknown[];}
type Row=Record<string,any>;
const unavailable=()=>new ApiError(503,'ACCOUNT_SHARED_SAFETY_EXPORT_UNAVAILABLE','The original shared safety history could not be confirmed.');
const at=(d:Date)=>{if(!(d instanceof Date)||!Number.isFinite(d.getTime()))throw unavailable();return d.toISOString();};
const nullableAt=(d:Date|null)=>d===null?null:at(d);
const occurrenceView=(r:QuestionOccurrenceRow)=>({id:r.id,ownerId:r.user_id,draftId:r.draft_id,sourceKind:r.source_kind??'companion_name',
 publicationId:r.publication_id,submissionId:r.submission_id,sourceGeneration:r.source_generation,occurrence:r.occurrence,generation:r.generation,phase:r.phase,
 reservedUntil:at(r.reserved_until),displayUntil:nullableAt(r.display_until),evidenceUntil:nullableAt(r.evidence_until),
 claimedAt:nullableAt(r.claimed_at),receiptReceivedAt:nullableAt(r.receipt_received_at)});
async function* rows(client:PoolClient,owner:string,table:'platform_safety_events'|'platform_safety_question_scopes',signal?:AbortSignal){
 const key=table==='platform_safety_events'?'id':'draft_id';let after:string|null=null;
 for(;;){signal?.throwIfAborted();const found=(await client.query(`SELECT * FROM ${table} WHERE user_id=$1 AND ($2::uuid IS NULL OR ${key}>$2) ORDER BY ${key} LIMIT 100`,[owner,after])).rows;
  for(const row of found){signal?.throwIfAborted();if(row.user_id!==owner)throw unavailable();yield row;}
  if(found.length<100)break;after=id(found.at(-1)[key]);}
}
/** Retained original facts only. Never initializes scopes, recovers a grant,
 * consults current policy or turns a delivery receipt into a human-read claim. */
export class AccountSharedSafetyExport{
 constructor(private readonly config:Pick<PlatformConfig,'dataCrypto'>){}
 async *exportInTransaction(client:PoolClient,value:FixedSessionContext,archive:SharedSafetyArchive,signal?:AbortSignal):AsyncGenerator<{section:SharedSafetyExportSection;record:unknown}>{
  const raw=object(value,['userId','tokenHash']),who=Object.freeze({userId:id(raw.userId),tokenHash:raw.tokenHash as string});
  if(typeof who.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(who.tokenHash))throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');
  await authorizeFixedSession(client,who,signal);
  try{
   const sources=new Map<string,Row>(),seen=new Set<string>();
   for(const [kind,list] of [['onboarding',archive.onboardingSafetyResponses],['companion_name',archive.nameSafetyResponses]] as const)for(const value of list){
    const r=value as Row,key=kind+':'+r.id;if(r.ownerId!==who.userId||sources.has(key))throw unavailable();sources.set(key,r);
   }
   let eventCount=0;
   for await(const r of rows(client,who.userId,'platform_safety_events',signal)){
    const naming=r.source_kind==='companion_name';
    if(!naming&&r.source_kind!=='onboarding')throw unavailable();
    const responseId=naming?r.name_response_id:r.response_id,submissionId=naming?r.name_submission_id:r.submission_id,key=r.source_kind+':'+responseId,source=sources.get(key);
    if(!source||source.status!=='ready'||seen.has(key)||r.event_kind!=='response_prepared'||source.submissionId!==submissionId
     ||r.level!==source.level||r.detector_revision!==source.detectorRevision||r.detector_mode!==source.detectorMode
     ||at(r.created_at)!==source.preparedAt||at(r.retention_until)!==source.retentionUntil
     ||(naming?(r.submission_id!==null||r.response_id!==null||r.name_source_generation!==source.sourceGeneration)
      :(r.name_submission_id!==null||r.name_response_id!==null||r.name_source_generation!==null||source.preparedEvent?.id!==r.id)))throw unavailable();
    seen.add(key);eventCount++;yield {section:'safetyResponseEvents',record:{id:r.id,ownerId:who.userId,sourceKind:r.source_kind,submissionId,responseId,
     sourceGeneration:source.sourceGeneration,kind:r.event_kind,level:r.level,detectorRevision:r.detector_revision,detectorMode:r.detector_mode,createdAt:at(r.created_at),retentionUntil:at(r.retention_until)}};
   }
   if([...sources].some(([key,r])=>(r.status==='ready')!==seen.has(key)))throw unavailable();
   const drafts=new Set(archive.onboardingDrafts.map(value=>{const r=value as Row;if(r.userId!==who.userId)throw unavailable();return r.id;}));
   const cutovers=new Set(archive.intakeResourceCutovers.map(value=>{const r=value as Row;if(r.userId!==who.userId)throw unavailable();return r.draftId;}));
   const publications=new Map<string,Row>();
   for(const [kind,list] of [['onboarding',archive.intakeResourcePublications],['companion_name',archive.nameResourcePublications]] as const)for(const value of list){
    const r=value as Row;if(r.ownerId!==who.userId||publications.has(kind+':'+r.id))throw unavailable();publications.set(kind+':'+r.id,r);
   }
   const counts={scopes:0,occurrences:0,operations:0,legacy:0};
   for await(const row of rows(client,who.userId,'platform_safety_question_scopes',signal)){
    if(!this.config.dataCrypto||!drafts.has(row.draft_id)||!cutovers.has(row.draft_id))throw unavailable();
    const anchor=(await client.query('SELECT name_question_scope_draft_id FROM platform_onboarding_drafts WHERE id=$1 AND user_id=$2',[row.draft_id,who.userId])).rows[0];
    if(anchor?.name_question_scope_draft_id!==row.draft_id)throw unavailable();
    const scope=row as QuestionScopeRow,journal=await readQuestionJournal(client,this.config.dataCrypto,scope,false,signal);counts.scopes++;
    yield {section:'safetyQuestionScopes',record:{ownerId:who.userId,draftId:scope.draft_id,revision:scope.revision,latestOperationId:scope.latest_operation_id}};
    const validate=(r:QuestionOccurrenceRow,when?:Date)=>{
     const p=publications.get((r.source_kind??'companion_name')+':'+r.publication_id);
     if(!p||r.user_id!==who.userId||r.draft_id!==scope.draft_id||p.draftId!==r.draft_id||p.submissionId!==r.submission_id
      ||p.sourceGeneration!==r.source_generation||p.level!=='L2'||p.questionDigest!==r.question_digest
      ||r.reserved_until>new Date(p.retentionUntil)||when&&when<new Date(p.publishedAt)
      ||r.display_until&&r.display_until>new Date(p.retentionUntil)
      ||r.evidence_until&&at(r.evidence_until)!==p.evidenceRetentionUntil)throw unavailable();return p;
    };
    for(const r of journal.actual){signal?.throwIfAborted();validate(r);counts.occurrences++;
     yield {section:'safetyQuestionOccurrences',record:occurrenceView(r)};}
    for(const op of journal.rows){
     signal?.throwIfAborted();if(op.user_id!==who.userId||op.draft_id!==scope.draft_id)throw unavailable();
     const capture=journal.captures.get(op.operation_id)!;if(!capture)throw unavailable();
     const after=occurrenceFromCapture(capture.after),p=validate(after,op.created_at);
     if(op.kind==='claim'&&capture.question!==p.response.question)throw unavailable();
     counts.operations++;yield {section:'safetyQuestionOperations',record:{ownerId:who.userId,operationId:op.operation_id,draftId:op.draft_id,occurrenceId:op.occurrence_id,
      kind:op.kind,expectedRevision:op.expected_revision,appliedRevision:op.applied_revision,at:at(op.created_at),after:occurrenceView(after),
      question:op.kind==='claim'?capture.question:null}};
    }
    for(const legacy of journal.legacy.rows){
     if(legacy.user_id!==who.userId||legacy.draft_id!==scope.draft_id)throw unavailable();counts.legacy++;
     yield {section:'safetyLegacyExposures',record:{ownerId:who.userId,draftId:legacy.draft_id,publicationId:legacy.publication_id,kind:'legacy_possible_exposure',recordedAt:at(legacy.recorded_at)}};
    }
   }
   const audit=(await client.query(`SELECT
    (SELECT count(*)::int FROM platform_safety_events WHERE user_id=$1) AS events,
    (SELECT count(*)::int FROM platform_safety_question_scopes WHERE user_id=$1) AS scopes,
    (SELECT count(*)::int FROM platform_safety_question_occurrences WHERE user_id=$1) AS occurrences,
    (SELECT count(*)::int FROM platform_safety_question_operations WHERE user_id=$1) AS operations,
    (SELECT count(*)::int FROM platform_safety_legacy_exposures WHERE user_id=$1) AS legacy,
    EXISTS(SELECT 1 FROM platform_onboarding_drafts d LEFT JOIN platform_safety_question_scopes s ON s.user_id=d.user_id AND s.draft_id=d.id
     WHERE d.user_id=$1 AND d.name_question_scope_draft_id IS NOT NULL AND s.draft_id IS NULL) AS missing_scope,
    EXISTS(SELECT 1 FROM platform_safety_events WHERE user_id=$1 AND created_at>clock_timestamp()
     UNION ALL SELECT 1 FROM platform_safety_legacy_exposures WHERE user_id=$1 AND recorded_at>clock_timestamp()) AS future`,[who.userId])).rows[0];
   if(audit.events!==eventCount||Object.entries(counts).some(([key,count])=>audit[key]!==count)||audit.missing_scope||audit.future)throw unavailable();
  }catch{signal?.throwIfAborted();throw unavailable();}
  await authorizeFixedSession(client,who,signal);signal?.throwIfAborted();
 }
}
