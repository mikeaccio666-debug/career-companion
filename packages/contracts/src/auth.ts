/** Auth, Agent session, and extension binding DTOs from AGENT-API-CONTRACT.md §2. */

import { parseIsoDateTime, parseUuid, type AgentSchemaEnvelope, type IsoDateTime, type Uuid } from './common.ts';

/** Existing AuthModule roles; these values are returned without Agent-specific remapping. */
export const AUTH_USER_ROLES = [
  'STUDENT',
  'STAFF',
  'PROJECT_ADMIN',
  'ADMIN',
  'REFERRAL_MENTOR',
] as const;
export type AuthUserRole = (typeof AUTH_USER_ROLES)[number];

export interface AuthUserView {
  readonly id: Uuid;
  readonly email: string;
  readonly role: AuthUserRole;
}

/**
 * The access token `apps/auth` issues and `apps/api` verifies.
 *
 * Both sides used to declare this shape independently — `apps/auth/src/security.ts`
 * for issuing, `apps/api/src/auth/jwks-access-token.strategy.ts` for verifying —
 * so a change on either side could only surface as a production authentication
 * failure. This module is the single wire authority; neither side may
 * re-declare it.
 *
 * Deployment identity (`iss`, `aud`, the JWKS URL) deliberately stays out of
 * here: those differ per environment and belong to configuration, not the wire.
 */
export const AUTH_ACCESS_TOKEN_ALGORITHM = 'ES256' as const;
export const AUTH_ACCESS_TOKEN_TYPE = 'at+jwt' as const;

/**
 * The issuer mints exactly this lifetime and the verifier rejects anything
 * longer, so the two are the same number by necessity rather than by luck.
 */
export const AUTH_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const AUTH_ACCESS_TOKEN_CLOCK_SKEW_SECONDS = 30;

export interface AuthAccessTokenProtectedHeader {
  readonly alg: typeof AUTH_ACCESS_TOKEN_ALGORITHM;
  readonly kid: string;
  readonly typ: typeof AUTH_ACCESS_TOKEN_TYPE;
  /** Header extensions stay closed: verifiers accept exactly the three keys above. */
  readonly crit?: never;
  readonly b64?: never;
  readonly jku?: never;
  readonly x5u?: never;
}

export interface AuthAccessTokenClaims {
  readonly sub: Uuid;
  /**
   * Durable refresh-session id. The issuer always sets it; the verifier still
   * accepts a token without it, because tokens minted before the session
   * binding existed carry no `sid`. Its presence is what makes
   * {@link BearerSubjectOwnerContext} available — absence downgrades the
   * request to subject-only authority rather than failing it.
   */
  readonly sid?: Uuid;
  readonly jti: string;
  /**
   * Issued for auditing only. Authorisation reads the role from the database
   * on every request (`jwks-access-token.strategy.ts` loads the user row), so
   * this claim is never the authority for access decisions and must not become
   * one — a token outlives a role change by up to its full lifetime.
   */
  readonly role: AuthUserRole;
  readonly iss: string;
  readonly aud: string;
  readonly iat: number;
  readonly exp: number;
  readonly nbf?: number;
  /** Data-L1 never rides in a bearer token: it is logged, proxied, and cached. */
  readonly email?: never;
  readonly password?: never;
  readonly resumeText?: never;
  readonly jobDescription?: never;
}

/** Published at the deployment's auth JWKS URL. Never carries a private scalar. */
export interface AuthAccessTokenPublicJwk {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly use: 'sig';
  readonly alg: typeof AUTH_ACCESS_TOKEN_ALGORITHM;
  readonly kid: string;
  readonly x: string;
  readonly y: string;
  readonly d?: never;
}

export interface GetAuthAccessTokenJwksResponse {
  readonly keys: readonly AuthAccessTokenPublicJwk[];
}

/**
 * Backend-private bearer-v2 authority established from a verified access JWT.
 * `jti` is an identifier only; current owner authority comes from `sub` plus
 * the durable refresh-session `sid`. It is not consumed, persisted as an
 * admission ledger, used as proof of possession, or treated as replay authority.
 */
export interface BearerSubjectOwnerContext {
  readonly sub: Uuid;
  readonly sid: Uuid;
  readonly jti: string;
}

/** Browser-visible Chat session. The refresh credential is deliberately absent. */
export interface ChatAccessSession {
  /** Secret JWT: never place in URLs, logs, analytics, or page-readable DOM. */
  readonly accessToken: string;
  readonly user: AuthUserView;
}

