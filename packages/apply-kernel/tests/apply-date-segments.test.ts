import { afterEach, describe, expect, it } from 'vitest';

import type { ApplyFormDescriptor } from '../src/contracts';
import { buildApplyPlan } from '../src/engine';
import type { HoneypotGeometry } from '../src/dict/guards';
import { parseApplyProfileCollections, type ApplyProfileCollections } from '../src/profileCollections';
import { compileRuleAdapter } from '../src/rules/interpreter';
import { parseVendorRuleset } from '../src/rules/schema';
import { runApplyPlan } from '../src/runner';
import { createUndoJournal } from '../src/undo';
import { capabilitiesForKinds } from '../src/write/allowlist';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';
import { mountMyExperience } from './fixtures/workday/myExperience';

/**
 * 分段日期（WAI-ARIA 的 spinbutton 分段：一个 `role=group` 里每一段一个 `input[role=spinbutton]`）。
 *
 * 参照物是 Workday 的 MM/YYYY（Canvas Kit 的日期输入，2026-09-24 在 adobe.wd5 测试台上经批准实测）：
 *
 *  1. 每一段的真输入框 1px 宽、`transform: scale(0.01)`，量出来 0.09×0.23——几何蜜罐一律判它是陷阱；
 *     用户操作的是它的父节点那一段（17×28 / 34×28）。
 *  2. 段收到 `input` 事件就更新自己的显示，但**表单模型只在整个日期组失焦时提交**，提交的是组件
 *     **上一次渲染时**的状态（React 18 的更新在微任务里才落地）。我们原来的文本信封是同步的
 *     input → change → blur → focusout：focusout 到的时候月份那一下还没渲染，组件拿旧状态提交、
 *     再用旧状态把刚写的月份盖掉。实测：月份显示「06」一瞬间变回「MM」，年份被写成「2006」，
 *     模型里只有「/2021」、报 Invalid Date。而逐段只发 input、等它渲染、再单独发一个 focusout，
 *     模型就是 {mm:'06', yyyy:'2021'}、错误消失。
 *
 * 下面的 `mountSegmentWidget` 按这两条复刻组件的时序：段的更新排进微任务，focusout 用当下「已渲染」的
 * 状态提交并覆盖。它复刻的是**时序**，不是 Workday 的代码。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

interface Committed {
  mm: string;
  yyyy: string;
}

/** 给一个分段日期组装上 Workday 那种时序。返回它的表单模型（最后一次提交的值）。 */
function mountSegmentWidget(group: Element): { readonly model: () => Committed | null } {
  const month = group.querySelector<HTMLInputElement>('[data-automation-id="dateSectionMonth-input"]');
  const year = group.querySelector<HTMLInputElement>('[data-automation-id="dateSectionYear-input"]')!;
  let rendered: Committed = { mm: '', yyyy: '' };
  const queue: Array<(state: Committed) => Committed> = [];
  let flushing = false;
  let committed: Committed | null = null;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  const render = () => {
    if (month) setter.call(month, rendered.mm === '' ? '' : String(Number.parseInt(rendered.mm, 10)));
    setter.call(year, rendered.yyyy);
  };
  const schedule = () => {
    if (flushing) return;
    flushing = true;
    queueMicrotask(() => {
      flushing = false;
      for (const update of queue.splice(0)) rendered = update(rendered);
      render();
    });
  };
  const onSection = (part: keyof Committed, input: HTMLInputElement) => () => {
    // 与组件一致：新状态由「这一次渲染看到的」状态算出，排进更新队列。
    const next = { ...rendered, [part]: input.value };
    queue.push(() => next);
    schedule();
  };
  month?.addEventListener('input', onSection('mm', month));
  year.addEventListener('input', onSection('yyyy', year));
  group.addEventListener('focusout', () => {
    // 焦点还在组里：不是离开这个日期，不提交。
    if (group.contains(document.activeElement)) return;
    const snapshot = {
      mm: rendered.mm === '' ? '' : rendered.mm.padStart(2, '0'),
      yyyy: rendered.yyyy,
    };
    committed = snapshot;
    queue.push(() => snapshot);
    schedule();
  });
  return { model: () => committed };
}

