import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  selectComboboxOption,
  type ComboboxOptionSource,
  type ComboboxSemanticTransactionSource,
} from '../../src/click/combobox';
import { consumeAuthority, type HostWriteAuthority } from '../../src/grant';
import { createBundledApplyPolicy } from '../../src/policy';
import { createScanRoot } from '../../src/scanRoot';
import { createUndoJournal } from '../../src/undo';
import { testApplyPolicy, testAuthority } from '../helpers/applyTestAuthority';

/**
 * S0 · 下拉编排的**交易边界**。
 *
 * 决策 17 把写入授权的活动窗口放宽到"有界的控件交互"，代价是我们现在会在宿主页面上
 * **点击**，而且要跨至少一个宏任务。这个文件锁死那个放宽换来的三条边界，全部是
 * 安全属性，不是功能：
 *
 *   1. 只点**我们看着它出现**的选项（openedByTransaction）——页面上本来就存在的
 *      同名 `[role=option]` 绝不能被我们点到；
 *   2. 等不到就**不点**，带类型错误码放弃，绝不"等久一点再说"；
 *   3. 策略关闭时**一次事件都不发**。
 *
 * 结构全部来自实测的真实 Greenhouse 申请页（2026-08-01，`#country`）：
 *   · 选项是 `<div role="option">`，不是 `<li>` 也不是 `<option>`
 *   · 同一 tick 内 0 个选项，**一个宏任务后 244 个**
 *   · 点中选项后下拉**自己关闭**（aria-expanded 回 false、选项清零）——所以我们
 *     不发 Escape，那会在模态里的申请表上误关整个弹层
 *   · 菜单是内联的（在 form#application-form 内），没有 portal 到 body
 */

/**
 * 这个 fixture 用 setTimeout 模拟"下拉过一会儿才落定"。定时器必须在 teardown
 * 时清掉：happy-dom 的 document 在测试结束后就没了，一个漏网的回调会在
 * **下一个测试文件**运行时抛 `ReferenceError: document is not defined`，
 * 而且报错落在无辜的那个文件头上。
 *
 * 2026-08-09 实测：本地 Mac 一直是绿的，只有更慢的 CI runner 会稳定复现——
 * 也就是说没有 CI，这个泄漏永远发现不了。
 */
const pendingTimers: ReturnType<typeof setTimeout>[] = [];

const testOptionSource: ComboboxOptionSource = {
  read: (_trigger, root) => root.querySelectorAll('[role="option"]').map((element) => ({
    element,
    text: element.textContent ?? '',
  })),
  isOpen: (trigger) => trigger.getAttribute('aria-expanded') === 'true',
};

