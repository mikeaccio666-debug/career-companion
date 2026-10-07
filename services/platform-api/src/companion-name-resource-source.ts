import type { PoolClient } from 'pg';
import type { DataCrypto } from './data-crypto.ts';
import type { CompanionNameSubmissionRow } from './companion-name-safety.ts';
import { companionNameUuid, parseCompanionNameSafetyClaim, parseCompanionNameSafetyDecision,
  parseCompanionNameSubmissionRequest, type CompanionNameSafetyDecision } from './companion-name-safety-protocol.ts';
import { ApiError } from './errors.ts';

export const nameResourceSourceUnavailable = () => new ApiError(503, 'COMPANION_NAME_RESOURCE_SOURCE_UNAVAILABLE', 'The private classified name resource source could not be confirmed.');
export interface NameResourcePreviewSource {
  readonly taskId: string; readonly companionId: string; readonly previewRevision: 1; readonly generation: number;
  readonly sourceDraftId: string; readonly sourceRevision: number; readonly answersId: string;
  readonly questionnaireRevision: number; readonly rulesRevision: number; readonly generatorVersion: number;
}
/** Target history only. It is neither a verified preview nor an execution grant. */
export interface AuthenticatedNameResourceSource {
  readonly kind: 'classified_name_resource_source'; readonly source: Readonly<CompanionNameSubmissionRow>;
  readonly decision: Readonly<CompanionNameSafetyDecision>; readonly previewSource: Readonly<NameResourcePreviewSource>;
}
interface EntryBinding {
  id: string; user_id: string; task_id: string; companion_id: string; preview_revision: number;
}
interface TaskBinding {
  id: string; user_id: string; companion_id: string; source_draft_id: string; source_revision: number; answers_id: string;
  questionnaire_revision: number; rules_revision: number; generator_version: number; purpose: string;
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw nameResourceSourceUnavailable();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))
    || keys.some(key => !Object.hasOwn(descriptors,key)) || Object.values(descriptors).some(item => !('value' in item) || !item.enumerable)) throw nameResourceSourceUnavailable();
  return value as Record<string, unknown>;
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || Object.is(value,-0) || (value as number)<1 || (value as number)>2147483647) throw nameResourceSourceUnavailable();
  return value as number;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || /^[0-9a-f]{64}$/.exec(value)?.[0] !== value) throw nameResourceSourceUnavailable(); return value;
}
/** Only the originally sealed coordinates are interpreted. Preview/dimensions
 * remain opaque historical bytes and never become current preview authority. */
