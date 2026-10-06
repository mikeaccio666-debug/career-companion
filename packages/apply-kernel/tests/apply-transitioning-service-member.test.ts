/**
 * 「Are you a transitioning service member?」（2026-09-24，负责人：跟 Jobright 一样）。
 *
 * Shield AI 的 Lever 表单上是一道必填单选（No / Yes），后面跟一道「If yes, what partnership program are you working
 * with?」。Jobright 答了它；我们从前一律「资料里没有答案」。现在按工作经历推：有工作经历、且没有一段看起来是军队服役
 * （陆海空军、海军陆战队、海岸警卫队、太空军、国民警卫队、美国武装部队、国防部……）就答 No，条目带依据
 * （NO_MILITARY_SERVICE_IN_HISTORY），浮层据此写明。有一段像军职、或工作经历一段都没有，就照旧不答。
 *
 * 题面由规则认（十家共用一条 labelPatterns，键 transitioningServiceMember），内核再核一遍是那一句本身：
 * 带条件、否定、掺了退伍军人（EEO）或问的是家属的，不答。只在选项控件上写，页面上恰好一项对得上才写。
 *
 * 题面与资料全是合成的。
 */

import { afterEach, describe, expect, it } from 'vitest';
import ashby from '@edaix/apply-rules/ashby.json';
import dover from '@edaix/apply-rules/dover.json';
import generic from '@edaix/apply-rules/generic.json';
import greenhouse from '@edaix/apply-rules/greenhouse.json';
import icims from '@edaix/apply-rules/icims.json';
import jobvite from '@edaix/apply-rules/jobvite.json';
import lever from '@edaix/apply-rules/lever.json';
import rippling from '@edaix/apply-rules/rippling.json';
import smartrecruiters from '@edaix/apply-rules/smartrecruiters.json';
import workable from '@edaix/apply-rules/workable.json';

import type { ApplyFormDescriptor } from '../src/contracts';
import { transitioningServiceMemberAnswer } from '../src/dict/historyAnswers';
import { buildApplyPlan } from '../src/engine';
import { parseApplyProfileCollections, type ApplyProfileCollections } from '../src/profileCollections';
import { compileBundledAdapter } from '../src/rules/interpreter';
import { parseVendorRuleset } from '../src/rules/schema';

afterEach(() => { document.body.innerHTML = ''; });

const QUESTION = 'Are you a transitioning service member?';
const CIVILIAN = parseApplyProfileCollections({
  experiences: [
    { company: 'Acme Robotics', title: 'Software Engineer' },
    { company: 'Example Analytics', title: 'Data Analyst' },
  ],
  educations: [{ school: 'Example University', fieldOfStudy: 'Computer Science' }],
});
const withExperience = (company: string, title: string | null = 'Analyst'): ApplyProfileCollections =>
  parseApplyProfileCollections({ experiences: [{ company: 'Acme Robotics', title: 'Software Engineer' }, { company, title }] });

