import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  parseAuthServerRegisterRequest,
  parseAuthServerRefreshRequest,
  parseExtensionTokenPair,
  parseLogoutAuthSessionResponse,
  parseAttestExtensionInstallResponse,
  parseExchangeRegistrationInvitationRequest,
  parseExchangeRegistrationInvitationResponse,
  parseListAdminWaitlistResponse,
  parseRegistrationContextResponse,
  parseExtensionConnectionStatusRequest,
  parseExtensionConnectionStatusResponse,
  parseRegisterAuthRequest,
  parseUuid,
  parseWaitlistRequest,
} from '../src/index.ts';
import type {
  AuthServerRegisterRequest,
  AuthServerRefreshRequest,
  AuthServerTokenPair,
  AttestExtensionInstallRequest,
  AttestExtensionInstallResponse,
  ChatAccessSession,
  BearerSubjectOwnerContext,
  ExtensionConnectionStatusRequest,
  ExtensionConnectionStatusResponse,
  ExtensionTokenPair,
  GetAuthCsrfResponse,
  IntrospectAuthSessionRequest,
  IntrospectAuthSessionResponse,
  RegisterAuthRequest,
  RevokeAuthSessionRequest,
  RevokeAuthSessionResponse,
  WaitlistRequest,
} from '../src/index.ts';
import type { AuthSessionEndpointContractMap } from '../src/http.ts';

const OWNER_ID = parseUuid('10000000-0000-4000-8000-000000000001')!;
const OTHER_OWNER_ID = parseUuid('10000000-0000-4000-8000-000000000002')!;
const INSTALL_ID = parseUuid('20000000-0000-4000-8000-000000000001')!;
const CORRELATION_ID = parseUuid('30000000-0000-4000-8000-000000000001')!;
const OTHER_CORRELATION_ID = parseUuid('30000000-0000-4000-8000-000000000002')!;
const EXTENSION_ID = 'a'.repeat(32);

