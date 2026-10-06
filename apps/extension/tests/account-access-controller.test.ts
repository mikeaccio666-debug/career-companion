// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { captureTrustedShadowGesture, isAdvanceRunPage, type GestureRoot, type TrustedGestureProof } from '@edaix/apply-kernel/grant';
import { createBundledApplyPolicy, type ApplyPolicy } from '@edaix/apply-kernel/policy';
import { workdayAdapter } from '@edaix/apply-kernel/sites/workday';
import { detectHumanCheckpoint } from '@edaix/apply-kernel/wizardAdvance';

import { createAccountAccessController, type AccountAccessDock } from '../lib/accountAccessController';
import type { DockAccountAccessPayload, DockAccountAccessReply } from '../lib/accountAccessIntent';
import type { DockAccountPrompt } from '../lib/dock/types';
import { createFillToReview } from '../lib/fillToReview';

/**
 * 替用户在招聘网站上注册、登录，然后接着填（2026-09-28）。用内核的真规则（workday.json 的 accountSteps）与合成夹具
 * （结构照 nvidia.wd5 的只读实测）演一个网站：按了哪颗、网站怎么回。锁的是每一种结局浮层上说什么、下一步做什么，以及：
 *  · 两把钥匙缺一把，一格不写、一下不按；
 *  · 密码只写进规则声明的那几格（蜜罐一个字不写），不进发给 worker 之外的任何消息——这里发出去的只有 STATUS／CREDENTIAL／
 *    RECORD，一条都不带密码；
 *  · 密码不对不乱试：请他在浮层里输这一家的密码；人机验证由他本人过，我们接着等；邮箱验证之后他回到这一页才接着登录。
 */

const FIXTURES = resolve(__dirname, '..', '..', '..', 'packages', 'apply-kernel', 'tests', 'fixtures', 'workday');
const fixture = (name: string): string => readFileSync(resolve(FIXTURES, name), 'utf8');
const ORIGIN = 'https://tenant.wd5.myworkdayjobs.com';
const PATH = '/en-US/site/job/x/apply/applyManually';
const EMAIL = 'candidate@example.test';
const PASSWORD = 'Tr1ck-y!Horse#42';
const visible = (): boolean => true;

const happyDom = (globalThis as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean } } }).happyDOM;
const iframeLoading = happyDom?.settings.disableIframePageLoading;
beforeAll(() => { if (happyDom !== undefined) happyDom.settings.disableIframePageLoading = true; });
afterAll(() => { if (happyDom !== undefined && iframeLoading !== undefined) happyDom.settings.disableIframePageLoading = iframeLoading; });
afterEach(() => { document.body.innerHTML = ''; });

function trustedProof(): TrustedGestureProof {
  const host = document.createElement('div');
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const event = new Event('click', { bubbles: true, composed: true });
  Object.defineProperty(event, 'isTrusted', { value: true });
  Object.defineProperty(event, 'composedPath', { value: () => [shadowRoot, host, document.body, document, window] });
  const proof = captureTrustedShadowGesture(event, shadowRoot);
  if (proof === null) throw new Error('test proof rejected');
  return proof;
}

/** 运行时包的写策略：Workday 开着（内置的那一份里它是关的），`account-access` 按给的开关。 */
function policy(accountAccess = true): ApplyPolicy {
  const bundled = createBundledApplyPolicy(Date.now());
  return {
    ...bundled,
    vendors: { ...bundled.vendors, workday: true },
    capabilities: { ...bundled.capabilities, 'account-access': accountAccess },
  };
}

type View = 'choice' | 'create' | 'signIn';
type CreateResult = 'success' | 'exists' | 'verify' | 'captcha';
type SignInResult = 'success' | 'wrong' | 'verify';

interface Press {
  readonly view: View;
  readonly email: string;
  readonly password: string;
  readonly verify: string | null;
  readonly terms: boolean | null;
  readonly honeypot: string;
}

