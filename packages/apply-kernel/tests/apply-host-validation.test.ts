import { describe, expect, it } from 'vitest';

import { classifyHostValidation } from '../src/write/verify';

/**
 * 宿主校验错误的采集与判决（CAP-AF-068）。
 *
 * C6 回读判决只回答一个问题：**我们写的值还在不在**。它不回答另一个问题：
 * **宿主接不接受这个值**。于是会出现最难看的一种失败——面板上报「已填 12/12」，
 * 页面上却红着四条错误，用户点提交才发现。而「回读判决 + 逐字段可审计」正是
 * 我们对外的差异化卖点，这恰恰是它最该兑现的地方。
 *
 * 三种信号来源，按可信度排序：
 *  1. **约束校验 API**（`willValidate` + `valid` + `validationMessage`）——
 *     浏览器原生判决，最可信；
 *  2. **`aria-invalid`**——宿主自己声明的判决，可信但要排除 "false"/"grammar"/"spelling"；
 *  3. **关联的错误文案**（aria-errormessage / aria-describedby 指向的红字）——
 *     只在前两者沉默时作为补充信号。
 *
 * 拿不准一律 `unknown`：把「宿主没表态」误报成「宿主拒收」，会让本来填好的
 * 字段被重试阶梯反复重写，比不判更糟。
 */

describe('宿主校验判决', () => {
  it('约束校验 API 说无效 → rejected', () => {
    expect(
      classifyHostValidation({
        willValidate: true,
        valid: false,
        validationMessage: 'Please enter a valid email address.',
      }),
    ).toBe('rejected');
  });

  it('约束校验 API 说有效 → accepted', () => {
    expect(classifyHostValidation({ willValidate: true, valid: true, validationMessage: '' })).toBe(
      'accepted',
    );
  });

  it('aria-invalid="true" → rejected', () => {
    expect(classifyHostValidation({ ariaInvalid: 'true' })).toBe('rejected');
  });

  it('aria-invalid="false" → accepted', () => {
    expect(classifyHostValidation({ ariaInvalid: 'false' })).toBe('accepted');
  });

  /**
   * `aria-invalid` 的值域不是布尔：`grammar` 与 `spelling` 是**内容提示**，
   * 不是「这个值宿主不收」。把它们当拒收会让富文本字段被反复重写。
   */
  it('aria-invalid=grammar/spelling 不是拒收', () => {
    expect(classifyHostValidation({ ariaInvalid: 'grammar' })).toBe('unknown');
    expect(classifyHostValidation({ ariaInvalid: 'spelling' })).toBe('unknown');
  });

  it('只有关联错误文案时，作为补充信号判 rejected', () => {
    expect(classifyHostValidation({ errorText: 'This field is required' })).toBe('rejected');
  });

  it('空白错误文案不算信号——容器常年存在只是没内容', () => {
    expect(classifyHostValidation({ errorText: '   ' })).toBe('unknown');
  });

  it('什么信号都没有 → unknown，绝不猜', () => {
    expect(classifyHostValidation({})).toBe('unknown');
    expect(classifyHostValidation({ willValidate: false })).toBe('unknown');
  });

  /**
   * 优先级：原生 API 压过 aria，aria 压过文案。
   * 宿主自己 aria-invalid=true 但浏览器说值合法时，仍以宿主为准——
   * 那多半是业务规则（"该邮箱已申请过"），浏览器看不见。
   */
  it('原生说有效、宿主 aria 说无效 → 以宿主为准（业务规则浏览器看不见）', () => {
    expect(
      classifyHostValidation({ willValidate: true, valid: true, ariaInvalid: 'true' }),
    ).toBe('rejected');
  });

  it('原生说无效时，即使有 accepted 形状的 aria 也判 rejected', () => {
    expect(
      classifyHostValidation({ willValidate: true, valid: false, ariaInvalid: 'false' }),
    ).toBe('rejected');
  });

  /**
   * 反向探针：`willValidate: false` 的控件（disabled / type=hidden / 不参与校验）
   * 上，`valid` 恒为 true，不能当成「宿主接受」——那是「宿主没表态」。
   */
  it('反向探针：不参与校验的控件不算 accepted', () => {
    expect(classifyHostValidation({ willValidate: false, valid: true })).toBe('unknown');
  });
});
