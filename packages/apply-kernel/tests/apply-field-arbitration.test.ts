import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { createScanRoot } from '../src/scanRoot';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import type { ApplyProfileDraft } from '../src/profileDraft';

/**
 * 分节与字段仲裁后处理（CAP-AF-045）。
 *
 * 复核结论（2026-08-15，engine.ts 字段循环）：**同一个 canonical key 命中两个
 * 控件，两个都会被写**——循环末尾直接 entries.push，全无按键去重或分节结构。
 *
 * 真实后果：多节表单（地址段 / 工作授权段 / 教育段各有一个 City）互相抢字段，
 * 要么把用户的城市写进教育段的"学校城市"，要么重复写同一栏触发宿主校验。
 * Workday 与 iCIMS 重复 City/Country，连 Greenhouse 都重复 Location。
 * 原定触发条件是「接第二家厂商时一起做」——四家早就接完了。
 *
 * 规格（AUTOFILL-DESIGN §2.4.4–2.4.5）：
 *  · 分节：autocomplete section token → fieldset → 最近前置标题 → 整表一节；
 *  · 每节每键至多一个：并列时先比 confidence，再比 DOM 顺序；
 *  · 理性化后处理：
 *      - fullName 与 first+last 同节并存 → 二选一（保留更具体的拆分对）；
 *      - 相邻两个 email 的第二个当 emailConfirm——**照填**（确认栏要的就是同值）；
 *      - phone 且 maxlength≤5 → 那不是电话栏（分机/区号），降手填。规格原文写的
 *        type=number；本仓 type=number 本来就是 UNSUPPORTED_CONTROL（TEXTUAL_INPUT_TYPES
 *        白名单），真正漏网的是 **type=text maxlength=4** 的分机栏——写进去会被
 *        宿主截断成 "+1 5"；
 *      - postalCode 紧跟 addressLine1 的降置信规则：**这两个键今天不存在**
 *        （11 键上限，扩键归 T3 的 CAP-AF-018），键落地前无法实现，此处留档。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const PROFILE: ApplyProfileDraft = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  fullName: 'Ada Lovelace',
  email: 'ada@example.test',
  phone: '+1 555 0100',
  city: 'Seattle',
};

function plan(html: string) {
  document.body.innerHTML = `<form id="application-form">${html}</form>`;
  const root = greenhouseAdapter.resolveRoot(document);
  expect(root, '适配器没认出表单').not.toBeNull();
  return buildApplyPlan(
    { vendor: 'greenhouse', root: root!, fields: [...greenhouseAdapter.scan(root!)] },
    PROFILE,
  );
}

const keysOf = (built: ReturnType<typeof plan>) => built.entries.map((entry) => entry.key);
const idsOf = (built: ReturnType<typeof plan>) =>
  built.entries.map((entry) => (entry.element as HTMLElement).id);
const dupSkips = (built: ReturnType<typeof plan>) =>
  built.skipped.filter((item) => item.reason === 'DUPLICATE_FIELD');

describe('每节每键至多一个', () => {
  it('同节同键两个控件只写一个，落选的如实报 DUPLICATE_FIELD', () => {
    const built = plan(
      `<label for="city_a">City</label><input id="city_a" type="text" />
       <label for="city_b">City</label><input id="city_b" type="text" />`,
    );
    expect(
      keysOf(built).filter((key) => key === 'city'),
      '同键写了两个——重复写同一栏会触发宿主校验或互相覆盖',
    ).toHaveLength(1);
    expect(dupSkips(built)).toHaveLength(1);
  });

  it('并列时 confidence 高者胜，与 DOM 顺序无关', () => {
    // city_label 靠标签命中（0.75）排前；city_auto 靠 autocomplete 命中（0.95）排后。
    const built = plan(
      `<label for="city_label">City</label><input id="city_label" type="text" />
       <label for="city_auto">Town</label><input id="city_auto" type="text" autocomplete="address-level2" />`,
    );
    expect(idsOf(built)).toContain('city_auto');
    expect(idsOf(built), 'confidence 低的那个赢了——仲裁没比置信度').not.toContain('city_label');
  });

  it('confidence 相同时 DOM 顺序在前者胜（确定性）', () => {
    const built = plan(
      `<label for="city_1">City</label><input id="city_1" type="text" />
       <label for="city_2">City</label><input id="city_2" type="text" />`,
    );
    expect(idsOf(built)).toContain('city_1');
    expect(idsOf(built)).not.toContain('city_2');
  });

  it('不同 fieldset 是不同节：各节保留自己的一个', () => {
    // 规格如此（每**节**每键至多一个）。跨节语义（教育段的 City 不是用户的城市）
    // 归行作用域与 T3 结构化集合，不在这条能力里扩大。
    const built = plan(
      `<fieldset><legend>Home address</legend>
         <label for="city_home">City</label><input id="city_home" type="text" /></fieldset>
       <fieldset><legend>Mailing address</legend>
         <label for="city_mail">City</label><input id="city_mail" type="text" /></fieldset>`,
    );
    expect(idsOf(built).filter((id) => id.startsWith('city_'))).toEqual(['city_home', 'city_mail']);
    expect(dupSkips(built)).toHaveLength(0);
  });

  it('无 fieldset 时最近前置标题分节', () => {
    const built = plan(
      `<h3>Current address</h3>
       <label for="city_now">City</label><input id="city_now" type="text" />
       <h3>Previous address</h3>
       <label for="city_prev">City</label><input id="city_prev" type="text" />`,
    );
    expect(idsOf(built).filter((id) => id.startsWith('city_'))).toEqual(['city_now', 'city_prev']);
  });
});

describe('理性化后处理', () => {
  it('相邻两个 email：第二个当确认栏，两个都照填同值', () => {
    // greenhouse 没有 email 的标签 pattern：第一个走 id attrMap（conf 1），
    // 第二个走 autocomplete attrMap（conf 0.95）。
    const built = plan(
      `<label for="email">Email</label><input id="email" type="email" />
       <label for="email_confirm">Confirm email</label><input id="email_confirm" type="email" autocomplete="email" />`,
    );
    const emails = built.entries.filter((entry) => entry.key === 'email');
    expect(
      emails,
      '确认栏被仲裁吃掉了——用户还得手抄一遍邮箱，宿主校验也过不去',
    ).toHaveLength(2);
    expect(emails.every((entry) => entry.value === 'ada@example.test')).toBe(true);
  });

  it('第三个 email 不再豁免，照常仲裁掉', () => {
    const built = plan(
      `<label for="e1">Email</label><input id="e1" type="email" autocomplete="email" />
       <label for="e2">Confirm email</label><input id="e2" type="email" autocomplete="email" />
       <label for="e3">Alternate email</label><input id="e3" type="email" autocomplete="email" />`,
    );
    expect(built.entries.filter((entry) => entry.key === 'email').length).toBeLessThanOrEqual(2);
    expect(dupSkips(built).length).toBeGreaterThan(0);
  });

  it('同节 fullName 与 first+last 并存：保留拆分对，fullName 让位', () => {
    const built = plan(
      `<label for="first_name">First Name</label><input id="first_name" type="text" />
       <label for="last_name">Last Name</label><input id="last_name" type="text" />
       <label for="full">Full name</label><input id="full" type="text" autocomplete="name" />`,
    );
    expect(keysOf(built)).toContain('firstName');
    expect(keysOf(built)).toContain('lastName');
    expect(
      keysOf(built),
      'fullName 和拆分对同时写——同一信息进了三栏，宿主把 Full name 当独立答案时就错了',
    ).not.toContain('fullName');
    expect(dupSkips(built)).toHaveLength(1);
  });

  it('反向探针：只有 fullName 时照常填，不许顺手扩杀', () => {
    const built = plan(
      `<label for="full">Full name</label><input id="full" type="text" autocomplete="name" />`,
    );
    expect(keysOf(built)).toContain('fullName');
  });

  it('phone 且 maxlength≤5：那不是电话栏（分机），降手填', () => {
    // id="phone" 走 attrMap conf 1——键匹配毫无问题，问题在**形状**：
    // 4 个字符装不下任何电话号码，写进去会被宿主截断成 "+1 5"。
    const built = plan(
      `<label for="phone">Phone extension</label><input id="phone" type="text" maxlength="4" />`,
    );
    expect(keysOf(built), '分机栏被当成电话填了 +1 555…——截断后是一串垃圾').not.toContain('phone');
    const skip = built.skipped.find((item) => item.label.toLowerCase().includes('extension'));
    expect(skip?.reason).toBe('LOW_CONFIDENCE');
  });

  it('反向探针：正常电话照常填（无 maxlength 束缚）', () => {
    const built = plan(`<label for="phone">Phone</label><input id="phone" type="tel" />`);
    expect(keysOf(built)).toContain('phone');
  });
});

/**
 * 同一件事、问法不同的两道**选择题**（2026-09-23 Discord 实测）：公司自订的「Race or Ethnicity (optional)」与
 * Greenhouse 标准段里答完「是否拉美裔」才冒出来的必填「Please identify your race」同在一节、同一个键。
 * 仲裁只留一道，必填那道被判成 DUPLICATE_FIELD、又被面板藏起来，浮层说「还有 1 项」而页面上还空着一道必填。
 * 自我认同与工作授权这几类的答案对哪一种问法都一样：题面不同就是两道题，两道都答。
 */
