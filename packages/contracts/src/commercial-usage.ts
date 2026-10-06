import { AGENT_HTTP_SCHEMA_VERSION, parseIsoDateTime, type AgentSchemaEnvelope, type IsoDateTime } from './common.ts';
import {
  parseCreatePaymentOfferRequest, parsePaymentFeatureKeys, parsePaymentOfferView,
  parsePaymentEntitlementView, type PaymentEntitlementView,
  type CreatePaymentOfferRequest, type PaymentFeatureKey, type PaymentOfferView,
} from './payment-catalog.ts';

/** Meter identity survives offer changes. Intake remains governed by its approved S4 policy. */
export const COMMERCIAL_USAGE_FEATURES = ['jobs.delivered', 'ats.report', 'intake.reply', 'intake.audio'] as const;
export type CommercialUsageFeature = typeof COMMERCIAL_USAGE_FEATURES[number];
export const OFFER_USAGE_FEATURES = ['jobs.delivered', 'ats.report'] as const;
export type OfferUsageFeature = typeof OFFER_USAGE_FEATURES[number];
export const OFFER_USAGE_WINDOWS = ['UTC_DAY', 'UTC_MONTH'] as const;
export type OfferUsageWindow = typeof OFFER_USAGE_WINDOWS[number];
export const COMMERCIAL_USAGE_UNITS = {
  'jobs.delivered': 'JOB', 'ats.report': 'REPORT', 'intake.reply': 'REPLY', 'intake.audio': 'SECOND',
} as const;
export const OFFER_USAGE_ACCESS: Readonly<Record<OfferUsageFeature, PaymentFeatureKey>> = {
  'jobs.delivered': 'jobs.recommend', 'ats.report': 'analysis.use',
};
export interface OfferUsageLimit {
  readonly feature: OfferUsageFeature;
  readonly window: OfferUsageWindow;
  readonly quantity: number;
}
/** Separate endpoint preserves the existing closed v1 catalog decoders. Missing meters grant zero. */
export interface CommercialOfferRequest {
  readonly offer: CreatePaymentOfferRequest;
  /** Comparable catalog level. Equal levels change billing at the next renewal. */
  readonly tier?: number;
  readonly limits: readonly OfferUsageLimit[];
}
export interface CommercialOfferView {
  readonly offer: PaymentOfferView;
  readonly tier?: number;
  readonly limits: readonly OfferUsageLimit[];
}
export interface CommercialOfferResponse extends AgentSchemaEnvelope { readonly offer: CommercialOfferView }
export interface CommercialAdminCatalogResponse extends AgentSchemaEnvelope {
  readonly offers: readonly CommercialOfferView[];
  readonly featureKeys: readonly PaymentFeatureKey[];
}
export interface CommercialCatalogResponse extends AgentSchemaEnvelope {
  readonly offers: readonly CommercialOfferView[];
  readonly currentOffer: CommercialOfferView | null;
  readonly entitlement: PaymentEntitlementView;
}
export interface CommercialUsageView {
  readonly feature: CommercialUsageFeature;
  readonly unit: typeof COMMERCIAL_USAGE_UNITS[CommercialUsageFeature];
  readonly state: 'AVAILABLE' | 'EXHAUSTED' | 'DENIED' | 'SYNC_REQUIRED';
  readonly limit: number;
  readonly consumed: number;
  readonly reserved: number;
  readonly remaining: number;
  readonly windowStart: IsoDateTime;
  readonly resetsAt: IsoDateTime;
}
export interface CommercialUsageResponse extends AgentSchemaEnvelope { readonly usage: readonly CommercialUsageView[] }

