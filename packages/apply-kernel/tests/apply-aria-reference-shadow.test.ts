import { afterEach, describe, expect, it } from 'vitest';
import { createScanRoot, resolveAriaReference } from '../src/scanRoot';
import { fillListboxCombobox } from '../src/write/listboxCombobox';
import { consumeAuthority, mintAuthority, type HostWriteAuthority } from '../src/grant';
import { createBundledApplyPolicy } from '../src/policy';
import { createUndoJournal } from '../src/undo';

/**
 * ARIA 的 id 引用（`aria-controls` / `aria-owns`）是**节点树内**的引用，不是文档级的。
 *
 * 触发器在 shadow root 里时，它指向的 `[role=listbox]` 通常也在同一棵影子树里，
 * 而 `document.getElementById` 不穿透影子边界——返回 null。上层看到的现象是
 * 「菜单一直没打开」（WIDGET_TIMEOUT / CHOICE_NO_DATA），与「这家部件坏了」
 * 完全分不开。整张表都在 shadow root 里的厂商（2026-09-15 实测：SmartRecruiters
 * 的 one-click 表单，8 个以上影子宿主，每个 role=combobox 的 aria-controls 都指向
 * 同一影子树内的列表）会整类失效，而且失败是静默的。
 *
 * 这里锁两件事：解析器从引用者自己的 root 开始找；listbox 写入器因此能在影子树里
 * 找到菜单、点中选项并回读。
 */
afterEach(() => {
  document.body.innerHTML = '';
});

function fillAuthority(fingerprint: string): HostWriteAuthority {
  const host = document.createElement('div');
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const button = document.createElement('button');
  shadowRoot.appendChild(button);
  const event = new Event('click', { bubbles: true, composed: true });
  Object.defineProperty(event, 'isTrusted', { value: true });
  Object.defineProperty(event, 'composedPath', {
    value: () => [button, shadowRoot, host, document.body, document, window],
  });
  const minted = mintAuthority({
    event,
    shadowRoot,
    purpose: 'fill',
    fingerprint,
    capabilities: new Set(['set-text', 'set-combobox']),
  });
  if (!minted.ok) throw new Error(minted.code);
  // runApplyPlan 在进写入循环前做这一步；直调写入器时必须自己做，否则票据
  // 还没进入 active 集合，点击原语一律判 GESTURE_UNTRUSTED。
  const active = consumeAuthority(minted.value);
  if (!active.ok) throw new Error(active.code);
  return active.value;
}

describe('resolveAriaReference', () => {
  it('finds a reference in the document tree', () => {
    document.body.innerHTML = '<input id="t" aria-controls="menu"><ul id="menu"></ul>';
    const trigger = document.getElementById('t')!;
    expect(resolveAriaReference(trigger, 'menu')).toBe(document.getElementById('menu'));
  });

  it('finds a reference that lives in the referrer\'s own shadow tree', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<input id="t" aria-controls="menu"><ul id="menu" role="listbox"></ul>';
    const trigger = shadow.getElementById
      ? shadow.getElementById('t')!
      : (shadow.querySelector('#t') as Element);

    // 这一行是本修复的反证：文档级查找在影子树里什么都找不到。
    expect(document.getElementById('menu')).toBeNull();
    expect(resolveAriaReference(trigger, 'menu')).toBe(shadow.querySelector('#menu'));
  });

  it('never reaches into a different tree, and an empty or unknown id resolves to nothing', () => {
    document.body.innerHTML = '<ul id="menu"></ul>';
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<input id="t">';
    const trigger = shadow.querySelector('#t') as Element;

    expect(resolveAriaReference(trigger, 'menu')).toBeNull();
    expect(resolveAriaReference(trigger, '')).toBeNull();
    expect(resolveAriaReference(document.body, 'nope')).toBeNull();
  });
});

/**
 * 影子树里的一个 ARIA listbox combobox：触发器本身是显示位（Rippling / Ashby /
 * SmartRecruiters 三家实测都是这个形态），菜单与选项在同一棵影子树内。
 */