function previewSource(value: unknown): Readonly<NameResourcePreviewSource> {
  const capture = closed(value,['preview','dimensions','source']);
  for (const opaque of [capture.preview,capture.dimensions]) {
    if (!opaque || typeof opaque !== 'object' || Array.isArray(opaque)) throw nameResourceSourceUnavailable();
  }
  const data = closed(capture.source,['taskId','companionId','previewRevision','generation','sourceDraftId','sourceRevision','answersId',
    'questionnaireRevision','rulesRevision','generatorVersion']);
  if (data.previewRevision !== 1) throw nameResourceSourceUnavailable();
  return Object.freeze({taskId:companionNameUuid(data.taskId),companionId:companionNameUuid(data.companionId),previewRevision:1,
    generation:positive(data.generation),sourceDraftId:companionNameUuid(data.sourceDraftId),sourceRevision:positive(data.sourceRevision),
    answersId:companionNameUuid(data.answersId),questionnaireRevision:positive(data.questionnaireRevision),
    rulesRevision:positive(data.rulesRevision),generatorVersion:positive(data.generatorVersion)});
}
function requestCapture(crypto: DataCrypto, row: CompanionNameSubmissionRow) {
  try {
    const text = crypto.openUtf8(row.request_ciphertext,{table:'platform_companion_name_submissions',column:'request_ciphertext',
      rowId:row.id,ownerId:row.user_id,revision:row.submitted_revision});
    const data = closed(JSON.parse(text),['schemaVersion','id','userId','operationId','entryId','taskId','companionId','previewRevision',
      'submittedAtRevision','expectedIdentityRevision','submittedAuthVersion','submittedSessionHash','applicationOperationId','previewCapture','request']);
    const request = parseCompanionNameSubmissionRequest(data.request), original = previewSource(data.previewCapture);
    if (request.operationId !== row.operation_id || request.taskId !== row.task_id || request.expectedEntryRevision+1 !== row.submitted_revision
      || request.expectedIdentityRevision !== row.expected_identity_revision || original.taskId !== row.task_id
      || original.companionId !== row.companion_id || original.previewRevision !== row.preview_revision) throw nameResourceSourceUnavailable();
    const payload = {schemaVersion:1,id:row.id,userId:row.user_id,operationId:row.operation_id,entryId:row.entry_id,
      taskId:row.task_id,companionId:row.companion_id,previewRevision:1,submittedAtRevision:row.submitted_revision,
      expectedIdentityRevision:row.expected_identity_revision,submittedAuthVersion:String(row.submitted_auth_version),
      submittedSessionHash:hash(data.submittedSessionHash),applicationOperationId:row.application_operation_id,previewCapture:data.previewCapture,request};
    if (text !== JSON.stringify(payload)) throw nameResourceSourceUnavailable();
    return {payload,original};
  } catch { throw nameResourceSourceUnavailable(); }
}
function rowClaim(row: CompanionNameSubmissionRow) {
  return parseCompanionNameSafetyClaim({submissionId:row.id,userId:row.user_id,operationId:row.operation_id,entryId:row.entry_id,
    taskId:row.task_id,companionId:row.companion_id,previewRevision:row.preview_revision,submittedAtRevision:row.submitted_revision,
    expectedIdentityRevision:row.expected_identity_revision,generation:row.generation,authVersion:String(row.auth_version),
    leaseToken:row.lease_token,detectorRevision:row.detector_revision});
}
function authenticateClaim(crypto: DataCrypto, row: CompanionNameSubmissionRow, sourceCapture: ReturnType<typeof requestCapture>['payload']) {
  try {
    const claim = rowClaim(row), text = crypto.openUtf8(row.claim_ciphertext!,{table:'platform_companion_name_submissions',
      column:'claim_ciphertext',rowId:row.id,ownerId:row.user_id,revision:row.generation});
    const data = closed(JSON.parse(text),['schemaVersion','claim','sessionTokenHash','sourceCapture']);
    if (text !== JSON.stringify({schemaVersion:1,claim,sessionTokenHash:hash(data.sessionTokenHash),sourceCapture})) throw nameResourceSourceUnavailable();
    return claim;
  } catch { throw nameResourceSourceUnavailable(); }
}
async function completedUsage(client: PoolClient, row: CompanionNameSubmissionRow) {
  const found = await client.query(`SELECT call_id,provider,model,usage_status,input_tokens,output_tokens,
    EXTRACT(EPOCH FROM admitted_at)::text AS admitted_exact,EXTRACT(EPOCH FROM finished_at)::text AS finished_exact
    FROM platform_safety_model_usage WHERE source_kind='companion_name' AND submission_id=$1 AND user_id=$2 AND operation_id=$3
      AND entry_id=$4 AND task_id=$5 AND companion_id=$6 AND preview_revision=$7 AND submitted_revision=$8 AND expected_identity_revision=$9
      AND generation=$10 AND auth_version=$11 AND detector_revision=$12 AND name_execution_token=$13
      AND draft_id IS NULL AND question_id IS NULL AND purpose='safety_classify' AND call_index=1 AND status='complete'
      AND usage_status IN ('reported','missing','invalid') AND admitted_at IS NOT NULL AND finished_at IS NOT NULL
      AND admitted_at<=finished_at AND finished_at<=clock_timestamp() FOR SHARE`,
  [row.id,row.user_id,row.operation_id,row.entry_id,row.task_id,row.companion_id,row.preview_revision,row.submitted_revision,
    row.expected_identity_revision,row.generation,row.auth_version,row.detector_revision,row.execution_token]);
  if (found.rows.length !== 1) throw nameResourceSourceUnavailable();
  const usage = found.rows[0];
  return {callId:usage.call_id,provider:usage.provider,model:usage.model,usageStatus:usage.usage_status,
    inputTokens:usage.input_tokens,outputTokens:usage.output_tokens,admittedAt:usage.admitted_exact,finishedAt:usage.finished_exact};
}

