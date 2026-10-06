import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildAnswerPlan } from '../src/engine';
import { createBundledApplyPolicy, type ApplyPolicy } from '../src/policy';
import { runApplyPlan } from '../src/runner';
import { ashbyAdapter } from '../src/sites/ashby/applyForm';
import { createUndoJournal } from '../src/undo';
import { capabilitiesForKinds } from '../src/write/allowlist';
import { prepareChoiceGroup } from '../src/write/choiceGroup';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

/**
 * 单选/复选题的写入手段：**原生激活**（2026-09-15）。
 *
 * ## 病根（lab 在真实 posting 上量到的）
 *
 * jobs.ashbyhq.com/notion/7793e862-50fa-4357-a4bc-2328440f8d68/application 的两道题，
 * 同一种属性写入（native `checked` setter + `input`/`change`）得到两种结果：
 *
 *   · 代词单选组 → 250ms 的延时复检里就被 React 刷回去，报 `LATE_REVERTED`。诚实。
 *   · 「How did you hear about this opportunity?」复选组 → 复检窗口里没被刷回去，
 *     这一栏**报了成功**；整页填完之后回读，那个 LinkedIn 复选框仍是未勾选的。
 *     一次静默的假成功。
 *
 * 差别只是「下一次重渲染落在 250ms 窗口内还是窗口外」——受控组的重渲染可能由
 * 后面某个字段的写入触发，那时本组的观察早就结束了。所以这不是可以靠加长窗口
 * 解决的竞态，属性写入对受控宿主**就是错的**：React 的 onChange 只从 `click` 起。
 *
 * ## 本文件锁什么
 *
 *  1. 计划里每个要勾的成员**恰好收到一次 click**，且写入不再经过 `checked` setter；
 *  2. 一个「只认 click」的受控宿主（本文件的 stand-in）现在填得进去，
 *     而同一个夹具在只写属性时填不进去（红/绿两侧都在本文件里）；
 *  3. 点击能力位被关掉时，这一栏**回落**到属性写入，而不是整道题填不上；
 *  4. 激活期间任何一个本组表单的 `submit` 都被当场拦下，且这次写入判定失败——
 *     这是本仓唯一一处不预先 `preventDefault` 的宿主点击，代价必须有测试；
 *  5. 带撤销的 `write()` 那条路径一个 click 都不发（只有 fill-first 用激活）。
 */

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const RADIO_NAME = 'bd5b0ecb-7bba-4958-946f-47ac05bea7c1_b0a5aba8-dbb7-41a9-b548-f72cc3e48956';
const RADIO_OPTIONS = ['He/Him', 'She/Her', 'They/Them', 'Prefer not to say'] as const;
const CHECKBOX_OPTIONS = ['LinkedIn', 'Glassdoor', 'Notion Blog', 'Conference or Meetup'] as const;

/** Ashby 的实测形状：没有 <form>，复选框以选项文案作 name，单选组成员同名。 */
function mountAshby(): void {
  document.body.innerHTML = `
    <div class="ashby-application-form-container">
      <div class="ashby-application-form-field-entry">
        <label class="ashby-application-form-question-title" for="first">First Name</label>
        <input id="first" name="first" type="text" />
      </div>
      <div data-field-path="b0a5aba8-dbb7-41a9-b548-f72cc3e48956">
        <fieldset class="ashby-application-form-input-radio-group">
          <label class="ashby-application-form-question-title" for="b0a5aba8-dbb7-41a9-b548-f72cc3e48956">What pronouns would you like our team to use when addressing you?</label>
          ${RADIO_OPTIONS.map((text, index) => `
          <div class="ashby-application-form-input-radio-group-option">
            <span><input type="radio" id="${RADIO_NAME}-labeled-radio-${index}" name="${RADIO_NAME}" class="ashby-application-form-input-radio-group-option-radio"></span>
            <label for="${RADIO_NAME}-labeled-radio-${index}" class="ashby-application-form-input-radio-group-option-label">${text}</label>
          </div>`).join('')}
        </fieldset>
      </div>
      <div data-field-path="0b3b7773-f6d9-4032-9ab1-368c4164e95a">
        <fieldset class="ashby-application-form-input-checkbox-group">
          <label class="ashby-application-form-question-title" for="0b3b7773-f6d9-4032-9ab1-368c4164e95a">How did you hear about this opportunity? (select all that apply)</label>
          ${CHECKBOX_OPTIONS.map((text, index) => `
          <div class="ashby-application-form-input-checkbox-group-option">
            <span><input type="checkbox" id="0b3b7773-labeled-checkbox-${index}" name="${text}"></span>
            <label for="0b3b7773-labeled-checkbox-${index}" class="ashby-application-form-input-checkbox-group-option-label">${text}</label>
          </div>`).join('')}
        </fieldset>
      </div>
    </div>`;
}

