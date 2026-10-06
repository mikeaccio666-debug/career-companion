import { afterEach, describe, expect, it } from 'vitest';
import { buildApplyPlan, buildFillPlan } from '../src/engine';
import { describeQuestion, questionIdentity } from '../src/questions';
import { runApplyPlan } from '../src/runner';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import { createUndoJournal } from '../src/undo';
import { capabilitiesForKinds } from '../src/write/allowlist';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

/**
 * A remembered answer is filled in the same run as the profile fields: one plan,
 * one fingerprint, one minted authority. The guards run first for both classes.
 */
afterEach(() => {
  document.body.innerHTML = '';
});

function mountForm(): void {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="first_name">First name*</label>
      <input id="first_name" type="text" required />
      <label for="why">Why do you want to work here?*</label>
      <textarea id="why" required></textarea>
      <label for="auth">Are you legally authorized to work in the United States?*</label>
      <select id="auth" required><option value="">Select...</option><option value="1">Yes</option><option value="0">No</option></select>
      <label for="pw">Create a password</label>
      <input id="pw" type="password" />
      <label for="trap">Website</label>
      <input id="trap" name="honeypot_url" type="text" style="width:1px;height:1px" />
    </form>`;
}

function scan() {
  const root = greenhouseAdapter.resolveRoot(document)!;
  return { vendor: 'greenhouse' as const, root, fields: [...greenhouseAdapter.scan(root)] };
}

describe('one fill plan for profile fields and remembered answers', () => {
  it('carries both classes under a single fingerprint and writes them in one run', async () => {
    mountForm();
    const form = scan();
    const answers = [
      { questionId: 'qwhy', element: document.getElementById('why')!, value: 'Because the product is the job search I wanted.' },
      { questionId: 'qauth', element: document.getElementById('auth')!, value: 'Yes' },
    ];
    const profileOnly = buildApplyPlan(form, { firstName: 'Avery' });
    const plan = buildFillPlan(form, { firstName: 'Avery' }, answers);

    expect(plan.entries.map((entry) => entry.key)).toEqual([
      'firstName',
      'question:qwhy',
      'question:qauth',
    ]);
    // One plan means one fingerprint: the answers are not a second authority.
    expect(plan.fingerprint).not.toBe(profileOnly.fingerprint);
    expect(new Set(plan.entries.map(() => plan.fingerprint)).size).toBe(1);
    // A field the profile pass skipped for want of a value is now planned, not skipped twice.
    expect(plan.skipped.some((item) => item.element === document.getElementById('why'))).toBe(false);

    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(plan.entries.map((entry) => entry.kind))]),
      journal: createUndoJournal(),
      root: form.root,
      policy: testApplyPolicy(),
    });
    expect(summary.results.filter((result) => result.ok).map((result) => result.key)).toEqual([
      'firstName',
      'question:qwhy',
      'question:qauth',
    ]);
    expect((document.getElementById('first_name') as HTMLInputElement).value).toBe('Avery');
    expect((document.getElementById('auth') as HTMLSelectElement).value).toBe('1');
  });

  it('runs the guards before a remembered answer, exactly as the reviewed path does', () => {
    mountForm();
    const form = scan();
    const plan = buildFillPlan(form, { firstName: 'Avery' }, [
      { questionId: 'qpw', element: document.getElementById('pw')!, value: 'hunter2' },
      { questionId: 'qtrap', element: document.getElementById('trap')!, value: 'https://example.com' },
    ]);
    expect(plan.entries.some((entry) => entry.key.startsWith('question:'))).toBe(false);
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'question:qpw', reason: 'MANUAL_ONLY' }),
        expect.objectContaining({ key: 'question:qtrap', reason: 'HONEYPOT' }),
      ]),
    );
  });

  it('never lets a remembered answer overwrite a field the profile plan already owns', () => {
    mountForm();
    const form = scan();
    const plan = buildFillPlan(form, { firstName: 'Avery' }, [
      { questionId: 'qname', element: document.getElementById('first_name')!, value: 'Someone Else' },
    ]);
    expect(plan.entries.map((entry) => entry.key)).toEqual(['firstName']);
    expect(plan.entries[0]!.value).toBe('Avery');
  });

  it('with no remembered answers is the profile plan itself', () => {
    mountForm();
    const form = scan();
    const plan = buildFillPlan(form, { firstName: 'Avery' }, []);
    expect(plan.entries.map((entry) => entry.key)).toEqual(['firstName']);
  });
});

describe('question identity', () => {
  it('is the memory identity of the described question, not its scan order', () => {
    mountForm();
    const form = scan();
    const select = form.fields.find((field) => field.element.id === 'auth')!;
    const first = describeQuestion(select, 'q2')!;
    const second = describeQuestion(select, 'q7')!;
    expect(questionIdentity(first)).toEqual(questionIdentity(second));
    expect(questionIdentity(first)).toEqual({
      text: 'Are you legally authorized to work in the United States?',
      controlType: 'SINGLE_CHOICE',
      optionTexts: ['Yes', 'No'],
    });
  });
});