/** No source/current-preview/prefix/all-history/identity admission is consumed.
 * The original source lease/session is historical evidence, not current access. */
export async function readNameResourceSourceInTransaction(client: PoolClient, crypto: DataCrypto | undefined,
  actualSubmissionId: string, signal?: AbortSignal): Promise<Readonly<AuthenticatedNameResourceSource>> {
  const id = companionNameUuid(actualSubmissionId); signal?.throwIfAborted();
  if (!crypto) throw nameResourceSourceUnavailable();
  const reference = (await client.query<{user_id:string}>('SELECT user_id FROM platform_companion_name_submissions WHERE id=$1',[id])).rows[0];
  if (!reference) throw new ApiError(404,'NOT_FOUND','The classified name source is not available.');
  // Match all owner writes: the live account lock precedes source/entry locks.
  const account = (await client.query<{account_kind:string}>('SELECT account_kind FROM platform_users WHERE id=$1 FOR NO KEY UPDATE',[reference.user_id])).rows[0];
  if (!account || account.account_kind !== 'student') throw nameResourceSourceUnavailable();
  const row = (await client.query<CompanionNameSubmissionRow>('SELECT * FROM platform_companion_name_submissions WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,reference.user_id])).rows[0];
  if (!row || row.status !== 'detected' || !row.result_ciphertext || !row.claim_ciphertext || !row.execution_token
    || row.preview_revision !== 1) throw nameResourceSourceUnavailable();
  const entry = (await client.query<EntryBinding>('SELECT id,user_id,task_id,companion_id,preview_revision FROM platform_companion_name_entries WHERE id=$1 FOR SHARE',[row.entry_id])).rows[0];
  const task = (await client.query<TaskBinding>(`SELECT id,user_id,companion_id,source_draft_id,source_revision,answers_id,
    questionnaire_revision,rules_revision,generator_version,purpose FROM platform_companion_generation_tasks WHERE id=$1 FOR SHARE`,[row.task_id])).rows[0];
  if (!entry || !task || entry.user_id !== row.user_id || entry.task_id !== row.task_id || entry.companion_id !== row.companion_id
    || entry.preview_revision !== row.preview_revision || task.user_id !== row.user_id || task.companion_id !== row.companion_id
    || task.purpose !== 'companion_preview') throw nameResourceSourceUnavailable();
  const capture = requestCapture(crypto,row), original = capture.original;
  if (original.sourceDraftId !== task.source_draft_id || original.sourceRevision !== task.source_revision || original.answersId !== task.answers_id
    || original.questionnaireRevision !== task.questionnaire_revision || original.rulesRevision !== task.rules_revision
    || original.generatorVersion !== task.generator_version) throw nameResourceSourceUnavailable();
  const claim = authenticateClaim(crypto,row,capture.payload);
  let text: string, data: Record<string,unknown>, decision: Readonly<CompanionNameSafetyDecision>;
  try {
    text = crypto.openUtf8(row.result_ciphertext,{table:'platform_companion_name_submissions',column:'result_ciphertext',
      rowId:row.id,ownerId:row.user_id,revision:row.generation});
    data = closed(JSON.parse(text),['schemaVersion','claim','executionToken','sourceCapture','decision','modelUsage']);
    decision = parseCompanionNameSafetyDecision(data.decision);
    companionNameUuid(row.execution_token);
  } catch { throw nameResourceSourceUnavailable(); }
  const modelUsage = decision.mode === 'full' ? await completedUsage(client,row) : null;
  if (row.level !== decision.level || row.detector_mode !== decision.mode || text !== JSON.stringify({schemaVersion:1,claim,
    executionToken:row.execution_token,sourceCapture:capture.payload,decision,modelUsage})) throw nameResourceSourceUnavailable();
  signal?.throwIfAborted();
  return Object.freeze({kind:'classified_name_resource_source',source:Object.freeze(row),decision,previewSource:original});
}
