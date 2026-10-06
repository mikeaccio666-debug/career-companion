import { AGENT_HTTP_SCHEMA_VERSION, parseIsoDateTime, parseUuid, type AgentSchemaEnvelope, type IsoDateTime, type Uuid } from './common.ts';
import { REFERRAL_ONE_TIME_AMOUNT_USD_CENTS, REFERRAL_ONE_TIME_CURRENCY, REFERRAL_REFUND_POLICY_VERSION } from './payments.ts';

/** Implemented software admission keys. These never grant roles, quotas or release permission. */
export const PAYMENT_FEATURE_KEYS = [
  'chat.use', 'resume.manage', 'profile.manage', 'analysis.use',
  'jobs.recommend', 'learning.use', 'application.assist',
] as const;
export type PaymentFeatureKey = (typeof PAYMENT_FEATURE_KEYS)[number];
/** Supported currencies all use two decimal minor units. */
export const PAYMENT_CATALOG_CURRENCIES = ['usd', 'eur', 'gbp', 'cad', 'aud'] as const;
export const PAYMENT_OFFER_KINDS = ['SUBSCRIPTION', 'REFERRAL'] as const;
export type PaymentOfferKind = (typeof PAYMENT_OFFER_KINDS)[number];
export const PAYMENT_OFFER_STATES = ['DRAFT', 'PUBLISHED', 'RETIRED'] as const;
export type PaymentOfferState = (typeof PAYMENT_OFFER_STATES)[number];
export const SUBSCRIPTION_PERIOD_END_POLICY_VERSION = 's5-period-end-reviewed-refund-v2' as const;
export const SUBSCRIPTION_POLICY_VERSION = 't24-immediate-cancel-no-refund-v1' as const;
export const ONBOARDING_TRIAL_POLICY_VERSION = 't24-first-access-72h-v1' as const;

