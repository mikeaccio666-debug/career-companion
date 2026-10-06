import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import ashbyRules from '@edaix/apply-rules/ashby.json';
import bamboohrRules from '@edaix/apply-rules/bamboohr.json';
import doverRules from '@edaix/apply-rules/dover.json';
import greenhouseRules from '@edaix/apply-rules/greenhouse.json';
import leverRules from '@edaix/apply-rules/lever.json';
import ripplingRules from '@edaix/apply-rules/rippling.json';
import workableRules from '@edaix/apply-rules/workable.json';

import type { ApplyFieldDescriptor, VendorAdapter } from '../src/contracts';
import { buildAnswerPlan } from '../src/engine';
import { describeQuestion } from '../src/questions';
import { compileBundledAdapter, compileRuleAdapter } from '../src/rules/interpreter';
import { parseVendorRuleset } from '../src/rules/schema';
import { runApplyPlan } from '../src/runner';
import { createUndoJournal } from '../src/undo';
import { capabilitiesForKinds } from '../src/write/allowlist';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

/**
 * Question scopes（`questionScopes`，apply-rules 数据）：厂商声明的逐题容器与题干元素。
 *
 * 2026-09-15 ATS lab 对四家真实 posting 的只读实测：Lever 自定义题的控件只有 placeholder
 * 「Type your response」、单选/复选组没有 legend（6 题题干为空、2 题只剩 placeholder）；
 * Ashby 的「select all that apply」给每个 checkbox 起了自己选项文案的 name（一道题被拆成 7 道）、
 * location 自动完成框只剩 placeholder；Rippling 的长题干超出附近文字级联的 120 字上限；
 * Dover 的单选题题干是 styled div。题干为空的问题 `describeQuestion` 返回 null，永远答不了。
 *
 * 这里锁三件事：schema 的 fail-closed；解释器的三级标签来源（宿主声明 > 题干容器 > 推断）与
 * 容器归组；以及对四份真实夹具的红/绿——去掉规则数据，题干就回到空或 placeholder。
 */

afterEach(() => {
  document.documentElement.innerHTML = '<head></head><body></body>';
});

type RulesetSource = Record<string, unknown>;
const BUNDLED: Record<'lever' | 'ashby' | 'rippling' | 'dover', RulesetSource> = {
  lever: leverRules as RulesetSource,
  ashby: ashbyRules as RulesetSource,
  rippling: ripplingRules as RulesetSource,
  dover: doverRules as RulesetSource,
};

function syntheticRuleset(questionScopes?: unknown): VendorAdapter {
  const parsed = parseVendorRuleset({
    schemaVersion: 2,
    vendor: 'greenhouse',
    applyPath: { source: '.' },
    anchors: ['form#application-form'],
    excludeWithin: ['footer'],
    denyLabels: [{ source: 'captcha', flags: 'i' }],
    denyNameSubstrings: [],
    widgetNames: [],
    keySteps: [
      {
        type: 'labelPatterns',
        confidence: 0.75,
        patterns: [{ regex: { source: 'preferred name', flags: 'i' }, key: 'preferredName' }],
      },
    ],
    finalSubmitControl: null,
    ...(questionScopes === undefined ? {} : { questionScopes }),
  });
  if (!parsed.ok) throw new Error(parsed.code);
  return compileRuleAdapter(parsed.value);
}

function scanWith(adapter: VendorAdapter): readonly ApplyFieldDescriptor[] {
  const root = adapter.resolveRoot(document);
  expect(root, 'adapter could not prove the form root').not.toBeNull();
  return adapter.scan(root!);
}

function fieldAt(fields: readonly ApplyFieldDescriptor[], selector: string): ApplyFieldDescriptor | undefined {
  const element = document.querySelector(selector);
  return fields.find((field) => field.element === element);
}

/** 标签快照：夹具重新装载后旧的 element 引用就失效了，比较前后必须先把文字抄下来。 */
function labelsAt(fields: readonly ApplyFieldDescriptor[], selectors: readonly string[]): Record<string, string | undefined> {
  return Object.fromEntries(selectors.map((selector) => [selector, fieldAt(fields, selector)?.label]));
}

function optionsOf(field: ApplyFieldDescriptor | undefined): string[] {
  return field?.kind === 'choice' ? field.choice.options.map((option) => option.label) : [];
}

/** 同一份随包规则，带或不带 questionScopes——红/绿只差这一个键。 */
function fixtureAdapter(vendor: keyof typeof BUNDLED, withScopes: boolean): VendorAdapter {
  const source = structuredClone(BUNDLED[vendor]);
  if (!withScopes) delete source['questionScopes'];
  return compileBundledAdapter(source);
}

