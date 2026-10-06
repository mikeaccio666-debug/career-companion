// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://shop.example/contact"}
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * 证据多了才重新报到：那一次报到不再把页面再探一遍（2026-10-03 全网注入实测）。
 *
 * `recheckEvidence` 刚探过页面（`pageEvidence.refresh()`）、发现证据多了才报到；从前 `hello()` 进门又探一遍——同一拍里、
 * DOM 没变，第二遍的结论必然相同，白花一次通用表探测（有表的页面上每次 13–40 ms）。别的几条报到的路（注入时、
 * 回到标签页、pageshow、站内换路径、重问）没有人先探过，照旧由 `hello()` 自己探。
 *
 * 这里跑真内容脚本，只把 `browser` 换成桩，数通用表探测（`genericApplyFormEvidence`）被调用了几次。
 * 一次注入里各条路径的计数会互相叠加，所以只跑一次 main()，分两段看。
 */

const fake = vi.hoisted(() => ({
  sent: [] as unknown[],
  /** 页面上此刻那张表在通用探测眼里是什么样。 */
  form: 'NONE' as 'NONE' | 'FORM' | 'JOB_FORM' | 'APPLICATION_FORM',
  probes: 0,
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
vi.mock('../lib/kernelScanner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/kernelScanner')>();
  return {
    ...actual,
    genericApplyFormEvidence: () => {
      fake.probes += 1;
      return fake.form;
    },
  };
});

type Hello = Readonly<{ kind: string; genericForm?: true }>;
const hellos = () => fake.sent.filter((message) => (message as Hello).kind === 'bridge/hello') as Hello[];

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('报到不重复探页面', () => {
  it('证据多了才报到时只探一次；别的路径报到照旧自己探', async () => {
    vi.useFakeTimers();
    const { default: entrypoint } = await import('../entrypoints/apply.content');
    (entrypoint as unknown as { main: () => void }).main();
    // 注入时报到一次（hello 自己探），规则装上后再看一眼（没变，不报到）。
    await vi.advanceTimersByTimeAsync(100);
    expect(hellos()).toHaveLength(1);

    // 第一段：表画出来了，1.5 秒那一眼看见了——这一次报到不该再探一遍。
    fake.form = 'FORM';
    const probesBefore = fake.probes;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(hellos(), '证据多了，报到一次').toHaveLength(2);
    expect(hellos()[1]?.genericForm, '报到照旧带上这一份证据').toBe(true);
    expect(fake.probes - probesBefore, '一次「证据多了」只探一次页面').toBe(1);

    // 第二段：别的路径（回到这个标签页）报到时没有人先探过，hello 照旧自己探。
    await vi.advanceTimersByTimeAsync(15_000);
    const probesBeforeFocus = fake.probes;
    const hellosBeforeFocus = hellos().length;
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(hellos(), '回到标签页照旧报到').toHaveLength(hellosBeforeFocus + 1);
    expect(fake.probes - probesBeforeFocus, '回到标签页的那一次报到照旧自己探').toBe(1);
  });
});
