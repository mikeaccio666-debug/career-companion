import { afterEach, describe, expect, it } from 'vitest';

import workday from '@edaix/apply-rules/workday.json';
import { compileBundledAdapter } from '../src/rules/interpreter';

/**
 * Workday「My Information」：地址、邮编、国家、州、来源题——认得出控件，却没有键。
 *
 * 2026-09-22 在 nvidia.wd5.myworkdayjobs.com 真实申请页上逐个读了每个控件「最近的带
 * data-automation-id 的祖先」（那正是 ancestorAttrMap 认键的依据）：
 *
 *   Address Line 1 / Postal Code   最近祖先 = formField-addressLine1 / formField-postalCode
 *   Country / State 按钮下拉        最近祖先 = formField-country / formField-countryRegion
 *   How Did You Hear About Us?     最近祖先 = multiselectInputContainer（一个结构包装层）
 *
 * 规则的 ancestorAttrMap 只写了姓名、城市、电话、LinkedIn 五个，于是前四栏落
 * 「没把握，没敢填」——那句话的内核含义是 `!field.key`。控件本身早就支持了：按钮下拉是
 * 规则里声明过的 listboxComboboxes，来源题是 promptComboboxes，缺的只是键。
 *
 * ## 来源题为什么不能也用 ancestorAttrMap
 *
 * 它的最近祖先是 `multiselectInputContainer`，而 ancestorAttrMap 是「最近的祖先说了算、
 * 不认识就闭集拒绝」——这是故意的（分机栏不许继承外层电话栏的键）。
 *
 * 加一个「透明包装层」字段能绕过去，但**旧版插件的规则解析器是严格的**：规则里出现一个
 * 不认识的键，整份 Workday 规则被拒，而一份被拒会让整个发布包被拒——所有厂商一起停，
 * 包括商店里的 1.0.0。所以只用**已有的规则能力**：输入框自己身上带着稳定的 Workday
 * 字段 id `source--source`，放一条 `attrMap(id)` 在 ancestorAttrMap **前面**。attrMap
 * 对认不出的 id 是放行给下一步，其他字段照旧由 ancestorAttrMap 认。
 *
 * ## 这一刀不碰的两栏
 *
 *  · **Country Phone Code**：映射到地址国家对 Mike 是对的（+1、美国），但 Argoland 的用户里
 *    有大量留学生——地址在美国、手机 +86 很常见，按地址国家选区号会让招聘方拨错国家。
 *    正确做法是从号码本身读国家码，而且要豁免「号码框 + 区号选择器」的同键仲裁，另做。
 *  · **Phone Device Type**：档案里没有这一项，填什么都是替用户定。
 */

/**
 * 2026-09-22 在 nvidia.wd5 真实页面上抽的**结构骨架**，手写成夹具——只有标签、
 * data-automation-id、字段 id、类型与题干，没有任何账号数据。
 *
 * 不用 `fixtures/workday/my-information-step2.html`：那份是 2026-08-21 录的，比规则里的
 * 控件声明（2026-09-15）还早——它的国家按钮后面没有那个 0×0 的镜像输入框，来源题的
 * 输入框也没有 `data-uxi-widget-type="selectinput"`，于是 listbox 与 prompt 两个声明
 * 在它上面一个都不生效。拿它测只会得到「控件不存在」，测不到键。
 */
const listbox = (field: string, fkit: string, label: string, name: string, required: boolean) => `
  <div data-automation-id="${field}" data-fkit-id="${fkit}">
    <label for="${fkit}">${label}${required ? '*' : ''}</label>
    <div><div><div><button id="${fkit}" name="${name}" type="button" aria-haspopup="listbox">Select One</button><input type="text" /><span></span></div></div><div></div></div>
  </div>`;
const text = (field: string, fkit: string, label: string, name: string, required: boolean) => `
  <div data-automation-id="${field}" data-fkit-id="${fkit}">
    <label for="${fkit}">${label}${required ? '*' : ''}</label>
    <div><div><input id="${fkit}" name="${name}" type="text" aria-required="${required}" /></div><div></div></div>
  </div>`;
const prompt = (field: string, fkit: string, label: string) => `
  <div data-automation-id="${field}" data-fkit-id="${fkit}">
    <label for="${fkit}">${label}*</label>
    <div><div><div><div data-automation-id="multiSelectContainer" data-uxi-widget-type="multiselect">
      <div data-automation-id="multiselectInputContainer"><div>
        <input id="${fkit}" data-uxi-widget-type="selectinput" aria-required="true" />
        <div data-automation-id="promptSelectionLabel"></div>
      </div><span data-automation-id="promptIcon" data-uxi-widget-type="selectinputicon"></span></div>
    </div></div></div><div></div></div>
  </div>`;

