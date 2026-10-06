import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import icimsRules from '@edaix/apply-rules/icims.json';
import workdayRules from '@edaix/apply-rules/workday.json';
import greenhouseRules from '@edaix/apply-rules/greenhouse.json';
import { compileBundledAdapter } from '../src/rules/interpreter';
import { parseVendorRuleset } from '../src/rules/schema';

/**
 * 账号墙（2026-09-28，负责人：像 Jobright 那样替用户在 Workday／iCIMS 上注册、登录）。
 *
 * 夹具是照 2026-09-28 只读实测的结构手写的（nvidia.wd5 的三个视图、careers-udhgroup.icims.com 的「先报邮箱」），
 * 只留结构与钩子。这里锁三件事：规则认得出每一步、交出去的元素是对的那几个、说不清的时候一律认不出。
 */

const fixture = (name: string): string => readFileSync(resolve(__dirname, 'fixtures', name), 'utf8');
const workday = compileBundledAdapter(workdayRules);
const icims = compileBundledAdapter(icimsRules);
const visible = (): boolean => true;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Workday 的三步各认各的', () => {
  it('「选怎么登录」：只交出「Sign in with email」那一颗，页头的 Sign In 不认', () => {
    document.body.innerHTML = fixture('workday/account-choice.html');
    const step = workday.resolveAccountWall!(document);
    expect(step?.kind).toBe('choice');
    expect(step?.controls.useEmail?.getAttribute('data-automation-id')).toBe('SignInWithEmailButton');
    expect(Object.keys(step!.fields)).toEqual([]);
    expect(Object.keys(step!.controls)).toEqual(['useEmail']);
    expect(step?.isCurrent()).toBe(true);
  });

  it('「用邮箱登录」：邮箱、密码、罩在提交上的那一层 click_filter、切到注册的那一颗', () => {
    document.body.innerHTML = fixture('workday/account-sign-in.html');
    const step = workday.resolveAccountWall!(document)!;
    expect(step.kind).toBe('signIn');
    expect(step.fields.email?.getAttribute('data-automation-id')).toBe('email');
    expect(step.fields.password?.type).toBe('password');
    expect(step.fields.verifyPassword).toBeUndefined();
    // 提交声明的是人点得到的那一层，不是 aria-hidden 的原生按钮。
    expect(step.controls.submit?.getAttribute('data-automation-id')).toBe('click_filter');
    expect(step.controls.submit?.getAttribute('role')).toBe('button');
    expect(step.controls.toCreateAccount?.getAttribute('data-automation-id')).toBe('createAccountLink');
    // 蜜罐在墙外面，一格都不是它。
    const all = [...Object.values(step.fields), ...Object.values(step.controls)];
    expect(all.some((element) => element?.getAttribute('data-automation-id') === 'beecatcher')).toBe(false);
  });

  it('「注册」：两个密码框、注册条款勾选框、提交、切到登录', () => {
    document.body.innerHTML = fixture('workday/account-create.html');
    const step = workday.resolveAccountWall!(document)!;
    expect(step.kind).toBe('createAccount');
    expect(step.fields.password?.getAttribute('autocomplete')).toBe('new-password');
    expect(step.fields.verifyPassword?.getAttribute('data-automation-id')).toBe('verifyPassword');
    expect(step.controls.terms?.getAttribute('data-automation-id')).toBe('createAccountCheckbox');
    expect(step.controls.submit?.getAttribute('aria-label')).toBe('Create Account');
    expect(step.controls.toSignIn?.getAttribute('data-automation-id')).toBe('signInLink');
  });

  it('申请表那一页（adobe.wd5 这类不用账号的）没有账号墙', () => {
    document.body.innerHTML = fixture('workday/my-information-step2.html');
    expect(workday.resolveAccountWall!(document)).toBeNull();
  });

  it('isCurrent：网站换了视图（登录 → 注册）、控件被换掉，这一步就不再算数', () => {
    document.body.innerHTML = fixture('workday/account-sign-in.html');
    const step = workday.resolveAccountWall!(document)!;
    const email = step.fields.email!;
    const clone = email.cloneNode(true);
    email.replaceWith(clone);
    expect(step.isCurrent()).toBe(false);
    document.body.innerHTML = fixture('workday/account-create.html');
    expect(step.isCurrent()).toBe(false);
  });
});

