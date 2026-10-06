import { afterEach, describe, expect, it } from 'vitest';

import { buildAnswerPlan } from '../src/engine';
import { runApplyPlan } from '../src/runner';
import { ashbyAdapter } from '../src/sites/ashby/applyForm';
import { createUndoJournal } from '../src/undo';
import { capabilitiesForKinds } from '../src/write/allowlist';
import { prepareChoiceGroup, type PrepareChoiceGroupInput } from '../src/write/choiceGroup';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

/**
 * 规则归组的选择题成员（2026-09-15 jobs.ashbyhq.com/notion/7793e862-…/application 只读实测）：
 * Ashby 没有 <form>，"select all that apply" 的每个 checkbox 以自己的选项文案作 name，
 * 单选组成员同名 `<questionUuid>_<optionUuid>`。question scope 已把它们归成一道题（解释器），
 * 但写入器原来要求「同 name、同 form」，于是每一道题都在写前被 MIXED_GROUP_IDENTITY 拒掉、
 * runner 报 IDENTITY_CHANGED。
 *
 * 现在 `fillChoiceGroup` 以描述符的 `choice.options` 为成员权威（declared），身份复核只比对
 * 这些确切成员；单选仍守一条原生规则——同名 radio 兄弟必须全在集合内（勾一个会取消其余）。
 * 直接调用 `prepareChoiceGroup` 的默认仍是 native，Greenhouse / Lever / BambooHR 的同名组一字不变。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const RADIO_NAME = 'bd5b0ecb-7bba-4958-946f-47ac05bea7c1_b0a5aba8-dbb7-41a9-b548-f72cc3e48956';

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
          ${['He/Him', 'She/Her', 'They/Them', 'Prefer not to say'].map((text, index) => `
          <div class="ashby-application-form-input-radio-group-option">
            <span><input type="radio" id="${RADIO_NAME}-labeled-radio-${index}" name="${RADIO_NAME}" class="ashby-application-form-input-radio-group-option-radio"></span>
            <label for="${RADIO_NAME}-labeled-radio-${index}" class="ashby-application-form-input-radio-group-option-label">${text}</label>
          </div>`).join('')}
        </fieldset>
      </div>
      <div data-field-path="0b3b7773-f6d9-4032-9ab1-368c4164e95a">
        <fieldset class="ashby-application-form-input-checkbox-group">
          <label class="ashby-application-form-question-title" for="0b3b7773-f6d9-4032-9ab1-368c4164e95a">How did you hear about this opportunity? (select all that apply)</label>
          ${['LinkedIn', 'Glassdoor', 'Notion Blog', 'Conference or Meetup'].map((text, index) => `
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

function prepareInput(elements: readonly HTMLInputElement[], membership?: PrepareChoiceGroupInput['membership']): PrepareChoiceGroupInput {
  return {
    questionId: 'q.ashby',
    options: elements.map((element, index) => ({ element, optionId: `o${index}` })),
    ...(membership ? { membership } : {}),
  };
}

describe('declared membership · Ashby 形状', () => {
  it('没有 <form> 的同名单选组：native 拒绝，declared 接受', () => {
    mountAshby();
    const radios = inputs('input[type=radio]');
    expect(prepareChoiceGroup(prepareInput(radios))).toMatchObject({ ok: false, error: 'MIXED_GROUP_IDENTITY' });
    expect(prepareChoiceGroup(prepareInput(radios, 'declared'))).toMatchObject({ ok: true });
  });

  it('name 各不相同的复选组：native 拒绝，declared 接受', () => {
    mountAshby();
    const boxes = inputs('input[type=checkbox]');
    expect(prepareChoiceGroup(prepareInput(boxes))).toMatchObject({ ok: false, error: 'MIXED_GROUP_IDENTITY' });
    expect(prepareChoiceGroup(prepareInput(boxes, 'declared'))).toMatchObject({ ok: true });
  });

  it('declared 单选仍不许漏掉同名兄弟——勾一个会取消它', () => {
    mountAshby();
    const radios = inputs('input[type=radio]');
    expect(prepareChoiceGroup(prepareInput(radios.slice(0, 3), 'declared'))).toMatchObject({ ok: false, error: 'INCOMPLETE_OPTION_MEMBERSHIP' });
  });

  it('declared 复选只比对确切成员：另一道题里同名的 checkbox 不算兄弟', () => {
    mountAshby();
    const boxes = inputs('input[type=checkbox]');
    // 另一道 select-all 题也有一个叫 LinkedIn 的选项（Ashby 用选项文案作 name 时完全可能）。
    const other = document.createElement('input');
    other.type = 'checkbox';
    other.name = 'LinkedIn';
    document.querySelector('.ashby-application-form-container')!.append(other);
    expect(prepareChoiceGroup(prepareInput(boxes, 'declared'))).toMatchObject({ ok: true });
  });

  it('declared 身份复核：成员的 name 或 form 变了就不再是同一道题', async () => {
    mountAshby();
    const boxes = inputs('input[type=checkbox]');
    const prepared = prepareChoiceGroup(prepareInput(boxes, 'declared'));
    if (!prepared.ok) throw new Error(prepared.error);
    boxes[1]!.name = 'Indeed';
    const result = await prepared.value.fillOnly({
      answer: { kind: 'MULTI_CHOICE', optionIds: ['o0'] },
      authorizeWrite: async () => true,
      readHostValidation: () => ({ ariaInvalid: 'false' }),
      executionFence: () => null,
      lateRecheckMs: 1,
      settle: async () => undefined,
      lateRecheckDelay: async () => undefined,
    });
    expect(result).toMatchObject({ ok: false, code: 'IDENTITY_CHANGED' });
    expect(boxes.map((box) => box.checked)).toEqual([false, false, false, false]);
  });

  it('端到端：Ashby 适配器 + question scope 归组的两道题，审阅答案真写进去', async () => {
    mountAshby();
    const root = ashbyAdapter.resolveRoot(document);
    expect(root, 'Ashby 锚点没认出来').not.toBeNull();
    const fields = [...ashbyAdapter.scan(root!)];
    const groups = fields.filter((field) => field.kind === 'choice');
    expect(groups.map((field) => [field.choice.control, field.choice.options.length])).toEqual([['radio', 4], ['checkbox', 4]]);

    const plan = buildAnswerPlan({ vendor: 'ashby', root: root!, fields }, [
      { questionId: 'pronouns', element: groups[0]!.element, value: 'Prefer not to say' },
      { questionId: 'source', element: groups[1]!.element, value: 'LinkedIn\nNotion Blog' },
    ]);
    expect(plan.entries.map((entry) => [entry.key, entry.kind])).toEqual([['question:pronouns', 'choice'], ['question:source', 'choice']]);

    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(plan.entries.map((entry) => entry.kind))]),
      journal: createUndoJournal(),
      root: root!,
      policy: testApplyPolicy(),
      readHostValidation: () => ({ ariaInvalid: 'false' }),
      lateRecheckMs: 5,
    });
    expect(summary.results.map((result) => [result.key, result.ok ? 'ok' : result.reason])).toEqual([
      ['question:pronouns', 'ok'],
      ['question:source', 'ok'],
    ]);
    expect(inputs('input[type=radio]').map((radio) => radio.checked)).toEqual([false, false, false, true]);
    expect(inputs('input[type=checkbox]').map((box) => box.checked)).toEqual([true, false, true, false]);
  });
});
