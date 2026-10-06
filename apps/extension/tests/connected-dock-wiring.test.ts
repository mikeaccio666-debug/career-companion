// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://job-boards.greenhouse.io/edaix-canary/jobs/1"}
/**
 * The connected artifact is the one that ships. A dock wired into the other
 * apply entrypoint is a dock nobody installs, so this pins the wiring where the
 * build actually reads it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wiring = vi.hoisted(() => ({
  reply: undefined as unknown,
  handlers: null as { onAutofill: () => void } | null,
  handle: null as { update: (progress: unknown) => void; beginRun?: (progress: unknown) => void } | null,
  installed: null as { runCurrentPage?: (...args: unknown[]) => Promise<unknown> } | null,
  progressSpy: [] as Array<(event: unknown) => void>,
  pushed: [] as Array<(message: unknown) => unknown>,
  sendMessage: vi.fn(async () => wiring.reply),
}));
vi.mock('wxt/utils/define-content-script', () => ({ defineContentScript: (entry: unknown) => entry }));
vi.mock('wxt/browser', () => ({ browser: {
  runtime: {
    id: 'connected-dock-test',
    getURL: (path: string) => `chrome-extension://connected-dock-test${path}`,
    onConnect: { addListener: () => {} },
    onMessage: { addListener: (listener: (message: unknown) => unknown) => wiring.pushed.push(listener) },
    sendMessage: wiring.sendMessage,
    getManifest: () => ({ version: '0.0.0' }),
  },
  storage: { local: { get: async () => ({}) }, onChanged: { addListener: () => {} } },
} }));

// Real parser, real mount — only the handlers are observed, so the wiring under
// test is the entrypoint's own and not a stand-in for it.
vi.mock('../connected-dev/contentRuntime', () => ({
  installPilotUa5ConnectedContent: (config: { runCurrentPage?: unknown }) => {
    wiring.installed = config as never;
  },
}));
vi.mock('../connected-dev/liveRun', () => ({
  createPilotUa5ConnectedLiveRun: () => Object.assign(
    async (_discovery: unknown, onProgress: (event: unknown) => void) => {
      wiring.progressSpy.push(onProgress);
      return { ok: false, code: 'PILOT_UA5_UNAVAILABLE' };
    },
    { undoCurrentPage: async () => 'UNAVAILABLE', getCurrentResult: () => null,
      getWizardProjection: () => undefined, resetWizard: () => {},
      rescanCurrentPage: async () => ({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' }),
      dispose: () => {} },
  ),
}));
vi.mock('../lib/autofillDock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/autofillDock')>();
  return { ...actual, mountAutofillDock: (face: never, handlers: never, ...rest: never[]) => {
    wiring.handlers = handlers as unknown as { onAutofill: () => void };
    const real = actual.mountAutofillDock(face, handlers, ...rest);
    return wiring.handle === null ? real : { ...real, ...wiring.handle };
  } };
});

const { default: entrypoint } = await import('../entrypoints-connected/apply.content');

const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });
const docks = () => document.querySelectorAll('#edaix-autofill-dock').length;

beforeEach(() => {
  (globalThis as Record<string, unknown>).__VIBE_EXTENSION_CONNECTED_DEV_ENABLED__ = true;
  // The panel reports a run only where a run can happen: the admitted write artifact.
  (globalThis as Record<string, unknown>).__VIBE_EXTENSION_CONNECTED_DEV_WRITE_ENABLED__ = true;
  document.body.innerHTML = '';
  document.querySelectorAll('#edaix-autofill-dock').forEach((node) => { node.remove(); });
});
afterEach(() => { wiring.reply = undefined; wiring.pushed.length = 0; wiring.handlers = null; wiring.handle = null;
  wiring.installed = null; wiring.progressSpy.length = 0; });

describe('the connected artifact stands a dock on the page', () => {
  it('mounts the face the background sent, and nothing before it arrives', async () => {
    wiring.reply = { dock: { kind: 'UNAVAILABLE', reason: 'NO_MISSION' } };
    entrypoint.main(undefined as never);
    expect(docks(), 'nothing may reach the page before the background has spoken').toBe(0);
    await settle();
    expect(docks()).toBe(1);
  });
  it('takes a later face from the worker, so picking the job afterwards still works', async () => {
    // Opening the application page first and choosing the Mission afterwards is
    // the ordinary way round. A face decided once at page-ready would leave the
    // panel saying "not in your list" for a job that now is.
    wiring.reply = { dock: { kind: 'UNAVAILABLE', reason: 'NO_MISSION' } };
    entrypoint.main(undefined as never);
    await settle();
    expect(docks()).toBe(1);
    const push = wiring.pushed.at(-1);
    expect(push, 'the content script must be listening for a later face').toBeDefined();
    push?.({ dock: { kind: 'READY' } });
    await settle();
    expect(docks(), 'one dock, not two').toBe(1);
    expect(document.querySelector('#edaix-autofill-dock')).not.toBeNull();
  });
  it('ignores a pushed face it cannot name', async () => {
    wiring.reply = { dock: { kind: 'READY' } };
    entrypoint.main(undefined as never);
    await settle();
    wiring.pushed.at(-1)?.({ dock: { kind: 'WHATEVER' } });
    await settle();
    expect(docks(), 'an unnameable face takes nothing down and puts nothing up').toBe(1);
  });
  it("reports the user's own gesture to the worker, naming the page it happened on", async () => {
    // The panel's button is a source of write authority now (owner ruling,
    // 2026-09-11). That a page-dispatched click never reaches onAutofill at all
    // is proven in autofill-dock.test.ts; what is proven here is that a gesture
    // which does reach it is reported, and reported about this page.
    wiring.reply = { dock: { kind: 'READY' } };
    entrypoint.main(undefined as never);
    await settle();
    expect(wiring.handlers).not.toBeNull();
    wiring.sendMessage.mockClear();
    wiring.handlers?.onAutofill();
    expect(wiring.sendMessage).toHaveBeenCalledWith({
      kind: 'pilot-ua5/dock-fill-intent', version: 2,
      origin: 'https://job-boards.greenhouse.io', pathname: '/edaix-canary/jobs/1',
    });
  });
  it('shows a live run on the panel, phase by phase', async () => {
    // The panel is where the user is looking. A fill that reports only into the
    // side panel leaves whoever started it from the page watching nothing.
    const updates: unknown[] = [];
    // Observed before the mount, because the panel is mounted by the reply.
    // The first event of a run hands the sheet over; the rest refresh it.
    wiring.handle = {
      update: (progress: unknown) => { updates.push(progress); },
      beginRun: (progress: unknown) => { updates.push(progress); },
    };
    wiring.reply = { dock: { kind: 'READY' } };
    entrypoint.main(undefined as never);
    await settle();
    const run = wiring.installed?.runCurrentPage;
    expect(run, 'the content runtime must be handed a run it can report through').toBeDefined();
    await run?.({ requestId: 'r' }, () => {}, {}).catch(() => undefined);
    expect(wiring.progressSpy.length, 'the run must be given a progress sink').toBeGreaterThan(0);
    wiring.progressSpy[0]?.({ phase: 'OBSERVED', observedControls: 12 });
    wiring.progressSpy[0]?.({ phase: 'SETTLED', requiredCompleted: 5, requiredQuestions: 6 });
    expect(updates).toEqual([
      expect.objectContaining({ phase: 'SCANNING', observedControls: 12 }),
      expect.objectContaining({ phase: 'SETTLED', requiredCompleted: 5, requiredQuestions: 6 }),
    ]);
  });
  it('reports a second fill on the same page, not just the first', async () => {
    // update() refuses a run that is not the one the sheet is showing, so two
    // applications can never share it. A later fill on the same page is a new
    // run and has to be handed the sheet — otherwise every fill after the first
    // is silent and the panel sits on the previous run's numbers.
    const seen: string[] = [];
    wiring.handle = {
      update: () => { seen.push('update'); },
      beginRun: () => { seen.push('beginRun'); },
    };
    wiring.reply = { dock: { kind: 'READY' } };
    entrypoint.main(undefined as never);
    await settle();
    const run = wiring.installed?.runCurrentPage;
    await run?.({ requestId: 'a' }, () => {}, {}).catch(() => undefined);
    await run?.({ requestId: 'b' }, () => {}, {}).catch(() => undefined);
    wiring.progressSpy[0]?.({ phase: 'OBSERVED', observedControls: 1 });
    wiring.progressSpy[1]?.({ phase: 'OBSERVED', observedControls: 2 });
    expect(seen, 'each run takes the sheet, then refreshes it').toEqual(['beginRun', 'beginRun']);
  });
  it('mounts nothing when the background sends no face', async () => {
    wiring.reply = undefined;
    entrypoint.main(undefined as never);
    await settle();
    expect(docks()).toBe(0);
  });
  it('mounts nothing for an instruction it does not recognise', async () => {
    // The reply is an untrusted boundary even from our own worker: a shape we
    // cannot name is not a shape we stand on a user's form for.
    wiring.reply = { dock: { kind: 'READY', extra: 1 } };
    entrypoint.main(undefined as never);
    await settle();
    expect(docks()).toBe(0);
  });
});
