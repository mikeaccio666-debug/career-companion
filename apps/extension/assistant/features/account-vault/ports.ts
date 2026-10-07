/** Internal UI ports. Revision/epoch are recheck inputs, never authorization. */
export interface VaultSiteView {
  readonly origin: string;
  readonly email: string | null;
  readonly source: 'GENERATED' | 'USER_SAVED' | 'LEGACY_SHARED' | 'LEGACY_SITE';
  readonly state: 'PENDING' | 'REGISTERED' | 'NEEDS_PASSWORD';
  readonly hasPassword: boolean;
  readonly at: number;
}

export interface VaultSnapshotView {
  readonly status: 'EMPTY' | 'READABLE' | 'KEY_MISSING' | 'UNREADABLE';
  readonly revision: number | null;
  readonly authEpoch: number;
  readonly email: string | null;
  readonly defaultEmail: string | null;
  readonly sites: readonly VaultSiteView[];
}

export type VaultUiFailure = 'AUTH_CHANGED' | 'OWNER_CHANGED' | 'CHANGED' | 'UNTRUSTED' | 'UNAVAILABLE' | 'KEY_MISSING' | 'UNREADABLE' | 'CLEAR_FAILED' | 'EXPIRED' | 'CANCELED';
export type VaultUiResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; code: VaultUiFailure }>;

export interface VaultTransitionView {
  readonly ticket: string;
  readonly action: 'LOGOUT' | 'SWITCH_ACCOUNT';
  readonly hasVault: boolean;
  readonly canExport: boolean;
  readonly expiresAt: number;
}

export interface AccountVaultUiPorts {
  list(signal: AbortSignal): Promise<VaultUiResult<VaultSnapshotView>>;
  reveal(input: { origin: string; expectedRevision: number; expectedEpoch: number }, event: MouseEvent, signal: AbortSignal): Promise<VaultUiResult<{
    origin: string; password: string | null; revision: number; authEpoch: number;
  }>>;
  export(input: { expectedRevision: number; expectedEpoch: number }, event: MouseEvent, signal: AbortSignal): Promise<VaultUiResult<{
    rows: readonly { origin: string; email: string | null; password: string }[];
    legacyPassword: string | null; revision: number; authEpoch: number;
  }>>;
  /** Extension-owned download implementation; no server, clipboard or host DOM. */
  download(csv: string): void;
  onInvalidated(listener: () => void): () => void;
  loadPendingTransition?(signal: AbortSignal): Promise<VaultUiResult<VaultTransitionView | null>>;
  confirmTransition?(ticket: string, event: MouseEvent, signal: AbortSignal): Promise<VaultUiResult<void>>;
  cancelTransition?(ticket: string, event: MouseEvent, signal: AbortSignal): Promise<VaultUiResult<void>>;
}
