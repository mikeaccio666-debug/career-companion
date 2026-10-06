/**
 * 「你在这家公司工作过吗」「你是这家公司的在职或前员工吗」按工作经历答（2026-09-24，负责人：「跟 Jobright 一样」）。
 *
 * 公司是本次申请的公司（申请卡片交来的 `jobCompany`）。经历里有一段的雇主按比对口径就是这一家 → 是；
 * 没有 → 否。问「你现在是否受雇于 X」的，只有一段**在职**（没有结束日期）的经历对得上才答是。
 * 岗位公司不知道、经历集合没交来、雇主名只是部分对得上（「Acme Labs」对「Acme」），都不答。
 *
 * 不归这里管的（照旧）：「申请过／面试过」、亲友在这里工作、「与 X 合作过」、合作伙伴、只问承包商身份的、
 * 点名了别家公司的、限定了时间段的、否定句。
 */

import { afterEach, describe, expect, it } from 'vitest';
import greenhouseRules from '@edaix/apply-rules/greenhouse.json';

import { buildAuditView } from '../src/audit';
import type { ApplyFormDescriptor, ScanRootOptions } from '../src/contracts';
import { hiringCompanyEmploymentTense, notEmployedOption } from '../src/dict/historyAnswers';
import { buildApplyPlan, type BuildPlanOptions } from '../src/engine';
import type { ApplyProfileCollections, ProfileExperience } from '../src/profileCollections';
import { compileBundledAdapter } from '../src/rules/interpreter';
import { ashbyAdapter } from '../src/sites/ashby/applyForm';

afterEach(() => { document.body.innerHTML = ''; });

const experience = (company: string, current = false): ProfileExperience => ({
  company,
  title: 'Engineer',
  employmentType: 'FULL_TIME',
  startDate: { year: 2019, month: 1 },
  endDate: current ? null : { year: 2021, month: 6 },
  location: null,
  isCurrent: current,
});

const history = (...experiences: ProfileExperience[]): ApplyProfileCollections => ({ experiences });

describe('判读：认得出的问法', () => {
  it.each([
    'Have you ever worked for Acme?',
    'Have you previously been employed by Acme (or any of its subsidiaries)?',
    'Have you previously been employed by Acme or any of its subsidiaries?',
    'Are you a current or former employee of Acme?',
    'Have you worked at Acme before?',
    'Former Acme employee?',
    'Are you a former Acme, Inc. employee?',
    'Have you previously worked for ACME as an employee or contractor?*',
    'Have you been employed by Acme Corporation in the past?',
    'Have you ever worked for this company?',
    'Have you ever been employed by us?',
    'Have you worked here before?',
    'Have you ever worked for our company in any capacity?',
    'Have you ever been employed by Acme in any role?',
    'Have you been employed by Acme, including internships?',
    'Are you a current or former employee?',
    // 2026-09-24 adobe.wd5 第 3 步：身份那一组复选框的题干（结构见 apply-workday-eligibility-questions.test.ts）。
    'Have you ever worked at Acme in the following capacity:*',
    'Have you ever worked for Acme in any of the following capacities?',
  ])('「%s」→ EVER', (text) => {
    expect(hiringCompanyEmploymentTense(text, 'Acme')).toBe('EVER');
  });

  it.each([
    'Are you currently employed by Acme?',
    'Are you a current employee of Acme?',
    'Do you currently work for Acme?',
    'Are you a current Acme employee?',
    'Current employee?',
  ])('「%s」→ CURRENT', (text) => {
    expect(hiringCompanyEmploymentTense(text, 'Acme')).toBe('CURRENT');
  });
});

