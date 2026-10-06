import { AGENT_HTTP_SCHEMA_VERSION, parseIsoDateTime, parseUuid, type AgentSchemaEnvelope, type IsoDateTime, type Uuid } from './common.ts';
import { PAYMENT_CATALOG_CURRENCIES, SUBSCRIPTION_POLICY_VERSION, SUBSCRIPTION_PERIOD_END_POLICY_VERSION, stripeInvoiceUrl } from './payment-catalog.ts';
import { WEBSITE_ACCESS_STATES, type WebsiteAccessState } from './payments.ts';

export { SUBSCRIPTION_PERIOD_END_POLICY_VERSION } from './payment-catalog.ts';
export const SUBSCRIPTION_CHANGE_KINDS = ['UPGRADE', 'DOWNGRADE', 'BILLING_PERIOD_CHANGE'] as const;
export const SUBSCRIPTION_CHANGE_STATES = ['QUOTED', 'PROCESSING', 'PAYMENT_PENDING', 'SCHEDULED', 'APPLIED', 'CANCELED', 'FAILED', 'RECONCILIATION_REQUIRED'] as const;
export const SUBSCRIPTION_REFUND_REASONS = ['PURCHASE_MISTAKE', 'DUPLICATE_CHARGE', 'SERVICE_ISSUE', 'OTHER'] as const;
export const SUBSCRIPTION_REFUND_STATES = ['REQUESTED', 'DECLINED', 'PROCESSING', 'PENDING', 'SUCCEEDED', 'FAILED', 'RECONCILIATION_REQUIRED'] as const;
export const SUBSCRIPTION_REFUND_REVIEW_REASONS = ['APPROVED', 'NOT_ELIGIBLE', 'DUPLICATE', 'CUSTOMER_WITHDREW'] as const;
export const SUBSCRIPTION_REFUND_ACCESS_EFFECTS = ['NONE', 'WILL_TERMINATE', 'TERMINATION_PENDING', 'TERMINATED', 'REVIEW_REQUIRED'] as const;
export type SubscriptionChangeKind = typeof SUBSCRIPTION_CHANGE_KINDS[number];
export type SubscriptionChangeState = typeof SUBSCRIPTION_CHANGE_STATES[number];
export type SubscriptionRefundReason = typeof SUBSCRIPTION_REFUND_REASONS[number];
export type SubscriptionRefundState = typeof SUBSCRIPTION_REFUND_STATES[number];
export type SubscriptionRefundReviewReason = typeof SUBSCRIPTION_REFUND_REVIEW_REASONS[number];
export type SubscriptionRefundAccessEffect = typeof SUBSCRIPTION_REFUND_ACCESS_EFFECTS[number];

export interface ManagedSubscription {
  readonly id: Uuid;
  readonly offerId: Uuid | null;
  readonly state: WebsiteAccessState;
  readonly currentPeriodStartsAt: IsoDateTime | null;
  readonly currentPeriodEndsAt: IsoDateTime | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly policyVersion: string;
}
export interface SubscriptionOperationRetryRequest { readonly operationId: Uuid }
export function parseSubscriptionOperationRetryRequest(value:unknown):SubscriptionOperationRetryRequest|null {
  return exact(value,['operationId']) && parseUuid(value.operationId) ? value as unknown as SubscriptionOperationRetryRequest : null;
}
export interface SubscriptionRenewalRequest {
  readonly clientRequestId: Uuid;
  readonly subscriptionId: Uuid;
  readonly expectedPeriodEndsAt: IsoDateTime;
  readonly renew: boolean;
}
export interface SubscriptionRenewalOperation {
  readonly id: Uuid;
  readonly subscriptionId: Uuid;
  readonly renew: boolean;
  readonly state: 'PENDING' | 'CONFIRMED' | 'FAILED' | 'RECONCILIATION_REQUIRED';
  readonly createdAt: IsoDateTime;
}
export interface SubscriptionRenewalResponse extends AgentSchemaEnvelope { readonly operation: SubscriptionRenewalOperation }
export interface SubscriptionChangeRequest { readonly subscriptionId: Uuid; readonly targetOfferId: Uuid }
export interface SubscriptionChangeQuote extends AgentSchemaEnvelope {
  readonly id: Uuid;
  readonly subscriptionId: Uuid;
  readonly currentOfferId: Uuid;
  readonly targetOfferId: Uuid;
  readonly kind: SubscriptionChangeKind;
  /** Exact provider preview; upgrades cannot silently create a negative credit. */
  readonly amountDueCents: number;
  readonly currency: string;
  readonly effectiveAt: IsoDateTime;
  readonly expiresAt: IsoDateTime;
  readonly policyVersion: typeof SUBSCRIPTION_PERIOD_END_POLICY_VERSION;
}
export interface ConfirmSubscriptionChangeRequest { readonly clientRequestId: Uuid; readonly quoteId: Uuid }
export interface CancelSubscriptionChangeRequest { readonly clientRequestId: Uuid; readonly changeId: Uuid }
export interface SubscriptionChangeView extends Omit<SubscriptionChangeQuote, 'schemaVersion'> {
  readonly state: SubscriptionChangeState;
  readonly paymentUrl: string | null;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}
