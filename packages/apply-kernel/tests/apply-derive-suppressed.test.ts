import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { deriveProfile } from '../src/profileDraft';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import type { ApplyFieldKey } from '../src/contracts';

/**
 * 抑制键**绝不能被推导补回来**。
 *
 * 这是签署授权里"删除后不得由简历重新推导重建"的最后一环，也是最容易漏的一环：
 * 服务端硬删了值、登记了长期指令、简历接口也把被抑制的键从建议里剔除了 ——
 * 然后 `deriveProfile` 在计划构造时把它算了回来。
 *
 * 落点比"值回到档案里"更不可逆：它直接进了雇主的申请表。
 *
 * 三条推导路径都要堵：
 *   · `city` ← `location`（以及反向）
 *   · `fullName` ← `firstName + lastName`
 *   · `firstName / lastName` ← `fullName`
 *
 * 还有一条更隐蔽的：抑制键**自己作为推导来源**也不行。用户删了 `location`，
 * 如果它还能推出 `city`，那这个值只是换了个键名继续存在。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const suppress = (...keys: ApplyFieldKey[]): ReadonlySet<ApplyFieldKey> => new Set(keys);

describe('deriveProfile 的抑制守卫', () => {
  it('抑制 city 后，不再从 location 推出 city', () => {
    const derived = deriveProfile({ location: 'Seattle, WA' }, suppress('city'));
    expect(derived.city, '被删掉的 city 又被 location 推了回来').toBeUndefined();
    expect(derived.location, 'location 没被抑制，不该受影响').toBe('Seattle, WA');
  });

  it('抑制 fullName 后，不再从姓/名拼出 fullName', () => {
    const derived = deriveProfile({ firstName: 'Ada', lastName: 'Lovelace' }, suppress('fullName'));
    expect(derived.fullName).toBeUndefined();
    expect(derived.firstName).toBe('Ada');
  });

  it('抑制 firstName 后，不再从 fullName 切出 firstName', () => {
    const derived = deriveProfile({ fullName: 'Ada Lovelace' }, suppress('firstName'));
    expect(derived.firstName).toBeUndefined();
    expect(derived.lastName, 'lastName 没被抑制，仍应被切出来').toBe('Lovelace');
  });

  /**
   * 最隐蔽的一条：被抑制的键**自己有值**时，也不能当推导来源 ——
   * 否则用户删掉的那个值只是换了个键名继续出现在申请表上。
   */
  it('抑制键自己有值时也不作为推导来源', () => {
    const derived = deriveProfile({ location: 'Seattle, WA' }, suppress('location'));
    expect(derived.location, '抑制键本身必须从结果里消失').toBeUndefined();
    expect(derived.city, '抑制的 location 被拿去推出了 city —— 值只是换了个键名').toBeUndefined();
  });

  it('抑制键即使原本就有值也不进结果', () => {
    const derived = deriveProfile({ phone: '+1 555 0100', email: 'a@b.co' }, suppress('phone'));
    expect(derived.phone).toBeUndefined();
    expect(derived.email).toBe('a@b.co');
  });

  /** 反向探针：不传抑制集时推导必须照常，否则上面全是"因为什么都不推"而绿。 */
  it('不传抑制集时推导照常（否则以上断言全是空转）', () => {
    const derived = deriveProfile({ location: 'Seattle, WA', fullName: 'Ada Lovelace' });
    expect(derived.city, '推导本身失效了 —— 上面几条测的就不是抑制').toBe('Seattle, WA');
    expect(derived.firstName).toBe('Ada');
    expect(derived.lastName).toBe('Lovelace');
  });
});

describe('抑制键一路穿到计划', () => {
  /**
   * 这一条测的是**接线**，不是纯函数。`deriveProfile` 正确但 `buildApplyPlan`
   * 没把参数传下去，是这个项目已经踩过三次的形状（蜜罐守卫、推荐人守卫、
   * JOB_DEPENDENT）。
   */
  it('suppressedKeys=[city] 且 location 有值时，计划里不出现 city 条目', () => {
    document.body.innerHTML = `<form id="application-form">
      <label for="q_city">City</label><input id="q_city" type="text" />
      <label for="email">Email</label><input id="email" type="email" />
    </form>`;
    const root = greenhouseAdapter.resolveRoot(document);
    expect(root, '适配器没认出表单，断言等于空转').not.toBeNull();
    const form = {
      vendor: 'greenhouse' as const,
      root: root!,
      fields: [...greenhouseAdapter.scan(root!)],
    };
    const profile = { location: 'Seattle, WA', email: 'ada@example.test' };

    // 前置条件：不抑制时它**确实**会被推出来并进计划，否则这条测试没有意义。
    const withoutSuppression = buildApplyPlan(form, profile);
    expect(
      withoutSuppression.entries.some((entry) => entry.key === 'city'),
      '前置条件不成立：不抑制时 city 也没进计划',
    ).toBe(true);

    const withSuppression = buildApplyPlan(form, profile, { suppressedKeys: suppress('city') });
    expect(
      withSuppression.entries.some((entry) => entry.key === 'city'),
      '抑制的 city 仍然进了计划 —— 它会被填进雇主的申请表',
    ).toBe(false);
    // 其余字段不受影响。
    expect(withSuppression.entries.some((entry) => entry.key === 'email')).toBe(true);
  });
});
