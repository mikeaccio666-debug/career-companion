import { afterEach, describe, expect, it } from 'vitest';
import { createScanRoot } from '../src/scanRoot';
import { fillChoiceGroup, prepareChoiceGroup } from '../src/write/choiceGroup';
import type { ChoiceGroupShape } from '../src/contracts';

/**
 * A choice member's readback must ask the **host**, not the property we just set.
 *
 * Measured live on Workday's My Information page (nvidia.wd5.myworkdayjobs.com,
 * 2026-09-15), on "Have you previously worked for NVIDIA as an employee or
 * contractor?":
 *
 *   · property write + `input`/`change`: `checked` becomes `true` and
 *     `aria-checked` stays `"false"` — for good. The host goes on reporting the
 *     question unanswered (its own error summary flags the group after "Save and
 *     Continue"), while a readback that reads `checked` reports FILLED.
 *   · a synthetic click on the member: `checked` **and** `aria-checked="true"`.
 *
 * A control that reports FILLED while the host still calls the question
 * unanswered is the worst answer this writer can give: the panel says the form
 * is done, the user submits, and the page rejects it. So where the host
 * publishes its own state, that state decides — and the property fallback, which
 * provably cannot reach such a host, is not even attempted (it would only leave
 * a half-written group that the next rescan reads as "already answered").
 */
afterEach(() => {
  document.body.innerHTML = '';
});

interface Group {
  readonly radios: readonly HTMLInputElement[];
  readonly root: ReturnType<typeof createScanRoot>;
  readonly choice: ChoiceGroupShape;
}

/**
 * Workday's shape: no `<form>`, a `fieldset`/`legend` question, and members that
 * are visually replaced by a styled span (hence `opacity: 0`, and hence the host
 * publishing the real state on `aria-checked`).
 *
 * `publishes` switches the only thing under test: whether the host owns a
 * published state at all. With it off the fixture is an ordinary radio group and
 * every historical path must behave exactly as before.
 */
function mountWorkdayRadios({ publishes = true, honoursClick = true } = {}): Group {
  document.body.innerHTML = `
    <div data-automation-id="applyFlowMyInfoPage">
      <div data-automation-id="formField-candidateIsPreviousWorker">
        <fieldset>
          <legend>Have you previously worked for NVIDIA as an employee or contractor?*</legend>
          <div><input type="radio" id="prev-yes" name="candidateIsPreviousWorker" value="true"${publishes ? ' aria-checked="false"' : ''}><label for="prev-yes">Yes</label></div>
          <div><input type="radio" id="prev-no" name="candidateIsPreviousWorker" value="false"${publishes ? ' aria-checked="false"' : ''}><label for="prev-no">No</label></div>
        </fieldset>
      </div>
    </div>`;
  const radios = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  if (publishes && honoursClick) {
    for (const member of radios) {
      member.addEventListener('click', () => {
        for (const other of radios) other.setAttribute('aria-checked', String(other === member));
      });
    }
  }
  return {
    radios,
    root: createScanRoot(document.querySelector('[data-automation-id="applyFlowMyInfoPage"]')!, [], []),
    choice: {
      control: 'radio',
      options: radios.map((element) => ({ element, label: element.id === 'prev-yes' ? 'Yes' : 'No' })),
    },
  };
}

const aria = (radios: readonly HTMLInputElement[]) => radios.map((radio) => radio.getAttribute('aria-checked'));
const checked = (radios: readonly HTMLInputElement[]) => radios.map((radio) => radio.checked);

async function answer(group: Group, line: string, { canClick = true } = {}) {
  return fillChoiceGroup({
    questionId: 'q.previousWorker',
    choice: group.choice,
    lines: [line],
    root: group.root,
    clickCapabilityCurrent: () => canClick,
    authorizeWrite: async () => true,
    readHostValidation: () => ({ ariaInvalid: 'false' }),
    executionFence: () => null,
    lateRecheckMs: 1,
  });
}

