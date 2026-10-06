import test from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { chromium, type BrowserServer } from 'playwright';
import { ownBrowserServer } from '../src/owned-browser.ts';
import { executeBrowser } from '../src/executors.ts';
import { ProviderError } from '../src/errors.ts';

function fixture(close: (process: ChildProcess) => Promise<void>, kill: (process: ChildProcess) => Promise<void>) {
  const process = new ChildProcess();
  let closes = 0, kills = 0;
  return {
    process,
    server: {
      process: () => process,
      close: async () => { closes++; await close(process); },
      kill: async () => { kills++; await kill(process); },
    },
    counts: () => ({ closes, kills }),
  };
}
const pending = () => new Promise<void>(() => {});
const exited = async (process: ChildProcess) => { Object.defineProperty(process, 'exitCode', { value: 0 }); };
const killed = async (process: ChildProcess) => { Object.defineProperty(process, 'signalCode', { value: 'SIGKILL' }); };
const unconfirmed = (error: unknown) => error instanceof ProviderError && error.code === 'BROWSER_CLEANUP_UNCONFIRMED' &&
  !error.message.includes('PRIVATE_PROCESS_FIXTURE');

test('owned browser confirms graceful exit, shares completion and clears escalation', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(exited, killed), owned = ownBrowserServer(f.server);
  const first = owned.close();
  assert.equal(owned.close(), first);
  await first;
  context.mock.timers.tick(1500);
  await Promise.resolve();
  assert.deepEqual(f.counts(), { closes: 1, kills: 0 });
  assert.equal(f.process.exitCode, 0);
});

test('owned browser escalates a pending graceful close and waits for actual exit acknowledgment', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let release!: () => void;
  const f = fixture(pending, async process => {
    await new Promise<void>(resolve => { release = resolve; });
    Object.defineProperty(process, 'signalCode', { value: 'SIGKILL' });
  });
  const owned = ownBrowserServer(f.server);
  let resolved = false;
  const result = owned.close().then(() => { resolved = true; });
  context.mock.timers.tick(999);
  assert.equal(f.counts().kills, 0);
  context.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(f.counts().kills, 1);
  assert.equal(resolved, false, 'requesting process termination does not confirm cleanup');
  release();
  await result;
  assert.equal(f.process.signalCode, 'SIGKILL');
});

test('force close upgrades an existing graceful wait immediately and remains idempotent', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(pending, killed), owned = ownBrowserServer(f.server);
  const first = owned.close();
  assert.equal(owned.close(true), first);
  assert.equal(owned.close(true), first);
  await first;
  assert.deepEqual(f.counts(), { closes: 1, kills: 1 });
  context.mock.timers.tick(2000);
  assert.equal(f.counts().kills, 1);
});

test('graceful failure uses only the owned kill and does not expose process errors', async () => {
  const f = fixture(async () => { throw new Error('PRIVATE_PROCESS_FIXTURE'); }, killed);
  await ownBrowserServer(f.server).close();
  assert.deepEqual(f.counts(), { closes: 1, kills: 1 });
});

test('failed termination or a still-live process cannot be reported as closed', async () => {
  for (const kill of [async () => { throw new Error('PRIVATE_PROCESS_FIXTURE'); }, async () => {}]) {
    const f = fixture(pending, kill), owned = ownBrowserServer(f.server);
    await assert.rejects(owned.close(true), unconfirmed);
    await assert.rejects(owned.close(true), unconfirmed);
    assert.deepEqual(f.counts(), { closes: 0, kills: 1 });
    assert.equal(f.process.exitCode, null);
    assert.equal(f.process.signalCode, null);
  }
});

const browserExecutable = existsSync(chromium.executablePath()) ? chromium.executablePath() :
  existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined;

