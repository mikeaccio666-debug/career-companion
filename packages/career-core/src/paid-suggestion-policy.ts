import { careerRecordObject as object, careerRecordId as id, EXPERT_KEYS } from '@companion/platform-contracts';
export const PAID_SERVICE_KINDS = Object.freeze(['mock_interview', 'resume_direction', 'offer_negotiation', 'referral_assessment', 'course_unit', 'manteng_package'] as const);
export type PaidServiceKind = typeof PAID_SERVICE_KINDS[number];
export const PAID_TRIGGERS = Object.freeze(['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'] as const);
export type PaidTrigger = typeof PAID_TRIGGERS[number];
type Response = 'pending' | 'chose_free' | 'interested' | 'ordered' | 'declined' | 'no_response';
export interface PaidSuggestionHistory {
    readonly id: string;
    readonly ownerId: string;
    readonly serviceKind: PaidServiceKind;
    readonly trigger: PaidTrigger;
    readonly shownAt: string;
    readonly response: Response;
    readonly respondedAt: string | null;
    readonly feelsSalesy: boolean;
    readonly feedbackAt: string | null;
}
export interface PaidSuggestionMute {
    readonly serviceKind: PaidServiceKind;
    readonly mutedUntil: string | null;
    readonly restoredAt: string | null;
}
export type PaidTriggerEvidence = {
    readonly trigger: 'T1';
    readonly intent: 'human_service' | 'fees' | 'other';
} | {
    readonly trigger: 'T2';
    readonly interviewStartsAt: string;
    readonly interviewKind: 'final' | 'onsite' | 'other';
    readonly sameServiceScheduled: boolean;
    readonly interviewAlreadySuggested: boolean;
} | {
    readonly trigger: 'T3';
    readonly offerMarkedAt: string;
    readonly offerCount: number;
    readonly comparingOrNegotiating: boolean;
    readonly replyDeadlineAt: string | null;
} | {
    readonly trigger: 'T5';
    readonly submitted30d: number;
    readonly invitedApplications30d: number;
    readonly submittedAfterRevision: number;
    readonly guideRevisionApplied: boolean;
    readonly cohortSize: number;
    readonly cohortMedianRate: number | null;
    readonly calibratedRate: number | null;
    readonly calibrationRef: string | null;
} | {
    readonly trigger: 'T6';
    readonly sameRoleNotAdvanced60d: number;
} | {
    readonly trigger: 'T4' | 'T7' | 'T8';
};
/** Server-derived facts only. Counts are distinct applications in the named window/family.
 * A snapshot is not an authority: the future service must read and authenticate every source.
 * quietHours/lateNight are explicit results of the user's time policy, never inferred here. */
export interface PaidSuggestionInput {
    readonly ownerId: string;
    readonly now: string;
    readonly registeredAt: string;
    readonly timeZone: string;
    readonly serviceKind: PaidServiceKind;
    readonly evidence: PaidTriggerEvidence | null;
    readonly evidenceSensitivity: 'normal' | 'sensitive' | 'restricted';
    readonly settings: {
        readonly mode: 'when_relevant' | 'only_when_asked';
        readonly optOrUnemploymentRecorded: boolean;
        readonly enabledTriggers: readonly PaidTrigger[];
        readonly serviceAvailable: boolean | null;
    };
    readonly context: {
        readonly speaker: 'companion' | typeof EXPERT_KEYS[number];
        readonly channel: 'web' | 'discord_dm' | 'discord_public' | 'voice' | 'push' | 'email';
        readonly surface: 'live_conversation' | 'morning_brief' | 'three_things' | 'letter' | 'background';
        readonly userConversationActive: boolean;
        readonly quietHours: boolean | null;
        readonly lateNight: boolean | null;
        readonly declinedTodayAt: string | null;
        readonly lastRejectionAt: string | null;
        readonly lastCrisisAt: string | null;
        readonly latestOfferAt: string | null;
    };
    readonly historyCompleteSince: string;
    readonly history: readonly PaidSuggestionHistory[];
    readonly mutes: readonly PaidSuggestionMute[];
    /** Latest authorized copy-review cutoff for THIS trigger; not a caller-controlled bypass in an HTTP API. */
    readonly feedbackReviewedThrough: string | null;
}
export type PaidSuggestionDenial = 'phase_disabled' | 'trigger_disabled' | 'service_unavailable' | 'wrong_surface' | 'time_policy_unknown' | 'quiet_hours' | 'late_night' | 'not_today' | 'post_rejection' | 'post_crisis' | 'offer_day' | 'only_when_asked' | 'service_muted' | 'frequency_limit' | 'feedback_paused' | 'evidence_unavailable' | 'private_evidence' | 'trigger_not_met' | 'calibration_missing' | 'referral_information_only';
export type PaidSuggestionDecision = Readonly<{
    policyRevision: 1;
    eligible: boolean;
    reason: PaidSuggestionDenial | null;
    trigger: PaidTrigger | null;
    serviceKind: PaidServiceKind;
    needsCopyReview: boolean;
    frequencyDays: 14 | 30;
    presentation: 'web_card' | 'discord_link' | 'information_only' | null;
    freePath: 'ask_ai_or_career_center' | 'two_targeted_practice_rounds' | 'offer_comparison_and_negotiation_notes' | 'three_job_resume_review' | 'interview_review_and_two_rounds' | null;
}>;
export class PaidSuggestionInputError extends Error {
    constructor() { super('The paid-suggestion sources could not be confirmed.'); }
}
const fail = (): never => { throw new PaidSuggestionInputError(); };
const DAY = 86400000;
function bool(v: unknown): boolean { if (typeof v !== 'boolean')
    return fail(); return v; }
