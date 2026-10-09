import { careerRecordId as id, careerRecordObject as object, CareerRecordInputError } from './career-record-values.ts';
import { dailyDate } from './daily-plans.ts';
export interface TodayAgendaEvent {
  readonly kind: 'interview' | 'job_deadline'; readonly id: string;
  readonly title: string; readonly employer: string; readonly at: string;
  readonly endsAt: string | null; readonly timeZone: string;
}
export interface TodayAgenda {
  readonly ownerId: string; readonly companionId: string; readonly capturedAt: string;
  readonly localDate: string; readonly timeZone: string; readonly resting: boolean;
  readonly events: readonly Readonly<TodayAgendaEvent>[];
  readonly pending: Readonly<{ scope: 'resume_reviews'; count: number; earliestExpiresAt: string | null }> | null;
}
const fail = (): never => { throw new CareerRecordInputError(); };
function instant(v: unknown): string { if (typeof v !== 'string' || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) return fail(); return v; }
function zone(v: unknown): string { if (typeof v !== 'string' || !v || v.length > 100 || /^[+-]/.test(v)) return fail(); try { new Intl.DateTimeFormat('en-US', { timeZone: v }).format(0); } catch { return fail(); } return v; }
function label(v: unknown): string { if (typeof v !== 'string' || !v.trim() || v.length > 1000) return fail(); return v; }
export function agendaLocalDate(at: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at));
  return dailyDate(['year', 'month', 'day'].map(k => parts.find(p => p.type === k)!.value).join('-'));
}
export function parseTodayAgenda(value: unknown): Readonly<TodayAgenda> {
  const v = object(value, ['ownerId', 'companionId', 'capturedAt', 'localDate', 'timeZone', 'resting', 'events', 'pending']);
  const ownerId = id(v.ownerId), companionId = id(v.companionId), capturedAt = instant(v.capturedAt), timeZone = zone(v.timeZone), localDate = dailyDate(v.localDate);
  if (typeof v.resting !== 'boolean' || agendaLocalDate(capturedAt, timeZone) !== localDate
    || !Array.isArray(v.events) || Object.getPrototypeOf(v.events) !== Array.prototype || v.events.length > 1000) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(v.events), events: Readonly<TodayAgendaEvent>[] = [];
  if (Reflect.ownKeys(descriptors).length !== v.events.length + 1) return fail();
  for (let i = 0; i < v.events.length; i++) {
    if (!descriptors[i] || !('value' in descriptors[i]) || !descriptors[i].enumerable) return fail();
    const e = object(descriptors[i].value, ['kind', 'id', 'title', 'employer', 'at', 'endsAt', 'timeZone']);
    if (!['interview', 'job_deadline'].includes(e.kind as string)) return fail();
    const at = instant(e.at), endsAt = e.endsAt === null ? null : instant(e.endsAt);
    if (e.kind === 'job_deadline' ? endsAt !== null || agendaLocalDate(at, timeZone) !== localDate
      : endsAt === null || endsAt <= at || agendaLocalDate(at, timeZone) > localDate || agendaLocalDate(new Date(Date.parse(endsAt) - 1).toISOString(), timeZone) < localDate) return fail();
    events.push(Object.freeze({ kind: e.kind as TodayAgendaEvent['kind'], id: id(e.id), title: label(e.title), employer: label(e.employer), at, endsAt, timeZone: zone(e.timeZone) }));
  }
  if (new Set(events.map(e => e.kind + ':' + e.id)).size !== events.length) return fail();
  let pending: TodayAgenda['pending'] = null;
  if (v.pending !== null) {
    const p = object(v.pending, ['scope', 'count', 'earliestExpiresAt']);
    if (p.scope !== 'resume_reviews' || !Number.isSafeInteger(p.count) || (p.count as number) < 0 || (p.count as number) > 500 || Object.is(p.count, -0)) return fail();
    const earliestExpiresAt = p.earliestExpiresAt === null ? null : instant(p.earliestExpiresAt);
    if ((p.count === 0) !== (earliestExpiresAt === null) || earliestExpiresAt !== null && earliestExpiresAt <= capturedAt) return fail();
    pending = Object.freeze({ scope: 'resume_reviews', count: p.count as number, earliestExpiresAt });
  }
  if (v.resting !== (pending === null)) return fail();
  return Object.freeze({ ownerId, companionId, capturedAt, localDate, timeZone, resting: v.resting, events: Object.freeze(events), pending });
}