/**
 * 只声明本文件要用的最小规则（与 workday.json 同一套形状，但内核的行为不该随那份规则的其它改动变红）：
 * 经历、教育两个行作用域，行内按控件 id 认日期的年／月段；在职勾选框由 ancestorAttrMap 给新角色。
 */
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
      container: '[role="group"][aria-labelledby="Work-Experience-section"]',
      row: '[data-fkit-id^="workExperience-"][data-fkit-id$="--null"]',
      collection: 'experience',
      cellIdPattern: { source: '^workExperience-\\d+--(.+)$' },
      fieldMap: {
        'startDate-dateSectionMonth-input': 'startMonth',
        'startDate-dateSectionYear-input': 'startYear',
        'endDate-dateSectionMonth-input': 'endMonth',
        'endDate-dateSectionYear-input': 'endYear',
      },
    },
    {
      kind: 'contains',
      container: '[role="group"][aria-labelledby="Education-section"]',
      row: '[data-fkit-id^="education-"][data-fkit-id$="--null"]',
      collection: 'education',
      cellIdPattern: { source: '^education-\\d+--(.+)$' },
      fieldMap: {
        'firstYearAttended-dateSectionYear-input': 'startYear',
        'lastYearAttended-dateSectionYear-input': 'endYear',
      },
    },
  ],
  keySteps: [
    {
      type: 'ancestorAttrMap',
      attr: 'data-automation-id',
      confidence: 1,
      map: { 'formfield-currentlyworkhere': 'experience.isCurrent' },
    },
  ],
};

const adapter = () => {
  const parsed = parseVendorRuleset(RULES, { unknownFieldKeys: 'reject' });
  if (!parsed.ok) throw new Error(`fixture ruleset rejected: ${parsed.code}`);
  return compileRuleAdapter(parsed.value);
};

/** 内置策略把 workday 关着（生产只认后端下发的运行时包）；与别的 Workday 用例一样，测试里单独打开。 */
function workdayPolicy() {
  const bundled = testApplyPolicy();
  return { ...bundled, vendors: { ...bundled.vendors, workday: true } };
}

function descriptor(): ApplyFormDescriptor {
  mountMyExperience(document);
  const compiled = adapter();
  const root = compiled.resolveRoot(document)!;
  return { vendor: 'workday', root, fields: [...compiled.scan(root)], rowScopes: compiled.rowScopes ?? [] };
}

const group = (field: string) =>
  document.querySelector(`[data-fkit-id^="workExperience-"][data-fkit-id$="--null"] [data-automation-id="formField-${field}"] [role="group"]`)!;

/** 生产上的几何：段的真输入框 0.09×0.23，看得见的是它的父节点；其余控件 344×40。 */
const measured = (element: Element): HoneypotGeometry => {
  if (element.getAttribute('role') === 'spinbutton') return { width: 0.09, height: 0.23, left: 10, right: 10.09 };
  if (element.querySelector(':scope > input[role="spinbutton"]')) return { width: 17, height: 28, left: 10, right: 27 };
  return { width: 344, height: 40, left: 10, right: 354 };
};

const PAST_JOB = parseApplyProfileCollections({
  experiences: [
    { company: 'Sample Labs', title: 'Data Scientist', startDate: { year: 2021, month: 6 }, endDate: { year: 2023, month: 2 } },
  ],
  educations: [{ school: 'Example University', startDate: { year: 2017, month: 9 }, endDate: { year: 2021, month: 5 } }],
});

function plan(collections: ApplyProfileCollections, withGeometry = true) {
  const form = descriptor();
  return { form, plan: buildApplyPlan(form, {}, { collections, ...(withGeometry ? { readGeometry: measured } : {}) }) };
}

const keyed = (built: ReturnType<typeof buildApplyPlan>, key: string) => ({
  entries: built.entries.filter((entry) => entry.key === key),
  skipped: built.skipped.filter((skip) => skip.key === key),
});

