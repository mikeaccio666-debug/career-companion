/** Calendar v1 executable wire. Runtime activation requires T1-3 final convergence. */
import { AUTH_USER_ROLES, type AuthUserRole } from './auth.ts';
import { parseIsoDateTime, parseLocalDate, parseUuid } from './common.ts';
import { parseIanaTimeZone } from './ianaTimeZones.ts';

export const CALENDAR_EVENT_TYPES = ['interview', 'deadline', 'reminder', 'activity', 'timeline'] as const;
export const CALENDAR_EVENT_PROGRESS_STATUSES = ['NOT_STARTED', 'DONE', 'ARCHIVED'] as const;
export const CALENDAR_PAGE_SIZE = 200;
export const CALENDAR_REMINDER_RULE_KEYS = ['24_HOURS_BEFORE', '1_HOUR_BEFORE', '24_HOURS_BEFORE_END', 'ALL_DAY_PREVIOUS_0900'] as const;
export const CALENDAR_REMINDER_CHANNELS = ['IN_APP', 'EMAIL'] as const;
export type CalendarReminderRuleKey = (typeof CALENDAR_REMINDER_RULE_KEYS)[number];
export type CalendarReminderChannel = (typeof CALENDAR_REMINDER_CHANNELS)[number];
/** One reminder rule the viewer asked for on one event: when, and over which channels. */
export type CalendarReminderRule = Readonly<{ ruleKey: CalendarReminderRuleKey; channels: readonly CalendarReminderChannel[] }>;
/** Replaces the viewer's rules for one event; an empty list turns reminders off for it. */
export type CalendarReminderWrite = Readonly<{ rules: readonly CalendarReminderRule[] }>;
/** A planned delivery the viewer will receive, projected from the server's reminder rows. */
export type CalendarReminderView = Readonly<{ ruleKey: CalendarReminderRuleKey; channel: CalendarReminderChannel }>;
export type CalendarEventType = (typeof CALENDAR_EVENT_TYPES)[number];
export type CalendarEventProgressStatus = (typeof CALENDAR_EVENT_PROGRESS_STATUSES)[number];
export type CalendarEventCreator = 'student' | 'admin' | 'agent';
/** `audience` (C-7) is an admin fan-out target; only the admin audience routes may write it. */
export const CALENDAR_EVENT_VISIBILITIES = ['personal', 'public', 'cohort', 'audience'] as const;
/** The visibilities a viewer may choose on the normal create/update routes; unchanged by C-7. */
export const CALENDAR_SELF_SERVE_VISIBILITIES = ['personal', 'public', 'cohort'] as const;
export type CalendarEventVisibility = (typeof CALENDAR_EVENT_VISIBILITIES)[number];

/** One admin audience targets either one account or one role cohort — never a list of people. */
export const CALENDAR_AUDIENCE_KINDS = ['USER', 'ROLE'] as const;
export type CalendarAudienceKind = (typeof CALENDAR_AUDIENCE_KINDS)[number];
/** The account roles a role audience may name; the same closed set the job_agent user role carries. */
export const CALENDAR_AUDIENCE_ROLES = ['STUDENT', 'ADMIN'] as const;
export type CalendarAudienceRole = (typeof CALENDAR_AUDIENCE_ROLES)[number];
export type CalendarAudienceTarget =
  | Readonly<{ kind: 'USER'; userId: string }>
  | Readonly<{ kind: 'ROLE'; role: CalendarAudienceRole }>;
/**
 * The audience an admin chose, echoed back on admin reads only. `userId` is the admin's own input;
 * a role audience never names a member, and no read ever projects the recipient list.
 */
export type CalendarAudienceView = Readonly<{
  kind: CalendarAudienceKind;
  role?: CalendarAudienceRole;
  userId?: string;
  /** Bumped by every fan-out of this event, so a refresh is distinguishable from the first send. */
  revision: number;
}>;

