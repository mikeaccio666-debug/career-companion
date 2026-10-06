import { describe, expect, it } from 'vitest';

import greenhouseRules from '@edaix/apply-rules/greenhouse.json';
import { parseVendorRuleset } from '../src/rules/schema';

/**
 * `accountSteps` 的形状校验（2026-09-28）。与别的已知结构同一个口径：条目里的陌生键、认不得的步骤或结局、缺了必填的
 * 那一项，整份拒收（旧内核看得见「接管」看不见「限制」的那类漂移，不能靠跳过一条来容忍）；顶层键本身在 2026-09-28
 * 之后的内核里是认得的（发布侧严格口径也收它）。
 */

const base = greenhouseRules as Record<string, unknown>;
const withAccount = (accountSteps: unknown) => parseVendorRuleset({ ...base, accountSteps }, { unknownTopLevelKeys: 'reject' });

const valid = {
  container: '.wall',
  steps: [
    { kind: 'choice', marker: '.choice', useEmail: '.use-email' },
    { kind: 'signIn', marker: '.sign-in', email: '.email', password: '.password', submit: '.submit', toCreateAccount: '.to-create' },
    {
      kind: 'createAccount', marker: '.create', email: '.email', password: '.password', verifyPassword: '.verify',
      terms: '.terms', submit: '.submit', toSignIn: '.to-sign-in',
    },
    { kind: 'identify', marker: '.identify', email: '.email', submit: '.next', terms: '.accept' },
  ],
  banners: '.wall [role="alert"]',
  outcomes: [
    { kind: 'accountExists', text: { source: 'already exists', flags: 'i' } },
    { kind: 'wrongPassword', text: { source: 'wrong password', flags: 'i' } },
    { kind: 'verifyEmail', text: { source: 'verify your email', flags: 'i' } },
    { kind: 'blocked', text: { source: 'locked', flags: 'i' } },
  ],
};

describe('accountSteps 的形状', () => {
  it('发布侧严格口径收下一份完整的声明', () => {
    const parsed = withAccount(valid);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.accountSteps?.steps.map((step) => step.kind)).toEqual(['choice', 'signIn', 'createAccount', 'identify']);
    expect(parsed.value.accountSteps?.path).toBeNull();
    expect(parsed.value.accountSteps?.outcomes).toHaveLength(4);
  });

  it('缺席与 null 同义：没有账号墙', () => {
    const parsed = parseVendorRuleset(base, { unknownTopLevelKeys: 'reject' });
    expect(parsed.ok && parsed.value.accountSteps).toBeNull();
    const explicit = withAccount(null);
    expect(explicit.ok && explicit.value.accountSteps).toBeNull();
  });

  it.each([
    ['认不得的步骤', { ...valid, steps: [{ kind: 'mfa', marker: '.x' }] }],
    ['同一种步骤写两条', { ...valid, steps: [valid.steps[0], valid.steps[0]] }],
    ['步骤缺必填（登录没有密码）', { ...valid, steps: [{ kind: 'signIn', marker: '.x', email: '.e', submit: '.s' }] }],
    ['步骤多写一个不属于它的键（选择那一步写了密码）', { ...valid, steps: [{ kind: 'choice', marker: '.x', useEmail: '.u', password: '.p' }] }],
    ['条目里的陌生键', { ...valid, steps: [{ ...valid.steps[0], captcha: '.c' }] }],
    ['空的选择器', { ...valid, steps: [{ kind: 'choice', marker: '', useEmail: '.u' }] }],
    ['没有步骤', { ...valid, steps: [] }],
    ['认不得的结局', { ...valid, outcomes: [{ kind: 'twoFactor', text: { source: 'code' } }] }],
    ['同一种结局写两条', { ...valid, outcomes: [valid.outcomes[0], valid.outcomes[0]] }],
    ['有结局却没说网站在哪儿说话', { ...valid, banners: undefined }],
    ['结局的正则带了被禁的 flags', { ...valid, outcomes: [{ kind: 'blocked', text: { source: 'x', flags: 'g' } }] }],
    ['顶层多一个键', { ...valid, secret: 'x' }],
    ['没有容器', { ...valid, container: undefined }],
  ])('%s → 整份拒收', (_why, accountSteps) => {
    expect(withAccount(accountSteps).ok).toBe(false);
  });

  it('可选的 path 按正则全量校验', () => {
    expect(withAccount({ ...valid, path: { source: '^\\/jobs\\/login\\/?$' } }).ok).toBe(true);
    expect(withAccount({ ...valid, path: { source: '(' } }).ok).toBe(false);
  });

  it('$comment 键照旧只是随行注释', () => {
    expect(withAccount({ ...valid, $comment: 'x', steps: [{ ...valid.steps[0], $comment: 'y' }] }).ok).toBe(true);
  });
});
