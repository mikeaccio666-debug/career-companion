import { afterEach, describe, expect, it } from 'vitest';

import type { ApplyFormDescriptor } from '../src/contracts';
import { buildApplyPlan } from '../src/engine';
import { parseApplyProfileCollections, type ApplyProfileCollections } from '../src/profileCollections';
import { compileRuleAdapter } from '../src/rules/interpreter';
import { parseVendorRuleset } from '../src/rules/schema';
import { runApplyPlan } from '../src/runner';
import { createUndoJournal } from '../src/undo';
import { buildAuditView } from '../src/audit';
import { consumeAuthority, mintAuthority, type HostWriteAuthority } from '../src/grant';
import { createScanRoot } from '../src/scanRoot';
import { capabilitiesForKinds } from '../src/write/allowlist';
import { fillSearchPrompt, SEARCH_BUDGET_MS } from '../src/write/searchPrompt';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

/**
 * 搜索式多选（2026-09-24）：Workday My Experience 的 Field of Study 与「Type to Add Skills」。
 *
 * 经 main 批准在 adobe.wd5 测试台上实测（用我自己的测试词，选上的那一个当场删掉了）：
 *  · 打字不出任何结果——没有 aria-controls，也不弹列表；
 *  · 回车才搜：只有一个结果时 **Workday 自己把它选上**（「Computer Science」→ 选中
 *    「Computer and Information Science」，输入框随即清空）；
 *  · 好几个结果时弹出 body 下的 `div[data-automation-id=activeListContainer][role=listbox]`（没有 id），
 *    每行 `[role=option]` 里接指针的是 `[data-automation-id=promptOption]`；Skills 的行带复选框，
 *    搜「Python」回来 14 行、没有一行就叫「Python」，规范的那一行是「Python (Programming Language)」；
 *  · 选中的值是框里的 `[data-automation-id=selectedItem]`。
 *
 * 下面的 `mountSearchPrompt` 按这些复刻宿主的行为（不是 Workday 的代码）。规则是本文件自带的最小
 * 一份，与 workday.json 同一形状——内核的行为不该随那份规则别的改动变红。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const FIELDS_OF_STUDY = [
  'Aerospace Engineering', 'Applied Mathematics', 'Chemical Engineering', 'Civil Engineering', 'Computer Engineering',
  'Computer and Information Science', 'Electrical Engineering', 'Mathematics', 'Statistics',
];
const SKILLS = [
  'Python (Programming Language)', 'Python IDLE', 'Maya Python', 'Python Software Development',
  'Machine Learning', 'Machine Learning Operations', 'PyTorch', 'TensorFlow',
  'SQL (Programming Language)', 'Structured Query Language (SQL)', 'Kubernetes',
];

interface Widget {
  readonly input: HTMLInputElement;
  /** 宿主收到的每一次搜索（回车时框里的字）。 */
  readonly searches: string[];
  /** 被点中的行。 */
  readonly clicked: string[];
}

/** 宿主的快慢（都不是 Workday 的代码）：答之前先挂一段「Loading…」、某些词压根不答。 */
interface HostTiming {
  /** 回车之后先弹一个只有「Loading…」、一行都没有的列表，这么久之后才换成结果。 */
  readonly loadingMs?: number;
  /** 这些词回车之后宿主一点反应都没有（网络卡住）。 */
  readonly silentFor?: readonly string[];
}

