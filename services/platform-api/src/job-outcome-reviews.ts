import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { JobOutcomeEvidence, JobOutcomeReviewInput, JobOutcomeReviewPage, JobOutcomeReviewReason, JobOutcomeReviewRecord, JobOutcomeReviewSaved } from '@companion/platform-contracts';
import { JOB_KINDS, JOB_OUTCOME_REVIEW_HISTORY_LIMIT, JOB_OUTCOME_REVIEW_NOTE_BYTES, JOB_OUTCOME_REVIEW_NOTE_CHARACTERS, JOB_OUTCOME_REVIEW_OUTCOMES } from '@companion/platform-contracts';
import type { Database } from './database.ts';
import { ApiError, identifier, invalid, notFound, object } from './errors.ts';

const INTEGER_MAX = 2147483647;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const jobStates = ['needs_approval', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'uncertain'] as const;
const attemptStates = ['running', 'succeeded', 'failed', 'cancelled', 'uncertain'] as const;
const browserStates = ['ready', 'started', 'completed', 'uncertain'] as const;
const workflowStates = ['started', 'provider_task', 'completed', 'failed', 'uncertain'] as const;
const mcpStates = ['started', 'completed', 'tool_error', 'uncertain'] as const;
const integer = (value: unknown, minimum: number, label: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > INTEGER_MAX) throw invalid(`Invalid ${label}.`);
  return value;
};
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw invalid('Use a valid review request ID.');
  return value.toLowerCase();
}
export function parseJobOutcomeReviewInput(value: unknown): JobOutcomeReviewInput {
  const data = object(value);
  if (Object.keys(data).some(key => !['generation', 'evidenceVersion', 'expectedRevision', 'requestId', 'outcome', 'note'].includes(key))) throw invalid('Unsupported outcome-review field.');
  const generation = integer(data.generation, 1, 'task version'), expectedRevision = integer(data.expectedRevision, 0, 'review revision');
  if (typeof data.evidenceVersion !== 'string' || !/^[a-f0-9]{64}$/.test(data.evidenceVersion)) throw invalid('Use the exact current evidence version.');
  if (typeof data.outcome !== 'string' || !JOB_OUTCOME_REVIEW_OUTCOMES.includes(data.outcome as JobOutcomeReviewInput['outcome'])) throw invalid('Choose a supported human observation.');
  if (data.note !== undefined && (typeof data.note !== 'string' || data.note.length > JOB_OUTCOME_REVIEW_NOTE_CHARACTERS || Buffer.byteLength(data.note, 'utf8') > JOB_OUTCOME_REVIEW_NOTE_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(data.note) || Buffer.from(data.note, 'utf8').toString('utf8') !== data.note)) throw invalid('Use a valid bounded review note.');
  const note = typeof data.note === 'string' ? data.note.trim() : '';
  return { generation, evidenceVersion: data.evidenceVersion, expectedRevision, requestId: uuid(data.requestId), outcome: data.outcome as JobOutcomeReviewInput['outcome'], ...(note ? { note } : {}) };
}
export function parseJobOutcomeReviewQuery(value: unknown): number | undefined {
  const data = object(value);
  if (Object.keys(data).some(key => key !== 'generation')) throw invalid('Unsupported outcome-review query.');
  if (data.generation === undefined) return undefined;
  if (typeof data.generation !== 'string' || !/^[1-9][0-9]{0,9}$/.test(data.generation)) throw invalid('Use one positive task version.');
  return integer(Number(data.generation), 1, 'task version');
}