export interface SubscriptionChangeResponse extends AgentSchemaEnvelope { readonly change: SubscriptionChangeView }
export interface SubscriptionManagementResponse extends AgentSchemaEnvelope {
  readonly subscription: ManagedSubscription | null;
  readonly renewal: SubscriptionRenewalOperation | null;
  readonly changes: readonly SubscriptionChangeView[];
}
export interface SubscriptionRefundQuote extends AgentSchemaEnvelope {
  readonly invoiceReference: string;
  readonly subscriptionId: Uuid;
  readonly policyVersion: typeof SUBSCRIPTION_PERIOD_END_POLICY_VERSION;
  readonly paidCents: number;
  readonly refundedCents: number;
  readonly pendingCents: number;
  readonly refundableCents: number;
  readonly currency: string;
  /** The reviewed service period, not an authorization to revoke a later purchase. */
  readonly currentPeriodEndsAt: IsoDateTime | null;
  readonly fullRefundTerminates: true;
  readonly createdAt: IsoDateTime;
}
export interface SubscriptionRefundRequest {
  readonly clientRequestId: Uuid;
  readonly invoiceReference: string;
  readonly amountCents: number;
  readonly reason: SubscriptionRefundReason;
}
export interface SubscriptionRefundReviewRequest {
  readonly clientRequestId: Uuid;
  readonly expectedRevision: number;
  readonly decision: 'APPROVE' | 'DECLINE';
  readonly reason: SubscriptionRefundReviewReason;
}
export interface SubscriptionRefundAccessReviewRequest {
  readonly clientRequestId:Uuid;
  readonly expectedRevision:number;
  readonly decision:'KEEP_LATER_PURCHASE';
}
export function parseSubscriptionRefundAccessReviewRequest(value:unknown):SubscriptionRefundAccessReviewRequest|null {
  return exact(value,['clientRequestId','expectedRevision','decision']) && parseUuid(value.clientRequestId) &&
    Number.isSafeInteger(value.expectedRevision) && Number(value.expectedRevision)>0 && value.decision==='KEEP_LATER_PURCHASE'
    ? value as unknown as SubscriptionRefundAccessReviewRequest : null;
}
export interface SubscriptionRefundView {
  readonly id: Uuid;
  readonly ownerId: Uuid;
  readonly subscriptionId: Uuid;
  readonly invoiceReference: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly reason: SubscriptionRefundReason;
  readonly state: SubscriptionRefundState;
  readonly revision: number;
  readonly reviewReason: SubscriptionRefundReviewReason | null;
  readonly accessEffect: SubscriptionRefundAccessEffect;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}
export interface SubscriptionRefundResponse extends AgentSchemaEnvelope { readonly refund: SubscriptionRefundView }
export interface SubscriptionRefundListResponse extends AgentSchemaEnvelope {
  readonly refunds: readonly SubscriptionRefundView[];
  readonly nextCursor: Uuid | null;
}

