import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { smartrecruitersAdapter } from '../src/sites/smartrecruiters/applyForm';

/**
 * SmartRecruiters one-click 的「City」栏，2026-09-15 在
 * `jobs.smartrecruiters.com/oneclick-ui/company/TurnerTownsend/publication/68ab7551-…`
 * 只读实测。基线是 `filled 8/11 · required 5/6`，差的那一个必填项就是它：
 * `city "City" CAPABILITY_DISABLED`（是 combobox，但没有任何 measured binding，
 * 于是 semantic authority 缺位、零点击）。
 *
 * 实测到三件决定这份夹具形状的事：
 *
 * 1. **它的 label 写「City*」，但它不是文本框。** 它是
 *    `input[role=combobox][aria-haspopup=listbox][aria-autocomplete=list]`，
 *    打字后打 `/oneclick-ui/api/location/autocomplete?q=…`，返回的是**完整地名**：
 *    "San Francisco, CA, US"、"San Francisco, Caraga, Philippines"、
 *    "San Francisco, Central Luzon, Philippines"… 一次七条同名城市。
 *    所以只给 `city`（"San Francisco"）会让阶梯匹配如实报 AMBIGUOUS_OPTION；
 *    它要的是档案里的 `location`（"San Francisco, CA, United States"）。
 * 2. **钩子只能是 `data-sr-id`。** id 是生成序号 `spl-form-element_10`（规则文件
 *    开头那条注释早就写明序号会漂），没有 name，`autocomplete` 是 `off`。
 * 3. **部件拆在两棵影子树里**（见 apply-aria-reference-shadow.test.ts）：触发器在
 *    `spl-input` 的影子根里，它 `aria-controls` 指的 listbox 在外面一层
 *    `spl-autocomplete` 的影子根里。
 *
 * 同页第二个 role=combobox 是电话区号选择器（`input.c-spl-dropdown-search__input`，
 * aria-label「Search by country/region or code」，没有 data-sr-id）。它**不得**被
 * City 的 binding 命中——这份夹具把它一起摆上，就是为了锁住这条。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

/** One-click 表单的实测形态：没有 <form>，锚点是自定义元素，控件全在影子根里。 */
function mountOneClickFixture(): void {
  document.body.innerHTML = '<oc-app-root class="oc-content"><oc-oneclick-form></oc-oneclick-form></oc-app-root>';
  const anchor = document.querySelector('oc-oneclick-form')!;
  anchor.innerHTML = `
    <div class="form-section">
      <oc-personal-information>
        <spl-input id="spl-form-element_1"></spl-input>
        <oc-location-autocomplete-wrapper>
          <oc-location-autocomplete>
            <spl-autocomplete id="spl-form-element_10"></spl-autocomplete>
          </oc-location-autocomplete>
        </oc-location-autocomplete-wrapper>
        <spl-dropdown-search></spl-dropdown-search>
      </oc-personal-information>
    </div>`;

  // First name: 实测最稳的一档，W3C autocomplete 直接可用。
  const nameShadow = anchor.querySelector('spl-input#spl-form-element_1')!.attachShadow({ mode: 'open' });
  nameShadow.innerHTML = `
    <spl-internal-form-field>
      <label for="first-name-input">First name</label>
      <input id="first-name-input" class=" c-spl-input " type="text" autocomplete="given-name" required>
    </spl-internal-form-field>`;

  // City：外层影子根放 listbox，内层影子根放触发器。
  const outer = anchor.querySelector('spl-autocomplete#spl-form-element_10')!.attachShadow({ mode: 'open' });
  outer.innerHTML = `
    <div><spl-internal-form-field>
      <spl-dropdown class="c-spl-autocomplete-dropdown">
        <div class="c-spl-autocomplete-trigger"><spl-input id="spl-form-element_10"></spl-input></div>
        <div id="menu-spl-form-element_10" slot="menu" role="listbox"
             data-sr-id="location-autocomplete-search-menu"></div>
      </spl-dropdown>
    </spl-internal-form-field></div>`;
  const inner = outer.querySelector('spl-input#spl-form-element_10')!.attachShadow({ mode: 'open' });
  inner.innerHTML = `
    <spl-internal-form-field><div class="c-spl-input-grid"><div class="c-spl-input-wrapper">
      <label for="spl-form-element_10">City*</label>
      <input id="spl-form-element_10" class="c-spl-input" type="text" role="combobox"
             aria-haspopup="listbox" aria-autocomplete="list" aria-expanded="false"
             aria-controls="menu-spl-form-element_10" aria-required="true" autocomplete="off"
             data-sr-id="location-autocomplete-search-search-input">
    </div></div></spl-internal-form-field>`;

  // 电话区号选择器：同样是 role=combobox，但没有 data-sr-id，是另一个部件。
  const phone = anchor.querySelector('spl-dropdown-search')!.attachShadow({ mode: 'open' });
  phone.innerHTML = `
    <div class="c-spl-dropdown-search">
      <input class="c-spl-dropdown-search__input" type="text" role="combobox"
             aria-haspopup="listbox" aria-autocomplete="list" aria-expanded="false"
             aria-controls="spl-form-element_12-menu" autocomplete="off"
             placeholder="Search by country/region or code"
             aria-label="Search by country/region or code">
    </div>`;
}

