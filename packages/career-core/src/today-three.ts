import { careerRecordObject as object, careerRecordId as id, EXPERT_KEYS, type ExpertKey } from '@companion/platform-contracts';
import { P0_EXPERT_KEYS } from './team/members.ts';

export const TODAY_STAGES = Object.freeze(['first_meeting', 'direction', 'polish', 'apply', 'interview', 'offer', 'settle'] as const);
export type TodayStage = typeof TODAY_STAGES[number];
export type TodayAction = Readonly<{ kind: 'pending'; id: string } | { kind: 'interview'; id: string | null } | { kind: 'expert'; expert: ExpertKey }>;
/** References to server-checked actions only; no raw resume, memory or model text.
 * Eligibility is a source snapshot, never an authorization or execution grant. */
export interface TodayCandidate {
  readonly id: string; readonly ownerId: string; readonly expert: ExpertKey;
  readonly minutes: number; readonly stages: readonly TodayStage[]; readonly action: TodayAction;
  readonly state: 'ready' | 'completed' | 'unavailable';
  readonly access: 'free' | 'included' | 'paid' | 'unknown';
  readonly sensitivity: 'normal' | 'sensitive' | 'restricted'; readonly effort: 'light' | 'standard';
  readonly deadlineAt: string | null; readonly interviewId: string | null;
}
export interface TodayInterview { readonly id: string; readonly ownerId: string; readonly startsAt: string; }
export interface TodayHistory {
  readonly candidateId: string; readonly ownerId: string; readonly localDate: string;
  readonly outcome: 'unfinished' | 'done' | 'dropped';
}
export interface TodayThreeInput {
  readonly ownerId: string; readonly now: string; readonly timeZone: string;
  /** Ordered, server-derived active stages. Stages can overlap; no progression is inferred here. */
  readonly activeStages: readonly TodayStage[]; readonly enabledExperts: readonly ExpertKey[];
  readonly dailyMinutes?: number; readonly fifteenMinuteSteps: boolean;
  readonly requestKind: 'scheduled' | 'user_requested';
  readonly optedOutDate: string | null; readonly pauseUntil: string | null;
  readonly overlays: readonly { readonly kind: 'post_rejection' | 'post_crisis' | 'low_mood' | 'sprint'; readonly until: string }[];
  readonly candidates: readonly TodayCandidate[]; readonly interviews: readonly TodayInterview[];
  /** Complete two preceding local calendar days, including explicit empty days.
   * The source reader must validate coverage before calling this function. */
  readonly historyDates: readonly [string, string]; readonly history: readonly TodayHistory[];
}
export type TodaySkipReason = 'unavailable' | 'completed' | 'dropped' | 'paid_or_unknown' | 'private_source'
  | 'expert_disabled' | 'past_deadline' | 'interview_unavailable' | 'interview_today_only' | 'stage_mismatch'
  | 'smaller_step_needed' | 'rest_day_in_pool' | 'light_only' | 'daily_budget' | 'expert_limit' | 'item_limit' | 'duplicate_action';
