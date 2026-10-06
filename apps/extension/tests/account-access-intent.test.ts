import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_ACCESS_INTENT_KIND,
  createDockAccountAccessIntent,
  parseDockAccountAccessIntent,
  parseDockAccountAccessReply,
} from '../lib/accountAccessIntent';
import { PILOT_UA5_CONNECTED_PROTOCOL_VERSION } from '../lib/pilotUa5ConnectedProtocol';

/**
 * 浮层 ↔ worker 的招聘网站账号消息（2026-09-28）：精确键集，形状不对整条作废；页面只报 origin 与 pathname。
 */

const ORIGIN = 'https://tenant.wd5.myworkdayjobs.com';
const PATH = '/en-US/site/job/x/apply/applyManually';
const base = { kind: ACCOUNT_ACCESS_INTENT_KIND, version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION, origin: ORIGIN, pathname: PATH };

describe('请求', () => {
  it.each([
    { step: 'STATUS' },
    { step: 'CREDENTIAL' },
    { step: 'RECORD', outcome: 'CREATED' },
    { step: 'SITE_PASSWORD', password: 'Their-Own-9' },
    { step: 'SETTINGS_GET' },
    { step: 'SETTINGS_SET_EMAIL', email: 'jobs@example.test' },
    { step: 'SETTINGS_SET_EMAIL', email: null },
    { step: 'SETTINGS_SET_PASSWORD', password: 'Brand-New-Pass-7' },
    { step: 'REVEAL' },
  ] as const)('%o 收得下', (payload) => {
    expect(createDockAccountAccessIntent(ORIGIN, PATH, payload)).toEqual({ ...base, payload });
  });

  it.each([
    ['多一个键', { ...base, payload: { step: 'STATUS' }, extra: 1 }],
    ['payload 多一个键', { ...base, payload: { step: 'CREDENTIAL', email: 'x@y.z' } }],
    ['不认得的一步', { ...base, payload: { step: 'EXPORT_ALL' } }],
    ['RECORD 的结局不认得', { ...base, payload: { step: 'RECORD', outcome: 'LOGGED_OUT' } }],
    ['这一家的密码是空的', { ...base, payload: { step: 'SITE_PASSWORD', password: '' } }],
    ['这一家的密码带换行', { ...base, payload: { step: 'SITE_PASSWORD', password: 'a\nb' } }],
    ['邮箱形状不对', { ...base, payload: { step: 'SETTINGS_SET_EMAIL', email: 'not-an-email' } }],
    ['共用密码超长', { ...base, payload: { step: 'SETTINGS_SET_PASSWORD', password: 'A1!a'.repeat(20) } }],
    ['origin 不是 https', { ...base, origin: 'http://tenant.wd5.myworkdayjobs.com', payload: { step: 'STATUS' } }],
    ['版本不对', { ...base, version: 'v0', payload: { step: 'STATUS' } }],
  ])('%s → 整条作废', (_name, message) => {
    expect(parseDockAccountAccessIntent(message)).toBeNull();
  });

  it('单页应用改过地址：多带加载时的路径，照样收', () => {
    const parsed = parseDockAccountAccessIntent({ ...base, pathname: '/en-US/site/job/x/apply', documentPathname: PATH, payload: { step: 'STATUS' } });
    expect(parsed).toMatchObject({ pathname: '/en-US/site/job/x/apply', documentPathname: PATH });
  });
});

describe('答复', () => {
  it.each([
    { kind: 'ACCOUNT_STATUS', consent: true, enabled: false, known: true },
    { kind: 'ACCOUNT_CREDENTIAL', email: 'a@b.co', password: 'Pass-word-1', source: 'SHARED', generated: true, known: false },
    { kind: 'ACCOUNT_SETTINGS', email: null, defaultEmail: 'a@b.co', hasPassword: false, sites: 0 },
    { kind: 'ACCOUNT_PASSWORD', password: null },
    { kind: 'ACCOUNT_SAVED' },
    { kind: 'REFUSED', code: 'CONSENT_REQUIRED' },
  ])('%o 收得下', (reply) => {
    expect(parseDockAccountAccessReply(reply)).toEqual(reply);
  });

  it.each([
    ['多一个键', { kind: 'ACCOUNT_SAVED', password: 'x' }],
    ['密码不是字符串', { kind: 'ACCOUNT_CREDENTIAL', email: 'a@b.co', password: 1, source: 'SHARED', generated: true, known: false }],
    ['来源不认得', { kind: 'ACCOUNT_CREDENTIAL', email: 'a@b.co', password: 'p', source: 'SERVER', generated: true, known: false }],
    ['拒绝码不认得', { kind: 'REFUSED', code: 'TRY_HARDER' }],
    ['几家不是整数', { kind: 'ACCOUNT_SETTINGS', email: null, defaultEmail: null, hasPassword: false, sites: 1.5 }],
    ['不认得的种类', { kind: 'ACCOUNT_DUMP' }],
  ])('%s → null', (_name, reply) => {
    expect(parseDockAccountAccessReply(reply)).toBeNull();
  });
});
