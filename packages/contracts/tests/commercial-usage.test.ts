import { describe, expect, it } from 'vitest';
import {
  parseCommercialOfferRequest, parseCommercialUsageResponse, parseOfferUsageLimits,
} from '../src/commercial-usage.ts';

const offer = {
  clientRequestId: '11111111-1111-4111-8111-111111111111', key: 'software-test',
  name: 'Test offer', kind: 'SUBSCRIPTION', amountCents: 1000, currency: 'usd',
  interval: 'month', intervalCount: 1, featureKeys: ['jobs.recommend', 'analysis.use'],
};
const limit = { feature: 'ats.report', window: 'UTC_MONTH', quantity: 50 };
const usage = {
  feature: 'ats.report', unit: 'REPORT', state: 'AVAILABLE', limit: 50,
  consumed: 7, reserved: 2, remaining: 41,
  windowStart: '2026-09-01T00:00:00.000Z', resetsAt: '2026-10-01T00:00:00.000Z',
};

describe('commercial usage and immutable offer policy', () => {
  it('accepts finite limits without encoding plan names or prices into feature identity', () => {
    expect(parseCommercialOfferRequest({ offer, limits: [limit] })).not.toBeNull();
    expect(parseCommercialOfferRequest({ offer: { ...offer, key: 'annual-custom', interval: 'year' }, limits: [limit] })).not.toBeNull();
  });

  it('rejects ambiguous duplicate windows, invented privileges and implicit unlimited usage', () => {
    for (const limits of [
      [limit, limit], [limit, { ...limit, window: 'UTC_DAY' }],
      [{ ...limit, quantity: null }], [{ ...limit, quantity: -1 }],
      [{ ...limit, quantity: 1.5 }], [{ ...limit, quantity: Number.MAX_SAFE_INTEGER }],
      [{ ...limit, feature: 'admin' }], [{ ...limit, window: 'SESSION' }],
      [{ ...limit, quantity: 50, carryOver: true }],
    ]) expect(parseOfferUsageLimits(limits)).toBeNull();
    expect(parseOfferUsageLimits([{ ...limit, quantity: 0 }])).not.toBeNull();
  });

  it('rejects nonzero Referral tiers before persistence', () => {
    const referral = { ...offer, kind: 'REFERRAL', amountCents: 4900, interval: null, featureKeys: [] };
    expect(parseCommercialOfferRequest({ offer: referral, limits: [], tier: 0 })).not.toBeNull();
    expect(parseCommercialOfferRequest({ offer: referral, limits: [], tier: 1 })).toBeNull();
  });

  it('cannot sell usage without its software feature or attach software quotas to a Referral', () => {
    expect(parseCommercialOfferRequest({ offer: { ...offer, featureKeys: ['chat.use'] }, limits: [limit] })).toBeNull();
    expect(parseCommercialOfferRequest({ offer: { ...offer, kind: 'REFERRAL', interval: null,
      amountCents: 4900, featureKeys: [] }, limits: [limit] })).toBeNull();
    expect(parseCommercialOfferRequest({ offer, limits: [limit], refundPolicy: 'anything' })).toBeNull();
  });

  it('validates server arithmetic, time windows and unavailable states before UI can show a balance', () => {
    const wrap = (row: unknown) => ({ schemaVersion: 1, usage: [row] });
    expect(parseCommercialUsageResponse(wrap(usage))).not.toBeNull();
    for (const row of [
      { ...usage, remaining: 50 }, { ...usage, unit: 'SECOND' },
      { ...usage, consumed: -1 }, { ...usage, state: 'SYNC_REQUIRED' },
      { ...usage, resetsAt: usage.windowStart }, { ...usage, limit: null },
      { ...usage, state: 'EXHAUSTED' },
    ]) expect(parseCommercialUsageResponse(wrap(row))).toBeNull();
    expect(parseCommercialUsageResponse(wrap({ ...usage, state: 'EXHAUSTED', consumed: 60, reserved: 0, remaining: 0 }))).not.toBeNull();
    expect(parseCommercialUsageResponse(wrap({ ...usage, state: 'SYNC_REQUIRED', limit: 0, consumed: 7, reserved: 2, remaining: 0 }))).not.toBeNull();
    expect(parseCommercialUsageResponse({ schemaVersion: 1, usage: [usage, usage] })).toBeNull();
  });
});
