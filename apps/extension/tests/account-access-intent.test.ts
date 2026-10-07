import { describe, expect, it } from 'vitest';
import { ACCOUNT_ACCESS_INTENT_KIND, ACCOUNT_VAULT_MANAGEMENT_KIND, ACCOUNT_VAULT_MANAGEMENT_VERSION, createDockAccountAccessIntent, parseDockAccountAccessIntent, parseDockAccountAccessReply, createAccountVaultManagementIntent, parseAccountVaultManagementIntent, parseAccountVaultManagementReply } from '../lib/accountAccessIntent';
import { PILOT_UA5_CONNECTED_PROTOCOL_VERSION } from '../lib/pilotUa5ConnectedProtocol';
const ORIGIN = 'https://careers.example.test'; const PATH = '/jobs/synthetic/apply'; const operationId = '00000000-0000-4000-8000-000000000001'; const authEpoch = 3;
const base = { kind: ACCOUNT_ACCESS_INTENT_KIND, version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION, origin: ORIGIN, pathname: PATH };
const summary = { origin: ORIGIN, email: 'candidate@example.test', source: 'GENERATED', state: 'PENDING', hasPassword: true, at: 1 } as const;
const list = { kind: 'VAULT_LIST', status: 'READABLE', revision: 2, authEpoch, email: null, defaultEmail: 'candidate@example.test', sites: [summary] } as const;
const reveal = { kind: 'ACCOUNT_PASSWORD', origin: ORIGIN, password: 'Synthetic$Password9', revision: 2, authEpoch } as const;
const exported = { kind: 'VAULT_EXPORT', rows: [{ origin: ORIGIN, email: null, source: 'LEGACY_SHARED', state: 'REGISTERED', password: 'Synthetic$Legacy9', at: 1 }], legacyPassword: 'Orphan$Legacy9', revision: 2, authEpoch } as const;

describe('page protocol exact scope and operation binding', () => {
  it.each([{ step: 'STATUS' }, { step: 'LIST' }, { step: 'CREDENTIAL', purpose: 'register', operationId, expectedEpoch: authEpoch }, { step: 'CREDENTIAL', purpose: 'login', operationId, expectedEpoch: authEpoch }, { step: 'CHECK', operationId, expectedEpoch: authEpoch }, { step: 'PASSWORD_PROMPT', operationId, expectedEpoch: authEpoch }, { step: 'RECORD', outcome: 'CREATED', operationId, expectedEpoch: authEpoch }, { step: 'RECORD', outcome: 'VERIFICATION_REQUIRED', operationId, expectedEpoch: authEpoch }, { step: 'SITE_PASSWORD', password: 'Their$Own9', operationId, expectedEpoch: authEpoch }] as const)('accepts %o', (payload) => { expect(createDockAccountAccessIntent(ORIGIN, PATH, payload)).toEqual({ ...base, payload }); });
  it.each([
    ['extra wrapper key', { ...base, payload: { step: 'STATUS' }, owner: 'forged' }],
    ['unbound credential source', { ...base, payload: { step: 'CREDENTIAL', purpose: 'register' } }],
    ['missing credential purpose', { ...base, payload: { step: 'CREDENTIAL' } }],
    ['extra credential input', { ...base, payload: { step: 'CREDENTIAL', purpose: 'register', operationId, expectedEpoch: authEpoch, email: 'a@b.test' } }],
    ['unbound outcome', { ...base, payload: { step: 'RECORD', outcome: 'CREATED' } }],
    ['unknown outcome', { ...base, payload: { step: 'RECORD', outcome: 'LOGGED_OUT', operationId, expectedEpoch: authEpoch } }],
    ['unbound manual password', { ...base, payload: { step: 'SITE_PASSWORD', password: 'Their$Own9' } }],
    ['empty password', { ...base, payload: { step: 'SITE_PASSWORD', password: '', operationId, expectedEpoch: authEpoch } }],
    ['control in password', { ...base, payload: { step: 'SITE_PASSWORD', password: 'a\nb', operationId, expectedEpoch: authEpoch } }],
    ['unsafe origin', { ...base, origin: 'http://careers.example.test', payload: { step: 'STATUS' } }],
    ['wrong version', { ...base, version: 'v0', payload: { step: 'STATUS' } }],
    ['settings from page', { ...base, payload: { step: 'SETTINGS_GET' } }],
    ['global password write', { ...base, payload: { step: 'SETTINGS_SET_PASSWORD', password: 'Synthetic$Password9' } }],
    ['global reveal', { ...base, payload: { step: 'REVEAL' } }],
    ['full export', { ...base, payload: { step: 'EXPORT', expectedRevision: 2, expectedEpoch: 3 } }],
    ['invalid epoch', { ...base, payload: { step: 'CHECK', operationId, expectedEpoch: -1 } }],
    ['oversize operation', { ...base, payload: { step: 'CHECK', operationId: 'a'.repeat(101), expectedEpoch: 3 } }],
  ])('rejects %s', (_name, value) => { expect(parseDockAccountAccessIntent(value)).toBeNull(); });
  it('retains exact document pathname binding after SPA navigation', () => { expect(parseDockAccountAccessIntent({ ...base, pathname: '/jobs/synthetic', documentPathname: PATH, payload: { step: 'STATUS' } })).toMatchObject({ pathname: '/jobs/synthetic', documentPathname: PATH }); });
  it.each([{ kind: 'ACCOUNT_STATUS', consent: true, enabled: false, known: false, operationId, authEpoch }, { kind: 'ACCOUNT_CREDENTIAL', email: 'candidate@example.test', password: 'Synthetic$Password9', source: 'GENERATED', generated: true, known: false, operationId, authEpoch }, { kind: 'ACCOUNT_CURRENT' }, { kind: 'ACCOUNT_PASSWORD_PROMPT', operationId, authEpoch, email: null }, { kind: 'ACCOUNT_SAVED' }, { kind: 'REFUSED', code: 'CONSENT_REQUIRED' }, { kind: 'REFUSED', code: 'NO_PASSWORD', operationId, authEpoch }, list])('accepts page reply %o', (reply) => { expect(parseDockAccountAccessReply(reply)).toEqual(reply); });
  it.each([reveal, exported, { kind: 'ACCOUNT_SETTINGS', email: null, defaultEmail: null, hasPassword: false, sites: 0 }, { kind: 'REFUSED', code: 'UNKNOWN' }, { kind: 'REFUSED', code: 'NO_PASSWORD', operationId }, { kind: 'ACCOUNT_CURRENT', password: 'secret' }, { kind: 'ACCOUNT_CREDENTIAL', email: 'a@b.test', password: 'p', source: 'SHARED', generated: true, known: false, operationId, authEpoch }])('rejects secret or malformed page reply %o', (reply) => { expect(parseDockAccountAccessReply(reply)).toBeNull(); });
});