/** Workday 搜索式多选的宿主行为。`single` = Field of Study 那种单值（选中即收起）。 */
function mountSearchPrompt(field: string, catalog: readonly string[], single: boolean, timing: HostTiming = {}): Widget {
  const host = document.querySelector(`[data-automation-id="formField-${field}"]`)!;
  const input = host.querySelector<HTMLInputElement>('input[data-uxi-widget-type="selectinput"]')!;
  const container = host.querySelector('[data-automation-id="multiSelectContainer"]')!;
  const searches: string[] = [];
  const clicked: string[] = [];
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  const closePopup = () => document.querySelector('[data-automation-id="activeListContainer"]')?.remove();
  const addChip = (text: string) => {
    let list = container.querySelector('[data-automation-id="selectedItemList"]');
    if (list === null) {
      list = document.createElement('div');
      list.setAttribute('data-automation-id', 'selectedItemList');
      list.setAttribute('role', 'listbox');
      container.prepend(list);
    }
    const chip = document.createElement('div');
    chip.setAttribute('role', 'option');
    chip.setAttribute('data-automation-id', 'selectedItem');
    chip.innerHTML = '<div data-automation-id="DELETE_charm" role="presentation"></div>';
    const label = document.createElement('div');
    label.setAttribute('data-automation-id', 'promptOption');
    label.textContent = text;
    chip.append(label);
    list.append(chip);
  };
  const answer = (query: string) => {
    const words = query.split(/\s+/).filter(Boolean);
    const results = catalog.filter((item) => words.every((word) => item.toLowerCase().includes(word)));
    closePopup();
    if (results.length === 1) {
      addChip(results[0]!);
      setter.call(input, '');
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
        addChip(text);
        if (single) {
          closePopup();
          setter.call(input, '');
        }
      });
      row.append(hit);
      popup.append(row);
    }
    document.body.append(popup);
  };
  input.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key !== 'Enter') return;
    const query = input.value.trim().toLowerCase();
    searches.push(input.value);
    if (timing.silentFor?.includes(input.value)) return;
    if (timing.loadingMs === undefined) {
      answer(query);
      return;
    }
    closePopup();
    const loading = document.createElement('div');
    loading.setAttribute('data-automation-id', 'activeListContainer');
    loading.setAttribute('role', 'listbox');
    loading.textContent = 'Loading…';
    document.body.append(loading);
    setTimeout(() => answer(query), timing.loadingMs);
  });
  // 失焦收起列表（combobox 的通用行为；写入器收摊时派的就是这一对）。
  input.addEventListener('focusout', closePopup);
  return { input, searches, clicked };
}

const prompt = (fkit: string, field: string, label: string) => `
  <div data-automation-id="formField-${field}" data-fkit-id="${fkit}--${field}">
    <label for="${fkit}--${field}">${label}</label>
    <div><div><div><div data-automation-id="multiSelectContainer" data-uxi-widget-type="multiselect">
      <div data-automation-id="multiselectInputContainer"><div>
        <input id="${fkit}--${field}" data-uxi-widget-type="selectinput" placeholder="Search" />
      </div></div>
    </div></div></div></div>
  </div>`;

function mountPage(): void {
  document.body.innerHTML = `
    <div data-automation-id="applyFlowMyExpPage">
      <div role="group" aria-labelledby="Education-section">
        <h4 id="Education-section">Education</h4>
        <div role="group" aria-labelledby="Education-1-panel">
          <div data-fkit-id="education-30--null">
            <div data-automation-id="formField-schoolName" data-fkit-id="education-30--schoolName">
              <label for="education-30--schoolName">School or University*</label>
              <input id="education-30--schoolName" name="schoolName" type="text" />
            </div>
            ${prompt('education-30', 'fieldOfStudy', 'Field of Study')}
          </div>
        </div>
      </div>
      <div role="group" aria-labelledby="Skills-section">
        <h4 id="Skills-section">Skills</h4>
        <div data-fkit-id="skills--null">${prompt('skills', 'skills', 'Type to Add Skills')}</div>
      </div>
    </div>`;
}

const SHAPE = {
  containerSelector: '[data-automation-id="multiSelectContainer"]',
  selectedValueSelector: '[data-automation-id="selectedItem"]',
  popupRootSelector: 'div[data-automation-id="activeListContainer"][role="listbox"]',
  optionSelector: '[data-automation-id="promptOption"]',
};

