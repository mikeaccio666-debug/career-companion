import { parseUuid, type AssistantRoleView, type RolePreferencesSnapshot } from '@edaix/contracts';
import type { RolePorts } from '../features/targets/owner-roles';
export function createRoleFixture() {
  const roles: AssistantRoleView[] = ['Product Designer', 'UX Researcher'].map((targetRole, index) => ({ id: parseUuid(`20000000-0000-4000-8000-00000000000${index + 1}`)!, revision: '1', targetRole, status: 'ACTIVE', jobPreferences: { preferredLocation: index ? 'Vancouver' : 'Toronto' } }));
  const snapshots = new Map(roles.map(r => [r.id, { schemaVersion: 1 as const, conversationId: r.id, revision: r.revision,
    preferences: { preferredLocation: r.jobPreferences.preferredLocation, workMode: null, salary: null, availableFrom: null } } as RolePreferencesSnapshot]));
  let scenario: 'normal' | 'conflict' | 'uncertain' | 'slow' = 'normal';
  const ports: RolePorts = {
    async list(_cursor, signal) { return signal.aborted ? { ok: false, code: 'CANCELLED' } : { ok: true, value: { items: structuredClone(roles), nextCursor: null } }; },
    async create(request, signal) {
      if (signal.aborted) return { ok: false, code: 'CANCELLED' };
      const existing = roles.find(r => r.targetRole.toLowerCase() === request.targetRole.toLowerCase());
      if (existing) return { ok: true, value: { role: structuredClone(existing), created: false } };
      const role: AssistantRoleView = { id: parseUuid(crypto.randomUUID())!, revision: '1', targetRole: request.targetRole, status: 'ACTIVE', jobPreferences: request.jobPreferences ?? { preferredLocation: null } };
      roles.push(role); snapshots.set(role.id, { schemaVersion: 1, conversationId: role.id, revision: '1', preferences: { preferredLocation: role.jobPreferences.preferredLocation, workMode: null, salary: null, availableFrom: null } });
      return scenario === 'uncertain' ? { ok: false, code: 'SAVE_UNCERTAIN' } : { ok: true, value: { role: structuredClone(role), created: true } };
    },
    async read(id, signal) { const value = snapshots.get(id); return signal.aborted ? { ok: false, code: 'CANCELLED' } : value ? { ok: true, value: structuredClone(value) } : { ok: false, code: 'NOT_FOUND' }; },
    async save(id, patch, signal) {
      if (scenario === 'slow') await new Promise(r => setTimeout(r, 1800));
      if (signal.aborted) return { ok: false, code: 'SAVE_UNCERTAIN' };
      const current = snapshots.get(id); if (!current) return { ok: false, code: 'NOT_FOUND' };
      if (scenario === 'conflict') { snapshots.set(id, { ...current, revision: String(BigInt(current.revision) + 1n) as typeof current.revision, preferences: { ...current.preferences, preferredLocation: 'Montreal' } }); return { ok: false, code: 'REVISION_CONFLICT' }; }
      if (current.revision !== patch.expectedRevision) return { ok: false, code: 'REVISION_CONFLICT' };
      const value = { ...current, revision: String(BigInt(current.revision) + 1n) as typeof current.revision, preferences: structuredClone(patch.preferences) };
      snapshots.set(id, value); const index = roles.findIndex(r => r.id === id); roles[index] = { ...roles[index]!, revision: value.revision, jobPreferences: { preferredLocation: value.preferences.preferredLocation } };
      return scenario === 'uncertain' ? { ok: false, code: 'SAVE_UNCERTAIN' } : { ok: true, value: structuredClone(value) };
    },
  };
  return { ports, scenario(value: typeof scenario) { scenario = value; } };
}