/** Old Auth server-to-server response. It must never cross the Chat BFF boundary. */
export interface AuthServerTokenPair extends ChatAccessSession {
  /** Opaque secret rotated on every successful refresh. */
  readonly refreshToken: string;
}

/** Extension-only token pair returned by handoff redeem or the §2.3 refresh adapter. */
export interface ExtensionTokenPair extends ChatAccessSession {
  readonly refreshToken: string;
}

export interface AuthAcquisition {
  readonly utmSource?: string;
  readonly utmMedium?: string;
  readonly utmCampaign?: string;
  readonly utmContent?: string;
  readonly utmTerm?: string;
  readonly gclid?: string;
  readonly fbclid?: string;
  /** Host only; the full referrer URL is forbidden. */
  readonly referrerHost?: string;
  readonly landingPath?: string;
  readonly capturedAt?: IsoDateTime;
}

/** §2.1 POST /auth/register */
export interface RegisterAuthRequest {
  readonly password: string;
  readonly fullName?: string;
  readonly anonId?: Uuid;
  readonly acquisition?: AuthAcquisition;
}

/** Server-only register request. The browser cannot select or override the invited email. */
export interface AuthServerRegisterRequest extends RegisterAuthRequest {
  /** Opaque restricted-session secret supplied only by the same-origin Portal BFF. */
  readonly registrationSession: string;
}

export interface RegisterAuthResponse {
  readonly ok: true;
  readonly verificationRequired: true;
}

/** §2.1 GET /auth/csrf */
export interface GetAuthCsrfResponse {
  readonly ok: true;
}

/** §2.1 POST /auth/login */
export interface LoginAuthRequest {
  readonly email: string;
  readonly password: string;
}

export type LoginAuthResponse = ChatAccessSession;

/** §2.1 POST /auth/google */
export interface GoogleLoginRequest {
  /** Google Identity Services credential (signed ID-token JWT). */
  readonly credential: string;
}

/** Server-only Google request used when the BFF has a restricted registration session. */
export interface AuthServerGoogleLoginRequest extends GoogleLoginRequest {
  readonly registrationSession?: string;
}

export interface GoogleLoginResponse extends ChatAccessSession {
  readonly isNewUser: boolean;
}

/** §2.1 POST /auth/refresh browser request has exactly zero body bytes. */
export type RefreshAuthSessionRequest = never;

export type RefreshAuthSessionResponse = ChatAccessSession;

/** §2.1 POST /auth/logout browser request has exactly zero body bytes. */
export type LogoutAuthSessionRequest = never;

/** Old Auth server-to-server refresh/logout body. */
export interface AuthServerRefreshRequest {
  readonly refreshToken: string;
}

export type AuthServerLogoutRequest = AuthServerRefreshRequest;

export interface LogoutAuthSessionResponse {
  readonly ok: true;
}

/** Exact credential body for Auth server calls and the isolated Extension adapter, never Chat BFF. */
export function parseAuthServerRefreshRequest(value: unknown): AuthServerRefreshRequest | null {
  return hasExactKeys(value, ['refreshToken']) && safeAuthToken(value.refreshToken)
    ? Object.freeze({ refreshToken: value.refreshToken }) : null;
}

export function parseExtensionTokenPair(value: unknown): ExtensionTokenPair | null {
  if (!hasExactKeys(value, ['accessToken', 'refreshToken', 'user'])
    || !safeAuthToken(value.accessToken) || !safeAuthToken(value.refreshToken)
    || !hasExactKeys(value.user, ['id', 'email', 'role'])) return null;
  const user = value.user;
  const id = parseUuid(user.id);
  if (!id || typeof user.email !== 'string' || user.email.length === 0 || user.email.length > 320
    || !AUTH_USER_ROLES.some((role) => role === user.role)) return null;
  return Object.freeze({ accessToken: value.accessToken, refreshToken: value.refreshToken,
    user: Object.freeze({ id, email: user.email, role: user.role as AuthUserRole }) });
}

export function parseLogoutAuthSessionResponse(value: unknown): LogoutAuthSessionResponse | null {
  return hasExactKeys(value, ['ok']) && value.ok === true ? Object.freeze({ ok: true }) : null;
}

function safeAuthToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._~-]{16,16384}$/.test(value);
}

