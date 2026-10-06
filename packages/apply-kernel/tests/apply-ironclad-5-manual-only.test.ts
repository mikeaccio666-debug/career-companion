import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import type { ApplyProfileDraft } from '../src/profileDraft';

/**
 * 当前 stable runtime 的 fail-closed 守卫证据：**EEO 自我认同 / 法律声明勾选 / 密码 / 验证码**
 * 在未有已批准 dedicated release 链前全部不进写入计划；这个测试不把 pending proposal 误记为永久拒绝。
 *
 * ⚠️ **2026-08-18 之前这四类在填表链路上一道守卫都没有**（体检发现）：
 * engine 的守卫链只有蜜罐 / 推荐人 / JOB_DEPENDENT 三道；`isPasswordField` 与
 * 名字就叫「永不自动填」的 `mustNeverAutofill` 在 src/ 下**零调用方**；
 * `LEGAL_DECLARATION` / `OTP_OR_VERIFICATION` 的正则只活在 `click/policy.ts`，
 * 那条路径只被 combobox 点击用，**管不到 setValue / setFile 的写入链**。
 *
 * 密码今天之所以没被填，只是因为 `TEXTUAL_INPUT_TYPES` 白名单**碰巧没有**
 * `'password'`——体检实测把它加进去，570 + 129 条用例**全绿**。
 * 也就是说此前**没有任何测试写着「密码不许填」**。
 *
 * 更近的风险是 choice 写入（数据源就位后必然做）：一旦接上，EEO 人口统计单选与
 * 「I certify…」法律勾选会直接通过全部现有守卫被代勾。
 */

afterEach(() => { document.body.innerHTML = ''; });

/** 满档案：证明"不填"不是因为没数据。 */
const FULL: ApplyProfileDraft = {
  firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test',
  phone: '+1 555 0100', city: 'London', location: 'London, UK',
};

function planWith(extra: string, type = 'text') {
  document.body.innerHTML = `<form id="application-form">
    <label for="first_name">First Name</label><input id="first_name" type="text" />
    ${extra}
  </form>`;
  void type;
  const root = greenhouseAdapter.resolveRoot(document)!;
  return buildApplyPlan({ vendor: 'greenhouse', root, fields: [...greenhouseAdapter.scan(root)] }, FULL);
}

const reasonFor = (p: ReturnType<typeof planWith>, label: string) =>
  p.skipped.find((s) => s.label === label)?.reason;

function expectManualOnly(label: string, html: string) {
  const plan = planWith(html);
  expect(
    plan.entries.map((e) => e.label),
    `「${label}」进了写入计划——铁律 5 说这四类永远由用户本人操作`,
  ).not.toContain(label);
  expect(
    reasonFor(plan, label),
    `「${label}」没被判成 MANUAL_ONLY——守卫没覆盖到它`,
  ).toBe('MANUAL_ONLY');
}

