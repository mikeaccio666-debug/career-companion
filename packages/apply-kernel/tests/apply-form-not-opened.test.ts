/**
 * 「申请表还没打开」要和「规则失效」分开说。
 *
 * 2026-09-22 真实批测：BambooHR 八页全部停在浮层这句话上——
 *
 *   规则的表单锚点在这一页上没找到。刷新后重试；仍然如此就是这一家的规则要更新了。
 *
 * 那句话是错的。规则没问题：`/careers/<id>` 上本来就没有表单，页面上只有一个
 * `button[data-bi-id="careers-site-apply-button"]`（「Apply for This Job」），
 * 点完 `form#job-application-form` 才出现、网址不变。用户读到的却是「我们坏了，
 * 等下个版本」，于是整整一家 ATS 在他手里是死的。
 *
 * 2026-09-22 Mike 拍板：打开申请表由本人点，声明 `applyGate` 只把那句话换成「先点页面上的申请按钮」。
 * 2026-10-04 负责人改了（D8）：「自动填写」可以先替他点开申请表——那一下只把表单展开，不提交任何东西。
 * 内核只交出规则声明的那一颗（`applyGateControl`），按不按、什么时候按由扩展按翻页那一位决定。
 */

import { afterEach, describe, expect, it } from 'vitest';

import bamboohr from '../../apply-rules/rules/bamboohr.json';
import greenhouse from '../../apply-rules/rules/greenhouse.json';
import { compileBundledAdapter } from '../src/rules/interpreter';
import { parseVendorRuleset } from '../src/rules/schema';

type Ruleset = Parameters<typeof compileBundledAdapter>[0];

const APPLY_BUTTON = '<button data-bi-id="careers-site-apply-button" type="button">Apply for This Job</button>';

afterEach(() => { document.body.innerHTML = ''; });

describe('BambooHR：岗位页上只有一个申请按钮', () => {
  const adapter = () => compileBundledAdapter(bamboohr as unknown as Ruleset);

  it('只有按钮、没有表单 → 是「还没打开」', () => {
    document.body.innerHTML = `<main><h1>Registered Nurse</h1>${APPLY_BUTTON}</main>`;
    expect(adapter().hasUnopenedApplyForm(document)).toBe(true);
    expect(adapter().resolveRoot(document)).toBeNull();
  });

  // 点开之后按钮仍留在页面上（实测如此）。只看按钮在不在会把已经打开的表单
  // 也报成「还没打开」，所以必须先排除锚点。
  it('表单已经打开、按钮还在 → 不是「还没打开」', () => {
    document.body.innerHTML = `<main>${APPLY_BUTTON}
      <form id="job-application-form"><input name="firstName"></form></main>`;
    expect(adapter().hasUnopenedApplyForm(document)).toBe(false);
  });

  it('两样都没有 → 不是「还没打开」，那是别的原因', () => {
    document.body.innerHTML = '<main><h1>Careers</h1></main>';
    expect(adapter().hasUnopenedApplyForm(document)).toBe(false);
  });
});

describe('没有声明 applyGate 的厂商，行为一个字都不变', () => {
  it('Greenhouse 永远答否', () => {
    document.body.innerHTML = `<main>${APPLY_BUTTON}</main>`;
    expect(compileBundledAdapter(greenhouse as unknown as Ruleset).hasUnopenedApplyForm(document)).toBe(false);
  });
});

describe('applyGate 的解析', () => {
  const withGate = (gate: unknown) => parseVendorRuleset({ ...(bamboohr as object), applyGate: gate });

  it('缺席与 null 同义：老规则不用改一个字', () => {
    const { applyGate: _omitted, ...withoutGate } = bamboohr as Record<string, unknown>;
    expect(parseVendorRuleset(withoutGate)).toMatchObject({ ok: true });
    expect(withGate(null)).toMatchObject({ ok: true });
  });

  it('选择器必须是非空字符串；多一个键就整份拒收', () => {
    expect(withGate({ selector: '' })).toMatchObject({ ok: false, code: 'RULES_MALFORMED' });
    expect(withGate({ selector: 42 })).toMatchObject({ ok: false, code: 'RULES_MALFORMED' });
    expect(withGate({ selector: 'button', activation: 'click' }))
      .toMatchObject({ ok: false, code: 'RULES_MALFORMED' });
  });

  // 选择器来自规则；写坏了是规则坏了，不是「可以猜一下」。
  it('选择器语法非法：查不动就答否，不抛', () => {
    document.body.innerHTML = `<main>${APPLY_BUTTON}</main>`;
    const broken = parseVendorRuleset({ ...(bamboohr as object), applyGate: { selector: 'button[[' } });
    expect(broken).toMatchObject({ ok: true });
    if (!broken.ok) throw new Error(broken.code);
    expect(compileBundledAdapter(broken.value as unknown as Ruleset).hasUnopenedApplyForm(document)).toBe(false);
  });
});

/**
 * D8（2026-10-04 负责人）：「自动填写」可以先替他点开 BambooHR 的「Apply for This Job」——它只把申请表展开（网址不变），
 * 不提交任何东西。内核只交出规则声明的那一颗；是不是任何一张表的提交控件、停用、不止一颗，一律不交。
 */
describe('申请表还没打开：交出规则声明的那一颗「打开申请表」', () => {
  const adapter = () => compileBundledAdapter(bamboohr as unknown as Ruleset);

  it('只有按钮、没有表单 → 交出那一颗按钮', () => {
    document.body.innerHTML = `<main><h1>Registered Nurse</h1>${APPLY_BUTTON}</main>`;
    expect(adapter().applyGateControl?.(document)).toBe(document.querySelector('button[data-bi-id]'));
  });

  it('表单已经打开、按钮还在 → 不交（不再按一次）', () => {
    document.body.innerHTML = `<main>${APPLY_BUTTON}<form id="job-application-form"><input name="firstName"></form></main>`;
    expect(adapter().applyGateControl?.(document)).toBeNull();
  });

  it('那一颗是某张表的提交按钮（按下去会提交那张表）→ 不交', () => {
    document.body.innerHTML = '<main><form id="other"><button data-bi-id="careers-site-apply-button">Apply for This Job</button></form></main>';
    expect(adapter().applyGateControl?.(document)).toBeNull();
    document.body.innerHTML = '<main><form id="other"><input type="submit" data-bi-id="careers-site-apply-button" value="Apply"></form></main>';
    expect(adapter().applyGateControl?.(document)).toBeNull();
  });

  it('停用、不止一颗 → 不交', () => {
    document.body.innerHTML = '<main><button data-bi-id="careers-site-apply-button" type="button" disabled>Apply for This Job</button></main>';
    expect(adapter().applyGateControl?.(document)).toBeNull();
    document.body.innerHTML = '<main><button data-bi-id="careers-site-apply-button" type="button" aria-disabled="true">Apply</button></main>';
    expect(adapter().applyGateControl?.(document)).toBeNull();
    document.body.innerHTML = `<main>${APPLY_BUTTON}${APPLY_BUTTON}</main>`;
    expect(adapter().applyGateControl?.(document)).toBeNull();
  });

  it('没声明 applyGate 的厂商：永远不交', () => {
    document.body.innerHTML = `<main>${APPLY_BUTTON}</main>`;
    expect(compileBundledAdapter(greenhouse as unknown as Ruleset).applyGateControl?.(document) ?? null).toBeNull();
  });
});