/** §2.1 POST /auth/verify-email */
export interface VerifyEmailRequest {
  readonly token: string;
}

export interface VerifyEmailResponse {
  readonly ok: true;
}

/** §2.1 POST /auth/resend-email-verification */
export interface ResendEmailVerificationRequest {
  readonly email: string;
}

export interface ResendEmailVerificationResponse {
  readonly ok: true;
}

export const WAITLIST_LOCALES = ['en', 'zh-cn'] as const;
export type WaitlistLocale = (typeof WAITLIST_LOCALES)[number];

export interface WaitlistRequest {
  readonly fullName: string;
  readonly email: string;
  readonly targetRole?: string;
  readonly targetCompany?: string;
  readonly moreAboutYou?: string;
  readonly locale: WaitlistLocale;
  /** Honeypot. A non-empty value is rejected without creating a row. */
  readonly website?: string;
  /** Adaptive challenge proof; absent until the backend requests it. */
  readonly challengeProof?: string;
}

export interface WaitlistResponse {
  readonly ok: true;
}

export function parseWaitlistResponse(value: unknown): WaitlistResponse | null {
  return hasExactKeys(value, ['ok']) && value.ok === true
    ? Object.freeze({ ok: true })
    : null;
}

export interface ExchangeRegistrationInvitationRequest {
  readonly token: string;
}

/** Old Auth → Portal BFF only. The session secret never crosses into browser JSON. */
export interface ExchangeRegistrationInvitationResponse {
  readonly registrationSession: string;
  readonly expiresAt: IsoDateTime;
}

export interface ExchangeRegistrationInvitationBrowserResponse {
  readonly ok: true;
  readonly expiresAt: IsoDateTime;
}

export function parseExchangeRegistrationInvitationBrowserResponse(
  value: unknown,
): ExchangeRegistrationInvitationBrowserResponse | null {
  if (!hasExactKeys(value, ['expiresAt', 'ok']) || value.ok !== true) return null;
  const expiresAt = parseIsoDateTime(value.expiresAt);
  return expiresAt === null ? null : Object.freeze({ ok: true, expiresAt });
}

export interface GetRegistrationContextRequest {
  readonly registrationSession: string;
}

export interface RegistrationContextResponse {
  readonly email: string;
  readonly expiresAt: IsoDateTime;
}

export const WAITLIST_ENTRY_STATUSES = ['PENDING', 'INVITED', 'REGISTERED'] as const;
export type WaitlistEntryStatus = (typeof WAITLIST_ENTRY_STATUSES)[number];
export const INVITATION_DELIVERY_STATUSES = ['PENDING', 'DELIVERED', 'FAILED'] as const;
export type InvitationDeliveryStatus = (typeof INVITATION_DELIVERY_STATUSES)[number];

export interface AdminWaitlistEntryView {
  readonly id: Uuid;
  readonly fullName: string;
  readonly email: string;
  readonly targetRole?: string;
  readonly targetCompany?: string;
  readonly moreAboutYou?: string;
  readonly locale: WaitlistLocale;
  readonly status: WaitlistEntryStatus;
  readonly createdAt: IsoDateTime;
  readonly invitationId?: Uuid;
  readonly invitationExpiresAt?: IsoDateTime;
  readonly invitationDeliveredAt?: IsoDateTime;
  readonly invitationDeliveryStatus?: InvitationDeliveryStatus;
}

export interface ListAdminWaitlistQuery {
  readonly status?: WaitlistEntryStatus;
  readonly cursor?: Uuid;
  readonly limit?: number;
}

export interface ListAdminWaitlistResponse {
  readonly entries: readonly AdminWaitlistEntryView[];
  readonly nextCursor?: Uuid;
}

export interface WaitlistEntryPathParams {
  readonly waitlistEntryId: Uuid;
}

export interface InvitationPathParams {
  readonly invitationId: Uuid;
}

export interface CreateRegistrationInvitationResponse {
  readonly invitationId: Uuid;
  readonly expiresAt: IsoDateTime;
  readonly deliveryStatus: InvitationDeliveryStatus;
}

export interface RevokeRegistrationInvitationResponse {
  readonly ok: true;
}

export function parseRevokeRegistrationInvitationResponse(
  value: unknown,
): RevokeRegistrationInvitationResponse | null {
  return hasExactKeys(value, ['ok']) && value.ok === true
    ? Object.freeze({ ok: true })
    : null;
}

