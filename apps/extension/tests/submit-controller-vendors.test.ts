// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { installBundledApplyAdapters } from '@edaix/apply-kernel/bundledAdapters';
import type { ApplyFormDescriptor, ApplyVendor } from '@edaix/apply-kernel/contracts';
import { createBundledApplyPolicy, type ApplyPolicy } from '@edaix/apply-kernel/policy';
import { readApplyForm } from '@edaix/apply-kernel/registry';

import { createSubmitController } from '../lib/submitController';

installBundledApplyAdapters();

/**
 * 在浮层里提交的厂商（2026-10-04 负责人：Greenhouse、Workable 之外再开几家）——按之前那几道闸的演练。
 *
 * 夹具与内核测试同一份（照 2026-10-04 真实在招岗位只读实测手写，只有结构，没有任何人的资料）。真实网站上只演练到按之前
 * 那一刻：负责人决定绝不在真实网站上按提交，真按只发生在他本人投自己想投的岗位时。这里在夹具上验：
 *  · 规则声明了、开关开着、那一颗此刻可用：摆「提交」；
 *  · 按的只是规则声明的那一颗、只按一次、走它自己的激活（网站收到的提交者就是那一颗）；
 *  · 网站把它禁用着（必填没填好）就不摆，放开之后再认一次才摆；那一颗多了、变了，当场不按；
 *  · 规则没声明的厂商永远不摆（浮层照旧请他去网站上点）。
 */

const fixture = (path: string): string =>
  readFileSync(resolve(__dirname, '../../../packages/apply-kernel/tests/fixtures', path), 'utf8');

class TrustedClick extends MouseEvent { get isTrusted() { return true; } }

afterEach(() => { document.body.innerHTML = ''; });

function policy(vendor: ApplyVendor): ApplyPolicy {
  const base = createBundledApplyPolicy();
  return {
    ...base,
    enabled: true,
    vendors: { ...base.vendors, [vendor]: true },
    capabilities: { ...base.capabilities, 'submit-application': true },
    notAfter: Date.now() + 60_000,
  };
}

function controller(vendor: ApplyVendor) {
  return createSubmitController({
    document,
    isVisible: () => true,
    resolvePolicy: async () => policy(vendor),
    pollMs: 5,
    settleMs: 120,
    rejectAfterMs: 40,
  });
}

/** 一次点击：在我方 shadow root 里的一颗按钮上派发，监听器里当场交给 send。 */
function clickFromOurShadow<T>(run: (event: MouseEvent, shadowRoot: ShadowRoot) => T): T {
  const host = document.createElement('div');
  document.documentElement.append(host);
  const shadowRoot = host.attachShadow({ mode: 'closed' });
  const button = document.createElement('button');
  shadowRoot.append(button);
  let result: T | undefined;
  button.addEventListener('click', (event) => { result = run(event, shadowRoot); });
  button.dispatchEvent(new TrustedClick('click', { bubbles: true, composed: true }));
  host.remove();
  return result as T;
}

function mounted(vendor: ApplyVendor, path: string): ApplyFormDescriptor {
  document.body.innerHTML = fixture(path);
  // 宿主自己的提交处理：夹具里不让它真的离开这一页。
  for (const form of Array.from(document.querySelectorAll('form'))) form.addEventListener('submit', (event) => event.preventDefault());
  const descriptor = readApplyForm(vendor);
  expect(descriptor, `${vendor} 的表要认得出来`).not.toBeNull();
  return descriptor!;
}

/** 数这一页上每一颗按钮被按了几下（只数，不改它的行为）。 */
function countClicks(): Map<Element, number> {
  const clicks = new Map<Element, number>();
  for (const button of Array.from(document.querySelectorAll('button'))) {
    button.addEventListener('click', () => { clicks.set(button, (clicks.get(button) ?? 0) + 1); });
  }
  return clicks;
}

describe('Dover：按之前那几道闸', () => {
  it('规则声明了、开关开着：摆「提交」；按的只是表里那一颗「Apply」，只按一次，走它自己的激活', async () => {
    const descriptor = mounted('dover', 'dover/final-submit.html');
    const submitter = controller('dover');
    submitter.arm({ descriptor, policy: policy('dover') });
    expect(submitter.available()).toBe(true);

    const clicks = countClicks();
    const form = document.querySelector('form')!;
    const submitters: (Element | null)[] = [];
    form.addEventListener('submit', (event) => { submitters.push((event as SubmitEvent).submitter ?? null); });
    const outcome = await clickFromOurShadow((event, root) => submitter.send(event, root, Promise.resolve()));
    const apply = document.querySelector('form button[type="submit"]')!;
    expect([...clicks.entries()].filter(([, count]) => count > 0).map(([button]) => button)).toEqual([apply]);
    expect(clicks.get(apply)).toBe(1);
    // 走的是那一颗按钮自己的激活：网站收到一次提交，提交者就是那一颗（随包字节里没有表单的提交方法，另有字节闸）。
    expect(submitters).toEqual([apply]);
    // 夹具里的表不会换成确认页：照实说还没看到确认。
    expect(outcome).toBe('UNCONFIRMED');
  });

  it('信封合上之前表里多了一颗原生提交：当场不按，一下都不碰', async () => {
    const descriptor = mounted('dover', 'dover/final-submit.html');
    const submitter = controller('dover');
    submitter.arm({ descriptor, policy: policy('dover') });
    const clicks = countClicks();
    let close: () => void = () => {};
    const pressAt = new Promise<void>((resolve) => { close = resolve; });
    const pending = clickFromOurShadow((event, root) => submitter.send(event, root, pressAt));
    const extra = document.createElement('button');
    extra.type = 'submit';
    document.querySelector('form')!.append(extra);
    close();
    expect(await pending).toBe('UNAVAILABLE');
    expect([...clicks.values()].reduce((sum, count) => sum + count, 0)).toBe(0);
  });
});