describe('判读：不归这里管的一律不认', () => {
  it.each([
    'Have you ever applied to Acme before?',
    'Have you previously applied for a position at Acme?',
    'Have you interviewed with Acme in the past?',
    'Have you ever worked with Acme?',
    'Do you have any relatives who work for Acme?',
    'Do you have friends or family currently employed by Acme?',
    'Were you referred by a current Acme employee?',
    'Have you ever worked for an Acme partner?',
    'Have you ever worked for Acme as a contractor?',
    'Have you ever been a contractor for Acme?',
    'Have you ever worked for Initech?',
    'Have you ever worked for a competitor of Acme?',
    'Have you worked for Acme or Initech?',
    'Have you worked for Acme Labs?',
    'Have you worked for Acme in the last 12 months?',
    'Have you ever been employed?',
    'Are you currently employed?',
    'Have you never worked for Acme?',
    'Have you worked in a similar role before?',
    'Why do you want to work for Acme?',
    // 「the following」只在后面跟着身份（capacity）时算废话：后面列的是别的公司时，经历里没有 Acme 推不出「否」。
    'Have you ever worked for Acme or any of the following companies?',
  ])('「%s」→ null', (text) => {
    expect(hiringCompanyEmploymentTense(text, 'Acme')).toBeNull();
  });

  it('岗位公司不知道（空、或只剩公司后缀）→ 点名了公司的问法一律不认', () => {
    expect(hiringCompanyEmploymentTense('Have you ever worked for Acme?', '')).toBeNull();
    expect(hiringCompanyEmploymentTense('Have you ever worked for Acme?', 'Inc.')).toBeNull();
  });
});

function greenhouse(controls: string): ApplyFormDescriptor {
  document.body.innerHTML = `<form id="application-form">
    <label for="first_name">First Name</label><input id="first_name" type="text" />
    ${controls}
  </form>`;
  const adapter = compileBundledAdapter(greenhouseRules);
  const root = adapter.resolveRoot(document)!;
  return { vendor: 'greenhouse', root, fields: [...adapter.scan(root)] };
}

let groups = 0;
const radios = (label: string, options: readonly string[] = ['Yes', 'No']): string => {
  groups += 1;
  return `<fieldset><legend>${label}</legend>
    ${options.map((text, index) => `<label><input name="q${groups}" type="radio" value="${index}" /> ${text}</label>`).join('')}
  </fieldset>`;
};
const select = (label: string, options: readonly string[] = ['Yes', 'No']): string => {
  groups += 1;
  return `<label for="s${groups}">${label}</label>
    <select id="s${groups}"><option value="">Select...</option>${options.map((text) => `<option>${text}</option>`).join('')}</select>`;
};

const plan = (controls: string, options: BuildPlanOptions) =>
  buildApplyPlan(greenhouse(controls), { firstName: 'Taylor' } as never, options);
const entryFor = (result: ReturnType<typeof plan>, label: string) => result.entries.find((entry) => entry.label === label);
const skipFor = (result: ReturnType<typeof plan>, label: string) => result.skipped.find((item) => item.label === label);

const EVER = 'Have you ever worked for Acme?';
const CURRENT = 'Are you currently employed by Acme?';

