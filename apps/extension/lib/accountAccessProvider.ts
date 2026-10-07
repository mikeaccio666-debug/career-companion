import { generateAccountPassword, isPlausibleEmail, isPlausibleSitePassword } from './accountPassword';
import { isAccountOrigin, type AccountAccessRefused, type AccountVaultManagementPayload, type AccountVaultManagementReply, type AccountVaultListReply, type DockAccountAccessPayload, type DockAccountAccessReply, type DockAccountAccessRefusal, type VaultSiteSummary } from './accountAccessIntent';
import { AccountVaultError, type AccountSiteRecord, type AccountVault, type AccountVaultRecord } from './accountVault';

/** These worker-local context ids fence replay/source races. They do not grant
 * DOM write, consent, runtime capability, or trusted-click authority. */
export interface AccountAuthContext { readonly userId: string; readonly epoch: number }
interface BoundOperation {
  readonly owner: string; readonly epoch: number; readonly origin: string;
  readonly email: string | null; readonly siteRevision: number | null;
  readonly kind: 'prompt' | 'credential'; readonly purpose?: 'register' | 'login';
}
interface StoredOperation extends BoundOperation { readonly expires: number; claimed: boolean }
export interface AccountAccessOperationStore {
  issue(context: BoundOperation): string;
  claim(id: string, context: AccountAuthContext, origin: string, expectedEpoch: number): BoundOperation | null;
  check(id: string, context: AccountAuthContext, origin: string, expectedEpoch: number): BoundOperation | null;
  release(id: string): void;
  consume(id: string): void;
  invalidate(): void;
}
/** Instantiate once per worker lifetime, not once per RPC. A restart intentionally
 * invalidates all outstanding context ids, even if a numeric epoch is repeated. */
