import {
  AGENT_HTTP_SCHEMA_VERSION,
  parseIsoDateTime,
  parseUuid,
  type AgentErrorCode,
  type AgentSchemaEnvelope,
  type IsoDateTime,
  type Uuid,
} from './common.ts';

export const REFERRAL_REFUND_POLICY_VERSION = 'referral-full-original-payment-v1' as const;
export const REFERRAL_ONE_TIME_AMOUNT_USD_CENTS = 4_900 as const;
export const REFERRAL_ONE_TIME_CURRENCY = 'usd' as const;
export const REFERRAL_COMMERCE_STATES = [
  'NOT_PURCHASED',
  'CHECKOUT_PENDING',
  'PAID',
  'REFUND_REQUESTED',
  'REFUND_PROCESSING',
  'REFUNDED',
  'RECONCILIATION_REQUIRED',
] as const;
export type ReferralCommerceState = (typeof REFERRAL_COMMERCE_STATES)[number];

export interface CreateReferralCheckoutRequest {
  readonly clientRequestId: Uuid;
}

export interface CreateReferralCheckoutResponse extends AgentSchemaEnvelope {
  readonly checkoutUrl: string;
  /** Local opaque reference. Provider object IDs never cross this boundary. */
  readonly orderReference: Uuid;
  readonly amountCents: number;
  readonly currency: 'usd';
  readonly refundPolicyVersion: typeof REFERRAL_REFUND_POLICY_VERSION;
}

export interface ReferralCommerceView extends AgentSchemaEnvelope {
  readonly referralRequestId: Uuid;
  readonly orderReference: Uuid | null;
  readonly state: ReferralCommerceState;
  readonly amountPaidCents: number | null;
  readonly currency: 'usd' | null;
  readonly refundableAmountCents: number;
  readonly refundPolicyVersion: typeof REFERRAL_REFUND_POLICY_VERSION;
  readonly providerReconciledAt: IsoDateTime | null;
}

export interface ExecuteReferralRefundResponse extends AgentSchemaEnvelope {
  readonly commerce: ReferralCommerceView;
}

export type ReconcileReferralRefundResponse = ExecuteReferralRefundResponse;

export function parseCreateReferralCheckoutResponse(
  value: unknown,
): CreateReferralCheckoutResponse | null {
  if (!exactRecord(value, [
    'amountCents',
    'checkoutUrl',
    'currency',
    'orderReference',
    'refundPolicyVersion',
    'schemaVersion',
  ]) || value.schemaVersion !== AGENT_HTTP_SCHEMA_VERSION ||
      typeof value.checkoutUrl !== 'string' || value.checkoutUrl.length > 2_048 ||
      parseUuid(value.orderReference) === null ||
      !Number.isSafeInteger(value.amountCents) || Number(value.amountCents) <= 0 ||
      value.currency !== 'usd' || value.refundPolicyVersion !== REFERRAL_REFUND_POLICY_VERSION) {
    return null;
  }
  return value as unknown as CreateReferralCheckoutResponse;
}

export function parseReferralCommerceView(value: unknown): ReferralCommerceView | null {
  if (!exactRecord(value, [
    'amountPaidCents',
    'currency',
    'orderReference',
    'providerReconciledAt',
    'referralRequestId',
    'refundableAmountCents',
    'refundPolicyVersion',
    'schemaVersion',
    'state',
  ]) || value.schemaVersion !== AGENT_HTTP_SCHEMA_VERSION ||
      parseUuid(value.referralRequestId) === null ||
      (value.orderReference !== null && parseUuid(value.orderReference) === null) ||
      !REFERRAL_COMMERCE_STATES.includes(value.state as ReferralCommerceState) ||
      (value.amountPaidCents !== null &&
        (!Number.isSafeInteger(value.amountPaidCents) || Number(value.amountPaidCents) <= 0)) ||
      (value.currency !== null && value.currency !== 'usd') ||
      !Number.isSafeInteger(value.refundableAmountCents) || Number(value.refundableAmountCents) < 0 ||
      value.refundPolicyVersion !== REFERRAL_REFUND_POLICY_VERSION ||
      (value.providerReconciledAt !== null && parseIsoDateTime(value.providerReconciledAt) === null)) {
    return null;
  }
  if ((value.amountPaidCents === null) !== (value.currency === null)) return null;
  if (Number(value.refundableAmountCents) > Number(value.amountPaidCents ?? 0)) return null;
  return value as unknown as ReferralCommerceView;
}

export function parseExecuteReferralRefundResponse(
  value: unknown,
): ExecuteReferralRefundResponse | null {
  if (!exactRecord(value, ['commerce', 'schemaVersion']) ||
      value.schemaVersion !== AGENT_HTTP_SCHEMA_VERSION ||
      parseReferralCommerceView(value.commerce) === null) return null;
  return value as unknown as ExecuteReferralRefundResponse;
}

