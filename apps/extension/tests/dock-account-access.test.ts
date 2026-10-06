// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountAutofillDock, type AutofillDockHandlers, type DockAccountHandlers, type DockAccountSettings } from '../lib/autofillDock';
import { dockCopy } from '../lib/dock/copy';

/**
 * 浮层上的招聘网站账号（2026-09-28）。钉住：
 *  · 账号墙那一页主按钮写「注册并自动填写」「登录并自动填写」，下面一行说要先有账号；
 *  · 替他做到哪一步写在进度卡上，做成了的逐条记在总结里，留到他下一次自己按主按钮；
 *  · 停在账号墙上时一张卡说要他做的那一件事；输这一家密码、「我已验证，继续」只认真实点击，把这一下原样交给调用方；
 *  · 账户菜单「招聘网站账号」：点开才读，看、复制、改都问调用方；收起菜单就不留明文。
 */
class TrustedClick extends MouseEvent { get isTrusted() { return true; } }
const click = (node: Element | null | undefined) => node?.dispatchEvent(new TrustedClick('click', { bubbles: true, composed: true }));
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });
const COPY = dockCopy('zh');
const S = COPY.siteAccount;
const SITE = 'Acme 的 Workday';
const EMAIL = 'candidate@example.test';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function account(over: Partial<DockAccountHandlers> = {}): DockAccountHandlers {
  const settings: DockAccountSettings = { email: null, defaultEmail: EMAIL, hasPassword: true, sites: 0 };
  return {
    onSitePassword: vi.fn(),
    onResume: vi.fn(),
    load: vi.fn(async () => settings),
    reveal: vi.fn(async () => 'Shared-Pass-42'),
    setEmail: vi.fn(async (email: string | null) => ({ ...settings, email })),
    setPassword: vi.fn(async () => settings),
    ...over,
  };
}

function mount(extra: Partial<AutofillDockHandlers> = {}) {
  const onAutofill = vi.fn();
  const onOpenEntry = vi.fn();
  const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, {
    onAutofill, onOpenEntry, vendorLabel: 'Workday', onStop: () => {}, ...extra,
  }, document);
  handle.openPanel();
  const root = () => handle.sceneRoot()!;
  const q = <T extends Element = HTMLElement>(selector: string) => root().querySelector<T & HTMLElement>(selector);
  return { handle, onAutofill, onOpenEntry, root, q };
}

describe('账号墙那一页的主按钮', () => {
  it('REGISTER →「注册并自动填写」，SIGN_IN →「登录并自动填写」，没有墙 →「自动填写」；下面一行说要先有账号', () => {
    const { handle, q } = mount({ accountAccess: account() });
    expect(handle.autofillButton()?.textContent).toBe(COPY.autofill);
    expect(q('[data-account="wall-note"]')?.style.display).toBe('none');
    handle.setAccountWall({ action: 'REGISTER', site: SITE });
    expect(handle.autofillButton()?.textContent).toBe(S.register);
    expect(q('[data-account="wall-note"]')?.style.display).toBe('');
    expect(q('[data-account="wall-note"]')?.textContent).toBe(S.wallNote(SITE));
    handle.setAccountWall({ action: 'SIGN_IN', site: SITE });
    expect(handle.autofillButton()?.textContent).toBe(S.signIn);
    handle.setAccountWall(null);
    expect(handle.autofillButton()?.textContent).toBe(COPY.autofill);
    expect(q('[data-account="wall-note"]')?.style.display).toBe('none');
  });

  it('按下去就是平常那一下：交给调用方（它按页面上有没有账号墙决定走哪一路）', () => {
    const { handle, onAutofill } = mount({ accountAccess: account() });
    handle.setAccountWall({ action: 'REGISTER', site: SITE });
    click(handle.autofillButton());
    expect(onAutofill).toHaveBeenCalledTimes(1);
    expect(handle.runState()).toBe('PREPARING');
  });
});

