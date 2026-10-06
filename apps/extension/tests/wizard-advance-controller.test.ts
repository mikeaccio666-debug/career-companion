// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApplyFormDescriptor } from '@edaix/apply-kernel/contracts';
import { createBundledApplyPolicy, type ApplyPolicy } from '@edaix/apply-kernel/policy';
import { createScanRoot } from '@edaix/apply-kernel/scanRoot';

import {
  beginAdvanceRunStep,
  captureTrustedShadowGesture,
  endAdvanceRun,
  openAdvanceRun,
  type AdvanceRun,
  type AdvanceRunScope,
  type AdvanceRunStep,
} from '@edaix/apply-kernel/grant';

import { advanceAllowed, chainAllowed, createWizardAdvanceController, nextControlState } from '../lib/wizardAdvanceController';

/**
 * 内容脚本这一侧的「继续到下一页」（wizardAdvanceController.ts）。
 *
 * 浮层只报「用户按了」；这里判那一下是不是真人、开关此刻开没开、按哪一颗、翻没翻过去，
 * 以及用户自己在网站上翻了页之后要不要让浮层回到可以点 Autofill 的样子。
 */

class TrustedClick extends MouseEvent { get isTrusted() { return true; } }

afterEach(() => { document.body.innerHTML = ''; });

/** Workday My Information 的骨架：底栏那颗 Save and Continue 没有 type，页面上没有 <form>。 */
function workdayPage() {
  document.body.innerHTML = `
    <div id="app">
      <div id="step" data-automation-id="applyFlowMyInfoPage">
        <label for="fn">First Name</label><input id="fn" type="text" />
        <label for="ln">Last Name</label><input id="ln" type="text" />
      </div>
    </div>
    <div data-automation-id="pageFooter">
      <button data-automation-id="pageFooterBackButton">Back</button>
      <button id="next" data-automation-id="pageFooterNextButton">Save and Continue</button>
    </div>`;
  const container = document.getElementById('step')!;
  const root = createScanRoot(container, []);
  const fields = ['fn', 'ln'].map((id) => ({
    kind: 'text', key: null, label: root.labelTextFor(document.getElementById(id)!), required: true, confidence: 1,
    element: document.getElementById(id)!, signature: {} as never,
  }));
  const descriptor = { vendor: 'workday', root, fields } as unknown as ApplyFormDescriptor;
  return { descriptor, next: document.getElementById('next')! };
}

/** 翻到 My Experience：整步换掉。 */
function goToMyExperience() {
  document.getElementById('app')!.innerHTML = `
    <div data-automation-id="applyFlowMyExpPage">
      <label for="jt">Job Title</label><input id="jt" type="text" />
    </div>`;
}

function policy(overrides: Partial<ApplyPolicy['capabilities']> = { 'advance-step': true }): ApplyPolicy {
  const base = createBundledApplyPolicy();
  return {
    ...base,
    enabled: true,
    vendors: { ...base.vendors, workday: true },
    capabilities: { ...base.capabilities, ...overrides },
    notAfter: Date.now() + 60_000,
  };
}

/** 一次真点击：在我方 shadow root 里的一颗按钮上派发，监听器里当场交给 advance。 */
function clickFromOurShadow(run: (event: MouseEvent, shadowRoot: ShadowRoot) => void, trusted = true) {
  const host = document.createElement('div');
  document.documentElement.append(host);
  const shadowRoot = host.attachShadow({ mode: 'closed' });
  const button = document.createElement('button');
  shadowRoot.append(button);
  button.addEventListener('click', (event) => run(event, shadowRoot));
  button.dispatchEvent(trusted ? new TrustedClick('click', { bubbles: true, composed: true }) : new MouseEvent('click', { bubbles: true }));
  host.remove();
}

function controller(resolvePolicy: () => Promise<ApplyPolicy | null> = async () => policy()) {
  return createWizardAdvanceController({
    document,
    isVisible: () => true,
    resolvePolicy,
    pollMs: 5,
    settleMs: 150,
    debounceMs: 5,
  });
}

