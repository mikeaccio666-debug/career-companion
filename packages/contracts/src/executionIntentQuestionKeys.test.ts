import { describe, expect, it } from 'vitest';
import {
  APPLICATION_PROFILE_FIELD_KEYS,
  EXECUTION_INTENT_MAX_QUESTION_CLAIM_KEYS,
  isQuestionClaimKey,
  partitionExecutionIntentClaimKeys,
  questionClaimKeyForIdentityDigest,
} from './executionIntent.ts';
import { applicationQuestionIdentityPreimage } from './applicationQuestionMemory.ts';

const digest = (hex: string) => `sha256:${hex.repeat(64).slice(0, 64)}`;

describe('question claim keys', () => {
  it('derives a stable key from the question identity digest', () => {
    expect(questionClaimKeyForIdentityDigest(digest('ab'))).toBe(
      `question:q${'ab'.repeat(16)}`,
    );
    // Scan order never enters the key: only the digest does.
    expect(questionClaimKeyForIdentityDigest(digest('ab'))).toBe(
      questionClaimKeyForIdentityDigest(digest('ab')),
    );
  });

  it('refuses anything that is not a canonical sha256 identity digest', () => {
    for (const bad of ['', 'sha256:', 'sha256:zz', digest('ab').toUpperCase(), 42, null]) {
      expect(questionClaimKeyForIdentityDigest(bad as string)).toBeNull();
    }
  });

  it('accepts only the strict question key shape', () => {
    expect(isQuestionClaimKey(`question:q${'0'.repeat(32)}`)).toBe(true);
    for (const bad of [
      'question:',
      'question:q',
      `question:q${'0'.repeat(31)}`,
      `question:q${'0'.repeat(33)}`,
      `question:q${'0'.repeat(31)}Z`,
      'question:q0'.padEnd(34, 'g'),
      'question:0'.padEnd(33, '0'),
      'firstName',
      `question:q${'0'.repeat(32)}\n`,
    ]) {
      expect(isQuestionClaimKey(bad)).toBe(false);
    }
  });

  it('partitions a sorted claim set into profile keys and question keys', () => {
    const question = questionClaimKeyForIdentityDigest(digest('ab'))!;
    const partitioned = partitionExecutionIntentClaimKeys(['city', 'email', question]);
    expect(partitioned).toEqual({
      profileKeys: ['city', 'email'],
      questionKeys: [question],
    });
  });

  it('keeps the profile keys canonical and rejects unsorted, duplicated or unknown keys', () => {
    const question = questionClaimKeyForIdentityDigest(digest('ab'))!;
    expect(partitionExecutionIntentClaimKeys([])).toBeNull();
    expect(partitionExecutionIntentClaimKeys(['email', 'city'])).toBeNull();
    expect(partitionExecutionIntentClaimKeys(['city', 'city'])).toBeNull();
    expect(partitionExecutionIntentClaimKeys(['city', 'nickname'])).toBeNull();
    expect(partitionExecutionIntentClaimKeys([question, 'city'])).toBeNull();
    expect(partitionExecutionIntentClaimKeys(['city', 'question:qzz'])).toBeNull();
  });

  it('bounds the question class without touching the profile bound', () => {
    const keys = Array.from({ length: EXECUTION_INTENT_MAX_QUESTION_CLAIM_KEYS + 1 }, (_value, index) =>
      questionClaimKeyForIdentityDigest(digest(index.toString(16).padStart(2, '0')))!,
    ).sort();
    expect(new Set(keys).size).toBe(keys.length);
    expect(partitionExecutionIntentClaimKeys(keys)).toBeNull();
    expect(partitionExecutionIntentClaimKeys(keys.slice(0, EXECUTION_INTENT_MAX_QUESTION_CLAIM_KEYS))).not.toBeNull();
  });

  it('leaves the canonical profile field keys untouched', () => {
    expect([...APPLICATION_PROFILE_FIELD_KEYS]).toEqual([
      'firstName', 'lastName', 'fullName', 'preferredName', 'email', 'phone',
      'linkedinUrl', 'githubUrl', 'portfolioUrl', 'city', 'location',
      // 端点从 argoland #469 起就在发这三个；插件接住之前它们只是被丢掉。
      'addressLine1', 'addressRegion', 'currentCompany',
      'addressCountry', 'addressPostalCode', 'currentJobTitle',
      'eeoGender', 'eeoRace', 'eeoVeteran', 'eeoDisability', 'heardAboutSource',
      // 2026-09-21 填写键扩展（argoland #535）。
      'preferredPronouns', 'earliestStartDate', 'noticePeriodDays', 'profileSummary',
      'expectedSalaryAmount', 'expectedSalaryCurrency', 'expectedSalaryPeriod',
      'over18', 'openToRelocation', 'openToRelocationCities', 'preferredWorkModes',
      'profileTwitterUrl', 'otherWebsiteUrl',
    ]);
    // Every profile key sorts before the question class, so one ASCII sort is canonical.
    const sorted = [...APPLICATION_PROFILE_FIELD_KEYS].sort();
    expect(sorted.every((key) => key < 'question:')).toBe(true);
  });
});

describe('question identity preimage', () => {
  it('ignores required markers, case and option order', () => {
    const a = applicationQuestionIdentityPreimage({
      text: 'Are you authorised to work? *',
      controlType: 'SINGLE_CHOICE',
      optionTexts: ['Yes', 'No'],
    });
    const b = applicationQuestionIdentityPreimage({
      text: 'are you authorised to work?',
      controlType: 'SINGLE_CHOICE',
      optionTexts: ['no', 'yes'],
    });
    expect(a).toBe(b);
  });

  it('separates different control types', () => {
    const text = applicationQuestionIdentityPreimage({ text: 'Why us?', controlType: 'TEXT', optionTexts: [] });
    const textarea = applicationQuestionIdentityPreimage({ text: 'Why us?', controlType: 'TEXTAREA', optionTexts: [] });
    expect(text).not.toBe(textarea);
  });
});
