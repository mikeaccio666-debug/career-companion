// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { fillFromGesture } from '../lib/gestureFill';
import type { KernelFillAudit } from '../lib/kernelFiller';
import { createBundledApplyPolicy, type ApplyPolicy } from '@edaix/apply-kernel/policy';
import { captureTrustedShadowGesture } from '@edaix/apply-kernel/grant';
import { installApplyAdapters, readApplyForm } from '@edaix/apply-kernel/registry';
import { workdayAdapter } from '@edaix/apply-kernel/sites/workday';

installApplyAdapters({ workday: workdayAdapter });

/**
 * Workday「My Experience」在手势路上：档案 3 段经历、1 段教育，页面预渲染经历、教育各 1 行
 * （2026-09-24 adobe.wd5 实测的形状）。点「自动填写」一次：先填页面上已有的那一行，再按规则声明的
 * 「Add Another」逐段加行、重扫、只填新加的那一行。
 *
 * 夹具只留这条路用得到的结构（与 packages/apply-kernel/tests/fixtures/workday/myExperience.ts 同一形状，
 * 那边是整页）：区、行、行内的文本框、在职勾选框、MM/YYYY 分段日期、区末的 add-button。
 */

class TrustedClick extends MouseEvent { get isTrusted() { return true; } }

const text = (fkit: string, field: string, label: string): string => `
  <div data-automation-id="formField-${field}" data-fkit-id="${fkit}--${field}">
    <label for="${fkit}--${field}">${label}</label>
    <div><div><input id="${fkit}--${field}" name="${field}" type="text" /></div><div></div></div>
  </div>`;

const segment = (id: string, part: 'Month' | 'Year'): string => `
  <div id="${id}-dateSection${part}">
    <div data-automation-id="dateSection${part}-display" aria-hidden="true">${part === 'Month' ? 'MM' : 'YYYY'}</div>
    <input data-automation-id="dateSection${part}-input" id="${id}-dateSection${part}-input" role="spinbutton" aria-valuemin="1" aria-valuemax="${part === 'Month' ? '12' : '9999'}" aria-label="${part}" />
  </div>`;

const date = (fkit: string, field: string, legend: string, parts: readonly ('Month' | 'Year')[]): string => `
  <div data-automation-id="formField-${field}" data-fkit-id="${fkit}--${field}">
    <fieldset><legend>${legend}</legend>
      <div data-automation-id="dateInputWrapper" id="${fkit}--${field}" role="group">
        <div>${parts.map((part) => segment(`${fkit}--${field}`, part)).join('<div>/</div>')}</div>
      </div>
    </fieldset>
  </div>`;

function experienceRow(seq: number, ordinal: number): string {
  const fkit = `workExperience-${seq}`;
  return `
  <div role="group" aria-labelledby="Work-Experience-${ordinal}-panel">
    <div><h5 id="Work-Experience-${ordinal}-panel">Work Experience ${ordinal}</h5></div>
    <div data-fkit-id="${fkit}--null">
      ${text(fkit, 'jobTitle', 'Job Title*')}
      ${text(fkit, 'companyName', 'Company*')}
      ${text(fkit, 'location', 'Location')}
      <div data-automation-id="formField-currentlyWorkHere" data-fkit-id="${fkit}--currentlyWorkHere">
        <label for="${fkit}--currentlyWorkHere">I currently work here</label>
        <div><div><input id="${fkit}--currentlyWorkHere" name="currentlyWorkHere" type="checkbox" /></div></div>
      </div>
      <div>${date(fkit, 'startDate', 'From*', ['Month', 'Year'])}${date(fkit, 'endDate', 'To*', ['Month', 'Year'])}</div>
    </div>
  </div>`;
}

function educationRow(seq: number, ordinal: number): string {
  const fkit = `education-${seq}`;
  return `
  <div role="group" aria-labelledby="Education-${ordinal}-panel">
    <div><h5 id="Education-${ordinal}-panel">Education ${ordinal}</h5></div>
    <div data-fkit-id="${fkit}--null">
      ${text(fkit, 'schoolName', 'School or University*')}
      ${text(fkit, 'gradeAverage', 'Overall Result (GPA)')}
      <div>${date(fkit, 'firstYearAttended', 'From', ['Year'])}${date(fkit, 'lastYearAttended', 'To (Actual or Expected)', ['Year'])}</div>
    </div>
  </div>`;
}

const addButton = () => '<div><div><div><button data-automation-id="add-button">Add Another</button></div></div></div>';