const RULES = {
  schemaVersion: 2,
  vendor: 'workday',
  finalSubmitControl: null,
  applyPath: { source: '.*' },
  anchors: ['[data-automation-id="applyFlowMyExpPage"]'],
  excludeWithin: [],
  denyLabels: [],
  denyNameSubstrings: [],
  widgetNames: [],
  rowScopes: [
    {
      kind: 'contains',
      container: '[role="group"][aria-labelledby="Education-section"]',
      row: '[data-fkit-id^="education-"][data-fkit-id$="--null"]',
      collection: 'education',
      cellIdPattern: { source: '^education-\\d+--(.+)$' },
      fieldMap: { schoolName: 'school', fieldOfStudy: 'fieldOfStudy' },
    },
  ],
  searchPromptComboboxes: [
    { triggerSelector: '[data-automation-id="formField-fieldOfStudy"] input[data-uxi-widget-type="selectinput"]', ...SHAPE, maxValues: 1 },
    { triggerSelector: '[data-automation-id="formField-skills"] input[data-uxi-widget-type="selectinput"]', ...SHAPE, maxValues: 15 },
  ],
  keySteps: [{ type: 'attrMap', attr: 'id', confidence: 1, map: { 'skills--skills': 'skills.all' } }],
};

function compile(rules: unknown = RULES) {
  const parsed = parseVendorRuleset(rules, { unknownFieldKeys: 'reject' });
  if (!parsed.ok) throw new Error(`fixture ruleset rejected: ${parsed.code}`);
  return compileRuleAdapter(parsed.value);
}

function descriptor(): ApplyFormDescriptor {
  const adapter = compile();
  const root = adapter.resolveRoot(document)!;
  return { vendor: 'workday', root, fields: [...adapter.scan(root)], rowScopes: adapter.rowScopes ?? [] };
}

function workdayPolicy() {
  const bundled = testApplyPolicy();
  return { ...bundled, vendors: { ...bundled.vendors, workday: true } };
}

async function fill(collections: ApplyProfileCollections, key: string) {
  const form = descriptor();
  const plan = buildApplyPlan(form, {}, { collections });
  const only = { ...plan, entries: plan.entries.filter((entry) => entry.key === key) };
  const summary = await runApplyPlan({
    plan: only,
    auth: testAuthority(only.fingerprint, 'fill', [...capabilitiesForKinds(only.entries.map((entry) => entry.kind))]),
    journal: createUndoJournal(),
    root: form.root,
    policy: workdayPolicy(),
    readHostValidation: () => ({ ariaInvalid: null }),
    lateRecheckMs: 5,
  });
  return { plan: only, summary, result: summary.results[0] };
}

/** 一张在我方 shadow 里铸出来、已经交出去的点击授权（与 apply-listbox-typeahead-answered-empty 同一个做法）。 */
function clickAuthority(): HostWriteAuthority {
  const host = document.createElement('div');
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const button = document.createElement('button');
  shadowRoot.appendChild(button);
  const event = new Event('click', { bubbles: true, composed: true });
  Object.defineProperty(event, 'isTrusted', { value: true });
  Object.defineProperty(event, 'composedPath', { value: () => [button, shadowRoot, host, document.body, document, window] });
  const minted = mintAuthority({ event, shadowRoot, purpose: 'fill', fingerprint: 'fp-search', capabilities: new Set(['set-combobox']) });
  if (!minted.ok) throw new Error(minted.code);
  const active = consumeAuthority(minted.value);
  if (!active.ok) throw new Error(active.code);
  return active.value;
}

/** 直接交给写入器（为了把整页时限调小；产品链路上 runner 从不传 budgetMs）。 */
function searchSkillsDirectly(values: readonly string[], budgetMs: number) {
  const form = descriptor();
  const field = form.fields.find((item) => item.element.id === 'skills--skills')!;
  if (field.kind !== 'combobox' || field.listbox === undefined) throw new Error('skills is not a search prompt');
  const rechecks: (() => boolean)[] = [];
  const outcome = fillSearchPrompt({
    trigger: field.element,
    binding: field.listbox,
    candidates: values,
    root: createScanRoot(document.querySelector('[data-automation-id="applyFlowMyExpPage"]')!, []),
    authority: clickAuthority(),
    ticket: createUndoJournal().record(field.element),
    policy: workdayPolicy(),
    fence: () => null,
    deferLateRecheck: (stillHolds) => { rechecks.push(stillHolds); },
    budgetMs,
  });
  return { outcome, rechecks };
}

