import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ManualJobs } from '../src/manual-jobs.ts';
import { CareerApplications } from '../src/career-applications.ts';
import { ApiError } from '../src/errors.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
let f: Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>, jobs: ManualJobs, applications: CareerApplications;
before(async () => { f = await createCompanionNameSafetyFixture(); jobs = new ManualJobs(f.db, f.config, FICTIONAL_LEGAL); applications = new CareerApplications(f.db, f.config, FICTIONAL_LEGAL, jobs); });
after(async () => { await f?.close(); });
const error = (status: number) => (e: unknown) => e instanceof ApiError && e.status === status;
async function source(who: Awaited<ReturnType<typeof f.actor>>, suffix = randomUUID()) {
    return (await jobs.mutate(who, 'create', null, { operationId: randomUUID(), expectedRevision: 0,
        employer: 'Fictional Company ' + suffix, title: 'Fictional Analyst', canonicalUrl: 'https://example.invalid/jobs/' + suffix,
        roleFamily: 'da', location: 'Fictional City', deadlineAt: null, deadlineTimeZone: null,
        privateNote: 'Fictional source-only note', jobText: 'Fictional role. We sponsor candidates.' })).job!;
}
async function make(who: Awaited<ReturnType<typeof f.actor>>) {
    const job = await source(who), body = { operationId: randomUUID(), expectedRevision: 0, jobObservationId: job.id, jobObservationRevision: job.revision, privateNote: 'Fictional application-only note' };
    const result = await applications.mutate(who, 'create', null, body);
    return { job, body, application: result.application! };
}
const change = (who: Awaited<ReturnType<typeof f.actor>>, app: NonNullable<Awaited<ReturnType<typeof applications.get>>>, choice: object) => applications.mutate(who, 'stage', app.id, { operationId: randomUUID(), expectedRevision: app.revision, ...choice });
const care = (who: Awaited<ReturnType<typeof f.actor>>) => f.db.withBoundedTransaction(c => applications.readActiveCareWindowsInTransaction(c, who));
test('actual owned source snapshot and encrypted note are separate from JD; immutable operations recover current results', async () => {
    const who = await f.actor(), { job, body, application: a } = await make(who);
    assert.equal(a.stage, 'saved');
    assert.equal(a.job.id, job.id);
    assert.equal(a.job.state, 'unknown');
    assert.equal(a.submittedVia, null);
    assert(!('privateNote' in a.job));
    assert(!('jobText' in a.job));
    const raw = (await f.db.query('SELECT * FROM platform_career_applications WHERE id=$1', [a.id])).rows[0];
    for (const text of [body.privateNote, job.employer])
        assert(!raw.record_ciphertext.includes(Buffer.from(text)));
    const edited = (await applications.mutate(who, 'edit', a.id, { operationId: randomUUID(), expectedRevision: 1, privateNote: 'Fictional updated note' })).application!;
    const replay = await applications.mutate(who, 'create', null, body);
    assert.equal(replay.operation.replayed, true);
    assert.equal(replay.application!.revision, 2);
    assert.equal((await applications.observe(who, body.operationId)).application!.privateNote, edited.privateNote);
    await assert.rejects(applications.mutate(who, 'create', null, { ...body, privateNote: 'Different fictional command' }), error(409));
    const list = await applications.list(who);
    assert(!('privateNote' in list.applications[0]));
    assert.equal(list.nextAfter, null);
    const history = await applications.history(who, a.id);
    assert.deepEqual(history.events.map(e => e.action), ['create', 'edit']);
    for (const row of (await f.db.query('SELECT * FROM platform_career_application_events WHERE user_id=$1', [who.userId])).rows) {
        const text = f.crypto.openUtf8(row.event_ciphertext, { table: 'platform_career_application_events', column: 'event_ciphertext', rowId: row.id, ownerId: who.userId, revision: row.revision });
        assert(!text.includes('Fictional'));
        assert(!text.includes('privateNote'));
    }
    await jobs.mutate(who, 'delete', job.id, { operationId: randomUUID(), expectedRevision: 1 });
    assert.equal((await applications.get(who, a.id)).job.id, job.id);
    assert.equal((await applications.mutate(who, 'create', null, body)).application!.id, a.id);
});
test('only explicit owner stage intent records self-report; accepted and expired offers stay offers', async () => {
    const who = await f.actor(), { application: a } = await make(who);
    const applied = (await change(who, a, { stage: 'applied' })).application!;
    assert.equal(applied.submittedVia, 'user_sends');
    let current = applied;
    for (const offerState of ['verbal', 'written', 'accepted', 'declined', 'expired']) {
        current = (await change(who, current, { stage: 'offer', offerState })).application!;
        assert.equal(current.stage, 'offer');
        assert.equal(current.offerState, offerState);
    }
    const closed = (await change(who, current, { stage: 'closed', closedReason: 'declined' })).application!;
    assert.equal(closed.closedAtStage, 'offer');
    assert.equal(closed.careWindow, null);
    const reopened = (await change(who, closed, { stage: 'saved' })).application!;
    assert.equal(reopened.offerState, null);
    assert.equal(reopened.closedReason, null);
    assert.equal(reopened.submittedVia, null);
    await assert.rejects(change(who, reopened, { stage: 'applied', submittedVia: 'extension' }), error(400));
});
test('real stage history and 48-hour restriction sources commit together, survive edits/deletion, and never extend on replay', async () => {
    const who = await f.actor(), { application: a } = await make(who), interview = (await change(who, a, { stage: 'interview' })).application!;
    const body = { operationId: randomUUID(), expectedRevision: interview.revision, stage: 'closed', closedReason: 'not_advanced' }, closed = (await applications.mutate(who, 'stage', a.id, body)).application!;
    assert.equal(closed.closedAtStage, 'interview');
    assert.equal(Date.parse(closed.careWindow!.until) - Date.parse(closed.careWindow!.startedAt), 48 * 3600000);
    assert.equal((await care(who))[0].sourceEventId, body.operationId);
    assert.deepEqual((await applications.mutate(who, 'stage', a.id, body)).application!.careWindow, closed.careWindow);
    const corrected = (await change(who, closed, { stage: 'closed', closedReason: 'rescinded' })).application!;
    assert.deepEqual(corrected.careWindow, closed.careWindow);
    assert.equal((await care(who)).length, 1);
    assert.equal((await applications.history(who, a.id)).events.filter(e => e.careWindowUntil !== null).length, 1);
    await applications.mutate(who, 'delete', a.id, { operationId: randomUUID(), expectedRevision: corrected.revision });
    assert.equal((await care(who)).length, 1);
    await assert.rejects(applications.get(who, a.id), error(404));
    assert.equal((await applications.observe(who, body.operationId)).application, null);
});
test('actual database endings cover all 30 combinations, preserving neutral history and triggering only the specified restriction sources', async () => {
    const who = await f.actor();
    let expected = 0;
    for (const stage of ['saved', 'applied', 'oa', 'interview', 'offer'])
        for (const reason of ['not_advanced', 'withdrawn', 'role_closed', 'no_response', 'declined', 'rescinded']) {
            let a = (await make(who)).application;
            if (stage !== 'saved')
                a = (await change(who, a, stage === 'offer' ? { stage, offerState: 'written' } : { stage })).application!;
            const closed = (await change(who, a, { stage: 'closed', closedReason: reason })).application!, qualifies = ['oa', 'interview', 'offer'].includes(stage) && ['not_advanced', 'rescinded'].includes(reason);
            assert.equal(closed.closedAtStage, stage);
            assert.equal(closed.careWindow !== null, qualifies);
            if (qualifies)
                expected++;
        }
    assert.equal((await care(who)).length, expected);
});
test('source revision, ownership, admission, student account and revoked fixed session remain actual gates', async () => {
    const who = await f.actor(), other = await f.actor(), staff = await f.actor(true), { job, body, application: a } = await make(who);
    await assert.rejects(applications.mutate(other, 'create', null, { ...body, operationId: randomUUID() }), error(404));
    await assert.rejects(applications.mutate(who, 'create', null, { ...body, operationId: randomUUID(), jobObservationRevision: 2 }), error(409));
    await assert.rejects(applications.get(other, a.id), error(404));
    await assert.rejects(applications.observe(other, body.operationId), error(404));
    await assert.rejects(applications.history(other, a.id), error(404));
    await assert.rejects(applications.get(staff, a.id), error(403));
    await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [who.userId]);
    await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1', [who.userId]);
    assert.equal((await applications.get(who, a.id)).id, a.id);
    assert.equal((await applications.observe(who, body.operationId)).application!.id, a.id);
    await assert.rejects(change(who, a, { stage: 'applied' }), error(403));
    await applications.mutate(who, 'delete', a.id, { operationId: randomUUID(), expectedRevision: 1 });
    await f.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [other.userId]);
    await assert.rejects(applications.list(other), error(401));
});
test('concurrent owner intent serializes by actual account; stale stages and duplicate saved sources cannot write twice', async () => {
    const who = await f.actor(), { body, application: a } = await make(who);
    const duplicate = await Promise.allSettled([1, 2].map(() => applications.mutate(who, 'create', null, { ...body, operationId: randomUUID() })));
    assert(duplicate.every(r => r.status === 'rejected' && error(409)(r.reason)));
    const results = await Promise.allSettled(['oa', 'interview'].map(stage => change(who, a, { stage })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter(r => r.status === 'rejected' && error(409)(r.reason)).length, 1);
    assert.equal((await applications.history(who, a.id)).events.length, 2);
});
test('an actual late auth reset rolls back application, event, operation and care source as one transaction', async () => {
    const who = await f.actor(), { application: a } = await make(who), interview = (await change(who, a, { stage: 'interview' })).application!, original = f.db.withBoundedTransaction.bind(f.db), op = randomUUID();
    f.db.withBoundedTransaction = async (run, options) => original(async (client) => { const query = client.query.bind(client); let reset = false; return run(new Proxy(client, { get(target, key) { if (key === 'query')
            return async (...args: any[]) => { const result = await (query as any)(...args); if (!reset && typeof args[0] === 'string' && args[0].startsWith('UPDATE platform_career_applications SET')) {
                reset = true;
                await query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [who.userId]);
            } return result; }; return Reflect.get(target, key); } })); }, options);
    try {
        await assert.rejects(applications.mutate(who, 'stage', a.id, { operationId: op, expectedRevision: interview.revision, stage: 'closed', closedReason: 'not_advanced' }), error(401));
    }
    finally {
        f.db.withBoundedTransaction = original;
    }
    assert.equal((await applications.get(who, a.id)).stage, 'interview');
    assert.equal((await care(who)).length, 0);
    assert.equal((await f.db.query('SELECT id FROM platform_career_application_events WHERE id=$1', [op])).rowCount, 0);
    assert.equal((await f.db.query('SELECT operation_id FROM platform_career_application_operations WHERE operation_id=$1', [op])).rowCount, 0);
});
test('recovery cannot resurrect a deleted application; a new explicit record is distinct from historical operations', async () => {
    const who = await f.actor(), { body, application: a } = await make(who), deletion = { operationId: randomUUID(), expectedRevision: 1 };
    await applications.mutate(who, 'delete', a.id, deletion);
    assert.equal((await applications.mutate(who, 'create', null, body)).application, null);
    assert.equal((await applications.mutate(who, 'delete', a.id, deletion)).operation.replayed, true);
    const newer = (await applications.mutate(who, 'create', null, { ...body, operationId: randomUUID() })).application!;
    assert.notEqual(newer.id, a.id);
    assert.equal((await applications.observe(who, body.operationId)).application, null);
});
test('authentic old ciphertext and mirrored row fields cannot roll back immutable latest proof; immutable event changes fail', async () => {
    const who = await f.actor(), { application: a } = await make(who), row = (await f.db.query('SELECT * FROM platform_career_applications WHERE id=$1', [a.id])).rows[0];
    await change(who, a, { stage: 'applied' });
    await f.db.query('UPDATE platform_career_applications SET revision=$2,last_operation_id=$3,stage=$4,updated_at=$5,record_ciphertext=$6 WHERE id=$1', [a.id, row.revision, row.last_operation_id, row.stage, row.updated_at, row.record_ciphertext]);
    await assert.rejects(applications.get(who, a.id), error(503));
    await assert.rejects(f.db.query("UPDATE platform_career_application_events SET action='delete' WHERE user_id=$1", [who.userId]));
    await assert.rejects(f.db.query('DELETE FROM platform_career_application_operations WHERE user_id=$1', [who.userId]));
});
test('actual owner application and event pagination cross the 50-entry boundary without missing or foreign entries', async () => {
    const who = await f.actor(), other = await f.actor();
    let a;
    for (let i = 0; i < 53; i++)
        a = (await make(who)).application;
    const first = await applications.list(who), second = await applications.list(who, { after: first.nextAfter });
    assert.equal(first.applications.length, 50);
    assert.equal(second.applications.length, 3);
    assert.equal(new Set([...first.applications, ...second.applications].map(v => v.id)).size, 53);
    await assert.rejects(applications.list(other, { after: first.nextAfter }), error(404));
    for (let i = 0; i < 52; i++)
        a = (await applications.mutate(who, 'edit', a!.id, { operationId: randomUUID(), expectedRevision: a!.revision, privateNote: 'Fictional note ' + i })).application!;
    const page = await applications.history(who, a!.id), tail = await applications.history(who, a!.id, { after: page.nextAfter });
    assert.equal(page.events.length, 50);
    assert.equal(tail.events.length, 3);
    assert.equal(tail.events[2].revision, 53);
    assert.equal((await applications.list(who, { stage: 'closed' })).applications.length, 0);
});
test('actual account deletion cascades all private records and immutable proofs; schema migration repeats safely', async () => {
    const who = await f.actor(), { application: a } = await make(who), oa = (await change(who, a, { stage: 'oa' })).application!;
    await change(who, oa, { stage: 'closed', closedReason: 'not_advanced' });
    await f.db.query('DELETE FROM platform_users WHERE id=$1', [who.userId]);
    for (const table of ['platform_career_applications', 'platform_career_application_events', 'platform_career_application_operations'])
        assert.equal((await f.db.query('SELECT user_id FROM ' + table + ' WHERE user_id=$1', [who.userId])).rowCount, 0);
    await f.db.migrate();
    await f.db.query(await readFile(new URL('../migrations/062_career_applications.sql', import.meta.url), 'utf8'));
});

test('persisting a care source preserves actual unknown or existing companion overlays, without manufacturing a safe projection', async () => {
 for (const overlays of [null, [{kind:'crisis',until:'2099-01-01T00:00:00.000Z'}]]) {
  const who=await f.actor();
  await f.db.query("INSERT INTO platform_companions(id,user_id,status,fingerprint,overlays) VALUES($1,$2,'drafting',$3,$4::jsonb)",[randomUUID(),who.userId,'e5'.repeat(32),overlays===null?null:JSON.stringify(overlays)]);
  const a=(await make(who)).application,interview=(await change(who,a,{stage:'interview'})).application!;
  await change(who,interview,{stage:'closed',closedReason:'not_advanced'});
  assert.deepEqual((await f.db.query('SELECT overlays FROM platform_companions WHERE user_id=$1',[who.userId])).rows[0].overlays,overlays);
  assert.equal((await care(who)).length,1);
 }
});
