import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseCareerInterview } from '@companion/platform-contracts';
import { interviewDraft, interviewEditorIntent } from '../src/career-interview-presentation.ts';
const owner = randomUUID(), id = randomUUID(), appId = randomUUID(), at = '2026-10-08T10:00:00.000Z';
const record = parseCareerInterview({ id, ownerId: owner, revision: 1, lastOperationId: randomUUID(), createdAt: at, updatedAt: at, source: 'user_recorded',
  application: { id: appId, ownerId: owner, revision: 3, employer: 'Fictional Company', title: 'Fictional Analyst', roleFamily: 'da' }, roundType: 'behavioral',
  startsAt: '2026-11-01T06:30:17.123Z', timeZone: 'America/New_York', durationMin: 45, status: 'scheduled', briefId: null, debrief: null });
const applications = [{ id: appId, revision: 3 }] as any;
test('new form begins blank; explicit overlap choice and owner confirmation are required', () => {
  const blank = interviewDraft('create');
  assert.equal(blank.applicationId, ''); assert.equal(blank.roundType, ''); assert.equal(blank.duration, '');
  assert.equal(blank.timeZone, ''); assert.equal(blank.localTime, ''); assert.equal(blank.selectedInstant, ''); assert.equal(blank.confirmed, false);
  const draft = { ...blank, applicationId: appId, roundType: 'sql' as const, duration: '60', timeZone: 'America/New_York', localTime: '2026-11-01T01:30', confirmed: true };
  assert.throws(() => interviewEditorIntent(draft, applications, randomUUID()), /两次/);
  assert.throws(() => interviewEditorIntent({ ...draft, selectedInstant: '2026-11-01T05:30:00.000Z', confirmed: false }, applications, randomUUID()), /确认/);
  assert.throws(() => interviewEditorIntent({ ...draft, selectedInstant: '2026-11-01T05:30:00.000Z' }, [], randomUUID()), /投递/);
  const saved = interviewEditorIntent({ ...draft, selectedInstant: '2026-11-01T06:30:00.000Z' }, applications, randomUUID());
  assert.equal((saved.body as any).startsAt, '2026-11-01T06:30:00.000Z'); assert.equal((saved.body as any).applicationRevision, 3);
  assert.equal(Object.hasOwn(saved.body as object, 'action'), false);
});
test('opening a saved ambiguous time selects its actual original instant and preserves sub-minute precision', () => {
  const draft = interviewDraft('reschedule', record);
  assert.equal(draft.selectedInstant, record.startsAt); assert.equal(draft.localTime, '2026-11-01T01:30:17.123');
  assert.equal(draft.confirmed, false);
  const result = interviewEditorIntent({ ...draft, confirmed: true }, [], randomUUID());
  assert.equal((result.body as any).startsAt, record.startsAt); assert.equal((result.body as any).expectedRevision, 1);
});
test('gaps and non-positive, fractional or padded duration cannot be silently normalized', () => {
  const draft = { ...interviewDraft('create'), applicationId: appId, roundType: 'sql' as const, duration: '60', timeZone: 'America/New_York', localTime: '2026-03-08T02:30', confirmed: true };
  assert.throws(() => interviewEditorIntent(draft, applications, randomUUID()), /跳过/);
  for (const duration of ['', '0', '-1', '01', '1.5', ' 20', '2147483648'])
    assert.throws(() => interviewEditorIntent({ ...draft, localTime: '2026-10-08T12:00', duration }, applications, randomUUID()));
  const saved = interviewEditorIntent({ ...interviewDraft('edit', record), roundType: 'sql', duration: '90', confirmed: true }, [], randomUUID());
  assert.deepEqual(Object.keys(saved.body as object).sort(), ['durationMin', 'expectedRevision', 'operationId', 'roundType']);
});
