import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import { runApplyPlan } from '../src/runner';
import { createUndoJournal } from '../src/undo';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';
import type { ApplyProfileDraft } from '../src/profileDraft';

/**
 * 宿主在失焦时把输入框整个重新挂载——值写进去了，我们却报「页面在填写前发生了变化」。
 *
 * 2026-09-22 在 nvidia.wd5.myworkdayjobs.com 的真实申请页上量的：
 *  · 点完 Apply Manually、不碰我们的浮层，First Name 输入框 3.6 秒出现，之后 16 秒一次都没换；
 *  · 点 Autofill 之后 3.1 秒，它被换掉了。
 *  · 逐个隔离：focus、blur、派 input 事件、真的改值——都不换。**改值之后再派 blur + focusout**
 *    （我们写入器最后那两个事件，给「失焦时校验」的表单用的）——300 毫秒内被换掉，
 *    而且**新节点里就是我们写的值**。只有被写过的那一个框会被换，同段的其它框都不动。
 *
 * 于是 14 页里 12 页面板写着「0 / 5 必填」：First Name、Last Name、Phone Number 三个
 * 必填全报 DETACHED。**这是一个假失败**——值在表单里，我们却说没填上。和 Lever 那个
 * 假成功（#55）正好相反，一样是面板在对用户说谎。
 *
 * ## 修法：认出接班节点
 *
 * 写后回读发现节点不在文档里了，就在**同一个表单根里**找它的接班人：签名
 * （`fieldSignature` 的 core——标签、类型、name 形状、作用域、作用域内序号——加上标签）
 * 完全一样的**恰好一个**节点，而且里面正好是我们写的值，才判成功。签名本来就是为
 * 「扛住预览到写入之间的重渲染」设计的，框架生成的 id 刻意不参与。
 *
 * 不写任何东西：这一步只是认出我们的写入落到了哪里。
 *
 * ## 还原
 *
 * 还原票据绑的是旧节点，够不到接班节点——放掉它，与还原簿对「已卸节点」的既有处理
 * （`abandonedDetached`）一致。这一栏填上了，但「还原本轮写入」碰不到它。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const PROFILE: ApplyProfileDraft = { firstName: 'Ada', email: 'ada@example.test' };

type Remount = 'keep-value' | 'clear-value' | 'remove' | 'moved';

/**
 * 模拟 Workday：firstName 那个框在 focusout 时被换成一个新节点。
 *  · keep-value  新节点带着当前值（Workday 的真实行为）
 *  · clear-value 新节点是空的（宿主把我们的值扔了）
 *  · remove      直接拿掉，不补新的
 *  · moved       补回来了，但挪到了 email 后面（结构位置变了，那就不是同一个字段）
 */
function mount(remount: Remount | null): void {
  document.body.innerHTML = `
    <form id="application-form">
      <div id="slot"><label for="first_name">First Name</label><input id="first_name" type="text" name="first_name" /></div>
      <label for="email">Email</label><input id="email" type="email" name="email" />
    </form>`;
  if (remount === null) return;
  const install = (input: HTMLInputElement): void => {
    input.addEventListener('focusout', () => {
      const slot = document.getElementById('slot')!;
      const value = input.value;
      input.remove();
      if (remount === 'remove') return;
      const fresh = (): HTMLInputElement => {
        const next = document.createElement('input');
        next.id = 'first_name';
        next.type = 'text';
        next.setAttribute('name', 'first_name');
        next.value = remount === 'clear-value' ? '' : value;
        return next;
      };
      if (remount === 'moved') document.querySelector('#application-form')!.append(fresh());
      else slot.append(fresh());
    }, { once: true });
  };
  install(document.querySelector<HTMLInputElement>('#first_name')!);
}

async function run(remount: Remount | null) {
  mount(remount);
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
  });
  const byKey = Object.fromEntries(
    summary.results.map((result) => [result.key, result.ok ? 'ok' : result.reason]),
  ) as Record<string, string>;
  return { summary, byKey, journal };
}

describe('宿主失焦时重挂载输入框', () => {
  it('新节点带着我们写的值 → 判成功，不是 DETACHED', async () => {
    const { byKey } = await run('keep-value');
    expect(
      byKey['firstName'],
      '值已经在表单里了，我们却说「页面在填写前发生了变化」——Workday 14 页里 12 页就是这样',
    ).toBe('ok');
    expect(byKey['email']).toBe('ok');
  });

  it('接班节点里真的是我们写的值', async () => {
    await run('keep-value');
    const now = document.querySelector<HTMLInputElement>('#first_name')!;
    expect(now.isConnected).toBe(true);
    expect(now.value).toBe('Ada');
  });

  it('还原票据放掉——还原够不到接班节点，但它也不会去碰一个已经不在文档里的旧节点', async () => {
    const { journal } = await run('keep-value');
    // email 那一张票还在；firstName 那一张已放掉。
    expect(journal.size()).toBe(1);
  });

  it('反向探针：新节点是空的 → 不许判成功', async () => {
    const { byKey } = await run('clear-value');
    expect(byKey['firstName'], '宿主把值扔了，我们却说填上了').not.toBe('ok');
  });

  it('反向探针：直接拿掉不补 → 照旧 DETACHED', async () => {
    const { byKey } = await run('remove');
    expect(byKey['firstName']).toBe('DETACHED');
  });

  /**
   * 签名里带着「作用域内序号」：挪了位置的节点序号变了，就不是同一个字段——哪怕它
   * 的 name 一样、里面的值也一样。认接班人只认原位的那一个。
   */
  it('反向探针：接班节点挪了位置 → 不认', async () => {
    const { byKey } = await run('moved');
    expect(byKey['firstName']).toBe('DETACHED');
  });

  it('反向探针：没有重挂载的宿主，行为与从前逐字一致', async () => {
    const { byKey, journal } = await run(null);
    expect(byKey).toEqual({ firstName: 'ok', email: 'ok' });
    expect(journal.size()).toBe(2);
  });
});
