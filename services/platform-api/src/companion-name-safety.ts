import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ProviderRequestAdmission } from '@companion/platform-contracts';
import type { CompanionNameCategory } from '@companion/career-core';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { BackgroundGeneration, VerifiedCompanionPreviewEnvelope } from './background-generation.ts';
import type { PlatformConfig } from './config.ts';
import type { Database } from './database.ts';
import type { LegalBundle } from './legal-documents.ts';
import { OnboardingStorage } from './onboarding-storage.ts';
import { CompanionIdentityDrafts, CompanionIdentityNameRejected } from './companion-identity-drafts.ts';
import { ApiError } from './errors.ts';
import { enqueueNameSafetyResponse } from './companion-name-safety-response-outbox.ts';
import type { CompanionNameSafetyDelivery } from './companion-name-safety-delivery.ts';
import { parseCompanionNameApplication, parseCompanionNameSafetyClaim, parseCompanionNameSafetyDecision, parseCompanionNameSubmissionRequest,
  parseCompanionNameSubmissionClaimRequest, parseCompanionNameTask, type CompanionNameSafetyClaim, type CompanionNameSafetyDecision,
  type CompanionNameSubmissionClaimRequest, type CompanionNameSubmissionRequest } from './companion-name-safety-protocol.ts';

export const companionNameSafetyUnavailable = () => new ApiError(503, 'COMPANION_NAME_SAFETY_UNAVAILABLE', 'The private name safety source could not be confirmed.');
export const companionNameSafetyClaimChanged = () => new ApiError(409, 'COMPANION_NAME_SAFETY_CLAIM_CHANGED', 'The name detection claim is no longer current.');
const entryChanged = () => new ApiError(409, 'COMPANION_NAME_ENTRY_REVISION_CHANGED', 'Read the current naming entry before submitting again.');
export type CompanionNameSafetyFailure = 'unavailable' | 'timeout' | 'invalid_result';
export interface CompanionNameSafetyExecution {
  readonly executionToken: string;
  /** Reauthenticates this actual generation's session, source, lease and execution token in the caller's transaction. */
  readonly assertCurrent: (client: PoolClient, signal?: AbortSignal) => Promise<void>;
}
export type CompanionNameClassifier = (input: Readonly<{ text: string }>, admission: ProviderRequestAdmission,
  execution: Readonly<CompanionNameSafetyExecution>) => Promise<unknown>;
export type CompanionNameExecutionGuard = (client: PoolClient, signal?: AbortSignal) => Promise<void>;
interface EntryRow {
  id: string; user_id: string; task_id: string; companion_id: string; preview_revision: number; revision: number;
  latest_submission_id: string; payload_ciphertext: Buffer;
}
export interface CompanionNameSubmissionRow {
  id: string; user_id: string; operation_id: string; entry_id: string; task_id: string; companion_id: string; preview_revision: number;
  submitted_revision: number; expected_identity_revision: number; submitted_auth_version: string; application_operation_id: string; request_ciphertext: Buffer;
  status: 'pending' | 'running' | 'detected'; generation: number; auth_version: string | null; lease_token: string | null; lease_until: Date | null;
  execution_token: string | null; detector_revision: number | null; claim_ciphertext: Buffer | null; result_ciphertext: Buffer | null;
  level: 'L0' | 'L1' | 'L2' | null; detector_mode: 'full' | 'keyword_only' | null; failure: CompanionNameSafetyFailure | null;
  application_status: 'pending' | 'applied' | 'name_rejected' | 'superseded' | 'not_eligible'; rejected_category: CompanionNameCategory | null;
  applied_identity_revision: number | null; application_ciphertext: Buffer | null;
}
const captureFixed = (value: FixedSessionContext) => Object.freeze({ userId: value.userId, tokenHash: value.tokenHash });
const captureClaim = (value: unknown) => { try { return parseCompanionNameSafetyClaim(value); } catch { throw companionNameSafetyClaimChanged(); } };
const sessionHash = (value: unknown): string => {
  if (typeof value !== 'string' || /^[0-9a-f]{64}$/.exec(value)?.[0] !== value) throw companionNameSafetyUnavailable(); return value;
};
function claimOptions(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw entryChanged();
  const data = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => !['taskId', 'detectorRevision', 'leaseMs'].includes(key as string))
    || !Object.hasOwn(data, 'taskId') || !Object.hasOwn(data, 'detectorRevision') || Object.values(data).some(item => !('value' in item) || !item.enumerable)) throw entryChanged();
  const taskId = parseCompanionNameTask({ taskId: data.taskId.value }), detectorRevision = data.detectorRevision.value, leaseMs = data.leaseMs?.value ?? 5000;
  if (!Number.isSafeInteger(detectorRevision) || Object.is(detectorRevision, -0) || detectorRevision < 1 || detectorRevision > 2147483647
    || !Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 60000) throw entryChanged();
  return Object.freeze({ taskId, detectorRevision: detectorRevision as number, leaseMs: leaseMs as number });
}

/** Foundation only: durable independent text, fencing and semantic application.
 * Public naming remains closed until real resources and presentation/followup
 * protocols exist. Risk is never cleared or converted into a companion name. */
