import { describe, expect, it } from 'vitest';

import {
  AGENT_HTTP_SCHEMA_VERSION,
  parseGetRecommendationItemDetailResponse,
  parseSha256Digest,
  parseUuid,
  type GetRecommendationItemDetailParams,
  type GetRecommendationItemDetailResponse,
  type RecommendationItemDetailView,
} from '../src/index.ts';

const batchId = parseUuid('11111111-1111-4111-8111-111111111111')!;
const conversationId = parseUuid('22222222-2222-4222-8222-222222222222')!;
const itemId = parseUuid('33333333-3333-4333-8333-333333333333')!;
const canonicalJobId = parseUuid('44444444-4444-4444-8444-444444444444')!;
const descriptionDigest = parseSha256Digest(`sha256:${'a'.repeat(64)}`)!;

describe('Recommendation item detail contract', () => {
  it('keeps route identity in params and exposes only the exact public content projection', () => {
    const params: GetRecommendationItemDetailParams = { batchId, itemId };
    const item: RecommendationItemDetailView = {
      batchId,
      conversationId,
      itemId,
      job: {
        jobId: 'provider-job-1',
        title: 'Software Engineer',
        company: 'Example Labs',
        location: null,
        employmentType: null,
        sourcePlatform: 'GREENHOUSE',
        atsProvider: 'GREENHOUSE',
        qualification: {
          eligibility: 'ELIGIBLE',
          score: null,
          scoreScale: 100,
          reasons: [],
          risks: [],
          missingRequirements: [],
          sponsorship: {
            status: 'UNKNOWN',
            sourceCode: 'UNKNOWN',
            confidence: null,
          },
          referralAvailability: 'UNKNOWN',
        },
      },
      canonicalJobId,
      canonicalJobRevision: '7',
      listingGenerationKey: 'generation-7',
      descriptionDigest,
      description: 'Build reliable systems.',
    };
    const response: GetRecommendationItemDetailResponse = {
      schemaVersion: AGENT_HTTP_SCHEMA_VERSION,
      item,
    };

    expect(params).toEqual({ batchId, itemId });
    expect(Object.keys(response.item).sort()).toEqual([
      'batchId',
      'canonicalJobId',
      'canonicalJobRevision',
      'conversationId',
      'description',
      'descriptionDigest',
      'itemId',
      'job',
      'listingGenerationKey',
    ]);
    expect(response).not.toHaveProperty('catalogSelector');
    expect(response).not.toHaveProperty('sourceJobId');
    expect(response).not.toHaveProperty('url');
    const validateJob = (value: unknown) => value === item.job;
    expect(parseGetRecommendationItemDetailResponse(response, validateJob)).toBe(response);
    expect(parseGetRecommendationItemDetailResponse(response, () => false)).toBeNull();
    for (const invalid of [null, [], {}, { ...response, schemaVersion: 2 },
      { ...response, sourceUrl: 'https://invalid.example' }]) {
      expect(parseGetRecommendationItemDetailResponse(invalid, validateJob)).toBeNull();
    }
    for (const drift of [
      { batchId: 'not-uuid' }, { itemId: null }, { conversationId: '' },
      { canonicalJobId: 'not-uuid' }, { canonicalJobRevision: '0' },
      { canonicalJobRevision: '01' }, { canonicalJobRevision: '9223372036854775808' },
      { listingGenerationKey: ' ' }, { listingGenerationKey: 'x'.repeat(513) },
      { listingGenerationKey: 'generation\n1' }, { descriptionDigest: 'a'.repeat(64) },
      { description: '' }, { description: 'x'.repeat(30_001) },
      { description: 'unsafe\u0000text' }, { sourceUrl: 'https://invalid.example' },
    ]) {
      expect(parseGetRecommendationItemDetailResponse({ ...response,
        item: { ...item, ...drift } }, validateJob)).toBeNull();
    }
    expect(parseGetRecommendationItemDetailResponse({ ...response,
      item: { ...item, description: 'Line one\n\tLine two\r\n' } }, validateJob)).not.toBeNull();
  });
});
