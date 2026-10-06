import { describe, expect, it } from 'vitest';

import {
  REFERRAL_COFFEE_CHAT_SLOT_STATUSES,
  REFERRAL_MEETING_PROVIDERS,
  REFERRAL_MENTOR_DECISIONS,
  REFERRAL_MENTOR_WORKFLOW_STATUSES,
  REFERRAL_REQUEST_STATUSES,
  REFERRAL_RESOLUTION_CODES,
} from '../src/index.ts';

describe('referral fulfillment contract', () => {
  it('keeps the manual MVP status and resolution sets closed', () => {
    expect(REFERRAL_REQUEST_STATUSES).toEqual([
      'REQUESTED',
      'IN_REVIEW',
      'CONTACTED',
      'COFFEE_CHAT_SCHEDULED',
      'COMPLETED',
      'UNAVAILABLE',
      'CANCELLED',
    ]);
    expect(REFERRAL_RESOLUTION_CODES).toEqual([
      'MANUAL_PROCESS_COMPLETED',
      'NO_CURRENT_RESOURCE',
      'POSITION_NOT_SUPPORTED',
      'STUDENT_NOT_ELIGIBLE',
      'REQUEST_WITHDRAWN',
      'DUPLICATE_REQUEST',
    ]);
  });

  it('keeps the default-off T14 Mentor workflow namespace separate from T13 Ops status', () => {
    expect(REFERRAL_MENTOR_WORKFLOW_STATUSES).toContain('MENTOR_CONFIRMED');
    expect(REFERRAL_MENTOR_DECISIONS).toEqual(['APPROVE', 'REQUEST_CHANGE', 'DECLINE']);
    expect(REFERRAL_COFFEE_CHAT_SLOT_STATUSES).toEqual(['OFFERED', 'SELECTED', 'CANCELLED']);
    expect(REFERRAL_MEETING_PROVIDERS).toEqual(['GOOGLE_MEET', 'ZOOM']);
  });
});
