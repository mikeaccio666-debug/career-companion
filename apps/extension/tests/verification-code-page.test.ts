// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ADAPTERS, installBundledApplyAdapters } from '@edaix/apply-kernel/bundledAdapters';
import type { ApplyFormDescriptor, FinalSubmitControlDescriptor } from '@edaix/apply-kernel/contracts';
import { createBundledApplyPolicy, type ApplyPolicy } from '@edaix/apply-kernel/policy';
import { readApplyForm } from '@edaix/apply-kernel/registry';
import type { ResolvedRuntimeApplyAdapter } from '@edaix/apply-kernel/runtimeRegistry';
import { workdayAdapter } from '@edaix/apply-kernel/sites/workday';

import { mountAutofillDock, type AutofillDockHandle, type DockCodePrompt } from '../lib/autofillDock';
import { dockCopy } from '../lib/dock/copy';
import type { ResolvedContentDiscoveryRuntimeAuthority } from '../lib/executionRuntimeAuthority';
import { createSubmitController } from '../lib/submitController';
import { createVerificationCodePage } from '../lib/verificationCodePage';

installBundledApplyAdapters();

/**
 * 验证码第 1 步的整条链（2026-10-04，负责人：网站把验证码发到他的邮箱，他在浮层里输或粘贴，插件写进网站那一格）：内容脚本
 * 那一侧的真模块（lib/verificationCodePage.ts、lib/submitController.ts）、真浮层、真内核与随包规则，夹具照 Greenhouse 公开的
 * 前端代码手写。网站那一侧用夹具上挂的提交处理模拟：第一次提交回「要验证码」、填满之后再提交回成功或「不对」。
 *
 * 钉住：网站要验证码 → 浮层换成那张卡；他在卡上输 → 写进那 8 格、一下都没按网站的提交；他再按浮层里的「提交」→ 才替他按
 * 规则声明的那一颗；验证码不对 → 卡上说不对、让他再输；插件从头到尾不读邮件、不自己取码。
 */

const fixture = (path: string): string =>
  readFileSync(resolve(__dirname, '../../../packages/apply-kernel/tests/fixtures', path), 'utf8');
class TrustedClick extends MouseEvent { get isTrusted() { return true; } }
const click = (node: Element | null | undefined) => node?.dispatchEvent(new TrustedClick('click', { bubbles: true, composed: true }));
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });
async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}
const ZH = dockCopy('zh').emailCode;

const originalMatchMedia = window.matchMedia;
beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion'), media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  window.matchMedia = originalMatchMedia;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function policy(over: Partial<ApplyPolicy['capabilities']> = {}): ApplyPolicy {
  const base = createBundledApplyPolicy();
  return {
    ...base,
    enabled: true,
    vendors: { ...base.vendors, greenhouse: true },
    capabilities: { ...base.capabilities, 'set-text': true, 'submit-application': true, ...over },
    notAfter: Date.now() + 60_000,
  };
}

function runtime(vendor: 'greenhouse' | 'workday', fill: ApplyPolicy = policy()): ResolvedContentDiscoveryRuntimeAuthority {
  const adapter = vendor === 'greenhouse' ? ADAPTERS.greenhouse : workdayAdapter;
  const mapping = { atsProvider: vendor.toUpperCase(), vendor, adapter } as unknown as ResolvedRuntimeApplyAdapter;
  return { mapping, hostPolicy: createBundledApplyPolicy(), fillPolicy: fill } as unknown as ResolvedContentDiscoveryRuntimeAuthority;
}

/**
 * 夹具：一张 Greenhouse 表。网站那一侧（挂在提交钮的点击上，与 Greenhouse 的提交处理同一个形状）：第一次按提交 →
 * 把「Security code」那一块挂出来（反垃圾判成可疑）；
 * 8 格填满之后再按 → 按 `answer` 回成功（表换成确认）或「验证码不对」。
 */
