import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApplyPlan } from '../../src/engine';
import { AUTHORITY_TTL_MS, mintAuthority, type HostWriteAuthority } from '../../src/grant';
import { readApplyForm } from '../../src/registry';
import { runApplyPlan } from '../../src/runner';
import { createUndoJournal } from '../../src/undo';
import { testApplyPolicy } from '../helpers/applyTestAuthority';
import { installBundledApplyAdapters } from '../../src/bundledAdapters';

// 识别路径的适配器表生产由后端 release 装配；单测不连后端，装随包内置那份。
installBundledApplyAdapters();


afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function preparedPlan() {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="email">Email</label>
      <input id="email" name="job_application[email]" />
    </form>
  `;
  const form = readApplyForm('greenhouse');
  if (!form) throw new Error('Greenhouse fixture unexpectedly failed to scan');
  const input = document.querySelector<HTMLInputElement>('#email')!;
  return { input, root: form.root, plan: buildApplyPlan(form, { email: 'alex@example.test' }) };
}

function trustedClick(
  shadowRoot: ShadowRoot,
  composedPath: () => EventTarget[] = () => [shadowRoot, shadowRoot.host, document.body, document, window],
): Event {
  const event = new Event('click', { bubbles: true, composed: true });
  Object.defineProperty(event, 'isTrusted', { value: true });
  Object.defineProperty(event, 'composedPath', {
    value: composedPath,
  });
  return event;
}

function shadowRoot(): ShadowRoot {
  return document.createElement('div').attachShadow({ mode: 'open' });
}

function inputSetterCanary(input: HTMLInputElement) {
  const setter = vi.spyOn(HTMLInputElement.prototype, 'value', 'set');
  input.value = 's0-canary';
  expect(setter, 'input value setter 探针没有抓到 canary').toHaveBeenCalledTimes(1);
  input.value = '';
  setter.mockClear();
  return setter;
}

describe('S0 · apply cannot write without a valid grant', () => {
  it('rejects an untrusted synthetic click before any host write', async () => {
    const { input, root, plan } = preparedPlan();
    const shadow = shadowRoot();
    const synthetic = new Event('click', { bubbles: true, composed: true });
    expect(mintAuthority({ event: synthetic, shadowRoot: shadow, purpose: 'fill', fingerprint: plan.fingerprint })).toEqual({
      ok: false,
      code: 'GESTURE_UNTRUSTED',
    });
    const setter = inputSetterCanary(input);

    const run = await runApplyPlan({
      plan,
      auth: undefined as unknown as HostWriteAuthority,
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
    });

    expect(run.results[0]).toMatchObject({ ok: false, reason: 'GESTURE_UNTRUSTED' });
    expect(setter).not.toHaveBeenCalled();
  });

  it('rejects a trusted-looking click whose composed path is outside our ShadowRoot', async () => {
    const { input, root, plan } = preparedPlan();
    const shadow = shadowRoot();
    const foreign = trustedClick(shadow, () => [document.body, document, window]);
    expect(mintAuthority({ event: foreign, shadowRoot: shadow, purpose: 'fill', fingerprint: plan.fingerprint })).toEqual({
      ok: false,
      code: 'GESTURE_FOREIGN',
    });
    const setter = inputSetterCanary(input);

    const run = await runApplyPlan({
      plan,
      auth: undefined as unknown as HostWriteAuthority,
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
    });

    expect(run.results[0]).toMatchObject({ ok: false, reason: 'GESTURE_UNTRUSTED' });
    expect(setter).not.toHaveBeenCalled();
  });

  it('rejects an expired real grant before any host write', async () => {
    const { input, root, plan } = preparedPlan();
    const shadow = shadowRoot();
    const minted = mintAuthority({
      event: trustedClick(shadow),
      shadowRoot: shadow,
      purpose: 'fill',
      fingerprint: plan.fingerprint,
      now: Date.now() - AUTHORITY_TTL_MS - 1,
    });
    if (!minted.ok) throw new Error('test authority unexpectedly rejected');
    const setter = inputSetterCanary(input);

    const run = await runApplyPlan({
      plan,
      auth: minted.value,
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
    });

    expect(run.results[0]).toMatchObject({ ok: false, reason: 'GESTURE_EXPIRED' });
    expect(setter).not.toHaveBeenCalled();
  });

  it('does not let a consumed grant write a second time', async () => {
    const { input, root, plan } = preparedPlan();
    const shadow = shadowRoot();
    const minted = mintAuthority({ event: trustedClick(shadow), shadowRoot: shadow, purpose: 'fill', fingerprint: plan.fingerprint });
    if (!minted.ok) throw new Error('test authority unexpectedly rejected');
    const journal = createUndoJournal();
    await runApplyPlan({ plan, auth: minted.value, journal, root, policy: testApplyPolicy() });
    input.value = '';
    const setter = inputSetterCanary(input);

    const second = await runApplyPlan({ plan, auth: minted.value, journal, root, policy: testApplyPolicy() });

    expect(second.results[0]).toMatchObject({ ok: false, reason: 'GRANT_CONSUMED' });
    expect(setter).not.toHaveBeenCalled();
  });

  it('does not let a grant bound to another preview write', async () => {
    const { input, root, plan } = preparedPlan();
    const shadow = shadowRoot();
    const minted = mintAuthority({ event: trustedClick(shadow), shadowRoot: shadow, purpose: 'fill', fingerprint: 'other-preview' });
    if (!minted.ok) throw new Error('test authority unexpectedly rejected');
    const setter = inputSetterCanary(input);

    const run = await runApplyPlan({
      plan,
      auth: minted.value,
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
    });

    expect(run.results[0]).toMatchObject({ ok: false, reason: 'PLAN_STALE' });
    expect(setter).not.toHaveBeenCalled();
  });
});