const FIXTURE = `
  <div data-automation-id="applyFlowMyInfoPage">
    ${prompt('formField-source', 'source--source', 'How Did You Hear About Us?')}
    ${listbox('formField-country', 'country--country', 'Country', 'country', true)}
    ${text('formField-legalName--firstName', 'name--legalName--firstName', 'First Name', 'legalName--firstName', true)}
    ${text('formField-legalName--lastName', 'name--legalName--lastName', 'Last Name', 'legalName--lastName', true)}
    ${text('formField-addressLine1', 'address--addressLine1', 'Address Line 1', 'addressLine1', false)}
    ${text('formField-city', 'address--city', 'City', 'city', false)}
    ${listbox('formField-countryRegion', 'address--countryRegion', 'State', 'countryRegion', false)}
    ${text('formField-postalCode', 'address--postalCode', 'Postal Code', 'postalCode', false)}
    ${listbox('formField-phoneType', 'phoneNumber--phoneType', 'Phone Device Type', 'phoneType', true)}
    ${prompt('formField-countryPhoneCode', 'phoneNumber--countryPhoneCode', 'Country Phone Code')}
    ${text('formField-emailAddress', 'emailAddress--emailAddress', 'Email', 'emailAddress', true)}
    ${text('formField-phoneNumber', 'phoneNumber--phoneNumber', 'Phone Number', 'phoneNumber', true)}
    ${text('formField-extension', 'phoneNumber--extension', 'Phone Extension', 'extension', false)}
  </div>`;

const adapter = () => compileBundledAdapter(workday as never);

const scan = () => {
  document.body.innerHTML = FIXTURE;
  const root = adapter().resolveRoot(document);
  expect(root, '夹具上找不到 My Information 的锚点——这条测试就没在测任何东西').not.toBeNull();
  return [...adapter().scan(root!)];
};

/** 按「这个控件所在的 formField」取它解出来的键。 */
const keyIn = (formField: string): string | null => {
  const hit = scan().find((field) =>
    field.element.closest(`[data-automation-id="${formField}"]`) !== null);
  return hit?.key ?? null;
};

afterEach(() => { document.body.innerHTML = ''; });

describe('Workday My Information：四个文本／下拉栏补上键', () => {
  it.each([
    ['formField-addressLine1', 'addressLine1'],
    ['formField-postalCode', 'addressPostalCode'],
    ['formField-country', 'addressCountry'],
    ['formField-countryRegion', 'addressRegion'],
  ])('%s → %s', (formField, key) => {
    expect(keyIn(formField), `${formField} 认得出控件，却没有键`).toBe(key);
  });

  it('国家与州是按钮下拉，照旧走规则声明的 listbox 组合框，不是普通文本', () => {
    for (const formField of ['formField-country', 'formField-countryRegion']) {
      const field = scan().find((item) => item.element.closest(`[data-automation-id="${formField}"]`) !== null);
      expect(field?.kind, formField).toBe('combobox');
    }
  });
});

/**
 * 2026-09-24 adobe.wd5（没登录就进了 applyManually）：Email 是第 1 页的必填，包装层是
 * formField-emailAddress。登录后的租户（nvidia）第 1 页没有这一栏，所以一直没补上，浮层只能
 * 让 AI 起草——邮箱是档案里现成的字段，不该等 AI。
 */
describe('Workday 没登录时第 1 页的 Email', () => {
  it('formField-emailAddress → email', () => {
    expect(keyIn('formField-emailAddress')).toBe('email');
  });
});

describe('Workday 来源题：最近祖先是结构包装层', () => {
  it('How Did You Hear About Us? → heardAboutSource（靠输入框自己的 id）', () => {
    expect(keyIn('formField-source')).toBe('heardAboutSource');
  });

  it('它照旧是层级多选（promptComboboxes），不是普通文本', () => {
    const field = scan().find((item) => item.element.closest('[data-automation-id="formField-source"]') !== null);
    expect(field?.kind).toBe('combobox');
  });
});

describe('放宽到此为止', () => {
  it('已有的五个键一个都不变', () => {
    expect(keyIn('formField-legalName--firstName')).toBe('firstName');
    expect(keyIn('formField-legalName--lastName')).toBe('lastName');
    expect(keyIn('formField-city')).toBe('city');
    expect(keyIn('formField-phoneNumber')).toBe('phone');
  });

  it('反向探针：区号不认——按地址国家选会让「地址在美国、手机 +86」的用户被拨错国家', () => {
    // Workday 会按 Country 自己默认区号（2026-09-22 nvidia 实测：区号已带出、Country 已选），
    // 我们不去覆盖它。
    expect(keyIn('formField-countryPhoneCode')).toBeNull();
  });

  it('电话类型认成 phone：选择器上的候选是「手机」的各种写法（见 apply-phone-device-type.test.ts）', () => {
    // 2026-09-22 产品决定：有 cell / mobile 就选。原先这里断言「不认」，理由是档案里没有这一项。
    expect(keyIn('formField-phoneType')).toBe('phone');
  });

  it('反向探针：分机栏仍然不继承电话的键（最近祖先说了算的那条纪律没被破）', () => {
    expect(keyIn('formField-extension')).toBeNull();
  });
});
