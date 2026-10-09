import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { renderSafetyResponse } from '@companion/career-core';
import type { OnboardingDraft } from '@companion/platform-contracts';
import type { DataCrypto } from './data-crypto.ts';
import { OnboardingStorage, type IntakeOperationRow, type SafetySubmissionRow } from './onboarding-storage.ts';
import { readAuthenticatedSafetyResponseForSource, readAuthenticatedSafetyResponsesForSources } from './onboarding-safety-responses.ts';
import { publicSafetyResponse } from './safety-response-view.ts';
import { captureFollowup, type SafetyFollowupRow, type SafetyPublicationRow } from './onboarding-safety-followup-protocol.ts';
import type { SafetyResponseBundle } from './safety-response-bundle.ts';
import { deliveryDigest, deliveryStorageUnavailable, deliveryUnavailable, deliveryUuid, openDelivery } from './safety-delivery-review.ts';

/** Closed persisted observation. Explicit legacy recovery belongs to a write
 * driver; a current GET cannot silently enroll or create classified sources. */
export async function observeIntakeSourcesInTransaction(client:PoolClient,storage:OnboardingStorage,draft:OnboardingDraft){
  const operations=(await client.query<IntakeOperationRow>('SELECT operation_id,draft_id,applied_revision,request_ciphertext FROM platform_onboarding_operations WHERE user_id=$1 ORDER BY applied_revision,operation_id FOR SHARE',[draft.userId])).rows;
  const texts=new Map<string,ReturnType<OnboardingStorage['decodeOperation']>>();
  for(const row of operations){if(row.draft_id!==draft.id||row.applied_revision>draft.revision)throw deliveryStorageUnavailable();const command=storage.decodeOperation(row,draft.userId);if(command.action.kind==='text')texts.set(row.operation_id,command);}
  const sources=(await client.query<SafetySubmissionRow>('SELECT * FROM platform_onboarding_safety_submissions WHERE user_id=$1 ORDER BY submitted_revision,id FOR SHARE',[draft.userId])).rows;
  if(sources.length!==texts.size)throw deliveryStorageUnavailable();
  for(const source of sources){const raw=texts.get(source.operation_id);
    if(!raw||raw.action.kind!=='text'||source.draft_id!==draft.id||source.submitted_revision!==raw.expectedRevision+1||source.question_id!==raw.action.questionId)throw deliveryStorageUnavailable();
    if(source.status==='detected')storage.decodeResult(source);
  }
  if(draft.pendingText&&!sources.some(row=>row.operation_id===draft.pendingText!.id&&row.question_id===draft.pendingText!.questionId&&row.submitted_revision===draft.pendingText!.submittedAtRevision))throw deliveryStorageUnavailable();
  if(draft.safety&&!sources.some(row=>row.operation_id===draft.safety!.textId&&row.status==='detected'&&row.question_id===draft.safety!.questionId&&row.submitted_revision===draft.safety!.submittedAtRevision&&row.level===draft.safety!.level&&row.detector_mode===draft.safety!.mode&&row.detector_revision===draft.safety!.detectorRevision))throw deliveryStorageUnavailable();
  return sources;
}

/** The actual classified target only. No later intake, original live session,
 * provider, lease, quota, preview or045 manifest can confer or deny this proof.
 * lock=false is for a bounded REPEATABLE READ archive; execution keeps the default locks. */
