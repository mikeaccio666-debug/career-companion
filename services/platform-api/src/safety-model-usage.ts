import { parseModelCallUsage } from '@companion/platform-contracts';
import { parseMemorySafetyClaim,type MemorySafetyClaim } from './shared-memory-safety-protocol.ts';
import type { ModelCallEvent } from '@companion/platform-contracts';
import type { PoolClient } from 'pg';
import type { Database } from './database.ts';
import type { ResolvedModelRoute } from './model-routing.ts';
import { parseOnboardingSafetyClaim, type OnboardingSafetyClaim } from './onboarding-safety-protocol.ts';
import { parseCompanionNameSafetyClaim, type CompanionNameSafetyClaim } from './companion-name-safety-protocol.ts';
import { ApiError } from './errors.ts';

export interface SafetyModelUsage {
  onModelCall(event: ModelCallEvent): Promise<void>;
  /** Only the actual provider-request guard calls this, using its own real transaction client. */
  assertAdmitted(client: PoolClient, signal?: AbortSignal): Promise<void>;
  /** A full result requires the real completed, admitted call in the result transaction. */
  assertComplete(client: PoolClient, signal?: AbortSignal): Promise<void>;
}
const terminal = ['complete', 'failed', 'cancelled', 'interrupted'];
const unavailable = () => new ApiError(503, 'ONBOARDING_SAFETY_UNAVAILABLE', 'The safety model call could not be confirmed.');
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw unavailable();
  const descriptors = Object.getOwnPropertyDescriptors(value), allowed = [...required, ...optional];
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key)) || required.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(descriptor => !('value' in descriptor))) throw unavailable();
  return value as Record<string, unknown>;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(value)?.[0] !== value) throw unavailable(); return value;
}
function tokens(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 2147483647) throw unavailable(); return value;
}
function bounded(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > maximum
    || /[\x00-\x1f\x7f]/.test(value) || Buffer.from(value, 'utf8').toString('utf8') !== value) throw unavailable(); return value;
}
interface UsageRow {
  call_id: string; user_id: string; submission_id: string; operation_id: string; draft_id: string | null; question_id: string | null;
  source_kind: 'onboarding' | 'companion_name' | 'shared_memory'; memory_id:string|null; memory_execution_token:string|null; entry_id: string | null; task_id: string | null; companion_id: string | null;
  preview_revision: number | null; expected_identity_revision: number | null; name_execution_token: string | null;
  submitted_revision: number; generation: number; auth_version: string; detector_revision: number; call_index: number;
  provider: string; model: string; purpose: string; status: string; usage_status: string; input_tokens: number | null; output_tokens: number | null;
  admitted_at: Date | null; finished_at: Date | null; cached_input_tokens: number | null; cache_write_input_tokens: number | null;
}
/** Server-owned execution context emitted by the concrete naming source after its real execution-token COMMIT. */
export interface CompanionNameSafetyExecution {
  readonly executionToken: string;
  readonly assertCurrent: (client: PoolClient, signal?: AbortSignal) => Promise<void>;
}
export interface MemorySafetyExecution {readonly executionToken:string;readonly assertCurrent:(client:PoolClient,signal?:AbortSignal)=>Promise<void>;}

type Binding = Readonly<{ kind: 'onboarding'; claim: Readonly<OnboardingSafetyClaim> }>
  | Readonly<{ kind: 'companion_name'; claim: Readonly<CompanionNameSafetyClaim>; execution: Readonly<CompanionNameSafetyExecution> }>
  | Readonly<{kind:'shared_memory';claim:Readonly<MemorySafetyClaim>;execution:Readonly<MemorySafetyExecution>}>;
