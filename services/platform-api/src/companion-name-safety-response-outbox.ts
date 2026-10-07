import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { CompanionNameSubmissionRow } from './companion-name-safety.ts';
import type { CompanionNameSafetyDecision } from './companion-name-safety-protocol.ts';
import { ApiError } from './errors.ts';

export interface CompanionNameSafetyResponseRow {
  id: string; user_id: string; submission_id: string; operation_id: string; entry_id: string; task_id: string; companion_id: string;
  preview_revision: number; submitted_revision: number; expected_identity_revision: number; source_generation: number;
  detector_revision: number; level: 'L1' | 'L2'; detector_mode: 'full' | 'keyword_only'; status: 'pending' | 'ready';
  payload_ciphertext: Buffer | null; bundle_revision: number | null; content_digest: string | null; review_digest: string | null;
  locale: 'zh' | 'en' | null; locale_origin: 'captured_answers' | 'default_zh' | null;
  prepared_at: Date | null; retention_until: Date | null; created_at: Date;
}
export const nameResponseStorageUnavailable = () => new ApiError(503, 'DATA_STORAGE_UNAVAILABLE', 'The private name resource response could not be saved or read.');
export const nameSafetyResponseUnavailable = () => new ApiError(503, 'COMPANION_NAME_SAFETY_RESPONSE_UNAVAILABLE', 'The reviewed fixed name resource response is not available.');

export function assertNameSafetyResponseSource(row: CompanionNameSafetyResponseRow, source: CompanionNameSubmissionRow,
  decision: CompanionNameSafetyDecision): void {
  if (source.status !== 'detected' || row.user_id !== source.user_id || row.submission_id !== source.id || row.operation_id !== source.operation_id
    || row.entry_id !== source.entry_id || row.task_id !== source.task_id || row.companion_id !== source.companion_id
    || row.preview_revision !== source.preview_revision || row.submitted_revision !== source.submitted_revision
    || row.expected_identity_revision !== source.expected_identity_revision || row.source_generation !== source.generation
    || row.detector_revision !== source.detector_revision || row.level !== source.level || row.detector_mode !== source.detector_mode
    || decision.level !== row.level || decision.mode !== row.detector_mode) throw nameResponseStorageUnavailable();
}
/** Actual detected result only, in the classifier's transaction or authenticated target recovery. */
export async function enqueueNameSafetyResponse(client: PoolClient, source: CompanionNameSubmissionRow,
  decision: CompanionNameSafetyDecision): Promise<CompanionNameSafetyResponseRow | null> {
  if (decision.level === 'L0') return null;
  if (source.status !== 'detected' || source.level !== decision.level || source.detector_mode !== decision.mode
    || !source.result_ciphertext || !source.detector_revision || source.generation < 1) throw nameResponseStorageUnavailable();
  await client.query(`INSERT INTO platform_companion_name_safety_responses
    (id,user_id,submission_id,operation_id,entry_id,task_id,companion_id,preview_revision,submitted_revision,expected_identity_revision,
      source_generation,detector_revision,level,detector_mode)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(submission_id) DO NOTHING`,
  [randomUUID(),source.user_id,source.id,source.operation_id,source.entry_id,source.task_id,source.companion_id,source.preview_revision,
    source.submitted_revision,source.expected_identity_revision,source.generation,source.detector_revision,decision.level,decision.mode]);
  const row = (await client.query<CompanionNameSafetyResponseRow>('SELECT * FROM platform_companion_name_safety_responses WHERE submission_id=$1 FOR UPDATE', [source.id])).rows[0];
  if (!row) throw nameResponseStorageUnavailable();
  assertNameSafetyResponseSource(row,source,decision); return row;
}
