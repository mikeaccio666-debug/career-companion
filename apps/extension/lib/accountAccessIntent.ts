import { PILOT_UA5_CONNECTED_PROTOCOL_VERSION, createPilotUa5ConnectedPageReady } from './pilotUa5ConnectedProtocol';
import { documentPathField, keysBesidesDocumentPath, readDocumentPathname } from './documentPath';
import { isPlausibleEmail, isPlausibleSitePassword } from './accountPassword';

// Content-script messages remain site-bound. Vault management is a separate,
// extension-settings-only protocol; its secrets are never page replies.
export const ACCOUNT_ACCESS_INTENT_KIND = 'dock/account-access-intent' as const;
export const ACCOUNT_VAULT_MANAGEMENT_KIND = 'account-vault/management' as const;
export const ACCOUNT_VAULT_MANAGEMENT_VERSION = 1 as const;
export type VaultCredentialSource = 'GENERATED' | 'USER_SAVED' | 'LEGACY_SHARED' | 'LEGACY_SITE';
export type VaultSiteState = 'PENDING' | 'REGISTERED' | 'NEEDS_PASSWORD';
export interface VaultSiteSummary {
  readonly origin: string;
  readonly email: string | null;
  readonly source: VaultCredentialSource;
  readonly state: VaultSiteState;
  readonly hasPassword: boolean;
  readonly at: number;
}
export interface VaultExportRow extends Omit<VaultSiteSummary, 'hasPassword'> { readonly password: string }

export type DockAccountAccessPayload =
  | Readonly<{ step: 'STATUS' }>
  | Readonly<{ step: 'CREDENTIAL'; purpose: 'register' | 'login'; operationId: string; expectedEpoch: number }>
  | Readonly<{ step: 'CHECK'; operationId: string; expectedEpoch: number }>
  | Readonly<{ step: 'PASSWORD_PROMPT'; operationId: string; expectedEpoch: number }>
  | Readonly<{ step: 'RECORD'; outcome: 'CREATED' | 'SIGNED_IN' | 'EXISTS' | 'VERIFICATION_REQUIRED'; operationId: string; expectedEpoch: number }>
  | Readonly<{ step: 'SITE_PASSWORD'; password: string; operationId: string; expectedEpoch: number }>
  | Readonly<{ step: 'LIST' }>;
export interface DockAccountAccessIntent {
  readonly kind: typeof ACCOUNT_ACCESS_INTENT_KIND;
  readonly version: typeof PILOT_UA5_CONNECTED_PROTOCOL_VERSION;
  readonly origin: string;
  readonly pathname: string;
  readonly documentPathname?: string;
  readonly payload: DockAccountAccessPayload;
}
export type DockAccountAccessRefusal = 'CONSENT_REQUIRED' | 'DISABLED' | 'NO_EMAIL' | 'NO_PASSWORD' | 'UNAVAILABLE'
  | 'AUTH_CHANGED' | 'OWNER_CHANGED' | 'KEY_MISSING' | 'UNREADABLE' | 'REVISION_CHANGED' | 'OPERATION_STALE';
export interface AccountAccessRefused {
  readonly kind: 'REFUSED';
  readonly code: DockAccountAccessRefusal;
  readonly operationId?: string;
  readonly authEpoch?: number;
}
export interface AccountVaultListReply {
  readonly kind: 'VAULT_LIST';
  readonly status: 'EMPTY' | 'READABLE' | 'KEY_MISSING' | 'UNREADABLE';
  readonly revision: number | null;
  readonly authEpoch: number;
  readonly email: string | null;
  readonly defaultEmail: string | null;
  readonly sites: readonly VaultSiteSummary[];
}
export interface AccountVaultRevealReply {
  readonly kind: 'ACCOUNT_PASSWORD'; readonly origin: string; readonly password: string | null;
  readonly revision: number; readonly authEpoch: number;
}
export interface AccountVaultExportReply {
  readonly kind: 'VAULT_EXPORT'; readonly rows: readonly VaultExportRow[]; readonly legacyPassword: string | null;
  readonly revision: number; readonly authEpoch: number;
}
export type DockAccountAccessReply =
  | Readonly<{ kind: 'ACCOUNT_STATUS'; consent: boolean; enabled: boolean; known: boolean; operationId: string; authEpoch: number }>
  | Readonly<{ kind: 'ACCOUNT_CREDENTIAL'; email: string; password: string; source: VaultCredentialSource; generated: boolean; known: boolean; operationId: string; authEpoch: number }>
  | Readonly<{ kind: 'ACCOUNT_CURRENT' }>
  | Readonly<{ kind: 'ACCOUNT_PASSWORD_PROMPT'; operationId: string; authEpoch: number; email: string | null }>
  | Readonly<{ kind: 'ACCOUNT_SAVED' }>
  | AccountVaultListReply | AccountAccessRefused;