export interface TodaySelected {
  readonly candidateId: string; readonly expert: ExpertKey; readonly minutes: number; readonly action: TodayAction;
  readonly rule: 'deadline_48h' | 'interview_72h' | 'carry_once' | 'stage';
}
export interface TodayThreePlan {
  readonly policyRevision: 1; readonly localDate: string; readonly budgetMinutes: number; readonly totalMinutes: number;
  readonly suppressed: 'opted_out' | 'paused' | 'post_rejection' | 'post_crisis' | null;
  readonly items: readonly TodaySelected[];
  /** Internal diagnostics, not messages or task labels for the student. */
  readonly skipped: readonly { readonly candidateId: string; readonly reason: TodaySkipReason }[];
}
export class TodayThreeInputError extends Error { constructor() { super('The daily planning sources could not be confirmed.'); } }
const fail = (): never => { throw new TodayThreeInputError(); };
const DAY = 86_400_000, HOUR = 3_600_000;
function choice<T extends string>(v: unknown, values: readonly T[]): T { if (typeof v !== 'string' || !values.includes(v as T)) return fail(); return v as T; }
function bool(v: unknown): boolean { if (typeof v !== 'boolean') return fail(); return v; }
function integer(v: unknown, min: number, max: number): number { if (typeof v !== 'number' || !Number.isSafeInteger(v) || Object.is(v, -0) || v < min || v > max) return fail(); return v; }
function instant(v: unknown): string { if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) return fail(); return v; }
function date(v: unknown): string { if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(v) || !Number.isFinite(Date.parse(v + 'T00:00:00.000Z')) || new Date(v + 'T00:00:00.000Z').toISOString().slice(0, 10) !== v) return fail(); return v; }
const nullableInstant = (v: unknown) => v === null ? null : instant(v);
function array<T>(v: unknown, max: number, parse: (x: unknown) => T): T[] {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype || v.length > max) return fail();
  const ds = Object.getOwnPropertyDescriptors(v);
  if (Reflect.ownKeys(ds).length !== v.length + 1) return fail();
  const out: T[] = [];
  for (let i = 0; i < v.length; i++) { if (!ds[i] || !('value' in ds[i]) || !ds[i].enumerable) return fail(); out.push(parse(ds[i].value)); }
  return out;
}
function unique<T>(values: T[]): T[] { if (new Set(values).size !== values.length) return fail(); return values; }
function action(value: unknown): TodayAction {
  const v = object(value, ['kind'], ['id', 'expert']);
  if (v.kind === 'expert') { object(value, ['kind', 'expert']); return Object.freeze({ kind: 'expert', expert: choice(v.expert, EXPERT_KEYS) }); }
  object(value, ['kind', 'id']);
  if (v.kind === 'pending') return Object.freeze({ kind: 'pending', id: id(v.id) });
  if (v.kind === 'interview') return Object.freeze({ kind: 'interview', id: v.id === null ? null : id(v.id) });
  return fail();
}
function localDate(at: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at));
  return date(['year', 'month', 'day'].map(kind => parts.find(p => p.type === kind)?.value).join('-'));
}
function parse(input: unknown) {
  const v = object(input, ['ownerId', 'now', 'timeZone', 'activeStages', 'enabledExperts', 'fifteenMinuteSteps', 'requestKind', 'optedOutDate', 'pauseUntil', 'overlays', 'candidates', 'interviews', 'historyDates', 'history'], ['dailyMinutes']);
  const ownerId = id(v.ownerId), now = instant(v.now);
  if (typeof v.timeZone !== 'string' || v.timeZone.length > 100 || v.timeZone.startsWith('+') || v.timeZone.startsWith('-')) return fail();
  const today = localDate(now, v.timeZone), previous = [1, 2].map(n => new Date(Date.parse(today + 'T00:00:00.000Z') - n * DAY).toISOString().slice(0, 10));
  const historyDates = unique(array(v.historyDates, 2, date));
  if (historyDates.length !== 2 || previous.some(d => !historyDates.includes(d))) return fail();
  const activeStages = unique(array(v.activeStages, TODAY_STAGES.length, x => choice(x, TODAY_STAGES)));
  const enabledExperts = unique(array(v.enabledExperts, EXPERT_KEYS.length, x => choice(x, EXPERT_KEYS)));
  // P0 availability cannot be widened by the supplied runtime roster.
  const enabled = new Set(enabledExperts.filter(key => P0_EXPERT_KEYS.includes(key)));
  const overlays = array(v.overlays, 4, x => { const row = object(x, ['kind', 'until']); return { kind: choice(row.kind, ['post_rejection', 'post_crisis', 'low_mood', 'sprint'] as const), until: instant(row.until) }; });
  unique(overlays.map(o => o.kind));
  const interviews = array(v.interviews, 1000, x => { const row = object(x, ['id', 'ownerId', 'startsAt']); if (id(row.ownerId) !== ownerId) return fail(); return { id: id(row.id), ownerId, startsAt: instant(row.startsAt) }; });
  unique(interviews.map(i => i.id));
  const history = array(v.history, 2000, x => {
    const row = object(x, ['candidateId', 'ownerId', 'localDate', 'outcome']);
    if (id(row.ownerId) !== ownerId || !historyDates.includes(date(row.localDate))) return fail();
    return { candidateId: id(row.candidateId), localDate: date(row.localDate), outcome: choice(row.outcome, ['unfinished', 'done', 'dropped'] as const) };
  });
  unique(history.map(h => h.localDate + ':' + h.candidateId));
  const candidates = array(v.candidates, 1000, x => {
    const row = object(x, ['id', 'ownerId', 'expert', 'minutes', 'stages', 'action', 'state', 'access', 'sensitivity', 'effort', 'deadlineAt', 'interviewId']);
    if (id(row.ownerId) !== ownerId) return fail();
    const expert = choice(row.expert, EXPERT_KEYS), target = action(row.action);
    if (target.kind === 'expert' && target.expert !== expert || target.kind === 'interview' && expert !== 'interviewer') return fail();
    return { id: id(row.id), expert, minutes: integer(row.minutes, 1, 1440), stages: unique(array(row.stages, TODAY_STAGES.length, x => choice(x, TODAY_STAGES))), action: target,
      state: choice(row.state, ['ready', 'completed', 'unavailable'] as const), access: choice(row.access, ['free', 'included', 'paid', 'unknown'] as const),
      sensitivity: choice(row.sensitivity, ['normal', 'sensitive', 'restricted'] as const), effort: choice(row.effort, ['light', 'standard'] as const),
      deadlineAt: nullableInstant(row.deadlineAt), interviewId: row.interviewId === null ? null : id(row.interviewId) };
  });
  unique(candidates.map(c => c.id));
  return { now, today, timeZone: v.timeZone, previous, activeStages, enabled, overlays, interviews, history, candidates,
    budget: v.dailyMinutes === undefined ? 90 : integer(v.dailyMinutes, 0, 1440), shortSteps: bool(v.fifteenMinuteSteps),
    requested: choice(v.requestKind, ['scheduled', 'user_requested'] as const) === 'user_requested',
    optedOutDate: v.optedOutDate === null ? null : date(v.optedOutDate), pauseUntil: nullableInstant(v.pauseUntil) };
}