const flush = (ms = 30) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

describe('要不要摆出按钮', () => {
  it('开关开着、页面上有唯一那颗 → 给出宿主按钮上的字', () => {
    const page = workdayPage();
    const wizard = controller();
    wizard.arm({ descriptor: page.descriptor, policy: policy(), onLeft: () => {} });
    expect(wizard.label()).toBe('Save and Continue');
  });

  it.each([
    ['翻页位没开（出厂默认）', policy({ 'advance-step': false })],
    ['整体关了', { ...policy(), enabled: false }],
    ['这一家关了', { ...policy(), vendors: { ...policy().vendors, workday: false } }],
    ['过期了', { ...policy(), notAfter: Date.now() - 1 }],
  ])('%s → 不摆', (_name, value) => {
    const page = workdayPage();
    const wizard = controller();
    wizard.arm({ descriptor: page.descriptor, policy: value as ApplyPolicy, onLeft: () => {} });
    expect(wizard.label()).toBeNull();
  });

  it('没 arm 过（这一页还没跑过 Autofill）→ 不摆', () => {
    workdayPage();
    expect(controller().label()).toBeNull();
  });

  it('advanceAllowed 缺一位都不放', () => {
    expect(advanceAllowed(null, 'workday')).toBe(false);
    expect(advanceAllowed(policy(), 'workday')).toBe(true);
    expect(advanceAllowed(policy({ 'advance-step': false }), 'workday')).toBe(false);
  });
});

