import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { OnboardingDraft, OnboardingSafetyResult } from '@companion/platform-contracts';
import { parseOnboardingDraft, type CompanionDimensions } from '@companion/career-core';
import { OnboardingStorage, intakeUnavailable, type IntakeOperationRow, type SafetySubmissionRow } from './onboarding-storage.ts';
import { publicSafetyResponse, readAuthenticatedSafetyResponsesForSources } from './onboarding-safety-responses.ts';
import { captureFollowup, followupDigest, type SafetyFollowupRow, type SafetyPublicationRow } from './onboarding-safety-followup-protocol.ts';
import { parseCapturedCompanionAnswers, type CapturedCompanionAnswers } from './companion-captured-answers.ts';
import { deriveCapturedCompanionDimensions, type CapturedCompanionSourceProducts } from './companion-historical-intake.ts';
import { intakeResourcePrefixProofs, intakeResourceProofArray, parseIntakeResourcePrefixProof, type IntakeResourcePrefixProof } from './onboarding-resource-prefix.ts';

const bindingKeys = ['taskId','userId','companionId','answersId','sourceDraftId','sourceRevision','authVersion',
  'questionnaireRevision','rulesRevision','generatorVersion','purpose','canonicalAnswersDigest','canonicalSeedDigest'] as const;
/** Digests of the canonical answers and ORIGINAL seed before receipt fields. */
export interface CompanionSourcePrefixBinding {
  readonly taskId: string; readonly userId: string; readonly companionId: string; readonly answersId: string;
  readonly sourceDraftId: string; readonly sourceRevision: number; readonly authVersion: string;
  readonly questionnaireRevision: 1; readonly rulesRevision: 1; readonly generatorVersion: 1;
  readonly purpose: 'companion_preview'; readonly canonicalAnswersDigest: string; readonly canonicalSeedDigest: string;
}
type Entry = Readonly<Record<string, string | number | boolean | null>>;
export interface CompanionSourcePrefixManifest extends CompanionSourcePrefixBinding {
  readonly schemaVersion: 1|2; readonly manifestId: string; readonly capturedAt: string;
  readonly operations: readonly Entry[]; readonly submissions: readonly Entry[]; readonly responses: readonly Entry[];
  readonly events: readonly Entry[]; readonly publications: readonly Entry[]; readonly followups: readonly Entry[];
  readonly handledSubmissionIds: readonly string[];
  readonly intakeResources?: readonly IntakeResourcePrefixProof[];
}
export interface CompanionSourcePrefixCapture { readonly payload: Readonly<CompanionSourcePrefixManifest>; readonly digest: string; }
export interface CompanionSourcePrefixProof {
  readonly handledSubmissionIds: readonly string[]; readonly responseIds: readonly string[];
  readonly publicationIds: readonly string[]; readonly followupIds: readonly string[]; readonly eventIds: readonly string[];
}
export interface CompanionSourcePrefixDimensionsProof extends CompanionSourcePrefixProof {
  readonly dimensions: Readonly<CompanionDimensions>;
}
interface SourcePrefixProducts {
  readonly manifest: Readonly<CompanionSourcePrefixManifest>;
  readonly products: Readonly<CapturedCompanionSourceProducts>;
}
const entryKeys = {
  operations: ['operationId','appliedRevision','createdAt','canonicalCommandDigest'],
  submissions: ['submissionId','operationId','questionId','submittedRevision','status','generation','authVersion',
    'detectorRevision','originalLevel','originalDetectorMode','createdAt','updatedAt','claimDigest','canonicalResultDigest'],
  responses: ['responseId','submissionId','operationId','questionId','submittedRevision','sourceGeneration','detectorRevision',
    'originalLevel','originalDetectorMode','status','bundleRevision','contentDigest','reviewDigest','locale','createdAt',
    'preparedAt','retentionUntil','canonicalResponsePayloadDigest'],
  events: ['eventId','responseId','submissionId','sourceKind','eventKind','originalLevel','detectorRevision',
    'originalDetectorMode','createdAt','retentionUntil'],
  publications: ['publicationId','responseId','submissionId','sourceGeneration','projectionDigest','publishedAt',
    'retentionUntil','canonicalPublicationPayloadDigest'],
  followups: ['operationId','publicationId','actionKind','expectedRevision','appliedRevision','sessionHash','presentationDigest',
    'presentationOperationId','acknowledgmentOperationId','handled','clarifiedAt','createdAt','resumeStatus','canonicalFollowupPayloadDigest'],
} as const;
const idKeys = { operations:'operationId', submissions:'submissionId', responses:'responseId', events:'eventId',
  publications:'publicationId', followups:'operationId' } as const;
