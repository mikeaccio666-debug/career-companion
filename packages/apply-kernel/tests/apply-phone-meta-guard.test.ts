import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { ashbyAdapter } from '../src/sites/ashby/applyForm';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import type { ApplyProfileDraft } from '../src/profileDraft';

/**
 * Ashby 的姓名缺口 + 电话元数据栏守卫的接线。
 *
 * ## 一、Ashby 对 firstName / lastName 是**零信号**
 *
 * `packages/apply-rules/rules/ashby.json` 的 attrMap 只有两条
 * （`_systemfield_name → fullName`、`_systemfield_email → email`），labelPatterns
 * 覆盖 linkedin/github/portfolio/phone/city/preferredName——**没有姓、没有名**。
 * 而这家的规则文件自己写着「标签文案在这家是主信号而非兜底」（其余全是逐公司 UUID）。
 *
 * 后果：雇主把姓名配置成两栏的 Ashby 表单，我们每次白丢两个字段。而「First name」
 * 「Last name」大概是整个招聘表单世界里最没有歧义的两个标签。
 *
 * ## 二、电话元数据栏守卫是第五处死代码
 *
 * `dict/guards.ts:97` 的 `isPhoneMetaField` 单测全绿（Phone extension / Area code /
 * Device type / 分机 / 区号），`src/` 下零调用方。今天唯一拦住分机栏的是
 * `maxlength ≤ 5` 兜底，拦不住没写 maxlength 的那些。
 *
 * 两件必须同批：放宽电话标签的**同时**才需要这道网——分机栏写进整串手机号，
 * 回读会通过（值确实在那儿），面板报「已填」，属于「把没成功报成成功」那一族。
 *
 * ## 三、这一轮**不**放宽到无锚定正则
 *
 * 新增的电话标签一律两端锚定（`^\s*mobile\s*$` 这种形态），所以「Phone extension」
 * 在标签层根本匹配不到。无锚定的广化（`/phone/i`）要等真实 posting 采样——
 * 没有真实页面就估不出误命中率，而本仓已有「十条适配器测试全绿、真实页面浮层
 * 根本不出现」的直接反例。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const PROFILE: ApplyProfileDraft = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.test',
  phone: '+1 555 0100',
};

function plan(html: string) {
  document.body.innerHTML = `<div class="ashby-application-form-container">${html}</div>`;
  const root = ashbyAdapter.resolveRoot(document);
  expect(root, '适配器没认出 Ashby 表单容器').not.toBeNull();
  return buildApplyPlan(
    { vendor: 'ashby', root: root!, fields: [...ashbyAdapter.scan(root!)] },
    PROFILE,
  );
}

const keysOf = (built: ReturnType<typeof plan>) => built.entries.map((entry) => entry.key);

describe('Ashby 的拆分姓名', () => {
  it('First name / Last name 两栏能填——今天是白丢的', () => {
    const built = plan(
      `<label for="a">First name</label><input id="a" name="_systemfield_x1" type="text" />
       <label for="b">Last name</label><input id="b" name="_systemfield_x2" type="text" />`,
    );
    expect(
      keysOf(built),
      'Ashby 拆分姓名的表单里「First name」认不出——这家的标签是主信号，其余全是逐公司 UUID',
    ).toContain('firstName');
    expect(keysOf(built)).toContain('lastName');
  });

  it.each([
    ['Given name', 'firstName'],
    ['Surname', 'lastName'],
    ['Family name', 'lastName'],
  ])('「%s」这类常见写法也认得', (label, key) => {
    const built = plan(`<label for="a">${label}</label><input id="a" type="text" />`);
    expect(keysOf(built)).toContain(key);
  });

  it('反向探针：Full name 仍然落 fullName，不被拆分规则抢走', () => {
    const built = plan(
      `<label for="a">Name</label><input id="a" name="_systemfield_name" type="text" />`,
    );
    expect(keysOf(built)).toContain('fullName');
  });

  it('反向探针：不许顺手吃掉别人的名字栏', () => {
    // 推荐人守卫排在匹配之前；这条确认新增的姓名 pattern 没有绕过它。
    const built = plan(
      `<label for="a">Reference first name</label><input id="a" type="text" />`,
    );
    expect(keysOf(built), '推荐人的名字被填成了申请人本人').not.toContain('firstName');
  });
});

describe('电话标签的保守放宽', () => {
  it.each(['Mobile', 'Mobile number', 'Cell', 'Cell phone', 'Telephone'])(
    '「%s」认得出是电话',
    (label) => {
      const built = plan(`<label for="p">${label}</label><input id="p" type="tel" />`);
      expect(keysOf(built), `「${label}」认不出——真实表单上电话栏很少正好写 Phone`).toContain(
        'phone',
      );
    },
  );

  it('反向探针：原有的 Phone / Phone number 照常', () => {
    for (const label of ['Phone', 'Phone number']) {
      const built = plan(`<label for="p">${label}</label><input id="p" type="tel" />`);
      expect(keysOf(built)).toContain('phone');
    }
  });
});

describe('电话元数据栏不接电话号码', () => {
  it.each([
    'Phone extension',
    'Mobile extension',
    'Area code',
    'Phone device type',
    '分机',
    '区号',
  ])('「%s」栏不许写入电话号码', (label) => {
    const built = plan(`<label for="f">${label}</label><input id="f" type="text" />`);
    expect(
      keysOf(built),
      `「${label}」被当成电话栏填了整串号码——值确实留在那儿，回读会通过，面板报「已填」`,
    ).not.toContain('phone');
  });

  it('守卫要盖住 attrMap，不只是标签层（Greenhouse `id="phone"` + 分机标签）', () => {
    // attrMap 置信度是 1，标签层的锚定放宽根本管不着它。Greenhouse 的
    // `id="phone"` 直落 phone 键，而 CAP-AF-045 的 maxlength≤5 兜底对
    // **没写 maxlength** 的分机栏失效——今天这一栏会被填进整串手机号。
    document.body.innerHTML =
      '<form id="application-form">' +
      '<label for="phone">Phone extension</label><input id="phone" type="text" />' +
      '</form>';
    const root = greenhouseAdapter.resolveRoot(document);
    expect(root).not.toBeNull();
    const built = buildApplyPlan(
      { vendor: 'greenhouse', root: root!, fields: [...greenhouseAdapter.scan(root!)] },
      PROFILE,
    );
    expect(
      built.entries.map((entry) => entry.key),
      'attrMap 的高置信把标签的警告压过去了——分机栏收到了整串手机号',
    ).not.toContain('phone');
  });

  it('反向探针：守卫只对 phone 键生效，不许扩到别的键', () => {
    // PHONE_GUARD 含 `type` 与 `device`。对所有键生效就会误杀「Type of employment」
    // 这类正常字段——那是把一道窄守卫用成宽刀。
    // 这两栏在档案里没有值，所以它们本就该落 NO_VALUE（"去补资料"）。
    // 守卫一旦扩到所有键，原因码就会变成 LOW_CONFIDENCE（"我们没认出来"）——
    // 两者给用户的下一步动作相反，而且后者是我们在撒谎：我们认出来了。
    const built = plan(
      `<label for="a">Preferred name type</label><input id="a" type="text" />
       <label for="b">City type</label><input id="b" type="text" />`,
    );
    const reasons = Object.fromEntries(built.skipped.map((item) => [item.label, item.reason]));
    expect(
      reasons['Preferred name type'],
      '守卫扩到了 preferredName——PHONE_GUARD 里的 type/device 会误杀一批正常字段',
    ).toBe('NO_VALUE');
    expect(reasons['City type'], '守卫扩到了 city').toBe('NO_VALUE');
  });

  it('反向探针：Greenhouse 正常 `id="phone"` 栏照常填', () => {
    document.body.innerHTML =
      '<form id="application-form">' +
      '<label for="phone">Phone</label><input id="phone" type="tel" />' +
      '</form>';
    const root = greenhouseAdapter.resolveRoot(document);
    const built = buildApplyPlan(
      { vendor: 'greenhouse', root: root!, fields: [...greenhouseAdapter.scan(root!)] },
      PROFILE,
    );
    expect(built.entries.map((entry) => entry.key)).toContain('phone');
  });
});
