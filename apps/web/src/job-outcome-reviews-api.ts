import { JOB_OUTCOME_REVIEW_HISTORY_LIMIT, JOB_OUTCOME_REVIEW_MAX_RESPONSE_BYTES, JOB_OUTCOME_REVIEW_NOTE_BYTES, JOB_OUTCOME_REVIEW_NOTE_CHARACTERS, JOB_OUTCOME_REVIEW_OUTCOMES, type JobOutcomeEvidence, type JobOutcomeReviewInput, type JobOutcomeReviewPage, type JobOutcomeReviewRecord } from '@companion/platform-contracts';

type Transport = <T>(path: string, init?: RequestInit) => Promise<T>;
// Platform identifiers and saved request IDs are canonical lowercase UUIDs.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const statuses = ['needs_approval', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'uncertain'];
const kinds = ['image', 'video', 'speech', 'browser', 'cli', 'workflow', 'mcp'];
const reasons = ['job_uncertain', 'browser_execution_started', 'browser_checkpoint_missing', 'workflow_result_unknown', 'workflow_checkpoint_missing', 'mcp_call_recorded', 'cli_cleanup_unconfirmed', 'model_relay_uncertain', 'comfyui_submission_unknown'];
function fail(): never { throw new Error('任务版本、服务器事实或用户核对记录不完整，请重新读取。'); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  if (Object.keys(value).some((key) => !keys.includes(key))) fail();
  return value as Record<string, unknown>;
}
const integer = (value: unknown, minimum = 1): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= 2147483647;
const id = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && hash.test(value);
const boolean = (value: unknown): value is boolean => typeof value === 'boolean';
function bounded(value: unknown) {
  try { if (new TextEncoder().encode(JSON.stringify(value)).length > JOB_OUTCOME_REVIEW_MAX_RESPONSE_BYTES) fail(); }
  catch { fail(); }
}
export function validJobOutcomeReviewNote(note: unknown): note is string {
  if (typeof note !== 'string' || note.length > JOB_OUTCOME_REVIEW_NOTE_CHARACTERS || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note)) return false;
  const bytes = new TextEncoder().encode(note);
  return bytes.length <= JOB_OUTCOME_REVIEW_NOTE_BYTES && new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) === note;
}
export function parseJobOutcomeReviewRecord(value: unknown, jobId: string, generation: number): JobOutcomeReviewRecord {
  const row = object(value, ['id', 'jobId', 'generation', 'revision', 'requestId', 'evidenceVersion', 'outcome', 'note', 'provenance', 'verified', 'createdAt']);
  if (!id(row.id) || row.jobId !== jobId || row.generation !== generation || !integer(row.revision) || !id(row.requestId) || !digest(row.evidenceVersion) || !(JOB_OUTCOME_REVIEW_OUTCOMES as readonly unknown[]).includes(row.outcome) || row.note !== undefined && !validJobOutcomeReviewNote(row.note) || row.provenance !== 'user_reported' || row.verified !== false || typeof row.createdAt !== 'string' || row.createdAt.length > 40 || !Number.isFinite(Date.parse(row.createdAt))) fail();
  return row as unknown as JobOutcomeReviewRecord;
}
function evidence(value: unknown, generation: number): JobOutcomeEvidence {
  const row = object(value, ['version', 'generation', 'kind', 'status', 'totalAttempts', 'hasProviderTask', 'cleanupPending', 'reasons', 'attempts', 'attemptsHasMore', 'browser', 'workflow', 'mcp']);
  if (!digest(row.version) || row.generation !== generation || typeof row.kind !== 'string' || !kinds.includes(row.kind) || typeof row.status !== 'string' || !statuses.includes(row.status) || !integer(row.totalAttempts, 0) || !boolean(row.hasProviderTask) || !boolean(row.cleanupPending) || !boolean(row.attemptsHasMore) || !Array.isArray(row.reasons) || row.reasons.length > reasons.length || new Set(row.reasons).size !== row.reasons.length || row.reasons.some((reason) => typeof reason !== 'string' || !reasons.includes(reason)) || !Array.isArray(row.attempts) || row.attempts.length > JOB_OUTCOME_REVIEW_HISTORY_LIMIT) fail();
  const attempts = new Set<number>(); let previousAttempt = Number.MAX_SAFE_INTEGER;
  for (const value of row.attempts) {
    const attempt = object(value, ['attempt', 'status', 'hasProviderTask']);
    if (!integer(attempt.attempt) || attempt.attempt >= previousAttempt || attempts.has(attempt.attempt) || typeof attempt.status !== 'string' || !['running', 'succeeded', 'failed', 'cancelled', 'uncertain'].includes(attempt.status) || !boolean(attempt.hasProviderTask)) fail();
    attempts.add(attempt.attempt); previousAttempt = attempt.attempt;
  }
  if (row.browser !== undefined) {
    const item = object(row.browser, ['scope', 'revision', 'state', 'completedActions', 'totalActions']);
    if (row.kind !== 'browser' || item.scope !== 'task_checkpoint' || !integer(item.revision, 0) || typeof item.state !== 'string' || !['ready', 'started', 'completed', 'uncertain'].includes(item.state) || !integer(item.completedActions, 0) || !integer(item.totalActions, 0) || item.totalActions > 12 || item.completedActions > item.totalActions) fail();
  }
  if (row.workflow !== undefined) {
    const item = object(row.workflow, ['scope', 'revision', 'steps']);
    if (row.kind !== 'workflow' || item.scope !== 'task_checkpoint' || !integer(item.revision, 0) || !Array.isArray(item.steps) || item.steps.length > 8) fail();
    const indexes = new Set<number>(); let previousIndex = -1;
    for (const value of item.steps) {
      const step = object(value, ['index', 'state', 'hasProviderTask']);
      if (!integer(step.index, 0) || step.index > 7 || step.index <= previousIndex || indexes.has(step.index) || typeof step.state !== 'string' || !['started', 'provider_task', 'completed', 'failed', 'uncertain'].includes(step.state) || !boolean(step.hasProviderTask)) fail();
      indexes.add(step.index); previousIndex = step.index;
    }
  }
  if (row.mcp !== undefined) {
    const item = object(row.mcp, ['generation', 'status', 'hasSavedResult']);
    if (row.kind !== 'mcp' || !integer(item.generation) || item.generation > generation || typeof item.status !== 'string' || !['started', 'completed', 'tool_error', 'uncertain'].includes(item.status) || !boolean(item.hasSavedResult)) fail();
  }
  return row as unknown as JobOutcomeEvidence;
}
export function parseJobOutcomeReviewPage(value: unknown, jobId: string, generation?: number): JobOutcomeReviewPage {
  bounded(value);
  const page = object(value, ['jobId', 'requestedGeneration', 'currentGeneration', 'evidence', 'writeEligibility', 'latestRevision', 'records', 'hasMore']);
  if (!id(jobId) || page.jobId !== jobId || !integer(page.requestedGeneration) || !integer(page.currentGeneration) || page.requestedGeneration > page.currentGeneration || generation !== undefined && page.requestedGeneration !== generation || !integer(page.latestRevision, 0) || !boolean(page.hasMore) || !Array.isArray(page.records) || page.records.length > JOB_OUTCOME_REVIEW_HISTORY_LIMIT) fail();
  const eligibility = object(page.writeEligibility, ['allowed', 'reason']);
  if (!boolean(eligibility.allowed) || ![null, 'historical_generation', 'cleanup_pending', 'not_reviewable'].includes(eligibility.reason as string | null) || eligibility.allowed !== (eligibility.reason === null)) fail();
  if (page.requestedGeneration !== page.currentGeneration) {
    if (page.evidence !== null || eligibility.allowed || eligibility.reason !== 'historical_generation') fail();
  } else {
    if (page.evidence === null || eligibility.reason === 'historical_generation') fail();
    const facts = evidence(page.evidence, page.requestedGeneration);
    if (eligibility.allowed && (facts.cleanupPending || !facts.reasons.length || !['failed', 'cancelled', 'uncertain'].includes(facts.status)) || eligibility.reason === 'cleanup_pending' && !facts.cleanupPending) fail();
  }
  const records = page.records.map((row) => parseJobOutcomeReviewRecord(row, jobId, page.requestedGeneration as number));
  const ids = new Set<string>(), requests = new Set<string>(); let previousRevision = Number.MAX_SAFE_INTEGER;
  for (const row of records) {
    if (ids.has(row.id) || requests.has(row.requestId) || row.revision >= previousRevision || row.revision > page.latestRevision) fail();
    ids.add(row.id); requests.add(row.requestId); previousRevision = row.revision;
  }
  if (records.length ? records[0].revision !== page.latestRevision : page.latestRevision !== 0 || page.hasMore) fail();
  return page as unknown as JobOutcomeReviewPage;
}
export function parseJobOutcomeReviewSaved(value: unknown, jobId: string, input: JobOutcomeReviewInput): JobOutcomeReviewRecord {
  bounded(value); const saved = object(value, ['record']), record = parseJobOutcomeReviewRecord(saved.record, jobId, input.generation);
  if (record.requestId !== input.requestId || record.evidenceVersion !== input.evidenceVersion || record.outcome !== input.outcome || (record.note || '') !== (input.note?.trim() || '') || record.revision !== input.expectedRevision + 1) fail();
  return record;
}
export function createJobOutcomeReviewClient(transport: Transport) {
  return {
    async read(jobId: string, generation?: number, signal?: AbortSignal): Promise<JobOutcomeReviewPage> {
      if (!id(jobId) || generation !== undefined && !integer(generation)) fail(); signal?.throwIfAborted();
      const query = generation === undefined ? '' : `?generation=${generation}`;
      const value = await transport<unknown>(`/jobs/${encodeURIComponent(jobId)}/outcome-review${query}`, { signal }); signal?.throwIfAborted();
      return parseJobOutcomeReviewPage(value, jobId, generation);
    },
    async save(jobId: string, input: JobOutcomeReviewInput, signal?: AbortSignal): Promise<JobOutcomeReviewRecord> {
      object(input, ['generation', 'evidenceVersion', 'expectedRevision', 'requestId', 'outcome', 'note']);
      if (!id(jobId) || !integer(input.generation) || !digest(input.evidenceVersion) || !integer(input.expectedRevision, 0) || !id(input.requestId) || !(JOB_OUTCOME_REVIEW_OUTCOMES as readonly unknown[]).includes(input.outcome) || input.note !== undefined && !validJobOutcomeReviewNote(input.note)) fail(); signal?.throwIfAborted();
      const value = await transport<unknown>(`/jobs/${encodeURIComponent(jobId)}/outcome-reviews`, { method: 'POST', body: JSON.stringify(input), signal }); signal?.throwIfAborted();
      return parseJobOutcomeReviewSaved(value, jobId, input);
    },
  };
}