export class CompanionNameSafety {
  private readonly storage: OnboardingStorage;
  constructor(readonly db: Database, config: Pick<PlatformConfig, 'dataCrypto' | 'requireVerifiedEmail'>, legal: LegalBundle | null,
    private readonly background: BackgroundGeneration, private readonly identities: CompanionIdentityDrafts,
    private readonly resources?: CompanionNameSafetyDelivery) {
    this.storage = new OnboardingStorage(config, legal);
  }
  private async source(client: PoolClient, fixed: FixedSessionContext, taskId: string, signal?: AbortSignal) {
    const version = await this.storage.authorizeSession(client, fixed, signal);
    const verified = await this.background.readInTransaction(client, fixed, { taskId }, signal);
    if (!verified) throw new ApiError(409, 'COMPANION_PREVIEW_REQUIRED', 'Wait for the actual completed preview before submitting a name.');
    return { version, verified };
  }
  /** Existing raw operations keep their actual original preview. This proof is
   * only for observation or classification of already committed name sources;
   * fresh submissions and applications still require the current source gate. */
  private async savedSource(client: PoolClient, fixed: FixedSessionContext, taskId: string, signal?: AbortSignal) {
    const version = await this.storage.authorizeSession(client, fixed, signal);
    const proof = await this.background.readSavedCompletedInTransaction(client, fixed, { taskId }, signal);
    if (!proof) throw new ApiError(409, 'COMPANION_PREVIEW_REQUIRED', 'Wait for the actual completed preview before reading a saved name.');
    return { version, verified: proof.envelope };
  }
  private async entry(client: PoolClient, fixed: FixedSessionContext, taskId: string) {
    return (await client.query<EntryRow>('SELECT * FROM platform_companion_name_entries WHERE user_id=$1 AND task_id=$2 FOR UPDATE', [fixed.userId, taskId])).rows[0];
  }
  private entryPayload(row: EntryRow, verified: VerifiedCompanionPreviewEnvelope) {
    return { schemaVersion: 1, id: row.id, userId: row.user_id, taskId: row.task_id, companionId: row.companion_id,
      previewRevision: 1, revision: row.revision, latestSubmissionId: row.latest_submission_id, previewCapture: verified };
  }
  private requestPayload(row: CompanionNameSubmissionRow, request: CompanionNameSubmissionRequest, verified: VerifiedCompanionPreviewEnvelope, submittedSessionHash: string) {
    return { schemaVersion: 1, id: row.id, userId: row.user_id, operationId: row.operation_id, entryId: row.entry_id,
      taskId: row.task_id, companionId: row.companion_id, previewRevision: 1, submittedAtRevision: row.submitted_revision,
      expectedIdentityRevision: row.expected_identity_revision, submittedAuthVersion: String(row.submitted_auth_version),
      submittedSessionHash, applicationOperationId: row.application_operation_id, previewCapture: verified, request };
  }
  private decodeRequest(row: CompanionNameSubmissionRow, entry: EntryRow, verified: VerifiedCompanionPreviewEnvelope) {
    try {
      if (row.user_id !== entry.user_id || row.entry_id !== entry.id || row.task_id !== entry.task_id || row.companion_id !== entry.companion_id
        || row.preview_revision !== 1 || row.submitted_revision < 1 || row.submitted_revision > entry.revision) throw companionNameSafetyUnavailable();
      const text = this.storage.crypto!.openUtf8(row.request_ciphertext, { table: 'platform_companion_name_submissions', column: 'request_ciphertext',
        rowId: row.id, ownerId: row.user_id, revision: row.submitted_revision });
      const data = JSON.parse(text), request = parseCompanionNameSubmissionRequest(data?.request);
      if (request.operationId !== row.operation_id || request.taskId !== row.task_id || request.expectedEntryRevision + 1 !== row.submitted_revision
        || request.expectedIdentityRevision !== row.expected_identity_revision) throw companionNameSafetyUnavailable();
      const payload = this.requestPayload(row, request, verified, sessionHash(data?.submittedSessionHash));
      if (JSON.stringify(payload) !== text) throw companionNameSafetyUnavailable();
      return { request, payload };
    } catch { throw companionNameSafetyUnavailable(); }
  }
  private rowClaim(row: CompanionNameSubmissionRow) {
    return captureClaim({ submissionId: row.id, userId: row.user_id, operationId: row.operation_id, entryId: row.entry_id,
      taskId: row.task_id, companionId: row.companion_id, previewRevision: row.preview_revision, submittedAtRevision: row.submitted_revision,
      expectedIdentityRevision: row.expected_identity_revision, generation: row.generation, authVersion: String(row.auth_version),
      leaseToken: row.lease_token, detectorRevision: row.detector_revision });
  }
  private claimPayload(claim: CompanionNameSafetyClaim, tokenHash: string, sourceCapture: ReturnType<CompanionNameSafety['requestPayload']>) {
    return { schemaVersion: 1, claim, sessionTokenHash: tokenHash, sourceCapture };
  }
  private decodeClaim(row: CompanionNameSubmissionRow, sourceCapture: ReturnType<CompanionNameSafety['requestPayload']>) {
    try {
      const claim = this.rowClaim(row), text = this.storage.crypto!.openUtf8(row.claim_ciphertext!, { table: 'platform_companion_name_submissions',
        column: 'claim_ciphertext', rowId: row.id, ownerId: row.user_id, revision: row.generation });
      const data = JSON.parse(text), tokenHash = sessionHash(data?.sessionTokenHash);
      if (text !== JSON.stringify(this.claimPayload(claim, tokenHash, sourceCapture))) throw companionNameSafetyUnavailable();
      return { claim, fixed: captureFixed({ userId: row.user_id, tokenHash }) };
    } catch { throw companionNameSafetyUnavailable(); }
  }
  private async completedUsage(client: PoolClient, row: CompanionNameSubmissionRow) {
    const found = await client.query(`SELECT call_id,provider,model,usage_status,input_tokens,output_tokens,
      EXTRACT(EPOCH FROM admitted_at)::text AS admitted_exact,EXTRACT(EPOCH FROM finished_at)::text AS finished_exact FROM platform_safety_model_usage
      WHERE source_kind='companion_name' AND submission_id=$1 AND user_id=$2 AND operation_id=$3 AND entry_id=$4
        AND task_id=$5 AND companion_id=$6 AND preview_revision=$7 AND submitted_revision=$8 AND expected_identity_revision=$9
        AND generation=$10 AND auth_version=$11 AND detector_revision=$12 AND name_execution_token=$13
        AND draft_id IS NULL AND question_id IS NULL AND purpose='safety_classify' AND call_index=1 AND status='complete'
        AND usage_status IN ('reported','missing','invalid') AND admitted_at IS NOT NULL AND finished_at IS NOT NULL
        AND admitted_at<=finished_at AND finished_at<=clock_timestamp() FOR SHARE`,
    [row.id, row.user_id, row.operation_id, row.entry_id, row.task_id, row.companion_id, row.preview_revision,
      row.submitted_revision, row.expected_identity_revision, row.generation, row.auth_version, row.detector_revision, row.execution_token]);
    if (found.rows.length !== 1) throw companionNameSafetyUnavailable();
    const usage = found.rows[0];
    return { callId: usage.call_id, provider: usage.provider, model: usage.model, usageStatus: usage.usage_status,
      inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, admittedAt: usage.admitted_exact, finishedAt: usage.finished_exact };
  }
  private resultPayload(row: CompanionNameSubmissionRow, sourceCapture: ReturnType<CompanionNameSafety['requestPayload']>, decision: CompanionNameSafetyDecision,
    modelUsage: Awaited<ReturnType<CompanionNameSafety['completedUsage']>> | null) {
    return { schemaVersion: 1, claim: this.rowClaim(row), executionToken: row.execution_token, sourceCapture, decision, modelUsage };
  }
  private async decodeResult(client: PoolClient, row: CompanionNameSubmissionRow, sourceCapture: ReturnType<CompanionNameSafety['requestPayload']>) {
    try {
      if (row.status !== 'detected') throw companionNameSafetyUnavailable();
      const text = this.storage.crypto!.openUtf8(row.result_ciphertext!, { table: 'platform_companion_name_submissions', column: 'result_ciphertext',
        rowId: row.id, ownerId: row.user_id, revision: row.generation });
      const data = JSON.parse(text), decision = parseCompanionNameSafetyDecision(data?.decision);
      const modelUsage = decision.mode === 'full' ? await this.completedUsage(client, row) : null;
      if (row.level !== decision.level || row.detector_mode !== decision.mode || text !== JSON.stringify(this.resultPayload(row, sourceCapture, decision, modelUsage))) throw companionNameSafetyUnavailable();
      return { decision, payload: this.resultPayload(row, sourceCapture, decision, modelUsage) };
    } catch { throw companionNameSafetyUnavailable(); }
  }
  private async history(client: PoolClient, entry: EntryRow, verified: VerifiedCompanionPreviewEnvelope, fixed: FixedSessionContext) {
    try {
      if (entry.preview_revision !== 1 || entry.task_id !== verified.source.taskId || entry.companion_id !== verified.source.companionId) throw companionNameSafetyUnavailable();
      const text = this.storage.crypto!.openUtf8(entry.payload_ciphertext, { table: 'platform_companion_name_entries', column: 'payload_ciphertext',
        rowId: entry.id, ownerId: entry.user_id, revision: entry.revision });
      if (text !== JSON.stringify(this.entryPayload(entry, verified))) throw companionNameSafetyUnavailable();
      const rows = (await client.query<CompanionNameSubmissionRow>('SELECT * FROM platform_companion_name_submissions WHERE entry_id=$1 AND user_id=$2 ORDER BY submitted_revision,id FOR UPDATE', [entry.id, entry.user_id])).rows;
      if (rows.length !== entry.revision || rows.at(-1)?.id !== entry.latest_submission_id) throw companionNameSafetyUnavailable();
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index]; if (row.submitted_revision !== index + 1) throw companionNameSafetyUnavailable();
        const capture = this.decodeRequest(row, entry, verified);
        if (row.status !== 'pending') this.decodeClaim(row, capture.payload);
        if (row.status === 'detected') {
          const result = await this.decodeResult(client, row, capture.payload);
          if (row.application_status !== 'pending') await this.decodeApplication(client, row, capture.payload, result.payload, fixed);
        }
      }
      return rows;
    } catch { throw companionNameSafetyUnavailable(); }
  }
  private view(entry: EntryRow, rows: readonly CompanionNameSubmissionRow[]) {
    const pendingCount = rows.filter(row => row.status !== 'detected').length, blockedCount = rows.filter(row => row.status === 'detected' && row.level !== 'L0').length;
    return Object.freeze({ entryId: entry.id, taskId: entry.task_id, companionId: entry.companion_id, previewRevision: 1 as const, revision: entry.revision,
      latestSubmissionId: entry.latest_submission_id, status: blockedCount ? 'blocked' as const : pendingCount ? 'pending' as const : 'clear' as const,
      pendingCount, blockedCount, submissions: Object.freeze(rows.map(row => Object.freeze({ id: row.id, operationId: row.operation_id,
        submittedAtRevision: row.submitted_revision, status: row.status, level: row.level, mode: row.detector_mode,
        application: row.application_status, rejectedCategory: row.rejected_category, appliedIdentityRevision: row.applied_identity_revision }))) });
  }
  async read(context: FixedSessionContext, value: unknown, signal?: AbortSignal) {
    const fixed = captureFixed(context), taskId = parseCompanionNameTask(value);
    return this.db.withBoundedTransaction(async client => {
      const { verified } = await this.savedSource(client, fixed, taskId, signal), entry = await this.entry(client, fixed, taskId);
      const result = entry ? this.view(entry, await this.history(client, entry, verified, fixed)) : null;
      await authorizeFixedSession(client, fixed, signal); signal?.throwIfAborted(); return result;
    });
  }
  async submit(context: FixedSessionContext, value: unknown, signal?: AbortSignal) {
    const fixed = captureFixed(context), request = parseCompanionNameSubmissionRequest(value), canonical = JSON.stringify(request);
    return this.db.withBoundedTransaction(async client => {
      const { verified, version } = await this.source(client, fixed, request.taskId, signal), previous = await this.entry(client, fixed, request.taskId);
      const rows = previous ? await this.history(client, previous, verified, fixed) : [];
      const old = (await client.query<CompanionNameSubmissionRow>('SELECT * FROM platform_companion_name_submissions WHERE user_id=$1 AND operation_id=$2 FOR UPDATE', [fixed.userId, request.operationId])).rows[0];
      if (old) {
        if (!previous || old.entry_id !== previous.id) throw new ApiError(409, 'COMPANION_NAME_OPERATION_CONFLICT', 'Use a new operation identifier for a different name source.');
        if (JSON.stringify(this.decodeRequest(old, previous, verified).request) !== canonical) throw new ApiError(409, 'COMPANION_NAME_OPERATION_CONFLICT', 'Use a new operation identifier for different raw text.');
        await authorizeFixedSession(client, fixed, signal); signal?.throwIfAborted();
        return Object.freeze({ entry: this.view(previous, rows), submissionId: old.id, operation: Object.freeze({ id: old.operation_id, appliedRevision: old.submitted_revision, replayed: true }) });
      }
      if (request.expectedEntryRevision !== (previous?.revision ?? 0)) throw entryChanged();
      const entry: EntryRow = { id: previous?.id ?? randomUUID(), user_id: fixed.userId, task_id: request.taskId, companion_id: verified.source.companionId,
        preview_revision: 1, revision: request.expectedEntryRevision + 1, latest_submission_id: randomUUID(), payload_ciphertext: Buffer.alloc(0) };
      const row = { id: entry.latest_submission_id, user_id: fixed.userId, operation_id: request.operationId, entry_id: entry.id,
        task_id: request.taskId, companion_id: verified.source.companionId, preview_revision: 1, submitted_revision: entry.revision,
        expected_identity_revision: request.expectedIdentityRevision, submitted_auth_version: version, application_operation_id: randomUUID(),
        status: 'pending', generation: 0, level: null, detector_mode: null, application_status: 'pending', rejected_category: null, applied_identity_revision: null } as CompanionNameSubmissionRow;
      row.request_ciphertext = this.storage.crypto!.sealUtf8(JSON.stringify(this.requestPayload(row, request, verified, fixed.tokenHash)),
        { table: 'platform_companion_name_submissions', column: 'request_ciphertext', rowId: row.id, ownerId: fixed.userId, revision: row.submitted_revision });
      entry.payload_ciphertext = this.storage.crypto!.sealUtf8(JSON.stringify(this.entryPayload(entry, verified)),
        { table: 'platform_companion_name_entries', column: 'payload_ciphertext', rowId: entry.id, ownerId: fixed.userId, revision: entry.revision });
      await authorizeFixedSession(client, fixed, signal);
      if (previous) {
        const saved = await client.query('UPDATE platform_companion_name_entries SET revision=$3,latest_submission_id=$4,payload_ciphertext=$5,updated_at=clock_timestamp() WHERE id=$1 AND user_id=$2 AND revision=$6 RETURNING id',
          [entry.id, fixed.userId, entry.revision, row.id, entry.payload_ciphertext, previous.revision]); if (!saved.rowCount) throw entryChanged();
      } else await client.query('INSERT INTO platform_companion_name_entries(id,user_id,task_id,companion_id,preview_revision,revision,latest_submission_id,payload_ciphertext) VALUES($1,$2,$3,$4,1,$5,$6,$7)',
        [entry.id, fixed.userId, entry.task_id, entry.companion_id, entry.revision, row.id, entry.payload_ciphertext]);
      await client.query('INSERT INTO platform_companion_name_submissions(id,user_id,operation_id,entry_id,task_id,companion_id,preview_revision,submitted_revision,expected_identity_revision,submitted_auth_version,application_operation_id,request_ciphertext) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$11)',
        [row.id, row.user_id, row.operation_id, row.entry_id, row.task_id, row.companion_id, row.submitted_revision, row.expected_identity_revision, version, row.application_operation_id, row.request_ciphertext]);
      await authorizeFixedSession(client, fixed, signal); signal?.throwIfAborted();
      return Object.freeze({ entry: this.view(entry, [...rows, row]), submissionId: row.id, operation: Object.freeze({ id: row.operation_id, appliedRevision: row.submitted_revision, replayed: false }) });
    });
  }
  async claim(context: FixedSessionContext, value: { taskId: string; detectorRevision: number; leaseMs?: number }, signal?: AbortSignal): Promise<Readonly<CompanionNameSafetyClaim> | null> {
    const fixed = captureFixed(context), options = claimOptions(value);
    return this.claimSavedSource(fixed, options, undefined, signal);
  }
  /** Internal exact dispatch after a raw source COMMIT. An active or completed
   * source is observed without stealing its claim or rerunning its detector. */
  async claimSubmission(context: FixedSessionContext, value: CompanionNameSubmissionClaimRequest,
    signal?: AbortSignal): Promise<Readonly<CompanionNameSafetyClaim> | null> {
    const fixed = captureFixed(context), options = parseCompanionNameSubmissionClaimRequest(value);
    return this.claimSavedSource(fixed, options, options.submissionId, signal);
  }
  private async claimSavedSource(fixed: FixedSessionContext, options: Readonly<{ taskId: string; detectorRevision: number; leaseMs: number }>,
    submissionId: string | undefined, signal?: AbortSignal): Promise<Readonly<CompanionNameSafetyClaim> | null> {
    return this.db.withBoundedTransaction(async client => {
      const { verified, version } = await this.savedSource(client, fixed, options.taskId, signal), entry = await this.entry(client, fixed, options.taskId);
      if (!entry) {
        if (submissionId !== undefined) throw companionNameSafetyUnavailable();
        await authorizeFixedSession(client, fixed, signal); signal?.throwIfAborted(); return null;
      }
      const rows = await this.history(client, entry, verified, fixed);
      if (submissionId !== undefined && !rows.some(item => item.id === submissionId)) throw companionNameSafetyUnavailable();
      const row = (await client.query<CompanionNameSubmissionRow>(`SELECT * FROM platform_companion_name_submissions WHERE entry_id=$1 AND user_id=$2
        AND ($3::uuid IS NULL OR id=$3) AND (status='pending' OR status='running' AND lease_until<=clock_timestamp())
        ORDER BY submitted_revision,id LIMIT 1 FOR UPDATE`, [entry.id, fixed.userId, submissionId ?? null])).rows[0];
      if (!row) { await authorizeFixedSession(client, fixed, signal); signal?.throwIfAborted(); return null; }
      if (!rows.some(item => item.id === row.id) || row.generation === 2147483647) throw companionNameSafetyUnavailable();
      const next = { ...row, status: 'running' as const, generation: row.generation + 1, auth_version: version,
        lease_token: randomUUID(), execution_token: null, detector_revision: options.detectorRevision }, claim = this.rowClaim(next);
      const claimCiphertext = this.storage.crypto!.sealUtf8(JSON.stringify(this.claimPayload(claim, fixed.tokenHash, this.decodeRequest(row, entry, verified).payload)),
        { table: 'platform_companion_name_submissions', column: 'claim_ciphertext', rowId: row.id, ownerId: row.user_id, revision: next.generation });
      await authorizeFixedSession(client, fixed, signal);
      const saved = await client.query(`UPDATE platform_companion_name_submissions SET status='running',generation=$2,auth_version=$3,lease_token=$4,
        lease_until=clock_timestamp()+($5::int*interval '1 millisecond'),execution_token=NULL,detector_revision=$6,claim_ciphertext=$7,failure=NULL,updated_at=clock_timestamp()
        WHERE id=$1 AND generation=$8 AND user_id=$9 AND entry_id=$10
          AND (status='pending' OR status='running' AND lease_until<=clock_timestamp()) RETURNING id`,
        [row.id, next.generation, version, next.lease_token, options.leaseMs, options.detectorRevision, claimCiphertext, row.generation, fixed.userId, entry.id]);
      if (!saved.rowCount) throw companionNameSafetyClaimChanged();
      await authorizeFixedSession(client, fixed, signal); signal?.throwIfAborted(); return claim;
    });
  }
  private async owned(client: PoolClient, claim: CompanionNameSafetyClaim, signal?: AbortSignal, allowDetected = false, executionToken?: string) {
    const raw = (await client.query<CompanionNameSubmissionRow>('SELECT * FROM platform_companion_name_submissions WHERE id=$1 AND user_id=$2', [claim.submissionId, claim.userId])).rows[0];
    if (!raw || raw.generation !== claim.generation || !raw.claim_ciphertext) throw companionNameSafetyClaimChanged();
    // Obtain the encrypted generation session before any source locks. The raw
    // read grants nothing; subsequent locks and exact capture checks establish it.
    let tokenHash: string;
    try { tokenHash = sessionHash(JSON.parse(this.storage.crypto!.openUtf8(raw.claim_ciphertext, { table: 'platform_companion_name_submissions', column: 'claim_ciphertext', rowId: raw.id, ownerId: raw.user_id, revision: raw.generation })).sessionTokenHash); }
    catch { throw companionNameSafetyUnavailable(); }
    const fixed = captureFixed({ userId: claim.userId, tokenHash }), { version, verified } = await this.savedSource(client, fixed, claim.taskId, signal);
    if (version !== claim.authVersion) throw companionNameSafetyClaimChanged();
    const entry = await this.entry(client, fixed, claim.taskId); if (!entry || entry.id !== claim.entryId) throw companionNameSafetyClaimChanged();
    const rows = await this.history(client, entry, verified, fixed), row = rows.find(item => item.id === claim.submissionId);
    if (!row || row.status !== 'running' && !(allowDetected && row.status === 'detected') || executionToken !== undefined && row.execution_token !== executionToken
      || JSON.stringify(this.rowClaim(row)) !== JSON.stringify(claim)) throw companionNameSafetyClaimChanged();
    const capture = this.decodeRequest(row, entry, verified), actual = this.decodeClaim(row, capture.payload);
    if (actual.fixed.tokenHash !== fixed.tokenHash) throw companionNameSafetyUnavailable();
    const valid = await client.query(`SELECT id FROM platform_companion_name_submissions WHERE id=$1 AND (status='running' AND lease_until>clock_timestamp() ${allowDetected ? "OR status='detected'" : ''})`, [row.id]);
    signal?.throwIfAborted(); if (!valid.rowCount) throw companionNameSafetyClaimChanged();
    return { row, rows, entry, fixed, verified, capture };
  }
  private admission(claim: CompanionNameSafetyClaim, executionToken: string, parent: AbortSignal,
    guard: CompanionNameExecutionGuard, onComplete?: () => void): ProviderRequestAdmission {
    return async <T>(launch: (signal: AbortSignal) => Promise<T>, requestSignal?: AbortSignal): Promise<T> => {
      const cancelled = new AbortController(), signal = AbortSignal.any([parent, cancelled.signal, ...(requestSignal ? [requestSignal] : [])]);
      let pending: Promise<T> | undefined;
      try {
        const started = await this.db.withBoundedTransaction(async client => {
          await this.owned(client, claim, signal, false, executionToken); await guard(client, signal);
          await this.owned(client, claim, signal, false, executionToken); signal.throwIfAborted();
          pending = Promise.resolve(launch(signal)); pending.catch(() => {}); return { pending };
        });
        const result = await started.pending; signal.throwIfAborted(); onComplete?.(); return result;
      } catch (error) { cancelled.abort(); void pending?.catch(() => {}); throw error; }
    };
  }
  async process(value: CompanionNameSafetyClaim, classify: CompanionNameClassifier, signal: AbortSignal | undefined,
    guard: CompanionNameExecutionGuard) {
    const claim = captureClaim(value);
    if (typeof classify !== 'function' || typeof guard !== 'function') throw new ApiError(400, 'INVALID_SAFETY_RESULT', 'A name detector requires an actual server execution guard.');
    const input = await this.db.withBoundedTransaction(async client => {
      const owned = await this.owned(client, claim, signal, true);
      if (owned.row.status === 'detected') return { replay: true as const };
      await guard(client, signal);
      if (owned.row.execution_token !== null) throw companionNameSafetyClaimChanged();
      const executionToken = randomUUID();
      const saved = await client.query(`UPDATE platform_companion_name_submissions SET execution_token=$2,updated_at=clock_timestamp()
        WHERE id=$1 AND status='running' AND execution_token IS NULL AND lease_until>clock_timestamp() RETURNING id`, [claim.submissionId, executionToken]);
      if (!saved.rowCount) throw companionNameSafetyClaimChanged(); signal?.throwIfAborted();
      return { replay: false as const, text: owned.capture.request.name, executionToken };
    });
    if (input.replay) return Object.freeze({ submissionId: claim.submissionId, status: 'detected' as const, replayed: true });
    const deadline = AbortSignal.timeout(1000), requestSignal = AbortSignal.any([deadline, ...(signal ? [signal] : [])]);
    const execution: Readonly<CompanionNameSafetyExecution> = Object.freeze({ executionToken: input.executionToken,
      assertCurrent: async (client: PoolClient, currentSignal?: AbortSignal) => { await this.owned(client, claim, currentSignal, false, input.executionToken); } });
    let admitted = false;
    const pending = this.admission(claim, input.executionToken, requestSignal, guard)(async parentSignal => classify(Object.freeze({ text: input.text }),
      this.admission(claim, input.executionToken, parentSignal, guard, () => { admitted = true; }), execution));
    pending.catch(() => {}); let decision: Readonly<CompanionNameSafetyDecision>;
    let onAbort: () => void = () => {};
    try {
      const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(requestSignal.reason); requestSignal.addEventListener('abort', onAbort, { once: true }); if (requestSignal.aborted) onAbort(); });
      const raw = await Promise.race([pending, aborted]);
      if (!admitted) throw new ApiError(400, 'INVALID_SAFETY_RESULT', 'A name detection result requires an actual admitted execution.');
      try { decision = parseCompanionNameSafetyDecision(raw); } catch { throw new ApiError(400, 'INVALID_SAFETY_RESULT', 'Use a valid bound name detection result.'); }
    } catch (error) {
      if (deadline.aborted && !signal?.aborted) { await this.fail(claim, 'timeout').catch(() => {}); throw companionNameSafetyUnavailable(); }
      throw error;
    } finally { requestSignal.removeEventListener('abort', onAbort); }
    return this.db.withBoundedTransaction(async client => {
      const owned = await this.owned(client, claim, signal, true, input.executionToken);
      await guard(client, signal);
      if (owned.row.status === 'detected') {
        if (JSON.stringify((await this.decodeResult(client, owned.row, owned.capture.payload)).decision) !== JSON.stringify(decision)) throw new ApiError(409, 'COMPANION_NAME_SAFETY_RESULT_CONFLICT', 'The name classification was already saved.');
        return Object.freeze({ submissionId: claim.submissionId, status: 'detected' as const, replayed: true });
      }
      const modelUsage = decision.mode === 'full' ? await this.completedUsage(client, owned.row) : null;
      const ciphertext = this.storage.crypto!.sealUtf8(JSON.stringify(this.resultPayload(owned.row, owned.capture.payload, decision, modelUsage)),
        { table: 'platform_companion_name_submissions', column: 'result_ciphertext', rowId: claim.submissionId, ownerId: claim.userId, revision: claim.generation });
      const saved = await client.query(`UPDATE platform_companion_name_submissions SET status='detected',result_ciphertext=$2,level=$3,detector_mode=$4,failure=NULL,updated_at=clock_timestamp()
        WHERE id=$1 AND status='running' AND generation=$5 AND lease_token=$6 AND execution_token=$7 AND lease_until>clock_timestamp() RETURNING id`,
        [claim.submissionId, ciphertext, decision.level, decision.mode, claim.generation, claim.leaseToken, input.executionToken]);
      if (!saved.rowCount) throw companionNameSafetyClaimChanged();
      await enqueueNameSafetyResponse(client, { ...owned.row, status: 'detected', result_ciphertext: ciphertext,
        level: decision.level, detector_mode: decision.mode, failure: null }, decision);
      await authorizeFixedSession(client, owned.fixed, signal);
      const current = await client.query('SELECT id FROM platform_companion_name_submissions WHERE id=$1 AND lease_until>clock_timestamp()', [claim.submissionId]);
      signal?.throwIfAborted(); if (!current.rowCount) throw companionNameSafetyClaimChanged();
      return Object.freeze({ submissionId: claim.submissionId, status: 'detected' as const, replayed: false });
    });
  }
  async fail(value: CompanionNameSafetyClaim, failure: CompanionNameSafetyFailure, signal?: AbortSignal): Promise<void> {
    const claim = captureClaim(value);
    if (!['unavailable', 'timeout', 'invalid_result'].includes(failure)) throw companionNameSafetyClaimChanged();
    await this.db.withBoundedTransaction(async client => {
      const owned = await this.owned(client, claim, signal);
      const saved = await client.query(`UPDATE platform_companion_name_submissions SET status='pending',lease_token=NULL,lease_until=NULL,execution_token=NULL,failure=$2,updated_at=clock_timestamp()
        WHERE id=$1 AND generation=$3 AND lease_token=$4 AND lease_until>clock_timestamp() RETURNING id`, [claim.submissionId, failure, claim.generation, claim.leaseToken]);
      if (!saved.rowCount) throw companionNameSafetyClaimChanged(); await authorizeFixedSession(client, owned.fixed, signal); signal?.throwIfAborted();
    });
  }
  private applicationPayload(row: CompanionNameSubmissionRow, sourceCapture: ReturnType<CompanionNameSafety['requestPayload']>, resultCapture: ReturnType<CompanionNameSafety['resultPayload']>, identityCapture: unknown = null) {
    return { schemaVersion: 1, submissionId: row.id, userId: row.user_id, generation: row.generation, sourceCapture, resultCapture,
      application: { status: row.application_status, rejectedCategory: row.rejected_category, appliedIdentityRevision: row.applied_identity_revision }, identityCapture };
  }
  private identityReceiptPayload(row: CompanionNameSubmissionRow, draftId: string, revision: number, identityCapture: unknown) {
    return { schemaVersion: 1, userId: row.user_id, operationId: row.application_operation_id, draftId, identityRevision: revision,
      submissionId: row.id, generation: row.generation, identityCapture };
  }
  private async decodeApplication(client: PoolClient, row: CompanionNameSubmissionRow, sourceCapture: ReturnType<CompanionNameSafety['requestPayload']>, resultCapture: ReturnType<CompanionNameSafety['resultPayload']>, fixed: FixedSessionContext) {
    try {
      const text = this.storage.crypto!.openUtf8(row.application_ciphertext!, { table: 'platform_companion_name_submissions', column: 'application_ciphertext', rowId: row.id, ownerId: row.user_id, revision: row.generation });
      const data = JSON.parse(text);
      if (text !== JSON.stringify(this.applicationPayload(row, sourceCapture, resultCapture, data?.identityCapture))) throw companionNameSafetyUnavailable();
      if (row.application_status === 'applied') {
        if (row.level !== 'L0' || row.detector_mode !== 'full' || row.applied_identity_revision !== row.expected_identity_revision + 1
          || data.identityCapture?.revision !== row.applied_identity_revision || data.identityCapture?.userId !== row.user_id
          || data.identityCapture?.taskId !== row.task_id || data.identityCapture?.companionId !== row.companion_id) throw companionNameSafetyUnavailable();
        const provenance = (await client.query('SELECT * FROM platform_companion_name_identity_provenance WHERE submission_id=$1 AND user_id=$2 FOR SHARE', [row.id, row.user_id])).rows[0];
        if (!provenance || provenance.operation_id !== row.application_operation_id || provenance.draft_id !== data.identityCapture.id || provenance.identity_revision !== row.applied_identity_revision || provenance.generation !== row.generation
          || this.storage.crypto!.openUtf8(provenance.payload_ciphertext, { table: 'platform_companion_name_identity_provenance', column: 'payload_ciphertext', rowId: provenance.draft_id, ownerId: row.user_id, revision: provenance.identity_revision }) !== text) throw companionNameSafetyUnavailable();
        if (data.identityCapture.name !== sourceCapture.request.name.trim().normalize('NFC')) throw companionNameSafetyUnavailable();
        const receipt = (await client.query('SELECT * FROM platform_companion_name_identity_receipts WHERE user_id=$1 AND operation_id=$2 FOR SHARE',
          [row.user_id, row.application_operation_id])).rows[0];
        if (!receipt || receipt.draft_id !== provenance.draft_id || receipt.identity_revision !== row.applied_identity_revision
          || receipt.submission_id !== row.id || receipt.generation !== row.generation || receipt.level !== 'L0' || receipt.detector_mode !== 'full'
          || this.storage.crypto!.openUtf8(receipt.payload_ciphertext, { table: 'platform_companion_name_identity_receipts', column: 'payload_ciphertext',
            rowId: row.application_operation_id, ownerId: row.user_id, revision: receipt.identity_revision })
              !== JSON.stringify(this.identityReceiptPayload(row, receipt.draft_id, receipt.identity_revision, data.identityCapture))) throw companionNameSafetyUnavailable();
        await this.identities.validateCapturedInTransaction(client, fixed, { taskId: row.task_id,
          operationId: row.application_operation_id, payload: JSON.stringify(data.identityCapture) });
      } else if (data.identityCapture !== null) throw companionNameSafetyUnavailable();
      return data;
    } catch { throw companionNameSafetyUnavailable(); }
  }
  /** Classification was already committed. Semantic rejection and availability
   * failures cannot erase it or launch the detector again. */
  async apply(context: FixedSessionContext, value: unknown, signal?: AbortSignal) {
    const fixed = captureFixed(context), input = parseCompanionNameApplication(value);
    return this.db.withBoundedTransaction(async client => {
      const { verified } = await this.source(client, fixed, input.taskId, signal), entry = await this.entry(client, fixed, input.taskId);
      if (!entry) throw companionNameSafetyUnavailable();
      const rows = await this.history(client, entry, verified, fixed), row = rows.find(item => item.id === input.submissionId);
      if (!row) throw companionNameSafetyUnavailable();
      if (row.status !== 'detected') throw new ApiError(409, 'COMPANION_NAME_SAFETY_PENDING', 'Wait for the saved name classification.');
      const source = this.decodeRequest(row, entry, verified), result = await this.decodeResult(client, row, source.payload);
      if (row.application_status !== 'pending') {
        await authorizeFixedSession(client, fixed, signal); signal?.throwIfAborted();
        return Object.freeze({ submissionId: row.id, status: row.application_status, rejectedCategory: row.rejected_category, appliedIdentityRevision: row.applied_identity_revision, replayed: true });
      }
      let status: CompanionNameSubmissionRow['application_status'], rejectedCategory: CompanionNameCategory | null = null, identityCapture: unknown = null, identityRevision: number | null = null;
      if (result.decision.level !== 'L0') status = 'not_eligible';
      else if (entry.latest_submission_id !== row.id) status = 'superseded';
      else {
        // This internal writer retains its original entry scope. A handled old
        // risk is an authentic explicit resource operation, never a new L0.
        // Public selection still needs the whole prebirth intake/name barrier.
        for(const item of rows){
          if(item.status!=='detected'||item.level==='L0'&&item.detector_mode!=='full'
            ||item.level!=='L0'&&(!this.resources||!await this.resources.verifyHandledInTransaction(client,fixed.userId,item.id,signal)))
            throw new ApiError(409, 'COMPANION_NAME_SAFETY_REVIEW_REQUIRED', 'All saved name sources must be explicitly handled before applying a name.');
        }
        await client.query('SAVEPOINT companion_name_application');
        try {
          const saved = await this.identities.saveInTransaction(client, fixed, { taskId: row.task_id, expectedRevision: row.expected_identity_revision,
            operationId: row.application_operation_id, name: source.request.name }, signal);
          if (saved.operation.replayed) throw companionNameSafetyUnavailable();
          const identityRow = (await client.query('SELECT * FROM platform_companion_identity_drafts WHERE companion_id=$1 AND user_id=$2 FOR UPDATE', [row.companion_id, row.user_id])).rows[0];
          identityRevision = saved.draft.revision;
          identityCapture = JSON.parse(this.storage.crypto!.openUtf8(identityRow.payload_ciphertext, { table: 'platform_companion_identity_drafts', column: 'payload_ciphertext', rowId: identityRow.id, ownerId: row.user_id, revision: identityRevision! }));
          const receiptCiphertext = this.storage.crypto!.sealUtf8(JSON.stringify(this.identityReceiptPayload(row, identityRow.id, identityRevision!, identityCapture)),
            { table: 'platform_companion_name_identity_receipts', column: 'payload_ciphertext', rowId: row.application_operation_id, ownerId: row.user_id, revision: identityRevision! });
          await client.query('INSERT INTO platform_companion_name_identity_receipts(user_id,operation_id,draft_id,identity_revision,submission_id,generation,payload_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7)',
            [row.user_id, row.application_operation_id, identityRow.id, identityRevision, row.id, row.generation, receiptCiphertext]);
          status = 'applied'; await client.query('RELEASE SAVEPOINT companion_name_application');
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT companion_name_application'); await client.query('RELEASE SAVEPOINT companion_name_application');
          if (error instanceof CompanionIdentityNameRejected) { status = 'name_rejected'; rejectedCategory = error.category; }
          else if (error instanceof ApiError && error.code === 'COMPANION_IDENTITY_REVISION_CHANGED') status = 'superseded';
          else throw error;
        }
      }
      const applied = { ...row, application_status: status, rejected_category: rejectedCategory, applied_identity_revision: identityRevision };
      const text = JSON.stringify(this.applicationPayload(applied, source.payload, result.payload, identityCapture));
      const ciphertext = this.storage.crypto!.sealUtf8(text, { table: 'platform_companion_name_submissions', column: 'application_ciphertext', rowId: row.id, ownerId: row.user_id, revision: row.generation });
      await client.query('UPDATE platform_companion_name_submissions SET application_status=$2,rejected_category=$3,applied_identity_revision=$4,application_ciphertext=$5,updated_at=clock_timestamp() WHERE id=$1', [row.id, status, rejectedCategory, identityRevision, ciphertext]);
      if (status === 'applied') {
        const id = (identityCapture as { id: string }).id, provenance = this.storage.crypto!.sealUtf8(text, { table: 'platform_companion_name_identity_provenance', column: 'payload_ciphertext', rowId: id, ownerId: row.user_id, revision: identityRevision! });
        await client.query('INSERT INTO platform_companion_name_identity_provenance(draft_id,identity_revision,user_id,operation_id,submission_id,generation,payload_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, identityRevision, row.user_id, row.application_operation_id, row.id, row.generation, provenance]);
      }
      await authorizeFixedSession(client, fixed, signal); signal?.throwIfAborted();
      return Object.freeze({ submissionId: row.id, status, rejectedCategory, appliedIdentityRevision: identityRevision, replayed: false });
    });
  }
}