describe('用户按了「继续到下一页」', () => {
  it('页面派发的点击 → UNTRUSTED，宿主的按钮一下都没被按', async () => {
    const page = workdayPage();
    const click = vi.spyOn(page.next, 'click');
    const wizard = controller();
    wizard.arm({ descriptor: page.descriptor, policy: policy(), onLeft: () => {} });
    let outcome: Promise<unknown> = Promise.resolve();
    clickFromOurShadow((event, shadowRoot) => { outcome = wizard.advance(event, shadowRoot); }, false);
    expect(await outcome).toBe('UNTRUSTED');
    expect(click).not.toHaveBeenCalled();
  });

  it('来自别人的 shadow（不是我们的浮层）→ UNTRUSTED', async () => {
    const page = workdayPage();
    const click = vi.spyOn(page.next, 'click');
    const wizard = controller();
    wizard.arm({ descriptor: page.descriptor, policy: policy(), onLeft: () => {} });
    const other = document.createElement('div').attachShadow({ mode: 'open' });
    let outcome: Promise<unknown> = Promise.resolve();
    clickFromOurShadow((event) => { outcome = wizard.advance(event, other); });
    expect(await outcome).toBe('UNTRUSTED');
    expect(click).not.toHaveBeenCalled();
  });

  it('真点击 → 按宿主那一颗；整步换掉 → ADVANCED，之后不再管这一页', async () => {
    const page = workdayPage();
    const click = vi.spyOn(page.next, 'click').mockImplementation(() => { setTimeout(goToMyExperience, 20); });
    const onLeft = vi.fn();
    const wizard = controller();
    wizard.arm({ descriptor: page.descriptor, policy: policy(), onLeft });
    let outcome: Promise<unknown> = Promise.resolve();
    clickFromOurShadow((event, shadowRoot) => { outcome = wizard.advance(event, shadowRoot); });
    expect(await outcome).toBe('ADVANCED');
    expect(click).toHaveBeenCalledTimes(1);
    expect(onLeft, '我们自己按翻的页，由浮层自己收场，不再另报一次').not.toHaveBeenCalled();
    expect(wizard.label(), '新的一页还没跑过 Autofill').toBeNull();
  });

  it('按了宿主不翻（校验没过）→ NOT_ADVANCED，接着盯这一页', async () => {
    const page = workdayPage();
    vi.spyOn(page.next, 'click').mockImplementation(() => {});
    const onLeft = vi.fn();
    const wizard = controller();
    wizard.arm({ descriptor: page.descriptor, policy: policy(), onLeft });
    let outcome: Promise<unknown> = Promise.resolve();
    clickFromOurShadow((event, shadowRoot) => { outcome = wizard.advance(event, shadowRoot); });
    expect(await outcome).toBe('NOT_ADVANCED');
    expect(wizard.label(), '还是这一页，按钮还在').toBe('Save and Continue');
    // 用户照着红色提示改完，直接在网站上按了下一步：照样发现。
    goToMyExperience();
    await flush();
    expect(onLeft).toHaveBeenCalledTimes(1);
  });

  it('按之前重新读开关：arm 时开着、按的时候已经关了 → 不按', async () => {
    const page = workdayPage();
    const click = vi.spyOn(page.next, 'click');
    const wizard = controller(async () => policy({ 'advance-step': false }));
    wizard.arm({ descriptor: page.descriptor, policy: policy(), onLeft: () => {} });
    let outcome: Promise<unknown> = Promise.resolve();
    clickFromOurShadow((event, shadowRoot) => { outcome = wizard.advance(event, shadowRoot); });
    expect(await outcome).toBe('UNAVAILABLE');
    expect(click).not.toHaveBeenCalled();
  });

  it('读不到开关（worker 没给授权、运行时解不出）→ 不按', async () => {
    const page = workdayPage();
    const click = vi.spyOn(page.next, 'click');
    const wizard = controller(async () => null);
    wizard.arm({ descriptor: page.descriptor, policy: policy(), onLeft: () => {} });
    let outcome: Promise<unknown> = Promise.resolve();
    clickFromOurShadow((event, shadowRoot) => { outcome = wizard.advance(event, shadowRoot); });
    expect(await outcome).toBe('UNAVAILABLE');
    expect(click).not.toHaveBeenCalled();
  });

  it('按之前再找一次：底栏那颗已经变成 Submit → 不按', async () => {
    const page = workdayPage();
    const click = vi.spyOn(page.next, 'click');
    const wizard = controller();
    wizard.arm({ descriptor: page.descriptor, policy: policy(), onLeft: () => {} });
    expect(wizard.label()).toBe('Save and Continue');
    page.next.textContent = 'Submit';
    let outcome: Promise<unknown> = Promise.resolve();
    clickFromOurShadow((event, shadowRoot) => { outcome = wizard.advance(event, shadowRoot); });
    expect(await outcome).toBe('UNAVAILABLE');
    expect(click).not.toHaveBeenCalled();
  });

  it('等结论的时候再按一次 → 宿主只被按一次', async () => {
    const page = workdayPage();
    const click = vi.spyOn(page.next, 'click').mockImplementation(() => {});
    const wizard = controller();
    wizard.arm({ descriptor: page.descriptor, policy: policy(), onLeft: () => {} });
    const outcomes: Promise<unknown>[] = [];
    clickFromOurShadow((event, shadowRoot) => { outcomes.push(wizard.advance(event, shadowRoot)); });
    clickFromOurShadow((event, shadowRoot) => { outcomes.push(wizard.advance(event, shadowRoot)); });
    expect(await outcomes[1]).toBe('UNAVAILABLE');
    await outcomes[0];
    expect(click).toHaveBeenCalledTimes(1);
  });
});

