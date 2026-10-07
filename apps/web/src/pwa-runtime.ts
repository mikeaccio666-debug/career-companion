/** Public installation state only. This module never receives account data or drafts. */
export type PwaRegistrationState = 'disabled' | 'registering' | 'registered' | 'unavailable';
export interface PwaSnapshot {
  readonly online: boolean;
  readonly registration: PwaRegistrationState;
  readonly offlineReady: boolean;
  readonly updateReady: boolean;
}
export interface PwaRegistration { update(): Promise<unknown>; }
export interface PwaRegisterOptions {
  immediate: boolean;
  onNeedRefresh(): void;
  onOfflineReady(): void;
  onRegisteredSW(scriptUrl: string, registration: PwaRegistration | undefined): void;
  onRegisterError(error: unknown): void;
}
export type PwaRegister = (options: PwaRegisterOptions) => unknown;
export interface PwaEnvironment {
  production: boolean;
  supported: boolean;
  isOnline(): boolean;
  isVisible(): boolean;
  now(): number;
  subscribeConnectivity(change: () => void): () => void;
  subscribeVisibility(change: () => void): () => void;
  loadRegister(): Promise<PwaRegister>;
  setTimer(run: () => void, delay: number): unknown;
  clearTimer(timer: unknown): void;
}
export const PWA_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export class PwaRuntime {
  private snapshot: PwaSnapshot = Object.freeze({ online: true, registration: 'disabled', offlineReady: false, updateReady: false });
  private listeners = new Set<() => void>();
  private generation = 0;
  private environment: PwaEnvironment | null = null;
  private disconnect: (() => void) | null = null;
  private hide: (() => void) | null = null;
  private registration: PwaRegistration | null = null;
  private timer: unknown = null;
  private lastCheck: number | null = null;
  private checking = false;

  getSnapshot = (): PwaSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(change: Partial<PwaSnapshot>) {
    const next = { ...this.snapshot, ...change };
    if (Object.keys(next).every((key) => next[key as keyof PwaSnapshot] === this.snapshot[key as keyof PwaSnapshot])) return;
    this.snapshot = Object.freeze(next);
    for (const listener of this.listeners) listener();
  }
  start(environment: PwaEnvironment): void {
    if (this.environment) return;
    this.environment = environment;
    const generation = ++this.generation;
    const current = () => this.environment === environment && this.generation === generation;
    const connected = () => { if (current()) { this.publish({ online: environment.isOnline() }); void this.checkForUpdate(generation); } };
    this.publish({ online: environment.isOnline(), registration: environment.production && environment.supported ? 'registering' : 'disabled', offlineReady: false, updateReady: false });
    this.disconnect = environment.subscribeConnectivity(connected);
    if (!environment.production || !environment.supported) return;
    this.hide = environment.subscribeVisibility(() => { if (current()) void this.checkForUpdate(generation); });
    void environment.loadRegister().then((register) => {
      if (!current()) return;
      // Deliberately discard the returned update function: activating a waiting worker
      // would replace other open workspaces without knowing their unsaved work.
      register({
        immediate: false,
        onNeedRefresh: () => { if (current()) this.publish({ updateReady: true }); },
        onOfflineReady: () => { if (current()) this.publish({ offlineReady: true }); },
        onRegisteredSW: (_url, registration) => {
          if (!current()) return;
          this.registration = registration || null;
          this.publish({ registration: registration ? 'registered' : 'unavailable' });
          this.lastCheck = environment.now();
          if (registration) this.scheduleCheck(generation);
        },
        onRegisterError: () => { if (current()) this.publish({ registration: 'unavailable' }); },
      });
    }).catch(() => { if (current()) this.publish({ registration: 'unavailable' }); });
  }
  private scheduleCheck(generation: number): void {
    const environment = this.environment;
    if (!environment || this.generation !== generation || this.timer !== null || !this.registration) return;
    this.timer = environment.setTimer(() => {
      this.timer = null;
      if (this.generation !== generation) return;
      void this.checkForUpdate(generation);
      this.scheduleCheck(generation);
    }, PWA_UPDATE_CHECK_INTERVAL_MS);
  }
  private async checkForUpdate(generation: number): Promise<void> {
    const environment = this.environment;
    if (!environment || generation !== this.generation || !this.registration || this.checking || this.snapshot.updateReady || !environment.isOnline() || !environment.isVisible()) return;
    const now = environment.now();
    if (this.lastCheck !== null && now - this.lastCheck < PWA_UPDATE_CHECK_INTERVAL_MS) return;
    this.lastCheck = now; this.checking = true;
    try { await this.registration.update(); }
    catch { /* Keep the current page and version; a later eligible check can retry. */ }
    finally { if (this.environment === environment && generation === this.generation) this.checking = false; }
  }
  dispose(): void {
    ++this.generation;
    this.disconnect?.(); this.hide?.();
    if (this.environment && this.timer !== null) this.environment.clearTimer(this.timer);
    this.environment = null; this.disconnect = null; this.hide = null;
    this.registration = null; this.timer = null; this.lastCheck = null; this.checking = false;
  }
}
export const pwaRuntime = new PwaRuntime();