function scanFixture(vendor: keyof typeof BUNDLED, withScopes: boolean): readonly ApplyFieldDescriptor[] {
  document.documentElement.innerHTML = readFileSync(
    resolve(process.cwd(), 'tests/fixtures', vendor, 'application-form.html'),
    'utf8',
  );
  return scanWith(fixtureAdapter(vendor, withScopes));
}

const SCOPE = [{ container: '.question', label: '.title' }];

describe('parseVendorRuleset · questionScopes', () => {
  it('缺省归一化为空数组；声明后按原样保留，$comment 随行注释放行', () => {
    const base = structuredClone(workableRules) as RulesetSource;
    const absent = parseVendorRuleset(base);
    expect(absent.ok && absent.value.questionScopes).toEqual([]);

    const declared = parseVendorRuleset({
      ...base,
      '$comment.questionScopes': 'evidence lives here',
      questionScopes: [{ $comment: 'per entry too', container: 'li.q', label: '.t' }],
    });
    expect(declared.ok && declared.value.questionScopes).toEqual([{ container: 'li.q', label: '.t' }]);
  });

  it('畸形整份拒收：非数组、缺 label、空串、白名单外的键、重复 container', () => {
    const base = structuredClone(workableRules) as RulesetSource;
    for (const bad of [
      { container: 'li.q', label: '.t' },
      [{ container: 'li.q' }],
      [{ container: '', label: '.t' }],
      [{ container: 'li.q', label: '   ' }],
      [{ container: 'li.q', label: '.t', options: '.o' }],
      [{ container: 'li.q', label: '.t' }, { container: 'li.q', label: '.other' }],
      ['li.q'],
    ]) {
      expect(parseVendorRuleset({ ...base, questionScopes: bad }), JSON.stringify(bad)).toEqual({
        ok: false,
        code: 'RULES_MALFORMED',
      });
    }
  });

  it('随包内置数据：lever / ashby / rippling / dover 各声明一条，其余厂商为空', () => {
    for (const vendor of ['lever', 'ashby', 'rippling', 'dover'] as const) {
      const parsed = parseVendorRuleset(BUNDLED[vendor]);
      expect(parsed.ok && parsed.value.questionScopes, vendor).toHaveLength(1);
    }
    for (const source of [greenhouseRules, workableRules, bamboohrRules]) {
      const parsed = parseVendorRuleset(source);
      expect(parsed.ok && parsed.value.questionScopes).toEqual([]);
    }
  });
});