function inputs(selector: string): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>(selector)];
}

/**
 * 一个只认 click 的受控宿主，形状照抄 React 的 ChangeEventPlugin：选中态由它自己
 * 的一份状态决定，状态只在 `click` 里更新，任何一次重渲染都把 DOM 刷回状态。
 * 属性写入 + `input`/`change` 对它完全无效——重渲染一来就被抹掉。
 */
function controlHost(members: readonly HTMLInputElement[], kind: 'radio' | 'checkbox') {
  const state = new Set<HTMLInputElement>();
  const render = () => {
    for (const member of members) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')!
        .set!.call(member, state.has(member));
    }
  };
  for (const member of members) {
    member.addEventListener('click', () => {
      if (kind === 'radio') state.clear();
      if (state.has(member)) state.delete(member);
      else state.add(member);
      // 受控宿主在这一下里自己把 DOM 同步到新状态。
      render();
    });
  }
  return { render, state };
}

async function fill(
  answers: readonly { questionId: string; index: 0 | 1; value: string }[],
  options: { policy?: ApplyPolicy } = {},
) {
  const root = ashbyAdapter.resolveRoot(document)!;
  const fields = [...ashbyAdapter.scan(root)];
  const groups = fields.filter((field) => field.kind === 'choice');
  const plan = buildAnswerPlan({ vendor: 'ashby', root, fields }, answers.map((answer) => ({
    questionId: answer.questionId,
    element: groups[answer.index]!.element,
    value: answer.value,
  })));
  const summary = await runApplyPlan({
    plan,
    auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(plan.entries.map((entry) => entry.kind))]),
    journal: createUndoJournal(),
    root,
    policy: options.policy ?? testApplyPolicy(),
    readHostValidation: () => ({ ariaInvalid: 'false' }),
    lateRecheckMs: 5,
  });
  return summary.results.map((result) => [result.key, result.ok ? 'ok' : result.reason]);
}

