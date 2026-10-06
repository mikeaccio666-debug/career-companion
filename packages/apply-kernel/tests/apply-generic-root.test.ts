/**
 * 认不出厂商的那张表：判据只能是「这里面有多少字段是我们认得的」。
 *
 * 2026-09-22 盘点自建域（58 个 Greenhouse board 的样本）：26 个岗位挂在公司自己的
 * 域名上，其中 11 个是官方 embed（现在就认得）、13 个落地页上压根没有表单、
 * 2 个是客户自己写的前端——最后那一类我们认得出厂商，却没有任何规则能解析那张表。
 *
 * 而识别力本来就大半与站点无关：十一份规则的 labelPatterns 去重后只有 38 条，
 * 15 条被 8 家以上共用；97 页真实语料里已填的 1545 个字段实例，只靠标签文案能认出
 * 75%。这些规则今天被锁在「先认出厂商、再命中锚点」之后。
 *
 * 自建域上那两件都不成立：没有厂商的路径形态，也没有厂商的 id 钩子。所以通用路的
 * 判据只剩一件事——**这一张表里有足够多我们认得的字段**。`whitelabelRoot` 已经是
 * 「容器 + 最少命中数」这个形状，但它数的是本家的 id 钩子；`genericRoot` 数的是
 * 扫出来带键的字段。
 *
 * 纪律与白标一条不差：**恰好一个**容器达标才算，两个都像就不猜；达不到门槛照旧
 * NO_ROOT——那是「看起来像个表单」，不是「一张我们读得懂的申请表」。
 */

import { afterEach, describe, expect, it } from 'vitest';

import greenhouse from '../../apply-rules/rules/greenhouse.json';
import { compileBundledAdapter } from '../src/rules/interpreter';
import { parseVendorRuleset } from '../src/rules/schema';

type Ruleset = Parameters<typeof compileBundledAdapter>[0];

/**
 * 客户自己写的前端：没有本家锚点、没有本家 id，只有干净的标签。
 *
 * 标签刻意选的是**今天的规则已经认得出**的那几个。这一刀测的是机制——「按认得出
 * 几个字段找那张表」——不是标签库有多全。实测过一轮：纯标签下 Greenhouse 连
 * `First name` / `Last name` / `Phone` 都认不出（它们全靠 `attrMap` 的 name 钩子），
 * 补那几条是紧跟着的另一刀，有它自己的语料与红绿。
 */
const CUSTOM_FORM = `
  <form class="careers-apply">
    <label for="f1">Legal First Name</label><input id="f1" type="text">
    <label for="f2">LinkedIn Profile</label><input id="f2" type="text">
    <label for="f3">GitHub</label><input id="f3" type="text">
    <label for="f4">Location (City)</label><input id="f4" type="text">
    <label for="f5">Pronouns</label><input id="f5" type="text">
  </form>`;

/** 页脚那种订阅框：有 form、有一栏我们认得的，但它不是一张申请表。 */
const NEWSLETTER = `
  <form class="footer-signup">
    <label for="n1">Website</label><input id="n1" type="text">
  </form>`;

const withGeneric = (minKeyedFields: number, container = 'form') =>
  compileBundledAdapter({
    ...(greenhouse as object),
    genericRoot: { container, minKeyedFields },
  } as unknown as Ruleset);

const plain = () => compileBundledAdapter(greenhouse as unknown as Ruleset);

afterEach(() => { document.body.innerHTML = ''; });

describe('认不出厂商时，按「认得出几个字段」找那张表', () => {
  it('客户自建的表：达到门槛就认出来', () => {
    document.body.innerHTML = CUSTOM_FORM;
    const adapter = withGeneric(4);
    const root = adapter.resolveRoot(document, { generic: true } as never);
    expect(root).not.toBeNull();
    const keyed = [...adapter.scan(root!)].filter((field) => field.key !== null);
    expect(keyed.length).toBeGreaterThanOrEqual(4);
  });

  it('路径闸：声明了 genericRoot 才放行，且只在调用方声明 generic 时', () => {
    expect(withGeneric(4).isApplyPath('/careers/apply', { generic: true } as never)).toBe(true);
    expect(plain().isApplyPath('/careers/apply', { generic: true } as never)).toBe(false);
    // 没声明 generic 的调用方照旧只看本家的路径正则。
    expect(withGeneric(4).isApplyPath('/careers/apply')).toBe(false);
  });
});

