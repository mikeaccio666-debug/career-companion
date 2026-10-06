import { APPLICATION_SIGNING_CONSENT_VERSION } from '@edaix/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createSigningConsentProvider, signingConsentCoversAccountRegistration } from '../lib/signingConsentProvider';

/**
 * worker 侧：用户在资料页单独勾过的「代填授权」同意（2026-09-23；2026-09-28 起勾选框是一句话，范围写在隐私政策里版本号
 * 相同的那一节）。只有当前版本算数：同意过旧版本的按没同意处理。另答要不要请他一键同意：没同意当前版本、也没撤回过。
 * 任何一样读不出都是「没同意、也不请」（fail closed），诊断只记码。
 */
const USER = '76000000-0000-4000-8000-000000000001';

const body = (over: Record<string, unknown> = {}) => JSON.stringify({
  schemaVersion: 1,
  consent: {
    purpose: 'application-signing',
    policyVersion: APPLICATION_SIGNING_CONSENT_VERSION,
    granted: true,
    grantedAt: '2026-09-28T08:00:00.000Z',
    revoked: false,
    ...over,
  },
});

function harness(over: { run?: () => Promise<unknown>; userId?: string | null } = {}) {
  const diagnostics: string[] = [];
  const run = vi.fn(over.run ?? (async () => ({ ok: true, text: body() })));
  const provider = createSigningConsentProvider({
    directory: { run: run as never },
    getUserId: async () => (over.userId === undefined ? USER : over.userId),
    onDiagnostic: (code, detail) => { diagnostics.push(detail === undefined ? code : `${code} ${JSON.stringify(detail)}`); },
  });
  return { provider, run, diagnostics };
}

const NONE = { granted: false, reconsent: false };
const notGranted = (over: Record<string, unknown> = {}) => body({ granted: false, grantedAt: null, ...over });

