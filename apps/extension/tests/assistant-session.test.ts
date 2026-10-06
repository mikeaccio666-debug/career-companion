import { createProfileDraft } from '../assistant/features/profile/editor-model';
import { fictionalProfileSnapshot } from '../assistant/testing/profile-snapshot';
import { describe, expect, it, vi } from 'vitest';
import { APPLICATION_PROFILE_FIELD_KEYS, parseUuid, type ProfileDirectoryPersonalV1 } from '@edaix/contracts';
import { createAssistantController } from '../assistant/app/controller';
import { createSessionController } from '../assistant/features/session/controller';
import type { AssistantReadPorts, ReadResult, SessionIdentity } from '../assistant/features/session/read-ports';
import { initialAssistantState } from '../assistant/state/initial';
import { createPreviewPorts } from '../assistant/testing/preview-ports';
import { previewData, entitlementScenarios } from '../assistant/testing/fixtures';
import { emptyProfile } from '../assistant/features/session/read-model';
import { createAssistantView } from '../assistant/app/view-model';
import { createViewContext } from '../assistant/app/view-context';
import { panelDimensions } from '../assistant/shell/geometry';
import { createReadOnlyPorts } from '../assistant/features/session/read-only-ports';

const A = { ownerId: parseUuid('10000000-0000-4000-8000-000000000001')!, generation: 1 };
const B = { ownerId: parseUuid('10000000-0000-4000-8000-000000000002')!, generation: 2 };
const personal = (name: string) => ({ schemaVersion: 1, revision: '1', deletionEpoch: '0', updatedAt: null,
  fields: { ...Object.fromEntries(APPLICATION_PROFILE_FIELD_KEYS.map((key) => [key, null])), firstName: name },
}) as unknown as ProfileDirectoryPersonalV1;
const ok = <T>(value: T): ReadResult<T> => ({ ok: true, value });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function setup() {
  let identity: SessionIdentity | null = A;
  const data = { ...previewData, profile: emptyProfile(), jobs: [], resumeVersions: [], sampleReports: undefined };
  const ui = createAssistantController(data, { ...createPreviewPorts().ports, mode: 'connected' }, initialAssistantState(data, {
    persona: 'out', locale: 'zh-CN', entitlements: { ats: entitlementScenarios.ats.sync, jobs: { access: 'unavailable' },
      letters: { access: 'unavailable' }, chat: { access: 'unavailable' }, voice: { access: 'unavailable' } },
  }));
  const ports: AssistantReadPorts = {
    session: vi.fn(async () => ok(identity)), openPortal: vi.fn(async () => ok(undefined)), logout: vi.fn(async () => ok(undefined)),
    personal: vi.fn(async session => ok(personal(session.ownerId === A.ownerId ? 'Account A' : 'Account B'))),
    resumes: vi.fn(async () => ok({ schemaVersion: 1 as const, libraryRevision: '0' as never, defaultTrackId: null, tracks: [] })),
  };
  const session = createSessionController(ui, ports);
  return { ui, ports, session, setIdentity: (value: SessionIdentity | null) => { identity = value; } };
}

