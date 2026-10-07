import assert from 'node:assert/strict';
import test from 'node:test';
import { PwaRuntime, PWA_UPDATE_CHECK_INTERVAL_MS, pwaNotices, publicConnectionCopy, readWorkspaceBootstrap, WORKSPACE_CONNECTION_TIMEOUT_MS, type PwaEnvironment, type PwaRegisterOptions } from '../src/pwa-runtime.ts';
import { AccountOperationScope, executeAccountOperation } from '../src/account-operations.ts';
import { parseAuthOptions } from '../src/account-actions.ts';

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function flush() { await Promise.resolve(); await Promise.resolve(); }
function setup(options: { production?: boolean; supported?: boolean; loader?: PwaEnvironment['loadRegister'] } = {}) {
  const runtime = new PwaRuntime();
  let now = 0, online = true, visible = true, loads = 0, registrations = 0, activationCalls = 0;
  let connectivity: (() => void) | undefined, visibility: (() => void) | undefined, callbacks: PwaRegisterOptions | undefined;
  const timers = new Map<number, () => void>(); const delays: number[] = []; let sequence = 0;
  const environment: PwaEnvironment = {
    production: options.production ?? true, supported: options.supported ?? true,
    isOnline: () => online, isVisible: () => visible, now: () => now,
    subscribeConnectivity: (run) => { connectivity = run; return () => { connectivity = undefined; }; },
    subscribeVisibility: (run) => { visibility = run; return () => { visibility = undefined; }; },
    loadRegister: () => { ++loads; return options.loader?.() ?? Promise.resolve((value) => { ++registrations; callbacks = value; return () => { ++activationCalls; throw new Error('A waiting version must never be force-activated.'); }; }); },
    setTimer: (run, delay) => { delays.push(delay); const id = ++sequence; timers.set(id, run); return id; }, clearTimer: (timer) => { timers.delete(timer as number); },
  };
  return { runtime, environment, timers, delays, get callbacks() { return callbacks!; }, get loads() { return loads; }, get registrations() { return registrations; }, get activationCalls() { return activationCalls; },
    setNow(value: number) { now = value; }, setOnline(value: boolean) { online = value; connectivity?.(); }, setVisible(value: boolean) { visible = value; visibility?.(); },
    tick() { const [id, run] = timers.entries().next().value!; timers.delete(id); run(); },
    get subscribed() { return !!connectivity || !!visibility; },
  };
}

test('public runtime imports without window and development or unsupported browsers never load registration', () => {
  assert.equal(typeof globalThis.window, 'undefined');
  for (const options of [{ production: false }, { supported: false }]) {
    const fixture = setup(options); fixture.runtime.start(fixture.environment);
    assert.equal(fixture.loads, 0); assert.equal(fixture.runtime.getSnapshot().registration, 'disabled');
    fixture.setOnline(false); assert.equal(fixture.runtime.getSnapshot().online, false);
    fixture.runtime.dispose(); assert.equal(fixture.subscribed, false); assert.equal(fixture.timers.size, 0);
  }
});

test('prompt registration is once per runtime and readiness never invokes the activation function', async () => {
  const fixture = setup(); let notifications = 0;
  const unsubscribe = fixture.runtime.subscribe(() => ++notifications);
  fixture.runtime.start(fixture.environment); fixture.runtime.start(fixture.environment); await flush();
  assert.equal(fixture.loads, 1); assert.equal(fixture.registrations, 1); assert.equal(fixture.callbacks.immediate, false);
  fixture.callbacks.onRegisteredSW('/public-worker.js', { update: async () => {} });
  fixture.callbacks.onOfflineReady(); fixture.callbacks.onNeedRefresh();
  const state = fixture.runtime.getSnapshot(), notificationsBefore = notifications;
  fixture.callbacks.onNeedRefresh();
  assert.strictEqual(fixture.runtime.getSnapshot(), state); assert.equal(notifications, notificationsBefore);
  assert.equal(state.offlineReady, true); assert.equal(state.updateReady, true); assert.equal(fixture.activationCalls, 0);
  const copy = pwaNotices(state).map((notice) => notice.text).join(' ');
  assert.match(copy, /保存或复制需要保留的内容/); assert.match(copy, /结束录音或对话/); assert.match(copy, /所有页面窗口/);
  assert.equal(pwaNotices(state).some((notice) => notice.id === 'ready'), false);
  unsubscribe(); fixture.runtime.dispose(); assert.equal(fixture.timers.size, 0);
});