describe('说不清就认不出（fail closed）', () => {
  it('两个账号墙容器：不猜是哪一个', () => {
    const one = fixture('workday/account-sign-in.html');
    document.body.innerHTML = one + one;
    expect(workday.resolveAccountWall!(document)).toBeNull();
  });

  it('密码栏不是 type=password：规则的形状对不上，整步不认', () => {
    document.body.innerHTML = fixture('workday/account-sign-in.html');
    document.querySelector('[data-automation-id="password"]')!.setAttribute('type', 'text');
    expect(workday.resolveAccountWall!(document)).toBeNull();
  });

  it('必填的提交不在：整步不认', () => {
    document.body.innerHTML = fixture('workday/account-sign-in.html');
    document.querySelector('[data-automation-id="click_filter"]')!.remove();
    expect(workday.resolveAccountWall!(document)).toBeNull();
  });

  it('可选的一项声明了、此刻不在（注册条款）：这一步照认，只是没有那一格', () => {
    document.body.innerHTML = fixture('workday/account-create.html');
    document.querySelector('[data-automation-id="createAccountCheckbox"]')!.remove();
    const step = workday.resolveAccountWall!(document)!;
    expect(step.kind).toBe('createAccount');
    expect(step.controls.terms).toBeUndefined();
  });

  it('可选的一项有两个：说不清是哪一个，整步不认', () => {
    document.body.innerHTML = fixture('workday/account-create.html');
    const link = document.querySelector('[data-automation-id="signInLink"]')!;
    link.after(link.cloneNode(true));
    expect(workday.resolveAccountWall!(document)).toBeNull();
  });

  it('没声明账号墙的厂商：四项都答「没有」', () => {
    const greenhouse = compileBundledAdapter(greenhouseRules);
    document.body.innerHTML = fixture('workday/account-sign-in.html');
    expect(greenhouse.declaresAccountSteps).toBe(false);
    expect(greenhouse.resolveAccountWall!(document)).toBeNull();
    expect(greenhouse.isAccountPath!('/jobs/1/x/login')).toBe(false);
    expect(greenhouse.readAccountOutcome!(document, visible)).toBeNull();
  });
});

describe('网站说了什么（横幅）', () => {
  const banner = (text: string, attrs = 'role="alert"'): void => {
    const wall = document.querySelector('[data-automation-id="signInContent"]')!;
    wall.insertAdjacentHTML('afterbegin', `<div ${attrs}>${text}</div>`);
  };

  it.each([
    ['An account with this email address already exists.', 'accountExists'],
    ['This email address is already in use.', 'accountExists'],
    ['Wrong email address or password.', 'wrongPassword'],
    ['The email or password you entered is incorrect.', 'wrongPassword'],
    ['Please verify your email address. We sent a verification link to your inbox.', 'verifyEmail'],
    ['Your account has not been verified yet.', 'verifyEmail'],
    ['Your account has been locked. Too many failed sign in attempts.', 'blocked'],
  ] as const)('「%s」→ %s', (text, kind) => {
    document.body.innerHTML = fixture('workday/account-sign-in.html');
    banner(text);
    expect(workday.readAccountOutcome!(document, visible)).toBe(kind);
  });

  it('Workday 的错误元素（data-automation-id 里带 error）也算横幅', () => {
    document.body.innerHTML = fixture('workday/account-create.html');
    banner('An account with this email address already exists.', 'data-automation-id="errorMessage"');
    expect(workday.readAccountOutcome!(document, visible)).toBe('accountExists');
  });

  it('有字但一种都认不出（某一格格式不对）：unrecognized，不是没说话', () => {
    document.body.innerHTML = fixture('workday/account-create.html');
    banner('Password must contain at least one special character.');
    expect(workday.readAccountOutcome!(document, visible)).toBe('unrecognized');
  });

  it('看不见的横幅不算；没有横幅就是 null', () => {
    document.body.innerHTML = fixture('workday/account-sign-in.html');
    expect(workday.readAccountOutcome!(document, visible)).toBeNull();
    banner('Wrong email address or password.');
    expect(workday.readAccountOutcome!(document, () => false)).toBeNull();
  });

  it('「Verify New Password」这种标签不在横幅里，不会被当成要验证邮箱', () => {
    document.body.innerHTML = fixture('workday/account-create.html');
    expect(workday.readAccountOutcome!(document, visible)).toBeNull();
  });
});

describe('iCIMS 的「先报邮箱」', () => {
  it('邮箱、「I accept」、「Next」；路径 /jobs/login 与 /jobs/<id>/<slug>/login 都是账号页', () => {
    document.body.innerHTML = fixture('icims/account-email.html');
    const step = icims.resolveAccountWall!(document)!;
    expect(step.kind).toBe('identify');
    expect(step.fields.email?.id).toBe('email');
    expect(step.fields.password).toBeUndefined();
    expect(step.controls.terms?.id).toBe('accept_gdpr');
    expect(step.controls.submit?.id).toBe('enterEmailSubmitButton');
    expect(icims.isAccountPath!('/jobs/login')).toBe(true);
    expect(icims.isAccountPath!('/jobs/4439/accounting-manager/login')).toBe(true);
    expect(icims.isAccountPath!('/jobs/4439/accounting-manager/candidate')).toBe(false);
    expect(icims.isAccountPath!('/jobs/4439/accounting-manager/job')).toBe(false);
  });

  it('页面自带的登录提示原文按规则认', () => {
    document.body.innerHTML = fixture('icims/account-email.html');
    const alert = document.querySelector('.alert-text')!;
    alert.textContent = 'Invalid login or password.';
    expect(icims.readAccountOutcome!(document, visible)).toBe('wrongPassword');
    alert.textContent = 'Your account has been disabled due to inactivity.';
    expect(icims.readAccountOutcome!(document, visible)).toBe('blocked');
  });
});

describe('纯加法：去掉 accountSteps，这份规则照旧是一份合法规则', () => {
  it.each([['workday', workdayRules], ['icims', icimsRules]] as const)('%s', (_vendor, rules) => {
    const { accountSteps: _removed, ['$comment.accountSteps']: _note, ...without } = rules as Record<string, unknown>;
    const parsed = parseVendorRuleset(without, { unknownTopLevelKeys: 'reject', unknownFieldKeys: 'reject' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.accountSteps).toBeNull();
  });
});
