import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ManualJobs } from '../src/manual-jobs.ts';
import { CareerApplications } from '../src/career-applications.ts';
import { CareerInterviews } from '../src/career-interviews.ts';
import { ApiError } from '../src/errors.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
let f: Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>, jobs: ManualJobs, apps: CareerApplications, interviews: CareerInterviews;
before(async () => { f = await createCompanionNameSafetyFixture(); jobs = new ManualJobs(f.db, f.config, FICTIONAL_LEGAL); apps = new CareerApplications(f.db, f.config, FICTIONAL_LEGAL, jobs); interviews = new CareerInterviews(f.db, f.config, FICTIONAL_LEGAL, apps); });
after(async () => { await f?.close(); });
const error = (status: number) => (e: unknown) => e instanceof ApiError && e.status === status;
async function source(who: Awaited<ReturnType<typeof f.actor>>) {
    const job = (await jobs.mutate(who, 'create', null, { operationId: randomUUID(), expectedRevision: 0, employer: 'Fictional Company ' + randomUUID(), title: 'Fictional Analyst', canonicalUrl: 'https://example.invalid/jobs/' + randomUUID(), roleFamily: 'da', location: '', deadlineAt: null, deadlineTimeZone: null, privateNote: 'Fictional private JD note', jobText: 'Fictional role.' })).job!;
    return (await apps.mutate(who, 'create', null, { operationId: randomUUID(), expectedRevision: 0, jobObservationId: job.id, jobObservationRevision: 1, privateNote: 'Fictional private application note' })).application!;
}
const body = (a: Awaited<ReturnType<typeof source>>) => ({ operationId: randomUUID(), expectedRevision: 0, applicationId: a.id, applicationRevision: a.revision, roundType: 'sql', startsAt: '2026-11-01T05:30:00.000Z', timeZone: 'America/New_York', durationMin: 45 });
async function make(who: Awaited<ReturnType<typeof f.actor>>) { const application = await source(who), command = body(application), r = await interviews.mutate(who, 'create', null, command); return { application, command, interview: r.interview! }; }
test('actual owned source, encrypted schedule and immutable nonce recovery preserve current results', async () => {
    const who = await f.actor(), { application, command, interview: a } = await make(who);
    assert.equal(a.status, 'scheduled');
    assert.equal(a.application.id, application.id);
    assert.equal(a.application.revision, 1);
    assert(!('jobText' in a.application));
    assert(!('privateNote' in a.application));
    assert.equal(a.briefId, null);
    assert.equal(a.debrief, null);
    const row = (await f.db.query('SELECT * FROM platform_career_interviews WHERE id=$1', [a.id])).rows[0];
    for (const v of ['Fictional', command.startsAt, command.timeZone])
        assert(!row.record_ciphertext.includes(Buffer.from(v)));
    const edited = (await interviews.mutate(who, 'edit', a.id, { operationId: randomUUID(), expectedRevision: 1, roundType: 'coding', durationMin: 60 })).interview!;
    const replay = await interviews.mutate(who, 'create', null, Object.fromEntries(Object.entries(command).reverse()));
    assert.equal(replay.operation.replayed, true);
    assert.equal(replay.interview!.revision, 2);
    assert.equal(replay.interview!.roundType, 'coding');
    assert.equal((await interviews.observe(who, command.operationId)).interview!.revision, 2);
    await assert.rejects(interviews.mutate(who, 'create', null, { ...command, durationMin: 90 }), error(409));
    assert.equal((await apps.get(who, application.id)).stage, 'saved');
    assert.equal((await interviews.get(who, a.id)).startsAt, edited.startsAt);
});
test('rescheduling, completion and cancellation require explicit owner commands and do not change application stages', async () => {
    const who = await f.actor(), { application, interview: a } = await make(who);
    const moved = (await interviews.mutate(who, 'reschedule', a.id, { operationId: randomUUID(), expectedRevision: 1, startsAt: '2026-11-01T06:30:00.000Z', timeZone: a.timeZone })).interview!;
    assert.equal(moved.status, 'rescheduled');
    assert.equal(moved.startsAt, '2026-11-01T06:30:00.000Z');
    assert.equal(moved.application.id, application.id);
    let v = moved;
    for (const status of ['done', 'cancelled']) {
        v = (await interviews.mutate(who, 'status', a.id, { operationId: randomUUID(), expectedRevision: v.revision, status })).interview!;
        assert.equal(v.status, status);
    }
    assert.equal((await apps.get(who, application.id)).stage, 'saved');
    assert.equal((await interviews.list(who, { status: 'cancelled' })).interviews.length, 1);
    assert.equal((await interviews.list(who, { status: 'scheduled' })).interviews.length, 0);
});
test('foreign sources, stale source proofs, staff, admission withdrawal and revoked login remain real gates', async () => {
    const who = await f.actor(), other = await f.actor(), staff = await f.actor(true), { application, command, interview: a } = await make(who);
    await assert.rejects(interviews.mutate(other, 'create', null, { ...command, operationId: randomUUID() }), error(404));
    await apps.mutate(who, 'stage', application.id, { operationId: randomUUID(), expectedRevision: 1, stage: 'interview' });
    await assert.rejects(interviews.mutate(who, 'create', null, { ...command, operationId: randomUUID() }), error(409));
    for (const fn of [() => interviews.get(other, a.id), () => interviews.observe(other, command.operationId), () => interviews.list(other, { after: a.id })])
        await assert.rejects(fn, error(404));
    await assert.rejects(interviews.list(staff), error(403));
    await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [who.userId]);
    await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1', [who.userId]);
    assert.equal((await interviews.get(who, a.id)).id, a.id);
    await assert.rejects(interviews.mutate(who, 'status', a.id, { operationId: randomUUID(), expectedRevision: 1, status: 'done' }), error(403));
    await interviews.mutate(who, 'delete', a.id, { operationId: randomUUID(), expectedRevision: 1 });
    assert.equal((await interviews.observe(who, command.operationId)).interview, null);
    await f.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [other.userId]);
    await assert.rejects(interviews.list(other), error(401));
});
test('concurrent duplicates replay one effect; competing revisions have one winner', async () => {
    const who = await f.actor(), application = await source(who), command = body(application);
    const repeated = await Promise.all([1, 2].map(() => interviews.mutate(who, 'create', null, command)));
    assert.equal(new Set(repeated.map(v => v.interview!.id)).size, 1);
    assert.equal(repeated.filter(v => v.operation.replayed).length, 1);
    const id = repeated[0].interview!.id, competing = await Promise.allSettled(['done', 'cancelled'].map(status => interviews.mutate(who, 'status', id, { operationId: randomUUID(), expectedRevision: 1, status })));
    assert.equal(competing.filter(v => v.status === 'fulfilled').length, 1);
    assert.equal(competing.filter(v => v.status === 'rejected' && error(409)(v.reason)).length, 1);
    assert.equal((await f.db.query('SELECT * FROM platform_career_interview_operations WHERE user_id=$1', [who.userId])).rowCount, 2);
});
test('physical removal forgets payloads and observing or retrying any original intent cannot resurrect them', async () => {
    const who = await f.actor(), { application, command, interview: a } = await make(who), deletion = { operationId: randomUUID(), expectedRevision: 1 };
    await interviews.mutate(who, 'delete', a.id, deletion);
    await assert.rejects(interviews.get(who, a.id), error(404));
    assert.equal((await interviews.mutate(who, 'create', null, command)).interview, null);
    assert.equal((await interviews.mutate(who, 'delete', a.id, deletion)).interview, null);
    const receipts = (await f.db.query('SELECT * FROM platform_career_interview_operations WHERE user_id=$1', [who.userId])).rows;
    for (const r of receipts) {
        const clear = f.crypto.openUtf8(r.receipt_ciphertext, { table: 'platform_career_interview_operations', column: 'receipt_ciphertext', rowId: r.operation_id, ownerId: who.userId, revision: r.applied_revision });
        for (const privateValue of ['Fictional', command.startsAt, command.timeZone])
            assert(!clear.includes(privateValue));
    }
    const newOne = (await interviews.mutate(who, 'create', null, body(application))).interview!;
    assert.notEqual(newOne.id, a.id);
    assert.equal((await interviews.observe(who, command.operationId)).interview, null);
});
test('authentic older ciphertext and mirrored metadata cannot roll back the independently latest immutable proof', async () => {
    const who = await f.actor(), { interview: a } = await make(who), old = (await f.db.query('SELECT * FROM platform_career_interviews WHERE id=$1', [a.id])).rows[0];
    await interviews.mutate(who, 'status', a.id, { operationId: randomUUID(), expectedRevision: 1, status: 'done' });
    await f.db.query('UPDATE platform_career_interviews SET revision=$2,last_operation_id=$3,status=$4,updated_at=$5,record_ciphertext=$6 WHERE id=$1', [a.id, old.revision, old.last_operation_id, old.status, old.updated_at, old.record_ciphertext]);
    await assert.rejects(interviews.get(who, a.id), error(503));
    await assert.rejects(interviews.list(who), error(503));
    await assert.rejects(f.db.query("UPDATE platform_career_interview_operations SET action='delete' WHERE user_id=$1", [who.userId]));
    await assert.rejects(f.db.query('DELETE FROM platform_career_interview_operations WHERE user_id=$1', [who.userId]));
});
test('a late real authentication reset rolls back the new record revision and receipt together', async () => {
    const who = await f.actor(), { interview: a } = await make(who), original = f.db.withBoundedTransaction.bind(f.db), operationId = randomUUID();
    f.db.withBoundedTransaction = async (run, options) => original(async (client) => { const query = client.query.bind(client); let reset = false; return run(new Proxy(client, { get(target, key) { if (key === 'query')
            return async (...args: any[]) => { const result = await (query as any)(...args); if (!reset && typeof args[0] === 'string' && args[0].startsWith('UPDATE platform_career_interviews SET')) {
                reset = true;
                await query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [who.userId]);
            } return result; }; return Reflect.get(target, key); } })); }, options);
    try {
        await assert.rejects(interviews.mutate(who, 'status', a.id, { operationId, expectedRevision: 1, status: 'done' }), error(401));
    }
    finally {
        f.db.withBoundedTransaction = original;
    }
    assert.equal((await interviews.get(who, a.id)).revision, 1);
    assert.equal((await f.db.query('SELECT * FROM platform_career_interview_operations WHERE operation_id=$1', [operationId])).rowCount, 0);
});
test('historical minimal application reference survives explicit source removal while new schedules require an actual source', async () => {
    const who = await f.actor(), { application, interview: a } = await make(who);
    await apps.mutate(who, 'delete', application.id, { operationId: randomUUID(), expectedRevision: 1 });
    assert.equal((await interviews.get(who, a.id)).application.title, 'Fictional Analyst');
    await assert.rejects(interviews.mutate(who, 'create', null, body(application)), error(404));
    assert.equal((await interviews.mutate(who, 'status', a.id, { operationId: randomUUID(), expectedRevision: 1, status: 'done' })).interview!.status, 'done');
});
test('real pagination crosses the 50-row boundary with verified batched proofs and stable owner cursors', async () => {
    const who = await f.actor(), application = await source(who);
    for (let i = 0; i < 53; i++)
        await interviews.mutate(who, 'create', null, body(application));
    const first = await interviews.list(who), second = await interviews.list(who, { after: first.nextAfter });
    assert.equal(first.interviews.length, 50);
    assert.equal(second.interviews.length, 3);
    assert.equal(new Set([...first.interviews, ...second.interviews].map(v => v.id)).size, 53);
    await assert.rejects(interviews.list(who, { status: 'fake' }), error(400));
});
test('actual account deletion cascades encrypted schedules and immutable proofs; the migration is repeatable', async () => {
    const who = await f.actor();
    await make(who);
    await f.db.query('DELETE FROM platform_users WHERE id=$1', [who.userId]);
    for (const table of ['platform_career_interviews', 'platform_career_interview_operations'])
        assert.equal((await f.db.query('SELECT * FROM ' + table + ' WHERE user_id=$1', [who.userId])).rowCount, 0);
    await f.db.migrate();
    await f.db.query(await readFile(new URL('../migrations/064_career_interviews.sql', import.meta.url), 'utf8'));
});
test('ciphertext transplants and mirrored application coordinates cannot relabel an authentic schedule', async () => {
    const who = await f.actor(), a = await make(who), b = await make(who), row = (await f.db.query('SELECT * FROM platform_career_interviews WHERE id=$1', [a.interview.id])).rows[0];
    const other = (await f.db.query('SELECT record_ciphertext FROM platform_career_interviews WHERE id=$1', [b.interview.id])).rows[0];
    await f.db.query('UPDATE platform_career_interviews SET record_ciphertext=$2 WHERE id=$1', [a.interview.id, other.record_ciphertext]);
    await assert.rejects(interviews.get(who, a.interview.id), error(503));
    await f.db.query('UPDATE platform_career_interviews SET record_ciphertext=$2,application_id=$3 WHERE id=$1', [a.interview.id, row.record_ciphertext, b.application.id]);
    await assert.rejects(interviews.get(who, a.interview.id), error(503));
});
test('the actual 500-record resource boundary and every complete page remain bounded without unverified source shortcuts', async () => {
    const who = await f.actor(), application = await source(who);
    for (let i = 0; i < 500; i++)
        await interviews.mutate(who, 'create', null, body(application));
    await assert.rejects(interviews.mutate(who, 'create', null, body(application)), error(409));
    const ids = new Set<string>();
    let after: string | null = null;
    do {
        const page = await interviews.list(who, after ? { after } : {});
        for (const v of page.interviews) {
            assert(!ids.has(v.id));
            assert.equal(v.application.id, application.id);
            ids.add(v.id);
        }
        after = page.nextAfter;
    } while (after);
    assert.equal(ids.size, 500);
    assert.equal((await f.db.query('SELECT * FROM platform_career_interview_operations WHERE user_id=$1', [who.userId])).rowCount, 500);
});