test('disposed import and previous-generation callbacks cannot register or publish after restart', async () => {
  const loader = deferred<(options: PwaRegisterOptions) => unknown>(); let lateRegistrations = 0;
  const fixture = setup({ loader: () => loader.promise }); fixture.runtime.start(fixture.environment); fixture.runtime.dispose();
  loader.resolve(() => { ++lateRegistrations; }); await flush(); assert.equal(lateRegistrations, 0);
  const restarted = setup(); restarted.runtime.start(restarted.environment); await flush(); const old = restarted.callbacks;
  restarted.runtime.dispose(); restarted.runtime.start(restarted.environment); await flush();
  const current = restarted.runtime.getSnapshot(); old.onNeedRefresh(); old.onOfflineReady(); old.onRegisterError(new Error('Fictional raw detail.'));
  assert.strictEqual(restarted.runtime.getSnapshot(), current); assert.equal(current.updateReady, false);
  restarted.runtime.dispose();
});

test('registration/import failure exposes public wording without keeping the raw failure', async () => {
  const fixture = setup({ loader: async () => { throw new Error('Fictional private-looking raw detail.'); } });
  fixture.runtime.start(fixture.environment); await flush();
  assert.equal(fixture.runtime.getSnapshot().registration, 'unavailable');
  assert.doesNotMatch(JSON.stringify(pwaNotices(fixture.runtime.getSnapshot())), /private-looking|raw detail/);
  fixture.runtime.dispose();
});

test('long-lived pages only check a public worker after cooldown while visible/online and never activate', async () => {
  const fixture = setup(); const pending = deferred<void>(); let checks = 0;
  fixture.runtime.start(fixture.environment); await flush(); fixture.callbacks.onRegisteredSW('/public-worker.js', { update: () => { ++checks; return pending.promise; } });
  assert.deepEqual(fixture.delays, [PWA_UPDATE_CHECK_INTERVAL_MS]);
  fixture.setOnline(true); fixture.setVisible(true); assert.equal(checks, 0);
  fixture.setNow(PWA_UPDATE_CHECK_INTERVAL_MS); fixture.setVisible(false); fixture.tick(); assert.equal(checks, 0);
  fixture.setOnline(false); fixture.setVisible(true); assert.equal(checks, 0);
  fixture.setOnline(true); assert.equal(checks, 1);
  fixture.setNow(PWA_UPDATE_CHECK_INTERVAL_MS * 2); fixture.setVisible(true); fixture.tick(); assert.equal(checks, 1);
  pending.resolve(); await flush(); fixture.callbacks.onNeedRefresh();
  fixture.setNow(PWA_UPDATE_CHECK_INTERVAL_MS * 3); fixture.tick(); assert.equal(checks, 1); assert.equal(fixture.activationCalls, 0);
  fixture.runtime.dispose(); assert.equal(fixture.timers.size, 0); assert.equal(fixture.subscribed, false);
});

test('failed background checks keep the current page and can retry after another cooldown', async () => {
  const fixture = setup(); let checks = 0;
  fixture.runtime.start(fixture.environment); await flush(); fixture.callbacks.onRegisteredSW('/public-worker.js', { update: async () => { ++checks; throw new Error('Fictional worker fetch error.'); } });
  fixture.setNow(PWA_UPDATE_CHECK_INTERVAL_MS); fixture.tick(); await flush();
  assert.equal(checks, 1); assert.equal(fixture.runtime.getSnapshot().registration, 'registered');
  fixture.setNow(PWA_UPDATE_CHECK_INTERVAL_MS * 2); fixture.tick(); await flush(); assert.equal(checks, 2);
  assert.equal(fixture.activationCalls, 0); fixture.runtime.dispose();
});

test('offline/connected-with-unreachable-service public entry is distinct from an authenticated or model-ready workspace', () => {
  assert.match(publicConnectionCopy(false, false).title, /无法联网/);
  assert.match(publicConnectionCopy(true, false).title, /无法连接账号服务/);
  assert.match(publicConnectionCopy(true, false).text, /无法确认登录状态/);
  assert.match(publicConnectionCopy(true, true).text, /确认账号服务和当前登录状态/);
  const notices = pwaNotices({ online: false, registration: 'registered', offlineReady: true, updateReady: true });
  assert.deepEqual(notices.map((notice) => notice.id), ['offline', 'update']); assert.equal(notices[0].dismissible, false);
  assert.match(pwaNotices({ online: true, registration: 'registered', offlineReady: true, updateReady: false })[0].text, /登录、会话、资料和模型仍需联网/);
});