/** 一个照 Workday 账号墙行事的网站：切视图、按了注册／登录之后怎么回。 */
function mountSite(behaviour: { create?: CreateResult; signIn?: SignInResult }, clock: { now: () => number; hooks: (() => void)[] }) {
  const presses: Press[] = [];
  let view: View = 'choice';
  const q = (id: string): HTMLElement | null => document.querySelector(`[data-automation-id="${id}"]`);
  const wall = (): HTMLElement => q('signInContent')!;
  const banner = (text: string): void => {
    const node = document.createElement('div');
    node.setAttribute('role', 'alert');
    node.textContent = text;
    wall().append(node);
  };
  const pass = (): void => {
    document.body.innerHTML = '<div data-automation-id="applyFlowPage"><h2>My Information</h2><form><input data-automation-id="legalNameSection_firstName"></form></div>';
  };
  const show = (next: View): void => {
    view = next;
    document.body.innerHTML = fixture(next === 'choice' ? 'account-choice.html' : next === 'create' ? 'account-create.html' : 'account-sign-in.html');
    q('SignInWithEmailButton')?.addEventListener('click', () => show('signIn'));
    q('createAccountLink')?.addEventListener('click', () => show('create'));
    q('signInLink')?.addEventListener('click', () => show('signIn'));
    q('click_filter')?.addEventListener('click', () => {
      const field = (id: string) => q(id) as HTMLInputElement | null;
      presses.push({
        view,
        email: field('email')?.value ?? '',
        password: field('password')?.value ?? '',
        verify: field('verifyPassword')?.value ?? null,
        terms: field('createAccountCheckbox')?.checked ?? null,
        honeypot: field('beecatcher')?.value ?? '',
      });
      const result = view === 'create' ? behaviour.create ?? 'success' : behaviour.signIn ?? 'success';
      if (result === 'success') pass();
      else if (result === 'exists') banner('An account with this email address already exists.');
      else if (result === 'wrong') banner('Wrong email or password.');
      else if (result === 'verify') banner('Please verify your email address. Check your inbox for the link.');
      else {
        // 人机验证的挑战框弹出来，墙还在；他过了关（5 秒之后），网站自己往下走。
        const frame = document.createElement('iframe');
        frame.setAttribute('src', 'https://www.google.com/recaptcha/api2/bframe?hl=en&k=placeholder');
        document.body.append(frame);
        const at = clock.now();
        clock.hooks.push(() => { if (clock.now() - at >= 5_000 && q('signInContent') !== null) pass(); });
      }
    });
  };
  show('choice');
  return { presses, show, view: () => view };
}

function harness(options: {
  create?: CreateResult;
  signIn?: SignInResult;
  credential?: DockAccountAccessReply;
  policy?: ApplyPolicy;
  noWall?: boolean;
} = {}) {
  let t = Date.now();
  const hooks: (() => void)[] = [];
  const clock = { now: () => t, hooks };
  const wait = async (ms: number): Promise<void> => {
    t += ms;
    for (const hook of hooks) hook();
    await Promise.resolve();
  };
  const site = mountSite({ ...(options.create === undefined ? {} : { create: options.create }), ...(options.signIn === undefined ? {} : { signIn: options.signIn }) }, clock);
  if (options.noWall === true) document.body.innerHTML = '<form><label>First name<input></label></form>';
  const asked: DockAccountAccessPayload[] = [];
  const events: string[] = [];
  const prompts: (DockAccountPrompt | null)[] = [];
  const continued: GestureRoot[] = [];
  let returnListener: (() => void) | null = null;
  const writePolicy = options.policy ?? policy();
  const dock: AccountAccessDock = {
    status: (status) => { events.push(`status:${status.kind}`); },
    prompt: (prompt) => { prompts.push(prompt); events.push(prompt === null ? 'prompt:null' : `prompt:${prompt.kind}`); },
    note: (note) => { events.push(`note:${note.kind}`); },
    continuing: () => { events.push('continuing'); },
  };
  const chain = createFillToReview({
    now: clock.now,
    resolvePolicy: async () => writePolicy,
    advance: async () => 'ADVANCED',
    checkpoint: () => null,
    fillNextPage: () => {},
    dock: () => null,
  });
  const controller = createAccountAccessController({
    now: clock.now,
    wait,
    isVisible: visible,
    resolve: async () => ({
      policy: writePolicy,
      vendor: 'workday',
      wall: () => workdayAdapter.resolveAccountWall!(document),
      outcome: () => workdayAdapter.readAccountOutcome!(document, visible),
      // 规则里这一家的验证邮件从哪儿来（2026-10-04，emailVerification.mail）。
      mail: () => workdayAdapter.emailVerificationMail ?? null,
    }),
    ask: async (payload) => {
      asked.push(payload);
      if (payload.step === 'CREDENTIAL') {
        return options.credential ?? { kind: 'ACCOUNT_CREDENTIAL', email: EMAIL, password: PASSWORD, source: 'SHARED', generated: true, known: false };
      }
      return { kind: 'ACCOUNT_SAVED' };
    },
    checkpoint: () => detectHumanCheckpoint({ document, isVisible: visible, ignoreLogin: true }),
    chain: () => chain,
    page: () => ({ origin: ORIGIN, pathname: PATH }),
    dock: () => dock,
    continueFill: (root) => { continued.push(root); },
    site: () => 'Acme 的 Workday',
    onReturn: (listener) => {
      returnListener = listener;
      return () => { returnListener = null; };
    },
  });
  return {
    site,
    asked,
    events,
    prompts,
    continued,
    controller,
    run: (signal = new AbortController().signal) => controller.run(trustedProof(), signal),
    comeBack: () => returnListener?.(),
    returning: () => returnListener !== null,
  };
}