describe('推断：工作经历里没有军职就答 No', () => {
  it('有工作经历、一段都不像军职 → No，带依据', () => {
    expect(transitioningServiceMemberAnswer(QUESTION, CIVILIAN)).toEqual({ answer: 'NO', basis: 'NO_MILITARY_SERVICE_IN_HISTORY' });
  });

  it('工作经历一段都没有（只有教育）、或集合没交来 → 不答', () => {
    expect(transitioningServiceMemberAnswer(QUESTION, parseApplyProfileCollections({ educations: [{ school: 'Example University' }] }))).toBeNull();
    expect(transitioningServiceMemberAnswer(QUESTION, undefined)).toBeNull();
  });

  it.each([
    ['U.S. Army', null],
    ['United States Army', 'Infantry Officer'],
    ['US Navy', null],
    ['Department of the Navy', 'Logistics Specialist'],
    ['U.S. Air Force', null],
    ['United States Marine Corps', null],
    ['U.S. Coast Guard', null],
    ['United States Space Force', null],
    ['Army National Guard', null],
    ['Air National Guard', null],
    ['U.S. Armed Forces', null],
    ['Department of Defense', 'Program Analyst'],
    ['DoD', null],
    ['USMC', null],
    ['Acme Defense Contracting', 'Sergeant'],
    ['Acme Defense Contracting', 'Petty Officer Second Class'],
  ])('有一段像军职（%s / %s）→ 不答', (company, title) => {
    expect(transitioningServiceMemberAnswer(QUESTION, withExperience(company, title))).toBeNull();
  });

  it('教育里是军校或 ROTC → 也不答（宁可交还本人）', () => {
    const cadet = parseApplyProfileCollections({
      experiences: [{ company: 'Acme Robotics', title: 'Software Engineer' }],
      educations: [{ school: 'United States Military Academy' }],
    });
    expect(transitioningServiceMemberAnswer(QUESTION, cadet)).toBeNull();
    const rotc = parseApplyProfileCollections({
      experiences: [{ company: 'Acme Robotics', title: 'Software Engineer' }],
      educations: [{ school: 'Example University', fieldOfStudy: 'Army ROTC' }],
    });
    expect(transitioningServiceMemberAnswer(QUESTION, rotc)).toBeNull();
  });

  it.each([
    'Are you a transitioning service member?',
    'Are you currently a transitioning service member?',
    'Are you a transitioning military service member?',
    'Transitioning Service Member',
    'Are you a transitioning servicemember? (required)',
  ])('「%s」→ 答', (label) => {
    expect(transitioningServiceMemberAnswer(label, CIVILIAN)).toMatchObject({ answer: 'NO' });
  });

  it.each([
    'If you are a transitioning service member, which program are you working with?',
    'If yes, what partnership program are you working with?',
    'Are you a veteran or transitioning service member?',
    'Are you not a transitioning service member?',
    'Is your spouse a transitioning service member?',
    'Are you a military spouse or dependent of a transitioning service member?',
  ])('「%s」→ 不答', (label) => {
    expect(transitioningServiceMemberAnswer(label, CIVILIAN)).toBeNull();
  });
});

const RULESETS = { ashby, dover, generic, greenhouse, icims, jobvite, lever, rippling, smartrecruiters, workable } as const;

function keyFor(rules: unknown, label: string): string | null {
  const patterns: { key: string; re: RegExp }[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (record['type'] === 'labelPatterns') {
      for (const entry of record['patterns'] as { key: string; regex: { source: string; flags: string } }[]) {
        patterns.push({ key: entry.key, re: new RegExp(entry.regex.source, entry.regex.flags) });
      }
    }
    for (const child of Object.values(record)) walk(child);
  };
  walk(rules);
  return patterns.find((entry) => entry.re.test(label.toLowerCase()))?.key ?? null;
}

describe('规则：十家都认这一句，键是 transitioningServiceMember', () => {
  it.each(Object.keys(RULESETS))('%s', (vendor) => {
    const rules = RULESETS[vendor as keyof typeof RULESETS];
    // 发布侧的严格解析认得这个键（旧内核按「不认识的键」跳过这一条，不整份拒收）。
    expect(parseVendorRuleset(rules, { unknownFieldKeys: 'reject' }).ok).toBe(true);
    for (const label of [
      'Are you a transitioning service member?',
      'Are you currently a transitioning service member?',
      'Are you a transitioning military service member?',
      'Transitioning Service Member',
      'Are you a transitioning service member?✱',
    ]) {
      expect(keyFor(rules, label), label).toBe('transitioningServiceMember');
    }
    for (const label of [
      'If yes, what partnership program are you working with?',
      'If you are a transitioning service member, which program are you working with?',
      'Are you a veteran or transitioning service member?',
      'Is your spouse a transitioning service member?',
    ]) {
      expect(keyFor(rules, label), label).not.toBe('transitioningServiceMember');
    }
  });
});