const scan = () => {
  const root = smartrecruitersAdapter.resolveRoot(document)!;
  return { root, fields: smartrecruitersAdapter.scan(root) };
};

const cityField = (fields: ReturnType<typeof scan>['fields']) =>
  fields.find((field) => field.element.getAttribute('data-sr-id') === 'location-autocomplete-search-search-input');

const phoneCodeField = (fields: ReturnType<typeof scan>['fields']) =>
  fields.find((field) => field.element.classList.contains('c-spl-dropdown-search__input'));

describe('SmartRecruiters · one-click 的 City 是地点自动完成框', () => {
  it('锚点穿过影子根拿到两个 combobox 与具名文本框', () => {
    mountOneClickFixture();
    const { fields } = scan();
    // 页面上 document.querySelectorAll('input') 是 0——没有穿透扫描就什么都没有。
    expect(document.querySelectorAll('input')).toHaveLength(0);
    expect(fields.map((field) => field.kind).sort()).toEqual(['combobox', 'combobox', 'text']);
  });

  it('City 解析成 `location` 而不是 `city` —— 地理编码返回的是完整地名', () => {
    mountOneClickFixture();
    const city = cityField(scan().fields);
    // `city` 会让候选只剩 "San Francisco"，而实测同一查询有七条同名城市
    // （CA / Caraga / Central Luzon / Central Visayas / Córdoba…），
    // 阶梯匹配只会 AMBIGUOUS_OPTION，一条都点不了。
    expect(city?.key).toBe('location');
    expect(city?.kind).toBe('combobox');
    expect(city?.required).toBe(true);
  });

  it('City 拿到 measured binding；电话区号选择器一个都不许拿到', () => {
    mountOneClickFixture();
    const { fields } = scan();
    const city = cityField(fields);
    const phoneCode = phoneCodeField(fields);

    expect(city?.kind === 'combobox' ? city.listbox : undefined).toMatchObject({
      valueContainerSelector: 'div.c-spl-input-wrapper',
      selectedValueSelector: 'input[data-sr-id="location-autocomplete-search-search-input"]',
      // 菜单里的十一行是 <spl-select-option>，没有 role=option：不声明行选择器，
      // 通用扫法会看到一个空菜单并报 CHOICE_NO_DATA。
      optionSelector: 'spl-select-option',
    });
    // 区号选择器是混合语义且默认已正确，声明它等于多开一类可点目标。
    expect(phoneCode?.kind).toBe('combobox');
    expect(phoneCode?.kind === 'combobox' ? phoneCode.listbox : 'no-binding').toBeUndefined();
    expect(phoneCode?.key ?? null).toBeNull();
  });

  it('readback 选择器在触发器自己那棵影子树里解析得到', () => {
    mountOneClickFixture();
    const city = cityField(scan().fields)!;
    const binding = city.kind === 'combobox' ? city.listbox! : undefined;
    // `closest()` 不跨影子边界：valueContainerSelector 写外层的
    // `oc-location-autocomplete` 就一个字都解析不到，回读会永远读到空。
    const container = city.element.closest(binding!.valueContainerSelector);
    expect(container).not.toBeNull();
    expect(container!.querySelector(binding!.selectedValueSelector)).toBe(city.element);
    expect(city.element.closest('oc-location-autocomplete')).toBeNull();
  });

  it('计划里 City 带着档案的 location 值进入 combobox 通路', () => {
    mountOneClickFixture();
    const { root, fields } = scan();
    const plan = buildApplyPlan(
      { vendor: 'smartrecruiters', root, fields: [...fields] },
      { firstName: 'Taylor', location: 'San Francisco, CA, United States' },
      {},
    );
    const entry = plan.entries.find((candidate) => candidate.key === 'location');
    expect(entry?.kind).toBe('combobox');
    expect(entry?.value).toBe('San Francisco, CA, United States');
    // 区号那一栏没有键也没有 binding，照旧不进计划。
    expect(plan.entries.some((candidate) => candidate.element === phoneCodeField(fields)?.element)).toBe(false);
  });
});