type FixtureCleanup = () => void | Promise<void>;
async function withFixtureCleanup<T>(run: (cleanup: (close: FixtureCleanup) => void) => Promise<T>): Promise<T> {
  const cleanups: FixtureCleanup[] = [];
  let result!: T, failed = false, failure: unknown;
  try { result = await run(close => cleanups.push(close)); }
  catch (error) { failed = true; failure = error; }
  // Every registered resource gets its own cleanup attempt, even when another close rejects.
  const settled = await Promise.allSettled(cleanups.reverse().map(close => Promise.resolve().then(close)));
  const errors = settled.flatMap(item => item.status === 'rejected' ? [item.reason] : []);
  if (failed) errors.unshift(failure);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'The synthetic browser fixture failed and cleanup was not fully confirmed.');
  return result;
}
async function withCancellationFixture<T>(http: Server, launch: typeof chromium.launchServer,
  run: (fixture: { origin: string; sentinel: BrowserServer; sentinelOwner: ReturnType<typeof ownBrowserServer> }, cleanup: (close: FixtureCleanup) => void) => Promise<T>): Promise<T> {
  return withFixtureCleanup(async cleanup => {
    cleanup(async () => {
      http.closeAllConnections();
      if (http.listening) await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
    const address = http.address(); assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const sentinel = await launch({ host: '127.0.0.1', port: 0, headless: true, chromiumSandbox: true, executablePath: browserExecutable,
      env: { PATH: process.env.PATH || '/usr/bin:/bin' }, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--host-resolver-rules=MAP * ~NOTFOUND'] });
    let sentinelOwner: ReturnType<typeof ownBrowserServer> | undefined;
    cleanup(() => sentinelOwner ? sentinelOwner.close(true) : sentinel.kill());
    sentinelOwner = ownBrowserServer(sentinel);
    return run({ origin, sentinel, sentinelOwner }, cleanup);
  });
}

test('cancellation fixture closes its listening HTTP server when sentinel launch rejects', async () => {
  const http = createServer(), launchFailure = new Error('Synthetic sentinel launch refusal');
  let wasListening = false;
  await assert.rejects(withCancellationFixture(http, async () => {
    wasListening = http.listening;
    throw launchFailure;
  }, async () => assert.fail('A rejected sentinel cannot enter the fixture body')), error => error === launchFailure);
  assert.equal(wasListening, true);
  assert.equal(http.listening, false, 'failed launch must not retain the fixture listener');
});

test('cancellation fixture closes HTTP after another cleanup rejects and preserves the original failure', async () => {
  const http = createServer(), bodyFailure = new Error('Synthetic fixture assertion failure');
  const f = fixture(exited, async () => { throw new Error('PRIVATE_PROCESS_FIXTURE'); });
  await assert.rejects(withCancellationFixture(http, async () => f.server as BrowserServer, async () => { throw bodyFailure; }), error =>
    error instanceof AggregateError && error.errors.length === 2 && error.errors[0] === bodyFailure && unconfirmed(error.errors[1]));
  assert.deepEqual(f.counts(), { closes: 0, kills: 1 });
  assert.equal(http.listening, false, 'another failed close must not bypass HTTP cleanup');
});

test('actual cancellation exits only the task process, closes its private endpoint and removes caller listeners', { skip: !browserExecutable, timeout: 45_000 }, async () => {
  let arrived!: () => void, disconnected!: () => void;
  const requestStarted = new Promise<void>(resolve => { arrived = resolve; });
  const requestClosed = new Promise<void>(resolve => { disconnected = resolve; });
  const http = createServer((request, _response) => {
    request.socket.once('close', disconnected);
    arrived();
  });
  const launch = chromium.launchServer.bind(chromium);
  await withCancellationFixture(http, launch, async ({ origin, sentinel, sentinelOwner }, cleanup) => {
    let taskServer: BrowserServer | undefined, readiness: ReturnType<typeof setTimeout> | undefined;
    const caller = new AbortController();
    let execution: Promise<unknown> | undefined;
    cleanup(() => { chromium.launchServer = launch; clearTimeout(readiness); caller.abort(); });
    cleanup(async () => { await taskServer?.kill(); });
    cleanup(async () => {
      caller.abort();
      await execution?.catch(error => {
        if (!(error instanceof ProviderError && error.code === 'JOB_CANCELLED')) throw error;
      });
    });
    chromium.launchServer = async options => { taskServer = await launch(options); return taskServer; };
    execution = executeBrowser({ kind: 'browser', provider: 'browser', prompt: 'Fictional owned cancellation fixture.', options: { url: origin } },
      { jobId: 'fictional-owned-browser', userId: 'fictional-user', workspaceDirectory: tmpdir(), signal: caller.signal },
      { PLATFORM_ENABLE_BROWSER: '1', PLATFORM_BROWSER_ALLOWED_ORIGINS: origin, PLATFORM_BROWSER_EXECUTABLE: browserExecutable });
    await Promise.race([requestStarted, execution.then(() => assert.fail('The slow read must stay pending')),
      new Promise<void>((_resolve, reject) => { readiness = setTimeout(() => reject(new Error('The local fixture read did not start.')), 30_000); })]);
    clearTimeout(readiness);
    assert.ok(taskServer);
    const taskProcess = taskServer.process();
    assert.notEqual(taskProcess.pid, sentinel.process().pid);
    const endpoint = taskServer.wsEndpoint();
    assert.equal(new URL(endpoint).hostname, '127.0.0.1');
    assert.ok(new URL(endpoint).pathname.length > 20);
    const started = performance.now();
    caller.abort();
    await assert.rejects(execution, (error: unknown) => error instanceof ProviderError && error.code === 'JOB_CANCELLED');
    assert.ok(performance.now() - started < 5000, 'an active read must cancel within the existing five-second bound');
    await requestClosed;
    assert.ok(taskProcess.exitCode !== null || taskProcess.signalCode !== null, 'return waits for real process exit');
    assert.throws(() => process.kill(taskProcess.pid!, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
    await assert.rejects(chromium.connect(endpoint, { timeout: 1000 }));
    assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
    assert.equal(sentinel.process().exitCode, null);
    assert.equal(sentinel.process().signalCode, null);
    const browser = await chromium.connect(sentinel.wsEndpoint(), { timeout: 2000 });
    const page = await browser.newPage();
    assert.equal(await page.evaluate(() => 6 * 7), 42, 'another owned browser remains usable');
    await sentinelOwner.close();
    assert.ok(sentinel.process().exitCode !== null || sentinel.process().signalCode !== null);
  });
});
