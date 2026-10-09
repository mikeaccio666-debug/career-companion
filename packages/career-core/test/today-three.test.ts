import test from 'node:test';
import assert from 'node:assert/strict';
import { pickTodayThree, TodayThreeInputError, type TodayCandidate, type TodayThreeInput } from '../src/today-three.ts';
const ID = (n: number) => '10000000-0000-4000-8000-' + String(n).padStart(12, '0');
const owner = ID(999), now = '2026-10-09T17:00:00.000Z', HOUR = 3_600_000;
const at = (hours: number) => new Date(Date.parse(now) + hours * HOUR).toISOString();
function candidate(n: number, patch: Partial<TodayCandidate> = {}): TodayCandidate {
  return { id: ID(n), ownerId: owner, expert: 'guide', minutes: 30, stages: ['polish'],
    action: { kind: 'expert', expert: 'guide' }, state: 'ready', access: 'free', sensitivity: 'normal', effort: 'standard', deadlineAt: null, interviewId: null, ...patch };
}
function input(candidates: readonly TodayCandidate[] = []): TodayThreeInput {
  return { ownerId: owner, now, timeZone: 'America/Los_Angeles', activeStages: ['polish', 'apply'], enabledExperts: ['guide', 'applier', 'interviewer'],
    fifteenMinuteSteps: false, requestKind: 'scheduled', optedOutDate: null, pauseUntil: null, overlays: [], candidates, interviews: [],
    historyDates: ['2026-10-08', '2026-10-07'], history: [] };
}
const chosen = (x: TodayThreeInput) => pickTodayThree(x).items.map(i => i.candidateId);
const history = (n: number, date: string, outcome: 'unfinished' | 'done' | 'dropped' = 'unfinished') => ({ candidateId: ID(n), ownerId: owner, localDate: date, outcome });

