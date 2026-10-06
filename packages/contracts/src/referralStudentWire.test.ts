import { describe, expect, it } from 'vitest';
import { parseStudentReferralCoffeeChatItem, parseStudentReferralCoffeeChatsPage, parseStudentReferralCoffeeChatsQuery, parseStudentReferralCoffeeChatsResponse } from './referralStudentWire.ts';
const id = '11111111-1111-4111-8111-111111111111';
const item = { referralRequestId: id, jobId: 'canonical-job', jobTitle: 'Engineer', company: 'Example', status: 'REQUESTED', revision: '0', slots: [] };
describe('student Referral paged wire', () => {
  it('keeps unpaginated wire exact and requires explicit completeness in opt-in pages', () => {
    const legacy = { schemaVersion: 1, items: [item] };
    const page = { ...legacy, nextCursor: id };
    expect(parseStudentReferralCoffeeChatsResponse(legacy)).toEqual(legacy);
    expect(parseStudentReferralCoffeeChatsPage(legacy)).toBeNull();
    expect(parseStudentReferralCoffeeChatsResponse(page)).toBeNull();
    expect(parseStudentReferralCoffeeChatsPage(page)).toEqual(page);
    expect(parseStudentReferralCoffeeChatsPage({ ...page, nextCursor: null })).toBeTruthy();
  });
  it.each([
    { cursor: id }, { limit: 0 }, { limit: 101 }, { limit: '10' }, { limit: 1, cursor: 'bad' },
    { limit: 1, ownerId: id }, { limit: 1, cursor: [id] }, { limit: 1, cursor: null },
  ])('rejects malformed pagination %j', (query) => {
    expect(parseStudentReferralCoffeeChatsQuery(query)).toBeNull();
  });
  it('admits only the bounded typed query and default legacy request', () => {
    expect(parseStudentReferralCoffeeChatsQuery({})).toEqual({});
    expect(parseStudentReferralCoffeeChatsQuery({ limit: 100, cursor: id })).toEqual({ limit: 100, cursor: id });
  });
  it('rejects duplicate identities, detached continuation, overlong pages and private fields', () => {
    expect(parseStudentReferralCoffeeChatsPage({ schemaVersion: 1, items: [item, item], nextCursor: null })).toBeNull();
    expect(parseStudentReferralCoffeeChatsPage({ schemaVersion: 1, items: [], nextCursor: id })).toBeNull();
    expect(parseStudentReferralCoffeeChatsPage({ schemaVersion: 1, items: Array(101).fill(item), nextCursor: null })).toBeNull();
    expect(parseStudentReferralCoffeeChatItem({ ...item, studentEmail: 'private@example.invalid' })).toBeNull();
    expect(parseStudentReferralCoffeeChatItem({ ...item, company: '' })).toBeNull();
  });
  it('preserves strict slot, optional guarantee and outcome decoding', () => {
    const withSlot = { ...item, slots: [{ slotId: id, startAt: '2026-09-09T10:00:00.000Z', endAt: '2026-09-09T10:30:00.000Z', timeZone: 'America/Los_Angeles', status: 'SELECTED', meetingProvider: 'GOOGLE_MEET', meetingUrl: 'https://meet.google.com/abc-defg-hij' }] };
    expect(parseStudentReferralCoffeeChatItem(withSlot)).toBeTruthy();
    expect(parseStudentReferralCoffeeChatItem({ ...withSlot, slots: [{ ...withSlot.slots[0], meetingUrl: 'https://evil.invalid' }] })).toBeNull();
    expect(parseStudentReferralCoffeeChatItem({ ...item, guarantee: { state: 'REFUND_REQUESTED', deadlineAt: '2026-09-09T10:00:00.000Z', attempt: 1, revision: '1', remedyReason: 'MENTOR_DECLINED', lastRemedy: 'REFUND' } })).toBeTruthy();
    expect(parseStudentReferralCoffeeChatItem({ ...item, referralOutcome: { status: 'UNKNOWN', evidenceSource: null, revision: '0', recordedAt: null, projectionState: 'NOT_APPLICABLE', projectionReason: 'NO_APPLICATION_PROJECTION', applicationId: null } })).toBeTruthy();
    expect(parseStudentReferralCoffeeChatItem({ ...item, referralOutcome: { status: 'SUCCESS' } })).toBeNull();
  });
});