describe('按经历答', () => {
  it('经历里有这家（「Acme, Inc.」对「Acme」）→ Yes，键 previouslyEmployedHere，依据「有这家公司」', () => {
    const result = plan(radios(EVER), { jobCompany: 'Acme', collections: history(experience('Initech'), experience('Acme, Inc.')) });
    expect(entryFor(result, EVER)).toMatchObject({
      kind: 'choice', key: 'previouslyEmployedHere', value: 'Yes', confidence: 1, historyBasis: 'EMPLOYER_IN_HISTORY',
    });
  });

  it('岗位公司写的是「ACME Corp.」、经历写的是「Acme」→ 同一家', () => {
    const result = plan(select(EVER), { jobCompany: 'ACME Corp.', collections: history(experience('Acme')) });
    expect(entryFor(result, EVER)).toMatchObject({ kind: 'select', resolvedOptionText: 'Yes' });
  });

  it('经历里没有这家 → No，依据「没有这家公司」', () => {
    const result = plan(select(EVER), { jobCompany: 'Acme', collections: history(experience('Initech')) });
    expect(entryFor(result, EVER)).toMatchObject({
      kind: 'select', key: 'previouslyEmployedHere', resolvedOptionText: 'No', historyBasis: 'EMPLOYER_NOT_IN_HISTORY',
    });
  });

  it('只有教育、没有工作经历 → No', () => {
    const result = plan(radios(EVER), {
      jobCompany: 'Acme',
      collections: { educations: [{ school: 'Example University', degreeLevel: 'BACHELOR', fieldOfStudy: null, startDate: null, endDate: null, location: null, gpa: null, gpaScale: null, isCurrent: false }] },
    });
    expect(entryFor(result, EVER)).toMatchObject({ value: 'No', historyBasis: 'EMPLOYER_NOT_IN_HISTORY' });
  });

  it('问「现在是否受雇于 X」：那段经历已经结束 → No，依据写明「已结束」', () => {
    const result = plan(radios(CURRENT), { jobCompany: 'Acme', collections: history(experience('Acme')) });
    expect(entryFor(result, CURRENT)).toMatchObject({ value: 'No', historyBasis: 'EMPLOYER_ENDED' });
  });

  it('问「现在是否受雇于 X」：那段经历在职（没有结束日期）→ Yes', () => {
    const result = plan(radios(CURRENT), { jobCompany: 'Acme', collections: history(experience('Acme', true)) });
    expect(entryFor(result, CURRENT)).toMatchObject({ value: 'Yes', historyBasis: 'EMPLOYER_IN_HISTORY' });
  });

  it('问「现在是否受雇于 X」：那段经历既没标在职、也没有结束日期 → 说不清，不答', () => {
    const unclear = { ...experience('Acme'), endDate: null };
    const result = plan(radios(CURRENT), { jobCompany: 'Acme', collections: history(unclear) });
    expect(entryFor(result, CURRENT)).toBeUndefined();
  });

  it('同一节里两道（在这里工作过吗、现在在这里吗）是两道题，各答各的，不按重复字段仲裁掉', () => {
    // 两个原生下拉、没有 fieldset 也没有标题：同一节、同一个键——从前会被当成重复字段丢掉一个。
    const result = plan(select(EVER) + select(CURRENT), { jobCompany: 'Acme', collections: history(experience('Acme')) });
    expect(entryFor(result, EVER)).toMatchObject({ resolvedOptionText: 'Yes' });
    expect(entryFor(result, CURRENT)).toMatchObject({ resolvedOptionText: 'No' });
    expect(result.skipped.some((item) => item.reason === 'DUPLICATE_FIELD')).toBe(false);
  });

  it('审计行把依据带给浮层', () => {
    const result = plan(radios(EVER), { jobCompany: 'Acme', collections: history(experience('Initech')) });
    const row = buildAuditView(result, []).rows.find((item) => item.label === EVER);
    expect(row).toMatchObject({ key: 'previouslyEmployedHere', historyBasis: 'EMPLOYER_NOT_IN_HISTORY' });
  });

  it('页面上已经选了 → fill-first 不覆盖（NOT_EMPTY）', () => {
    const descriptor = greenhouse(radios(EVER));
    (document.querySelector('input[type="radio"][value="1"]') as HTMLInputElement).checked = true;
    const result = buildApplyPlan(descriptor, {} as never, { jobCompany: 'Acme', collections: history(experience('Acme')) });
    expect(entryFor(result, EVER)).toBeUndefined();
    expect(skipFor(result, EVER)).toMatchObject({ reason: 'NOT_EMPTY', key: 'previouslyEmployedHere' });
  });
});

describe('「没在这家工作过」那一项（答「否」而页面上没有 No 时的选项阶梯）', () => {
  it.each([
    [['Employee', 'Intern', 'Temporary Agency or Vendor', 'Other', 'I have not worked for Acme in the past.'], 'I have not worked for Acme in the past.'],
    [['Employee', 'Contractor', 'I have never worked for Acme'], 'I have never worked for Acme'],
    [['Employee', 'Contractor', 'I have not previously been employed by Acme, Inc.'], 'I have not previously been employed by Acme, Inc.'],
    [['Employee', 'Intern', 'No, I haven’t worked here before'], 'No, I haven’t worked here before'],
    [['As an employee', 'As a contractor', 'Never worked for this company'], 'Never worked for this company'],
    [['Employee', 'Intern', 'None of the above'], 'None of the above'],
    // 明说没在这里工作过的那一项排在「None of the above」前面。
    [['Employee', 'None of the above', 'I have not worked for Acme'], 'I have not worked for Acme'],
  ])('%j → 「%s」', (options, expected) => {
    expect(notEmployedOption(options, 'Acme')).toBe(expected);
  });

  it.each([
    [['Employee', 'Intern', 'Other']],
    [['Employee', 'I have worked for Acme before']],
    // 点名了别家、只是部分对得上、「worked with」（合作过）、公司名后面还跟了别的话：都不算。
    [['Employee', 'I have not worked for Initech']],
    [['Employee', 'I have not worked for Acme Labs']],
    [['Employee', 'I have not worked with Acme']],
    [['Employee', 'I have not worked for Acme but I have applied before']],
    // 同一级两项：分不清勾哪一项。
    [['I have not worked for Acme', 'I have never worked for Acme']],
    [['None of the above', 'None']],
    [['None of the above apply']],
  ])('%j → null', (options) => {
    expect(notEmployedOption(options, 'Acme')).toBeNull();
  });
});