/** Deterministic choice, not a saved plan, delivered brief, permission or receipt.
 * No ambient clock, I/O, model call, title rewriting, duration shrinking or random fill. */
export function pickTodayThree(input: TodayThreeInput): Readonly<TodayThreePlan> {
  let v: ReturnType<typeof parse>;
  try { v = parse(input); } catch { return fail(); }
  const now = Date.parse(v.now), active = (kind: string) => v.overlays.some(o => o.kind === kind && Date.parse(o.until) > now);
  const suppressed = v.optedOutDate === v.today ? 'opted_out' : v.pauseUntil && Date.parse(v.pauseUntil) > now ? 'paused'
    : !v.requested && active('post_crisis') ? 'post_crisis' : !v.requested && active('post_rejection') ? 'post_rejection' : null;
  const items: TodaySelected[] = [], skipped: { candidateId: string; reason: TodaySkipReason }[] = [];
  const finish = (): Readonly<TodayThreePlan> => Object.freeze({ policyRevision: 1, localDate: v.today, budgetMinutes: v.budget,
    totalMinutes: items.reduce((sum, item) => sum + item.minutes, 0), suppressed,
    items: Object.freeze(items.map(item => Object.freeze(item))), skipped: Object.freeze(skipped.map(item => Object.freeze(item))) });
  if (suppressed) return finish();
  const interviews = new Map(v.interviews.map(i => [i.id, i]));
  const interviewsToday = new Set(v.interviews.filter(i => Date.parse(i.startsAt) > now && localDate(i.startsAt, v.timeZone) === v.today).map(i => i.id));
  const eligible: { candidate: typeof v.candidates[number]; rule: TodaySelected['rule']; urgent: number; at: number; stage: number; carry: number }[] = [];
  const skip = (candidateId: string, reason: TodaySkipReason) => skipped.push({ candidateId, reason });
  for (const c of [...v.candidates].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const history = v.history.filter(h => h.candidateId === c.id), yesterday = history.find(h => h.localDate === v.previous[0]);
    const interview = c.interviewId ? interviews.get(c.interviewId) : null;
    let reason: TodaySkipReason | null = c.state === 'completed' || history.some(h => h.outcome === 'done') ? 'completed'
      : c.state !== 'ready' ? 'unavailable' : history.some(h => h.outcome === 'dropped') ? 'dropped'
      : !['free', 'included'].includes(c.access) ? 'paid_or_unknown' : c.sensitivity !== 'normal' ? 'private_source'
      : !v.enabled.has(c.expert) ? 'expert_disabled' : c.deadlineAt && Date.parse(c.deadlineAt) <= now ? 'past_deadline'
      : c.interviewId && (!interview || Date.parse(interview.startsAt) <= now) ? 'interview_unavailable'
      : interviewsToday.size && (!c.interviewId || !interviewsToday.has(c.interviewId)) ? 'interview_today_only'
      : v.shortSteps && c.minutes > 15 ? 'smaller_step_needed'
      : history.length === 2 && history.every(h => h.outcome === 'unfinished') ? 'rest_day_in_pool'
      : active('post_rejection') && c.effort !== 'light' ? 'light_only' : null;
    const deadline = c.deadlineAt ? Date.parse(c.deadlineAt) : Infinity, interviewAt = interview ? Date.parse(interview.startsAt) : Infinity;
    const urgentAt = Math.min(deadline <= now + 48 * HOUR ? deadline : Infinity, interviewAt <= now + 72 * HOUR ? interviewAt : Infinity);
    const stage = v.activeStages.findIndex(stage => c.stages.includes(stage));
    if (!reason && !Number.isFinite(urgentAt) && stage < 0) reason = 'stage_mismatch';
    if (reason) { skip(c.id, reason); continue; }
    const carry = yesterday?.outcome === 'unfinished';
    eligible.push({ candidate: c, urgent: Number.isFinite(urgentAt) ? 0 : 1, at: urgentAt, stage: stage < 0 ? Infinity : stage, carry: carry ? 0 : 1,
      rule: Number.isFinite(urgentAt) ? urgentAt === deadline ? 'deadline_48h' : 'interview_72h' : carry ? 'carry_once' : 'stage' });
  }
  eligible.sort((a, b) => a.urgent - b.urgent || a.at - b.at || a.stage - b.stage || a.carry - b.carry || (a.candidate.id < b.candidate.id ? -1 : 1));
  const expertCounts = new Map<ExpertKey, number>(), usedActions = new Set<string>();
  let remaining = v.budget;
  for (const { candidate: c, rule } of eligible) {
    const actionKey = c.action.kind === 'pending' || c.action.kind === 'interview' && c.action.id ? c.action.kind + ':' + c.action.id : null;
    const reason = actionKey && usedActions.has(actionKey) ? 'duplicate_action' : items.length >= (active('post_rejection') ? 1 : 3) ? 'item_limit'
      : (expertCounts.get(c.expert) ?? 0) >= 2 ? 'expert_limit' : c.minutes > remaining ? 'daily_budget' : null;
    if (reason) { skip(c.id, reason); continue; }
    items.push({ candidateId: c.id, expert: c.expert, minutes: c.minutes, action: c.action, rule });
    remaining -= c.minutes; expertCounts.set(c.expert, (expertCounts.get(c.expert) ?? 0) + 1); if (actionKey) usedActions.add(actionKey);
  }
  return finish();
}