/** A daily call-count cap plus explicit usage uncertainty. This is not a dollar CostGuard or an approved production budget. */
export function createSafetyModelUsage(db: Database, value: OnboardingSafetyClaim, route: ResolvedModelRoute, dailyLimit: number): SafetyModelUsage {
  try { return createBoundSafetyModelUsage(db, { kind: 'onboarding', claim: parseOnboardingSafetyClaim(value) }, route, dailyLimit); }
  catch { throw unavailable(); }
}
/** A real name claim uses the same account-wide ledger and cannot reset onboarding quota or unresolved usage. */
export function createCompanionNameSafetyModelUsage(db: Database, value: CompanionNameSafetyClaim, route: ResolvedModelRoute,
  dailyLimit: number, execution: CompanionNameSafetyExecution): SafetyModelUsage {
  try {
    const captured = record(execution, ['executionToken', 'assertCurrent']);
    if (typeof captured.assertCurrent !== 'function') throw unavailable();
    const fixed = Object.freeze({ executionToken: uuid(captured.executionToken), assertCurrent: captured.assertCurrent as CompanionNameSafetyExecution['assertCurrent'] });
    return createBoundSafetyModelUsage(db, { kind: 'companion_name', claim: parseCompanionNameSafetyClaim(value), execution: fixed }, route, dailyLimit);
  } catch { throw new ApiError(503, 'COMPANION_NAME_SAFETY_UNAVAILABLE', 'Name detection is not available.'); }
}
export function createMemorySafetyModelUsage(db:Database,value:MemorySafetyClaim,route:ResolvedModelRoute,dailyLimit:number,execution:MemorySafetyExecution):SafetyModelUsage {
 const v=record(execution,['executionToken','assertCurrent']);if(typeof v.assertCurrent!=='function')throw unavailable();
 return createBoundSafetyModelUsage(db,{kind:'shared_memory',claim:parseMemorySafetyClaim(value),execution:Object.freeze({executionToken:uuid(v.executionToken),assertCurrent:v.assertCurrent as MemorySafetyExecution['assertCurrent']})},route,dailyLimit);
}
function createBoundSafetyModelUsage(db: Database, binding: Binding, route: ResolvedModelRoute, dailyLimit: number): SafetyModelUsage {
  const claim = binding.claim;
  const unavailable = () => binding.kind === 'shared_memory'?new ApiError(503,'MEMORY_SAFETY_UNAVAILABLE','The memory safety model call could not be confirmed.'):binding.kind === 'onboarding'
    ? new ApiError(503, 'ONBOARDING_SAFETY_UNAVAILABLE', 'The safety model call could not be confirmed.')
    : new ApiError(503, 'COMPANION_NAME_SAFETY_UNAVAILABLE', 'The name safety model call could not be confirmed.');
  let provider: string, model: string;
  try {
    const fixed = record(route, ['purpose', 'provider', 'model']);
    if (fixed.purpose !== 'safety_classify') throw unavailable();
    provider = bounded(fixed.provider, 80); model = bounded(fixed.model, 150);
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.exec(provider)?.[0] !== provider
      || !Number.isSafeInteger(dailyLimit) || dailyLimit < 0 || dailyLimit > 10000) throw unavailable();
  } catch { throw unavailable(); }
  // Captured only after the prepared reservation's actual COMMIT. It grants no execution by itself.
  let acceptedCallId: string | undefined;
  async function account(client: PoolClient, checkVersion: boolean, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const found = await client.query('SELECT auth_version FROM platform_users WHERE id=$1 FOR NO KEY UPDATE', [claim.userId]);
    signal?.throwIfAborted();
    if (!found.rowCount || checkVersion && String(found.rows[0].auth_version) !== claim.authVersion) throw unavailable();
  }
  async function current(client: PoolClient, signal?: AbortSignal) {
    if(binding.kind==='shared_memory'){
      const memory=binding.claim;await binding.execution.assertCurrent(client,signal);
      const found=await client.query(`SELECT id FROM platform_memory_safety_sources WHERE id=$1 AND user_id=$2 AND memory_id=$3 AND operation_id=$4 AND submitted_revision=$5
       AND generation=$6 AND auth_version=$7 AND lease_token=$8 AND detector_revision=$9 AND execution_token=$10 AND status='running' AND lease_until>clock_timestamp() FOR UPDATE`,
       [memory.submissionId,memory.userId,memory.memoryId,memory.operationId,memory.submittedAtRevision,memory.generation,memory.authVersion,memory.leaseToken,memory.detectorRevision,binding.execution.executionToken]);
      signal?.throwIfAborted();if(!found.rowCount)throw unavailable();return;
    }

    if (binding.kind === 'companion_name') {
      const name = binding.claim;
      // This closure authenticates the actual generation session and complete encrypted source under the same transaction.
      await binding.execution.assertCurrent(client, signal);
      const found = await client.query(`SELECT id FROM platform_companion_name_submissions
        WHERE id=$1 AND user_id=$2 AND operation_id=$3 AND entry_id=$4 AND task_id=$5 AND companion_id=$6
          AND preview_revision=$7 AND submitted_revision=$8 AND expected_identity_revision=$9
          AND generation=$10 AND auth_version=$11 AND lease_token=$12 AND detector_revision=$13 AND execution_token=$14
          AND status='running' AND lease_until>clock_timestamp() FOR UPDATE`,
      [name.submissionId, name.userId, name.operationId, name.entryId, name.taskId, name.companionId,
        name.previewRevision, name.submittedAtRevision, name.expectedIdentityRevision, name.generation,
        name.authVersion, name.leaseToken, name.detectorRevision, binding.execution.executionToken]);
      signal?.throwIfAborted(); if (!found.rowCount) throw unavailable();
      return;
    }
    const intake = binding.claim;
    const found = await client.query(`SELECT id FROM platform_onboarding_safety_submissions
      WHERE id=$1 AND user_id=$2 AND operation_id=$3 AND draft_id=$4 AND question_id=$5 AND submitted_revision=$6
        AND generation=$7 AND auth_version=$8 AND lease_token=$9 AND detector_revision=$10
        AND status='running' AND lease_until>clock_timestamp() FOR UPDATE`,
    [intake.submissionId, intake.userId, intake.operationId, intake.draftId, intake.questionId, intake.submittedAtRevision,
      intake.generation, intake.authVersion, intake.leaseToken, intake.detectorRevision]);
    signal?.throwIfAborted(); if (!found.rowCount) throw unavailable();
  }
  function matches(row: UsageRow | undefined, callId: string): row is UsageRow {
    if (!row || row.call_id !== callId || row.user_id !== claim.userId || row.submission_id !== claim.submissionId
      || row.source_kind !== binding.kind || row.operation_id !== claim.operationId || row.submitted_revision !== claim.submittedAtRevision
      || row.generation !== claim.generation || String(row.auth_version) !== claim.authVersion || row.detector_revision !== claim.detectorRevision
      || row.call_index !== 1 || row.provider !== provider || row.model !== model || row.purpose !== 'safety_classify') return false;
    if(binding.kind==='shared_memory')return row.memory_id===binding.claim.memoryId&&row.memory_execution_token===binding.execution.executionToken
      &&row.draft_id===null&&row.question_id===null&&row.entry_id===null&&row.task_id===null&&row.companion_id===null&&row.preview_revision===null&&row.expected_identity_revision===null&&row.name_execution_token===null;
    if(row.memory_id!==null||row.memory_execution_token!==null)return false;
    if (binding.kind === 'onboarding') return row.draft_id === binding.claim.draftId && row.question_id === binding.claim.questionId
      && row.entry_id === null && row.task_id === null && row.companion_id === null && row.preview_revision === null && row.expected_identity_revision === null && row.name_execution_token === null;
    const name = binding.claim;
    return row.draft_id === null && row.question_id === null && row.entry_id === name.entryId && row.task_id === name.taskId
      && row.companion_id === name.companionId && row.preview_revision === name.previewRevision && row.expected_identity_revision === name.expectedIdentityRevision
      && row.name_execution_token === binding.execution.executionToken;
  }
  function event(input: ModelCallEvent) {
    const base = record(input, ['type', 'callId'], ['index', 'provider', 'model', 'purpose', 'status', 'usage']);
    const callId = uuid(base.callId);
    if (base.type === 'started') {
      const start = record(input, ['type', 'callId', 'index', 'provider', 'model', 'purpose']);
      if (start.index !== 1 || start.provider !== provider || start.model !== model || start.purpose !== 'safety_classify') throw unavailable();
      return { type: 'started' as const, callId };
    }
    const finish = record(input, ['type', 'callId', 'status', 'usage']);
    if (finish.type !== 'finished' || typeof finish.status !== 'string' || !terminal.includes(finish.status)) throw unavailable();
    const usage = parseModelCallUsage(finish.usage);
    return { type: 'finished' as const, callId, status: finish.status, usage: usage.status,
      input: usage.status === 'reported' ? usage.inputTokens : null, output: usage.status === 'reported' ? usage.outputTokens : null,
      cached: usage.status === 'reported' ? usage.cachedInputTokens ?? null : null,
      written: usage.status === 'reported' ? usage.cacheWriteInputTokens ?? null : null };

  }
  return Object.freeze({
    async onModelCall(input: ModelCallEvent): Promise<void> {
      try {
        const snapshot = event(input);
        if (snapshot.type === 'started') {
          if (acceptedCallId && acceptedCallId !== snapshot.callId) throw unavailable();
          await db.withBoundedTransaction(async client => {
            await account(client, true); await current(client);
            const found = await client.query<UsageRow>('SELECT * FROM platform_safety_model_usage WHERE submission_id=$1 AND generation=$2 AND source_kind=$3 FOR UPDATE', [claim.submissionId, claim.generation, binding.kind]);
            if (found.rows[0]) {
              if (!matches(found.rows[0], snapshot.callId) || found.rows[0].status !== 'prepared') throw unavailable();
              await current(client); return;
            }
            if (dailyLimit < 1) throw unavailable();
            const at = (await client.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0].at.toISOString();
            const coverage = await client.query(`SELECT
              count(*) FILTER(WHERE created_at >= (date_trunc('day',$2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
                AND created_at < ((date_trunc('day',$2::timestamptz AT TIME ZONE 'UTC')+interval '1 day') AT TIME ZONE 'UTC'))::int AS daily,
              bool_or(status IN ('prepared','admitted') OR usage_status<>'reported') AS unknown
              FROM platform_safety_model_usage WHERE user_id=$1`, [claim.userId, at]);
            if (coverage.rows[0].unknown || coverage.rows[0].daily >= dailyLimit) throw unavailable();
            await current(client);
            if(binding.kind==='shared_memory'){
              const memory=binding.claim;await client.query(`INSERT INTO platform_safety_model_usage(call_id,user_id,submission_id,operation_id,memory_id,submitted_revision,generation,auth_version,detector_revision,call_index,provider,model,purpose,created_at,source_kind,memory_execution_token)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,'safety_classify',$12,'shared_memory',$13)`,
               [snapshot.callId,memory.userId,memory.submissionId,memory.operationId,memory.memoryId,memory.submittedAtRevision,memory.generation,memory.authVersion,memory.detectorRevision,provider,model,at,binding.execution.executionToken]);
            }else if (binding.kind === 'onboarding') {
              const intake = binding.claim;
              await client.query(`INSERT INTO platform_safety_model_usage(call_id,user_id,submission_id,operation_id,draft_id,question_id,
                submitted_revision,generation,auth_version,detector_revision,call_index,provider,model,purpose,created_at,source_kind)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$12,'safety_classify',$13,'onboarding')`,
              [snapshot.callId, intake.userId, intake.submissionId, intake.operationId, intake.draftId, intake.questionId,
                intake.submittedAtRevision, intake.generation, intake.authVersion, intake.detectorRevision, provider, model, at]);
            } else {
              const name = binding.claim;
              await client.query(`INSERT INTO platform_safety_model_usage(call_id,user_id,submission_id,operation_id,entry_id,task_id,
                companion_id,preview_revision,expected_identity_revision,submitted_revision,generation,auth_version,detector_revision,
                call_index,provider,model,purpose,created_at,source_kind,name_execution_token)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,$14,$15,'safety_classify',$16,'companion_name',$17)`,
              [snapshot.callId, name.userId, name.submissionId, name.operationId, name.entryId, name.taskId, name.companionId,
                name.previewRevision, name.expectedIdentityRevision, name.submittedAtRevision, name.generation, name.authVersion,
                name.detectorRevision, provider, model, at, binding.execution.executionToken]);
            }
            await current(client);
          });
          acceptedCallId = snapshot.callId; return;
        }
        if (acceptedCallId !== snapshot.callId) throw unavailable();
        await db.withBoundedTransaction(async client => {
          // Completion of an actual accepted call is accounting, not new execution. Auth reset/lease expiry cannot erase its measured usage.
          await account(client, false);
          const found = await client.query<UsageRow>('SELECT * FROM platform_safety_model_usage WHERE call_id=$1 AND user_id=$2 FOR UPDATE', [snapshot.callId, claim.userId]);
          const row = found.rows[0]; if (!matches(row, snapshot.callId)) throw unavailable();
          if (terminal.includes(row.status)) {
            if (row.status !== snapshot.status || row.usage_status !== snapshot.usage || row.input_tokens !== snapshot.input || row.output_tokens !== snapshot.output || row.cached_input_tokens !== snapshot.cached || row.cache_write_input_tokens !== snapshot.written) throw unavailable();
            return;
          }
          if (!['prepared', 'admitted'].includes(row.status) || snapshot.status === 'complete' && row.admitted_at === null) throw unavailable();
          await client.query(`UPDATE platform_safety_model_usage SET status=$2,usage_status=$3,input_tokens=$4,output_tokens=$5,cached_input_tokens=$6,cache_write_input_tokens=$7,finished_at=clock_timestamp()
            WHERE call_id=$1`, [snapshot.callId, snapshot.status, snapshot.usage, snapshot.input, snapshot.output, snapshot.cached, snapshot.written]);
        });
      } catch { throw unavailable(); }
    },
    async assertComplete(client: PoolClient, signal?: AbortSignal): Promise<void> {
      try {
        signal?.throwIfAborted(); if (!acceptedCallId) throw unavailable();
        await account(client, true, signal); await current(client, signal);
        const found = await client.query<UsageRow>('SELECT * FROM platform_safety_model_usage WHERE call_id=$1 AND user_id=$2 FOR UPDATE', [acceptedCallId, claim.userId]);
        const row = found.rows[0];
        if (!matches(row, acceptedCallId) || row.status !== 'complete' || row.admitted_at === null || row.finished_at === null
          || !['reported', 'missing', 'invalid'].includes(row.usage_status)) throw unavailable();
        await current(client, signal);
      } catch { if (signal?.aborted) signal.throwIfAborted(); throw unavailable(); }
    },
    async assertAdmitted(client: PoolClient, signal?: AbortSignal): Promise<void> {
      try {
        signal?.throwIfAborted(); if (!acceptedCallId) throw unavailable();
        await account(client, true, signal); await current(client, signal);
        const found = await client.query<UsageRow>('SELECT * FROM platform_safety_model_usage WHERE call_id=$1 AND user_id=$2 FOR UPDATE', [acceptedCallId, claim.userId]);
        const row = found.rows[0]; if (!matches(row, acceptedCallId) || row.status !== 'prepared' || row.usage_status !== 'pending') throw unavailable();
        await current(client, signal);
        const saved = await client.query(`UPDATE platform_safety_model_usage SET status='admitted',admitted_at=clock_timestamp()
          WHERE call_id=$1 AND status='prepared' RETURNING call_id`, [acceptedCallId]);
        signal?.throwIfAborted(); if (!saved.rowCount) throw unavailable();
        await current(client, signal);
      } catch (error) { if (signal?.aborted) signal.throwIfAborted(); throw unavailable(); }
    },
  });
}