/** 发给 worker 的每一条消息里都没有密码。 */
function expectNoPasswordIn(asked: readonly DockAccountAccessPayload[]): void {
  expect(asked.every((payload) => payload.step === 'STATUS' || payload.step === 'CREDENTIAL' || payload.step === 'RECORD')).toBe(true);
  expect(JSON.stringify(asked)).not.toContain(PASSWORD);
}

describe('注册', () => {
  it('选「用邮箱登录」→ 切到注册 → 邮箱、密码写两遍、勾注册条款 → 按注册 → 墙没了：记下、照实说、用下一页的凭证接着填', async () => {
    const h = harness();
    expect(await h.run()).toBe('CONTINUED');
    expect(h.site.presses).toEqual([{ view: 'create', email: EMAIL, password: PASSWORD, verify: PASSWORD, terms: true, honeypot: '' }]);
    expect(h.asked).toEqual([{ step: 'CREDENTIAL' }, { step: 'RECORD', outcome: 'CREATED' }]);
    expectNoPasswordIn(h.asked);
    expect(h.events).toEqual([
      'status:PREPARING',
      'status:CHOOSING',
      'status:REGISTERING',
      'note:REGISTERED',
      'note:TERMS_ACCEPTED',
      'prompt:null',
      'continuing',
    ]);
    expect(h.continued).toHaveLength(1);
    expect(isAdvanceRunPage(h.continued[0])).toBe(true);
  });

  it('网站说这个邮箱已经有账号：记下，改用保存的密码登录，登录成了接着填', async () => {
    const h = harness({ create: 'exists' });
    expect(await h.run()).toBe('CONTINUED');
    expect(h.site.presses.map((press) => press.view)).toEqual(['create', 'signIn']);
    expect(h.site.presses[1]).toMatchObject({ email: EMAIL, password: PASSWORD, verify: null });
    expect(h.asked).toEqual([{ step: 'CREDENTIAL' }, { step: 'RECORD', outcome: 'EXISTS' }, { step: 'RECORD', outcome: 'SIGNED_IN' }]);
    expectNoPasswordIn(h.asked);
    expect(h.events).toContain('note:ACCOUNT_EXISTS');
    expect(h.events).toContain('status:SIGNING_IN');
    expect(h.events).toContain('note:SIGNED_IN');
    expect(h.events.at(-1)).toBe('continuing');
  });
});