function mountShadowCombobox(options: readonly string[]): {
  trigger: HTMLInputElement;
  container: Element;
} {
  const host = document.createElement('oc-oneclick-form');
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <div class="field">
      <label for="city">City</label>
      <input id="city" role="combobox" aria-autocomplete="list" aria-haspopup="listbox"
             aria-expanded="false" aria-controls="city-menu">
      <ul id="city-menu" role="listbox" hidden></ul>
    </div>`;
  const trigger = shadow.querySelector('#city') as HTMLInputElement;
  const menu = shadow.querySelector('#city-menu') as HTMLElement;
  const render = () => {
    const query = trigger.value.trim().toLowerCase();
    const matches = query === '' ? [] : options.filter((option) => option.toLowerCase().includes(query));
    menu.innerHTML = matches
      .map((option) => `<li role="option">${option}</li>`)
      .join('');
    menu.hidden = matches.length === 0;
    for (const option of menu.querySelectorAll('[role="option"]')) {
      option.addEventListener('click', () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          trigger,
          option.textContent ?? '',
        );
        menu.innerHTML = '';
        menu.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
      });
    }
  };
  trigger.addEventListener('mousedown', () => {
    trigger.setAttribute('aria-expanded', 'true');
    render();
  });
  trigger.addEventListener('input', render);
  return { trigger, container: host };
}

describe('listbox combobox inside a shadow tree', () => {
  it('opens the menu, picks the candidate and reads the trigger back', async () => {
    const { trigger, container } = mountShadowCombobox([
      'San Francisco, California, United States',
      'San Diego, California, United States',
    ]);
    const root = createScanRoot(container, []);
    const journal = createUndoJournal();
    const outcome = await fillListboxCombobox({
      trigger,
      binding: { valueContainerSelector: '.field', selectedValueSelector: '#city' },
      candidates: ['San Francisco, CA, United States'],
      root,
      authority: fillAuthority('fp-shadow'),
      ticket: journal.record(trigger),
      policy: createBundledApplyPolicy(Date.now()),
      fillEmptyOnly: true,
      fence: () => null,
      lateRecheckMs: 10,
      waitMs: 500,
    });

    expect(outcome).toEqual({ ok: true, value: expect.any(String) });
    expect(trigger.value).toBe('San Francisco, California, United States');
  });
});

/**
 * SmartRecruiters 的 one-click City（jobs.smartrecruiters.com/oneclick-ui，
 * 2026-09-15 只读实测）：同样是 ARIA listbox combobox、触发器兼显示位，但它把
 * 部件**拆在两棵影子树里**——
 *
 *   oc-location-autocomplete                      （scan root 之内的 light DOM）
 *   └ spl-autocomplete           #shadow-root
 *     └ spl-dropdown
 *       ├ div.c-spl-autocomplete-trigger
 *       │ └ spl-input            #shadow-root
 *       │   └ div.c-spl-input-wrapper
 *       │     └ input[role=combobox][aria-controls="menu-spl-form-element_10"]
 *       └ div#menu-spl-form-element_10[role=listbox]
 *
 * 触发器在**里面那棵**树里，它 `aria-controls` 指的菜单在**外面那棵**树里，
 * 于是这条引用在它自己的树里是悬空的：`resolveAriaReference` 如实返回 null，
 * 写入器判定「菜单从没打开」，这一栏报 WIDGET_TIMEOUT。实测基线里它的表现是
 * `city "City" CAPABILITY_DISABLED`（还没有 binding）——补上 binding 之后，若不
 * 同时解决跨树解析，它只会从一种静默失败换成另一种。
 */
function mountNestedShadowCombobox(
  options: readonly string[],
  /**
   * 实测 SmartRecruiters 的十一行是 `<spl-select-option>`，**没有 role=option**。
   * 默认仍渲染成 role=option（其余四家的形态），传 'spl-select-option' 复现这一家。
   */
  rowTag: 'role-option' | 'spl-select-option' = 'role-option',
): {
  trigger: HTMLInputElement;
  container: Element;
  menuId: string;
} {
  const menuId = 'menu-spl-form-element_10';
  const container = document.createElement('oc-oneclick-form');
  document.body.appendChild(container);
  const widget = document.createElement('oc-location-autocomplete');
  container.appendChild(widget);

  const outerHost = document.createElement('spl-autocomplete');
  widget.appendChild(outerHost);
  const outer = outerHost.attachShadow({ mode: 'open' });
  outer.innerHTML = `
    <spl-dropdown class="c-spl-autocomplete-dropdown">
      <div class="c-spl-autocomplete-trigger"><spl-input></spl-input></div>
      <div id="${menuId}" role="listbox" slot="menu"></div>
    </spl-dropdown>`;

  const innerHost = outer.querySelector('spl-input') as Element;
  const inner = innerHost.attachShadow({ mode: 'open' });
  inner.innerHTML = `
    <div class="c-spl-input-grid"><div class="c-spl-input-wrapper">
      <input class="c-spl-input" role="combobox" aria-haspopup="listbox"
             aria-autocomplete="list" aria-expanded="false" aria-controls="${menuId}"
             data-sr-id="location-autocomplete-search-search-input">
    </div></div>`;

  const trigger = inner.querySelector('input') as HTMLInputElement;
  const menu = outer.querySelector(`#${menuId}`) as HTMLElement;
  const render = (): void => {
    const query = trigger.value.trim().toLowerCase();
    const matches = query === '' ? [] : options.filter((option) => option.toLowerCase().includes(query));
    menu.innerHTML = matches
      .map((option) =>
        rowTag === 'role-option'
          ? `<div role="option">${option}</div>`
          : `<spl-select-option><div class="c-spl-autocomplete-option-content">${option}</div></spl-select-option>`)
      .join('');
    for (const option of menu.querySelectorAll(rowTag === 'role-option' ? '[role="option"]' : 'spl-select-option')) {
      option.addEventListener('click', () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          trigger,
          option.textContent ?? '',
        );
        menu.innerHTML = '';
        trigger.setAttribute('aria-expanded', 'false');
      });
    }
  };
  trigger.addEventListener('mousedown', () => {
    trigger.setAttribute('aria-expanded', 'true');
    render();
  });
  trigger.addEventListener('input', render);
  return { trigger, container, menuId };
}

