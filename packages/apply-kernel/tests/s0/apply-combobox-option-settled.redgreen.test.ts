import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  selectComboboxOption,
  type ComboboxOptionSource,
  type ComboboxSemanticTransactionSource,
} from '../../src/click/combobox';
import { consumeAuthority, type HostWriteAuthority } from '../../src/grant';
import { createScanRoot } from '../../src/scanRoot';
import { createUndoJournal } from '../../src/undo';
import { testApplyPolicy, testAuthority } from '../helpers/applyTestAuthority';

/**
 * S0 · CAP-AF-004 **选项集稳定性闸门的接线证明**。
 *
 * `apply-option-search.test.ts` 已经把判定逻辑本身钉住了。这个文件回答另一个问题：
 * **那个闸门真的接在 `selectComboboxOption` 这条真实路径上吗**——这个仓库在
 * "写了、测了、没人调用"上栽过 7 次，纯函数绿不代表生产路径变了。
 *
 * 场景取自真实的分批加载：`combobox.ts` 头部实测「同一 tick 0 个选项，一个宏任务后
 * 244 个」。244 个不是一次到位的，中间存在一个"只加载了一部分"的窗口。
 *
 * 在那个窗口里，阶梯的**低阶**（第 4 级词边界前缀）可能唯一命中一项，而列表完整后
 * 本该由**高阶**（第 1 级原文精确）命中**另一项**。两次都"成功"，选中的却不是同一个
 * 选项——下拉是收起的，用户看不见我们把 "LinkedIn" 填成了 "LinkedIn Recruiter"。
 *
 * 因此这里断言的是**最终选中了哪一项**，不是"有没有报错"。
 */

const pendingTimers: ReturnType<typeof setTimeout>[] = [];

const testOptionSource: ComboboxOptionSource = {
  read: (_trigger, root) => root.querySelectorAll('[role="option"]').map((element) => ({
    element,
    text: element.textContent ?? '',
  })),
  isOpen: (trigger) => trigger.getAttribute('aria-expanded') === 'true',
};

const testSemanticTransactions: ComboboxSemanticTransactionSource = {
  snapshot: (trigger, root) => {
    const previous = trigger.value;
    const previousBacking = trigger.dataset.selectedBacking;
    const ownsEventTarget = (target: EventTarget | null) =>
      target === trigger ||
      (target instanceof Element && root.querySelectorAll('[role="option"]').includes(target));
    return {
      canRestorePreWrite: () =>
        trigger.value === previous && trigger.dataset.selectedBacking === previousBacking,
      restorePreWrite: () => {
        trigger.value = previous;
        if (previousBacking === undefined) delete trigger.dataset.selectedBacking;
        else trigger.dataset.selectedBacking = previousBacking;
        return true;
      },
      isAtPreWriteState: () =>
        trigger.value === previous && trigger.dataset.selectedBacking === previousBacking,
      ownsEventTarget,
      captureWrittenState: (expected) => ({
        isAtWrittenState: () => trigger.dataset.selectedBacking === expected,
        restorePreWrite: () => {
          trigger.value = previous;
          if (previousBacking === undefined) delete trigger.dataset.selectedBacking;
          else trigger.dataset.selectedBacking = previousBacking;
          return true;
        },
        isAtPreWriteState: () =>
          trigger.value === previous && trigger.dataset.selectedBacking === previousBacking,
        ownsEventTarget,
        wasUserEdited: () => false,
        dispose: () => undefined,
      }),
    };
  },
};