describe('extension settings protocol', () => {
  it.each([{ step: 'LIST' }, { step: 'REVEAL', origin: ORIGIN, expectedRevision: 2, expectedEpoch: authEpoch }, { step: 'EXPORT', expectedRevision: 2, expectedEpoch: authEpoch }] as const)('accepts management %o', (payload) => { expect(createAccountVaultManagementIntent(payload)).toEqual({ kind: ACCOUNT_VAULT_MANAGEMENT_KIND, version: ACCOUNT_VAULT_MANAGEMENT_VERSION, payload }); });
  it.each([{ step: 'REVEAL', origin: ORIGIN }, { step: 'EXPORT', expectedRevision: 2 }, { step: 'EXPORT', expectedRevision: NaN, expectedEpoch: 3 }, { step: 'REVEAL', origin: `${ORIGIN}/jobs`, expectedRevision: 2, expectedEpoch: 3 }, { step: 'LIST', userId: 'forged' }, { step: 'SITE_PASSWORD', password: 'secret' }])('rejects incomplete or authority-bearing management %o', (payload) => { expect(parseAccountVaultManagementIntent({ kind: ACCOUNT_VAULT_MANAGEMENT_KIND, version: ACCOUNT_VAULT_MANAGEMENT_VERSION, payload })).toBeNull(); });
  it('does not confuse protocols or allow wrapper authority fields', () => { expect(parseDockAccountAccessIntent(createAccountVaultManagementIntent({ step: 'LIST' }))).toBeNull(); expect(parseAccountVaultManagementIntent({ ...createAccountVaultManagementIntent({ step: 'LIST' }), origin: ORIGIN })).toBeNull(); });
  it.each([list, reveal, exported, { ...list, status: 'EMPTY', revision: 0, sites: [] }, { ...list, status: 'KEY_MISSING', revision: null, sites: [] }, { ...list, status: 'UNREADABLE', revision: null, sites: [] }, { kind: 'REFUSED', code: 'REVISION_CHANGED' }])('accepts truthful management reply %o', (reply) => { expect(parseAccountVaultManagementReply(reply)).toEqual(reply); });
  it.each([{ ...list, status: 'KEY_MISSING', revision: 0 }, { ...list, status: 'UNREADABLE', revision: null }, { ...list, sites: [summary, summary] }, { ...list, sites: [{ ...summary, password: 'secret' }] }, { ...reveal, origin: `${ORIGIN}/jobs` }, { ...reveal, password: 'a\nb' }, { ...exported, rows: [...exported.rows, ...exported.rows] }, { ...exported, rows: [{ ...exported.rows[0], password: 1 }] }, { ...exported, owner: 'user-a' }])('rejects inconsistent or ambiguous management reply %o', (reply) => { expect(parseAccountVaultManagementReply(reply)).toBeNull(); });
  it('deep-copies and freezes management rows, preserving unknown historical email', () => { const input = structuredClone(exported); const parsed = parseAccountVaultManagementReply(input); expect(parsed?.kind).toBe('VAULT_EXPORT'); if (parsed?.kind !== 'VAULT_EXPORT') throw new Error('fixture parse unavailable'); expect(parsed.rows[0]?.email).toBeNull(); expect(parsed.rows).not.toBe(input.rows); expect(Object.isFrozen(parsed.rows[0])).toBe(true); expect(Object.isFrozen(parsed.rows)).toBe(true); });
});


it('rejects unbound derived password prompts and secret extra fields', () => {
  expect(parseDockAccountAccessIntent({ ...base, payload: { step: 'PASSWORD_PROMPT', expectedEpoch: 3 } })).toBeNull();
  expect(parseDockAccountAccessReply({ kind: 'ACCOUNT_PASSWORD_PROMPT', operationId, authEpoch, email: null, password: 'secret' })).toBeNull();
  expect(parseAccountVaultManagementReply({ kind: 'ACCOUNT_PASSWORD_PROMPT', operationId, authEpoch, email: null })).toBeNull();
});