const sha = (text: string) => createHash('sha256').update(text,'utf8').digest('hex');
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value!=='object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw intakeUnavailable();
  const descriptors=Object.getOwnPropertyDescriptors(value), actual=Reflect.ownKeys(value);
  if (actual.length!==keys.length || actual.some(key=>typeof key!=='string'||!keys.includes(key))
    || keys.some(key=>!Object.hasOwn(descriptors,key)) || Object.values(descriptors).some(item=>!('value'in item)||!item.enumerable)) throw intakeUnavailable();
  return Object.fromEntries(keys.map(key=>[key,descriptors[key].value]));
}
function uuid(value: unknown): string {
  if (typeof value!=='string'||/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(value)?.[0]!==value) throw intakeUnavailable();
  return value;
}
function digest(value: unknown): string {
  if (typeof value!=='string'||/^[0-9a-f]{64}$/.exec(value)?.[0]!==value) throw intakeUnavailable();
  return value;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value)||Object.is(value,-0)||(value as number)<1||(value as number)>2147483647) throw intakeUnavailable();
  return value as number;
}
function at(value: Date): string {
  if (!(value instanceof Date)||!Number.isFinite(value.getTime())) throw intakeUnavailable();
  return value.toISOString();
}
function parseBinding(value: unknown): Readonly<CompanionSourcePrefixBinding> {
  const data=record(value,bindingKeys);
  if (typeof data.authVersion!=='string'||/^(0|[1-9][0-9]*)$/.exec(data.authVersion)?.[0]!==data.authVersion
    || BigInt(data.authVersion)>9223372036854775807n || data.questionnaireRevision!==1||data.rulesRevision!==1
    ||data.generatorVersion!==1||data.purpose!=='companion_preview') throw intakeUnavailable();
  return Object.freeze({taskId:uuid(data.taskId),userId:uuid(data.userId),companionId:uuid(data.companionId),answersId:uuid(data.answersId),
    sourceDraftId:uuid(data.sourceDraftId),sourceRevision:integer(data.sourceRevision),authVersion:data.authVersion,
    questionnaireRevision:1 as const,rulesRevision:1 as const,generatorVersion:1 as const,purpose:'companion_preview' as const,
    canonicalAnswersDigest:digest(data.canonicalAnswersDigest),canonicalSeedDigest:digest(data.canonicalSeedDigest)});
}
function frozenEntries(values: Entry[]): readonly Entry[] { return Object.freeze(values.map(value=>Object.freeze(value))); }
function ids(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw intakeUnavailable();
  const result=value.map(uuid);
  if (new Set(result).size!==result.length) throw intakeUnavailable();
  return Object.freeze(result);
}
function parseManifest(value: unknown): Readonly<CompanionSourcePrefixManifest> {
  const version=value&&typeof value==='object'?Object.getOwnPropertyDescriptor(value,'schemaVersion'):undefined;
  if(!version||!('value'in version)||![1,2].includes(version.value))throw intakeUnavailable();
  const keys=['schemaVersion','manifestId',...bindingKeys,'capturedAt',...Object.keys(entryKeys),...(version.value===2?['intakeResources']:[]),'handledSubmissionIds'];
  const data=record(value,keys), binding=parseBinding(Object.fromEntries(bindingKeys.map(key=>[key,data[key]])));
  if (data.manifestId!==binding.taskId||typeof data.capturedAt!=='string'
    || at(new Date(data.capturedAt))!==data.capturedAt) throw intakeUnavailable();
  const groups: Record<string,readonly Entry[]>={};
  for (const [group,keys] of Object.entries(entryKeys)) {
    if (!Array.isArray(data[group])) throw intakeUnavailable();
    const values=(data[group] as unknown[]).map(value=>record(value,keys));
    ids(values.map(value=>value[idKeys[group as keyof typeof idKeys]]));
    if (values.some(value=>Object.values(value).some(item=>item!==null&&!['string','number','boolean'].includes(typeof item)))) throw intakeUnavailable();
    groups[group]=frozenEntries(values as Entry[]);
  }
  let modern:readonly IntakeResourcePrefixProof[]|undefined;
  if(data.schemaVersion===2){const array=intakeResourceProofArray(data.intakeResources);if(!array.length)throw intakeUnavailable();
    modern=Object.freeze(array.map(parseIntakeResourcePrefixProof));if(new Set(modern.map(p=>p.submissionId)).size!==modern.length)throw intakeUnavailable();}
  return Object.freeze({schemaVersion:data.schemaVersion,manifestId:binding.taskId,...binding,capturedAt:data.capturedAt,
    ...groups,...(modern?{intakeResources:modern}:{}),handledSubmissionIds:ids(data.handledSubmissionIds)}) as Readonly<CompanionSourcePrefixManifest>;
}
function aad(binding: CompanionSourcePrefixBinding) {
  return {table:'platform_companion_source_prefixes',column:'payload_ciphertext',rowId:binding.taskId,
    ownerId:binding.userId,revision:binding.sourceRevision};
}
/** SELECT-only reconstruction against the captured ID set. It never recovers an
 * inbox, inserts a missing response, or borrows later handling evidence. */
