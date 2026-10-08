import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { careerApplicationSummary } from '@companion/platform-contracts';
import type { BoundPlatformClient } from '../src/api.ts';
import { readCareerApplications, readCareerApplication, readCareerApplicationEvents, changeCareerApplication, observeCareerApplication, type ApplicationIntent } from '../src/career-application-api.ts';
const owner = randomUUID(), id = randomUUID(), jobId = randomUUID(), opId = randomUUID(), at = '2026-10-08T00:00:00.000Z';
const snapshot = () => ({ id: jobId, sourceId: jobId, ownerId: owner, source: 'manual', state: 'unknown', employer: 'Fictional Company', title: 'Fictional Analyst', canonicalUrl: 'https://example.invalid/jobs/1', roleFamily: 'da', location: '', deadlineAt: null, deadlineTimeZone: null, sponsorship: 'unknown', evidenceOverflow: false, ruleRevision: 1, observedAt: at, checkedAt: at, revision: 1, lastOperationId: randomUUID() });
const app = (patch: object = {}) => ({ id, ownerId: owner, revision: 1, lastOperationId: opId, createdAt: at, updatedAt: at, source: 'user_recorded', job: snapshot(), privateNote: 'Fictional private note', packetId: null, careWindow: null, stage: 'saved', closedReason: null, closedAtStage: null, offerState: null, submittedVia: null, ...patch }) as any;
const command = () => ({ action: 'create', id: null, body: { operationId: opId, expectedRevision: 0, jobObservationId: jobId, jobObservationRevision: 1, privateNote: 'Fictional private note' } }) satisfies ApplicationIntent;
function client(run: (path: string, init: RequestInit) => unknown, current = () => true): BoundPlatformClient { return { account: { accountId: owner, generation: 1 }, isCurrent: current, subscribe: () => () => { }, request: async (path, init = {}) => await run(path, init) } as BoundPlatformClient; }
const ack = (patch: object = {}) => ({ id: opId, applicationId: id, action: 'create', appliedRevision: 1, replayed: false, ...patch });
test('application list validates owner, stage filter, dense unique records and authenticated pagination shape', async () => {
    const summary = careerApplicationSummary(app());
    const r = await readCareerApplications(client(() => ({ applications: [summary], nextAfter: null })));
    assert.equal(r.applications.length, 1);
    assert(!('privateNote' in r.applications[0]));
    assert(Object.isFrozen(r.applications));
    for (const response of [{ applications: [summary, summary], nextAfter: null }, { applications: [careerApplicationSummary(app({ ownerId: randomUUID(), job: { ...snapshot(), ownerId: randomUUID() } }))], nextAfter: null }, { applications: [summary], nextAfter: id }, { applications: [app()], nextAfter: null }, { applications: new Array(1), nextAfter: null }])
        await assert.rejects(readCareerApplications(client(() => response)));
    await assert.rejects(readCareerApplications(client(() => ({ applications: [summary], nextAfter: null })), null, 'offer'));
    await assert.rejects(readCareerApplications(client(() => ({ applications: [summary], nextAfter: null }), () => false)));
});
test('single record never accepts a forged trusted channel, packet, identity, missing source or invalid care window', async () => {
    assert.equal((await readCareerApplication(client(() => ({ application: app() })), id)).job.id, jobId);
    for (const patch of [{ id: randomUUID() }, { source: 'extension' }, { packetId: randomUUID() }, { stage: 'applied', submittedVia: 'extension' }, { job: { ...snapshot(), ownerId: randomUUID() } }, { careWindow: { kind: 'post_rejection', sourceEventId: opId, eventRevision: 1, startedAt: at, until: '2026-10-10T00:00:00.000Z' } }])
        await assert.rejects(readCareerApplication(client(() => ({ application: app(patch) })), id));
});
test('fresh create confirmation preserves actual source coordinate and note; nonce, action and revision cannot be substituted', async () => {
    const value = command(), response = { application: app(), operation: ack() };
    const result = await changeCareerApplication(client((path, init) => { assert.equal(path, '/career/applications'); assert.equal(init.method, 'POST'); assert.equal(JSON.parse(String(init.body)).operationId, opId); return response; }), value);
    assert.equal(result.application!.id, id);
    for (const operation of [ack({ id: randomUUID() }), ack({ action: 'edit' }), ack({ appliedRevision: 2 }), ack({ replayed: 'yes' })])
        await assert.rejects(changeCareerApplication(client(() => ({ application: app(), operation })), value));
    for (const patch of [{ lastOperationId: randomUUID() }, { privateNote: 'Fictional unrequested note' }, { job: { ...snapshot(), id: randomUUID(), sourceId: randomUUID() } }])
        await assert.rejects(changeCareerApplication(client(() => ({ application: app(patch), operation: ack() })), value));
    let reached = false;
    await assert.rejects(changeCareerApplication(client(() => { reached = true; return response; }), { ...value, body: { ...value.body, submittedVia: 'extension' } }));
    assert.equal(reached, false);
});
test('original operation observer is read-only and may return a newer actual version or authentic tombstone', async () => {
    const value = command();
    let paths: string[] = [];
    const result = await observeCareerApplication(client((path, init) => { paths.push(path); assert.equal(init.method, undefined); assert.equal(init.body, undefined); return { application: app({ revision: 2, lastOperationId: randomUUID(), privateNote: 'Fictional later note' }), operation: ack({ replayed: true }) }; }), value);
    assert.equal(result.application!.revision, 2);
    assert.deepEqual(paths, ['/career/applications/operations/' + opId]);
    assert.equal((await observeCareerApplication(client(() => ({ application: null, operation: ack({ replayed: true }) })), value)).application, null);
    await assert.rejects(observeCareerApplication(client(() => ({ application: null, operation: ack() })), value));
    await assert.rejects(observeCareerApplication(client(() => ({ application: app({ revision: 1, lastOperationId: randomUUID() }), operation: ack({ replayed: true }) })), value));
});
test('stage, edit and deletion acknowledgements follow original requested action and current version', async () => {
    const body = { operationId: opId, expectedRevision: 1, stage: 'applied' }, value = { action: 'stage', id, body } satisfies ApplicationIntent;
    const application = app({ revision: 2, stage: 'applied', submittedVia: 'user_sends' }), operation = ack({ action: 'stage', appliedRevision: 2 });
    assert.equal((await changeCareerApplication(client((path, init) => { assert.equal(path, '/career/applications/' + id + '/stage'); assert.equal(init.method, 'POST'); return { application, operation }; }), value)).application!.submittedVia, 'user_sends');
    await assert.rejects(changeCareerApplication(client(() => ({ application: { ...application, submittedVia: null }, operation })), value));
    await assert.rejects(changeCareerApplication(client(() => ({ application: { ...application, stage: 'oa' }, operation })), value));
    const deletion = { action: 'delete', id, body: { operationId: opId, expectedRevision: 1 } } satisfies ApplicationIntent;
    assert.equal((await changeCareerApplication(client((path, init) => { assert.equal(init.method, 'DELETE'); return { application: null, operation: ack({ action: 'delete', appliedRevision: 2 }) }; }), deletion)).application, null);
    await assert.rejects(changeCareerApplication(client(() => ({ application, operation: ack({ action: 'delete', appliedRevision: 2 }) })), deletion));
});
test('history carries only actual owner state events and validates monotonic sequence and after cursor', async () => {
    const saved = { stage: 'saved', closedReason: null, closedAtStage: null, offerState: null, submittedVia: null }, event = { id: opId, ownerId: owner, applicationId: id, revision: 1, action: 'create', actor: 'user', channel: 'web', createdAt: at, previous: null, next: saved, careWindowUntil: null };
    const read = () => ({ applicationId: id, events: [event], nextAfter: null });
    assert.equal((await readCareerApplicationEvents(client(() => read()), id)).events.length, 1);
    for (const events of [[event, event], [{ ...event, ownerId: randomUUID() }], [{ ...event, applicationId: randomUUID() }], [{ ...event, actor: 'receipt' }]])
        await assert.rejects(readCareerApplicationEvents(client(() => ({ ...read(), events })), id));
    await assert.rejects(readCareerApplicationEvents(client(() => read()), id, opId));
    await assert.rejects(readCareerApplicationEvents(client(() => ({ ...read(), nextAfter: opId })), id));
});
