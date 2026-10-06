import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import { runApplyPlan } from '../src/runner';
import { createUndoJournal } from '../src/undo';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';
import type { ApplyWriteResult } from '../src/contracts';
import type { ApplyProfileDraft } from '../src/profileDraft';

/**
 * 整轮结束**之后**的复核。
 *
 * 延时复检（CAP-AF-055，`apply-late-revert-sweep.test.ts`）在整轮写完后扫一次，
 * 窗口是产品链路上钉死的 250 毫秒。那个数字是照着「受控框架重渲染」量的，而它
 * 挡不住真正常见的另一种宿主回写：**简历解析**。那是一次服务端往返，2026-09-22
 * 在 Lever 上实测是结算后约十二秒才把我们填好的地点清空。
 *
 * 窗口一关，那一行就永远停在 `ok` 上——面板说「已填」，表单其实是空的。这是
 * 「回读判决 + 可审计」最难堪的失败形态：**不是没填上，是我们说了谎**。而且比
 * 漏填更糟，因为漏填至少会催用户去看那一栏。
 *
 * ## 为什么不是「把 250 毫秒调大」
 *
 * 调到十二秒，用户就要对着中段屏干等十二秒，而且仍然是猜——下一家可能十五秒。
 * 宿主什么时候回写不由我们决定，所以这件事的形状只能是「随时可以再问一次」，
 * 不是「等得更久一点」。
 *
 * ## 为什么写入值不进 `ApplyWriteResult`
 *
 * 复核要拿「我们当时写进去的是什么」跟现在的 DOM 比。那个值是简历/档案原文，
 * 属 Data-L1，不得进入任何会被序列化、落日志或上报的形状。所以它留在 runner 的
 * 闭包里，摘要只交出一个**只读**的复核入口。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const PROFILE: ApplyProfileDraft = { firstName: 'Ada', email: 'ada@example.test' };

function mount(): void {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="first_name">First Name</label><input id="first_name" type="text" />
      <label for="email">Email</label><input id="email" type="email" />
    </form>`;
}

async function run() {
  mount();
  const root = greenhouseAdapter.resolveRoot(document)!;
  const plan = buildApplyPlan(
    { vendor: 'greenhouse', root, fields: [...greenhouseAdapter.scan(root)] },
    PROFILE,
  );
  const summary = await runApplyPlan({
    plan,
    auth: testAuthority(plan.fingerprint, 'fill', ['set-text', 'set-select', 'set-combobox', 'set-file']),
    journal: createUndoJournal(),
    root,
    policy: testApplyPolicy(),
    lateRecheckMs: 200,
    // 注入的等待器：这一轮的窗口里宿主什么都没做，所以整轮收尾时两条都是成功。
    lateRecheckDelay: async () => {},
  });
  return { summary, plan, root };
}

const byKey = (results: readonly ApplyWriteResult[]): Record<string, string> =>
  Object.fromEntries(results.map((result) => [result.key, result.ok ? 'ok' : result.reason]));

describe('整轮结束之后的复核', () => {
  it('窗口关闭之后宿主才清空 → 复核判 LATE_REVERTED，不再停在谎报的成功上', async () => {
    const { summary } = await run();
    // 整轮收尾时两条都成功——延时复检窗口里没人动过。
    expect(byKey(summary.results)).toEqual({ firstName: 'ok', email: 'ok' });

    // 十二秒后简历解析回来，把我们填的名字清空。今天没有任何途径能知道这件事。
    document.querySelector<HTMLInputElement>('#first_name')!.value = '';

    const revised = summary.recheck();
    expect(
      byKey(revised),
      '窗口关闭之后被宿主清空的那条仍报成功——面板会说「已填」而表单是空的',
    ).toEqual({ firstName: 'LATE_REVERTED', email: 'ok' });
  });

  it('值被覆盖成别人的内容，同样判 LATE_REVERTED', async () => {
    const { summary } = await run();
    // 简历解析回填的典型形状：值还在，但不是我们写的那个。
    document.querySelector<HTMLInputElement>('#first_name')!.value = 'Augusta';
    expect(byKey(summary.recheck())['firstName']).toBe('LATE_REVERTED');
  });

  it('反向探针：没人动过时复核不改任何一条', async () => {
    const { summary } = await run();
    expect(byKey(summary.recheck())).toEqual({ firstName: 'ok', email: 'ok' });
  });

  it('反向探针：复核只读——不写 DOM，也不改还原票据', async () => {
    mount();
    const root = greenhouseAdapter.resolveRoot(document)!;
    const plan = buildApplyPlan(
      { vendor: 'greenhouse', root, fields: [...greenhouseAdapter.scan(root)] },
      PROFILE,
    );
    const journal = createUndoJournal();
    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', ['set-text', 'set-select', 'set-combobox', 'set-file']),
      journal,
      root,
      policy: testApplyPolicy(),
      lateRecheckMs: 200,
      lateRecheckDelay: async () => {},
    });
    const before = journal.size();
    document.querySelector<HTMLInputElement>('#first_name')!.value = '';

    summary.recheck();

    // 复核发现值没了，但它不该去把值写回来，也不该动还原票据：还原仍然是用户的动作。
    expect(document.querySelector<HTMLInputElement>('#first_name')!.value, '复核把值写回去了').toBe('');
    expect(journal.size(), '复核动了还原票据').toBe(before);
  });

  it('反向探针：复核可以反复调用，且不吃掉自己上一次的判定', async () => {
    const { summary } = await run();
    document.querySelector<HTMLInputElement>('#first_name')!.value = '';
    expect(byKey(summary.recheck())['firstName']).toBe('LATE_REVERTED');
    expect(byKey(summary.recheck())['firstName']).toBe('LATE_REVERTED');
    // 宿主又把值放回来了（用户自己重填，或者解析第二轮）——复核如实说它现在在。
    document.querySelector<HTMLInputElement>('#first_name')!.value = 'Ada';
    expect(byKey(summary.recheck())['firstName']).toBe('ok');
  });

  it('反向探针：摘要本身不被复核改写——它是那一刻的结论', async () => {
    const { summary } = await run();
    document.querySelector<HTMLInputElement>('#first_name')!.value = '';
    summary.recheck();
    expect(byKey(summary.results), '复核就地改了整轮摘要').toEqual({ firstName: 'ok', email: 'ok' });
    expect(summary.filled).toBe(2);
  });

  /**
   * 控件被宿主卸掉时读不到值，这与「值被清空」不是一回事：重新挂载一个等价节点
   * 与真的移除，在不重新扫描的前提下分不出来。判 LATE_REVERTED 会是反方向的谎。
   */
  it('反向探针：控件被卸掉时复核不改判——读不到不等于没了', async () => {
    const { summary } = await run();
    document.querySelector<HTMLInputElement>('#first_name')!.remove();
    expect(byKey(summary.recheck())['firstName']).toBe('ok');
  });

  /**
   * 复核只针对**本轮判定成功**的条目。已经失败的条目不该被改写成另一个码——
   * 那会把 WRITE_REVERTED / HOST_REJECTED 这些更具体的诊断洗成 LATE_REVERTED。
   */
  it('反向探针：已经失败的条目不被复核覆盖', async () => {
    mount();
    const root = greenhouseAdapter.resolveRoot(document)!;
    const plan = buildApplyPlan(
      { vendor: 'greenhouse', root, fields: [...greenhouseAdapter.scan(root)] },
      PROFILE,
    );
    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', ['set-text', 'set-select', 'set-combobox', 'set-file']),
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
      lateRecheckMs: 200,
      // 宿主判 email 无效：那条本轮就是 HOST_REJECTED。
      readHostValidation: (element) =>
        (element as HTMLInputElement).id === 'email' ? { ariaInvalid: 'true' } : {},
      lateRecheckDelay: async () => {},
    });
    const failed = summary.results.find((result) => result.key === 'email')!;
    expect(failed.ok, '前置条件：这一条本轮就该是失败的').toBe(false);

    // 之后这一栏也被清空——但它的诊断已经比 LATE_REVERTED 更具体，不该被洗掉。
    document.querySelector<HTMLInputElement>('#email')!.value = '';
    const revised = summary.recheck();
    expect(
      revised.find((result) => result.key === 'email'),
      'HOST_REJECTED 被复核洗成了 LATE_REVERTED',
    ).toEqual(failed);
  });
});
