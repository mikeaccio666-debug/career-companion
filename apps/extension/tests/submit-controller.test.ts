// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApplyFormDescriptor, FinalSubmitControlDescriptor } from '@edaix/apply-kernel/contracts';
import { createBundledApplyPolicy, type ApplyPolicy } from '@edaix/apply-kernel/policy';
import { createScanRoot } from '@edaix/apply-kernel/scanRoot';

import {
  arrivesAfterSubmit,
  DOCK_SUBMIT_PRESSED,
  DOCK_SUBMIT_SETTLED,
  isDockSubmitPressed,
  isDockSubmitSettled,
  JUST_SUBMITTED_MS,
} from '../lib/dockSubmitPressed';
import { createSubmitController, pageSaysSubmitted, submitAllowed } from '../lib/submitController';

/**
 * 在插件里提交（2026-09-23 负责人决定：「插件替用户点提交」）。
 *
 * 用户在浮层里按「提交」= 他本人确认；插件随后替他按网站上的最终提交。这里钉住四道闸
 * （真点击、远程开关、只按规则声明的那一颗、信封合上才按）与按完怎么判。
 */

class TrustedClick extends MouseEvent { get isTrusted() { return true; } }

afterEach(() => { document.body.innerHTML = ''; });

/** Greenhouse 式的一张表：一颗 native submit；单页应用，提交事件自己接住不整页跳。 */
function page(options: { declare?: boolean; jd?: string } = {}) {
  document.body.innerHTML = `
    <main>
      <section id="jd"><p>${options.jd ?? 'Build the future of voice chat.'}</p></section>
      <form id="application">
        <label for="fn">First Name</label><input id="fn" type="text" value="Ada" />
        <label for="ln">Last Name</label><input id="ln" type="text" value="Lovelace" />
        <button id="final" type="submit">Submit application</button>
      </form>
    </main>`;
  const form = document.querySelector<HTMLFormElement>('#application')!;
  const button = document.querySelector<HTMLButtonElement>('#final')!;
  form.addEventListener('submit', (event) => event.preventDefault());
  const clicks = vi.fn();
  button.addEventListener('click', clicks);
  const root = createScanRoot(form, []);
  const fields = ['fn', 'ln'].map((id) => ({
    kind: 'text', key: null, label: root.labelTextFor(document.getElementById(id)!), required: true, confidence: 1,
    element: document.getElementById(id)!, signature: {} as never,
  }));
  const finalSubmitControl: FinalSubmitControlDescriptor | null = options.declare === false ? null : {
    activation: 'native-submit',
    element: button,
    form,
    isCurrent: () => button.isConnected && button.form === form && button.type === 'submit',
  };
  const descriptor = { vendor: 'greenhouse', root, fields, finalSubmitControl } as unknown as ApplyFormDescriptor;
  return { descriptor, form, button, clicks };
}

function policy(overrides: Partial<ApplyPolicy['capabilities']> = { 'submit-application': true }): ApplyPolicy {
  const base = createBundledApplyPolicy();
  return {
    ...base,
    enabled: true,
    vendors: { ...base.vendors, greenhouse: true },
    capabilities: { ...base.capabilities, ...overrides },
    notAfter: Date.now() + 60_000,
  };
}

/** 一次点击：在我方 shadow root 里的一颗按钮上派发，监听器里当场交给 send。 */
function clickFromOurShadow<T>(run: (event: MouseEvent, shadowRoot: ShadowRoot) => T, trusted = true): T {
  const host = document.createElement('div');
  document.documentElement.append(host);
  const shadowRoot = host.attachShadow({ mode: 'closed' });
  const button = document.createElement('button');
  shadowRoot.append(button);
  let result: T | undefined;
  button.addEventListener('click', (event) => { result = run(event, shadowRoot); });
  button.dispatchEvent(trusted ? new TrustedClick('click', { bubbles: true, composed: true }) : new MouseEvent('click', { bubbles: true }));
  host.remove();
  return result as T;
}