export type CalendarEvent = {
  readonly id: string;
  readonly title: string;
  readonly type: CalendarEventType;
  readonly ownerId: string | null;
  readonly createdBy: CalendarEventCreator;
  readonly visibility: CalendarEventVisibility;
  readonly cohortId?: string;
  readonly startsAt: string;
  readonly endsAt?: string;
  readonly timezone: string;
  readonly allDay: boolean;
  readonly progressStatus: CalendarEventProgressStatus;
  /** Private viewer selection, or the unique owned Application/Role relation. Never an author-selected recipient. */
  readonly dailyReportConversationId?: string | null;
  readonly applicationId?: string;
  readonly company?: string;
  readonly position?: string;
  readonly resumeVersionId?: string;
  readonly resumeVersionLabel?: string;
  readonly location?: string;
  readonly description?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly googleSyncRevision?: number;
  readonly googleSyncState?: 'PENDING' | 'SYNCED' | 'CONFLICT' | 'CANCELLED' | 'UNCERTAIN';
  /** Monotonic body revision; reminders of an older revision are cancelled by the server. */
  readonly revision?: number;
  /** The current viewer's pending reminders for this revision. Absent when none are planned. */
  readonly reminders?: readonly CalendarReminderView[];
  /** Set only on agent-created events: the closed producer that owns the idempotent identity. */
  readonly sourceType?: string;
  /** Present iff `visibility` is `audience`, and only on the admin audience reads. */
  readonly audience?: CalendarAudienceView;
};

export type CalendarEventWrite = Omit<CalendarEvent,
  'id' | 'ownerId' | 'createdBy' | 'progressStatus' | 'dailyReportConversationId' | 'createdAt' | 'updatedAt' | 'googleSyncState'
  | 'revision' | 'reminders' | 'sourceType' | 'audience'> & { readonly syncToGoogle?: boolean };
export type CalendarEventProgressWrite = { readonly progressStatus: CalendarEventProgressStatus };
export type CalendarEventDailyReportWrite = { readonly conversationId: string | null };
export type CalendarEventList = {
  readonly events: readonly CalendarEvent[];
  readonly role: AuthUserRole;
  readonly nextCursor?: string;
  /** Channels the server can deliver reminders over right now; EMAIL is absent while no provider is configured. */
  readonly reminderChannels?: readonly CalendarReminderChannel[];
};
export type CalendarRange = { readonly from: string; readonly to: string; readonly cursor?: string };
export type CalendarCohort = { readonly id: string; readonly name: string; readonly memberCount: number };
export type CalendarCohortList = { readonly cohorts: readonly CalendarCohort[] };
export type CalendarHideResponse = { readonly ok: true };

/** One admin audience event plus its counts. Counts only: no read ever returns a recipient list. */
export type CalendarAudienceCounts = Readonly<{
  recipients: number;
  hidden: number;
  byProgress: Readonly<Record<CalendarEventProgressStatus, number>>;
}>;
export type CalendarAudienceWrite = Readonly<{ event: CalendarEventWrite; audience: CalendarAudienceTarget }>;
export type CalendarAudiencePreview = Readonly<{ recipientCount: number }>;
export type CalendarAdminEvent = Readonly<{ event: CalendarEvent; counts: CalendarAudienceCounts }>;
export type CalendarAdminEventList = Readonly<{ events: readonly CalendarAdminEvent[]; nextCursor?: string }>;
/** A refresh reports the same counts plus how many newly eligible accounts it added. */
export type CalendarAudienceRefresh = Readonly<{ counts: CalendarAudienceCounts; added: number }>;

const REQUIRED_WRITE_KEYS = ['title', 'type', 'visibility', 'startsAt', 'timezone', 'allDay'] as const;
const OPTIONAL_WRITE_KEYS = ['cohortId', 'endsAt', 'applicationId', 'company', 'position', 'resumeVersionId',
  'resumeVersionLabel', 'location', 'description', 'googleSyncRevision', 'syncToGoogle'] as const;
const EVENT_KEYS = ['id', 'ownerId', 'createdBy', 'progressStatus', 'dailyReportConversationId', 'createdAt', 'updatedAt', 'googleSyncState', 'revision', 'reminders', 'sourceType', 'audience'] as const;
const TEXT_LIMITS = { company: 200, position: 200, resumeVersionLabel: 200, location: 500, description: 4000 } as const;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
function member<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}
function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0');
}
function date(value: unknown, allDay: boolean): boolean {
  return allDay
    ? parseLocalDate(value) !== null || (parseIsoDateTime(value) !== null && /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.0+)?Z$/.test(value as string))
    : parseIsoDateTime(value) !== null;
}

export function parseCalendarEventWrite(value: unknown): CalendarEventWrite | null {
  return parseEventBody(value, CALENDAR_SELF_SERVE_VISIBILITIES);
}

/**
 * The shared event body. `visibilities` is the closed set this caller may name: the normal
 * create/update routes keep the three self-serve values, while the admin audience write and the
 * read projection also accept `audience`.
 */
