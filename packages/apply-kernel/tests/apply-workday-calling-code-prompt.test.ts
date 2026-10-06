import { afterEach, describe, expect, it } from 'vitest';

import workday from '@edaix/apply-rules/workday.json';
import type { ApplyFormDescriptor } from '../src/contracts';
import { buildAuditView } from '../src/audit';
import { buildApplyPlan } from '../src/engine';
import { consumeAuthority, mintAuthority, type HostWriteAuthority } from '../src/grant';
import { compileBundledAdapter } from '../src/rules/interpreter';
import { runApplyPlan } from '../src/runner';
import { createScanRoot } from '../src/scanRoot';
import { createUndoJournal } from '../src/undo';
import { capabilitiesForKinds } from '../src/write/allowlist';
import { fillSearchPrompt } from '../src/write/searchPrompt';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

/**
 * Workday 第 1 页的「Country Phone Code」（2026-09-28 adobe.wd5 测试台，只读实测结构）。
 *
 * 它是 Workday 的 selectinput 单选：`input#phoneNumber--countryPhoneCode`（aria-required、placeholder「Search」）
 * 外面是 `multiSelectContainer`，选中的值是里面的 `selectedItem`（「United States of America (+1)」）。Workday 按
 * Country 自己带出一项；从前规则没有声明它，扫描把那个搜索框当成**普通文本框**、认不出键——一个空的必填
 * 文本框，浮层列成「我们没认出这一题」，连填因此停在第 1 页（其实网站早就选好了）。
 *
 * 现在：规则把它声明成一值的 searchPromptComboboxes（与 Field of Study 同一套部件）。内核按题面认出它是
 * 电话的国际区号（与 2026-09-28 Zalando 的原生区号下拉同一个判据），条目记在电话名下：
 *  · 已经选着一项：页面上本来就有，不动它，不算「需要你」；
 *  · 空着：只按号码自己写明的区号挑，国名取居住国，搜的是「国名 (+区号)」；宿主自己选上的那一项区号不对就照实
 *    报 VALUE_COERCED，好几行都带这个区号时按居住国的国名收窄到恰好一行才点；
 *  · 号码没写区号：不猜（「地址在美国、手机 +86」的人按地址选会被拨错国家），交还本人。
 *
 * 下面的宿主部件按实测的样子复刻行为（不是 Workday 的代码）：回车才搜，只有一个结果时自己选上。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const CODES = [
  'Afghanistan (+93)', 'American Samoa (+1)', 'Canada (+1)', 'China (+86)', 'Germany (+49)', 'Korea, Republic of (+82)',
  'United Kingdom (+44)', 'United States Minor Outlying Islands (+1)', 'United States of America (+1)',
];

const label = (text: string, required: boolean) => `<span>${text}${required ? '<abbr aria-hidden="true">*</abbr>' : ''}</span>`;

const listbox = (field: string, fkit: string, text: string, required: boolean, shown = 'Select One') => `
  <div data-automation-id="formField-${field}" data-fkit-id="${fkit}">
    <label for="${fkit}">${label(text, required)}</label>
    <div><div><div><button id="${fkit}" name="${field}" type="button" aria-haspopup="listbox">${shown}</button><input type="text" /><span></span></div></div><div></div></div>
  </div>`;

const textField = (field: string, fkit: string, text: string, required: boolean) => `
  <div data-automation-id="formField-${field}" data-fkit-id="${fkit}">
    <label for="${fkit}">${label(text, required)}</label>
    <div><div><input id="${fkit}" name="${field}" type="text" aria-required="${required}" /></div><div></div></div>
  </div>`;

const chip = (text: string) => `
  <li role="presentation" data-automation-id="menuItem">
    <div role="option" data-automation-id="selectedItem" aria-label="${text}, press delete to clear value.">
      <div data-automation-id="DELETE_charm" role="presentation" aria-hidden="true"><span></span></div>
      <p data-automation-id="promptOption" data-automation-label="${text}">${text}</p>
    </div>
  </li>`;

/** 实测的形状：星号是 aria-hidden 的 <abbr>，选中的值是 selectedItemList 里的 selectedItem。 */
const countryPhoneCode = (selected: string | null) => `
  <div data-automation-id="formField-countryPhoneCode" data-fkit-id="phoneNumber--countryPhoneCode">
    <label for="phoneNumber--countryPhoneCode">${label('Country Phone Code', true)}</label>
    <div><div><div>
      <div dir="ltr" tabindex="-1" data-automation-id="multiSelectContainer" data-uxi-widget-type="multiselect">
        <div data-automation-id="multiselectInputContainer">
          <div data-automation-hiddensearch="false">
            <input enterkeyhint="search" placeholder="Search" aria-required="true" autocomplete="off" tabindex="0"
              data-uxi-widget-type="selectinput" id="phoneNumber--countryPhoneCode" aria-describedby="prompt-help" />
            <div data-automation-id="promptSelectionLabel"></div>
            <div id="prompt-help" aria-hidden="true" data-automation-id="promptAriaInstruction">${selected === null ? '' : `1 item selected, ${selected}`}</div>
          </div>
          <div tabindex="-1"><ul role="listbox" data-automation-id="selectedItemList" aria-label="items selected">${selected === null ? '' : chip(selected)}</ul></div>
          <span data-automation-id="promptIcon" aria-hidden="true"></span>
        </div>
      </div>
    </div></div></div>
  </div>`;