describe('放宽到此为止', () => {
  it('调用方没声明 generic：本家锚点不在就照旧认不出', () => {
    document.body.innerHTML = CUSTOM_FORM;
    expect(withGeneric(4).resolveRoot(document)).toBeNull();
  });

  it('订阅框达不到门槛：不认', () => {
    document.body.innerHTML = NEWSLETTER;
    expect(withGeneric(4).resolveRoot(document, { generic: true } as never)).toBeNull();
  });

  // 两张表都像申请表时不猜——与白标那条纪律一字不差。
  it('两个容器同时达标：不猜', () => {
    document.body.innerHTML = `${CUSTOM_FORM}${CUSTOM_FORM}`;
    expect(withGeneric(4).resolveRoot(document, { generic: true } as never)).toBeNull();
  });

  it('一张达标、一张不达标：认那张达标的', () => {
    document.body.innerHTML = `${NEWSLETTER}${CUSTOM_FORM}`;
    const root = withGeneric(4).resolveRoot(document, { generic: true } as never);
    expect(root).not.toBeNull();
    expect((root as unknown as { container?: Element })).toBeTruthy();
  });

  // 本家锚点在场时走本家那条路，通用路不许抢。
  it('本家锚点在场：仍然用锚点', () => {
    document.body.innerHTML = `<form id="application-form">
      <label for="g1">Legal First Name</label><input id="g1" type="text">
    </form>${CUSTOM_FORM}`;
    const root = withGeneric(4).resolveRoot(document, { generic: true } as never);
    expect(root).not.toBeNull();
    expect(document.querySelector('#application-form')!.contains(document.querySelector('#g1'))).toBe(true);
  });

  it('没有声明 genericRoot 的规则：generic 也认不出', () => {
    document.body.innerHTML = CUSTOM_FORM;
    expect(plain().resolveRoot(document, { generic: true } as never)).toBeNull();
  });
});

/**
 * 通用规则集根本没有厂商，所以「本家锚点」对它是个空概念——可 schema 逼 anchors 非空，
 * 而 `resolveRoot` 先试 anchors：随便填一个能命中的锚点，就会**绕过**「数字段」那道闸，
 * 整条通用路的唯一判据被架空。所以放宽只放这一处：**声明了 genericRoot 才允许空锚点**。
 */
describe('没有厂商就没有锚点', () => {
  const anchorless = (rest: Record<string, unknown>) => {
    const { anchors: _dropped, ...without } = greenhouse as Record<string, unknown>;
    return parseVendorRuleset({ ...without, anchors: [], ...rest });
  };

  it('空锚点 + 声明了 genericRoot：收', () => {
    expect(
      anchorless({ genericRoot: { container: 'form', minKeyedFields: 4 } }),
      '通用规则集没有锚点可写，却被 schema 逼着写一个——写什么都会架空数字段那道闸',
    ).toMatchObject({ ok: true });
  });

  it('反向探针：空锚点 + 没有 genericRoot：照旧拒', () => {
    expect(anchorless({})).toMatchObject({ ok: false, code: 'RULES_MALFORMED' });
    expect(anchorless({ genericRoot: null })).toMatchObject({ ok: false, code: 'RULES_MALFORMED' });
  });

  it('空锚点的规则走通用路：数字段那道闸照常是唯一判据', () => {
    document.body.innerHTML = CUSTOM_FORM;
    const { anchors: _dropped, ...without } = greenhouse as Record<string, unknown>;
    const adapter = compileBundledAdapter({
      ...without,
      anchors: [],
      genericRoot: { container: 'form', minKeyedFields: 4 },
    } as unknown as Ruleset);

    expect(adapter.resolveRoot(document, { generic: true } as never)).not.toBeNull();
    // 没声明 generic 的调用方：没有锚点可试，什么都认不出。
    expect(adapter.resolveRoot(document)).toBeNull();
    // 门槛照旧管用：订阅框不认。
    document.body.innerHTML = NEWSLETTER;
    expect(adapter.resolveRoot(document, { generic: true } as never)).toBeNull();
  });
});

describe('genericRoot 的解析', () => {
  const parse = (value: unknown) => parseVendorRuleset({ ...(greenhouse as object), genericRoot: value });

  it('缺席与 null 同义：现有十一份规则一个字都不用改', () => {
    const { genericRoot: _omitted, ...without } = greenhouse as Record<string, unknown>;
    expect(parseVendorRuleset(without)).toMatchObject({ ok: true });
    expect(parse(null)).toMatchObject({ ok: true });
  });

  it('容器要非空字符串、门槛要正整数；多一个键就整份拒收', () => {
    expect(parse({ container: '', minKeyedFields: 4 })).toMatchObject({ ok: false, code: 'RULES_MALFORMED' });
    expect(parse({ container: 'form', minKeyedFields: 0 })).toMatchObject({ ok: false, code: 'RULES_MALFORMED' });
    expect(parse({ container: 'form', minKeyedFields: 1.5 })).toMatchObject({ ok: false, code: 'RULES_MALFORMED' });
    expect(parse({ container: 'form' })).toMatchObject({ ok: false, code: 'RULES_MALFORMED' });
    expect(parse({ container: 'form', minKeyedFields: 4, extra: 1 }))
      .toMatchObject({ ok: false, code: 'RULES_MALFORMED' });
  });

  // 选择器来自规则；写坏了是规则坏了，不是「可以猜一下」。
  it('容器选择器语法非法：认不出，不抛', () => {
    document.body.innerHTML = CUSTOM_FORM;
    expect(parse({ container: 'form[[', minKeyedFields: 4 })).toMatchObject({ ok: true });
    const adapter = compileBundledAdapter({
      ...(greenhouse as object),
      genericRoot: { container: 'form[[', minKeyedFields: 4 },
    } as unknown as Ruleset);
    expect(adapter.resolveRoot(document, { generic: true } as never)).toBeNull();
  });
});
