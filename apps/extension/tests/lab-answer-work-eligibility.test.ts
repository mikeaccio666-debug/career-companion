import { describe, expect, it } from 'vitest';
import type { QuestionDescription } from '@edaix/apply-kernel/questions';
import { labAnswerFor } from '../lab/labAnswers';

/**
 * Workday step 3 (nvidia.wd5, measured live 2026-09-15) asks its two
 * immigration questions with the word "country" inside the sentence:
 *
 *   Are you legally authorized to work in the country where this position is located?
 *   Will you require employer support to obtain or maintain authorization to work
 *   in that country? e.g. (work permit)
 *
 * Both offer exactly Yes / No. With the bare `country` field-name rule ahead of
 * the work-eligibility rules, both were answered "United States" and both
 * writes came back CHOICE_NO_DATA — the page could not be completed at all.
 *
 * The second question also has to reach `sponsorship`, not `work-authorization`:
 * the latter answers Yes, and "yes, I require employer support" is a wrong
 * answer on a real application, not merely an unfilled box.
 */
function question(text: string, options: readonly string[] = ['Yes', 'No']): QuestionDescription {
  return {
    questionId: 'q0',
    text,
    controlType: 'SINGLE_CHOICE',
    required: true,
    options: options.map((option, index) => ({ optionId: `h${index}`, text: option })),
    fieldName: 'primaryQuestionnaire',
  };
}

describe('lab mock answers · work eligibility questions that mention a country', () => {
  it('answers "legally authorized to work in the country…" from the Yes/No options', () => {
    expect(labAnswerFor(question('Are you legally authorized to work in the country where this position is located?'), {}))
      .toEqual({ value: 'Yes', category: 'work-authorization' });
  });

  it('reads "require employer support … authorization to work in that country" as sponsorship', () => {
    expect(labAnswerFor(
      question('Will you require employer support to obtain or maintain authorization to work in that country? e.g. (work permit)'),
      {},
    )).toEqual({ value: 'No', category: 'sponsorship' });
  });

  it('keeps the plain address Country field on the country rule', () => {
    expect(labAnswerFor(question('Country', ['United States of America', 'Canada']), {}))
      .toEqual({ value: 'United States of America', category: 'country' });
  });

  it('still reads the classic sponsorship wording', () => {
    expect(labAnswerFor(question('Will you now or in the future require visa sponsorship?'), {}))
      .toEqual({ value: 'No', category: 'sponsorship' });
  });
});