function page() {
  document.body.innerHTML = `
    <div data-automation-id="applyFlowMyExpPage">
      <div role="group" aria-labelledby="Work-Experience-section">
        <h4 id="Work-Experience-section">Work Experience</h4>
        ${experienceRow(29, 1)}
        ${addButton()}
      </div>
      <div role="group" aria-labelledby="Education-section">
        <h4 id="Education-section">Education</h4>
        ${educationRow(30, 1)}
        ${addButton()}
      </div>
      <div role="group" aria-labelledby="Certifications-section">
        <h4 id="Certifications-section">Certifications</h4>
        ${addButton()}
      </div>
    </div>`;
  const host = document.createElement('div');
  document.body.append(host);
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const button = document.createElement('button');
  shadowRoot.append(button);
  const descriptor = readApplyForm('workday', document);
  expect(descriptor, '前置条件：规则要认出这一页').not.toBeNull();
  return { shadowRoot, button, descriptor: descriptor! };
}

/** 宿主的行为（2026-09-24 实测）：点区里的「Add Another」，在按钮那一格之前多出一行，序号是新生成的。 */
function hostAddsRows(): { clicks: () => number } {
  let clicks = 0;
  let seq = 40;
  const section = document.querySelector('[aria-labelledby="Work-Experience-section"]')!;
  const add = section.querySelector('button[data-automation-id="add-button"]')!;
  add.addEventListener('click', () => {
    clicks += 1;
    const ordinal = section.querySelectorAll('[data-fkit-id^="workExperience-"][data-fkit-id$="--null"]').length + 1;
    let slot: Element = add;
    while (slot.parentElement !== section) slot = slot.parentElement!;
    slot.insertAdjacentHTML('beforebegin', experienceRow(seq, ordinal));
    seq += 2;
  });
  return { clicks: () => clicks };
}

/** 教育区同一个样子：点它自己的「Add Another」多出一行教育。 */
function hostAddsEducationRows(): { clicks: () => number } {
  let clicks = 0;
  let seq = 90;
  const section = document.querySelector('[aria-labelledby="Education-section"]')!;
  const add = section.querySelector('button[data-automation-id="add-button"]')!;
  add.addEventListener('click', () => {
    clicks += 1;
    const ordinal = section.querySelectorAll('[data-fkit-id^="education-"][data-fkit-id$="--null"]').length + 1;
    let slot: Element = add;
    while (slot.parentElement !== section) slot = slot.parentElement!;
    slot.insertAdjacentHTML('beforebegin', educationRow(seq, ordinal));
    seq += 2;
  });
  return { clicks: () => clicks };
}

function livePolicy(over: Partial<ApplyPolicy> = {}): ApplyPolicy {
  const bundled = createBundledApplyPolicy();
  return {
    ...bundled,
    notAfter: Date.now() + 60_000,
    vendors: { ...bundled.vendors, workday: true },
    capabilities: { ...bundled.capabilities, 'manage-rows': true },
    ...over,
  };
}

function input(over: Record<string, unknown> = {}) {
  const { shadowRoot, button, descriptor } = page();
  let proof: ReturnType<typeof captureTrustedShadowGesture> = null;
  button.addEventListener('click', (e) => { proof = captureTrustedShadowGesture(e, shadowRoot); });
  button.dispatchEvent(new TrustedClick('click'));
  return {
    shadowRoot,
    proof: proof as never,
    scan: { descriptor } as never,
    profile: {} as never,
    policy: livePolicy(),
    progress: { onOutcome: vi.fn(), shouldStop: () => false } as never,
    ...over,
  };
}

const rescan = async () => {
  const descriptor = readApplyForm('workday', document);
  return descriptor === null ? null : ({ descriptor } as never);
};

const COLLECTIONS = {
  experiences: [
    { company: 'Example Robotics', title: 'Machine Learning Engineer', employmentType: null, location: 'San Jose, CA', startDate: { year: 2023, month: 3 }, endDate: null, isCurrent: true },
    { company: 'Sample Labs', title: 'Data Scientist', employmentType: null, location: null, startDate: { year: 2021, month: 6 }, endDate: { year: 2023, month: 2 }, isCurrent: false },
    { company: 'Demo Corp', title: 'Research Intern', employmentType: null, location: null, startDate: { year: 2020, month: 5 }, endDate: { year: 2020, month: 8 }, isCurrent: false },
  ],
  educations: [
    { school: 'Example University', degreeLevel: null, fieldOfStudy: null, startDate: { year: 2019, month: 9 }, endDate: { year: 2021, month: 5 }, location: null, gpa: '3.9', gpaScale: null, isCurrent: false },
  ],
};

const rowValues = (field: string) =>
  [...document.querySelectorAll<HTMLInputElement>(`[data-fkit-id^="workExperience-"][data-fkit-id$="--null"] [data-automation-id="formField-${field}"] input`)]
    .map((element) => element.value);
