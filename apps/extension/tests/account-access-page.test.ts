// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { installApplyAdapters } from '@edaix/apply-kernel/registry';
import type { TrustedGestureProof } from '@edaix/apply-kernel/grant';
import { workdayAdapter } from '@edaix/apply-kernel/sites/workday';

import { createAccountAccessPage, type AccountAccessPageDeps } from '../lib/accountAccessPage';
import { ACCOUNT_ACCESS_INTENT_KIND } from '../lib/accountAccessIntent';
import type { AutofillDockHandle, DockAccountWall } from '../lib/autofillDock';

/**
 * 申请页上的招聘网站账号那一套（2026-09-28，lib/accountAccessPage.ts）。钉住：
 *  · 看着这一页：规则声明的账号墙出现了才问 worker 一次 STATUS；两把钥匙都在，主按钮才换成「注册／登录并自动填写」；
 *    墙不见了换回来；声明了账号墙的厂商之外一概不看；
 *  · 发给 worker 的每一条都是我们自己的账号消息，带的是这一页的 origin 与 pathname——密码只在他输了这一家的密码那一条里；
 *  · 浮层拆了就不再看。
 */

const FIXTURES = resolve(__dirname, '..', '..', '..', 'packages', 'apply-kernel', 'tests', 'fixtures', 'workday');
const fixture = (name: string): string => readFileSync(resolve(FIXTURES, name), 'utf8');
const HERE = { origin: 'https://tenant.wd5.myworkdayjobs.com', pathname: '/en-US/site/job/x/apply/applyManually', hostname: 'tenant.wd5.myworkdayjobs.com' };
const settle = async () => { for (let index = 0; index < 5; index += 1) await Promise.resolve(); };

beforeAll(() => { installApplyAdapters({ workday: workdayAdapter }); });
afterAll(() => { installApplyAdapters({}); });
afterEach(() => { document.body.innerHTML = ''; });

function setup(status: { consent: boolean; enabled: boolean; known: boolean } = { consent: true, enabled: true, known: false }, vendor: 'workday' | 'greenhouse' = 'workday') {
  const walls: (DockAccountWall | null)[] = [];
  const dock = { reportBlocked: vi.fn(), accountPrompt: vi.fn(), setAccountWall: (wall: DockAccountWall | null) => { walls.push(wall); } } as unknown as AutofillDockHandle;
  let tick: (() => void) | null = null;
  const sent: unknown[] = [];
  const send = vi.fn(async (message: unknown): Promise<unknown> => {
    sent.push(message);
    return { kind: 'ACCOUNT_STATUS', ...status, operationId: '00000000-0000-4000-8000-000000000001', authEpoch: 1 };
  });
  const fillPage = vi.fn(async () => {});
  const deps: AccountAccessPageDeps = {
    doc: document,
    here: () => HERE,
    vendor,
    isTopFrame: true,
    isVisible: () => true,
    openShadowRoot: () => null,
    send,
    discovery: async () => null,
    dock: () => dock,
    chain: () => { throw new Error('not used'); },
    fillPage,
    restart: () => new AbortController(),
    site: () => 'Acme 的 Workday',
    onReturn: () => () => {},
    setInterval: (run) => { tick = run; return 1; },
    clearInterval: () => { tick = null; },
  };
  const page = createAccountAccessPage(deps);
  return { page, walls, sent, send, fillPage, tick: () => tick?.(), ticking: () => tick !== null };
}

describe('看着这一页', () => {
  it('没有墙 → 不问；墙出现了（选怎么登录）→ 问一次 STATUS，没账号就写「注册并自动填写」；换到登录那一步 → 「登录并自动填写」；墙没了 → 换回来', async () => {
    document.body.innerHTML = '<form><input></form>';
    const h = setup();
    h.page.start();
    await settle();
    expect(h.send).not.toHaveBeenCalled();
    document.body.innerHTML = fixture('account-choice.html');
    h.tick();
    await settle();
    expect(h.walls.at(-1)).toEqual({ action: 'REGISTER', site: 'Acme 的 Workday' });
    // 同一步不再问。
    h.tick();
    await settle();
    expect(h.send).toHaveBeenCalledTimes(1);
    document.body.innerHTML = fixture('account-sign-in.html');
    h.tick();
    await settle();
    expect(h.walls.at(-1)).toEqual({ action: 'SIGN_IN', site: 'Acme 的 Workday' });
    document.body.innerHTML = '<form><input></form>';
    h.tick();
    await settle();
    expect(h.walls.at(-1)).toBeNull();
    expect(h.sent.every((message) => (message as { kind?: string }).kind === ACCOUNT_ACCESS_INTENT_KIND)).toBe(true);
    expect(h.sent).toEqual([
      expect.objectContaining({ origin: HERE.origin, pathname: HERE.pathname, payload: { step: 'STATUS' } }),
      expect.objectContaining({ payload: { step: 'STATUS' } }),
    ]);
  });

  it('这一家已经有他的账号：选怎么登录那一步也写「登录并自动填写」', async () => {
    document.body.innerHTML = fixture('account-choice.html');
    const h = setup({ consent: true, enabled: true, known: true });
    h.page.start();
    await settle();
    expect(h.walls.at(-1)).toEqual({ action: 'SIGN_IN', site: 'Acme 的 Workday' });
  });

  it.each([
    ['没同意点名这一类的那一版', { consent: false, enabled: true, known: false }],
    ['运行时包里 account-access 关着', { consent: true, enabled: false, known: false }],
  ])('%s：主按钮照旧是「自动填写」', async (_name, status) => {
    document.body.innerHTML = fixture('account-create.html');
    const h = setup(status);
    h.page.start();
    await settle();
    expect(h.walls).toEqual([null]);
  });

  it('规则没声明账号墙的厂商：一概不看、不问', async () => {
    document.body.innerHTML = fixture('account-create.html');
    const h = setup(undefined, 'greenhouse');
    h.page.start();
    await settle();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.walls).toEqual([]);
    expect(h.page.wallOnPage()).toBe(false);
  });

  it('浮层拆了：不再看', () => {
    const h = setup();
    h.page.start();
    expect(h.ticking()).toBe(true);
    h.page.dispose();
    expect(h.ticking()).toBe(false);
  });

  it('主按钮那一下走哪一路：这一页上有规则声明的账号墙才走账号墙那一路', () => {
    const h = setup();
    document.body.innerHTML = '<form><input></form>';
    expect(h.page.wallOnPage()).toBe(false);
    document.body.innerHTML = fixture('account-sign-in.html');
    expect(h.page.wallOnPage()).toBe(true);
  });
});

