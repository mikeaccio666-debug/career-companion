/**
 * 反着问的年龄题（2026-09-24，负责人：顺手修掉的老毛病）。
 *
 * 规则的 over18 正则也认「Are you under the age of 18?」，内核却一律按「是否年满 18」答：档案里「年满 18」
 * → 对「你未满 18 吗」答了「是」。现在由一个判读（dict/ageQuestion.ts）决定问的是哪一边：年满那一边照档案值答，
 * 未满那一边答它的反面，说不清（带条件、否定、两边都提、问号前还问了别的）就不答。明确的档案值与按学历／工作经历
 * 推出来的值共用这一个判读。规则正则同时补上别的反着问的说法（under 18、younger than 18、not yet 18、
 * Are you a minor），每一家都认。
 *
 * 题面全是合成的。
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
import workday from '@edaix/apply-rules/workday.json';

import type { ApplyFormDescriptor, ScanRootOptions } from '../src/contracts';
import { ageQuestion } from '../src/dict/ageQuestion';
import { buildApplyPlan, type BuildPlanOptions } from '../src/engine';
import type { ApplyProfileCollections } from '../src/profileCollections';
import { compileBundledAdapter } from '../src/rules/interpreter';
import { ashbyAdapter } from '../src/sites/ashby/applyForm';

afterEach(() => { document.body.innerHTML = ''; });

describe('判读：问的是哪一边', () => {
  it.each([
    'Are you at least 18 years of age?',
    'Are you 18 years of age or older?',
    'Are you over the age of 18?',
    'Over 18?',
    'I am at least 18 years of age',
    'Are you at least 18 years old? If not, please explain.',
  ])('「%s」→ AT_LEAST_18', (label) => {
    expect(ageQuestion(label)).toBe('AT_LEAST_18');
  });

  it.each([
    'Are you under the age of 18?',
    'Are you under 18 years of age?',
    'Are you under 18?',
    'Are you younger than 18?',
    'Are you not yet 18?',
    'Are you a minor?',
    'Are you currently a minor?',
    'Is the applicant under 18?',
    'I am under 18 years of age',
    'Are you a minor (under 18 years of age)?',
    'Are you under 18 (required)?',
  ])('「%s」→ UNDER_18', (label) => {
    expect(ageQuestion(label)).toBe('UNDER_18');
  });

  it.each([
    'If you are under the age of 18, please enter your work permit number',
    'Are you under 18 or over 65?',
    'Are you not under 18?',
    'Are you not at least 18 years of age?',
    'Are you at least 18 years old or an emancipated minor?',
    'Do you have a driver license? (You must be at least 18 years of age.)',
  ])('「%s」→ null（说不清就不答）', (label) => {
    expect(ageQuestion(label)).toBeNull();
  });
});

// Workday 从 2026-09-24（法定工作年龄那一刀）起也带同一条 over18 正则：第十一家。
const RULESETS = { ashby, dover, generic, greenhouse, icims, jobvite, lever, rippling, smartrecruiters, workable, workday } as const;

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

describe('规则：反着问的说法每一家都认成 over18', () => {
  it.each(Object.keys(RULESETS))('%s', (vendor) => {
    const rules = RULESETS[vendor as keyof typeof RULESETS];
    for (const label of [
      'Are you under the age of 18?',
      'Are you under 18?',
      'Are you under 18 years of age?',
      'Are you younger than 18?',
      'Are you not yet 18?',
      'Are you a minor?',
      'Are you currently a minor?',
      'Are you at least 18 years of age?',
    ]) {
      expect(keyFor(rules, label), label).toBe('over18');
    }
    // 教育段里的「辅修」不是年龄题。
    for (const label of ['Minor', 'Minor (optional)', 'What was your minor?', 'Do you have a minor in Computer Science?', 'Do you have less than 18 months of experience?']) {
      expect(keyFor(rules, label), label).not.toBe('over18');
    }
  });
});

const EDUCATION = {
  school: 'Example University', degreeLevel: 'BACHELOR', fieldOfStudy: 'Design',
  startDate: { year: 2016, month: 9 }, endDate: { year: 2020, month: 5 },
  location: null, gpa: null, gpaScale: null, isCurrent: false,
} as const;
const WITH_EDUCATION: ApplyProfileCollections = { educations: [EDUCATION] };

let groups = 0;
function greenhouseForm(controls: string): ApplyFormDescriptor {
  document.body.innerHTML = `<form id="application-form">
    <label for="first_name">First Name</label><input id="first_name" type="text" />
    ${controls}
  </form>`;
  const adapter = compileBundledAdapter(greenhouse);
  const root = adapter.resolveRoot(document)!;
  return { vendor: 'greenhouse', root, fields: [...adapter.scan(root)] };
}
const radios = (label: string, options: readonly string[] = ['Yes', 'No']): string => {
  groups += 1;
  return `<fieldset><legend>${label}</legend>
    ${options.map((text, index) => `<label><input name="g${groups}" type="radio" value="${index}" /> ${text}</label>`).join('')}
  </fieldset>`;
};
const select = (label: string): string => {
  groups += 1;
  return `<label for="s${groups}">${label}</label>
    <select id="s${groups}"><option value="">Select...</option><option>Yes</option><option>No</option></select>`;
};
const textBox = (label: string): string => {
  groups += 1;
  return `<label for="t${groups}">${label}</label><input id="t${groups}" type="text" />`;
};

const plan = (controls: string, profile: Record<string, string>, options: BuildPlanOptions = {}) =>
  buildApplyPlan(greenhouseForm(controls), { firstName: 'Taylor', ...profile } as never, options);
const entryFor = (result: ReturnType<typeof plan>, label: string) => result.entries.find((entry) => entry.label === label);
const skipFor = (result: ReturnType<typeof plan>, label: string) => result.skipped.find((item) => item.label === label);

describe('反着问的年龄题：答逻辑上对的那一项', () => {
  it.each([
    'Are you under the age of 18?',
    'Are you under 18 years of age?',
    'Are you under 18?',
    'Are you younger than 18?',
    'Are you not yet 18?',
    'Are you a minor?',
  ])('「%s」：档案年满 18 → No；档案未满 18 → Yes', (label) => {
    expect(entryFor(plan(radios(label), { over18: 'true' }), label)).toMatchObject({ key: 'over18', value: 'No' });
    expect(entryFor(plan(radios(label), { over18: 'false' }), label)).toMatchObject({ key: 'over18', value: 'Yes' });
  });

  it('原生下拉与文本框同样按反面答', () => {
    const label = 'Are you under the age of 18?';
    expect(entryFor(plan(select(label), { over18: 'true' }), label)).toMatchObject({ kind: 'select', resolvedOptionText: 'No' });
    expect(entryFor(plan(textBox(label), { over18: 'true' }), label)).toMatchObject({ kind: 'text', value: 'No' });
  });

  it('推出来的年满 18 同样按反面答，并带上依据', () => {
    const label = 'Are you under the age of 18?';
    expect(entryFor(plan(radios(label), {}, { collections: WITH_EDUCATION }), label)).toMatchObject({
      key: 'over18', value: 'No', historyBasis: 'ADULT_FROM_HISTORY',
    });
  });

  it('正着问的照旧：年满 18 → Yes', () => {
    const label = 'Are you at least 18 years of age?';
    expect(entryFor(plan(radios(label), { over18: 'true' }), label)).toMatchObject({ key: 'over18', value: 'Yes' });
  });

  it.each([
    // 从前这一栏按「年满 18」写进了「Yes」（规则的「age of 18」认了它）。
    ['If you are under the age of 18, please describe your school schedule', textBox],
    ['Are you not under 18?', radios],
    ['Are you under 18 or over 65?', radios],
  ] as const)('说不清的「%s」→ 不答（LOW_CONFIDENCE），明确值与推出来的值都一样', (label, control) => {
    for (const [profile, options] of [[{ over18: 'true' }, {}], [{}, { collections: WITH_EDUCATION }]] as const) {
      const result = plan(control(label), profile, options);
      expect(entryFor(result, label)).toBeUndefined();
      expect(skipFor(result, label)).toMatchObject({ reason: 'LOW_CONFIDENCE' });
    }
  });

  it('Ashby 的是非按钮：「未满 18 吗」按 No 那一颗', () => {
    const REQUIRED_CLASS = 'hashed-required';
    const scanOptions: ScanRootOptions = {
      readGeneratedContent: (element, pseudo) =>
        pseudo === '::after' && element.classList.contains(REQUIRED_CLASS) ? '"*"' : 'none',
    };
    const label = 'Are you under the age of 18?';
    document.body.innerHTML = `
      <div class="ashby-application-form-container">
        <div class="ashby-application-form-field-entry" data-field-path="question_3001">
          <label class="${REQUIRED_CLASS} ashby-application-form-question-title" for="question_3001">${label}</label>
          <div class="ashby-application-form-input-yesno">
            <button class="ashby-application-form-input-yesno-option" aria-pressed="false">Yes</button>
            <button class="ashby-application-form-input-yesno-option" aria-pressed="false">No</button>
            <input type="checkbox" tabindex="-1" name="question_3001">
          </div>
        </div>
      </div>`;
    const root = ashbyAdapter.resolveRoot(document, scanOptions)!;
    const form: ApplyFormDescriptor = { vendor: 'ashby', root, fields: [...ashbyAdapter.scan(root, scanOptions)] };
    const result = buildApplyPlan(form, { over18: 'true' } as never, {});
    expect(result.entries.find((entry) => entry.label === label)).toMatchObject({ kind: 'choice', key: 'over18', value: 'No' });
  });
});