const chips = (field: string) =>
  [...document.querySelectorAll(`[data-automation-id="formField-${field}"] [data-automation-id="selectedItem"]`)]
    .map((chip) => (chip.textContent ?? '').trim());

const education = (fieldOfStudy: string) => parseApplyProfileCollections({ educations: [{ school: 'Example University', fieldOfStudy }] });

describe('规则声明：searchPromptComboboxes', () => {
  it('收下这一种声明；每一项的键封闭，maxValues 是 1 到 15 的整数', () => {
    expect(parseVendorRuleset(RULES, { unknownFieldKeys: 'reject' })).toMatchObject({ ok: true });
    const withExtra = structuredClone(RULES) as Record<string, unknown> & { searchPromptComboboxes: Record<string, unknown>[] };
    withExtra.searchPromptComboboxes[0]!['hierarchical'] = true;
    expect(parseVendorRuleset(withExtra)).toEqual({ ok: false, code: 'RULES_MALFORMED' });
    for (const maxValues of [0, 16, 1.5, '3']) {
      const bad = structuredClone(RULES) as Record<string, unknown> & { searchPromptComboboxes: Record<string, unknown>[] };
      bad.searchPromptComboboxes[1]!['maxValues'] = maxValues;
      expect(parseVendorRuleset(bad), String(maxValues)).toEqual({ ok: false, code: 'RULES_MALFORMED' });
    }
  });

  it('被声明的输入框扫成带 searchPrompt 绑定的组合框：Field of Study 单值，Skills 多值', () => {
    mountPage();
    const form = descriptor();
    const study = form.fields.find((field) => field.element.id === 'education-30--fieldOfStudy');
    expect(study).toMatchObject({
      kind: 'combobox',
      key: 'education.fieldOfStudy',
      listbox: { valueContainerSelector: SHAPE.containerSelector, selectedValueSelector: SHAPE.selectedValueSelector, searchPrompt: { popupRootSelector: SHAPE.popupRootSelector, optionSelector: SHAPE.optionSelector, maxValues: 1 } },
    });
    expect(study).not.toHaveProperty('multiple');
    const skills = form.fields.find((field) => field.element.id === 'skills--skills');
    expect(skills).toMatchObject({ kind: 'combobox', key: 'skills.all', multiple: true, listbox: { searchPrompt: { maxValues: 15 } } });
  });

  it('反向：没有这条声明，同一个输入框照旧是普通文本框（不会被当成文本写进去）', () => {
    mountPage();
    const { searchPromptComboboxes: _drop, ...rest } = RULES;
    const adapter = compile(rest);
    const root = adapter.resolveRoot(document)!;
    const study = [...adapter.scan(root)].find((field) => field.element.id === 'education-30--fieldOfStudy');
    expect(study?.kind).toBe('text');
  });
});

describe('计划：技能逐项交出去，最多 maxValues 项', () => {
  it('skills.all 在搜索式多选上是一项一个值；超过 15 项只交前 15 项', () => {
    mountPage();
    const many = parseApplyProfileCollections({ skills: Array.from({ length: 20 }, (_, index) => `Skill ${index + 1}`) });
    const plan = buildApplyPlan(descriptor(), {}, { collections: many });
    const entry = plan.entries.find((item) => item.key === 'skills.all');
    expect(entry?.kind).toBe('combobox');
    if (entry?.kind !== 'combobox') return;
    expect(entry.comboboxCandidates).toHaveLength(15);
    expect(entry.comboboxCandidates[0]).toBe('Skill 1');
    // 计划里这一栏的值是要加的全部几项（一行一项，与别的多值答案同一个写法），不只是第一项。
    expect(entry.value).toBe(Array.from({ length: 15 }, (_, index) => `Skill ${index + 1}`).join('\n'));
    expect(entry.multiple).toBe(true);
    expect(entry.singlePick).toBeUndefined();
  });
});

