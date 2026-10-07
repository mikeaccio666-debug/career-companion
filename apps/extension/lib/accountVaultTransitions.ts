import { isVaultTransitionTicket, type VaultTransitionAction, type VaultTransitionRefusal, type VaultTransitionReply } from './accountVaultTransitionIntent';
import { AccountVaultError } from './accountVault';

export const VAULT_TRANSITION_TTL_MS = 120_000;
/** Root derives this only after the exact extension-management sender check. */
export const MANAGEMENT_TRANSITION_BINDING = 'extension-vault-management';
export interface AccountVaultTransitionContext { readonly userId: string; readonly epoch: number }
export interface AccountVaultTransitionInspection {
  readonly owner: string | null;
  readonly revision: string;
  readonly hasVault: boolean;
  readonly readable: boolean;
}
export interface AccountVaultTransitionsDeps {
  readonly readContext: () => Promise<AccountVaultTransitionContext | null>;
  readonly currentEpoch: () => number;
  readonly inspect: () => Promise<AccountVaultTransitionInspection>;
  /** Performs the real fenced auth/logout and vault cleanup; must reject failed cleanup. */
  readonly executeLogout: (expected: AccountVaultTransitionContext, revision: string) => Promise<void>;
  /** First assertion checks revision too; subsequent assertions allow this clear's own revision change. */
  readonly clearVault: (assertCurrent: () => Promise<boolean>) => Promise<void>;
  readonly showSwitch: (ticket: string) => Promise<void>;
  readonly now?: () => number;
  readonly newTicket?: () => string;
}
export interface AccountVaultTransitions {
  prepareLogout(binding: string): Promise<VaultTransitionReply>;
  pending(binding: string): Promise<VaultTransitionReply>;
  confirm(ticket: string, binding: string): Promise<VaultTransitionReply>;
  cancel(ticket: string, binding: string): VaultTransitionReply;
  /** Called solely by root after a validated real pair and before persisting it. */
  requestSwitch(input: Readonly<{ nextOwnerId: string; epoch: number; previousContext: AccountVaultTransitionContext | null }>): Promise<boolean>;
  invalidate(): void;
}
interface Held {
  readonly ticket: string;
  readonly action: VaultTransitionAction;
  readonly binding: string;
  readonly epoch: number;
  readonly context: AccountVaultTransitionContext | null;
  readonly inspection: AccountVaultTransitionInspection;
  readonly expiresAt: number;
  readonly resolve?: (accepted: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  ready: boolean;
  phase: 'WAITING' | 'CONFIRMING';
  settled: boolean;
}
const refusal = (code: VaultTransitionRefusal): VaultTransitionReply => Object.freeze({ kind: 'REFUSED', code });
const none = (): VaultTransitionReply => Object.freeze({ kind: 'TRANSITION_NONE' });
function sameContext(a: AccountVaultTransitionContext | null, b: AccountVaultTransitionContext | null): boolean {
  return a === null ? b === null : b !== null && a.userId === b.userId && a.epoch === b.epoch;
}
function validContext(value: AccountVaultTransitionContext | null): boolean {
  return value === null || (typeof value.userId === 'string' && value.userId !== '' && Number.isSafeInteger(value.epoch) && value.epoch >= 0);
}
/** Local confirmation orchestration. It neither grants execution authority nor holds an auth mutex. */
export function createAccountVaultTransitions(deps: AccountVaultTransitionsDeps): AccountVaultTransitions {
  const now = deps.now ?? Date.now;
  const newTicket = deps.newTicket ?? (() => crypto.randomUUID());
  // An old UI ticket cannot become valid after a worker restart, even if its numeric epoch repeats.
  const instance = crypto.randomUUID();
  let active: Held | null = null;
  let generation = 0;
  const terminal = new Map<string, VaultTransitionRefusal>();
  const issued = new Set<string>();
  const remember = (ticket: string, code: VaultTransitionRefusal): void => {
    terminal.set(ticket, code);
    if (terminal.size > 32) terminal.delete(terminal.keys().next().value!);
  };
  const finish = (held: Held, accepted: boolean, code: VaultTransitionRefusal): void => {
    if (held.settled) return;
    held.settled = true;
    clearTimeout(held.timer);
    if (active === held) active = null;
    remember(held.ticket, code);
    held.resolve?.(accepted);
  };
  const invalidate = (): void => {
    generation += 1;
    if (active !== null) finish(active, false, 'AUTH_CHANGED');
  };
  const validEpoch = (epoch: number): boolean => Number.isSafeInteger(epoch) && epoch >= 0 && deps.currentEpoch() === epoch;
  const expired = (held: Held): boolean => {
    const time = now();
    return !Number.isSafeInteger(time) || time < 0 || time >= held.expiresAt;
  };
  const contextCurrent = async (context: AccountVaultTransitionContext | null, epoch: number): Promise<boolean> => {
    if (!validContext(context) || !validEpoch(epoch)) return false;
    const current = await deps.readContext();
    return validContext(current) && sameContext(context, current) && validEpoch(epoch);
  };
  const inspect = async (): Promise<AccountVaultTransitionInspection> => {
    const value = await deps.inspect();
    if (typeof value.revision !== 'string' || value.revision === '' ||
        !(value.owner === null || typeof value.owner === 'string') ||
        typeof value.hasVault !== 'boolean' || typeof value.readable !== 'boolean') throw new Error('UNAVAILABLE');
    return Object.freeze({ owner: value.owner, revision: value.revision, hasVault: value.hasVault, readable: value.readable });
  };
  const view = (held: Held): VaultTransitionReply => Object.freeze({
    kind: 'CONFIRM_REQUIRED', ticket: held.ticket, action: held.action,
    hasVault: held.inspection.hasVault,
    canExport: held.inspection.hasVault && held.inspection.readable && held.context !== null && held.inspection.owner === held.context.userId,
    expiresAt: held.expiresAt,
  });
  const createHeld = (action: VaultTransitionAction, binding: string, epoch: number, context: AccountVaultTransitionContext | null,
    inspection: AccountVaultTransitionInspection, resolve?: (accepted: boolean) => void): Held => {
    const time = now();
    const part = newTicket();
    const ticket = `${instance}_${part}`;
    if (!Number.isSafeInteger(time) || time < 0 || !Number.isSafeInteger(time + VAULT_TRANSITION_TTL_MS) ||
        !isVaultTransitionTicket(part) || !isVaultTransitionTicket(ticket) || issued.has(ticket)) throw new Error('UNAVAILABLE');
    issued.add(ticket);
    const held: Held = { ticket, action, binding, epoch, context: context === null ? null : Object.freeze({ ...context }), inspection,
      expiresAt: time + VAULT_TRANSITION_TTL_MS, resolve, ready: action === 'LOGOUT', phase: 'WAITING', settled: false,
      timer: undefined as unknown as ReturnType<typeof setTimeout> };
    held.timer = setTimeout(() => finish(held, false, 'EXPIRED'), VAULT_TRANSITION_TTL_MS);
    (held.timer as unknown as { unref?: () => void }).unref?.();
    active = held;
    return held;
  };
  const checkHeld = async (held: Held, checkRevision: boolean): Promise<VaultTransitionRefusal | null> => {
    if (active !== held) return terminal.get(held.ticket) ?? 'AUTH_CHANGED';
    if (expired(held)) return 'EXPIRED';
    if (!(await contextCurrent(held.context, held.epoch))) return 'AUTH_CHANGED';
    if (checkRevision && (await inspect()).revision !== held.inspection.revision) return 'AUTH_CHANGED';
    if (!(await contextCurrent(held.context, held.epoch)) || active !== held) return terminal.get(held.ticket) ?? 'AUTH_CHANGED';
    if (expired(held)) return 'EXPIRED';
    return null;
  };
  return Object.freeze({
    async prepareLogout(binding: string) {
      invalidate();
      const attempt = generation;
      try {
        if (binding === '') return refusal('UNAVAILABLE');
        const epoch = deps.currentEpoch();
        const read = await deps.readContext();
        if (read === null || !validContext(read)) return refusal('AUTH_CHANGED');
        const context = Object.freeze({ userId: read.userId, epoch: read.epoch });
        if (!(await contextCurrent(context, epoch))) return refusal('AUTH_CHANGED');
        const snapshot = await inspect();
        const current = await contextCurrent(context, epoch);
        if (attempt !== generation || !current) return refusal('AUTH_CHANGED');
        return view(createHeld('LOGOUT', binding, epoch, context, snapshot));
      } catch { return refusal('UNAVAILABLE'); }
    },
    async pending(binding: string) {
      const held = active;
      if (held === null || held.binding !== binding || held.phase !== 'WAITING') return none();
      try {
        const error = await checkHeld(held, true);
        if (error !== null) { finish(held, false, error); return refusal(error); }
        return view(held);
      } catch { finish(held, false, 'UNAVAILABLE'); return refusal('UNAVAILABLE'); }
    },
    async confirm(ticket: string, binding: string) {
      const held = active;
      if (held === null || held.ticket !== ticket || held.binding !== binding || held.phase !== 'WAITING') return refusal(terminal.get(ticket) ?? 'UNAVAILABLE');
      if (!held.ready) return refusal('UNAVAILABLE');
      // Consume synchronously, before any await: concurrent confirmations cannot execute twice.
      held.phase = 'CONFIRMING';
      let logoutEntered = false;
      try {
        const error = await checkHeld(held, true);
        if (error !== null) { finish(held, false, error); return refusal(error); }
        if (held.action === 'LOGOUT') {
          if (held.context === null) { finish(held, false, 'AUTH_CHANGED'); return refusal('AUTH_CHANGED'); }
          // Own logout changes auth. Root fences its real mutation and suppresses self-invalidation here.
          logoutEntered = true;
          await deps.executeLogout(held.context, held.inspection.revision);
        } else {
          let first = true;
          await deps.clearVault(async () => {
            try {
              const error = await checkHeld(held, first);
              if (error !== null) return false;
              first = false;
              return true;
            } catch { return false; }
          });
          const error = await checkHeld(held, false);
          if (error !== null) { finish(held, false, error); return refusal(error); }
        }
        finish(held, true, 'UNAVAILABLE');
        return Object.freeze({ kind: 'TRANSITION_DONE', action: held.action });
      } catch (error) {
        let code: VaultTransitionRefusal = terminal.get(held.ticket) ?? 'CLEAR_FAILED';
        // A real logout deliberately changes the auth context before removing
        // ciphertext. Preserve a typed storage failure instead of hiding it
        // behind that expected auth change; unrelated invalidation still wins.
        const ownLogoutClearFailure = logoutEntered && error instanceof AccountVaultError && error.code === 'CLEAR_FAILED';
        if (!ownLogoutClearFailure || terminal.has(held.ticket)) {
          try { code = (await checkHeld(held, false)) ?? code; } catch { /* Keep the actual cleanup failure. */ }
        }
        finish(held, false, code);
        return refusal(code);
      }
    },
    cancel(ticket: string, binding: string) {
      const held = active;
      if (held === null || held.ticket !== ticket || held.binding !== binding || held.phase !== 'WAITING') return refusal(terminal.get(ticket) ?? 'UNAVAILABLE');
      finish(held, false, 'CANCELED');
      return refusal('CANCELED');
    },
    async requestSwitch(input: Readonly<{ nextOwnerId: string; epoch: number; previousContext: AccountVaultTransitionContext | null }>) {
      invalidate();
      const attempt = generation;
      try {
        const nextOwnerId = input.nextOwnerId;
        const epoch = input.epoch;
        const previousContext = input.previousContext === null ? null : Object.freeze({ userId: input.previousContext.userId, epoch: input.previousContext.epoch });
        if (typeof nextOwnerId !== 'string' || nextOwnerId === '' || !validContext(previousContext) || !(await contextCurrent(previousContext, epoch))) return false;
        const snapshot = await inspect();
        const current = await contextCurrent(previousContext, epoch);
        if (attempt !== generation || !current) return false;
        if (!snapshot.hasVault || (snapshot.readable && snapshot.owner === nextOwnerId)) return true;
        let resolve!: (accepted: boolean) => void;
        const decision = new Promise<boolean>((done) => { resolve = done; });
        const held = createHeld('SWITCH_ACCOUNT', MANAGEMENT_TRANSITION_BINDING, epoch, previousContext, snapshot, resolve);
        const shown = Promise.resolve().then(() => deps.showSwitch(held.ticket)).then(() => {
          if (active === held) held.ready = true;
          return 'SHOWN' as const;
        }, () => { finish(held, false, 'UNAVAILABLE'); return 'FAILED' as const; });
        const first = await Promise.race([shown, decision]);
        if (typeof first === 'boolean') return first;
        return await decision;
      } catch { return false; }
    },
    invalidate,
  });
}