describe('assistant connected session lifetime', () => {
  it('restores intake text to the same owner after reconnect and removes it on account change', async () => {
    const h = setup(); await h.session.refresh();
    h.ui.ctx.patch({ privateIntake: { view: null, input: 'Private interview draft', source: 'TRANSCRIPT', busy: true, streaming: 'Unfinished', truncated: false, recording: 'processing' } });
    h.session.invalidate('expired'); expect(h.ui.ctx.state.privateIntake).toBeUndefined();
    await h.session.refresh(); expect(h.ui.ctx.state.privateIntake).toMatchObject({ input: 'Private interview draft', source: 'TRANSCRIPT', busy: false, streaming: '', recording: 'idle' });
    h.session.invalidate('expired'); h.setIdentity(B); await h.session.refresh(); expect(h.ui.ctx.state.privateIntake).toBeUndefined();
    h.session.dispose(); h.ui.dispose();
  });
  it('restores Role drafts only for the same owner and clears them on logout or account change', async () => {
    const h = setup(); h.ui.ctx.patch({ roleManagementEnabled: true }); await h.session.refresh();
    h.ui.ctx.patch({ roleManager: { items: [], nextCursor: null, loading: false, loaded: true,
      create: { name: 'Private role draft', location: 'Toronto', requestId: A.ownerId, phase: 'saving' } } });
    h.session.invalidate('expired'); expect(h.ui.ctx.state.roleManager).toBeUndefined();
    await h.session.refresh(); expect(h.ui.ctx.state.roleManagementEnabled).toBe(true);
    expect(h.ui.ctx.state.roleManager?.create).toMatchObject({ phase: 'review', name: 'Private role draft', code: 'SAVE_UNCERTAIN' });
    h.session.invalidate('expired'); h.setIdentity(B); await h.session.refresh(); expect(h.ui.ctx.state.roleManager).toBeUndefined();
    h.ui.ctx.patch({ roleManager: { items: [], nextCursor: null, loading: false, loaded: true, create: { name: 'Other draft', location: '', requestId: B.ownerId, phase: 'editing' } } });
    await h.session.logout(); await h.session.refresh(); expect(h.ui.ctx.state.roleManager).toBeUndefined();
    h.session.dispose(); h.ui.dispose();
  });
  it('restores profile drafts only to the original owner, marking interrupted saves uncertain', async () => {
    const h = setup(); h.ui.ctx.patch({ profileEditingEnabled: true }); await h.session.refresh();
    h.ui.ctx.patch({ profileEditor: { draft: createProfileDraft(fictionalProfileSnapshot('Draft owner')!, 'summary'), phase: 'saving' }, scene: 'profile' });
    h.session.invalidate('expired'); expect(h.ui.ctx.state.profileEditor).toBeUndefined();
    await h.session.refresh(); expect(h.ui.ctx.state.profileEditingEnabled).toBe(true);
    expect(h.ui.ctx.state.profileEditor).toMatchObject({ phase: 'review', code: 'SAVE_UNCERTAIN' });
    h.session.invalidate('expired'); h.setIdentity(B); await h.session.refresh();
    expect(h.ui.ctx.state.profileEditor).toBeUndefined();
    h.ui.ctx.patch({ profileEditor: { draft: createProfileDraft(fictionalProfileSnapshot('Other draft')!, 'summary'), phase: 'editing' } });
    await h.session.logout(); await h.session.refresh(); expect(h.ui.ctx.state.profileEditor).toBeUndefined();
    h.session.dispose(); h.ui.dispose();
  });
  it('refreshes the actual connection when the user reopens the assistant', async () => {
    const refresh = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const ui = createAssistantController(previewData, createReadOnlyPorts({ refresh,
      login: async () => ({ ok: true, value: undefined }), logout: async () => ({ ok: true, value: undefined }) }),
      initialAssistantState(previewData, { persona: 'out', entitlements: {
        ats: { access: 'unavailable' }, jobs: { access: 'unavailable' }, letters: { access: 'unavailable' },
        chat: { access: 'unavailable' }, voice: { access: 'unavailable' } } }));
    await ui.dispatch('panel-close'); await ui.dispatch('toolbar-open');
    expect(refresh).toHaveBeenCalledOnce();
    ui.dispose();
  });
  it('reports a failed session probe as unavailable instead of asking the user to sign in again', async () => {
    const h = setup();
    h.ports.session = vi.fn(async () => ({ ok: false, code: 'UNAVAILABLE' } as const));
    expect(await h.session.refresh()).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(h.ui.ctx.state.session).toBe('unavailable');
    expect(h.ui.ctx.state.connectionIssue).toEqual({ stage: 'SESSION', code: 'UNAVAILABLE' });
    // 连过的人探测失败：主按钮仍是刷新，不该把他打回登录（这条是本测试的本意）。
    h.ui.ctx.patch({ everConnected: true });
    const view = createAssistantView(createViewContext(h.ui.ctx.state, h.ui.ctx.data,
      panelDimensions('welcome', { width: 1280, height: 900 })));
    expect(view.welcome.foot).not.toContain('过期');
    expect(view.welcome.primaryAct).toBe('session-refresh');
    h.session.dispose(); h.ui.dispose();
  });

  it('从没连过的人拿到的是连接，不是刷新', async () => {
    // 2026-09-16 加。在此之前 unavailable 一律给"刷新连接"，而 refresh 假设连接
    // 存在——首次使用的人点它必然失败，提示"暂时无法更新连接，请重试"，重试多少
    // 次都一样。实测就是这样卡住的：插件停在 SESSION / UNAVAILABLE，门户那边说
    // "请安装扩展"，两边都对，只是谁都拿不到对方。
    const h = setup();
    h.ports.session = vi.fn(async () => ({ ok: false, code: 'UNAVAILABLE' } as const));
    await h.session.refresh();
    expect(h.ui.ctx.state.everConnected ?? false, '夹具必须是没连过的状态').toBe(false);
    const view = createAssistantView(createViewContext(h.ui.ctx.state, h.ui.ctx.data,
      panelDimensions('welcome', { width: 1280, height: 900 })));
    expect(view.welcome.primaryAct, '主按钮必须是登录').toBe('login');
    expect(view.welcome.secondaryAct, '刷新退到次位，留给已经在门户登录过的人').toBe('session-refresh');
    h.session.dispose(); h.ui.dispose();
  });

  it('preserves which owner read requires login and clears the issue after a successful retry', async () => {
    const h = setup();
    h.ports.resumes = vi.fn(async () => ({ ok: false, code: 'LOGIN_REQUIRED' } as const));
    await h.session.refresh();
    expect(h.ui.ctx.state.connectionIssue).toEqual({ stage: 'RESUMES', code: 'LOGIN_REQUIRED' });
    expect(h.ui.ctx.state.profile.name).toBe('');
    h.ports.resumes = vi.fn(async () => ok({ schemaVersion: 1 as const, libraryRevision: '0' as never, defaultTrackId: null, tracks: [] }));
    await h.session.refresh();
    expect(h.ui.ctx.state.session).toBe('connected');
    expect(h.ui.ctx.state.connectionIssue).toBeUndefined();
    h.session.dispose(); h.ui.dispose();
  });
  it('reads profile and resume sections independently without claiming profile completion', async () => {
    const h = setup();
    h.ports.resumes = vi.fn(async () => ({ ok: false, code: 'LOCKED' } as const));
    await h.session.refresh();
    expect(h.ui.ctx.state.profile.name).toBe('Account A');
    expect(h.ui.ctx.state.reads).toMatchObject({ personal: 'ready', resumes: 'locked' });
    expect(h.ui.ctx.state.profileDone).toBe(false);
    expect(h.ui.ctx.state.confirmed).toEqual({ 0: false, 1: false, 2: false });
    expect(h.ui.ctx.state.hasResume).toBe(false);
    h.session.dispose(); h.ui.dispose();
  });

  it('scrubs immediately on expiry and restores a draft only after the same owner is freshly confirmed', async () => {
    const h = setup(); await h.session.refresh();
    h.ui.ctx.patch(s => ({ ...s, scene: 'chat', chat: { ...s.chat, input: 'Private unsent draft' } }));
    const old = h.ui.store.scope();
    h.session.invalidate('expired');
    expect(old.signal.aborted).toBe(true);
    expect(h.ui.ctx.state.profile.name).toBe('');
    expect(h.ui.ctx.state.chat.input).toBe('');
    h.setIdentity({ ...A, generation: 3 }); await h.session.refresh();
    expect(h.ui.ctx.state.scene).toBe('chat');
    expect(h.ui.ctx.state.chat.input).toBe('Private unsent draft');
    h.session.invalidate('expired'); h.setIdentity(B); await h.session.refresh();
    expect(h.ui.ctx.state.profile.name).toBe('Account B');
    expect(h.ui.ctx.state.chat.input).toBe('');
    expect(h.ui.ctx.state.scene).toBe('welcome');
    h.session.dispose(); h.ui.dispose();
  });

  it('cancels a slow old-owner read and ignores its late response after another account connects', async () => {
    const h = setup(), pending = deferred<ReadResult<ProfileDirectoryPersonalV1>>(), began = deferred<void>();
    h.ports.personal = vi.fn(async owner => {
      if (owner.ownerId === A.ownerId) { began.resolve(); return pending.promise; }
      return ok(personal('Account B'));
    });
    const first = h.session.refresh(); await began.promise;
    h.setIdentity(B); h.session.invalidate('out'); await h.session.refresh();
    await first;
    pending.resolve(ok(personal('Account A'))); await Promise.resolve();
    expect(h.ui.ctx.state.profile.name).toBe('Account B');
    expect(JSON.stringify(h.ui.ctx.state)).not.toContain('Account A');
    h.session.dispose(); h.ui.dispose();
  });

  it('rechecks session generation before publishing successful parallel reads', async () => {
    const h = setup();
    h.ports.personal = vi.fn(async () => { h.setIdentity(B); return ok(personal('Account A')); });
    await h.session.refresh();
    expect(h.ui.ctx.state.profile.name).toBe('');
    expect(h.ui.ctx.state.session).toBe('expired');
    h.session.dispose(); h.ui.dispose();
  });

  it('logout discards the suspended draft even if the server notification fails', async () => {
    const h = setup(); await h.session.refresh();
    h.ui.ctx.patch(s => ({ ...s, chat: { ...s.chat, input: 'Discard me' } }));
    h.ports.logout = vi.fn(async () => ({ ok: false, code: 'UNAVAILABLE' } as const));
    expect(await h.session.logout()).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(h.ui.ctx.state.profile.name).toBe('');
    await h.session.refresh();
    expect(h.ui.ctx.state.chat.input).toBe('');
    h.session.dispose(); h.ui.dispose();
  });

  it('connected mode refuses simulated login, saving, voice, score and fill actions', async () => {
    const h = setup();
    for (const action of ['review-confirm', 'voice-start', 'cand-confirm', 'discover', 'fill-confirm']) {
      expect(await h.ui.dispatch(action)).toEqual({ ok: false, code: 'UNAVAILABLE' });
    }
    await h.ui.dispatch('modal-action', 'login-ok');
    expect(h.ui.ctx.state.session).toBe('out');
    expect(h.ui.ctx.state.profileDone).toBe(false);
    expect(h.ui.ctx.state.voice.state).toBe('idle');
    h.session.dispose(); h.ui.dispose();
  });

  it('shows failed resume reads as unavailable and never as an empty library or READY profile', async () => {
    const h = setup();
    h.ports.resumes = vi.fn(async () => ({ ok: false, code: 'UNAVAILABLE' } as const));
    await h.session.refresh(); await h.ui.dispatch('open-resume');
    const view = createAssistantView(createViewContext(h.ui.ctx.state, h.ui.ctx.data,
      panelDimensions('home', { width: 1440, height: 900 })));
    expect(view.home.badge).not.toBe('READY');
    expect(view.ui.statusLine).toContain('简历暂不可用');
    expect(view.sheet.resumeStatus).toContain('暂时无法读取');
    expect(view.review.readOnly).toBe(true);
    expect(view.review.primaryAct).toBe('home');
    expect(view.review.groups).toHaveLength(1);
    h.session.dispose(); h.ui.dispose();
  });

  it('allows a real login handoff after expiry instead of reusing an aborted request', async () => {
    const h = setup(); await h.session.refresh(); h.session.invalidate('expired');
    expect(await h.session.login()).toEqual({ ok: true, value: undefined });
    expect(h.ports.openPortal).toHaveBeenCalledTimes(1);
    expect(h.ui.ctx.state.session).toBe('expired');
    h.session.dispose(); h.ui.dispose();
  });

  it('settles a hung reader as unavailable and clears its loading state after the deadline', async () => {
    vi.useFakeTimers();
    try {
      const h = setup(); h.ports.personal = vi.fn(() => new Promise<ReadResult<ProfileDirectoryPersonalV1>>(() => {}));
      const task = h.session.refresh();
      await vi.advanceTimersByTimeAsync(12_100);
      expect(await task).toEqual({ ok: false, code: 'UNAVAILABLE' });
      expect(h.ui.ctx.state.session).toBe('unavailable');
      expect(h.ui.ctx.state.reads?.personal).toBe('unavailable');
      h.session.dispose(); h.ui.dispose();
    } finally { vi.useRealTimers(); }
  });
});

