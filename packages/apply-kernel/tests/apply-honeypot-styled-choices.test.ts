import { afterEach, describe, expect, it } from 'vitest';

import type { HoneypotGeometry } from '../src/dict/guards';
import { buildApplyPlan } from '../src/engine';
import { jobviteAdapter } from '../src/sites/jobvite/applyForm';

/**
 * 样式藏起来的原生单选不是蜜罐——标签看得见，人点的就是标签（2026-10-04，bench-1003 第六节「浮层没提到的空格」）。
 *
 * Jobvite 的是非题：`fieldset > legend + label > (i[role=radio] + input[type=radio])`，原生 radio 被样式藏起来（量出来 0×0），
 * 看得见、点得到的是外面那个 `<label>`（里面那个 `<i>` 画出圆圈）。几何防线只量了 radio 自己，于是整组被判成蜜罐——
 * 蜜罐从不进单子，四道必填的单选在浮层上一个字都没有，连填还替他按了「Next」（ashcompanies，2026-10-03）。
 * 真的蜜罐连标签也看不见：量标签照样拦得住。
 *
 * 夹具结构照 2026-10-04 在 jobs.jobvite.com/ashcompanies/job/<id>/apply 只读抓到的那一道（题目是公开的岗位页面文字）。
 */

afterEach(() => { document.body.innerHTML = ''; });

const NORMAL: HoneypotGeometry = { width: 240, height: 32, fontSize: 14 };
const HIDDEN: HoneypotGeometry = { width: 0, height: 0, fontSize: 14 };

function mount(labelGeometry: HoneypotGeometry) {
  document.body.innerHTML = `
    <div class="jv-form jv-apply-form"><form>
      <label for="first">First Name*</label><input id="first" name="input-first" type="text" autocomplete="given-name" required>
      <label for="mail">Email*</label><input id="mail" name="input-mail" type="text" autocomplete="email" required>
      <fieldset class="jv-input-group">
        <legend class="jv-form-field-legend">Are you legally authorized to work in the United States?<span class="jv-required-label">*</span></legend>
        <label class="jv-input-group-row" for="q-0" id="lab-0"><i class="icon icon-radio-empty" role="radio" aria-selected="false"></i>
          <input id="q-0" name="yROGYfw3" type="radio" value="Yes" required aria-required="true"> Yes</label>
        <label class="jv-input-group-row" for="q-1" id="lab-1"><i class="icon icon-radio-empty" role="radio" aria-selected="false"></i>
          <input id="q-1" name="yROGYfw3" type="radio" value="No" required aria-required="true"> No</label>
      </fieldset>
    </form></div>`;
  const root = jobviteAdapter.resolveRoot(document);
  expect(root).not.toBeNull();
  const fields = [...jobviteAdapter.scan(root!)];
  const readGeometry = (element: Element): HoneypotGeometry => {
    if (element instanceof HTMLInputElement && element.type === 'radio') return HIDDEN;
    if (element.localName === 'label' && element.id.startsWith('lab-')) return labelGeometry;
    return NORMAL;
  };
  return buildApplyPlan({ vendor: 'jobvite', root: root!, fields }, { firstName: 'Ada', email: 'ada@example.test' } as never, { fillEmptyOnly: true, readGeometry } as never);
}

describe('样式藏起来的原生单选', () => {
  it('Jobvite：radio 量出来 0×0、标签看得见 → 不是蜜罐（照常进单子：这道题要他答）', () => {
    const plan = mount(NORMAL);
    const skip = plan.skipped.find((item) => item.label.startsWith('Are you legally authorized'));
    const entry = plan.entries.find((item) => item.label.startsWith('Are you legally authorized'));
    expect(skip?.reason === 'HONEYPOT', '整组被判成了蜜罐：浮层上一个字都没有').toBe(false);
    expect(skip !== undefined || entry !== undefined).toBe(true);
  });

  it('真的蜜罐：标签也看不见 → 照旧拦下', () => {
    const plan = mount(HIDDEN);
    const skip = plan.skipped.find((item) => item.label.startsWith('Are you legally authorized'));
    expect(skip?.reason).toBe('HONEYPOT');
  });
});
