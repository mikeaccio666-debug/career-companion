import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { BoundPlatformClient } from '../src/api.ts';
import { readIdentityEntry, readIdentityRecords, changeIdentityRecord, observeIdentityRecord, type IdentityIntent } from '../src/career-identity-api.ts';
import { identityEditorValue, identityValueText, IDENTITY_FOOTER } from '../src/career-identity-presentation.ts';
const owner = randomUUID(), id = randomUUID(), op = randomUUID(), at = '2026-10-08T10:00:00.000Z';
const record = (patch: object = {}) => ({ id, ownerId: owner, field: 'program_end_date', value: '2028-02-29', label: null, source: 'user_entered', sensitivity: 'sensitive', confirmedAt: at, remindBeforeDays: null, revision: 1, createdAt: at, updatedAt: at, lastOperationId: op, ...patch });
const intent = (): IdentityIntent => ({ action: 'create', id: null, body: { operationId: op, expectedRevision: 0, field: 'program_end_date', value: '2028-02-29', label: null } });
const ack = (patch: object = {}) => ({ id: op, recordId: id, action: 'create', appliedRevision: 1, replayed: false, ...patch });
function client(run: (path: string, init: RequestInit) => unknown, current = () => true): BoundPlatformClient { return { account: { accountId: owner, generation: 1 }, isCurrent: current, subscribe: () => () => { }, request: async (path, init = {}) => await run(path, init) } as BoundPlatformClient; }
test('entry validates actual owner and closed source shape; a hidden view cannot acquire a suggested identity', async () => {
    const v = { kind: 'available', ownerId: owner, stage: 'opt', source: { draftId: randomUUID(), revision: 10 } };
    assert.equal((await readIdentityEntry(client(() => v))).kind, 'available');
    for (const x of [{ ...v, ownerId: randomUUID() }, { ...v, stage: 'other' }, { kind: 'hidden', ownerId: owner, stage: 'opt' }, { kind: 'available', ownerId: owner, stage: 'opt' }, v])
        await assert.rejects(readIdentityEntry(client(() => x, () => x !== v)));
    assert.deepEqual(await readIdentityEntry(client(() => ({ kind: 'hidden', ownerId: owner }))), { kind: 'hidden', ownerId: owner });
});
test('full private list rejects sparse, duplicate, cross-owner and downgraded sensitivity responses', async () => {
    assert.equal((await readIdentityRecords(client(() => ({ records: [record()] }))))[0].value, '2028-02-29');
    for (const records of [[record(), record()], [record({ ownerId: randomUUID() })], [record({ sensitivity: 'normal' })], new Array(1), Array.from({ length: 101 }, () => record())])
        await assert.rejects(readIdentityRecords(client(() => ({ records }))));
    await assert.rejects(readIdentityRecords(client(() => ({ records: [record()] }), () => false)));
});
test('fresh receipt checks nonce, action, actual content/revision and rejects returned execution or inference privileges', async () => {
    const result = await changeIdentityRecord(client((path, init) => { assert.equal(path, '/career/identity'); assert.equal(init.method, 'POST'); assert.equal(JSON.parse(String(init.body)).operationId, op); return { record: record(), operation: ack() }; }), intent());
    assert.equal(result.record?.id, id);
    for (const operation of [ack({ id: randomUUID() }), ack({ recordId: randomUUID() }), ack({ action: 'delete' }), ack({ appliedRevision: 2 }), ack({ replayed: 'yes' }), ack({ executed: true })])
        await assert.rejects(changeIdentityRecord(client(() => ({ record: record(), operation })), intent()));
    for (const patch of [{ value: '2029-01-01' }, { lastOperationId: randomUUID() }, { source: 'derived' }, { remindBeforeDays: 10 }, { eligible: true }, { ownerId: randomUUID() }])
        await assert.rejects(changeIdentityRecord(client(() => ({ record: record(patch), operation: ack() })), intent()));
});
test('observation is read-only, requires actual replay status and accepts deletion without regenerating the original values', async () => {
    const r = await observeIdentityRecord(client((path, init) => { assert.equal(path, '/career/identity/operations/' + op); assert.equal(init.method, undefined); assert.equal(init.body, undefined); return { record: null, operation: ack({ replayed: true }) }; }), intent());
    assert.equal(r.record, null);
    await assert.rejects(observeIdentityRecord(client(() => ({ record: record(), operation: ack() })), intent()));
    const gone = { action: 'delete' as const, id, body: { operationId: op, expectedRevision: 1 } };
    await assert.rejects(changeIdentityRecord(client(() => ({ record: record({ revision: 2 }), operation: ack({ action: 'delete', appliedRevision: 2, replayed: true }) })), gone));
});
test('dates, explicit false/zero/unknown and self-reported numbers preserve meaning without defaults or ticking arithmetic', () => {
    assert.equal(identityEditorValue('program_end_date', '2028-02-29', '', '', ''), '2028-02-29');
    assert.throws(() => identityEditorValue('employment_reported', '', '', '', ''));
    assert.equal(identityEditorValue('employment_reported', '', 'false', '', ''), false);
    assert.throws(() => identityEditorValue('unemployment_days_reported', '', '', '', ''));
    assert.deepEqual(identityEditorValue('unemployment_days_reported', '0', '', '', ''), { days: 0 });
    assert.deepEqual(identityEditorValue('h1b_registration', '', '', '2026', 'unknown'), { year: 2026, outcome: 'unknown' });
    assert.equal(identityValueText(record() as any), '2028-02-29');
    const days = record({ field: 'unemployment_days_reported', value: { days: 1000, reportedAt: at }, sensitivity: 'restricted' }) as any;
    assert.equal(identityValueText(days), '你 2026-10-08 记的：1000 天（记录日期为 UTC）');
    assert(!/(倒数|还剩|超限|资格)/.test(identityValueText(days)));
    assert(IDENTITY_FOOTER.includes('DSO'));
});
