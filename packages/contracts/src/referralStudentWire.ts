import { parseIsoDateTime, parseUuid } from './common.ts';
import { parseIanaTimeZone } from './ianaTimeZones.ts';
import {
  REFERRAL_COFFEE_CHAT_SLOT_STATUSES, REFERRAL_MEETING_PROVIDERS,
  REFERRAL_MENTOR_WORKFLOW_STATUSES, REFERRAL_GUARANTEE_STATES,
  REFERRAL_GUARANTEE_REMEDIES, REFERRAL_GUARANTEE_REMEDY_REASONS,
  REFERRAL_OUTCOME_STATUSES, REFERRAL_OUTCOME_EVIDENCE_SOURCES,
  REFERRAL_OUTCOME_PROJECTION_STATES, REFERRAL_OUTCOME_PROJECTION_REASONS,
  type StudentReferralCoffeeChatItem, type ListStudentReferralCoffeeChatsResponse,
  type ListStudentReferralCoffeeChatsPageResponse, type ListStudentReferralCoffeeChatsQuery,
} from './referrals.ts';

const STUDENT_KEYS = ['referralRequestId', 'jobId', 'jobTitle', 'company', 'status', 'revision', 'slots'];
export function parseStudentReferralCoffeeChatsQuery(value: unknown): ListStudentReferralCoffeeChatsQuery | null {
  if (!record(value) || Object.keys(value).some((key) => key !== 'limit' && key !== 'cursor')) return null;
  if (Object.keys(value).length === 0) return {};
  if (!Number.isInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 100 ||
      ('cursor' in value && parseUuid(value.cursor) === null)) return null;
  return { limit: Number(value.limit), ...('cursor' in value ? { cursor: parseUuid(value.cursor)! } : {}) };
}

export function parseStudentReferralCoffeeChatItem(value: unknown): StudentReferralCoffeeChatItem | null {
  if (!record(value) || !STUDENT_KEYS.every((key) => key in value) ||
      Object.keys(value).some((key) => !STUDENT_KEYS.includes(key) && key !== 'guarantee' && key !== 'referralOutcome') ||
      !parseUuid(value.referralRequestId) || !bounded(value.jobId, 512) ||
      !nullableBounded(value.jobTitle, 512) || !nullableBounded(value.company, 255) ||
      !REFERRAL_MENTOR_WORKFLOW_STATUSES.includes(value.status as never) || !decimal(value.revision) ||
      !Array.isArray(value.slots) || value.slots.length > 5 || !value.slots.every(slot) ||
      ('guarantee' in value && !guarantee(value.guarantee)) ||
      ('referralOutcome' in value && !outcome(value.referralOutcome))) return null;
  return value as unknown as StudentReferralCoffeeChatItem;
}

export function parseStudentReferralCoffeeChatsResponse(value: unknown): ListStudentReferralCoffeeChatsResponse | null {
  return list(value, false) ? value as unknown as ListStudentReferralCoffeeChatsResponse : null;
}

export function parseStudentReferralCoffeeChatsPage(value: unknown): ListStudentReferralCoffeeChatsPageResponse | null {
  if (!list(value, true) || !record(value) ||
      (value.nextCursor !== null && parseUuid(value.nextCursor) === null)) return null;
  const items = value.items as StudentReferralCoffeeChatItem[];
  if (new Set(items.map((item) => item.referralRequestId)).size !== items.length ||
      (value.nextCursor !== null && (items.length === 0 || items.at(-1)!.referralRequestId !== value.nextCursor))) return null;
  return value as unknown as ListStudentReferralCoffeeChatsPageResponse;
}

function list(value: unknown, paged: boolean): boolean {
  return exact(value, paged ? ['schemaVersion', 'items', 'nextCursor'] : ['schemaVersion', 'items']) &&
    value.schemaVersion === 1 && Array.isArray(value.items) && value.items.length <= 100 &&
    value.items.every((item) => parseStudentReferralCoffeeChatItem(item) !== null);
}
function slot(value: unknown): boolean {
  if (!exact(value, ['slotId', 'startAt', 'endAt', 'timeZone', 'status', 'meetingProvider', 'meetingUrl'])) return false;
  const start = parseIsoDateTime(value.startAt), end = parseIsoDateTime(value.endAt);
  return Boolean(parseUuid(value.slotId) && start && end && Date.parse(end) > Date.parse(start) &&
    parseIanaTimeZone(value.timeZone) && REFERRAL_COFFEE_CHAT_SLOT_STATUSES.includes(value.status as never) &&
    (value.meetingProvider === null || REFERRAL_MEETING_PROVIDERS.includes(value.meetingProvider as never)) &&
    (value.meetingUrl === null || meetingUrl(value.meetingUrl)));
}
function meetingUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 2048 || value !== value.trim()) return false;
  try {
    const url = new URL(value), host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash &&
      ((host === 'meet.google.com' && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/.test(url.pathname)) ||
        ((host === 'zoom.us' || host.endsWith('.zoom.us')) &&
          (/^\/j\/[0-9]{9,11}\/?$/.test(url.pathname) || /^\/my\/[A-Za-z0-9._-]{1,128}\/?$/.test(url.pathname))));
  } catch { return false; }
}
function guarantee(value: unknown): boolean {
  return exact(value, ['state', 'deadlineAt', 'attempt', 'revision', 'remedyReason', 'lastRemedy']) && Boolean(
    REFERRAL_GUARANTEE_STATES.includes(value.state as never) && parseIsoDateTime(value.deadlineAt) &&
    Number.isSafeInteger(value.attempt) && Number(value.attempt) > 0 && decimal(value.revision) &&
    (value.remedyReason === null || REFERRAL_GUARANTEE_REMEDY_REASONS.includes(value.remedyReason as never)) &&
    (value.lastRemedy === null || REFERRAL_GUARANTEE_REMEDIES.includes(value.lastRemedy as never)));
}
function outcome(value: unknown): boolean {
  return exact(value, ['status', 'evidenceSource', 'revision', 'recordedAt', 'projectionState', 'projectionReason', 'applicationId']) && Boolean(
    REFERRAL_OUTCOME_STATUSES.includes(value.status as never) &&
    (value.evidenceSource === null || REFERRAL_OUTCOME_EVIDENCE_SOURCES.includes(value.evidenceSource as never)) &&
    decimal(value.revision) && (value.recordedAt === null || parseIsoDateTime(value.recordedAt)) &&
    REFERRAL_OUTCOME_PROJECTION_STATES.includes(value.projectionState as never) &&
    REFERRAL_OUTCOME_PROJECTION_REASONS.includes(value.projectionReason as never) &&
    (value.applicationId === null || parseUuid(value.applicationId)));
}
function bounded(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max; }
function nullableBounded(value: unknown, max: number): boolean { return value === null || bounded(value, max); }
function decimal(value: unknown): boolean { return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> { return record(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
