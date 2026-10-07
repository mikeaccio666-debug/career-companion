import { isPlausibleEmail, isPlausibleSitePassword } from './accountPassword';
import { isAccountOrigin, type VaultCredentialSource, type VaultSiteState } from './accountAccessIntent';

/** Worker-only encrypted local vault. Legacy storage/key names are retained so
 * existing ciphertext can be read; a successful update writes the v2 envelope.
 * Missing keys and unreadable data are preserved for explicit user recovery.
 */
export const ACCOUNT_VAULT_STORAGE_KEY = 'accountVaultV1';
const AAD_V1 = new TextEncoder().encode('argoland-account-vault-v1');
const AAD_V2 = new TextEncoder().encode('career-companion-account-vault-v2');
const IV_BYTES = 12;
export interface AccountSiteRecord {
  readonly email: string | null;
  readonly password?: string;
  readonly source: VaultCredentialSource;
  readonly state: VaultSiteState;
  readonly revision: number;
  readonly at: number;
}
export interface AccountVaultRecord {
  readonly v: 2;
  readonly owner: string | null;
  readonly email: string | null;
  /** Retained legacy material is exportable, never a fallback for a new site. */
  readonly legacyPassword: string | null;
  readonly revision: number;
  readonly sites: Readonly<Record<string, AccountSiteRecord>>;
}
export const EMPTY_ACCOUNT_VAULT: AccountVaultRecord = Object.freeze({ v: 2, owner: null, email: null, legacyPassword: null, revision: 0, sites: Object.freeze({}) });
export interface AccountVaultArea {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}
export interface AccountVaultKeyStore { load(): Promise<CryptoKey | null>; save(key: CryptoKey): Promise<void>; remove(): Promise<void> }
export type AccountVaultDiagnostic = 'ACCOUNT_VAULT_KEY_MISSING' | 'ACCOUNT_VAULT_UNREADABLE' | 'ACCOUNT_VAULT_WRITE_FAILED' | 'ACCOUNT_VAULT_CLEAR_FAILED';
export type AccountVaultReadState = Readonly<{ kind: 'EMPTY'; record: AccountVaultRecord }> | Readonly<{ kind: 'READABLE'; record: AccountVaultRecord }> | Readonly<{ kind: 'KEY_MISSING' }> | Readonly<{ kind: 'UNREADABLE' }>;
export type AccountVaultErrorCode = 'KEY_MISSING' | 'UNREADABLE' | 'RECORD_INVALID' | 'WRITE_FAILED' | 'CLEAR_FAILED';
export class AccountVaultError extends Error {
  constructor(readonly code: AccountVaultErrorCode) { super(`ACCOUNT_VAULT_${code}`); this.name = 'AccountVaultError'; }
}
export type AccountVaultAssertCurrent = () => void | Promise<void>;
export interface AccountVault {
  readState(): Promise<AccountVaultReadState>;
  read(): Promise<AccountVaultRecord>;
  /** The caller must serialize real auth transitions with this operation.
   * Rechecks fence awaits; they cannot roll back a storage commit mid-transition. */
  update(change: (record: AccountVaultRecord) => AccountVaultRecord, assertCurrent?: AccountVaultAssertCurrent): Promise<AccountVaultRecord>;
  /** Explicit confirmed deletion only. A failed ciphertext removal retains its key. */
  clear(assertCurrent?: AccountVaultAssertCurrent): Promise<void>;
}
function base64(bytes: Uint8Array): string { let value = ''; for (const byte of bytes) value += String.fromCharCode(byte); return btoa(value); }
function unbase64(value: string): Uint8Array<ArrayBuffer> { const text = atob(value); const bytes = new Uint8Array(text.length); for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i); return bytes; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean { const own = Object.keys(value); return required.every((key) => own.includes(key)) && own.every((key) => required.includes(key) || optional.includes(key)); }
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function nullableEmail(value: unknown): value is string | null { return value === null || (typeof value === 'string' && isPlausibleEmail(value)); }
function nullablePassword(value: unknown): value is string | null { return value === null || (typeof value === 'string' && isPlausibleSitePassword(value)); }
function owner(value: unknown): value is string | null { return value === null || (typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)); }
const SOURCES: ReadonlySet<string> = new Set(['GENERATED', 'USER_SAVED', 'LEGACY_SHARED', 'LEGACY_SITE']);
const STATES: ReadonlySet<string> = new Set(['PENDING', 'REGISTERED', 'NEEDS_PASSWORD']);
function parseV2(value: unknown): AccountVaultRecord | null {
  if (!record(value) || !exactKeys(value, ['v', 'owner', 'email', 'legacyPassword', 'revision', 'sites']) || value['v'] !== 2 || !owner(value['owner']) || !nullableEmail(value['email']) || !nullablePassword(value['legacyPassword']) || !integer(value['revision']) || !record(value['sites'])) return null;
  const sites: Record<string, AccountSiteRecord> = {};
  for (const [origin, site] of Object.entries(value['sites'])) {
    if (!isAccountOrigin(origin) || !record(site) || !exactKeys(site, ['email', 'source', 'state', 'revision', 'at'], ['password']) || !nullableEmail(site['email']) || !integer(site['revision']) || !integer(site['at']) || typeof site['source'] !== 'string' || !SOURCES.has(site['source']) || typeof site['state'] !== 'string' || !STATES.has(site['state'])) return null;
    const password = site['password'];
    if (password !== undefined && (typeof password !== 'string' || !isPlausibleSitePassword(password))) return null;
    // A known credential must actually contain a password. NEEDS_PASSWORD may
    // retain an unverified reservation for honest export, but never for login.
    if (site['state'] === 'REGISTERED' && password === undefined) return null;
    sites[origin] = Object.freeze({ email: site['email'], source: site['source'] as VaultCredentialSource, state: site['state'] as VaultSiteState, revision: site['revision'], at: site['at'], ...(password === undefined ? {} : { password }) });
  }
  return Object.freeze({ v: 2, owner: value['owner'], email: value['email'], legacyPassword: value['legacyPassword'], revision: value['revision'], sites: Object.freeze(sites) });
}
/** Pure, lossless credential conversion. It does not guess a historical profile
 * email and it binds the old shared password only to preexisting known sites. */