export type ResendRegistrationInvitationResponse = CreateRegistrationInvitationResponse;

export function parseExchangeRegistrationInvitationResponse(
  value: unknown,
): ExchangeRegistrationInvitationResponse | null {
  if (!hasExactKeys(value, ['expiresAt', 'registrationSession'])) return null;
  const expiresAt = parseIsoDateTime(value.expiresAt);
  return expiresAt !== null && isBoundedString(value.registrationSession, 16, 512)
    ? Object.freeze({ registrationSession: value.registrationSession, expiresAt })
    : null;
}

export function parseRegistrationContextResponse(
  value: unknown,
): RegistrationContextResponse | null {
  if (!hasExactKeys(value, ['email', 'expiresAt'])) return null;
  const expiresAt = parseIsoDateTime(value.expiresAt);
  return expiresAt !== null && isEmail(value.email)
    ? Object.freeze({ email: value.email, expiresAt })
    : null;
}

export function parseCreateRegistrationInvitationResponse(
  value: unknown,
): CreateRegistrationInvitationResponse | null {
  if (!hasExactKeys(value, ['deliveryStatus', 'expiresAt', 'invitationId'])) return null;
  const invitationId = parseUuid(value.invitationId);
  const expiresAt = parseIsoDateTime(value.expiresAt);
  return invitationId !== null && expiresAt !== null
    && INVITATION_DELIVERY_STATUSES.includes(value.deliveryStatus as InvitationDeliveryStatus)
    ? Object.freeze({
        invitationId,
        expiresAt,
        deliveryStatus: value.deliveryStatus as InvitationDeliveryStatus,
      })
    : null;
}

export function parseListAdminWaitlistResponse(
  value: unknown,
): ListAdminWaitlistResponse | null {
  if (!hasOnlyKeys(value, ['entries', 'nextCursor'], ['entries']) || !Array.isArray(value.entries)) {
    return null;
  }
  const entries: AdminWaitlistEntryView[] = [];
  for (const candidate of value.entries) {
    const parsed = parseAdminWaitlistEntry(candidate);
    if (parsed === null) return null;
    entries.push(parsed);
  }
  let nextCursor: Uuid | undefined;
  if (value.nextCursor !== undefined) {
    const parsed = parseUuid(value.nextCursor);
    if (parsed === null) return null;
    nextCursor = parsed;
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });
}

function parseAdminWaitlistEntry(value: unknown): AdminWaitlistEntryView | null {
  if (!hasOnlyKeys(value, [
    'createdAt', 'email', 'id', 'invitationDeliveredAt', 'invitationDeliveryStatus',
    'invitationExpiresAt', 'invitationId', 'locale', 'moreAboutYou', 'status',
    'fullName', 'targetCompany', 'targetRole',
  ], ['createdAt', 'email', 'fullName', 'id', 'locale', 'status'])) return null;
  const id = parseUuid(value.id);
  const createdAt = parseIsoDateTime(value.createdAt);
  if (
    id === null || createdAt === null || !isEmail(value.email) || !isBoundedString(value.fullName, 1, 120)
    || !WAITLIST_LOCALES.includes(value.locale as WaitlistLocale)
    || !WAITLIST_ENTRY_STATUSES.includes(value.status as WaitlistEntryStatus)
  ) return null;
  if (value.targetRole !== undefined && !isBoundedString(value.targetRole, 1, 160)) return null;
  if (value.targetCompany !== undefined && !isBoundedString(value.targetCompany, 1, 160)) return null;
  if (value.moreAboutYou !== undefined && !isBoundedString(value.moreAboutYou, 1, 2_000)) return null;
  let invitationId: Uuid | undefined;
  let invitationExpiresAt: IsoDateTime | undefined;
  let invitationDeliveredAt: IsoDateTime | undefined;
  if (value.invitationId !== undefined) {
    const parsed = parseUuid(value.invitationId);
    if (parsed === null) return null;
    invitationId = parsed;
  }
  if (value.invitationExpiresAt !== undefined) {
    const parsed = parseIsoDateTime(value.invitationExpiresAt);
    if (parsed === null) return null;
    invitationExpiresAt = parsed;
  }
  if (value.invitationDeliveredAt !== undefined) {
    const parsed = parseIsoDateTime(value.invitationDeliveredAt);
    if (parsed === null) return null;
    invitationDeliveredAt = parsed;
  }
  if (value.invitationDeliveryStatus !== undefined
    && !INVITATION_DELIVERY_STATUSES.includes(value.invitationDeliveryStatus as InvitationDeliveryStatus)) {
    return null;
  }
  return Object.freeze({
    id,
    fullName: value.fullName,
    email: value.email,
    ...(value.targetRole === undefined ? {} : { targetRole: value.targetRole }),
    ...(value.targetCompany === undefined ? {} : { targetCompany: value.targetCompany }),
    ...(value.moreAboutYou === undefined ? {} : { moreAboutYou: value.moreAboutYou }),
    locale: value.locale as WaitlistLocale,
    status: value.status as WaitlistEntryStatus,
    createdAt,
    ...(invitationId === undefined ? {} : { invitationId }),
    ...(invitationExpiresAt === undefined ? {} : { invitationExpiresAt }),
    ...(invitationDeliveredAt === undefined ? {} : { invitationDeliveredAt }),
    ...(value.invitationDeliveryStatus === undefined
      ? {}
      : { invitationDeliveryStatus: value.invitationDeliveryStatus as InvitationDeliveryStatus }),
  });
}

