import { describe, expect, it } from 'vitest';
import { parseRolePreferences, parseRolePreferencesPatch, parseRolePreferencesSnapshot, upgradeRolePreferences } from '../src/rolePreferences.ts';

const preferences = { preferredLocation: 'Toronto, ON', workMode: 'HYBRID', salary: { min: '90000', max: '120000.50', currency: 'CAD', period: 'YEAR' }, availableFrom: '2028-02-29' };
describe('Role preferences executable contract', () => {
  it('round trips exact user preferences and leaves legacy fields unspecified', () => {
    expect(parseRolePreferences(preferences)).toEqual(preferences);
    expect(upgradeRolePreferences({ preferredLocation: 'Toronto, ON' })).toEqual({ preferredLocation: 'Toronto, ON', workMode: null, salary: null, availableFrom: null });
    expect(upgradeRolePreferences({ preferredLocation: null, workMode: 'REMOTE' })).toBeNull();
  });
  it.each([
    { ...preferences, salary: { ...preferences.salary, min: '130000' } },
    { ...preferences, salary: { ...preferences.salary, max: '1e8' } },
    { ...preferences, salary: { ...preferences.salary, currency: 'ZZZ' } },
    { ...preferences, salary: { ...preferences.salary, min: '-1' } },
    { ...preferences, salary: { ...preferences.salary, max: '0.001' } },
    { ...preferences, salary: { ...preferences.salary, min: null, max: null } },
    { ...preferences, availableFrom: '2027-02-29' },
    { ...preferences, workMode: 'ANY' },
    { ...preferences, preferredLocation: 'Toronto\nOntario' },
    { ...preferences, targetRole: 'forbidden rename' },
  ])('rejects invalid, ambiguous or out-of-scope preferences', value => expect(parseRolePreferences(value)).toBeNull());
  it('validates CAS and response identity, strips unknown response fields only', () => {
    expect(parseRolePreferencesPatch({ expectedRevision: '2', preferences })).toEqual({ expectedRevision: '2', preferences });
    expect(parseRolePreferencesPatch({ expectedRevision: '0', preferences })).toBeNull();
    expect(parseRolePreferencesPatch({ expectedRevision: '2', preferences, userId: 'foreign' })).toBeNull();
    const view = { schemaVersion: 1, conversationId: '11111111-1111-4111-8111-111111111111', revision: '3', preferences };
    expect(parseRolePreferencesSnapshot({ ...view, internal: 'private' })).toEqual(view);
    expect(parseRolePreferencesSnapshot({ ...view, conversationId: 'invalid' })).toBeNull();
  });
});
