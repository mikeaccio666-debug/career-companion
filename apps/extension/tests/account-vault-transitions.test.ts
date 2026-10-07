import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAccountVaultTransitions, MANAGEMENT_TRANSITION_BINDING, VAULT_TRANSITION_TTL_MS,
  type AccountVaultTransitionContext, type AccountVaultTransitionInspection, type AccountVaultTransitions, type AccountVaultTransitionsDeps,
} from '../lib/accountVaultTransitions';
import type { VaultTransitionReply } from '../lib/accountVaultTransitionIntent';
import { AccountVaultError } from '../lib/accountVault';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const services: AccountVaultTransitions[] = [];
afterEach(() => { for (const service of services.splice(0)) service.invalidate(); vi.useRealTimers(); });
function setup(overrides: Partial<AccountVaultTransitionsDeps> = {}) {
  const state: { context: AccountVaultTransitionContext | null; epoch: number; vault: AccountVaultTransitionInspection; time: number; logouts: number; clears: number; shown: string[] } = {
    context: { userId: 'owner-a', epoch: 7 }, epoch: 7, vault: { owner: 'owner-a', revision: 'cipher-1', hasVault: true, readable: true },
    time: 1000, logouts: 0, clears: 0, shown: [],
  };
  let ids = 0;
  const deps: AccountVaultTransitionsDeps = {
    readContext: async () => state.context === null ? null : { ...state.context }, currentEpoch: () => state.epoch,
    inspect: async () => ({ ...state.vault }), now: () => state.time, newTicket: () => `nonce-${++ids}`,
    executeLogout: async (context, revision) => {
      expect(context).toEqual(state.context); expect(revision).toBe(state.vault.revision);
      state.logouts++; state.context = null; state.epoch++; state.vault = { owner: null, revision: 'cleared', hasVault: false, readable: true };
    },
    clearVault: async assertCurrent => {
      if (!(await assertCurrent())) throw new Error('fenced');
      state.vault = { owner: null, revision: 'cleared', hasVault: false, readable: true };
      // Its own ciphertext deletion must not make subsequent key cleanup fail the assertion.
      if (!(await assertCurrent())) throw new Error('fenced after own mutation');
      state.clears++;
    },
    showSwitch: async ticket => { state.shown.push(ticket); }, ...overrides,
  };
  const service = createAccountVaultTransitions(deps); services.push(service);
  return { state, deps, service };
}
function required(reply: VaultTransitionReply): Extract<VaultTransitionReply, { kind: 'CONFIRM_REQUIRED' }> {
  expect(reply.kind).toBe('CONFIRM_REQUIRED');
  if (reply.kind !== 'CONFIRM_REQUIRED') throw new Error('No confirmation ticket');
  return reply;
}
async function switchView(service: AccountVaultTransitions) {
  for (let i = 0; i < 30; i++) {
    const reply = await service.pending(MANAGEMENT_TRANSITION_BINDING);
    if (reply.kind === 'CONFIRM_REQUIRED') { await Promise.resolve(); await Promise.resolve(); return reply; }
    await Promise.resolve();
  }
  throw new Error('Switch did not expose its local confirmation');
}

