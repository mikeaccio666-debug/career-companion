import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readInterviewRecords, readInterviewRecord, changeInterviewRecord, observeInterviewRecord, freezeInterviewIntent,
  type InterviewRecordClient, type InterviewIntent } from '../src/career-interview-api.ts';
const owner = randomUUID(), id = randomUUID(), source = randomUUID(), at = '2026-10-08T10:00:00.000Z';
export function interviewFixture(patch: object = {}) {
  return { id, ownerId: owner, revision: 1, lastOperationId: randomUUID(), createdAt: at, updatedAt: at,
    source: 'user_recorded', application: { id: source, ownerId: owner, revision: 2, employer: 'Fictional Company', title: 'Fictional Analyst', roleFamily: 'da' },
    roundType: 'behavioral', startsAt: '2026-11-01T05:30:00.000Z', timeZone: 'America/New_York', durationMin: 45,
    status: 'scheduled', briefId: null, debrief: null, ...patch };
}
function client(run: (p: string, init: RequestInit) => unknown, active = true): InterviewRecordClient {
  return { account: { accountId: owner }, isCurrent: () => active, request: async <T>(p: string, init: RequestInit = {}) => await run(p, init) as T };
}
const intent = (action: InterviewIntent['action'] = 'create'): InterviewIntent => ({
  action, id: action === 'create' ? null : id,
  body: action === 'create' ? { operationId: randomUUID(), expectedRevision: 0, applicationId: source, applicationRevision: 2, roundType: 'behavioral', startsAt: '2026-11-01T05:30:00.000Z', timeZone: 'America/New_York', durationMin: 45 }
    : action === 'edit' ? { operationId: randomUUID(), expectedRevision: 1, roundType: 'sql', durationMin: 60 }
    : action === 'reschedule' ? { operationId: randomUUID(), expectedRevision: 1, startsAt: '2026-11-01T06:30:17.123Z', timeZone: 'America/New_York' }
    : action === 'status' ? { operationId: randomUUID(), expectedRevision: 1, status: 'done' }
    : { operationId: randomUUID(), expectedRevision: 1 },
});
function acknowledgement(value: InterviewIntent, replayed = false) {
  const body = value.body as any;
  return { interview: value.action === 'delete' ? null : interviewFixture({
    revision: body.expectedRevision + 1, lastOperationId: body.operationId,
    ...(value.action === 'create' ? {} : { updatedAt: '2026-10-08T11:00:00.000Z' }),
    ...(value.action === 'edit' ? { roundType: body.roundType, durationMin: body.durationMin } : {}),
    ...(value.action === 'reschedule' ? { startsAt: body.startsAt, timeZone: body.timeZone, status: 'rescheduled' } : {}),
    ...(value.action === 'status' ? { status: body.status } : {}),
  }), operation: { id: body.operationId, interviewId: id, action: value.action, appliedRevision: body.expectedRevision + 1, replayed } };
}
test('all five wire commands use fixed routes and do not send the parser-derived action', async () => {
  for (const action of ['create', 'edit', 'reschedule', 'status', 'delete'] as const) {
    const value = intent(action), paths: any[] = [];
    const c = client((p, init) => { paths.push({ p, init }); return acknowledgement(value); });
    await changeInterviewRecord(c, value);
    assert.equal(paths[0].p, '/career/interviews' + (action === 'create' ? '' : '/' + id) + (action === 'status' ? '/status' : action === 'reschedule' ? '/reschedule' : ''));
    assert.equal(paths[0].init.method, action === 'delete' ? 'DELETE' : action === 'edit' ? 'PATCH' : 'POST');
    assert.deepEqual(JSON.parse(paths[0].init.body), value.body);
    assert.equal(Object.hasOwn(JSON.parse(paths[0].init.body), 'action'), false);
    await observeInterviewRecord(client((p, init) => { assert.equal(p, '/career/interviews/operations/' + (value.body as any).operationId); assert.equal(init.method, undefined); return acknowledgement(value, true); }), value);
  }
});
test('a retained intent is detached and immutable; malformed id or extra authority never becomes a request', () => {
  const value = intent(), fixed = freezeInterviewIntent(value);
  (value.body as any).durationMin = 999;
  assert.equal((fixed.body as any).durationMin, 45); assert(Object.isFrozen(fixed)); assert(Object.isFrozen(fixed.body));
  assert.throws(() => freezeInterviewIntent({ ...intent(), id }));
  assert.throws(() => freezeInterviewIntent({ ...intent('delete'), id: null }));
  assert.throws(() => freezeInterviewIntent({ ...intent(), body: { ...(intent().body as any), ownerId: owner } }));
});
test('owner, nonce, action, coordinate, revision, last receipt and exact fresh command values are checked', async () => {
  for (const action of ['create', 'edit', 'reschedule', 'status', 'delete'] as const) {
    const value = intent(action), good = acknowledgement(value);
    const bad = [
      { ...good, operation: { ...good.operation, id: randomUUID() } },
      { ...good, operation: { ...good.operation, action: 'unknown' } },
      { ...good, operation: { ...good.operation, appliedRevision: 99 } },
      { ...good, operation: { ...good.operation, replayed: 'true' } },
      { ...good, extra: true },
    ];
    if (action !== 'create') bad.push({ ...good, operation: { ...good.operation, interviewId: randomUUID() } });
    if (good.interview) bad.push(
      { ...good, interview: { ...good.interview, ownerId: randomUUID() } },
      { ...good, interview: { ...good.interview, lastOperationId: randomUUID() } },
      { ...good, interview: { ...good.interview, id: randomUUID() } },
      { ...good, interview: null },
    );
    for (const payload of bad) await assert.rejects(changeInterviewRecord(client(() => payload), value));
    if (good.interview) {
      const wrong = action === 'create' ? { durationMin: 99 } : action === 'edit' ? { roundType: 'coding' } : action === 'reschedule' ? { startsAt: '2026-11-01T05:30:00.000Z' } : { status: 'cancelled' };
      await assert.rejects(changeInterviewRecord(client(() => ({ ...good, interview: { ...good.interview, ...wrong } })), value));
    } else await assert.rejects(changeInterviewRecord(client(() => ({ ...good, interview: interviewFixture({ revision: 2, updatedAt: '2026-10-08T11:00:00.000Z', lastOperationId: good.operation.id }) })), value));
    await assert.rejects(observeInterviewRecord(client(() => good), value));
    await assert.rejects(changeInterviewRecord(client(() => good, false), value));
  }
});
test('replay may return the later current record or an actual deletion, but cannot return an earlier or freshly invented state', async () => {
  const value = intent(), good = acknowledgement(value, true);
  await changeInterviewRecord(client(() => ({ ...good, interview: { ...good.interview, revision: 3, lastOperationId: randomUUID(), updatedAt: '2026-10-08T11:00:00.000Z', status: 'done' } })), value);
  await observeInterviewRecord(client(() => ({ ...good, interview: null })), value);
  await assert.rejects(changeInterviewRecord(client(() => ({ ...good, operation: { ...good.operation, replayed: false }, interview: null })), value));
});
test('list validates dense owned unique pages, real status filter, opaque id cursor and detail coordinate', async () => {
  const row = interviewFixture();
  assert.equal((await readInterviewRecord(client(() => ({ interview: row })), id)).id, id);
  await assert.rejects(readInterviewRecord(client(() => ({ interview: { ...row, id: randomUUID() } })), id));
  const good = { interviews: [row], nextAfter: null };
  assert.equal((await readInterviewRecords(client(() => good))).interviews.length, 1);
  for (const payload of [
    { interviews: [row, row], nextAfter: null }, { interviews: [row], nextAfter: id },
    { interviews: [{ ...row, ownerId: randomUUID() }], nextAfter: null }, { ...good, untrusted: true },
    { interviews: new Array(1), nextAfter: null }, { interviews: Array.from({ length: 51 }, () => ({ ...row, id: randomUUID() })), nextAfter: null },
  ]) await assert.rejects(readInterviewRecords(client(() => payload)));
  await assert.rejects(readInterviewRecords(client(() => good), id));
  await assert.rejects(readInterviewRecords(client(() => good), null, 'done'));
  const fifty = Array.from({ length: 50 }, () => interviewFixture({ id: randomUUID(), revision: 2, updatedAt: '2026-10-08T11:00:00.000Z', status: 'done' }));
  const result = await readInterviewRecords(client((p) => { assert.equal(p, '/career/interviews?status=done'); return { interviews: fifty, nextAfter: fifty.at(-1)!.id }; }), null, 'done');
  assert.equal(result.nextAfter, fifty.at(-1)!.id);
  await assert.rejects(readInterviewRecords(client(() => good, false)));
});

test('an already stale captured account makes no read, mutation or observation request', async () => {
  let requests = 0; const c = client(() => { requests++; throw Error('unexpected transport'); }, false);
  await assert.rejects(readInterviewRecords(c)); await assert.rejects(readInterviewRecord(c, id));
  await assert.rejects(changeInterviewRecord(c, intent())); await assert.rejects(observeInterviewRecord(c, intent()));
  assert.equal(requests, 0);
});