function site(answer: 'OK' | 'WRONG') {
  document.body.innerHTML = fixture('greenhouse/security-code.html');
  const block = document.querySelector('.email-verification')!;
  block.remove();
  const form = document.querySelector<HTMLFormElement>('form#application-form')!;
  const submitButton = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  let presses = 0;
  // 与 Greenhouse 一样：提交钮自己的点击处理先 preventDefault、再用脚本交表（原生的表单校验与提交都不走）。
  submitButton.addEventListener('click', (event) => {
    event.preventDefault();
    presses += 1;
    const boxes = Array.from(document.querySelectorAll<HTMLInputElement>('input[id^="security-input-"]'));
    if (boxes.length === 0) {
      submitButton.before(block);
      return;
    }
    if (boxes.map((box) => box.value).join('').length !== 8) return;
    if (answer === 'OK') {
      form.replaceWith(Object.assign(document.createElement('h1'), { textContent: 'Thank you for applying.' }));
      return;
    }
    document.querySelector('#email-verification-error')?.remove();
    const error = Object.assign(document.createElement('p'), { id: 'email-verification-error', textContent: 'The security code you entered is invalid.' });
    document.querySelector('.email-verification')!.append(error);
  });
  return { form, submitButton, presses: () => presses };
}

function wire(answer: 'OK' | 'WRONG', fill: ApplyPolicy = policy()) {
  const page = site(answer);
  let dock: AutofillDockHandle | null = null;
  const prompts: (DockCodePrompt | null)[] = [];
  const codePage = createVerificationCodePage({
    doc: document,
    here: () => ({ hostname: 'job-boards.greenhouse.io', pathname: '/example/jobs/4000000001' }),
    vendor: 'greenhouse',
    isTopFrame: true,
    isVisible: () => true,
    discovery: async () => runtime('greenhouse', fill),
    dock: () => (dock === null ? null : {
      ...dock,
      codePrompt: (prompt: DockCodePrompt | null) => { prompts.push(prompt); dock!.codePrompt(prompt); },
    } as AutofillDockHandle),
    site: () => 'Example Co 的 Greenhouse',
    setInterval: () => 0,
    clearInterval: () => {},
  });
  const descriptor = readApplyForm('greenhouse') as ApplyFormDescriptor;
  expect(descriptor?.finalSubmitControl).not.toBeNull();
  const submitter = createSubmitController({
    document,
    isVisible: () => true,
    resolvePolicy: async () => fill,
    codePrompt: () => codePage.mark(),
    pollMs: 5,
    settleMs: 400,
    rejectAfterMs: 60,
  });
  submitter.arm({ descriptor, policy: fill });
  dock = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, {
    onAutofill: () => {},
    onOpenEntry: () => {},
    vendorLabel: 'Greenhouse',
    verificationCode: codePage.handlers,
    submission: {
      available: () => submitter.available(),
      send: (event, shadowRoot, pressAt) => {
        const sent = submitter.send(event, shadowRoot, pressAt);
        void sent.then((outcome) => { if (outcome === 'CODE_REQUIRED') codePage.refresh(); });
        return sent;
      },
    },
  }, document);
  dock.openPanel();
  dock.beginRun({ runId: 'fill-1', requiredCompleted: 1, requiredQuestions: 1, rows: [{ label: 'First Name', required: true, done: true, state: 'CONFIRMED', value: 'Ada' }], phase: 'SETTLED' } as never);
  codePage.start();
  const root = () => dock!.sceneRoot()!.getRootNode() as ShadowRoot;
  const q = <T extends Element = HTMLElement>(selector: string) => root().querySelector<T & HTMLElement>(selector);
  return { ...page, dock: () => dock!, codePage, submitter, prompts, q };
}

function boxes(): string {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[id^="security-input-"]')).map((box) => box.value).join('');
}

