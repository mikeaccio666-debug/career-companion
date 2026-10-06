import { savedProfileView } from '../assistant/features/session/profile-view';
import type { ViewContext } from '../assistant/app/view-context';
import { parseCandidateProfileSnapshotV2 } from '@edaix/contracts';
import { describe, expect, it } from 'vitest';
import { fictionalProfileSnapshot } from '../assistant/testing/profile-snapshot';
import { createProfileDraft, editProfileValue, addProfileRow, removeProfileRow, buildProfilePatch, rebaseProfileDraft } from '../assistant/features/profile/editor-model';

const snapshot = () => fictionalProfileSnapshot('Example Person')!;
describe('ordinary profile editing', () => {
  it.each([
    ['links', { kind: 'WEBSITE', url: 'https://example.test' }],
    ['experiences', { company: 'Example', title: 'Engineer', isCurrent: 'false' }],
    ['educations', { school: 'Example School', isCurrent: 'false' }],
    ['skills', { name: 'Testing', categories: ['TECHNICAL'] }],
    ['languages', { language: 'English', proficiency: 'PROFESSIONAL' }],
    ['projects', { title: 'Example Project', isCurrent: 'false' }],
    ['achievements', { kind: 'AWARD', title: 'Example Award', statement: 'Fictional achievement', 'context.type': 'STANDALONE' }],
    ['workAuthorizations', { regionCode: 'US', authorizedToWork: 'YES', requiresSponsorship: 'NO', $confirmed: 'true' }],
  ] as const)('adds a valid %s row with explicit values and server-assigned identity', (section, values) => {
    let draft = addProfileRow(createProfileDraft(snapshot(), section), 'new');
    for (const [key, value] of Object.entries(values)) draft = editProfileValue(draft, 'new', key, Array.isArray(value) ? [...value] : value as string);
    const patch = buildProfilePatch(draft);
    expect(patch.ok).toBe(true);
    if (!patch.ok) return;
    const row = patch.value[section]!.at(-1)!;
    expect(row).not.toHaveProperty('id'); expect(row.confirmFields.length).toBeGreaterThan(1);
  });
  it('sends only changed scalar paths, permitting an incomplete profile', () => {
    const draft = editProfileValue(createProfileDraft(snapshot(), 'basic'), 'scalar', 'identity.preferredName', 'Sam');
    const result = buildProfilePatch(draft);
    expect(result.ok && result.value.fields).toEqual({ 'identity.preferredName': 'Sam' });
    expect(result.ok && result.value.expectedRevision).toBe('1');
  });
  it('confirms only edited fields of existing collection rows', () => {
    let draft = createProfileDraft(snapshot(), 'experiences');
    draft = editProfileValue(draft, draft.rows[0]!.key, 'title', 'Designer');
    const result = buildProfilePatch(draft);
    expect(result.ok && result.value.experiences?.[0]?.confirmFields).toEqual(['title']);
    expect(result.ok && result.value.experiences?.[0]?.startDate).toEqual({ year: 2022, month: 6 });
  });
  it('requires explicit current status and expected graduation date', () => {
    let draft = addProfileRow(createProfileDraft(snapshot(), 'educations'), 'new-school');
    draft = editProfileValue(draft, 'new-school', 'school', 'Second school');
    expect(buildProfilePatch(draft).ok).toBe(false);
    draft = editProfileValue(draft, 'new-school', 'isCurrent', 'true');
    expect(buildProfilePatch(draft).ok).toBe(false);
    draft = editProfileValue(draft, 'new-school', 'expectedGraduationDate', '2028');
    const result = buildProfilePatch(draft);
    expect(result.ok && result.value.educations?.[1]?.expectedGraduationDate).toEqual({ year: 2028, month: null });
  });
  it('requires explicit work authorization answers and per-row acknowledgement', () => {
    let draft = addProfileRow(createProfileDraft(snapshot(), 'workAuthorizations'), 'region');
    for (const [field, value] of [['regionCode', 'US'], ['authorizedToWork', 'YES'], ['requiresSponsorship', 'NO']]) draft = editProfileValue(draft, 'region', field!, value!);
    expect(buildProfilePatch(draft)).toMatchObject({ ok: false, code: 'CONFIRM_REQUIRED' });
    draft = editProfileValue(draft, 'region', '$confirmed', 'true');
    expect(buildProfilePatch(draft).ok).toBe(true);
    draft = editProfileValue(draft, 'region', 'requiresSponsorship', 'YES');
    expect(buildProfilePatch(draft)).toMatchObject({ ok: false, code: 'CONFIRM_REQUIRED' });
  });
  it('preserves unrelated server edits on explicit three-way rebase', () => {
    const before = snapshot();
    let draft = createProfileDraft(before, 'experiences');
    draft = editProfileValue(draft, draft.rows[0]!.key, 'title', 'My title');
    const latest = { ...before, revision: '2' as typeof before.revision, profile: { ...before.profile, experiences: [{ ...before.profile.experiences[0]!, company: 'New server company' as typeof before.profile.experiences[0]['company'] }] } };
    const rebased = rebaseProfileDraft(draft, latest);
    expect(rebased.ok).toBe(true);
    if (!rebased.ok) return;
    const patch = buildProfilePatch(rebased.value);
    expect(patch.ok && patch.value.experiences?.[0]).toMatchObject({ company: 'New server company', title: 'My title', confirmFields: ['title'] });
  });
  it('treats explicit work authorization acknowledgement as confirmation even without value edits', () => {
    const before = snapshot(), authority = before.profile.experiences[0]!.factAuthorityByField.company;
    const base = parseCandidateProfileSnapshotV2({ ...before, profile: { ...before.profile, workAuthorizations: [{ regionCode: 'US', authorizedToWork: 'YES', requiresSponsorship: 'NO', revision: '1', effectiveAt: '2026-09-13T00:00:00.000Z', expiresAt: null, revokedAt: null, factAuthorityByField: { regionCode: authority, authorizedToWork: authority, requiresSponsorship: authority } }] } })!;
    const draft = editProfileValue(createProfileDraft(base, 'workAuthorizations'), 'US', '$confirmed', 'true');
    const patch = buildProfilePatch(draft);
    expect(patch.ok && patch.value.workAuthorizations?.[0]?.confirmFields).toEqual(['authorizedToWork', 'regionCode', 'requiresSponsorship']);
  });
  it('does not recreate a new row already saved before the response was lost', () => {
    const before = snapshot(); let draft = addProfileRow(createProfileDraft(before, 'skills'), 'new-skill');
    draft = editProfileValue(draft, 'new-skill', 'name', 'Testing'); draft = editProfileValue(draft, 'new-skill', 'categories', ['TECHNICAL']);
    const authority = before.profile.experiences[0]!.factAuthorityByField.company;
    const latest = parseCandidateProfileSnapshotV2({ ...before, revision: '2', profile: { ...before.profile, skills: [{ id: '80000000-0000-4000-8000-000000000001', name: 'Testing', categories: ['TECHNICAL'], factAuthorityByField: { name: authority, categories: authority } }] } })!;
    const rebased = rebaseProfileDraft(draft, latest);
    expect(rebased.ok && rebased.value.rows).toHaveLength(1);
    expect(rebased.ok && buildProfilePatch(rebased.value)).toEqual({ ok: false, code: 'NO_CHANGES' });
  });
  it('cannot restore a draft across deletion epochs or removed edited rows', () => {
    const before = snapshot();
    const draft = editProfileValue(createProfileDraft(before, 'experiences'), before.profile.experiences[0]!.id, 'title', 'My title');
    const latest = { ...before, profile: { ...before.profile, experiences: [] } };
    expect(rebaseProfileDraft(draft, latest)).toMatchObject({ ok: false, code: 'REBASE_BLOCKED' });
    latest.deletionEpoch = '1' as typeof latest.deletionEpoch;
    expect(rebaseProfileDraft(createProfileDraft(before, 'summary'), latest).ok).toBe(false);
  });
  it('clears an explicitly removed primary current experience without changing other groups', () => {
    const original = snapshot(); const base = { ...original, profile: { ...original.profile, primaryCurrentExperienceId: original.profile.experiences[0]!.id } };
    const draft = removeProfileRow(createProfileDraft(base, 'experiences'), base.profile.experiences[0]!.id);
    const result = buildProfilePatch(draft);
    expect(result.ok && result.value).toMatchObject({ experiences: [], primaryCurrentExperienceId: null });
    expect(result.ok && result.value.educations).toBeUndefined();
  });
  it('does not emit a PATCH for an unchanged draft', () => {
    expect(buildProfilePatch(createProfileDraft(snapshot(), 'basic'))).toEqual({ ok: false, code: 'NO_CHANGES' });
  });
});

it('keeps edit routing tied to section identity even when translated titles collide', () => {
  const ctx = { t: () => 'Section', state: { profileV2: snapshot(), reads: { profileV2: 'ready' }, profileEditingEnabled: true } } as unknown as ViewContext;
  expect(savedProfileView(ctx).groups.map(g => g.editSection)).toEqual([
    'basic', 'summary', 'links', 'experiences', 'educations', 'skills', 'languages', 'projects', 'achievements', 'availability', 'workAuthorizations',
  ]);
});

it('drops additive fields from populated collections, dates and fact metadata without losing consumed facts', () => {
  const expected = snapshot(), wire = structuredClone(expected);
  function extend(value: unknown) {
    if (Array.isArray(value)) { for (const item of value) extend(item); }
    else if (value && typeof value === 'object') {
      for (const item of Object.values(value)) extend(item);
      (value as Record<string, unknown>).futureField = { discard: true };
    }
  }
  extend(wire);
  expect(parseCandidateProfileSnapshotV2(wire)).toEqual(expected);
});