function mountMyInformation(selected: string | null): void {
  document.body.innerHTML = `
    <div data-automation-id="applyFlowMyInfoPage">
      ${listbox('country', 'country--country', 'Country', true, 'United States of America')}
      <h3>Phone</h3>
      ${listbox('phoneType', 'phoneNumber--phoneType', 'Phone Device Type', true)}
      ${countryPhoneCode(selected)}
      ${textField('phoneNumber', 'phoneNumber--phoneNumber', 'Phone Number', true)}
      ${textField('extension', 'phoneNumber--extension', 'Phone Extension', false)}
    </div>`;
}

type SearchSemantics = 'words' | 'substring';

interface Widget {
  readonly input: HTMLInputElement;
  readonly searches: string[];
  readonly clicked: string[];
}

/** 宿主行为（不是 Workday 的代码）：回车才搜；一个结果自己选上；好几个结果弹一张挂在 body 下的列表。 */
function mountHost(catalog: readonly string[], semantics: SearchSemantics, pickAnyway?: string): Widget {
  const host = document.querySelector('[data-automation-id="formField-countryPhoneCode"]')!;
  const input = host.querySelector<HTMLInputElement>('input[data-uxi-widget-type="selectinput"]')!;
  const list = host.querySelector('[data-automation-id="selectedItemList"]')!;
  const searches: string[] = [];
  const clicked: string[] = [];
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  const closePopup = () => document.querySelector('[data-automation-id="activeListContainer"]')?.remove();
  const select = (text: string) => {
    list.innerHTML = chip(text);
    closePopup();
    setter.call(input, '');
  };
  input.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key !== 'Enter') return;
    searches.push(input.value);
    const query = input.value.trim().toLowerCase();
    const words = query.split(/[\s()+]+/u).filter(Boolean);
    const results = pickAnyway !== undefined
      ? [pickAnyway]
      : catalog.filter((item) => semantics === 'substring'
        ? item.toLowerCase().includes(query)
        : words.every((word) => item.toLowerCase().split(/[\s(),+]+/u).includes(word)));
    closePopup();
    if (results.length === 1) {
      select(results[0]!);
      return;
    }
    const popup = document.createElement('div');
    popup.setAttribute('data-automation-id', 'activeListContainer');
    popup.setAttribute('role', 'listbox');
    if (results.length === 0) popup.textContent = 'No Items.';
    for (const text of results) {
      const row = document.createElement('div');
      row.setAttribute('role', 'option');
      const hit = document.createElement('div');
      hit.setAttribute('data-automation-id', 'promptOption');
      hit.textContent = text;
      hit.addEventListener('click', () => {
        clicked.push(text);
        select(text);
      });
      row.append(hit);
      popup.append(row);
    }
    document.body.append(popup);
  });
  input.addEventListener('focusout', closePopup);
  // 搜索框清空（input 事件）时收起列表——写入器要先点行、再清空它打进去的那一句。
  input.addEventListener('input', () => { if (input.value === '') closePopup(); });
  return { input, searches, clicked };
}

