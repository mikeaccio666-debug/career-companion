import type { AuthClient, VaultAuthContext } from './authClient';
import { ACCOUNT_VAULT_STORAGE_KEY, type AccountVault, type AccountVaultArea } from './accountVault';
import { createAccountVaultTransitions, type AccountVaultTransitionInspection } from './accountVaultTransitions';

/** Worker-local bridge to the real auth lifecycle. No portal identity claim or
 * client epoch can replace the session that authClient actually validated. */
export function createAccountVaultLifecycle(deps: Readonly<{
  auth: () => AuthClient;
  vault: AccountVault;
  area: Pick<AccountVaultArea, 'get'>;
  invalidateOperations: () => void;
  broadcastInvalidated: () => void;
  showSwitch: (ticket: string) => Promise<void>;
}>) {
  let destructive: Promise<void> | null = null;
  let acceptedLogout = false;
  const serializeClear = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (destructive !== null) throw new Error('VAULT_TRANSITION_BUSY');
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    destructive = held;
    deps.invalidateOperations();
    try { return await operation(); }
    finally { if (destructive === held) destructive = null; release(); }
  };
  const inspect = async (): Promise<AccountVaultTransitionInspection> => {
    // The fingerprint also binds unreadable ciphertext. Reading raw bytes twice
    // prevents presenting a revision from one record with another record's owner.
    const before = JSON.stringify(await deps.area.get(ACCOUNT_VAULT_STORAGE_KEY)) ?? 'absent';
    const state = await deps.vault.readState();
    const after = JSON.stringify(await deps.area.get(ACCOUNT_VAULT_STORAGE_KEY)) ?? 'absent';
    if (before !== after) throw new Error('VAULT_REVISION_CHANGED');
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(after));
    const revision = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
    return { owner: state.kind === 'READABLE' ? state.record.owner : null,
      revision, hasVault: after !== 'absent' && after !== 'null', readable: state.kind === 'READABLE' || state.kind === 'EMPTY' };
  };
  const transitions = createAccountVaultTransitions({
    readContext: () => deps.auth().readVaultAuthContext({ readOnly: true }),
    currentEpoch: () => deps.auth().vaultAuthEpoch(),
    inspect,
    executeLogout: async (context, revision) => serializeClear(async () => {
      if ((await inspect()).revision !== revision) throw new Error('VAULT_REVISION_CHANGED');
      // Auth validates this exact owner/generation again before its first mutation.
      acceptedLogout = true;
      try {
        await deps.auth().logout(context);
        // A new handoff may begin, but its beforeReplace hook waits for this
        // barrier. No replacement identity can commit before old vault cleanup.
        await deps.vault.clear();
      } finally { acceptedLogout = false; }
    }),
    clearVault: async (assertCurrent) => serializeClear(async () => {
      // Do the revision assertion outside the vault queue: inspect reads it too.
      if (!(await assertCurrent())) throw new Error('VAULT_AUTH_CHANGED');
      await deps.vault.clear(async () => { if (!(await assertCurrent())) throw new Error('VAULT_AUTH_CHANGED'); });
    }),
    showSwitch: deps.showSwitch,
  });
  return Object.freeze({
    transitions,
    readContext: async (readOnly = false): Promise<VaultAuthContext | null> => {
      if (destructive !== null) return null;
      const current = await deps.auth().readVaultAuthContext({ readOnly });
      return destructive === null ? current : null;
    },
    beforeReplaceSession: async (change: Readonly<{ previousOwnerId: string | null; nextOwnerId: string; epoch: number }>): Promise<boolean> => {
      const pendingClear = destructive;
      if (pendingClear !== null) await pendingClear;
      if (deps.auth().vaultAuthEpoch() !== change.epoch) return false;
      const previousContext = await deps.auth().readVaultAuthContext({ readOnly: true });
      if (previousContext !== null && previousContext.userId !== change.previousOwnerId) return false;
      return transitions.requestSwitch({ nextOwnerId: change.nextOwnerId, epoch: change.epoch, previousContext });
    },
    onAuthInvalidated: (): void => {
      deps.invalidateOperations();
      if (!acceptedLogout) transitions.invalidate();
      deps.broadcastInvalidated();
    },
  });
}
