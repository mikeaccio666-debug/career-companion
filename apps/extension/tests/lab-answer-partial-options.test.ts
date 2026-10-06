import { describe, expect, it } from 'vitest';
import type { QuestionDescription } from '@edaix/apply-kernel/questions';
import { labAnswerFor } from '../lab/labAnswers';

/**
 * A harvested option list can be **partial**, and the lab's mock answer must not
 * pretend otherwise.
 *
 * Measured on Workday's "How Did You Hear About Us?" (nvidia.wd5, 2026-09-15):
 * the prompt lists six categories and the answers live one level below them, so
 * a harvest that only reaches the first category comes back with that category's
 * leaves. The old fallback took `options[0]` whenever no preference matched, and
 * this question was answered — on the owner's real application — with the name of
 * an association. Falling back to the rule's own free text instead hands the
 * writer's matching ladder something it can judge, and the ladder fails closed
 * when nothing matches.
 *
 * The distrust is scoped to harvested lists on purpose. A radio/checkbox group or
 * a native select is enumerated in full by `describeQuestion`, so one of its
 * options is always an answer the page really offers — dropping the fallback
 * there cost Lever its work-authorisation radio and BambooHR its licence question
 * (measured 2026-09-15). Callers therefore say which kind of list this is, and
 * the default — an unset flag, as in a complete enumeration — keeps the fallback.
 */
function question(text: string, options: readonly string[]): QuestionDescription {
  return {
    questionId: 'q0',
    text,
    controlType: 'SINGLE_CHOICE',
    required: true,
    options: options.map((option, index) => ({ optionId: `h${index}`, text: option })),
    fieldName: 'source',
  };
}

describe('lab mock answers on a partially harvested option list', () => {
  it('prefers the rule’s free text over an arbitrary first option', () => {
    const partial = question('How Did You Hear About Us?', ['Atidim', 'Impact', 'Moshal']);
    expect(labAnswerFor(partial, { optionsMayBePartial: true })).toEqual({ value: 'LinkedIn', category: 'source' });
  });

  it('still takes a preferred option when the harvest actually contains one', () => {
    const complete = question('How Did You Hear About Us?', ['Glassdoor', 'Indeed', 'Linkedin Jobs', 'Monster']);
    expect(labAnswerFor(complete, { optionsMayBePartial: true })).toEqual({ value: 'Linkedin Jobs', category: 'source' });
  });

  it('keeps the first-option fallback for a rule that has no free text of its own', () => {
    // The phone-meta rule answers with an option or nothing; its freeText is ''.
    const codes = question('Country Phone Code', ['Afghanistan (+93)', 'Albania (+355)']);
    expect(labAnswerFor(codes, { optionsMayBePartial: true })).toEqual({ value: 'Afghanistan (+93)', category: 'phone-meta' });
  });

  it('takes a real option from a complete enumeration, because one of them is the page’s own answer', () => {
    // A radio group: describeQuestion counted every member, so nothing is missing.
    // Both of these came back NO_VALUE while the distrust was applied to every
    // list, which is how the regression was found.
    const licence = question('Do you hold a current and clear license with the State of Utah?', ['Yes', 'No']);
    expect(labAnswerFor(licence, {})?.value).toBe('Yes');

    const auth = question('Are you legally authorized to work in the country for which you are applying?', ['Yes', 'No']);
    expect(labAnswerFor(auth, {})).toEqual({ value: 'Yes', category: 'work-authorization' });
  });
});