function descriptor(): ApplyFormDescriptor {
  const adapter = compileBundledAdapter(workday as never);
  const root = adapter.resolveRoot(document);
  expect(root, '夹具上找不到 My Information 的锚点').not.toBeNull();
  return { vendor: 'workday', root: root!, fields: [...adapter.scan(root!)], rowScopes: adapter.rowScopes ?? [] };
}

const byId = (form: ApplyFormDescriptor, id: string) => form.fields.find((field) => field.element.id === id);
const shownChips = () =>
  [...document.querySelectorAll('[data-automation-id="formField-countryPhoneCode"] [data-automation-id="selectedItem"]')]
    .map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim());

const PROFILE = { phone: '+1 415 555 0142', addressCountry: 'US' };

describe('规则：Country Phone Code 是一值的搜索式单选', () => {
  it('扫成带 searchPrompt 绑定的组合框（不再是普通文本框），必填，没有键——键由内核按题面认', () => {
    mountMyInformation('United States of America (+1)');
    const field = byId(descriptor(), 'phoneNumber--countryPhoneCode');
    expect(field).toMatchObject({ kind: 'combobox', key: null, required: true, label: 'Country Phone Code', listbox: { searchPrompt: { maxValues: 1 } } });
  });
});

describe('计划：已经选着一项', () => {
  it('网站带出来的那一项留着：记在电话名下的 NOT_EMPTY（页面上本来就有），不是「没认出」，不算需要你', () => {
    mountMyInformation('United States of America (+1)');
    const plan = buildApplyPlan(descriptor(), PROFILE, {});
    const skip = plan.skipped.find((item) => item.element.id === 'phoneNumber--countryPhoneCode');
    expect(skip).toMatchObject({ reason: 'NOT_EMPTY', key: 'phone', required: true });
    expect(plan.entries.some((entry) => entry.element.id === 'phoneNumber--countryPhoneCode')).toBe(false);
    const view = buildAuditView(plan, plan.entries.map((entry) => ({ key: entry.key, label: entry.label, ok: true })));
    const needs = view.rows.filter((row) => row.required && row.status !== 'FILLED' && row.status !== 'PREFILLED');
    expect(needs.map((row) => row.label)).toEqual([]);
    // 电话照旧只写国内号段（表自己管区号）；设备类型选择器照旧在计划里。
    expect(plan.entries.find((entry) => entry.element.id === 'phoneNumber--phoneNumber')?.value).toBe('4155550142');
    expect(plan.entries.some((entry) => entry.label === 'Phone Device Type')).toBe(true);
  });
});

describe('计划：空着', () => {
  it('号码写明了区号：条目记在电话名下，搜「国名 (+区号)」，号码、设备类型、区号三栏都留着（同节同键不互相仲裁掉）', () => {
    mountMyInformation(null);
    const plan = buildApplyPlan(descriptor(), PROFILE, {});
    const entry = plan.entries.find((item) => item.element.id === 'phoneNumber--countryPhoneCode');
    expect(entry).toMatchObject({ key: 'phone', kind: 'combobox', callingCode: '1' });
    expect(entry?.kind === 'combobox' ? entry.comboboxCandidates.slice(0, 2) : []).toEqual(['United States (+1)', 'United States of America (+1)']);
    expect(plan.entries.find((item) => item.element.id === 'phoneNumber--phoneNumber')?.value).toBe('4155550142');
    expect(plan.entries.some((item) => item.label === 'Phone Device Type')).toBe(true);
  });

  it('号码没写区号：不按地址猜，交还本人（资料里没有）', () => {
    mountMyInformation(null);
    const plan = buildApplyPlan(descriptor(), { phone: '(415) 555-0142', addressCountry: 'US' }, {});
    expect(plan.entries.some((item) => item.element.id === 'phoneNumber--countryPhoneCode')).toBe(false);
    expect(plan.skipped.find((item) => item.element.id === 'phoneNumber--countryPhoneCode')).toMatchObject({ reason: 'NO_VALUE', key: 'phone', required: true });
  });
});