describe('登录', () => {
  it('这一家已经有他的账号：直接登录；密码不对 → 不再乱试，请他在浮层里输这一家的密码', async () => {
    const h = harness({
      signIn: 'wrong',
      credential: { kind: 'ACCOUNT_CREDENTIAL', email: EMAIL, password: PASSWORD, source: 'SHARED', generated: false, known: true },
    });
    expect(await h.run()).toBe('STOPPED');
    expect(h.site.presses).toHaveLength(1);
    expect(h.site.presses[0]).toMatchObject({ view: 'signIn', email: EMAIL, password: PASSWORD });
    expect(h.events.at(-1)).toBe('prompt:SITE_PASSWORD');
    expect(h.continued).toHaveLength(0);
    expectNoPasswordIn(h.asked);
  });
});

describe('要他本人做的', () => {
  it('网站要验证邮箱：记下账号有了、照实说；他回到这一页（标签页重新获得焦点）才接着登录，过去了接着填', async () => {
    const h = harness({ create: 'verify' });
    expect(await h.run()).toBe('STOPPED');
    expect(h.events).toContain('note:REGISTERED');
    expect(h.events.at(-1)).toBe('prompt:VERIFY_EMAIL');
    // 卡上一并说这一家的验证邮件从哪儿来（规则的 emailVerification.mail，2026-10-04）。
    expect(h.prompts.at(-1)).toMatchObject({ kind: 'VERIFY_EMAIL', email: EMAIL, mail: { from: ['…@myworkday.com'], subject: null } });
    expect(h.asked).toContainEqual({ step: 'RECORD', outcome: 'CREATED' });
    expect(h.returning()).toBe(true);
    // 他去邮箱点了链接，回到这一页。
    h.comeBack();
    await vi.waitFor(() => expect(h.continued).toHaveLength(1));
    expect(h.site.presses.map((press) => press.view)).toEqual(['create', 'signIn']);
    expect(h.events).toContain('note:SIGNED_IN');
    expect(h.returning()).toBe(false);
    expectNoPasswordIn(h.asked);
  });

  it('按了注册之后弹出人机验证：请他本人完成、接着等，一下都不替他点；他过了、墙没了就接着填', async () => {
    const h = harness({ create: 'captcha' });
    expect(await h.run()).toBe('CONTINUED');
    expect(h.site.presses).toHaveLength(1);
    const asked = h.events.indexOf('prompt:CAPTCHA');
    expect(asked).toBeGreaterThan(0);
    expect(h.events.slice(asked)).toEqual(['prompt:CAPTCHA', 'note:REGISTERED', 'note:TERMS_ACCEPTED', 'prompt:null', 'continuing']);
  });

  it('他按了「停止」：一下都不按', async () => {
    const h = harness();
    const stop = new AbortController();
    stop.abort();
    expect(await h.run(stop.signal)).toBe('STOPPED');
    expect(h.site.presses).toEqual([]);
    expect(h.site.view()).toBe('choice');
  });
});

describe('两把钥匙', () => {
  it('没同意点名这一类的那一版：拿不到密码，一格不写、一下不按，请他去资料里开', async () => {
    const h = harness({ credential: { kind: 'REFUSED', code: 'CONSENT_REQUIRED' } });
    expect(await h.run()).toBe('STOPPED');
    expect(h.events).toEqual(['status:PREPARING', 'prompt:CONSENT']);
    expect(h.site.presses).toEqual([]);
    expect(h.site.view()).toBe('choice');
  });

  it('运行时包没放行 account-access：连密码都不问，照实说要他自己登录', async () => {
    const h = harness({ policy: policy(false) });
    expect(await h.run()).toBe('STOPPED');
    expect(h.asked).toEqual([]);
    expect(h.events).toEqual(['prompt:OFF']);
    expect(h.site.view()).toBe('choice');
  });

  it('worker 那边关着（这一家、这一页不在范围里）：DISABLED 也照实说', async () => {
    const h = harness({ credential: { kind: 'REFUSED', code: 'DISABLED' } });
    expect(await h.run()).toBe('STOPPED');
    expect(h.events.at(-1)).toBe('prompt:OFF');
    expect(h.site.presses).toEqual([]);
  });
});

it('这一页没有规则声明的账号墙：NO_WALL（调用方照旧填这一页），什么都不问', async () => {
  const h = harness({ noWall: true });
  expect(await h.run()).toBe('NO_WALL');
  expect(h.asked).toEqual([]);
  expect(h.events).toEqual([]);
});
