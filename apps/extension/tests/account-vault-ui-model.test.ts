// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAccountVaultUi } from '../assistant/features/account-vault/model';
import type { AccountVaultUiPorts, VaultSnapshotView } from '../assistant/features/account-vault/ports';

class TrustedClick extends MouseEvent { get isTrusted() { return true; } }
const gesture = () => new TrustedClick('click');
const origin = 'https://first.example.test';
const second = 'https://second.example.test';
const snapshot: VaultSnapshotView = {
  status: 'READABLE', revision: 7, authEpoch: 11, email: 'student@example.test', defaultEmail: null,
  sites: [origin, second].map((value) => ({ origin: value, email: 'student@example.test', source: 'GENERATED', state: 'PENDING', hasPassword: true, at: 100 })),
};
const disposals: Array<() => void> = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

function fixture(overrides: Partial<AccountVaultUiPorts> = {}) {
  let invalidate = () => {};
  const ports: AccountVaultUiPorts = {
    list: vi.fn(async () => ({ ok: true as const, value: snapshot })),
    reveal: vi.fn(async (input) => ({ ok: true as const, value: { origin: input.origin, password: 'fictional-secret', revision: 7, authEpoch: 11 } })),
    export: vi.fn(async () => ({ ok: true as const, value: { rows: [{ origin, email: 'student@example.test', password: '=fictional-secret' }], legacyPassword: null, revision: 7, authEpoch: 11 } })),
    download: vi.fn(),
    onInvalidated: (listener) => { invalidate = listener; return () => {}; },
    ...overrides,
  };
  const ui = createAccountVaultUi(ports);
  disposals.push(ui.dispose);
  return { ui, ports, invalidate: () => invalidate() };
}

describe('vault settings secret lifetime', () => {
  it('does not request any password when reading metadata', async () => {
    const { ui, ports } = fixture(); await ui.load();
    expect(ui.getSnapshot().snapshot?.sites[0]?.state).toBe('PENDING');
    expect(ui.getSnapshot().revealed).toBeNull();
    expect(ports.reveal).not.toHaveBeenCalled(); expect(ports.export).not.toHaveBeenCalled();
  });

  it.each(['KEY_MISSING', 'UNREADABLE'] as const)('keeps %s distinct from an empty vault and denies secret actions', async (status) => {
    const { ui, ports } = fixture({ list: async () => ({ ok: true, value: { ...snapshot, status, revision: null, email: null, sites: [] } }) });
    await ui.load(); await ui.reveal(origin, gesture()); ui.askExport(gesture()); await ui.export(gesture());
    expect(ui.getSnapshot().snapshot?.status).toBe(status);
    expect(ports.reveal).not.toHaveBeenCalled(); expect(ports.export).not.toHaveBeenCalled();
  });

  it('requires a genuine gesture and binds each reveal to origin, revision and epoch', async () => {
    const { ui, ports } = fixture(); await ui.load();
    await ui.reveal(origin, new MouseEvent('click')); expect(ports.reveal).not.toHaveBeenCalled();
    await ui.reveal(origin, gesture());
    expect(ports.reveal).toHaveBeenCalledWith({ origin, expectedRevision: 7, expectedEpoch: 11 }, expect.any(MouseEvent), expect.any(AbortSignal));
    expect(ui.getSnapshot().revealed).toEqual({ origin, password: 'fictional-secret' });
    await ui.reveal(second, gesture()); expect(ui.getSnapshot().revealed?.origin).toBe(second);
    ui.hide(); expect(ui.getSnapshot().revealed).toBeNull();
  });

  it.each(['lock', 'invalidate', 'dispose'] as const)('drops a pending reveal after %s', async (action) => {
    let finish!: (value: Awaited<ReturnType<AccountVaultUiPorts['reveal']>>) => void;
    const { ui, invalidate } = fixture({ reveal: () => new Promise((resolve) => { finish = resolve; }) });
    await ui.load(); const reading = ui.reveal(origin, gesture());
    if (action === 'invalidate') invalidate(); else ui[action]();
    finish({ ok: true, value: { origin, password: 'late-secret', revision: 7, authEpoch: 11 } });
    await reading;
    expect(ui.getSnapshot().revealed).toBeNull();
  });

  it.each([{ revision: 8, authEpoch: 11, origin }, { revision: 7, authEpoch: 12, origin }, { revision: 7, authEpoch: 11, origin: second }])('hides a reveal with changed binding %j', async (binding) => {
    const { ui } = fixture({ reveal: async () => ({ ok: true, value: { ...binding, password: 'wrong-secret' } }) });
    await ui.load(); await ui.reveal(origin, gesture());
    expect(ui.getSnapshot().phase).toBe('LOCKED'); expect(ui.getSnapshot().revealed).toBeNull();
  });
});

