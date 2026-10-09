import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPrebirthFixture, withPrebirthLoopback, type PrebirthFixture } from './fixtures/companion-prebirth.ts';
import { readyBirth } from './fixtures/companion-birth.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
import { TodayAgendaService } from '../src/today-agenda.ts';
import { CompanionDailySettingsService } from '../src/companion-daily-settings.ts';
import { TodayRestService } from '../src/today-rest.ts';
import { ManualJobs } from '../src/manual-jobs.ts';
import { CareerApplications } from '../src/career-applications.ts';
import { CareerInterviews } from '../src/career-interviews.ts';
import { ResumeOriginalReview } from '../src/resume-original-review.ts';
import { ApiError } from '../src/errors.ts';
import type { FixedSessionContext } from '../src/auth.ts';
let f: PrebirthFixture, settings: CompanionDailySettingsService, rest: TodayRestService, jobs: ManualJobs,
  applications: CareerApplications, interviews: CareerInterviews, resumes: ResumeOriginalReview, agenda: TodayAgendaService;
const operation = (expectedRevision = 0) => ({ operationId: randomUUID(), expectedRevision });
const prefs = { timeZone: 'America/New_York', morningTime: '09:00', quietStart: '22:30', quietEnd: '08:30', dailyMinutes: 90, webAlert: 'none' as const };
const denied = (status: number) => (e: unknown) => e instanceof ApiError && e.status === status;
before(async () => {
  f = await createPrebirthFixture(); settings = new CompanionDailySettingsService(f.db, f.config, FICTIONAL_LEGAL);
  rest = new TodayRestService(f.db, f.config, FICTIONAL_LEGAL); jobs = new ManualJobs(f.db, f.config, FICTIONAL_LEGAL);
  applications = new CareerApplications(f.db, f.config, FICTIONAL_LEGAL, jobs);
  interviews = new CareerInterviews(f.db, f.config, FICTIONAL_LEGAL, applications); resumes = new ResumeOriginalReview(f.db, f.config, FICTIONAL_LEGAL);
  agenda = new TodayAgendaService(f.db, { settings, rest, jobs, interviews, resumes });
});
after(async () => { await f?.close(); });
async function born(save = true) {
  let who!: FixedSessionContext;
  await withPrebirthLoopback(async runtime => { const b = await readyBirth(f, runtime); who = b.ready.who; await b.service.birth(who, b.body, b.key); });
  if (save) await settings.change(who, { ...operation(), companionId: (await settings.read(who)).settings.companionId, preferences: prefs });
  return who;
}
async function job(who: FixedSessionContext, at: string | null = null) {
  return (await jobs.mutate(who, 'create', null, { ...operation(), employer: 'Fictional agenda employer', title: 'Fictional agenda role ' + randomUUID(),
    canonicalUrl: 'https://example.invalid/' + randomUUID(), roleFamily: 'da', location: 'Fictional location', jobText: 'PRIVATE_FICTIONAL_JOB_BODY',
    privateNote: 'PRIVATE_FICTIONAL_JOB_NOTE', deadlineAt: at, deadlineTimeZone: at ? 'America/Los_Angeles' : null })).job!;
}
async function interview(who: FixedSessionContext, startsAt: string, durationMin = 45) {
  const j = await job(who), a = (await applications.mutate(who, 'create', null, { ...operation(), jobObservationId: j.id, jobObservationRevision: j.revision, privateNote: 'PRIVATE_FICTIONAL_APP_NOTE' })).application!;
  return (await interviews.mutate(who, 'create', null, { ...operation(), applicationId: a.id, applicationRevision: a.revision, roundType: 'sql', startsAt, timeZone: 'America/Los_Angeles', durationMin })).interview!;
}
async function resume(who: FixedSessionContext, track: 'da' | 'ds' = 'da') { return (await resumes.mutate(who, 'create', null, { ...operation(), track, label: 'PRIVATE_FICTIONAL_RESUME_LABEL', text: 'PRIVATE_FICTIONAL_RESUME_BODY' }, 'web')).view!; }
async function clock(at: string, run: () => Promise<void>) {
  const original = f.db.withBoundedTransaction.bind(f.db);
  f.db.withBoundedTransaction = async (fn, options) => original(c => fn(new Proxy(c, { get(target, key) {
    if (key === 'query') return async (sql: any, ...args: any[]) => sql === 'SELECT clock_timestamp() at'
      ? { rows: [{ at: new Date(at) }] } : (target.query as any)(sql, ...args);
    const v = Reflect.get(target, key); return typeof v === 'function' ? v.bind(target) : v;
  } })), options);
  try { await run(); } finally { f.db.withBoundedTransaction = original; }
}