describe('网站要验证码 → 他在浮层里输 → 他再按「提交」', () => {
  it('第一次按「提交」：网站要验证码，浮层换成那张卡（不亮红条）；那几格空着时不会再按网站的提交', async () => {
    const page = wire('OK');
    click(page.dock().primaryButton());
    await until(() => page.q('[data-code="ask"]') !== null);
    expect(page.presses()).toBe(1);
    expect(page.prompts.at(-1)?.recipient).toBe('a••••@e••••.test');
    expect(page.prompts.at(-1)?.mail.from[0]).toBe('no-reply@us.greenhouse-mail.io');
    // 卡在、验证码没填：再按「提交」，不按网站的提交（网站也不会收），还是这张卡。
    await until(() => page.dock().primaryButton()?.textContent === '提交');
    click(page.dock().primaryButton());
    await settle();
    await until(() => page.q('[data-code="ask"]') !== null);
    expect(page.presses()).toBe(1);
  });

  it('他在卡上粘贴验证码、按「填进网站」：写进那 8 格，一下都不按网站的提交；他再按「提交」才替他按，网站收下了', async () => {
    const page = wire('OK');
    click(page.dock().primaryButton());
    await until(() => page.q('[data-code="input"]') !== null);
    const input = page.q<HTMLInputElement>('[data-code="input"]')!;
    input.value = 'ab12-CD34';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    click(page.q('[data-action="code-enter"]'));
    await until(() => page.q('[data-code="filled"]') !== null);
    expect(boxes()).toBe('ab12CD34');
    expect(page.presses(), '填了验证码不等于提交').toBe(1);
    expect(page.q('[data-code="filled"]')?.textContent).toContain(ZH.filled.resubmitHere);

    await until(() => page.dock().primaryButton()?.textContent === '提交');
    click(page.dock().primaryButton());
    await until(() => document.body.textContent?.includes('Thank you for applying.') === true);
    expect(page.presses()).toBe(2);
  });

  it('验证码不对：卡上说不对、照登网站的原话，让他再输', async () => {
    const page = wire('WRONG');
    click(page.dock().primaryButton());
    await until(() => page.q('[data-code="input"]') !== null);
    const input = page.q<HTMLInputElement>('[data-code="input"]')!;
    input.value = 'AB12CD34';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    click(page.q('[data-action="code-enter"]'));
    await until(() => page.q('[data-code="filled"]') !== null);
    await until(() => page.dock().primaryButton()?.textContent === '提交');
    click(page.dock().primaryButton());
    await until(() => page.q('[data-code="WRONG"]') !== null);
    expect(page.q('[data-code="site-says"]')?.textContent).toBe(ZH.siteSays('The security code you entered is invalid.'));
    expect(page.q('[data-code="input"]')).not.toBeNull();
    expect(page.presses()).toBe(2);
  });
});

