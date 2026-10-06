import { afterEach, describe, expect, it } from 'vitest';

import type { ApplyFieldDescriptor } from '../src/contracts';
import { readApplyForm } from '../src/registry';
import { resolveScanRootMutationPolicy } from '../src/scanRoot';
import { workableAdapter } from '../src/sites/workable/applyForm';
import { installBundledApplyAdapters } from '../src/bundledAdapters';

// 识别路径的适配器表生产由后端 release 装配；单测不连后端，装随包内置那份。
installBundledApplyAdapters();


/**
 * Workable adapter, built against DOM read live from
 * `apply.workable.com/<org>/j/<code>/apply/` on 2026-08-01.
 *
 * The fixture reproduces what the live form actually looks like, including the
 * two things that contradicted the plan:
 *
 *  - the `<form>` has **no id** and a build-hashed class, so the only
 *    vendor-declared anchor is `data-ui="application-form"`;
 *  - `data-ui` is **not** on every control. `phone`, `city`, `postcode` and
 *    `country` carry none, so `name` — not `data-ui` — is the field signal.
 *
 * All values are synthetic.
 */

afterEach(() => {
  document.body.innerHTML = '';
});

function mountWorkableFixture(): void {
  document.body.innerHTML = `
    <div data-ui="careers-page-content">
      <main role="main">
        <form class="styles--2I-rr" data-ui="application-form">
          <label for="firstname">First name*</label>
          <input id="firstname" name="firstname" data-ui="firstname" type="text" required />

          <label for="lastname">Last name*</label>
          <input id="lastname" name="lastname" data-ui="lastname" type="text" required />

          <label for="email">Email*</label>
          <input id="email" name="email" data-ui="email" type="email" required />

          <label>Phone*<input name="phone" type="tel" autocomplete="off" required /></label>

          <label for="address">Address</label>
          <input id="address" name="address" data-ui="address" type="text" aria-required="false" />

          <label>City<input name="city" type="text" /></label>
          <label>Postcode<input name="postcode" type="text" /></label>
          <label>Country<input name="country" type="text" /></label>

          <input type="file" name="resume" data-ui="resume" />
          <!-- 公司可以自定义核心字段的标签文案，这一句是常见写法。它同时命中
               LABEL_PATTERNS 的 /website/i —— 没有"具名核心控件不走标签兜底"
               这条守卫的话，用户的作品集网址会被写进求职信框。 -->
          <label for="cover_letter">Cover letter or a link to your website</label>
          <textarea id="cover_letter" name="cover_letter" data-ui="cover_letter"></textarea>

          <label>Do you require sponsorship?
            <input type="radio" name="QA_12113744" value="yes" /></label>

          <label for="QA_12113745">LinkedIn profile</label>
          <input id="QA_12113745" name="QA_12113745" data-ui="QA_12113745" type="text" />

          <label for="QA_12113746">Why do you want to work here?</label>
          <textarea id="QA_12113746" name="QA_12113746" data-ui="QA_12113746"></textarea>
          <button data-ui="apply-button" type="submit">Submit application</button>
        </form>
      </main>
    </div>`;
}

function scan(): readonly ApplyFieldDescriptor[] {
  const root = workableAdapter.resolveRoot(document);
  expect(root, 'adapter could not prove the Workable form root').not.toBeNull();
  return workableAdapter.scan(root!);
}

const byName = (fields: readonly ApplyFieldDescriptor[], name: string) =>
  fields.find((f) => f.element.getAttribute('name') === name);

describe('workableAdapter.isApplyPath', () => {
  it('accepts the application route, with or without the org segment', () => {
    expect(workableAdapter.isApplyPath('/domain-tools/j/E2072FA81D/apply/')).toBe(true);
    expect(workableAdapter.isApplyPath('/domain-tools/j/E2072FA81D/apply')).toBe(true);
    expect(workableAdapter.isApplyPath('/j/ABC123/apply')).toBe(true);
  });

  it('rejects the posting page, which carries no form', () => {
    expect(workableAdapter.isApplyPath('/domain-tools/j/E2072FA81D')).toBe(false);
    expect(workableAdapter.isApplyPath('/domain-tools/j/E2072FA81D/')).toBe(false);
    expect(workableAdapter.isApplyPath('/careers/')).toBe(false);
    expect(workableAdapter.isApplyPath('/admin/domain-tools/j/E2072FA81D/apply')).toBe(false);
    expect(workableAdapter.isApplyPath('/domain-tools/extra/j/E2072FA81D/apply')).toBe(false);
  });
});