export async function readIntakeResourceSourceInTransaction(client:PoolClient,crypto:DataCrypto|undefined,id:string,signal?:AbortSignal,lock=true){
  id=deliveryUuid(id);if(!crypto)throw deliveryStorageUnavailable();signal?.throwIfAborted();
  const ref=(await client.query<{user_id:string}>('SELECT user_id FROM platform_onboarding_safety_submissions WHERE id=$1',[id])).rows[0];
  if(!ref)throw deliveryStorageUnavailable();
  const owner=(await client.query<{account_kind:string}>(`SELECT account_kind FROM platform_users WHERE id=$1${lock?' FOR NO KEY UPDATE':''}`,[ref.user_id])).rows[0];
  if(!owner||owner.account_kind!=='student')throw deliveryStorageUnavailable();
  const source=(await client.query<SafetySubmissionRow>(`SELECT * FROM platform_onboarding_safety_submissions WHERE id=$1 AND user_id=$2${lock?' FOR UPDATE':''}`,[id,ref.user_id])).rows[0];
  if(!source||source.status!=='detected'||!source.result_ciphertext||!source.execution_token)throw deliveryStorageUnavailable();
  const storage=new OnboardingStorage({dataCrypto:crypto,requireVerifiedEmail:false},null);
  const op=(await client.query<IntakeOperationRow&{user_id:string}>(`SELECT * FROM platform_onboarding_operations WHERE user_id=$1 AND operation_id=$2${lock?' FOR SHARE':''}`,[source.user_id,source.operation_id])).rows[0];
  if(!op||op.draft_id!==source.draft_id||op.applied_revision!==source.submitted_revision)throw deliveryStorageUnavailable();
  const command=storage.decodeOperation(op,source.user_id),decision=storage.decodeResult(source);
  if(command.action.kind!=='text'||command.action.questionId!==source.question_id)throw deliveryStorageUnavailable();
  const original=crypto.openUtf8(op.request_ciphertext,{table:'platform_onboarding_operations',column:'request_ciphertext',rowId:op.operation_id,ownerId:source.user_id,revision:op.applied_revision});
  const result=crypto.openUtf8(source.result_ciphertext,{table:'platform_onboarding_safety_submissions',column:'result_ciphertext',rowId:source.id,ownerId:source.user_id,revision:source.generation});
  if(original!==JSON.stringify(command)||result!==JSON.stringify(decision))throw deliveryStorageUnavailable();
  if(decision.mode==='full'){
    const usage=await client.query(`SELECT call_id FROM platform_safety_model_usage WHERE source_kind='onboarding' AND submission_id=$1 AND user_id=$2
      AND operation_id=$3 AND draft_id=$4 AND question_id=$5 AND submitted_revision=$6 AND generation=$7 AND auth_version=$8 AND detector_revision=$9
      AND entry_id IS NULL AND task_id IS NULL AND companion_id IS NULL AND preview_revision IS NULL AND expected_identity_revision IS NULL AND name_execution_token IS NULL
      AND purpose='safety_classify' AND call_index=1 AND status='complete' AND usage_status IN('reported','missing','invalid')
      AND admitted_at IS NOT NULL AND finished_at IS NOT NULL AND admitted_at<=finished_at AND finished_at<=clock_timestamp()${lock?' FOR SHARE':''}`,
      [source.id,source.user_id,source.operation_id,source.draft_id,source.question_id,source.submitted_revision,source.generation,source.auth_version,source.detector_revision]);
    if(usage.rows.length!==1)throw deliveryStorageUnavailable();
  }
  signal?.throwIfAborted();return {source,decision,storage};
}
export async function readIntakeResourceCaptureInTransaction(client:PoolClient,crypto:DataCrypto|undefined,id:string,signal?:AbortSignal,lock=true){
  const target=await readIntakeResourceSourceInTransaction(client,crypto,id,signal,lock);
  if(target.decision.level==='L0')return null;
  const original=await readAuthenticatedSafetyResponseForSource(client,target.storage,target.source,lock);
  return {...original,target};
}
/** Existing genuine039 target handling can be shown as an archived fact. No
 * current draft, invented039 row or later unrelated source is consumed. */