test('today follows saved timezone through 25-hour DST day, includes overnight overlap and excludes midnight end or cancelled interviews', async () => {
  const who = await born(), a = await interview(who, '2026-11-01T05:30:00.000Z'), b = await interview(who, '2026-11-01T06:30:00.000Z');
  const overnight = await interview(who, '2026-11-01T03:30:00.000Z', 60), ended = await interview(who, '2026-11-01T03:00:00.000Z', 60);
  const cancelled = await interview(who, '2026-11-01T18:00:00.000Z'), done = await interview(who, '2026-11-01T19:00:00.000Z');
  await interviews.mutate(who, 'status', cancelled.id, { ...operation(1), status: 'cancelled' });
  await interviews.mutate(who, 'status', done.id, { ...operation(1), status: 'done' });
  const deadline = await job(who, '2026-11-02T04:59:59.999Z'), tomorrow = await job(who, '2026-11-02T05:00:00.000Z');
  await clock('2026-11-01T16:00:00.000Z', async () => {
    const view = await agenda.read(who);
    assert.equal(view.localDate, '2026-11-01'); assert.equal(view.timeZone, 'America/New_York');
    assert.deepEqual(view.events.map(e => e.id), [overnight.id, a.id, b.id, deadline.id]);
    for (const id of [ended.id, cancelled.id, done.id, tomorrow.id]) assert(!view.events.some(e => e.id === id));
    assert(view.events.every(e => e.timeZone === 'America/Los_Angeles'));
    assert(!JSON.stringify(view).includes('PRIVATE_FICTIONAL')); assert(!JSON.stringify(view).includes(who.tokenHash));
    assert(Object.isFrozen(view.events)); assert(view.events.every(Object.isFrozen));
  });
  await clock('2026-11-02T05:00:00.000Z', async () => assert.deepEqual((await agenda.read(who)).events.map(e => e.id), [tomorrow.id]));
});

test('pending summary counts only unexpired undecided resume reviews and never writes an expiration or exposes resume text', async () => {
  const who = await born(), a = await resume(who), b = await resume(who, 'ds');
  let view = await agenda.read(who); assert.equal(view.pending?.count, 2);
  assert.equal(view.pending?.earliestExpiresAt, [a.item.expiresAt, b.item.expiresAt].sort()[0]);
  await resumes.mutate(who, 'approve', a.item.id, { ...operation(1), payloadDigest: a.item.payloadDigest }, 'web');
  view = await agenda.read(who); assert.equal(view.pending?.count, 1); assert.equal(view.pending?.earliestExpiresAt, b.item.expiresAt);
  assert(!JSON.stringify(view).includes('PRIVATE_FICTIONAL'));
  await clock(b.item.expiresAt, async () => { const expired = await agenda.read(who); assert.equal(expired.pending?.count, 0); assert.equal(expired.pending?.earliestExpiresAt, null); });
  assert.equal((await f.db.query('SELECT status FROM platform_pending_items WHERE id=$1', [b.item.id])).rows[0].status, 'pending');
});

test('rest removes review prompts but keeps the owner calendar; disabling reminders does not pretend to delete saved events', async () => {
  const who = await born(); await resume(who); const i = await interview(who, '2026-11-01T18:00:00.000Z');
  const companionId = (await settings.read(who)).settings.companionId;
  await clock('2026-11-01T16:00:00.000Z', async () => {
    await rest.change(who, { ...operation(), companionId, choice: 'today' });
    let view = await agenda.read(who); assert.equal(view.resting, true); assert.equal(view.pending, null); assert.equal(view.events[0].id, i.id);
    await rest.change(who, { ...operation(1), companionId, choice: 'reminders_off' });
    view = await agenda.read(who); assert.equal(view.pending, null); assert.equal(view.events[0].id, i.id);
    assert.equal((await f.db.query('SELECT id FROM platform_jobs WHERE user_id=$1', [who.userId])).rowCount, 0);
  });
});

test('complete agenda exceeds the visible first page and another account cannot contribute records', async () => {
  const who = await born(), other = await born();
  for (let n = 0; n < 55; n++) await job(who, '2026-11-01T20:00:00.000Z');
  await job(other, '2026-11-01T20:00:00.000Z');
  await clock('2026-11-01T16:00:00.000Z', async () => {
    assert.equal((await agenda.read(who)).events.length, 55); assert.equal((await agenda.read(other)).events.length, 1);
    await assert.rejects(agenda.read({ userId: who.userId, tokenHash: other.tokenHash }), denied(401));
  });
});

test('prebirth, missing preferences, staff, withdrawn admission and corrupt saved event fail as unavailable rather than empty', async () => {
  await assert.rejects(agenda.read(await f.actor()), denied(409)); await assert.rejects(agenda.read(await born(false)), denied(409));
  await assert.rejects(agenda.read(await f.actor(true)), denied(403));
  const who = await born(), i = await interview(who, '2026-11-01T18:00:00.000Z');
  await f.db.query('UPDATE platform_career_interviews SET record_ciphertext=$2 WHERE id=$1', [i.id, Buffer.from('fictional invalid schedule ciphertext')]);
  await assert.rejects(agenda.read(who), denied(503));
  const second = await born(); await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [second.userId]);
  await assert.rejects(agenda.read(second), denied(403));
  await assert.rejects(agenda.read({ ...second, localDate: '2026-11-01' } as FixedSessionContext), denied(401));
});

test('late session revocation cannot release a calendar and cancellation never fabricates an empty summary', async () => {
  const who = await born(), original = f.db.withBoundedTransaction.bind(f.db);
  f.db.withBoundedTransaction = async (run, options) => original(c => run(new Proxy(c, { get(target, key) {
    if (key === 'query') return async (sql: any, ...args: any[]) => {
      const result = await (target.query as any)(sql, ...args);
      if (typeof sql === 'string' && sql.startsWith('SELECT * FROM platform_career_job_observations WHERE user_id=$1 ORDER'))
        await target.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [who.userId]);
      return result;
    };
    const v = Reflect.get(target, key); return typeof v === 'function' ? v.bind(target) : v;
  } })), options);
  try { await assert.rejects(agenda.read(who), denied(401)); } finally { f.db.withBoundedTransaction = original; }
  await assert.rejects(agenda.read(who, AbortSignal.abort()));
});