function parseEventBody(value: unknown, visibilities: readonly CalendarEventVisibility[]): CalendarEventWrite | null {
  if (!record(value) || !keys(value, REQUIRED_WRITE_KEYS, OPTIONAL_WRITE_KEYS)) return null;
  if (!boundedText(value.title, 200) || !member(value.type, CALENDAR_EVENT_TYPES)
    || !member(value.visibility, visibilities) || typeof value.allDay !== 'boolean'
    || !parseIanaTimeZone(value.timezone) || !date(value.startsAt, value.allDay)) return null;
  if (value.endsAt !== undefined && (!date(value.endsAt, value.allDay)
    || Date.parse(value.endsAt as string) <= Date.parse(value.startsAt as string))) return null;
  for (const key of ['cohortId', 'applicationId', 'resumeVersionId'] as const) {
    if (value[key] !== undefined && !parseUuid(value[key])) return null;
  }
  if ((value.visibility === 'cohort') !== (value.cohortId !== undefined)) return null;
  for (const [key, max] of Object.entries(TEXT_LIMITS)) {
    if (value[key] !== undefined && !boundedText(value[key], max)) return null;
  }
  if (value.visibility !== 'personal' && ['applicationId', 'company', 'position', 'resumeVersionId', 'resumeVersionLabel']
    .some((key) => value[key] !== undefined)) return null;
  if (value.googleSyncRevision !== undefined && (!Number.isSafeInteger(value.googleSyncRevision) || (value.googleSyncRevision as number) < 1)) return null;
  if (value.syncToGoogle !== undefined && typeof value.syncToGoogle !== 'boolean') return null;
  return { ...value } as CalendarEventWrite;
}

export function parseCalendarEvent(value: unknown): CalendarEvent | null {
  if (!record(value) || !keys(value, [...REQUIRED_WRITE_KEYS, 'id', 'ownerId', 'createdBy', 'progressStatus'],
    [...OPTIONAL_WRITE_KEYS.filter(k => k !== 'syncToGoogle'), 'dailyReportConversationId', 'createdAt', 'updatedAt', 'googleSyncState', 'revision', 'reminders', 'sourceType', 'audience'])) return null;
  // The chosen audience is an admin-read projection: a recipient's copy of the same event omits it.
  if (value.audience !== undefined && (value.visibility !== 'audience' || !audienceView(value.audience))) return null;
  if (value.revision !== undefined && (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1)) return null;
  if (value.reminders !== undefined && !reminderViews(value.reminders)) return null;
  if (value.sourceType !== undefined && !(typeof value.sourceType === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/u.test(value.sourceType))) return null;
  if (value.googleSyncState !== undefined && (!member(value.googleSyncState, ['PENDING','SYNCED','CONFLICT','CANCELLED','UNCERTAIN']) || value.googleSyncRevision === undefined)) return null;
  if (!parseUuid(value.id) || (value.ownerId !== null && !parseUuid(value.ownerId))
    || !member(value.createdBy, ['student', 'admin', 'agent'])
    || !member(value.progressStatus, CALENDAR_EVENT_PROGRESS_STATUSES)) return null;
  if (value.dailyReportConversationId !== undefined && value.dailyReportConversationId !== null
    && !parseUuid(value.dailyReportConversationId)) return null;
  for (const key of ['createdAt', 'updatedAt'] as const) {
    if (value[key] !== undefined && !parseIsoDateTime(value[key])) return null;
  }
  const input = Object.fromEntries(Object.entries(value).filter(([key]) => !(EVENT_KEYS as readonly string[]).includes(key)));
  if (!parseEventBody(input, CALENDAR_EVENT_VISIBILITIES)) return null;
  if (value.visibility === 'personal' && value.ownerId === null) return null;
  if (value.createdBy === 'student' && value.visibility !== 'personal') return null;
  // An audience event is always authored by an admin who stays its only editor.
  if (value.visibility === 'audience' && (value.createdBy !== 'admin' || value.ownerId === null)) return null;
  return { ...value } as CalendarEvent;
}

/** `{kind, revision}` plus exactly the one target key that kind implies; never a member list. */
function audienceView(value: unknown): value is CalendarAudienceView {
  if (!record(value) || !member(value.kind, CALENDAR_AUDIENCE_KINDS) || !count(value.revision)) return false;
  return value.kind === 'USER'
    ? keys(value, ['kind', 'revision', 'userId']) && parseUuid(value.userId) !== null
    : keys(value, ['kind', 'revision', 'role']) && member(value.role, CALENDAR_AUDIENCE_ROLES);
}