describe('metadata-only vault management', () => {
  it('lists exact worker metadata and never offers secret operations on the ATS page', async () => {
    const h = setup();
    const snapshot = { kind: 'VAULT_LIST', status: 'READABLE', revision: 2, authEpoch: 1, email: 'student@example.test', defaultEmail: null,
      sites: [{ origin: HERE.origin, email: 'student@example.test', source: 'GENERATED', state: 'PENDING', hasPassword: true, at: 1 }] };
    h.send.mockResolvedValueOnce(snapshot);
    expect(await h.page.vaultManagement.list(new AbortController().signal)).toEqual({ ok: true, value: snapshot });
    expect(h.send.mock.calls[0]?.[0]).toMatchObject({ origin: HERE.origin, pathname: HERE.pathname, payload: { step: 'LIST' } });
    expect(Object.keys(h.page.handlers).sort()).toEqual(['onResume', 'onSitePassword']);
  });
  it('rejects a secret-shaped or unavailable list response', async () => {
    const h = setup(); h.send.mockResolvedValueOnce({ kind: 'ACCOUNT_PASSWORD', password: 'fictional-secret' });
    expect(await h.page.vaultManagement.list(new AbortController().signal)).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });
  it('drops an aborted metadata request', async () => {
    const h = setup(); const request = new AbortController(); request.abort();
    expect(await h.page.vaultManagement.list(request.signal)).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });
  it('retiring the actual page fences late status responses before they reach a new dock', async () => {
    document.body.innerHTML = fixture('account-create.html');
    const h = setup(); let reply!: (value: unknown) => void;
    h.send.mockImplementationOnce(() => new Promise((resolve) => { reply = resolve; }));
    h.page.start(); h.page.dispose();
    reply({ kind: 'ACCOUNT_STATUS', consent: true, enabled: true, known: false, operationId: '00000000-0000-4000-8000-000000000001', authEpoch: 1 });
    await settle(); expect(h.walls).toEqual([]);
  });
  it('synthetic settings clicks cannot open a vault tab or send a message', async () => {
    const h = setup(), host = document.createElement('div'); document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' }), button = document.createElement('button'); shadow.append(button);
    let opened: Promise<boolean> | undefined;
    button.addEventListener('click', (event) => { opened = h.page.vaultManagement.openSettings(HERE.origin, event as MouseEvent, shadow); });
    button.click(); expect(await opened).toBe(false); expect(h.send).not.toHaveBeenCalled();
  });
});


describe('account continuation forwards the existing owner context', () => {
  // This fixture is an opaque transport value. The fill executor is a spy;
  // these tests do not manufacture or exercise DOM-write authority.
  const proof = Object.freeze({}) as TrustedGestureProof;
  const status = { kind: 'ACCOUNT_STATUS' as const, consent: true, enabled: true, known: false,
    operationId: '00000000-0000-4000-8000-000000000001', authEpoch: 1 };
  it.each([true, false])('wall already gone: original operation CHECK controls continuation (%s)', async (current) => {
    document.body.innerHTML = '<form><input name="profile"></form>';
    const h = setup(); h.send.mockResolvedValueOnce(current ? { kind: 'ACCOUNT_CURRENT' } : { kind: 'REFUSED', code: 'AUTH_CHANGED' });
    await h.page.run(proof, status);
    expect(h.send.mock.calls[0]?.[0]).toMatchObject({ payload: { step: 'CHECK', operationId: status.operationId, expectedEpoch: 1 } });
    expect(h.fillPage).toHaveBeenCalledTimes(current ? 1 : 0);
    expect(h.send.mock.calls.every(([message]) => (message as { payload: { step: string } }).payload.step !== 'STATUS')).toBe(true);
  });
  it.each([true, false])('NO_WALL after runtime lookup: fallback checks the same operation (%s)', async (current) => {
    document.body.innerHTML = fixture('account-create.html');
    const h = setup(); // discovery is unavailable: actual controller returns NO_WALL.
    h.send.mockResolvedValueOnce(current ? { kind: 'ACCOUNT_CURRENT' } : { kind: 'REFUSED', code: 'AUTH_CHANGED' });
    await h.page.run(proof, status);
    expect(h.send.mock.calls[0]?.[0]).toMatchObject({ payload: { step: 'CHECK', operationId: status.operationId, expectedEpoch: 1 } });
    expect(h.fillPage).toHaveBeenCalledTimes(current ? 1 : 0);
  });
  it('retiring the page during a deferred continuation CHECK drops the result', async () => {
    document.body.innerHTML = '<form><input name="profile"></form>';
    const h = setup(); let resolve!: (value: unknown) => void;
    h.send.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = h.page.run(proof, status); h.page.dispose(); resolve({ kind: 'ACCOUNT_CURRENT' });
    await pending; expect(h.fillPage).not.toHaveBeenCalled();
  });
});
