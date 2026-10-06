/**
 * 「到了在 X 合法工作的年龄吗」按年龄答（2026-09-24）。
 *
 * adobe.wd5 第 3 步 Application Questions 上的原题：「Are you of legal age to work in the country in which this position will
 * be based?*」。它问的是年龄，不是工作授权。负责人 2026-09-24 的决定是「有学历或工作经历就答年满 18」；各地的法定工作
 * 年龄都不高于 18 岁，所以年满 18（档案里明确的，或按学历／工作经历推出来的）就答肯定的那一项。反过来不成立：未满 18
 * 的人在很多地方也到了法定工作年龄——档案明确未满 18 时不答，交还用户（随岗位所在地而定，JOB_DEPENDENT）。
 *
 * 判读是整句的（dict/ageQuestion.ts）：问号前那一句除了「legal age to work / legal working age」只许有问法与地点那几类字；
 * 带别的限定（in a bar——那是另一个年龄）、否定、或同一句还问了工作授权的，一律不答。规则那一边（数据）：十一家共用的
 * over18 正则认这几种说法，「legal drinking age」「legal age to sell …」不认。
 *
 * 题面除了 adobe 那一句都是合成的；Workday 上的结构见 apply-workday-eligibility-questions.test.ts。
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

import type { ApplyFormDescriptor } from '../src/contracts';
import { ageQuestion, asksAge, mixesAgeWithJobQuestion } from '../src/dict/ageQuestion';
import { buildApplyPlan, type BuildPlanOptions } from '../src/engine';
import type { ApplyProfileCollections } from '../src/profileCollections';
import { compileBundledAdapter } from '../src/rules/interpreter';

afterEach(() => { document.body.innerHTML = ''; });

const ADOBE = 'Are you of legal age to work in the country in which this position will be based?';

describe('判读：问的是法定工作年龄', () => {
  it.each([
    `${ADOBE}*`,
    ADOBE,
    'Are you of legal working age in the country where this position is located?',
    'Are you of the legal age to work in the United States?',
    'Are you of legal age to work in the US?',
    'Are you of legal age for employment?',
    'Are you of legal working age?',
    'I am of legal working age in the country where this job is based',
    'Please confirm that you are of legal working age',
  ])('「%s」→ WORKING_AGE，按年龄答', (label) => {
    expect(ageQuestion(label)).toBe('WORKING_AGE');
    expect(asksAge(label)).toBe(true);
  });

  it.each([
    // 地点以外的限定说的是另一个年龄（酒吧、赌场常要 21 岁）。
    'Are you of legal age to work in a bar?',
    'Are you of legal age to work full time in the US?',
    'Are you not of legal working age?',
    "Aren't you of legal working age?",
    'If you are not of legal working age, please upload your work permit',
    'Are you of legal working age and authorized to work in the United States?',
  ])('「%s」→ null（说不清就不答）', (label) => {
    expect(ageQuestion(label)).toBeNull();
  });

  it('「legal drinking age」不是这一类，也不是年龄题', () => {
    expect(ageQuestion('Are you of legal drinking age?')).toBeNull();
    expect(asksAge('Are you of legal drinking age?')).toBe(false);
  });

  it('同一句写明了 18 岁的，照旧按 18 岁判', () => {
    expect(ageQuestion('Are you of legal working age (18 or older)?')).toBe('AT_LEAST_18');
  });

  it('只问年龄的不算「年龄与工作授权问在一句里」；真掺了工作授权的照旧算', () => {
    expect(mixesAgeWithJobQuestion(`${ADOBE}*`)).toBe(false);
    expect(mixesAgeWithJobQuestion('Are you of legal working age and authorized to work in the United States?')).toBe(true);
  });
});

const RULESETS = {
  ashby, dover, generic, greenhouse, icims, jobvite, lever, rippling, smartrecruiters, workable, workday,
} as const;

function over18Patterns(rules: unknown): { source: string; flags: string }[] {
  const out: { source: string; flags: string }[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (record['type'] === 'labelPatterns') {
      for (const entry of record['patterns'] as { key: string; regex: { source: string; flags: string } }[]) {
        if (entry.key === 'over18') out.push(entry.regex);
      }
    }
    for (const child of Object.values(record)) walk(child);
  };
  walk(rules);
  return out;
}

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

describe('规则：十一家共用同一条 over18 正则', () => {
  it('每一家恰好一条、逐字相同（Workday 从这一版起也带它）', () => {
    const [first] = over18Patterns(generic);
    for (const [vendor, rules] of Object.entries(RULESETS)) {
      expect(over18Patterns(rules), vendor).toEqual([first]);
    }
  });

  it.each(Object.keys(RULESETS))('%s：法定工作年龄的说法认成 over18，别的「legal」不认', (vendor) => {
    const rules = RULESETS[vendor as keyof typeof RULESETS];
    for (const label of [
      `${ADOBE}*`,
      'Are you of legal working age in the country where this position is located?',
      'Are you of the legal age to work in the United States?',
      'Are you of legal age for employment?',
    ]) {
      expect(keyFor(rules, label), label).toBe('over18');
    }
    for (const label of [
      'Are you of legal drinking age?',
      'Are you of legal age to sell alcohol?',
      'Legal first name',
      'Are you legally authorized to work in the United States?',
    ]) {
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
const radios = (label: string): string => {
  groups += 1;
  return `<fieldset><legend>${label}</legend>
    <label><input name="g${groups}" type="radio" value="1" /> Yes</label>
    <label><input name="g${groups}" type="radio" value="0" /> No</label>
  </fieldset>`;
};
const select = (label: string): string => {
  groups += 1;
  return `<label for="s${groups}">${label}</label>
    <select id="s${groups}"><option value="">Select...</option><option>Yes</option><option>No</option></select>`;
};

const plan = (controls: string, profile: Record<string, string>, options: BuildPlanOptions = {}) =>
  buildApplyPlan(greenhouseForm(controls), { firstName: 'Taylor', ...profile } as never, options);
const entryFor = (result: ReturnType<typeof plan>, label: string) => result.entries.find((entry) => entry.label === label);
const skipFor = (result: ReturnType<typeof plan>, label: string) => result.skipped.find((item) => item.label === label);

describe('按年龄答（单选与原生下拉）', () => {
  it('档案明确年满 18 → 肯定的那一项，不带推断依据', () => {
    const entry = entryFor(plan(radios(ADOBE), { over18: 'true' }), ADOBE);
    expect(entry).toMatchObject({ kind: 'choice', key: 'over18', value: 'Yes' });
    expect(entry?.historyBasis).toBeUndefined();
    expect(entryFor(plan(select(ADOBE), { over18: 'true' }), ADOBE)).toMatchObject({ kind: 'select', key: 'over18', resolvedOptionText: 'Yes' });
  });

  it('档案里没有明确值、有一段教育 → 推出来的年满 18，答「Yes」并带依据', () => {
    expect(entryFor(plan(radios(ADOBE), {}, { collections: WITH_EDUCATION }), ADOBE)).toMatchObject({
      kind: 'choice', key: 'over18', value: 'Yes', historyBasis: 'ADULT_FROM_HISTORY',
    });
  });

  it('档案明确未满 18 → 不答（很多地方未满 18 也能工作），交还用户：随岗位所在地而定', () => {
    for (const control of [radios, select]) {
      const result = plan(control(ADOBE), { over18: 'false' }, { collections: WITH_EDUCATION });
      expect(entryFor(result, ADOBE)).toBeUndefined();
      expect(skipFor(result, ADOBE)).toMatchObject({ reason: 'JOB_DEPENDENT', key: 'over18' });
    }
  });

  it('既没有明确值、也推不出来 → 照旧不答（单选 CHOICE_NO_DATA、下拉 NO_VALUE）', () => {
    expect(skipFor(plan(radios(ADOBE), {}), ADOBE)).toMatchObject({ reason: 'CHOICE_NO_DATA', key: 'over18' });
    expect(skipFor(plan(select(ADOBE), {}), ADOBE)).toMatchObject({ reason: 'NO_VALUE', key: 'over18' });
  });

  it('带别的限定（「in a bar」）→ 说不清，不答（LOW_CONFIDENCE）', () => {
    const label = 'Are you of legal age to work in a bar?';
    const result = plan(radios(label), { over18: 'true' });
    expect(entryFor(result, label)).toBeUndefined();
    expect(skipFor(result, label)).toMatchObject({ reason: 'LOW_CONFIDENCE' });
  });

  it('同一句还问了工作授权 → 不只凭年龄那一半作答（JOB_DEPENDENT）', () => {
    const label = 'Are you of legal working age and authorized to work in the United States?';
    const result = plan(radios(label), { over18: 'true' });
    expect(entryFor(result, label)).toBeUndefined();
    expect(skipFor(result, label)).toMatchObject({ reason: 'JOB_DEPENDENT' });
  });

  it('没认出键的也一样：年龄与工作授权问在一句里，不再只凭授权记录那一半作答', () => {
    const label = 'Are you of legal working age and authorized to work in the United States?';
    const form = greenhouseForm(radios(label));
    const unkeyed: ApplyFormDescriptor = {
      ...form,
      fields: form.fields.map((field) => (field.label === label ? { ...field, key: null, confidence: 0 } : field)),
    };
    const result = buildApplyPlan(unkeyed, { firstName: 'Taylor', over18: 'true' } as never, {
      capabilities: { 'set-work-authorization': true },
      workAuthorizations: [{ regionCode: 'US', authorizedToWork: 'YES', requiresSponsorship: 'NO' }],
    });
    expect(result.entries.find((entry) => entry.label === label)).toBeUndefined();
    expect(result.skipped.find((item) => item.label === label)).toMatchObject({ reason: 'JOB_DEPENDENT' });
  });

  it('是年龄题不是工作授权题：那一国的授权记录是「否」也不影响，照年龄答「Yes」', () => {
    const result = plan(radios(ADOBE), { over18: 'true' }, {
      capabilities: { 'set-work-authorization': true },
      workAuthorizations: [{ regionCode: 'US', authorizedToWork: 'NO', requiresSponsorship: 'YES' }],
      jobRegionCode: 'US',
    });
    expect(entryFor(result, ADOBE)).toMatchObject({ key: 'over18', value: 'Yes' });
  });
});
