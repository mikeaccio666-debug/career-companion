import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import type { HoneypotGeometry } from '../src/dict/guards';
import type { ApplyProfileDraft } from '../src/profileDraft';

/**
 * 蜜罐第三道防线：几何层。
 *
 * 前两道是文案层（`HONEYPOT` 正则）与身份层（`HONEYPOT_IDENTITY` 命中
 * name/id/data-automation-id）。它们挡得住 Workday 的 `beecatcher` 这种**取了
 * 可疑名字**的陷阱，挡不住同形状但只改名字的变体——`isHoneypotGeometry` 早就
 * 实现了（1px / 裁剪窗口 / 零字号三条判据），`write/setFile.ts` 的可见性判定
 * 也接了，唯独 `engine.ts` 的调用点只传 text 与 identities。
 *
 * 为什么当时没接（engine.ts 自述）：happy-dom 对所有元素返回 0×0，而
 * `isHoneypotGeometry` 第一条就是 `width<=1||height<=1`，naive 接线会把测试里
 * **每一个字段**都判成蜜罐。所以先要环境标定。
 *
 * 本文件锁两件事：
 *   1. 真实布局环境里，纯 CSS 藏起来的陷阱必须被拦下（正向）；
 *   2. 整表所有控件都量到 0×0 时，几何层必须整体跳过（标定的反向探针）——
 *      否则这道防线会在无布局环境里把所有字段误杀，比不接还糟。
 *
 * 失败代价最不对称的一条：命中一个蜜罐 = 整份申请被静默判为 bot 丢弃，
 * 而界面还显示「已填」，用户永远不知道自己为什么没回音。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const NORMAL: HoneypotGeometry = { width: 240, height: 32, fontSize: 14 };

function plan(
  html: string,
  profile: ApplyProfileDraft,
  geometryById?: Readonly<Record<string, HoneypotGeometry>>,
) {
  document.body.innerHTML = `<form id="application-form">${html}</form>`;
  const root = greenhouseAdapter.resolveRoot(document);
  expect(root, '适配器没认出这个表单，后面全是空转').not.toBeNull();
  return buildApplyPlan(
    { vendor: 'greenhouse', root: root!, fields: [...greenhouseAdapter.scan(root!)] },
    profile,
    geometryById
      ? { readGeometry: (element: Element) => geometryById[element.id] ?? NORMAL }
      : {},
  );
}

const PROFILE: ApplyProfileDraft = {
  email: 'ada@example.test',
  firstName: 'Ada',
  phone: '+1 555 0100',
  portfolioUrl: 'https://ada.example.test',
};

const TWO_REAL_FIELDS = `<label for="email">Email</label><input id="email" type="email" />
   <label for="first_name">First Name</label><input id="first_name" type="text" />`;

function skippedReason(built: ReturnType<typeof plan>, label: string) {
  return built.skipped.find((item) => item.label.toLowerCase().includes(label))?.reason;
}

describe('蜜罐几何层', () => {
  it('裁剪成 1px 窗口的陷阱被拦下——文案与身份都干净', () => {
    // 关键：label 写的是「Portfolio」、id 也毫无嫌疑，前两道防线一条都不命中。
    // 藏它的手段纯粹是 CSS：clip: rect(1px, 1px, 1px, 1px)。
    const built = plan(
      `${TWO_REAL_FIELDS}
       <label for="portfolio">Portfolio</label><input id="portfolio" type="url" />`,
      PROFILE,
      { portfolio: { width: 240, height: 32, clip: 'rect(1px, 1px, 1px, 1px)', fontSize: 14 } },
    );

    expect(
      skippedReason(built, 'portfolio'),
      '纯 CSS 裁剪藏起来的陷阱没被拦下——填进去整份申请会被静默判为 bot',
    ).toBe('HONEYPOT');
    expect(built.entries.some((entry) => entry.key === 'portfolioUrl')).toBe(false);
  });

  it('1×1 的陷阱被拦下', () => {
    const built = plan(
      `${TWO_REAL_FIELDS}
       <label for="portfolio">Portfolio</label><input id="portfolio" type="url" />`,
      PROFILE,
      { portfolio: { width: 1, height: 1, fontSize: 14 } },
    );
    expect(skippedReason(built, 'portfolio')).toBe('HONEYPOT');
  });

  it('零字号的陷阱被拦下', () => {
    const built = plan(
      `${TWO_REAL_FIELDS}
       <label for="portfolio">Portfolio</label><input id="portfolio" type="url" />`,
      PROFILE,
      { portfolio: { width: 240, height: 32, fontSize: 0 } },
    );
    expect(skippedReason(built, 'portfolio')).toBe('HONEYPOT');
  });

  it('正常尺寸字段不受影响，照常进计划', () => {
    const built = plan(
      `${TWO_REAL_FIELDS}
       <label for="portfolio">Portfolio</label><input id="portfolio" type="url" />`,
      PROFILE,
      { portfolio: NORMAL },
    );
    expect(skippedReason(built, 'portfolio')).toBeUndefined();
    expect(built.entries.some((entry) => entry.key === 'portfolioUrl')).toBe(true);
  });

  /**
   * 标定的反向探针，也是这条能力当初没接的全部原因。
   *
   * 无布局环境（happy-dom、jsdom、以及任何 display:none 的祖先下）对每个元素都
   * 返回 0×0。若几何层不做标定就一律生效，整表所有字段都会被判成蜜罐——一个字段
   * 都填不了，而且理由是「陷阱」，比不接这道防线糟得多。
   *
   * 判据：**整表所有控件都退化**时跳过几何层。只要有一个字段量到了真实尺寸，
   * 就说明环境会布局，此时退化的那些就是真可疑。
   */
  it('整表每个控件都退化时，几何层整体跳过（安全网）', () => {
    const built = plan(
      `${TWO_REAL_FIELDS}
       <label for="portfolio">Portfolio</label><input id="portfolio" type="url" />`,
      PROFILE,
      {
        // 全退化 = 环境不布局，或整个表单在 display:none 的祖先下。
        email: { width: 0, height: 0 },
        first_name: { width: 0, height: 0 },
        portfolio: { width: 1, height: 1 },
      },
    );

    expect(
      built.skipped.filter((item) => item.reason === 'HONEYPOT'),
      '无布局环境把整表误杀成蜜罐——标定没生效',
    ).toEqual([]);
    expect(built.entries.length, '一个字段都没进计划').toBeGreaterThan(0);
  });

  /**
   * 反向探针：不注入 `readGeometry` 时这道防线必须**整体不存在**。
   *
   * kernel 是确定性纯解释器，不碰浏览器 API——它自己去读
   * getBoundingClientRect 既越界，也会在无布局环境里把整表误杀。
   * 这条同时保证既有 740+ 用例不会因为接上几何层而集体变红。
   */
  it('不注入 readGeometry 时，几何层整体不启用', () => {
    const built = plan(
      `${TWO_REAL_FIELDS}
       <label for="portfolio">Portfolio</label><input id="portfolio" type="url" />`,
      PROFILE,
    );
    expect(built.skipped.filter((item) => item.reason === 'HONEYPOT')).toEqual([]);
    expect(built.entries.length).toBeGreaterThan(0);
  });
});
