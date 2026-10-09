import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { careerProgress } from '@companion/career-core';
import { CareerProgressService } from '../src/career-progress.ts';
import { CareerStories } from '../src/career-stories.ts';
import { CareerApplications } from '../src/career-applications.ts';
import { ManualJobs } from '../src/manual-jobs.ts';
import { ApiError } from '../src/errors.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
let f: Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>, stories: CareerStories, applications: CareerApplications, jobs: ManualJobs, progress: CareerProgressService;
before(async () => {
    f = await createCompanionNameSafetyFixture();
    jobs = new ManualJobs(f.db, f.config, FICTIONAL_LEGAL);
    stories = new CareerStories(f.db, f.config, FICTIONAL_LEGAL);
    applications = new CareerApplications(f.db, f.config, FICTIONAL_LEGAL, jobs);
    progress = new CareerProgressService(f.db, stories, applications);
});
after(async () => { await f?.close(); });
type Actor = Awaited<ReturnType<typeof f.actor>>;
type Application = Awaited<ReturnType<typeof applications.get>>;
const error = (status: number) => (e: unknown) => e instanceof ApiError && e.status === status;
const command = (expectedRevision: number) => ({ operationId: randomUUID(), expectedRevision });
async function make(who: Actor) {
    const job = (await jobs.mutate(who, 'create', null, { ...command(0), employer: 'Fictional private employer ' + randomUUID(), title: 'Fictional Analyst', canonicalUrl: 'https://example.invalid/' + randomUUID(), roleFamily: 'da', location: '', deadlineAt: null, deadlineTimeZone: null, privateNote: 'Fictional private JD note', jobText: 'Fictional unpublished source.' })).job!;
    return (await applications.mutate(who, 'create', null, { ...command(0), jobObservationId: job.id, jobObservationRevision: job.revision, privateNote: 'Fictional private application note' })).application!;
}
const stage = async (who: Actor, a: Application, choice: object) => (await applications.mutate(who, 'stage', a.id, { ...command(a.revision), ...choice })).application!;
const projectCommand = () => ({ ...command(0), title: 'Fictional private project', experienceKind: 'course_project', sensitivity: 'restricted', occurredAt: '2026-08-01T00:00:00.000Z', context: 'Fictional source context', contribution: 'Fictional personal contribution', outcome: 'Fictional feedback' });
const evidence = (who: Actor) => f.db.withBoundedTransaction(async c => [...await stories.readProgressEvidenceInTransaction(c, who), ...await applications.readProgressEvidenceInTransaction(c, who)]);

test('actual project and application sources derive one owner snapshot without turning self-report into verified submission or leaking private facts', async () => {
    const who = await f.actor(), other = await f.actor();
    const p = (await stories.mutate(who, 'project', 'create', null, projectCommand())).record!;
    await stories.mutate(who, 'project', 'confirm', p.id, command(p.revision));
    let a = await make(who);
    assert.equal((await progress.read(who)).progress.provisionalCounts.application, 0);
    a = await stage(who, a, { stage: 'applied' });
    const ledger = await evidence(who), snapshot = await progress.read(who);
    assert.deepEqual(snapshot.progress, careerProgress(who.userId, ledger));
    assert.equal(snapshot.ownerId, who.userId);
    assert.deepEqual(snapshot.coverage, ['project', 'application']);
    assert.equal(snapshot.progress.counts.project, 1);
    assert.equal(snapshot.progress.provisionalCounts.application, 1);
    assert.equal(snapshot.progress.counts.application, 0);
    assert(!snapshot.progress.milestones.includes('first_confirmed_application'));
    const application = ledger.find(e => e.kind === 'application')!;
    assert.equal(application.referenceId, 'career-application:' + a.id + ':' + a.revision);
    assert.equal(application.occurredAt, a.updatedAt);
    assert(!JSON.stringify([ledger, snapshot]).includes('Fictional'));
    assert(!JSON.stringify(ledger).includes('sensitivity'));
    assert.equal((await progress.read(other)).progress.provisionalCounts.application, 0);
    await stage(other, await make(other), { stage: 'applied' });
    assert.equal((await progress.read(who)).progress.provisionalCounts.application, 1);
});