function parseV1(value: unknown): AccountVaultRecord | null {
  if (!record(value) || !exactKeys(value, ['v', 'owner', 'email', 'password', 'sites']) || value['v'] !== 1 || !owner(value['owner']) || !nullableEmail(value['email']) || !nullablePassword(value['password']) || !record(value['sites'])) return null;
  const sites: Record<string, AccountSiteRecord> = {};
  for (const [origin, site] of Object.entries(value['sites'])) {
    if (!isAccountOrigin(origin) || !record(site) || !exactKeys(site, ['at'], ['known', 'password']) || !integer(site['at']) || (site['known'] !== undefined && site['known'] !== true) || (site['password'] !== undefined && (typeof site['password'] !== 'string' || !isPlausibleSitePassword(site['password'])))) return null;
    const ownPassword = site['password'];
    const password = typeof ownPassword === 'string' ? ownPassword : site['known'] === true ? value['password'] : null;
    sites[origin] = Object.freeze({ email: value['email'], source: typeof ownPassword === 'string' ? 'LEGACY_SITE' : 'LEGACY_SHARED', state: password !== null ? 'REGISTERED' : site['known'] === true ? 'NEEDS_PASSWORD' : 'PENDING', revision: 0, at: site['at'], ...(password === null ? {} : { password }) });
  }
  return Object.freeze({ v: 2, owner: value['owner'], email: value['email'], legacyPassword: value['password'], revision: 0, sites: Object.freeze(sites) });
}
export function createAccountVault(deps: Readonly<{
  area: AccountVaultArea; keys: AccountVaultKeyStore; subtle?: SubtleCrypto;
  random?: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;
  onDiagnostic?: (code: AccountVaultDiagnostic) => void;
}>): AccountVault {
  const subtle = deps.subtle ?? globalThis.crypto.subtle;
  const random = deps.random ?? ((bytes: Uint8Array<ArrayBuffer>) => globalThis.crypto.getRandomValues(bytes));
  const diag = (code: AccountVaultDiagnostic): void => { try { deps.onDiagnostic?.(code); } catch { /* diagnostics never contain values */ } };
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => { const next = queue.then(task, task); queue = next.catch(() => undefined); return next; };
  const readStateNow = async (): Promise<AccountVaultReadState> => {
    try {
      const stored = await deps.area.get(ACCOUNT_VAULT_STORAGE_KEY);
      if (stored === undefined || stored === null) return Object.freeze({ kind: 'EMPTY', record: EMPTY_ACCOUNT_VAULT });
      if (!record(stored) || (stored['v'] !== 1 && stored['v'] !== 2) || typeof stored['iv'] !== 'string' || typeof stored['data'] !== 'string') throw new Error('shape');
      const key = await deps.keys.load();
      if (key === null) { diag('ACCOUNT_VAULT_KEY_MISSING'); return Object.freeze({ kind: 'KEY_MISSING' }); }
      const iv = unbase64(stored['iv']); if (iv.byteLength !== IV_BYTES) throw new Error('iv');
      const plain = await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: stored['v'] === 1 ? AAD_V1 : AAD_V2 }, key, unbase64(stored['data']));
      const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
      const checked = stored['v'] === 1 ? parseV1(decoded) : parseV2(decoded);
      if (checked === null) throw new Error('record');
      return Object.freeze({ kind: 'READABLE', record: checked });
    } catch { diag('ACCOUNT_VAULT_UNREADABLE'); return Object.freeze({ kind: 'UNREADABLE' }); }
  };
  const readNow = async (): Promise<AccountVaultRecord> => {
    const state = await readStateNow();
    if (state.kind === 'EMPTY' || state.kind === 'READABLE') return state.record;
    throw new AccountVaultError(state.kind);
  };
  const writeNow = async (value: AccountVaultRecord, assertCurrent: AccountVaultAssertCurrent, mayCreateKey: boolean): Promise<void> => {
    let key = await deps.keys.load(); await assertCurrent();
    if (key === null) {
      if (!mayCreateKey) throw new AccountVaultError('KEY_MISSING');
      key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) as CryptoKey;
      await assertCurrent(); await deps.keys.save(key); await assertCurrent();
    }
    const iv = random(new Uint8Array(IV_BYTES));
    const data = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD_V2 }, key, new TextEncoder().encode(JSON.stringify(value)));
    await assertCurrent();
    await deps.area.set(ACCOUNT_VAULT_STORAGE_KEY, { v: 2, iv: base64(iv), data: base64(new Uint8Array(data)) });
    await assertCurrent();
  };
  return Object.freeze({
    readState: () => serial(readStateNow),
    read: () => serial(readNow),
    update: (change: (current: AccountVaultRecord) => AccountVaultRecord, assertCurrent: AccountVaultAssertCurrent = () => undefined) => serial(async () => {
      const state = await readStateNow(); await assertCurrent();
      if (state.kind !== 'EMPTY' && state.kind !== 'READABLE') throw new AccountVaultError(state.kind);
      const current = state.record;
      if (current.revision === Number.MAX_SAFE_INTEGER) throw new AccountVaultError('RECORD_INVALID');
      const checked = parseV2({ ...change(current), revision: current.revision + 1 });
      if (checked === null) throw new AccountVaultError('RECORD_INVALID');
      // All credential rows are retained. Metadata retention is not allowed to
      // silently evict a password or the only evidence of an existing account.
      try { await writeNow(checked, assertCurrent, state.kind === 'EMPTY'); } catch (error) { diag('ACCOUNT_VAULT_WRITE_FAILED'); throw error; }
      return checked;
    }),
    clear: (assertCurrent: AccountVaultAssertCurrent = () => undefined) => serial(async () => {
      await assertCurrent();
      try { await deps.area.remove(ACCOUNT_VAULT_STORAGE_KEY); } catch { diag('ACCOUNT_VAULT_CLEAR_FAILED'); throw new AccountVaultError('CLEAR_FAILED'); }
      await assertCurrent();
      // A resolved adapter call is not proof of removal. Preserve the key if
      // ciphertext is still present, or its absence cannot be read back.
      try { const remaining = await deps.area.get(ACCOUNT_VAULT_STORAGE_KEY); if (remaining !== undefined && remaining !== null) throw new Error('still present'); } catch { diag('ACCOUNT_VAULT_CLEAR_FAILED'); throw new AccountVaultError('CLEAR_FAILED'); }
      await assertCurrent();
      try { await deps.keys.remove(); } catch { diag('ACCOUNT_VAULT_CLEAR_FAILED'); throw new AccountVaultError('CLEAR_FAILED'); }
      await assertCurrent();
    }),
  });
}
const DB_NAME = 'argoland-account-vault';
const STORE = 'keys';
const KEY_ID = 'vault-key-v1';
/** IndexedDB request success precedes durability. Resolve only on transaction
 * complete; an abort after request success must fail the vault write. */
