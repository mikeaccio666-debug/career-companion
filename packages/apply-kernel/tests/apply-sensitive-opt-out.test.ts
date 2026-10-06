import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan, summarizePlan } from '../src/engine';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import type { ApplyFieldKey } from '../src/contracts';
import type { ApplyProfileDraft } from '../src/profileDraft';

/**
 * 用户主动关掉的那一类，必须与"档案里本来就没有"分开报。
 *
 * `deriveProfile` 会把 `suppressedKeys` 从解析结果里删干净（那是删除承诺的最后
 * 一环，见 apply-derive-suppressed.test.ts）。删干净之后，计划构造走到
 * `if (!value)` 就把它报成了 `NO_VALUE` —— 与"我们该去补的"完全同码。
 *
 * 后果不是措辞问题，是两个真实的坏结果：
 *   · 它进了必填分母，opt-out 用户永远到不了 100%，把自己的失败率拉花；
 *   · required 时还会催用户去页面上处理他**自己刚关掉**的那一项。
 *
 * 分母是我们唯一诚实的对外数字（填充率基准的分母同源），污染它等于自毁招牌。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const suppress = (...keys: ApplyFieldKey[]): ReadonlySet<ApplyFieldKey> => new Set(keys);

function plan(
  html: string,
  profile: ApplyProfileDraft,
  suppressedKeys?: ReadonlySet<ApplyFieldKey>,
) {
  document.body.innerHTML = `<form id="application-form">${html}</form>`;
  const root = greenhouseAdapter.resolveRoot(document);
  expect(root, '适配器没认出这个表单，后面全是空转').not.toBeNull();
  return buildApplyPlan(
    { vendor: 'greenhouse', root: root!, fields: [...greenhouseAdapter.scan(root!)] },
    profile,
    suppressedKeys ? { suppressedKeys } : {},
  );
}

const EMAIL_AND_PHONE = `<label for="email">Email</label><input id="email" type="email" required />
   <label for="phone">Phone</label><input id="phone" type="tel" required />`;

describe('SENSITIVE_OPT_OUT：用户关掉的一类不是缺资料', () => {
  it('抑制键报 SENSITIVE_OPT_OUT，不报 NO_VALUE', () => {
    const built = plan(
      EMAIL_AND_PHONE,
      { email: 'ada@example.test', phone: '+1 555 0100' },
      suppress('phone'),
    );

    const phone = built.skipped.find((item) => item.label.toLowerCase().includes('phone'));
    expect(phone, 'phone 被抑制后应当出现在 skipped 里').toBeDefined();
    expect(
      phone!.reason,
      '用户主动关掉的一类仍被报成 NO_VALUE —— 与"我们该去补的"无法区分',
    ).toBe('SENSITIVE_OPT_OUT');
  });

  it('抑制的必填项不进分母', () => {
    const summary = summarizePlan(
      plan(
        EMAIL_AND_PHONE,
        { email: 'ada@example.test', phone: '+1 555 0100' },
        suppress('phone'),
      ),
    );

    expect(
      summary.requiredTotal,
      '用户关掉的一项把分母顶高了，opt-out 用户永远到不了 100%',
    ).toBe(1);
    expect(summary.requiredHandled).toBe(1);
  });

  it('抑制项不算"去补资料"的待办', () => {
    const summary = summarizePlan(
      plan(
        EMAIL_AND_PHONE,
        { email: 'ada@example.test', phone: '+1 555 0100' },
        suppress('phone'),
      ),
    );

    expect(
      summary.missingProfile,
      '把用户主动关掉的一项算成"去补资料"，引导文案会催他填自己刚关掉的东西',
    ).toBe(0);
    expect(
      summary.needsReview,
      '它不是我们的能力不足，并进 needsReview 会让人以为插件坏了',
    ).toBe(0);
    expect(summary.optedOut, '静默跳过不等于凭空消失——面板仍要能说清这一项去哪了').toBe(1);
  });

  /**
   * 反向探针：不能为了让 opt-out 干净就把所有缺值一刀切。
   * 真的"档案里没有"必须继续报 NO_VALUE、继续进分母、继续算用户待办 ——
   * 那条路径是这个功能的主收益，切没了比不做还糟。
   */
  it('没被抑制的真缺失仍报 NO_VALUE 并进分母', () => {
    const built = plan(EMAIL_AND_PHONE, { email: 'ada@example.test' }, suppress('city'));
    const summary = summarizePlan(built);

    const phone = built.skipped.find((item) => item.label.toLowerCase().includes('phone'));
    expect(phone!.reason, '真缺失被误报成 opt-out，用户永远不知道要去补').toBe('NO_VALUE');
    expect(summary.requiredTotal, '真缺失必须留在分母里').toBe(2);
    expect(summary.requiredHandled).toBe(1);
    expect(summary.missingProfile).toBe(1);
    expect(summary.optedOut).toBe(0);
  });
});