export const STANDARD_SUBSCRIPTION_TRIAL_DAYS = 3 as const;
export const STANDARD_SUBSCRIPTION_MONTHLY_AMOUNT_USD_CENTS = 4_900 as const;
export const STANDARD_SUBSCRIPTION_CURRENCY = 'usd' as const;
export const STANDARD_SUBSCRIPTION_INTERVAL = 'month' as const;
export const STANDARD_SUBSCRIPTION_REMINDER_LEAD_HOURS = 24 as const;

export const WEBSITE_ACCESS_STATES = [
  'NONE',
  'ONBOARDING_TRIAL',
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'CANCELED',
  'UNPAID',
  'INCOMPLETE',
] as const;
export type WebsiteAccessState = (typeof WEBSITE_ACCESS_STATES)[number];

export interface StandardSubscriptionCatalog {
  readonly trialDays: number;
  readonly amountUsdCents: number;
  readonly currency: string;
  readonly interval: 'month' | 'year';
  readonly includesAllCurrentWebsiteSoftwareFeatures: true;
  readonly excludesOneOffHumanServices: true;
  readonly promotionCodesAcceptedAtCheckout: true;
  readonly trialReminderLeadHours: typeof STANDARD_SUBSCRIPTION_REMINDER_LEAD_HOURS;
  readonly renewalReminderLeadHours: typeof STANDARD_SUBSCRIPTION_REMINDER_LEAD_HOURS;
}

export interface GetWebsiteSubscriptionResponse extends AgentSchemaEnvelope {
  readonly access: boolean;
  readonly state: WebsiteAccessState;
  readonly subscriptionId: Uuid | null;
  readonly currentPeriodEndsAt: IsoDateTime | null;
  readonly catalog: StandardSubscriptionCatalog;
}

export interface CreateSubscriptionCheckoutRequest {
  readonly clientRequestId: Uuid;
  /** Immutable server-owned catalog version; omitted only by legacy clients. */
  readonly offerId?: Uuid;
}

export interface CreateSubscriptionCheckoutResponse extends AgentSchemaEnvelope {
  readonly checkoutUrl: string;
}

export interface CreatePaymentMethodPortalResponse extends AgentSchemaEnvelope {
  readonly paymentMethodPortalUrl: string;
}

export interface CancelSubscriptionResponse extends GetWebsiteSubscriptionResponse {
  readonly canceledImmediately: true;
  readonly refundStatus: 'NO_REFUND';
  readonly creditStatus: 'NO_CREDIT';
}

export function parseGetWebsiteSubscriptionResponse(
  value: unknown,
): GetWebsiteSubscriptionResponse | null {
  return parseSubscriptionResponse(value, [
    'access',
    'catalog',
    'currentPeriodEndsAt',
    'schemaVersion',
    'state',
    'subscriptionId',
  ]);
}

export function parseCreateSubscriptionCheckoutResponse(
  value: unknown,
): CreateSubscriptionCheckoutResponse | null {
  if (
    !exactRecord(value, ['checkoutUrl', 'schemaVersion']) ||
    value.schemaVersion !== AGENT_HTTP_SCHEMA_VERSION ||
    typeof value.checkoutUrl !== 'string' ||
    value.checkoutUrl.length < 1 ||
    value.checkoutUrl.length > 2_048
  ) return null;
  return value as unknown as CreateSubscriptionCheckoutResponse;
}

export function parseCreatePaymentMethodPortalResponse(
  value: unknown,
): CreatePaymentMethodPortalResponse | null {
  if (
    !exactRecord(value, ['paymentMethodPortalUrl', 'schemaVersion']) ||
    value.schemaVersion !== AGENT_HTTP_SCHEMA_VERSION ||
    typeof value.paymentMethodPortalUrl !== 'string' ||
    value.paymentMethodPortalUrl.length < 1 ||
    value.paymentMethodPortalUrl.length > 2_048
  ) return null;
  return value as unknown as CreatePaymentMethodPortalResponse;
}

export function parseCancelSubscriptionResponse(
  value: unknown,
): CancelSubscriptionResponse | null {
  const parsed = parseSubscriptionResponse(value, [
    'access',
    'canceledImmediately',
    'catalog',
    'creditStatus',
    'currentPeriodEndsAt',
    'refundStatus',
    'schemaVersion',
    'state',
    'subscriptionId',
  ]);
  if (
    !parsed ||
    !exactRecord(value, [
      'access',
      'canceledImmediately',
      'catalog',
      'creditStatus',
      'currentPeriodEndsAt',
      'refundStatus',
      'schemaVersion',
      'state',
      'subscriptionId',
    ]) ||
    value.canceledImmediately !== true ||
    value.refundStatus !== 'NO_REFUND' ||
    value.creditStatus !== 'NO_CREDIT'
  ) return null;
  return value as unknown as CancelSubscriptionResponse;
}

