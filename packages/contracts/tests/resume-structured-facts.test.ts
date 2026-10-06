import { describe, expect, it } from 'vitest';
import { parseResumeProfileStructuredFactsV1, PROFILE_V2_COLLECTION_LIMITS } from '../src/index.ts';
const fact = (value: string) => ({ value, source: 'RESUME_TEXT', confidence: 0.8 });
const candidate = () => ({ scalars: { 'identity.fullName': fact('Example Person') },
  experiences: [{ id: 'experience-00', fields: { company: fact('Example Labs') } }],
  educations: [], skills: [], languages: [], projects: [], achievements: [{ id: 'achievement-00', fields: { statement: fact('Built a sample tool.') }, context: { type: 'EXPERIENCE', suggestionId: 'experience-00' } }],
});
describe('raw structured resume wire', () => {
  it('accepts bounded ordinary raw facts with an ephemeral parent reference', () => {
    expect(parseResumeProfileStructuredFactsV1(candidate())).toEqual(candidate());
  });
  it('preserves an unconfirmed association without granting a parent relationship', () => {
    const value = { ...candidate(), experiences: [{ ...candidate().experiences[0], association: { status: 'UNCONFIRMED', sourceExcerpt: 'EXPERIENCE\nExample Labs' } }], achievements: [] };
    expect(parseResumeProfileStructuredFactsV1(value)).toEqual(value);
    expect(parseResumeProfileStructuredFactsV1({ ...value, achievements: candidate().achievements })).toBeNull();
    for (const association of [{ status: 'CONFIRMED', sourceExcerpt: 'Example Labs' }, { status: 'UNCONFIRMED', sourceExcerpt: 'Different source' }, { status: 'UNCONFIRMED', sourceExcerpt: 'x'.repeat(16001) }]) {
      expect(parseResumeProfileStructuredFactsV1({ ...value, experiences: [{ ...value.experiences[0], association }] })).toBeNull();
    }
  });
  it.each(['missing group', 'sensitive scalar', 'wire field', 'unknown parent', 'duplicate id', 'bad source', 'too many'])(
    'rejects %s', mode => {
      const value: Record<string, unknown> = candidate();
      if (mode === 'missing group') delete value.languages;
      if (mode === 'sensitive scalar') value.scalars = { noExperience: fact('true') };
      if (mode === 'wire field') value.experiences = [{ id: 'experience-00', fields: { company: fact('Example Labs'), ownerId: fact('anything') } }];
      if (mode === 'unknown parent') value.experiences = [];
      if (mode === 'duplicate id') value.experiences = [...candidate().experiences, ...candidate().experiences];
      if (mode === 'bad source') value.scalars = { summary: { ...fact('Sample'), source: 'RESUME_LINK' } };
      if (mode === 'too many') value.languages = Array.from({ length: PROFILE_V2_COLLECTION_LIMITS.languages + 1 }, (_, index) => ({ id: `language-${String(index).padStart(2,'0')}`, fields: { language: fact('Example') } }));
      expect(parseResumeProfileStructuredFactsV1(value)).toBeNull();
    },
  );
});
