// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findPreStepControl } from '../lab/labNavigator';

/**
 * The lab's "Apply ▸" pre-step clicks an in-page expander when a scan finds no form.
 *
 * 2026-09-28, measuring the generic lane on company-built forms: the form's own button
 * often reads "Apply" and carries no `type`, which makes it a submit button. The pre-step
 * used to refuse only an explicit `type="submit"`, so on such a page it would have pressed
 * the form's submit. Whether a control submits is the element's own `type` and `form`.
 */
describe('lab 预步骤：会提交表单的按钮永远不是「展开申请表」', () => {
  beforeEach(() => {
    // happy-dom lays nothing out; the navigator only asks "does it have a box at all".
    vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{ width: 80, height: 30 }] as unknown as DOMRectList);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('表单里没写 type 的「Apply」就是提交按钮：拒', () => {
    document.body.innerHTML = '<form><label>Email <input name="email"></label><button>Apply</button></form>';
    expect(findPreStepControl(document)).toMatchObject({ refusal: 'NO_CANDIDATE' });
  });

  it('表单外的「Apply now」只是展开器：照旧点', () => {
    document.body.innerHTML = '<button id="open">Apply now</button><form><input name="email"><button type="submit">Send</button></form>';
    const hit = findPreStepControl(document);
    expect('control' in hit ? hit.control.id : hit.refusal).toBe('open');
  });

  it('表单里写明 type="button" 的「Apply」不会提交：照旧点', () => {
    document.body.innerHTML = '<form><input name="email"><button id="reveal" type="button">Apply for this job</button></form>';
    const hit = findPreStepControl(document);
    expect('control' in hit ? hit.control.id : hit.refusal).toBe('reveal');
  });
});
