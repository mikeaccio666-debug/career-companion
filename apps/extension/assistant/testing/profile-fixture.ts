import * as C from '@edaix/contracts';
import { fictionalProfileSnapshot } from './profile-snapshot';
import type { AssistantPorts } from '../ports/assistant-ports';
import { abortableDelay } from '../ports/assistant-ports';

/** Fictional in-memory UI adapter. No production entry imports this module. */
export function createProfileFixture() {
  let saved = fictionalProfileSnapshot('Example Person')!;
  let scenario: 'normal' | 'conflict' | 'uncertain' | 'slow' = 'normal';
  const read: NonNullable<AssistantPorts['profile']>['read'] = async signal => signal.aborted ? { ok: false, code: 'CANCELLED' } : { ok: true, value: saved };
  const save: NonNullable<AssistantPorts['profile']>['save'] = async (input, signal) => {
    if (!await abortableDelay(scenario === 'slow' ? 4000 : 500, signal)) return { ok: false, code: 'SAVE_UNCERTAIN' };
    const patch = C.parseCandidateProfileV2Patch(input);
    if (!patch) return { ok: false, code: 'VALIDATION_FAILED' };
    if (scenario === 'conflict') { saved = C.parseCandidateProfileSnapshotV2({ ...saved, revision: String(BigInt(saved.revision) + 1n), profile: { ...saved.profile, summary: 'Example update from another window' } })!; return { ok: false, code: 'REVISION_CONFLICT' }; }
    if (patch.expectedRevision !== saved.revision || patch.expectedDeletionEpoch !== saved.deletionEpoch) return { ok: false, code: 'REVISION_CONFLICT' };
    const next = structuredClone(saved) as any;
    const revision = String(BigInt(saved.revision) + 1n), at = '2026-09-13T12:00:00.000Z';
    const authority = () => ({ factId: crypto.randomUUID(), factRevision: revision, deletionEpoch: saved.deletionEpoch, meta: { source: 'USER', authorityState: 'USER_CONFIRMED', confidence: null, userConfirmedAt: at, sourceRef: null } });
    for (const [path, value] of Object.entries(patch.fields ?? {})) {
      const keys = path.split('.'), last = keys.pop()!; let target = next.profile;
      for (const key of keys) target = target[key]; target[last] = value;
      next.profile.scalarAuthorityByPath[path] = authority();
    }
    const collections = ['links', 'experiences', 'educations', 'skills', 'languages', 'projects', 'achievements', 'referrals', 'workAuthorizations'] as const;
    for (const collection of collections) if (patch[collection]) next.profile[collection] = patch[collection]!.map((mutation: any) => {
      const { confirmFields, ...values } = mutation;
      const old = next.profile[collection].find((row: any) => collection === 'workAuthorizations' ? row.regionCode === values.regionCode : row.id === values.id);
      const factAuthorityByField = { ...old?.factAuthorityByField };
      for (const key of confirmFields) factAuthorityByField[key] = authority();
      return { ...values, ...(collection === 'workAuthorizations' ? { revision, effectiveAt: at, expiresAt: old?.expiresAt ?? null, revokedAt: old?.revokedAt ?? null } : { id: values.id ?? crypto.randomUUID() }), factAuthorityByField };
    });
    for (const key of ['primaryLinkIdByKind', 'primaryCurrentExperienceId'] as const) if (key in patch) next.profile[key] = patch[key];
    next.revision = revision; next.updatedAt = at; next.hasStoredProfile = true;
    const parsed = C.parseCandidateProfileSnapshotV2(next);
    if (!parsed) return { ok: false, code: 'VALIDATION_FAILED' };
    saved = parsed;
    return scenario === 'uncertain' ? { ok: false, code: 'SAVE_UNCERTAIN' } : { ok: true, value: saved };
  };
  return { ports: { read, save }, scenario(value: typeof scenario) { scenario = value; } };
}
