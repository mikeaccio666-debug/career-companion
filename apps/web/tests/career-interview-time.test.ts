import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveInterviewTime, interviewLocalInput, displayInterviewTime } from '../src/career-interview-time.ts';
test('New York spring gap is rejected and autumn overlap exposes two instants without choosing one', () => {
  const gap = resolveInterviewTime('2026-03-08T02:30', 'America/New_York');
  assert.equal(gap.kind, 'gap'); assert.deepEqual(gap.candidates, []);
  const overlap = resolveInterviewTime('2026-11-01T01:30', 'America/New_York');
  assert.equal(overlap.kind, 'ambiguous');
  assert.deepEqual(overlap.candidates.map(c => c.startsAt), ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']);
  assert.match(overlap.candidates[0].label, /UTC-04:00/); assert.match(overlap.candidates[1].label, /UTC-05:00/);
});
test('half-hour DST and a whole skipped calendar day do not assume one-hour transitions', () => {
  assert.equal(resolveInterviewTime('2026-10-04T02:15', 'Australia/Lord_Howe').kind, 'gap');
  const overlap = resolveInterviewTime('2026-04-05T01:45', 'Australia/Lord_Howe');
  assert.equal(overlap.kind, 'ambiguous');
  assert.deepEqual(overlap.candidates.map(c => c.startsAt), ['2026-04-04T14:45:00.000Z', '2026-04-04T15:15:00.000Z']);
  assert.equal(resolveInterviewTime('2011-12-30T12:00', 'Pacific/Apia').kind, 'gap');
});
test('ordinary explicit zones preserve seconds and milliseconds when opening an editor and re-saving', () => {
  const original = '2026-11-01T06:30:17.123Z', local = interviewLocalInput(original, 'America/New_York');
  assert.equal(local, '2026-11-01T01:30:17.123');
  const overlap = resolveInterviewTime(local, 'America/New_York');
  assert(overlap.candidates.some(c => c.startsAt === original));
  assert.equal(resolveInterviewTime('2026-10-08T14:05:01.023', 'Asia/Shanghai').candidates[0].startsAt, '2026-10-08T06:05:01.023Z');
  assert.equal(resolveInterviewTime('2026-10-08T14:05', 'UTC').candidates[0].startsAt, '2026-10-08T14:05:00.000Z');
  assert.match(displayInterviewTime(original, 'America/Los_Angeles'), /2026-10-31 23:30:17.123.*America\/Los_Angeles.*UTC-07:00/);
});
test('invalid dates, missing zones, raw offsets and time suffixes cannot fall back to device time', () => {
  for (const [local, zone] of [
    ['2026-02-29T12:00', 'UTC'], ['2026-10-08T24:00', 'UTC'], ['0000-01-01T00:00', 'UTC'],
    ['2026-10-08T14:05Z', 'UTC'], ['2026-10-08T14:05+01:00', 'UTC'], ['2026-10-08T14:05', ''],
    ['2026-10-08T14:05', '+01:00'], ['2026-10-08T14:05', 'America/Fictional'],
    ['2026-10-08', 'America/New_York'], ['2026-10-08T12:00:00.1234', 'UTC'],
  ]) assert.equal(resolveInterviewTime(local, zone).kind, 'invalid', local + ' / ' + zone);
  assert.equal(resolveInterviewTime('2028-02-29T12:00', 'UTC').kind, 'valid');
});
test('explicit conversion is invariant when the process device zone changes', () => {
  const previous = process.env.TZ;
  try {
    const outcomes = ['UTC', 'Asia/Shanghai', 'America/Los_Angeles'].map(zone => {
      process.env.TZ = zone;
      return resolveInterviewTime('2026-11-01T01:30', 'America/New_York');
    });
    assert.deepEqual(outcomes[0], outcomes[1]); assert.deepEqual(outcomes[1], outcomes[2]);
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