afterEach(() => {
  for (const timer of pendingTimers.splice(0)) clearTimeout(timer);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

interface Harness {
  readonly trigger: HTMLInputElement;
  readonly form: HTMLFormElement;
  /** 我们实际点中的选项文案，按顺序。断言的就是它。 */
  readonly clickedOptions: string[];
  /** 分批把选项填进菜单，复刻真实的异步加载。 */
  openInBatches(batches: ReadonlyArray<{ readonly labels: readonly string[]; readonly afterMs: number }>): void;
  /** 每个宏任务都换一批：模拟永不稳定的列表。 */
  openNeverSettling(afterMs: number): void;
}

function mountCombobox(): Harness {
  document.body.innerHTML = `
    <form id="application-form">
      <fieldset>
        <label id="source-label" for="source">How Did You Hear About Us?</label>
        <div class="select-shell">
          <div class="select__input-container">
            <input id="source" type="text" role="combobox"
                   aria-expanded="false" aria-haspopup="true" aria-labelledby="source-label" />
          </div>
          <div class="select__menu-slot"></div>
        </div>
      </fieldset>
    </form>`;
  const form = document.querySelector('form') as HTMLFormElement;
  const trigger = document.getElementById('source') as HTMLInputElement;
  const slot = form.querySelector('.select__menu-slot') as HTMLElement;
  const clickedOptions: string[] = [];

  const appendOption = (label: string): void => {
    const option = document.createElement('div');
    option.setAttribute('role', 'option');
    option.textContent = label;
    option.addEventListener('click', () => {
      clickedOptions.push(label);
      trigger.value = label;
      trigger.dataset.selectedBacking = label;
      trigger.setAttribute('aria-expanded', 'false');
      slot.replaceChildren();
    });
    slot.appendChild(option);
  };

  return {
    trigger,
    form,
    clickedOptions,
    openInBatches(batches) {
      trigger.addEventListener(
        'click',
        () => {
          trigger.setAttribute('aria-expanded', 'true');
          for (const batch of batches) {
            pendingTimers.push(
              setTimeout(() => {
                for (const label of batch.labels) appendOption(label);
              }, batch.afterMs),
            );
          }
        },
        { once: true },
      );
    },
    openNeverSettling(afterMs) {
      let generation = 0;
      trigger.addEventListener(
        'click',
        () => {
          trigger.setAttribute('aria-expanded', 'true');
          const tick = () => {
            generation += 1;
            slot.replaceChildren();
            appendOption(`Option ${generation}`);
            pendingTimers.push(setTimeout(tick, afterMs));
          };
          pendingTimers.push(setTimeout(tick, afterMs));
        },
        { once: true },
      );
    },
  };
}

function activeAuthority(): HostWriteAuthority {
  const authority = testAuthority('combobox-plan', 'fill', ['set-text', 'set-select', 'set-combobox']);
  const consumed = consumeAuthority(authority);
  expect(consumed.ok, '测试前置：授权没能进入运行态').toBe(true);
  return authority;
}

function run(harness: Harness, desired: string, alternates?: readonly string[]) {
  return selectComboboxOption({
    trigger: harness.trigger,
    previousRawValue: harness.trigger.value,
    desired,
    alternates,
    root: createScanRoot(harness.form, []),
    optionSource: testOptionSource,
    semanticTransactionSource: testSemanticTransactions,
    authority: activeAuthority(),
    ticket: createUndoJournal().record(harness.trigger),
    policy: testApplyPolicy(),
    readSelection: (trigger, expected) =>
      trigger.dataset.selectedBacking === expected ? expected : null,
  });
}

describe('CAP-AF-004 · 稳定性闸门接在真实下拉路径上', () => {
  it('分批加载时选中的是完整列表该选的那一项，不是半加载时唯一命中的那一项', async () => {
    const harness = mountCombobox();
    // 第一批只有更长的那项：此刻 "LinkedIn" 走第 4 级前缀，唯一命中它。
    // 第二批才把精确项加载出来：完整列表下正确答案是第 1 级精确命中的 "LinkedIn"。
    harness.openInBatches([
      { labels: ['LinkedIn Recruiter'], afterMs: 0 },
      { labels: ['LinkedIn'], afterMs: 4 },
    ]);

    const result = await run(harness, 'LinkedIn');

    expect(result.ok, '应当选中一项').toBe(true);
    // 这一行就是闸门的全部价值。没有闸门时它会是 'LinkedIn Recruiter'。
    expect(harness.clickedOptions).toEqual(['LinkedIn']);
  });

  it('列表始终不稳定时放弃并交还用户，绝不在移动的列表上下判决', async () => {
    const harness = mountCombobox();
    harness.openNeverSettling(1);

    const result = await run(harness, 'Option 1', undefined);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('WIDGET_TIMEOUT');
    // 一次都不许点：宁可这个字段留空。
    expect(harness.clickedOptions).toEqual([]);
  });

  it('有序备选也接在真实路径上：首选不在宿主选项里时按序回退', async () => {
    const harness = mountCombobox();
    harness.openInBatches([
      { labels: ['Job Fair', 'LinkedIn', 'Referral'], afterMs: 0 },
    ]);

    const result = await run(harness, 'Jobright', ['LinkedIn']);

    expect(result.ok, '应当回退到备选并选中').toBe(true);
    expect(harness.clickedOptions).toEqual(['LinkedIn']);
  });
});
