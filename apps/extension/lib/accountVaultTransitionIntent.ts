import { createPilotUa5ConnectedPageReady } from './pilotUa5ConnectedProtocol';
import { documentPathField, readDocumentPathname } from './documentPath';

export const ACCOUNT_VAULT_TRANSITION_VERSION = 1 as const;
export type VaultTransitionAction = 'LOGOUT' | 'SWITCH_ACCOUNT';
export type VaultTransitionRefusal = 'AUTH_CHANGED' | 'EXPIRED' | 'UNAVAILABLE' | 'CLEAR_FAILED' | 'CANCELED';
export type VaultTransitionPayload =
  | Readonly<{ step: 'PREPARE_LOGOUT' }>
  | Readonly<{ step: 'PENDING' }>
  | Readonly<{ step: 'CONFIRM' | 'CANCEL'; ticket: string }>;
export type DockVaultTransitionPayload = Exclude<VaultTransitionPayload, Readonly<{ step: 'PENDING' }>>;
export type VaultTransitionReply =
  | Readonly<{ kind: 'CONFIRM_REQUIRED'; ticket: string; action: VaultTransitionAction; hasVault: boolean; canExport: boolean; expiresAt: number }>
  | Readonly<{ kind: 'TRANSITION_DONE'; action: VaultTransitionAction }>
  | Readonly<{ kind: 'TRANSITION_NONE' }>
  | Readonly<{ kind: 'REFUSED'; code: VaultTransitionRefusal }>;
export interface ExtensionVaultTransitionIntent {
  readonly kind: 'account-vault/transition';
  readonly version: 1;
  readonly payload: VaultTransitionPayload;
}
export interface DockVaultTransitionIntent {
  readonly kind: 'dock/vault-transition';
  readonly version: 1;
  readonly origin: string;
  readonly pathname: string;
  readonly documentPathname?: string;
  readonly payload: DockVaultTransitionPayload;
}
export interface DockOpenVaultIntent {
  readonly kind: 'dock/open-vault';
  readonly version: 1;
  readonly origin: string;
  readonly pathname: string;
  readonly documentPathname?: string;
  readonly selectedOrigin?: string;
}

