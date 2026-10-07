// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { captureTrustedShadowGesture, isAdvanceRunPage, type GestureRoot, type TrustedGestureProof } from '@edaix/apply-kernel/grant';
import { createBundledApplyPolicy, type ApplyPolicy } from '@edaix/apply-kernel/policy';
import { workdayAdapter } from '@edaix/apply-kernel/sites/workday';
import { detectHumanCheckpoint } from '@edaix/apply-kernel/wizardAdvance';

import { createAccountAccessController, type AccountAccessDock, type AccountPasswordPromptContext } from '../lib/accountAccessController';
import type { DockAccountAccessPayload, DockAccountAccessReply } from '../lib/accountAccessIntent';
import type { DockAccountPrompt } from '../lib/dock/types';
import { createFillToReview } from '../lib/fillToReview';

/**
 * 替用户在招聘网站上注册、登录，然后接着填（2026-09-28）。用内核的真规则（workday.json 的 accountSteps）与合成夹具
 * （结构照 nvidia.wd5 的只读实测）演一个网站：按了哪颗、网站怎么回。锁的是每一种结局浮层上说什么、下一步做什么，以及：
 *  · 两把钥匙缺一把，一格不写、一下不按；
 *  · 密码只写进规则声明的那几格（蜜罐一个字不写），不进发给 worker 之外的任何消息——这里发出去的只有 STATUS／CREDENTIAL／
 *    CHECK／RECORD，一条都不带密码；
 *  · 密码不对不乱试；已存在账号及邮箱待验证都停止，不复用随机密码登录。
 */

const FIXTURES = resolve(__dirname, '..', '..', '..', 'packages', 'apply-kernel', 'tests', 'fixtures', 'workday');
const fixture = (name: string): string => readFileSync(resolve(FIXTURES, name), 'utf8');
const ORIGIN = 'https://tenant.wd5.myworkdayjobs.com';
const PATH = '/en-US/site/job/x/apply/applyManually';
const EMAIL = 'candidate@example.test';
const PASSWORD = 'Tr1ck-y!Horse#42';
const OPERATION = 'd29f7095-af12-4141-8000-123456789abc';
const AUTH_EPOCH = 7;
const bound = { operationId: OPERATION, expectedEpoch: AUTH_EPOCH };
const PROMPT_OPERATION = 'c88809bb-72b4-4141-8000-123456789abc';
const promptReply = { kind: 'ACCOUNT_PASSWORD_PROMPT' as const, operationId: PROMPT_OPERATION, authEpoch: AUTH_EPOCH, email: EMAIL };
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
type CreateResult = 'success' | 'exists' | 'verify' | 'captcha' | 'noResponse';
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
      else if (result === 'noResponse') { /* No observed outcome: keep the actual account wall. */ }
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
  return { presses, show, view: () => view, setCreate: (result: CreateResult) => { behaviour.create = result; } };
}

