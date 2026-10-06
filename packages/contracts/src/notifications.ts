import { parseIsoDateTime, parseUuid, type IsoDateTime, type Uuid } from './common.ts';

/**
 * Owner-scoped in-app notifications (C-4). The store is the existing job_agent.user_notifications /
 * notification_templates pair; templates carry localized copy, so the wire returns both languages and
 * the Portal picks by locale. Producers are closed: only the calendar reminder worker writes today,
 * for a due reminder (C-4) and for an admin audience an account was added to (C-7).
 */
export const NOTIFICATION_KINDS = ['CALENDAR_REMINDER', 'CALENDAR_AUDIENCE'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export const NOTIFICATION_PAGE_SIZE = 50;

export type LocalizedNotificationText = Readonly<{ en: string; zh: string }>;

export type NotificationItem = Readonly<{
  id: Uuid;
  kind: NotificationKind;
  title: LocalizedNotificationText;
  body: LocalizedNotificationText;
  /** Same-origin Portal path the notification opens; never an external URL. */
  href: string;
  createdAt: IsoDateTime;
  readAt: IsoDateTime | null;
  /** Closed scalar metadata (e.g. eventId); never Data-L1. */
  metadata: Readonly<Record<string, string | number | boolean | null>>;
}>;

export type NotificationList = Readonly<{
  items: readonly NotificationItem[];
  unreadCount: number;
}>;

/** Mark the listed notifications read, or every unread one for the owner. */
export type NotificationReadWrite =
  | Readonly<{ ids: readonly Uuid[] }>
  | Readonly<{ all: true }>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key));
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0');
}
function localized(value: unknown): value is LocalizedNotificationText {
  return record(value) && exactKeys(value, ['en', 'zh']) && text(value.en, 1000) && text(value.zh, 1000);
}
function portalPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 500 && /^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/?#-]*$/u.test(value);
}
function scalarMetadata(value: unknown): value is NotificationItem['metadata'] {
  if (!record(value) || Object.keys(value).length > 16) return false;
  return Object.entries(value).every(([key, entry]) => /^[a-zA-Z][a-zA-Z0-9]{0,63}$/u.test(key)
    && (entry === null || ['string', 'number', 'boolean'].includes(typeof entry))
    && (typeof entry !== 'string' || entry.length <= 500));
}

export function parseNotificationItem(value: unknown): NotificationItem | null {
  if (!record(value) || !exactKeys(value, ['id', 'kind', 'title', 'body', 'href', 'createdAt', 'readAt', 'metadata'])) return null;
  const id = parseUuid(value.id);
  const createdAt = parseIsoDateTime(value.createdAt);
  const readAt = value.readAt === null ? null : parseIsoDateTime(value.readAt);
  if (!id || !createdAt || readAt === null && value.readAt !== null || readAt === undefined) return null;
  if (!(NOTIFICATION_KINDS as readonly string[]).includes(value.kind as string) || !localized(value.title)
    || !localized(value.body) || !portalPath(value.href) || !scalarMetadata(value.metadata)) return null;
  return Object.freeze({
    id, kind: value.kind as NotificationKind, title: value.title, body: value.body, href: value.href,
    createdAt, readAt, metadata: Object.freeze({ ...value.metadata }),
  });
}

export function parseNotificationList(value: unknown): NotificationList | null {
  if (!record(value) || !exactKeys(value, ['items', 'unreadCount']) || !Array.isArray(value.items)
    || value.items.length > NOTIFICATION_PAGE_SIZE || !Number.isSafeInteger(value.unreadCount) || (value.unreadCount as number) < 0) return null;
  const items = value.items.map(parseNotificationItem);
  if (items.some((item) => item === null) || new Set(items.map((item) => item!.id)).size !== items.length) return null;
  return Object.freeze({ items: Object.freeze(items as NotificationItem[]), unreadCount: value.unreadCount as number });
}

export function parseNotificationReadWrite(value: unknown): NotificationReadWrite | null {
  if (!record(value)) return null;
  if (exactKeys(value, ['all'])) return value.all === true ? { all: true } : null;
  if (!exactKeys(value, ['ids']) || !Array.isArray(value.ids) || value.ids.length === 0 || value.ids.length > NOTIFICATION_PAGE_SIZE) return null;
  const ids = value.ids.map(parseUuid);
  if (ids.some((id) => id === null) || new Set(ids).size !== ids.length) return null;
  return { ids: ids as Uuid[] };
}
