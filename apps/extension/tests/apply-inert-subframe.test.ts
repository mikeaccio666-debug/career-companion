// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://ads.example/slot/1"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 主机不在厂商表里的子帧（广告、视频、验证码、社交插件、站内小部件……）不做用不上的事（2026-10-03 全网注入实测）。
 *
 * 这种帧从不报到（`hello` 里「子帧不报到」那一道），永远拿不到浮层，下面两样在它那里从来用不上，却每一帧都在付：
 *  · 站点规则：向后台要一次整份发布（约 90 KB JSON），再把十几套规则逐一校验、编译、SHA-256 复核；
 *  · 早装的提交拦截：window 上一排捕获监听（当天实测 11 个），页面上每一次指针、键盘、点击都过一遍。
 * 一个带 8 个 iframe 的页面就是 9 次注入、9 份规则。
 *
 * 判据与 `hello` 不报到的那一道是同一个：子帧，且 `detectApplyVendor(location.hostname) === null`。
 * 主机在厂商表里的子帧（公司官网里嵌的 Greenhouse 申请表）与顶层帧一切照旧。
 *
 * 这里跑真内容脚本，只把 `browser` 换成桩，另外数一下规则安装与提交拦截各被调用了几次（真函数照常执行）。
 */

const fake = vi.hoisted(() => ({
  sent: [] as unknown[],
  installRules: [] as unknown[],
  installBroker: [] as unknown[],
}));

vi.mock('wxt/utils/define-content-script', () => ({ defineContentScript: <T>(config: T): T => config }));
vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      id: 'test-extension-id',
      getManifest: () => ({ version: '1.0.0' }),
      onConnect: { addListener: () => {} },
      onMessage: { addListener: () => {} },
      sendMessage: (message: unknown) => {
        fake.sent.push(message);
        const kind = (message as { kind?: unknown } | null)?.kind;
        // worker 手里有一份规则（这里是认不出的替身，照样编译成空表）。答 `rules: null` 是 worker 还没有规则：#147 起内容脚本
        // 隔 1.5 秒再要一次、记 SITE_KNOWLEDGE_RETRIED（lib/siteKnowledge.ts），那不是这里要看的。
        if (kind === 'apply-site-knowledge/get') return Promise.resolve({ rules: {} });
        return Promise.resolve({ dock: { kind: 'HIDDEN' } });
      },
    },
    storage: {
      local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      onChanged: { addListener: () => {} },
    },
  },
}));
vi.mock('../lib/executionRuntimeAuthority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/executionRuntimeAuthority')>();
  return {
    ...actual,
    installApplyAdaptersFromRules: (...args: Parameters<typeof actual.installApplyAdaptersFromRules>) => {
      fake.installRules.push(args[0]);
      return actual.installApplyAdaptersFromRules(...args);
    },
  };
});
vi.mock('../lib/submissionGestureGate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/submissionGestureGate')>();
  return {
    ...actual,
    installEarlySubmissionCaptureBroker: (...args: Parameters<typeof actual.installEarlySubmissionCaptureBroker>) => {
      fake.installBroker.push(args[0]);
      return actual.installEarlySubmissionCaptureBroker(...args);
    },
  };
});

const kinds = () => fake.sent.map((message) => (message as { kind?: unknown }).kind);
const topDescriptor = Object.getOwnPropertyDescriptor(window, 'top')!;

async function injectInto(url: string, frame: 'top' | 'subframe'): Promise<void> {
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(url);
  // 子帧：window.top 是另一个窗口（跨源时是代理对象，这里只用它的身份）。
  if (frame === 'subframe') Object.defineProperty(window, 'top', { ...topDescriptor, value: {} });
  const { default: entrypoint } = await import('../entrypoints/apply.content');
  (entrypoint as unknown as { main: () => void }).main();
  await vi.advanceTimersByTimeAsync(100);
}

beforeEach(() => {
  fake.sent.length = 0;
  fake.installRules.length = 0;
  fake.installBroker.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  Object.defineProperty(window, 'top', topDescriptor);
});

describe('主机不在厂商表里的子帧：不要规则、不编译、不装提交拦截', () => {
  it('广告／小部件子帧：一条消息都不发，规则不装，提交拦截不装', async () => {
    await injectInto('https://ads.example/slot/1', 'subframe');
    expect(window.top === window.self, '前提：这一帧是子帧').toBe(false);
    expect(kinds(), '不要规则、不报到').toEqual([]);
    expect(fake.installRules, '不编译规则').toEqual([]);
    expect(fake.installBroker, '不装提交拦截').toEqual([]);
  });
});

describe('别的帧一切照旧', () => {
  it('主机在厂商表里的子帧（公司官网里嵌的 Greenhouse 申请表）：要规则、编译、装提交拦截，并说这一帧持有申请表', async () => {
    await injectInto('https://job-boards.greenhouse.io/embed/job_app?for=acme&token=123', 'subframe');
    expect(window.top === window.self).toBe(false);
    expect(kinds()).toEqual(['apply-site-knowledge/get', 'bridge/frame-form']);
    expect(fake.installRules).toEqual([{}]);
    expect(fake.installBroker).toEqual([window]);
  });

  it('顶层帧（主机不在厂商表里也一样）：要规则、编译、装提交拦截、报到', async () => {
    await injectInto('https://ads.example/slot/1', 'top');
    expect(window.top === window.self).toBe(true);
    expect(kinds()).toEqual(['apply-site-knowledge/get', 'bridge/hello']);
    expect(fake.installRules).toEqual([{}]);
    expect(fake.installBroker).toEqual([window]);
  });
});
