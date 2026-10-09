import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { careerRecordId, careerRecordObject } from '@companion/platform-contracts';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { Database } from './database.ts';
import type { CompanionPlanningSources } from './companion-planning-source.ts';
import type { DailyPlans } from './daily-plans.ts';
import type { TodayRestService } from './today-rest.ts';
import type { CompanionDailySettingsService } from './companion-daily-settings.ts';
import type { CareerTargets } from './career-targets.ts';
import type { CareerStories } from './career-stories.ts';
import type { ResumeOriginalReview } from './resume-original-review.ts';
import type { ManualJobs } from './manual-jobs.ts';
import type { CareerApplications } from './career-applications.ts';
import type { CareerInterviews } from './career-interviews.ts';
import { ApiError } from './errors.ts';
const bad = () => new ApiError(400, 'TODAY_SOURCE_INPUT_INVALID', 'Use the current daily source coordinates.');
function fixed(value: FixedSessionContext) {
  try { const s = careerRecordObject(value, ['userId', 'tokenHash']); if (typeof s.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(s.tokenHash)) throw bad(); return Object.freeze({ userId: careerRecordId(s.userId), tokenHash: s.tokenHash }); }
  catch { throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.'); }
}
const canonical = (v: unknown) => JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
function localDate(at: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at));
  return ['year', 'month', 'day'].map(k => parts.find(p => p.type === k)!.value).join('-');
}
export interface TodaySourcePorts {
  behavior: Pick<CompanionPlanningSources, 'readInTransaction'>;
  plans: Pick<DailyPlans, 'readHistoryInTransaction'>;
  rest: Pick<TodayRestService, 'readForPolicyInTransaction'>;
  settings: Pick<CompanionDailySettingsService, 'readForPolicyInTransaction'>;
  targets: Pick<CareerTargets, 'readForPreparationInTransaction'>;
  library: Pick<CareerStories, 'readPreparationIndexInTransaction'>;
  resumes: Pick<ResumeOriginalReview, 'readForDailyPlanningInTransaction'>;
  jobs: Pick<ManualJobs, 'readForDailyPlanningInTransaction'>;
  applications: Pick<CareerApplications, 'readForDailyPlanningInTransaction' | 'readActiveCareWindowsInTransaction'>;
  interviews: Pick<CareerInterviews, 'readForDailyPlanningInTransaction'>;
}
/** Actual, complete source sets for the future daily-plan transaction.
 * Internal owner-private metadata: not model input, a selected plan, a task
 * completion, an admission decision or an endpoint accepting source DTOs.
 * All adapters are mandatory and assembled from real repositories in app.ts. */