describe('local account vault transition orchestration', () => {
  it('prepares an unselected bound logout; cancel preserves auth and ciphertext', async () => {
    const h = setup(); const view = required(await h.service.prepareLogout('extension-management'));
    expect(view).toMatchObject({ action: 'LOGOUT', hasVault: true, canExport: true, expiresAt: 121000 });
    expect(h.state.logouts).toBe(0); expect(h.state.clears).toBe(0);
    expect(h.service.cancel(view.ticket, 'other-sender')).toEqual({ kind: 'REFUSED', code: 'UNAVAILABLE' });
    expect(await h.service.pending('other-sender')).toEqual({ kind: 'TRANSITION_NONE' });
    expect(h.service.cancel(view.ticket, 'extension-management')).toEqual({ kind: 'REFUSED', code: 'CANCELED' });
    expect(await h.service.confirm(view.ticket, 'extension-management')).toEqual({ kind: 'REFUSED', code: 'CANCELED' });
    expect(h.state.vault.revision).toBe('cipher-1'); expect(h.state.context?.userId).toBe('owner-a');
  });

  it('executes one real logout dependency even for concurrent confirmations', async () => {
    const h = setup(); const view = required(await h.service.prepareLogout('management'));
    const results = await Promise.all([h.service.confirm(view.ticket, 'management'), h.service.confirm(view.ticket, 'management')]);
    expect(results[0]).toEqual({ kind: 'TRANSITION_DONE', action: 'LOGOUT' });
    expect(results[1]).toEqual({ kind: 'REFUSED', code: 'UNAVAILABLE' });
    expect(h.state.logouts).toBe(1); expect(h.state.context).toBeNull();
  });

  it('rejects changed session and changed ciphertext before mutation', async () => {
    for (const change of ['owner', 'epoch', 'revision'] as const) {
      const h = setup(); const view = required(await h.service.prepareLogout('management'));
      if (change === 'owner') h.state.context = { userId: 'owner-b', epoch: 7 };
      if (change === 'epoch') { h.state.epoch++; h.state.context = { userId: 'owner-a', epoch: 8 }; }
      if (change === 'revision') h.state.vault = { ...h.state.vault, revision: 'cipher-2' };
      expect(await h.service.confirm(view.ticket, 'management')).toEqual({ kind: 'REFUSED', code: 'AUTH_CHANGED' });
      expect(h.state.logouts).toBe(0); expect(h.state.clears).toBe(0);
    }
  });

  it('preserves a real cleanup failure after the accepted logout has changed auth', async () => {
    const h = setup();
    (h.deps as { executeLogout: AccountVaultTransitionsDeps['executeLogout'] }).executeLogout = async () => {
      h.state.logouts++; h.state.context = null; h.state.epoch++;
      throw new AccountVaultError('CLEAR_FAILED');
    };
    const view = required(await h.service.prepareLogout('management'));
    expect(await h.service.confirm(view.ticket, 'management')).toEqual({ kind: 'REFUSED', code: 'CLEAR_FAILED' });
    expect(h.state.logouts).toBe(1); expect(h.state.context).toBeNull(); expect(h.state.vault.revision).toBe('cipher-1');
    expect(await h.service.confirm(view.ticket, 'management')).toEqual({ kind: 'REFUSED', code: 'CLEAR_FAILED' });
    expect(h.state.logouts).toBe(1);
  });

  it('allows read-only export while a real deferred switch is waiting, then clears only after confirmation', async () => {
    const h = setup(); const decision = h.service.requestSwitch({ nextOwnerId: 'owner-b', epoch: 7, previousContext: h.state.context });
    const view = await switchView(h.service); let settled = false; void decision.then(() => { settled = true; });
    // An independent read-only port can finish: coordinator is not holding an auth/vault lock.
    const exportRead = await h.deps.inspect(); expect(exportRead.revision).toBe('cipher-1');
    expect(settled).toBe(false); expect(h.state.clears).toBe(0); expect(view.canExport).toBe(true);
    expect(await h.service.confirm(view.ticket, MANAGEMENT_TRANSITION_BINDING)).toEqual({ kind: 'TRANSITION_DONE', action: 'SWITCH_ACCOUNT' });
    expect(await decision).toBe(true); expect(h.state.clears).toBe(1); expect(h.state.context?.userId).toBe('owner-a');
    expect(h.state.logouts).toBe(0); // The real candidate pair remains root/authClient's responsibility.
  });

  it('cancel and invalidation settle a held switch false without deleting anything', async () => {
    for (const mode of ['cancel', 'invalidate'] as const) {
      const h = setup(); const decision = h.service.requestSwitch({ nextOwnerId: 'owner-b', epoch: 7, previousContext: h.state.context });
      const view = await switchView(h.service);
      if (mode === 'cancel') h.service.cancel(view.ticket, MANAGEMENT_TRANSITION_BINDING); else h.service.invalidate();
      expect(await decision).toBe(false); expect(h.state.clears).toBe(0); expect(h.state.vault.revision).toBe('cipher-1');
    }
  });

  it('preserves readable same-owner and empty vaults without confirmation or cleanup', async () => {
    const h = setup(); expect(await h.service.requestSwitch({ nextOwnerId: 'owner-a', epoch: 7, previousContext: h.state.context })).toBe(true);
    h.state.vault = { owner: null, revision: 'empty', hasVault: false, readable: true };
    expect(await h.service.requestSwitch({ nextOwnerId: 'owner-b', epoch: 7, previousContext: h.state.context })).toBe(true);
    expect(h.state.shown).toEqual([]); expect(h.state.clears).toBe(0);
  });

  it('unreadable or foreign-owned vault cannot be exported and remains pending until explicit choice', async () => {
    for (const mode of ['unreadable', 'foreign', 'signed-out'] as const) {
      const h = setup();
      if (mode === 'unreadable') h.state.vault = { ...h.state.vault, readable: false };
      if (mode === 'foreign') h.state.vault = { ...h.state.vault, owner: 'owner-c' };
      if (mode === 'signed-out') h.state.context = null;
      const decision = h.service.requestSwitch({ nextOwnerId: 'owner-b', epoch: 7, previousContext: h.state.context });
      const view = await switchView(h.service); expect(view.canExport).toBe(false); expect(h.state.clears).toBe(0);
      h.service.cancel(view.ticket, MANAGEMENT_TRANSITION_BINDING); expect(await decision).toBe(false);
    }
  });

  it('reports cleanup failure, refuses the candidate switch and preserves the old record', async () => {
    const h = setup({ clearVault: async assertCurrent => { expect(await assertCurrent()).toBe(true); throw new Error('storage unavailable'); } });
    const decision = h.service.requestSwitch({ nextOwnerId: 'owner-b', epoch: 7, previousContext: h.state.context });
    const view = await switchView(h.service);
    expect(await h.service.confirm(view.ticket, MANAGEMENT_TRANSITION_BINDING)).toEqual({ kind: 'REFUSED', code: 'CLEAR_FAILED' });
    expect(await decision).toBe(false); expect(h.state.vault.revision).toBe('cipher-1');
  });

  it('rechecks epoch before a delayed clear dependency first mutates', async () => {
    const entered = deferred<void>(); const resume = deferred<void>(); let writes = 0;
    const h = setup({ clearVault: async check => { entered.resolve(); await resume.promise; if (!(await check())) throw new Error('fenced'); writes++; } });
    const decision = h.service.requestSwitch({ nextOwnerId: 'owner-b', epoch: 7, previousContext: h.state.context });
    const view = await switchView(h.service); const confirming = h.service.confirm(view.ticket, MANAGEMENT_TRANSITION_BINDING);
    await entered.promise; h.state.epoch++; h.state.context = { userId: 'owner-a', epoch: 8 }; resume.resolve();
    expect(await confirming).toEqual({ kind: 'REFUSED', code: 'AUTH_CHANGED' }); expect(await decision).toBe(false); expect(writes).toBe(0);
  });

  it('expires a held switch even when opening its UI never resolves', async () => {
    vi.useFakeTimers(); const opening = deferred<void>();
    const h = setup({ showSwitch: () => opening.promise });
    const decision = h.service.requestSwitch({ nextOwnerId: 'owner-b', epoch: 7, previousContext: h.state.context });
    const view = await switchView(h.service);
    expect(await h.service.confirm(view.ticket, MANAGEMENT_TRANSITION_BINDING)).toEqual({ kind: 'REFUSED', code: 'UNAVAILABLE' });
    h.state.time += VAULT_TRANSITION_TTL_MS; await vi.advanceTimersByTimeAsync(VAULT_TRANSITION_TTL_MS);
    expect(await decision).toBe(false); expect(h.state.clears).toBe(0);
    opening.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(await h.service.confirm(view.ticket, MANAGEMENT_TRANSITION_BINDING)).toEqual({ kind: 'REFUSED', code: 'EXPIRED' });
    expect(await h.service.pending(MANAGEMENT_TRANSITION_BINDING)).toEqual({ kind: 'TRANSITION_NONE' });
  });

  it('does not let an older delayed prepare replace a newer ticket', async () => {
    const firstInspection = deferred<AccountVaultTransitionInspection>(); let calls = 0;
    const h = setup({ inspect: async () => ++calls === 1 ? firstInspection.promise : ({ owner: 'owner-a', revision: 'cipher-1', hasVault: true, readable: true }) });
    const old = h.service.prepareLogout('old-ui'); for (let i = 0; i < 10 && calls === 0; i++) await Promise.resolve();
    const newer = required(await h.service.prepareLogout('new-ui')); firstInspection.resolve(h.state.vault);
    expect(await old).toEqual({ kind: 'REFUSED', code: 'AUTH_CHANGED' });
    expect(await h.service.pending('new-ui')).toEqual(newer); expect(h.state.logouts).toBe(0);
  });

  it('checks active-ticket identity after the final asynchronous context read', async () => {
    const h = setup(); const view = required(await h.service.prepareLogout('management'));
    const late = deferred<AccountVaultTransitionContext | null>(); let reads = 0;
    const original = h.deps.readContext;
    (h.deps as { readContext: AccountVaultTransitionsDeps['readContext'] }).readContext = async () => ++reads === 2 ? late.promise : original();
    const confirm = h.service.confirm(view.ticket, 'management');
    for (let i = 0; i < 20 && reads < 2; i++) await Promise.resolve(); expect(reads).toBe(2);
    h.service.invalidate(); late.resolve(h.state.context);
    expect(await confirm).toEqual({ kind: 'REFUSED', code: 'AUTH_CHANGED' }); expect(h.state.logouts).toBe(0);
  });

  it('rejects an old worker ticket even when the new worker repeats owner, epoch and injected nonce', async () => {
    const old = setup(); const view = required(await old.service.prepareLogout('management'));
    const fresh = setup(); const next = required(await fresh.service.prepareLogout('management'));
    expect(next.ticket).not.toBe(view.ticket);
    expect(await fresh.service.confirm(view.ticket, 'management')).toEqual({ kind: 'REFUSED', code: 'UNAVAILABLE' });
    expect(fresh.state.logouts).toBe(0);
  });
});