test('offer and neutral closure preserve effort; correcting to saved, deleting and replaying do not leave phantom progress', async () => {
    const who = await f.actor(); let a = await make(who);
    // Interview or offer alone is not a declaration of having submitted.
    a = await stage(who, a, { stage: 'interview' });
    assert.equal((await progress.read(who)).progress.provisionalCounts.application, 0);
    a = await stage(who, a, { stage: 'applied' });
    a = await stage(who, a, { stage: 'offer', offerState: 'written' });
    a = await stage(who, a, { stage: 'closed', closedReason: 'declined' });
    assert.equal((await progress.read(who)).progress.provisionalCounts.application, 1);
    await jobs.mutate(who, 'delete', a.job.id, command(1));
    assert.equal((await progress.read(who)).progress.provisionalCounts.application, 1);
    a = await stage(who, a, { stage: 'saved' });
    assert.equal((await progress.read(who)).progress.provisionalCounts.application, 0);
    const body = { ...command(a.revision), stage: 'applied' };
    a = (await applications.mutate(who, 'stage', a.id, body)).application!;
    await applications.mutate(who, 'stage', a.id, body);
    assert.equal((await progress.read(who)).progress.provisionalCounts.application, 1);
    await applications.mutate(who, 'delete', a.id, command(a.revision));
    assert.equal((await applications.mutate(who, 'stage', a.id, body)).application, null);
    assert.equal((await progress.read(who)).progress.provisionalCounts.application, 0);
});

test('a complete source snapshot includes entries beyond UI pagination and current edits never double-count', async () => {
    const who = await f.actor();
    for (let i = 0; i < 53; i++) {
        let a = await stage(who, await make(who), { stage: 'applied' });
        a = (await applications.mutate(who, 'edit', a.id, { ...command(a.revision), privateNote: 'Fictional correction' })).application!;
    }
    assert.equal((await applications.list(who)).applications.length, 50);
    assert.equal((await progress.read(who)).progress.provisionalCounts.application, 53);
});

test('tampered current projections and old authentic ciphertext fail the entire snapshot instead of returning partial zeros', async () => {
    for (const corruption of ['projection', 'rollback', 'event'] as const) {
        const who = await f.actor(); let a = await make(who);
        const old = (await f.db.query('SELECT * FROM platform_career_applications WHERE id=$1', [a.id])).rows[0];
        a = await stage(who, a, { stage: 'applied' });
        if (corruption === 'projection') await f.db.query("UPDATE platform_career_applications SET stage='saved' WHERE id=$1", [a.id]);
        if (corruption === 'rollback') await f.db.query('UPDATE platform_career_applications SET stage=$2,revision=$3,last_operation_id=$4,record_ciphertext=$5,updated_at=$6 WHERE id=$1', [a.id, old.stage, old.revision, old.last_operation_id, old.record_ciphertext, old.updated_at]);
        if (corruption === 'event') {
            // Ciphertext corruption via fixture-only crypto adapter preserves immutable SQL rows.
            const corrupted = new CareerApplications(f.db, { ...f.config, dataCrypto: {
                sealUtf8: f.crypto.sealUtf8,
                openUtf8(value, binding) { if (binding.table === 'platform_career_application_events') throw Error('Fictional corrupt source'); return f.crypto.openUtf8(value, binding); },
            } }, FICTIONAL_LEGAL, jobs);
            await assert.rejects(new CareerProgressService(f.db, stories, corrupted).read(who), error(503));
        } else await assert.rejects(progress.read(who), error(503));
    }
});

test('own statistics remain readable after admission withdrawal, but staff, expired sessions and aborted reads fail', async () => {
    const who = await f.actor(), staff = await f.actor(true);
    await stage(who, await make(who), { stage: 'applied' });
    await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [who.userId]);
    await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1', [who.userId]);
    assert.equal((await progress.read(who)).progress.provisionalCounts.application, 1);
    await assert.rejects(progress.read(staff), error(403));
    await assert.rejects(progress.read(who, AbortSignal.abort()));
    await f.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [who.userId]);
    await assert.rejects(progress.read(who), error(401));
});

test('session invalidation after reading source records prevents delivery of the combined snapshot', async () => {
    const who = await f.actor(); await stage(who, await make(who), { stage: 'applied' });
    const original = applications.readProgressEvidenceInTransaction.bind(applications);
    applications.readProgressEvidenceInTransaction = async (c, context, signal) => {
        const records = await original(c, context, signal);
        await c.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [who.userId]);
        return records;
    };
    try { await assert.rejects(progress.read(who), error(401)); } finally { applications.readProgressEvidenceInTransaction = original; }
});

test('full supported capacity authenticates 500 projects and 500 applications within the unchanged transaction deadline', async () => {
    const who = await f.actor();
    for (let i = 0; i < 500; i++) {
        const p = (await stories.mutate(who, 'project', 'create', null, projectCommand())).record!;
        await stories.mutate(who, 'project', 'confirm', p.id, command(p.revision));
        await stage(who, await make(who), { stage: 'applied' });
    }
    const snapshot = await progress.read(who);
    assert.equal(snapshot.progress.counts.project, 500);
    assert.equal(snapshot.progress.provisionalCounts.application, 500);
    assert.equal(snapshot.progress.counts.application, 0);
});
