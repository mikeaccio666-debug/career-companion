import { describe, expect, it } from 'vitest';
import {
  ADMIN_POLICY_MODULE_IDS,
  RECOMMENDATION_POLICY_CRITERIA,
  STRICTEST_RECOMMENDATION_POLICY_DOCUMENT,
  adminPolicyVersionTag,
  parseAdminPolicyDocument,
  parseAdminPolicyResponse,
  parseCreateAdminPolicyDraftRequest,
  parseListAdminPoliciesResponse,
  parseRecommendationPolicyDocument,
  parseConfirmRecommendationItemRequest,
  parseConfirmRecommendationItemResponse,
  LOCATION_TIERS,
  PENDING_CONFIRMATION_CODES,
  PROFILE_V2_SCALAR_PATHS,
} from '../src/index.ts';

const flagAll = {
  ...STRICTEST_RECOMMENDATION_POLICY_DOCUMENT,
  locationMode: 'TIERS',
  unresolvedHandling: Object.fromEntries(RECOMMENDATION_POLICY_CRITERIA.map((criterion) => [criterion, 'FLAG'])),
  maxFlaggedShare: 0.4,
  batchSize: 30,
  exposureCooldownDays: 14,
  postingWindowDays: 30,
};
const view = (overrides: Record<string, unknown> = {}) => ({
  moduleId: 'recommendation', version: 3, state: 'ACTIVE', schemaVersion: 1, document: flagAll,
  createdAt: '2026-09-14T00:00:00Z', publishedAt: '2026-09-14T01:00:00Z', retiredAt: null, ...overrides,
});

describe('admin policy documents', () => {
  it('accepts the strictest preset and a fully flagged document, and rejects out-of-bounds or partial ones', () => {
    expect(parseRecommendationPolicyDocument(STRICTEST_RECOMMENDATION_POLICY_DOCUMENT)).toEqual(STRICTEST_RECOMMENDATION_POLICY_DOCUMENT);
    expect(parseRecommendationPolicyDocument(flagAll)).toEqual(flagAll);
    for (const broken of [
      { ...flagAll, schemaVersion: 2 },
      { ...flagAll, locationMode: 'OPEN' },
      { ...flagAll, unresolvedHandling: { ...flagAll.unresolvedHandling, LEVEL: 'ASK' } },
      { ...flagAll, unresolvedHandling: Object.fromEntries(Object.entries(flagAll.unresolvedHandling).filter(([key]) => key !== 'MUST_HAVE')) },
      { ...flagAll, maxFlaggedShare: 1.5 },
      { ...flagAll, maxFlaggedShare: '0.4' },
      { ...flagAll, batchSize: 51 },
      { ...flagAll, batchSize: 0 },
      { ...flagAll, exposureCooldownDays: 2.5 },
      { ...flagAll, postingWindowDays: 0 },
      { ...flagAll, extra: true },
      null, 'TIERS', [],
    ]) expect(parseRecommendationPolicyDocument(broken)).toBeNull();
    expect(parseAdminPolicyDocument('recommendation', flagAll)).toEqual(flagAll);
    expect(parseAdminPolicyDocument('unknown-module', flagAll)).toBeNull();
    expect(ADMIN_POLICY_MODULE_IDS).toEqual(['recommendation']);
  });

  it('derives the version tag a batch records and refuses invented ones', () => {
    expect(adminPolicyVersionTag('recommendation', 3)).toBe('recommendation:3');
    expect(() => adminPolicyVersionTag('recommendation', 0)).toThrow('ADMIN_POLICY_VERSION_INVALID');
    expect(() => adminPolicyVersionTag('payments' as never, 1)).toThrow('ADMIN_POLICY_VERSION_INVALID');
  });

  it('validates the wire views with their state invariants and one active version per module', () => {
    expect(parseAdminPolicyResponse({ schemaVersion: 1, policy: view() })).not.toBeNull();
    expect(parseAdminPolicyResponse({ schemaVersion: 1, policy: view({ state: 'DRAFT', publishedAt: null }) })).not.toBeNull();
    for (const broken of [
      view({ state: 'DRAFT' }),
      view({ state: 'ACTIVE', publishedAt: null }),
      view({ state: 'RETIRED' }),
      view({ document: { ...flagAll, batchSize: 99 } }),
      view({ moduleId: 'payments' }),
      view({ version: 0 }),
      view({ createdAt: 'yesterday' }),
    ]) expect(parseAdminPolicyResponse({ schemaVersion: 1, policy: broken })).toBeNull();
    const list = { schemaVersion: 1, moduleId: 'recommendation', active: view(),
      versions: [view(), view({ version: 2, state: 'RETIRED', retiredAt: '2026-09-14T01:00:00Z' }), view({ version: 1, state: 'DRAFT', publishedAt: null })] };
    expect(parseListAdminPoliciesResponse(list)).not.toBeNull();
    expect(parseListAdminPoliciesResponse({ ...list, active: view({ state: 'DRAFT', publishedAt: null }) })).toBeNull();
    expect(parseListAdminPoliciesResponse({ ...list, versions: [view(), view()] })).toBeNull();
    expect(parseListAdminPoliciesResponse({ ...list, versions: [view(), view({ version: 2 })] })).toBeNull();
    expect(parseListAdminPoliciesResponse({ ...list, active: null })).not.toBeNull();
    expect(parseCreateAdminPolicyDraftRequest({ document: flagAll })).not.toBeNull();
    expect(parseCreateAdminPolicyDraftRequest({ document: 'x' })).toBeNull();
    expect(parseCreateAdminPolicyDraftRequest({ document: flagAll, publish: true })).toBeNull();
  });
});