it('projects a validated full profile and clears it with the owner session', async () => {
  const h = setup(), snapshot = fictionalProfileSnapshot('Fictional full profile');
  expect(snapshot).not.toBeNull(); h.ports.profileV2 = async () => ok(snapshot!);
  await h.session.refresh();
  expect(h.ui.ctx.state.profileV2).toEqual(snapshot);
  const view = () => createAssistantView(createViewContext(h.ui.ctx.state, h.ui.ctx.data, panelDimensions('profile', { width: 1280, height: 900 })));
  expect(view().review.groups.some(g => g.rows.some(r => r.label.includes('Example Company')))).toBe(true);
  await h.ui.dispatch('set-locale', 'en-US');
  expect(view().review.groups.map(g => g.title)).toContain('Education');
  expect(view().review.groups.some(g => g.rows.some(r => r.value.includes('虚构经历')))).toBe(true);
  h.session.invalidate(); expect(h.ui.ctx.state.profileV2).toBeUndefined();
  expect(JSON.stringify(view().review)).not.toContain('Example Company'); h.session.dispose(); h.ui.dispose();
});

it('does not leave a cancelled read permanently loading after the panel closes', async () => {
  const h = setup(), began = deferred<void>();
  h.ports.personal = async () => { began.resolve(); return new Promise(() => {}); };
  const pending = h.session.refresh(); await began.promise;
  await h.ui.dispatch('panel-close'); await pending;
  expect(h.ui.ctx.state.panelOpen).toBe(false);
  expect(h.ui.ctx.state.reads?.personal).not.toBe('loading');
  expect(h.ui.ctx.state.session).toBe('unavailable'); h.session.dispose(); h.ui.dispose();
});
