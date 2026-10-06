import { afterEach, describe, expect, it } from 'vitest';
import { buildAnswerPlan, buildApplyPlan } from '../src/engine';
import { describeQuestion } from '../src/questions';
import { runApplyPlan } from '../src/runner';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import { createUndoJournal } from '../src/undo';
import { capabilitiesForKinds } from '../src/write/allowlist';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

/**
 * Real Greenhouse job-boards (2026-09-10, 14 company-custom pages): a "select all that apply"
 * question renders as a fieldset with a legend and one same-name checkbox per option
 * (`name="question_123[]"`); Greenhouse asks yes/no through selects, but radio groups exist on
 * other vendors. One group is one question: the scanner reports it once with its options, the
 * profile plan leaves it for the user, a reviewed answer checks exactly the confirmed options.
 */
afterEach(() => {
  document.body.innerHTML = '';
});

function mountForm(): void {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="first_name">First name*</label>
      <input id="first_name" type="text" required />
      <fieldset>
        <legend>Which of these have you worked with? (select all that apply)*</legend>
        <div class="checkbox__input"><input id="question_1[]_0" name="question_1[]" type="checkbox" value="0" required /><label for="question_1[]_0">TypeScript</label></div>
        <div class="checkbox__input"><input id="question_1[]_1" name="question_1[]" type="checkbox" value="1" required /><label for="question_1[]_1">Python</label></div>
        <div class="checkbox__input"><input id="question_1[]_2" name="question_1[]" type="checkbox" value="2" required /><label for="question_1[]_2">Rust</label></div>
      </fieldset>
      <fieldset>
        <legend>Are you open to relocating?</legend>
        <label><input name="question_2" type="radio" value="yes" /> Yes</label>
        <label><input name="question_2" type="radio" value="no" /> No</label>
      </fieldset>
      <label for="terms"><input id="terms" type="checkbox" /> I confirm the above is accurate</label>
    </form>`;
}

describe('native choice groups are one question each', () => {
  it('scans a same-name group once, with its options, and describes it as a choice question', () => {
    mountForm();
    const root = greenhouseAdapter.resolveRoot(document)!;
    const fields = [...greenhouseAdapter.scan(root)];
    const groups = fields.filter((field) => field.kind === 'choice');
    expect(groups.map((field) => [field.choice.control, field.choice.options.map((o) => o.label), field.required])).toEqual([
      ['checkbox', ['TypeScript', 'Python', 'Rust'], true],
      ['radio', ['Yes', 'No'], false],
      ['checkbox', ['I confirm the above is accurate'], false],
    ]);
    expect(fields.filter((field) => field.kind === 'unsupported')).toEqual([]);
    const questions = groups.map((field, index) => describeQuestion(field, `q${index}`));
    expect(questions[0]).toMatchObject({ text: 'Which of these have you worked with? (select all that apply)*', controlType: 'MULTI_CHOICE',
      options: [{ optionId: 'o0', text: 'TypeScript' }, { optionId: 'o1', text: 'Python' }, { optionId: 'o2', text: 'Rust' }] });
    expect(questions[1]).toMatchObject({ controlType: 'SINGLE_CHOICE', options: [{ optionId: 'o0', text: 'Yes' }, { optionId: 'o1', text: 'No' }] });
  });

  it('leaves choice groups to the user in the profile plan and writes exactly the confirmed options from a reviewed answer', async () => {
    mountForm();
    const root = greenhouseAdapter.resolveRoot(document)!;
    const fields = [...greenhouseAdapter.scan(root)];
    const profilePlan = buildApplyPlan({ vendor: 'greenhouse', root, fields }, { firstName: 'Avery' });
    // The two custom groups wait for a reviewed answer; the attestation checkbox stays the user's own (never-writable guard first).
    expect(profilePlan.skipped.filter((item) => item.reason === 'CHOICE_NO_DATA')).toHaveLength(2);
    expect(profilePlan.skipped.find((item) => item.label.startsWith('I confirm'))).toMatchObject({ reason: 'MANUAL_ONLY' });

    const multi = document.getElementById('question_1[]_0')!;
    const radio = document.querySelector<HTMLInputElement>('input[name="question_2"]')!;
    const plan = buildAnswerPlan({ vendor: 'greenhouse', root, fields }, [
      { questionId: 'langs', element: multi, value: 'TypeScript\nRust' },
      { questionId: 'relocate', element: radio, value: 'No' },
      { questionId: 'attest', element: document.getElementById('terms')!, value: 'I confirm the above is accurate' },
    ]);
    // The attestation stays the user's own even with a reviewed answer (guard first); an unknown option writes nothing.
    expect(plan.entries.map((entry) => [entry.key, entry.kind])).toEqual([['question:langs', 'choice'], ['question:relocate', 'choice']]);
    expect(plan.skipped.map((item) => [item.key, item.reason])).toEqual([['question:attest', 'MANUAL_ONLY']]);
    expect(buildAnswerPlan({ vendor: 'greenhouse', root, fields }, [{ questionId: 'unknown', element: multi, value: 'Definitely' }]).skipped)
      .toEqual([expect.objectContaining({ key: 'question:unknown', reason: 'NO_VALUE' })]);

    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(plan.entries.map((entry) => entry.kind))]),
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
      readHostValidation: () => ({ ariaInvalid: 'false' }),
      lateRecheckMs: 5,
    });
    expect(summary.results.map((result) => [result.key, result.ok])).toEqual([['question:langs', true], ['question:relocate', true]]);
    const checked = [...document.querySelectorAll<HTMLInputElement>('input[type=checkbox], input[type=radio]')].filter((input) => input.checked).map((input) => input.id || input.value);
    expect(checked).toEqual(['question_1[]_0', 'question_1[]_2', 'no']);
  });

  it('refuses a reviewed answer whose option text names more than one member', () => {
    // Independent review of #320: two members with the same visible label would both be
    // checked, writing beyond what the user confirmed. Ambiguity is no value, not a wider write.
    document.body.innerHTML = `
      <form id="application-form">
        <fieldset>
          <legend>Which offices could you work from?</legend>
          <label><input name="question_3[]" type="checkbox" value="nyc" /> Remote</label>
          <label><input name="question_3[]" type="checkbox" value="sf" /> Remote</label>
          <label><input name="question_3[]" type="checkbox" value="ldn" /> London</label>
        </fieldset>
      </form>`;
    const root = greenhouseAdapter.resolveRoot(document)!;
    const fields = [...greenhouseAdapter.scan(root)];
    const first = document.querySelector<HTMLInputElement>('input[name="question_3[]"]')!;
    const ambiguous = buildAnswerPlan({ vendor: 'greenhouse', root, fields }, [{ questionId: 'offices', element: first, value: 'Remote\nLondon' }]);
    expect(ambiguous.entries).toEqual([]);
    expect(ambiguous.skipped).toEqual([expect.objectContaining({ key: 'question:offices', reason: 'NO_VALUE' })]);
    const unambiguous = buildAnswerPlan({ vendor: 'greenhouse', root, fields }, [{ questionId: 'offices', element: first, value: 'London' }]);
    expect(unambiguous.entries.map((entry) => entry.key)).toEqual(['question:offices']);
  });

  it('never checks a group whose wording is a honeypot or a never-writable control', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <fieldset style="position:absolute;left:-9999px"><legend>Leave this blank</legend>
          <label><input name="hp" type="checkbox" value="a" /> A</label></fieldset>
      </form>`;
    const root = greenhouseAdapter.resolveRoot(document)!;
    const fields = [...greenhouseAdapter.scan(root)];
    const plan = buildAnswerPlan({ vendor: 'greenhouse', root, fields }, [
      { questionId: 'hp', element: document.querySelector('input[name="hp"]')!, value: 'A' },
    ]);
    expect(plan.entries).toEqual([]);
    expect(plan.skipped).toEqual([expect.objectContaining({ key: 'question:hp', reason: 'HONEYPOT' })]);
  });
});