export async function readLegacyHandledIntakeTargetInTransaction(client:PoolClient,storage:OnboardingStorage,source:SafetySubmissionRow):Promise<boolean>{
  if(!storage.crypto)throw deliveryStorageUnavailable();
  // Old transported text is possible question exposure, independently checked
  // by the shared question reader. It is not a handling receipt and cannot
  // close an otherwise authentic new body when no old handling ever exists.
  if(!(await client.query('SELECT 1 FROM platform_onboarding_safety_followups f JOIN platform_onboarding_safety_publications p ON p.id=f.publication_id AND p.user_id=f.user_id WHERE f.user_id=$1 AND p.submission_id=$2 AND f.handled LIMIT 1',[source.user_id,source.id])).rowCount)return false;
  const publications=(await client.query<SafetyPublicationRow>('SELECT * FROM platform_onboarding_safety_publications WHERE user_id=$1 AND submission_id=$2 ORDER BY id FOR SHARE',[source.user_id,source.id])).rows;
  if(!publications.length)return false;
  const original=await readAuthenticatedSafetyResponseForSource(client,storage,source),response=publicSafetyResponse(original.response!);
  for(const p of publications){
    if(p.draft_id!==source.draft_id||p.response_id!==original.row.id||p.source_generation!==source.generation||p.published_at<original.row.prepared_at!||p.retention_until.toISOString()!==original.row.retention_until!.toISOString())throw deliveryStorageUnavailable();
    const expected={schemaVersion:1,id:p.id,userId:source.user_id,draftId:source.draft_id,responseId:p.response_id,submissionId:source.id,sourceGeneration:source.generation,
      preparedAt:original.row.prepared_at!.toISOString(),publishedAt:p.published_at.toISOString(),retentionUntil:p.retention_until.toISOString(),projectionDigest:p.projection_digest,response};
    if(p.projection_digest!==deliveryDigest(JSON.stringify(response))||JSON.stringify(openDelivery(storage.crypto,'platform_onboarding_safety_publications',p.id,p.user_id,1,p.payload_ciphertext))!==JSON.stringify(expected))throw deliveryStorageUnavailable();
  }
  const operations=(await client.query<SafetyFollowupRow>('SELECT * FROM platform_onboarding_safety_followups WHERE user_id=$1 AND publication_id=ANY($2::uuid[]) ORDER BY created_at,operation_id FOR SHARE',[source.user_id,publications.map(p=>p.id)])).rows;
  let handled=false;
  for(const op of operations){const p=publications.find(p=>p.id===op.publication_id)!;
    captureFollowup(storage,op);
    if(op.draft_id!==source.draft_id||op.created_at<p.published_at||!op.handled&&op.created_at>=p.retention_until)throw deliveryStorageUnavailable();
    if(op.action_kind==='present'||op.action_kind==='need_support')continue;
    const present=operations.find(r=>r.operation_id===op.presentation_operation_id);
    if(!present||present.action_kind!=='present'||present.publication_id!==p.id||present.session_hash!==op.session_hash||present.presentation_digest!==op.presentation_digest||present.created_at>op.created_at)throw deliveryStorageUnavailable();
    if(op.action_kind==='acknowledge')continue;
    const ack=operations.find(r=>r.operation_id===op.acknowledgment_operation_id);
    if(!ack||ack.action_kind!=='acknowledge'||ack.publication_id!==p.id||ack.session_hash!==op.session_hash||ack.presentation_operation_id!==present.operation_id||ack.presentation_digest!==op.presentation_digest||ack.created_at>op.created_at||!op.handled||handled)throw deliveryStorageUnavailable();handled=true;
  }
  if((await client.query('SELECT 1 FROM platform_onboarding_safety_followups WHERE user_id=$1 AND publication_id=ANY($2::uuid[]) AND created_at>clock_timestamp() UNION ALL SELECT 1 FROM platform_onboarding_safety_publications WHERE user_id=$1 AND id=ANY($2::uuid[]) AND published_at>clock_timestamp() LIMIT 1',[source.user_id,publications.map(p=>p.id)])).rowCount)throw deliveryStorageUnavailable();
  return handled;
}
/** Explicit publication may complete its genuine pending030 capture. This is
 * target-only and uses the unchanged030 codec/canonical prepared event. It
 * never repairs a missing row, invokes a model or grants current intake writes. */