describe('选择题走原生激活', () => {
  it('每个要勾的成员恰好收到一次 click，且不经过 checked setter', async () => {
    mountAshby();
    const clicks: string[] = [];
    document.addEventListener('click', (event) => clicks.push((event.target as HTMLInputElement).id), true);
    const checkedSetter = vi.spyOn(HTMLInputElement.prototype, 'checked', 'set');

    expect(await fill([
      { questionId: 'pronouns', index: 0, value: 'Prefer not to say' },
      { questionId: 'source', index: 1, value: 'LinkedIn\nNotion Blog' },
    ])).toEqual([['question:pronouns', 'ok'], ['question:source', 'ok']]);

    expect(clicks).toEqual([
      `${RADIO_NAME}-labeled-radio-3`,
      '0b3b7773-labeled-checkbox-0',
      '0b3b7773-labeled-checkbox-2',
    ]);
    // 激活自己会改选中态；我们一次都不写这个属性。
    expect(checkedSetter, '原生激活这条路不该再碰 checked setter').not.toHaveBeenCalled();
    expect(inputs('input[type=radio]').map((radio) => radio.checked)).toEqual([false, false, false, true]);
    expect(inputs('input[type=checkbox]').map((box) => box.checked)).toEqual([true, false, true, false]);
  });

  it('绿：只认 click 的受控宿主现在填得进去', async () => {
    mountAshby();
    controlHost(inputs('input[type=radio]'), 'radio');
    controlHost(inputs('input[type=checkbox]'), 'checkbox');

    expect(await fill([
      { questionId: 'pronouns', index: 0, value: 'They/Them' },
      { questionId: 'source', index: 1, value: 'Glassdoor' },
    ])).toEqual([['question:pronouns', 'ok'], ['question:source', 'ok']]);
    expect(inputs('input[type=radio]').map((radio) => radio.checked)).toEqual([false, false, true, false]);
    expect(inputs('input[type=checkbox]').map((box) => box.checked)).toEqual([false, true, false, false]);
  });

  /**
   * 红：同一个受控夹具，只走属性写入就填不进去。
   *
   * 这是上一条测试的对照组，而且是 lab 在 Ashby 上量到的那一幕的最小复现：
   * 属性写完、事件派完，宿主的下一次重渲染把它抹掉。
   */
  it('红：同一个夹具只写属性时，宿主的下一次重渲染把它抹掉', async () => {
    mountAshby();
    const radios = inputs('input[type=radio]');
    const host = controlHost(radios, 'radio');
    const prepared = prepareChoiceGroup({
      questionId: 'q.pronouns',
      options: radios.map((element, index) => ({ element, optionId: `o${index}` })),
      membership: 'declared',
    });
    if (!prepared.ok) throw new Error(prepared.error);
    // activation 不给 ⇒ 老的属性写入路径。
    const result = await prepared.value.fillOnly({
      answer: { kind: 'SINGLE_CHOICE', optionId: 'o2' },
      authorizeWrite: async () => true,
      readHostValidation: () => ({ ariaInvalid: 'false' }),
      executionFence: () => null,
      lateRecheckMs: 1,
      settle: async () => undefined,
      lateRecheckDelay: async () => undefined,
    });
    expect(result.ok, '属性写入在只认 click 的宿主上不该算成功').toBe(true);
    // 写入器看到的一切都对，但宿主的下一次重渲染才是最终裁判。
    host.render();
    expect(radios.map((radio) => radio.checked)).toEqual([false, false, false, false]);
    if (result.ok) expect(result.observation.check()).toBe('LATE_REVERTED');
  });

  it('点击能力位关掉时回落到属性写入：零 click，题照样填上', async () => {
    mountAshby();
    const clicks: string[] = [];
    document.addEventListener('click', (event) => clicks.push((event.target as HTMLInputElement).id), true);
    const base = createBundledApplyPolicy(Date.now());
    const policy: ApplyPolicy = {
      ...base,
      capabilities: { ...base.capabilities, 'set-combobox': false },
    };

    expect(await fill([{ questionId: 'pronouns', index: 0, value: 'She/Her' }], { policy }))
      .toEqual([['question:pronouns', 'ok']]);
    expect(clicks, '能力位关着还点了宿主').toEqual([]);
    expect(inputs('input[type=radio]').map((radio) => radio.checked)).toEqual([false, true, false, false]);
  });

  it('激活期间宿主想提交：提交被拦下，这次写入判定失败', async () => {
    document.body.innerHTML = `
      <form id="application-form" class="ashby-application-form-container">
        <div data-field-path="b0a5aba8-dbb7-41a9-b548-f72cc3e48956">
          <fieldset class="ashby-application-form-input-radio-group">
            <label class="ashby-application-form-question-title" for="b0a5aba8-dbb7-41a9-b548-f72cc3e48956">What pronouns would you like our team to use when addressing you?</label>
            ${RADIO_OPTIONS.map((text, index) => `
            <div class="ashby-application-form-input-radio-group-option">
              <span><input type="radio" id="${RADIO_NAME}-labeled-radio-${index}" name="${RADIO_NAME}"></span>
              <label for="${RADIO_NAME}-labeled-radio-${index}">${text}</label>
            </div>`).join('')}
          </fieldset>
        </div>
      </form>`;
    const form = document.querySelector('form')!;
    // 这个监听器排在捕获期否决之后。它记的是**默认动作有没有被取消**——
    // `preventDefault` 不会阻止别的监听器跑，它阻止的是这张表真的被提交。
    const submitted: boolean[] = [];
    form.addEventListener('submit', (event) => {
      submitted.push(event.defaultPrevented);
      event.preventDefault();
    });
    // 一个在 click 传播途中提交整张表的敌意宿主监听器。预先取消 click 的默认
    // 动作拦不住这种写法；激活窗口里的捕获期 submit 否决拦得住。
    document.addEventListener('click', () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    const outcome = await fill([{ questionId: 'pronouns', index: 0, value: 'He/Him' }]);
    expect(submitted.length, '反向探针：这个夹具本来就该发出 submit').toBeGreaterThan(0);
    expect(
      submitted.every(Boolean),
      '激活窗口里的 submit 默认动作没有被取消——这张表会真的提交出去',
    ).toBe(true);
    expect(outcome[0]![1], '被拦下提交之后不该报成功').not.toBe('ok');
  });

  it('带撤销的 write() 那条路径仍然零 click', async () => {
    mountAshby();
    const click = vi.spyOn(HTMLElement.prototype, 'click');
    const clicks: string[] = [];
    document.addEventListener('click', (event) => clicks.push((event.target as Element).id), true);
    const radios = inputs('input[type=radio]');
    const prepared = prepareChoiceGroup({
      questionId: 'q.pronouns',
      options: radios.map((element, index) => ({ element, optionId: `o${index}` })),
      membership: 'declared',
    });
    if (!prepared.ok) throw new Error(prepared.error);
    const result = await prepared.value.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'o1' },
      settle: async () => undefined,
    });
    expect(result.ok).toBe(true);
    expect(clicks).toEqual([]);
    expect(click).not.toHaveBeenCalled();
    expect(radios.map((radio) => radio.checked)).toEqual([false, true, false, false]);
  });
});