async function manifestAt(client: PoolClient, storage: OnboardingStorage, binding: Readonly<CompanionSourcePrefixBinding>,
  capturedAt: string, original?: Readonly<CompanionSourcePrefixManifest>): Promise<Readonly<SourcePrefixProducts>> {
  if (!storage.crypto) throw intakeUnavailable();
  const captureTime=new Date(capturedAt), checkTime=(value: Date) => {
    const text=at(value); if (value>captureTime) throw intakeUnavailable(); return text;
  };
  const operations=(await client.query<IntakeOperationRow & {user_id:string;created_at:Date}>(`SELECT * FROM platform_onboarding_operations
    WHERE user_id=$1 AND draft_id=$2 AND applied_revision<=$3 ORDER BY applied_revision,operation_id FOR UPDATE`,
  [binding.userId,binding.sourceDraftId,binding.sourceRevision])).rows;
  const commands=new Map<string,ReturnType<OnboardingStorage['decodeOperation']>>(), revisions=new Set<number>();
  const operationEntries: Entry[]=operations.map(row=>{
    if (row.user_id!==binding.userId||row.draft_id!==binding.sourceDraftId||revisions.has(row.applied_revision)) throw intakeUnavailable();
    revisions.add(row.applied_revision);
    const command=storage.decodeOperation(row,binding.userId), text=storage.crypto!.openUtf8(row.request_ciphertext,
      {table:'platform_onboarding_operations',column:'request_ciphertext',rowId:row.operation_id,ownerId:binding.userId,revision:row.applied_revision});
    if (text!==JSON.stringify(command)||commands.has(row.operation_id)) throw intakeUnavailable();
    commands.set(row.operation_id,command);
    return {operationId:row.operation_id,appliedRevision:row.applied_revision,createdAt:checkTime(row.created_at),canonicalCommandDigest:sha(text)};
  });
  const starts=operations.filter(row=>commands.get(row.operation_id)!.action.kind==='start');
  if (starts.length!==1||starts[0]!.applied_revision!==1) throw intakeUnavailable();
  const submissions=(await client.query<SafetySubmissionRow & {created_at:Date;updated_at:Date}>(`SELECT * FROM platform_onboarding_safety_submissions
    WHERE user_id=$1 AND draft_id=$2 AND submitted_revision<=$3 ORDER BY submitted_revision,id FOR UPDATE`,
  [binding.userId,binding.sourceDraftId,binding.sourceRevision])).rows;
  const textIds=operations.filter(row=>commands.get(row.operation_id)!.action.kind==='text').map(row=>row.operation_id);
  if (submissions.length!==textIds.length||new Set(submissions.map(row=>row.operation_id)).size!==submissions.length) throw intakeUnavailable();
  const results=new Map<string,Readonly<OnboardingSafetyResult>>();
  const submissionEntries: Entry[]=submissions.map(row=>{
    const command=commands.get(row.operation_id);
    if (row.user_id!==binding.userId||row.draft_id!==binding.sourceDraftId||row.status!=='detected'||!command||command.action.kind!=='text'
      ||command.action.questionId!==row.question_id||command.expectedRevision+1!==row.submitted_revision) throw intakeUnavailable();
    const result=storage.decodeResult(row), text=storage.crypto!.openUtf8(row.result_ciphertext!,
      {table:'platform_onboarding_safety_submissions',column:'result_ciphertext',rowId:row.id,ownerId:binding.userId,revision:row.generation});
    if (text!==JSON.stringify(result)) throw intakeUnavailable();
    results.set(row.operation_id,result);
    return {submissionId:row.id,operationId:row.operation_id,questionId:row.question_id,submittedRevision:row.submitted_revision,
      status:row.status,generation:row.generation,authVersion:String(row.auth_version),detectorRevision:row.detector_revision!,
      originalLevel:row.level!,originalDetectorMode:row.detector_mode!,createdAt:checkTime(row.created_at),updatedAt:checkTime(row.updated_at),
      claimDigest:sha(JSON.stringify({leaseToken:row.lease_token,leaseUntil:at(row.lease_until!),executionToken:row.execution_token})),
      canonicalResultDigest:sha(text)};
  });
  const captures=await readAuthenticatedSafetyResponsesForSources(client,storage,binding.userId,submissions);
  const responseEntries: Entry[]=captures.map(({row,response})=>{
    if (row.status!=='ready'||!response||row.draft_id!==binding.sourceDraftId) throw intakeUnavailable();
    const text=storage.crypto!.openUtf8(row.payload_ciphertext!,{table:'platform_onboarding_safety_responses',column:'payload_ciphertext',
      rowId:row.id,ownerId:binding.userId,revision:1});
    const coordinates=['id','user_id','submission_id','operation_id','draft_id','question_id','submitted_revision','source_generation',
      'detector_revision','level','detector_mode','bundle_revision','content_digest','review_digest','locale'] as const;
    const expected={schemaVersion:1,...Object.fromEntries(coordinates.map(key=>[key,row[key]])),
      preparedAt:at(row.prepared_at!),retentionUntil:at(row.retention_until!),response};
    if (text!==JSON.stringify(expected)) throw intakeUnavailable();
    return {responseId:row.id,submissionId:row.submission_id,operationId:row.operation_id,questionId:row.question_id,
      submittedRevision:row.submitted_revision,sourceGeneration:row.source_generation,detectorRevision:row.detector_revision,
      originalLevel:row.level,originalDetectorMode:row.detector_mode,status:row.status,bundleRevision:row.bundle_revision!,
      contentDigest:row.content_digest!,reviewDigest:row.review_digest!,locale:row.locale!,createdAt:checkTime(row.created_at),
      preparedAt:checkTime(row.prepared_at!),retentionUntil:at(row.retention_until!),canonicalResponsePayloadDigest:sha(text)};
  });
  const responseIds=captures.map(item=>item.row.id);
  const events=(await client.query(`SELECT * FROM platform_safety_events WHERE user_id=$1 AND response_id=ANY($2::uuid[])
    ORDER BY created_at,id FOR UPDATE`,[binding.userId,responseIds])).rows;
  const eventEntries: Entry[]=events.map(row=>({eventId:row.id,responseId:row.response_id,submissionId:row.submission_id,
    sourceKind:row.source_kind,eventKind:row.event_kind,originalLevel:row.level,detectorRevision:row.detector_revision,
    originalDetectorMode:row.detector_mode,createdAt:checkTime(row.created_at),retentionUntil:at(row.retention_until)}));
  const publications=(await client.query<SafetyPublicationRow>(`SELECT * FROM platform_onboarding_safety_publications
    WHERE user_id=$1 AND response_id=ANY($2::uuid[]) ORDER BY published_at,id FOR UPDATE`,[binding.userId,responseIds])).rows;
  const publicationEntries: Entry[]=publications.map(row=>{
    const capture=captures.find(item=>item.row.id===row.response_id);
    if (!capture?.response||row.draft_id!==binding.sourceDraftId||row.submission_id!==capture.row.submission_id
      ||row.source_generation!==capture.row.source_generation||at(row.retention_until)!==at(capture.row.retention_until!)
      ||row.published_at<capture.row.prepared_at!) throw intakeUnavailable();
    const projection=publicSafetyResponse(capture.response), expected={schemaVersion:1,id:row.id,userId:binding.userId,
      draftId:binding.sourceDraftId,responseId:row.response_id,submissionId:row.submission_id,sourceGeneration:row.source_generation,
      preparedAt:at(capture.row.prepared_at!),publishedAt:at(row.published_at),retentionUntil:at(row.retention_until),
      projectionDigest:row.projection_digest,response:projection};
    const text=storage.crypto!.openUtf8(row.payload_ciphertext,{table:'platform_onboarding_safety_publications',column:'payload_ciphertext',
      rowId:row.id,ownerId:binding.userId,revision:1});
    if (row.projection_digest!==followupDigest(JSON.stringify(projection))||text!==JSON.stringify(expected)) throw intakeUnavailable();
    return {publicationId:row.id,responseId:row.response_id,submissionId:row.submission_id,sourceGeneration:row.source_generation,
      projectionDigest:row.projection_digest,publishedAt:checkTime(row.published_at),retentionUntil:at(row.retention_until),
      canonicalPublicationPayloadDigest:sha(text)};
  });
  const publicationIds=publications.map(row=>row.id);
  // Only captured IDs are read on verification. A later real support/present row
  // cannot replace an original row or make an original omission disappear.
  const followups=(await client.query<SafetyFollowupRow>(`SELECT * FROM platform_onboarding_safety_followups
    WHERE user_id=$1 AND publication_id=ANY($2::uuid[]) ${original?'AND operation_id=ANY($3::uuid[])':''}
    ORDER BY created_at,operation_id FOR UPDATE`,original
    ?[binding.userId,publicationIds,original.followups.map(row=>row.operationId)]
    :[binding.userId,publicationIds])).rows;
  const followupEntries: Entry[]=followups.map(row=>{
    const publication=publications.find(item=>item.id===row.publication_id);
    if (row.draft_id!==binding.sourceDraftId||!publication||row.applied_revision>binding.sourceRevision
      ||row.expected_revision>binding.sourceRevision||row.created_at<publication.published_at
      ||!row.handled&&row.created_at>=publication.retention_until) throw intakeUnavailable();
    const capture=captureFollowup(storage,row), text=storage.crypto!.openUtf8(row.payload_ciphertext,
      {table:'platform_onboarding_safety_followups',column:'payload_ciphertext',rowId:row.operation_id,ownerId:binding.userId,revision:row.applied_revision});
    if (text!==JSON.stringify(capture)) throw intakeUnavailable();
    return {operationId:row.operation_id,publicationId:row.publication_id,actionKind:row.action_kind,expectedRevision:row.expected_revision,
      appliedRevision:row.applied_revision,sessionHash:row.session_hash,presentationDigest:row.presentation_digest,
      presentationOperationId:row.presentation_operation_id,acknowledgmentOperationId:row.acknowledgment_operation_id,
      handled:row.handled,clarifiedAt:row.clarified_at?at(row.clarified_at):null,createdAt:checkTime(row.created_at),
      resumeStatus:capture.resumeStatus,canonicalFollowupPayloadDigest:sha(text)};
  });
  const handled=new Set<string>();
  for (const row of followups) {
    if (row.action_kind==='present'||row.action_kind==='need_support') continue;
    const present=followups.find(item=>item.operation_id===row.presentation_operation_id);
    if (!present||present.action_kind!=='present'||present.publication_id!==row.publication_id||present.session_hash!==row.session_hash
      ||present.presentation_digest!==row.presentation_digest||present.created_at>row.created_at) throw intakeUnavailable();
    if (row.action_kind==='acknowledge') continue;
    const ack=followups.find(item=>item.operation_id===row.acknowledgment_operation_id);
    if (!ack||ack.action_kind!=='acknowledge'||ack.publication_id!==row.publication_id||ack.session_hash!==row.session_hash
      ||ack.presentation_operation_id!==present.operation_id||ack.presentation_digest!==row.presentation_digest||ack.created_at>row.created_at) throw intakeUnavailable();
    const publication=publications.find(item=>item.id===row.publication_id)!;
    if (!row.handled||handled.has(publication.submission_id)) throw intakeUnavailable();
    handled.add(publication.submission_id);
  }
  // V1 remains its exact original codec and original-only refusal semantics.
  // New preparation can independently capture genuine050 handling; historical
  // V2 reconstruction is restricted to its actually captured original IDs.
  const modern=original?.schemaVersion===1?[]:await intakeResourcePrefixProofs(client,storage,binding.userId,binding.sourceDraftId,submissions,capturedAt,original?.intakeResources);
  for(const proof of modern)handled.add(proof.submissionId);
  if (submissions.some(row=>!handled.has(row.id)&&(row.level!=='L0'||row.detector_mode!=='full'))) throw intakeUnavailable();
  const manifest=Object.freeze({schemaVersion:modern.length?2 as const:1 as const,manifestId:binding.taskId,...binding,capturedAt,operations:frozenEntries(operationEntries),
    submissions:frozenEntries(submissionEntries),responses:frozenEntries(responseEntries),events:frozenEntries(eventEntries),
    publications:frozenEntries(publicationEntries),followups:frozenEntries(followupEntries),...(modern.length?{intakeResources:modern}:{}),handledSubmissionIds:Object.freeze([...handled].sort())});
  // Ephemeral values only. They are not part of the canonical manifest/ciphertext
  // and may be used for dimensions only after the whole manifest matches.
  const products: CapturedCompanionSourceProducts=Object.freeze({
    operations:Object.freeze(operations.map(row=>Object.freeze({operationId:row.operation_id,userId:row.user_id,
      draftId:row.draft_id,appliedRevision:row.applied_revision,command:commands.get(row.operation_id)!}))),
    submissions:Object.freeze(submissions.map(row=>Object.freeze({submissionId:row.id,operationId:row.operation_id,userId:row.user_id,
      draftId:row.draft_id,questionId:row.question_id,submittedRevision:row.submitted_revision,status:'detected' as const,
      generation:row.generation,authVersion:String(row.auth_version),detectorRevision:row.detector_revision!,
      level:row.level!,mode:row.detector_mode!,result:results.get(row.operation_id)!}))),
    handledSubmissionIds:manifest.handledSubmissionIds});
  return Object.freeze({manifest,products});
}