describe('几何：分段日期按看得见的那一段量，不再判成蜜罐', () => {
  it('生产几何下，起止年月四段都进计划', () => {
    const { plan: built } = plan(PAST_JOB);
    for (const key of ['experience.startMonth', 'experience.startYear', 'experience.endMonth', 'experience.endYear']) {
      expect(keyed(built, key).entries.map((entry) => entry.value), key).toHaveLength(1);
      expect(keyed(built, key).skipped.filter((skip) => skip.reason === 'HONEYPOT'), key).toHaveLength(0);
    }
    expect(keyed(built, 'experience.startMonth').entries[0]!.value).toBe('6');
    expect(keyed(built, 'experience.endYear').entries[0]!.value).toBe('2023');
  });

  it('反向探针：没有被规则认成日期段的 1px 输入框照旧按它自己量、照旧是蜜罐', () => {
    const form = descriptor();
    const trap = document.createElement('input');
    trap.type = 'text';
    trap.name = 'website';
    trap.setAttribute('role', 'spinbutton');
    const holder = document.createElement('div');
    holder.append(trap);
    form.root.querySelectorAll('[data-fkit-id="socialNetworkAccounts--null"]')[0]!.append(holder);
    const compiled = adapter();
    const rescanned: ApplyFormDescriptor = { ...form, fields: [...compiled.scan(form.root)] };
    const built = buildApplyPlan(rescanned, {}, { collections: PAST_JOB, readGeometry: measured });
    const skip = built.skipped.find((item) => item.element === trap);
    expect(skip?.reason).toBe('HONEYPOT');
  });
});

describe('资料里的日期缺月份：MM/YYYY 两段一段都不写', () => {
  it('只写年份会留下「Invalid Date: /2021」——宁可两段都空着交给用户', () => {
    const noMonth = parseApplyProfileCollections({
      experiences: [{ company: 'Sample Labs', title: 'Data Scientist', startDate: { year: 2021, month: null }, endDate: { year: 2023, month: 2 } }],
    });
    const { plan: built } = plan(noMonth);
    expect(keyed(built, 'experience.startYear').entries).toHaveLength(0);
    expect(keyed(built, 'experience.startYear').skipped.map((skip) => skip.reason)).toEqual(['NO_VALUE']);
    expect(keyed(built, 'experience.startMonth').skipped.map((skip) => skip.reason)).toEqual(['NO_VALUE']);
    // 同一行的另一个日期不受牵连。
    expect(keyed(built, 'experience.endYear').entries.map((entry) => entry.value)).toEqual(['2023']);
  });

  it('只有年份一段的日期组（教育的 From/To）照写', () => {
    const { plan: built } = plan(PAST_JOB);
    expect(keyed(built, 'education.startYear').entries.map((entry) => entry.value)).toEqual(['2017']);
    expect(keyed(built, 'education.endYear').entries.map((entry) => entry.value)).toEqual(['2021']);
  });
});

describe('写入：逐段只发 input，等渲染落地，再单独提交一次', () => {
  it('月份与年份都进了宿主的表单模型，回读与宿主判决都通过', async () => {
    const { form, plan: built } = plan(PAST_JOB, false);
    const from = mountSegmentWidget(group('startDate'));
    const to = mountSegmentWidget(group('endDate'));
    const dates = { ...built, entries: built.entries.filter((entry) => /^experience\.(start|end)(Month|Year)$/.test(entry.key)) };
    expect(dates.entries).toHaveLength(4);
    const summary = await runApplyPlan({
      plan: dates,
      auth: testAuthority(dates.fingerprint, 'fill', [...capabilitiesForKinds(dates.entries.map((entry) => entry.kind))]),
      journal: createUndoJournal(),
      root: form.root,
      policy: workdayPolicy(),
    });
    expect(summary.results.map((result) => [result.key, result.ok])).toEqual([
      ['experience.startMonth', true],
      ['experience.startYear', true],
      ['experience.endMonth', true],
      ['experience.endYear', true],
    ]);
    expect(from.model()).toEqual({ mm: '06', yyyy: '2021' });
    expect(to.model()).toEqual({ mm: '02', yyyy: '2023' });
  });

  it('焦点正在这个日期组里：提交不会发生，这一段不写（写了就是一个模型里没有的「已填」）', async () => {
    const { form, plan: built } = plan(PAST_JOB, false);
    const from = mountSegmentWidget(group('startDate'));
    const month = group('startDate').querySelector<HTMLInputElement>('[data-automation-id="dateSectionMonth-input"]')!;
    month.focus();
    const dates = { ...built, entries: built.entries.filter((entry) => entry.key === 'experience.startMonth') };
    const summary = await runApplyPlan({
      plan: dates,
      auth: testAuthority(dates.fingerprint, 'fill', [...capabilitiesForKinds(dates.entries.map((entry) => entry.kind))]),
      journal: createUndoJournal(),
      root: form.root,
      policy: workdayPolicy(),
    });
    expect(summary.results).toEqual([{ key: 'experience.startMonth', label: expect.any(String), ok: false, reason: 'TARGET_NOT_WRITABLE' }]);
    expect(month.value).toBe('');
    expect(from.model()).toBeNull();
  });
});

