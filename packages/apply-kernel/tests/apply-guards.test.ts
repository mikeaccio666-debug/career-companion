import { describe, expect, it } from 'vitest';

import {
  isCountryCodeField,
  isHoneyPotField,
  isHoneypotGeometry,
  isNonResumeFileField,
  isResumeFileField,
  isOtherPersonField,
  isPasswordField,
  isPhoneMetaField,
  mustNeverAutofill,
  normalizeGuardText,
} from '../src/dict/guards';

describe('autofill field guards', () => {
  it('normalizes spacing before applying anchored guards', () => {
    expect(normalizeGuardText('  Confirm\n Password  ')).toBe('confirm password');
    expect(isPasswordField('  Confirm\n Password  ')).toBe(true);
  });

  it.each([
    'Emergency contact name',
    'Reference email',
    'Guarantor phone',
    'Next of kin',
    '紧急联系人电话',
    '推荐人邮箱',
  ])('marks %s as another person’s field', (label) => {
    expect(isOtherPersonField(label)).toBe(true);
  });

  // 2026-09-17 合投表单：队友那一栏必须拦住，否则会把申请人自己的姓名写进去。
  it.each([
    'Team member 2 first and last name',
    'Team member 2 email address',
    'Supervisor name',
    'Supervisor phone number',
    "Relative's name",
    'Reference',
    'References',
    'Reference 1 - Company',
  ])('still marks %s as another person’s field', (label) => {
    expect(isOtherPersonField(label)).toBe(true);
  });

  // 2026-09-23 同页对比：这些问的是申请人自己，却被当成「涉及他人」拦掉了。
  // 「preference」里含 reference（没有词边界），偏好题一律被拦；长问句里的 team members / supervisor /
  // relative 说的是申请人的经历，不是要别人的资料。
  it.each([
    'How comfortable are you mentoring other team members and performing code reviews?',
    'Work location preference',
    'Shift preference',
    'Pronoun preference',
    'Years of relevant experience relative to this role',
    'Have you ever worked as a supervisor or team lead?',
  ])('does not mistake %s for another person’s field', (label) => {
    expect(isOtherPersonField(label)).toBe(false);
  });

  // 2026-09-24 adobe.wd5 第 3 页：担保签证题在括号里举例「spouse visa」，被整道当成「涉及他人」跳过——这一页最要紧的一题空着。
  // 括号里的举例（e.g. / such as / for example / including）与「配偶签证」这种签证类型说法，说的都不是另一个人。
  it.each([
    'Will you now or in the future require sponsorship for employment visa status (e.g., H-1B visa status, spouse visa, etc)?',
    'Will you require sponsorship (such as H-1B, spousal visa, OPT)?',
    'Do you currently hold a spouse visa or dependent visa?',
    'Are you on a spousal work permit?',
  ])('does not mistake %s for another person’s field', (label) => {
    expect(isOtherPersonField(label)).toBe(false);
  });

  it.each([
    'Spouse name',
    'Is your spouse a US citizen?',
    "Spouse's employer",
    'Emergency contact (e.g., spouse or parent)',
    'Name of spouse (if any)',
  ])('still marks %s as another person’s field', (label) => {
    expect(isOtherPersonField(label)).toBe(true);
  });

  it.each(['Phone extension', 'Area code', 'Device type', '分机', '区号'])(
    'does not mistake %s for a personal phone number',
    (label) => {
      expect(isPhoneMetaField(label)).toBe(true);
    },
  );

  it.each(['Country calling code', 'Dial code', 'Phone country code'])(
    'does not mistake %s for a country selector',
    (label) => {
      expect(isCountryCodeField(label)).toBe(true);
    },
  );

  it.each([
    'Leave this field blank',
    'Please leave the box blank',
    'Do not fill',
    '请将此栏留空',
  ])('recognises honey pot wording: %s', (label) => {
    expect(isHoneyPotField(label)).toBe(true);
    expect(mustNeverAutofill(label)).toBe(true);
  });

  it.each(['Password', 'Choose password', 'Retype password', 'Confirm password', '密码'])(
    'never autofills a password field: %s',
    (label) => {
      expect(isPasswordField(label)).toBe(true);
      expect(mustNeverAutofill(label)).toBe(true);
    },
  );

  it('leaves ordinary applicant fields eligible for their type-specific rules', () => {
    const label = 'Applicant email address';
    expect(isOtherPersonField(label)).toBe(false);
    expect(isPhoneMetaField(label)).toBe(false);
    expect(isCountryCodeField(label)).toBe(false);
    expect(mustNeverAutofill(label)).toBe(false);
  });
});

/**
 * 简历那一栏的两层判据，都是 2026-08-23 接 Rippling 时被真实页面戳穿的。
 *
 * Rippling 的简历控件：标签是 **`Résumé`**（带重音），`name` 为空，
 * `id` 是位置序号 `field-4`，唯一语义化的属性是 `data-testid="input-resume"`。
 * 两层各漏一半，合起来就是「简历上传永不触发，且完全静默」——面板显示
 * 「需手动填」，看起来像我们不支持这个控件（与 2026-08-01 Greenhouse
 * 那次一模一样的形状，见 `RESUME_FILE` 头注）。
 */