function nullableBool(v: unknown): boolean | null { return v === null ? null : bool(v); }
function choice<T extends string>(v: unknown, values: readonly T[]): T { if (typeof v !== 'string' || !values.includes(v as T))
    return fail(); return v as T; }
function integer(v: unknown): number { if (typeof v !== 'number' || !Number.isSafeInteger(v) || Object.is(v, -0) || v < 0 || v > 10000000)
    return fail(); return v; }
function rate(v: unknown): number | null { if (v === null)
    return null; if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1 || Object.is(v, -0))
    return fail(); return v; }
function date(v: unknown): string { if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v)
    return fail(); return v; }
function nullableDate(v: unknown): string | null { return v === null ? null : date(v); }
function array<T>(v: unknown, max: number, parse: (x: unknown) => T): T[] {
    if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype || v.length > max)
        return fail();
    const d = Object.getOwnPropertyDescriptors(v);
    if (Reflect.ownKeys(d).length !== v.length + 1)
        return fail();
    const out: T[] = [];
    for (let i = 0; i < v.length; i++) {
        if (!d[i] || !('value' in d[i]) || !d[i].enumerable)
            return fail();
        out.push(parse(d[i].value));
    }
    return out;
}
function evidence(v: unknown): PaidTriggerEvidence | null {
    if (v === null)
        return null;
    const tagged = object(v, ['trigger'], ['intent', 'interviewStartsAt', 'interviewKind', 'sameServiceScheduled', 'interviewAlreadySuggested', 'offerMarkedAt', 'offerCount', 'comparingOrNegotiating', 'replyDeadlineAt', 'submitted30d', 'invitedApplications30d', 'submittedAfterRevision', 'guideRevisionApplied', 'cohortSize', 'cohortMedianRate', 'calibratedRate', 'calibrationRef', 'sameRoleNotAdvanced60d']);
    const trigger = choice(tagged.trigger, PAID_TRIGGERS);
    if (trigger === 'T1') {
        const e = object(v, ['trigger', 'intent']);
        return { trigger, intent: choice(e.intent, ['human_service', 'fees', 'other']) };
    }
    if (trigger === 'T2') {
        const e = object(v, ['trigger', 'interviewStartsAt', 'interviewKind', 'sameServiceScheduled', 'interviewAlreadySuggested']);
        return { trigger, interviewStartsAt: date(e.interviewStartsAt), interviewKind: choice(e.interviewKind, ['final', 'onsite', 'other']), sameServiceScheduled: bool(e.sameServiceScheduled), interviewAlreadySuggested: bool(e.interviewAlreadySuggested) };
    }
    if (trigger === 'T3') {
        const e = object(v, ['trigger', 'offerMarkedAt', 'offerCount', 'comparingOrNegotiating', 'replyDeadlineAt']);
        return { trigger, offerMarkedAt: date(e.offerMarkedAt), offerCount: integer(e.offerCount), comparingOrNegotiating: bool(e.comparingOrNegotiating), replyDeadlineAt: nullableDate(e.replyDeadlineAt) };
    }
    if (trigger === 'T5') {
        const e = object(v, ['trigger', 'submitted30d', 'invitedApplications30d', 'submittedAfterRevision', 'guideRevisionApplied', 'cohortSize', 'cohortMedianRate', 'calibratedRate', 'calibrationRef']);
        const ref = e.calibrationRef === null ? null : id(e.calibrationRef), calibrated = rate(e.calibratedRate);
        if ((ref === null) !== (calibrated === null))
            return fail();
        const result = { trigger, submitted30d: integer(e.submitted30d), invitedApplications30d: integer(e.invitedApplications30d), submittedAfterRevision: integer(e.submittedAfterRevision), guideRevisionApplied: bool(e.guideRevisionApplied), cohortSize: integer(e.cohortSize), cohortMedianRate: rate(e.cohortMedianRate), calibratedRate: calibrated, calibrationRef: ref };
        if (result.invitedApplications30d > result.submitted30d)
            return fail();
        return result;
    }
    if (trigger === 'T6') {
        const e = object(v, ['trigger', 'sameRoleNotAdvanced60d']);
        return { trigger, sameRoleNotAdvanced60d: integer(e.sameRoleNotAdvanced60d) };
    }
    object(v, ['trigger']);
    return { trigger };
}
function parse(value: unknown): PaidSuggestionInput {
    const v = object(value, ['ownerId', 'now', 'registeredAt', 'timeZone', 'serviceKind', 'evidence', 'evidenceSensitivity', 'settings', 'context', 'historyCompleteSince', 'history', 'mutes', 'feedbackReviewedThrough']);
    const now = date(v.now), registeredAt = date(v.registeredAt), historyCompleteSince = date(v.historyCompleteSince), ownerId = id(v.ownerId);
    if (registeredAt > now || historyCompleteSince > new Date(Math.max(Date.parse(registeredAt), Date.parse(now) - 37 * DAY)).toISOString())
        return fail();
    if (typeof v.timeZone !== 'string' || !v.timeZone || v.timeZone.length > 100)
        return fail();
    new Intl.DateTimeFormat('en-US', { timeZone: v.timeZone }).format();
    const s = object(v.settings, ['mode', 'optOrUnemploymentRecorded', 'enabledTriggers', 'serviceAvailable']);
    const enabledTriggers = array(s.enabledTriggers, 8, x => choice(x, PAID_TRIGGERS));
    if (new Set(enabledTriggers).size !== enabledTriggers.length)
        return fail();
    const c = object(v.context, ['speaker', 'channel', 'surface', 'userConversationActive', 'quietHours', 'lateNight', 'declinedTodayAt', 'lastRejectionAt', 'lastCrisisAt', 'latestOfferAt']);
    const context = { speaker: choice(c.speaker, ['companion', ...EXPERT_KEYS]), channel: choice(c.channel, ['web', 'discord_dm', 'discord_public', 'voice', 'push', 'email']), surface: choice(c.surface, ['live_conversation', 'morning_brief', 'three_things', 'letter', 'background']), userConversationActive: bool(c.userConversationActive), quietHours: nullableBool(c.quietHours), lateNight: nullableBool(c.lateNight), declinedTodayAt: nullableDate(c.declinedTodayAt), lastRejectionAt: nullableDate(c.lastRejectionAt), lastCrisisAt: nullableDate(c.lastCrisisAt), latestOfferAt: nullableDate(c.latestOfferAt) };
    for (const at of [context.declinedTodayAt, context.lastRejectionAt, context.lastCrisisAt, context.latestOfferAt])
        if (at !== null && at > now)
            return fail();
    const history = array(v.history, 10000, x => {
        const h = object(x, ['id', 'ownerId', 'serviceKind', 'trigger', 'shownAt', 'response', 'respondedAt', 'feelsSalesy', 'feedbackAt']);
        const shownAt = date(h.shownAt), respondedAt = nullableDate(h.respondedAt), response = choice(h.response, ['pending', 'chose_free', 'interested', 'ordered', 'declined', 'no_response']);
        if (h.ownerId !== ownerId || shownAt > now || shownAt < registeredAt || respondedAt !== null && (respondedAt < shownAt || respondedAt > now) || (response === 'pending') !== (respondedAt === null))
            return fail();
        if (response === 'no_response' && Date.parse(respondedAt!) < Date.parse(shownAt) + 7 * DAY)
            return fail();
        const feedbackAt = nullableDate(h.feedbackAt), feelsSalesy = bool(h.feelsSalesy);
        if (feelsSalesy !== (feedbackAt !== null) || feedbackAt !== null && (feedbackAt < shownAt || feedbackAt > now))
            return fail();
        return { id: id(h.id), ownerId, serviceKind: choice(h.serviceKind, PAID_SERVICE_KINDS), trigger: choice(h.trigger, PAID_TRIGGERS), shownAt, response, respondedAt, feelsSalesy, feedbackAt };
    });
    if (new Set(history.map(h => h.id)).size !== history.length)
        return fail();
    const mutes = array(v.mutes, 6, x => { const m = object(x, ['serviceKind', 'mutedUntil', 'restoredAt']), mutedUntil = nullableDate(m.mutedUntil), restoredAt = nullableDate(m.restoredAt); if ((mutedUntil === null) === (restoredAt === null) || restoredAt !== null && restoredAt > now)
        return fail(); return { serviceKind: choice(m.serviceKind, PAID_SERVICE_KINDS), mutedUntil, restoredAt }; });
    if (new Set(mutes.map(m => m.serviceKind)).size !== mutes.length)
        return fail();
    const feedbackReviewedThrough = nullableDate(v.feedbackReviewedThrough);
    if (feedbackReviewedThrough !== null && feedbackReviewedThrough > now)
        return fail();
    const e = evidence(v.evidence);
    if (e?.trigger === 'T3' && (e.offerMarkedAt > now || context.latestOfferAt === null || context.latestOfferAt < e.offerMarkedAt))
        return fail();
    return { ownerId, now, registeredAt, timeZone: v.timeZone, serviceKind: choice(v.serviceKind, PAID_SERVICE_KINDS), evidence: e, evidenceSensitivity: choice(v.evidenceSensitivity, ['normal', 'sensitive', 'restricted']),
        settings: { mode: choice(s.mode, ['when_relevant', 'only_when_asked']), optOrUnemploymentRecorded: bool(s.optOrUnemploymentRecorded), enabledTriggers, serviceAvailable: nullableBool(s.serviceAvailable) }, context, historyCompleteSince, history, mutes, feedbackReviewedThrough };
}
/** 06 §7, 09 §8. Pure eligibility only: no reservation, signed grant, DB write,
 * model request, price, delivery or suppression task. Missing sources never become positive facts. */