const nestedBinding = {
  valueContainerSelector: '.c-spl-input-wrapper',
  selectedValueSelector: 'input[data-sr-id="location-autocomplete-search-search-input"]',
};

describe('listbox combobox whose menu lives one shadow root out', () => {
  it('has a reference that dangles in the trigger\'s own tree — that is what needed fixing', () => {
    const { trigger, menuId } = mountNestedShadowCombobox(['San Francisco, CA, US']);
    // 反证：规范内的同树解析在这一家身上什么都找不到，所以写入器必须另有出路。
    expect(resolveAriaReference(trigger, menuId)).toBeNull();
    expect(document.getElementById(menuId)).toBeNull();
  });

  it('resolves the menu through the verified scan root and fills the field', async () => {
    const { trigger, container } = mountNestedShadowCombobox([
      'San Francisco, CA, US',
      'San Diego, CA, US',
    ]);
    const root = createScanRoot(container, []);
    const journal = createUndoJournal();
    const outcome = await fillListboxCombobox({
      trigger,
      binding: nestedBinding,
      candidates: ['San Francisco'],
      root,
      authority: fillAuthority('fp-nested-shadow'),
      ticket: journal.record(trigger),
      policy: createBundledApplyPolicy(Date.now()),
      fillEmptyOnly: true,
      fence: () => null,
      lateRecheckMs: 10,
      waitMs: 500,
    });

    expect(outcome).toEqual({ ok: true, value: 'San Francisco, CA, US' });
    expect(trigger.value).toBe('San Francisco, CA, US');
  });

  it('refuses when a second element in the root carries the same id', async () => {
    const { trigger, container, menuId } = mountNestedShadowCombobox(['San Francisco, CA, US']);
    // 同一个 id 出现两次：哪一个是这个触发器控制的菜单无法证明，于是一个都不认。
    const decoy = document.createElement('div');
    decoy.id = menuId;
    decoy.setAttribute('role', 'listbox');
    container.appendChild(decoy);

    const root = createScanRoot(container, []);
    const journal = createUndoJournal();
    const outcome = await fillListboxCombobox({
      trigger,
      binding: nestedBinding,
      candidates: ['San Francisco'],
      root,
      authority: fillAuthority('fp-nested-ambiguous'),
      ticket: journal.record(trigger),
      policy: createBundledApplyPolicy(Date.now()),
      fillEmptyOnly: true,
      fence: () => null,
      lateRecheckMs: 10,
      waitMs: 200,
    });

    // 解析不出菜单 = 从没看到过任何选项，如实报 CHOICE_NO_DATA；
    // 关键保证是没有点中任何东西，搜索词也没留在框里冒充选中值。
    expect(outcome).toEqual({ ok: false, code: 'CHOICE_NO_DATA' });
    expect(trigger.value).toBe('');
  });

  it('never resolves a menu that sits outside the verified container', async () => {
    const { trigger, container, menuId } = mountNestedShadowCombobox([]);
    // 菜单被搬到申请容器之外：跨树兜底只搜受验证容器，容器外的同 id 元素不算数。
    const outside = document.createElement('div');
    outside.id = menuId;
    outside.setAttribute('role', 'listbox');
    outside.innerHTML = '<div role="option">San Francisco, CA, US</div>';
    document.body.appendChild(outside);

    const root = createScanRoot(container, []);
    const journal = createUndoJournal();
    const outcome = await fillListboxCombobox({
      trigger,
      binding: nestedBinding,
      candidates: ['San Francisco'],
      root,
      authority: fillAuthority('fp-nested-outside'),
      ticket: journal.record(trigger),
      policy: createBundledApplyPolicy(Date.now()),
      fillEmptyOnly: true,
      fence: () => null,
      lateRecheckMs: 10,
      waitMs: 200,
    });

    // 容器外那份菜单里就有能匹配上的选项——没填上恰恰证明我们没去够它。
    expect(outcome).toEqual({ ok: false, code: 'CHOICE_NO_DATA' });
    expect(trigger.value).toBe('');
  });
});