export type AccountVaultManagementPayload =
  | Readonly<{ step: 'LIST' }>
  | Readonly<{ step: 'REVEAL'; origin: string; expectedRevision: number; expectedEpoch: number }>
  | Readonly<{ step: 'EXPORT'; expectedRevision: number; expectedEpoch: number }>;
export interface AccountVaultManagementIntent {
  readonly kind: typeof ACCOUNT_VAULT_MANAGEMENT_KIND;
  readonly version: typeof ACCOUNT_VAULT_MANAGEMENT_VERSION;
  readonly payload: AccountVaultManagementPayload;
}
export type AccountVaultManagementReply = AccountVaultListReply | AccountVaultRevealReply | AccountVaultExportReply | AccountAccessRefused;

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const own = Object.keys(value); return own.length === expected.length && expected.every((key) => own.includes(key));
}
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function operation(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9-]{16,100}$/u.test(value); }
function email(value: unknown): value is string | null { return value === null || (typeof value === 'string' && isPlausibleEmail(value)); }
function password(value: unknown): value is string | null { return value === null || (typeof value === 'string' && isPlausibleSitePassword(value)); }
export function isAccountOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try { const url = new URL(value); return url.origin === value && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))); }
  catch { return false; }
}
const SOURCES: ReadonlySet<string> = new Set(['GENERATED', 'USER_SAVED', 'LEGACY_SHARED', 'LEGACY_SITE']);
const STATES: ReadonlySet<string> = new Set(['PENDING', 'REGISTERED', 'NEEDS_PASSWORD']);
const REFUSALS: ReadonlySet<string> = new Set(['CONSENT_REQUIRED', 'DISABLED', 'NO_EMAIL', 'NO_PASSWORD', 'UNAVAILABLE', 'AUTH_CHANGED', 'OWNER_CHANGED', 'KEY_MISSING', 'UNREADABLE', 'REVISION_CHANGED', 'OPERATION_STALE']);
function parsePayload(value: unknown): DockAccountAccessPayload | null {
  if (!record(value)) return null;
  const step = value['step'];
  if ((step === 'STATUS' || step === 'LIST') && keys(value, ['step'])) return Object.freeze({ step });
  if (step === 'CREDENTIAL' && keys(value, ['step', 'purpose', 'operationId', 'expectedEpoch']) && (value['purpose'] === 'register' || value['purpose'] === 'login') && operation(value['operationId']) && integer(value['expectedEpoch'])) return Object.freeze({ step, purpose: value['purpose'], operationId: value['operationId'], expectedEpoch: value['expectedEpoch'] });
  if ((step === 'CHECK' || step === 'PASSWORD_PROMPT') && keys(value, ['step', 'operationId', 'expectedEpoch']) && operation(value['operationId']) && integer(value['expectedEpoch'])) return Object.freeze({ step, operationId: value['operationId'], expectedEpoch: value['expectedEpoch'] });
  if (step === 'RECORD' && keys(value, ['step', 'outcome', 'operationId', 'expectedEpoch']) && operation(value['operationId']) && integer(value['expectedEpoch'])) {
    const outcome = value['outcome'];
    if (outcome === 'CREATED' || outcome === 'SIGNED_IN' || outcome === 'EXISTS' || outcome === 'VERIFICATION_REQUIRED') return Object.freeze({ step, outcome, operationId: value['operationId'], expectedEpoch: value['expectedEpoch'] });
  }
  if (step === 'SITE_PASSWORD' && keys(value, ['step', 'password', 'operationId', 'expectedEpoch']) && typeof value['password'] === 'string' && isPlausibleSitePassword(value['password']) && operation(value['operationId']) && integer(value['expectedEpoch'])) return Object.freeze({ step, password: value['password'], operationId: value['operationId'], expectedEpoch: value['expectedEpoch'] });
  return null;
}
export function parseDockAccountAccessIntent(value: unknown): DockAccountAccessIntent | null {
  if (!record(value)) return null;
  const own = keysBesidesDocumentPath(value);
  const expected = ['kind', 'version', 'origin', 'pathname', 'payload'];
  if (own.length !== expected.length || !expected.every((key) => own.includes(key))) return null;
  if (value['kind'] !== ACCOUNT_ACCESS_INTENT_KIND || value['version'] !== PILOT_UA5_CONNECTED_PROTOCOL_VERSION || typeof value['origin'] !== 'string' || typeof value['pathname'] !== 'string') return null;
  const payload = parsePayload(value['payload']);
  const ready = createPilotUa5ConnectedPageReady(value['origin'], value['pathname']);
  if (payload === null || ready === null) return null;
  const loaded = readDocumentPathname(value, ready.origin);
  return loaded === null ? null : Object.freeze({ kind: ACCOUNT_ACCESS_INTENT_KIND, version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION, origin: ready.origin, pathname: ready.pathname, ...documentPathField(loaded, ready.pathname), payload });
}
export function createDockAccountAccessIntent(origin: string, pathname: string, payload: DockAccountAccessPayload): DockAccountAccessIntent | null {
  return parseDockAccountAccessIntent({ kind: ACCOUNT_ACCESS_INTENT_KIND, version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION, origin, pathname, payload });
}
export function parseAccountVaultManagementIntent(value: unknown): AccountVaultManagementIntent | null {
  if (!record(value) || !keys(value, ['kind', 'version', 'payload']) || value['kind'] !== ACCOUNT_VAULT_MANAGEMENT_KIND || value['version'] !== ACCOUNT_VAULT_MANAGEMENT_VERSION || !record(value['payload'])) return null;
  const p = value['payload']; let payload: AccountVaultManagementPayload;
  if (p['step'] === 'LIST' && keys(p, ['step'])) payload = { step: 'LIST' };
  else if (p['step'] === 'REVEAL' && keys(p, ['step', 'origin', 'expectedRevision', 'expectedEpoch']) && isAccountOrigin(p['origin']) && integer(p['expectedRevision']) && integer(p['expectedEpoch'])) payload = { step: 'REVEAL', origin: p['origin'], expectedRevision: p['expectedRevision'], expectedEpoch: p['expectedEpoch'] };
  else if (p['step'] === 'EXPORT' && keys(p, ['step', 'expectedRevision', 'expectedEpoch']) && integer(p['expectedRevision']) && integer(p['expectedEpoch'])) payload = { step: 'EXPORT', expectedRevision: p['expectedRevision'], expectedEpoch: p['expectedEpoch'] };
  else return null;
  return Object.freeze({ kind: ACCOUNT_VAULT_MANAGEMENT_KIND, version: ACCOUNT_VAULT_MANAGEMENT_VERSION, payload: Object.freeze(payload) });
}
export function createAccountVaultManagementIntent(payload: AccountVaultManagementPayload): AccountVaultManagementIntent | null {
  return parseAccountVaultManagementIntent({ kind: ACCOUNT_VAULT_MANAGEMENT_KIND, version: ACCOUNT_VAULT_MANAGEMENT_VERSION, payload });
}
function refusal(v: Record<string, unknown>): AccountAccessRefused | null {
  if (typeof v['code'] !== 'string' || !REFUSALS.has(v['code'])) return null;
  if (keys(v, ['kind', 'code'])) return Object.freeze({ kind: 'REFUSED', code: v['code'] as DockAccountAccessRefusal });
  if (keys(v, ['kind', 'code', 'operationId', 'authEpoch']) && operation(v['operationId']) && integer(v['authEpoch'])) return Object.freeze({ kind: 'REFUSED', code: v['code'] as DockAccountAccessRefusal, operationId: v['operationId'], authEpoch: v['authEpoch'] });
  return null;
}
function summary(v: unknown): VaultSiteSummary | null {
  if (!record(v) || !keys(v, ['origin', 'email', 'source', 'state', 'hasPassword', 'at']) || !isAccountOrigin(v['origin']) || !email(v['email']) || typeof v['source'] !== 'string' || !SOURCES.has(v['source']) || typeof v['state'] !== 'string' || !STATES.has(v['state']) || typeof v['hasPassword'] !== 'boolean' || !integer(v['at'])) return null;
  return Object.freeze({ origin: v['origin'], email: v['email'], source: v['source'] as VaultCredentialSource, state: v['state'] as VaultSiteState, hasPassword: v['hasPassword'], at: v['at'] });
}
function list(v: Record<string, unknown>): AccountVaultListReply | null {
  if (!keys(v, ['kind', 'status', 'revision', 'authEpoch', 'email', 'defaultEmail', 'sites']) || !integer(v['authEpoch']) || !email(v['email']) || !email(v['defaultEmail']) || !Array.isArray(v['sites'])) return null;
  const status = v['status']; if (status !== 'EMPTY' && status !== 'READABLE' && status !== 'KEY_MISSING' && status !== 'UNREADABLE') return null;
  const readable = status === 'EMPTY' || status === 'READABLE';
  if (readable ? !integer(v['revision']) : (v['revision'] !== null || v['sites'].length !== 0 || v['email'] !== null)) return null;
  if (status === 'EMPTY' && v['sites'].length !== 0) return null;
  const sites = v['sites'].map(summary);
  if (sites.some((site) => site === null) || new Set(sites.map((site) => site?.origin)).size !== sites.length) return null;
  return Object.freeze({ kind: 'VAULT_LIST', status, revision: v['revision'] as number | null, authEpoch: v['authEpoch'], email: v['email'], defaultEmail: v['defaultEmail'], sites: Object.freeze(sites as VaultSiteSummary[]) });
}
export function parseDockAccountAccessReply(value: unknown): DockAccountAccessReply | null {
  if (!record(value)) return null;
  switch (value['kind']) {
    case 'REFUSED': return refusal(value);
    case 'VAULT_LIST': return list(value);
    case 'ACCOUNT_PASSWORD_PROMPT': return keys(value, ['kind', 'operationId', 'authEpoch', 'email']) && operation(value['operationId']) && integer(value['authEpoch']) && email(value['email']) ? Object.freeze({ kind: 'ACCOUNT_PASSWORD_PROMPT', operationId: value['operationId'], authEpoch: value['authEpoch'], email: value['email'] }) : null;
    case 'ACCOUNT_CURRENT': return keys(value, ['kind']) ? Object.freeze({ kind: 'ACCOUNT_CURRENT' }) : null;
    case 'ACCOUNT_SAVED': return keys(value, ['kind']) ? Object.freeze({ kind: 'ACCOUNT_SAVED' }) : null;
    case 'ACCOUNT_STATUS': return keys(value, ['kind', 'consent', 'enabled', 'known', 'operationId', 'authEpoch']) && typeof value['consent'] === 'boolean' && typeof value['enabled'] === 'boolean' && typeof value['known'] === 'boolean' && operation(value['operationId']) && integer(value['authEpoch']) ? Object.freeze({ kind: 'ACCOUNT_STATUS', consent: value['consent'], enabled: value['enabled'], known: value['known'], operationId: value['operationId'], authEpoch: value['authEpoch'] }) : null;
    case 'ACCOUNT_CREDENTIAL': return keys(value, ['kind', 'email', 'password', 'source', 'generated', 'known', 'operationId', 'authEpoch']) && typeof value['email'] === 'string' && isPlausibleEmail(value['email']) && typeof value['password'] === 'string' && isPlausibleSitePassword(value['password']) && typeof value['source'] === 'string' && SOURCES.has(value['source']) && typeof value['generated'] === 'boolean' && typeof value['known'] === 'boolean' && operation(value['operationId']) && integer(value['authEpoch']) ? Object.freeze({ kind: 'ACCOUNT_CREDENTIAL', email: value['email'], password: value['password'], source: value['source'] as VaultCredentialSource, generated: value['generated'], known: value['known'], operationId: value['operationId'], authEpoch: value['authEpoch'] }) : null;
    default: return null;
  }
}
export function parseAccountVaultManagementReply(value: unknown): AccountVaultManagementReply | null {
  if (!record(value)) return null;
  if (value['kind'] === 'REFUSED') return refusal(value);
  if (value['kind'] === 'VAULT_LIST') return list(value);
  if (value['kind'] === 'ACCOUNT_PASSWORD' && keys(value, ['kind', 'origin', 'password', 'revision', 'authEpoch']) && isAccountOrigin(value['origin']) && password(value['password']) && integer(value['revision']) && integer(value['authEpoch'])) return Object.freeze({ kind: 'ACCOUNT_PASSWORD', origin: value['origin'], password: value['password'], revision: value['revision'], authEpoch: value['authEpoch'] });
  if (value['kind'] === 'VAULT_EXPORT' && keys(value, ['kind', 'rows', 'legacyPassword', 'revision', 'authEpoch']) && Array.isArray(value['rows']) && password(value['legacyPassword']) && integer(value['revision']) && integer(value['authEpoch'])) {
    const rows: VaultExportRow[] = [];
    for (const row of value['rows']) {
      if (!record(row) || !keys(row, ['origin', 'email', 'password', 'source', 'state', 'at']) || typeof row['password'] !== 'string' || !isPlausibleSitePassword(row['password'])) return null;
      const site = summary({ origin: row['origin'], email: row['email'], source: row['source'], state: row['state'], at: row['at'], hasPassword: true });
      if (site === null) return null;
      rows.push(Object.freeze({ origin: site.origin, email: site.email, password: row['password'], source: site.source, state: site.state, at: site.at }));
    }
    if (new Set(rows.map((row) => row.origin)).size !== rows.length) return null;
    return Object.freeze({ kind: 'VAULT_EXPORT', rows: Object.freeze(rows), legacyPassword: value['legacyPassword'], revision: value['revision'], authEpoch: value['authEpoch'] });
  }
  return null;
}