describe('宿主判决：一个日期是一个值', () => {
  it('这一段自己没被标无效，但同组另一段被标了（Workday 在 Invalid Date 时标空着的那一段）→ 这一段判宿主不收', async () => {
    const { form, plan: built } = plan(PAST_JOB, false);
    mountSegmentWidget(group('startDate'));
    const year = group('startDate').querySelector<HTMLInputElement>('[data-automation-id="dateSectionYear-input"]')!;
    const only = { ...built, entries: built.entries.filter((entry) => entry.key === 'experience.startMonth') };
    const summary = await runApplyPlan({
      plan: only,
      auth: testAuthority(only.fingerprint, 'fill', [...capabilitiesForKinds(only.entries.map((entry) => entry.kind))]),
      journal: createUndoJournal(),
      root: form.root,
      policy: workdayPolicy(),
      readHostValidation: (element) => ({ ariaInvalid: element === year ? 'true' : null }),
    });
    expect(summary.results.map((result) => [result.key, result.ok ? 'ok' : result.reason])).toEqual([['experience.startMonth', 'HOST_REJECTED']]);
  });

  it('反向：组里别的段都没被标，照常成功', async () => {
    const { form, plan: built } = plan(PAST_JOB, false);
    mountSegmentWidget(group('startDate'));
    const only = { ...built, entries: built.entries.filter((entry) => entry.key === 'experience.startMonth') };
    const summary = await runApplyPlan({
      plan: only,
      auth: testAuthority(only.fingerprint, 'fill', [...capabilitiesForKinds(only.entries.map((entry) => entry.kind))]),
      journal: createUndoJournal(),
      root: form.root,
      policy: workdayPolicy(),
      readHostValidation: () => ({ ariaInvalid: null }),
    });
    expect(summary.results.map((result) => [result.key, result.ok])).toEqual([['experience.startMonth', true]]);
  });
});

describe('在职：I currently work here', () => {
  const CURRENT = parseApplyProfileCollections({
    experiences: [
      // 脏数据：在职却也带着结束日期——在职的那一段不写 To。
      { company: 'Example Robotics', title: 'ML Engineer', startDate: { year: 2023, month: 3 }, endDate: { year: 2024, month: 1 }, isCurrent: true },
    ],
  });

  it('在职的那一段：勾上勾选框，To 两段都不写', () => {
    const { plan: built } = plan(CURRENT);
    const current = keyed(built, 'experience.isCurrent');
    expect(current.entries.map((entry) => [entry.kind, entry.value])).toEqual([['choice', 'I currently work here']]);
    expect(keyed(built, 'experience.endMonth').entries).toHaveLength(0);
    expect(keyed(built, 'experience.endYear').entries).toHaveLength(0);
    expect(keyed(built, 'experience.startMonth').entries.map((entry) => entry.value)).toEqual(['3']);
  });

  it('不在职的那一段：不去碰它（本来就没勾）', () => {
    const { plan: built } = plan(PAST_JOB);
    const current = keyed(built, 'experience.isCurrent');
    expect(current.entries).toHaveLength(0);
    expect(current.skipped.map((skip) => skip.reason)).toEqual(['NOT_EMPTY']);
  });

  it('档案里没有这一段：照实说没有', () => {
    const { plan: built } = plan(parseApplyProfileCollections({}));
    expect(keyed(built, 'experience.isCurrent').skipped.map((skip) => skip.reason)).toEqual(['NO_VALUE']);
  });

  it('勾上它走原生勾选（点击），读得回 checked', async () => {
    const { form, plan: built } = plan(CURRENT, false);
    const only = { ...built, entries: built.entries.filter((entry) => entry.key === 'experience.isCurrent') };
    const summary = await runApplyPlan({
      plan: only,
      auth: testAuthority(only.fingerprint, 'fill', [...capabilitiesForKinds(only.entries.map((entry) => entry.kind))]),
      journal: createUndoJournal(),
      root: form.root,
      policy: workdayPolicy(),
      // 选择题的写入要求调用方给出宿主判决的读法（生产上是 kernelFiller 的 readHostValidationSignals）。
      readHostValidation: () => ({ ariaInvalid: 'false' }),
      lateRecheckMs: 5,
    });
    expect(summary.results.map((result) => [result.key, result.ok])).toEqual([['experience.isCurrent', true]]);
    expect(document.querySelector<HTMLInputElement>('input[name="currentlyWorkHere"]')!.checked).toBe(true);
  });
});
