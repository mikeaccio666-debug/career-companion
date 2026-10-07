// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountAutofillDock, type AutofillDockHandlers, type DockAccountHandlers, type DockVaultManagement } from '../lib/autofillDock';
import { dockCopy } from '../lib/dock/copy';

/**
 * 浮层上的招聘网站账号（2026-09-28）。钉住：
 *  · 账号墙那一页主按钮写「注册并自动填写」「登录并自动填写」，下面一行说要先有账号；
 *  · 替他做到哪一步写在进度卡上，做成了的逐条记在总结里，留到他下一次自己按主按钮；
 *  · 停在账号墙上时一张卡说要他做的那一件事；输这一家密码、「我已验证，继续」只认真实点击，把这一下原样交给调用方；
 *  · 账户菜单「招聘网站账号」：点开才读隐藏的站点列表；密码查看和导出只在插件设置页。
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
  return {
    onSitePassword: vi.fn(),
    onResume: vi.fn(),
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
  it.each(['zh', 'en'] as const)('%s 的账号已存在和验证说明不把待本人输入密码说成已经登录', (language) => {
    const copy = dockCopy(language).siteAccount;
    const exists = copy.done.ACCOUNT_EXISTS(SITE);
    const verification = copy.prompts.VERIFY_EMAIL.sub(SITE, EMAIL, null);
    expect(exists).toContain(language === 'zh' ? '请输入这个网站的密码继续' : 'Enter this site’s password to continue');
    expect(exists).not.toContain(language === 'zh' ? '改用你保存的密码登录' : 'signed in with your saved password');
    expect(verification).toContain(language === 'zh' ? '若仍需登录，我们会请你输入这个网站的密码' : 'If you still need to sign in, we’ll ask for this site’s password');
  });

  it.each(['zh', 'en'] as const)('%s 的未知邮箱提示区分新注册资料与已有网站的历史邮箱，不声称改资料就能重建旧登录', (language) => {
    const prompt = dockCopy(language).siteAccount.prompts.NO_EMAIL;
    expect(prompt.title).toContain(language === 'zh' ? '无法确认登录邮箱' : 'confirm the sign-in email');
    expect(prompt.sub).toContain(language === 'zh' ? '新注册请先核对资料里的邮箱' : 'For a new account, check the email in your profile');
    expect(prompt.sub).toContain(language === 'zh' ? '已有网站账号可以先在网站上手动登录' : 'already have an account on this site, sign in there yourself');
    expect(prompt.primary).toBe(language === 'zh' ? '打开我的资料' : 'Open my profile');
  });

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
  const origin = 'https://careers.example.test';
  const saved = 'https://saved.example.test';
  const snapshot = {
    status: 'READABLE' as const, revision: 3, authEpoch: 8, email: EMAIL, defaultEmail: null,
    sites: [
      { origin, email: EMAIL, source: 'GENERATED' as const, state: 'PENDING' as const, hasPassword: true, at: 100 },
      { origin: saved, email: EMAIL, source: 'USER_SAVED' as const, state: 'REGISTERED' as const, hasPassword: true, at: 100 },
    ],
  };
  const vault = (over: Partial<DockVaultManagement> = {}): DockVaultManagement => ({
    list: vi.fn(async () => ({ ok: true as const, value: snapshot })), openSettings: vi.fn(async () => true), ...over,
  });
  const openSection = async (q: ReturnType<typeof mount>['q']) => {
    click(q('[data-act="menu-account"]'));
    click(q('[data-action="site-accounts"]'));
    await settle();
  };

  it('没接元数据处理器就没有这一项，即使账号墙执行器在', () => {
    expect(mount().q('[data-action="site-accounts"]')).toBeNull();
    expect(mount({ accountAccess: account() }).q('[data-action="site-accounts"]')).toBeNull();
  });

  it('明确点开才读；密码存在不等于注册完成，菜单始终隐藏密码', async () => {
    const port = vault(); const { q, root } = mount({ vaultManagement: port });
    expect(port.list).not.toHaveBeenCalled(); await openSection(q);
    expect(port.list).toHaveBeenCalledTimes(1);
    expect(q('[data-account="sites"]')?.textContent).toContain('careers.example.test');
    expect(q('[data-account="sites"]')?.textContent).toContain('注册还没完成');
    expect(q('[data-account="sites"]')?.textContent).toContain('已保存密码');
    expect(q('[data-account="sites"]')?.textContent).toContain('••••••••');
    expect(q('[data-action="account-reveal"]')).toBeNull();
    expect(q('[data-action="account-copy"]')).toBeNull();
    expect(q('[data-action="account-edit-password"]')).toBeNull();
    expect(root().querySelector('[data-action="confirm-export"]')).toBeNull();
  });

  it('逐站点查看只打开可信插件设置，原始真人事件与shadow交给调用方', async () => {
    const port = vault(); const { q } = mount({ vaultManagement: port }); await openSection(q);
    const button = q('[data-action="account-open-site-settings"]');
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(port.openSettings).not.toHaveBeenCalled();
    click(button);
    expect(port.openSettings).toHaveBeenCalledWith(origin, expect.any(MouseEvent), expect.any(ShadowRoot));
    click(q('[data-action="account-open-settings"]'));
    expect(port.openSettings).toHaveBeenLastCalledWith(null, expect.any(MouseEvent), expect.any(ShadowRoot));
  });

  it.each(['KEY_MISSING', 'UNREADABLE'] as const)('把 %s 明确显示为不可恢复，而不是空库', async (status) => {
    const { q } = mount({ vaultManagement: vault({ list: async () => ({ ok: true, value: { ...snapshot, status, revision: null, email: null, sites: [] } }) }) });
    await openSection(q);
    expect(q('[data-account="sites"]')?.textContent).toContain(status === 'KEY_MISSING' ? '密钥丢失' : '读不出来');
    expect(q('[data-account="sites"]')?.textContent).not.toContain('还没有关联');
    expect(q('[data-action="account-open-site-settings"]')).toBeNull();
  });

  it('菜单关闭或换人后，迟到的元数据不能重挂', async () => {
    let finish!: (value: Awaited<ReturnType<DockVaultManagement['list']>>) => void;
    const { q, handle } = mount({ vaultManagement: vault({ list: () => new Promise((resolve) => { finish = resolve; }) }) });
    await openSection(q); click(q('[data-act="menu-account"]'));
    finish({ ok: true, value: snapshot }); await settle();
    expect(q('[data-account="sites"]')).toBeNull();
    await openSection(q); handle.forgetUser(); finish({ ok: true, value: snapshot }); await settle();
    expect(q('[data-account="sites"]')).toBeNull();
  });

  it('无法确认登录邮箱时给已有站点手动登录路径，并保留实际资料编辑器', () => {
    const { handle, q, onOpenEntry } = mount({ accountAccess: account() });
    handle.accountPrompt({ kind: 'NO_EMAIL', site: SITE });
    expect(q('[data-account="NO_EMAIL"]')?.textContent).toContain('已有网站账号可以先在网站上手动登录');
    click(q('[data-action="account-email"]'));
    expect(onOpenEntry).toHaveBeenCalledWith('AUTOFILL_INFORMATION'); expect(handle.scene()).toBe('PROFILE');
  });

  it('移除浮层会中止读取并丢弃迟到的站点列表', async () => {
    let finish!: (value: Awaited<ReturnType<DockVaultManagement['list']>>) => void;
    let signal!: AbortSignal;
    const { q, handle, root } = mount({ vaultManagement: vault({ list: (input) => { signal = input; return new Promise((resolve) => { finish = resolve; }); } }) });
    await openSection(q); const removedRoot = root(); handle.dismiss();
    expect(signal.aborted).toBe(true);
    finish({ ok: true, value: snapshot }); await settle();
    expect(removedRoot.querySelector('[data-account="sites"]')?.textContent).not.toContain('careers.example.test');
  });
});
