import { describe, expect, it } from 'vitest';
import { parseNotificationItem, parseNotificationList, parseNotificationReadWrite } from '../src/notifications';

const item = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'CALENDAR_REMINDER',
  title: { en: 'Calendar reminder', zh: '日历提醒' },
  body: { en: 'Portfolio review starts in 24 hours.', zh: '作品集评审 24 小时后开始。' },
  href: '/calendar?event=11111111-1111-4111-8111-111111111111',
  createdAt: '2026-09-05T17:00:00.000Z',
  readAt: null,
  metadata: { eventId: '11111111-1111-4111-8111-111111111111', revision: 2 },
};

describe('Notification wire', () => {
  it('accepts an exact item with localized copy, a same-origin path and scalar metadata', () => {
    expect(parseNotificationItem(item)).toEqual(item);
    expect(parseNotificationItem({ ...item, readAt: '2026-09-05T18:00:00.000Z' })).toEqual({ ...item, readAt: '2026-09-05T18:00:00.000Z' });
  });

  it('rejects unknown kinds, external hrefs, partial copy, non-scalar metadata and extra keys', () => {
    expect(parseNotificationItem({ ...item, kind: 'MARKETING' })).toBeNull();
    expect(parseNotificationItem({ ...item, href: 'https://example.com/x' })).toBeNull();
    expect(parseNotificationItem({ ...item, href: '//example.com/x' })).toBeNull();
    expect(parseNotificationItem({ ...item, title: { en: 'Only English' } })).toBeNull();
    expect(parseNotificationItem({ ...item, metadata: { nested: { a: 1 } } })).toBeNull();
    expect(parseNotificationItem({ ...item, readAt: 'yesterday' })).toBeNull();
    expect(parseNotificationItem({ ...item, email: 'x@example.com' })).toBeNull();
  });

  it('bounds the list and requires distinct ids and a non-negative unread count', () => {
    expect(parseNotificationList({ items: [item], unreadCount: 1 })).toEqual({ items: [item], unreadCount: 1 });
    expect(parseNotificationList({ items: [item, item], unreadCount: 2 })).toBeNull();
    expect(parseNotificationList({ items: [], unreadCount: -1 })).toBeNull();
    expect(parseNotificationList({ items: Array.from({ length: 51 }, (_, index) => ({ ...item, id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}` })), unreadCount: 0 })).toBeNull();
  });

  it('marks listed ids or everything, never both', () => {
    expect(parseNotificationReadWrite({ ids: [item.id] })).toEqual({ ids: [item.id] });
    expect(parseNotificationReadWrite({ all: true })).toEqual({ all: true });
    expect(parseNotificationReadWrite({ all: false })).toBeNull();
    expect(parseNotificationReadWrite({ ids: [] })).toBeNull();
    expect(parseNotificationReadWrite({ ids: [item.id, item.id] })).toBeNull();
    expect(parseNotificationReadWrite({ ids: [item.id], all: true })).toBeNull();
  });
});