function harness(options: {
  create?: CreateResult;
  signIn?: SignInResult;
  credential?: DockAccountAccessReply;
  policy?: ApplyPolicy;
  noWall?: boolean;
  initialView?: View;
  check?: (index: number) => Promise<DockAccountAccessReply> | DockAccountAccessReply;
  record?: (payload: Extract<DockAccountAccessPayload, { step: 'RECORD' }>) => Promise<DockAccountAccessReply> | DockAccountAccessReply;
  ask?: (payload: DockAccountAccessPayload) => Promise<DockAccountAccessReply | undefined>;
  wallRead?: (index: number, presses: readonly Press[]) => void;
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
  if (options.initialView !== undefined) site.show(options.initialView);
  if (options.noWall === true) document.body.innerHTML = '<form><label>First name<input></label></form>';
  const asked: DockAccountAccessPayload[] = [];
  const events: string[] = [];
  const prompts: (DockAccountPrompt | null)[] = [];
  const continued: GestureRoot[] = [];
  const passwordContexts: (AccountPasswordPromptContext | null)[] = [];
  let returnListener: (() => void) | null = null;
  let checks = 0;
  let wallReads = 0;
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
      wall: () => { options.wallRead?.(++wallReads, site.presses); return workdayAdapter.resolveAccountWall!(document); },
      outcome: () => workdayAdapter.readAccountOutcome!(document, visible),
      // 规则里这一家的验证邮件从哪儿来（2026-10-04，emailVerification.mail）。
      mail: () => workdayAdapter.emailVerificationMail ?? null,
    }),
    ask: async (payload) => {
      asked.push(payload);
      const intercepted = await options.ask?.(payload);
      if (intercepted !== undefined) return intercepted;
      if (payload.step === 'STATUS') return { kind: 'ACCOUNT_STATUS', consent: true, enabled: true,
        known: options.credential?.kind === 'ACCOUNT_CREDENTIAL' && options.credential.known, operationId: OPERATION, authEpoch: AUTH_EPOCH };
      if (payload.step === 'CHECK') return options.check?.(++checks) ?? { kind: 'ACCOUNT_CURRENT' };
      if (payload.step === 'CREDENTIAL') {
        return options.credential ?? { kind: 'ACCOUNT_CREDENTIAL', email: EMAIL, password: PASSWORD, source: 'GENERATED', generated: true, known: false, operationId: OPERATION, authEpoch: AUTH_EPOCH };
      }
      if (payload.step === 'RECORD' && options.record !== undefined) return options.record(payload);
      if (payload.step === 'PASSWORD_PROMPT' || (payload.step === 'RECORD' && (payload.outcome === 'EXISTS' || payload.outcome === 'VERIFICATION_REQUIRED'))) return promptReply;
      return { kind: 'ACCOUNT_SAVED' };
    },
    onPasswordPrompt: context => passwordContexts.push(context),
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
    passwordContexts,
    controller,
    run: (signal = new AbortController().signal, status?: Extract<DockAccountAccessReply, { kind: 'ACCOUNT_STATUS' }>) => controller.run(trustedProof(), signal, status),
    comeBack: () => returnListener?.(),
    returning: () => returnListener !== null,
  };
}

/** 发给 worker 的每一条消息里都没有密码。 */
function expectNoPasswordIn(asked: readonly DockAccountAccessPayload[]): void {
  expect(asked.every((payload) => payload.step === 'STATUS' || payload.step === 'CREDENTIAL' || payload.step === 'CHECK' || payload.step === 'RECORD' || payload.step === 'PASSWORD_PROMPT')).toBe(true);
  for (const payload of asked.filter(payload => payload.step === 'CHECK' || payload.step === 'RECORD' || payload.step === 'PASSWORD_PROMPT')) expect(payload).toMatchObject(bound);
  expect(JSON.stringify(asked)).not.toContain(PASSWORD);
}

