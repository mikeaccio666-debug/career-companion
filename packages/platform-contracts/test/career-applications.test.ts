import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseCareerApplicationCommand, parseApplicationCareWindow, parseCareerApplicationEvent } from '../src/career-applications.ts';
const state = (patch: object = {}) => ({ stage: 'interview', closedReason: null, closedAtStage: null, offerState: null, submittedVia: null, ...patch });
const event = (patch: object = {}) => ({ id: randomUUID(), ownerId: randomUUID(), applicationId: randomUUID(), revision: 2, action: 'stage', actor: 'user', channel: 'web', createdAt: '2026-10-08T00:00:00.000Z', previous: state(), next: state({ stage: 'closed', closedReason: 'not_advanced', closedAtStage: 'interview' }), careWindowUntil: '2026-10-10T00:00:00.000Z', ...patch });
test('owner commands are closed and cannot invent snapshot, packet, receipt, channel or authority', () => {
    const command = { operationId: randomUUID(), expectedRevision: 0, jobObservationId: randomUUID(), jobObservationRevision: 1, privateNote: '' };
    assert(Object.isFrozen(parseCareerApplicationCommand('create', command)));
    for (const patch of [{ ownerId: randomUUID() }, { submittedVia: 'extension' }, { job: {} }, { packetId: randomUUID() }, { source: 'receipt' }, { expectedRevision: 1 }, { jobObservationRevision: 0 }])
        assert.throws(() => parseCareerApplicationCommand('create', { ...command, ...patch }));
    let read = false;
    const accessor = { ...command };
    Object.defineProperty(accessor, 'privateNote', { get() { read = true; return ''; }, enumerable: true });
    assert.throws(() => parseCareerApplicationCommand('create', accessor));
    assert.equal(read, false);
    assert.throws(() => parseCareerApplicationCommand('delete', { operationId: randomUUID(), expectedRevision: 0 }));
    assert.throws(() => parseCareerApplicationCommand('edit', { operationId: randomUUID(), expectedRevision: 1, privateNote: '', stage: 'offer' }));
});
test('care sources require exact 48 hours and a real stage event revision', () => {
    const input = { kind: 'post_rejection', sourceEventId: randomUUID(), eventRevision: 2, startedAt: '2026-10-08T00:00:00.000Z', until: '2026-10-10T00:00:00.000Z' };
    assert.equal(parseApplicationCareWindow(input).eventRevision, 2);
    for (const patch of [{ until: '2026-10-09T00:00:00.000Z' }, { eventRevision: 1 }, { sourceEventId: 'fake' }, { ownerId: randomUUID() }])
        assert.throws(() => parseApplicationCareWindow({ ...input, ...patch }));
});
test('stage event structure derives closing stage and requires care precisely once; edits cannot smuggle stage changes', () => {
    assert.equal(parseCareerApplicationEvent(event()).careWindowUntil, '2026-10-10T00:00:00.000Z');
    for (const patch of [{ careWindowUntil: null }, { careWindowUntil: '2026-10-09T00:00:00.000Z' }, { actor: 'receipt' }, { channel: 'discord' }, { next: state({ stage: 'closed', closedReason: 'not_advanced', closedAtStage: 'oa' }) }, { action: 'edit' }, { next: state({ stage: 'applied', submittedVia: 'extension' }) }])
        assert.throws(() => parseCareerApplicationEvent(event(patch)));
    const closed = state({ stage: 'closed', closedReason: 'not_advanced', closedAtStage: 'interview' });
    assert.equal(parseCareerApplicationEvent(event({ previous: closed, next: closed, careWindowUntil: null })).careWindowUntil, null);
    assert.throws(() => parseCareerApplicationEvent(event({ previous: closed, next: closed })));
    assert.equal(parseCareerApplicationEvent(event({ action: 'delete', previous: closed, next: null, careWindowUntil: null })).next, null);
    assert.throws(() => parseCareerApplicationEvent(event({ action: 'create', revision: 1, previous: null, next: state(), careWindowUntil: null })));
});