describe('recommendation item confirmations and flagged card fields', () => {
  it('accepts a LOCATION confirmation with at least one mobility fact', () => {
    expect(parseConfirmRecommendationItemRequest({ criterion: 'LOCATION', remoteOk: true })).not.toBeNull();
    expect(parseConfirmRecommendationItemRequest({ criterion: 'LOCATION', relocationMode: 'OPEN_WITHIN_COUNTRIES', relocationCountryCodes: ['US', 'CA'] })).not.toBeNull();
    for (const broken of [
      { criterion: 'LOCATION' },
      { criterion: 'GRADUATION', remoteOk: true },
      { criterion: 'LOCATION', remoteOk: 'yes' },
      { criterion: 'LOCATION', relocationMode: 'MAYBE' },
      { criterion: 'LOCATION', relocationCountryCodes: ['usa'] },
      { criterion: 'LOCATION', relocationCountryCodes: ['US', 'US'] },
      { criterion: 'LOCATION', remoteOk: true, extra: 1 },
    ]) expect(parseConfirmRecommendationItemRequest(broken)).toBeNull();
    expect(parseConfirmRecommendationItemResponse({ schemaVersion: 1, criterion: 'LOCATION', profileRevision: '12' })).not.toBeNull();
    expect(parseConfirmRecommendationItemResponse({ schemaVersion: 1, criterion: 'LOCATION', profileRevision: '012' })).toBeNull();
  });

  it('pins the closed tier and confirmation code sets and the Profile V2 scalar tail', () => {
    expect(LOCATION_TIERS).toEqual(['A', 'B', 'C']);
    expect(PENDING_CONFIRMATION_CODES).toEqual(['SPONSORSHIP', 'LOCATION', 'GRADUATION', 'LEVEL', 'EXPERIENCE', 'EDUCATION', 'REQUIRED_SKILL']);
    // argoland 2026-09 的契约变更把 `mobility.*` 三项换成了一个 `referralSource`。
    // 权威在 argoland，这边跟版（RULE-EXT-CONTRACT-CONSUMER）。
    // 2026-09-21 填写键扩展（argoland #535）又在后面加了 8 条，尾巴是「是否年满 18」。
    expect(PROFILE_V2_SCALAR_PATHS.slice(-1)).toEqual(['eligibility.over18']);
  });
});