describe('注册', () => {
  it('选「用邮箱登录」→ 切到注册 → 邮箱、密码写两遍、勾注册条款 → 按注册 → 墙没了：记下、照实说、用下一页的凭证接着填', async () => {
    const h = harness();
    expect(await h.run()).toBe('CONTINUED');
    expect(h.site.presses).toEqual([{ view: 'create', email: EMAIL, password: PASSWORD, verify: PASSWORD, terms: true, honeypot: '' }]);
    expect(h.asked.filter(payload => payload.step !== 'CHECK')).toEqual([{ step: 'STATUS' }, { step: 'CREDENTIAL', purpose: 'register', ...bound }, { step: 'RECORD', outcome: 'CREATED', ...bound }]);
    expect(h.asked.filter(payload => payload.step === 'CHECK')).toHaveLength(5);
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

  it('网站说这个邮箱已经有账号：等待真实记录完成后请本人输入密码，不把新随机密码当登录凭证', async () => {
    const h = harness({ create: 'exists' });
    expect(await h.run()).toBe('STOPPED');
    expect(h.site.presses.map((press) => press.view)).toEqual(['create']);
    expect(h.asked.filter(payload => payload.step !== 'CHECK')).toEqual([{ step: 'STATUS' }, { step: 'CREDENTIAL', purpose: 'register', ...bound }, { step: 'RECORD', outcome: 'EXISTS', ...bound }]);
    expectNoPasswordIn(h.asked);
    expect(h.events).toContain('note:ACCOUNT_EXISTS');
    expect(h.events).not.toContain('status:SIGNING_IN');
    expect(h.events).not.toContain('note:SIGNED_IN');
    expect(h.events.at(-1)).toBe('prompt:SITE_PASSWORD');
    expect(h.continued).toHaveLength(0);
  });
});

describe('登录', () => {
  it('这一家已经有他的账号：直接登录；密码不对 → 不再乱试，请他在浮层里输这一家的密码', async () => {
    const h = harness({
      signIn: 'wrong',
      credential: { kind: 'ACCOUNT_CREDENTIAL', email: EMAIL, password: PASSWORD, source: 'LEGACY_SHARED', generated: false, known: true, operationId: OPERATION, authEpoch: AUTH_EPOCH },
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
  it('网站要验证邮箱：只记待验证；回到标签页不自动登录，不误报注册完成', async () => {
    const h = harness({ create: 'verify' });
    expect(await h.run()).toBe('STOPPED');
    expect(h.events).not.toContain('note:REGISTERED');
    expect(h.events.at(-1)).toBe('prompt:VERIFY_EMAIL');
    // 卡上一并说这一家的验证邮件从哪儿来（规则的 emailVerification.mail，2026-10-04）。
    expect(h.prompts.at(-1)).toMatchObject({ kind: 'VERIFY_EMAIL', email: EMAIL, mail: { from: ['…@myworkday.com'], subject: null } });
    expect(h.asked).toContainEqual({ step: 'RECORD', outcome: 'VERIFICATION_REQUIRED', ...bound });
    expect(h.returning()).toBe(false);
    // 他去邮箱点了链接，回到这一页。
    h.comeBack();
    await Promise.resolve();
    expect(h.continued).toHaveLength(0);
    expect(h.site.presses.map((press) => press.view)).toEqual(['create']);
    expect(h.events).not.toContain('note:SIGNED_IN');
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function waitFor(predicate: () => boolean) {
  for (let index = 0; index < 100; index++) { if (predicate()) return; await Promise.resolve(); }
  throw new Error('Deferred controller stage was not reached');
}

describe('会话和保险箱操作绑定', () => {
  it('本人新点击重试仅派生旧 credential 的真实 prompt，不复用已消费的 STATUS', async () => {
    const h = harness({ create: 'noResponse' }); const status = { kind: 'ACCOUNT_STATUS' as const, consent: true, enabled: true, known: false,
      operationId: OPERATION, authEpoch: AUTH_EPOCH };
    expect(await h.run(new AbortController().signal, status)).toBe('STOPPED');
    expect(h.events).not.toContain('note:REGISTERED'); expect(h.asked.filter(payload => payload.step === 'RECORD')).toEqual([]);
    const count = h.asked.length; h.site.setCreate('success');
    expect(await h.run(new AbortController().signal, status)).toBe('CONTINUED');
    expect(h.asked.slice(count, count + 2)).toEqual([{ step: 'PASSWORD_PROMPT', ...bound },
      { step: 'CREDENTIAL', purpose: 'register', operationId: PROMPT_OPERATION, expectedEpoch: AUTH_EPOCH }]);
    expect(h.asked.filter(payload => payload.step === 'STATUS')).toEqual([]);
    expect(h.site.presses).toHaveLength(2); expect(h.continued).toHaveLength(1);
  });

  for (const code of ['AUTH_CHANGED', 'OPERATION_STALE'] as const) {
    it(`重试派生被 ${code} 拒绝，无 fresh STATUS 或新 credential 重绑`, async () => {
      let refusing = false;
      const h = harness({ create: 'noResponse', ask: async payload => refusing && payload.step === 'PASSWORD_PROMPT' ? { kind: 'REFUSED', code } : undefined });
      const status = { kind: 'ACCOUNT_STATUS' as const, consent: true, enabled: true, known: false, operationId: OPERATION, authEpoch: AUTH_EPOCH };
      expect(await h.run(new AbortController().signal, status)).toBe('STOPPED');
      const count = h.asked.length; refusing = true;
      expect(await h.run(new AbortController().signal, status)).toBe('STOPPED');
      expect(h.asked.slice(count)).toEqual([{ step: 'PASSWORD_PROMPT', ...bound }]);
      expect(h.site.presses).toHaveLength(1); expect(h.continued).toEqual([]);
    });
  }

  it('新展示 status 不能借用上一 status 的 retry metadata', async () => {
    const h = harness({ create: 'noResponse' }); const old = { kind: 'ACCOUNT_STATUS' as const, consent: true, enabled: true, known: false,
      operationId: OPERATION, authEpoch: AUTH_EPOCH };
    expect(await h.run(new AbortController().signal, old)).toBe('STOPPED');
    const count = h.asked.length; h.site.setCreate('success');
    expect(await h.run(new AbortController().signal, { ...old, operationId: PROMPT_OPERATION })).toBe('CONTINUED');
    expect(h.asked[count]).toEqual({ step: 'CREDENTIAL', purpose: 'register', operationId: PROMPT_OPERATION, expectedEpoch: AUTH_EPOCH });
    expect(h.asked.slice(count).filter(payload => payload.step === 'PASSWORD_PROMPT')).toEqual([]);
  });

  it('RECORD 完成和 dispose 都清掉旧 retry metadata', async () => {
    for (const mode of ['recorded', 'disposed'] as const) {
      const h = harness({ create: mode === 'recorded' ? 'success' : 'noResponse' });
      const status = { kind: 'ACCOUNT_STATUS' as const, consent: true, enabled: true, known: false, operationId: OPERATION, authEpoch: AUTH_EPOCH };
      await h.run(new AbortController().signal, status);
      if (mode === 'recorded') h.site.show('create'); else h.controller.dispose();
      h.site.setCreate('success'); const count = h.asked.length;
      await h.run(new AbortController().signal, status);
      expect(h.asked.slice(count).filter(payload => payload.step === 'PASSWORD_PROMPT')).toEqual([]);
      expect(h.asked[count]).toEqual({ step: 'CREDENTIAL', purpose: 'register', ...bound });
    }
  });

  for (const stage of ['initial', 'drive', 'submitted'] as const) {
    it(`${stage} 真实扫描抛错不算账号墙消失，不写注册完成回执`, async () => {
      const h = harness({ wallRead: (index, presses) => {
        if ((stage === 'initial' && index === 1) || (stage === 'drive' && index === 2) || (stage === 'submitted' && presses.length > 0)) throw new Error('synthetic account scanner failure');
      } });
      expect(await h.run()).toBe('STOPPED');
      expect(h.site.presses).toHaveLength(stage === 'submitted' ? 1 : 0);
      expect(h.asked.filter(payload => payload.step === 'RECORD')).toEqual([]);
      expect(h.events).not.toContain('note:REGISTERED'); expect(h.events.at(-1)).toBe('prompt:FAILED');
      expect(h.continued).toEqual([]);
    });
  }

  it('真实页面传展示时的 status，CREDENTIAL 继承该 op，不 click 后 fresh STATUS', async () => {
    const h = harness(); const status = { kind: 'ACCOUNT_STATUS' as const, consent: true, enabled: true, known: false,
      operationId: OPERATION, authEpoch: AUTH_EPOCH };
    expect(await h.run(new AbortController().signal, status)).toBe('CONTINUED');
    expect(h.asked.filter(payload => payload.step === 'STATUS')).toEqual([]);
    expect(h.asked[0]).toEqual({ step: 'CREDENTIAL', purpose: 'register', ...bound });
    expect(h.site.presses).toHaveLength(1); expect(h.continued).toHaveLength(1);
  });

  it('旧 A status 的点击遇到 worker 身份变更拒绝，不重新认 B status 或写字段', async () => {
    const h = harness({ credential: { kind: 'REFUSED', code: 'AUTH_CHANGED' } });
    const status = { kind: 'ACCOUNT_STATUS' as const, consent: true, enabled: true, known: false,
      operationId: OPERATION, authEpoch: AUTH_EPOCH };
    expect(await h.run(new AbortController().signal, status)).toBe('STOPPED');
    expect(h.asked).toEqual([{ step: 'CREDENTIAL', purpose: 'register', ...bound }]);
    expect(h.site.view()).toBe('choice'); expect(h.site.presses).toEqual([]); expect(h.continued).toEqual([]);
  });

  it('STATUS 后晚到另一 auth epoch 的 credential，不写入也不打开 account run', async () => {
    const h = harness({ credential: { kind: 'ACCOUNT_CREDENTIAL', email: EMAIL, password: PASSWORD,
      source: 'GENERATED', generated: true, known: false, operationId: OPERATION, authEpoch: AUTH_EPOCH + 1 } });
    expect(await h.run()).toBe('STOPPED');
    expect(h.site.view()).toBe('choice'); expect(h.site.presses).toEqual([]); expect(h.continued).toEqual([]);
    expect(h.asked).toEqual([{ step: 'STATUS' }, { step: 'CREDENTIAL', purpose: 'register', ...bound }]);
    expect(h.events.at(-1)).toBe('prompt:UNAVAILABLE');
  });

  it('实际登录页只请求 login；没有已确认密码就零填写并绑定显示时的 prompt', async () => {
    const h = harness({ initialView: 'signIn', credential: { kind: 'REFUSED', code: 'NO_PASSWORD', operationId: PROMPT_OPERATION, authEpoch: AUTH_EPOCH } });
    expect(await h.run()).toBe('STOPPED');
    expect(h.asked).toEqual([{ step: 'STATUS' }, { step: 'CREDENTIAL', purpose: 'login', ...bound }]);
    expect(h.site.presses).toEqual([]);
    expect((document.querySelector('[data-automation-id="password"]') as HTMLInputElement).value).toBe('');
    expect(h.passwordContexts.at(-1)).toEqual({ operationId: PROMPT_OPERATION, authEpoch: AUTH_EPOCH });
    expect(h.events.at(-1)).toBe('prompt:SITE_PASSWORD');
  });

  it('实际登录页不接受仍为未知的随机注册凭证', async () => {
    const h = harness({ initialView: 'signIn' });
    expect(await h.run()).toBe('STOPPED'); expect(h.site.presses).toEqual([]); expect(h.continued).toEqual([]);
    expect(h.asked).toEqual([{ step: 'STATUS' }, { step: 'CREDENTIAL', purpose: 'login', ...bound }]);
    expect((document.querySelector('[data-automation-id="password"]') as HTMLInputElement).value).toBe('');
  });

  for (const checkIndex of [1, 2, 3, 4, 5]) {
    it(`第 ${checkIndex} 次操作前 worker 拒绝，后续写入和提交停止`, async () => {
      const h = harness({ check: index => index === checkIndex ? { kind: 'REFUSED', code: 'AUTH_CHANGED' } : { kind: 'ACCOUNT_CURRENT' } });
      expect(await h.run()).toBe('STOPPED');
      expect(h.asked.filter(payload => payload.step === 'CHECK')).toHaveLength(checkIndex);
      expect(h.site.presses).toEqual([]); expect(h.continued).toEqual([]);
      const password = document.querySelector('[data-automation-id="password"]') as HTMLInputElement | null;
      if (checkIndex <= 3 && password !== null) expect(password.value).toBe('');
      const terms = document.querySelector('[data-automation-id="createAccountCheckbox"]') as HTMLInputElement | null;
      if (checkIndex <= 4 && terms !== null) expect(terms.checked).toBe(false);
      expectNoPasswordIn(h.asked);
    });
  }

  it('CHECK 正在 await 时取消或 dispose，不接受晚到的 ACCOUNT_CURRENT', async () => {
    for (const mode of ['abort', 'dispose'] as const) {
      const held = deferred<DockAccountAccessReply>();
      const h = harness({ check: () => held.promise }); const controller = new AbortController();
      const running = h.run(controller.signal); await waitFor(() => h.asked.some(payload => payload.step === 'CHECK'));
      if (mode === 'abort') controller.abort(); else h.controller.dispose();
      held.resolve({ kind: 'ACCOUNT_CURRENT' });
      expect(await running).toBe('STOPPED'); expect(h.site.view()).toBe('choice'); expect(h.site.presses).toEqual([]);
      expect(h.continued).toEqual([]); expect(h.passwordContexts.at(-1)).toBeNull();
    }
  });

  it('网站已过墙但 RECORD 尚未提交，不显示注册成功也不继续；失败按实际结果停止', async () => {
    const held = deferred<DockAccountAccessReply>(); const h = harness({ record: () => held.promise });
    const running = h.run(); let done = false; void running.then(() => { done = true; });
    await waitFor(() => h.asked.some(payload => payload.step === 'RECORD'));
    expect(done).toBe(false); expect(h.site.presses).toHaveLength(1);
    expect(h.events).not.toContain('note:REGISTERED'); expect(h.continued).toEqual([]);
    held.resolve({ kind: 'REFUSED', code: 'AUTH_CHANGED' });
    expect(await running).toBe('STOPPED'); expect(h.events).not.toContain('note:REGISTERED'); expect(h.continued).toEqual([]);
  });

  it('WrongPassword 用原 credential 派生 prompt，不 fresh STATUS 识别另一个用户', async () => {
    const h = harness({ signIn: 'wrong', credential: { kind: 'ACCOUNT_CREDENTIAL', email: EMAIL, password: PASSWORD,
      source: 'USER_SAVED', generated: false, known: true, operationId: OPERATION, authEpoch: AUTH_EPOCH } });
    expect(await h.run()).toBe('STOPPED');
    expect(h.asked.filter(payload => payload.step === 'STATUS')).toHaveLength(1);
    expect(h.asked.at(-1)).toEqual({ step: 'PASSWORD_PROMPT', ...bound });
    expect(h.passwordContexts.at(-1)).toEqual({ operationId: PROMPT_OPERATION, authEpoch: AUTH_EPOCH });
    expect(h.prompts.at(-1)).toMatchObject({ kind: 'SITE_PASSWORD', retry: true });
    h.controller.dispose(); expect(h.passwordContexts.at(-1)).toBeNull();
  });

  it('EXISTS 和待验证返回的新 prompt 绑定在 UI 显示之前；不把 consumed credential op 再用于输入', async () => {
    for (const create of ['exists', 'verify'] as const) {
      const h = harness({ create }); expect(await h.run()).toBe('STOPPED');
      expect(h.passwordContexts.at(-1)).toEqual({ operationId: PROMPT_OPERATION, authEpoch: AUTH_EPOCH });
      expect(h.asked.filter(payload => payload.step === 'STATUS')).toHaveLength(1);
      expect(h.asked.at(-1)).toMatchObject({ step: 'RECORD', outcome: create === 'exists' ? 'EXISTS' : 'VERIFICATION_REQUIRED', ...bound });
      expect(h.site.presses).toHaveLength(1); expect(h.events).not.toContain('note:REGISTERED'); expect(h.continued).toEqual([]);
    }
  });

  it('密码 prompt 派生等待期间 dispose，晚到 prompt 不重新绑定旧页面', async () => {
    const held = deferred<DockAccountAccessReply>();
    const h = harness({ signIn: 'wrong', credential: { kind: 'ACCOUNT_CREDENTIAL', email: EMAIL, password: PASSWORD,
      source: 'USER_SAVED', generated: false, known: true, operationId: OPERATION, authEpoch: AUTH_EPOCH },
      ask: async payload => payload.step === 'PASSWORD_PROMPT' ? held.promise : undefined });
    const running = h.run(); await waitFor(() => h.asked.some(payload => payload.step === 'PASSWORD_PROMPT'));
    h.controller.dispose(); held.resolve(promptReply);
    expect(await running).toBe('STOPPED'); expect(h.passwordContexts.at(-1)).toBeNull();
    expect(h.prompts).not.toContainEqual(expect.objectContaining({ kind: 'SITE_PASSWORD' }));
  });
});
