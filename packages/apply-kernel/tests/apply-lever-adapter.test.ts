import { afterEach, describe, expect, it } from 'vitest';

import type { ApplyFieldDescriptor } from '../src/contracts';
import { leverAdapter } from '../src/sites/lever/applyForm';

/**
 * Lever adapter, built against DOM read live from
 * `jobs.lever.co/<org>/<uuid>/apply` on 2026-08-01. The fixture reproduces the
 * real markup: a server-rendered `<form method="POST">` whose core fields carry
 * stable `name` attributes and almost no ids, the `urls[...]` bracket
 * namespace, per-posting `cards[<uuid>][fieldN]` questions, the location
 * typeahead, and the resume file input.
 *
 * All values are synthetic. Lever is deliberately the engine's control group:
 * no controlled React inputs, so a failure here is an engine fault rather than
 * a framework-compatibility fault.
 */

afterEach(() => {
  document.body.innerHTML = '';
});

function mountLeverFixture(): void {
  document.body.innerHTML = `
    <div class="content">
      <form id="application-form" method="POST">
        <div class="application-field">
          <input type="file" name="resume" id="resume-upload-input" />
        </div>

        <li class="application-question">
          <label><span class="application-label">Full name✱</span>
            <input type="text" name="name" required /></label>
        </li>

        <li class="application-question">
          <label><span class="application-label">Email✱</span>
            <input type="email" name="email" required /></label>
        </li>

        <li class="application-question">
          <label><span class="application-label">Phone ✱</span>
            <input type="text" name="phone" required /></label>
        </li>

        <li class="application-question" data-qa="structured-contact-location-question">
          <label><span class="application-label">Current location ✱</span>
            <input type="text" name="location" id="location-input" class="location-input" required /></label>
          <input type="hidden" id="selected-location" name="selectedLocation" />
          <div class="dropdown-container"><div class="dropdown-results"></div></div>
        </li>

        <li class="application-question">
          <label><span class="application-label">Current company</span>
            <input type="text" name="org" /></label>
        </li>

        <li class="application-question">
          <label><span class="application-label">LinkedIn URL</span>
            <input type="text" name="urls[LinkedIn]" /></label>
        </li>
        <li class="application-question">
          <label><span class="application-label">GitHub URL</span>
            <input type="text" name="urls[GitHub]" /></label>
        </li>
        <li class="application-question">
          <label><span class="application-label">Portfolio URL</span>
            <input type="text" name="urls[Portfolio]" /></label>
        </li>
        <li class="application-question">
          <label><span class="application-label">Other website</span>
            <input type="text" name="urls[Other]" /></label>
        </li>

        <li class="application-question">
          <label><span class="application-label">Pronouns</span>
            <input type="checkbox" name="pronouns" value="she/her" /></label>
        </li>

        <li class="application-question">
          <label><span class="application-label">Why do you want to work here?</span>
            <textarea name="cards[e27c9c9a][field1]"></textarea></label>
        </li>
        <li class="application-question">
          <label><span class="application-label">Years of experience</span>
            <select name="cards[e27c9c9a][field0]"><option value=""></option><option value="3">3</option></select></label>
        </li>
      </form>
    </div>`;
}

function scan() {
  const root = leverAdapter.resolveRoot(document);
  expect(root, 'adapter could not prove the Lever form root').not.toBeNull();
  return leverAdapter.scan(root!);
}

const byKey = (fields: readonly ApplyFieldDescriptor[], key: string): ApplyFieldDescriptor[] =>
  fields.filter((f) => f.key === key);

describe('leverAdapter.isApplyPath', () => {
  it('accepts the application route only', () => {
    expect(leverAdapter.isApplyPath('/matchgroup/1deea0b0-c0c9/apply')).toBe(true);
    expect(leverAdapter.isApplyPath('/matchgroup/1deea0b0-c0c9/apply/')).toBe(true);
  });

  it('rejects the board index and the job description', () => {
    // The description page has no form; surfacing there is a false positive.
    expect(leverAdapter.isApplyPath('/matchgroup')).toBe(false);
    expect(leverAdapter.isApplyPath('/matchgroup/1deea0b0-c0c9')).toBe(false);
    expect(leverAdapter.isApplyPath('/admin/matchgroup/1deea0b0-c0c9/apply')).toBe(false);
    expect(leverAdapter.isApplyPath('/matchgroup/1deea0b0-c0c9/apply/admin')).toBe(false);
  });
});