export interface PwaNotice { id: 'offline' | 'update' | 'ready' | 'unavailable'; title: string; text: string; dismissible: boolean; }
export function pwaNotices(state: PwaSnapshot): PwaNotice[] {
  const notices: PwaNotice[] = [];
  if (!state.online) notices.push({ id: 'offline', title: '当前离线', text: '恢复网络后，请自行确认并继续发送。当前页面的文字不会自动提交。', dismissible: false });
  if (state.updateReady) notices.push({ id: 'update', title: '新版已准备好', text: '先保存或复制需要保留的内容，结束录音或对话，再关闭所有页面窗口重新打开。', dismissible: true });
  else if (state.offlineReady) notices.push({ id: 'ready', title: '离线入口已准备好', text: '登录、会话、资料和模型仍需联网。', dismissible: true });
  else if (state.registration === 'unavailable') notices.push({ id: 'unavailable', title: '暂时无法准备离线入口', text: '离线入口暂不可用。联网后可以重新打开账号入口。', dismissible: true });
  return notices;
}

export const WORKSPACE_CONNECTION_TIMEOUT_MS = 12_000;
export interface BootstrapTiming { setTimer(run: () => void, delay: number): unknown; clearTimer(timer: unknown): void; }
const defaultTiming: BootstrapTiming = { setTimer: (run, delay) => globalThis.setTimeout(run, delay), clearTimer: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>) };
export interface WorkspaceBootstrap<Options> {
  options: Options;
  account: unknown | null;
  health: PromiseSettledResult<unknown>;
  capabilities: PromiseSettledResult<unknown>;
  features: PromiseSettledResult<unknown>;
}
/** Explicitly read-only initialization, bounded even if a transport ignores abort. */
export async function readWorkspaceBootstrap<Options>(
  read: (path: string, signal: AbortSignal) => Promise<unknown>,
  signal: AbortSignal,
  parseOptions: (data: unknown) => Options,
  isAnonymous: (failure: unknown) => boolean,
  timing: BootstrapTiming = defaultTiming,
): Promise<WorkspaceBootstrap<Options>> {
  if (signal.aborted) throw new DOMException('Connection cancelled.', 'AbortError');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = () => reject(new DOMException('Connection interrupted.', 'AbortError')); });
  controller.signal.addEventListener('abort', rejectAbort, { once: true });
  const timer = timing.setTimer(() => controller.abort(), WORKSPACE_CONNECTION_TIMEOUT_MS);
  try {
    const operation = Promise.all([
      read('/auth/options', controller.signal).then(parseOptions),
      read('/auth/me', controller.signal).catch((failure) => { if (isAnonymous(failure)) return null; throw failure; }),
      Promise.allSettled([read('/ready', controller.signal), read('/capabilities', controller.signal), read('/features', controller.signal)]),
    ]).then(([options, account, publicResults]) => ({ options, account, health: publicResults[0], capabilities: publicResults[1], features: publicResults[2] }));
    const result = await Promise.race([operation, aborted]);
    if (signal.aborted || controller.signal.aborted) throw new DOMException('Connection cancelled.', 'AbortError');
    return result;
  } finally {
    timing.clearTimer(timer);
    signal.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', rejectAbort);
    controller.abort();
  }
}

export function publicConnectionCopy(online: boolean, connecting: boolean) {
  if (!online) return { title: '当前无法联网', text: '这里是求职伙伴的公共入口。登录和账号信息需要连接服务。恢复网络后，再重试连接。' };
  if (connecting) return { title: '正在连接你的求职账号…', text: '正在确认账号服务和当前登录状态。' };
  return { title: '暂时无法连接账号服务', text: '这里是求职伙伴的公共入口。当前无法确认登录状态或读取账号信息。请检查网络，稍后重试。' };
}
