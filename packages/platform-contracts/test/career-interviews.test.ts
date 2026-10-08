import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseCareerInterviewCommand, parseCareerInterview, parseCareerInterviewOperation, CAREER_INTERVIEW_ROUND_TYPES } from '../src/career-interviews.ts';
const ownerId = randomUUID(), id = randomUUID(), operationId = randomUUID(), applicationId = randomUUID();
const body = { operationId, expectedRevision: 0, applicationId, applicationRevision: 1, roundType: 'sql', startsAt: '2026-11-01T05:30:00.000Z', timeZone: 'America/New_York', durationMin: 45 };
const record = { id, ownerId, revision: 1, lastOperationId: operationId, createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z', source: 'user_recorded', application: { id: applicationId, ownerId, revision: 1, employer: 'Fictional Company', title: 'Fictional Analyst', roleFamily: 'da' }, roundType: 'sql', startsAt: body.startsAt, timeZone: body.timeZone, durationMin: 45, status: 'scheduled', briefId: null, debrief: null };
test('all documented round types and owner actions have closed typed values', () => {
    for (const roundType of CAREER_INTERVIEW_ROUND_TYPES) {
        const c = parseCareerInterviewCommand('create', { ...body, roundType });
        assert.equal(c.action, 'create');
        assert.equal((c as any).roundType, roundType);
        assert(Object.isFrozen(c));
    }
    assert.equal(parseCareerInterviewCommand('edit', { operationId, expectedRevision: 1, roundType: 'coding', durationMin: 60 }).action, 'edit');
    assert.equal(parseCareerInterviewCommand('reschedule', { operationId, expectedRevision: 1, startsAt: '2026-11-01T06:30:00.000Z', timeZone: body.timeZone }).action, 'reschedule');
    for (const status of ['done', 'cancelled'])
        assert.equal((parseCareerInterviewCommand('status', { operationId, expectedRevision: 1, status }) as any).status, status);
    assert.equal(parseCareerInterviewCommand('delete', { operationId, expectedRevision: 1 }).action, 'delete');
});
test('an explicit instant and named time zone preserve both occurrences of a daylight-saving overlap', () => {
    const early = parseCareerInterview({ ...record }), late = parseCareerInterview({ ...record, startsAt: '2026-11-01T06:30:00.000Z' });
    assert.notEqual(early.startsAt, late.startsAt);
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: body.timeZone, hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
    assert.match(formatter.format(new Date(early.startsAt)), /EDT/);
    assert.match(formatter.format(new Date(late.startsAt)), /EST/);
    assert.equal(parseCareerInterview({ ...record, timeZone: 'UTC' }).timeZone, 'UTC');
});
test('missing zone, local or noncanonical instants, invalid dates, opaque ownership, and fabricated output are rejected', () => {
    for (const patch of [{ timeZone: '' }, { timeZone: 'Not/A_Zone' }, { timeZone: '+01:00' }, { startsAt: '2026-11-01T01:30' }, { startsAt: '2026-11-01T01:30:00-04:00' }, { startsAt: '2026-02-30T00:00:00.000Z' }, { startsAt: '0000-01-01T00:00:00.000Z' }, { durationMin: 0 }, { durationMin: -0 }, { durationMin: 1.5 }, { expectedRevision: 1 }, { applicationRevision: 0 }, { roundType: 'virtual_onsite' }])
        assert.throws(() => parseCareerInterviewCommand('create', { ...body, ...patch }));
    for (const [key, value] of Object.entries({ ownerId, source: 'calendar', status: 'done', briefId: randomUUID(), debrief: 'Fake generated review', application: record.application, localStart: '2026-11-01T01:30', model: 'fake' }))
        assert.throws(() => parseCareerInterviewCommand('create', { ...body, [key]: value }));
    const noZone = { ...body } as any;
    delete noZone.timeZone;
    assert.throws(() => parseCareerInterviewCommand('create', noZone));
    const getters = { ...body };
    Object.defineProperty(getters, 'timeZone', { get() { throw Error('must not execute'); }, enumerable: true });
    assert.throws(() => parseCareerInterviewCommand('create', getters));
    for (const status of ['scheduled', 'rescheduled', 'rejected'])
        assert.throws(() => parseCareerInterviewCommand('status', { operationId, expectedRevision: 1, status }));
});
test('records and receipts bind owner, version, server times, source, and action', () => {
    assert(Object.isFrozen(parseCareerInterview(record).application));
    for (const patch of [{ source: 'model' }, { debrief: 'Fake' }, { briefId: randomUUID() }, { status: 'done' }, { updatedAt: '2026-10-07T00:00:00.000Z' }, { application: { ...record.application, ownerId: randomUUID() } }, { toolGrant: { allow: true } }])
        assert.throws(() => parseCareerInterview({ ...record, ...patch }));
    const ack = { id: operationId, interviewId: id, action: 'create', appliedRevision: 1, replayed: false };
    assert.equal(parseCareerInterviewOperation(ack).action, 'create');
    for (const patch of [{ action: 'submit' }, { appliedRevision: 2 }, { replayed: 'true' }, { grant: true }])
        assert.throws(() => parseCareerInterviewOperation({ ...ack, ...patch }));
    assert.throws(() => parseCareerInterviewOperation({ ...ack, action: 'delete' }));
});
