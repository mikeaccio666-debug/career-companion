import { afterEach, describe, expect, it, vi } from 'vitest';

import generic from '@edaix/apply-rules/generic.json';
import type { ApplyFormDescriptor, ApplyPlan } from '../src/contracts';
import { buildApplyPlan, capabilitiesForPlan } from '../src/engine';
import { runApplyPlan } from '../src/runner';
import { compileBundledAdapter } from '../src/rules/interpreter';
import { createUndoJournal } from '../src/undo';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

/**
 * 通用路上没有规则绑定的 ARIA 下拉（2026-09-28，write/ariaComboboxGeneric.ts）。
 *
 * 两种形状，都照公开组件库的标记手写（没有页面数据）：
 *  · `input[role=combobox]`：点开才出 `aria-controls` 指着的 listbox，listbox 渲染在表单外（MUI Autocomplete 一类）；
 *  · 藏起来的原生 `<select>`（display:none）+ 紧跟着的 `span[role=combobox][aria-owns=…-menu]`，菜单也在表单外
 *    （jQuery UI selectmenu，Hetzner 的「Land」）。
 */

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const row = (id: string, label: string, control = `<input id="${id}" type="text">`) =>
  `<div class="field"><label for="${id}">${label}</label>${control}</div>`;
const ANCHORS = `${row('mail', 'Email')}${row('li', 'LinkedIn')}${row('gh', 'GitHub')}${row('ph', 'Phone')}`;

function describeForm(): ApplyFormDescriptor {
  const adapter = compileBundledAdapter(generic as never);
  const root = adapter.resolveRoot(document, { generic: true } as never);
  if (root === null) throw new Error('generic root not found');
  return { vendor: 'generic', root, fields: [...adapter.scan(root, { generic: true } as never)], finalSubmitControl: null };
}

async function fill(plan: ApplyPlan, form: ApplyFormDescriptor) {
  const bundled = testApplyPolicy();
  return runApplyPlan({
    plan,
    auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForPlan(plan)]),
    journal: createUndoJournal(),
    root: form.root,
    // 通用路只由后端的包放行（随包 policy 关着）；这里模拟包里放行了它。
    policy: { ...bundled, vendors: { ...bundled.vendors, generic: true } },
    lateRecheckMs: 20,
  });
}

/** 一个 MUI Autocomplete 形状的部件：点开渲染表单外的 listbox，点选项写进输入框、关上。 */
function autocomplete(input: HTMLInputElement, options: readonly string[], counter?: { clicks: number }): void {
  const listboxId = `${input.id}-listbox`;
  const close = () => {
    document.getElementById(listboxId)?.remove();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-controls');
  };
  input.addEventListener('click', () => {
    if (counter) counter.clicks += 1;
    if (document.getElementById(listboxId)) return;
    const listbox = document.createElement('ul');
    listbox.id = listboxId;
    listbox.setAttribute('role', 'listbox');
    for (const text of options) {
      const option = document.createElement('li');
      option.setAttribute('role', 'option');
      option.textContent = text;
      option.addEventListener('click', () => {
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        close();
      });
      listbox.append(option);
    }
    document.body.append(listbox);
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', listboxId);
  });
  input.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Escape') close();
  });
}

const COUNTRY_INPUT = '<input id="country" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" class="MuiAutocomplete-input">';