describe('用户自己在网站上按了下一步', () => {
  it('整步换掉 → 告诉浮层一次，之后不再管这一页', async () => {
    const page = workdayPage();
    const onLeft = vi.fn();
    const wizard = controller();
    wizard.arm({ descriptor: page.descriptor, policy: policy(), onLeft });
    goToMyExperience();
    await flush();
    expect(onLeft).toHaveBeenCalledTimes(1);
    expect(wizard.label()).toBeNull();
  });

  it('只是重挂载了输入框（同名标签还在）→ 不算换页', async () => {
    const page = workdayPage();
    const onLeft = vi.fn();
    const wizard = controller();
    wizard.arm({ descriptor: page.descriptor, policy: policy(), onLeft });
    for (const input of Array.from(document.querySelectorAll('input'))) input.replaceWith(input.cloneNode(true));
    await flush();
    expect(onLeft).not.toHaveBeenCalled();
  });

  it('disarm 之后（新一轮开始）→ 不再报', async () => {
    const page = workdayPage();
    const onLeft = vi.fn();
    const wizard = controller();
    wizard.arm({ descriptor: page.descriptor, policy: policy(), onLeft });
    wizard.disarm();
    goToMyExperience();
    await flush();
    expect(onLeft).not.toHaveBeenCalled();
  });
});