const checkboxes = (label: string, options: readonly string[]): string => {
  groups += 1;
  return `<fieldset><legend>${label}</legend>
    ${options.map((text, index) => `<label><input name="c${groups}" type="checkbox" value="${index}" /> ${text}</label>`).join('')}
  </fieldset>`;
};

const CAPACITY = 'Have you ever worked at Acme in the following capacity:*';
const CAPACITIES = ['Employee', 'Intern', 'Temporary Agency or Vendor', 'Other', 'I have not worked for Acme in the past.'] as const;

describe('身份那一组复选框（2026-09-24 adobe.wd5 那一题的形状）', () => {
  it('经历里没有这家 → 只勾「I have not worked for Acme in the past.」那一项，依据「没有这家公司」', () => {
    const result = plan(checkboxes(CAPACITY, CAPACITIES), { jobCompany: 'Acme', collections: history(experience('Initech')) });
    expect(entryFor(result, CAPACITY)).toMatchObject({
      kind: 'choice', key: 'previouslyEmployedHere', value: 'I have not worked for Acme in the past.', historyBasis: 'EMPLOYER_NOT_IN_HISTORY',
    });
  });

  it('经历里有这家 → 不猜是哪种身份，交还用户（CHOICE_NO_DATA）', () => {
    const result = plan(checkboxes(CAPACITY, CAPACITIES), { jobCompany: 'Acme', collections: history(experience('Acme')) });
    expect(entryFor(result, CAPACITY)).toBeUndefined();
    expect(skipFor(result, CAPACITY)).toMatchObject({ reason: 'CHOICE_NO_DATA' });
  });

  it('「No, I have not」那一项照旧由是／否的判读接住', () => {
    const result = plan(checkboxes(CAPACITY, ['Employee', 'Intern', 'No, I have not']), { jobCompany: 'Acme', collections: history(experience('Initech')) });
    expect(entryFor(result, CAPACITY)).toMatchObject({ key: 'previouslyEmployedHere', value: 'No, I have not' });
  });

  it('原生下拉上也一样：选「I have never worked for Acme」', () => {
    const label = 'Have you ever worked for Acme?';
    const result = plan(select(label, ['Yes, as an employee', 'Yes, as a contractor', 'I have never worked for Acme']), {
      jobCompany: 'Acme', collections: history(experience('Initech')),
    });
    expect(entryFor(result, label)).toMatchObject({ kind: 'select', key: 'previouslyEmployedHere', resolvedOptionText: 'I have never worked for Acme' });
  });

  it('问「现在」、那段经历已经结束 → 「否」成立，「没在这家工作过」不成立：不选', () => {
    const label = 'Are you currently employed by Acme in any of the following capacities?';
    const options = ['Employee', 'Intern', 'None of the above'];
    const ended = plan(checkboxes(label, options), { jobCompany: 'Acme', collections: history(experience('Acme')) });
    expect(entryFor(ended, label)).toBeUndefined();
    const never = plan(checkboxes(label, options), { jobCompany: 'Acme', collections: history(experience('Initech')) });
    expect(entryFor(never, label)).toMatchObject({ value: 'None of the above', historyBasis: 'EMPLOYER_NOT_IN_HISTORY' });
  });

  it('已经勾了一项 → fill-first 不覆盖（NOT_EMPTY）', () => {
    const descriptor = greenhouse(checkboxes(CAPACITY, CAPACITIES));
    (document.querySelector('input[type="checkbox"][value="1"]') as HTMLInputElement).checked = true;
    const result = buildApplyPlan(descriptor, {} as never, { jobCompany: 'Acme', collections: history(experience('Initech')) });
    expect(entryFor(result, CAPACITY)).toBeUndefined();
    expect(skipFor(result, CAPACITY)).toMatchObject({ reason: 'NOT_EMPTY', key: 'previouslyEmployedHere' });
  });
});

