import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import type { ApplyFieldDescriptor } from '../src/contracts';
import { ashbyAdapter } from '../src/sites/ashby/applyForm';

/**
 * Ashby adapter, built against DOM read live from
 * `jobs.ashbyhq.com/<org>/<uuid>/application` on 2026-08-01.
 *
 * Ashby is the odd one of the four, and the fixture keeps all three surprises:
 *
 *  1. **No `<form>` element exists.** The anchor must be Ashby's semantic
 *     container class, which sits next to a build-hashed one
 *     (`_jobPostingForm_5yu8i_402`) that changes on every Ashby deploy.
 *  2. **Only `_systemfield_*` names are stable.** Everything else is a
 *     per-company UUID, and radio groups are `<questionUuid>_<optionUuid>`.
 *     So this vendor is the real test of label matching — `LinkedIn` is
 *     reachable only through its label.
 *  3. **`g-recaptcha-response` lives inside the same container**, so the shared
 *     captcha filter is load-bearing here rather than defensive.
 *
 * All values are synthetic.
 */

afterEach(() => {
  document.body.innerHTML = '';
});

function mountAshbyFixture(): void {
  document.body.innerHTML = `
    <div id="root">
      <div class="ashby-job-posting-right-pane">
        <div id="form" role="tabpanel">
          <div class="_jobPostingForm_5yu8i_402 ashby-application-form-container">
            <div class="_section_5yu8i_86 ashby-application-form-section-container">
              <label for="_systemfield_name">Name</label>
              <input id="_systemfield_name" name="_systemfield_name" type="text" required />

              <label for="_systemfield_email">Email</label>
              <input id="_systemfield_email" name="_systemfield_email" type="email" required />

              <label for="6187fd70-0105-4785-8940-1c1f804dbc8a">Phone Number</label>
              <input id="6187fd70-0105-4785-8940-1c1f804dbc8a"
                     name="6187fd70-0105-4785-8940-1c1f804dbc8a" type="tel" required />

              <label for="090051c4-93ff-4f42-80bb-e0b9d8a26afa">LinkedIn</label>
              <input id="090051c4-93ff-4f42-80bb-e0b9d8a26afa"
                     name="090051c4-93ff-4f42-80bb-e0b9d8a26afa" type="text" />

              <label for="res">Resume</label>
              <input id="res" type="file" />

              <label>Yes<input type="radio"
                name="26c8666f-a821-493e-921c-b6f966a1c09d_fe19ec8e-680c-4f8d-bc5b-0c0866587f75" /></label>
              <label>No<input type="radio"
                name="26c8666f-a821-493e-921c-b6f966a1c09d_fe19ec8e-680c-4f8d-bc5b-0c0866587f75" /></label>

              <textarea name="g-recaptcha-response"></textarea>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

function scan(): readonly ApplyFieldDescriptor[] {
  const root = ashbyAdapter.resolveRoot(document);
  expect(root, 'adapter could not prove the Ashby container').not.toBeNull();
  return ashbyAdapter.scan(root!);
}

const byKey = (fields: readonly ApplyFieldDescriptor[], key: string) =>
  fields.filter((f) => f.key === key);

describe('ashbyAdapter.isApplyPath', () => {
  it('accepts the application route only', () => {
    expect(ashbyAdapter.isApplyPath('/cohere/e4603bb7-5bbe/application')).toBe(true);
    expect(ashbyAdapter.isApplyPath('/cohere/e4603bb7-5bbe/application/')).toBe(true);
  });

  it('rejects the posting page and the board index', () => {
    expect(ashbyAdapter.isApplyPath('/cohere/e4603bb7-5bbe')).toBe(false);
    expect(ashbyAdapter.isApplyPath('/cohere')).toBe(false);
    expect(ashbyAdapter.isApplyPath('/admin/cohere/e4603bb7-5bbe/application')).toBe(false);
    expect(ashbyAdapter.isApplyPath('/cohere/extra/e4603bb7-5bbe/application')).toBe(false);
  });
});

describe('ashbyAdapter.scan', () => {
  it('maps the two _systemfield_ names with full confidence', () => {
    mountAshbyFixture();
    const fields = scan();
    expect(byKey(fields, 'fullName')).toHaveLength(1);
    expect(byKey(fields, 'fullName')[0].confidence).toBe(1);
    expect(byKey(fields, 'email')).toHaveLength(1);
    expect(byKey(fields, 'email')[0].confidence).toBe(1);
  });

  /**
   * The whole point of this vendor: `phone` and `linkedin` have per-company
   * UUID names, so a name-only engine finds nothing. They are reachable only
   * through `<label for>` prose.
   */
  it('reaches UUID-named fields through their labels alone', () => {
    mountAshbyFixture();
    const fields = scan();
    for (const key of ['phone', 'linkedinUrl'] as const) {
      const matched = byKey(fields, key);
      expect(matched, `${key} 只能靠标签匹配，却没匹配到`).toHaveLength(1);
      expect(matched[0].confidence).toBe(0.75);
      // Confirm it really is an opaque name, i.e. the test is exercising the
      // label path rather than a stable-name shortcut.
      expect(matched[0].element.getAttribute('name')).toMatch(/^[0-9a-f-]{20,}$/);
    }
  });

  it('drops the reCAPTCHA textarea that shares the container', () => {
    mountAshbyFixture();
    expect(scan().some((f) => (f.element.getAttribute('name') ?? '').includes('recaptcha'))).toBe(
      false,
    );
  });

  /**
   * ⚠️ 2026-08-01 起 file 控件**不再**报 unsupported：它有了自己的写入原语
   * （`write/setFile.ts`）与能力位。引擎会再用 `isResumeFileField` 把它收窄到
   * **简历**那一栏——一张表上常常还有求职信、成绩单、作品集，挂错比不挂糟得多。
   *
   * 单选/复选目前仍归 unsupported，原因码是 `CHOICE_NO_DATA`。卡住它们的是数据：
   * 同日在两张真实申请表上数过，Greenhouse 零单选零复选；Lever 的 11 个复选框全是
   * 代词、3 个单选是 EEO 人口统计，我们的 11 键档案里没有对应数据，支持了也填不上
   * 东西。范围本身见 16 号裁决授权卡 A 栏（2026-08-03 更正过此处的旧表述）。
   */
  it('file 控件归 file kind；radio 仍报需手动', () => {
    mountAshbyFixture();
    const fields = scan();
    const file = fields.find((f) => (f.element as HTMLInputElement).type === 'file');
    const other = fields.find((f) => (f.element as HTMLInputElement).type === 'radio');
    expect(file, 'file 控件没被扫到').toBeTruthy();
    expect(file!.kind).toBe('file');
    expect(other, 'radio 控件没被扫到').toBeTruthy();
    // 单选/复选是一道题（choice kind），答案来自审阅面板；档案键从不猜它们。
    expect(other!.kind).toBe('choice');
  });

  /**
   * fail-closed. The hashed sibling class is the trap: it looks equally
   * "specific" but changes on every Ashby deploy, so anchoring on it would
   * make the surface vanish silently after an upgrade.
   */
  it('requires the semantic container, not the build-hashed one', () => {
    document.body.innerHTML =
      '<div class="_jobPostingForm_5yu8i_402"><input name="_systemfield_email" /></div>';
    expect(ashbyAdapter.resolveRoot(document)).toBeNull();
  });

  it('ignores controls outside the container', () => {
    mountAshbyFixture();
    document.body.insertAdjacentHTML(
      'beforeend',
      '<footer><label>Email<input type="email" name="_systemfield_email" /></label></footer>',
    );
    expect(byKey(scan(), 'email')).toHaveLength(1);
  });

  /**
   * Label matching is Ashby's primary signal, which makes the shared
   * `OTHER_PERSON` guard load-bearing here rather than defensive: an
   * unanchored `/linkedin/i` would otherwise write the applicant's own profile
   * into a reference's field and show it as a green "filled" row.
   */
  it('引擎守卫仍然拦住"别人的"字段，即使标签是唯一信号', () => {
    document.body.innerHTML = `
      <div class="ashby-application-form-container">
        <label for="a">LinkedIn</label><input id="a" name="uuid-a" type="text" />
        <label for="b">Emergency contact LinkedIn</label><input id="b" name="uuid-b" type="text" />
      </div>`;
    const root = ashbyAdapter.resolveRoot(document)!;
    const plan = buildApplyPlan(
      { vendor: 'ashby', root, fields: [...ashbyAdapter.scan(root)] },
      { linkedinUrl: 'https://linkedin.com/in/ada' },
    );
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].label).toBe('LinkedIn');
    expect(plan.skipped.some((s) => s.reason === 'OTHER_PERSON')).toBe(true);
  });
});

/**
 * 2026-09-24 测试台（jobs.ashbyhq.com/replit/447a6e11-…/application）：自我认同问卷不在申请表那个
 * 容器里。`#form` 下面并排挂着「简历自动填写」上传区、申请表容器、问卷容器
 * （`.ashby-survey-form-container > .ashby-application-form-container`）。锚点只取第一个
 * `.ashby-application-form-container`，问卷的性别、种族、退伍三组单选从来没被扫到——浮层上连一行都没有。
 * 结构照当天页面的 DOM（选项与题面原文，UUID 换成合成的）。
 */
function mountAshbyWithSurvey(): void {
  const radioGroup = (path: string, title: string, options: readonly string[]) => `
    <div data-field-path="${path}" data-field-entry-id="aaaa-1111__${path}">
      <fieldset class="_container_1258i_28 _fieldEntry_1e3gg_28 ashby-application-form-input-radio-group">
        <label class="_heading_f7cvd_52 _label_1e3gg_42 ashby-application-form-question-title" for="${path}">${title}</label>
        ${options.map((option, index) => `
          <div class="_option_1258i_34 false ashby-application-form-input-radio-group-option">
            <span class="_container_132c8_28" data-disabled="false"><input type="radio"
              id="aaaa-1111__${path}-labeled-radio-${index}" name="aaaa-1111__${path}"
              class="ashby-application-form-input-radio-group-option-radio"></span>
            <label for="aaaa-1111__${path}-labeled-radio-${index}"
              class="_label_1258i_42 ashby-application-form-input-radio-group-option-label">${option}</label>
          </div>`).join('')}
      </fieldset>
    </div>`;
  document.body.innerHTML = `
    <div id="root">
      <div class="ashby-job-posting-right-pane">
        <div id="form" role="tabpanel">
          <div class="_autofillPane_5yu8i_448 ashby-application-form-autofill-uploader _container_f7cvd_28">
            <div role="presentation" class="ashby-application-form-autofill-input-root">
              <input accept=".pdf,.doc,.docx" type="file" tabindex="-1" />
              <h3 class="ashby-application-form-autofill-input-title">Autofill from resume</h3>
              <p>Upload your resume here to autofill key application fields.</p>
              <button>Upload file</button>
            </div>
          </div>
          <div class="_jobPostingForm_5yu8i_402 ashby-application-form-container">
            <div class="_section_5yu8i_86 ashby-application-form-section-container">
              <label for="_systemfield_name">Full Name</label>
              <input id="_systemfield_name" name="_systemfield_name" type="text" required />
              <label for="_systemfield_email">Email</label>
              <input id="_systemfield_email" name="_systemfield_email" type="email" required />
              <label for="_systemfield_resume">Resume</label>
              <input id="_systemfield_resume" type="file" />
            </div>
          </div>
          <div class="ashby-survey-form-container">
            <div class="_jobPostingForm_5yu8i_402 ashby-application-form-container">
              <div class="_section_5yu8i_86 ashby-application-form-section-container">
                <p><strong>U.S. EQUAL EMPLOYMENT OPPORTUNITY INFORMATION</strong> (Completion is voluntary)</p>
                ${radioGroup('_systemfield_eeoc_gender', 'Gender', ['Male', 'Female', 'Decline to self-identify'])}
                ${radioGroup('_systemfield_eeoc_race', 'Race', [
                  'Hispanic or Latino',
                  'White (Not Hispanic or Latino)',
                  'Black or African American (Not Hispanic or Latino)',
                  'Native Hawaiian or Other Pacific Islander (Not Hispanic or Latino)',
                  'Asian (Not Hispanic or Latino)',
                  'American Indian or Alaska Native (Not Hispanic or Latino)',
                  'Two or More Races (Not Hispanic or Latino)',
                  'Decline to self-identify',
                ])}
                ${radioGroup('_systemfield_eeoc_veteran_status', 'Veteran Status', [
                  'I identify as one or more of the classifications of protected veteran listed above',
                  'I am not a protected veteran',
                  'I decline to self-identify for protected veteran status',
                ])}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

describe('ashbyAdapter: the self-identification survey sits in its own container', () => {
  it('scans the survey next to the application form and answers it from the profile', () => {
    mountAshbyWithSurvey();
    const root = ashbyAdapter.resolveRoot(document)!;
    const fields = [...ashbyAdapter.scan(root)];
    const choiceLabels = fields.filter((field) => field.kind === 'choice').map((field) => field.label);
    expect(choiceLabels).toEqual(['Gender', 'Race', 'Veteran Status']);
    const plan = buildApplyPlan(
      { vendor: 'ashby', root, fields },
      { fullName: 'Ada Lovelace', eeoGender: 'FEMALE', eeoRace: 'ASIAN', eeoVeteran: 'DECLINE' },
      { capabilities: { 'set-self-identification': true } },
    );
    expect(plan.entries.filter((entry) => entry.key.startsWith('eeo')).map((entry) => [entry.key, entry.value])).toEqual([
      ['eeoGender', 'Female'],
      ['eeoRace', 'Asian (Not Hispanic or Latino)'],
      ['eeoVeteran', 'I decline to self-identify for protected veteran status'],
    ]);
  });

  it('never scans the "Autofill from resume" uploader beside the form', () => {
    mountAshbyWithSurvey();
    const root = ashbyAdapter.resolveRoot(document)!;
    const files = [...ashbyAdapter.scan(root)].filter((field) => field.kind === 'file');
    expect(files.map((field) => field.element.id)).toEqual(['_systemfield_resume']);
  });

  it('keeps the application container as the root when a posting has no survey', () => {
    mountAshbyFixture();
    const fields = scan();
    const container = document.querySelector('.ashby-application-form-container')!;
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.every((field) => container.contains(field.element))).toBe(true);
  });
});