test('three real choices respect the default 90 minutes and two-per-expert maximum without filling empty slots', () => {
  const x = input([candidate(1), candidate(2), candidate(3), candidate(4, { expert: 'applier', action: { kind: 'expert', expert: 'applier' } })]);
  const result = pickTodayThree(x);
  assert.deepEqual(result.items.map(i => i.candidateId), [ID(1), ID(2), ID(4)]);
  assert.equal(result.totalMinutes, 90); assert.equal(result.budgetMinutes, 90);
  assert.deepEqual(result.skipped, [{ candidateId: ID(3), reason: 'expert_limit' }]);
  assert.deepEqual(pickTodayThree(input()).items, []);
  assert.equal(chosen(input([candidate(1)])).length, 1);
});
test('near deadlines and interviews precede stage candidates, ordered by event time; exact windows are inclusive', () => {
  const x = input([candidate(1), candidate(2, { stages: ['offer'], deadlineAt: at(48) }), candidate(3, { expert: 'interviewer', action: { kind: 'interview', id: null }, stages: ['interview'], interviewId: ID(100) })]);
  const result = pickTodayThree({ ...x, interviews: [{ id: ID(100), ownerId: owner, startsAt: at(36) }] });
  assert.deepEqual(result.items.map(i => [i.candidateId, i.rule]), [[ID(3), 'interview_72h'], [ID(2), 'deadline_48h'], [ID(1), 'stage']]);
  assert.equal(chosen(input([candidate(1, { deadlineAt: at(48 + 1 / HOUR), stages: ['offer'] })])).length, 0);
  for (const hours of [72, 72 + 1 / HOUR]) {
    const result = pickTodayThree({ ...input([candidate(1, { interviewId: ID(100), stages: ['interview'] })]), interviews: [{ id: ID(100), ownerId: owner, startsAt: at(hours) }] });
    assert.equal(result.items.length, hours === 72 ? 1 : 0);
  }
});
test('only upcoming interviews today determine same-day focus, using the supplied time zone', () => {
  const x = input([candidate(1, { deadlineAt: at(1) }), candidate(2, { interviewId: ID(100) }), candidate(3, { interviewId: ID(101) })]);
  const result = pickTodayThree({ ...x, interviews: [{ id: ID(100), ownerId: owner, startsAt: at(2) }, { id: ID(101), ownerId: owner, startsAt: at(24) }] });
  assert.deepEqual(result.items.map(i => i.candidateId), [ID(2)]);
  assert.deepEqual(result.skipped.map(i => i.reason), ['interview_today_only', 'interview_today_only']);
  assert.deepEqual(chosen({ ...input([candidate(1)]), interviews: [{ id: ID(100), ownerId: owner, startsAt: at(-1) }] }), [ID(1)]);
});
test('over-budget work is never shortened and a smaller next candidate can fit; zero budget is valid', () => {
  const x = input([candidate(1, { minutes: 35, deadlineAt: at(1) }), candidate(2, { minutes: 15 }), candidate(3, { minutes: 10 })]);
  const result = pickTodayThree({ ...x, dailyMinutes: 25 });
  assert.equal(result.totalMinutes, 25); assert.deepEqual(result.items.map(i => i.minutes), [15, 10]);
  assert.ok(result.skipped.some(i => i.candidateId === ID(1) && i.reason === 'daily_budget'));
  assert.deepEqual(chosen({ ...x, dailyMinutes: 0 }), []);
});
test('Q4A requires actual steps of at most 15 minutes, not a fabricated estimate for a larger task', () => {
  const x = input([candidate(1, { minutes: 16, deadlineAt: at(1) }), candidate(2, { minutes: 15 })]);
  const result = pickTodayThree({ ...x, fifteenMinuteSteps: true });
  assert.deepEqual(result.items.map(i => i.candidateId), [ID(2)]);
  assert.deepEqual(result.skipped, [{ candidateId: ID(1), reason: 'smaller_step_needed' }]);
});
test('paid, unknown entitlement, private and unavailable candidates cannot enter even with urgent deadlines', () => {
  const patches: Partial<TodayCandidate>[] = [{ access: 'paid' }, { access: 'unknown' }, { sensitivity: 'sensitive' }, { sensitivity: 'restricted' }, { state: 'unavailable' }, { state: 'completed' }];
  const result = pickTodayThree(input(patches.map((p, i) => candidate(i + 1, { ...p, deadlineAt: at(1) }))));
  assert.equal(result.items.length, 0); assert.equal(result.skipped.length, patches.length);
  assert.equal(chosen(input([candidate(1, { access: 'included' })])).length, 1);
});
test('only enabled P0 experts are chosen; supplied future expert flags cannot widen the release', () => {
  for (const expert of ['planner', 'coach', 'networker'] as const)
    assert.deepEqual(chosen({ ...input([candidate(1, { expert, action: { kind: 'expert', expert } })]), enabledExperts: [expert] }), []);
  assert.deepEqual(chosen({ ...input([candidate(1)]), enabledExperts: [] }), []);
});
test('opt-out and pause suppress tasks without generating reminder cancellation or fake completed work', () => {
  const x = input([candidate(1, { deadlineAt: at(1) })]);
  for (const patch of [{ optedOutDate: '2026-10-09' }, { pauseUntil: at(1) }]) {
    const result = pickTodayThree({ ...x, ...patch, requestKind: 'user_requested' });
    assert.equal(result.items.length, 0); assert.equal(result.totalMinutes, 0);
    assert.ok(['opted_out', 'paused'].includes(result.suppressed!));
  }
  assert.equal(chosen({ ...x, optedOutDate: '2026-10-08', pauseUntil: now }).length, 1);
});
test('scheduled tasks stop during crisis and rejection even with a sprint; expired overlays stop suppressing', () => {
  for (const kind of ['post_crisis', 'post_rejection'] as const) {
    const x = { ...input([candidate(1)]), overlays: [{ kind, until: at(1) }, { kind: 'sprint' as const, until: at(2) }] };
    assert.equal(pickTodayThree(x).suppressed, kind);
    assert.equal(chosen({ ...x, overlays: [{ kind, until: now }] }).length, 1);
  }
});
test('an explicit request can produce crisis-period tasks; rejection-period requested work stays light and at most one', () => {
  const x = { ...input([candidate(1), candidate(2, { effort: 'light' }), candidate(3, { effort: 'light' })]), requestKind: 'user_requested' as const };
  assert.equal(chosen({ ...x, overlays: [{ kind: 'post_crisis', until: at(1) }] }).length, 2);
  const result = pickTodayThree({ ...x, overlays: [{ kind: 'post_rejection', until: at(1) }] });
  assert.deepEqual(result.items.map(i => i.candidateId), [ID(2)]);
  assert.ok(result.skipped.some(i => i.reason === 'light_only')); assert.ok(result.skipped.some(i => i.reason === 'item_limit'));
});
test('unfinished yesterday can recur once; two consecutive misses return it to the pool for a day', () => {
  const x = input([candidate(1), candidate(2)]);
  const result = pickTodayThree({ ...x, history: [history(2, '2026-10-08')] });
  assert.deepEqual(result.items.map(i => [i.candidateId, i.rule]), [[ID(2), 'carry_once'], [ID(1), 'stage']]);
  assert.deepEqual(chosen({ ...x, history: [history(2, '2026-10-08'), history(2, '2026-10-07')] }), [ID(1)]);
  assert.deepEqual(chosen({ ...x, history: [history(2, '2026-10-07')] }), [ID(1), ID(2)]);
  for (const outcome of ['done', 'dropped'] as const)
    assert.deepEqual(chosen({ ...x, history: [history(2, '2026-10-08', outcome)] }), [ID(1)]);
});
test('stage order handles overlapping phases and urgent work can precede an inactive phase', () => {
  const x = input([candidate(1, { stages: ['apply'] }), candidate(2, { stages: ['polish', 'interview'] }), candidate(3, { stages: ['offer'] })]);
  assert.deepEqual(chosen(x), [ID(2), ID(1)]);
  assert.deepEqual(chosen({ ...x, activeStages: ['apply', 'polish'] }), [ID(1), ID(2)]);
  assert.deepEqual(chosen({ ...x, activeStages: [] }), []);
});
test('duplicate action targets do not occupy two slots; separate expert actions can still coexist', () => {
  const action = { kind: 'pending' as const, id: ID(100) };
  const result = pickTodayThree(input([candidate(1, { action }), candidate(2, { action }), candidate(3)]));
  assert.deepEqual(result.items.map(i => i.candidateId), [ID(1), ID(3)]);
  assert.ok(result.skipped.some(i => i.reason === 'duplicate_action'));
});
test('missing, completed or elapsed interview/deadline sources cannot become ordinary stage work', () => {
  const x = input([candidate(1, { deadlineAt: now }), candidate(2, { interviewId: ID(100) }), candidate(3, { interviewId: ID(101) })]);
  const result = pickTodayThree({ ...x, interviews: [{ id: ID(101), ownerId: owner, startsAt: now }] });
  assert.equal(result.items.length, 0); assert.equal(result.skipped.length, 3);
});
test('DST and UTC offsets use preceding local calendar dates, not elapsed 24-hour buckets', () => {
  for (const [timestamp, timeZone, today, dates] of [
    ['2026-11-02T07:30:00.000Z', 'America/Los_Angeles', '2026-11-01', ['2026-10-31', '2026-10-30']],
    ['2026-03-09T06:30:00.000Z', 'America/Los_Angeles', '2026-03-08', ['2026-03-07', '2026-03-06']],
    ['2026-10-09T17:00:00.000Z', 'Asia/Shanghai', '2026-10-10', ['2026-10-09', '2026-10-08']],
  ] as const) {
    const result = pickTodayThree({ ...input(), now: timestamp, timeZone, historyDates: dates });
    assert.equal(result.localDate, today);
  }
});
test('owner and historical coverage mismatches reject the entire snapshot before returning choices', () => {
  const x = input([candidate(1)]);
  for (const patch of [
    { candidates: [candidate(1, { ownerId: ID(888) })] },
    { interviews: [{ id: ID(100), ownerId: ID(888), startsAt: at(1) }] },
    { history: [{ ...history(1, '2026-10-08'), ownerId: ID(888) }] },
    { historyDates: ['2026-10-08', '2026-10-06'] },
    { history: [history(1, '2026-10-09')] },
    { history: [history(1, '2026-10-08'), history(1, '2026-10-08')] },
  ]) assert.throws(() => pickTodayThree({ ...x, ...patch } as TodayThreeInput), TodayThreeInputError);
});
test('invalid values, duplicate sources and non-domain links fail with a controlled error', () => {
  for (const patch of [
    { timeZone: 'Mars/Olympus' }, { timeZone: '+08:00' }, { now: '2026-02-30T17:00:00.000Z' },
    { dailyMinutes: -1 }, { dailyMinutes: NaN }, { dailyMinutes: -0 }, { activeStages: ['polish', 'polish'] },
    { candidates: [candidate(1), candidate(1)] }, { candidates: [candidate(1, { minutes: 0 })] },
    { candidates: [candidate(1, { action: { kind: 'expert', expert: 'applier' } })] },
    { candidates: [{ ...candidate(1), action: { kind: 'url', href: 'https://example.invalid' } }] },
    { candidates: [{ ...candidate(1), rawResume: 'private fixture' }] },
    { overlays: [{ kind: 'sprint', until: at(1) }, { kind: 'sprint', until: at(2) }] },
  ]) assert.throws(() => pickTodayThree({ ...input(), ...patch } as TodayThreeInput), TodayThreeInputError);
});
test('accessor and sparse arrays are rejected without invoking caller code', () => {
  let invoked = false;
  const c = { ...candidate(1) }; Object.defineProperty(c, 'minutes', { enumerable: true, get() { invoked = true; return 1; } });
  assert.throws(() => pickTodayThree(input([c])), TodayThreeInputError);
  const values = [candidate(1)]; Object.defineProperty(values, '0', { get() { invoked = true; return candidate(1); } });
  assert.throws(() => pickTodayThree(input(values)), TodayThreeInputError);
  assert.throws(() => pickTodayThree(input(new Array(2))), TodayThreeInputError); assert.equal(invoked, false);
});
test('output is detached, frozen and deterministic under candidate, interview and history enumeration order', () => {
  const x = { ...input([candidate(1), candidate(2), candidate(3, { expert: 'applier', action: { kind: 'pending' as const, id: ID(100) } })]), history: [history(2, '2026-10-08'), history(1, '2026-10-07')] };
  const before = JSON.stringify(x), result = pickTodayThree(x);
  assert.equal(JSON.stringify(x), before);
  assert.deepEqual(result, pickTodayThree({ ...x, candidates: [...x.candidates].reverse(), history: [...x.history].reverse() }));
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.items));
  for (const item of result.items) { assert.ok(Object.isFrozen(item)); assert.ok(Object.isFrozen(item.action)); }
  assert.throws(() => { (result.items[0].action as any).kind = 'execute'; });
  assert.doesNotMatch(JSON.stringify(result), /ownerId|rawResume|credential|authorization|token/);
});