function parseSubscriptionResponse(
  value: unknown,
  keys: readonly string[],
): GetWebsiteSubscriptionResponse | null {
  if (!exactRecord(value, keys) || value.schemaVersion !== AGENT_HTTP_SCHEMA_VERSION) return null;
  if (
    typeof value.access !== 'boolean' ||
    !WEBSITE_ACCESS_STATES.includes(value.state as WebsiteAccessState) ||
    value.access !== (
      value.state === 'ONBOARDING_TRIAL' ||
      value.state === 'TRIALING' ||
      value.state === 'ACTIVE'
    ) ||
    (value.state === 'ONBOARDING_TRIAL' && (
      value.subscriptionId !== null ||
      parseIsoDateTime(value.currentPeriodEndsAt) === null
    )) ||
    (value.subscriptionId !== null && parseUuid(value.subscriptionId) === null) ||
    (value.currentPeriodEndsAt !== null && parseIsoDateTime(value.currentPeriodEndsAt) === null) ||
    !isStandardSubscriptionCatalog(value.catalog)
  ) return null;
  return value as unknown as GetWebsiteSubscriptionResponse;
}

function isStandardSubscriptionCatalog(value: unknown): value is StandardSubscriptionCatalog {
  return exactRecord(value, [
    'amountUsdCents',
    'currency',
    'excludesOneOffHumanServices',
    'includesAllCurrentWebsiteSoftwareFeatures',
    'interval',
    'promotionCodesAcceptedAtCheckout',
    'renewalReminderLeadHours',
    'trialDays',
    'trialReminderLeadHours',
  ]) &&
    Number.isSafeInteger(value.trialDays) && Number(value.trialDays) >= 0 &&
    Number.isSafeInteger(value.amountUsdCents) && Number(value.amountUsdCents) > 0 &&
    typeof value.currency === 'string' && /^[a-z]{3}$/.test(value.currency) &&
    (value.interval === 'month' || value.interval === 'year') &&
    value.includesAllCurrentWebsiteSoftwareFeatures === true &&
    value.excludesOneOffHumanServices === true &&
    value.promotionCodesAcceptedAtCheckout === true &&
    value.trialReminderLeadHours === STANDARD_SUBSCRIPTION_REMINDER_LEAD_HOURS &&
    value.renewalReminderLeadHours === STANDARD_SUBSCRIPTION_REMINDER_LEAD_HOURS;
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

export const PAYMENTS_ENDPOINTS = Object.freeze({
  getCatalog: Object.freeze({ method: 'GET', path: '/payments/catalog', auth: 'bearer' }),
  getInvoices: Object.freeze({ method: 'GET', path: '/payments/invoices', auth: 'bearer' }),
  reconcileSubscription: Object.freeze({ method: 'POST', path: '/payments/subscription/reconcile', auth: 'bearer' }),
  listAdminOffers: Object.freeze({ method: 'GET', path: '/api/v1/agent/admin/payments/offers', auth: 'admin' }),
  createAdminOffer: Object.freeze({ method: 'POST', path: '/api/v1/agent/admin/payments/offers', auth: 'admin' }),
  publishAdminOffer: Object.freeze({ method: 'POST', path: '/api/v1/agent/admin/payments/offers/:offerId/publish', auth: 'admin' }),
  retireAdminOffer: Object.freeze({ method: 'POST', path: '/api/v1/agent/admin/payments/offers/:offerId/retire', auth: 'admin' }),
  inspectAdminEntitlements: Object.freeze({ method: 'GET', path: '/api/v1/agent/admin/payments/users/:userId/entitlements', auth: 'admin' }),
  reconcileAdminEntitlements: Object.freeze({ method: 'POST', path: '/api/v1/agent/admin/payments/users/:userId/reconcile', auth: 'admin' }),
  getSubscription: Object.freeze({
    method: 'GET',
    path: '/payments/subscription',
    auth: 'bearer',
  }),
  createSubscriptionCheckout: Object.freeze({
    method: 'POST',
    path: '/payments/subscription/checkout',
    auth: 'bearer',
  }),
  createPaymentMethodPortal: Object.freeze({
    method: 'POST',
    path: '/payments/subscription/payment-method',
    auth: 'bearer',
  }),
  cancelSubscription: Object.freeze({
    method: 'POST',
    path: '/payments/subscription/cancel',
    auth: 'bearer',
  }),
  stripeWebhook: Object.freeze({
    method: 'POST',
    path: '/payments/stripe/webhook',
    auth: 'stripe-signature',
  }),
});

export const PAYMENTS_ENDPOINT_ERROR_CODES = [
  'VALIDATION_FAILED',
  'LOGIN_REQUIRED',
  'ACTION_STATE_CONFLICT',
  'AGENT_UNAVAILABLE',
  'INTERNAL_ERROR',
  'ACCESS_DENIED',
  'RESOURCE_NOT_FOUND',
  'RATE_LIMITED',
] as const satisfies readonly AgentErrorCode[];