describe('question scope · 标签的三级来源', () => {
  it('宿主声明的名字永远压过题干；只有推断出来的标签（placeholder / 附近文字）才让题干接手', () => {
    document.body.innerHTML = `<form id="application-form">
      <div class="question"><div class="title">Declared question</div>
        <label for="a">Own label</label><input id="a" name="a" placeholder="Type your response" /></div>
      <div class="question"><div class="title">Placeholder question</div>
        <input id="b" name="b" placeholder="Type your response" /></div>
      <div class="question"><div class="title">Aria question</div>
        <input id="c" name="c" aria-label="Search" placeholder="Search" /></div>
      <div class="question"><div class="title">Prose question that the nearby text would otherwise hide</div>
        <div><span>Nearby prose</span><input id="d" name="d" /></div></div>
      <div class="question"><div class="title">Preferred name (what should we call you?)<span class="required">✱</span></div>
        <input id="e" name="e" placeholder="Type your response" /></div>
    </form>`;
    const ids = ['#a', '#b', '#c', '#d', '#e'];

    const before = scanWith(syntheticRuleset());
    expect(labelsAt(before, ids)).toEqual({
      '#a': 'Own label',
      '#b': 'Type your response',
      '#c': 'Search',
      '#d': 'Nearby prose',
      '#e': 'Type your response',
    });

    const after = scanWith(syntheticRuleset(SCOPE));
    expect(labelsAt(after, ids)).toEqual({
      '#a': 'Own label',
      '#b': 'Placeholder question',
      '#c': 'Search',
      '#d': 'Prose question that the nearby text would otherwise hide',
      '#e': 'Preferred name (what should we call you?)',
    });
    // 题干进入键推断：labelPatterns 看到的是题干，不是 placeholder。
    expect(fieldAt(before, '#e')?.key).toBeNull();
    expect(fieldAt(after, '#e')).toMatchObject({ key: 'preferredName', confidence: 0.75 });
  });

  it('fail closed：容器在扫描根之外、题干不唯一、题干元素包着控件、非法选择器 → 逐字同从前', () => {
    document.body.innerHTML = `<div class="question"><div class="title">Outside the form</div>
      <form id="application-form">
        <input id="none" name="none" placeholder="No container" />
        <div class="question"><div class="title">First</div><div class="title">Second</div>
          <input id="two" name="two" placeholder="Two titles" /></div>
        <div class="question"><div class="title">Wraps <input id="wrapped" name="wrapped" placeholder="Wrapped" /></div></div>
      </form></div>`;
    const expected = { '#none': 'No container', '#two': 'Two titles', '#wrapped': 'Wrapped' };
    for (const scopes of [undefined, SCOPE, [{ container: ':::nope', label: '.title' }], [{ container: '.question', label: ':::nope' }]]) {
      expect(labelsAt(scanWith(syntheticRuleset(scopes)), Object.keys(expected)), JSON.stringify(scopes)).toEqual(expected);
    }
  });

  it('choice：容器归组跨 name；题干 legend > scope；单成员保留自己的声明标签；没有容器时同名归组', () => {
    document.body.innerHTML = `<form id="application-form">
      <div class="question"><div class="title">How did you hear about us?</div>
        <label><input type="checkbox" name="LinkedIn" /> LinkedIn</label>
        <label><input type="checkbox" name="Glassdoor" /> Glassdoor</label>
      </div>
      <div class="question"><div class="title">Scope title</div>
        <fieldset><legend>Legend wins</legend>
          <label><input type="radio" name="r" value="y" /> Yes</label>
          <label><input type="radio" name="r" value="n" /> No</label>
        </fieldset>
      </div>
      <div class="question"><div class="title">Certification</div>
        <label><input type="checkbox" name="agree" /> I confirm the above is accurate</label>
      </div>
      <div class="question"><div class="title">Sponsorship needed?</div>
        <div class="yesno"><button type="button">Yes</button><button type="button">No</button><input type="checkbox" name="sponsor" tabindex="-1" /></div>
      </div>
      <label><input type="radio" name="loose" value="a" /> A</label>
      <label><input type="radio" name="loose" value="b" /> B</label>
    </form>`;
    const summary = (fields: readonly ApplyFieldDescriptor[]) =>
      fields.filter((field) => field.kind === 'choice').map((field) => [field.label, optionsOf(field)]);

    expect(summary(scanWith(syntheticRuleset()))).toEqual([
      ['LinkedIn', ['LinkedIn']],
      ['Glassdoor', ['Glassdoor']],
      ['Legend wins', ['Yes', 'No']],
      ['I confirm the above is accurate', ['I confirm the above is accurate']],
      ['YesNo', ['YesNo']],
      ['', ['A', 'B']],
    ]);

    const scoped = scanWith(syntheticRuleset(SCOPE));
    expect(summary(scoped)).toEqual([
      ['How did you hear about us?', ['LinkedIn', 'Glassdoor']],
      ['Legend wins', ['Yes', 'No']],
      ['I confirm the above is accurate', ['I confirm the above is accurate']],
      ['Sponsorship needed?', ['YesNo']],
      ['', ['A', 'B']],
    ]);
    expect(describeQuestion(fieldAt(scoped, 'input[name="LinkedIn"]')!, 'q0')).toMatchObject({
      text: 'How did you hear about us?',
      controlType: 'MULTI_CHOICE',
      fieldName: 'LinkedIn',
      options: [{ optionId: 'o0', text: 'LinkedIn' }, { optionId: 'o1', text: 'Glassdoor' }],
    });
  });

  it('denyLabels 对题干也查一次', () => {
    document.body.innerHTML = `<form id="application-form">
      <div class="question"><div class="title">Solve the captcha to continue</div>
        <label><input type="radio" name="bot" value="1" /> One</label>
        <label><input type="radio" name="bot" value="2" /> Two</label>
      </div>
      <div class="question"><div class="title">Solve the captcha</div><input name="text" placeholder="Type" /></div>
      <label for="ok">Fine</label><input id="ok" name="ok" />
    </form>`;
    expect(scanWith(syntheticRuleset(SCOPE)).map((field) => field.label)).toEqual(['Fine']);
  });
});