describe('进度与记下的事', () => {
  it('正在做的写在进度卡上', () => {
    const { handle, root } = mount({ accountAccess: account() });
    handle.beginPreparing();
    handle.accountStatus({ kind: 'REGISTERING', site: SITE });
    expect(root().textContent).toContain(S.status.REGISTERING(SITE));
    handle.accountStatus({ kind: 'SIGNING_IN', site: SITE });
    expect(root().textContent).toContain(S.status.SIGNING_IN(SITE));
  });

  it('做成了的逐条列在这一轮的总结里（接着填的那一页也算这一轮）；他下一次自己按主按钮就清掉', () => {
    const { handle, q } = mount({ accountAccess: account() });
    handle.beginPreparing();
    handle.accountStatus({ kind: 'REGISTERED', site: SITE, email: EMAIL, generated: true });
    handle.accountStatus({ kind: 'TERMS_ACCEPTED', site: SITE });
    handle.accountContinuing();
    expect(handle.runState()).toBe('PREPARING');
    const rows = [{ label: 'First Name', required: true, done: true, state: 'CONFIRMED' as const, value: 'Sample' }];
    handle.beginRun({ runId: 'gesture-1', requiredQuestions: 1, requiredCompleted: 1, rows, phase: 'SETTLED' } as never);
    handle.finishRun({ started: true, outcome: 'FILLED' } as never);
    const notes = () => [...(q('.sum-notes')?.querySelectorAll('[data-account="done"]') ?? [])].map((node) => node.textContent);
    expect(notes()).toEqual([S.done.REGISTERED(SITE, EMAIL), S.done.generated, S.done.TERMS_ACCEPTED(SITE)]);
    // 他自己按「重新填写这一页」：新的一轮，上一轮替他做的不再列。
    click(q('[data-action="rerun"]'));
    handle.beginRun({ runId: 'gesture-2', requiredQuestions: 1, requiredCompleted: 1, rows, phase: 'SETTLED' } as never);
    handle.finishRun({ started: true, outcome: 'FILLED' } as never);
    expect(notes()).toEqual([]);
  });
});