describe('vault export confirmation', () => {
  it('requires two genuine clicks and keeps exported secrets out of UI state', async () => {
    const { ui, ports } = fixture(); await ui.load();
    await ui.export(gesture()); expect(ports.export).not.toHaveBeenCalled();
    ui.askExport(gesture()); expect(ui.getSnapshot().confirmExport).toBe(true); expect(ports.export).not.toHaveBeenCalled();
    await ui.export(new MouseEvent('click')); expect(ports.export).not.toHaveBeenCalled();
    await ui.export(gesture());
    expect(ports.download).toHaveBeenCalledTimes(1);
    expect(ports.download).toHaveBeenCalledWith(expect.stringContaining('=fictional-secret'));
    expect(JSON.stringify(ui.getSnapshot())).not.toContain('fictional-secret');
    expect(ui.getSnapshot().confirmExport).toBe(false);
  });

  it('does not download a late export after account invalidation', async () => {
    let finish!: (value: Awaited<ReturnType<AccountVaultUiPorts['export']>>) => void;
    const { ui, ports, invalidate } = fixture({ export: () => new Promise((resolve) => { finish = resolve; }) });
    await ui.load(); ui.askExport(gesture()); const exporting = ui.export(gesture()); invalidate();
    finish({ ok: true, value: { rows: [{ origin, email: null, password: 'late-secret' }], legacyPassword: null, revision: 7, authEpoch: 11 } });
    await exporting; expect(ports.download).not.toHaveBeenCalled();
  });

  it('does not download when the export revision changed', async () => {
    const { ui, ports } = fixture({ export: async () => ({ ok: true, value: { rows: [], legacyPassword: null, revision: 8, authEpoch: 11 } }) });
    await ui.load(); ui.askExport(gesture()); await ui.export(gesture());
    expect(ports.download).not.toHaveBeenCalled(); expect(ui.getSnapshot().phase).toBe('LOCKED');
  });

  it('exports unbound legacy credentials honestly with an empty URL and manual-save note', async () => {
    const { ui, ports } = fixture({ export: async () => ({ ok: true, value: { rows: [], legacyPassword: '+old-secret', revision: 7, authEpoch: 11 } }) });
    await ui.load(); ui.askExport(gesture()); await ui.export(gesture());
    expect(ports.download).toHaveBeenCalledWith(expect.stringContaining('"旧共用密码（未关联网站）","","student@example.test","+old-secret"'));
    expect(ui.getSnapshot().notice).toContain('手动保存');
    expect(JSON.stringify(ui.getSnapshot())).not.toContain('old-secret');
  });
});

