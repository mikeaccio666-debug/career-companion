import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import icimsRules from '@edaix/apply-rules/icims.json';
import workdayRules from '@edaix/apply-rules/workday.json';
import { fillAccountFields, pressAccountControl, tickAccountTerms } from '../src/accountAccess';
import type { AccountWallStep } from '../src/contracts';
import { resolveAuthorizedAccountGate, resolveAuthorizedApplyGate } from '../src/gate/resolve';
import {
  GESTURE_PROOF_TTL_MS,
  advanceRunState,
  beginAdvanceRunStep,
  captureTrustedShadowGesture,
  checkActiveCapability,
  completeAccountRunStep,
  completeAdvanceRunStep,
  consumeAuthority,
  endAdvanceRun,
  mintAccountAccessAuthority,
  mintAuthorityFromGesture,
  openAdvanceRun,
  rebindAfterAccount,
  type TrustedGestureProof,
} from '../src/grant';
import { createBundledApplyPolicy, type ApplyPolicy } from '../src/policy';
import { compileBundledAdapter } from '../src/rules/interpreter';

/**
 * 账号墙上动手的那几下（2026-09-28）。锁的是：票只从专用路径来、票上只有 `account-access`；策略位关着一下都不做；
 * 这一步不再是那一步就不做；写完读回；按的方式是原生激活、走网站自己的处理，我们自己从不调 form 的 submit／requestSubmit；
 * 账号墙之后连填那一轮只许换一次路径。
 */

const fixture = (name: string): string => readFileSync(resolve(__dirname, 'fixtures', name), 'utf8');
const workday = compileBundledAdapter(workdayRules);
const icims = compileBundledAdapter(icimsRules);
const visible = (): boolean => true;
const EMAIL = 'candidate@example.test';
const PASSWORD = 'Tr1ck-y!Horse#42';

function trustedProof(now = Date.now()): TrustedGestureProof {
  const host = document.createElement('div');
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const event = new Event('click', { bubbles: true, composed: true });
  Object.defineProperty(event, 'isTrusted', { value: true });
  Object.defineProperty(event, 'composedPath', { value: () => [shadowRoot, host, document.body, document, window] });
  const proof = captureTrustedShadowGesture(event, shadowRoot, now);
  if (proof === null) throw new Error('test proof rejected');
  return proof;
}

function policy(accountAccess = true): ApplyPolicy {
  const bundled = createBundledApplyPolicy(Date.now());
  return { ...bundled, capabilities: { ...bundled.capabilities, 'account-access': accountAccess } };
}

function mountWall(name: string, adapter = workday): AccountWallStep {
  document.body.innerHTML = fixture(name);
  const step = adapter.resolveAccountWall!(document);
  if (step === null) throw new Error(`${name}: no account wall`);
  return step;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('票', () => {
  it('通用铸造永远删掉 account-access；专用票上只有它', () => {
    const generic = mintAuthorityFromGesture({ proof: trustedProof(), purpose: 'fill', fingerprint: null, capabilities: new Set(['set-text', 'account-access']) });
    expect(generic.ok).toBe(true);
    if (!generic.ok) return;
    const active = consumeAuthority(generic.value);
    expect(active.ok && checkActiveCapability(active.value, 'account-access')).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });

    const account = mintAccountAccessAuthority({ proof: trustedProof() });
    expect(account.ok).toBe(true);
    if (!account.ok) return;
    const consumed = consumeAuthority(account.value);
    expect(consumed.ok && checkActiveCapability(consumed.value, 'account-access')).toEqual({ ok: true, value: undefined });
    expect(consumed.ok && checkActiveCapability(consumed.value, 'set-text')).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
  });

  it('伪造的凭证、过期的点击都铸不出来', () => {
    expect(mintAccountAccessAuthority({ proof: { capturedAt: Date.now() } as unknown as TrustedGestureProof })).toEqual({ ok: false, code: 'GESTURE_UNTRUSTED' });
    const old = trustedProof(Date.now() - GESTURE_PROOF_TTL_MS - 1);
    expect(mintAccountAccessAuthority({ proof: old })).toEqual({ ok: false, code: 'GESTURE_EXPIRED' });
  });
});

