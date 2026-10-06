import { describe, expect, it } from 'vitest';
import {
  parseCalendarGoogleCommand,
  parseCalendarGoogleResponse,
  parseCalendarGoogleBody,
} from '../src/calendar-google';
const id = '11111111-1111-4111-8111-111111111111';
const body = {
  title: 'Review',
  description: '',
  location: '',
  time: {
    startsAt: '2026-11-01T08:30:00.000Z',
    endsAt: '2026-11-01T09:30:00.000Z',
    timezone: 'America/Los_Angeles',
    allDay: false,
  },
  cancelled: false,
};
describe('Google Calendar owner boundary', () => {
  it('rejects owner/provider URL injection and implicit initial upload', () => {
    expect(
      parseCalendarGoogleCommand({ action: 'start', ownerId: id }),
    ).toBeNull();
    expect(
      parseCalendarGoogleCommand({
        action: 'select',
        calendarId: 'https://evil.invalid',
      }),
    ).toBeNull();
    expect(
      parseCalendarGoogleCommand({ action: 'confirm', previewId: id }),
    ).toBeNull();
    expect(
      parseCalendarGoogleCommand({
        action: 'confirm',
        previewId: id,
        publishEventIds: [],
      }),
    ).not.toBeNull();
  });
  it('requires bounded exact revisions for conflict actions and rejects credentials in status', () => {
    expect(
      parseCalendarGoogleCommand({
        action: 'resolve',
        linkId: id,
        revision: 0,
        choice: 'LOCAL',
      }),
    ).toBeNull();
    expect(
      parseCalendarGoogleCommand({
        action: 'resolve',
        linkId: id,
        revision: 1,
        choice: 'LOCAL',
      }),
    ).not.toBeNull();
    expect(
      parseCalendarGoogleResponse({
        kind: 'STATUS',
        autoSyncNewEvents: false,
        state: 'DISCONNECTED',
        calendar: null,
        lastSyncedAt: null,
        reason: null,
        links: [],
        refreshToken: 'secret',
      }),
    ).toBeNull();
  });
  it('preserves all-day exclusive dates and rejects invalid time pairs', () => {
    expect(parseCalendarGoogleBody(body)).toEqual(body);
    expect(
      parseCalendarGoogleBody({
        ...body,
        time: {
          startsAt: '2026-11-01',
          endsAt: '2026-11-02',
          timezone: 'America/Los_Angeles',
          allDay: true,
        },
      }),
    ).not.toBeNull();
    expect(
      parseCalendarGoogleBody({
        ...body,
        time: { ...body.time, endsAt: body.time.startsAt },
      }),
    ).toBeNull();
  });
});