describe('同键不同题的选择题都答', () => {
  function comboboxes(fields: readonly { id: string; label: string; required: boolean; key: string }[]) {
    document.body.innerHTML = `<form>${fields
      .map((field) => `<label for="${field.id}">${field.label}</label><input id="${field.id}" role="combobox" aria-autocomplete="list" aria-expanded="false" />`)
      .join('')}</form>`;
    return {
      vendor: 'greenhouse',
      root: createScanRoot(document.querySelector('form')!, [], []),
      fields: fields.map((field, index) => ({
        kind: 'combobox',
        element: document.getElementById(field.id),
        key: field.key,
        label: field.label,
        required: field.required,
        confidence: 0.9,
        signature: { core: `form/input:${index}`, labelHint: field.label },
        listbox: { triggerSelector: 'input[role="combobox"]', valueContainerSelector: '.v', selectedValueSelector: '.s' },
      })),
    } as never;
  }

  it('自订的族裔题与标准段的条件种族题：两道都进计划，一道都不判重复', () => {
    const built = buildApplyPlan(
      comboboxes([
        { id: 'custom_race', label: 'Race or Ethnicity (optional)', required: false, key: 'eeoRace' },
        { id: 'std_race', label: 'Please identify your race', required: true, key: 'eeoRace' },
      ]),
      { eeoRace: 'ASIAN' } as never,
      { capabilities: { 'set-self-identification': true } } as never,
    );
    expect(built.entries.map((entry) => (entry.element as HTMLElement).id)).toEqual(['custom_race', 'std_race']);
    expect(dupSkips(built)).toHaveLength(0);
  });

  it('题面相同的两个选项控件仍是同一道题的重复控件，照常仲裁', () => {
    const built = buildApplyPlan(
      comboboxes([
        { id: 'race_a', label: 'Race', required: false, key: 'eeoRace' },
        { id: 'race_b', label: 'Race', required: false, key: 'eeoRace' },
      ]),
      { eeoRace: 'ASIAN' } as never,
      { capabilities: { 'set-self-identification': true } } as never,
    );
    expect(built.entries).toHaveLength(1);
    expect(dupSkips(built)).toHaveLength(1);
  });

  /**
   * 同一道题网站问了两遍（2026-10-04 测试台，Greenhouse Point72）：「Are you legally authorized to work in the United States?」
   * 在申请表里出现两次，两个下拉都标必填。从前第二个判成重复、从不填，网站上一直空着一道必填（bench-1003 第六节）。
   * 网站要两格都答，答案就是同一个：都必填、都是选项控件、题面是一整句问话时两格都答。
   */
  it('同一道题问了两遍、两格都必填：两格都答（同一个答案）', () => {
    const question = 'Are you legally authorized to work in the United States?';
    const built = buildApplyPlan(
      comboboxes([
        { id: 'auth_a', label: question, required: true, key: 'workAuthorization' },
        { id: 'auth_b', label: question, required: true, key: 'workAuthorization' },
      ]),
      { workAuthorization: 'YES' } as never,
    );
    expect(built.entries.map((entry) => (entry.element as HTMLElement).id)).toEqual(['auth_a', 'auth_b']);
    expect(new Set(built.entries.map((entry) => entry.value)).size).toBe(1);
    expect(dupSkips(built)).toHaveLength(0);
  });

  it('同一道题两格、只有一格必填：照常仲裁，留下必填那一格', () => {
    const question = 'Are you legally authorized to work in the United States?';
    const built = buildApplyPlan(
      comboboxes([
        { id: 'auth_a', label: question, required: false, key: 'workAuthorization' },
        { id: 'auth_b', label: question, required: true, key: 'workAuthorization' },
      ]),
      { workAuthorization: 'YES' } as never,
    );
    expect(built.entries.map((entry) => (entry.element as HTMLElement).id)).toEqual(['auth_b']);
    expect(dupSkips(built)).toHaveLength(1);
  });

  it('真要仲裁时必填优先：落选的不会是必填那一栏', () => {
    const built = plan(
      `<label for="city_a">City</label><input id="city_a" type="text" />
       <label for="city_b">City</label><input id="city_b" type="text" required />`,
    );
    expect(idsOf(built)).toEqual(['city_b']);
    expect(dupSkips(built)).toHaveLength(1);
  });
});
