import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import generic from '@edaix/apply-rules/generic.json';
import releaseManifest from '@edaix/apply-rules/release-manifest.json';
import { ADAPTERS } from '../src/bundledAdapters';
import { compileBundledAdapter } from '../src/rules/interpreter';
import { createBundledApplyPolicy } from '../src/policy';
import { parseVendorRuleset } from '../src/rules/schema';

/**
 * 不绑任何厂商的那份规则（argoland #584 的 GENERIC / generic）。
 *
 * 2026-09-22 盘点自建域：58 个 Greenhouse board 的样本里 26 个岗位挂在公司自己的
 * 域名上，其中 11 个是官方 embed（现在就认得）、13 个落地页上压根没有表单、
 * 2 个是客户自己写的前端。最后那一类我们认得出厂商，却没有任何规则能解析那张表。
 *
 * 而识别力本来就大半与站点无关：十一份规则的 labelPatterns 去重后只有 45 条，
 * 22 条被 8 家以上共用。这些规则今天被锁在「先认出厂商、再命中锚点」之后，于是在
 * 自建域上一条都跑不起来。`generic.json` 把那部分解锁出来：一条站点知识都不带，
 * 认字段靠标准 HTML 的 autocomplete 词表与可见标签，找表靠 `genericRoot` 数字段。
 *
 * ## 放行不在本仓，在后端那一侧
 *
 * 2026-09-22 起这条路在插件里接上了（`pageVendor` 的第三层）。但随包适配器仍是
 * `null`、内置 policy 仍关着：本地没有第二条入口，能不能用**只由后端的包说了算**
 * ——包里要有 GENERIC 的精确映射、包里的 policy 厂商位要开，两道缺一道适配器就装
 * 不上，这一页就照旧「认不出申请表」。RULE-GLOBAL-HIGH-RISK-FAIL-CLOSED 要的正是
 * 这个方向：取数失败、清单外，一律保持关闭。
 */

type Ruleset = Parameters<typeof compileBundledAdapter>[0];

/** 客户自己写的申请表：没有任何厂商钩子，只有标准 autocomplete 与可见标签。 */
const SELF_BUILT_FORM = `
  <form class="careers-apply">
    <label for="a">First name</label><input id="a" autocomplete="given-name">
    <label for="b">Last name</label><input id="b" autocomplete="family-name">
    <label for="c">Email</label><input id="c" autocomplete="email">
    <label for="d">Phone</label><input id="d" autocomplete="tel">
    <label for="e">LinkedIn</label><input id="e" type="text">
    <label for="f">Where did you hear about us?</label><input id="f" type="text">
  </form>`;

/** 只有标签、连 autocomplete 都没写的那种——自建域上最常见的形态。 */
const LABELS_ONLY_FORM = `
  <form class="apply">
    <label for="g">First name</label><input id="g" type="text">
    <label for="h">Last name</label><input id="h" type="text">
    <label for="i">Email</label><input id="i" type="text">
    <label for="j">Phone</label><input id="j" type="text">
  </form>`;

/** 页脚订阅框：有 form、有一栏认得的，但它不是一张申请表。 */
const NEWSLETTER = `
  <form class="signup"><label for="k">Email</label><input id="k" type="text"></form>`;

const adapter = () => compileBundledAdapter(generic as unknown as Ruleset);

afterEach(() => { document.body.innerHTML = ''; });

describe('通用规则集：认不出厂商时也读得懂那张表', () => {
  it('自建表单（autocomplete + 标签）：找得到表，认得出字段', () => {
    document.body.innerHTML = SELF_BUILT_FORM;
    const root = adapter().resolveRoot(document, { generic: true } as never);
    expect(root, '自建域上最典型的那张表都找不到，这份规则就没有意义').not.toBeNull();

    const keys = [...adapter().scan(root!)].flatMap((field) => (field.key === null ? [] : [field.key]));
    expect(new Set(keys)).toEqual(
      new Set(['firstName', 'lastName', 'email', 'phone', 'linkedinUrl', 'heardAboutSource']),
    );
  });

  it('只有标签、一个 autocomplete 都没写：照样认得出地板那四个', () => {
    document.body.innerHTML = LABELS_ONLY_FORM;
    const root = adapter().resolveRoot(document, { generic: true } as never);
    expect(root).not.toBeNull();
    const keys = [...adapter().scan(root!)].flatMap((field) => (field.key === null ? [] : [field.key]));
    expect(
      new Set(keys),
      '自建域上钩子往往一个都没有，姓名/邮箱/电话就是这张表的地板',
    ).toEqual(new Set(['firstName', 'lastName', 'email', 'phone']));
  });

  it('订阅框达不到门槛：不认', () => {
    document.body.innerHTML = NEWSLETTER;
    expect(adapter().resolveRoot(document, { generic: true } as never)).toBeNull();
  });

  it('两张表都达标：不猜（与白标那条纪律一字不差）', () => {
    document.body.innerHTML = `${SELF_BUILT_FORM}${LABELS_ONLY_FORM}`;
    expect(adapter().resolveRoot(document, { generic: true } as never)).toBeNull();
  });

  it('一张达标一张不达标：认那张达标的', () => {
    document.body.innerHTML = `${NEWSLETTER}${LABELS_ONLY_FORM}`;
    expect(adapter().resolveRoot(document, { generic: true } as never)).not.toBeNull();
  });

  it('调用方没声明 generic：什么都认不出——这份规则没有锚点，也没有能命中的路径', () => {
    document.body.innerHTML = SELF_BUILT_FORM;
    expect(adapter().resolveRoot(document)).toBeNull();
    expect(adapter().isApplyPath('/careers/apply')).toBe(false);
    expect(adapter().isApplyPath('/anything/at/all')).toBe(false);
  });

  it('门槛 4 是量出来的：低于它的表一律不认', () => {
    const parsed = parseVendorRuleset(generic);
    expect(parsed).toMatchObject({ ok: true });
    expect(
      (parsed as { value: { genericRoot: { minKeyedFields: number } } }).value.genericRoot.minKeyedFields,
      '门槛改了就必须重新量 170 张真实申请页的分布（见 generic.json 的注释）',
    ).toBe(4);
  });
});

