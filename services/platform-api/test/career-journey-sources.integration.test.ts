import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareCareerRun } from '@companion/career-core';
import { CareerApplications } from '../src/career-applications.ts';
import { ManualJobs } from '../src/manual-jobs.ts';
import { CareerTargets } from '../src/career-targets.ts';
import { CareerStories } from '../src/career-stories.ts';
import { ResumeOriginalReview } from '../src/resume-original-review.ts';
import { CareerPreparationSources } from '../src/career-preparation-sources.ts';
import { ApiError } from '../src/errors.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
let f: Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>, jobs: ManualJobs, applications: CareerApplications, sources: CareerPreparationSources, targets: CareerTargets, library: CareerStories, resumes: ResumeOriginalReview;
before(async () => { f = await createCompanionNameSafetyFixture(); jobs = new ManualJobs(f.db, f.config, FICTIONAL_LEGAL); applications = new CareerApplications(f.db, f.config, FICTIONAL_LEGAL, jobs); targets = new CareerTargets(f.db, f.config, FICTIONAL_LEGAL); library = new CareerStories(f.db, f.config, FICTIONAL_LEGAL); resumes = new ResumeOriginalReview(f.db, f.config, FICTIONAL_LEGAL); sources = new CareerPreparationSources(f.db, targets, library, resumes, applications); });
after(async () => { await f?.close(); });
const error = (status: number) => (e: unknown) => e instanceof ApiError && e.status === status;
const coordinate = (i: {
    ownerId: string;
    indexId: string;
}) => ({ ownerId: i.ownerId, indexId: i.indexId });
async function bookmark(who: Awaited<ReturnType<typeof f.actor>>, track = 'da') {
    return (await jobs.mutate(who, 'create', null, { operationId: randomUUID(), expectedRevision: 0, employer: 'PRIVATE_FICTIONAL_COMPANY ' + randomUUID(), title: 'PRIVATE_FICTIONAL_JOB_TITLE', canonicalUrl: 'https://example.invalid/jobs/' + randomUUID(), roleFamily: track, location: 'PRIVATE_FICTIONAL_CITY', deadlineAt: null, deadlineTimeZone: null, privateNote: 'PRIVATE_FICTIONAL_JOB_NOTE', jobText: 'PRIVATE_FICTIONAL_JD. We sponsor candidates.' })).job!;
}
async function apply(who: Awaited<ReturnType<typeof f.actor>>, job: Awaited<ReturnType<typeof bookmark>>) { return (await applications.mutate(who, 'create', null, { operationId: randomUUID(), expectedRevision: 0, jobObservationId: job.id, jobObservationRevision: job.revision, privateNote: 'PRIVATE_FICTIONAL_APPLICATION_NOTE' })).application!; }
test('actual bookmarks and applications produce separate owned source metadata; target selection freezes application and original JD together', async () => {
    const who = await f.actor(), other = await f.actor(), job = await bookmark(who), a = await apply(who, job);
    await bookmark(other);
    const index = await sources.read(who);
    assert.equal(index.savedJobs!.length, 1);
    assert.equal(index.applications!.length, 1);
    assert.equal(index.applications![0].job!.id, job.id);
    assert.equal(index.applications![0].id, a.id);
    assert(!JSON.stringify(index).includes('PRIVATE_FICTIONAL'));
    const selected = await sources.prepare(who, { skillId: 'application-preparation', selection: { targetJobId: a.id } });
    assert.equal(selected.built.context.inputs.find(r => r.input === 'target-job')!.id, a.id);
    assert.deepEqual(selected.built.sourceDependencies, [{ input: 'target-job', referenceId: a.id, members: [{ id: job.id, revision: 1 }] }]);
    assert.equal(prepareCareerRun('application-preparation', selected.built.context).state, 'blocked');
    assert.deepEqual(selected.built.context.tools, {});
    assert(selected.built.unavailableSources.includes('readProfile'));
    const absent = await sources.prepare(other, { skillId: 'application-preparation', selection: { targetJobId: a.id } });
    assert.equal(absent.built.context.inputs.some(r => r.input === 'target-job'), false);
    await assert.rejects(sources.prepare(who, { skillId: 'application-preparation', selection: { targetJobId: a.id, submittedVia: 'extension' } }), error(400));
});
test('three distinct actual JDs are required; bookmarks do not double-count an application, and its closed stage excludes the same original', async () => {
    const who = await f.actor(), job = await bookmark(who), a = await apply(who, job);
    assert.equal((await sources.prepare(who, { skillId: 'role-exploration' })).built.context.inputs.some(r => r.input === 'current-jobs'), false);
    const j2 = await bookmark(who);
    assert.equal((await sources.prepare(who, { skillId: 'role-exploration' })).built.context.inputs.some(r => r.input === 'current-jobs'), false);
    const j3 = await bookmark(who), index = await sources.read(who), prepared = await sources.prepare(who, { skillId: 'role-exploration' }), snapshot = prepared.built.snapshots.find(r => r.input === 'current-jobs')!;
    assert.equal(snapshot.members.length, 4);
    assert.deepEqual(new Set(snapshot.members.map(r => r.id)), new Set([job.id, j2.id, j3.id, a.id]));
    const closed = (await applications.mutate(who, 'stage', a.id, { operationId: randomUUID(), expectedRevision: 1, stage: 'closed', closedReason: 'withdrawn' })).application!;
    assert.equal((await sources.prepare(who, { skillId: 'role-exploration' })).built.context.inputs.some(r => r.input === 'current-jobs'), false);
    assert.equal((await sources.prepare(who, { skillId: 'application-preparation', selection: { targetJobId: a.id } })).built.context.inputs.some(r => r.input === 'target-job'), false);
    await assert.rejects(f.db.withBoundedTransaction(c => sources.assertCurrentInTransaction(c, who, coordinate(index))), error(409));
    await applications.mutate(who, 'stage', a.id, { operationId: randomUUID(), expectedRevision: closed.revision, stage: 'interview' });
    const reopened = await sources.prepare(who, { skillId: 'role-exploration' });
    assert.notEqual(reopened.built.snapshots.find(r => r.input === 'current-jobs')!.id, snapshot.id);
});
test('application notes and stage changes invalidate actual source coordinates without adding their private text', async () => {
    const who = await f.actor(), job = await bookmark(who), a = await apply(who, job), before = await sources.read(who);
    await applications.mutate(who, 'edit', a.id, { operationId: randomUUID(), expectedRevision: 1, privateNote: 'PRIVATE_FICTIONAL_NEW_NOTE' });
    const edited = await sources.read(who);
    assert.notEqual(edited.indexId, before.indexId);
    assert(!JSON.stringify(edited).includes('PRIVATE_FICTIONAL'));
    await assert.rejects(f.db.withBoundedTransaction(c => sources.assertCurrentInTransaction(c, who, coordinate(before))), error(409));
});
test('removing the actual original JD leaves only historical application metadata and invalidates preparation, including restoring an authentic old source snapshot', async () => {
    const who = await f.actor(), job = await bookmark(who), a = await apply(who, job), before = await sources.read(who), row = (await f.db.query('SELECT * FROM platform_career_job_observations WHERE id=$1', [job.id])).rows[0];
    await jobs.mutate(who, 'delete', job.id, { operationId: randomUUID(), expectedRevision: 1 });
    const current = await sources.read(who);
    assert.equal(current.savedJobs!.length, 0);
    assert.equal(current.applications!.length, 1);
    assert.equal(current.applications![0].job, null);
    assert.equal((await applications.get(who, a.id)).job.id, job.id);
    assert.equal((await sources.prepare(who, { skillId: 'application-preparation', selection: { targetJobId: a.id } })).built.context.inputs.some(r => r.input === 'target-job'), false);
    await assert.rejects(f.db.withBoundedTransaction(c => sources.assertCurrentInTransaction(c, who, coordinate(before))), error(409));
    await f.db.query('INSERT INTO platform_career_job_observations(id,user_id,source,state,revision,last_operation_id,observed_at,checked_at,created_at,updated_at,record_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$7,$7,$9)', [row.id, row.user_id, row.source, row.state, row.revision, row.last_operation_id, row.observed_at, row.checked_at, row.record_ciphertext]);
    await assert.rejects(sources.read(who), error(503));
});
test('confirmed same-track resume selection now uses a real selected application, without switching an explicit mismatching version', async () => {
    const who = await f.actor(), job = await bookmark(who), a = await apply(who, job), ids: string[] = [];
    for (const track of ['da', 'swe']) {
        const v = (await resumes.mutate(who, 'create', null, { operationId: randomUUID(), expectedRevision: 0, track, label: 'PRIVATE_FICTIONAL_RESUME_LABEL', text: 'PRIVATE_FICTIONAL_RESUME_BODY' }, 'web')).view!;
        await resumes.mutate(who, 'approve', v.item.id, { operationId: randomUUID(), expectedRevision: 1, payloadDigest: v.item.payloadDigest }, 'web');
        ids.push(v.item.resumeVersionId);
    }
    const prepared = await sources.prepare(who, { skillId: 'application-preparation', selection: { targetJobId: a.id } });
    assert.equal(prepared.built.context.inputs.find(r => r.input === 'reviewed-resume')!.id, ids[0]);
    const mismatch = await sources.prepare(who, { skillId: 'application-preparation', selection: { targetJobId: a.id, resumeId: ids[1] } });
    assert.equal(mismatch.built.context.inputs.some(r => r.input === 'reviewed-resume'), false);
});
test('actual owner/session/admission and late reset gates remain effective throughout journey source composition', async () => {
    const who = await f.actor(), other = await f.actor(), staff = await f.actor(true);
    await apply(who, await bookmark(who));
    const before = await sources.read(who);
    await assert.rejects(f.db.withBoundedTransaction(c => sources.assertCurrentInTransaction(c, other, coordinate(before))), error(404));
    await assert.rejects(sources.read(staff), error(403));
    const original = f.db.withBoundedTransaction.bind(f.db);
    f.db.withBoundedTransaction = async (run, options) => original(async (client) => { const query = client.query.bind(client); let changed = false; return run(new Proxy(client, { get(target, key) { if (key === 'query')
            return async (...args: any[]) => { const result = await (query as any)(...args); if (!changed && typeof args[0] === 'string' && args[0].startsWith('SELECT * FROM platform_career_applications')) {
                changed = true;
                await query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [who.userId]);
            } return result; }; return Reflect.get(target, key); } })); }, options);
    try {
        await assert.rejects(sources.read(who), error(401));
    }
    finally {
        f.db.withBoundedTransaction = original;
    }
    await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [other.userId]);
    await assert.rejects(sources.read(other), error(403));
});
test('batch authentication refuses an authentic older application restored behind the latest operation', async () => {
    const who = await f.actor(), a = await apply(who, await bookmark(who)), row = (await f.db.query('SELECT * FROM platform_career_applications WHERE id=$1', [a.id])).rows[0];
    await applications.mutate(who, 'stage', a.id, { operationId: randomUUID(), expectedRevision: 1, stage: 'applied' });
    await f.db.query('UPDATE platform_career_applications SET revision=$2,last_operation_id=$3,stage=$4,updated_at=$5,record_ciphertext=$6 WHERE id=$1', [a.id, row.revision, row.last_operation_id, row.stage, row.updated_at, row.record_ciphertext]);
    await assert.rejects(sources.read(who), error(503));
});
test('batch authentication includes historical care event proof, with no N+1 fallback or assumed safe overlay', async () => {
    const who = await f.actor(), a = await apply(who, await bookmark(who)), interview = (await applications.mutate(who, 'stage', a.id, { operationId: randomUUID(), expectedRevision: 1, stage: 'interview' })).application!;
    const closed = (await applications.mutate(who, 'stage', a.id, { operationId: randomUUID(), expectedRevision: interview.revision, stage: 'closed', closedReason: 'not_advanced' })).application!;
    await applications.mutate(who, 'edit', a.id, { operationId: randomUUID(), expectedRevision: closed.revision, privateNote: 'PRIVATE_FICTIONAL_LATER_NOTE' });
    const index = await sources.read(who);
    assert.equal(index.applications![0].revision, 4);
    assert.equal(index.applications![0].stage, 'closed');
    assert(!JSON.stringify(index).includes('PRIVATE_FICTIONAL'));
});
test('an absent journey adapter stays unavailable while a genuine empty owner collection is an empty collection', async () => {
    const who = await f.actor(), absent = new CareerPreparationSources(f.db, targets, library, resumes), missing = await absent.read(who);
    assert.equal(missing.applications, null);
    assert.equal(missing.savedJobs, null);
    const built = await absent.prepare(who, { skillId: 'role-exploration' });
    assert(built.built.unavailableSources.includes('listApplications'));
    assert(built.built.unavailableSources.includes('listSavedJobs'));
    const present = await sources.read(who);
    assert.deepEqual(present.applications, []);
    assert.deepEqual(present.savedJobs, []);
});