/** Strict browser decoder: email and restricted-session authority are both forbidden. */
export function parseRegisterAuthRequest(value: unknown): RegisterAuthRequest | null {
  if (!hasOnlyKeys(value, ['acquisition', 'anonId', 'fullName', 'password'], ['password'])) return null;
  if (!isBoundedString(value.password, 8, 256)) return null;
  const fullName = value.fullName === undefined
    ? undefined
    : isBoundedString(value.fullName, 1, 160) ? value.fullName : null;
  if (fullName === null) return null;
  let anonId: Uuid | undefined;
  if (value.anonId !== undefined) {
    const parsedAnonId = parseUuid(value.anonId);
    if (parsedAnonId === null) return null;
    anonId = parsedAnonId;
  }
  let acquisition: AuthAcquisition | undefined;
  if (value.acquisition !== undefined) {
    const parsedAcquisition = parseAuthAcquisition(value.acquisition);
    if (parsedAcquisition === null) return null;
    acquisition = parsedAcquisition;
  }
  return Object.freeze({
    password: value.password,
    ...(fullName === undefined ? {} : { fullName }),
    ...(anonId === undefined ? {} : { anonId }),
    ...(acquisition === undefined ? {} : { acquisition }),
  });
}

export function parseAuthServerRegisterRequest(value: unknown): AuthServerRegisterRequest | null {
  if (!hasOnlyKeys(
    value,
    ['acquisition', 'anonId', 'fullName', 'password', 'registrationSession'],
    ['password', 'registrationSession'],
  )) return null;
  const browser = parseRegisterAuthRequest(Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'registrationSession'),
  ));
  return browser !== null && isBoundedString(value.registrationSession, 16, 512)
    ? Object.freeze({ ...browser, registrationSession: value.registrationSession })
    : null;
}

export function parseWaitlistRequest(value: unknown): WaitlistRequest | null {
  if (!hasOnlyKeys(
    value,
    ['challengeProof', 'email', 'fullName', 'locale', 'moreAboutYou', 'targetCompany', 'targetRole', 'website'],
    ['email', 'fullName', 'locale'],
  )) {
    return null;
  }
  if (
    !isEmail(value.email)
    || !isBoundedString(value.fullName, 1, 120)
    || !WAITLIST_LOCALES.includes(value.locale as WaitlistLocale)
  ) return null;
  if (value.targetRole !== undefined && !isBoundedString(value.targetRole, 1, 160)) return null;
  if (value.targetCompany !== undefined && !isBoundedString(value.targetCompany, 1, 160)) return null;
  if (value.moreAboutYou !== undefined && !isBoundedString(value.moreAboutYou, 1, 2_000)) return null;
  if (value.website !== undefined && typeof value.website !== 'string') return null;
  if (value.challengeProof !== undefined && !isBoundedString(value.challengeProof, 1, 4096)) return null;
  return Object.freeze({
    email: value.email,
    fullName: value.fullName,
    locale: value.locale as WaitlistLocale,
    ...(value.targetRole === undefined ? {} : { targetRole: value.targetRole }),
    ...(value.targetCompany === undefined ? {} : { targetCompany: value.targetCompany }),
    ...(value.moreAboutYou === undefined ? {} : { moreAboutYou: value.moreAboutYou }),
    ...(value.website === undefined ? {} : { website: value.website }),
    ...(value.challengeProof === undefined ? {} : { challengeProof: value.challengeProof }),
  });
}