describe('Chat session and private Auth contract types', () => {
  it('keeps Extension credential bodies and responses exact and separate from browser BFF bodies', () => {
    const refreshToken = 'r'.repeat(64);
    expect(parseAuthServerRefreshRequest({ refreshToken })).toEqual({ refreshToken });
    for (const value of [null, {}, { refreshToken, userId: OWNER_ID }, { refreshToken: '' }, { refreshToken: 'x\n'.repeat(32) }]) {
      expect(parseAuthServerRefreshRequest(value)).toBeNull();
    }
    const pair = { accessToken: 'a'.repeat(64), refreshToken, user: { id: OWNER_ID, email: 'fixture@example.invalid', role: 'STUDENT' } };
    expect(parseExtensionTokenPair(pair)).toEqual(pair);
    expect(parseExtensionTokenPair({ ...pair, extra: true })).toBeNull();
    expect(parseExtensionTokenPair({ ...pair, user: { ...pair.user, password: 'not-allowed' } })).toBeNull();
    expect(parseLogoutAuthSessionResponse({ ok: true })).toEqual({ ok: true });
    expect(parseLogoutAuthSessionResponse({ ok: true, userId: OWNER_ID })).toBeNull();
  });

  it('keeps browser session JSON separate from both raw refresh-token shapes', () => {
    expectTypeOf<ChatAccessSession>().toEqualTypeOf<{
      readonly accessToken: string;
      readonly user: {
        readonly id: import('../src/common.ts').Uuid;
        readonly email: string;
        readonly role: 'STUDENT' | 'STAFF' | 'PROJECT_ADMIN' | 'ADMIN' | 'REFERRAL_MENTOR';
      };
    }>();
    expectTypeOf<ExtensionTokenPair>().toEqualTypeOf<AuthServerTokenPair>();
    expectTypeOf<ExtensionTokenPair>().not.toEqualTypeOf<ChatAccessSession>();
  });

  it('pins empty browser refresh/logout bodies and private exact request bodies', () => {
    expectTypeOf<AuthSessionEndpointContractMap['refresh']['body']>().toEqualTypeOf<never>();
    expectTypeOf<AuthSessionEndpointContractMap['logout']['body']>().toEqualTypeOf<never>();
    expectTypeOf<AuthServerRefreshRequest>().toEqualTypeOf<{ readonly refreshToken: string }>();
    expectTypeOf<IntrospectAuthSessionRequest>().toEqualTypeOf<{ readonly refreshToken: string }>();
    expectTypeOf<RevokeAuthSessionRequest>().toEqualTypeOf<{ readonly refreshToken: string }>();
  });

  it('keeps invited email authority out of the browser register body', () => {
    expectTypeOf<RegisterAuthRequest>().toEqualTypeOf<{
      readonly password: string;
      readonly fullName?: string;
      readonly anonId?: import('../src/common.ts').Uuid;
      readonly acquisition?: import('../src/auth.ts').AuthAcquisition;
    }>();
    expectTypeOf<AuthServerRegisterRequest>().toEqualTypeOf<{
      readonly password: string;
      readonly fullName?: string;
      readonly anonId?: import('../src/common.ts').Uuid;
      readonly acquisition?: import('../src/auth.ts').AuthAcquisition;
      readonly registrationSession: string;
    }>();
  });

  it('pins the public waitlist request without marketing consent', () => {
    expectTypeOf<WaitlistRequest>().toEqualTypeOf<{
      readonly fullName: string;
      readonly email: string;
      readonly targetRole?: string;
      readonly targetCompany?: string;
      readonly moreAboutYou?: string;
      readonly locale: 'en' | 'zh-cn';
      readonly website?: string;
      readonly challengeProof?: string;
    }>();
  });

  it.each([
    ['email override', { email: 'other@example.com', password: 'long-enough-password' }],
    ['registration session override', { password: 'long-enough-password', registrationSession: 'secret' }],
    ['extra key', { password: 'long-enough-password', extra: true }],
  ])('rejects a browser register body with %s', (_label, value) => {
    expect(parseRegisterAuthRequest(value)).toBeNull();
  });

  it('accepts the exact browser body and exact server-only restricted session body', () => {
    expect(parseRegisterAuthRequest({ password: 'long-enough-password', fullName: 'Ada' }))
      .toEqual({ password: 'long-enough-password', fullName: 'Ada' });
    expect(parseAuthServerRegisterRequest({
      password: 'long-enough-password',
      fullName: 'Ada',
      registrationSession: 'opaque-registration-session',
    })).toEqual({
      password: 'long-enough-password',
      fullName: 'Ada',
      registrationSession: 'opaque-registration-session',
    });
  });

  it('strictly parses waitlist and invitation exchange inputs', () => {
    expect(parseWaitlistRequest({ email: 'member@example.com', fullName: 'Ada Lovelace', locale: 'en' }))
      .toEqual({ email: 'member@example.com', fullName: 'Ada Lovelace', locale: 'en' });
    expect(parseWaitlistRequest({ email: 'member@example.com', fullName: 'Ada', locale: 'fr' })).toBeNull();
    expect(parseWaitlistRequest({ email: 'member@example.com', fullName: 'Ada', locale: 'en', consent: true }))
      .toBeNull();
    expect(parseExchangeRegistrationInvitationRequest({ token: 'opaque-token' }))
      .toEqual({ token: 'opaque-token' });
    expect(parseExchangeRegistrationInvitationRequest({ token: 'opaque-token', email: 'x@y.test' }))
      .toBeNull();
  });

  it('strictly parses invitation/session/admin response projections', () => {
    expect(parseExchangeRegistrationInvitationResponse({
      registrationSession: 'opaque-registration-session',
      expiresAt: '2026-09-01T12:15:00.000Z',
    })).toEqual({
      registrationSession: 'opaque-registration-session',
      expiresAt: '2026-09-01T12:15:00.000Z',
    });
    expect(parseExchangeRegistrationInvitationResponse({
      registrationSession: 'opaque-registration-session',
      expiresAt: '2026-09-01T12:15:00.000Z',
      email: 'not-allowed@example.com',
    })).toBeNull();
    expect(parseRegistrationContextResponse({
      email: 'member@example.com',
      expiresAt: '2026-09-01T12:15:00.000Z',
    })).not.toBeNull();
    expect(parseListAdminWaitlistResponse({
      entries: [{
        id: OWNER_ID,
        fullName: 'Ada Lovelace',
        email: 'member@example.com',
        locale: 'en',
        status: 'PENDING',
        createdAt: '2026-09-01T12:00:00.000Z',
      }],
    })?.entries).toHaveLength(1);
    expect(parseListAdminWaitlistResponse({
      entries: [{
        id: OWNER_ID,
        fullName: 'Ada Lovelace',
        email: 'member@example.com',
        locale: 'en',
        status: 'PENDING',
        createdAt: 'not-a-date',
      }],
    })).toBeNull();
  });

  it('pins the backend-private bearer owner context without adding secret material', () => {
    expectTypeOf<BearerSubjectOwnerContext>().toEqualTypeOf<{
      readonly sub: import('../src/common.ts').Uuid;
      readonly sid: import('../src/common.ts').Uuid;
      readonly jti: string;
    }>();
  });

  it('pins the CSRF, introspection, and revoke success projections', () => {
    expectTypeOf<GetAuthCsrfResponse>().toEqualTypeOf<{ readonly ok: true }>();
    expectTypeOf<IntrospectAuthSessionResponse>().toMatchTypeOf<{
      readonly schemaVersion: 1;
      readonly session: {
        readonly authenticated: true;
        readonly user: { readonly emailVerified: true };
      };
      readonly refreshExpiresAt: string;
    }>();
    expectTypeOf<RevokeAuthSessionResponse>().toEqualTypeOf<{ readonly ok: true }>();
  });

  it('pins the correlated fail-closed Portal to Extension connection attestation wire', () => {
    expectTypeOf<AttestExtensionInstallRequest>().toEqualTypeOf<{
      readonly installId: import('../src/common.ts').Uuid;
    }>();
    expectTypeOf<AttestExtensionInstallResponse>().toEqualTypeOf<
      | {
        readonly connected: true;
        readonly installId: import('../src/common.ts').Uuid;
        readonly userId: import('../src/common.ts').Uuid;
      }
      | { readonly connected: false }
    >();
    expectTypeOf<ExtensionConnectionStatusRequest>().toEqualTypeOf<{
      readonly kind: 'auth/connection-status';
      readonly expectedOwnerId: import('../src/common.ts').Uuid;
      readonly correlationId: import('../src/common.ts').Uuid;
    }>();
    expectTypeOf<ExtensionConnectionStatusResponse>().toEqualTypeOf<
      | {
        readonly ok: true;
        readonly protocolVersion: 1;
        readonly extensionId: string;
        readonly userId: import('../src/common.ts').Uuid;
        readonly installId: import('../src/common.ts').Uuid;
        readonly correlationId: import('../src/common.ts').Uuid;
        readonly capabilities: readonly ['DISCOVERY_READ_ONLY'];
      }
      | { readonly ok: false }
    >();
  });

  it.each([
    ['missing owner', { kind: 'auth/connection-status', correlationId: CORRELATION_ID }],
    ['missing correlation', { kind: 'auth/connection-status', expectedOwnerId: OWNER_ID }],
    ['extra key', { kind: 'auth/connection-status', expectedOwnerId: OWNER_ID, correlationId: CORRELATION_ID, extra: true }],
    ['wrong owner type', { kind: 'auth/connection-status', expectedOwnerId: 42, correlationId: CORRELATION_ID }],
    ['malformed owner', { kind: 'auth/connection-status', expectedOwnerId: 'not-a-uuid', correlationId: CORRELATION_ID }],
    ['malformed correlation', { kind: 'auth/connection-status', expectedOwnerId: OWNER_ID, correlationId: 'not-a-uuid' }],
    ['wrong kind', { kind: 'auth/connection', expectedOwnerId: OWNER_ID, correlationId: CORRELATION_ID }],
  ])('strictly rejects a %s connection-status request', (_label, value) => {
    expect(parseExtensionConnectionStatusRequest(value)).toBeNull();
  });

  it('parses only the exact correlated connection-status request', () => {
    expect(parseExtensionConnectionStatusRequest({
      kind: 'auth/connection-status',
      expectedOwnerId: OWNER_ID,
      correlationId: CORRELATION_ID,
    })).toEqual({
      kind: 'auth/connection-status',
      expectedOwnerId: OWNER_ID,
      correlationId: CORRELATION_ID,
    });
  });

  it.each([
    ['extra key', { extra: true }],
    ['wrong ok type', { ok: 'true' }],
    ['wrong owner', { userId: OTHER_OWNER_ID }],
    ['wrong protocol', { protocolVersion: 2 }],
    ['wrong extension', { extensionId: 'b'.repeat(32) }],
    ['wrong correlation', { correlationId: OTHER_CORRELATION_ID }],
    ['wrong install type', { installId: 42 }],
    ['missing capability', { capabilities: [] }],
    ['extra capability', { capabilities: ['DISCOVERY_READ_ONLY', 'WRITE'] }],
  ])('strictly rejects a connection ACK with %s', (_label, override) => {
    expect(parseExtensionConnectionStatusResponse({
      ok: true,
      protocolVersion: 1,
      extensionId: EXTENSION_ID,
      userId: OWNER_ID,
      installId: INSTALL_ID,
      correlationId: CORRELATION_ID,
      capabilities: ['DISCOVERY_READ_ONLY'],
      ...override,
    }, {
      extensionId: EXTENSION_ID,
      expectedOwnerId: OWNER_ID,
      correlationId: CORRELATION_ID,
    })).toBeNull();
  });

  it('rejects a same-owner positive ACK replayed into a different correlation', () => {
    const replay = {
      ok: true,
      protocolVersion: 1,
      extensionId: EXTENSION_ID,
      userId: OWNER_ID,
      installId: INSTALL_ID,
      correlationId: CORRELATION_ID,
      capabilities: ['DISCOVERY_READ_ONLY'],
    };
    expect(parseExtensionConnectionStatusResponse(replay, {
      extensionId: EXTENSION_ID,
      expectedOwnerId: OWNER_ID,
      correlationId: OTHER_CORRELATION_ID,
    })).toBeNull();
  });

  it('parses only exact positive and exact closed connection ACKs', () => {
    const success = {
      ok: true,
      protocolVersion: 1,
      extensionId: EXTENSION_ID,
      userId: OWNER_ID,
      installId: INSTALL_ID,
      correlationId: CORRELATION_ID,
      capabilities: ['DISCOVERY_READ_ONLY'],
    };
    const expectation = {
      extensionId: EXTENSION_ID,
      expectedOwnerId: OWNER_ID,
      correlationId: CORRELATION_ID,
    };
    expect(parseExtensionConnectionStatusResponse(success, expectation)).toEqual(success);
    expect(parseExtensionConnectionStatusResponse({ ok: false }, expectation)).toEqual({ ok: false });
    expect(parseExtensionConnectionStatusResponse({ ok: false, correlationId: CORRELATION_ID }, expectation))
      .toBeNull();
  });

  it.each([
    ['missing key', { connected: true, installId: INSTALL_ID }],
    ['extra key', { connected: true, installId: INSTALL_ID, userId: OWNER_ID, extra: true }],
    ['wrong connected type', { connected: 'true', installId: INSTALL_ID, userId: OWNER_ID }],
    ['wrong install type', { connected: true, installId: 42, userId: OWNER_ID }],
    ['wrong owner type', { connected: true, installId: INSTALL_ID, userId: 42 }],
    ['widened closed response', { connected: false, userId: OWNER_ID }],
  ])('strictly rejects an install-status response with %s', (_label, value) => {
    expect(parseAttestExtensionInstallResponse(value)).toBeNull();
  });

  it('parses exact connected and disconnected install-status responses', () => {
    expect(parseAttestExtensionInstallResponse({
      connected: true,
      installId: INSTALL_ID,
      userId: OWNER_ID,
    })).toEqual({ connected: true, installId: INSTALL_ID, userId: OWNER_ID });
    expect(parseAttestExtensionInstallResponse({ connected: false }))
      .toEqual({ connected: false });
  });
});