describe('input[role=combobox]：点开它自己的面板，只选整条相等的一项', () => {
  it('国家：选上「United States」，读回两次，面板关上', async () => {
    document.body.innerHTML = `<form>${ANCHORS}${row('country', 'Country', COUNTRY_INPUT)}</form>`;
    const input = document.getElementById('country') as HTMLInputElement;
    autocomplete(input, ['Canada', 'United States', 'United States Minor Outlying Islands']);
    const form = describeForm();
    const plan = buildApplyPlan(form, { addressCountry: 'US' });
    expect(plan.entries.find((entry) => entry.key === 'addressCountry')?.kind).toBe('combobox');
    const summary = await fill(plan, form);
    expect(summary.results.find((result) => result.key === 'addressCountry')).toMatchObject({ ok: true });
    expect(input.value).toBe('United States');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('两项都叫这个名字：有歧义，一项都不点，面板关上，交还本人', async () => {
    document.body.innerHTML = `<form>${ANCHORS}${row('country', 'Country', COUNTRY_INPUT)}</form>`;
    const input = document.getElementById('country') as HTMLInputElement;
    autocomplete(input, ['United States', 'United States']);
    const form = describeForm();
    const summary = await fill(buildApplyPlan(form, { addressCountry: 'US' }), form);
    expect(summary.results.find((result) => result.key === 'addressCountry')).toMatchObject({ ok: false, reason: 'AMBIGUOUS_OPTION' });
    expect(input.value).toBe('');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('只有前缀对得上（「United States of America」）：不当成同一项', async () => {
    document.body.innerHTML = `<form>${ANCHORS}${row('country', 'Country', COUNTRY_INPUT)}</form>`;
    const input = document.getElementById('country') as HTMLInputElement;
    autocomplete(input, ['United States Minor Outlying Islands']);
    const form = describeForm();
    const summary = await fill(buildApplyPlan(form, { addressCountry: 'US' }), form);
    expect(summary.results.find((result) => result.key === 'addressCountry')?.ok).toBe(false);
    expect(input.value).toBe('');
  });

  it('点开找不到它自己的面板：交还本人；一模一样的第二个部件不再去点', async () => {
    document.body.innerHTML = `<form>${ANCHORS}
      ${row('country', 'Country', COUNTRY_INPUT)}
      ${row('city', 'City', '<input id="city" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" class="MuiAutocomplete-input">')}
    </form>`;
    const counter = { clicks: 0 };
    for (const id of ['country', 'city']) {
      document.getElementById(id)!.addEventListener('click', () => { counter.clicks += 1; });
    }
    const form = describeForm();
    const summary = await fill(buildApplyPlan(form, { addressCountry: 'US', city: 'San Francisco' }), form);
    expect(summary.results.find((result) => result.key === 'addressCountry')).toMatchObject({ ok: false, reason: 'WIDGET_TIMEOUT' });
    expect(summary.results.find((result) => result.key === 'city')).toMatchObject({ ok: false, reason: 'WIDGET_TIMEOUT' });
    expect(counter.clicks).toBe(1);
  }, 15_000);

  it('选中之后输入框清空、值显示在旁边（react-select v1，D. E. Shaw 的学校）：按这一栏自己容器里显示的那一项读回', async () => {
    document.body.innerHTML = `<form>${ANCHORS}
      <div class="field"><label for="country">Country</label>
        <div class="Select"><div class="Select-control"><span class="Select-value-label" role="option" aria-selected="true"></span>
          <input id="country" role="combobox" aria-expanded="false" aria-haspopup="false" aria-owns=""></div></div>
      </div></form>`;
    const input = document.getElementById('country') as HTMLInputElement;
    const shown = document.querySelector('.Select-value-label')!;
    input.addEventListener('click', () => {
      if (document.getElementById('rs-list')) return;
      const listbox = document.createElement('div');
      listbox.id = 'rs-list';
      listbox.setAttribute('role', 'listbox');
      for (const text of ['Canada', 'United States']) {
        const option = document.createElement('div');
        option.setAttribute('role', 'option');
        option.textContent = text;
        option.addEventListener('click', () => {
          shown.textContent = text;
          listbox.remove();
          input.setAttribute('aria-expanded', 'false');
          input.setAttribute('aria-owns', '');
        });
        listbox.append(option);
      }
      input.closest('.Select')!.append(listbox);
      input.setAttribute('aria-expanded', 'true');
      input.setAttribute('aria-owns', 'rs-list');
    });
    const form = describeForm();
    const summary = await fill(buildApplyPlan(form, { addressCountry: 'US' }), form);
    expect(summary.results.find((result) => result.key === 'addressCountry')).toMatchObject({ ok: true });
    expect(shown.textContent).toBe('United States');
  });

  it('点开是空面板（「Type to search」），打了字才出选项：打候选再选', async () => {
    document.body.innerHTML = `<form>${ANCHORS}${row('school', 'Country', '<input id="school" role="combobox" aria-expanded="false" aria-haspopup="false" aria-owns="">')}</form>`;
    const input = document.getElementById('school') as HTMLInputElement;
    const listbox = document.createElement('div');
    listbox.id = 'school-list';
    listbox.setAttribute('role', 'listbox');
    listbox.innerHTML = '<div class="noresults">Type to search</div>';
    input.addEventListener('click', () => {
      input.after(listbox);
      input.setAttribute('aria-expanded', 'true');
      input.setAttribute('aria-owns', 'school-list');
    });
    input.addEventListener('input', () => {
      listbox.replaceChildren(...['United States', 'United States Virgin Islands']
        .filter((text) => input.value !== '' && text.toLowerCase().startsWith(input.value.toLowerCase()))
        .map((text) => {
          const option = document.createElement('div');
          option.setAttribute('role', 'option');
          option.textContent = text;
          option.addEventListener('click', () => {
            input.value = text;
            listbox.remove();
            input.setAttribute('aria-expanded', 'false');
          });
          return option;
        }));
    });
    const form = describeForm();
    const summary = await fill(buildApplyPlan(form, { addressCountry: 'US' }), form);
    expect(summary.results.find((result) => result.key === 'addressCountry')).toMatchObject({ ok: true });
    expect(input.value).toBe('United States');
  });

  it('面板里的行都没声明 role=option（react-select v1 的自定义行）：交还本人，一模一样的第二个不再去点', async () => {
    document.body.innerHTML = `<form>${ANCHORS}
      ${row('country', 'Country', '<input id="country" role="combobox" aria-expanded="false" aria-haspopup="false" aria-owns="">')}
      ${row('city', 'City', '<input id="city" role="combobox" aria-expanded="false" aria-haspopup="false" aria-owns="">')}
    </form>`;
    const counter = { clicks: 0 };
    for (const id of ['country', 'city']) {
      const input = document.getElementById(id) as HTMLInputElement;
      input.addEventListener('click', () => {
        counter.clicks += 1;
        const listbox = document.createElement('div');
        listbox.id = `${id}-list`;
        listbox.setAttribute('role', 'listbox');
        listbox.innerHTML = '<div class="row">Canada</div><div class="row">United States</div><div class="row">Mexico</div>';
        input.after(listbox);
        input.setAttribute('aria-expanded', 'true');
        input.setAttribute('aria-owns', listbox.id);
      });
      input.addEventListener('keydown', () => {
        document.getElementById(`${id}-list`)?.remove();
        input.setAttribute('aria-expanded', 'false');
      });
    }
    const form = describeForm();
    const summary = await fill(buildApplyPlan(form, { addressCountry: 'US', city: 'San Francisco' }), form);
    expect(summary.results.find((result) => result.key === 'addressCountry')).toMatchObject({ ok: false, reason: 'OPTIONS_INCOMPLETE' });
    expect(summary.results.find((result) => result.key === 'city')).toMatchObject({ ok: false, reason: 'OPTIONS_INCOMPLETE' });
    expect(counter.clicks).toBe(1);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('厂商路上没有绑定的下拉照旧不碰', async () => {
    document.body.innerHTML = `<form>${ANCHORS}${row('country', 'Country', COUNTRY_INPUT)}</form>`;
    const input = document.getElementById('country') as HTMLInputElement;
    autocomplete(input, ['United States']);
    const form = { ...describeForm(), vendor: 'greenhouse' as const };
    const summary = await fill(buildApplyPlan(form, { addressCountry: 'US' }), form);
    expect(summary.results.find((result) => result.key === 'addressCountry')).toMatchObject({ ok: false, reason: 'CAPABILITY_DISABLED' });
    expect(input.value).toBe('');
  });
});

/** jQuery UI selectmenu 形状：原生下拉 display:none，紧跟着一个 span[role=combobox]，菜单挂在 body 上。 */
function selectmenu(select: HTMLSelectElement): HTMLElement {
  const button = document.createElement('span');
  button.id = `${select.id}-button`;
  button.tabIndex = 0;
  button.setAttribute('role', 'combobox');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-autocomplete', 'list');
  button.setAttribute('aria-owns', `${select.id}-menu`);
  button.setAttribute('aria-haspopup', 'true');
  button.className = 'ui-selectmenu-button ui-button';
  button.textContent = select.options[select.selectedIndex]?.text ?? '';
  select.after(button);
  const menu = document.createElement('ul');
  menu.id = `${select.id}-menu`;
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-hidden', 'true');
  for (const option of [...select.options].slice(1)) {
    const item = document.createElement('li');
    const row = document.createElement('div');
    row.setAttribute('role', 'option');
    row.textContent = option.text;
    row.addEventListener('click', () => {
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      button.textContent = option.text;
      menu.setAttribute('aria-hidden', 'true');
      button.setAttribute('aria-expanded', 'false');
    });
    item.append(row);
    menu.append(item);
  }
  document.body.append(menu);
  button.addEventListener('click', () => {
    menu.setAttribute('aria-hidden', 'false');
    button.setAttribute('aria-expanded', 'true');
  });
  return button;
}

const LAND = `<select id="country" name="bewerbung_form[country]" aria-labelledby="country_caption" style="display: none;"><option value="">---</option><option value="DE">Deutschland</option><option value="US">Vereinigte Staaten</option></select>`;
/** 与生产读法同形的几何桩：藏起来的下拉 0×0，别的都看得见。 */
const geometry = (element: Element) => (element.localName === 'select' ? { width: 0, height: 0, left: 0, right: 0 } : { width: 200, height: 32, left: 40, right: 240 });

describe('藏起来的原生下拉 + 替它说话的 ARIA 触发器', () => {
  it('点触发器、在它自己的菜单里选，读回原生下拉的选中项', async () => {
    document.body.innerHTML = `<form>${ANCHORS}<div class="field"><label for="country-button" id="country_caption">Land</label><div class="input_box">${LAND}</div></div></form>`;
    const button = selectmenu(document.getElementById('country') as HTMLSelectElement);
    const form = describeForm();
    const plan = buildApplyPlan(form, { addressCountry: 'US' }, { readGeometry: geometry });
    const entry = plan.entries.find((candidate) => candidate.key === 'addressCountry');
    expect(entry).toMatchObject({ kind: 'select', value: 'Vereinigte Staaten' });
    expect(entry?.kind === 'select' ? entry.selectProxy : null).toBe(button);
    const summary = await fill(plan, form);
    expect(summary.results.find((result) => result.key === 'addressCountry')).toMatchObject({ ok: true });
    expect((document.getElementById('country') as HTMLSelectElement).value).toBe('US');
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('旁边没有这样的触发器：藏起来的下拉照旧当陷阱，不写', () => {
    document.body.innerHTML = `<form>${ANCHORS}<div class="field"><label for="country" id="country_caption">Land</label>${LAND}</div></form>`;
    const form = describeForm();
    const plan = buildApplyPlan(form, { addressCountry: 'US' }, { readGeometry: geometry });
    expect(plan.entries.find((candidate) => candidate.key === 'addressCountry')).toBeUndefined();
    expect(plan.skipped.find((candidate) => candidate.key === 'addressCountry')?.reason).toBe('HONEYPOT');
  });
});