/** Strict: exactly one target key, matching the declared kind. */
export function parseCalendarAudienceTarget(value: unknown): CalendarAudienceTarget | null {
  if (!record(value) || !member(value.kind, CALENDAR_AUDIENCE_KINDS)) return null;
  if (value.kind === 'USER') {
    return keys(value, ['kind', 'userId']) && parseUuid(value.userId)
      ? { kind: 'USER', userId: value.userId as string } : null;
  }
  return keys(value, ['kind', 'role']) && member(value.role, CALENDAR_AUDIENCE_ROLES)
    ? { kind: 'ROLE', role: value.role } : null;
}

/**
 * The body of an event whose visibility is already `audience`. The admin owner edits its body
 * through the normal update route; the audience itself is never part of a body edit.
 */
export function parseCalendarAudienceEventWrite(value: unknown): CalendarEventWrite | null {
  return parseEventBody(value, ['audience']);
}

/** The admin audience create body: one event body fixed to `audience`, plus one target. */
export function parseCalendarAudienceWrite(value: unknown): CalendarAudienceWrite | null {
  if (!record(value) || !keys(value, ['event', 'audience'])) return null;
  const event = parseCalendarAudienceEventWrite(value.event);
  const audience = parseCalendarAudienceTarget(value.audience);
  return event && audience ? { event, audience } : null;
}

export function parseCalendarAudiencePreview(value: unknown): CalendarAudiencePreview | null {
  return record(value) && keys(value, ['recipientCount']) && Number.isSafeInteger(value.recipientCount)
    && (value.recipientCount as number) >= 0 ? { recipientCount: value.recipientCount as number } : null;
}

export function parseCalendarAudienceCounts(value: unknown): CalendarAudienceCounts | null {
  if (!record(value) || !keys(value, ['recipients', 'hidden', 'byProgress'])
    || !count(value.recipients) || !count(value.hidden) || !record(value.byProgress)
    || !keys(value.byProgress, CALENDAR_EVENT_PROGRESS_STATUSES)) return null;
  const byProgress = value.byProgress as Record<CalendarEventProgressStatus, unknown>;
  if (!CALENDAR_EVENT_PROGRESS_STATUSES.every((status) => count(byProgress[status]))) return null;
  const totals = CALENDAR_EVENT_PROGRESS_STATUSES.reduce((sum, status) => sum + (byProgress[status] as number), 0);
  if (totals !== value.recipients || (value.hidden as number) > (value.recipients as number)) return null;
  return {
    recipients: value.recipients as number, hidden: value.hidden as number,
    byProgress: Object.fromEntries(CALENDAR_EVENT_PROGRESS_STATUSES
      .map((status) => [status, byProgress[status] as number])) as CalendarAudienceCounts['byProgress'],
  };
}

export function parseCalendarAdminEvent(value: unknown): CalendarAdminEvent | null {
  if (!record(value) || !keys(value, ['event', 'counts'])) return null;
  const event = parseCalendarEvent(value.event);
  const counts = parseCalendarAudienceCounts(value.counts);
  return event && counts && event.visibility === 'audience' && event.audience !== undefined ? { event, counts } : null;
}

export function parseCalendarAdminEventList(value: unknown): CalendarAdminEventList | null {
  if (!record(value) || !keys(value, ['events'], ['nextCursor']) || !Array.isArray(value.events)
    || value.events.length > CALENDAR_PAGE_SIZE
    || (value.nextCursor !== undefined && !parseUuid(value.nextCursor))) return null;
  const events = value.events.map(parseCalendarAdminEvent);
  if (events.some((entry) => entry === null)
    || new Set(events.map((entry) => entry!.event.id)).size !== events.length) return null;
  return { events: events as CalendarAdminEvent[], ...(value.nextCursor ? { nextCursor: value.nextCursor as string } : {}) };
}

