// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { fillFromGesture } from '../lib/gestureFill';
import { createBundledApplyPolicy, type ApplyPolicy } from '@edaix/apply-kernel/policy';
import { captureTrustedShadowGesture } from '@edaix/apply-kernel/grant';
import { installBundledApplyAdapters } from '@edaix/apply-kernel/bundledAdapters';
import { readApplyForm } from '@edaix/apply-kernel/registry';

installBundledApplyAdapters();

/**
 * 代填条款、声明与签名（2026-09-23）——手势填写路上的两把钥匙。
 *
 * 生效策略里的 `sign-on-behalf`（运行时包放行）**且** worker 读到用户在资料页同意过当前版本（`signOnBehalf`；
 * 2026-09-28 起只有当前版本算数），条款框才会被勾上。少一把都不勾，条目也不会进这一轮的写入面。
 */
class TrustedClick extends MouseEvent { get isTrusted() { return true; } }

const TERMS = 'I have read and agree to the Terms of Use and Privacy Policy';

function page() {
  document.body.innerHTML = `<form id="application-form">
    <label for="first_name">First Name</label><input id="first_name" type="text" />
    <label for="consent">${TERMS}</label><input id="consent" name="consent" type="checkbox" />
  </form>`;
  const host = document.createElement('div');
  document.body.append(host);
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const button = document.createElement('button');
  shadowRoot.append(button);
  const descriptor = readApplyForm('greenhouse', document);
  expect(descriptor, '前置条件：适配器要认出这张表').not.toBeNull();
  return { shadowRoot, button, descriptor: descriptor! };
}

function livePolicy(signOnBehalf: boolean): ApplyPolicy {
  const base = createBundledApplyPolicy();
  return {
    ...base,
    notAfter: Date.now() + 60_000,
    capabilities: { ...base.capabilities, 'set-select': true, 'set-combobox': true, 'sign-on-behalf': signOnBehalf },
  };
}

async function fill(options: { policyOn: boolean; consent?: true }) {
  const { shadowRoot, button, descriptor } = page();
  let proof: ReturnType<typeof captureTrustedShadowGesture> = null;
  button.addEventListener('click', (event) => { proof = captureTrustedShadowGesture(event, shadowRoot); });
  button.dispatchEvent(new TrustedClick('click'));
  const result = await fillFromGesture({
    proof: proof as never,
    scan: { descriptor } as never,
    profile: { firstName: 'Taylor' } as never,
    policy: livePolicy(options.policyOn),
    progress: { onOutcome: vi.fn(), shouldStop: () => false } as never,
    ...(options.consent === true ? { signOnBehalf: true, signingDate: '2026-09-23' } : {}),
  });
  const consent = document.getElementById('consent') as HTMLInputElement;
  return { result, consent };
}