export async function prepareIntakeResourceCaptureInTransaction(client:PoolClient,crypto:DataCrypto|undefined,id:string,
  bundle:SafetyResponseBundle|null,signal?:AbortSignal){
  const target=await readIntakeResourceSourceInTransaction(client,crypto,id,signal);
  if(target.decision.level==='L0')return null;
  const captures=await readAuthenticatedSafetyResponsesForSources(client,target.storage,target.source.user_id,[target.source]);
  if(captures.length!==1)throw deliveryStorageUnavailable();const capture=captures[0],row=capture.row;
  if(capture.response)return {...capture,target};
  if(!bundle)throw deliveryUnavailable();
  const policy=(await client.query('SELECT revision,content_digest,review_digest FROM platform_safety_response_policy WHERE singleton=true FOR SHARE')).rows[0];
  if(!policy||policy.revision!==bundle.revision||policy.content_digest!==bundle.contentDigest||policy.review_digest!==bundle.reviewDigest)throw deliveryUnavailable();
  // Locale comes from actual original prefix operations, never a later draft.
  // Before a language answer exists the questionnaire's default is Chinese.
  let locale:'zh'|'en'='zh';
  const prefix=(await client.query<IntakeOperationRow>('SELECT operation_id,draft_id,applied_revision,request_ciphertext FROM platform_onboarding_operations WHERE user_id=$1 AND applied_revision<=$2 ORDER BY applied_revision FOR SHARE',[target.source.user_id,target.source.submitted_revision])).rows;
  for(const op of prefix){if(op.draft_id!==target.source.draft_id)throw deliveryStorageUnavailable();const command=target.storage.decodeOperation(op,target.source.user_id);
    if(command.action.kind==='answer'&&command.action.questionId==='emotion_language')locale=command.action.value==='en'?'en':'zh';}
  const response=renderSafetyResponse({level:row.level,locale,templateFromBundle:bundle.locales[locale],contactsFromBundle:bundle.resources.contacts,
    outsideUsTranslation:bundle.resources.outsideUs[locale],companionName:locale==='en'?'Your companion':'你的主理人',userName:'',askSafetyQuestion:row.level==='L2'});
  const time=(await client.query<{at:Date;until:Date}>('SELECT t.at,t.at+($1::int*interval \'1 day\') AS until FROM (SELECT clock_timestamp() AS at) t',[bundle.retentionDays])).rows[0];
  const ready={...row,status:'ready' as const,bundle_revision:bundle.revision,content_digest:bundle.contentDigest,review_digest:bundle.reviewDigest,locale,prepared_at:time.at,retention_until:time.until};
  const coordinates=['id','user_id','submission_id','operation_id','draft_id','question_id','submitted_revision','source_generation','detector_revision','level','detector_mode','bundle_revision','content_digest','review_digest','locale'] as const;
  const payload={schemaVersion:1,...Object.fromEntries(coordinates.map(key=>[key,ready[key]])),preparedAt:time.at.toISOString(),retentionUntil:time.until.toISOString(),response};
  const cipher=crypto!.sealUtf8(JSON.stringify(payload),{table:'platform_onboarding_safety_responses',column:'payload_ciphertext',rowId:row.id,ownerId:row.user_id,revision:1});
  await client.query(`INSERT INTO platform_safety_events(id,user_id,source_kind,submission_id,response_id,event_kind,level,detector_revision,detector_mode,created_at,retention_until)
    VALUES($1,$2,'onboarding',$3,$4,'response_prepared',$5,$6,$7,$8,$9)`,[randomUUID(),row.user_id,row.submission_id,row.id,row.level,row.detector_revision,row.detector_mode,time.at,time.until]);
  const updated=await client.query(`UPDATE platform_onboarding_safety_responses SET status='ready',payload_ciphertext=$2,bundle_revision=$3,content_digest=$4,
    review_digest=$5,locale=$6,prepared_at=$7,retention_until=$8 WHERE id=$1 AND status='pending' RETURNING id`,[row.id,cipher,bundle.revision,bundle.contentDigest,bundle.reviewDigest,locale,time.at,time.until]);
  if(updated.rowCount!==1)throw deliveryStorageUnavailable();return readIntakeResourceCaptureInTransaction(client,crypto,id,signal);
}