/**
 * 同一个部件的第二道坎（2026-09-15 同次实测）：菜单是规规矩矩的
 * `div[role=listbox]`，但它填进去的十一行是 `<spl-select-option>` 自定义元素，
 * `menu.querySelectorAll('[role=option]')` 返回 **0**。通用扫法看到的是一个空菜单，
 * 而列表明明就在屏幕上——字段报 CHOICE_NO_DATA，和「这家没搜到结果」分不开。
 *
 * 规则量到这个形态之后可以声明 `optionSelector`；它只在**这个触发器 aria-controls
 * 指到的那个 listbox 之内**套用，点击边界再从活 DOM 自证 ruleDeclaredOption。
 */
const declaredRowBinding = { ...nestedBinding, optionSelector: 'spl-select-option' };

describe('listbox whose rows carry no role=option', () => {
  it('没有 optionSelector 时如实报「没看到选项」，一个都不点', async () => {
    const { trigger, container } = mountNestedShadowCombobox(
      ['San Francisco, CA, US'],
      'spl-select-option',
    );
    const root = createScanRoot(container, []);
    const journal = createUndoJournal();
    const outcome = await fillListboxCombobox({
      trigger,
      binding: nestedBinding,
      candidates: ['San Francisco'],
      root,
      authority: fillAuthority('fp-roleless-undeclared'),
      ticket: journal.record(trigger),
      policy: createBundledApplyPolicy(Date.now()),
      fillEmptyOnly: true,
      fence: () => null,
      lateRecheckMs: 10,
      waitMs: 300,
    });

    expect(outcome).toEqual({ ok: false, code: 'CHOICE_NO_DATA' });
    // 打过字就必须还原：搜索词绝不留在这个兼作显示位的框里冒充选中值。
    expect(trigger.value).toBe('');
  });

  it('声明 optionSelector 之后点中那一行并回读', async () => {
    const { trigger, container } = mountNestedShadowCombobox(
      ['San Francisco, CA, US', 'San Diego, CA, US'],
      'spl-select-option',
    );
    const root = createScanRoot(container, []);
    const journal = createUndoJournal();
    const outcome = await fillListboxCombobox({
      trigger,
      binding: declaredRowBinding,
      candidates: ['San Francisco'],
      root,
      authority: fillAuthority('fp-roleless-declared'),
      ticket: journal.record(trigger),
      policy: createBundledApplyPolicy(Date.now()),
      fillEmptyOnly: true,
      fence: () => null,
      lateRecheckMs: 10,
      waitMs: 500,
    });

    expect(outcome).toEqual({ ok: true, value: 'San Francisco, CA, US' });
    expect(trigger.value).toBe('San Francisco, CA, US');
  });

  it('声明的行选择器只在这个触发器自己的菜单里生效', async () => {
    const { trigger, container } = mountNestedShadowCombobox([], 'spl-select-option');
    // 同一个容器里另有一份长得一模一样的列表，但它不是这个触发器 aria-controls 指的那个。
    const decoyMenu = document.createElement('div');
    decoyMenu.setAttribute('role', 'listbox');
    decoyMenu.innerHTML = '<spl-select-option>San Francisco, CA, US</spl-select-option>';
    container.appendChild(decoyMenu);

    const root = createScanRoot(container, []);
    const journal = createUndoJournal();
    const outcome = await fillListboxCombobox({
      trigger,
      binding: declaredRowBinding,
      candidates: ['San Francisco'],
      root,
      authority: fillAuthority('fp-roleless-scoped'),
      ticket: journal.record(trigger),
      policy: createBundledApplyPolicy(Date.now()),
      fillEmptyOnly: true,
      fence: () => null,
      lateRecheckMs: 10,
      waitMs: 300,
    });

    expect(outcome).toEqual({ ok: false, code: 'CHOICE_NO_DATA' });
    expect(trigger.value).toBe('');
  });
});