describe('两把钥匙都在才勾', () => {
  it('策略放行 + 用户同意过 → 条款框勾上', async () => {
    const { result, consent } = await fill({ policyOn: true, consent: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.outcomes).toContainEqual(expect.objectContaining({ key: 'termsConsent', ok: true }));
    expect(consent.checked).toBe(true);
  });

  it('策略放行，但用户没同意 → 不勾，也不进这一轮的写入', async () => {
    const { result, consent } = await fill({ policyOn: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.outcomes.some((outcome) => outcome.key === 'termsConsent')).toBe(false);
    expect(consent.checked).toBe(false);
  });

  it('用户同意过，但策略没放行 → 不勾', async () => {
    const { result, consent } = await fill({ policyOn: false, consent: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.outcomes.some((outcome) => outcome.key === 'termsConsent' && outcome.ok)).toBe(false);
    expect(consent.checked).toBe(false);
  });
});

/**
 * 第三刀（2026-09-24）：六类同意走同一对钥匙。条目键进写入面只在「策略放行 ∧ 用户同意过当前版本」时。
 */
describe('同意类：同样两把钥匙都在才勾', () => {
  const SMS = 'I agree to receive text messages from Acme about my application.';

  async function fillSms(options: { policyOn: boolean; consent?: true }) {
    document.body.innerHTML = `<form id="application-form">
      <label for="first_name">First Name</label><input id="first_name" type="text" />
      <label for="sms">${SMS}</label><input id="sms" name="sms" type="checkbox" />
    </form>`;
    const host = document.createElement('div');
    document.body.append(host);
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const button = document.createElement('button');
    shadowRoot.append(button);
    const descriptor = readApplyForm('greenhouse', document)!;
    let proof: ReturnType<typeof captureTrustedShadowGesture> = null;
    button.addEventListener('click', (event) => { proof = captureTrustedShadowGesture(event, shadowRoot); });
    button.dispatchEvent(new TrustedClick('click'));
    const result = await fillFromGesture({
      proof: proof as never,
      scan: { descriptor } as never,
      profile: { firstName: 'Taylor' } as never,
      policy: livePolicy(options.policyOn),
      progress: { onOutcome: vi.fn(), shouldStop: () => false } as never,
      ...(options.consent === true ? { signOnBehalf: true, signingDate: '2026-09-24' } : {}),
    });
    return { result, box: document.getElementById('sms') as HTMLInputElement };
  }

  it('策略放行 + 用户同意过 → 短信同意框勾上，条目键是 smsConsent', async () => {
    const { result, box } = await fillSms({ policyOn: true, consent: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.outcomes).toContainEqual(expect.objectContaining({ key: 'smsConsent', ok: true }));
    expect(box.checked).toBe(true);
  });

  it('用户没同意 → 不勾，也不进这一轮的写入', async () => {
    const { result, box } = await fillSms({ policyOn: true });
    if (result.ok) expect(result.outcomes.some((outcome) => outcome.key === 'smsConsent')).toBe(false);
    expect(box.checked).toBe(false);
  });

  it('策略没放行 → 不勾', async () => {
    const { result, box } = await fillSms({ policyOn: false, consent: true });
    if (result.ok) expect(result.outcomes.some((outcome) => outcome.key === 'smsConsent' && outcome.ok)).toBe(false);
    expect(box.checked).toBe(false);
  });
});

/**
 * 第五刀（2026-09-28）：新类别与旧类别一样，只在同意了当前版本时代填；能不能联系雇主按资料里的回答答，不看同意书。
 */
describe('第五刀：哪一版同意、资料里答了什么', () => {
  const CREDIT = 'I authorize Acme to obtain a credit report as part of my application.';
  const EMPLOYER = 'May we contact your current employer?';

  async function fillPage(options: { policyOn?: boolean; consent?: true; employerContact?: 'YES' | 'NO' }) {
    document.body.innerHTML = `<form id="application-form">
      <label for="first_name">First Name</label><input id="first_name" type="text" />
      <label for="credit">${CREDIT}</label><input id="credit" name="credit" type="checkbox" />
      <fieldset><legend>${EMPLOYER}</legend>
        <label for="ey">Yes</label><input id="ey" name="employer" type="radio" />
        <label for="en">No</label><input id="en" name="employer" type="radio" />
      </fieldset>
    </form>`;
    const host = document.createElement('div');
    document.body.append(host);
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const button = document.createElement('button');
    shadowRoot.append(button);
    const descriptor = readApplyForm('greenhouse', document)!;
    let proof: ReturnType<typeof captureTrustedShadowGesture> = null;
    button.addEventListener('click', (event) => { proof = captureTrustedShadowGesture(event, shadowRoot); });
    button.dispatchEvent(new TrustedClick('click'));
    const result = await fillFromGesture({
      proof: proof as never,
      scan: { descriptor } as never,
      profile: { firstName: 'Taylor' } as never,
      policy: livePolicy(options.policyOn ?? true),
      progress: { onOutcome: vi.fn(), shouldStop: () => false } as never,
      ...(options.consent === true ? { signOnBehalf: true, signingDate: '2026-09-28' } : {}),
      ...(options.employerContact === undefined ? {} : { employerContact: options.employerContact }),
    });
    return {
      result,
      credit: document.getElementById('credit') as HTMLInputElement,
      yes: document.getElementById('ey') as HTMLInputElement,
      no: document.getElementById('en') as HTMLInputElement,
    };
  }

  it('同意了当前版本：信用调查框勾上，条目键是 screeningConsent', async () => {
    const { result, credit } = await fillPage({ consent: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.outcomes).toContainEqual(expect.objectContaining({ key: 'screeningConsent', ok: true }));
    expect(credit.checked).toBe(true);
  });

  it('没同意当前版本（只同意过旧版本也一样，worker 不带同意）：信用调查框不勾，也不进这一轮的写入', async () => {
    const { result, credit } = await fillPage({});
    if (result.ok) expect(result.outcomes.some((outcome) => outcome.key === 'screeningConsent')).toBe(false);
    expect(credit.checked).toBe(false);
  });

  it('资料里答了「不可以」：没同意过代填授权也照答 No', async () => {
    const { result, yes, no, credit } = await fillPage({ employerContact: 'NO' });
    if (result.ok) expect(result.outcomes).toContainEqual(expect.objectContaining({ key: 'employerContactDeclined', ok: true }));
    expect([yes.checked, no.checked, credit.checked]).toEqual([false, true, false]);
  });

  it('资料里没答：联系雇主那一题交还本人', async () => {
    const { result, yes, no } = await fillPage({ consent: true });
    if (result.ok) expect(result.outcomes.some((outcome) => outcome.key.startsWith('employerContact'))).toBe(false);
    expect([yes.checked, no.checked]).toEqual([false, false]);
  });

  it('策略没放行：答了也不代填', async () => {
    const { yes, no, credit } = await fillPage({ policyOn: false, consent: true, employerContact: 'YES' });
    expect([yes.checked, no.checked, credit.checked]).toEqual([false, false, false]);
  });
});