export function parseOfferUsageLimits(value: unknown): readonly OfferUsageLimit[] | null {
  if (!Array.isArray(value) || value.length > OFFER_USAGE_FEATURES.length ||
    !value.every((row) => exact(row, ['feature', 'window', 'quantity']) &&
      OFFER_USAGE_FEATURES.includes(row.feature as OfferUsageFeature) &&
      OFFER_USAGE_WINDOWS.includes(row.window as OfferUsageWindow) && count(row.quantity) && Number(row.quantity) <= 1_000_000) ||
    new Set(value.map((row) => row.feature)).size !== value.length) return null;
  return value as readonly OfferUsageLimit[];
}
export function parseCommercialOfferRequest(value: unknown): CommercialOfferRequest | null {
  if (!(exact(value, ['offer', 'limits']) || exact(value, ['offer', 'limits', 'tier'])) || (value.tier !== undefined && (!count(value.tier) || Number(value.tier) > 1000))) return null;
  const offer = parseCreatePaymentOfferRequest(value.offer);
  const limits = parseOfferUsageLimits(value.limits);
  return offer && limits && compatible(offer, limits, value.tier) ? { offer, limits, ...(value.tier !== undefined ? {tier:Number(value.tier)} : {}) } : null;
}
export function parseCommercialOfferView(value: unknown): CommercialOfferView | null {
  if (!(exact(value, ['offer', 'limits']) || exact(value, ['offer', 'limits', 'tier'])) || (value.tier !== undefined && (!count(value.tier) || Number(value.tier) > 1000))) return null;
  const offer = parsePaymentOfferView(value.offer);
  const limits = parseOfferUsageLimits(value.limits);
  return offer && limits && compatible(offer, limits, value.tier) ? { offer, limits, ...(value.tier !== undefined ? {tier:Number(value.tier)} : {}) } : null;
}
export function parseCommercialOfferResponse(value: unknown): CommercialOfferResponse | null {
  return exact(value, ['schemaVersion', 'offer']) && value.schemaVersion === AGENT_HTTP_SCHEMA_VERSION &&
    parseCommercialOfferView(value.offer) ? value as unknown as CommercialOfferResponse : null;
}
export function parseCommercialAdminCatalogResponse(value: unknown): CommercialAdminCatalogResponse | null {
  return exact(value, ['schemaVersion', 'offers', 'featureKeys']) && value.schemaVersion === AGENT_HTTP_SCHEMA_VERSION &&
    Array.isArray(value.offers) && value.offers.length <= 100 && value.offers.every((row) => parseCommercialOfferView(row)) &&
    parsePaymentFeatureKeys(value.featureKeys)
    ? value as unknown as CommercialAdminCatalogResponse : null;
}
export function parseCommercialCatalogResponse(value: unknown): CommercialCatalogResponse | null {
  return exact(value, ['schemaVersion', 'offers', 'currentOffer', 'entitlement']) && value.schemaVersion === AGENT_HTTP_SCHEMA_VERSION &&
    Array.isArray(value.offers) && value.offers.length <= 100 && value.offers.every((row) => parseCommercialOfferView(row)) &&
    (value.currentOffer === null || parseCommercialOfferView(value.currentOffer)) && parsePaymentEntitlementView(value.entitlement)
    ? value as unknown as CommercialCatalogResponse : null;
}
export function parseCommercialUsageResponse(value: unknown): CommercialUsageResponse | null {
  if (!exact(value, ['schemaVersion', 'usage']) || value.schemaVersion !== AGENT_HTTP_SCHEMA_VERSION ||
    !Array.isArray(value.usage) || value.usage.length > COMMERCIAL_USAGE_FEATURES.length ||
    !value.usage.every(validUsage) || new Set(value.usage.map((row) => row.feature)).size !== value.usage.length) return null;
  return value as unknown as CommercialUsageResponse;
}
function validUsage(value: unknown): value is CommercialUsageView {
  if (!exact(value, ['feature', 'unit', 'state', 'limit', 'consumed', 'reserved', 'remaining', 'windowStart', 'resetsAt']) ||
    !COMMERCIAL_USAGE_FEATURES.includes(value.feature as CommercialUsageFeature) ||
    value.unit !== COMMERCIAL_USAGE_UNITS[value.feature as CommercialUsageFeature] ||
    !['AVAILABLE', 'EXHAUSTED', 'DENIED', 'SYNC_REQUIRED'].includes(String(value.state)) ||
    ![value.limit, value.consumed, value.reserved, value.remaining].every(count) ||
    !Number.isSafeInteger(Number(value.consumed) + Number(value.reserved)) ||
    !parseIsoDateTime(value.windowStart) || !parseIsoDateTime(value.resetsAt) ||
    Date.parse(String(value.windowStart)) >= Date.parse(String(value.resetsAt))) return false;
  const remaining = Math.max(0, Number(value.limit) - Number(value.consumed) - Number(value.reserved));
  if (value.remaining !== remaining) return false;
  if (value.state === 'DENIED' || value.state === 'SYNC_REQUIRED') return value.limit === 0 && value.remaining === 0;
  return value.state === 'AVAILABLE' ? remaining > 0 : remaining === 0;
}
function compatible(offer: Pick<CreatePaymentOfferRequest, 'kind' | 'featureKeys'>, limits: readonly OfferUsageLimit[], tier: unknown): boolean {
  return offer.kind === 'REFERRAL' ? limits.length === 0 && (tier === undefined || tier === 0) : limits.every((row) => offer.featureKeys.includes(OFFER_USAGE_ACCESS[row.feature]));
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function count(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0; }