describe('简历判据 · Rippling 戳穿的两层', () => {
  it('文案层认得带重音的 Résumé', () => {
    // `\bresum[eé]\b` 匹配不到 `ré`：重音在**第一个** e 上。
    for (const label of ['Résumé', 'résumé', 'Resumé', 'Resume', 'CV', 'Curriculum Vitae']) {
      expect(isResumeFileField(label), label).toBe(true);
    }
  });

  it('文案层不会把求职信当简历', () => {
    // 正向白名单的意义：挂错栏比不挂糟——recruiter 看到明显不对的附件，
    // 而用户以为自己传对了。
    // 只列实测支持的英文文案。法语 `Lettre de motivation` 一度写在这里，
    // 但我量的是英文页——没量过的词表不进（漏认的后果是 UNSUPPORTED_CONTROL，
    // 安全的一侧）。
    for (const label of ['Cover letter', 'Transcript', 'Portfolio']) {
      expect(isNonResumeFileField(label), label).toBe(true);
    }
  });

  it('属性身份层读 data-testid —— 不然 Rippling 的简历栏两层都够不着', () => {
    // 标签为空时只剩这一层。Rippling 的 name 为空、id 是 field-4，
    // 唯一语义化的就是 data-testid。
    expect(isResumeFileField('', [null, 'field-4', 'input-resume'])).toBe(true);
  });
});

/**
 * Dover 的「Autofill from resume」诱饵栏（2026-08-23 实测，50-证据库 §F.8-d）。
 *
 * Dover 的申请表上有**两个** `accept=".pdf"` 的文件输入：
 *
 *  1. `Autofill from resume · Drag & drop or upload to autofill your application`
 *     —— 这是**厂商自己的简历解析器**，传上去是让它回填表单，不是附件；
 *  2. `Drag and drop file or browse computer (PDF, 5 MB maximum)`
 *     —— 这才是真正的简历附件栏，而它的文案里**一个 resume 字都没有**。
 *
 * 正向白名单在这里正好挑中假的、漏掉真的 —— 与它被设计出来要防的
 * 「把简历挂到成绩单那一栏」是同一个错，方向反过来而已。
 */
describe('简历判据 · Dover 的诱饵栏', () => {
  it('「Autofill from resume」不算简历附件栏', () => {
    expect(
      isNonResumeFileField('Autofill from resume Drag & drop or upload to autofill your application'),
      '会把简历传进厂商的解析器而不是附件栏',
    ).toBe(true);
  });

  it('真正的附件栏文案里没有 resume —— 认不出它是安全的一侧', () => {
    // 认不出 ⇒ UNSUPPORTED_CONTROL ⇒ 提示手填。这比挂错栏好。
    expect(isResumeFileField('Drag and drop file or browse computer (PDF, 5 MB maximum)')).toBe(false);
  });
});

/**
 * 「推到视口外」这一招（2026-08-23，BambooHR 实测逼出来的）。
 *
 * 实测的藏法是把**父节点** `position:absolute; left:-9999px`，
 * 而蜜罐元素自己 `visibility:visible`、尺寸正常（**178×28**）。
 * 所以：
 *
 *  · `width <= 1 || height <= 1` —— 判不出来；
 *  · `clip` / `clip-path` —— 干净；
 *  · `font-size` —— 正常。
 *
 * 那一家最后是靠文案层（label 逐字 `Please leave this field blank`）接住的 ——
 * **单点**。而「推到视口外」恰恰是最常见的一种藏法，下一家未必好心给个 label。
 *
 * ## 为什么敢往这里加一条
 *
 * 失败方向不对称：误判的代价是**少填一栏**（如实报「需手动填」），
 * 漏判的代价是**整份申请被站点静默丢弃**，而用户以为投出去了。
 *
 * ## 判据为什么是「整体在左侧视口外很远」而不是「坐标为负」
 *
 * `getBoundingClientRect()` 是**视口相对**的：页面往下滚一点，上面的字段
 * `top` 就变成负数 —— 那是完全正常的。所以纵向一律不判。
 * 横向也要求**整体出界**（`right <= 0`）且**很远**（`left <= -1000`）：
 * 表单里的真实字段被横向推出去一千像素以上，实际不会发生。
 */
describe('蜜罐几何 · 推到视口外', () => {
  it('实测的 BambooHR 形态：尺寸正常，但整体在左侧视口外', () => {
    // 实测值：width 178.5 / height 28 / left -9935 / right -9757
    expect(isHoneypotGeometry({ width: 178.5, height: 28, left: -9935, right: -9757 })).toBe(true);
  });

  it('往下滚过去的正常字段不算 —— 纵向一律不判', () => {
    for (const box of [
      { width: 240, height: 32, top: -400, left: 20, right: 260 },
      { width: 240, height: 32, top: -4000, left: 20, right: 260 },
    ]) {
      expect(isHoneypotGeometry(box), JSON.stringify(box)).toBe(false);
    }
  });

  it('只是部分出界、或出界得不远，都不算', () => {
    for (const box of [
      { width: 240, height: 32, left: -100, right: 140 }, // 左边露出去一点，主体还在
      { width: 240, height: 32, left: -260, right: -20 }, // 整体出界但只有 260px
      { width: 240, height: 32, left: 20, right: 260 }, // 正常
    ]) {
      expect(isHoneypotGeometry(box), JSON.stringify(box)).toBe(false);
    }
  });

  it('没给横向坐标时行为逐字不变 —— 这个维度是纯增量', () => {
    expect(isHoneypotGeometry({ width: 240, height: 32 })).toBe(false);
    expect(isHoneypotGeometry({ width: 1, height: 32 })).toBe(true);
  });
});
