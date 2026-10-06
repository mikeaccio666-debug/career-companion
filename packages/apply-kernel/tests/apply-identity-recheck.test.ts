import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { readApplyForm } from '../src/registry';
import { runApplyPlan } from '../src/runner';
import { createUndoJournal } from '../src/undo';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';
import { installBundledApplyAdapters } from '../src/bundledAdapters';

// 识别路径的适配器表生产由后端 release 装配；单测不连后端，装随包内置那份。
installBundledApplyAdapters();


afterEach(() => {
  document.body.innerHTML = '';
});

function greenhouseFields(): {
  readonly form: NonNullable<ReturnType<typeof readApplyForm>>;
  readonly firstName: HTMLInputElement;
  readonly lastName: HTMLInputElement;
  readonly email: HTMLInputElement;
} {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="first_name">First name</label>
      <input id="first_name" name="job_application[first_name]" />
      <label for="last_name">Last name</label>
      <input id="last_name" name="job_application[last_name]" />
      <label id="email-label" for="email">Email</label>
      <input id="email" name="job_application[email]" />
    </form>
  `;
  const form = readApplyForm('greenhouse');
  if (!form) throw new Error('Greenhouse fixture unexpectedly failed to scan');

  return {
    form,
    firstName: document.querySelector<HTMLInputElement>('#first_name')!,
    lastName: document.querySelector<HTMLInputElement>('#last_name')!,
    email: document.querySelector<HTMLInputElement>('#email')!,
  };
}

describe('C5 · apply field identity recheck', () => {
  // 2026-09-23 起不连坐：结构身份变了的那一栏一个字都不写，别的栏各自写前重验、照常写。
  // 从前这里把 email 连坐成 ABORTED——Greenhouse 上正是这样把排在最后的简历一起废掉的（0/4）。
  it('gives up only the structurally changed field; earlier and later verified work stays undoable', async () => {
    const { form, firstName, lastName, email } = greenhouseFields();
    const plan = buildApplyPlan(form, {
      firstName: 'Alex',
      lastName: 'Rivera',
      email: 'alex@example.test',
    });
    const journal = createUndoJournal();

    // The first host event models a framework changing the next question
    // after the candidate has already reviewed this exact preview.
    firstName.addEventListener('input', () => {
      lastName.setAttribute('name', 'job_application[answers_attributes][new_question]');
    }, { once: true });
    const lastNameEvents: string[] = [];
    lastName.addEventListener('input', () => lastNameEvents.push('input'));

    const run = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal,
      root: form.root,
      policy: testApplyPolicy(),
    });

    expect(run.results[0]).toMatchObject({ key: 'firstName', ok: true });
    expect(run.results[1]).toMatchObject({ key: 'lastName', ok: false, reason: 'IDENTITY_CHANGED' });
    expect(run.results[2]).toMatchObject({ key: 'email', ok: true });
    // 漂移不再是整轮中止，而是如实记数，调用方据此重扫。
    expect(run.abortedBy).toBeNull();
    expect(run.identityDrift).toBe(1);
    expect(run.filled).toBe(2);
    expect(firstName.value).toBe('Alex');
    // 身份变了的那一栏：零写入、零宿主事件。
    expect(lastName.value).toBe('');
    expect(lastNameEvents).toEqual([]);
    expect(email.value).toBe('alex@example.test');
    expect(journal.undoAll(testAuthority(null, 'undo'))).toMatchObject({ restored: 2, remaining: 0 });
    expect(firstName.value).toBe('');
    expect(email.value).toBe('');
  });

  it('treats label text as a diagnostic hint, not an identity blocker', async () => {
    const { form, email } = greenhouseFields();
    const plan = buildApplyPlan(form, { email: 'alex@example.test' });
    document.querySelector('#email-label')!.textContent = 'Email This field is required';

    const run = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal: createUndoJournal(),
      root: form.root,
      policy: testApplyPolicy(),
    });

    expect(run.results.find((result) => result.key === 'email')).toMatchObject({ ok: true });
    expect(run.labelHintDrifted).toBe(1);
    expect(email.value).toBe('alex@example.test');
  });

  it('rechecks the current value before recording an undo ticket or writing', async () => {
    const { form, email } = greenhouseFields();
    const plan = buildApplyPlan(form, { email: 'alex@example.test' });
    email.value = 'candidate@example.test';
    const hostEvents: string[] = [];
    email.addEventListener('input', () => hostEvents.push('input'));
    const journal = createUndoJournal();

    const run = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal,
      root: form.root,
      policy: testApplyPolicy(),
    });

    expect(run.results.find((result) => result.key === 'email')).toMatchObject({
      ok: false,
      reason: 'NOT_EMPTY',
    });
    expect(email.value).toBe('candidate@example.test');
    expect(hostEvents).toEqual([]);
    expect(journal.canUndo()).toBe(false);
  });

  it('fails closed when a reviewed field moves into the adapter exclusion zone', async () => {
    const { form, firstName, lastName, email } = greenhouseFields();
    const plan = buildApplyPlan(form, {
      firstName: 'Alex',
      lastName: 'Rivera',
      email: 'alex@example.test',
    });
    const footer = document.createElement('footer');
    firstName.replaceWith(footer);
    footer.appendChild(firstName);
    const hostInputEvents: string[] = [];
    firstName.addEventListener('input', () => hostInputEvents.push('input'));

    const run = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal: createUndoJournal(),
      root: form.root,
      policy: testApplyPolicy(),
    });

    // 挪进排除区的那一栏一个字都不写；没挪的两栏身份没变，照常写（不再连坐成 ABORTED）。
    expect(run.results).toEqual([
      expect.objectContaining({ key: 'firstName', ok: false, reason: 'IDENTITY_CHANGED' }),
      expect.objectContaining({ key: 'lastName', ok: true }),
      expect.objectContaining({ key: 'email', ok: true }),
    ]);
    expect(run.abortedBy).toBeNull();
    expect(run.identityDrift).toBe(1);
    expect(hostInputEvents).toEqual([]);
    expect(firstName.value).toBe('');
    expect(lastName.value).toBe('Rivera');
    expect(email.value).toBe('alex@example.test');
  });

  it('fails closed when a reviewed native select changes from single to multiple', async () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="city">City</label>
        <select id="city" name="job_application[city]">
          <option value="">Choose</option>
          <option value="us">United States</option>
        </select>
      </form>
    `;
    const form = readApplyForm('greenhouse');
    if (!form) throw new Error('Greenhouse fixture unexpectedly failed to scan');
    const city = document.querySelector<HTMLSelectElement>('#city')!;
    const plan = buildApplyPlan(form, { city: 'United States' });
    city.multiple = true;
    const hostInputEvents: string[] = [];
    city.addEventListener('input', () => hostInputEvents.push('input'));

    const run = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal: createUndoJournal(),
      root: form.root,
      policy: testApplyPolicy(),
    });

    expect(run.results).toEqual([
      expect.objectContaining({ key: 'city', ok: false, reason: 'IDENTITY_CHANGED' }),
    ]);
    expect(hostInputEvents).toEqual([]);
  });
});