export function parseSubscriptionRenewalRequest(value: unknown): SubscriptionRenewalRequest | null {
  return exact(value, ['clientRequestId', 'subscriptionId', 'expectedPeriodEndsAt', 'renew']) &&
    parseUuid(value.clientRequestId) && parseUuid(value.subscriptionId) && parseIsoDateTime(value.expectedPeriodEndsAt) && typeof value.renew === 'boolean'
    ? value as unknown as SubscriptionRenewalRequest : null;
}
export function parseSubscriptionRenewalOperation(value: unknown): SubscriptionRenewalOperation | null {
  return exact(value, ['id', 'subscriptionId', 'renew', 'state', 'createdAt']) && parseUuid(value.id) && parseUuid(value.subscriptionId) &&
    typeof value.renew === 'boolean' && ['PENDING', 'CONFIRMED', 'FAILED', 'RECONCILIATION_REQUIRED'].includes(String(value.state)) && parseIsoDateTime(value.createdAt)
    ? value as unknown as SubscriptionRenewalOperation : null;
}
export function parseSubscriptionRenewalResponse(value: unknown): SubscriptionRenewalResponse | null {
  return envelope(value, ['operation']) && parseSubscriptionRenewalOperation(value.operation) ? value as unknown as SubscriptionRenewalResponse : null;
}
export function parseSubscriptionChangeRequest(value: unknown): SubscriptionChangeRequest | null {
  return exact(value, ['subscriptionId', 'targetOfferId']) && parseUuid(value.subscriptionId) && parseUuid(value.targetOfferId)
    ? value as unknown as SubscriptionChangeRequest : null;
}
export function parseConfirmSubscriptionChangeRequest(value: unknown): ConfirmSubscriptionChangeRequest | null {
  return exact(value, ['clientRequestId', 'quoteId']) && parseUuid(value.clientRequestId) && parseUuid(value.quoteId)
    ? value as unknown as ConfirmSubscriptionChangeRequest : null;
}
export function parseCancelSubscriptionChangeRequest(value: unknown): CancelSubscriptionChangeRequest | null {
  return exact(value, ['clientRequestId', 'changeId']) && parseUuid(value.clientRequestId) && parseUuid(value.changeId)
    ? value as unknown as CancelSubscriptionChangeRequest : null;
}
const changeKeys = ['id', 'subscriptionId', 'currentOfferId', 'targetOfferId', 'kind', 'amountDueCents', 'currency', 'effectiveAt', 'expiresAt', 'policyVersion'];
function validChange(value: Record<string, unknown>): boolean {
  return !!parseUuid(value.id) && !!parseUuid(value.subscriptionId) && !!parseUuid(value.currentOfferId) && !!parseUuid(value.targetOfferId) && value.currentOfferId !== value.targetOfferId &&
    SUBSCRIPTION_CHANGE_KINDS.includes(value.kind as SubscriptionChangeKind) && amount(value.amountDueCents) && currency(value.currency) &&
    (value.kind === 'UPGRADE' || value.amountDueCents === 0) && !!parseIsoDateTime(value.effectiveAt) && !!parseIsoDateTime(value.expiresAt) &&
    value.policyVersion === SUBSCRIPTION_PERIOD_END_POLICY_VERSION;
}
export function parseSubscriptionChangeQuote(value: unknown): SubscriptionChangeQuote | null {
  return envelope(value, changeKeys) && validChange(value) ? value as unknown as SubscriptionChangeQuote : null;
}
export function parseSubscriptionChangeView(value: unknown): SubscriptionChangeView | null {
  return exact(value, [...changeKeys, 'state', 'paymentUrl', 'createdAt', 'updatedAt']) && validChange(value) &&
    SUBSCRIPTION_CHANGE_STATES.includes(value.state as SubscriptionChangeState) && (value.paymentUrl === null || stripeInvoiceUrl(value.paymentUrl)) &&
    !!parseIsoDateTime(value.createdAt) && !!parseIsoDateTime(value.updatedAt) && (value.paymentUrl === null || value.state === 'PAYMENT_PENDING')
    ? value as unknown as SubscriptionChangeView : null;
}
export function parseSubscriptionChangeResponse(value: unknown): SubscriptionChangeResponse | null {
  return envelope(value, ['change']) && parseSubscriptionChangeView(value.change) ? value as unknown as SubscriptionChangeResponse : null;
}
export function parseSubscriptionManagementResponse(value: unknown): SubscriptionManagementResponse | null {
  return envelope(value, ['subscription', 'renewal', 'changes']) && (value.subscription === null || validManaged(value.subscription)) &&
    (value.renewal === null || parseSubscriptionRenewalOperation(value.renewal)) && Array.isArray(value.changes) && value.changes.length <= 25 &&
    value.changes.every(row => parseSubscriptionChangeView(row)) ? value as unknown as SubscriptionManagementResponse : null;
}
function validManaged(value: unknown): boolean {
  return exact(value, ['id', 'offerId', 'state', 'currentPeriodStartsAt', 'currentPeriodEndsAt', 'cancelAtPeriodEnd', 'policyVersion']) &&
    !!parseUuid(value.id) && (value.offerId === null || !!parseUuid(value.offerId)) && WEBSITE_ACCESS_STATES.includes(value.state as WebsiteAccessState) &&
    (value.currentPeriodStartsAt === null || !!parseIsoDateTime(value.currentPeriodStartsAt)) &&
    (value.currentPeriodEndsAt === null || !!parseIsoDateTime(value.currentPeriodEndsAt)) && typeof value.cancelAtPeriodEnd === 'boolean' &&
    [SUBSCRIPTION_POLICY_VERSION, SUBSCRIPTION_PERIOD_END_POLICY_VERSION].includes(value.policyVersion as typeof SUBSCRIPTION_POLICY_VERSION);
}
export function parseSubscriptionRefundQuote(value: unknown): SubscriptionRefundQuote | null {
  if (!envelope(value, ['invoiceReference', 'subscriptionId', 'policyVersion', 'paidCents', 'refundedCents', 'pendingCents', 'refundableCents', 'currency',
    'currentPeriodEndsAt', 'fullRefundTerminates', 'createdAt']) || !invoiceReference(value.invoiceReference) || !parseUuid(value.subscriptionId) ||
    value.policyVersion !== SUBSCRIPTION_PERIOD_END_POLICY_VERSION || ![value.paidCents, value.refundedCents, value.pendingCents, value.refundableCents].every(amount) ||
    !currency(value.currency) || value.fullRefundTerminates !== true || !parseIsoDateTime(value.createdAt) ||
    (value.currentPeriodEndsAt !== null && !parseIsoDateTime(value.currentPeriodEndsAt))) return null;
  return Number(value.paidCents) - Number(value.refundedCents) - Number(value.pendingCents) === value.refundableCents
    ? value as unknown as SubscriptionRefundQuote : null;
}
export function parseSubscriptionRefundRequest(value: unknown): SubscriptionRefundRequest | null {
  return exact(value, ['clientRequestId', 'invoiceReference', 'amountCents', 'reason']) && parseUuid(value.clientRequestId) &&
    invoiceReference(value.invoiceReference) && amount(value.amountCents) && Number(value.amountCents) > 0 &&
    SUBSCRIPTION_REFUND_REASONS.includes(value.reason as SubscriptionRefundReason) ? value as unknown as SubscriptionRefundRequest : null;
}
export function parseSubscriptionRefundReviewRequest(value: unknown): SubscriptionRefundReviewRequest | null {
  return exact(value, ['clientRequestId', 'expectedRevision', 'decision', 'reason']) && parseUuid(value.clientRequestId) &&
    Number.isSafeInteger(value.expectedRevision) && Number(value.expectedRevision) > 0 && Number(value.expectedRevision) <= 2147483647 &&
    ['APPROVE', 'DECLINE'].includes(String(value.decision)) && SUBSCRIPTION_REFUND_REVIEW_REASONS.includes(value.reason as SubscriptionRefundReviewReason) &&
    ((value.decision === 'APPROVE') === (value.reason === 'APPROVED')) ? value as unknown as SubscriptionRefundReviewRequest : null;
}
export function parseSubscriptionRefundView(value: unknown): SubscriptionRefundView | null {
  if (!exact(value, ['id', 'ownerId', 'subscriptionId', 'invoiceReference', 'amountCents', 'currency', 'reason', 'state', 'revision', 'reviewReason',
    'accessEffect', 'createdAt', 'updatedAt']) || !parseUuid(value.id) || !parseUuid(value.ownerId) || !parseUuid(value.subscriptionId) ||
    !invoiceReference(value.invoiceReference) || !amount(value.amountCents) || Number(value.amountCents) <= 0 || !currency(value.currency) ||
    !SUBSCRIPTION_REFUND_REASONS.includes(value.reason as SubscriptionRefundReason) || !SUBSCRIPTION_REFUND_STATES.includes(value.state as SubscriptionRefundState) ||
    !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || Number(value.revision) > 2147483647 ||
    (value.reviewReason !== null && !SUBSCRIPTION_REFUND_REVIEW_REASONS.includes(value.reviewReason as SubscriptionRefundReviewReason)) ||
    !SUBSCRIPTION_REFUND_ACCESS_EFFECTS.includes(value.accessEffect as SubscriptionRefundAccessEffect) ||
    !parseIsoDateTime(value.createdAt) || !parseIsoDateTime(value.updatedAt)) return null;
  if (['TERMINATION_PENDING', 'TERMINATED', 'REVIEW_REQUIRED'].includes(String(value.accessEffect)) && value.state !== 'SUCCEEDED') return null;
  return value as unknown as SubscriptionRefundView;
}
export function parseSubscriptionRefundResponse(value: unknown): SubscriptionRefundResponse | null {
  return envelope(value, ['refund']) && parseSubscriptionRefundView(value.refund) ? value as unknown as SubscriptionRefundResponse : null;
}
export function parseSubscriptionRefundListResponse(value: unknown): SubscriptionRefundListResponse | null {
  return envelope(value, ['refunds', 'nextCursor']) && Array.isArray(value.refunds) && value.refunds.length <= 25 &&
    value.refunds.every(row => parseSubscriptionRefundView(row)) && (value.nextCursor === null || parseUuid(value.nextCursor))
    ? value as unknown as SubscriptionRefundListResponse : null;
}
function envelope(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return exact(value, ['schemaVersion', ...keys]) && value.schemaVersion === AGENT_HTTP_SCHEMA_VERSION;
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function amount(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 100_000_000; }
function currency(value: unknown): boolean { return PAYMENT_CATALOG_CURRENCIES.includes(value as typeof PAYMENT_CATALOG_CURRENCIES[number]); }
function invoiceReference(value: unknown): boolean { return typeof value === 'string' && /^in_[A-Za-z0-9_]{1,250}$/.test(value); }