describe('写那几格', () => {
  it('注册：邮箱、密码、再输一次，写完读回；每一格都发 input/change/blur/focusout', () => {
    const step = mountWall('workday/account-create.html');
    const seen: string[] = [];
    for (const type of ['input', 'change', 'blur', 'focusout']) {
      step.fields.password!.addEventListener(type, () => seen.push(type));
    }
    expect(fillAccountFields({ step, proof: trustedProof(), policy: policy(), email: EMAIL, password: PASSWORD })).toEqual({ ok: true, value: undefined });
    expect(step.fields.email!.value).toBe(EMAIL);
    expect(step.fields.password!.value).toBe(PASSWORD);
    expect(step.fields.verifyPassword!.value).toBe(PASSWORD);
    expect(seen).toEqual(['input', 'change', 'blur', 'focusout']);
    // 蜜罐一个字都没写。
    expect((document.querySelector('[data-automation-id="beecatcher"]') as HTMLInputElement).value).toBe('');
  });

  it('iCIMS 先报邮箱那一步只写邮箱', () => {
    const step = mountWall('icims/account-email.html', icims);
    expect(fillAccountFields({ step, proof: trustedProof(), policy: policy(), email: EMAIL, password: PASSWORD }).ok).toBe(true);
    expect(step.fields.email!.value).toBe(EMAIL);
    expect([...document.querySelectorAll('input[type="password"]')]).toEqual([]);
  });

  it('远程策略的 account-access 关着：一格都不写', () => {
    const step = mountWall('workday/account-sign-in.html');
    expect(fillAccountFields({ step, proof: trustedProof(), policy: policy(false), email: EMAIL, password: PASSWORD }))
      .toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    expect(step.fields.email!.value).toBe('');
    expect(step.fields.password!.value).toBe('');
  });

  it('策略整体关着：一格都不写', () => {
    const step = mountWall('workday/account-sign-in.html');
    expect(fillAccountFields({ step, proof: trustedProof(), policy: { ...policy(), enabled: false }, email: EMAIL, password: PASSWORD }))
      .toEqual({ ok: false, code: 'POLICY_DISABLED' });
    expect(step.fields.password!.value).toBe('');
  });

  it('这一步已经不是那一步（网站换了视图）：一格都不写', () => {
    const step = mountWall('workday/account-sign-in.html');
    document.body.innerHTML = fixture('workday/account-create.html');
    expect(fillAccountFields({ step, proof: trustedProof(), policy: policy(), email: EMAIL, password: PASSWORD }))
      .toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
    expect([...document.querySelectorAll<HTMLInputElement>('input[type="text"], input[type="password"]')].every((input) => input.value === '')).toBe(true);
  });

  it('「选怎么登录」那一步没有格可写', () => {
    const step = mountWall('workday/account-choice.html');
    expect(fillAccountFields({ step, proof: trustedProof(), policy: policy(), email: EMAIL, password: PASSWORD }))
      .toEqual({ ok: false, code: 'TARGET_NOT_WRITABLE' });
  });

  it('网站把值改掉了：报 WRITE_REVERTED，不往下写', () => {
    const step = mountWall('workday/account-sign-in.html');
    step.fields.email!.addEventListener('input', () => { step.fields.email!.value = 'x'; });
    expect(fillAccountFields({ step, proof: trustedProof(), policy: policy(), email: EMAIL, password: PASSWORD }))
      .toEqual({ ok: false, code: 'WRITE_REVERTED' });
    expect(step.fields.password!.value).toBe('');
  });
});

describe('勾注册条款', () => {
  it('原生点击勾上；已经勾着就不动；没有这一格就是 NONE', () => {
    const step = mountWall('workday/account-create.html');
    expect(tickAccountTerms({ step, proof: trustedProof(), policy: policy(), isVisible: visible })).toEqual({ ok: true, value: 'TICKED' });
    expect((step.controls.terms as HTMLInputElement).checked).toBe(true);
    expect(tickAccountTerms({ step, proof: trustedProof(), policy: policy(), isVisible: visible })).toEqual({ ok: true, value: 'ALREADY' });
    const signIn = mountWall('workday/account-sign-in.html');
    expect(tickAccountTerms({ step: signIn, proof: trustedProof(), policy: policy(), isVisible: visible })).toEqual({ ok: true, value: 'NONE' });
  });

  it('条款的字里掺了营销订阅：不勾，交还本人', () => {
    document.body.innerHTML = fixture('workday/account-create.html');
    document.querySelector('label[for="input-19"]')!.textContent = 'I agree and subscribe me to marketing emails';
    const step = workday.resolveAccountWall!(document)!;
    expect(tickAccountTerms({ step, proof: trustedProof(), policy: policy(), isVisible: visible })).toEqual({ ok: false, code: 'CLICK_DENIED' });
    expect((step.controls.terms as HTMLInputElement).checked).toBe(false);
  });

  it('看不见的条款框不点', () => {
    const step = mountWall('workday/account-create.html');
    expect(tickAccountTerms({ step, proof: trustedProof(), policy: policy(), isVisible: () => false })).toEqual({ ok: false, code: 'CLICK_DENIED' });
    expect((step.controls.terms as HTMLInputElement).checked).toBe(false);
  });
});

