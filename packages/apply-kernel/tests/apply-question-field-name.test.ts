import { afterEach, describe, expect, it } from 'vitest';
import { describeQuestion } from '../src/questions';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';

/**
 * A described question carries the control's own form name so a caller that already knows the
 * application form's field list can join the two. This is the generic `name`/`id` attribute of
 * the scanned control, never site knowledge: a same-name choice group answers with the one
 * name all its members share.
 */
afterEach(() => {
  document.body.innerHTML = '';
});

describe('a described question names its control', () => {
  it('reports the control name, falling back to its id, and one shared name per choice group', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="first_name">First name*</label>
        <input id="first_name" type="text" required />
        <label for="why">Why do you want to work here?*</label>
        <textarea id="why" name="question_7" required></textarea>
        <label for="auth">Are you legally authorized to work?*</label>
        <select id="auth" required><option value="">Select...</option><option value="1">Yes</option><option value="0">No</option></select>
        <fieldset>
          <legend>Which of these have you worked with?</legend>
          <div><input id="question_9[]_0" name="question_9[]" type="checkbox" value="0" /><label for="question_9[]_0">TypeScript</label></div>
          <div><input id="question_9[]_1" name="question_9[]" type="checkbox" value="1" /><label for="question_9[]_1">Rust</label></div>
        </fieldset>
      </form>`;
    const root = greenhouseAdapter.resolveRoot(document)!;
    const questions = [...greenhouseAdapter.scan(root)].map((field, index) => describeQuestion(field, `q${index}`));

    expect(questions.filter((question) => question !== null).map((question) => [question.text, question.fieldName])).toEqual([
      ['First name', 'first_name'],
      ['Why do you want to work here?', 'question_7'],
      ['Are you legally authorized to work?', 'auth'],
      ['Which of these have you worked with?', 'question_9[]'],
    ]);
  });
});