/** First genuine preparation only, under the caller's existing real current
 * source/account/safety/session gates and locks. This creates no execution grant. */
export async function captureCompanionSourcePrefixInTransaction(client: PoolClient, storage: OnboardingStorage,
  value: CompanionSourcePrefixBinding, source: OnboardingDraft): Promise<Readonly<CompanionSourcePrefixCapture>> {
  try {
    const binding=parseBinding(value), draft=parseOnboardingDraft(source);
    if (draft.id!==binding.sourceDraftId||draft.userId!==binding.userId||draft.revision!==binding.sourceRevision||draft.state!=='intake_ready') throw intakeUnavailable();
    const answers={schemaVersion:1,id:binding.answersId,userId:binding.userId,sourceDraftId:draft.id,
      sourceRevision:draft.revision,fastTrack:draft.fastTrack,answersPartial:draft.answersPartial};
    if (sha(JSON.stringify(answers))!==binding.canonicalAnswersDigest) throw intakeUnavailable();
    const capturedAt=at((await client.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0].at);
    const {manifest:payload}=await manifestAt(client,storage,binding,capturedAt);
    return Object.freeze({payload,digest:sha(JSON.stringify(payload))});
  } catch { throw intakeUnavailable(); }
}
/** INSERT-only after the actual new task exists. Never used by replay or read. */
export async function saveCompanionSourcePrefixInTransaction(client: PoolClient, storage: OnboardingStorage,
  value: Readonly<CompanionSourcePrefixCapture>): Promise<void> {
  try {
    const data=record(value,['payload','digest']), payload=parseManifest(data.payload), expectedDigest=digest(data.digest), text=JSON.stringify(payload);
    if (!storage.crypto||sha(text)!==expectedDigest) throw intakeUnavailable();
    const ciphertext=storage.crypto.sealUtf8(text,aad(payload));
    const saved=await client.query(`INSERT INTO platform_companion_source_prefixes
      (id,task_id,user_id,companion_id,answers_id,source_draft_id,source_revision,auth_version,questionnaire_revision,rules_revision,
        generator_version,purpose,schema_version,captured_at,payload_digest,payload_ciphertext)
      SELECT $1,$1,$2,$3,$4,$5,$6,$7,1,1,1,'companion_preview',$11,$8,$9,$10
      FROM platform_companion_generation_tasks WHERE id=$1 AND user_id=$2 AND companion_id=$3 AND answers_id=$4
        AND source_draft_id=$5 AND source_revision=$6 AND auth_version=$7 AND source_receipt_version=$11
        AND questionnaire_revision=1 AND rules_revision=1 AND generator_version=1 AND purpose='companion_preview'
        AND status='pending' AND generation=0 AND created_at>=$8::timestamptz`,
    [payload.taskId,payload.userId,payload.companionId,payload.answersId,payload.sourceDraftId,payload.sourceRevision,payload.authVersion,
      payload.capturedAt,expectedDigest,ciphertext,payload.schemaVersion]);
    if (saved.rowCount!==1) throw intakeUnavailable();
  } catch { throw intakeUnavailable(); }
}
/** No source recovery or manifest creation. Original ID completeness and every
 * original content/coordinate digest must still match the independent capture. */