export class TodaySources {
  constructor(private readonly db: Database, private readonly ports: TodaySourcePorts) {}
  async readInTransaction(c: PoolClient, value: FixedSessionContext, signal?: AbortSignal) {
    const s = fixed(value); await authorizeFixedSession(c, s, signal);
    // This authenticates the active birth, email/terms, and takes the same owner
    // lock used by every source writer. No nested transactions or list pages.
    const settings = await this.ports.settings.readForPolicyInTransaction(c, s, signal);
    if (!settings.preferences) throw new ApiError(409, 'DAILY_SETTINGS_REQUIRED', 'Choose your daily preferences first.');
    const capturedAt = (await c.query('SELECT clock_timestamp() at')).rows[0].at.toISOString();
    const rest = await this.ports.rest.readForPolicyInTransaction(c, s, signal);
    if (rest.ownerId !== s.userId || rest.companionId !== settings.companionId) throw new ApiError(503, 'TODAY_SOURCES_UNAVAILABLE', 'The owned rest choice could not be confirmed.');
    const companionBehavior = await this.ports.behavior.readInTransaction(c, s, signal);
    if (companionBehavior.ownerId !== s.userId || companionBehavior.companionId !== settings.companionId)
      throw new ApiError(503, 'TODAY_SOURCES_UNAVAILABLE', 'The owned planning preference could not be confirmed.');
    const dailyHistory = await this.ports.plans.readHistoryInTransaction(c, s, capturedAt, settings.preferences.timeZone, signal);
    const targets = await this.ports.targets.readForPreparationInTransaction(c, s, signal);
    const library = await this.ports.library.readPreparationIndexInTransaction(c, s, signal);
    const resumes = await this.ports.resumes.readForDailyPlanningInTransaction(c, s, signal);
    const savedJobs = await this.ports.jobs.readForDailyPlanningInTransaction(c, s, signal);
    const applications = await this.ports.applications.readForDailyPlanningInTransaction(c, s, signal);
    const interviews = await this.ports.interviews.readForDailyPlanningInTransaction(c, s, signal);
    const rejectionWindows = await this.ports.applications.readActiveCareWindowsInTransaction(c, s, signal);
    for (const set of [targets, library.projects, library.stories, resumes.resumes, resumes.reviews, savedJobs, applications, interviews]) {
      if (set.some(record => record.ownerId !== s.userId) || new Set(set.map(record => record.id)).size !== set.length)
        throw new ApiError(503, 'TODAY_SOURCES_UNAVAILABLE', 'The owned daily sources could not be confirmed.');
    }
    if (settings.ownerId !== s.userId) throw new ApiError(503, 'TODAY_SOURCES_UNAVAILABLE', 'The owned daily sources could not be confirmed.');
    const date = localDate(capturedAt, settings.preferences.timeZone);
    const jobMap = new Map(savedJobs.map(v => [v.id, v]));
    const appMap = new Map(applications.map(v => [v.id, v]));
    const content = Object.freeze({
      kind: 'owned_today_source_snapshot' as const, ownerId: s.userId, localDate: date, settings,
      rest: Object.freeze({ settings: rest,
        tasksSuppressed: !!(rest.optedOutUntil && rest.optedOutUntil > capturedAt || rest.pauseUntil && rest.pauseUntil > capturedAt),
        optedOutDate: rest.optedOutUntil && rest.optedOutUntil > capturedAt ? date : null,
        pauseUntil: rest.pauseUntil && rest.pauseUntil > capturedAt ? rest.pauseUntil : null,
        proactivePaused: !!(rest.pauseUntil && rest.pauseUntil > capturedAt),
        remindersMuted: rest.reminders === 'off' && !!(rest.optedOutUntil && rest.optedOutUntil > capturedAt || rest.pauseUntil && rest.pauseUntil > capturedAt),
      }),
      targets: Object.freeze(targets.map(v => Object.freeze({ id: v.id, revision: v.revision, status: v.status }))),
      projects: Object.freeze(library.projects.map(v => Object.freeze({ id: v.id, revision: v.revision }))),
      stories: Object.freeze(library.stories.map(v => Object.freeze({ id: v.id, revision: v.revision }))),
      resumes: resumes.resumes,
      // Preserve sensitive classification. Only generic coordinates are exposed;
      // no task adapter may relabel the original resume as normal-sensitivity.
      reviews: Object.freeze(resumes.reviews.map(v => Object.freeze({ ...v, actionable: v.status === 'pending' && v.expiresAt > capturedAt }))),
      jobs: Object.freeze(savedJobs.map(v => Object.freeze({ ...v, deadlinePassed: v.deadlineAt !== null && v.deadlineAt <= capturedAt,
        deadlineWithin48Hours: v.deadlineAt !== null && v.deadlineAt > capturedAt && Date.parse(v.deadlineAt) <= Date.parse(capturedAt) + 48 * 3600000 }))),
      applications: Object.freeze(applications.map(v => Object.freeze({ ...v,
        currentJob: jobMap.has(v.job.id) ? Object.freeze({ id: v.job.id, revision: jobMap.get(v.job.id)!.revision }) : null,
        sourceState: !jobMap.has(v.job.id) ? 'missing' as const : jobMap.get(v.job.id)!.revision === v.job.revision ? 'same_revision' as const : 'newer_revision' as const }))),
      interviews: Object.freeze(interviews.map(v => Object.freeze({ ...v,
        upcoming: ['scheduled', 'rescheduled'].includes(v.status) && v.startsAt > capturedAt,
        within72Hours: ['scheduled', 'rescheduled'].includes(v.status) && v.startsAt > capturedAt && Date.parse(v.startsAt) <= Date.parse(capturedAt) + 72 * 3600000,
        localDate: localDate(v.startsAt, settings.preferences!.timeZone),
        currentApplication: appMap.has(v.application.id) ? Object.freeze({ id: v.application.id, revision: appMap.get(v.application.id)!.revision, stage: appMap.get(v.application.id)!.stage }) : null,
        sourceState: !appMap.has(v.application.id) ? 'missing' as const : appMap.get(v.application.id)!.revision === v.application.revision ? 'same_revision' as const : 'newer_revision' as const }))),
      // Genuine immutable events survive application removal. This does not
      // claim that the separately missing crisis/other overlay source is empty.
      rejectionWindows: Object.freeze(rejectionWindows.filter(v => v.until > capturedAt)),
      coverage: Object.freeze(['companion_birth_behavior', 'daily_plan_history', 'rest_choices', 'daily_preferences', 'target_coordinates', 'normal_project_coordinates', 'confirmed_story_coordinates', 'resume_reviews', 'manual_job_deadlines', 'application_states', 'interview_schedules', 'post_rejection_events'] as const),
      // Missing data stays missing, never [] / false / an unearned plan grant.
      companionBehavior, companionOverlays: null, journeyFocus: null, dailyHistory, practiceReceipts: null,
    });
    await authorizeFixedSession(c, s, signal); signal?.throwIfAborted();
    return Object.freeze({ ...content, capturedAt, sourceId: 'today_source_' + createHash('sha256').update(canonical(content)).digest('hex') });
  }
  async read(value: FixedSessionContext, signal?: AbortSignal) {
    const s = fixed(value); return this.db.withBoundedTransaction(c => this.readInTransaction(c, s, signal));
  }
  /** Re-read immediately inside the eventual accepting/writing transaction.
   * This freshness check does not by itself satisfy the missing plan sources. */
  async assertCurrentInTransaction(c: PoolClient, value: FixedSessionContext, expected: unknown, signal?: AbortSignal) {
    const s = fixed(value); let ownerId: string, sourceId: string;
    try { const e = careerRecordObject(expected, ['ownerId', 'sourceId']); ownerId = careerRecordId(e.ownerId); if (typeof e.sourceId !== 'string' || !/^today_source_[0-9a-f]{64}$/.test(e.sourceId)) throw bad(); sourceId = e.sourceId; } catch { throw bad(); }
    if (ownerId !== s.userId) throw new ApiError(404, 'NOT_FOUND', 'The daily sources were not found.');
    const current = await this.readInTransaction(c, s, signal);
    if (current.sourceId !== sourceId) throw new ApiError(409, 'TODAY_SOURCES_CHANGED', 'Read the current daily sources before continuing.');
    return current;
  }
}
export type TodaySourceSnapshot = Awaited<ReturnType<TodaySources['read']>>;
