import { describe, expect, it } from 'vitest';
import {
  CALENDAR_REMINDER_CHANNELS, CALENDAR_REMINDER_RULE_KEYS,
  parseCalendarEvent, parseCalendarEventList, parseCalendarEventWrite, parseCalendarReminderWrite,
} from '../src/calendar';
import { parseCalendarGoogleCommand, parseCalendarGoogleResponse } from '../src/calendar-google';

const event = {
  title: 'Portfolio review', type: 'reminder', visibility: 'personal',
  startsAt: '2026-09-06T17:00:00.000Z', endsAt: '2026-09-06T18:00:00.000Z',
  timezone: 'America/Los_Angeles', allDay: false,
  id: '11111111-1111-4111-8111-111111111111', ownerId: '22222222-2222-4222-8222-222222222222',
  createdBy: 'student', progressStatus: 'NOT_STARTED',
};

describe('Calendar reminder write', () => {
  it('accepts one rule per key with a non-empty distinct channel list, and an empty list to turn reminders off', () => {
    expect(parseCalendarReminderWrite({ rules: [] })).toEqual({ rules: [] });
    expect(parseCalendarReminderWrite({ rules: [{ ruleKey: '24_HOURS_BEFORE', channels: ['IN_APP', 'EMAIL'] }, { ruleKey: '1_HOUR_BEFORE', channels: ['IN_APP'] }] }))
      .toEqual({ rules: [{ ruleKey: '24_HOURS_BEFORE', channels: ['IN_APP', 'EMAIL'] }, { ruleKey: '1_HOUR_BEFORE', channels: ['IN_APP'] }] });
  });

  it('rejects unknown keys, unknown rules or channels, duplicates, and empty channel lists', () => {
    expect(parseCalendarReminderWrite({ rules: [{ ruleKey: '24_HOURS_BEFORE', channels: [] }] })).toBeNull();
    expect(parseCalendarReminderWrite({ rules: [{ ruleKey: '2_DAYS_BEFORE', channels: ['IN_APP'] }] })).toBeNull();
    expect(parseCalendarReminderWrite({ rules: [{ ruleKey: '24_HOURS_BEFORE', channels: ['SMS'] }] })).toBeNull();
    expect(parseCalendarReminderWrite({ rules: [{ ruleKey: '24_HOURS_BEFORE', channels: ['IN_APP', 'IN_APP'] }] })).toBeNull();
    expect(parseCalendarReminderWrite({ rules: [{ ruleKey: '24_HOURS_BEFORE', channels: ['IN_APP'] }, { ruleKey: '24_HOURS_BEFORE', channels: ['EMAIL'] }] })).toBeNull();
    expect(parseCalendarReminderWrite({ rules: [{ ruleKey: '24_HOURS_BEFORE', channels: ['IN_APP'], note: 'x' }] })).toBeNull();
    expect(parseCalendarReminderWrite({ rules: [], eventId: event.id })).toBeNull();
    expect(parseCalendarReminderWrite({ rules: CALENDAR_REMINDER_RULE_KEYS.map((ruleKey) => ({ ruleKey, channels: [...CALENDAR_REMINDER_CHANNELS] })).concat([{ ruleKey: '1_HOUR_BEFORE', channels: ['IN_APP'] }]) })).toBeNull();
  });
});

describe('Calendar event projection with reminders', () => {
  it('carries the revision, the viewer reminders and an agent source type, none of which a client may write', () => {
    const projected = { ...event, revision: 3, reminders: [{ ruleKey: '24_HOURS_BEFORE', channel: 'IN_APP' }], sourceType: 'REFERRAL_COFFEE_CHAT', createdBy: 'agent' };
    expect(parseCalendarEvent(projected)).toEqual(projected);
    expect(parseCalendarEventWrite({ ...event, revision: 3 })).toBeNull();
    expect(parseCalendarEventWrite({ ...event, reminders: [] })).toBeNull();
    expect(parseCalendarEventWrite({ ...event, sourceType: 'REFERRAL_COFFEE_CHAT' })).toBeNull();
  });

  it('rejects a non-positive revision, duplicate or unknown reminders, and a malformed source type', () => {
    expect(parseCalendarEvent({ ...event, revision: 0 })).toBeNull();
    expect(parseCalendarEvent({ ...event, reminders: [{ ruleKey: '24_HOURS_BEFORE', channel: 'IN_APP' }, { ruleKey: '24_HOURS_BEFORE', channel: 'IN_APP' }] })).toBeNull();
    expect(parseCalendarEvent({ ...event, reminders: [{ ruleKey: 'NEVER', channel: 'IN_APP' }] })).toBeNull();
    expect(parseCalendarEvent({ ...event, sourceType: 'referral' })).toBeNull();
  });

  it('lets the list name the channels the server can deliver over, distinct and closed', () => {
    const list = { events: [event], role: 'STUDENT', reminderChannels: ['IN_APP'] };
    expect(parseCalendarEventList(list)).toEqual(list);
    expect(parseCalendarEventList({ ...list, reminderChannels: ['IN_APP', 'IN_APP'] })).toBeNull();
    expect(parseCalendarEventList({ ...list, reminderChannels: ['PUSH'] })).toBeNull();
  });
});

describe('Google auto-sync', () => {
  it('parses the auto-sync command and requires the flag on every status', () => {
    expect(parseCalendarGoogleCommand({ action: 'auto-sync', enabled: true })).toEqual({ action: 'auto-sync', enabled: true });
    expect(parseCalendarGoogleCommand({ action: 'auto-sync' })).toBeNull();
    expect(parseCalendarGoogleCommand({ action: 'auto-sync', enabled: 'yes' })).toBeNull();
    const status = { kind: 'STATUS', state: 'DISCONNECTED', calendar: null, lastSyncedAt: null, reason: null, links: [] };
    expect(parseCalendarGoogleResponse(status)).toBeNull();
    expect(parseCalendarGoogleResponse({ ...status, autoSyncNewEvents: false })).toEqual({ ...status, autoSyncNewEvents: false });
  });
});