describe('workableAdapter.scan', () => {
  it('projects the unique vendor-declared final native control without exposing its selector', () => {
    mountWorkableFixture();
    const descriptor = readApplyForm('workable', document)!;
    expect(descriptor.finalSubmitControl?.element.getAttribute('data-ui')).toBe('apply-button');
    expect(descriptor.finalSubmitControl?.form).toBe(document.querySelector('form'));
    expect(descriptor.finalSubmitControl?.isCurrent()).toBe(true);

    const duplicate = document.createElement('button');
    duplicate.type = 'submit';
    duplicate.dataset.ui = 'apply-button';
    descriptor.finalSubmitControl!.form.append(duplicate);
    expect(descriptor.finalSubmitControl?.isCurrent()).toBe(false);
  });

  it('mutation seal follows real data-ui semantics and ignores unrelated hashed class churn', () => {
    mountWorkableFixture();
    const form = document.querySelector('form')!;
    form.insertAdjacentHTML('beforeend', `
      <div data-ui="experience"><ul><li><input name="title" /></li></ul></div>`);
    const descriptor = readApplyForm('workable', document)!;
    const policy = resolveScanRootMutationPolicy(descriptor.root)!;
    const experience = form.querySelector('[data-ui="experience"]')!;

    form.className = 'styles--another-build-hash';
    expect(policy.isRelevant([{
      type: 'attributes',
      target: form,
      attributeName: 'class',
    } as unknown as MutationRecord])).toBe(false);
    expect(policy.isCurrent()).toBe(true);

    expect(policy.isRelevant([{
      type: 'attributes',
      target: descriptor.fields[0]!.element,
      attributeName: 'form',
    } as unknown as MutationRecord])).toBe(true);

    experience.setAttribute('data-ui', 'not-experience');
    expect(policy.isRelevant([{
      type: 'attributes',
      target: experience,
      attributeName: 'data-ui',
    } as unknown as MutationRecord])).toBe(true);
  });

  it('maps the core fields from stable names with full confidence', () => {
    mountWorkableFixture();
    const fields = scan();
    for (const [name, key] of [
      ['firstname', 'firstName'],
      ['lastname', 'lastName'],
      ['email', 'email'],
      ['phone', 'phone'],
      ['city', 'city'],
    ] as const) {
      const field = byName(fields, name);
      expect(field, `${name} missing`).toBeTruthy();
      expect(field!.key, `${name} → ${key}`).toBe(key);
      expect(field!.confidence).toBe(1);
    }
  });

  /**
   * `phone` and `city` carry no `data-ui` on the live form. Keying on it would
   * silently drop two required core fields — the plan's "data-ui is a
   * first-class hook" claim only holds for some controls.
   */
  it('maps controls that have no data-ui at all', () => {
    mountWorkableFixture();
    const fields = scan();
    for (const name of ['phone', 'city']) {
      expect(byName(fields, name)!.element.getAttribute('data-ui')).toBeNull();
      expect(byName(fields, name)!.key, `${name} 只靠 data-ui 就会被漏掉`).not.toBeNull();
    }
  });

  it('具名核心控件按 name 映到各自的键（2026-09-22：P1-5 之后它们有键了）', () => {
    mountWorkableFixture();
    const fields = scan();
    // 从前这三栏刻意留空，理由是「没有对应的档案键」而不是「不该填」。P1-5 之后
    // 它们各有一个键，而按 **name** 映射不存在那条理由担心的标签误伤——认的是
    // 控件自己的名字，不是标签文字。
    expect(byName(fields, 'address')?.key).toBe('addressLine1');
    expect(byName(fields, 'postcode')?.key).toBe('addressPostalCode');
    expect(byName(fields, 'country')?.key).toBe('addressCountry');
  });

  /**
   * 守卫的真实作用面。第一版这条测试是**摆设**：拿 `address` 当例子，而
   * "Address" 本来就不匹配任何 LABEL_PATTERN，所以把守卫整条删掉断言照样绿
   * （红绿自证当场抓到）。真正会出事的是**具名核心控件被配了一个命中 pattern
   * 的标签**——公司把求职信标签写成 "Cover letter or a link to your website"
   * 是常见写法，而它命中 /website/i。
   */
  it('具名核心控件即使标签命中 pattern 也不走兜底', () => {
    mountWorkableFixture();
    const coverLetter = byName(scan(), 'cover_letter');
    expect(coverLetter!.label).toMatch(/website/i);
    expect(
      coverLetter!.key,
      '用户的作品集网址会被写进求职信框 —— 具名控件不该回落到猜标签',
    ).toBeNull();
  });

  it('falls through to labels only for the opaque QA_<digits> questions', () => {
    mountWorkableFixture();
    const fields = scan();
    const linkedin = byName(fields, 'QA_12113745');
    expect(linkedin?.key).toBe('linkedinUrl');
    expect(linkedin?.confidence).toBe(0.75);
    // A free-text essay question must not be mapped onto a profile field.
    expect(byName(fields, 'QA_12113746')?.key).toBeNull();
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
    mountWorkableFixture();
    const fields = scan();
    const file = fields.find((f) => (f.element as HTMLInputElement).type === 'file');
    const other = fields.find((f) => (f.element as HTMLInputElement).type === 'radio');
    expect(file, 'file 控件没被扫到').toBeTruthy();
    expect(file!.kind).toBe('file');
    expect(other, 'radio 控件没被扫到').toBeTruthy();
    // 单选/复选是一道题（choice kind），答案来自审阅面板；档案键从不猜它们。
    expect(other!.kind).toBe('choice');
  });

  it('reads aria-required="false" as not required', () => {
    mountWorkableFixture();
    // Workable writes the attribute explicitly; a truthy-string check would
    // mark every optional field as required and skew the progress model.
    expect(byName(scan(), 'address')!.required).toBe(false);
    expect(byName(scan(), 'firstname')!.required).toBe(true);
  });

  /** fail-closed: the anchor is a vendor container attribute, never an input id. */
  it('returns no root when the vendor anchor is absent', () => {
    document.body.innerHTML =
      '<main><form class="styles--2I-rr"><input name="email" /></form></main>';
    expect(workableAdapter.resolveRoot(document)).toBeNull();
  });

  it('ignores controls outside the anchored form', () => {
    mountWorkableFixture();
    document.body.insertAdjacentHTML(
      'beforeend',
      '<footer><label>Email<input type="email" name="email" /></label></footer>',
    );
    expect(scan().filter((f) => f.key === 'email')).toHaveLength(1);
  });
});
