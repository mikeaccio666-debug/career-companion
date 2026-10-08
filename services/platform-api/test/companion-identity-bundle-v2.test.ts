import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { companionLatinSealInitials } from '@companion/career-core';
import { expectedCompanionIdentityBundleDigest, parseCompanionIdentityBundle } from '../src/companion-identity-bundle.ts';
import { expectedCompanionIdentityReviewDigest, parseCompanionIdentityReview } from '../src/companion-identity-review.ts';

const base = () => ({ schemaVersion: 1, revision: 1, sourceRefs: { names: 'fictional-names', seals: 'fictional-standard-table', aliases: 'fictional-aliases' },
  policy: { familyOrPartner: [], teamOrOrg: [], abusive: [], publicFigures: [], allowedSealCharacters: ['墨', '舟', '朗', '如'], englishSealAliases: [{ name: 'Juno', sealChar: '如' }] } });
const v2 = () => { const old = base(); return { ...old, schemaVersion: 2, revision: 2, policy: { ...old.policy, englishSealRules: {
  normalization: 'latin_nfkd_initial_v1', initials: companionLatinSealInitials().map(spelling => ({ spelling, sealChar: '舟', reason: '虚构覆盖，只验证软件，不是发音或审核证明。' })), prefixes: [] } } }; };
const reviewer = '00000000-0000-4000-8000-000000000321';
const review = () => ({ schemaVersion: 1, bundleRevision: 1, bundleDigest: 'a'.repeat(64), coverage: 'complete_eligible_level_one',
  reviewerUserId: reviewer, reviewedAt: '2026-10-07T00:00:00.000Z', reviewEvidenceRef: 'fictional-evidence', tierOneSourceRef: 'fictional-tier-one' });

test('V1 bundle and review retain literal canonical field order/digest without acquiring V2 coverage', () => {
  for (const value of [base(), review()]) {
    const original = JSON.stringify(value), digest = createHash('sha256').update(original).digest('hex');
    if ('policy' in value) {
      assert.equal(expectedCompanionIdentityBundleDigest(value), digest);
      assert.equal(JSON.stringify(parseCompanionIdentityBundle({ ...value, contentDigest: digest })), JSON.stringify({ ...value, contentDigest: digest }));
    } else {
      assert.equal(expectedCompanionIdentityReviewDigest(value), digest);
      assert.equal(JSON.stringify(parseCompanionIdentityReview({ ...value, reviewDigest: digest })), JSON.stringify({ ...value, reviewDigest: digest }));
    }
  }
});
test('V2 finite full-domain rules and explicit review coverage enter the immutable asset digests', () => {
  const value = v2(), digest = expectedCompanionIdentityBundleDigest(value), parsed = parseCompanionIdentityBundle({ ...value, contentDigest: digest });
  assert.equal(parsed.schemaVersion, 2); assert.equal(Object.isFrozen(parsed), true);
  const nextReview = { ...review(), schemaVersion: 2, bundleRevision: 2, bundleDigest: digest,
    englishRuleCoverage: 'all_accepted_latin_initials_v1', englishRuleReviewRef: 'fictional-phonetic-review-not-professional-approval' };
  const reviewDigest = expectedCompanionIdentityReviewDigest(nextReview);
  assert.equal(parseCompanionIdentityReview({ ...nextReview, reviewDigest }).schemaVersion, 2);
  assert.notEqual(reviewDigest, expectedCompanionIdentityReviewDigest(review()));
  assert.throws(() => parseCompanionIdentityReview({ ...nextReview, englishRuleCoverage: 'approved', reviewDigest }));
  assert.throws(() => parseCompanionIdentityReview({ ...nextReview, schemaVersion: 1, reviewDigest }));
  assert.throws(() => parseCompanionIdentityBundle({ ...value, policy: { ...value.policy, englishSealRules: { ...value.policy.englishSealRules,
    initials: value.policy.englishSealRules.initials.slice(1) } }, contentDigest: digest }));
});
