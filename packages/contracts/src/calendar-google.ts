/** T1-4 Google sync wire. Provider tokens and OAuth codes are server-only. */
import { parseUuid, parseIsoDateTime, parseLocalDate } from './common.ts';
import { parseIanaTimeZone } from './ianaTimeZones.ts';
export const CALENDAR_GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.owned',
] as const;
export const CALENDAR_GOOGLE_STATES = [
  'DISABLED',
  'DISCONNECTED',
  'NEEDS_CALENDAR',
  'ACTIVE',
  'DISCONNECTING',
  'REAUTH_REQUIRED',
] as const;
export const CALENDAR_GOOGLE_REASONS = [
  'PROVIDER_UNAVAILABLE',
  'REAUTH_REQUIRED',
  'PERMISSION_DENIED',
  'RANGE_TOO_LARGE',
  'INVALID_PROVIDER_DATA',
  'CONFLICT',
  'SEND_UNCERTAIN',
  'RATE_LIMITED',
] as const;
export type CalendarGoogleReason = (typeof CALENDAR_GOOGLE_REASONS)[number];
export type CalendarGoogleBody = Readonly<{
  title: string;
  description: string;
  location: string;
  time: Readonly<{
    startsAt: string;
    endsAt: string;
    timezone: string;
    allDay: boolean;
  }>;
  cancelled: boolean;
}>;
export type CalendarGoogleCalendar = Readonly<{
  id: string;
  name: string;
  timezone: string;
}>;
export type CalendarGoogleLink = Readonly<{
  id: string;
  eventId: string;
  revision: number;
  state:
    'PENDING' | 'SYNCED' | 'CONFLICT' | 'CANCELLED' | 'UNCERTAIN' | 'DETACHED';
  local: CalendarGoogleBody;
  remote: CalendarGoogleBody | null;
}>;
export type CalendarGoogleStatus = Readonly<{
  kind: 'STATUS';
  state: (typeof CALENDAR_GOOGLE_STATES)[number];
  calendar: CalendarGoogleCalendar | null;
  lastSyncedAt: string | null;
  reason: CalendarGoogleReason | null;
  links: readonly CalendarGoogleLink[];
  /** Link every new personal event of this owner without a per-event opt-in. False while not connected. */
  autoSyncNewEvents: boolean;
}>;
export type CalendarGoogleCommand =
  | Readonly<{ action: 'start' | 'calendars' | 'sync' | 'disconnect' }>
  | Readonly<{ action: 'auto-sync'; enabled: boolean }>
  | Readonly<{ action: 'complete'; state: string; code: string }>
  | Readonly<{ action: 'select'; calendarId: string }>
  | Readonly<{
      action: 'confirm';
      previewId: string;
      publishEventIds: readonly string[];
    }>
  | Readonly<{
      action: 'resolve';
      linkId: string;
      revision: number;
      choice: 'LOCAL' | 'GOOGLE';
    }>
  | Readonly<{ action: 'cancel' | 'unlink'; linkId: string; revision: number }>;
export type CalendarGoogleResponse =
  | CalendarGoogleStatus
  | Readonly<{ kind: 'AUTHORIZE'; url: string }>
  | Readonly<{
      kind: 'CALENDARS';
      calendars: readonly CalendarGoogleCalendar[];
    }>
  | Readonly<{
      kind: 'PREVIEW';
      previewId: string;
      expiresAt: string;
      from: string;
      to: string;
      calendar: CalendarGoogleCalendar;
      importCount: number;
      skippedCount: number;
      publishable: readonly Readonly<{ id: string; title: string }>[];
    }>;
const obj = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype ||
    Object.getPrototypeOf(v) === null);
const keys = (v: Record<string, unknown>, k: readonly string[]) =>
  Reflect.ownKeys(v).length === k.length &&
  k.every(
    (x) =>
      Object.hasOwn(v, x) && 'value' in Object.getOwnPropertyDescriptor(v, x)!,
  );
