import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { workableAdapter } from '../src/sites/workable/applyForm';
import type { HoneypotGeometry } from '../src/dict/guards';
import type { ApplyProfileDraft } from '../src/profileDraft';

/**
 * Workable 的守卫覆盖（CAP-AF-057 后半句）。
 *
 * 四家适配器里 Workable 至今**零守卫用例**，而它恰恰是重复行增删改动最多的
 * 一家——每次动行编排都可能把字段身份算错，而守卫是最后一道拦网。
 * Greenhouse / Ashby 都有各自的守卫用例，这家没有，等于四道防线里最需要复核
 * 的那一家从没被证明过。
 *
 * 这里逐条证明四道守卫在 Workable 的真实 DOM 形状上都发言：
 * 蜜罐（文案层）、蜜罐（几何层）、他人字段、岗位相关题。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const NORMAL: HoneypotGeometry = { width: 240, height: 32, fontSize: 14 };

/** Workable 的真实外壳：适配器要求 data-ui="application-form" 锚点。 */
function mount(extra: string): void {
  document.body.innerHTML = `
    <div data-ui="careers-page-content">
      <main role="main">
        <form class="styles--2I-rr" data-ui="application-form">
          <label for="firstname">First name*</label>
          <input id="firstname" name="firstname" data-ui="firstname" type="text" required />
          <label for="email">Email*</label>
          <input id="email" name="email" data-ui="email" type="email" required />
          ${extra}
        </form>
      </main>
    </div>`;
}

const PROFILE: ApplyProfileDraft = {
  firstName: 'Ada',
  email: 'ada@example.test',
  portfolioUrl: 'https://ada.example.test',
};

function plan(geometryById?: Readonly<Record<string, HoneypotGeometry>>) {
  const root = workableAdapter.resolveRoot(document);
  expect(root, '适配器没认出 Workable 表单，后面全是空转').not.toBeNull();
  return buildApplyPlan(
    { vendor: 'workable', root: root!, fields: [...workableAdapter.scan(root!)] },
    PROFILE,
    geometryById
      ? { readGeometry: (element: Element) => geometryById[element.id] ?? NORMAL }
      : {},
  );
}

const reasonFor = (built: ReturnType<typeof plan>, needle: string) =>
  built.skipped.find((item) => item.label.toLowerCase().includes(needle))?.reason;

describe('Workable 上的四道守卫', () => {
  it('蜜罐（文案层）被拦下', () => {
    mount(`<label for="hp">Please leave this field blank</label>
           <input id="hp" name="website" data-ui="website" type="text" />`);
    expect(reasonFor(plan(), 'leave this field blank')).toBe('HONEYPOT');
  });

  it('蜜罐（几何层）被拦下——文案与身份都干净', () => {
    mount(`<label for="portfolio">Portfolio</label>
           <input id="portfolio" name="portfolio" data-ui="portfolio" type="url" />`);
    const built = plan({ portfolio: { width: 1, height: 1, fontSize: 14 } });
    expect(
      reasonFor(built, 'portfolio'),
      'Workable 上纯 CSS 藏起来的陷阱没被拦下',
    ).toBe('HONEYPOT');
  });

  it('推荐人字段被拦下，不会被写成申请人本人', () => {
    mount(`<label for="ref">Reference email</label>
           <input id="ref" name="reference_email" data-ui="reference_email" type="email" />`);
    expect(reasonFor(plan(), 'reference')).toBe('OTHER_PERSON');
  });

  it('岗位相关题被拦下，且不与"我们没认出来"混为一谈', () => {
    // Workable 的自定义题用 QA_ 前缀的随机 name，标签是唯一信号。
    mount(`<label for="QA_1">Do you require visa sponsorship?</label>
           <input id="QA_1" name="QA_1" data-ui="QA_1" type="text" />`);
    const reason = reasonFor(plan(), 'sponsorship');
    expect(reason, 'JOB_DEPENDENT 被 LOW_CONFIDENCE 吃掉了——两者对用户的含义相反').toBe(
      'JOB_DEPENDENT',
    );
  });

  /**
   * 反向探针：四道守卫不能误扩成"什么都拦"。
   *
   * 判据用「跳过原因不是守卫码」而不是「一定进计划」——Workable 的
   * 「Portfolio」标签今天推不出 portfolioUrl（LOW_CONFIDENCE，属 CAP-AF-046
   * 标签推断级联的缺口，与守卫无关）。断言成"必须进计划"会把那条独立缺口
   * 绑进这个文件，将来 046 一动这里就无故变红。
   */
  it('反向探针：正常字段不会被任何一道守卫拦下', () => {
    mount(`<label for="portfolio">Portfolio</label>
           <input id="portfolio" name="portfolio" data-ui="portfolio" type="url" />`);
    const built = plan({ portfolio: NORMAL });

    expect(built.entries.some((entry) => entry.key === 'email'), '正常字段被守卫误伤').toBe(true);
    const guardCodes = ['HONEYPOT', 'OTHER_PERSON', 'JOB_DEPENDENT', 'MANUAL_ONLY'];
    expect(
      reasonFor(built, 'portfolio') === undefined ||
        !guardCodes.includes(reasonFor(built, 'portfolio')!),
      '正常的 portfolio 字段被某道守卫拦下了——守卫误扩',
    ).toBe(true);
    expect(reasonFor(built, 'portfolio')).toBe('LOW_CONFIDENCE');
  });
});