/**
 * 岗位公司带法人实体代码（2026-09-24 adobe.wd5 实测）：Workday 的 JobPosting 里 hiringOrganization 写的是「ADUS-Adobe Inc.」，
 * 题面说的是「Adobe」。比对口径没去掉「ADUS-」时，第 1 页「Have you been employed by Adobe in the past?」与第 3 页的身份复选框
 * 都认不出是这一家，落到 AI（AI 说「资料里没找到依据」），必填题空着翻不过去。
 */
describe('岗位公司带法人实体代码（「ADUS-Adobe Inc.」）', () => {
  const ADOBE = 'ADUS-Adobe Inc.';
  const PAST = 'Have you been employed by Adobe in the past?*';

  it('判读：两种问法都认得出是这一家', () => {
    expect(hiringCompanyEmploymentTense('Have you been employed by Adobe in the past?', ADOBE)).toBe('EVER');
    expect(hiringCompanyEmploymentTense('Have you ever worked at Adobe in the following capacity:', ADOBE)).toBe('EVER');
    expect(notEmployedOption(['Employee', 'Intern', 'Temporary Agency or Vendor', 'Other', 'I have not worked for Adobe in the past.'], ADOBE))
      .toBe('I have not worked for Adobe in the past.');
  });

  it('经历里没有 Adobe → No；有「Adobe」→ Yes', () => {
    expect(entryFor(plan(radios(PAST), { jobCompany: ADOBE, collections: history(experience('Initech')) }), PAST))
      .toMatchObject({ key: 'previouslyEmployedHere', value: 'No', historyBasis: 'EMPLOYER_NOT_IN_HISTORY' });
    expect(entryFor(plan(radios(PAST), { jobCompany: ADOBE, collections: history(experience('Adobe')) }), PAST))
      .toMatchObject({ key: 'previouslyEmployedHere', value: 'Yes', historyBasis: 'EMPLOYER_IN_HISTORY' });
  });

  it('第 3 页身份复选框：经历里没有 Adobe → 只勾「I have not worked for Adobe in the past.」', () => {
    const question = 'Have you ever worked at Adobe in the following capacity:*';
    const result = plan(checkboxes(question, ['Employee', 'Intern', 'Temporary Agency or Vendor', 'Other', 'I have not worked for Adobe in the past.']), {
      jobCompany: ADOBE, collections: history(experience('Initech')),
    });
    expect(entryFor(result, question)).toMatchObject({ key: 'previouslyEmployedHere', value: 'I have not worked for Adobe in the past.' });
  });

  it('只去掉「两位以上大写字母或数字＋连字符」打头的代码：T-Mobile、E-Trade 照旧是本名', () => {
    expect(hiringCompanyEmploymentTense('Have you ever worked for T-Mobile?', 'T-Mobile')).toBe('EVER');
    expect(hiringCompanyEmploymentTense('Have you ever worked for Mobile?', 'T-Mobile')).toBeNull();
    expect(hiringCompanyEmploymentTense('Have you ever worked for Trade?', 'E-Trade')).toBeNull();
    // 代码后面不是大写字母开头的公司名，不当代码。
    expect(hiringCompanyEmploymentTense('Have you ever worked for labs?', 'AB-labs')).toBeNull();
  });
});

