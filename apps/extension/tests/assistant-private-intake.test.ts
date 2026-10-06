import { describe, expect, it } from 'vitest';
import { candidateProfileDraft } from '../assistant/features/intake/private-controller';
import { fictionalProfileSnapshot } from '../assistant/testing/profile-snapshot';
import { buildProfilePatch } from '../assistant/features/profile/editor-model';

describe('reviewed intake draft', () => {
  it('prefills the quoted group while preserving existing profile rows', () => {
    const profile = fictionalProfileSnapshot('Example Person')!;
    const draft = candidateProfileDraft(profile, { id: 'summary', section: 'summary', fields: [{ path: 'summary', value: 'Designer', sources: [{ start: 0, end: 8, quote: 'Designer' }] }] });
    expect(draft.rows[0]?.values.summary).toBe('Designer');
    const patch = buildProfilePatch(draft);
    expect(patch.ok && patch.value.fields).toEqual({ summary: 'Designer' });
  });
});