describe('按那几颗', () => {
  it('Workday 的提交：点的是罩在上面的那一层，原生激活；我们自己从不调 submit／requestSubmit', () => {
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => undefined);
    const requestSubmit = vi.spyOn(HTMLFormElement.prototype, 'requestSubmit').mockImplementation(() => undefined);
    const step = mountWall('workday/account-sign-in.html');
    const clicked = vi.fn();
    step.controls.submit!.addEventListener('click', clicked);
    expect(pressAccountControl({ step, role: 'submit', proof: trustedProof(), policy: policy(), isVisible: visible })).toEqual({ ok: true, value: undefined });
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it('「用邮箱登录」与两个切换：点的就是规则声明的那一颗', () => {
    const choice = mountWall('workday/account-choice.html');
    const google = vi.fn();
    document.querySelector('[data-automation-id="GoogleSignInButton"]')!.addEventListener('click', google);
    const email = vi.fn();
    choice.controls.useEmail!.addEventListener('click', email);
    expect(pressAccountControl({ step: choice, role: 'useEmail', proof: trustedProof(), policy: policy(), isVisible: visible }).ok).toBe(true);
    expect(email).toHaveBeenCalledTimes(1);
    expect(google).not.toHaveBeenCalled();

    const signIn = mountWall('workday/account-sign-in.html');
    expect(pressAccountControl({ step: signIn, role: 'toCreateAccount', proof: trustedProof(), policy: policy(), isVisible: visible }).ok).toBe(true);
    expect(pressAccountControl({ step: signIn, role: 'toSignIn', proof: trustedProof(), policy: policy(), isVisible: visible }))
      .toEqual({ ok: false, code: 'TARGET_NOT_WRITABLE' });
  });

  it('远程策略关着、这一步不再是那一步：一下都不按', () => {
    const step = mountWall('workday/account-sign-in.html');
    const clicked = vi.fn();
    step.controls.submit!.addEventListener('click', clicked);
    expect(pressAccountControl({ step, role: 'submit', proof: trustedProof(), policy: policy(false), isVisible: visible }))
      .toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    step.fields.email!.replaceWith(step.fields.email!.cloneNode(true));
    expect(pressAccountControl({ step, role: 'submit', proof: trustedProof(), policy: policy(), isVisible: visible }))
      .toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
    expect(clicked).not.toHaveBeenCalled();
  });

  it('提交落进了验证码的容器：不按（人机验证由本人完成）', () => {
    document.body.innerHTML = fixture('workday/account-sign-in.html');
    document.querySelector('[data-automation-id="noCaptchaWrapper"]')!.classList.add('captcha-shell');
    const step = workday.resolveAccountWall!(document)!;
    const clicked = vi.fn();
    step.controls.submit!.addEventListener('click', clicked);
    expect(pressAccountControl({ step, role: 'submit', proof: trustedProof(), policy: policy(), isVisible: visible }))
      .toEqual({ ok: false, code: 'CLICK_DENIED' });
    expect(clicked).not.toHaveBeenCalled();
  });

  it('iCIMS：勾上「I accept」之前「Next」是禁用的，不按；网站放开之后按下去，网站自己的 submit 监听收到', () => {
    const step = mountWall('icims/account-email.html', icims);
    const next = step.controls.submit as HTMLInputElement;
    const terms = step.controls.terms as HTMLInputElement;
    // 网站自己的脚本：勾上才放开「Next」；提交先拦下来跑隐形人机验证。
    terms.addEventListener('change', () => { next.disabled = !terms.checked; });
    const submitted = vi.fn((event: Event) => event.preventDefault());
    document.querySelector('form')!.addEventListener('submit', submitted);
    expect(pressAccountControl({ step, role: 'submit', proof: trustedProof(), policy: policy(), isVisible: visible }))
      .toEqual({ ok: false, code: 'CLICK_DENIED' });
    expect(submitted).not.toHaveBeenCalled();
    expect(tickAccountTerms({ step, proof: trustedProof(), policy: policy(), isVisible: visible })).toEqual({ ok: true, value: 'TICKED' });
    expect(next.disabled).toBe(false);
    expect(pressAccountControl({ step, role: 'submit', proof: trustedProof(), policy: policy(), isVisible: visible }).ok).toBe(true);
    expect(submitted).toHaveBeenCalledTimes(1);
  });
});

describe('账号墙之后的第一页：只许换一次路径', () => {
  const scope = { origin: 'https://tenant.wd5.myworkdayjobs.com', pathname: '/en-US/site/job/x/apply/applyManually', vendor: 'workday' };
  const moved = { ...scope, pathname: '/en-US/site/job/x/apply' };
  /** 开一轮、账号墙那一步完成：交回这一轮与账号墙之后发的那一页。 */
  const afterWall = () => {
    const opened = openAdvanceRun({ proof: trustedProof(), scope });
    if (!opened.ok) throw new Error('run');
    const step = beginAdvanceRunStep(opened.value.run, scope);
    if (!step.ok) throw new Error('step');
    const page = completeAccountRunStep(step.value);
    if (!page.ok) throw new Error('page');
    return { run: opened.value.run, first: opened.value.page, page: page.value };
  };

  it('Workday 建草稿（…/applyManually → …/apply）：那一页可以跟着换一次；之后照旧一换就停', () => {
    const { run, page } = afterWall();
    expect(advanceRunState(run, moved)).toEqual({ ok: false, code: 'RUN_SCOPE_CHANGED' });
    expect(rebindAfterAccount(page, moved)).toEqual({ ok: true, value: true });
    expect(advanceRunState(run, moved).ok).toBe(true);
    expect(advanceRunState(run, scope)).toEqual({ ok: false, code: 'RUN_SCOPE_CHANGED' });
    // 第二次换：不许。
    expect(rebindAfterAccount(page, { ...scope, pathname: '/elsewhere' })).toEqual({ ok: false, code: 'RUN_SCOPE_CHANGED' });
  });

  it('只有账号墙之后发的那一页能换：一轮的第一页、连填翻到的页都不行', () => {
    const opened = openAdvanceRun({ proof: trustedProof(), scope });
    if (!opened.ok) throw new Error('run');
    expect(rebindAfterAccount(opened.value.page, moved)).toEqual({ ok: false, code: 'RUN_SCOPE_CHANGED' });
    const step = beginAdvanceRunStep(opened.value.run, scope);
    if (!step.ok) throw new Error('step');
    const next = completeAdvanceRunStep(step.value);
    if (!next.ok) throw new Error('next');
    expect(rebindAfterAccount(next.value, moved)).toEqual({ ok: false, code: 'RUN_SCOPE_CHANGED' });
  });

  it('那一页已经不是这一轮的当前页（连填又往下翻了）：不许', () => {
    const { run, page } = afterWall();
    const step = beginAdvanceRunStep(run, scope);
    if (!step.ok) throw new Error('step');
    expect(completeAdvanceRunStep(step.value).ok).toBe(true);
    expect(rebindAfterAccount(page, moved)).toEqual({ ok: false, code: 'RUN_SCOPE_CHANGED' });
  });

  it('换源、换厂商：不许；这一轮收场了：不许', () => {
    for (const other of [{ ...moved, origin: 'https://evil.example' }, { ...moved, vendor: 'icims' }]) {
      const { page } = afterWall();
      expect(rebindAfterAccount(page, other)).toEqual({ ok: false, code: 'RUN_SCOPE_CHANGED' });
    }
    const { run, page } = afterWall();
    endAdvanceRun(run);
    expect(rebindAfterAccount(page, moved)).toEqual({ ok: false, code: 'RUN_ENDED' });
  });
});

describe('账号墙那一路的门控', () => {
  it('密码页在这一路上不是拒绝理由；申请表那一路照旧拒它', () => {
    document.body.innerHTML = fixture('workday/account-sign-in.html');
    const input = { doc: document, hostname: 'tenant.wd5.myworkdayjobs.com', pathname: '/en-US/site/job/x/apply/applyManually', policy: createBundledApplyPolicy(), vendor: 'workday' as const, isTopFrame: true };
    expect(resolveAuthorizedAccountGate(input)).toEqual({ attach: true, vendor: 'workday', source: 'REMOTE_MAPPING' });
    expect(resolveAuthorizedApplyGate(input)).toEqual({ attach: false, reason: 'CREDENTIAL_PAGE', vendor: 'workday' });
  });

  it('挑战页、远程否决照旧拒', () => {
    document.body.innerHTML = '<div id="challenge-running"></div><input type="password">';
    const base = { doc: document, hostname: 'tenant.wd5.myworkdayjobs.com', pathname: '/x', policy: createBundledApplyPolicy(), vendor: 'workday' as const, isTopFrame: true };
    expect(resolveAuthorizedAccountGate(base)).toMatchObject({ attach: false, reason: 'CHALLENGE_PAGE' });
    const denied = { ...createBundledApplyPolicy(), deniedHostSuffixes: ['myworkdayjobs.com'] };
    expect(resolveAuthorizedAccountGate({ ...base, policy: denied }).attach).toBe(false);
  });
});