export function parseExchangeRegistrationInvitationRequest(
  value: unknown,
): ExchangeRegistrationInvitationRequest | null {
  return hasExactKeys(value, ['token']) && isBoundedString(value.token, 8, 512)
    ? Object.freeze({ token: value.token })
    : null;
}

function parseAuthAcquisition(value: unknown): AuthAcquisition | null {
  const keys = [
    'capturedAt',
    'fbclid',
    'gclid',
    'landingPath',
    'referrerHost',
    'utmCampaign',
    'utmContent',
    'utmMedium',
    'utmSource',
    'utmTerm',
  ] as const;
  if (!hasOnlyKeys(value, keys, [])) return null;
  for (const key of keys) {
    if (value[key] !== undefined && !isBoundedString(value[key], 1, 512)) return null;
  }
  return Object.freeze({ ...value }) as AuthAcquisition;
}

function isBoundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function isEmail(value: unknown): value is string {
  return isBoundedString(value, 3, 320) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export interface AgentSessionUserView extends AuthUserView {
  /** The endpoint rejects an unverified account, so a success response is always true. */
  readonly emailVerified: true;
}

/** §2.2 private Auth session introspection. */
export interface IntrospectAuthSessionRequest {
  readonly refreshToken: string;
}

export interface IntrospectAuthSessionResponse extends AgentSchemaEnvelope {
  readonly session: {
    readonly authenticated: true;
    readonly user: AgentSessionUserView;
  };
  readonly refreshExpiresAt: IsoDateTime;
}

/** §2.2 private Auth session revoke. */
export interface RevokeAuthSessionRequest {
  readonly refreshToken: string;
}

export interface RevokeAuthSessionResponse {
  readonly ok: true;
}

/** §2.2 GET /api/v1/agent/session */
export interface GetAgentSessionResponse extends AgentSchemaEnvelope {
  readonly session: {
    readonly authenticated: true;
    readonly user: AgentSessionUserView;
  };
}

/** §2.3 POST /auth/extension-handoffs */
export interface CreateExtensionHandoffRequest {
  readonly extensionId: string;
  /** 22–256 safe chars from a CSPRNG carrying at least 128 bits（§2.3 切片 e333426d 收紧）。 */
  readonly state: string;
}

export interface CreateExtensionHandoffResponse {
  readonly code: string;
  readonly expiresAt: IsoDateTime;
}

/**
 * §2.3 POST /auth/extension-handoffs/redeem（public）。
 * 服务端校验浏览器 Origin 必须精确等于 `chrome-extension://<extensionId>`；
 * 任一失配统一回 AUTH_HANDOFF_INVALID。extension id 走环境固定 allowlist，
 * portal 不得信任 URL/query 传入的任意 id。
 */
export interface RedeemExtensionHandoffRequest {
  readonly code: string;
  readonly extensionId: string;
  readonly state: string;
  readonly anonId?: Uuid;
}

export type RedeemExtensionHandoffResponse = ExtensionTokenPair;

/** §2.3 POST /api/v1/agent/extension-installs（Bearer；成功 202 {ok:true}，幂等可重放）。 */
export interface LinkExtensionInstallRequest {
  readonly installId: Uuid;
}

export interface LinkExtensionInstallResponse {
  readonly ok: true;
}

/** §2.3 POST /api/v1/agent/extension-installs/status（Bearer；owner-only, zero mutation）。 */
export interface AttestExtensionInstallRequest {
  readonly installId: Uuid;
}

export type AttestExtensionInstallResponse =
  | {
    readonly connected: true;
    readonly installId: Uuid;
    readonly userId: Uuid;
  }
  | { readonly connected: false };

/**
 * Portal ↔ Extension VM0 connection attestation.
 *
 * The Portal owner is comparison input only. A positive ACK is emitted only
 * after a fresh owner-only, zero-write install-status read. `correlationId`
 * is generated per call and echoed verbatim so a positive ACK from an older
 * same-owner request cannot be replayed into the current generation.
 */
export const EXTENSION_CONNECTION_PROTOCOL_VERSION = 1 as const;
export const EXTENSION_CONNECTION_CAPABILITIES = Object.freeze([
  'DISCOVERY_READ_ONLY',
] as const);
export type ExtensionConnectionCapability =
  (typeof EXTENSION_CONNECTION_CAPABILITIES)[number];

export interface ExtensionConnectionStatusRequest {
  readonly kind: 'auth/connection-status';
  readonly expectedOwnerId: Uuid;
  readonly correlationId: Uuid;
}

export interface ExtensionConnectionStatusSuccess {
  readonly ok: true;
  readonly protocolVersion: typeof EXTENSION_CONNECTION_PROTOCOL_VERSION;
  readonly extensionId: string;
  readonly userId: Uuid;
  readonly installId: Uuid;
  readonly correlationId: Uuid;
  readonly capabilities: typeof EXTENSION_CONNECTION_CAPABILITIES;
}

export type ExtensionConnectionStatusResponse =
  | ExtensionConnectionStatusSuccess
  | { readonly ok: false };

export interface ExtensionConnectionStatusExpectation {
  readonly extensionId: string;
  readonly expectedOwnerId: Uuid;
  readonly correlationId: Uuid;
}

/** Strict executable boundary for the Portal → Extension status request. */
export function parseExtensionConnectionStatusRequest(
  value: unknown,
): ExtensionConnectionStatusRequest | null {
  if (!hasExactKeys(value, ['correlationId', 'expectedOwnerId', 'kind'])) return null;
  const expectedOwnerId = parseUuid(value.expectedOwnerId);
  const correlationId = parseUuid(value.correlationId);
  return value.kind === 'auth/connection-status' &&
      expectedOwnerId !== null &&
      correlationId !== null
    ? Object.freeze({ kind: 'auth/connection-status', expectedOwnerId, correlationId })
    : null;
}

/**
 * Strict executable boundary for the Extension → Portal ACK. Expected
 * owner, extension, and correlation are call-specific authority and are
 * never learned from the untrusted response.
 */
export function parseExtensionConnectionStatusResponse(
  value: unknown,
  expectation: ExtensionConnectionStatusExpectation,
): ExtensionConnectionStatusResponse | null {
  if (hasExactKeys(value, ['ok']) && value.ok === false) {
    return Object.freeze({ ok: false });
  }
  if (!hasExactKeys(value, [
    'capabilities',
    'correlationId',
    'extensionId',
    'installId',
    'ok',
    'protocolVersion',
    'userId',
  ])) return null;
  const userId = parseUuid(value.userId);
  const installId = parseUuid(value.installId);
  const correlationId = parseUuid(value.correlationId);
  if (
    value.ok !== true ||
    value.protocolVersion !== EXTENSION_CONNECTION_PROTOCOL_VERSION ||
    value.extensionId !== expectation.extensionId ||
    userId !== expectation.expectedOwnerId ||
    installId === null ||
    correlationId !== expectation.correlationId ||
    !hasExactCapabilities(value.capabilities)
  ) return null;
  return Object.freeze({
    ok: true,
    protocolVersion: EXTENSION_CONNECTION_PROTOCOL_VERSION,
    extensionId: expectation.extensionId,
    userId,
    installId,
    correlationId,
    capabilities: EXTENSION_CONNECTION_CAPABILITIES,
  });
}

/** Strict executable consumer for the owner-only install-status HTTP result. */
export function parseAttestExtensionInstallResponse(
  value: unknown,
): AttestExtensionInstallResponse | null {
  if (hasExactKeys(value, ['connected']) && value.connected === false) {
    return Object.freeze({ connected: false });
  }
  if (!hasExactKeys(value, ['connected', 'installId', 'userId'])) return null;
  const installId = parseUuid(value.installId);
  const userId = parseUuid(value.userId);
  return value.connected === true && installId !== null && userId !== null
    ? Object.freeze({ connected: true, installId, userId })
    : null;
}

function hasExactCapabilities(
  value: unknown,
): value is typeof EXTENSION_CONNECTION_CAPABILITIES {
  return Array.isArray(value) &&
    value.length === EXTENSION_CONNECTION_CAPABILITIES.length &&
    value.every((capability, index) =>
      capability === EXTENSION_CONNECTION_CAPABILITIES[index]);
}

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length &&
    keys.every((key, index) => key === sorted[index]);
}

function hasOnlyKeys(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) &&
    required.every((key) => Object.hasOwn(value, key));
}

/**
 * §2.4 deliberately reuses GetExecutionIntentJwksResponse from
 * executionIntent.ts. It is public RFC 7517 JSON and has no Agent envelope.
 */
