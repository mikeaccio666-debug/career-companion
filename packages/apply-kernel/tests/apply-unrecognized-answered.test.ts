import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { ripplingAdapter } from '../src/sites/rippling/applyForm';

/**
 * 认不出来、可页面上已经有值的那一栏，不是「需要你」（2026-10-04，bench-1003 第七节：Rippling 6/8 页的假题「Search」）。
 *
 * Rippling 的电话区号是一个搜索式下拉：输入框的可读名只有「Search」（aria-label 与占位都是它），网站默认已经选好
 * 「+1 US」，值就在这个输入框里。我们认不出它是什么（规则刻意不绑电话区号），从前一律报「没把握」，浮层列成
 * 「我们没认出这一题，请在这里回答」——可这一题网站早答好了。认不出、但读得出值的文本类控件（文本框、文本域、
 * 组合框的输入框）报 NOT_EMPTY（页面上已有），与认得出的那些栏同一个说法。空着的照旧是「没把握」。
 *
 * 夹具结构照 2026-10-04 在 ats.rippling.com/moov/jobs/<uuid>/apply 只读抓到的那一段（值是网站的默认值，不是用户数据）。
 */

afterEach(() => { document.body.innerHTML = ''; });

function mount(codeValue: string) {
  document.body.innerHTML = `
    <div id="__next"><form>
      <div data-testid="field">
        <label for="field-8">First name*</label>
        <input data-testid="input-first_name" id="field-8" name="z7FRYsYUls" type="text" required />
      </div>
      <div data-testid="field">
        <span id="field-30-label">Phone number*</span>
        <div data-testid="phone_number-code"><div><div data-testid="select-controller"><div><div><div data-testid="select-search-input">
          <input data-input="select-search-input" data-testid="input-select-search-input" id="field-34" aria-required="true"
            autocomplete="auto-complete-off" placeholder="Search" aria-label="Search" role="combobox" aria-autocomplete="list"
            aria-haspopup="listbox" aria-expanded="false" name="OPTB26rPi98" value="${codeValue}">
        </div></div></div></div></div></div>
        <div data-testid="phone_number">
          <input data-testid="input-phone_number" id="field-36" name="Ih0FOu2yvX" type="text" aria-labelledby="field-30-label" required />
        </div>
      </div>
    </form></div>`;
  const root = ripplingAdapter.resolveRoot(document);
  expect(root).not.toBeNull();
  return buildApplyPlan({ vendor: 'rippling', root: root!, fields: [...ripplingAdapter.scan(root!)] }, { firstName: 'Ada', phone: '+1 555 0100' } as never);
}

const searchRow = (plan: ReturnType<typeof mount>) =>
  [...plan.skipped, ...plan.entries.map((entry) => ({ ...entry, reason: 'PLANNED' }))].find((item) => (item.element as HTMLElement).id === 'field-34');

describe('认不出、页面上已经有值的那一栏', () => {
  it('Rippling 电话区号（可读名「Search」、网站默认「+1 US」）：页面上已有，不是「没把握」', () => {
    const row = searchRow(mount('+1 US'));
    expect(row, '这一栏应当被扫到').toBeDefined();
    expect(row?.reason).toBe('NOT_EMPTY');
  });

  it('空着的照旧是「没把握」（我们认不出、也没有值）', () => {
    const row = searchRow(mount(''));
    expect(row?.reason).toBe('LOW_CONFIDENCE');
  });
});