afterEach(() => {
  for (const timer of pendingTimers.splice(0)) clearTimeout(timer);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

interface Harness {
  readonly trigger: HTMLInputElement;
  readonly form: HTMLFormElement;
  /** 每个被派发到宿主的鼠标事件，按顺序。 */
  readonly clicks: string[];
  openLater(labels: readonly string[], afterMs: number): void;
  addPreexistingOption(label: string): HTMLElement;
}

/** 复刻实测到的 react-select 结构，包括"选项晚一个宏任务才出现"。 */
function mountCombobox(): Harness {
  document.body.innerHTML = `
    <form id="application-form">
      <fieldset class="phone-input">
        <label id="country-label" for="country">Country</label>
        <div class="select-shell">
          <div class="select__control">
            <div class="select__input-container">
              <input id="country" type="text" role="combobox"
                     aria-expanded="false" aria-haspopup="true" aria-labelledby="country-label" />
            </div>
          </div>
          <div class="select__menu-slot"></div>
        </div>
      </fieldset>
    </form>`;
  const form = document.querySelector('form') as HTMLFormElement;
  const trigger = document.getElementById('country') as HTMLInputElement;
  const slot = form.querySelector('.select__menu-slot') as HTMLElement;
  const clicks: string[] = [];

  const track = (element: Element, label: string): void => {
    for (const type of ['mousedown', 'mouseup', 'click']) {
      element.addEventListener(type, () => clicks.push(`${label}:${type}`));
    }
  };
  track(trigger, 'trigger');

  return {
    trigger,
    form,
    clicks,
    openLater(labels, afterMs) {
      trigger.addEventListener('click', () => {
        if (trigger.getAttribute('aria-expanded') === 'true') {
          trigger.setAttribute('aria-expanded', 'false');
          slot.replaceChildren();
          return;
        }
        pendingTimers.push(setTimeout(() => {
          trigger.setAttribute('aria-expanded', 'true');
          for (const [index, label] of labels.entries()) {
            const option = document.createElement('div');
            option.setAttribute('role', 'option');
            option.id = `react-select-country-option-${index}`;
            option.textContent = label;
            // 实测：选中后下拉自行关闭。
            option.addEventListener('click', () => {
              trigger.value = label;
              trigger.dataset.selectedBacking = label;
              trigger.setAttribute('aria-expanded', 'false');
              slot.replaceChildren();
            });
            track(option, `option[${label}]`);
            slot.appendChild(option);
          }
        }, afterMs));
      });
    },
    addPreexistingOption(label) {
      const option = document.createElement('div');
      option.setAttribute('role', 'option');
      option.textContent = label;
      track(option, `preexisting[${label}]`);
      slot.appendChild(option);
      return option;
    },
  };
}

/**
 * 授权必须先被 `consumeAuthority` 推进到**运行态**才有写入能力——铸出来的授权
 * 本身不能写。真实调用方是 `runApplyPlan`，它在进入逐字段循环前消费一次。
 */
function activeAuthority(): HostWriteAuthority {
  // `set-combobox` **不在** mintAuthority 的默认能力集里（默认只有 set-text /
  // set-select）。这是刻意的：点击宿主必须被显式请求，不能顺带获得。生产侧因此
  // 也必须在计划里含下拉字段时才带上这个能力去铸授权。
  const authority = testAuthority('combobox-plan', 'fill', ['set-text', 'set-select', 'set-combobox']);
  const consumed = consumeAuthority(authority);
  expect(consumed.ok, '测试前置：授权没能进入运行态').toBe(true);
  return authority;
}

const testSemanticTransactionSource: ComboboxSemanticTransactionSource = {
  snapshot: (trigger, root) => {
    const previousRawValue = trigger.value;
    const previousBacking = trigger.dataset.selectedBacking;
    const ownsEventTarget = (target: EventTarget | null) =>
      target === trigger ||
      (target instanceof Element && root.querySelectorAll('[role="option"]').includes(target));
    const isAtPreWriteState = () =>
      trigger.value === previousRawValue &&
      trigger.dataset.selectedBacking === previousBacking;
    return {
      canRestorePreWrite: isAtPreWriteState,
      restorePreWrite: () => {
        trigger.value = previousRawValue;
        if (previousBacking === undefined) delete trigger.dataset.selectedBacking;
        else trigger.dataset.selectedBacking = previousBacking;
        return true;
      },
      isAtPreWriteState,
      ownsEventTarget,
      captureWrittenState: (expected) => ({
        isAtWrittenState: () => trigger.dataset.selectedBacking === expected,
        restorePreWrite: () => {
          trigger.value = previousRawValue;
          if (previousBacking === undefined) delete trigger.dataset.selectedBacking;
          else trigger.dataset.selectedBacking = previousBacking;
          return true;
        },
        isAtPreWriteState,
        ownsEventTarget,
        wasUserEdited: () => false,
        dispose: () => undefined,
      }),
    };
  },
};

function run(harness: Harness, overrides: Partial<Parameters<typeof selectComboboxOption>[0]> = {}) {
  return selectComboboxOption({
    trigger: harness.trigger,
    previousRawValue: harness.trigger.value,
    desired: 'United States',
    root: createScanRoot(harness.form, []),
    optionSource: testOptionSource,
    semanticTransactionSource: testSemanticTransactionSource,
    authority: activeAuthority(),
    ticket: createUndoJournal().record(harness.trigger),
    policy: testApplyPolicy(),
    readSelection: (trigger, expected) =>
      trigger.dataset.selectedBacking === expected ? expected : null,
    timeoutMs: 400,
    ...overrides,
  });
}

describe('S0 · 下拉交易边界', () => {
  it('等到选项出现后选中，并且只点了触发器与那一个选项', async () => {
    const harness = mountCombobox();
    harness.openLater(['United States +1', 'United Kingdom +44'], 5);

    const result = await run(harness);

    expect(result.ok, `编排失败：${result.ok ? '' : result.code}`).toBe(true);
    expect(harness.clicks).toEqual([
      'trigger:mousedown',
      'trigger:mouseup',
      'trigger:click',
      'option[United States +1]:mousedown',
      'option[United States +1]:mouseup',
      'option[United States +1]:click',
    ]);
  });

  it('绝不点击我们打开之前就已经存在的选项', async () => {
    const harness = mountCombobox();
    // 页面上本来就有一个同名 [role=option]（别的控件的残留、或宿主自己的菜单）。
    harness.addPreexistingOption('United States +1');
    // 我们这次交易什么都不会开出来。
    const result = await run(harness, { timeoutMs: 60 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('WIDGET_TIMEOUT');
    expect(
      harness.clicks.filter((entry) => entry.startsWith('preexisting')),
      '点到了不属于本次交易的选项',
    ).toEqual([]);
  });

  it('超时就放弃，不点任何选项', async () => {
    const harness = mountCombobox();
    harness.openLater(['United States +1'], 5_000); // 远超预算

    const result = await run(harness, { timeoutMs: 60 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('WIDGET_TIMEOUT');
    expect(harness.clicks.filter((entry) => entry.startsWith('option'))).toEqual([]);
  });

  it('策略关闭时一次事件都不发', async () => {
    const harness = mountCombobox();
    harness.openLater(['United States +1'], 5);

    const result = await run(harness, {
      policy: { ...createBundledApplyPolicy(Date.now()), enabled: false },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('POLICY_DISABLED');
    expect(harness.clicks, '策略已关闭仍然点了宿主').toEqual([]);
  });

  it('等待 option 的宏任务期间策略失效，不再点击任何选项', async () => {
    const harness = mountCombobox();
    harness.openLater(['United States +1'], 0);
    let checks = 0;

    const result = await run(harness, {
      executionFence: () => (++checks >= 3 ? 'POLICY_DISABLED' : null),
    });

    expect(result).toEqual({ ok: false, code: 'POLICY_DISABLED' });
    expect(harness.clicks.filter((entry) => entry.startsWith('option'))).toEqual([]);
  });

  it('option mousedown 产生未封存 backing 时不猜测 rollback ownership', async () => {
    const harness = mountCombobox();
    harness.openLater(['United States +1'], 0);
    const slot = harness.form.querySelector('.select__menu-slot') as HTMLElement;
    const onMousedown = (event: Event) => {
      const option = event.target;
      if (!(option instanceof Element) || option.getAttribute('role') !== 'option') return;
      harness.trigger.dataset.selectedBacking = 'United States';
      option.remove();
    };
    slot.addEventListener('mousedown', onMousedown, { once: true });

    const result = await run(harness);

    expect(result).toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
    expect(harness.trigger.value).toBe('');
    expect(harness.trigger.dataset.selectedBacking).toBe('United States');
    expect(harness.clicks.filter((entry) => entry.startsWith('option'))).toEqual([
      'option[United States +1]:mousedown',
    ]);
  });

  it('semantic restore 自报成功但 no-op 且 readback 不匹配时升级为 IDENTITY_CHANGED', async () => {
    const harness = mountCombobox();
    harness.openLater(['United States +1'], 0);
    const slot = harness.form.querySelector('.select__menu-slot') as HTMLElement;
    const onMousedown = (event: Event) => {
      const option = event.target;
      if (!(option instanceof Element) || option.getAttribute('role') !== 'option') return;
      harness.trigger.dataset.selectedBacking = 'United States';
      option.remove();
    };
    slot.addEventListener('mousedown', onMousedown, { once: true });

    const result = await run(harness, {
      semanticTransactionSource: {
        snapshot: (trigger) => ({
          canRestorePreWrite: () => trigger.dataset.selectedBacking === undefined,
          restorePreWrite: () => true,
          isAtPreWriteState: () => trigger.dataset.selectedBacking === undefined,
          ownsEventTarget: (target) => target === trigger,
          captureWrittenState: () => null,
        }),
      },
    });

    expect(result).toMatchObject({ ok: false, code: 'IDENTITY_CHANGED' });
    expect(result.ok ? undefined : result.recovery).toBeUndefined();
    expect(harness.trigger.dataset.selectedBacking).toBe('United States');
    expect(harness.clicks.filter((entry) => entry.startsWith('option'))).toEqual([
      'option[United States +1]:mousedown',
    ]);
  });

  it('没有任何选项匹配时不点，报 NO_OPTION_MATCH', async () => {
    const harness = mountCombobox();
    harness.openLater(['Afghanistan +93', 'Albania +355'], 5);

    const result = await run(harness);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NO_OPTION_MATCH');
    expect(harness.clicks.filter((entry) => entry.startsWith('option'))).toEqual([]);
    // 开出来的下拉必须关回去：我们打开了它，就得把页面留在没来过的样子。
    // （这一条是变异测试补上的——原来只断言"没点选项"，把关闭那段整个删掉
    //  照样全绿。）
    expect(
      harness.clicks.filter((entry) => entry === 'trigger:click').length,
      '匹配失败后把下拉晾在打开状态',
    ).toBe(2);
  });

  it('多个选项都说得通时不猜，报 AMBIGUOUS_OPTION', async () => {
    const harness = mountCombobox();
    // "United States" 同时是这两条的前缀——阶梯匹配必须在这里停手。
    harness.openLater(['United States Minor Outlying Islands +1', 'United States Virgin Islands +1'], 5);

    const result = await run(harness);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('AMBIGUOUS_OPTION');
    expect(harness.clicks.filter((entry) => entry.startsWith('option'))).toEqual([]);
  });
});