describe('写入：打字、回车搜索、恰好一项才选、读回选中的那一项', () => {
  it('唯一结果：宿主自己选上，我们读回那一项并报成功', async () => {
    mountPage();
    const widget = mountSearchPrompt('fieldOfStudy', FIELDS_OF_STUDY, true);
    const { result } = await fill(education('Computer Science'), 'education.fieldOfStudy');
    expect(result).toMatchObject({ ok: true });
    // 单值栏的结局就是这一栏自己的结果，不另列「没加上」。
    expect(result).not.toHaveProperty('notAdded');
    expect(widget.searches).toEqual(['Computer Science']);
    expect(widget.clicked).toEqual([]);
    expect(chips('fieldOfStudy')).toEqual(['Computer and Information Science']);
    expect(widget.input.value).toBe('');
  });

  it('好几个结果：只点恰好对得上的那一行', async () => {
    mountPage();
    const widget = mountSearchPrompt('fieldOfStudy', FIELDS_OF_STUDY, true);
    const { result } = await fill(education('Mathematics'), 'education.fieldOfStudy');
    // 「Mathematics」搜回两行（还有 Applied Mathematics），只有一行一字不差。
    expect(result).toMatchObject({ ok: true });
    expect(widget.clicked).toEqual(['Mathematics']);
    expect(chips('fieldOfStudy')).toEqual(['Mathematics']);
  });

  it('好几个结果、没有一行对得上：一行都不点，搜索框清空，交还用户', async () => {
    mountPage();
    const widget = mountSearchPrompt('fieldOfStudy', FIELDS_OF_STUDY, true);
    const { result } = await fill(education('Engineering'), 'education.fieldOfStudy');
    expect(result).toMatchObject({ ok: false, reason: 'NO_OPTION_MATCH' });
    expect(widget.clicked).toEqual([]);
    expect(chips('fieldOfStudy')).toEqual([]);
    expect(widget.input.value).toBe('');
    expect(document.querySelector('[data-automation-id="activeListContainer"]')).toBeNull();
  });

  it('搜不到：什么都不选，搜索框清空', async () => {
    mountPage();
    const widget = mountSearchPrompt('fieldOfStudy', FIELDS_OF_STUDY, true);
    const { result } = await fill(education('Underwater Basket Weaving'), 'education.fieldOfStudy');
    expect(result).toMatchObject({ ok: false, reason: 'NO_OPTION_MATCH' });
    expect(chips('fieldOfStudy')).toEqual([]);
    expect(widget.input.value).toBe('');
  });

  it('已经选过一项的单值栏不再加第二项', async () => {
    mountPage();
    const widget = mountSearchPrompt('fieldOfStudy', FIELDS_OF_STUDY, true);
    widget.input.value = 'Statistics';
    widget.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(chips('fieldOfStudy')).toEqual(['Statistics']);
    const { result } = await fill(education('Mathematics'), 'education.fieldOfStudy');
    expect(result).toMatchObject({ ok: false, reason: 'NOT_EMPTY' });
    expect(chips('fieldOfStudy')).toEqual(['Statistics']);
    expect(widget.searches).toEqual(['Statistics']);
  });

  it('搜索框里有字（用户自己在搜）：不覆盖', async () => {
    mountPage();
    const widget = mountSearchPrompt('fieldOfStudy', FIELDS_OF_STUDY, true);
    widget.input.value = 'Stat';
    const { result } = await fill(education('Mathematics'), 'education.fieldOfStudy');
    expect(result).toMatchObject({ ok: false, reason: 'NOT_EMPTY' });
    expect(widget.input.value).toBe('Stat');
    expect(widget.searches).toEqual([]);
  });

  it('技能：逐项搜，每项只走别的下拉同一道阶梯；好几行都说得通的跳过（不猜），对不上的跳过', async () => {
    mountPage();
    const widget = mountSearchPrompt('skills', SKILLS, false);
    const skills = parseApplyProfileCollections({ skills: ['Python', 'Machine Learning', 'PyTorch', 'Juggling', 'SQL'] });
    const { plan, summary, result } = await fill(skills, 'skills.all');
    // 没加上的逐项带稳定原因码交出去，审计行原样带着（浮层据此列出来）。
    const misses = [{ value: 'Python', reason: 'AMBIGUOUS_OPTION' }, { value: 'Juggling', reason: 'NO_OPTION_MATCH' }];
    expect(result).toMatchObject({ ok: true, notAdded: misses });
    expect(buildAuditView(plan, summary.results).rows.find((row) => row.key === 'skills.all')?.notAdded).toEqual(misses);
    expect(widget.searches).toEqual(['Python', 'Machine Learning', 'PyTorch', 'Juggling', 'SQL']);
    // Python 搜回四行，三行以「Python」这个词开头（…(Programming Language)、IDLE、Software Development）：
    // 词边界前缀不唯一 → 歧义，一行都不点（实测 14 行时同理）。
    // Machine Learning 一字不差的那一行；PyTorch 只有一个结果、宿主自己选上。
    // SQL 搜回两行：只有「SQL (Programming Language)」以「SQL」这个词开头（唯一的词边界前缀）；
    // 「Structured Query Language (SQL)」不是。
    expect(widget.clicked).toEqual(['Machine Learning', 'SQL (Programming Language)']);
    expect(chips('skills')).toEqual(['Machine Learning', 'PyTorch', 'SQL (Programming Language)']);
    expect(widget.input.value).toBe('');
    expect(document.querySelector('[data-automation-id="activeListContainer"]')).toBeNull();
  });

  it('技能全都说不准（好几行都以它开头）：报 AMBIGUOUS_OPTION，一行都没点', async () => {
    mountPage();
    const widget = mountSearchPrompt('skills', SKILLS, false);
    const { result } = await fill(parseApplyProfileCollections({ skills: ['Python'] }), 'skills.all');
    expect(result).toMatchObject({ ok: false, reason: 'AMBIGUOUS_OPTION', notAdded: [{ value: 'Python', reason: 'AMBIGUOUS_OPTION' }] });
    expect(widget.clicked).toEqual([]);
    expect(chips('skills')).toEqual([]);
    expect(widget.input.value).toBe('');
  });

  it('技能：已经在框里的不再搜第二次', async () => {
    mountPage();
    const widget = mountSearchPrompt('skills', SKILLS, false);
    widget.input.value = 'Kubernetes';
    widget.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    const { result } = await fill(parseApplyProfileCollections({ skills: ['Kubernetes', 'TensorFlow'] }), 'skills.all');
    expect(result).toMatchObject({ ok: true });
    expect(widget.searches).toEqual(['Kubernetes', 'TensorFlow']);
    expect(chips('skills')).toEqual(['Kubernetes', 'TensorFlow']);
  });

  it('技能一项都对不上：报 NO_OPTION_MATCH，一行都没点', async () => {
    mountPage();
    const widget = mountSearchPrompt('skills', SKILLS, false);
    const { result } = await fill(parseApplyProfileCollections({ skills: ['Juggling'] }), 'skills.all');
    expect(result).toMatchObject({ ok: false, reason: 'NO_OPTION_MATCH', notAdded: [{ value: 'Juggling', reason: 'NO_OPTION_MATCH' }] });
    expect(widget.clicked).toEqual([]);
    expect(chips('skills')).toEqual([]);
  });

  it('搜索框在一张 <form> 里：不回车（回车可能被宿主当成提交），整栏交还用户', async () => {
    mountPage();
    const widget = mountSearchPrompt('fieldOfStudy', FIELDS_OF_STUDY, true);
    const page = document.querySelector('[data-automation-id="applyFlowMyExpPage"]')!;
    const form = document.createElement('form');
    page.replaceWith(form);
    form.append(page);
    const { result } = await fill(education('Statistics'), 'education.fieldOfStudy');
    expect(result).toMatchObject({ ok: false, reason: 'CAPABILITY_DISABLED' });
    expect(widget.searches).toEqual([]);
  });
});

