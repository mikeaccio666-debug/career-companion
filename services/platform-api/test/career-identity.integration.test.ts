import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { CareerIdentityRecords } from '../src/career-identity.ts';
import { ApiError } from '../src/errors.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
let f: Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>, records: CareerIdentityRecords;
before(async () => { f = await createCompanionNameSafetyFixture(); records = new CareerIdentityRecords(f.db, f.config, FICTIONAL_LEGAL); });
after(async () => { await f?.close(); });
const create = (field = 'program_end_date', value: unknown = '2027-02-01', label: unknown = null) => ({ operationId: randomUUID(), expectedRevision: 0, field, value, label });
const bad = (status: number) => (e: unknown) => e instanceof ApiError && e.status === status;
test('actual owner-confirmed values are encrypted and never become shared memories or agent preparation fields', async () => {
    const who = await f.actor();
    assert.deepEqual(await records.list(who), { records: [] });
    const examples = [create(), create('stem_designated', false), create('opt_status', 'Fictional private status'), create('opt_start_date', '2027-01-01'), create('opt_end_date', '2026-01-01'), create('stem_opt_start_date', '2025-01-01'), create('stem_opt_end_date', '2024-01-01'), create('employment_reported', false), create('unemployment_days_reported', { days: 0 }), create('h1b_registration', { year: 2026, outcome: 'unknown' }), create('custom_status_date', '2028-03-01', 'Fictional private label')];
    for (const command of examples) {
        const saved = await records.mutate(who, 'create', null, command), r = saved.record!;
        assert.deepEqual(r.value, command.field === 'unemployment_days_reported' ? { days: 0, reportedAt: r.confirmedAt } : command.value);
        assert.equal(r.remindBeforeDays, null);
        assert.equal(r.sensitivity, ['program_end_date', 'stem_designated'].includes(command.field) ? 'sensitive' : 'restricted');
        assert.equal(r.source, 'user_entered');
        const row = (await f.db.query('SELECT * FROM platform_career_identity_dates WHERE id=$1', [r.id])).rows[0];
        assert(Buffer.isBuffer(row.value_ciphertext));
        assert(!row.value_ciphertext.includes(Buffer.from(JSON.stringify(command.value))));
        assert(!JSON.stringify({ ...row, value_ciphertext: null }).includes('Fictional private'));
    }
    assert.equal((await records.list(who)).records.length, examples.length);
    for (const table of ['platform_memories', 'platform_jobs'])
        assert.equal((await f.db.query('SELECT user_id FROM ' + table + ' WHERE user_id=$1', [who.userId])).rowCount, 0);
});
test('immutable receipts enable original-operation observation, replay and physical forgetting without resurrection', async () => {
    const who = await f.actor(), command = create('custom_status_date', '2027-01-01', 'Fictional Original'), a = await records.mutate(who, 'create', null, command), id = a.record!.id;
    const edited = await records.mutate(who, 'edit', id, { ...create('custom_status_date', '2027-02-01', 'Fictional Updated'), expectedRevision: 1 });
    const retry = await records.mutate(who, 'create', null, Object.fromEntries(Object.entries(command).reverse()));
    assert.equal(retry.operation.replayed, true);
    assert.equal(retry.operation.appliedRevision, 1);
    assert.equal(retry.record?.revision, 2);
    assert.deepEqual((await records.operation(who, command.operationId)).record, edited.record);
    const deletion = { operationId: randomUUID(), expectedRevision: 2 };
    assert.equal((await records.mutate(who, 'delete', id, deletion)).record, null);
    assert.equal((await records.mutate(who, 'create', null, command)).record, null);
    assert.equal((await records.operation(who, command.operationId)).record, null);
    await assert.rejects(records.get(who, id), bad(404));
    assert.deepEqual(await records.list(who), { records: [] });
    assert((await records.mutate(who, 'delete', id, deletion)).operation.replayed);
    const rows = (await f.db.query('SELECT * FROM platform_career_identity_operations WHERE user_id=$1', [who.userId])).rows;
    assert.equal(rows.length, 3);
    for (const r of rows) {
        const text = f.crypto.openUtf8(r.receipt_ciphertext, { table: 'platform_career_identity_operations', column: 'receipt_ciphertext', rowId: r.operation_id, ownerId: who.userId, revision: r.applied_revision });
        assert(!text.includes('Fictional'));
        assert(!text.includes('2027-'));
    }
});
test('actual owner lock prevents duplicate singleton fields and duplicate reporting years under concurrent writes', async () => {
    const who = await f.actor(), r = await Promise.allSettled([records.mutate(who, 'create', null, create()), records.mutate(who, 'create', null, create())]);
    assert.equal(r.filter(v => v.status === 'fulfilled').length, 1);
    assert.equal((r.find(v => v.status === 'rejected') as PromiseRejectedResult).reason.status, 409);
    const h = await Promise.allSettled([records.mutate(who, 'create', null, create('h1b_registration', { year: 2026, outcome: 'unknown' })), records.mutate(who, 'create', null, create('h1b_registration', { year: 2026, outcome: 'selected' }))]);
    assert.equal(h.filter(v => v.status === 'fulfilled').length, 1);
    await records.mutate(who, 'create', null, create('h1b_registration', { year: 2027, outcome: 'not_selected' }));
    const custom = create('custom_status_date', '2026-01-01', 'Fictional A');
    await records.mutate(who, 'create', null, custom);
    await records.mutate(who, 'create', null, create('custom_status_date', '2026-01-01', 'Fictional B'));
    assert.equal((await records.list(who)).records.length, 5);
});
test('field/year keys are immutable, concurrent edits honor actual revisions, and nonce reuse cannot adopt different data', async () => {
    const who = await f.actor(), command = create('h1b_registration', { year: 2026, outcome: 'unknown' }), first = await records.mutate(who, 'create', null, command), id = first.record!.id;
    for (const patch of [create('h1b_registration', { year: 2027, outcome: 'selected' }), create('employment_reported', true)])
        await assert.rejects(records.mutate(who, 'edit', id, { ...patch, expectedRevision: 1 }), bad(409));
    const edits = await Promise.allSettled(['selected', 'not_selected'].map(outcome => records.mutate(who, 'edit', id, { ...create('h1b_registration', { year: 2026, outcome }), expectedRevision: 1 })));
    assert.equal(edits.filter(v => v.status === 'fulfilled').length, 1);
    assert.equal((await records.get(who, id)).revision, 2);
    await assert.rejects(records.mutate(who, 'create', null, { ...command, value: { year: 2026, outcome: 'selected' } }), bad(409));
});
test('foreign, staff and revoked actual sessions cannot access any owner record or operation', async () => {
    const who = await f.actor(), other = await f.actor(), staff = await f.actor(true), command = create(), first = await records.mutate(who, 'create', null, command), id = first.record!.id;
    for (const read of [() => records.get(other, id), () => records.operation(other, command.operationId), () => records.mutate(other, 'edit', id, { ...create(), expectedRevision: 1 }), () => records.mutate(other, 'delete', id, { operationId: randomUUID(), expectedRevision: 1 })])
        await assert.rejects(read, bad(404));
    assert.deepEqual(await records.list(other), { records: [] });
    await assert.rejects(records.list(staff), bad(403));
    await f.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [who.userId]);
    await assert.rejects(records.list(who), bad(401));
});
test('raw sensitivity tampering and authentic earlier ciphertext rollback fail against the independent latest receipt', async () => {
    const who = await f.actor(), a = await records.mutate(who, 'create', null, create()), id = a.record!.id, row = (await f.db.query('SELECT * FROM platform_career_identity_dates WHERE id=$1', [id])).rows[0];
    await records.mutate(who, 'edit', id, { ...create('program_end_date', '2028-02-29'), expectedRevision: 1 });
    await f.db.query('UPDATE platform_career_identity_dates SET revision=$2,last_operation_id=$3,value_ciphertext=$4,updated_at=$5,confirmed_at=$5 WHERE id=$1', [id, row.revision, row.last_operation_id, row.value_ciphertext, row.updated_at]);
    await assert.rejects(records.get(who, id), bad(503));
    await assert.rejects(records.list(who), bad(503));
    await assert.rejects(f.db.query('DELETE FROM platform_career_identity_operations WHERE user_id=$1', [who.userId]));
    const other = await f.actor(), b = await records.mutate(other, 'create', null, create());
    await assert.rejects(f.db.query('UPDATE platform_career_identity_dates SET sensitivity=$2 WHERE id=$1', [b.record!.id, 'restricted']));
});
test('withdrawn current admission preserves owner reads, original-operation observation and forgetting but rejects new confirmation', async () => {
    const who = await f.actor(), command = create(), a = await records.mutate(who, 'create', null, command);
    await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [who.userId]);
    await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1', [who.userId]);
    assert.equal((await records.get(who, a.record!.id)).id, a.record!.id);
    assert((await records.operation(who, command.operationId)).record);
    await assert.rejects(records.mutate(who, 'create', null, create('employment_reported', true)), bad(403));
    await assert.rejects(records.mutate(who, 'edit', a.record!.id, { ...create(), expectedRevision: 1 }), bad(403));
    assert.equal((await records.mutate(who, 'delete', a.record!.id, { operationId: randomUUID(), expectedRevision: 1 })).record, null);
});
test('actual late session reset rolls back private data and its receipt in the same transaction', async () => {
    const who = await f.actor(), command = create(), original = f.db.withBoundedTransaction.bind(f.db);
    f.db.withBoundedTransaction = async (run, options) => original(async (client) => { const query = client.query.bind(client); let reset = false; const guarded = new Proxy(client, { get(target, key) { if (key === 'query')
            return async (...args: any[]) => { const result = await (query as any)(...args); if (!reset && typeof args[0] === 'string' && args[0].startsWith('INSERT INTO platform_career_identity_dates')) {
                reset = true;
                await query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [who.userId]);
            } return result; }; return Reflect.get(target, key); } }); return run(guarded); }, options);
    try {
        await assert.rejects(records.mutate(who, 'create', null, command), bad(401));
    }
    finally {
        f.db.withBoundedTransaction = original;
    }
    for (const table of ['platform_career_identity_dates', 'platform_career_identity_operations'])
        assert.equal((await f.db.query('SELECT user_id FROM ' + table + ' WHERE user_id=$1', [who.userId])).rowCount, 0);
});
test('all 100 actual records use a bounded batch proof read; no unknown data is silently truncated', async () => {
    const who = await f.actor();
    for (let i = 0; i < 100; i++)
        await records.mutate(who, 'create', null, create('custom_status_date', '2027-01-01', 'Fictional date ' + i));
    assert.equal((await records.list(who)).records.length, 100);
    await assert.rejects(records.mutate(who, 'create', null, create('custom_status_date', '2027-01-01', 'Fictional over capacity')), bad(409));
});
test('account deletion cascades actual encrypted records and immutable receipts; migration SQL is repeat-safe with real rows', async () => {
    await f.db.query(await fs.readFile(new URL('../migrations/063_career_identity_records.sql', import.meta.url), 'utf8'));
    const retained = await f.actor(), saved = await records.mutate(retained, 'create', null, create());
    await f.db.query(await fs.readFile(new URL('../migrations/063_career_identity_records.sql', import.meta.url), 'utf8'));
    assert.equal((await records.get(retained, saved.record!.id)).value, saved.record!.value);
    const who = await f.actor();
    await records.mutate(who, 'create', null, create());
    await f.db.query('DELETE FROM platform_users WHERE id=$1', [who.userId]);
    for (const table of ['platform_career_identity_dates', 'platform_career_identity_operations'])
        assert.equal((await f.db.query('SELECT user_id FROM ' + table + ' WHERE user_id=$1', [who.userId])).rowCount, 0);
    await f.db.migrate();
});