function controller(options: {
  resolvePolicy?: () => Promise<ApplyPolicy | null>;
  onPressing?: () => void;
  onSettled?: () => void;
} = {}) {
  return createSubmitController({
    document,
    isVisible: () => true,
    resolvePolicy: options.resolvePolicy ?? (async () => policy()),
    ...(options.onPressing ? { onPressing: options.onPressing } : {}),
    ...(options.onSettled ? { onSettled: options.onSettled } : {}),
    pollMs: 5,
    settleMs: 300,
    rejectAfterMs: 40,
  });
}

const tick = (ms = 0) => new Promise((resolve) => { setTimeout(resolve, ms); });

describe('摆不摆「提交」：开关、声明、按钮本身', () => {
  it('远程开关、这一家、提交这一位都开着，规则声明了那一颗：能替用户按', () => {
    const { descriptor } = page();
    const submitter = controller();
    submitter.arm({ descriptor, policy: policy() });
    expect(submitter.available()).toBe(true);
  });

  it('后端没发 submit-application（缺席即关）：不摆', () => {
    const { descriptor } = page();
    const submitter = controller();
    submitter.arm({ descriptor, policy: policy({}) });
    expect(submitAllowed(policy({}), 'greenhouse')).toBe(false);
    expect(submitter.available()).toBe(false);
  });

  it('这一家的规则没声明最终提交（finalSubmitControl 为 null）：永远不按', () => {
    const { descriptor } = page({ declare: false });
    const submitter = controller();
    submitter.arm({ descriptor, policy: policy() });
    expect(submitter.available()).toBe(false);
  });

  it('按钮禁用着、或者没 arm：不摆', () => {
    const { descriptor, button } = page();
    const submitter = controller();
    expect(submitter.available(), '没 arm').toBe(false);
    submitter.arm({ descriptor, policy: policy() });
    button.disabled = true;
    expect(submitter.available()).toBe(false);
  });
});