describe('写不写：只认他在浮层里的真实点击，开关关着就不写', () => {
  function shown(): void {
    document.body.innerHTML = fixture('greenhouse/security-code.html');
  }
  function codePageFor(fill: ApplyPolicy | null) {
    const prompts: (DockCodePrompt | null)[] = [];
    const page = createVerificationCodePage({
      doc: document,
      here: () => ({ hostname: 'job-boards.greenhouse.io', pathname: '/example/jobs/4000000001' }),
      vendor: 'greenhouse',
      isTopFrame: true,
      isVisible: () => true,
      discovery: async () => (fill === null ? null : runtime('greenhouse', fill)),
      dock: () => ({ codePrompt: (prompt: DockCodePrompt | null) => { prompts.push(prompt); } }) as unknown as AutofillDockHandle,
      site: () => 'Example Co 的 Greenhouse',
      setInterval: () => 0,
      clearInterval: () => {},
    });
    return { page, prompts };
  }
  function fromOurShadow<T>(run: (event: MouseEvent, shadowRoot: ShadowRoot) => T, trusted = true): T {
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

  it('看着这一页：网站开始要验证码就交给浮层，不要了就收起；mark() 给提交控制器同一个说法', () => {
    document.body.innerHTML = fixture('greenhouse/security-code.html');
    const block = document.querySelector('.email-verification')!;
    block.remove();
    const { page, prompts } = codePageFor(policy());
    page.start();
    expect(prompts).toEqual([]);
    expect(page.mark()).toBeNull();
    document.querySelector('button[type="submit"]')!.before(block);
    page.refresh();
    expect(prompts.at(-1)?.length).toBe(8);
    expect(page.mark()).toEqual({ filled: false, error: null });
    block.remove();
    page.refresh();
    expect(prompts.at(-1)).toBeNull();
    page.dispose();
  });

  it('页面派发的点击：UNTRUSTED，一格都不碰', async () => {
    shown();
    const { page } = codePageFor(policy());
    const outcome = await fromOurShadow((event, root) => page.handlers.enter('AB12CD34', event, root), false);
    expect(outcome).toBe('UNTRUSTED');
    expect(boxes()).toBe('');
  });

  it('写策略没开（set-text 关着）、拿不到这一页的授权：OFF，一格都不碰', async () => {
    shown();
    expect(await fromOurShadow((event, root) => codePageFor(policy({ 'set-text': false })).page.handlers.enter('AB12CD34', event, root))).toBe('OFF');
    expect(await fromOurShadow((event, root) => codePageFor(null).page.handlers.enter('AB12CD34', event, root))).toBe('OFF');
    expect(boxes()).toBe('');
  });

  it('位数不对：FORMAT；网站此刻不在要验证码：GONE', async () => {
    shown();
    expect(await fromOurShadow((event, root) => codePageFor(policy()).page.handlers.enter('AB12', event, root))).toBe('FORMAT');
    document.querySelector('.email-verification')!.remove();
    expect(await fromOurShadow((event, root) => codePageFor(policy()).page.handlers.enter('AB12CD34', event, root))).toBe('GONE');
  });

  it('写上了：FILLED；没有任何点击、键盘或提交事件落到网页上', async () => {
    shown();
    // 只数落在网站那张表里的事件（我们自己浮层里的那一下点击不算）。
    const form = document.querySelector('form#application-form')!;
    const seen: string[] = [];
    for (const type of ['click', 'submit', 'keydown', 'keyup', 'input']) {
      document.addEventListener(type, (event) => { if (event.target instanceof Node && form.contains(event.target)) seen.push(event.type); }, true);
    }
    const { page } = codePageFor(policy());
    const outcome = await fromOurShadow((event, root) => page.handlers.enter('ＡＢ１２ ＣＤ３４', event, root));
    expect(outcome).toBe('FILLED');
    expect(boxes()).toBe('AB12CD34');
    // 8 格各一个 input 事件（网站据此收下这一格）；没有任何点击、提交或键盘事件。
    expect(seen).toEqual(Array(8).fill('input'));
  });

  it('Workday：规则没声明验证码格（验证是点链接），这一套什么都不交给浮层', () => {
    document.body.innerHTML = fixture('greenhouse/security-code.html');
    const prompts: (DockCodePrompt | null)[] = [];
    const page = createVerificationCodePage({
      doc: document,
      here: () => ({ hostname: 'example.wd5.myworkdayjobs.com', pathname: '/en-US/External/job/X/apply' }),
      vendor: 'workday',
      isTopFrame: true,
      isVisible: () => true,
      discovery: async () => runtime('workday'),
      dock: () => ({ codePrompt: (prompt: DockCodePrompt | null) => { prompts.push(prompt); } }) as unknown as AutofillDockHandle,
      site: () => 'Example 的 Workday',
      setInterval: () => 0,
      clearInterval: () => {},
    });
    page.start();
    page.refresh();
    expect(prompts).toEqual([]);
    expect(page.mark()).toBeNull();
  });
});

describe('提交控制器：网站要验证码时不干等', () => {
  it('按了之后验证码提示冒出来：CODE_REQUIRED（不等满 settle）', async () => {
    const page = wire('OK');
    const descriptor = readApplyForm('greenhouse') as ApplyFormDescriptor;
    const control = descriptor.finalSubmitControl as FinalSubmitControlDescriptor;
    expect(control.element).toBe(page.submitButton);
    const submitter = createSubmitController({
      document,
      isVisible: () => true,
      resolvePolicy: async () => policy(),
      codePrompt: () => page.codePage.mark(),
      pollMs: 5,
      settleMs: 5_000,
      rejectAfterMs: 60,
    });
    submitter.arm({ descriptor, policy: policy() });
    const started = Date.now();
    const host = document.createElement('div');
    document.documentElement.append(host);
    const shadowRoot = host.attachShadow({ mode: 'closed' });
    const button = document.createElement('button');
    shadowRoot.append(button);
    let pending: Promise<unknown> = Promise.resolve();
    button.addEventListener('click', (event) => { pending = submitter.send(event, shadowRoot, Promise.resolve()); });
    button.dispatchEvent(new TrustedClick('click', { bubbles: true, composed: true }));
    expect(await pending).toBe('CODE_REQUIRED');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
