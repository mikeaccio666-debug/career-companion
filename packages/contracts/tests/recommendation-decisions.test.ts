import { describe, expect, it } from 'vitest';

import {
  RECOMMENDATION_DECISIONS,
  RECOMMENDATION_DECISION_RESULT_CODES,
  RECOMMENDATION_ITEM_STATUSES,
  RECOMMENDATION_DECISION_ITEM_ERROR_CODES,
  RECOMMENDATION_RESPONSE_LIMITS,
  type ListRecommendationBatchesQuery,
  type RecommendationItemDecisionResult,
  type RecommendationItemDecisionRequest,
} from '../src/index.ts';

describe('recommendation decision vocabulary', () => {
  it('keeps Apply and Skip only', () => {
    expect(RECOMMENDATION_DECISIONS).toEqual(['APPLY', 'SKIP']);
    expect(RECOMMENDATION_ITEM_STATUSES).not.toContain('NOT_INTERESTED');
    expect(RECOMMENDATION_DECISION_RESULT_CODES).not.toContain('NOT_INTERESTED');
    expect(RECOMMENDATION_DECISION_RESULT_CODES).toContain('CONVERSATION_ARCHIVED');
    expect(RECOMMENDATION_DECISION_ITEM_ERROR_CODES).toContain('CONVERSATION_STATE_CONFLICT');
  });

  it('mirrors the bounded recommendation response budgets', () => {
    expect(RECOMMENDATION_RESPONSE_LIMITS).toEqual({
      maxSerializedUtf8Bytes: 16_777_216,
      maxStringCodeUnits: 8_000_000,
      maxDisplayCodeUnits: 2_000_000,
    });
    expect(Object.isFrozen(RECOMMENDATION_RESPONSE_LIMITS)).toBe(true);
  });

  it('filters by Role conversation and reports archived Role at item level', () => {
    const conversationId = '70f57443-ebd2-44ea-b08b-d20fab20aa41' as NonNullable<ListRecommendationBatchesQuery['conversationId']>;
    const query: ListRecommendationBatchesQuery = { conversationId, limit: 20 };
    const result: RecommendationItemDecisionResult = {
      itemId: conversationId,
      resultCode: 'CONVERSATION_ARCHIVED',
      missionId: null,
      errorCode: 'CONVERSATION_STATE_CONFLICT',
    };

    expect(query.conversationId).toBe(conversationId);
    expect(result.errorCode).toBe('CONVERSATION_STATE_CONFLICT');
  });

  it('does not encode a persistent preference in Skip', () => {
    const skip: RecommendationItemDecisionRequest = {
      itemId: '70f57443-ebd2-44ea-b08b-d20fab20aa41' as RecommendationItemDecisionRequest['itemId'],
      itemRevision: '1',
      decision: 'SKIP',
    };
    const invalid: RecommendationItemDecisionRequest = {
      ...skip,
      // @ts-expect-error Skip only decides the current item.
      suppressSimilarJobs: true,
    };

    expect(invalid.decision).toBe('SKIP');
  });
});