/** Shield AI 那一页的形状（Lever 自定义题，2026-09-24 ats-lab 抓取里的结构：题干在 .application-label，单选 No／Yes）。 */
function leverForm(controls: string): ApplyFormDescriptor {
  document.body.innerHTML = `
    <form id="application-form" method="POST">
      <li class="application-question">
        <label><span class="application-label">Full name✱</span><input type="text" name="name" required /></label>
      </li>
      ${controls}
    </form>`;
  const adapter = compileBundledAdapter(lever);
  const root = adapter.resolveRoot(document)!;
  return { vendor: 'lever', root, fields: [...adapter.scan(root)] };
}
const card = (id: string, label: string, body: string): string => `
  <li class="application-question custom-question">
    <div>
      <div class="application-label full-width multiple-choice"><div class="text">${label}<span class="required">✱</span></div></div>
      <div class="application-field full-width required-field">${body}</div>
    </div>
  </li>`;
const radios = (id: string, options: readonly string[]): string =>
  `<ul data-qa="multiple-choice">${options.map((text) =>
    `<li><label><input type="radio" name="cards[${id}][field0]" value="${text}" required="required"><span class="application-answer-alternative">${text}</span></label></li>`).join('')}</ul>`;
const SHIELD = card('07fdf1f1-9952-493d-a9b7-320969a56fed', QUESTION, radios('07fdf1f1-9952-493d-a9b7-320969a56fed', ['No', 'Yes'])) +
  card('07fdf1f1-9952-493d-a9b7-320969a56fee', 'If yes, what partnership program are you working with?',
    radios('07fdf1f1-9952-493d-a9b7-320969a56fee', ['Hiring our Heroes', 'NextOp', 'Skillbridge general (no program)']));

describe('计划：Lever 单选按工作经历答 No', () => {
  it('没有军职 → No，带依据；后面那道「If yes, …」照旧不答', () => {
    const plan = buildApplyPlan(leverForm(SHIELD), { fullName: 'Taylor Example' } as never, { collections: CIVILIAN });
    expect(plan.entries.find((entry) => entry.label === QUESTION)).toMatchObject({
      key: 'transitioningServiceMember', kind: 'choice', value: 'No', historyBasis: 'NO_MILITARY_SERVICE_IN_HISTORY',
    });
    expect(plan.entries.some((entry) => entry.label.startsWith('If yes'))).toBe(false);
  });

  it('有一段像军职、或没有工作经历、或集合没交来 → 不写，单选照旧 CHOICE_NO_DATA', () => {
    for (const collections of [withExperience('U.S. Army'), parseApplyProfileCollections({ educations: [{ school: 'Example University' }] }), undefined]) {
      const plan = buildApplyPlan(leverForm(SHIELD), { fullName: 'Taylor Example' } as never, collections === undefined ? {} : { collections });
      expect(plan.entries.some((entry) => entry.label === QUESTION)).toBe(false);
      expect(plan.skipped.find((skip) => skip.label === QUESTION)).toMatchObject({ reason: 'CHOICE_NO_DATA', key: 'transitioningServiceMember' });
    }
  });

  it('原生下拉照样按 No；文本框不写（没有「恰好一项」可对）', () => {
    const select = card('aa', QUESTION, `<select name="cards[aa][field0]" required=""><option value="">Select...</option><option>Yes</option><option>No</option></select>`);
    const selectPlan = buildApplyPlan(leverForm(select), { fullName: 'Taylor Example' } as never, { collections: CIVILIAN });
    expect(selectPlan.entries.find((entry) => entry.label === QUESTION)).toMatchObject({ kind: 'select', resolvedOptionText: 'No' });
    const text = card('bb', QUESTION, `<input class="card-field-input" type="text" name="cards[bb][field0]" />`);
    const textPlan = buildApplyPlan(leverForm(text), { fullName: 'Taylor Example' } as never, { collections: CIVILIAN });
    expect(textPlan.entries.some((entry) => entry.label === QUESTION)).toBe(false);
    expect(textPlan.skipped.find((skip) => skip.label === QUESTION)).toMatchObject({ reason: 'USER_ONLY' });
  });

  it('页面上已经选了一项：不改', () => {
    const plan = buildApplyPlan(leverForm(SHIELD.replace('value="Yes" required', 'value="Yes" checked required')), { fullName: 'Taylor Example' } as never, { collections: CIVILIAN });
    expect(plan.skipped.find((skip) => skip.label === QUESTION)).toMatchObject({ reason: 'NOT_EMPTY' });
  });
});