/** 一张在我方 shadow 里铸出来、已经交出去的点击授权（与 apply-search-prompt 同一个做法）。 */
function clickAuthority(): HostWriteAuthority {
  const host = document.createElement('div');
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const button = document.createElement('button');
  shadowRoot.appendChild(button);
  const event = new Event('click', { bubbles: true, composed: true });
  Object.defineProperty(event, 'isTrusted', { value: true });
  Object.defineProperty(event, 'composedPath', { value: () => [button, shadowRoot, host, document.body, document, window] });
  const minted = mintAuthority({ event, shadowRoot, purpose: 'fill', fingerprint: 'fp-calling-code', capabilities: new Set(['set-combobox']) });
  if (!minted.ok) throw new Error(minted.code);
  const active = consumeAuthority(minted.value);
  if (!active.ok) throw new Error(active.code);
  return active.value;
}

function workdayPolicy() {
  const bundled = testApplyPolicy();
  return { ...bundled, vendors: { ...bundled.vendors, workday: true } };
}

async function writeDirectly(candidates: readonly string[], callingCode: string) {
  const field = byId(descriptor(), 'phoneNumber--countryPhoneCode')!;
  if (field.kind !== 'combobox' || field.listbox === undefined) throw new Error('country phone code is not a search prompt');
  return fillSearchPrompt({
    trigger: field.element,
    binding: field.listbox,
    candidates,
    callingCode,
    root: createScanRoot(document.querySelector('[data-automation-id="applyFlowMyInfoPage"]')!, []),
    authority: clickAuthority(),
    ticket: createUndoJournal().record(field.element),
    policy: workdayPolicy(),
    fence: () => null,
    deferLateRecheck: () => {},
  });
}

const US = ['United States (+1)', 'United States of America (+1)'];

describe('写入：只认这个区号', () => {
  it('按词搜：「United States (+1)」搜回两行都带 +1，按居住国的国名收窄到恰好一行才点', async () => {
    mountMyInformation(null);
    const widget = mountHost(CODES, 'words');
    const outcome = await writeDirectly(US, '1');
    expect(outcome).toMatchObject({ ok: true, value: 'United States of America (+1)' });
    expect(widget.searches).toEqual(['United States (+1)']);
    expect(widget.clicked).toEqual(['United States of America (+1)']);
    expect(shownChips()).toEqual(['United States of America (+1)']);
  });

  it('整串搜：第一种写法一行都搜不到，换下一种写法；网站自己选上唯一的结果，区号对得上才算', async () => {
    mountMyInformation(null);
    const widget = mountHost(CODES, 'substring');
    const outcome = await writeDirectly(US, '1');
    expect(outcome).toMatchObject({ ok: true, value: 'United States of America (+1)' });
    expect(widget.searches).toEqual(['United States (+1)', 'United States of America (+1)']);
    expect(widget.input.value).toBe('');
  });

  it('网站自己选上的那一项区号不对：照实报 VALUE_COERCED，不说填好了', async () => {
    mountMyInformation(null);
    mountHost(CODES, 'words', 'Afghanistan (+93)');
    const outcome = await writeDirectly(US, '1');
    expect(outcome).toMatchObject({ ok: false, code: 'VALUE_COERCED' });
  });

  it('居住国与号码的区号对不上（地址在美国、手机 +86）：搜不到就不选，搜索框清空', async () => {
    mountMyInformation(null);
    const widget = mountHost(CODES, 'words');
    const outcome = await writeDirectly(['United States (+86)', 'United States of America (+86)'], '86');
    expect(outcome).toMatchObject({ ok: false, code: 'NO_OPTION_MATCH' });
    expect(shownChips()).toEqual([]);
    expect(widget.clicked).toEqual([]);
    expect(widget.input.value).toBe('');
  });

  it('已经选着同一个区号：一次都不搜，算填好；选着别的区号：不动它（NOT_EMPTY）', async () => {
    mountMyInformation('Canada (+1)');
    const same = mountHost(CODES, 'words');
    expect(await writeDirectly(US, '1')).toMatchObject({ ok: true });
    expect(same.searches).toEqual([]);

    mountMyInformation('Germany (+49)');
    const other = mountHost(CODES, 'words');
    expect(await writeDirectly(US, '1')).toMatchObject({ ok: false, code: 'NOT_EMPTY' });
    expect(other.searches).toEqual([]);
    expect(shownChips()).toEqual(['Germany (+49)']);
  });
});