describe('a choice member whose host publishes its own state', () => {
  /**
   * 红：同一个夹具，只写属性。`checked` 变了、事件也派了，而宿主公布的状态
   * 一个字没动——这一栏必须如实失败，不能因为读到了自己刚写的属性就报成功。
   */
  it('red: the property path is not success when aria-checked never moves', async () => {
    const group = mountWorkdayRadios();
    const prepared = prepareChoiceGroup({
      questionId: 'q.previousWorker',
      options: group.radios.map((element, index) => ({ element, optionId: `o${index}` })),
      membership: 'declared',
    });
    if (!prepared.ok) throw new Error(prepared.error);
    // No `activation` ⇒ the historical setter + input/change path.
    const result = await prepared.value.fillOnly({
      answer: { kind: 'SINGLE_CHOICE', optionId: 'o1' },
      authorizeWrite: async () => true,
      readHostValidation: () => ({ ariaInvalid: 'false' }),
      executionFence: () => null,
      lateRecheckMs: 1,
      settle: async () => undefined,
      lateRecheckDelay: async () => undefined,
    });
    expect(result.ok, 'a write the host never received must not report success').toBe(false);
    // The property did move — that is exactly why reading it back is a lie.
    expect(checked(group.radios)).toEqual([false, true]);
    expect(aria(group.radios)).toEqual(['false', 'false']);
  });

  it('green: native activation reaches the host, and the readback agrees', async () => {
    const group = mountWorkdayRadios();
    expect(await answer(group, 'No')).toEqual({ ok: true, value: undefined });
    expect(checked(group.radios)).toEqual([false, true]);
    expect(aria(group.radios)).toEqual(['false', 'true']);
  });

  it('a host that ignores the click too is reported as a failure, not as filled', async () => {
    const group = mountWorkdayRadios({ honoursClick: false });
    const result = await answer(group, 'No');
    expect(result.ok).toBe(false);
    expect(aria(group.radios)).toEqual(['false', 'false']);
  });

  /**
   * 不回落：属性写入对这种宿主证明无效，做了只会留下半截状态——下一遍重扫看到
   * 一个非空的组，连原生激活的第二次机会都没有了。
   */
  it('never falls back to the property path when the host publishes its own state', async () => {
    const group = mountWorkdayRadios();
    const result = await answer(group, 'No', { canClick: false });
    expect(result).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    expect(checked(group.radios), '回落一次都不该发生').toEqual([false, false]);
    expect(aria(group.radios)).toEqual(['false', 'false']);
  });

  it('an ordinary group that publishes nothing still falls back exactly as before', async () => {
    const group = mountWorkdayRadios({ publishes: false });
    expect(await answer(group, 'No', { canClick: false })).toEqual({ ok: true, value: undefined });
    expect(checked(group.radios)).toEqual([false, true]);
  });
});

describe('a group that is already answered', () => {
  it('reports the answer we wanted as success, not as a changed identity', async () => {
    const group = mountWorkdayRadios();
    expect(await answer(group, 'No')).toEqual({ ok: true, value: undefined });
    // The rescan loop fills the same page again; the second pass must read the
    // same way a human would: this question is answered, and it is our answer.
    expect(await answer(group, 'No')).toEqual({ ok: true, value: undefined });
    expect(aria(group.radios)).toEqual(['false', 'true']);
  });

  it('refuses to overwrite a different existing answer, and says NOT_EMPTY', async () => {
    const group = mountWorkdayRadios();
    expect(await answer(group, 'Yes')).toEqual({ ok: true, value: undefined });
    expect(await answer(group, 'No')).toEqual({ ok: false, code: 'NOT_EMPTY' });
    expect(aria(group.radios)).toEqual(['true', 'false']);
    expect(checked(group.radios)).toEqual([true, false]);
  });

  it('a group the host says is unanswered while the property says otherwise is not success', async () => {
    const group = mountWorkdayRadios();
    // Exactly the state the old property path used to leave behind.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')!.set!.call(group.radios[1], true);
    const result = await answer(group, 'No');
    expect(result.ok, 'the host still calls this question unanswered').toBe(false);
  });
});
