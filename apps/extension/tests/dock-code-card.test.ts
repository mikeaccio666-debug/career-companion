// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  mountAutofillDock,
  type AutofillDockFieldRow,
  type AutofillDockHandlers,
  type DockCodeOutcome,
  type DockCodePrompt,
  type DockSubmitOutcome,
} from '../lib/autofillDock';
import { dockCopy } from '../lib/dock/copy';

/**
 * 浮层上的验证码卡（2026-10-04，负责人：验证码第 1 步）。网站把验证码发到他的邮箱、要他填进这一页：
 *  · 一张卡说清发生了什么、去哪个收件箱找哪一封（发件人、标题开头）、要几位；
 *  · 卡上那一格里他自己输或粘贴，按「填进网站」——那一下点击原样交给调用方（它当场取证），写上之后只说下一步：
 *    再按一次「提交」（还是要他按），或者去网站上点；插件不因为填了验证码就提交；
 *  · 网站说验证码不对、过期了、试太多次：换一句话，照登网站的原话，让他再输；
 *  · 按了提交、网站要的是验证码：不亮红条、不弹提示，换成这张卡。
 */

class TrustedClick extends MouseEvent { get isTrusted() { return true; } }
const click = (node: Element | null | undefined) => node?.dispatchEvent(new TrustedClick('click', { bubbles: true, composed: true }));
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });
const ZH = dockCopy('zh').emailCode;
const EN = dockCopy('en').emailCode;
const INBOX = ['ada', 'example.test'].join('@');

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

function prompt(over: Partial<DockCodePrompt> = {}): DockCodePrompt {
  return {
    site: 'Example Co 的 Greenhouse',
    recipient: INBOX,
    mail: { from: ['no-reply@us.greenhouse-mail.io', 'no-reply@eu.greenhouse-mail.io'], subject: 'Security code for your application to' },
    length: 8,
    charset: 'ALPHANUMERIC',
    next: 'RESUBMIT',
    error: null,
    siteSays: null,
    filled: false,
    ...over,
  };
}

const ROWS: AutofillDockFieldRow[] = [
  { label: 'First Name', required: true, done: true, state: 'CONFIRMED', value: 'Ada' },
];

function mount(extra: Partial<AutofillDockHandlers> = {}, options: { run?: boolean; open?: boolean } = {}) {
  const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, {
    onAutofill: () => {},
    onOpenEntry: () => {},
    vendorLabel: 'Greenhouse',
    ...extra,
  }, document);
  if (options.open !== false) handle.openPanel();
  if (options.run === true) handle.beginRun({ runId: 'fill-1', requiredCompleted: 1, requiredQuestions: 1, rows: ROWS, phase: 'SETTLED' } as never);
  const root = () => handle.sceneRoot()!.getRootNode() as ShadowRoot;
  const q = <T extends Element = HTMLElement>(selector: string) => root().querySelector<T & HTMLElement>(selector);
  return { handle, root, q };
}

