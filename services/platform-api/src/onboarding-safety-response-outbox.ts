import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { OnboardingSafetyResult } from '@companion/platform-contracts';
import { ApiError } from './errors.ts';
import type { SafetySubmissionRow } from './onboarding-storage.ts';

export interface SafetyResponseRow {
  id: string; user_id: string; submission_id: string; operation_id: string; draft_id: string;
  question_id: SafetySubmissionRow['question_id']; submitted_revision: number; source_generation: number;
  detector_revision: number; level: 'L1' | 'L2'; detector_mode: 'full' | 'keyword_only'; status: 'pending' | 'ready';
  payload_ciphertext: Buffer | null; bundle_revision: number | null; content_digest: string | null; review_digest: string | null;
  locale: 'zh' | 'en' | null; prepared_at: Date | null; retention_until: Date | null; created_at: Date;
}
export const responseStorageUnavailable = () => new ApiError(503, 'DATA_STORAGE_UNAVAILABLE', 'The private safety response could not be saved or read.');
export const safetyResponseUnavailable = () => new ApiError(503, 'ONBOARDING_SAFETY_RESPONSE_UNAVAILABLE', 'The fixed safety response is not configured.');
/** Called only after authenticating the actual source result, under its account/history locks. */
export function assertSafetyResponseSource(row: SafetyResponseRow, source: SafetySubmissionRow, result: OnboardingSafetyResult): void {
  if (source.status !== 'detected' || row.user_id !== source.user_id || row.submission_id !== source.id
    || row.operation_id !== source.operation_id || row.draft_id !== source.draft_id || row.question_id !== source.question_id
    || row.submitted_revision !== source.submitted_revision || row.source_generation !== source.generation
    || row.detector_revision !== source.detector_revision || row.level !== source.level || row.detector_mode !== source.detector_mode
    || result.level !== row.level || result.mode !== row.detector_mode || result.textId !== row.operation_id
    || result.submittedAtRevision !== row.submitted_revision || result.detectorRevision !== row.detector_revision) throw responseStorageUnavailable();
}
/** Same transaction as detection, or historical recovery. No raw text or detached guessed source is copied. */
export async function enqueueSafetyResponse(client: PoolClient, source: SafetySubmissionRow, result: OnboardingSafetyResult): Promise<void> {
  if (result.level === 'L0') return;
  if (source.status !== 'detected' || source.level !== result.level || source.detector_mode !== result.mode
    || !source.result_ciphertext || !source.detector_revision || source.generation < 1) throw responseStorageUnavailable();
  await client.query(`INSERT INTO platform_onboarding_safety_responses
    (id,user_id,submission_id,operation_id,draft_id,question_id,submitted_revision,source_generation,detector_revision,level,detector_mode)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(submission_id) DO NOTHING`,
  [randomUUID(), source.user_id, source.id, source.operation_id, source.draft_id, source.question_id,
    source.submitted_revision, source.generation, source.detector_revision, result.level, result.mode]);
  const row = (await client.query<SafetyResponseRow>('SELECT * FROM platform_onboarding_safety_responses WHERE submission_id=$1 FOR UPDATE', [source.id])).rows[0];
  if (!row) throw responseStorageUnavailable();
  assertSafetyResponseSource(row, source, result);
}
