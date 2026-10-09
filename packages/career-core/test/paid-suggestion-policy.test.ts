import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { canSuggestPaid, PaidSuggestionInputError, type PaidSuggestionInput, type PaidSuggestionHistory, type PaidTriggerEvidence } from '../src/paid-suggestion-policy.ts';
const owner = randomUUID(), NOW = '2026-10-08T18:00:00.000Z', DAY = 86400000;
const at = (days: number) => new Date(Date.parse(NOW) + days * DAY).toISOString();
function input(evidence: PaidTriggerEvidence = { trigger: 'T2', interviewStartsAt: at(4), interviewKind: 'final', sameServiceScheduled: false, interviewAlreadySuggested: false }): PaidSuggestionInput {
    return {
        ownerId: owner, now: NOW, registeredAt: at(-100), timeZone: 'America/Los_Angeles', serviceKind: 'mock_interview', evidence, evidenceSensitivity: 'normal',
        settings: { mode: 'when_relevant', optOrUnemploymentRecorded: false, enabledTriggers: ['T1', 'T2', 'T3', 'T5', 'T6'], serviceAvailable: true },
        context: { speaker: 'companion', channel: 'web', surface: 'live_conversation', userConversationActive: true, quietHours: false, lateNight: false, declinedTodayAt: null, lastRejectionAt: null, lastCrisisAt: null, latestOfferAt: null },
        historyCompleteSince: at(-37), history: [], mutes: [], feedbackReviewedThrough: null
    };
}
function history(patch: Partial<PaidSuggestionHistory> = {}): PaidSuggestionHistory { return { id: randomUUID(), ownerId: owner, serviceKind: 'resume_direction', trigger: 'T5', shownAt: at(-15), response: 'chose_free', respondedAt: at(-15), feelsSalesy: false, feedbackAt: null, ...patch }; }
function verdict(x: PaidSuggestionInput, reason: string | null) { const d = canSuggestPaid(x); assert.equal(d.reason, reason); assert.equal(d.eligible, reason === null); if (reason) {
    assert.equal(d.presentation, null);
    assert.equal(d.freePath, null);
} return d; }
test('eligible direction produces a frozen policy result and free route, never a token, price or claimed receipt', () => {
    const d = verdict(input(), null);
    assert.equal(d.freePath, 'two_targeted_practice_rounds');
    assert.equal(d.presentation, 'web_card');
    assert(Object.isFrozen(d));
    assert.deepEqual(Object.keys(d).sort(), ['policyRevision', 'eligible', 'reason', 'trigger', 'serviceKind', 'needsCopyReview', 'frequencyDays', 'presentation', 'freePath'].sort());
    assert.equal(canSuggestPaid({ ...input(), context: { ...input().context, channel: 'discord_dm' } }).presentation, 'discord_link');
});
test('only active companion conversations may carry a suggestion; every other channel and proactive surface is denied', () => {
    const x = input();
    for (const speaker of ['guide', 'interviewer', 'applier', 'planner', 'coach', 'networker'] as const)
        verdict({ ...x, context: { ...x.context, speaker } }, 'wrong_surface');
    for (const channel of ['discord_public', 'voice', 'push', 'email'] as const)
        verdict({ ...x, context: { ...x.context, channel } }, 'wrong_surface');
    for (const surface of ['morning_brief', 'three_things', 'letter', 'background'] as const)
        verdict({ ...x, context: { ...x.context, surface } }, 'wrong_surface');
    verdict({ ...x, context: { ...x.context, userConversationActive: false } }, 'wrong_surface');
});
test('phase and service availability cannot be bypassed by an enabled flag or explicit interest', () => {
    for (const trigger of ['T4', 'T7', 'T8'] as const) {
        const x = input({ trigger });
        verdict({ ...x, settings: { ...x.settings, enabledTriggers: [trigger] } }, 'phase_disabled');
    }
    const x = input();
    verdict({ ...x, settings: { ...x.settings, enabledTriggers: [] } }, 'trigger_disabled');
    for (const serviceAvailable of [null, false])
        verdict({ ...x, settings: { ...x.settings, serviceAvailable } }, 'service_unavailable');
    verdict({ ...input({ trigger: 'T1', intent: 'human_service' }), serviceKind: 'referral_assessment' }, 'referral_information_only');
    verdict({ ...input({ trigger: 'T1', intent: 'fees' }), serviceKind: 'course_unit' }, 'phase_disabled');
    assert.equal(verdict({ ...input({ trigger: 'T1', intent: 'fees' }), serviceKind: 'manteng_package' }, null).presentation, 'information_only');
    verdict({ ...x, evidence: null }, 'evidence_unavailable');
    for (const evidenceSensitivity of ['sensitive', 'restricted'] as const)
        verdict({ ...x, evidenceSensitivity }, 'private_evidence');
});
test('explicit T1 intent is required; asking about a knowledge-bank item cannot be treated as asking for paid service', () => {
    verdict(input({ trigger: 'T1', intent: 'other' }), 'trigger_not_met');
    verdict(input({ trigger: 'T1', intent: 'human_service' }), null);
    verdict(input({ trigger: 'T1', intent: 'fees' }), null);
    const x = input();
    verdict({ ...x, settings: { ...x.settings, mode: 'only_when_asked' } }, 'only_when_asked');
    verdict({ ...input({ trigger: 'T1', intent: 'fees' }), settings: { ...x.settings, mode: 'only_when_asked' }, history: [history({ shownAt: at(-1), respondedAt: at(-1) })] }, null);
});
test('quiet hours and late night apply to requested service too, and absent time policy never assumes daytime', () => {
    for (const x of [input(), input({ trigger: 'T1', intent: 'fees' })]) {
        verdict({ ...x, context: { ...x.context, quietHours: true } }, 'quiet_hours');
        verdict({ ...x, context: { ...x.context, lateNight: true } }, 'late_night');
        verdict({ ...x, context: { ...x.context, quietHours: null } }, 'time_policy_unknown');
        verdict({ ...x, context: { ...x.context, lateNight: null } }, 'time_policy_unknown');
    }
});
test('rejection and crisis cooldowns use exact elapsed boundaries and also protect T1 requests', () => {
    for (const x of [input(), input({ trigger: 'T1', intent: 'fees' })]) {
        verdict({ ...x, context: { ...x.context, lastRejectionAt: at(-2 + 1 / DAY) } }, 'post_rejection');
        verdict({ ...x, context: { ...x.context, lastRejectionAt: at(-2) } }, null);
        verdict({ ...x, context: { ...x.context, lastCrisisAt: at(-14 + 1 / DAY) } }, 'post_crisis');
        verdict({ ...x, context: { ...x.context, lastCrisisAt: at(-14) } }, null);
    }
});
test('offer-day and not-today use the user local date instead of UTC; different local days are not conflated', () => {
    const x = { ...input(), now: '2026-10-09T01:00:00.000Z' };
    for (const key of ['latestOfferAt', 'declinedTodayAt'] as const) {
        verdict({ ...x, context: { ...x.context, [key]: '2026-10-08T10:00:00.000Z' } }, key === 'latestOfferAt' ? 'offer_day' : 'not_today');
        verdict({ ...x, context: { ...x.context, [key]: '2026-10-08T06:00:00.000Z' } }, null);
    }
    const east = { ...input(), timeZone: 'Asia/Shanghai', now: '2026-10-08T17:00:00.000Z', historyCompleteSince: at(-38) };
    verdict({ ...east, context: { ...east.context, latestOfferAt: '2026-10-08T16:30:00.000Z' } }, 'offer_day');
    verdict({ ...east, context: { ...east.context, latestOfferAt: '2026-10-08T15:30:00.000Z' } }, null);
});
test('all unsolicited triggers share one 14-day cap; recorded OPT or unemployment data widens it to 30 days', () => {
    const x = input();
    verdict({ ...x, history: [history({ shownAt: at(-14 + 1 / DAY), respondedAt: at(-14 + 1 / DAY) })] }, 'frequency_limit');
    verdict({ ...x, history: [history({ shownAt: at(-14), respondedAt: at(-14) })] }, null);
    const protectedInput = { ...x, settings: { ...x.settings, optOrUnemploymentRecorded: true } };
    verdict({ ...protectedInput, history: [history()] }, 'frequency_limit');
    verdict({ ...protectedInput, history: [history({ shownAt: at(-30), respondedAt: at(-30) })] }, null);
    verdict({ ...x, history: [history({ trigger: 'T1', shownAt: at(-1), respondedAt: at(-1) })] }, null);
});
test('same-service decline and explicit mute stop suggestions, while a real owner restoration releases earlier decisions', () => {
    const x = input(), h = history({ serviceKind: 'mock_interview', trigger: 'T1', shownAt: at(-31), response: 'declined', respondedAt: at(-1) });
    verdict({ ...x, history: [h] }, 'service_muted');
    verdict({ ...x, history: [{ ...h, serviceKind: 'resume_direction' }] }, null);
    verdict({ ...x, mutes: [{ serviceKind: 'mock_interview', mutedUntil: at(1), restoredAt: null }] }, 'service_muted');
    verdict({ ...x, mutes: [{ serviceKind: 'mock_interview', mutedUntil: NOW, restoredAt: null }] }, null);
    verdict({ ...x, history: [h], mutes: [{ serviceKind: 'mock_interview', mutedUntil: null, restoredAt: NOW }] }, null);
    verdict({ ...x, history: [h], mutes: [{ serviceKind: 'mock_interview', mutedUntil: null, restoredAt: at(-2) }] }, 'service_muted');
    verdict({ ...x, history: [{ ...h, respondedAt: at(-30) }] }, null);
});
test('seven days of no response starts one fixed 30-day mute even when the housekeeping worker has not run', () => {
    const x = input(), h = history({ serviceKind: 'mock_interview', trigger: 'T1', shownAt: at(-7), response: 'pending', respondedAt: null });
    verdict({ ...x, history: [h] }, 'service_muted');
    verdict({ ...x, history: [{ ...h, shownAt: at(-7 + 1 / DAY) }] }, null);
    verdict({ ...x, history: [{ ...h, shownAt: at(-37) }] }, null);
    verdict({ ...x, history: [{ ...h, shownAt: at(-37 + 1 / DAY) }] }, 'service_muted');
    verdict({ ...x, history: [{ ...h, shownAt: at(-37), response: 'no_response', respondedAt: NOW }] }, null);
});
test('T2 is final or onsite within 72 hours to seven days, no duplicate for that interview or existing same service', () => {
    for (const days of [3, 7])
        verdict(input({ trigger: 'T2', interviewStartsAt: at(days), interviewKind: 'onsite', sameServiceScheduled: false, interviewAlreadySuggested: false }), null);
    for (const days of [3 - 1 / DAY, 7 + 1 / DAY])
        verdict(input({ trigger: 'T2', interviewStartsAt: at(days), interviewKind: 'final', sameServiceScheduled: false, interviewAlreadySuggested: false }), 'trigger_not_met');
    const x = input(), e = x.evidence as Extract<PaidTriggerEvidence, {
        trigger: 'T2';
    }>;
    for (const patch of [{ sameServiceScheduled: true }, { interviewAlreadySuggested: true }, { interviewKind: 'other' as const }])
        verdict({ ...x, evidence: { ...e, ...patch } }, 'trigger_not_met');
    verdict({ ...x, serviceKind: 'resume_direction' }, 'trigger_not_met');
});
test('T3 requires a real offer older than 24 hours plus comparison intent, multiple offers or a live deadline within fourteen days', () => {
    const e: Extract<PaidTriggerEvidence, {
        trigger: 'T3';
    }> = { trigger: 'T3', offerMarkedAt: at(-2), offerCount: 1, comparingOrNegotiating: true, replyDeadlineAt: null };
    const x = { ...input(e), serviceKind: 'offer_negotiation' as const, context: { ...input().context, latestOfferAt: at(-2) } };
    verdict(x, null);
    verdict({ ...x, evidence: { ...e, offerMarkedAt: at(-1) }, context: { ...x.context, latestOfferAt: at(-1) } }, null);
    verdict({ ...x, evidence: { ...e, offerMarkedAt: at(-1 + 1 / DAY) }, context: { ...x.context, latestOfferAt: at(-1 + 1 / DAY) } }, 'trigger_not_met');
    verdict({ ...x, evidence: { ...e, comparingOrNegotiating: false } }, 'trigger_not_met');
    verdict({ ...x, evidence: { ...e, comparingOrNegotiating: false, offerCount: 2 } }, null);
    verdict({ ...x, evidence: { ...e, comparingOrNegotiating: false, replyDeadlineAt: at(14) } }, null);
    for (const deadline of [at(14 + 1 / DAY), at(-1 / DAY)])
        verdict({ ...x, evidence: { ...e, comparingOrNegotiating: false, replyDeadlineAt: deadline } }, 'trigger_not_met');
    verdict({ ...x, evidence: { ...e, offerCount: 0 } }, 'trigger_not_met');
    assert.throws(() => canSuggestPaid({ ...x, context: { ...x.context, latestOfferAt: null } }), PaidSuggestionInputError);
});
test('T5 respects registration age, application volume, applied guide revision, strict half-median and calibrated low-sample fallback', () => {
    const e: Extract<PaidTriggerEvidence, {
        trigger: 'T5';
    }> = { trigger: 'T5', submitted30d: 60, invitedApplications30d: 2, submittedAfterRevision: 20, guideRevisionApplied: true, cohortSize: 10, cohortMedianRate: 0.1, calibratedRate: null, calibrationRef: null };
    const x = { ...input(e), serviceKind: 'resume_direction' as const };
    verdict(x, null);
    verdict({ ...x, registeredAt: at(-30) }, null);
    verdict({ ...x, registeredAt: at(-30 + 1 / DAY) }, 'trigger_not_met');
    for (const patch of [{ submitted30d: 59 }, { submittedAfterRevision: 19 }, { guideRevisionApplied: false }, { invitedApplications30d: 3 }])
        verdict({ ...x, evidence: { ...e, ...patch } }, 'trigger_not_met');
    verdict({ ...x, evidence: { ...e, cohortSize: 9 } }, 'calibration_missing');
    verdict({ ...x, evidence: { ...e, cohortSize: 9, cohortMedianRate: 1, calibratedRate: 0.05, calibrationRef: randomUUID() } }, 'trigger_not_met');
    verdict({ ...x, evidence: { ...e, cohortSize: 9, cohortMedianRate: null, calibratedRate: 0.1, calibrationRef: randomUUID() } }, null);
    verdict({ ...x, evidence: { ...e, cohortMedianRate: null, calibratedRate: 1, calibrationRef: randomUUID() } }, 'calibration_missing');
    assert.throws(() => canSuggestPaid({ ...x, evidence: { ...e, calibratedRate: 0.1 } }), PaidSuggestionInputError);
    assert.throws(() => canSuggestPaid({ ...x, evidence: { ...e, invitedApplications30d: 61 } }), PaidSuggestionInputError);
});
test('T6 counts same-family explicit not-advanced outcomes, with at least three in the supplied sixty-day source', () => {
    verdict(input({ trigger: 'T6', sameRoleNotAdvanced60d: 2 }), 'trigger_not_met');
    verdict(input({ trigger: 'T6', sameRoleNotAdvanced60d: 3 }), null);
    verdict({ ...input({ trigger: 'T6', sameRoleNotAdvanced60d: 3 }), serviceKind: 'offer_negotiation' }, 'trigger_not_met');
});
function feedbackRows(n: number, flags: number): PaidSuggestionHistory[] { return Array.from({ length: n }, (_, i) => history({ trigger: 'T2', shownAt: at(-5), respondedAt: at(-5), feelsSalesy: i < flags, feedbackAt: i < flags ? at(-4) : null })); }
test('salesy feedback uses exact >3 and >6 percent thresholds; small samples request review without manufacturing a pause', () => {
    const x = input(), small = canSuggestPaid({ ...x, history: feedbackRows(29, 2) });
    assert.equal(small.reason, 'frequency_limit');
    assert.equal(small.needsCopyReview, true);
    assert.equal(small.frequencyDays, 14);
    const three = canSuggestPaid({ ...x, history: feedbackRows(100, 3) });
    assert.equal(three.frequencyDays, 14);
    assert.equal(three.reason, 'frequency_limit');
    const six = canSuggestPaid({ ...x, history: feedbackRows(100, 6) });
    assert.equal(six.frequencyDays, 30);
    assert.equal(six.reason, 'frequency_limit');
    const above = canSuggestPaid({ ...x, history: feedbackRows(100, 7) });
    assert.equal(above.reason, 'feedback_paused');
    assert.equal(above.frequencyDays, 30);
    verdict({ ...x, history: feedbackRows(30, 2) }, 'feedback_paused');
});
test('feedback review covers actual feedback time, so later feedback on an old shown card is not silently excused', () => {
    const x = input(), rows = feedbackRows(30, 2);
    const reviewed = canSuggestPaid({ ...x, history: rows, feedbackReviewedThrough: at(-4) });
    assert.equal(reviewed.reason, 'frequency_limit');
    assert.equal(reviewed.needsCopyReview, false);
    assert.equal(reviewed.frequencyDays, 30);
    verdict({ ...x, history: rows, feedbackReviewedThrough: at(-4 - 1 / DAY) }, 'feedback_paused');
    const newer = rows.map((h, i) => i === 0 ? { ...h, feedbackAt: at(-1) } : h);
    verdict({ ...x, history: newer, feedbackReviewedThrough: at(-3) }, 'feedback_paused');
    const old = rows.map(h => ({ ...h, shownAt: at(-14), respondedAt: at(-14) }));
    const lateFeedback = canSuggestPaid({ ...x, history: old });
    assert.equal(lateFeedback.frequencyDays, 14);
    assert.equal(lateFeedback.needsCopyReview, true);
    assert.equal(lateFeedback.reason, null);
});
test('incomplete histories, cross-owner rows, duplicate events and forged time cannot produce eligibility', () => {
    const x = input();
    const h = history();
    for (const change of [{ historyCompleteSince: at(-36) }, { registeredAt: at(1) }, { history: [{ ...h, ownerId: randomUUID() }] }, { history: [h, h] }, { history: [{ ...h, shownAt: at(1) }] }, { feedbackReviewedThrough: at(1) }, { context: { ...x.context, lastCrisisAt: at(1) } }, { history: [{ ...h, feelsSalesy: true, feedbackAt: null }] }, { history: [{ ...h, response: 'no_response', respondedAt: at(-14) }] }, { timeZone: 'Fictional/Unknown' }])
        assert.throws(() => canSuggestPaid({ ...x, ...change }), PaidSuggestionInputError);
    const recent = { ...x, registeredAt: at(-3), historyCompleteSince: at(-3) };
    verdict(recent, null);
});
test('closed inputs reject accessors, hidden properties, sparse lists, prototype fields and extra evidence without reading getters', () => {
    const x = input();
    let called = false;
    const hostile = { ...x, get evidence() { called = true; return x.evidence; } };
    assert.throws(() => canSuggestPaid(hostile), PaidSuggestionInputError);
    assert.equal(called, false);
    const hidden = { ...x };
    Object.defineProperty(hidden, 'bypass', { value: true });
    for (const v of [hidden, { ...x, history: new Array(1) }, { ...x, settings: { ...x.settings, enabledTriggers: ['T2', 'T2'] } }, { ...x, evidence: { ...x.evidence, price: 149 } }, Object.assign(Object.create({ approved: true }), x)])
        assert.throws(() => canSuggestPaid(v), PaidSuggestionInputError);
    const a: any = [history()];
    Object.defineProperty(a, 0, { get() { called = true; return history(); } });
    assert.throws(() => canSuggestPaid({ ...x, history: a }), PaidSuggestionInputError);
    assert.equal(called, false);
    assert(!JSON.stringify(canSuggestPaid(x)).includes(owner));
});
test('fall DST keeps an offer-day exclusion across a 25-hour local day without stretching elapsed cooldowns', () => {
    const x = input({ trigger: 'T1', intent: 'fees' }), now = '2026-11-02T07:30:00.000Z';
    const snapshot = { ...x, now, historyCompleteSince: '2026-09-01T00:00:00.000Z' };
    verdict({ ...snapshot, context: { ...x.context, latestOfferAt: '2026-11-01T07:00:00.000Z' } }, 'offer_day');
    verdict({ ...snapshot, context: { ...x.context, latestOfferAt: '2026-11-01T06:59:59.999Z' } }, null);
});
