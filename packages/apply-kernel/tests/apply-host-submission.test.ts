import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { readApplyForm } from '../src/registry';
import { markSubmissionBlockedByAuthority, runApplyPlan } from '../src/runner';
import { createUndoJournal } from '../src/undo';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';
import { installBundledApplyAdapters } from '../src/bundledAdapters';

// 识别路径的适配器表生产由后端 release 装配；单测不连后端，装随包内置那份。
installBundledApplyAdapters();


afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function greenhouseFields(): {
  readonly form: NonNullable<ReturnType<typeof readApplyForm>>;
  readonly firstName: HTMLInputElement;
  readonly email: HTMLInputElement;
} {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="first_name">First name</label>
      <input id="first_name" name="job_application[first_name]" />
      <label for="email">Email</label>
      <input id="email" name="job_application[email]" />
    </form>
  `;
  const form = readApplyForm('greenhouse');
  if (!form) throw new Error('Greenhouse fixture unexpectedly failed to scan');

  return {
    form,
    firstName: document.querySelector<HTMLInputElement>('#first_name')!,
    email: document.querySelector<HTMLInputElement>('#email')!,
  };
}

describe('C5 · host submission watchdog', () => {
  it('does not report a submit already cancelled by an earlier authority gate', async () => {
    const { form, firstName, email } = greenhouseFields();
    const plan = buildApplyPlan(form, { firstName: 'Alex', email: 'alex@example.test' });
    const hostForm = document.querySelector('form')!;
    document.addEventListener('submit', (event) => {
      markSubmissionBlockedByAuthority(event);
      event.preventDefault();
    }, {
      capture: true,
      once: true,
    });
    firstName.addEventListener('input', () => {
      hostForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }, { once: true });

    const run = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal: createUndoJournal(),
      root: form.root,
      policy: testApplyPolicy(),
    });

    expect(run.abortedBy).toBeNull();
    expect(run.filled).toBe(2);
    expect(firstName.value).toBe('Alex');
    expect(email.value).toBe('alex@example.test');
  });

  it('treats an unbranded host-cancelled SPA submit as a real host submission', async () => {
    const { form, firstName, email } = greenhouseFields();
    const plan = buildApplyPlan(form, { firstName: 'Alex', email: 'alex@example.test' });
    const hostForm = document.querySelector('form')!;
    let hostSideEffect = false;
    document.addEventListener('submit', (event) => {
      event.preventDefault();
      hostSideEffect = true;
    }, { capture: true, once: true });
    firstName.addEventListener('input', () => {
      hostForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }, { once: true });

    const run = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal: createUndoJournal(),
      root: form.root,
      policy: testApplyPolicy(),
    });

    expect(hostSideEffect).toBe(true);
    expect(run.abortedBy).toBe('HOST_SUBMITTED');
    expect(email.value).toBe('');
  });

  it('observes a synchronous host submit without preventing it, then writes no later fields', async () => {
    const { form, firstName, email } = greenhouseFields();
    const plan = buildApplyPlan(form, { firstName: 'Alex', email: 'alex@example.test' });
    const hostSubmitEvents: Event[] = [];
    const emailInputEvents: string[] = [];
    const hostForm = document.querySelector('form')!;
    hostForm.addEventListener('submit', (event) => hostSubmitEvents.push(event));
    email.addEventListener('input', () => emailInputEvents.push('input'));
    firstName.addEventListener('input', () => {
      hostForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }, { once: true });

    const journal = createUndoJournal();
    const run = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal,
      root: form.root,
      policy: testApplyPolicy(),
    });

    expect(hostSubmitEvents).toHaveLength(1);
    expect(hostSubmitEvents[0]?.defaultPrevented).toBe(false);
    expect((run as typeof run & { abortedBy?: unknown }).abortedBy).toBe('HOST_SUBMITTED');
    expect(run.results).toEqual([
      expect.objectContaining({ key: 'firstName', ok: false, reason: 'HOST_SUBMITTED' }),
      expect.objectContaining({ key: 'email', ok: false, reason: 'HOST_SUBMITTED' }),
    ]);
    expect(firstName.value).toBe('Alex');
    expect(email.value).toBe('');
    expect(emailInputEvents).toEqual([]);
    expect(journal.canUndo()).toBe(false);
  });

  it('reports HOST_SUBMITTED when it follows an earlier identity stop during C6', async () => {
    const { form, firstName, email } = greenhouseFields();
    const plan = buildApplyPlan(form, { firstName: 'Alex', email: 'alex@example.test' });
    const hostForm = document.querySelector('form')!;
    firstName.addEventListener(
      'input',
      () => {
        email.setAttribute('name', 'job_application[answers_attributes][new_question]');
        queueMicrotask(() => hostForm.dispatchEvent(new Event('submit', { bubbles: true })));
      },
      { once: true },
    );

    const run = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal: createUndoJournal(),
      root: form.root,
      policy: testApplyPolicy(),
    });

    expect(run.abortedBy).toBe('HOST_SUBMITTED');
    expect(run.results).toEqual([
      expect.objectContaining({ key: 'firstName', ok: false, reason: 'HOST_SUBMITTED' }),
      expect.objectContaining({ key: 'email', ok: false, reason: 'IDENTITY_CHANGED' }),
    ]);
  });

  it('removes its submit and beforeunload observers after the run settles', async () => {
    const { form } = greenhouseFields();
    const plan = buildApplyPlan(form, { firstName: 'Alex' });
    const addDocumentListener = vi.spyOn(document, 'addEventListener');
    const removeDocumentListener = vi.spyOn(document, 'removeEventListener');
    const addWindowListener = vi.spyOn(window, 'addEventListener');
    const removeWindowListener = vi.spyOn(window, 'removeEventListener');

    await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal: createUndoJournal(),
      root: form.root,
      policy: testApplyPolicy(),
    });

    const submitHandler = addDocumentListener.mock.calls.find(([type]) => type === 'submit')?.[1];
    const beforeUnloadHandler = addWindowListener.mock.calls.find(([type]) => type === 'beforeunload')?.[1];
    if (!submitHandler || !beforeUnloadHandler) throw new Error('host submission observers were not installed');
    expect(removeDocumentListener).toHaveBeenCalledWith('submit', submitHandler, true);
    expect(removeWindowListener).toHaveBeenCalledWith('beforeunload', beforeUnloadHandler, true);
  });

  it('stops immediately when a host cancels beforeunload during C6 verification', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { form } = greenhouseFields();
    const plan = buildApplyPlan(form, { firstName: 'Alex', email: 'alex@example.test' });
    const journal = createUndoJournal();
    window.addEventListener('beforeunload', (event) => event.preventDefault(), {
      capture: true,
      once: true,
    });
    const pending = runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal,
      root: form.root,
      policy: testApplyPolicy(),
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await Promise.resolve();
    const beforeUnload = new Event('beforeunload', { cancelable: true });
    expect(window.dispatchEvent(beforeUnload)).toBe(false);
    expect(beforeUnload.defaultPrevented).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(true);
    await expect(pending).resolves.toMatchObject({
      abortedBy: 'HOST_SUBMITTED',
      filled: 0,
      failed: 2,
    });
    await expect(pending).resolves.toMatchObject({
      results: [
        { key: 'firstName', ok: false, reason: 'HOST_SUBMITTED' },
        { key: 'email', ok: false, reason: 'HOST_SUBMITTED' },
      ],
    });
    expect(journal.canUndo()).toBe(false);
  });
});
