import { describe, expect, it } from 'vitest';
import { parseCreatePaymentOfferRequest, parsePaymentCatalogResponse } from '../src/payment-catalog.ts';

const draft = {
  clientRequestId: '11111111-1111-4111-8111-111111111111',
  key: 'software-yearly', name: 'Software annual test', kind: 'SUBSCRIPTION',
  amountCents: 24000, currency: 'usd', interval: 'year', intervalCount: 1,
  featureKeys: ['chat.use', 'resume.manage'],
};

describe('versioned payment catalog wire', () => {
  it('accepts a new price, interval and supported feature combination without changing the decoder', () => {
    expect(parseCreatePaymentOfferRequest(draft)).toEqual(draft);
    expect(parseCreatePaymentOfferRequest({ ...draft, amountCents: 7500, interval: 'month' })).not.toBeNull();
  });

  it('rejects invented privileges, quota authority, policy changes and one-off subscription benefits', () => {
    for (const value of [
      { ...draft, featureKeys: ['admin'] }, { ...draft, quota: 500 },
      { ...draft, trialHours: 100 }, { ...draft, amountCents: -1 },
      { ...draft, kind: 'REFERRAL', interval: null },
      { ...draft, featureKeys: ['chat.use', 'chat.use'] },
    ]) expect(parseCreatePaymentOfferRequest(value)).toBeNull();
  });

  it('does not treat an unavailable entitlement projection as access', () => {
    expect(parsePaymentCatalogResponse({ schemaVersion: 1, offers: [], currentOffer: null,
      entitlement: { source: 'SUBSCRIPTION', state: 'SYNC_REQUIRED', featureKeys: ['chat.use'],
        expiresAt: null, synchronizedAt: null } })).toBeNull();
  });
});