const text = (v: unknown, max: number, empty = false): v is string =>
  typeof v === 'string' &&
  v.length <= max &&
  (empty || v.trim().length > 0) &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v);
const rev = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) > 0 && (v as number) < 2_147_483_647;
const member = <T extends string>(v: unknown, values: readonly T[]): v is T =>
  typeof v === 'string' && values.includes(v as T);
export function parseCalendarGoogleBody(v: unknown): CalendarGoogleBody | null {
  if (
    !obj(v) ||
    !keys(v, ['title', 'description', 'location', 'time', 'cancelled']) ||
    !text(v.title, 200) ||
    !text(v.description, 4000, true) ||
    !text(v.location, 500, true) ||
    typeof v.cancelled !== 'boolean' ||
    !obj(v.time)
  )
    return null;
  const t = v.time;
  if (
    !keys(t, ['startsAt', 'endsAt', 'timezone', 'allDay']) ||
    typeof t.allDay !== 'boolean' ||
    !parseIanaTimeZone(t.timezone) ||
    !(t.allDay
      ? parseLocalDate(t.startsAt) && parseLocalDate(t.endsAt)
      : parseIsoDateTime(t.startsAt) && parseIsoDateTime(t.endsAt)) ||
    Date.parse(t.endsAt as string) <= Date.parse(t.startsAt as string)
  )
    return null;
  return {
    title: v.title,
    description: v.description,
    location: v.location,
    cancelled: v.cancelled,
    time: {
      startsAt: t.startsAt as string,
      endsAt: t.endsAt as string,
      timezone: t.timezone as string,
      allDay: t.allDay,
    },
  };
}
export function parseCalendarGoogleCalendar(
  v: unknown,
): CalendarGoogleCalendar | null {
  if (
    !obj(v) ||
    !keys(v, ['id', 'name', 'timezone']) ||
    !calendarId(v.id) ||
    !text(v.name, 250) ||
    !parseIanaTimeZone(v.timezone)
  )
    return null;
  return { id: v.id, name: v.name, timezone: v.timezone as string };
}
function calendarId(v: unknown): v is string {
  return text(v, 1024) && !/[\s/:?#]/u.test(v);
}
export function parseCalendarGoogleCommand(
  v: unknown,
): CalendarGoogleCommand | null {
  if (!obj(v)) return null;
  if (
    member(v.action, ['start', 'calendars', 'sync', 'disconnect']) &&
    keys(v, ['action'])
  )
    return { action: v.action };
  if (
    v.action === 'auto-sync' &&
    keys(v, ['action', 'enabled']) &&
    typeof v.enabled === 'boolean'
  )
    return { action: v.action, enabled: v.enabled };
  if (
    v.action === 'complete' &&
    keys(v, ['action', 'state', 'code']) &&
    typeof v.state === 'string' &&
    /^[A-Za-z0-9_-]{43}$/u.test(v.state) &&
    text(v.code, 2048)
  )
    return { action: v.action, state: v.state, code: v.code };
  if (
    v.action === 'select' &&
    keys(v, ['action', 'calendarId']) &&
    calendarId(v.calendarId)
  )
    return { action: v.action, calendarId: v.calendarId };
  if (
    v.action === 'confirm' &&
    keys(v, ['action', 'previewId', 'publishEventIds']) &&
    parseUuid(v.previewId) &&
    Array.isArray(v.publishEventIds) &&
    v.publishEventIds.length <= 200 &&
    v.publishEventIds.every((x) => parseUuid(x)) &&
    new Set(v.publishEventIds).size === v.publishEventIds.length
  )
    return {
      action: v.action,
      previewId: v.previewId as string,
      publishEventIds: [...v.publishEventIds] as string[],
    };
  if (
    member(v.action, ['cancel', 'unlink']) &&
    keys(v, ['action', 'linkId', 'revision']) &&
    parseUuid(v.linkId) &&
    rev(v.revision)
  )
    return {
      action: v.action,
      linkId: v.linkId as string,
      revision: v.revision,
    };
  if (
    v.action === 'resolve' &&
    keys(v, ['action', 'linkId', 'revision', 'choice']) &&
    parseUuid(v.linkId) &&
    rev(v.revision) &&
    member(v.choice, ['LOCAL', 'GOOGLE'])
  )
    return {
      action: v.action,
      linkId: v.linkId as string,
      revision: v.revision,
      choice: v.choice,
    };
  return null;
}
export function parseCalendarGoogleResponse(
  v: unknown,
): CalendarGoogleResponse | null {
  if (!obj(v)) return null;
  if (v.kind === 'AUTHORIZE' && keys(v, ['kind', 'url']) && text(v.url, 8192)) {
    try {
      const u = new URL(v.url);
      if (
        u.origin === 'https://accounts.google.com' &&
        u.pathname === '/o/oauth2/v2/auth' &&
        !u.username &&
        !u.password &&
        !u.hash
      )
        return { kind: v.kind, url: v.url };
    } catch {
      return null;
    }
    return null;
  }
  if (
    v.kind === 'CALENDARS' &&
    keys(v, ['kind', 'calendars']) &&
    Array.isArray(v.calendars) &&
    v.calendars.length <= 100
  ) {
    const calendars = v.calendars.map(parseCalendarGoogleCalendar);
    return calendars.every(Boolean) &&
      new Set(calendars.map((c) => c!.id)).size === calendars.length
      ? { kind: v.kind, calendars: calendars as CalendarGoogleCalendar[] }
      : null;
  }
  if (
    v.kind === 'PREVIEW' &&
    keys(v, [
      'kind',
      'previewId',
      'expiresAt',
      'from',
      'to',
      'calendar',
      'importCount',
      'skippedCount',
      'publishable',
    ]) &&
    parseUuid(v.previewId) &&
    parseIsoDateTime(v.expiresAt) &&
    parseIsoDateTime(v.from) &&
    parseIsoDateTime(v.to) &&
    Date.parse(v.to as string) > Date.parse(v.from as string) &&
    [v.importCount, v.skippedCount].every(
      (n) =>
        Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 1000,
    ) &&
    Array.isArray(v.publishable) &&
    v.publishable.length <= 200
  ) {
    const calendar = parseCalendarGoogleCalendar(v.calendar);
    if (
      calendar &&
      v.publishable.every(
        (e) =>
          obj(e) &&
          keys(e, ['id', 'title']) &&
          parseUuid(e.id) &&
          text(e.title, 200),
      ) &&
      new Set(v.publishable.map((e) => e.id)).size === v.publishable.length
    )
      return { ...v, calendar } as CalendarGoogleResponse;
  }
  if (
    v.kind === 'STATUS' &&
    keys(v, ['kind', 'state', 'calendar', 'lastSyncedAt', 'reason', 'links', 'autoSyncNewEvents']) &&
    typeof v.autoSyncNewEvents === 'boolean' &&
    member(v.state, CALENDAR_GOOGLE_STATES) &&
    (v.calendar === null || parseCalendarGoogleCalendar(v.calendar)) &&
    (v.lastSyncedAt === null || parseIsoDateTime(v.lastSyncedAt)) &&
    (v.reason === null || member(v.reason, CALENDAR_GOOGLE_REASONS)) &&
    Array.isArray(v.links) &&
    v.links.length <= 1000
  ) {
    for (const l of v.links)
      if (
        !obj(l) ||
        !keys(l, ['id', 'eventId', 'revision', 'state', 'local', 'remote']) ||
        !parseUuid(l.id) ||
        !parseUuid(l.eventId) ||
        !rev(l.revision) ||
        !member(l.state, [
          'PENDING',
          'SYNCED',
          'CONFLICT',
          'CANCELLED',
          'UNCERTAIN',
          'DETACHED',
        ]) ||
        !parseCalendarGoogleBody(l.local) ||
        (l.remote !== null && !parseCalendarGoogleBody(l.remote))
      )
        return null;
    if (new Set(v.links.map((l) => l.id)).size !== v.links.length) return null;
    return v as unknown as CalendarGoogleStatus;
  }
  return null;
}