/** Runtime messages are data. Do not execute accessors while validating them. */
function data(value: unknown): Record<string, unknown> | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string')) return null;
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch { return null; }
}
function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}
export function isVaultTransitionTicket(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return /^[A-Za-z0-9_-]{1,200}$/.exec(value)?.[0] === value;
}
export function isVaultSiteOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.origin === value && url.username === '' && url.password === '' &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  } catch { return false; }
}
function payload(value: unknown, dock: boolean): VaultTransitionPayload | null {
  const record = data(value);
  if (record === null) return null;
  if (record.step === 'PREPARE_LOGOUT' || (!dock && record.step === 'PENDING')) {
    return exact(record, ['step']) ? Object.freeze({ step: record.step }) : null;
  }
  if (record.step === 'CONFIRM' || record.step === 'CANCEL') {
    return exact(record, ['step', 'ticket']) && isVaultTransitionTicket(record.ticket)
      ? Object.freeze({ step: record.step, ticket: record.ticket }) : null;
  }
  return null;
}
export function parseExtensionVaultTransitionIntent(value: unknown): ExtensionVaultTransitionIntent | null {
  const record = data(value);
  if (record === null || !exact(record, ['kind', 'version', 'payload']) ||
      record.kind !== 'account-vault/transition' || record.version !== 1) return null;
  const parsed = payload(record.payload, false);
  return parsed === null ? null : Object.freeze({ kind: 'account-vault/transition', version: 1, payload: parsed });
}
export function parseDockVaultTransitionIntent(value: unknown): DockVaultTransitionIntent | null {
  const record = data(value);
  if (record === null || !exact(record, ['kind', 'version', 'origin', 'pathname', 'payload'], ['documentPathname']) ||
      record.kind !== 'dock/vault-transition' || record.version !== 1 ||
      typeof record.origin !== 'string' || typeof record.pathname !== 'string') return null;
  const page = createPilotUa5ConnectedPageReady(record.origin, record.pathname);
  const parsed = payload(record.payload, true);
  if (page === null || parsed === null || parsed.step === 'PENDING') return null;
  const loaded = readDocumentPathname(record, page.origin);
  if (loaded === null) return null;
  return Object.freeze({ kind: 'dock/vault-transition', version: 1, origin: page.origin, pathname: page.pathname,
    ...documentPathField(loaded, page.pathname), payload: parsed });
}
export function parseDockOpenVaultIntent(value: unknown): DockOpenVaultIntent | null {
  const record = data(value);
  if (record === null || !exact(record, ['kind', 'version', 'origin', 'pathname'], ['documentPathname', 'selectedOrigin']) ||
      record.kind !== 'dock/open-vault' || record.version !== 1 ||
      typeof record.origin !== 'string' || typeof record.pathname !== 'string' ||
      (Object.hasOwn(record, 'selectedOrigin') && !isVaultSiteOrigin(record.selectedOrigin))) return null;
  const page = createPilotUa5ConnectedPageReady(record.origin, record.pathname);
  if (page === null) return null;
  const loaded = readDocumentPathname(record, page.origin);
  if (loaded === null) return null;
  return Object.freeze({ kind: 'dock/open-vault', version: 1, origin: page.origin, pathname: page.pathname,
    ...documentPathField(loaded, page.pathname), ...(record.selectedOrigin === undefined ? {} : { selectedOrigin: record.selectedOrigin as string }) });
}
export function parseVaultTransitionReply(value: unknown): VaultTransitionReply | null {
  const record = data(value);
  if (record === null) return null;
  if (record.kind === 'TRANSITION_NONE') return exact(record, ['kind']) ? Object.freeze({ kind: record.kind }) : null;
  if (record.kind === 'REFUSED') {
    const codes: readonly string[] = ['AUTH_CHANGED', 'EXPIRED', 'UNAVAILABLE', 'CLEAR_FAILED', 'CANCELED'];
    return exact(record, ['kind', 'code']) && typeof record.code === 'string' && codes.includes(record.code)
      ? Object.freeze({ kind: record.kind, code: record.code as VaultTransitionRefusal }) : null;
  }
  const action = record.action;
  if (action !== 'LOGOUT' && action !== 'SWITCH_ACCOUNT') return null;
  if (record.kind === 'TRANSITION_DONE') return exact(record, ['kind', 'action']) ? Object.freeze({ kind: record.kind, action }) : null;
  if (record.kind === 'CONFIRM_REQUIRED' && exact(record, ['kind', 'ticket', 'action', 'hasVault', 'canExport', 'expiresAt']) &&
      isVaultTransitionTicket(record.ticket) && typeof record.hasVault === 'boolean' && typeof record.canExport === 'boolean' &&
      (!record.canExport || record.hasVault) && typeof record.expiresAt === 'number' && Number.isSafeInteger(record.expiresAt) && record.expiresAt >= 0) {
    return Object.freeze({ kind: record.kind, ticket: record.ticket, action, hasVault: record.hasVault, canExport: record.canExport, expiresAt: record.expiresAt });
  }
  return null;
}

export interface VaultManagementSender {
  readonly id?: string;
  readonly frameId?: number;
  readonly url?: string;
  readonly tab?: Readonly<{ url?: string }>;
}
/** Only the real extension page, never a caller's claimed URL or a portal. */
export function isVaultManagementSender(sender: VaultManagementSender, extensionId: string, managementUrl: string): boolean {
  try {
    if (sender.id !== extensionId || sender.frameId !== 0 || typeof sender.url !== 'string') return false;
    const expected = new URL(managementUrl);
    if (!['chrome-extension:', 'moz-extension:'].includes(expected.protocol) || expected.pathname !== '/vault.html' || expected.search !== '' || expected.hash !== '' ||
        expected.username !== '' || expected.password !== '' || (expected.protocol === 'chrome-extension:' && expected.hostname !== extensionId)) return false;
    const matches = (value: string): boolean => {
      const url = new URL(value);
      if (url.protocol !== expected.protocol || url.hostname !== expected.hostname || url.pathname !== expected.pathname ||
          url.username !== '' || url.password !== '' || url.hash !== '') return false;
      const seen = new Set<string>();
      for (const [key, value] of url.searchParams) {
        if (seen.has(key)) return false;
        seen.add(key);
        if (key === 'selectedOrigin' ? !isVaultSiteOrigin(value) : key === 'transition' ? !isVaultTransitionTicket(value) : key === 'action' ? value !== 'logout' : true) return false;
      }
      if (seen.has('action') && seen.size !== 1) return false;
      return true;
    };
    return matches(sender.url) && (sender.tab?.url === undefined || matches(sender.tab.url));
  } catch { return false; }
}