/** Internal projections contain only the execution fields needed for the evidence token. */
export interface JobOutcomeEvidenceSources { attempts: any[]; browser?: any; workflow?: any; mcp?: any; relayUncertain: boolean }
const damaged = () => new ApiError(409, 'JOB_OUTCOME_EVIDENCE_UNAVAILABLE', 'The saved task evidence cannot be safely summarized.');
function storedInteger(value: unknown, minimum = 0, maximum = INTEGER_MAX): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) throw damaged();
  return value;
}
function storedState<T extends string>(value: unknown, states: readonly T[]): T {
  if (typeof value !== 'string' || !states.includes(value as T)) throw damaged();
  return value as T;
}
/** The public projection never returns arbitrary database strings or artifact-generation guesses. */
export function jobOutcomeEvidence(row: any, sources: JobOutcomeEvidenceSources): JobOutcomeEvidence {
  const generation = storedInteger(row.generation, 1), status = storedState(row.status, jobStates), kind = storedState(row.kind, JOB_KINDS);
  if (sources.browser && kind !== 'browser' || sources.workflow && kind !== 'workflow' || sources.mcp && kind !== 'mcp') throw damaged();
  const reasons: JobOutcomeReviewReason[] = [];
  if (status === 'uncertain') reasons.push('job_uncertain');
  const evidence: Omit<JobOutcomeEvidence, 'version'> = {
    generation, kind, status, totalAttempts: storedInteger(row.attempt_count), hasProviderTask: !!row.provider_task_id,
    cleanupPending: !!row.lease_token || !!row.lease_until, reasons,
    attempts: sources.attempts.slice(0, JOB_OUTCOME_REVIEW_HISTORY_LIMIT).map(attempt => ({ attempt: storedInteger(attempt.attempt, 1), status: storedState(attempt.status, attemptStates), hasProviderTask: !!attempt.provider_task_id })),
    attemptsHasMore: sources.attempts.length > JOB_OUTCOME_REVIEW_HISTORY_LIMIT,
  };
  if (sources.browser) {
    const saved = sources.browser;
    evidence.browser = { scope: 'task_checkpoint', revision: storedInteger(saved.revision), state: storedState(saved.state, browserStates), completedActions: storedInteger(saved.next_index, 0, 12), totalActions: storedInteger(saved.total_actions, 1, 12) };
    if (evidence.browser.completedActions > evidence.browser.totalActions) throw damaged();
    if (evidence.browser.revision > 0 || evidence.browser.completedActions > 0 || evidence.browser.state === 'uncertain') reasons.push('browser_execution_started');
  } else if (kind === 'browser' && Array.isArray(row.options?.actions) && row.options.actions.length > 0) reasons.push('browser_checkpoint_missing');
  if (sources.workflow) {
    const saved = sources.workflow;
    if (!Array.isArray(saved.steps) || saved.steps.length > 8) throw damaged();
    const steps: NonNullable<JobOutcomeEvidence['workflow']>['steps'] = saved.steps.map((step: any) => ({ index: storedInteger(step.index, 0, 7), state: storedState(step.state, workflowStates), hasProviderTask: !!step.providerTaskId }));
    evidence.workflow = { scope: 'task_checkpoint', revision: storedInteger(saved.revision), steps: steps.sort((a, b) => a.index - b.index) };
    if (new Set(evidence.workflow.steps.map(step => step.index)).size !== evidence.workflow.steps.length) throw damaged();
    if (evidence.workflow.steps.some(step => ['started', 'uncertain'].includes(step.state) && !step.hasProviderTask)) reasons.push('workflow_result_unknown');
  } else if (kind === 'workflow') reasons.push('workflow_checkpoint_missing');
  if (sources.mcp) {
    const saved = sources.mcp;
    evidence.mcp = { generation: storedInteger(saved.generation, 1), status: storedState(saved.status, mcpStates), hasSavedResult: !!saved.artifact_id && !!saved.response_hash };
    if (evidence.mcp.generation > generation || ['completed', 'tool_error'].includes(evidence.mcp.status) !== evidence.mcp.hasSavedResult) throw damaged();
    reasons.push('mcp_call_recorded');
  }
  if (row.error_code === 'CLI_CLEANUP_UNCONFIRMED') reasons.push('cli_cleanup_unconfirmed');
  if (sources.relayUncertain || row.error_code === 'MODEL_RELAY_UNCERTAIN') reasons.push('model_relay_uncertain');
  if (row.provider === 'comfyui' && status === 'uncertain' && !row.provider_task_id) reasons.push('comfyui_submission_unknown');
  // Hash private identifiers and checkpoint identities without exposing their values.
  const version = hash({ evidence, providerTask: row.provider_task_id ?? null, errorCode: row.error_code ?? null,
    lease: [row.lease_token ?? null, row.lease_until ?? null], attempts: sources.attempts.map(item => [item.attempt, item.status, item.provider_task_id ?? null]),
    browserHash: sources.browser?.definition_hash ?? null, workflowHash: sources.workflow?.definition_hash ?? null,
    workflowInputs: sources.workflow?.steps.map((item: any) => [item.index, item.inputHash, item.providerTaskId ?? null]) ?? null,
    mcpIdentity: sources.mcp ? [sources.mcp.generation, sources.mcp.definition_hash, sources.mcp.arguments_hash, sources.mcp.artifact_id, sources.mcp.response_hash] : null });
  return { version, ...evidence };
}
export function jobOutcomeWriteEligibility(evidence: JobOutcomeEvidence): JobOutcomeReviewPage['writeEligibility'] {
  if (evidence.cleanupPending) return { allowed: false, reason: 'cleanup_pending' };
  return ['failed', 'cancelled', 'uncertain'].includes(evidence.status) && evidence.reasons.length > 0
    ? { allowed: true, reason: null } : { allowed: false, reason: 'not_reviewable' };
}
function record(row: any): JobOutcomeReviewRecord {
  return { id: row.id, jobId: row.job_id, generation: row.generation, revision: row.revision, requestId: row.request_id,
    evidenceVersion: row.evidence_version, outcome: row.outcome, ...(row.note == null ? {} : { note: row.note }),
    provenance: 'user_reported', verified: false, createdAt: new Date(row.created_at).toISOString() };
}
async function evidenceSources(client: PoolClient, jobId: string, generation: number): Promise<JobOutcomeEvidenceSources> {
  const attempts = await client.query('SELECT attempt,status,provider_task_id FROM platform_job_attempts WHERE job_id=$1 AND generation=$2 ORDER BY attempt DESC LIMIT $3', [jobId, generation, JOB_OUTCOME_REVIEW_HISTORY_LIMIT + 1]);
  const browser = await client.query('SELECT definition_hash,revision,state,next_index,total_actions FROM platform_browser_checkpoints WHERE job_id=$1', [jobId]);
  const workflow = await client.query('SELECT definition_hash,revision,steps FROM platform_workflow_checkpoints WHERE job_id=$1', [jobId]);
  const mcp = await client.query('SELECT generation,status,definition_hash,arguments_hash,artifact_id,response_hash FROM platform_mcp_receipts WHERE job_id=$1', [jobId]);
  const relay = await client.query("SELECT EXISTS(SELECT 1 FROM platform_model_relay_requests WHERE job_id=$1 AND generation=$2 AND status IN ('reserved','uncertain')) AS uncertain", [jobId, generation]);
  return { attempts: attempts.rows, browser: browser.rows[0], workflow: workflow.rows[0], mcp: mcp.rows[0], relayUncertain: relay.rows[0].uncertain };
}