describe('答不准就不答：照旧交还用户', () => {
  it('岗位公司不知道 → 单选 CHOICE_NO_DATA、下拉 USER_ONLY（与从前逐字相同）', () => {
    const collections = history(experience('Acme'));
    expect(skipFor(plan(radios(EVER), { collections }), EVER)).toMatchObject({ reason: 'CHOICE_NO_DATA' });
    expect(skipFor(plan(select(EVER), { collections }), EVER)).toMatchObject({ reason: 'USER_ONLY' });
    expect(skipFor(plan(select(EVER), { collections, jobCompany: '  ' }), EVER)).toMatchObject({ reason: 'USER_ONLY' });
  });

  it('经历集合没交来、或一段教育与经历都没有 → 不答', () => {
    expect(entryFor(plan(radios(EVER), { jobCompany: 'Acme' }), EVER)).toBeUndefined();
    expect(entryFor(plan(radios(EVER), { jobCompany: 'Acme', collections: {} }), EVER)).toBeUndefined();
  });

  it('雇主名只是部分对得上（「Acme Labs」对「Acme」）→ 说不清是不是同一家，不答「否」', () => {
    const result = plan(radios(EVER), { jobCompany: 'Acme', collections: history(experience('Acme Labs')) });
    expect(entryFor(result, EVER)).toBeUndefined();
  });

  it('点名了别家公司的问法 → 不答', () => {
    const other = 'Have you ever worked for Initech?';
    expect(entryFor(plan(radios(other), { jobCompany: 'Acme', collections: history(experience('Initech')) }), other)).toBeUndefined();
  });

  it.each([
    'Have you ever applied to Acme before?',
    'Have you ever worked with Acme?',
    'Have you ever worked for Acme as a contractor?',
  ])('「%s」→ 不答（下拉照旧 USER_ONLY）', (label) => {
    const result = plan(select(label), { jobCompany: 'Acme', collections: history(experience('Acme')) });
    expect(entryFor(result, label)).toBeUndefined();
    expect(skipFor(result, label)).toMatchObject({ reason: 'USER_ONLY' });
  });

  it('亲属在这里工作的题 → 仍是 OTHER_PERSON', () => {
    const relative = 'Do you have any relatives currently employed by this company?';
    const result = plan(radios(relative), { jobCompany: 'Acme', collections: history(experience('Acme')) });
    expect(entryFor(result, relative)).toBeUndefined();
    expect(skipFor(result, relative)).toMatchObject({ reason: 'OTHER_PERSON' });
  });

  it('自由文本框不答：只在选项控件上、恰好一项对得上才写', () => {
    const result = plan(`<label for="t">${EVER}</label><input id="t" type="text" />`, { jobCompany: 'Acme', collections: history(experience('Acme')) });
    expect(entryFor(result, EVER)).toBeUndefined();
    expect(skipFor(result, EVER)).toMatchObject({ reason: 'USER_ONLY' });
    expect(entryFor(plan(radios(EVER, ['Yes', 'Yes', 'No']), { jobCompany: 'Acme', collections: history(experience('Acme')) }), EVER)).toBeUndefined();
  });
});

describe('Ashby 的是非按钮（aria-pressed）', () => {
  const REQUIRED_CLASS = 'hashed-required';
  const SCAN_OPTIONS: ScanRootOptions = {
    readGeneratedContent: (element, pseudo) =>
      pseudo === '::after' && element.classList.contains(REQUIRED_CLASS) ? '"*"' : 'none',
  };
  const QUESTION = 'Have you previously worked at Acme?';

  function scanAshby(): ApplyFormDescriptor {
    document.body.innerHTML = `
      <div class="ashby-application-form-container">
        <div class="ashby-application-form-field-entry" data-field-path="question_2001">
          <label class="${REQUIRED_CLASS} ashby-application-form-question-title" for="question_2001">${QUESTION}</label>
          <div class="ashby-application-form-input-yesno">
            <button class="ashby-application-form-input-yesno-option" aria-pressed="false">Yes</button>
            <button class="ashby-application-form-input-yesno-option" aria-pressed="false">No</button>
            <input type="checkbox" tabindex="-1" name="question_2001">
          </div>
        </div>
      </div>`;
    const root = ashbyAdapter.resolveRoot(document, SCAN_OPTIONS)!;
    return { vendor: 'ashby', root, fields: [...ashbyAdapter.scan(root, SCAN_OPTIONS)] };
  }

  it('经历里有这家 → Yes；没有 → No', () => {
    const yes = buildApplyPlan(scanAshby(), {}, { jobCompany: 'Acme', collections: history(experience('Acme')) });
    expect(yes.entries.find((entry) => entry.label === QUESTION)).toMatchObject({ kind: 'choice', key: 'previouslyEmployedHere', value: 'Yes' });
    const no = buildApplyPlan(scanAshby(), {}, { jobCompany: 'Acme', collections: history(experience('Initech')) });
    expect(no.entries.find((entry) => entry.label === QUESTION)).toMatchObject({ kind: 'choice', key: 'previouslyEmployedHere', value: 'No' });
  });
});
