import { afterEach, describe, expect, it } from 'vitest';
import { buildAnswerPlan, buildApplyPlan } from '../src/engine';
import { describeQuestion } from '../src/questions';
import { runApplyPlan } from '../src/runner';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import { createUndoJournal } from '../src/undo';
import { capabilitiesForKinds } from '../src/write/allowlist';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

/**
 * 档案计划跳过的题（开放题、看岗位的题）由用户在审阅面板里答；答案经
 * buildAnswerPlan 走同一条 runner 路。守卫照旧：密码不写，即使有答案。
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
    </form>`;
}

describe('reviewed answers for skipped questions', () => {
  it('describes skipped fields as questions and plans reviewed answers for them', async () => {
    mountForm();
    const root = greenhouseAdapter.resolveRoot(document)!;
    const fields = [...greenhouseAdapter.scan(root)];
    const profilePlan = buildApplyPlan({ vendor: 'greenhouse', root, fields }, { firstName: 'Avery' });
    const skipped = profilePlan.skipped.map((item) => item.element);
    expect(skipped).toEqual(expect.arrayContaining([document.getElementById('why'), document.getElementById('auth'), document.getElementById('pw')]));

    const questions = fields.map((field, index) => describeQuestion(field, `q${index}`));
    expect(questions.find((q) => q?.text.startsWith('Why'))).toMatchObject({ controlType: 'TEXTAREA', required: true, options: [] });
    expect(questions.find((q) => q?.text.startsWith('Are you'))).toMatchObject({
      controlType: 'SINGLE_CHOICE', options: [{ optionId: 'o0', text: 'Yes' }, { optionId: 'o1', text: 'No' }],
    });

    const plan = buildAnswerPlan({ vendor: 'greenhouse', root, fields }, [
      { questionId: 'why', element: document.getElementById('why')!, value: 'Because the product is the job search I wanted.' },
      { questionId: 'auth', element: document.getElementById('auth')!, value: 'Yes' },
      { questionId: 'pw', element: document.getElementById('pw')!, value: 'hunter2' },
    ]);
    expect(plan.entries.map((entry) => entry.key)).toEqual(['question:why', 'question:auth']);
    expect(plan.skipped).toEqual([expect.objectContaining({ key: 'question:pw', reason: 'MANUAL_ONLY' })]);

    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(plan.entries.map((entry) => entry.kind))]),
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
    });
    expect(summary.results.map((result) => [result.key, result.ok])).toEqual([['question:why', true], ['question:auth', true]]);
    expect((document.getElementById('why') as HTMLTextAreaElement).value).toBe('Because the product is the job search I wanted.');
    expect((document.getElementById('auth') as HTMLSelectElement).value).toBe('1');
    expect((document.getElementById('pw') as HTMLInputElement).value).toBe('');
  });
});
