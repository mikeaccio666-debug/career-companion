import { describe, expect, it } from 'vitest';
import {
  PAYMENTS_ENDPOINTS,
  parseCancelSubscriptionResponse,
  parseCreateSubscriptionCheckoutResponse,
  parseCreatePaymentMethodPortalResponse,
  parseGetWebsiteSubscriptionResponse,
  STANDARD_SUBSCRIPTION_CURRENCY,
  STANDARD_SUBSCRIPTION_INTERVAL,
  STANDARD_SUBSCRIPTION_MONTHLY_AMOUNT_USD_CENTS,
  STANDARD_SUBSCRIPTION_REMINDER_LEAD_HOURS,
  STANDARD_SUBSCRIPTION_TRIAL_DAYS,
  WEBSITE_ACCESS_STATES,
  REFERRAL_COMMERCE_STATES,
  REFERRAL_ONE_TIME_AMOUNT_USD_CENTS,
  REFERRAL_ONE_TIME_CURRENCY,
  REFERRAL_REFUND_POLICY_VERSION,
  parseExecuteReferralRefundResponse,
  parseReferralCommerceView,
} from '../src/index.ts';

describe('T24 standard subscription contracts', () => {
  it('freezes the approved MVP catalog', () => {
    expect(STANDARD_SUBSCRIPTION_TRIAL_DAYS).toBe(3);
    expect(STANDARD_SUBSCRIPTION_MONTHLY_AMOUNT_USD_CENTS).toBe(4_900);
    expect(STANDARD_SUBSCRIPTION_CURRENCY).toBe('usd');
    expect(STANDARD_SUBSCRIPTION_INTERVAL).toBe('month');
    expect(STANDARD_SUBSCRIPTION_REMINDER_LEAD_HOURS).toBe(24);
  });

  it('keeps cancellation immediate and the Stripe webhook signed', () => {
    expect(PAYMENTS_ENDPOINTS.cancelSubscription).toEqual({
      method: 'POST',
      path: '/payments/subscription/cancel',
      auth: 'bearer',
    });
    expect(PAYMENTS_ENDPOINTS.stripeWebhook.auth).toBe('stripe-signature');
  });

  it('grants access only for the onboarding trial or a live Stripe subscription', () => {
    expect(WEBSITE_ACCESS_STATES).toEqual([
      'NONE',
      'ONBOARDING_TRIAL',
      'TRIALING',
      'ACTIVE',
      'PAST_DUE',
      'CANCELED',
      'UNPAID',
      'INCOMPLETE',
    ]);
  });

  it('parses only exact subscription response shapes', () => {
    const catalog = {
      trialDays: 3,
      amountUsdCents: 4_900,
      currency: 'usd',
      interval: 'month',
      includesAllCurrentWebsiteSoftwareFeatures: true,
      excludesOneOffHumanServices: true,
      promotionCodesAcceptedAtCheckout: true,
      trialReminderLeadHours: 24,
      renewalReminderLeadHours: 24,
    } as const;
    expect(parseGetWebsiteSubscriptionResponse({
      schemaVersion: 1,
      access: true,
      state: 'TRIALING',
      subscriptionId: '11111111-1111-4111-8111-111111111111',
      currentPeriodEndsAt: '2026-09-01T00:00:00.000Z',
      catalog,
    })?.state).toBe('TRIALING');
    expect(parseGetWebsiteSubscriptionResponse({
      schemaVersion: 1,
      access: true,
      state: 'ONBOARDING_TRIAL',
      subscriptionId: null,
      currentPeriodEndsAt: '2026-09-03T12:00:00.000Z',
      catalog,
    })?.state).toBe('ONBOARDING_TRIAL');
    expect(parseGetWebsiteSubscriptionResponse({
      schemaVersion: 1,
      access: true,
      state: 'CANCELED',
      subscriptionId: null,
      currentPeriodEndsAt: null,
      catalog,
    })).toBeNull();
    expect(parseCreateSubscriptionCheckoutResponse({
      schemaVersion: 1,
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_123',
    })?.checkoutUrl).toContain('checkout.stripe.com');
    expect(parseCreatePaymentMethodPortalResponse({
      schemaVersion: 1,
      paymentMethodPortalUrl: 'https://billing.stripe.com/p/session/test_123',
    })?.paymentMethodPortalUrl).toContain('billing.stripe.com');
    expect(parseCancelSubscriptionResponse({
      schemaVersion: 1,
      access: false,
      state: 'CANCELED',
      subscriptionId: '11111111-1111-4111-8111-111111111111',
      currentPeriodEndsAt: '2026-09-01T00:00:00.000Z',
      catalog,
      canceledImmediately: true,
      refundStatus: 'NO_REFUND',
      creditStatus: 'NO_CREDIT',
    })).toMatchObject({
      canceledImmediately: true,
      refundStatus: 'NO_REFUND',
      creditStatus: 'NO_CREDIT',
    });
  });
});

describe('T19/T14-7 referral refund contract', () => {
  it('freezes the approved $49 USD one-time referral price', () => {
    expect(REFERRAL_ONE_TIME_AMOUNT_USD_CENTS).toBe(4_900);
    expect(REFERRAL_ONE_TIME_CURRENCY).toBe('usd');
  });

  it('pins a full original-payment policy without exposing provider IDs', () => {
    expect(REFERRAL_REFUND_POLICY_VERSION).toBe('referral-full-original-payment-v1');
    expect(REFERRAL_COMMERCE_STATES).toEqual([
      'NOT_PURCHASED',
      'CHECKOUT_PENDING',
      'PAID',
      'REFUND_REQUESTED',
      'REFUND_PROCESSING',
      'REFUNDED',
      'RECONCILIATION_REQUIRED',
    ]);
  });

  it('strictly parses the Admin commerce projection', () => {
    const view = {
      schemaVersion: 1,
      referralRequestId: '11111111-1111-4111-8111-111111111111',
      orderReference: '22222222-2222-4222-8222-222222222222',
      state: 'REFUND_REQUESTED',
      amountPaidCents: 19_900,
      currency: 'usd',
      refundableAmountCents: 19_900,
      refundPolicyVersion: 'referral-full-original-payment-v1',
      providerReconciledAt: null,
    };
    expect(parseReferralCommerceView(view)?.state).toBe('REFUND_REQUESTED');
    expect(parseReferralCommerceView({ ...view, stripePaymentIntentId: 'pi_secret' })).toBeNull();
    expect(parseExecuteReferralRefundResponse({ schemaVersion: 1, commerce: view })?.commerce)
      .toMatchObject({ state: 'REFUND_REQUESTED' });
  });
});
