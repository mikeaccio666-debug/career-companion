import { describe, expect, it } from 'vitest';
import {
  isVaultManagementSender, isVaultSiteOrigin, isVaultTransitionTicket,
  parseDockOpenVaultIntent, parseDockVaultTransitionIntent, parseExtensionVaultTransitionIntent, parseVaultTransitionReply,
} from '../lib/accountVaultTransitionIntent';

const page = { version: 1, origin: 'https://jobs.example.test', pathname: '/apply' };
const managementUrl = 'chrome-extension://extension-id/vault.html';
const sender = { id: 'extension-id', frameId: 0, url: managementUrl, tab: { url: managementUrl } };

describe('local vault transition data protocol', () => {
  it('accepts only explicit version-one steps and binds the dock document path', () => {
    for (const payload of [{ step: 'PREPARE_LOGOUT' }, { step: 'PENDING' }, { step: 'CONFIRM', ticket: 'opaque_ticket' }, { step: 'CANCEL', ticket: 'opaque_ticket' }]) {
      const extension = { kind: 'account-vault/transition', version: 1, payload };
      expect(parseExtensionVaultTransitionIntent(extension)).toEqual(extension);
      const dock = { kind: 'dock/vault-transition', ...page, documentPathname: '/loaded', payload };
      expect(parseDockVaultTransitionIntent(dock)).toEqual(payload.step === 'PENDING' ? null : dock);
    }
    expect(parseDockVaultTransitionIntent({ kind: 'dock/vault-transition', ...page, documentPathname: '/apply', payload: { step: 'PREPARE_LOGOUT' } }))
      .toEqual({ kind: 'dock/vault-transition', ...page, payload: { step: 'PREPARE_LOGOUT' } });
  });

  it.each([
    { kind: 'account-vault/transition', version: 2, payload: { step: 'PREPARE_LOGOUT' } },
    { kind: 'account-vault/transition', version: 1, owner: 'caller-owner', payload: { step: 'PREPARE_LOGOUT' } },
    { kind: 'account-vault/transition', version: 1, payload: { step: 'CONFIRM', ticket: 'opaque_ticket', confirmed: true } },
    { kind: 'account-vault/transition', version: 1, payload: { step: 'CONFIRM' } },
    { kind: 'account-vault/transition', version: 1, payload: { step: 'CANCEL', ticket: '' } },
    { kind: 'account-vault/transition', version: 1, payload: { step: 'DELETE' } },
    null, [],
  ])('rejects malformed or caller-expanded transition input: %j', (input) => {
    expect(parseExtensionVaultTransitionIntent(input)).toBeNull();
  });

  it('does not execute accessors while parsing untrusted message data', () => {
    let calls = 0;
    const input = { get kind() { calls++; throw new Error('untrusted accessor'); }, version: 1, payload: { step: 'PENDING' } };
    expect(parseExtensionVaultTransitionIntent(input)).toBeNull();
    expect(parseVaultTransitionReply({ kind: 'REFUSED', get code() { calls++; return 'UNAVAILABLE'; } })).toBeNull();
    expect(calls).toBe(0);
  });

  it('opens only a value-free canonical selected-site request', () => {
    const input = { kind: 'dock/open-vault', ...page, selectedOrigin: 'https://account.example.test' };
    expect(parseDockOpenVaultIntent(input)).toEqual(input);
    expect(parseDockOpenVaultIntent({ ...input, password: 'not-allowed' })).toBeNull();
    expect(parseDockOpenVaultIntent({ ...input, selectedOrigin: 'https://account.example.test/login' })).toBeNull();
    expect(parseDockOpenVaultIntent({ ...input, selectedOrigin: undefined })).toBeNull();
    expect(parseDockOpenVaultIntent({ ...input, documentPathname: 'https://different.example.test/' })).toBeNull();
  });

  it('roundtrips safe summaries without a credential, owner or candidate token pair', () => {
    const messages = [
      { kind: 'CONFIRM_REQUIRED', ticket: 'opaque_ticket', action: 'SWITCH_ACCOUNT', hasVault: true, canExport: true, expiresAt: 120000 },
      { kind: 'TRANSITION_DONE', action: 'LOGOUT' }, { kind: 'TRANSITION_NONE' },
      ...['AUTH_CHANGED', 'EXPIRED', 'UNAVAILABLE', 'CLEAR_FAILED', 'CANCELED'].map(code => ({ kind: 'REFUSED', code })),
    ];
    for (const reply of messages) expect(parseVaultTransitionReply(JSON.parse(JSON.stringify(reply)))).toEqual(reply);
    expect(parseVaultTransitionReply({ ...messages[0], password: 'not-allowed' })).toBeNull();
    expect(parseVaultTransitionReply({ ...messages[0], hasVault: false })).toBeNull();
    expect(parseVaultTransitionReply({ ...messages[0], expiresAt: Infinity })).toBeNull();
    expect(parseVaultTransitionReply({ kind: 'REFUSED', code: 'vendor_stack_trace' })).toBeNull();
  });

  it.each(['\n', '\r', '\r\n', '\u2028', '\u2029'])('rejects ticket and origin trailing terminator %j', (ending) => {
    expect(isVaultTransitionTicket(`opaque_ticket${ending}`)).toBe(false);
    expect(isVaultSiteOrigin(`https://account.example.test${ending}`)).toBe(false);
  });

  it('checks the real extension sender, top frame, fixed page and non-embedded tab', () => {
    expect(isVaultManagementSender(sender, 'extension-id', managementUrl)).toBe(true);
    expect(isVaultManagementSender({ ...sender, url: `${managementUrl}?selectedOrigin=https%3A%2F%2Fjobs.example.test&transition=opaque_ticket` }, 'extension-id', managementUrl)).toBe(true);
    expect(isVaultManagementSender({ ...sender, url: `${managementUrl}?action=logout` }, 'extension-id', managementUrl)).toBe(true);
    for (const patch of [{ id: 'foreign-extension' }, { frameId: 1 }, { frameId: undefined },
      { url: 'https://portal.example.test/vault.html' }, { url: 'chrome-extension://foreign-extension/vault.html' },
      { url: 'chrome-extension://extension-id/other.html' }, { tab: { url: 'https://ats.example.test/apply' } }]) {
      expect(isVaultManagementSender({ ...sender, ...patch }, 'extension-id', managementUrl)).toBe(false);
    }
    expect(isVaultManagementSender(sender, 'extension-id', 'chrome-extension://foreign-extension/vault.html')).toBe(false);
  });

  it.each(['?unknown=value', '?transition=a&transition=b', '?selectedOrigin=https%3A%2F%2Fjobs.example.test%2Fpath',
    '?action=login', '?action=logout&transition=opaque_ticket', '?action=logout&selectedOrigin=https%3A%2F%2Fjobs.example.test',
    '?transition=opaque_ticket%0A', '#embedded'])('rejects expanded management URL %s', suffix => {
    expect(isVaultManagementSender({ ...sender, url: managementUrl + suffix }, 'extension-id', managementUrl)).toBe(false);
  });
});
