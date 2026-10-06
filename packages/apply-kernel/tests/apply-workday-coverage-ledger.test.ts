import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { classifyControl } from '../src/dict/controls';
import { isPhoneMetaField } from '../src/dict/guards';
import { APPLY_FIELD_KEYS } from '../src/contracts';

/**
 * Workday step 2「My Information」的**覆盖率账本**。
 *
 * 结构取自真实申请流程（2026-08-21，Mike 已登录的会话里只读实测：未填写任何
 * 字段、未点击任何按钮、未推进流程）。
 *
 * 这个文件不测 adapter 行为；`apply-workday-adapter.test.ts` 已单独锁住登录后
 * My Information 的四个低风险文本字段。本文件继续回答：其余字段为什么不能填，
 * 以及真实结构变化后要重算多少工作。它是 Workday 排期账本，不是完成声明。
 *
 * ## 三种控件形态，只有第一种今天有写入原语
 *
 *   `input[type=text]`               —— 普通文本，有原语
 *   `button[aria-haspopup="listbox"]` —— **自定义下拉，不是 <select>**，无原语（CAP-AF-004）
 *   `input[autocomplete=off]` 无 type —— 带远程建议的 typeahead，无原语（CAP-AF-004）
 *   `input[type=radio|checkbox]`      —— choice，无写入链（CAP-AF-001）
 *
 * ## 整页没有 <form>
 *
 * 四家现行适配器都锚在 `form#...` 上，这一家锚不了。Workday 适配器必须锚
 * `[data-automation-id="applyFlowMyInfoPage"]`——这是接它时第一件要改的事。
 */

const FIXTURE = readFileSync(
  resolve(__dirname, 'fixtures/workday/my-information-step2.html'),
  'utf8',
);

afterEach(() => {
  document.body.innerHTML = '';
});

function mount(): void {
  document.body.innerHTML = FIXTURE;
}

const wrapperOf = (key: string) =>
  document.querySelector<HTMLElement>(`div[data-automation-id="formField-${key}"]`);
const controlOf = (key: string) =>
  wrapperOf(key)?.querySelector<HTMLElement>('input, button, select, textarea') ?? null;
const labelOf = (key: string) => wrapperOf(key)?.querySelector('label')?.textContent?.trim() ?? '';

describe('结构前提', () => {
  it('整页没有 <form>——现有四家的锚点方式在这里不适用', () => {
    mount();
    expect(
      document.querySelectorAll('form'),
      '如果这条变绿了说明 Workday 改版加了 form，适配器的锚点策略要重评',
    ).toHaveLength(0);
    expect(document.querySelector('[data-automation-id="applyFlowMyInfoPage"]')).not.toBeNull();
  });

  it('label 用规规矩矩的 for，标签级联第一步就能拿到', () => {
    mount();
    const label = wrapperOf('legalName--firstName')!.querySelector('label')!;
    const control = controlOf('legalName--firstName')!;
    expect(label.getAttribute('for')).toBe(control.id);
  });
});

describe('现有普通文本原语与档案键已经覆盖的', () => {
  it.each([
    ['legalName--firstName', 'firstName'],
    ['legalName--lastName', 'lastName'],
    ['city', 'city'],
    ['phoneNumber', 'phone'],
  ] as const)('%s → 有档案键 %s 且是可写控件', (wrapper, key) => {
    mount();
    expect(classifyControl(controlOf(wrapper)!), `${wrapper} 不是可写文本控件`).toBe('text');
    expect(APPLY_FIELD_KEYS, `${key} 不在 11 键档案里`).toContain(key);
  });
});

describe('缺档案键才填得了的（CAP-AF-021 直接解锁）', () => {
  it.each(['addressLine1', 'postalCode'] as const)('%s 是可写控件，但没有对应档案键', (wrapper) => {
    mount();
    // 控件本身没问题——纯文本框，写入原语现成的。卡的**只是没有值可填**。
    expect(classifyControl(controlOf(wrapper)!)).toBe('text');
    const label = labelOf(wrapper).toLowerCase();
    const covered = (APPLY_FIELD_KEYS as readonly string[]).some((k) =>
      label.includes(k.toLowerCase()),
    );
    expect(covered, `${wrapper} 居然有档案键了——账本要更新`).toBe(false);
  });
});

describe('缺写入原语才填得了的（CAP-AF-004 / CAP-AF-001）', () => {
  it.each(['country', 'countryRegion', 'phoneType'] as const)(
    '%s 是自定义下拉（button[aria-haspopup=listbox]），不是 <select>',
    (wrapper) => {
      mount();
      const control = controlOf(wrapper)!;
      expect(control.tagName.toLowerCase()).toBe('button');
      expect(control.getAttribute('aria-haspopup')).toBe('listbox');
      expect(
        classifyControl(control),
        '自定义下拉被当成可写控件了——写进去会静默失败而 UI 报已填',
      ).toBe('unsupported');
    },
  );

  it.each(['source', 'countryPhoneCode'] as const)('%s 是 typeahead，今天无原语', (wrapper) => {
    mount();
    const control = controlOf(wrapper)!;
    expect(control.getAttribute('autocomplete')).toBe('off');
    expect(control.getAttribute('type')).toBeNull();
  });

  it.each(['candidateIsPreviousWorker', 'preferredCheck'] as const)(
    '%s 是 choice，写入链未建（CAP-AF-001）',
    (wrapper) => {
      mount();
      expect(classifyControl(controlOf(wrapper)!)).toBe('choice');
    },
  );
});

describe('永远不填的', () => {
  it('⚠️ Phone Extension —— 电话元数据守卫正在防的就是这一栏', () => {
    mount();
    const label = labelOf('extension');
    expect(label).toBe('Phone Extension');
    expect(
      isPhoneMetaField(label),
      '守卫认不出这一栏——整串手机号会被写进分机栏，宿主截断成垃圾而我们报"已填"',
    ).toBe(true);
  });

  it('0×0 的隐藏控件存在——几何层在 Workday 上是真的在工作', () => {
    mount();
    const hidden = document.querySelector('[data-automation-id="phone-sms-opt-in"]');
    expect(hidden, '隐藏控件不见了').not.toBeNull();
    // 注意：这一栏被几何层判成蜜罐是**良性**的——它本来也没有 canonical key。
    // 但它说明几何层在这一家会真的开火，接 Workday 时要按真实页面复核误杀面。
    expect((hidden as HTMLElement).getAttribute('style')).toContain('width:0');
  });
});

describe('账本总数（Workday 排期的依据）', () => {
  it('14 个字段：adapter 基线 4、扩键 +2、缺原语 7、永不填 1', () => {
    mount();
    const wrappers = [...document.querySelectorAll('div[data-automation-id^="formField-"]')];
    expect(wrappers, '真实页面的字段数变了——排期依据要重算').toHaveLength(14);

    const adapterBaseline = ['legalName--firstName', 'legalName--lastName', 'city', 'phoneNumber'];
    const unlockedByKeys = ['addressLine1', 'postalCode'];
    const needPrimitive = [
      'country', 'countryRegion', 'phoneType', 'source', 'countryPhoneCode',
      'candidateIsPreviousWorker', 'preferredCheck',
    ];
    const never = ['extension'];

    expect(
      [...adapterBaseline, ...unlockedByKeys, ...needPrimitive, ...never].sort(),
      '账本没有覆盖全部字段——有字段没被归类',
    ).toEqual(
      wrappers.map((w) => w.getAttribute('data-automation-id')!.replace('formField-', '')).sort(),
    );
  });
});