export function canSuggestPaid(value: unknown): PaidSuggestionDecision {
    let x: PaidSuggestionInput;
    try {
        x = parse(value);
    }
    catch {
        throw new PaidSuggestionInputError();
    }
    const now = Date.parse(x.now), e = x.evidence, trigger = e?.trigger ?? null, c = x.context;
    const recent = x.history.filter(h => h.trigger === trigger && Date.parse(h.shownAt) > now - 14 * DAY), flags = recent.filter(h => h.feelsSalesy);
    const unreviewed = (h: PaidSuggestionHistory) => x.feedbackReviewedThrough === null || h.feedbackAt! > x.feedbackReviewedThrough;
    const needsCopyReview = x.history.some(h => h.trigger === trigger && h.feelsSalesy && unreviewed(h));
    const reduced = recent.length >= 30 && flags.length * 100 > 3 * recent.length;
    const frequencyDays: 14 | 30 = x.settings.optOrUnemploymentRecorded || reduced ? 30 : 14;
    const result = (reason: PaidSuggestionDenial | null, freePath: PaidSuggestionDecision['freePath'] = null): PaidSuggestionDecision => Object.freeze({ policyRevision: 1, eligible: reason === null, reason, trigger, serviceKind: x.serviceKind, needsCopyReview, frequencyDays, freePath: reason === null ? freePath : null,
        presentation: reason !== null ? null : x.serviceKind === 'manteng_package' ? 'information_only' : c.channel === 'web' ? 'web_card' : 'discord_link' });
    if (e === null)
        return result('evidence_unavailable');
    if (['T4', 'T7', 'T8'].includes(e.trigger) || x.serviceKind === 'course_unit')
        return result('phase_disabled');
    if (x.serviceKind === 'referral_assessment')
        return result('referral_information_only');
    if (!x.settings.enabledTriggers.includes(e.trigger))
        return result('trigger_disabled');
    if (x.settings.serviceAvailable !== true)
        return result('service_unavailable');
    if (c.speaker !== 'companion' || c.surface !== 'live_conversation' || !c.userConversationActive || !['web', 'discord_dm'].includes(c.channel))
        return result('wrong_surface');
    if (c.quietHours === null || c.lateNight === null)
        return result('time_policy_unknown');
    if (c.quietHours)
        return result('quiet_hours');
    if (c.lateNight)
        return result('late_night');
    const day = (at: string) => new Intl.DateTimeFormat('en-CA', { timeZone: x.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
    if (c.declinedTodayAt !== null && day(c.declinedTodayAt) === day(x.now))
        return result('not_today');
    if (c.lastRejectionAt !== null && Date.parse(c.lastRejectionAt) > now - 2 * DAY)
        return result('post_rejection');
    if (c.lastCrisisAt !== null && Date.parse(c.lastCrisisAt) > now - 14 * DAY)
        return result('post_crisis');
    if (c.latestOfferAt !== null && day(c.latestOfferAt) === day(x.now))
        return result('offer_day');
    if (x.evidenceSensitivity !== 'normal')
        return result('private_evidence');
    if (e.trigger !== 'T1' && x.settings.mode === 'only_when_asked')
        return result('only_when_asked');
    const restored = x.mutes.find(m => m.serviceKind === x.serviceKind)?.restoredAt ?? null;
    const silenced = x.mutes.some(m => m.serviceKind === x.serviceKind && m.mutedUntil !== null && m.mutedUntil > x.now) || x.history.some(h => {
        if (h.serviceKind !== x.serviceKind)
            return false;
        const start = h.response === 'declined' ? Date.parse(h.respondedAt!) : h.response === 'no_response' || h.response === 'pending' && Date.parse(h.shownAt) + 7 * DAY <= now ? Date.parse(h.shownAt) + 7 * DAY : null;
        return start !== null && (restored === null || start > Date.parse(restored)) && now < start + 30 * DAY;
    });
    if (silenced)
        return result('service_muted');
    if (recent.length >= 30 && flags.length * 100 > 6 * recent.length && flags.some(unreviewed))
        return result('feedback_paused');
    if (e.trigger !== 'T1' && x.history.some(h => h.trigger !== 'T1' && Date.parse(h.shownAt) > now - frequencyDays * DAY))
        return result('frequency_limit');
    let passed = false, freePath: PaidSuggestionDecision['freePath'] = null;
    if (e.trigger === 'T1') {
        passed = ['human_service', 'fees'].includes(e.intent);
        freePath = 'ask_ai_or_career_center';
    }
    if (e.trigger === 'T2') {
        const until = Date.parse(e.interviewStartsAt) - now;
        passed = x.serviceKind === 'mock_interview' && ['final', 'onsite'].includes(e.interviewKind) && until >= 3 * DAY && until <= 7 * DAY && !e.sameServiceScheduled && !e.interviewAlreadySuggested;
        freePath = 'two_targeted_practice_rounds';
    }
    if (e.trigger === 'T3') {
        const deadline = e.replyDeadlineAt === null ? null : Date.parse(e.replyDeadlineAt) - now;
        passed = x.serviceKind === 'offer_negotiation' && now - Date.parse(e.offerMarkedAt) >= DAY && e.offerCount >= 1 && (e.comparingOrNegotiating || e.offerCount >= 2 || deadline !== null && deadline >= 0 && deadline <= 14 * DAY);
        freePath = 'offer_comparison_and_negotiation_notes';
    }
    if (e.trigger === 'T5') {
        if (now - Date.parse(x.registeredAt) < 30 * DAY)
            return result('trigger_not_met');
        const baseline = e.cohortSize >= 10 ? e.cohortMedianRate : e.calibratedRate;
        if (baseline === null)
            return result('calibration_missing');
        passed = x.serviceKind === 'resume_direction' && e.submitted30d >= 60 && e.guideRevisionApplied && e.submittedAfterRevision >= 20 && e.invitedApplications30d / e.submitted30d < baseline / 2;
        freePath = 'three_job_resume_review';
    }
    if (e.trigger === 'T6') {
        passed = x.serviceKind === 'mock_interview' && e.sameRoleNotAdvanced60d >= 3;
        freePath = 'interview_review_and_two_rounds';
    }
    return result(passed ? null : 'trigger_not_met', freePath);
}