const options = { emailActionsEnabled: false, requireVerifiedEmail: false, requireInvite: true, legal: { status: 'unavailable' as const } };
const fixtureUser = { id: '11111111-1111-4111-8111-111111111111', email: 'fictional@example.invalid', emailVerified: false };
const anonymous = (failure: unknown) => !!failure && typeof failure === 'object' && (failure as { status?: number }).status === 401;
function timing() { let run: (() => void) | null = null; let delay = 0; return { setTimer(value: () => void, ms: number) { run = value; delay = ms; return 1; }, clearTimer() { run = null; }, fire() { run?.(); }, get pending() { return !!run; }, get delay() { return delay; } }; }

test('each explicit bootstrap retry rechecks actual me/options and only uses four read-only routes', async () => {
  const paths: string[] = []; let turn = 0;
  const read = async (path: string) => { paths.push(path); if (path === '/auth/options') return options; if (path === '/auth/me') { if (!turn) throw Object.assign(new Error('Fictional anonymous.'), { status: 401 }); return { user: fixtureUser }; } return path === '/capabilities' ? { capabilities: { chat: false } } : path === '/features' ? { version: 1, workbench: false, providerDetails: false } : { status: 'ok' }; };
  const clock = timing(); const first = await readWorkspaceBootstrap(read, new AbortController().signal, parseAuthOptions, anonymous, clock);
  assert.equal(first.account, null); assert.deepEqual(first.options, options); assert.equal(clock.pending, false);
  ++turn; const second = await readWorkspaceBootstrap(read, new AbortController().signal, parseAuthOptions, anonymous, clock);
  assert.deepEqual(second.account, { user: fixtureUser }); assert.equal(clock.pending, false);
  assert.deepEqual(paths, ['/auth/options', '/auth/me', '/ready', '/capabilities', '/features', '/auth/options', '/auth/me', '/ready', '/capabilities', '/features']);
});

test('network failure while browser says online remains a public bootstrap failure, never an anonymous success', async () => {
  const clock = timing();
  await assert.rejects(readWorkspaceBootstrap(async (path) => { if (path === '/auth/options') return options; throw new TypeError('Fictional unreachable network.'); }, new AbortController().signal, parseAuthOptions, anonymous, clock));
  assert.equal(clock.pending, false);
});

test('bootstrap timeout/cancel is bounded and ignores late transport completion even if transport ignores abort', async () => {
  for (const mode of ['timeout', 'cancel']) {
    const pending = deferred<unknown>(), external = new AbortController(), clock = timing(); const signals: AbortSignal[] = [];
    const operation = readWorkspaceBootstrap((_path, signal) => { signals.push(signal); return pending.promise; }, external.signal, parseAuthOptions, anonymous, clock);
    assert.equal(clock.delay, WORKSPACE_CONNECTION_TIMEOUT_MS);
    if (mode === 'timeout') clock.fire(); else external.abort();
    await assert.rejects(operation, { name: 'AbortError' }); assert.equal(clock.pending, false);
    assert.equal(signals.length, 5); assert.ok(signals.every((signal) => signal.aborted));
    pending.resolve(options); await flush();
  }
  let calls = 0; const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(readWorkspaceBootstrap(async () => { ++calls; return options; }, cancelled.signal, parseAuthOptions, anonymous));
  assert.equal(calls, 0);
});

test('old initialization cannot restore a previous account or finish a newer retry after account/action changes', async () => {
  const scope = new AccountOperationScope(); scope.activate(); scope.changeSession(null);
  const first = scope.begin('initialization', false)!; const pending = deferred<unknown>(); let restored = 0, failed = 0, finished = 0;
  const initial = executeAccountOperation(scope, first, () => readWorkspaceBootstrap(async (path) => path === '/auth/me' ? pending.promise : path === '/auth/options' ? options : {}, new AbortController().signal, parseAuthOptions, anonymous), {
    apply: () => ++restored, onError: () => ++failed, finally: () => ++finished,
  });
  scope.changeSession('22222222-2222-4222-8222-222222222222');
  pending.resolve({ user: fixtureUser });
  assert.deepEqual(await initial, { status: 'discarded' }); assert.deepEqual([restored, failed, finished], [0, 0, 0]); scope.dispose();
});