describe('停在账号墙上的那张卡', () => {
  it('这一家的密码不一样：一格密码框；真实点击把他输的与这一下交给调用方，回到进度卡；不是真实点击、空的都不交', () => {
    const onSitePassword = vi.fn();
    const { handle, q } = mount({ accountAccess: account({ onSitePassword }) });
    handle.beginPreparing();
    handle.accountPrompt({ kind: 'SITE_PASSWORD', site: SITE, email: EMAIL, retry: false });
    expect(handle.runState()).toBe('IDLE');
    const card = q('[data-account="SITE_PASSWORD"]');
    expect(card?.textContent).toContain(S.prompts.SITE_PASSWORD.title(SITE));
    expect(card?.textContent).toContain(S.prompts.SITE_PASSWORD.sub(EMAIL));
    const input = q<HTMLInputElement>('[data-account="site-password"]')!;
    expect(input.type).toBe('password');
    const go = q('[data-action="account-site-password"]');
    click(go);
    expect(onSitePassword).not.toHaveBeenCalled();
    input.value = 'Their-Own-9';
    go?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(onSitePassword).not.toHaveBeenCalled();
    click(go);
    expect(onSitePassword).toHaveBeenCalledTimes(1);
    const [password, event, shadowRoot] = onSitePassword.mock.calls[0] as unknown as [string, MouseEvent, ShadowRoot];
    expect(password).toBe('Their-Own-9');
    expect(event.isTrusted).toBe(true);
    expect(shadowRoot).toBeTruthy();
    expect(input.value).toBe('');
    expect(handle.runState()).toBe('PREPARING');
    expect(q('[data-account="SITE_PASSWORD"]')).toBeNull();
  });

  it('密码框里按的键不往网页上冒', () => {
    const { handle, q } = mount({ accountAccess: account() });
    handle.accountPrompt({ kind: 'SITE_PASSWORD', site: SITE, email: EMAIL, retry: true });
    const heard = vi.fn();
    document.addEventListener('keydown', heard);
    q('[data-account="site-password"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, composed: true }));
    expect(heard).not.toHaveBeenCalled();
    document.removeEventListener('keydown', heard);
    expect(q('[data-account="SITE_PASSWORD"]')?.textContent).toContain(S.prompts.SITE_PASSWORD.retrySub);
  });

  it('去邮箱验证：「我已验证，继续」把这一下交给调用方', () => {
    const onResume = vi.fn();
    const { handle, q } = mount({ accountAccess: account({ onResume }) });
    handle.accountPrompt({ kind: 'VERIFY_EMAIL', site: SITE, email: EMAIL });
    expect(q('[data-account="VERIFY_EMAIL"]')?.textContent).toContain(S.prompts.VERIFY_EMAIL.sub(SITE, EMAIL, null));
    click(q('[data-action="account-resume"]'));
    expect(onResume).toHaveBeenCalledTimes(1);
    expect((onResume.mock.calls[0] as unknown as [MouseEvent])[0].isTrusted).toBe(true);
  });

  it('去邮箱验证：规则写了这一家的发件地址（2026-10-04），卡上一并说从哪儿来，好在收件箱里找', () => {
    const { handle, q } = mount({ accountAccess: account() });
    handle.accountPrompt({ kind: 'VERIFY_EMAIL', site: SITE, email: EMAIL, mail: { from: ['…@myworkday.com'], subject: null } });
    const text = q('[data-account="VERIFY_EMAIL"]')?.textContent ?? '';
    expect(text).toContain(S.prompts.VERIFY_EMAIL.sub(SITE, EMAIL, '…@myworkday.com'));
    expect(text).toContain('…@myworkday.com');
  });

  it('没同意：卡上的按钮打开资料编辑器（代填授权那一格在那里）', () => {
    const { handle, q, onOpenEntry } = mount({ accountAccess: account() });
    handle.accountPrompt({ kind: 'CONSENT', site: SITE });
    click(q('[data-action="account-consent"]'));
    expect(handle.scene()).toBe('PROFILE');
    expect(onOpenEntry).toHaveBeenCalledWith('AUTOFILL_INFORMATION');
  });

  it('人机验证：这一轮还在等他（不算停），卡上有「停止」；账号墙那一步接着走，卡就收起', () => {
    const { handle, q } = mount({ accountAccess: account() });
    handle.beginPreparing();
    handle.accountPrompt({ kind: 'CAPTCHA', site: SITE });
    expect(handle.runState()).toBe('PREPARING');
    expect(q('[data-account="CAPTCHA"]')?.textContent).toContain(S.waiting);
    expect(q('[data-account="CAPTCHA"] [data-action="stop"]')).not.toBeNull();
    handle.accountStatus({ kind: 'SIGNING_IN', site: SITE });
    expect(q('[data-account="CAPTCHA"]')).toBeNull();
  });

  it('网站没接受：「再试一次」就是新的一轮', () => {
    const { handle, q, onAutofill } = mount({ accountAccess: account() });
    handle.beginPreparing();
    handle.accountPrompt({ kind: 'REJECTED', site: SITE });
    click(q('[data-account="REJECTED"] [data-action="retry"]'));
    expect(onAutofill).toHaveBeenCalledTimes(1);
    expect(q('[data-account="REJECTED"]')).toBeNull();
  });

  it('账号墙不见了（他自己在网站上登录了）：停在墙上的那张卡收起', () => {
    const { handle, q } = mount({ accountAccess: account() });
    handle.setAccountWall({ action: 'SIGN_IN', site: SITE });
    handle.accountPrompt({ kind: 'OFF', site: SITE });
    expect(q('[data-account="OFF"]')).not.toBeNull();
    handle.setAccountWall(null);
    expect(q('[data-account="OFF"]')).toBeNull();
    expect(handle.autofillButton()?.textContent).toBe(COPY.autofill);
  });
});

describe('账户菜单里的「招聘网站账号」', () => {
  const openSection = async (q: ReturnType<typeof mount>['q']) => {
    click(q('[data-act="menu-account"]'));
    click(q('[data-action="site-accounts"]'));
    await settle();
  };

  it('没接处理器就没有这一项', () => {
    expect(mount().q('[data-action="site-accounts"]')).toBeNull();
  });

  it('点开才读：注册邮箱（资料里的）、密码收着；显示才向调用方要明文，收起菜单就不留', async () => {
    const handlers = account();
    const { q, root } = mount({ accountAccess: handlers });
    expect(handlers.load).not.toHaveBeenCalled();
    await openSection(q);
    expect(handlers.load).toHaveBeenCalledTimes(1);
    const menu = q('[data-account="menu"]')!;
    expect(menu.textContent).toContain(EMAIL);
    expect(menu.textContent).toContain(S.menu.emailDefault);
    expect(menu.textContent).not.toContain('Shared-Pass-42');
    click(q('[data-action="account-reveal"]'));
    await settle();
    expect(handlers.reveal).toHaveBeenCalledTimes(1);
    expect(q('[data-revealed="true"]')?.textContent).toBe('Shared-Pass-42');
    // 收起菜单（再点一次头像）：明文不留在浮层里。
    click(q('[data-act="menu-account"]'));
    expect(root().textContent).not.toContain('Shared-Pass-42');
    expect(q('[data-account="menu"]')?.style.display).toBe('none');
  });

  it('复制：向调用方要明文、写进剪贴板', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { q } = mount({ accountAccess: account() });
    await openSection(q);
    click(q('[data-action="account-copy"]'));
    await settle();
    expect(writeText).toHaveBeenCalledWith('Shared-Pass-42');
  });

  it('改共用密码：不合要求照实说；合要求存上、说已保存', async () => {
    const setPassword = vi.fn(async (password: string) => (password === 'weak' ? 'WEAK' as const : { email: null, defaultEmail: EMAIL, hasPassword: true, sites: 0 }));
    const { q, root } = mount({ accountAccess: account({ setPassword }) });
    await openSection(q);
    click(q('[data-action="account-edit-password"]'));
    const input = q<HTMLInputElement>('[data-account="password"]')!;
    expect(input.type).toBe('password');
    expect(q('[data-account="menu"]')?.textContent).toContain(S.menu.rules);
    input.value = 'weak';
    click(q('[data-action="account-save"]'));
    await settle();
    expect(q('[data-account="menu"]')?.textContent).toContain(S.menu.weak);
    q<HTMLInputElement>('[data-account="password"]')!.value = 'Brand-New-Pass-7';
    click(q('[data-action="account-save"]'));
    await settle();
    expect(setPassword).toHaveBeenLastCalledWith('Brand-New-Pass-7');
    expect(q('[data-account="password"]')).toBeNull();
    expect(root().textContent).not.toContain('Brand-New-Pass-7');
  });

  it('没有注册邮箱那张卡：按钮打开「招聘网站账号」、直接改邮箱；改回资料里的交 null', async () => {
    const setEmail = vi.fn(async (email: string | null) => ({ email, defaultEmail: EMAIL, hasPassword: false, sites: 2 }));
    const { handle, q } = mount({ accountAccess: account({ setEmail }) });
    handle.accountPrompt({ kind: 'NO_EMAIL', site: SITE });
    click(q('[data-action="account-email"]'));
    await settle();
    const input = q<HTMLInputElement>('[data-account="email"]')!;
    input.value = '  jobs@example.test ';
    click(q('[data-action="account-save"]'));
    await settle();
    expect(setEmail).toHaveBeenLastCalledWith('jobs@example.test');
    expect(q('[data-account="menu"]')?.textContent).toContain('jobs@example.test');
    expect(q('[data-account="menu"]')?.textContent).toContain(S.menu.sites(2));
    click(q('[data-action="account-default-email"]'));
    await settle();
    expect(setEmail).toHaveBeenLastCalledWith(null);
  });
});