describe('发布里有这一份，不等于这条路已经放行', () => {
  it('随包适配器是 null：本地没有第二条入口', () => {
    expect(
      ADAPTERS.generic,
      '随包一份 generic 适配器等于给它一条不经后端准入清单的本地入口',
    ).toBeNull();
  });

  it('内置 policy 关着：远程 policy 后端存在之前，这里的 false 是永久关闭', () => {
    expect(createBundledApplyPolicy().vendors.generic).toBe(false);
  });

  it('规则随发布下发，映射也在：缺的只是「谁来声明 generic」', () => {
    expect(releaseManifest.rulesets.some((entry) => entry.vendor === 'generic')).toBe(true);
    expect(releaseManifest.mappings.some((entry) => entry.atsProvider === 'GENERIC')).toBe(true);
  });

  /**
   * 笨闸，故意的：打开那个开关的地方**恰好这几处**（放行面四处 + ATS lab 一处），多一处都要当场被看见。
   *
   * 2026-09-22 接上通用路时这条闸如期红了——它原本钉的是「一处都没有」。改成钉住
   * 放行面本身，而不是拆掉它：这条路的总开关分散在三层（判这一页归谁、传进扫描闸、
   * 声明代码执行得了），任何第五处都意味着有人在别的地方又开了一个口子。
   *
   *  · `autofillDockDecision.ts`  —— `pageVendor` 的第三层，判这一页走不走通用路；
   *  · `apply.content.ts`         —— 内容脚本把那个判断传进扫描闸（与上面同一条次序）；
   *  · `kernelScanner.ts`         —— 扫描闸把它穿给解释器的 `resolveRoot`；
   *  · `executionRuntimeAuthority.ts` —— 代码兼容天花板：这份代码执行得了。
   *
   * 第五处（2026-09-28）是 ATS lab 的内容脚本 `entrypoints-lab/lab.content.ts`：开通用路之前要在
   * 真实的自建域申请页上量一遍（准入清单要那一行证据），lab 照生产的次序（主机表 → 指纹 → 通用）
   * 走同一个 `readRuntimeApplyFormResult`。它只在 `VIBE_DIST=ats-lab` 的构建里存在（`wxt.config.ts`
   * 只在那时用 entrypoints-lab），商店包与任何发出去的包都不带它。
   *
   * 准入**不在**这几处。包里要有 GENERIC 的精确映射、包里的 policy 厂商位要开，
   * 两道缺一道适配器就装不上，这一层问到的就是「没有」。
   */
  it('打开那个开关的地方恰好是放行面的四处，外加只在 lab 构建里的那一处', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const hits: string[] = [];
    const skip = new Set(['node_modules', '.git', 'dist', 'output', '.output', '.output-store', '.output-local', '.output-connected-dev', '.wxt', 'e2e', '.claude']);
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (skip.has(name)) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx|mjs|js)$/.test(name)) continue;
        // 测试自己当然要声明它——被测的正是那条分支。
        if (/\.test\.(ts|tsx)$/.test(name) || full.includes(`${'tests'}/`)) continue;
        if (readFileSync(full, 'utf8').includes(`generic:${' '}true`)) hits.push(full.slice(root.length + 1));
      }
    };
    walk(join(root, 'packages'));
    walk(join(root, 'apps'));
    expect(
      [...hits].sort(),
      '放行面变了——多出来的那一处是在别处又开了一个口子，请当场说清楚它为什么该在',
    ).toEqual([
      'apps/extension/entrypoints-lab/lab.content.ts',
      'apps/extension/entrypoints/apply.content.ts',
      'apps/extension/lib/autofillDockDecision.ts',
      'apps/extension/lib/executionRuntimeAuthority.ts',
      'apps/extension/lib/kernelScanner.ts',
    ]);
  });
});