describe('时间：一页的答案 15 秒内（负责人 2026-09-24），技能搜索整页最多 8 秒', () => {
  it('默认的整页时限是 8 秒', () => {
    expect(SEARCH_BUDGET_MS).toBe(8_000);
  });

  it('列表答了「没有」（一行都没有、字不再变）：不等满 2.5 秒，照样清空搜索框、报 NO_OPTION_MATCH', async () => {
    mountPage();
    const widget = mountSearchPrompt('fieldOfStudy', FIELDS_OF_STUDY, true);
    const started = Date.now();
    const { result } = await fill(education('Underwater Basket Weaving'), 'education.fieldOfStudy');
    const elapsed = Date.now() - started;
    expect(result).toMatchObject({ ok: false, reason: 'NO_OPTION_MATCH' });
    expect(widget.input.value).toBe('');
    // 静 600ms 就认；从前等满 2,500ms。上限放宽到 2 秒，免得机器忙时误报。
    expect(elapsed).toBeLessThan(2_000);
  });

  it('列表还挂着「Loading…」（一行都没有）时不判：行一出来就按行判', async () => {
    mountPage();
    const widget = mountSearchPrompt('fieldOfStudy', FIELDS_OF_STUDY, true, { loadingMs: 300 });
    const { result } = await fill(education('Mathematics'), 'education.fieldOfStudy');
    expect(result).toMatchObject({ ok: true });
    expect(widget.clicked).toEqual(['Mathematics']);
    expect(chips('fieldOfStudy')).toEqual(['Mathematics']);
  });

  it('整页时限用完：卡住的那一次到点就停，不再开新的搜索；没加上的逐项报 ABORTED，搜索框清空', async () => {
    mountPage();
    const widget = mountSearchPrompt('skills', SKILLS, false, { silentFor: ['TensorFlow'] });
    const started = Date.now();
    const { outcome, rechecks } = searchSkillsDirectly(['PyTorch', 'TensorFlow', 'Kubernetes', 'Machine Learning'], 500);
    const settled = await outcome;
    const elapsed = Date.now() - started;
    expect(settled).toMatchObject({
      ok: true,
      notAdded: [
        { value: 'TensorFlow', reason: 'ABORTED' },
        { value: 'Kubernetes', reason: 'ABORTED' },
        { value: 'Machine Learning', reason: 'ABORTED' },
      ],
    });
    // 时限到了之后一次新的搜索都没开。
    expect(widget.searches).toEqual(['PyTorch', 'TensorFlow']);
    expect(chips('skills')).toEqual(['PyTorch']);
    expect(widget.input.value).toBe('');
    expect(rechecks.map((stillHolds) => stillHolds())).toEqual([true]);
    expect(elapsed).toBeLessThan(1_500);
  });

  it('时限在第一次搜索之前就用完：一次都不搜，整栏报 WIDGET_TIMEOUT，每一项都列为没来得及', async () => {
    mountPage();
    const widget = mountSearchPrompt('skills', SKILLS, false);
    const { outcome } = searchSkillsDirectly(['PyTorch', 'Kubernetes'], 0);
    expect(await outcome).toEqual({
      ok: false,
      code: 'WIDGET_TIMEOUT',
      notAdded: [{ value: 'PyTorch', reason: 'ABORTED' }, { value: 'Kubernetes', reason: 'ABORTED' }],
    });
    expect(widget.searches).toEqual([]);
    expect(chips('skills')).toEqual([]);
  });
});