export interface CreatePaymentOfferRequest {
  readonly clientRequestId: Uuid;
  readonly key: string;
  readonly name: string;
  readonly kind: PaymentOfferKind;
  readonly amountCents: number;
  readonly currency: string;
  readonly interval: 'month' | 'year' | null;
  readonly intervalCount: number;
  readonly featureKeys: readonly PaymentFeatureKey[];
}
export interface PaymentOfferView {
  readonly id: Uuid;
  readonly key: string;
  readonly version: number;
  readonly name: string;
  readonly kind: PaymentOfferKind;
  readonly state: PaymentOfferState;
  readonly amountCents: number;
  readonly currency: string;
  readonly interval: 'month' | 'year' | null;
  readonly intervalCount: number;
  readonly featureKeys: readonly PaymentFeatureKey[];
  readonly policyVersion: string;
  readonly testMode: boolean;
  readonly publishedAt: IsoDateTime | null;
}
export interface PaymentEntitlementView {
  readonly source: 'NONE' | 'ONBOARDING_TRIAL' | 'SUBSCRIPTION' | 'LEGACY_SUBSCRIPTION';
  readonly state: 'GRANTED' | 'DENIED' | 'SYNC_REQUIRED';
  readonly featureKeys: readonly PaymentFeatureKey[];
  readonly expiresAt: IsoDateTime | null;
  readonly synchronizedAt: IsoDateTime | null;
}
export interface PaymentCatalogResponse extends AgentSchemaEnvelope {
  readonly offers: readonly PaymentOfferView[];
  readonly currentOffer: PaymentOfferView | null;
  readonly entitlement: PaymentEntitlementView;
}
export interface AdminPaymentCatalogResponse extends AgentSchemaEnvelope {
  readonly offers: readonly PaymentOfferView[];
  readonly featureKeys: readonly PaymentFeatureKey[];
}
export interface PaymentOfferResponse extends AgentSchemaEnvelope { readonly offer: PaymentOfferView }
export interface PaymentInvoiceView {
  readonly reference: string;
  readonly createdAt: IsoDateTime;
  readonly amountPaidCents: number;
  readonly currency: string;
  readonly status: 'draft' | 'open' | 'paid' | 'uncollectible' | 'void';
  readonly hostedInvoiceUrl: string | null;
}
export interface PaymentInvoicesResponse extends AgentSchemaEnvelope {
  readonly invoices: readonly PaymentInvoiceView[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

export function isPaymentFeatureKey(value: unknown): value is PaymentFeatureKey {
  return PAYMENT_FEATURE_KEYS.includes(value as PaymentFeatureKey);
}
export function parsePaymentFeatureKeys(value: unknown): readonly PaymentFeatureKey[] | null {
  return Array.isArray(value) && value.length <= PAYMENT_FEATURE_KEYS.length &&
    value.every(isPaymentFeatureKey) && new Set(value).size === value.length ? value : null;
}
export function parseCreatePaymentOfferRequest(value: unknown): CreatePaymentOfferRequest | null {
  if (!exact(value, ['clientRequestId', 'key', 'name', 'kind', 'amountCents', 'currency', 'interval', 'intervalCount', 'featureKeys']) ||
    !parseUuid(value.clientRequestId) || !offerFields(value)) return null;
  return value as unknown as CreatePaymentOfferRequest;
}
export function parsePaymentOfferView(value: unknown): PaymentOfferView | null {
  if (!exact(value, ['id', 'key', 'version', 'name', 'kind', 'state', 'amountCents', 'currency', 'interval', 'intervalCount', 'featureKeys', 'policyVersion', 'testMode', 'publishedAt']) ||
    !parseUuid(value.id) || !offerFields(value) || !positiveInteger(value.version) ||
    !PAYMENT_OFFER_STATES.includes(value.state as PaymentOfferState) || typeof value.testMode !== 'boolean' ||
    !(value.kind === 'SUBSCRIPTION' ? [SUBSCRIPTION_POLICY_VERSION, SUBSCRIPTION_PERIOD_END_POLICY_VERSION].includes(value.policyVersion as typeof SUBSCRIPTION_POLICY_VERSION) : value.policyVersion === REFERRAL_REFUND_POLICY_VERSION) ||
    !nullableDate(value.publishedAt) || (value.state !== 'DRAFT' && value.publishedAt === null)) return null;
  return value as unknown as PaymentOfferView;
}
export function parsePaymentEntitlementView(value: unknown): PaymentEntitlementView | null {
  if (!exact(value, ['source', 'state', 'featureKeys', 'expiresAt', 'synchronizedAt']) ||
    !['NONE', 'ONBOARDING_TRIAL', 'SUBSCRIPTION', 'LEGACY_SUBSCRIPTION'].includes(String(value.source)) ||
    !['GRANTED', 'DENIED', 'SYNC_REQUIRED'].includes(String(value.state)) ||
    parsePaymentFeatureKeys(value.featureKeys) === null || !nullableDate(value.expiresAt) || !nullableDate(value.synchronizedAt) ||
    (value.state !== 'GRANTED' && (value.featureKeys as unknown[]).length !== 0) ||
    (value.state === 'GRANTED' && (value.source === 'NONE' || value.expiresAt === null || (value.featureKeys as unknown[]).length === 0))) return null;
  return value as unknown as PaymentEntitlementView;
}
export function parsePaymentCatalogResponse(value: unknown): PaymentCatalogResponse | null {
  if (!exact(value, ['schemaVersion', 'offers', 'currentOffer', 'entitlement']) || !envelope(value) ||
    !offers(value.offers) || (value.currentOffer !== null && !parsePaymentOfferView(value.currentOffer)) ||
    !parsePaymentEntitlementView(value.entitlement)) return null;
  return value as unknown as PaymentCatalogResponse;
}
export function parseAdminPaymentCatalogResponse(value: unknown): AdminPaymentCatalogResponse | null {
  if (!exact(value, ['schemaVersion', 'offers', 'featureKeys']) || !envelope(value) ||
    !offers(value.offers) || parsePaymentFeatureKeys(value.featureKeys) === null) return null;
  return value as unknown as AdminPaymentCatalogResponse;
}
export function parsePaymentOfferResponse(value: unknown): PaymentOfferResponse | null {
  return exact(value, ['schemaVersion', 'offer']) && envelope(value) && parsePaymentOfferView(value.offer)
    ? value as unknown as PaymentOfferResponse : null;
}
export function parsePaymentInvoicesResponse(value: unknown): PaymentInvoicesResponse | null {
  if (!exact(value, ['schemaVersion', 'invoices', 'hasMore', 'nextCursor']) || !envelope(value) ||
    typeof value.hasMore !== 'boolean' || (value.nextCursor !== null && !invoiceReference(value.nextCursor)) ||
    value.hasMore !== (value.nextCursor !== null) || !Array.isArray(value.invoices) || value.invoices.length > 25 ||
    !value.invoices.every((row) => exact(row, ['reference', 'createdAt', 'amountPaidCents', 'currency', 'status', 'hostedInvoiceUrl']) &&
      invoiceReference(row.reference) && parseIsoDateTime(row.createdAt) && Number.isSafeInteger(row.amountPaidCents) && Number(row.amountPaidCents) >= 0 &&
      typeof row.currency === 'string' && /^[a-z]{3}$/.test(row.currency) &&
      ['draft', 'open', 'paid', 'uncollectible', 'void'].includes(String(row.status)) &&
      (row.hostedInvoiceUrl === null || stripeInvoiceUrl(row.hostedInvoiceUrl)))) return null;
  return value as unknown as PaymentInvoicesResponse;
}
export function stripeInvoiceUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try { const url = new URL(value); return url.origin === 'https://invoice.stripe.com' && !url.username && !url.password; }
  catch { return false; }
}
function offerFields(value: Record<string, unknown>): boolean {
  if (typeof value.key !== 'string' || !/^[a-z][a-z0-9-]{2,63}$/.test(value.key) ||
    typeof value.name !== 'string' || value.name.trim() !== value.name || value.name.length < 1 || value.name.length > 100 ||
    !positiveInteger(value.amountCents) || Number(value.amountCents) > 99_999_999 ||
    !PAYMENT_CATALOG_CURRENCIES.includes(value.currency as (typeof PAYMENT_CATALOG_CURRENCIES)[number]) ||
    !positiveInteger(value.intervalCount) || Number(value.intervalCount) > 12 ||
    parsePaymentFeatureKeys(value.featureKeys) === null) return false;
  return value.kind === 'SUBSCRIPTION'
    ? (value.interval === 'month' || value.interval === 'year') && (value.featureKeys as unknown[]).length > 0
    : value.kind === 'REFERRAL' && value.interval === null && value.intervalCount === 1 &&
      value.amountCents === REFERRAL_ONE_TIME_AMOUNT_USD_CENTS && value.currency === REFERRAL_ONE_TIME_CURRENCY && (value.featureKeys as unknown[]).length === 0;
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function envelope(value: Record<string, unknown>): boolean { return value.schemaVersion === AGENT_HTTP_SCHEMA_VERSION; }
function positiveInteger(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) > 0; }
function nullableDate(value: unknown): boolean { return value === null || parseIsoDateTime(value) !== null; }
function offers(value: unknown): boolean { return Array.isArray(value) && value.length <= 100 && value.every((row) => parsePaymentOfferView(row) !== null); }
function invoiceReference(value: unknown): boolean { return typeof value === 'string' && /^in_[A-Za-z0-9_]{1,250}$/.test(value); }