describe('按：真点击、信封合上、再核一遍', () => {
  it('页面派发的点击：当场判否，网站的按钮一下都不碰', async () => {
    const { descriptor, clicks } = page();
    const submitter = controller();
    submitter.arm({ descriptor, policy: policy() });
    const outcome = clickFromOurShadow((event, root) => submitter.send(event, root, Promise.resolve()), false);
    expect(await outcome).toBe('UNTRUSTED');
    expect(clicks).not.toHaveBeenCalled();
  });

  it('不是来自我方 shadow 的真点击也不算', async () => {
    const { descriptor, clicks } = page();
    const submitter = controller();
    submitter.arm({ descriptor, policy: policy() });
    const other = document.createElement('div').attachShadow({ mode: 'open' });
    const outcome = clickFromOurShadow((event) => submitter.send(event, other, Promise.resolve()));
    expect(await outcome).toBe('UNTRUSTED');
    expect(clicks).not.toHaveBeenCalled();
  });

  it('信封合上之前不按；合上的那一刻才按，而且只按一次；按之前先告诉 worker', async () => {
    const { descriptor, clicks } = page();
    const order: string[] = [];
    clicks.mockImplementation(() => order.push('click'));
    const submitter = controller({ onPressing: () => order.push('pressing') });
    submitter.arm({ descriptor, policy: policy() });
    let close: () => void = () => {};
    const pressAt = new Promise<void>((resolve) => { close = resolve; });
    const outcome = clickFromOurShadow((event, root) => submitter.send(event, root, pressAt));
    await tick(30);
    expect(clicks, '信封还没合上').not.toHaveBeenCalled();
    expect(submitter.available(), '按的过程中不再摆第二次').toBe(false);
    close();
    await tick(10);
    expect(order).toEqual(['pressing', 'click']);
    document.querySelector('main')!.innerHTML = '<h1>Thank you for applying!</h1>';
    expect(await outcome).toBe('SUBMITTED');
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('按之前重新读一次开关：此刻关了（或读不到）就不按', async () => {
    const { descriptor, clicks } = page();
    const submitter = controller({ resolvePolicy: async () => null });
    submitter.arm({ descriptor, policy: policy() });
    const outcome = clickFromOurShadow((event, root) => submitter.send(event, root, Promise.resolve()));
    expect(await outcome).toBe('UNAVAILABLE');
    expect(clicks).not.toHaveBeenCalled();
  });

  it('动画的那几秒里网站把按钮换掉了（身份对不上）：不按', async () => {
    const { descriptor, button, clicks } = page();
    const submitter = controller();
    submitter.arm({ descriptor, policy: policy() });
    let close: () => void = () => {};
    const pressAt = new Promise<void>((resolve) => { close = resolve; });
    const outcome = clickFromOurShadow((event, root) => submitter.send(event, root, pressAt));
    button.type = 'button';
    close();
    expect(await outcome).toBe('UNAVAILABLE');
    expect(clicks).not.toHaveBeenCalled();
  });

  it('浮层换了一页（disarm）：信封合上时也不按', async () => {
    const { descriptor, clicks } = page();
    const submitter = controller();
    submitter.arm({ descriptor, policy: policy() });
    let close: () => void = () => {};
    const pressAt = new Promise<void>((resolve) => { close = resolve; });
    const outcome = clickFromOurShadow((event, root) => submitter.send(event, root, pressAt));
    submitter.disarm();
    close();
    expect(await outcome).toBe('UNAVAILABLE');
    expect(clicks).not.toHaveBeenCalled();
  });

  it('信封被拆掉（pressAt 拒绝）：不按', async () => {
    const { descriptor, clicks } = page();
    const submitter = controller();
    submitter.arm({ descriptor, policy: policy() });
    const outcome = clickFromOurShadow((event, root) => submitter.send(event, root, Promise.reject(new Error('cancelled'))));
    expect(await outcome).toBe('UNAVAILABLE');
    expect(clicks).not.toHaveBeenCalled();
  });
});

describe('按完怎么判', () => {
  it('职位描述里本来就写着「thank you for applying」：不算网站的回答；随后标红 → 网站没收', async () => {
    const { descriptor, form } = page({ jd: 'Thank you for applying to Discord — we read every one.' });
    const settled = vi.fn();
    const submitter = controller({ onSettled: settled });
    submitter.arm({ descriptor, policy: policy() });
    const outcome = clickFromOurShadow((event, root) => submitter.send(event, root, Promise.resolve()));
    await tick(15);
    form.querySelector('#fn')!.setAttribute('aria-invalid', 'true');
    expect(await outcome).toBe('NOT_SUBMITTED');
    expect(settled, '这一页自己等到了结论：让 worker 忘掉这个标签页').toHaveBeenCalledTimes(1);
  });

  it('表整个不见了、也没有确认的话：照实说还没看到确认', async () => {
    const { descriptor, form } = page();
    const submitter = controller();
    submitter.arm({ descriptor, policy: policy() });
    const outcome = clickFromOurShadow((event, root) => submitter.send(event, root, Promise.resolve()));
    await tick(10);
    form.remove();
    expect(await outcome).toBe('UNCONFIRMED');
  });

  it('等满了既没确认也没标红（比如网站弹出了人机验证）：还没看到确认，不说没收', async () => {
    const { descriptor } = page();
    const submitter = controller();
    submitter.arm({ descriptor, policy: policy() });
    const outcome = clickFromOurShadow((event, root) => submitter.send(event, root, Promise.resolve()));
    expect(await outcome).toBe('UNCONFIRMED');
  });

  /**
   * 2026-10-03 体检 3a-3：按下网站的提交之后、等结论的那几秒里出了错，从前一律答 UNAVAILABLE——浮层随之说「网站上的
   * 「提交」此刻按不了，请在网站上自己点」，而网站其实已经收到了那一下，他再点一次就是投了两份。按过了就只能说「还没看到
   * 网站的确认」（那一句请他先看一眼再决定要不要重新提交）。
   */
  it('已经按了网站的提交、之后读页面出错：说还没看到确认，不说按不了（免得他再投一份）', async () => {
    const { descriptor, button, clicks } = page();
    const settled = vi.fn();
    const submitter = controller({ onSettled: settled });
    submitter.arm({ descriptor, policy: policy() });
    // 网站一收到点击就开始拆这一页：之后再读页面上的字就抛。
    button.addEventListener('click', () => {
      Object.defineProperty(document.body, 'innerText', { configurable: true, get() { throw new Error('page is going away'); } });
    });
    try {
      const outcome = clickFromOurShadow((event, root) => submitter.send(event, root, Promise.resolve()));
      expect(await outcome).toBe('UNCONFIRMED');
      expect(clicks, '网站的提交按过一次').toHaveBeenCalledTimes(1);
      expect(settled, '这一页自己有了结论：让 worker 忘掉这个标签页').toHaveBeenCalledTimes(1);
    } finally {
      delete (document.body as { innerText?: unknown }).innerText;
    }
  });

  it('还没按就出了错（重读开关时抛了）：照旧说按不了，网站的按钮一下都没碰', async () => {
    const { descriptor, clicks } = page();
    const submitter = controller({ resolvePolicy: async () => { throw new Error('worker gone'); } });
    submitter.arm({ descriptor, policy: policy() });
    const outcome = clickFromOurShadow((event, root) => submitter.send(event, root, Promise.resolve()));
    expect(await outcome).toBe('UNAVAILABLE');
    expect(clicks).not.toHaveBeenCalled();
  });

  it('没按成（开关关着）：不报 settled——worker 那边本来就没有记号', async () => {
    const { descriptor } = page();
    const settled = vi.fn();
    const pressing = vi.fn();
    const submitter = controller({ resolvePolicy: async () => policy({}), onSettled: settled, onPressing: pressing });
    submitter.arm({ descriptor, policy: policy() });
    const outcome = clickFromOurShadow((event, root) => submitter.send(event, root, Promise.resolve()));
    expect(await outcome).toBe('UNAVAILABLE');
    expect(pressing).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
  });

  it('确认的话：中英常见说法都认；普通的一句 thank you 不认', () => {
    const say = (text: string) => { document.body.innerHTML = `<p>${text}</p>`; return pageSaysSubmitted(document); };
    expect(say('Your application has been submitted.')).toBe(true);
    expect(say('We’ve received your application')).toBe(true);
    expect(say('申请已提交')).toBe(true);
    expect(say('Thank you for your interest in Discord.')).toBe(false);
    expect(say('Thank you!')).toBe(false);
  });
});

describe('worker 记号：整页跳到确认页后，新一页才播「提交成功」', () => {
  const mark = { at: 1_000, documentId: 'doc-a' };

  it('另一份文档、90 秒内：到达', () => {
    expect(arrivesAfterSubmit(mark, 'doc-b', 2_000)).toBe('ARRIVED');
  });

  it('同一份文档又报到（用户切回了这个标签页）：不算到达，也不消耗', () => {
    expect(arrivesAfterSubmit(mark, 'doc-a', 2_000)).toBe('SAME_PAGE');
  });

  it('过了 90 秒、没有记号、或读不到文档身份：不播', () => {
    expect(arrivesAfterSubmit(mark, 'doc-b', 1_000 + JUST_SUBMITTED_MS + 1)).toBe('NONE');
    expect(arrivesAfterSubmit(undefined, 'doc-b', 2_000)).toBe('NONE');
    expect(arrivesAfterSubmit(mark, null, 2_000)).toBe('NONE');
    expect(arrivesAfterSubmit({ at: 1_000, documentId: null }, 'doc-b', 2_000)).toBe('NONE');
  });

  it('两声消息都不带页面内容，多一个键就不认', () => {
    expect(isDockSubmitPressed(DOCK_SUBMIT_PRESSED)).toBe(true);
    expect(isDockSubmitSettled(DOCK_SUBMIT_SETTLED)).toBe(true);
    expect(isDockSubmitPressed({ ...DOCK_SUBMIT_PRESSED, url: 'https://example.test' })).toBe(false);
    expect(isDockSubmitSettled(DOCK_SUBMIT_PRESSED)).toBe(false);
  });
});