describe('leverAdapter.scan', () => {
  it('maps the core fields from stable names with full confidence', () => {
    mountLeverFixture();
    const fields = scan();

    for (const [key, expectedName] of [
      ['fullName', 'name'],
      ['email', 'email'],
      ['phone', 'phone'],
      ['linkedinUrl', 'urls[LinkedIn]'],
      ['githubUrl', 'urls[GitHub]'],
      ['portfolioUrl', 'urls[Portfolio]'],
    ] as const) {
      const matched = byKey(fields, key);
      expect(matched, `no field mapped to ${key}`).toHaveLength(1);
      expect(matched[0].confidence, `${key} should come from the stable name`).toBe(1);
      expect(matched[0].element.getAttribute('name')).toBe(expectedName);
    }
  });

  it('reads Lever wrapping labels rather than falling back to placeholders', () => {
    mountLeverFixture();
    const full = byKey(scan(), 'fullName')[0];
    // textOf() strips the required marker; the label must still be readable.
    expect(full.label).toContain('Full name');
  });

  /**
   * The location typeahead is the one field where writing it *as text* is worse
   * than not writing it: text typed without picking a suggestion is discarded,
   * so the form submits with no location while a readback sees text sitting in
   * the box.
   *
   * 2026-09-15 起它不再报 WIDGET，而是带着实测过的 typeahead binding 走 combobox
   * 那条路（打字 → 等建议稳定 → 点中一条 → 回读显示值与隐藏见证 selectedLocation）。
   * 这条测试锁的东西没变、只是换了正确那一侧：**它永远不能是一个可直接 setValue
   * 的 text 字段**。
   */
  it('reports the location typeahead as a bound combobox, never as a writable text field', () => {
    mountLeverFixture();
    const location = scan().find((f) => f.element.getAttribute('name') === 'location');
    expect(location, 'location field disappeared from the scan').toBeTruthy();
    expect(location!.kind).toBe('combobox');
    expect(location!.key).toBe('location');
    expect((location as { listbox?: unknown }).listbox).toMatchObject({
      valueContainerSelector: 'li.application-question[data-qa="structured-contact-location-question"]',
      selectedValueSelector: 'input#location-input',
      typeahead: {
        suggestionSelector: '.dropdown-results > div.dropdown-location',
        selectionWitnessSelector: 'input#selected-location',
      },
    });
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
  it('file 控件归 file kind；checkbox 仍报需手动', () => {
    mountLeverFixture();
    const fields = scan();
    const file = fields.find((f) => (f.element as HTMLInputElement).type === 'file');
    const other = fields.find((f) => (f.element as HTMLInputElement).type === 'checkbox');
    expect(file, 'file 控件没被扫到').toBeTruthy();
    expect(file!.kind).toBe('file');
    expect(other, 'checkbox 控件没被扫到').toBeTruthy();
    // 单选/复选是一道题（choice kind）：档案里没有数据源，由审阅面板的答案来填；
    // 16 号裁决授权卡 A 栏的边界不变——它们从不由档案键猜。
    expect(other!.kind).toBe('choice');
  });

  it('does not guess per-posting card questions or the unlabelled url slot', () => {
    mountLeverFixture();
    const fields = scan();
    const why = fields.find((f) => (f.element.getAttribute('name') ?? '').includes('field1'));
    expect(why?.key, 'a free-text card question must not be mapped to a profile field').toBeNull();

    // "Other website" is a real Lever slot but not the candidate's portfolio.
    const other = fields.find((f) => f.element.getAttribute('name') === 'urls[Other]');
    expect(other?.key).toBeNull();

    // `org` is the candidate's current company, and the Profile has that key since
    // P1-5; mapping it by name is exact, not a guess (2026-09-22 live: this row used
    // to read "没把握，没敢填" while the Profile had the value).
    expect(fields.find((f) => f.element.getAttribute('name') === 'org')?.key).toBe('currentCompany');
  });

  it('skips hidden inputs so the selectedLocation shadow field never surfaces', () => {
    mountLeverFixture();
    expect(scan().some((f) => f.element.getAttribute('name') === 'selectedLocation')).toBe(false);
  });

  /** fail-closed: no vendor-declared anchor means no autofill surface at all. */
  it('returns no root when the page has no application form', () => {
    document.body.innerHTML = '<div class="content"><form method="POST"><input name="email" /></form></div>';
    expect(leverAdapter.resolveRoot(document)).toBeNull();
  });

  it('ignores controls outside the form anchor', () => {
    mountLeverFixture();
    document.body.insertAdjacentHTML(
      'beforeend',
      '<footer><label>Email<input type="email" name="email" /></label></footer>',
    );
    // Exactly one email field — the newsletter box in the page footer must not
    // become a second candidate for the applicant's address.
    expect(byKey(scan(), 'email')).toHaveLength(1);
  });

  /**
   * 2026-09-24 测试台 jobs.lever.co/shieldai/30df7ce0-…：自定义题「Please state your full legal name: ✱」，
   * 控件是只有 placeholder 的 input.card-field-input，题干在 div.application-label > div.text。从前一条标签规则
   * 都不中，落「我们没认出这道题」、只能等 AI。
   */
  it('keys the custom question "Please state your full legal name" to the full name', () => {
    document.body.innerHTML = `
      <form id="application-form" method="POST">
        <li class="application-question custom-question">
          <div class="application-label full-width"><div class="text">Please state your full legal name:<span class="required">✱</span></div></div>
          <div class="application-field full-width required-field">
            <input class="card-field-input" type="text" name="cards[eb3750bb-e1f0-473c-a54d-012919c5e349][field0]" placeholder="Type your response" required />
          </div>
        </li>
        <li class="application-question custom-question">
          <div class="application-label full-width"><div class="text">Full legal name</div></div>
          <div class="application-field full-width">
            <input class="card-field-input" type="text" name="cards[eb3750bb][field1]" placeholder="Type your response" />
          </div>
        </li>
        <li class="application-question custom-question">
          <div class="application-label full-width"><div class="text">Reference's full legal name</div></div>
          <div class="application-field full-width">
            <input class="card-field-input" type="text" name="cards[eb3750bb][field2]" placeholder="Type your response" />
          </div>
        </li>
      </form>`;
    const fields = scan();
    expect(fields.map((field) => [field.label, field.key])).toEqual([
      ['Please state your full legal name', 'fullName'],
      ['Full legal name', 'fullName'],
      ["Reference's full legal name", null],
    ]);
  });
});