/** This module only inserts human observations; execution state is never updated. */
export class JobOutcomeReviews {
  constructor(readonly db: Database) {}
  async get(userId: string, id: string, query: unknown = {}, signal?: AbortSignal): Promise<JobOutcomeReviewPage> {
    const jobId = identifier(id).toLowerCase(), requested = parseJobOutcomeReviewQuery(query);
    signal?.throwIfAborted();
    return this.db.transaction(async client => {
      const row = (await client.query('SELECT * FROM platform_jobs WHERE id=$1 AND user_id=$2 FOR SHARE', [jobId, userId])).rows[0];
      signal?.throwIfAborted(); if (!row) throw notFound();
      const generation = requested ?? row.generation;
      if (generation > row.generation) throw new ApiError(409, 'JOB_OUTCOME_GENERATION_CHANGED', 'That task version is not available.');
      const found = await client.query('SELECT * FROM platform_job_outcome_reviews WHERE user_id=$1 AND job_id=$2 AND generation=$3 ORDER BY revision DESC LIMIT $4', [userId, jobId, generation, JOB_OUTCOME_REVIEW_HISTORY_LIMIT + 1]);
      const evidence = generation === row.generation ? jobOutcomeEvidence(row, await evidenceSources(client, jobId, generation)) : null;
      signal?.throwIfAborted();
      return { jobId, requestedGeneration: generation, currentGeneration: row.generation, evidence,
        writeEligibility: evidence ? jobOutcomeWriteEligibility(evidence) : { allowed: false, reason: 'historical_generation' },
        latestRevision: found.rows[0]?.revision ?? 0, records: found.rows.slice(0, JOB_OUTCOME_REVIEW_HISTORY_LIMIT).map(record), hasMore: found.rows.length > JOB_OUTCOME_REVIEW_HISTORY_LIMIT };
    });
  }
  async save(userId: string, id: string, value: unknown, signal?: AbortSignal): Promise<JobOutcomeReviewSaved> {
    const jobId = identifier(id).toLowerCase(), input = parseJobOutcomeReviewInput(value), requestHash = hash({ jobId, ...input });
    signal?.throwIfAborted();
    return this.db.transaction(async client => {
      await client.query('SELECT id FROM platform_users WHERE id=$1 FOR NO KEY UPDATE', [userId]);
      const row = (await client.query('SELECT * FROM platform_jobs WHERE id=$1 AND user_id=$2 FOR UPDATE', [jobId, userId])).rows[0];
      signal?.throwIfAborted(); if (!row) throw notFound();
      // An acknowledged or lost-acknowledgement commit is returned before later execution/CAS conflicts.
      const prior = (await client.query('SELECT * FROM platform_job_outcome_reviews WHERE user_id=$1 AND request_id=$2', [userId, input.requestId])).rows[0];
      signal?.throwIfAborted();
      if (prior) {
        if (prior.job_id !== jobId.toLowerCase() || prior.generation !== input.generation || prior.request_hash !== requestHash) throw new ApiError(409, 'JOB_OUTCOME_REQUEST_CONFLICT', 'That review request was already used for different input.');
        return { record: record(prior) };
      }
      if (input.generation !== row.generation) throw new ApiError(409, 'JOB_OUTCOME_GENERATION_CHANGED', 'The task version changed. Read the exact version before saving a new observation.');
      const evidence = jobOutcomeEvidence(row, await evidenceSources(client, jobId, input.generation));
      const eligibility = jobOutcomeWriteEligibility(evidence);
      if (!eligibility.allowed) throw new ApiError(409, eligibility.reason === 'cleanup_pending' ? 'JOB_OUTCOME_CLEANUP_PENDING' : 'JOB_OUTCOME_NOT_REVIEWABLE', eligibility.reason === 'cleanup_pending' ? 'Execution cleanup has not been confirmed. Read the evidence again after it stops.' : 'Only stopped tasks with an unknown or blocked execution outcome accept a manual observation.');
      if (input.evidenceVersion !== evidence.version) throw new ApiError(409, 'JOB_OUTCOME_EVIDENCE_CHANGED', 'The execution evidence changed. Read it again before saving your observation.');
      const latest = (await client.query('SELECT revision FROM platform_job_outcome_reviews WHERE user_id=$1 AND job_id=$2 AND generation=$3 ORDER BY revision DESC LIMIT 1', [userId, jobId, input.generation])).rows[0]?.revision ?? 0;
      if (latest !== input.expectedRevision) throw new ApiError(409, 'JOB_OUTCOME_REVISION_CONFLICT', 'Another manual observation was saved. Read it before saving a new observation.');
      if (latest === INTEGER_MAX) throw new ApiError(409, 'JOB_OUTCOME_REVISION_LIMIT', 'This review history cannot accept another revision.');
      signal?.throwIfAborted();
      const saved = await client.query(`INSERT INTO platform_job_outcome_reviews(id,job_id,user_id,generation,revision,request_id,request_hash,evidence_version,outcome,note)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [randomUUID(), jobId, userId, input.generation, latest + 1, input.requestId, requestHash, evidence.version, input.outcome, input.note ?? null]);
      signal?.throwIfAborted();
      return { record: record(saved.rows[0]) };
    });
  }
}