function type(input: HTMLInputElement | null, value: string): void {
  input!.value = value;
  input!.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('网站要邮件里的验证码：一张卡说清楚', () => {
  it('说发生了什么、去哪个收件箱找哪一封（发件人、标题开头）、要几位；卡上一格、一颗「填进网站」，并说明我们不读邮件', () => {
    const enter = vi.fn(async (): Promise<DockCodeOutcome> => 'FILLED');
    const { handle, q } = mount({ verificationCode: { enter } });
    handle.codePrompt(prompt());
    const card = q('[data-code="ask"]');
    expect(card?.textContent).toContain(ZH.title);
    expect(card?.textContent).toContain(ZH.ask('Example Co 的 Greenhouse', INBOX, 'no-reply@us.greenhouse-mail.io', true, 'Security code for your application to', 8));
    expect(card?.textContent).toContain(INBOX);
    expect(card?.textContent).toContain('no-reply@us.greenhouse-mail.io');
    expect(card?.textContent).toContain(ZH.privacy);
    expect(q<HTMLInputElement>('[data-code="input"]')?.placeholder).toBe(ZH.placeholder(8, false));
    expect(q('[data-action="code-enter"]')?.textContent).toBe(ZH.enter);
  });

  it('读不出发到哪个邮箱：改说「你申请时填的邮箱」', () => {
    const { handle, q } = mount({ verificationCode: { enter: vi.fn(async (): Promise<DockCodeOutcome> => 'FILLED') } });
    handle.codePrompt(prompt({ recipient: null }));
    expect(q('[data-code="ask"]')?.textContent).toContain('你申请时填的邮箱');
  });

  it('面板收着时网站开始要验证码：面板打开（不用他找）', () => {
    const { handle } = mount({ verificationCode: { enter: vi.fn(async (): Promise<DockCodeOutcome> => 'FILLED') } }, { open: false });
    expect(handle.isOpen()).toBe(false);
    handle.codePrompt(prompt());
    expect(handle.isOpen()).toBe(true);
  });

  it('网站不再要了（null）：卡收起', () => {
    const { handle, q } = mount({ verificationCode: { enter: vi.fn(async (): Promise<DockCodeOutcome> => 'FILLED') } });
    handle.codePrompt(prompt());
    expect(q('[data-code="ask"]')).not.toBeNull();
    handle.codePrompt(null);
    expect(q('[data-code]')).toBeNull();
  });

  it('没接「填进网站」（老调用方）：只有那几句话，没有输入框', () => {
    const { handle, q } = mount();
    handle.codePrompt(prompt());
    expect(q('[data-code="ask"]')?.textContent).toContain(ZH.title);
    expect(q('[data-code="input"]')).toBeNull();
  });
});

describe('他在卡上输、按「填进网站」', () => {
  it('那一下点击当场交给调用方（连同他输的那一串与我方 shadow）；写上之后说「已填进网站」，下一步是按下面的「提交」', async () => {
    const enter = vi.fn(async (): Promise<DockCodeOutcome> => 'FILLED');
    const submission = { available: () => true, send: vi.fn(async (): Promise<DockSubmitOutcome> => 'SUBMITTED') };
    const { handle, q, root } = mount({ verificationCode: { enter }, submission }, { run: true });
    handle.codePrompt(prompt());
    type(q<HTMLInputElement>('[data-code="input"]'), 'AB12 CD34');
    click(q('[data-action="code-enter"]'));
    expect(enter).toHaveBeenCalledTimes(1);
    const [code, event, shadow] = enter.mock.calls[0]! as unknown as [string, MouseEvent, ShadowRoot];
    expect(code).toBe('AB12 CD34');
    expect(event.isTrusted).toBe(true);
    expect(shadow).toBe(root());
    await settle();
    await settle();
    const card = q('[data-code="filled"]');
    expect(card?.textContent).toContain(ZH.filled.title);
    expect(card?.textContent).toContain(ZH.filled.resubmitHere);
    expect(q('[data-code="input"]')).toBeNull();
    // 填了验证码不等于提交：没有替他按「提交」。
    expect(submission.send).not.toHaveBeenCalled();
    expect(handle.primaryButton()?.textContent).toBe('提交');
  });

  it('浮层这一轮没有「提交」可按（他是在网站上按的提交）：下一步说去网站上再按一次提交', async () => {
    const enter = vi.fn(async (): Promise<DockCodeOutcome> => 'FILLED');
    const { handle, q } = mount({ verificationCode: { enter } });
    handle.codePrompt(prompt());
    type(q<HTMLInputElement>('[data-code="input"]'), 'AB12CD34');
    click(q('[data-action="code-enter"]'));
    await settle();
    await settle();
    expect(q('[data-code="filled"]')?.textContent).toContain(ZH.filled.resubmitOnSite);
  });

  it('网站要的是按验证钮（verify）：写上之后说去网站上按验证', async () => {
    const enter = vi.fn(async (): Promise<DockCodeOutcome> => 'FILLED');
    const { handle, q } = mount({ verificationCode: { enter } });
    handle.codePrompt(prompt({ next: 'VERIFY', charset: 'DIGITS', length: 6 }));
    expect(q<HTMLInputElement>('[data-code="input"]')?.inputMode).toBe('numeric');
    type(q<HTMLInputElement>('[data-code="input"]'), '123456');
    click(q('[data-action="code-enter"]'));
    await settle();
    await settle();
    expect(q('[data-code="filled"]')?.textContent).toContain(ZH.filled.verify);
  });

  it('位数或字符不对：卡上照实说要几位什么字符，他输的那一串留着好改', async () => {
    const enter = vi.fn(async (): Promise<DockCodeOutcome> => 'FORMAT');
    const { handle, q } = mount({ verificationCode: { enter } });
    handle.codePrompt(prompt());
    type(q<HTMLInputElement>('[data-code="input"]'), 'AB12');
    click(q('[data-action="code-enter"]'));
    await settle();
    await settle();
    expect(q('[data-code="note"]')?.textContent).toBe(ZH.notes.FORMAT(8, false));
    expect(q<HTMLInputElement>('[data-code="input"]')?.value).toBe('AB12');
  });

  it.each([
    ['GONE', ZH.notes.GONE],
    ['OFF', ZH.notes.OFF],
    ['UNTRUSTED', ZH.notes.UNTRUSTED],
    ['FAILED', ZH.notes.FAILED],
  ] as const)('没写上（%s）：卡上照实说一句', async (outcome, line) => {
    const enter = vi.fn(async (): Promise<DockCodeOutcome> => outcome);
    const { handle, q } = mount({ verificationCode: { enter } });
    handle.codePrompt(prompt());
    type(q<HTMLInputElement>('[data-code="input"]'), 'AB12CD34');
    click(q('[data-action="code-enter"]'));
    await settle();
    await settle();
    expect(q('[data-code="note"]')?.textContent).toBe(line);
  });

  it('空着按：不交出去，光标回到那一格', () => {
    const enter = vi.fn(async (): Promise<DockCodeOutcome> => 'FILLED');
    const { handle, q } = mount({ verificationCode: { enter } });
    handle.codePrompt(prompt());
    click(q('[data-action="code-enter"]'));
    expect(enter).not.toHaveBeenCalled();
  });

  it('页面派发的点击：什么都不交出去', () => {
    const enter = vi.fn(async (): Promise<DockCodeOutcome> => 'FILLED');
    const { handle, q } = mount({ verificationCode: { enter } });
    handle.codePrompt(prompt());
    type(q<HTMLInputElement>('[data-code="input"]'), 'AB12CD34');
    q('[data-action="code-enter"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(enter).not.toHaveBeenCalled();
  });

  it('他在那一格里按的键不往网页上冒', () => {
    const { handle, q } = mount({ verificationCode: { enter: vi.fn(async (): Promise<DockCodeOutcome> => 'FILLED') } });
    handle.codePrompt(prompt());
    const heard = vi.fn();
    document.addEventListener('keydown', heard);
    q('[data-code="input"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'A', bubbles: true, composed: true }));
    expect(heard).not.toHaveBeenCalled();
    document.removeEventListener('keydown', heard);
  });
});

describe('验证码不对、过期了、试太多次', () => {
  it.each([
    ['WRONG', 'The security code you entered is invalid.'],
    ['EXPIRED', 'Your security code has expired.'],
    ['TOO_MANY', 'Too many attempts.'],
    ['OTHER', 'Please try again.'],
  ] as const)('%s：换一句话、照登网站的原话，让他再输', (error, siteSays) => {
    const { handle, q } = mount({ verificationCode: { enter: vi.fn(async (): Promise<DockCodeOutcome> => 'FILLED') } });
    handle.codePrompt(prompt({ error, siteSays }));
    const card = q(`[data-code="${error}"]`);
    expect(card?.textContent).toContain(ZH.errors[error].title);
    expect(card?.textContent).toContain(ZH.errors[error].sub);
    expect(q('[data-code="site-says"]')?.textContent).toBe(ZH.siteSays(siteSays));
    expect(q('[data-code="input"]')).not.toBeNull();
  });

  it('填进去之后网站又说不对：「已填进网站」作废，回到能再输的样子', async () => {
    const enter = vi.fn(async (): Promise<DockCodeOutcome> => 'FILLED');
    const { handle, q } = mount({ verificationCode: { enter } });
    handle.codePrompt(prompt());
    type(q<HTMLInputElement>('[data-code="input"]'), 'AB12CD34');
    click(q('[data-action="code-enter"]'));
    await settle();
    await settle();
    expect(q('[data-code="filled"]')).not.toBeNull();
    handle.codePrompt(prompt({ filled: true, error: 'WRONG', siteSays: 'The security code you entered is invalid.' }));
    expect(q('[data-code="WRONG"]')).not.toBeNull();
    expect(q('[data-code="input"]')).not.toBeNull();
  });
});

describe('按了「提交」，网站要的是验证码', () => {
  it('不亮红条、不弹提示；卡由 codePrompt 换上', async () => {
    let finish: (outcome: DockSubmitOutcome) => void = () => {};
    const send = vi.fn((_event: MouseEvent, _shadow: ShadowRoot, pressAt: Promise<void>) => pressAt.then(() => new Promise<DockSubmitOutcome>((resolve) => { finish = resolve; })));
    const { handle, q, root } = mount({ submission: { available: () => true, send }, verificationCode: { enter: vi.fn(async (): Promise<DockCodeOutcome> => 'FILLED') } }, { run: true });
    click(handle.primaryButton());
    await settle();
    handle.codePrompt(prompt());
    finish('CODE_REQUIRED');
    const deadline = Date.now() + 1_500;
    while (handle.primaryButton()?.textContent !== '提交' && Date.now() < deadline) await new Promise((resolve) => { setTimeout(resolve, 10); });
    await settle();
    expect(q('[data-code="ask"]')).not.toBeNull();
    expect(root().querySelector('[data-toast]')?.textContent ?? '').toBe('');
    const banner = root().querySelector<HTMLElement>('.banner');
    expect(banner === null || banner.style.display === 'none').toBe(true);
  });
});

describe('英文界面', () => {
  it('同一张卡说英文', () => {
    const { handle, q } = mount({ locale: 'en', verificationCode: { enter: vi.fn(async (): Promise<DockCodeOutcome> => 'FILLED') } });
    handle.codePrompt(prompt({ site: 'Example Co’s Greenhouse' }));
    const card = q('[data-code="ask"]');
    expect(card?.textContent).toContain(EN.title);
    expect(card?.textContent).toContain(EN.ask('Example Co’s Greenhouse', INBOX, 'no-reply@us.greenhouse-mail.io', true, 'Security code for your application to', 8));
    expect(q('[data-action="code-enter"]')?.textContent).toBe(EN.enter);
  });
});
