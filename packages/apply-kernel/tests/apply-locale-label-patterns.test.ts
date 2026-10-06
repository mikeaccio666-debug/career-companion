import { afterEach, describe, expect, it } from 'vitest';

import { parseVendorRuleset } from '../src/rules/schema';
import { compileRuleAdapter } from '../src/rules/interpreter';

/**
 * 标签匹配的 locale 分层 schema（CAP-AF-015）。
 *
 * 四份规则的 `labelPatterns` 今天全是英文正则，schema 里没有任何 locale 维度。
 * 目标用户是留学生：欧洲 / 加拿大法语区 / 德语区的申请页、以及同一家 ATS 的
 * 本地化界面全部匹配不上，表现为「浮层出来了但一个字段都认不出」——这条来自
 * **被真实用户投诉验证过**的竞品失效模式。
 *
 * 为什么现在就要定 schema 而不是等真要发多语言时再说：规则由后端热更新下发。
 * schema 一旦发出去，改动就是包结构级重构，代价随时间上升。所以 v1 仍然只发
 * 英文，但**分层维度现在就存在**。
 *
 * 设计：
 *  · `locales` 缺省 = 通用，任何页面语言都试（四份既有规则不用改也不会变行为）；
 *  · 声明了 `locales` 就只在匹配的页面语言下参与；
 *  · 页面语言由调用方注入（kernel 不读 document.documentElement.lang）；
 *  · 比较只看主语言子标签：`fr-CA` 页命中 `fr` 规则。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const BASE = {
  schemaVersion: 2,
  finalSubmitControl: null,
  vendor: 'greenhouse',
  applyPath: { source: '\\/apply$' },
  anchors: ['form#application-form'],
  excludeWithin: [],
  denyLabels: [],
  denyNameSubstrings: [],
  widgetNames: [],
  keySteps: [
    {
      type: 'labelPatterns',
      confidence: 0.75,
      patterns: [
        { regex: { source: 'city', flags: 'i' }, key: 'city', locales: ['en'] },
        { regex: { source: 'ville', flags: 'i' }, key: 'city', locales: ['fr'] },
        { regex: { source: 'e-?mail', flags: 'i' }, key: 'email' },
      ],
    },
  ],
};

function mount(labelText: string): void {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="f">${labelText}</label><input id="f" name="f" type="text" />
    </form>`;
}

function parsed(input: unknown = structuredClone(BASE)) {
  const result = parseVendorRuleset(input);
  if (!result.ok) throw new Error(`ruleset rejected: ${result.code}`);
  return result.value;
}

function keyFor(labelText: string, locale?: string) {
  mount(labelText);
  const adapter = compileRuleAdapter(parsed());
  const root = adapter.resolveRoot(document);
  expect(root, '适配器没认出表单').not.toBeNull();
  const fields = adapter.scan(root!, locale === undefined ? undefined : { locale });
  return fields[0]?.key ?? null;
}

describe('labelPatterns 的 locale 分层', () => {
  it('schema 接受 pattern 上的 locales', () => {
    expect(parseVendorRuleset(structuredClone(BASE)).ok, 'schema 拒收了 locales 字段').toBe(true);
  });

  it('英文页只用英文 pattern', () => {
    expect(keyFor('City', 'en')).toBe('city');
    expect(keyFor('Ville', 'en'), '英文页命中了法语 pattern——分层没生效').toBeNull();
  });

  it('法语页只用法语 pattern', () => {
    expect(keyFor('Ville', 'fr')).toBe('city');
    expect(keyFor('City', 'fr'), '法语页命中了英文 pattern——分层没生效').toBeNull();
  });

  it('只比主语言子标签：fr-CA 页命中 fr 规则', () => {
    expect(keyFor('Ville', 'fr-CA')).toBe('city');
  });

  it('没声明 locales 的 pattern 是通用的，任何语言都试', () => {
    expect(keyFor('Email', 'en')).toBe('email');
    expect(keyFor('Email', 'fr')).toBe('email');
    expect(keyFor('Email', 'de')).toBe('email');
  });

  /**
   * 反向探针：不传 locale 时必须**逐字保持今天的行为**——所有 pattern 都试。
   * 四份既有规则一个字都没改，接上分层之后行为必须完全不变，否则这条能力
   * 就是在悄悄改四家的匹配结果。
   */
  it('反向探针：不传 locale 时所有 pattern 都参与，行为与今天一致', () => {
    expect(keyFor('City')).toBe('city');
    expect(keyFor('Ville')).toBe('city');
    expect(keyFor('Email')).toBe('email');
  });

  it('locales 必须是非空的小写主语言子标签数组', () => {
    // 规则可由后端热更新下发，坏数据必须整份拒收（返回 ok:false 的稳定码），
    // 绝不能"跳过这一条继续用"——那会让新旧版本对同一份规则产生两种填法。
    const rejected = (locales: unknown) => {
      const ruleset = structuredClone(BASE) as Record<string, any>;
      ruleset['keySteps'][0].patterns[0].locales = locales;
      return parseVendorRuleset(ruleset).ok;
    };
    expect(rejected([]), '空数组等于"任何语言都不匹配"，是手误不是意图').toBe(false);
    expect(rejected(['EN']), '大小写混排永远匹配不中，只能是手误').toBe(false);
    expect(rejected('en'), 'locales 必须是数组').toBe(false);
    expect(rejected(['en-US']), '带地区子标签的规则永远匹配不到主子标签比较').toBe(false);
    expect(rejected(['en', 'en']), '重复项是手误').toBe(false);
  });
});