export function createAccountAccessOperationStore(deps: Readonly<{ now?: () => number; id?: () => string }> = {}): AccountAccessOperationStore {
  const now = deps.now ?? (() => Date.now()); const id = deps.id ?? (() => crypto.randomUUID());
  const entries = new Map<string, StoredOperation>(); const ttl = 10 * 60_000;
  const prune = (): void => { for (const [key, entry] of entries) if (entry.expires <= now()) entries.delete(key); };
  return Object.freeze({
    issue: (context: BoundOperation): string => {
      prune();
      // Context tokens can expire/evict; persisted credentials never do.
      if (entries.size >= 1000) entries.delete(entries.keys().next().value!);
      const token = id(); if (!/^[a-zA-Z0-9-]{16,100}$/u.test(token) || entries.has(token)) throw new Error('ACCOUNT_OPERATION_ID_INVALID');
      entries.set(token, { ...context, expires: now() + ttl, claimed: false }); return token;
    },
    claim: (token: string, context: AccountAuthContext, origin: string, expectedEpoch: number): BoundOperation | null => {
      prune(); const entry = entries.get(token);
      if (entry === undefined || entry.claimed || entry.owner !== context.userId || entry.epoch !== context.epoch || expectedEpoch !== context.epoch || entry.origin !== origin) return null;
      entry.claimed = true; return Object.freeze({ owner: entry.owner, epoch: entry.epoch, origin: entry.origin, email: entry.email, siteRevision: entry.siteRevision, kind: entry.kind, ...(entry.purpose === undefined ? {} : { purpose: entry.purpose }) });
    },
    check: (token: string, context: AccountAuthContext, origin: string, expectedEpoch: number): BoundOperation | null => {
      prune(); const entry = entries.get(token);
      if (entry === undefined || entry.claimed || entry.owner !== context.userId || entry.epoch !== context.epoch || expectedEpoch !== context.epoch || entry.origin !== origin) return null;
      return Object.freeze({ owner: entry.owner, epoch: entry.epoch, origin: entry.origin, email: entry.email, siteRevision: entry.siteRevision, kind: entry.kind, ...(entry.purpose === undefined ? {} : { purpose: entry.purpose }) });
    },
    release: (token: string): void => { const entry = entries.get(token); if (entry !== undefined) entry.claimed = false; },
    consume: (token: string): void => { entries.delete(token); },
    invalidate: (): void => { entries.clear(); },
  });
}
export type AccountAccessDiagnostic = 'ACCOUNT_ACCESS_NOT_SIGNED_IN' | 'ACCOUNT_ACCESS_CONSENT_MISSING' | 'ACCOUNT_ACCESS_DISABLED' | 'ACCOUNT_ACCESS_NO_EMAIL' | 'ACCOUNT_ACCESS_PASSWORD_GENERATED' | 'ACCOUNT_ACCESS_VAULT_FAILED' | 'ACCOUNT_ACCESS_OWNER_CHANGED' | `ACCOUNT_ACCESS_RECORDED_${'CREATED' | 'SIGNED_IN' | 'EXISTS' | 'VERIFICATION_REQUIRED'}`;
export interface AccountAccessProviderDeps {
  readonly vault: AccountVault;
  readonly getAuthContext: () => Promise<AccountAuthContext | null>;
  /** Root verifies the extension-settings sender and may allow retained-owner
   * export during a confirmed handoff. This path cannot write credentials. */
  readonly getManagementContext: () => Promise<AccountAuthContext | null>;
  readonly ops: AccountAccessOperationStore;
  readonly consent: () => Promise<boolean>;
  readonly capability: () => Promise<boolean>;
  readonly profileEmail: () => Promise<string | null>;
  readonly now?: () => number; readonly generate?: () => string;
  readonly onDiagnostic?: (code: AccountAccessDiagnostic) => void;
}
export interface AccountAccessProvider {
  handle(payload: DockAccountAccessPayload, site: string): Promise<DockAccountAccessReply>;
  /** Never call from an ATS content-script sender. */
  manage(payload: AccountVaultManagementPayload): Promise<AccountVaultManagementReply>;
}
class AccessError extends Error { constructor(readonly code: DockAccountAccessRefusal) { super(`ACCOUNT_ACCESS_${code}`); } }
function refusal(code: DockAccountAccessRefusal, context?: Readonly<{ operationId: string; authEpoch: number }>): AccountAccessRefused { return Object.freeze({ kind: 'REFUSED', code, ...context }); }
function validAuth(value: AccountAuthContext | null): value is AccountAuthContext { return value !== null && value.userId.length > 0 && value.userId.length <= 256 && Number.isSafeInteger(value.epoch) && value.epoch >= 0; }
function assertOwned(record: AccountVaultRecord, auth: AccountAuthContext): void {
  if (record.owner === auth.userId) return;
  if (record.owner === null && record.email === null && record.legacyPassword === null && Object.keys(record.sites).length === 0 && record.revision === 0) return;
  throw new AccessError('OWNER_CHANGED');
}
function siteRevision(record: AccountVaultRecord, origin: string): number | null { return record.sites[origin]?.revision ?? null; }
function known(site: AccountSiteRecord | undefined): boolean { return site?.state === 'REGISTERED' || site?.state === 'NEEDS_PASSWORD'; }
function safeEmail(value: string | null): string | null { return value !== null && isPlausibleEmail(value.trim()) ? value.trim() : null; }
function mappedError(error: unknown): DockAccountAccessRefusal {
  if (error instanceof AccessError) return error.code;
  if (error instanceof AccountVaultError && (error.code === 'KEY_MISSING' || error.code === 'UNREADABLE')) return error.code;
  return 'UNAVAILABLE';
}
export function createAccountAccessProvider(deps: AccountAccessProviderDeps): AccountAccessProvider {
  const now = deps.now ?? (() => Date.now()); const generate = deps.generate ?? (() => generateAccountPassword());
  const diag = (code: AccountAccessDiagnostic): void => { try { deps.onDiagnostic?.(code); } catch { /* codes only */ } };
  const getContext = async (read: () => Promise<AccountAuthContext | null>): Promise<AccountAuthContext> => {
    const current = await read().catch(() => null); if (!validAuth(current)) throw new AccessError('UNAVAILABLE'); return Object.freeze({ ...current });
  };
  const guardFor = (auth: AccountAuthContext, read: () => Promise<AccountAuthContext | null>) => async (): Promise<void> => {
    const current = await read().catch(() => null);
    if (!validAuth(current) || current.userId !== auth.userId || current.epoch !== auth.epoch) throw new AccessError('AUTH_CHANGED');
  };
  const checkedRead = async <T>(read: () => Promise<T>, fallback: T, guard: () => Promise<void>): Promise<T> => { const result = await read().catch(() => fallback); await guard(); return result; };
  const readOwned = async (auth: AccountAuthContext, guard: () => Promise<void>): Promise<AccountVaultRecord> => { const result = await deps.vault.read(); await guard(); assertOwned(result, auth); return result; };
  const emailFor = async (record: AccountVaultRecord, origin: string, guard: () => Promise<void>): Promise<string | null> => {
    const existing = record.sites[origin];
    // An unknown historical username stays unknown; current profile data cannot
    // reconstruct the username that belongs to an existing site's password.
    if (existing !== undefined) return existing.email;
    return record.email ?? safeEmail(await checkedRead(deps.profileEmail, null, guard));
  };
  const issue = (auth: AccountAuthContext, origin: string, record: AccountVaultRecord, email: string | null, kind: BoundOperation['kind'], purpose?: 'register' | 'login'): Readonly<{ operationId: string; authEpoch: number }> => Object.freeze({ operationId: deps.ops.issue({ owner: auth.userId, epoch: auth.epoch, origin, email, siteRevision: siteRevision(record, origin), kind, ...(purpose === undefined ? {} : { purpose }) }), authEpoch: auth.epoch });
  const list = async (auth: AccountAuthContext, guard: () => Promise<void>): Promise<AccountVaultListReply> => {
    const state = await deps.vault.readState(); await guard();
    const defaultEmail = safeEmail(await checkedRead(deps.profileEmail, null, guard));
    if (state.kind === 'KEY_MISSING' || state.kind === 'UNREADABLE') return Object.freeze({ kind: 'VAULT_LIST', status: state.kind, revision: null, authEpoch: auth.epoch, email: null, defaultEmail, sites: Object.freeze([]) });
    assertOwned(state.record, auth);
    const sites: VaultSiteSummary[] = Object.entries(state.record.sites).map(([origin, entry]) => Object.freeze({ origin, email: entry.email, source: entry.source, state: entry.state, hasPassword: entry.password !== undefined, at: entry.at })).sort((a, b) => a.origin.localeCompare(b.origin));
    await guard(); return Object.freeze({ kind: 'VAULT_LIST', status: state.kind, revision: state.record.revision, authEpoch: auth.epoch, email: state.record.email, defaultEmail, sites: Object.freeze(sites) });
  };
  async function handle(payload: DockAccountAccessPayload, site: string): Promise<DockAccountAccessReply> {
    if (!isAccountOrigin(site)) return refusal('DISABLED');
    try {
      const auth = await getContext(deps.getAuthContext); const guard = guardFor(auth, deps.getAuthContext);
      if (payload.step === 'LIST') return await list(auth, guard);
      if (payload.step === 'STATUS') {
        const enabled = await checkedRead(deps.capability, false, guard);
        const consent = await checkedRead(deps.consent, false, guard);
        const record = await readOwned(auth, guard);
        const email = await emailFor(record, site, guard);
        await guard(); return Object.freeze({ kind: 'ACCOUNT_STATUS', consent, enabled, known: known(record.sites[site]), ...issue(auth, site, record, email, 'prompt') });
      }
      if (payload.step === 'CHECK' || payload.step === 'PASSWORD_PROMPT') {
        if (payload.expectedEpoch !== auth.epoch) return refusal('AUTH_CHANGED');
        const op = deps.ops.check(payload.operationId, auth, site, payload.expectedEpoch);
        if (op === null) return refusal('OPERATION_STALE');
        if (!(await checkedRead(deps.capability, false, guard))) return refusal('DISABLED');
        if (!(await checkedRead(deps.consent, false, guard))) return refusal('CONSENT_REQUIRED');
        const record = await readOwned(auth, guard);
        const email = await emailFor(record, site, guard);
        if (siteRevision(record, site) !== op.siteRevision || email !== op.email || deps.ops.check(payload.operationId, auth, site, payload.expectedEpoch) === null) return refusal('OPERATION_STALE');
        await guard();
        if (deps.ops.check(payload.operationId, auth, site, payload.expectedEpoch) === null) return refusal('OPERATION_STALE');
        if (payload.step === 'PASSWORD_PROMPT') {
          if (op.kind !== 'credential') return refusal('OPERATION_STALE');
          const next = issue(auth, site, record, email, 'prompt'); deps.ops.consume(payload.operationId);
          return Object.freeze({ kind: 'ACCOUNT_PASSWORD_PROMPT', ...next, email });
        }
        return Object.freeze({ kind: 'ACCOUNT_CURRENT' });
      }
      if (payload.step === 'CREDENTIAL') {
        if (payload.purpose !== 'register' && payload.purpose !== 'login') return refusal('UNAVAILABLE');
        if (payload.expectedEpoch !== auth.epoch) return refusal('AUTH_CHANGED');
        const op = deps.ops.claim(payload.operationId, auth, site, payload.expectedEpoch);
        if (op === null || op.kind !== 'prompt') { if (op !== null) deps.ops.release(payload.operationId); return refusal('OPERATION_STALE'); }
        try {
          if (!(await checkedRead(deps.capability, false, guard))) { diag('ACCOUNT_ACCESS_DISABLED'); return refusal('DISABLED'); }
          if (!(await checkedRead(deps.consent, false, guard))) { diag('ACCOUNT_ACCESS_CONSENT_MISSING'); return refusal('CONSENT_REQUIRED'); }
          let record = await readOwned(auth, guard); let entry = record.sites[site];
          const email = await emailFor(record, site, guard);
          if (siteRevision(record, site) !== op.siteRevision || email !== op.email) return refusal('OPERATION_STALE');
          if (email === null) { diag('ACCOUNT_ACCESS_NO_EMAIL'); return refusal('NO_EMAIL'); }
          const manual = async (): Promise<DockAccountAccessReply> => {
            await guard(); const next = issue(auth, site, record, email, 'prompt'); deps.ops.consume(payload.operationId); return refusal('NO_PASSWORD', next);
          };
          if ((payload.purpose === 'login' && (entry?.state !== 'REGISTERED' || entry.password === undefined)) || entry?.state === 'NEEDS_PASSWORD') return await manual();
          let generated = false;
          if (entry?.password === undefined) {
            if (payload.purpose !== 'register') return await manual();
            record = await deps.vault.update((current) => {
              assertOwned(current, auth);
              if (siteRevision(current, site) !== op.siteRevision) throw new AccessError('OPERATION_STALE');
              const existing = current.sites[site];
              const password = generate(); if (!isPlausibleSitePassword(password)) throw new AccessError('UNAVAILABLE'); generated = true;
              return { ...current, owner: auth.userId, sites: { ...current.sites, [site]: { email, password, source: 'GENERATED', state: 'PENDING', at: now(), revision: (existing?.revision ?? 0) + 1 } } };
            }, guard);
            await guard(); entry = record.sites[site];
          }
          if (entry === undefined || entry.password === undefined || entry.state === 'NEEDS_PASSWORD' || (payload.purpose === 'login' && entry.state !== 'REGISTERED')) return await manual();
          if (entry.email === null) { diag('ACCOUNT_ACCESS_NO_EMAIL'); return refusal('NO_EMAIL'); }
          if (generated) diag('ACCOUNT_ACCESS_PASSWORD_GENERATED');
          await guard(); const next = issue(auth, site, record, entry.email, 'credential', payload.purpose); deps.ops.consume(payload.operationId);
          return Object.freeze({ kind: 'ACCOUNT_CREDENTIAL', email: entry.email, password: entry.password, source: entry.source, generated, known: known(entry), ...next });
        } finally { deps.ops.release(payload.operationId); }
      }
      if (payload.step === 'RECORD' || payload.step === 'SITE_PASSWORD') {
        if (payload.expectedEpoch !== auth.epoch) return refusal('AUTH_CHANGED');
        if (payload.step === 'RECORD' && !['CREATED', 'SIGNED_IN', 'EXISTS', 'VERIFICATION_REQUIRED'].includes(payload.outcome)) return refusal('OPERATION_STALE');
        const op = deps.ops.claim(payload.operationId, auth, site, payload.expectedEpoch);
        if (op === null) return refusal('OPERATION_STALE');
        try {
          if (payload.step === 'RECORD' && (op.kind !== 'credential' || ((payload.outcome === 'CREATED' || payload.outcome === 'VERIFICATION_REQUIRED') && op.purpose !== 'register') || (payload.outcome === 'SIGNED_IN' && op.purpose !== 'login'))) throw new AccessError('OPERATION_STALE');
          if (payload.step === 'SITE_PASSWORD') {
            if (op.kind !== 'prompt' || !isPlausibleSitePassword(payload.password)) throw new AccessError('OPERATION_STALE');
            if (!(await checkedRead(deps.capability, false, guard))) throw new AccessError('DISABLED');
            if (!(await checkedRead(deps.consent, false, guard))) throw new AccessError('CONSENT_REQUIRED');
          }
          const updated = await deps.vault.update((current) => {
            assertOwned(current, auth);
            if (siteRevision(current, site) !== op.siteRevision) throw new AccessError('OPERATION_STALE');
            const previous = current.sites[site];
            if (payload.step === 'SITE_PASSWORD') return { ...current, owner: auth.userId, sites: { ...current.sites, [site]: { email: op.email, password: payload.password, source: 'USER_SAVED', state: 'REGISTERED', at: now(), revision: (previous?.revision ?? 0) + 1 } } };
            if (previous === undefined || previous.password === undefined) throw new AccessError('OPERATION_STALE');
            const state = payload.outcome === 'VERIFICATION_REQUIRED' ? 'PENDING' : payload.outcome === 'EXISTS' && previous.state !== 'REGISTERED' ? 'NEEDS_PASSWORD' : 'REGISTERED';
            return { ...current, owner: auth.userId, sites: { ...current.sites, [site]: { ...previous, email: op.email, state, at: now(), revision: previous.revision + 1 } } };
          }, guard);
          await guard(); deps.ops.consume(payload.operationId);
          if (payload.step === 'RECORD') {
            diag(`ACCOUNT_ACCESS_RECORDED_${payload.outcome}`);
            if (payload.outcome === 'EXISTS' || payload.outcome === 'VERIFICATION_REQUIRED') return Object.freeze({ kind: 'ACCOUNT_PASSWORD_PROMPT', ...issue(auth, site, updated, op.email, 'prompt'), email: op.email });
          }
          if (payload.step === 'SITE_PASSWORD') {
            const enabled = await checkedRead(deps.capability, false, guard);
            const consent = await checkedRead(deps.consent, false, guard);
            await guard(); return Object.freeze({ kind: 'ACCOUNT_STATUS', enabled, consent, known: true, ...issue(auth, site, updated, op.email, 'prompt') });
          }
          return Object.freeze({ kind: 'ACCOUNT_SAVED' });
        } finally { deps.ops.release(payload.operationId); }
      }
      return refusal('UNAVAILABLE');
    } catch (error) { const code = mappedError(error); diag(code === 'OWNER_CHANGED' ? 'ACCOUNT_ACCESS_OWNER_CHANGED' : 'ACCOUNT_ACCESS_VAULT_FAILED'); return refusal(code); }
  }
  async function manage(payload: AccountVaultManagementPayload): Promise<AccountVaultManagementReply> {
    try {
      const auth = await getContext(deps.getManagementContext); const guard = guardFor(auth, deps.getManagementContext);
      if (payload.step === 'LIST') return await list(auth, guard);
      if (payload.expectedEpoch !== auth.epoch) return refusal('AUTH_CHANGED');
      const record = await readOwned(auth, guard);
      if (record.revision !== payload.expectedRevision) return refusal('REVISION_CHANGED');
      if (payload.step === 'REVEAL') {
        if (!isAccountOrigin(payload.origin)) return refusal('UNAVAILABLE');
        await guard(); return Object.freeze({ kind: 'ACCOUNT_PASSWORD', origin: payload.origin, password: record.sites[payload.origin]?.password ?? null, revision: record.revision, authEpoch: auth.epoch });
      }
      if (payload.step === 'EXPORT') {
        const rows = Object.entries(record.sites).filter((entry): entry is [string, AccountSiteRecord & { password: string }] => entry[1].password !== undefined).map(([origin, entry]) => Object.freeze({ origin, email: entry.email, password: entry.password, source: entry.source, state: entry.state, at: entry.at })).sort((a, b) => a.origin.localeCompare(b.origin));
        await guard(); return Object.freeze({ kind: 'VAULT_EXPORT', rows: Object.freeze(rows), legacyPassword: record.legacyPassword, revision: record.revision, authEpoch: auth.epoch });
      }
      return refusal('UNAVAILABLE');
    } catch (error) { return refusal(mappedError(error)); }
  }
  return Object.freeze({ handle, manage });
}
