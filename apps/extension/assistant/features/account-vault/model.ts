import { passwordManagerCsv } from './csv';
import type { AccountVaultUiPorts, VaultSnapshotView, VaultTransitionView, VaultUiFailure } from './ports';

export interface AccountVaultUiState {
  readonly phase: 'LOADING' | 'READY' | 'LOCKED' | 'UNAVAILABLE';
  readonly snapshot: VaultSnapshotView | null;
  readonly revealed: Readonly<{ origin: string; password: string }> | null;
  readonly busy: 'REVEAL' | 'EXPORT' | null;
  readonly confirmExport: boolean;
  readonly notice: string | null;
  readonly transition: VaultTransitionView | null;
  readonly transitionBusy: boolean;
}

const initial = (): AccountVaultUiState => ({ phase: 'LOADING', snapshot: null, revealed: null, busy: null, confirmExport: false, notice: null, transition: null, transitionBusy: false });
const failureText = (code: VaultUiFailure): string => code === 'AUTH_CHANGED' || code === 'OWNER_CHANGED'
  ? '登录状态变了，已隐藏密码。重新读取后再查看。'
  : code === 'CHANGED' ? '保存的账号有变化，已隐藏密码。重新读取后再查看。'
    : code === 'KEY_MISSING' ? '本机密钥丢失，保存的密码无法恢复，请到网站上重设。'
      : code === 'UNREADABLE' ? '保存内容读不出来，请到网站上重设密码。'
        : code === 'CLEAR_FAILED' ? '本机记录没有全部清除，请重新读取当前登录状态；必要时重新连接原账号后重试。'
          : code === 'EXPIRED' ? '这次确认已过期，重新读取后再操作。'
            : code === 'CANCELED' ? '这次操作已取消。'
              : code === 'UNTRUSTED' ? '请亲自点击设置页上的按钮。' : '暂时读不到保存的账号，请稍后再试。';