describe('铁律 5：四类永不进写入计划', () => {
  it.each([
    ['Password', '<label for="pw">Password</label><input id="pw" type="text" />'],
    ['Confirm password', '<label for="pw2">Confirm password</label><input id="pw2" type="text" />'],
    ['密码', '<label for="pw3">密码</label><input id="pw3" type="text" />'],
  ])('密码：%s', (label, html) => expectManualOnly(label, html));

  it.each([
    ['Gender', '<label for="g">Gender</label><input id="g" type="text" />'],
    ['Race / Ethnicity', '<label for="r">Race / Ethnicity</label><input id="r" type="text" />'],
    ['Veteran Status', '<label for="v">Veteran Status</label><input id="v" type="text" />'],
    ['Voluntary Self-Identification of Disability', '<label for="d">Voluntary Self-Identification of Disability</label><input id="d" type="text" />'],
    ['Equal Opportunity Employer Information', '<label for="e">Equal Opportunity Employer Information</label><input id="e" type="text" />'],
  ])('EEO 自我认同：%s', (label, html) => expectManualOnly(label, html));

  it.each([
    ['I certify that the information provided is accurate', '<label for="c">I certify that the information provided is accurate</label><input id="c" type="text" />'],
    ['I agree to the Terms and Conditions', '<label for="t">I agree to the Terms and Conditions</label><input id="t" type="text" />'],
    ['本人确认以上信息属实', '<label for="z">本人确认以上信息属实</label><input id="z" type="text" />'],
  ])('法律声明勾选：%s', (label, html) => expectManualOnly(label, html));

  it.each([
    ['Verification code', '<label for="o">Verification code</label><input id="o" type="text" />'],
    ['Enter the OTP sent to your phone', '<label for="o2">Enter the OTP sent to your phone</label><input id="o2" type="text" />'],
    ['验证码', '<label for="o3">验证码</label><input id="o3" type="text" />'],
  ])('验证码 / 2FA：%s', (label, html) => expectManualOnly(label, html));

  it.each([
    ['I authorize a background check', '<label for="b">I authorize a background check</label><input id="b" type="text" />'],
    ['I agree to binding arbitration', '<label for="a">I agree to binding arbitration</label><input id="a" type="text" />'],
    ['I consent to a credit report', '<label for="cr">I consent to a credit report</label><input id="cr" type="text" />'],
    ['Subscribe to job alerts', '<label for="s">Subscribe to job alerts</label><input id="s" type="text" />'],
    ['同意背景调查', '<label for="bg">同意背景调查</label><input id="bg" type="text" />'],
  ])('实质授权在当前 stable classifier 中一律 fail closed：%s', (label, html) => expectManualOnly(label, html));

  it('顺序是安全属性：同时命中两档时必须落 CONSENT_GRANT 一侧', () => {
    // `I authorize a background check` 同时命中「i authorize」与背景调查。
    // 两档的差别是「opt-in 后可不可以代勾」——判错档就等于把实质授权
    // 放进了可代勾的那一堆。这条锁的是判定顺序本身。
    const plan = planWith('<label for="x">I authorize a background check for employment</label><input id="x" type="text" />');
    expect(reasonFor(plan, 'I authorize a background check for employment')).toBe('MANUAL_ONLY');
  });

  it('反向：正常字段照填，守卫不许误伤', () => {
    // 只锁"这四类不填"的话，把守卫写成恒真也全绿——用户就一个字段都填不上了。
    const plan = planWith('<label for="email">Email</label><input id="email" type="email" />');
    expect(plan.entries.map((e) => e.key).sort()).toEqual(['email', 'firstName']);
    expect(plan.skipped.filter((s) => s.reason === 'MANUAL_ONLY')).toEqual([]);
  });

  it('这四类要提示用户去页面处理（不进 NEVER_PROMPT——与蜜罐相反）', () => {
    // 蜜罐是"填了有害、连提都别提"；这四类是"只能你本人做"，必须引导。
    // 铁律 5 原文就是「由用户本人操作」，不是「装作不存在」。
    const plan = planWith('<label for="pw">Password</label><input id="pw" type="text" required />');
    const skip = plan.skipped.find((s) => s.label === 'Password');
    expect(skip?.required, 'required 位丢了，filler 侧就不会产出 IN_PAGE_ACTION').toBe(true);
  });
});

import { classifyManualOnly } from '../src/dict/guards';

/**
 * 分档的直接单测。
 *
 * 今天两档都不填，所以**走 engine 的测试证伪不了判定顺序**——调换
 * `CONSENT_GRANT` 与 `LEGAL_ATTESTATION` 的先后，22 条用例照样全绿。
 * 那就是一条不可证伪的安全声称（`docs/64` §1）。这里直接测分档函数。
 *
 * 顺序为什么是安全属性：`I authorize a background check` **同时命中两档**。
 * 判成 OPT_IN_ELIGIBLE 就意味着——opt-in 开关落地那天，用户开了「代勾信息属实」
 * 之后，我们会连他的背景调查同意一起勾了。
 */
