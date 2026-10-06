import { describe, expect, it } from 'vitest';

import {
  GENERATED_PASSWORD_LENGTH,
  generateAccountPassword,
  isPlausibleEmail,
  isPlausibleSitePassword,
  sharedPasswordProblem,
} from '../lib/accountPassword';

/**
 * 招聘网站账号的密码（2026-09-28）。生成的那一条要合 Workday 注册页写明的要求（特殊字符、至少 8 位、数字、大写、小写）
 * 与 iCIMS 的常见要求；他自己设的共用密码按最严的那一家收；某一家自己的密码只挡明显不是密码的输入。
 */

const ALLOWED = /^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#$%*+\-=?@^_]+$/u;

describe('生成', () => {
  it('500 次：每一条都是 16 位、四类各至少两个、字母打头、没有连着三个一样的、只用好认好输的字', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      const password = generateAccountPassword();
      seen.add(password);
      expect(password).toHaveLength(GENERATED_PASSWORD_LENGTH);
      expect(password).toMatch(ALLOWED);
      expect(password).toMatch(/^[A-Za-z]/u);
      expect(password).not.toMatch(/(.)\1\1/u);
      expect(password.match(/[A-Z]/gu)?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(password.match(/[a-z]/gu)?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(password.match(/[0-9]/gu)?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(password.match(/[^A-Za-z0-9]/gu)?.length ?? 0).toBeGreaterThanOrEqual(2);
      // 也合他自己设密码时的那一把尺。
      expect(sharedPasswordProblem(password)).toBeNull();
    }
    expect(seen.size).toBe(500);
  });

  it('随机数只来自给的随机源（生产是 crypto.getRandomValues），取不偏的那一段', () => {
    let calls = 0;
    const counting = (values: Uint32Array): Uint32Array => {
      calls += 1;
      return globalThis.crypto.getRandomValues(values);
    };
    generateAccountPassword(counting);
    expect(calls).toBeGreaterThanOrEqual(GENERATED_PASSWORD_LENGTH);
  });
});

describe('他自己设的共用密码', () => {
  it.each([
    ['Sh0rt!pass', 'TOO_SHORT'],
    [`${'Aa1!'.repeat(16)}x`, 'TOO_LONG'],
    ['lowercase-only-1', 'NEEDS_UPPER'],
    ['UPPERCASE-ONLY-1', 'NEEDS_LOWER'],
    ['No-Digits-Here!', 'NEEDS_DIGIT'],
    ['NoSpecials12345', 'NEEDS_SPECIAL'],
    ['Has Space 123!', 'UNSUPPORTED_CHARACTER'],
    ['Ünïcode-Pass123', 'UNSUPPORTED_CHARACTER'],
  ])('%s → %s', (password, problem) => {
    expect(sharedPasswordProblem(password)).toBe(problem);
  });

  it('合要求 → null', () => {
    expect(sharedPasswordProblem('Good-Enough-42')).toBeNull();
  });
});

describe('某一家自己的密码与注册邮箱', () => {
  it('只挡空的、太长的、带控制字符的；别的由那一家自己判', () => {
    expect(isPlausibleSitePassword('abc')).toBe(true);
    expect(isPlausibleSitePassword('')).toBe(false);
    expect(isPlausibleSitePassword('x'.repeat(129))).toBe(false);
    expect(isPlausibleSitePassword('line\nbreak')).toBe(false);
  });

  it('邮箱只挡明显的手误', () => {
    expect(isPlausibleEmail('a@b.co')).toBe(true);
    expect(isPlausibleEmail('not-an-email')).toBe(false);
    expect(isPlausibleEmail('a b@c.d')).toBe(false);
  });
});
