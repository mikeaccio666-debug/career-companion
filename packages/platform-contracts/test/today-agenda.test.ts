import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTodayAgenda } from '../src/today-agenda.ts';
const id = '11111111-1111-4111-8111-111111111111';
const base = () => ({ ownerId: id, companionId: id, capturedAt: '2026-11-01T17:00:00.000Z', localDate: '2026-11-01', timeZone: 'America/New_York', resting: false,
  events: [{ kind: 'interview', id, title: 'Fictional role', employer: 'Fictional employer', at: '2026-11-01T05:30:00.000Z', endsAt: '2026-11-01T06:15:00.000Z', timeZone: 'America/Los_Angeles' }],
  pending: { scope: 'resume_reviews', count: 1, earliestExpiresAt: '2026-11-02T17:00:00.000Z' } });
test('owned agenda validates actual dates, overnight overlap and immutable arrays', () => {
  const v = parseTodayAgenda(base()); assert(Object.isFrozen(v)); assert(Object.isFrozen(v.events[0])); assert(Object.isFrozen(v.pending));
  const b = base(); b.events[0].at = '2026-11-01T03:30:00.000Z'; b.events[0].endsAt = '2026-11-01T04:30:00.000Z'; assert.equal(parseTodayAgenda(b).events.length, 1);
  b.events[0].endsAt = '2026-11-01T04:00:00.000Z'; assert.throws(() => parseTodayAgenda(b));
  assert.throws(() => parseTodayAgenda({ ...base(), localDate: '2026-11-02' }));
});
test('unknown fields, accessors, duplicate or out-of-day events cannot enter the calendar', () => {
  assert.throws(() => parseTodayAgenda({ ...base(), rawResume: 'private' }));
  const b = base(); b.events.push(b.events[0]); assert.throws(() => parseTodayAgenda(b));
  const c = base(); c.events[0].at = '2026-11-02T16:00:00.000Z'; c.events[0].endsAt = '2026-11-02T17:00:00.000Z'; assert.throws(() => parseTodayAgenda(c));
  let invoked = false; const events = []; Object.defineProperty(events, 0, { get() { invoked = true; return base().events[0]; }, enumerable: true });
  assert.throws(() => parseTodayAgenda({ ...base(), events })); assert.equal(invoked, false);
});
test('rest cannot carry pending prompts; empty counts and expired deadlines must be consistent', () => {
  assert.throws(() => parseTodayAgenda({ ...base(), resting: true }));
  assert.equal(parseTodayAgenda({ ...base(), resting: true, pending: null }).pending, null);
  assert.throws(() => parseTodayAgenda({ ...base(), pending: null }));
  for (const pending of [{ scope: 'all_pending', count: 1, earliestExpiresAt: '2026-11-02T17:00:00.000Z' },
    { scope: 'resume_reviews', count: 0, earliestExpiresAt: '2026-11-02T17:00:00.000Z' },
    { scope: 'resume_reviews', count: 1, earliestExpiresAt: '2026-11-01T17:00:00.000Z' }]) assert.throws(() => parseTodayAgenda({ ...base(), pending }));
});
