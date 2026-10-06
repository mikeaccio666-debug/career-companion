import { describe, expect, it } from 'vitest';
import {
  CALENDAR_EVENT_PROGRESS_STATUSES,
  parseCalendarAdminEvent, parseCalendarAdminEventList, parseCalendarAudienceCounts,
  parseCalendarAudienceEventWrite, parseCalendarAudiencePreview, parseCalendarAudienceRefresh,
  parseCalendarAudienceTarget, parseCalendarAudienceWrite, parseCalendarEvent, parseCalendarEventWrite,
} from '../src/calendar';

const eventId = '11111111-1111-4111-8111-111111111111';
const adminId = '22222222-2222-4222-8222-222222222222';
const memberId = '33333333-3333-4333-8333-333333333333';
const body = {
  title: 'Cohort orientation', type: 'activity', visibility: 'audience',
  startsAt: '2026-09-06T17:00:00.000Z', endsAt: '2026-09-06T18:00:00.000Z',
  timezone: 'America/Los_Angeles', allDay: false,
};
const event = {
  ...body, id: eventId, ownerId: adminId, createdBy: 'admin', progressStatus: 'NOT_STARTED',
  audience: { kind: 'ROLE', role: 'STUDENT', revision: 1 },
};
const counts = { recipients: 3, hidden: 1, byProgress: { NOT_STARTED: 2, DONE: 1, ARCHIVED: 0 } };

