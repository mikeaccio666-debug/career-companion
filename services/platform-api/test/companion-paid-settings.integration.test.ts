import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CompanionPaidSettingsService } from '../src/companion-paid-settings.ts';
import { createPrebirthFixture, withPrebirthLoopback, type PrebirthFixture } from './fixtures/companion-prebirth.ts';
import { readyBirth } from './fixtures/companion-birth.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
import { ApiError } from '../src/errors.ts';
let f: PrebirthFixture, service: CompanionPaidSettingsService;
before(async () => { f = await createPrebirthFixture(); service = new CompanionPaidSettingsService(f.db, f.config, FICTIONAL_LEGAL); });
after(async () => { await f?.close(); });
async function born() { let result: Awaited<ReturnType<typeof readyBirth>> | undefined; await withPrebirthLoopback(async (runtime) => { const b = await readyBirth(f, runtime); await b.service.birth(b.ready.who, b.body, b.key); result = b; }); assert(result); return result; }
const error = (status: number) => (e: unknown) => e instanceof ApiError && e.status === status;
function command(companionId: string, expectedRevision = 0, paidSuggestionsMode = 'only_when_asked') { return { companionId, operationId: randomUUID(), expectedRevision, paidSuggestionsMode }; }
test('real birth source yields an unsaved default; persisted preference, policy read and original receipt survive repeated operations without changing personality', async () => {
    const b = await born(), who = b.ready.who, initial = (await service.read(who)).settings, id = initial.companionId;
    assert.equal(initial.revision, 0);
    assert.equal(initial.paidSuggestionsMode, 'when_relevant');
    assert.equal(initial.updatedAt, null);
    const before = await b.service.read(who), c = command(id), first = await service.change(who, c);
    assert.equal(first.settings.revision, 1);
    assert.equal(first.settings.paidSuggestionsMode, 'only_when_asked');
    assert.equal((await new CompanionPaidSettingsService(f.db, f.config, FICTIONAL_LEGAL).read(who)).settings.paidSuggestionsMode, 'only_when_asked');
    assert.equal((await f.db.withBoundedTransaction(db => service.readForPolicyInTransaction(db, who))).paidSuggestionsMode, 'only_when_asked');
    assert.equal((await service.change(who, c)).operation.replayed, true);
    await service.change(who, command(id, 1, 'when_relevant'));
    const replay = await service.change(who, c);
    assert.equal(replay.settings.revision, 2);
    assert.equal(replay.operation.appliedRevision, 1);
    assert.equal(replay.operation.paidSuggestionsMode, 'only_when_asked');
    assert.equal(replay.settings.paidSuggestionsMode, 'when_relevant');
    assert.deepEqual(await service.operation(who, c.operationId), replay);
    await assert.rejects(service.change(who, { ...c, paidSuggestionsMode: 'when_relevant' }), error(409));
    assert.deepEqual(await b.service.read(who), before);
    assert.equal((await f.db.query('SELECT count(*)::int n FROM platform_companion_paid_setting_operations WHERE user_id=$1', [who.userId])).rows[0].n, 2);
    await f.db.query(await readFile(new URL('../migrations/074_companion_paid_settings.sql', import.meta.url), 'utf8'));
    await f.db.migrate();
    assert.equal((await service.read(who)).settings.revision, 2);
});
test('prebirth, staff, cross-owner and revoked sessions cannot adopt another companion or its settings operation', async () => {
    const b = await born(), who = b.ready.who, state = (await service.read(who)).settings, c = command(state.companionId);
    await service.change(who, c);
    const unborn = await f.actor();
    await assert.rejects(service.read(unborn), error(409));
    await assert.rejects(service.change(unborn, c), error(409));
    await assert.rejects(service.operation(unborn, c.operationId), error(404));
    const staff = await f.actor(true);
    await assert.rejects(service.read(staff), error(403));
    await assert.rejects(service.change(who, command(randomUUID(), 1)), error(409));
    await f.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [who.userId]);
    await assert.rejects(service.read(who), error(401));
    await assert.rejects(service.change(who, c), error(401));
});
test('settings cannot be rolled back with authentic older ciphertext or reset to an unchosen default', async () => {
    const b = await born(), who = b.ready.who, id = (await service.read(who)).settings.companionId;
    await service.change(who, command(id));
    const old = (await f.db.query('SELECT * FROM platform_companions WHERE id=$1', [id])).rows[0];
    await service.change(who, command(id, 1, 'when_relevant'));
    await f.db.query('UPDATE platform_companions SET paid_suggestions_mode=$2,paid_suggestions_revision=$3,paid_suggestions_ciphertext=$4,paid_suggestions_updated_at=$5,paid_suggestions_operation_id=$6 WHERE id=$1', [id, old.paid_suggestions_mode, old.paid_suggestions_revision, old.paid_suggestions_ciphertext, old.paid_suggestions_updated_at, old.paid_suggestions_operation_id]);
    await assert.rejects(service.read(who), error(503));
    await f.db.query("UPDATE platform_companions SET paid_suggestions_mode='when_relevant',paid_suggestions_revision=0,paid_suggestions_ciphertext=NULL,paid_suggestions_updated_at=NULL,paid_suggestions_operation_id=NULL WHERE id=$1", [id]);
    await assert.rejects(service.read(who), error(503));
});
test('concurrent owner choices accept one revision; operation receipts cannot be erased until actual account deletion', async () => {
    const b = await born(), who = b.ready.who, id = (await service.read(who)).settings.companionId;
    const outcomes = await Promise.allSettled(['when_relevant', 'only_when_asked'].map(mode => service.change(who, command(id, 0, mode))));
    assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal((await service.read(who)).settings.revision, 1);
    await assert.rejects(f.db.query('DELETE FROM platform_companion_paid_setting_operations WHERE user_id=$1', [who.userId]));
    await f.db.query('DELETE FROM platform_users WHERE id=$1', [who.userId]);
    assert.equal((await f.db.query('SELECT * FROM platform_companion_paid_setting_operations WHERE user_id=$1', [who.userId])).rowCount, 0);
});
test('withdrawn terms and email preserve private reads and original receipts while blocking new choices and policy consumption', async () => {
    const b = await born(), who = b.ready.who, id = (await service.read(who)).settings.companionId, c = command(id);
    await service.change(who, c);
    await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [who.userId]);
    await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1', [who.userId]);
    assert.equal((await service.read(who)).settings.paidSuggestionsMode, 'only_when_asked');
    assert.equal((await service.change(who, c)).operation.replayed, true);
    await assert.rejects(service.change(who, command(id, 1, 'when_relevant')), error(403));
    await assert.rejects(f.db.withBoundedTransaction(db => service.readForPolicyInTransaction(db, who)), error(403));
});
test('a late auth reset rolls back the setting and its operation atomically', async () => {
    const b = await born(), who = b.ready.who, id = (await service.read(who)).settings.companionId, original = f.db.withBoundedTransaction.bind(f.db);
    f.db.withBoundedTransaction = async (run, options) => original(async (client) => { const query = client.query.bind(client); let reset = false; const guarded = new Proxy(client, { get(target, key) { if (key === 'query')
            return async (...args: any[]) => { const result = await (query as any)(...args); if (!reset && typeof args[0] === 'string' && args[0].startsWith('UPDATE platform_companions SET paid_suggestions_mode')) {
                reset = true;
                await query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [who.userId]);
            } return result; }; return Reflect.get(target, key); } }); return run(guarded); }, options);
    try {
        await assert.rejects(service.change(who, command(id)), error(401));
    }
    finally {
        f.db.withBoundedTransaction = original;
    }
    assert.equal((await f.db.query('SELECT paid_suggestions_revision r FROM platform_companions WHERE id=$1', [id])).rows[0].r, 0);
    assert.equal((await f.db.query('SELECT * FROM platform_companion_paid_setting_operations WHERE user_id=$1', [who.userId])).rowCount, 0);
});
