import { describe, expect, it } from 'vitest';
import { countIntakeText, truncateIntakeText, parseIntakeTurnRequest, parseIntakeModelOutput, INTAKE_PROFILE_FIELDS, parseIntakeConfiguration } from '../src/profileIntake.ts';
const requestId = '11111111-1111-4111-8111-111111111111';
const output = (text: string) => ({ reply: 'Please review the city.', candidates: [{ id: 'city', section: 'basic', fields: [{ path: 'address.city', value: text, sources: [{ start: 0, end: [...text].length, quote: text }] }] }], roleSuggestions: [], clarifications: [], declinedFields: [] });
describe('private intake executable boundary', () => {
  it('counts and truncates Unicode code points without splitting emoji', () => {
    expect(countIntakeText('中a😀 ')).toBe(4);
    const long = '😀'.repeat(6001); expect(truncateIntakeText(long)).toEqual({ text: '😀'.repeat(6000), truncated: true, count: 6000 });
    expect(parseIntakeTurnRequest({ clientRequestId: requestId, expectedRevision: '0', text: long, source: 'TEXT' })).toBeNull();
    expect(parseIntakeTurnRequest({ clientRequestId: requestId, expectedRevision: '0', text: '😀'.repeat(6000), source: 'TEXT' })).not.toBeNull();
    expect(parseIntakeTurnRequest({ clientRequestId: requestId, expectedRevision: '0', text: '\ud800', source: 'TEXT' })).toBeNull();
  });
  it('requires exact source spans and preserves a quoted fact, not invented wording', () => {
    expect(parseIntakeModelOutput(output('Toronto'), 'Toronto')?.candidates[0]?.fields[0]?.value).toBe('Toronto');
    const invented = output('Toronto'); invented.candidates[0]!.fields[0]!.value = 'Vancouver';
    expect(parseIntakeModelOutput(invented, 'Toronto')).toBeNull();
    expect(parseIntakeModelOutput(output('Toronto'), 'Not Toronto')).toBeNull();
    const wrongOffset = output('Toronto'); wrongOffset.candidates[0]!.fields[0]!.sources[0]!.end = 6;
    expect(parseIntakeModelOutput(wrongOffset, 'Toronto')).toBeNull();
  });
  it('excludes sensitive declarations and arbitrary endpoint/authority instructions', () => {
    expect(INTAKE_PROFILE_FIELDS.some(f => /workAuthorization|sponsorship|ethnic|gender/i.test(f.path))).toBe(false);
    const v = output('Toronto'); v.candidates[0]!.fields[0]!.path = 'workAuthorizations.authorizedToWork';
    expect(parseIntakeModelOutput(v, 'Toronto')).toBeNull();
    expect(parseIntakeModelOutput({ ...output('Toronto'), endpoint: '/admin' }, 'Toronto')).toBeNull();
    expect(parseIntakeTurnRequest({ clientRequestId: requestId, expectedRevision: '0', text: 'Hi', source: 'TEXT', ownerId: requestId })).toBeNull();
  });
  it('keeps direction suggestions separate and requires source-bound rationale', () => {
    const v = { ...output('Toronto'), candidates: [], roleSuggestions: [{ id: 'direction', title: 'Data Analyst', rationale: 'A direction to explore.', sources: [{ start: 0, end: 7, quote: 'Toronto' }] }] };
    const parsed = parseIntakeModelOutput(v, 'Toronto'); expect(parsed?.candidates).toEqual([]); expect(parsed?.roleSuggestions).toHaveLength(1);
    expect(parseIntakeModelOutput({ ...v, roleSuggestions: [...v.roleSuggestions, ...v.roleSuggestions] }, 'Toronto')).toBeNull();
  });
  it('requires explicit versioned technical limits without choosing allowances', () => {
    expect(parseIntakeConfiguration(undefined)).toBeNull();
    expect(parseIntakeConfiguration({ version: 'test-v1', maxRecordingSeconds: 120, chunkSeconds: 30, nudgeAfterTurns: 3, maxSessionTurns: 30 })).not.toBeNull();
    expect(parseIntakeConfiguration({ version: 'test-v1', maxRecordingSeconds: 0, chunkSeconds: 30, nudgeAfterTurns: 3, maxSessionTurns: 30 })).toBeNull();
  });
});

it('rejects unchecked candidate decisions and profile writes outside the chosen group', async () => {
  const { parseIntakeCandidateDecisionRequest, parseIntakeConfirmRequest, intakePatchMatchesSection, parseIntakeView } = await import('../src/profileIntake.ts');
  expect(parseIntakeCandidateDecisionRequest({ expectedRevision: '1', decision: 'CONFIRMED' })).toBeNull();
  expect(parseIntakeView({ schemaVersion: 1, session: null, usage: { replies: { state: 'AVAILABLE', remaining: -1, resetsAt: null } }, configuration: null })).toBeNull();
  const patch = { schemaVersion: 2, expectedRevision: '0', expectedDeletionEpoch: '0', fields: { summary: 'Designer' } };
  expect(parseIntakeConfirmRequest({ expectedRevision: '1', patch })).not.toBeNull();
  expect(intakePatchMatchesSection(patch as never, 'summary')).toBe(true);
  expect(intakePatchMatchesSection(patch as never, 'basic')).toBe(false);
  expect(intakePatchMatchesSection({ ...patch, workAuthorizations: [] } as never, 'summary')).toBe(false);
});

// Keep this independent of Profile V2's extensible field constants: adding a
// profile field must not silently expose it to a paid intake prompt.
it('pins the complete intake collection surface', () => {
  const expected = {
    basic: ['identity.firstName','identity.middleName','identity.lastName','identity.fullName','identity.preferredName',
      'contact.email','contact.phone.countryCode','contact.phone.e164','contact.phone.display','contact.phone.type',
      'address.line1','address.line2','address.city','address.region','address.postalCode','address.countryCode'],
    summary: ['summary'], availability: ['availability.earliestStartDate','availability.noticePeriodDays'],
    links: ['kind','label','url'],
    experiences: ['company','title','city','region','employmentType','startDate','endDate','isCurrent','description'],
    educations: ['school','degree','degreeLevel','fieldOfStudy','city','region','startDate','endDate','expectedGraduationDate','isCurrent','gpa','gpaScale','coursework'],
    skills: ['name','categories'], languages: ['language','proficiency'],
    projects: ['title','organization','role','location','url','startDate','endDate','isCurrent','description'],
    achievements: ['kind','title','statement','occurredAt','url'],
  };
  expect(INTAKE_PROFILE_FIELDS).toEqual(Object.entries(expected).flatMap(([section, paths])=>paths.map(path=>({section,path}))));
});
it.each(['referralSource'])('rejects uncollectable %s candidates',path=>{
  const value=output('Toronto');value.candidates[0]!.fields[0]!.path=path;
  expect(parseIntakeModelOutput(value,'Toronto')).toBeNull();
});