describe('Rippling：网站放开之前不摆，放开之后才摆；写着 Continue 的永远不摆', () => {
  const enable = (): void => {
    const button = document.querySelector('button[type="submit"]')!;
    button.setAttribute('data-disabled', 'false');
    button.removeAttribute('aria-disabled');
  };

  it('扫描那一刻 aria-disabled：不摆；网站放开之后再认一次就摆，按的是那一颗', async () => {
    const descriptor = mounted('rippling', 'rippling/final-submit.html');
    expect(descriptor.finalSubmitControl).toBeNull();
    const submitter = controller('rippling');
    submitter.arm({ descriptor, policy: policy('rippling') });
    expect(submitter.available()).toBe(false);

    enable();
    expect(submitter.available()).toBe(true);
    const clicks = countClicks();
    const outcome = await clickFromOurShadow((event, root) => submitter.send(event, root, Promise.resolve()));
    expect(clicks.get(document.querySelector('button[type="submit"]')!)).toBe(1);
    expect(outcome).toBe('UNCONFIRMED');
  });

  it('放开之后又禁用了（他清空了一栏）：不摆，按下去也不按', async () => {
    const descriptor = mounted('rippling', 'rippling/final-submit.html');
    const submitter = controller('rippling');
    submitter.arm({ descriptor, policy: policy('rippling') });
    enable();
    expect(submitter.available()).toBe(true);
    document.querySelector('button[type="submit"]')!.setAttribute('aria-disabled', 'true');
    expect(submitter.available()).toBe(false);
    const clicks = countClicks();
    expect(await clickFromOurShadow((event, root) => submitter.send(event, root, Promise.resolve()))).toBe('UNAVAILABLE');
    expect([...clicks.values()].reduce((sum, count) => sum + count, 0)).toBe(0);
  });

  it('按钮写着 Continue（后面还有页）：那是翻页，放开了也不摆', () => {
    const descriptor = mounted('rippling', 'rippling/final-submit.html');
    const button = document.querySelector('button[type="submit"]')!;
    button.setAttribute('data-testid', 'Continue');
    button.textContent = 'Continue';
    enable();
    const submitter = controller('rippling');
    submitter.arm({ descriptor, policy: policy('rippling') });
    expect(submitter.available()).toBe(false);
  });
});

describe('BambooHR：表外操作栏里的「Submit Application」', () => {
  it('摆「提交」；按的是用 form 属性认领这张表的那一颗，同一栏的 Cancel 一下都不碰', async () => {
    const descriptor = mounted('bamboohr', 'bamboohr/final-submit.html');
    const submitter = controller('bamboohr');
    submitter.arm({ descriptor, policy: policy('bamboohr') });
    expect(submitter.available()).toBe(true);
    const clicks = countClicks();
    await clickFromOurShadow((event, root) => submitter.send(event, root, Promise.resolve()));
    const declared = document.querySelector('button[form="job-application-form"]')!;
    const cancel = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Cancel')!;
    expect(clicks.get(declared)).toBe(1);
    expect(clicks.get(cancel) ?? 0).toBe(0);
  });

  it('页面上又多了一颗认领这张表的原生提交：不摆，按下去也不按', async () => {
    const descriptor = mounted('bamboohr', 'bamboohr/final-submit.html');
    const submitter = controller('bamboohr');
    submitter.arm({ descriptor, policy: policy('bamboohr') });
    const twin = document.createElement('button');
    twin.type = 'submit';
    twin.setAttribute('form', 'job-application-form');
    document.body.append(twin);
    expect(submitter.available()).toBe(false);
    const clicks = countClicks();
    expect(await clickFromOurShadow((event, root) => submitter.send(event, root, Promise.resolve()))).toBe('UNAVAILABLE');
    expect([...clicks.values()].reduce((sum, count) => sum + count, 0)).toBe(0);
  });
});

describe('规则没声明最终提交的厂商：永远不摆（浮层照旧请他去网站上点）', () => {
  it.each([
    ['lever', 'lever/application-form.html'],
    ['ashby', 'ashby/application-form.html'],
    ['jobvite', 'jobvite/application-form.html'],
  ] as const)('%s', (vendor, path) => {
    document.body.innerHTML = fixture(path);
    const descriptor = readApplyForm(vendor);
    if (descriptor === null) return;
    expect(descriptor.finalSubmitControl ?? null).toBeNull();
    expect(descriptor.resolveFinalSubmitControl?.() ?? null).toBeNull();
    const submitter = controller(vendor);
    submitter.arm({ descriptor, policy: policy(vendor) });
    expect(submitter.available()).toBe(false);
  });
});