export function verifyCompanionSourcePrefixInTransaction(client: PoolClient, storage: OnboardingStorage,
  value: CompanionSourcePrefixBinding, valueDigest: string): Promise<Readonly<CompanionSourcePrefixProof>>;
export function verifyCompanionSourcePrefixInTransaction(client: PoolClient, storage: OnboardingStorage,
  value: CompanionSourcePrefixBinding, valueDigest: string,
  capturedAnswers: Readonly<CapturedCompanionAnswers>): Promise<Readonly<CompanionSourcePrefixDimensionsProof>>;
export async function verifyCompanionSourcePrefixInTransaction(client: PoolClient, storage: OnboardingStorage,
  value: CompanionSourcePrefixBinding, valueDigest: string,
  capturedAnswers?: Readonly<CapturedCompanionAnswers>): Promise<Readonly<CompanionSourcePrefixProof>> {
  try {
    const binding=parseBinding(value), expectedDigest=digest(valueDigest);
    // Snapshot and bind the actual closed captured answers before the first
    // await. Caller coordinates or arbitrary value products are never proof.
    const captured=capturedAnswers===undefined?undefined:parseCapturedCompanionAnswers(capturedAnswers);
    if (captured&&(captured.id!==binding.answersId||captured.userId!==binding.userId
      ||captured.sourceDraftId!==binding.sourceDraftId||captured.sourceRevision!==binding.sourceRevision
      ||sha(JSON.stringify(captured))!==binding.canonicalAnswersDigest)) throw intakeUnavailable();
    if (!storage.crypto) throw intakeUnavailable();
    const rows=(await client.query(`SELECT m.* FROM platform_companion_source_prefixes m
      JOIN platform_companion_generation_tasks t ON t.id=m.task_id AND t.user_id=m.user_id AND t.companion_id=m.companion_id
      WHERE m.task_id=$1 AND m.user_id=$2 AND t.source_receipt_version=m.schema_version AND m.schema_version IN(1,2) FOR UPDATE OF m`,[binding.taskId,binding.userId])).rows;
    const row=rows[0];
    if (rows.length!==1||row.id!==binding.taskId||row.companion_id!==binding.companionId||row.answers_id!==binding.answersId
      ||row.source_draft_id!==binding.sourceDraftId||row.source_revision!==binding.sourceRevision||String(row.auth_version)!==binding.authVersion
      ||row.questionnaire_revision!==1||row.rules_revision!==1||row.generator_version!==1||row.purpose!==binding.purpose
      ||![1,2].includes(row.schema_version)||row.payload_digest!==expectedDigest) throw intakeUnavailable();
    const text=storage.crypto.openUtf8(row.payload_ciphertext,aad(binding)), original=parseManifest(JSON.parse(text));
    if (original.schemaVersion!==row.schema_version||sha(text)!==expectedDigest||JSON.stringify(original)!==text||original.capturedAt!==at(row.captured_at)
      ||JSON.stringify(parseBinding(Object.fromEntries(bindingKeys.map(key=>[key,original[key]]))))!==JSON.stringify(binding)) throw intakeUnavailable();
    const current=await manifestAt(client,storage,binding,original.capturedAt,original);
    if (JSON.stringify(current.manifest)!==text) throw intakeUnavailable();
    const proof={handledSubmissionIds:original.handledSubmissionIds,responseIds:Object.freeze(original.responses.map(row=>row.responseId as string)),
      publicationIds:Object.freeze(original.publications.map(row=>row.publicationId as string)),followupIds:Object.freeze(original.followups.map(row=>row.operationId as string)),
      eventIds:Object.freeze(original.events.map(row=>row.eventId as string))};
    if (!captured) return Object.freeze(proof);
    return Object.freeze({...proof,dimensions:deriveCapturedCompanionDimensions(captured,current.products)});
  } catch { throw intakeUnavailable(); }
}