describe('读用户在资料页的代填同意', () => {
  it('这版插件显示的是 2026-09-28 那一版（勾选框一句话，范围在隐私政策里）', () => {
    expect(APPLICATION_SIGNING_CONSENT_VERSION).toBe('application-signing-2026-09-28');
  });

  it('同意过当前版本 → 同意着，不用再问；走 SIGNING_CONSENT_READ', async () => {
    const { provider, run, diagnostics } = harness();
    expect(await provider.read()).toEqual({ granted: true, reconsent: false });
    expect(run).toHaveBeenCalledWith('SIGNING_CONSENT_READ');
    expect(diagnostics).toEqual([]);
  });

  it('没同意当前版本（从没同意过，或只同意过旧版本：服务端都答 granted false）、也没撤回过 → 不代填，请他一键同意', async () => {
    const { provider, diagnostics } = harness({ run: async () => ({ ok: true, text: notGranted() }) });
    expect(await provider.read()).toEqual({ granted: false, reconsent: true });
    expect(diagnostics).toEqual([]);
  });

  it('撤回过 → 不代填，也不再问：那是他的决定，不是故障', async () => {
    const { provider, diagnostics } = harness({ run: async () => ({ ok: true, text: notGranted({ revoked: true }) }) });
    expect(await provider.read()).toEqual(NONE);
    expect(diagnostics).toEqual([]);
  });

  it('每次都现读，不缓存：刚同意着、随即撤回，下一次读就是撤回（2026-10-03 体检 P0-1：撤回即失效）', async () => {
    const answers = [body(), notGranted({ revoked: true })];
    const { provider, run } = harness({ run: async () => ({ ok: true, text: answers.shift() }) });
    expect(await provider.read()).toEqual({ granted: true, reconsent: false });
    expect(await provider.read()).toEqual(NONE);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('服务端要的是别的文案版本（老服务端还在 09-24，或更新的一版）→ 当没同意，也不问（这版插件显示不了那一版）', async () => {
    for (const version of ['application-signing-2026-09-24', 'application-signing-2099-01-01']) {
      const { provider, diagnostics } = harness({ run: async () => ({ ok: true, text: body({ policyVersion: version }) }) });
      expect(await provider.read()).toEqual(NONE);
      expect(diagnostics).toEqual(['SIGNING_CONSENT_VERSION_MISMATCH']);
    }
  });

  it('老服务端不发 revoked → 读成没撤回', async () => {
    const legacy = JSON.stringify({
      schemaVersion: 1,
      consent: { purpose: 'application-signing', policyVersion: APPLICATION_SIGNING_CONSENT_VERSION, granted: false, grantedAt: null },
    });
    expect(await harness({ run: async () => ({ ok: true, text: legacy }) }).provider.read()).toEqual({ granted: false, reconsent: true });
  });

  /**
   * 后端先发的加法（2026-09-28 核对，#129 钉住；这条读法从一开始就是这样）：应答里多出来的成员不拒、不解释。
   * 同意的**意思**只由文案版本号定——任何改变意思的东西（按类别撤回、限定范围……）都必须升版本号，旧包见到
   * 新版本号一律当没同意；不升版本号、只加一个字段去收窄同意，旧包是看不见的。
   */
  it('应答里多出来的成员不拒、不解释；是不是同意只看版本号与 granted', async () => {
    const withExtras = (consentExtras: Record<string, unknown>) => JSON.stringify({
      schemaVersion: 1,
      requestId: 'r-1',
      consent: { ...(JSON.parse(body()) as { consent: Record<string, unknown> }).consent, ...consentExtras },
    });
    const extra = harness({ run: async () => ({ ok: true, text: withExtras({ source: 'PORTAL', categories: ['TERMS', 'SMS'] }) }) });
    expect(await extra.provider.read()).toEqual({ granted: true, reconsent: false });
    expect(extra.diagnostics).toEqual([]);
    const newer = harness({ run: async () => ({ ok: true, text: withExtras({ policyVersion: 'application-signing-2026-10-15', categories: ['TERMS'] }) }) });
    expect(await newer.provider.read()).toEqual(NONE);
    expect(newer.diagnostics).toEqual(['SIGNING_CONSENT_VERSION_MISMATCH']);
  });

  it('自相矛盾（说同意着当前版本、又说最新一条是撤回）→ MALFORMED', async () => {
    const { provider, diagnostics } = harness({ run: async () => ({ ok: true, text: body({ revoked: true }) }) });
    expect(await provider.read()).toEqual(NONE);
    expect(diagnostics).toEqual(['SIGNING_CONSENT_RESPONSE_MALFORMED']);
  });

  it('形状不对 / 不是 JSON → MALFORMED', async () => {
    for (const text of ['not json', JSON.stringify({ schemaVersion: 1, consent: { purpose: 'job-automation' } }), body({ revoked: 'no' })]) {
      const { provider, diagnostics } = harness({ run: async () => ({ ok: true, text }) });
      expect(await provider.read()).toEqual(NONE);
      expect(diagnostics).toEqual(['SIGNING_CONSENT_RESPONSE_MALFORMED']);
    }
  });

  it('路由不在（旧后端 404）→ 当没同意，诊断另带状态码与 x-request-id（码不嵌数字）', async () => {
    const { provider, diagnostics } = harness({ run: async () => ({ ok: false, status: 404, code: 'HTTP_ERROR', requestId: 'req-0123456789' }) });
    expect(await provider.read()).toEqual(NONE);
    expect(diagnostics).toEqual(['SIGNING_CONSENT_FETCH_FAILED {"http":{"httpStatus":404,"requestId":"req-0123456789"}}']);
  });

  it('没登录 / 传输抛错 → 当没同意', async () => {
    const noUser = harness({ userId: null });
    expect(await noUser.provider.read()).toEqual(NONE);
    expect(noUser.diagnostics).toEqual(['SIGNING_CONSENT_AUTH_UNAVAILABLE']);
    const thrown = harness({ run: async () => { throw new Error('offline'); } });
    expect(await thrown.provider.read()).toEqual(NONE);
    expect(thrown.diagnostics).toEqual(['SIGNING_CONSENT_FETCH_FAILED']);
  });
});

describe('替你注册账号和登录（2026-09-28 那一版的范围，另一路在做）', () => {
  it('只看是不是同意着当前版本', () => {
    expect(signingConsentCoversAccountRegistration({ granted: true, reconsent: false })).toBe(true);
    expect(signingConsentCoversAccountRegistration({ granted: false, reconsent: true })).toBe(false);
    expect(signingConsentCoversAccountRegistration({ granted: false, reconsent: false })).toBe(false);
  });
});