export function createIndexedDbVaultKeyStore(factory: IDBFactory): AccountVaultKeyStore {
  const open = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, 1); let settled = false;
    const fail = (code: string): void => { if (!settled) { settled = true; reject(new Error(code)); } };
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
    req.onsuccess = () => { if (settled) req.result.close(); else { settled = true; resolve(req.result); } };
    req.onerror = () => fail('IDB_OPEN_FAILED');
    req.onblocked = () => fail('IDB_OPEN_BLOCKED');
  });
  const withStore = async <T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode); let result: T; let succeeded = false; let settled = false;
        const fail = (): void => { if (!settled) { settled = true; reject(new Error('IDB_TRANSACTION_FAILED')); } };
        tx.oncomplete = () => { if (!settled) { settled = true; if (succeeded) resolve(result); else reject(new Error('IDB_REQUEST_INCOMPLETE')); } };
        tx.onabort = fail; tx.onerror = fail;
        try {
          const req = act(tx.objectStore(STORE));
          req.onsuccess = () => { result = req.result; succeeded = true; };
          req.onerror = fail;
        } catch { try { tx.abort(); } catch { /* already settled */ } fail(); }
      });
    } finally { db.close(); }
  };
  return Object.freeze({
    load: async () => { const value: unknown = await withStore('readonly', (store) => store.get(KEY_ID)); return value instanceof CryptoKey ? value : null; },
    save: async (key: CryptoKey) => { await withStore('readwrite', (store) => store.put(key, KEY_ID)); },
    remove: async () => { await withStore('readwrite', (store) => store.delete(KEY_ID)); },
  });
}
