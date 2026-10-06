import { describe, expect, it } from 'vitest';
import {
  parseCalendarEvent, parseCalendarEventList, parseCalendarEventWrite,
  parseCalendarProgressWrite, parseCalendarRange, parseCalendarDailyReportWrite,
} from '../src/calendar';

const input = {
  title: 'Portfolio review', type: 'reminder', visibility: 'personal',
  startsAt: '2026-09-06T17:00:00.000Z', endsAt: '2026-09-06T18:00:00.000Z',
  timezone: 'America/Los_Angeles', allDay: false,
};
const event = {
  ...input, id: '11111111-1111-4111-8111-111111111111',
  ownerId: '22222222-2222-4222-8222-222222222222', createdBy: 'student',
  progressStatus: 'NOT_STARTED',
};

describe('Calendar stable boundary', () => {
  it('keeps the private daily-report binding separate from event facts and progress', () => {
    expect(parseCalendarDailyReportWrite({ conversationId: event.id })).toEqual({ conversationId: event.id });
    expect(parseCalendarDailyReportWrite({ conversationId: null })).toEqual({ conversationId: null });
    expect(parseCalendarDailyReportWrite({ conversationId: event.id, userId: event.ownerId })).toBeNull();
    expect(parseCalendarEventWrite({ ...input, dailyReportConversationId: event.id })).toBeNull();
    expect(parseCalendarProgressWrite({ progressStatus: 'DONE', conversationId: event.id })).toBeNull();
  });
  it('accepts timed events and date-only all-day events without changing their timezone', () => {
    expect(parseCalendarEventWrite(input)).toEqual(input);
    expect(parseCalendarEventWrite({ ...input, startsAt: '2026-09-06', endsAt: '2026-09-07', allDay: true })?.startsAt).toBe('2026-09-06');
    expect(parseCalendarEvent(event)?.timezone).toBe('America/Los_Angeles');
  });

  it.each([
    { ownerId: event.ownerId }, { createdBy: 'admin' }, { progressStatus: 'DONE' },
    { title: '' }, { type: 'unknown' }, { visibility: 'everyone' },
    { timezone: 'Unknown/Zone' }, { startsAt: '2026-02-30T17:00:00.000Z' },
    { endsAt: input.startsAt }, { cohortId: event.id }, { description: 'x'.repeat(4001) },
  ])('rejects invalid or authority-injecting write fields: %j', (change) => {
    expect(parseCalendarEventWrite({ ...input, ...change })).toBeNull();
  });

  it('requires an exact cohort binding and excludes personal material from shared events', () => {
    expect(parseCalendarEventWrite({ ...input, visibility: 'cohort' })).toBeNull();
    expect(parseCalendarEventWrite({ ...input, visibility: 'cohort', cohortId: event.id })).not.toBeNull();
    expect(parseCalendarEventWrite({ ...input, visibility: 'public', applicationId: event.id })).toBeNull();
  });

  it('uses the same closed event decoder for runtime output and the Portal list', () => {
    expect(parseCalendarEventList({ events: [event], role: 'STUDENT' })?.events).toHaveLength(1);
    expect(parseCalendarEventList({ events: [{ ...event, id: 'fixture-id' }], role: 'STUDENT' })).toBeNull();
    expect(parseCalendarEventList({ events: [event], role: 'STUDENT', token: 'unexpected' })).toBeNull();
  });

  it('restricts progress to its separate exact write shape', () => {
    expect(parseCalendarProgressWrite({ progressStatus: 'DONE' })).toEqual({ progressStatus: 'DONE' });
    expect(parseCalendarProgressWrite({ progressStatus: 'DONE', ownerId: event.ownerId })).toBeNull();
    expect(parseCalendarProgressWrite({ progressStatus: 'COMPLETE' })).toBeNull();
  });

  it('bounds range reads, rejects reversed windows and accepts the existing three-year Portal request', () => {
    expect(parseCalendarRange({ from: '2025-01-01T00:00:00.000Z', to: '2028-01-01T00:00:00.000Z' })).not.toBeNull();
    expect(parseCalendarRange({ from: input.endsAt, to: input.startsAt })).toBeNull();
    expect(parseCalendarRange({ from: input.startsAt, to: '2040-01-01T00:00:00.000Z' })).toBeNull();
    expect(parseCalendarRange({ from: input.startsAt, to: input.endsAt, ownerId: event.ownerId })).toBeNull();
  });
});