describe('worker-bound account transition in settings', () => {
  const transition = { ticket: 'worker-bound-ticket', action: 'SWITCH_ACCOUNT' as const, hasVault: true, canExport: true, expiresAt: Date.now() + 60_000 };
  it('loads the pending decision without confirming it, and allows cancellation', async () => {
    const confirmTransition = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const cancelTransition = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const { ui } = fixture({ loadPendingTransition: async () => ({ ok: true, value: transition }), confirmTransition, cancelTransition });
    await ui.load(); expect(ui.getSnapshot().transition?.ticket).toBe(transition.ticket); expect(confirmTransition).not.toHaveBeenCalled();
    await ui.resolveTransition('CANCEL', new MouseEvent('click')); expect(cancelTransition).not.toHaveBeenCalled();
    await ui.resolveTransition('CANCEL', gesture()); expect(cancelTransition).toHaveBeenCalledWith(transition.ticket, expect.any(MouseEvent), expect.any(AbortSignal));
    expect(ui.getSnapshot().snapshot).toBe(snapshot); expect(ui.getSnapshot().transition).toBeNull();
  });

  it('passes the worker ticket on explicit confirmation, then clears all local UI state', async () => {
    const confirmTransition = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const { ui } = fixture({ loadPendingTransition: async () => ({ ok: true, value: transition }), confirmTransition });
    await ui.load(); await ui.reveal(origin, gesture()); await ui.resolveTransition('CONFIRM', gesture());
    expect(confirmTransition).toHaveBeenCalledWith(transition.ticket, expect.any(MouseEvent), expect.any(AbortSignal));
    expect(ui.getSnapshot().snapshot).toBeNull(); expect(ui.getSnapshot().revealed).toBeNull();
  });

  it('does not claim the account changed when the worker refused confirmation', async () => {
    const { ui } = fixture({ loadPendingTransition: async () => ({ ok: true, value: transition }), confirmTransition: async () => ({ ok: false, code: 'AUTH_CHANGED' }) });
    await ui.load(); await ui.resolveTransition('CONFIRM', gesture());
    expect(ui.getSnapshot().transition).toEqual(transition); expect(ui.getSnapshot().notice).not.toContain('已确认换账号');
  });

  it.each(['LOGOUT', 'SWITCH_ACCOUNT'] as const)('keeps the non-secret %s confirmation receipt after auth invalidation', async (action) => {
    let finish!: (value: Awaited<ReturnType<NonNullable<AccountVaultUiPorts['confirmTransition']>>>) => void;
    let receiptSignal!: AbortSignal;
    const { ui, invalidate } = fixture({
      loadPendingTransition: async () => ({ ok: true, value: { ...transition, action } }),
      confirmTransition: (_ticket, _event, signal) => { receiptSignal = signal; return new Promise((resolve) => { finish = resolve; }); },
    });
    await ui.load(); await ui.reveal(origin, gesture());
    const confirming = ui.resolveTransition('CONFIRM', gesture()); invalidate();
    expect(ui.getSnapshot().snapshot).toBeNull(); expect(ui.getSnapshot().revealed).toBeNull();
    expect(ui.getSnapshot().transition).toBeNull(); expect(ui.getSnapshot().transitionBusy).toBe(true);
    expect(receiptSignal.aborted).toBe(false);
    finish({ ok: true, value: undefined }); await confirming;
    expect(ui.getSnapshot().transitionBusy).toBe(false);
    expect(ui.getSnapshot().notice).toBe(action === 'LOGOUT' ? '已退出，保存的招聘网站账号已清除。' : '已清除旧记录，正在完成连接。');
    expect(ui.getSnapshot().snapshot).toBeNull(); expect(ui.getSnapshot().revealed).toBeNull();
  });

  it('reports a clear failure after auth invalidation without claiming the account remains signed in', async () => {
    let finish!: (value: Awaited<ReturnType<NonNullable<AccountVaultUiPorts['confirmTransition']>>>) => void;
    const { ui, invalidate } = fixture({ loadPendingTransition: async () => ({ ok: true, value: transition }), confirmTransition: () => new Promise((resolve) => { finish = resolve; }) });
    await ui.load(); const confirming = ui.resolveTransition('CONFIRM', gesture()); invalidate();
    finish({ ok: false, code: 'CLEAR_FAILED' }); await confirming;
    expect(ui.getSnapshot().notice).toBe('本机记录没有全部清除，请重新读取当前登录状态；必要时重新连接原账号后重试。');
    expect(ui.getSnapshot().notice).not.toContain('尚未完成退出'); expect(ui.getSnapshot().snapshot).toBeNull();
    expect(ui.getSnapshot().transitionBusy).toBe(false);
  });

  it.each(['load', 'lock', 'hide', 'dispose'] as const)('drops a pending confirmation display after %s', async (action) => {
    let finish!: (value: Awaited<ReturnType<NonNullable<AccountVaultUiPorts['confirmTransition']>>>) => void;
    let receiptSignal!: AbortSignal;
    const { ui } = fixture({ loadPendingTransition: async () => ({ ok: true, value: transition }), confirmTransition: (_ticket, _event, signal) => { receiptSignal = signal; return new Promise((resolve) => { finish = resolve; }); } });
    await ui.load(); const confirming = ui.resolveTransition('CONFIRM', gesture()); await ui[action]();
    expect(receiptSignal.aborted).toBe(true);
    finish({ ok: true, value: undefined }); await confirming;
    expect(ui.getSnapshot().notice).not.toBe('已清除旧记录，正在完成连接。');
    expect(ui.getSnapshot().transitionBusy).toBe(false);
  });
});