describe('整条链：runner 把区号交给写入器', () => {
  it('空着的区号经 runner 写上，结果是填好了', async () => {
    mountMyInformation(null);
    const widget = mountHost(CODES, 'words');
    const form = descriptor();
    const plan = buildApplyPlan(form, PROFILE, {});
    const only = { ...plan, entries: plan.entries.filter((entry) => entry.element.id === 'phoneNumber--countryPhoneCode') };
    const summary = await runApplyPlan({
      plan: only,
      auth: testAuthority(only.fingerprint, 'fill', [...capabilitiesForKinds(only.entries.map((entry) => entry.kind))]),
      journal: createUndoJournal(),
      root: form.root,
      policy: workdayPolicy(),
      readHostValidation: () => ({ ariaInvalid: null }),
      lateRecheckMs: 5,
    });
    expect(summary.results[0]).toMatchObject({ ok: true, key: 'phone' });
    expect(widget.clicked).toEqual(['United States of America (+1)']);
  });
});

/**
 * 区号本身说明了国家（2026-10-01）：argoland #698 起档案电话可以是任何国家的号码，「地址在美国、手机 +86」的留学生
 * 最常见。从前只按居住国拼「国名 (+区号)」，这些人的区号永远搜不到；只属于一个国家的区号就按那个国家搜。
 */
describe('区号本身说明了国家', () => {
  const candidatesFor = (profile: Readonly<{ phone: string; addressCountry?: string }>) => {
    mountMyInformation(null);
    const plan = buildApplyPlan(descriptor(), profile, {});
    const entry = plan.entries.find((item) => item.element.id === 'phoneNumber--countryPhoneCode');
    return { entry, candidates: entry?.kind === 'combobox' ? entry.comboboxCandidates : [] };
  };

  it('地址在美国、手机 +86：搜「China (+86)」，不再拼成「United States (+86)」', () => {
    const { entry, candidates } = candidatesFor({ phone: '+86 138 0013 8000', addressCountry: 'US' });
    expect(entry).toMatchObject({ key: 'phone', kind: 'combobox', callingCode: '86' });
    expect(candidates[0]).toBe('China (+86)');
    expect(candidates.some((text) => text.startsWith('United States'))).toBe(false);
  });

  it('整条链写上：地址在美国、手机 +86，选中「China (+86)」', async () => {
    const { candidates } = candidatesFor({ phone: '+86 138 0013 8000', addressCountry: 'US' });
    const widget = mountHost(CODES, 'words');
    const outcome = await writeDirectly(candidates, '86');
    expect(outcome).toMatchObject({ ok: true, value: 'China (+86)' });
    expect(widget.searches[0]).toBe('China (+86)');
    expect(shownChips()).toEqual(['China (+86)']);
  });

  it('资料里没有居住国也能搜（+82）：选中「Korea, Republic of (+82)」', async () => {
    const { candidates } = candidatesFor({ phone: '+82 10 1234 5678' });
    expect(candidates.length).toBeGreaterThan(0);
    mountHost(CODES, 'words');
    const outcome = await writeDirectly(candidates, '82');
    expect(outcome).toMatchObject({ ok: true, value: 'Korea, Republic of (+82)' });
  });

  it('几国共用的区号（+1）照旧按居住国：住在加拿大搜「Canada (+1)」', () => {
    const { candidates } = candidatesFor({ phone: '+1 416 555 0142', addressCountry: 'CA' });
    expect(candidates[0]).toBe('Canada (+1)');
  });

  it('号码没写区号：照旧不猜', () => {
    const { entry } = candidatesFor({ phone: '138 0013 8000', addressCountry: 'CN' });
    expect(entry).toBeUndefined();
  });
});