describe('当前 stable 分档：硬拒绝闭集与既有 opt-in eligible', () => {
  it.each([
    ['Password', 'NEVER'], ['验证码', 'NEVER'],
    ['I authorize a background check', 'NEVER'],
    // ↓ 跨档的**复合标签**——真实申请表上把属实声明与实质授权写在同一个
    //   checkbox 里很常见。这两条是顺序探针真正咬得住的地方：判成
    //   OPT_IN_ELIGIBLE，就意味着用户开了「代勾信息属实」之后，
    //   我们会连他的背景调查同意 / VA 核查授权一起勾了。
    ['I certify that I consent to a background check', 'NEVER'],
    ['I certify the above and agree to the Terms and Conditions', 'NEVER'],
    ['Veteran Status — I authorize verification with the VA', 'NEVER'],
    ['I agree to binding arbitration', 'NEVER'],
    ['I consent to a credit report', 'NEVER'],
    ['Subscribe to job alerts', 'NEVER'],
    ['Gender', 'OPT_IN_ELIGIBLE'],
    ['Race / Ethnicity', 'OPT_IN_ELIGIBLE'],
    ['Veteran Status', 'OPT_IN_ELIGIBLE'],
    ['I certify that the information provided is accurate', 'OPT_IN_ELIGIBLE'],
    ['本人声明以上信息属实', 'OPT_IN_ELIGIBLE'],
    ['First Name', null], ['Email', null],
  ])('%s → %s', (label, tier) => {
    expect(
      classifyManualOnly(label),
      `「${label}」分档错了——opt-in 落地后这一格决定它会不会被我们代勾`,
    ).toBe(tier);
  });
});

/**
 * 结构化守卫：**看元素，不只看文案**。
 *
 * Yiwen 审 PR #20（2026-08-18）指出，此前「密码不会被填」是**被动**成立的——
 * 只因为 `TEXTUAL_INPUT_TYPES` 白名单碰巧没有 `'password'`。她的变异探针：
 * 把 password 加进那张表，640 条测试**照样全绿**，而一个
 * `<label>Email</label><input type="password">` 会直接进写入计划。
 *
 * 本组测的是**主动**保护：不管控件类型白名单怎么变，
 * `type=password` 与 `autocomplete=current-password` 都必须被挡住。
 */
describe('结构化守卫：真 password 控件（文案伪装成别的）', () => {
  it.each([
    ['type=password 而 label 写 Email', { type: 'password' }],
    ['autocomplete=current-password 而 type=text', { type: 'text', autocomplete: 'current-password' }],
    ['autocomplete=new-password 而 type=text', { type: 'text', autocomplete: 'new-password' }],
  ])('%s → MANUAL_ONLY，不进写入计划', (_name, attrs) => {
    const extra = Object.entries(attrs)
      .map(([k, v]) => `${k}="${v}"`)
      .join(' ');
    document.body.innerHTML = `<form id="application-form">
      <label for="pw">Email</label><input id="pw" name="pw" ${extra} />
    </form>`;
    const root = greenhouseAdapter.resolveRoot(document)!;
    const plan = buildApplyPlan(
      { vendor: 'greenhouse', root, fields: [...greenhouseAdapter.scan(root)] },
      { email: 'a@b.com' } as never,
    );

    expect(
      plan.entries.map((e) => e.label),
      '密码控件进了写入计划——铁律 5。文案伪装成 Email 就绕过了',
    ).not.toContain('Email');
    expect(
      plan.skipped.find((s) => s.label === 'Email')?.reason,
      '被挡住了但理由不是 MANUAL_ONLY——那说明挡它的是别的顺带条件（比如控件类型' +
        '白名单），不是铁律 5 的守卫。把 password 加进白名单它就会漏',
    ).toBe('MANUAL_ONLY');
  });
});