/** Secret state is one site only; exports stay out of the rendered state. */
export function createAccountVaultUi(ports: AccountVaultUiPorts) {
  let state = initial(), generation = 0, request = new AbortController(), disposed = false;
  // Confirmation returns no secrets. Keep its receipt alive across the auth
  // invalidation caused by that very confirmation, while immediately hiding data.
  let confirmationGeneration = 0, confirmationRequest: AbortController | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<AccountVaultUiState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const reset = () => {
    generation += 1;
    request.abort(); request = new AbortController();
    if (hideTimer !== null) clearTimeout(hideTimer);
    hideTimer = null;
    return generation;
  };
  const active = (scope: number) => !disposed && scope === generation && !request.signal.aborted;
  const stopConfirmation = () => { confirmationGeneration += 1; confirmationRequest?.abort(); confirmationRequest = null; };
  const usable = () => state.phase === 'READY' && state.snapshot?.status === 'READABLE' && state.snapshot.revision !== null ? state.snapshot : null;
  const matches = (value: { revision: number; authEpoch: number }, snapshot: VaultSnapshotView) => value.revision === snapshot.revision && value.authEpoch === snapshot.authEpoch;
  const invalidate = (notice: string | null = null, preserveConfirmation = false) => {
    reset();
    if (!preserveConfirmation) stopConfirmation();
    set({ ...initial(), phase: 'LOCKED', notice, transitionBusy: preserveConfirmation && confirmationRequest !== null });
  };
  const fail = (code: VaultUiFailure) => invalidate(failureText(code));
  const load = async () => {
    stopConfirmation();
    const scope = reset(); set(initial());
    try {
      const [reply, pending] = await Promise.all([
        ports.list(request.signal),
        ports.loadPendingTransition?.(request.signal) ?? Promise.resolve({ ok: true as const, value: null }),
      ]);
      if (!active(scope)) return;
      if (pending.ok) set({ transition: pending.value });
      else set({ notice: failureText(pending.code) });
      if (!reply.ok) { set({ phase: 'UNAVAILABLE', notice: failureText(reply.code) }); return; }
      set({ phase: 'READY', snapshot: reply.value });
    } catch { if (active(scope)) set({ phase: 'UNAVAILABLE', notice: failureText('UNAVAILABLE') }); }
  };
  const hide = () => { stopConfirmation(); reset(); set({ revealed: null, busy: null, confirmExport: false, transitionBusy: false }); };
  const stopInvalidation = ports.onInvalidated(() => invalidate('登录状态变了，已隐藏密码。重新读取后再查看。', true));
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => state,
    load,
    hide,
    lock: () => invalidate(),
    async reveal(origin: string, event: MouseEvent) {
      const snapshot = usable();
      if (!event.isTrusted || snapshot === null || state.busy !== null || state.transitionBusy || !snapshot.sites.some((site) => site.origin === origin && site.hasPassword)) return;
      const scope = reset(); set({ revealed: null, busy: 'REVEAL', confirmExport: false, notice: null });
      try {
        const reply = await ports.reveal({ origin, expectedRevision: snapshot.revision!, expectedEpoch: snapshot.authEpoch }, event, request.signal);
        if (!active(scope)) return;
        if (!reply.ok) { fail(reply.code); return; }
        if (!matches(reply.value, snapshot) || reply.value.origin !== origin) { fail('CHANGED'); return; }
        set({ busy: null, revealed: reply.value.password === null ? null : { origin, password: reply.value.password }, notice: reply.value.password === null ? '这家网站没有保存的密码，请到网站上重设。' : null });
        if (reply.value.password !== null) hideTimer = setTimeout(hide, 30_000);
      } catch { if (active(scope)) fail('UNAVAILABLE'); }
    },
    askExport(event: MouseEvent) { if (event.isTrusted && usable() !== null && state.busy === null && !state.transitionBusy) { reset(); set({ confirmExport: true, revealed: null, notice: null }); } },
    cancelExport: hide,
    async export(event: MouseEvent) {
      const snapshot = usable();
      if (!event.isTrusted || snapshot === null || !state.confirmExport || state.busy !== null || state.transitionBusy) return;
      const scope = reset(); set({ revealed: null, busy: 'EXPORT', confirmExport: false, notice: null });
      try {
        const reply = await ports.export({ expectedRevision: snapshot.revision!, expectedEpoch: snapshot.authEpoch }, event, request.signal);
        if (!active(scope)) return;
        if (!reply.ok) { fail(reply.code); return; }
        if (!matches(reply.value, snapshot)) { fail('CHANGED'); return; }
        ports.download(passwordManagerCsv(reply.value.rows, reply.value.legacyPassword === null ? null : { password: reply.value.legacyPassword, email: snapshot.email ?? snapshot.defaultEmail }));
        set({ busy: null, notice: reply.value.legacyPassword === null ? '已发起本地下载，请确认文件已保存。' : '已发起本地下载。文件里的旧共用密码没有关联网站，请手动保存这一行。' });
      } catch { if (active(scope)) fail('UNAVAILABLE'); }
    },
    async resolveTransition(action: 'CONFIRM' | 'CANCEL', event: MouseEvent) {
      const transition = state.transition;
      const resolve = action === 'CONFIRM' ? ports.confirmTransition : ports.cancelTransition;
      if (!event.isTrusted || transition === null || state.transitionBusy || resolve === undefined) return;
      if (transition.expiresAt <= Date.now()) { set({ notice: '这次确认已过期，重新读取后再操作。' }); return; }
      stopConfirmation();
      const scope = reset(); set({ revealed: null, busy: null, confirmExport: false, transitionBusy: true, notice: null });
      const receiptGeneration = confirmationGeneration;
      const receiptRequest = action === 'CONFIRM' ? new AbortController() : request;
      if (action === 'CONFIRM') confirmationRequest = receiptRequest;
      const receiptActive = () => action === 'CONFIRM'
        ? !disposed && receiptGeneration === confirmationGeneration && !receiptRequest.signal.aborted
        : active(scope);
      try {
        const reply = await resolve(transition.ticket, event, receiptRequest.signal);
        if (!receiptActive()) return;
        if (action === 'CONFIRM') confirmationRequest = null;
        if (!reply.ok) { set({ transitionBusy: false, notice: failureText(reply.code) }); return; }
        if (action === 'CONFIRM') {
          invalidate(transition.action === 'LOGOUT' ? '已退出，保存的招聘网站账号已清除。' : '已清除旧记录，正在完成连接。');
        } else set({ transition: null, transitionBusy: false, notice: '已取消，登录状态和保存的账号没有改变。' });
      } catch { if (receiptActive()) { confirmationRequest = null; set({ transitionBusy: false, notice: failureText('UNAVAILABLE') }); } }
    },
    dispose() { if (disposed) return; stopConfirmation(); reset(); stopInvalidation(); state = initial(); disposed = true; listeners.clear(); },
  };
}

export type AccountVaultUi = ReturnType<typeof createAccountVaultUi>;
