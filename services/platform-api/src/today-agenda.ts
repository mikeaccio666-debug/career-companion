import type { PoolClient } from 'pg';
import { parseTodayAgenda, agendaLocalDate, careerRecordObject, careerRecordId, type TodayAgendaEvent } from '@companion/platform-contracts';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { Database } from './database.ts';
import type { CompanionDailySettingsService } from './companion-daily-settings.ts';
import type { TodayRestService } from './today-rest.ts';
import type { ManualJobs } from './manual-jobs.ts';
import type { CareerInterviews } from './career-interviews.ts';
import type { ResumeOriginalReview } from './resume-original-review.ts';
import { ApiError } from './errors.ts';
interface Ports {
  settings: Pick<CompanionDailySettingsService, 'readForPolicyInTransaction'>;
  rest: Pick<TodayRestService, 'readForPolicyInTransaction'>;
  jobs: Pick<ManualJobs, 'readForTodayViewInTransaction'>;
  interviews: Pick<CareerInterviews, 'readForTodayViewInTransaction'>;
  resumes: Pick<ResumeOriginalReview, 'readForDailyPlanningInTransaction'>;
}
/** Owner's calendar display, not recommendations, notifications or completion.
 * Complete bounded reads share one owner lock and transaction. */
export class TodayAgendaService {
  constructor(private readonly db: Database, private readonly ports: Ports) {}
  async readInTransaction(c: PoolClient, value: FixedSessionContext, signal?: AbortSignal) {
    let s: FixedSessionContext;
    try {
      const v = careerRecordObject(value, ['userId', 'tokenHash']);
      if (typeof v.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(v.tokenHash)) throw Error();
      s = Object.freeze({ userId: careerRecordId(v.userId), tokenHash: v.tokenHash });
    } catch { throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.'); }
    await authorizeFixedSession(c, s, signal);
    const settings = await this.ports.settings.readForPolicyInTransaction(c, s, signal);
    if (!settings.preferences) throw new ApiError(409, 'DAILY_SETTINGS_REQUIRED', 'Choose your time zone first.');
    const rest = await this.ports.rest.readForPolicyInTransaction(c, s, signal);
    const capturedAt = (await c.query('SELECT clock_timestamp() at')).rows[0].at.toISOString();
    const timeZone = settings.preferences.timeZone, localDate = agendaLocalDate(capturedAt, timeZone);
    const jobs = await this.ports.jobs.readForTodayViewInTransaction(c, s, signal);
    const interviews = await this.ports.interviews.readForTodayViewInTransaction(c, s, signal);
    if (settings.ownerId !== s.userId || rest.ownerId !== s.userId || rest.companionId !== settings.companionId
      || [...jobs, ...interviews].some(v => v.ownerId !== s.userId)) throw new ApiError(503, 'TODAY_AGENDA_UNAVAILABLE', 'The owned calendar could not be confirmed.');
    const resting = !!(rest.optedOutUntil && rest.optedOutUntil > capturedAt || rest.pauseUntil && rest.pauseUntil > capturedAt);
    const events: TodayAgendaEvent[] = [];
    for (const job of jobs) if (job.deadlineAt && agendaLocalDate(job.deadlineAt, timeZone) === localDate) {
      if (!job.deadlineTimeZone) throw new ApiError(503, 'TODAY_AGENDA_UNAVAILABLE', 'The deadline time zone could not be confirmed.');
      events.push({ kind: 'job_deadline', id: job.id, title: job.title, employer: job.employer, at: job.deadlineAt, endsAt: null, timeZone: job.deadlineTimeZone });
    }
    for (const interview of interviews) {
      if (!['scheduled', 'rescheduled'].includes(interview.status)) continue;
      const endsAt = new Date(Date.parse(interview.startsAt) + interview.durationMin * 60000).toISOString();
      if (agendaLocalDate(interview.startsAt, timeZone) <= localDate && agendaLocalDate(new Date(Date.parse(endsAt) - 1).toISOString(), timeZone) >= localDate)
        events.push({ kind: 'interview', id: interview.id, title: interview.title, employer: interview.employer, at: interview.startsAt, endsAt, timeZone: interview.timeZone });
    }
    events.sort((a, b) => a.at.localeCompare(b.at) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
    let pending = null;
    if (!resting) {
      const { reviews } = await this.ports.resumes.readForDailyPlanningInTransaction(c, s, signal);
      if (reviews.some(v => v.ownerId !== s.userId)) throw new ApiError(503, 'TODAY_AGENDA_UNAVAILABLE', 'The owned reviews could not be confirmed.');
      const current = reviews.filter(v => v.status === 'pending' && v.expiresAt > capturedAt);
      pending = { scope: 'resume_reviews' as const, count: current.length, earliestExpiresAt: current.map(v => v.expiresAt).sort()[0] ?? null };
    }
    const result = parseTodayAgenda({ ownerId: s.userId, companionId: settings.companionId, capturedAt, localDate, timeZone, resting, events, pending });
    await authorizeFixedSession(c, s, signal); signal?.throwIfAborted(); return result;
  }
  async read(value: FixedSessionContext, signal?: AbortSignal) { return this.db.withBoundedTransaction(c => this.readInTransaction(c, value, signal)); }
}