export function parseCalendarAudienceRefresh(value: unknown): CalendarAudienceRefresh | null {
  if (!record(value) || !keys(value, ['counts', 'added']) || !count(value.added)) return null;
  const counts = parseCalendarAudienceCounts(value.counts);
  return counts ? { counts, added: value.added as number } : null;
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function parseCalendarEventList(value: unknown): CalendarEventList | null {
  if (!record(value) || !keys(value, ['events', 'role'], ['nextCursor', 'reminderChannels'])
    || !member(value.role, AUTH_USER_ROLES) || !Array.isArray(value.events) || value.events.length > CALENDAR_PAGE_SIZE
    || (value.nextCursor !== undefined && !parseUuid(value.nextCursor))
    || (value.reminderChannels !== undefined && !channelList(value.reminderChannels))) return null;
  const events = value.events.map(parseCalendarEvent);
  if (events.some((event) => event === null) || new Set(events.map((event) => event!.id)).size !== events.length) return null;
  return { events: events as CalendarEvent[], role: value.role, ...(value.nextCursor ? { nextCursor: value.nextCursor as string } : {}),
    ...(value.reminderChannels !== undefined ? { reminderChannels: [...(value.reminderChannels as CalendarReminderChannel[])] } : {}) };
}

export function parseCalendarProgressWrite(value: unknown): CalendarEventProgressWrite | null {
  return record(value) && keys(value, ['progressStatus']) && member(value.progressStatus, CALENDAR_EVENT_PROGRESS_STATUSES)
    ? { progressStatus: value.progressStatus } : null;
}

export function parseCalendarDailyReportWrite(value: unknown): CalendarEventDailyReportWrite | null {
  return record(value) && keys(value, ['conversationId']) && (value.conversationId === null || parseUuid(value.conversationId))
    ? { conversationId: value.conversationId as string | null } : null;
}

function channelList(value: unknown): value is CalendarReminderChannel[] {
  return Array.isArray(value) && value.length <= CALENDAR_REMINDER_CHANNELS.length
    && value.every((channel) => member(channel, CALENDAR_REMINDER_CHANNELS)) && new Set(value).size === value.length;
}

function reminderViews(value: unknown): value is CalendarReminderView[] {
  if (!Array.isArray(value) || value.length > CALENDAR_REMINDER_RULE_KEYS.length * CALENDAR_REMINDER_CHANNELS.length) return false;
  const seen = new Set<string>();
  for (const entry of value) {
    if (!record(entry) || !keys(entry, ['ruleKey', 'channel']) || !member(entry.ruleKey, CALENDAR_REMINDER_RULE_KEYS)
      || !member(entry.channel, CALENDAR_REMINDER_CHANNELS)) return false;
    const key = `${entry.ruleKey}:${entry.channel}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

/** Strict: known keys only, each rule key at most once, each channel at most once per rule, at most one rule per key. */
export function parseCalendarReminderWrite(value: unknown): CalendarReminderWrite | null {
  if (!record(value) || !keys(value, ['rules']) || !Array.isArray(value.rules) || value.rules.length > CALENDAR_REMINDER_RULE_KEYS.length) return null;
  const rules: CalendarReminderRule[] = [];
  for (const rule of value.rules) {
    if (!record(rule) || !keys(rule, ['ruleKey', 'channels']) || !member(rule.ruleKey, CALENDAR_REMINDER_RULE_KEYS)
      || !channelList(rule.channels) || rule.channels.length === 0) return null;
    rules.push({ ruleKey: rule.ruleKey, channels: [...rule.channels] });
  }
  return new Set(rules.map((rule) => rule.ruleKey)).size === rules.length ? { rules } : null;
}

export function parseCalendarRange(value: unknown): CalendarRange | null {
  if (!record(value) || !keys(value, ['from', 'to'], ['cursor']) || !parseIsoDateTime(value.from)
    || !parseIsoDateTime(value.to) || (value.cursor !== undefined && !parseUuid(value.cursor))) return null;
  const duration = Date.parse(value.to as string) - Date.parse(value.from as string);
  // Preserves the existing Portal's year-before through year-after query, including leap years.
  if (duration <= 0 || duration > 1097 * 86_400_000) return null;
  return { from: value.from as string, to: value.to as string, ...(value.cursor ? { cursor: value.cursor as string } : {}) };
}

export function parseCalendarCohortList(value: unknown): CalendarCohortList | null {
  if (!record(value) || !keys(value, ['cohorts']) || !Array.isArray(value.cohorts)) return null;
  const cohorts: CalendarCohort[] = [];
  for (const cohort of value.cohorts) {
    if (!record(cohort) || !keys(cohort, ['id', 'name', 'memberCount']) || !parseUuid(cohort.id)
      || !boundedText(cohort.name, 200) || !Number.isSafeInteger(cohort.memberCount) || (cohort.memberCount as number) < 0) return null;
    cohorts.push({ id: cohort.id as string, name: cohort.name, memberCount: cohort.memberCount as number });
  }
  return new Set(cohorts.map(({ id }) => id)).size === cohorts.length ? { cohorts } : null;
}