describe('连填里的翻页（2026-09-28）：没有点击，凭的是那一轮连填的这一步', () => {
  const SCOPE: AdvanceRunScope = { origin: 'https://acme.wd5.myworkdayjobs.com', pathname: '/job/R1/apply/applyManually', vendor: 'workday' };

  /** 一次真实点击开出的一轮连填，和它往下翻的第一步。 */
  function runStep(): { run: AdvanceRun; step: AdvanceRunStep } {
    let run: AdvanceRun | null = null;
    clickFromOurShadow((event, shadowRoot) => {
      const proof = captureTrustedShadowGesture(event, shadowRoot);
      if (proof === null) return;
      const opened = openAdvanceRun({ proof, scope: SCOPE });
      if (opened.ok) run = opened.value.run;
    });
    if (run === null) throw new Error('run did not open');
    const step = beginAdvanceRunStep(run, SCOPE);
    if (!step.ok) throw new Error(step.code);
    return { run, step: step.value };
  }

  const chainPolicy = () => policy({ 'advance-step': true, 'advance-steps': true });

  it('这一步还算数、两位都开着 → 按宿主那一颗；整步换掉 → ADVANCED', async () => {
    const page = workdayPage();
    const click = vi.spyOn(page.next, 'click').mockImplementation(() => { setTimeout(goToMyExperience, 20); });
    const wizard = controller(async () => chainPolicy());
    wizard.arm({ descriptor: page.descriptor, policy: chainPolicy(), onLeft: () => {} });
    const { step } = runStep();
    expect(await wizard.advanceInRun(step)).toBe('ADVANCED');
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('宿主没翻（校验没过）→ NOT_ADVANCED', async () => {
    const page = workdayPage();
    vi.spyOn(page.next, 'click').mockImplementation(() => {});
    const wizard = controller(async () => chainPolicy());
    wizard.arm({ descriptor: page.descriptor, policy: chainPolicy(), onLeft: () => {} });
    expect(await wizard.advanceInRun(runStep().step)).toBe('NOT_ADVANCED');
  });

  it.each([
    ['连填位没开（后端还没发，缺席读作关）', { 'advance-step': true }],
    ['连填位开着、翻页位关了', { 'advance-step': false, 'advance-steps': true }],
  ] as const)('%s → 不按', async (_name, capabilities) => {
    const page = workdayPage();
    const click = vi.spyOn(page.next, 'click');
    const wizard = controller(async () => policy(capabilities));
    wizard.arm({ descriptor: page.descriptor, policy: chainPolicy(), onLeft: () => {} });
    expect(await wizard.advanceInRun(runStep().step)).toBe('UNAVAILABLE');
    expect(click).not.toHaveBeenCalled();
  });

  it('这一轮已经收场（用户按了「停止」）→ 不按', async () => {
    const page = workdayPage();
    const click = vi.spyOn(page.next, 'click');
    const wizard = controller(async () => chainPolicy());
    wizard.arm({ descriptor: page.descriptor, policy: chainPolicy(), onLeft: () => {} });
    const { run, step } = runStep();
    endAdvanceRun(run);
    expect(await wizard.advanceInRun(step)).toBe('UNAVAILABLE');
    expect(click).not.toHaveBeenCalled();
  });

  it('读开关的那一会儿用户按了「停止」→ 读回来之后再问一次这一步，不按', async () => {
    const page = workdayPage();
    const click = vi.spyOn(page.next, 'click');
    const { run, step } = runStep();
    const wizard = controller(async () => { endAdvanceRun(run); return chainPolicy(); });
    wizard.arm({ descriptor: page.descriptor, policy: chainPolicy(), onLeft: () => {} });
    expect(await wizard.advanceInRun(step)).toBe('UNAVAILABLE');
    expect(click).not.toHaveBeenCalled();
  });

  it('伪造的一步（同形状的对象）→ 不按', async () => {
    const page = workdayPage();
    const click = vi.spyOn(page.next, 'click');
    const wizard = controller(async () => chainPolicy());
    wizard.arm({ descriptor: page.descriptor, policy: chainPolicy(), onLeft: () => {} });
    expect(await wizard.advanceInRun(Object.freeze({}) as unknown as AdvanceRunStep)).toBe('UNAVAILABLE');
    expect(click).not.toHaveBeenCalled();
  });

  it('这一页上有规则声明的最终提交 → 从不替他往下翻（那是最后一页，提交只在他按「提交」之后）', async () => {
    const page = workdayPage();
    const click = vi.spyOn(page.next, 'click');
    const submit = document.createElement('button');
    submit.type = 'submit';
    document.body.append(submit);
    const descriptor = {
      ...page.descriptor,
      finalSubmitControl: { element: submit, form: document.createElement('form'), isCurrent: () => true },
    } as unknown as ApplyFormDescriptor;
    const wizard = controller(async () => chainPolicy());
    wizard.arm({ descriptor, policy: chainPolicy(), onLeft: () => {} });
    expect(await wizard.advanceInRun(runStep().step)).toBe('UNAVAILABLE');
    expect(click).not.toHaveBeenCalled();
  });

  it('chainAllowed：翻页、连填两位与厂商、时限缺一不可', () => {
    expect(chainAllowed(chainPolicy(), 'workday')).toBe(true);
    expect(chainAllowed(policy({ 'advance-step': true }), 'workday')).toBe(false);
    expect(chainAllowed(policy({ 'advance-steps': true }), 'workday')).toBe(false);
    expect(chainAllowed({ ...chainPolicy(), vendors: { ...chainPolicy().vendors, workday: false } }, 'workday')).toBe(false);
    expect(chainAllowed(null, 'workday')).toBe(false);
  });

  it('公司自己做的表（generic）不连填：翻页位开着也不，照旧每一页由他按「继续到下一页」', () => {
    const generic = { ...chainPolicy(), vendors: { ...chainPolicy().vendors, generic: true } };
    expect(advanceAllowed(generic, 'generic')).toBe(true);
    expect(chainAllowed(generic, 'generic')).toBe(false);
  });
});

describe('页面上那颗翻页按钮的情况（连填据此判断是不是最后一页）', () => {
  it('有唯一一颗 → ONE；没有（最后一步是 Submit）→ NONE；两颗 → AMBIGUOUS', () => {
    const page = workdayPage();
    const state = () => nextControlState({ document, descriptor: page.descriptor, isVisible: () => true });
    expect(state()).toBe('ONE');
    page.next.textContent = 'Submit';
    expect(state()).toBe('NONE');
    page.next.textContent = 'Next';
    const second = document.createElement('button');
    second.type = 'button';
    second.textContent = 'Continue';
    document.body.append(second);
    expect(state()).toBe('AMBIGUOUS');
  });

  it('arm 之后控制器自己也能答；没 arm 就是 UNARMED', () => {
    const page = workdayPage();
    const wizard = controller();
    expect(wizard.nextState()).toBe('UNARMED');
    wizard.arm({ descriptor: page.descriptor, policy: policy(), onLeft: () => {} });
    expect(wizard.nextState()).toBe('ONE');
  });
});