describe('question scope · 真实夹具红/绿（2026-09-15 实测结构）', () => {
  const LEVER_TEXT = 'input[name="cards[a69a985a-eae9-4c14-90fb-b5a4b891523e][field1]"]';
  const LEVER_RADIO = 'input[name="cards[1c719ca9-5069-4afe-9e82-39ca420e0edb][field0]"]';
  const LEVER_BOXES = 'input[name="cards[a69a985a-eae9-4c14-90fb-b5a4b891523e][field0]"]';
  const LEVER_SELECT = 'select[name="cards[a6197d84-549e-4a91-8bb0-6af972510013][field0]"]';
  const LEVER_CONSENT = 'input[name="cards[73796cde-fc01-4758-9002-c85155f3503d][field0]"]';
  const LEVER_CORE = ['[name="name"]', '[name="email"]', '[name="phone"]', '[name="urls[LinkedIn]"]', '[name="pronouns"]'];

  it('lever：自定义题的题干来自 li.application-question > .application-label；没有规则只剩 placeholder / 空', () => {
    const before = scanFixture('lever', false);
    expect(fieldAt(before, LEVER_TEXT)).toMatchObject({ label: 'Type your response', key: null });
    expect(fieldAt(before, LEVER_RADIO)).toMatchObject({ kind: 'choice', label: '' });
    expect(fieldAt(before, LEVER_BOXES)).toMatchObject({ kind: 'choice', label: '' });
    expect(fieldAt(before, LEVER_CONSENT)).toMatchObject({ kind: 'choice', label: '' });
    // 下拉题是这一组里**唯一**不靠规则也读得到题干的：它的题干容器里恰好只有一个控件，
    // 所以附近文字级联够得着。2026-09-15 之前够不着——`<option>` 的选项文字当时算进
    // textContent，题干被 3302 项选项撑过 120 字上限，级联只能放弃。标签文本改成
    // "只取用户读得到的那段"之后选项不再参与，这一栏的题干是白捡的。
    // 单选/复选/同意三题仍然非规则不可：它们的容器里有多个控件，级联按设计不发言。
    expect(fieldAt(before, LEVER_SELECT)?.label).toBe('Please tell us how you heard about this opportunity.');
    const coreBefore = labelsAt(before, LEVER_CORE);

    const after = scanFixture('lever', true);
    expect(fieldAt(after, LEVER_TEXT)).toMatchObject({
      label: 'Preferred Name | What would you like us to call you?',
      key: 'preferredName',
    });
    expect(fieldAt(after, LEVER_RADIO)).toMatchObject({
      kind: 'choice',
      label: 'Are you legally authorized to work in the country for which you are applying?',
      required: true,
    });
    expect(optionsOf(fieldAt(after, LEVER_RADIO))).toEqual(['Yes', 'No']);
    expect(fieldAt(after, LEVER_BOXES)).toMatchObject({ kind: 'choice', label: 'Language Skill(s) (Check all that apply)' });
    expect(optionsOf(fieldAt(after, LEVER_BOXES))).toEqual(['English (ENG)', 'Spanish (SPA)', 'French (FRA)']);
    expect(fieldAt(after, LEVER_SELECT)).toMatchObject({ kind: 'select', label: 'Please tell us how you heard about this opportunity.' });
    expect(fieldAt(after, LEVER_CONSENT)?.label).toMatch(/^As part of our interview process, we may use AI notetakers/);
    expect(describeQuestion(fieldAt(after, LEVER_SELECT)!, 'q')).toMatchObject({ controlType: 'SINGLE_CHOICE' });
    expect(describeQuestion(fieldAt(after, LEVER_RADIO)!, 'q')).toMatchObject({ controlType: 'SINGLE_CHOICE' });

    // 核心字段自带包裹 label：前后逐字相同。
    expect(labelsAt(after, LEVER_CORE)).toEqual(coreBefore);
    expect(coreBefore['[name="name"]']).toBe('Full name');
    // 这一页除简历文件外每个控件都有题干，且没有一个只剩自己的 placeholder。
    for (const field of after) {
      if (field.kind === 'file') continue;
      expect(field.label, field.element.getAttribute('name') ?? '').not.toBe('');
      expect(field.label).not.toBe(field.element.getAttribute('placeholder'));
    }
  });

  it('lever：读到题干的单选组可以被审阅答案写入（同名成员、同一 form）', async () => {
    const fields = scanFixture('lever', true);
    const adapter = fixtureAdapter('lever', true);
    const root = adapter.resolveRoot(document)!;
    const radio = document.querySelector<HTMLInputElement>(LEVER_RADIO)!;
    const text = document.querySelector<HTMLInputElement>(LEVER_TEXT)!;
    const plan = buildAnswerPlan({ vendor: 'lever', root, fields: [...fields] }, [
      { questionId: 'authorized', element: radio, value: 'Yes' },
      { questionId: 'preferred', element: text, value: 'Ada' },
    ]);
    // 条目按页面顺序：文本题在单选题之前。
    expect(plan.entries.map((entry) => [entry.key, entry.kind])).toEqual([
      ['question:preferred', 'text'],
      ['question:authorized', 'choice'],
    ]);
    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(plan.entries.map((entry) => entry.kind))]),
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
      readHostValidation: () => ({ ariaInvalid: 'false' }),
      lateRecheckMs: 5,
    });
    expect(summary.results.map((result) => [result.key, result.ok])).toEqual([
      ['question:preferred', true],
      ['question:authorized', true],
    ]);
    expect(radio.checked).toBe(true);
    expect(text.value).toBe('Ada');
  });

  const ASHBY_LOCATION = 'input.ashby-application-form-input-autocomplete';
  const ASHBY_YESNO = 'input[name="790b5934-74f5-46f5-897a-675b7f37f2f3"]';
  const ASHBY_YESNO_ENTRY = '[data-field-path="790b5934-74f5-46f5-897a-675b7f37f2f3"]';
  const ASHBY_PRONOUNS = 'input[name="bd5b0ecb-7bba-4958-946f-47ac05bea7c1_b0a5aba8-dbb7-41a9-b548-f72cc3e48956"]';
  const ASHBY_LEGACY = 'input[name="26c8666f-a821-493e-921c-b6f966a1c09d_fe19ec8e-680c-4f8d-bc5b-0c0866587f75"]';
  const ASHBY_CORE = ['#_systemfield_name', '#_systemfield_email', '[id="6187fd70-0105-4785-8940-1c1f804dbc8a"]'];
  const ASHBY_SOURCES = ['LinkedIn', 'Glassdoor', 'Notion Blog', 'Conference or Meetup'];

  it('ashby：题干来自 label.ashby-application-form-question-title；复选组按容器归组而不是按 name 拆开', () => {
    const before = scanFixture('ashby', false);
    expect(fieldAt(before, ASHBY_LOCATION)).toMatchObject({ kind: 'combobox', label: 'Start typing...' });
    expect(fieldAt(before, ASHBY_YESNO)).toMatchObject({ kind: 'choice', label: 'Yes No' });
    expect(fieldAt(before, ASHBY_PRONOUNS)).toMatchObject({ kind: 'choice', label: '' });
    expect(before.filter((field) => ASHBY_SOURCES.includes(field.element.getAttribute('name') ?? '')).map((field) => [field.label, optionsOf(field)]))
      .toEqual(ASHBY_SOURCES.map((name) => [name, [name]]));
    // 2026-08-01 形态的同名 radio 对没有题干容器：前后逐字相同（fail closed）。
    expect(fieldAt(before, ASHBY_LEGACY)).toMatchObject({ kind: 'choice', label: '' });
    const coreBefore = labelsAt(before, ASHBY_CORE);

    const after = scanFixture('ashby', true);
    expect(fieldAt(after, ASHBY_LOCATION)).toMatchObject({ kind: 'combobox', label: 'Location' });
    // 2026-09-23 起是非题按 ARIA 代理题读（dict/ariaChoice.ts）：两颗 aria-pressed 按钮是它的选项，
    // 由第一颗报告；那个只镜像 Yes 的 checkbox 不再是一道「YesNo」单项题。没有题干容器（上面的 before）
    // 时按钮归不了题，那一侧逐字不变。
    expect(fieldAt(after, ASHBY_YESNO), '镜像 checkbox 不再是第二个字段').toBeUndefined();
    const yesNo = fieldAt(after, `${ASHBY_YESNO_ENTRY} button`);
    expect(yesNo).toMatchObject({
      kind: 'choice',
      label: 'Will you now or in the future require Notion to sponsor an immigration case in order to employ you?',
      choice: { control: 'proxy', proxy: 'toggle', multiple: false },
    });
    expect(optionsOf(yesNo)).toEqual(['Yes', 'No']);
    expect(fieldAt(after, ASHBY_PRONOUNS)).toMatchObject({ kind: 'choice', label: 'What pronouns would you like our team to use when addressing you?' });
    expect(optionsOf(fieldAt(after, ASHBY_PRONOUNS))).toEqual(['He/Him', 'She/Her', 'They/Them', 'Prefer not to say']);
    const source = after.filter((field) => ASHBY_SOURCES.includes(field.element.getAttribute('name') ?? ''));
    expect(source).toHaveLength(1);
    expect(source[0]).toMatchObject({ kind: 'choice', label: 'How did you hear about this opportunity? (select all that apply)' });
    expect(optionsOf(source[0])).toEqual(ASHBY_SOURCES);
    expect(describeQuestion(source[0]!, 'q')).toMatchObject({ controlType: 'MULTI_CHOICE', fieldName: 'LinkedIn' });
    // 一份审阅答案落成一条 choice 条目（写入器对无 <form> 的跨 name 组另有裁决，不在本文件范围）。
    const plan = buildAnswerPlan(
      { vendor: 'ashby', root: fixtureAdapter('ashby', true).resolveRoot(document)!, fields: [...after] },
      [{ questionId: 'source', element: source[0]!.element, value: 'Glassdoor' }],
    );
    expect(plan.entries.map((entry) => [entry.key, entry.kind, entry.value])).toEqual([['question:source', 'choice', 'Glassdoor']]);

    expect(fieldAt(after, ASHBY_LEGACY)).toMatchObject({ kind: 'choice', label: '' });
    expect(optionsOf(fieldAt(after, ASHBY_LEGACY))).toEqual(['Yes', 'No']);
    expect(labelsAt(after, ASHBY_CORE)).toEqual(coreBefore);
    expect(coreBefore['#_systemfield_name']).toBe('Name');
  });

  const RIPPLING_CORE = ['#field-8', '#field-12', '#field-16', '#field-20', '#field-31', '#field-42', '#field-73'];

  it('rippling：长题干的 textarea 靠 .marginY--36 容器读到题干；短题干与推断一致；核心字段不变', () => {
    const before = scanFixture('rippling', false);
    expect(fieldAt(before, '#field-59')).toMatchObject({ kind: 'textarea', label: '', required: true });
    expect(fieldAt(before, '#field-55')?.label).toBe('Describe your direct experience working on fintech, lending, credit, or payments products');
    const coreBefore = labelsAt(before, RIPPLING_CORE);

    const after = scanFixture('rippling', true);
    expect(fieldAt(after, '#field-59')).toMatchObject({
      kind: 'textarea',
      label: 'Tell us about a product you built or managed in a regulated environment. What specific compliance or regulatory requirements did you have to account for, and how did you incorporate them into the product?',
    });
    expect(fieldAt(after, '#field-55')?.label).toBe('Describe your direct experience working on fintech, lending, credit, or payments products');
    expect(describeQuestion(fieldAt(after, '#field-59')!, 'q')).toMatchObject({ controlType: 'TEXTAREA', required: true });
    expect(labelsAt(after, RIPPLING_CORE)).toEqual(coreBefore);
    expect(coreBefore['#field-8']).toBe('First name');
    // 页面上没有任何题干文字的 sms_opt_in 组：规则对它不发言，仍为空（已知缺口）。
    expect(fieldAt(after, 'input[name="sms_opt_in"]')).toMatchObject({ kind: 'choice', label: '' });
  });

  const DOVER_RADIO = 'input[name="175bbfa0-6011-468c-9d02-faf41e4282cb"]';

  it('dover：单选组的题干来自最近 .MuiBox-root 里的 styles__FormLabel；没有规则为空', () => {
    const before = scanFixture('dover', false);
    expect(fieldAt(before, DOVER_RADIO)).toMatchObject({ kind: 'choice', label: '', required: true });
    // 夹具里的核心字段仍是 2026-08-23 的零宽空格 label 简化形态：没有题干容器，前后都为空。
    expect(fieldAt(before, 'input[name="firstName"]')?.label).toBe('');

    const after = scanFixture('dover', true);
    expect(fieldAt(after, DOVER_RADIO)).toMatchObject({
      kind: 'choice',
      label: 'How many years of experience do you have reporting directly to a founder of a company?',
      required: true,
    });
    expect(optionsOf(fieldAt(after, DOVER_RADIO))).toEqual([
      "I haven't reported directly to a founder before.",
      '< 1 year',
      '1 - 3 years',
      '3+ years',
    ]);
    expect(describeQuestion(fieldAt(after, DOVER_RADIO)!, 'q')).toMatchObject({
      controlType: 'SINGLE_CHOICE',
      fieldName: '175bbfa0-6011-468c-9d02-faf41e4282cb',
    });
    expect(fieldAt(after, 'input[name="firstName"]')?.label).toBe('');
  });
});