const dateValues = (field: string) =>
  [...document.querySelectorAll(`[data-fkit-id^="workExperience-"][data-fkit-id$="--null"] [data-automation-id="formField-${field}"] [role="group"]`)]
    .map((group) => [...group.querySelectorAll<HTMLInputElement>('input[role="spinbutton"]')].map((segment) => segment.value).join('/'));

describe('Workday My Experience：一次点击，档案几段就填几行', () => {
  it('3 段经历：已有的第 1 行先填，再加 2 行、各填各的；教育那 1 行照常', async () => {
    const base = input();
    const host = hostAddsRows();
    const audits: KernelFillAudit[] = [];
    const result = await fillFromGesture({
      ...base,
      collections: COLLECTIONS,
      rowAdds: { rescan, settleMs: 0 },
      onAudit: (audit: KernelFillAudit) => { audits.push(audit); },
    } as never);
    expect(result.ok).toBe(true);
    expect(host.clicks()).toBe(2);
    expect(audits[0]!.rowAdds).toEqual({ added: 2, saved: 0, stop: null, unreachable: [] });

    expect(rowValues('jobTitle')).toEqual(['Machine Learning Engineer', 'Data Scientist', 'Research Intern']);
    expect(rowValues('companyName')).toEqual(['Example Robotics', 'Sample Labs', 'Demo Corp']);
    expect(dateValues('startDate')).toEqual(['3/2023', '6/2021', '5/2020']);
    // 在职的那一段：勾上 I currently work here，To 不写。
    expect(dateValues('endDate')).toEqual(['/', '2/2023', '8/2020']);
    expect(rowValues('currentlyWorkHere').length).toBe(3);
    expect([...document.querySelectorAll<HTMLInputElement>('input[name="currentlyWorkHere"]')].map((box) => box.checked))
      .toEqual([true, false, false]);

    const school = document.querySelector<HTMLInputElement>('[data-automation-id="formField-schoolName"] input')!;
    expect(school.value).toBe('Example University');
    const years = [...document.querySelectorAll<HTMLInputElement>('[data-fkit-id^="education-"] input[role="spinbutton"]')].map((segment) => segment.value);
    expect(years).toEqual(['2019', '2021']);
  });

  /**
   * 2026-09-28 测试台（adobe.wd5 第 2 页，6 段经历、6 段教育）：行序在每个区里各数各的，经历第 N 行与教育第 N 行
   * 行序相同。从前「加完一行、只填新加的那一行」按行序切计划，把另一个区同一行序的格也切了进来——那几格又走一遍、
   * 在单子上再记一遍：教育后 3 段缺学位，浮层列出 6 个「Degree 资料里没有」。
   */
  it('两个区都要加行：加经历第 N 行时不碰教育第 N 行，单子上每一格只记一次', async () => {
    const base = input();
    const experiences = hostAddsRows();
    const educations = hostAddsEducationRows();
    const audits: KernelFillAudit[] = [];
    const result = await fillFromGesture({
      ...base,
      collections: {
        experiences: COLLECTIONS.experiences.slice(0, 2),
        educations: [
          COLLECTIONS.educations[0]!,
          { school: 'Sample College', degreeLevel: null, fieldOfStudy: null, startDate: { year: 2015, month: 9 }, endDate: { year: 2019, month: 5 }, location: null, gpa: null, gpaScale: null, isCurrent: false },
        ],
      },
      rowAdds: { rescan, settleMs: 0 },
      onAudit: (audit: KernelFillAudit) => { audits.push(audit); },
    } as never);
    expect(result.ok).toBe(true);
    expect([experiences.clicks(), educations.clicks()]).toEqual([1, 1]);
    const rows = audits[0]!.view.rows;
    const seen = new Map<Element, number>();
    for (const row of rows) seen.set(row.element, (seen.get(row.element) ?? 0) + 1);
    const repeated = rows.filter((row) => (seen.get(row.element) ?? 0) > 1).map((row) => row.label);
    expect(repeated, '同一格在单子上记了不止一次').toEqual([]);
    // 第 2 段教育没有 GPA：只记一次「资料里没有」。
    expect(rows.filter((row) => row.label === 'Overall Result (GPA)' && row.status === 'MISSING_PROFILE')).toHaveLength(1);
  });

  it('策略没放行 manage-rows：一下都不点，只填页面上已有的那一行', async () => {
    const bundled = createBundledApplyPolicy();
    const base = input({ policy: livePolicy({ capabilities: { ...bundled.capabilities, 'manage-rows': false } }) });
    const host = hostAddsRows();
    await fillFromGesture({ ...base, collections: COLLECTIONS, rowAdds: { rescan, settleMs: 0 } } as never);
    expect(host.clicks()).toBe(0);
    expect(rowValues('jobTitle')).toEqual(['Machine Learning Engineer']);
  });
});
