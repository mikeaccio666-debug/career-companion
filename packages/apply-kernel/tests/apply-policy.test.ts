import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  APPLY_POLICY_CACHE_KEY,
  APPLY_POLICY_GRACE_MS,
  APPLY_POLICY_INSTALLED_AT_KEY,
  APPLY_POLICY_KILL_KEY,
  APPLY_POLICY_TTL_MS,
  createBundledApplyPolicy,
  loadApplyPolicy,
  resolveApplyPolicy,
  tighten,
  type ApplyPolicy,
} from '../src/policy';

const NOW = Date.UTC(2026, 6, 29, 12);

function bundled(): ApplyPolicy {
  return createBundledApplyPolicy(NOW - 60_000);
}

function remote(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    version: 'remote-v1',
    minExtensionVersion: '1.0.0',
    enabled: true,
    vendors: { greenhouse: true, lever: false, ashby: false, workable: false },
    capabilities: { 'set-text': true, 'set-select': true },
    minConfidence: 0.7,
    inferredRequiresConfirm: true,
    notAfter: NOW + 10 * 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

function resolve(
  overrides: Partial<Parameters<typeof resolveApplyPolicy>[0]> = {},
): ApplyPolicy {
  return resolveApplyPolicy({
    bundled: bundled(),
    now: NOW,
    extensionVersion: '1.0.5',
    killPresent: false,
    installedAt: NOW - 1,
    cachePresent: false,
    cached: undefined,
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apply policy fail-closed resolver', () => {
  it('存储抛错时关闭，而不是回落成永久开启', async () => {
    vi.stubGlobal('browser', {
      runtime: { getManifest: () => ({ version: '1.0.5' }) },
      storage: { local: { get: vi.fn(async () => { throw new Error('storage down'); }) } },
    });

    const policy = await loadApplyPolicy(NOW, bundled());
    expect(policy.enabled).toBe(false);
    expect(policy.source).toBe('disabled');
  });

  it.each([
    ['记录形状非法', { policy: { enabled: true }, fetchedAt: NOW }],
    ['记录超过 24 小时', { policy: remote(), fetchedAt: NOW - APPLY_POLICY_TTL_MS - 1 }],
  ])('%s 时关闭', (_case, cached) => {
    const policy = resolve({ cachePresent: true, cached });
    expect(policy.enabled).toBe(false);
  });

  it('粘性 kill 键存在时，即使有新鲜 enabled 策略也关闭', () => {
    const policy = resolve({
      killPresent: true,
      cachePresent: true,
      cached: { policy: remote(), fetchedAt: NOW - 1 },
    });
    expect(policy.enabled).toBe(false);
  });

  it('打包策略过硬过期时关闭', () => {
    const expired = createBundledApplyPolicy(NOW - 31 * 24 * 60 * 60 * 1000);
    const policy = resolve({ bundled: expired });
    expect(policy.enabled).toBe(false);
  });

  it('无缓存但安装宽限期已过时关闭', () => {
    const policy = resolve({ installedAt: NOW - APPLY_POLICY_GRACE_MS - 1 });
    expect(policy.enabled).toBe(false);
  });

  it('无缓存、安装 5 天后仍开启——72 小时静默自杀已废除（2026-08-12）', () => {
    // 背景：远程策略通道只有读的一半（APPLY_POLICY_CACHE_KEY 全仓无生产写入方），
    // 72 小时宽限意味着每个内测包装满三天就静默失效。宽限期现在覆盖整个包内
    // 硬有效期，真正的到期约束回到 notAfter（构建 + 30 天），无界授权仍不存在
    // （上一条与"打包策略过硬过期时关闭"共同锁住这一点）。
    const policy = resolve({ installedAt: NOW - 5 * 24 * 60 * 60 * 1000 });
    expect(policy.enabled).toBe(true);
    expect(policy.source).toBe('bundled');
  });

  it('远程要求的扩展版本更高时关闭', () => {
    const policy = resolve({
      cachePresent: true,
      cached: {
        policy: remote({ minExtensionVersion: '9.0.0' }),
        fetchedAt: NOW - 1,
      },
    });
    expect(policy.enabled).toBe(false);
  });

  it('远程策略只能收紧，不能降低置信度或重新打开能力位', () => {
    const strictBundled = {
      ...bundled(),
      minConfidence: 0.9,
      capabilities: { 'set-text': true, 'set-select': false, 'set-combobox': false, 'set-richtext': false, 'manage-rows': false, 'set-file': false, 'set-other-person': false, 'set-attestation': false, 'set-self-identification': false, 'set-work-authorization': false, 'set-referral': false, 'advance-step': false, 'advance-steps': false, 'sign-on-behalf': false, 'submit-application': false, 'account-access': false },
    } satisfies ApplyPolicy;
    const policy = tighten(
      strictBundled,
      remote({ minConfidence: 0, capabilities: { 'set-text': true, 'set-select': true } }),
    );

    expect(policy.minConfidence).toBe(0.9);
    expect(policy.capabilities['set-select']).toBe(false);
  });

  it('首次运行只登记安装时间，并在有界宽限期内使用打包策略', async () => {
    const storage: Record<string, unknown> = {};
    const set = vi.fn(async (entries: Record<string, unknown>) => Object.assign(storage, entries));
    vi.stubGlobal('browser', {
      runtime: { getManifest: () => ({ version: '1.0.5' }) },
      storage: {
        local: {
          get: vi.fn(async (keys: string[]) =>
            Object.fromEntries(
              keys.filter((key) => Object.prototype.hasOwnProperty.call(storage, key)).map((key) => [key, storage[key]]),
            ),
          ),
          set,
        },
      },
    });

    const policy = await loadApplyPolicy(NOW, bundled());
    expect(policy.enabled).toBe(true);
    expect(policy.source).toBe('bundled');
    expect(set).toHaveBeenCalledWith({ [APPLY_POLICY_INSTALLED_AT_KEY]: NOW });
    expect(storage).not.toHaveProperty(APPLY_POLICY_CACHE_KEY);
    expect(storage).not.toHaveProperty(APPLY_POLICY_KILL_KEY);
  });
});

/**
 * 策略解析对 schema 漂移的容错。
 *
 * 这一组是被一次真实的自伤逼出来的：2026-08-01 给 WRITE_CAPABILITIES 加 `set-file`
 * 时，原本的 `exactBooleanRecord`（要求键集完全相等）让**线上所有已缓存的三键 blob**
 * 全部解析失败 → tighten 返回 disabledPolicy → autofill 对所有人整体关闭，且完全静默。
 *
 * 容错方向是有选择的，不是一律放行 —— 下面四条各锁一个方向。
 */
describe('策略解析的 schema 容错', () => {
  const base = () => ({
    version: 'remote-v1',
    minExtensionVersion: '0.0.0',
    enabled: true,
    vendors: { greenhouse: true, lever: true, ashby: true, workable: true },
    capabilities: { 'set-text': true, 'set-select': true, 'set-combobox': true, 'set-file': true },
    minConfidence: 0.7,
    inferredRequiresConfirm: true,
    notAfter: Date.now() + 86_400_000,
  });

  it('缺少某个能力位时，那一位为 false，其余照常（fail-closed，不是整包拒绝）', () => {
    const blob = base();
    delete (blob.capabilities as Record<string, unknown>)['set-file'];
    const policy = tighten(bundled(), blob);
    expect(policy.source, '旧 blob 被整包拒了 —— 这次发版会静默关掉所有人的 autofill').toBe(
      'remote',
    );
    expect(policy.capabilities['set-file'], '缺键必须 fail-closed').toBe(false);
    expect(policy.capabilities['set-text'], '其余能力位被误伤').toBe(true);
  });

  it('多余的未知键被忽略（旧版扩展遇到新 blob 不会被未来的键炸掉）', () => {
    const blob = base();
    (blob.capabilities as Record<string, unknown>)['set-future-thing'] = true;
    (blob.vendors as Record<string, unknown>)['some-new-vendor'] = true;
    const policy = tighten(bundled(), blob);
    expect(policy.source).toBe('remote');
    expect(Object.keys(policy.capabilities).sort()).toEqual(
      [
      // 2026-08-19 显式扩项：新增 `set-attestation`（乙档代勾的 C3 放行闸）。
      // 2026-08-22 显式扩项：新增 `manage-rows`（CAP-AF-003 增删行的宿主点击，
      // 内置默认 false）。
      // 2026-09-15 显式扩项：新增 `set-other-person`（推荐人 / 紧急联系人栏，
      // 内置默认 false——需要一份可信的他人数据源才谈得上打开）。
      // 2026-09-22 显式扩项：新增 `advance-step`（多页申请的翻页，按宿主的 Save and
      // Continue 会把这一步保存进宿主，内置默认 false）。
      // 2026-09-23 显式扩项：新增 `sign-on-behalf`（代填条款同意、属实声明与签名，内置默认
      // false；每个用户还得在资料页单独同意过）。
      // 2026-09-23（晚）显式扩项：新增 `submit-application`（用户在浮层里按「提交」之后替他按
      // 规则声明的最终提交；内置默认 false，远程策略放行才开）。
      // 2026-09-28 显式扩项：新增 `advance-steps`（连填：一次「自动填写」一页一页填到检查页；内置默认 false，
      // 远程策略放行才开，缺席回到每一页一颗「继续到下一页」）。
      // 2026-09-28 显式扩项：新增 `account-access`（替用户在招聘网站上注册、登录；内置默认 false，远程策略放行、
      // 用户同意过点名这一类的那一版文案，两样都在才做）。
      // **本行变红是这道闸在正常工作**——能力位集合变动必须是有人显式改过测试。
      'account-access',
      'advance-step',
      'advance-steps',
      'manage-rows',
      'set-attestation',
      'set-combobox',
      'set-file',
      'set-other-person',
      'set-referral',
      'set-richtext',
      'set-select',
      'set-self-identification',
      'set-text',
      'set-work-authorization',
      'sign-on-behalf',
      'submit-application',
    ],
    );
  });

  it('非布尔值按 false 处理（同样 fail-closed）', () => {
    const blob = base();
    (blob.capabilities as Record<string, unknown>)['set-file'] = 'yes';
    (blob.vendors as Record<string, unknown>).lever = 1;
    const policy = tighten(bundled(), blob);
    expect(policy.capabilities['set-file']).toBe(false);
    expect(policy.vendors.lever).toBe(false);
  });

  /** 反向探针：容错不能变成"什么都收"。整个记录不是对象时仍须整包拒绝。 */
  it('vendors / capabilities 根本不是对象时仍然整包拒绝', () => {
    for (const bad of [null, 'x', 42, ['a']]) {
      expect(tighten(bundled(), { ...base(), capabilities: bad }).source).toBe('disabled');
      expect(tighten(bundled(), { ...base(), vendors: bad }).source).toBe('disabled');
    }
  });
});