describe('Calendar admin audience boundary', () => {
  it('names exactly one target per kind and refuses a mixed, empty or list-shaped audience', () => {
    expect(parseCalendarAudienceTarget({ kind: 'USER', userId: memberId })).toEqual({ kind: 'USER', userId: memberId });
    expect(parseCalendarAudienceTarget({ kind: 'ROLE', role: 'STUDENT' })).toEqual({ kind: 'ROLE', role: 'STUDENT' });
    for (const target of [
      { kind: 'USER', userId: memberId, role: 'STUDENT' }, { kind: 'USER', role: 'STUDENT' },
      { kind: 'ROLE', role: 'STUDENT', userId: memberId }, { kind: 'ROLE', userId: memberId },
      { kind: 'ROLE' }, { kind: 'USER' }, { kind: 'COHORT', role: 'STUDENT' },
      // A role outside the storage enum, and the roles only the broader Auth wire knows.
      { kind: 'ROLE', role: 'EVERYONE' }, { kind: 'ROLE', role: 'STAFF' }, { kind: 'ROLE', role: 'REFERRAL_MENTOR' },
      { kind: 'USER', userId: 'not-a-uuid' }, { kind: 'USER', userIds: [memberId] },
    ]) expect(parseCalendarAudienceTarget(target)).toBeNull();
  });

  it('keeps `audience` out of the self-serve visibilities and out of every event write body', () => {
    expect(parseCalendarEventWrite(body)).toBeNull();
    expect(parseCalendarAudienceEventWrite(body)).toEqual(body);
    // The three self-serve values stay exactly where they were.
    expect(parseCalendarEventWrite({ ...body, visibility: 'personal' })).not.toBeNull();
    expect(parseCalendarAudienceEventWrite({ ...body, visibility: 'personal' })).toBeNull();
    // The chosen audience is never smuggled through the body of an event write.
    expect(parseCalendarAudienceEventWrite({ ...body, audience: event.audience })).toBeNull();
  });

  it('binds the create body to one event body plus one target, with no third key', () => {
    expect(parseCalendarAudienceWrite({ event: body, audience: { kind: 'ROLE', role: 'ADMIN' } }))
      .toEqual({ event: body, audience: { kind: 'ROLE', role: 'ADMIN' } });
    expect(parseCalendarAudienceWrite({ event: body, audience: { kind: 'ROLE', role: 'ADMIN' }, notify: true })).toBeNull();
    expect(parseCalendarAudienceWrite({ event: { ...body, visibility: 'public' }, audience: { kind: 'ROLE', role: 'ADMIN' } })).toBeNull();
    expect(parseCalendarAudienceWrite({ event: body })).toBeNull();
    expect(parseCalendarAudienceWrite({ audience: { kind: 'ROLE', role: 'ADMIN' } })).toBeNull();
  });

  it('projects the chosen audience only on an admin read of an admin-authored audience event', () => {
    expect(parseCalendarEvent(event)?.audience).toEqual({ kind: 'ROLE', role: 'STUDENT', revision: 1 });
    // A recipient's copy of the same event carries no target at all, and stays valid.
    const { audience: _audience, ...recipientCopy } = event;
    expect(parseCalendarEvent(recipientCopy)?.audience).toBeUndefined();
    // An audience target cannot ride on a non-audience event, nor on a student-authored one.
    expect(parseCalendarEvent({ ...event, visibility: 'public', audience: event.audience })).toBeNull();
    expect(parseCalendarEvent({ ...event, createdBy: 'student' })).toBeNull();
    expect(parseCalendarEvent({ ...event, ownerId: null })).toBeNull();
    // The view is exactly `{kind, revision}` plus the one key its kind implies.
    for (const audience of [
      { kind: 'ROLE', role: 'STUDENT' }, { kind: 'ROLE', revision: 1 },
      { kind: 'ROLE', role: 'STUDENT', userId: memberId, revision: 1 },
      { kind: 'USER', userId: memberId, role: 'STUDENT', revision: 1 },
      { kind: 'USER', revision: 1 }, { kind: 'ROLE', role: 'STUDENT', revision: -1 },
      { kind: 'ROLE', role: 'STUDENT', revision: 1.5 },
      // The member list this feature exists to never expose.
      { kind: 'ROLE', role: 'STUDENT', revision: 1, userIds: [memberId] },
    ]) expect(parseCalendarEvent({ ...event, audience })).toBeNull();
  });

  it('accepts only counts that add up, and never a shape carrying member identities', () => {
    expect(parseCalendarAudienceCounts(counts)).toEqual(counts);
    expect(parseCalendarAudienceCounts({ ...counts, recipients: 4 })).toBeNull();
    expect(parseCalendarAudienceCounts({ ...counts, hidden: 4 })).toBeNull();
    expect(parseCalendarAudienceCounts({ ...counts, byProgress: { NOT_STARTED: 2, DONE: 1 } })).toBeNull();
    expect(parseCalendarAudienceCounts({ ...counts, byProgress: { ...counts.byProgress, PENDING: 0 } })).toBeNull();
    expect(parseCalendarAudienceCounts({ ...counts, recipients: -1, byProgress: { NOT_STARTED: -1, DONE: 0, ARCHIVED: 0 } })).toBeNull();
    expect(parseCalendarAudienceCounts({ ...counts, recipientIds: [memberId] })).toBeNull();
    expect(parseCalendarAudienceCounts({ ...counts, recipientEmails: ['member@example.invalid'] })).toBeNull();
    // Every stored progress status is one of the count keys, so no recipient can fall outside the total.
    expect(Object.keys(counts.byProgress).sort()).toEqual([...CALENDAR_EVENT_PROGRESS_STATUSES].sort());
  });

  it('pairs each admin event with its counts and pages by event id', () => {
    expect(parseCalendarAdminEvent({ event, counts })).toEqual({ event, counts });
    // Counts only ever describe an audience event that already knows its target.
    const { audience: _audience, ...untargeted } = event;
    expect(parseCalendarAdminEvent({ event: untargeted, counts })).toBeNull();
    expect(parseCalendarAdminEvent({ event: { ...event, visibility: 'public', audience: undefined }, counts })).toBeNull();
    expect(parseCalendarAdminEventList({ events: [{ event, counts }] })?.events).toHaveLength(1);
    expect(parseCalendarAdminEventList({ events: [{ event, counts }], nextCursor: eventId })?.nextCursor).toBe(eventId);
    expect(parseCalendarAdminEventList({ events: [{ event, counts }], nextCursor: 'fixture' })).toBeNull();
    expect(parseCalendarAdminEventList({ events: [{ event, counts }, { event, counts }] })).toBeNull();
    expect(parseCalendarAdminEventList({ events: [{ event, counts }], recipients: [memberId] })).toBeNull();
  });

  it('reports a preview and a refresh as counts, never as the accounts behind them', () => {
    expect(parseCalendarAudiencePreview({ recipientCount: 0 })).toEqual({ recipientCount: 0 });
    expect(parseCalendarAudiencePreview({ recipientCount: -1 })).toBeNull();
    expect(parseCalendarAudiencePreview({ recipientCount: 2, recipients: [memberId] })).toBeNull();
    expect(parseCalendarAudienceRefresh({ counts, added: 2 })).toEqual({ counts, added: 2 });
    expect(parseCalendarAudienceRefresh({ counts, added: -1 })).toBeNull();
    expect(parseCalendarAudienceRefresh({ counts, added: 2, addedUserIds: [memberId] })).toBeNull();
  });
});
