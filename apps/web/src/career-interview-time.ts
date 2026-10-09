import { resolveZonedTime, type ZonedTimeResolution, type ZonedTimeCandidate } from './zoned-date-time.ts';
export { zonedLocalInput as interviewLocalInput, displayZonedTime as displayInterviewTime, deviceTimeZone as deviceInterviewTimeZone } from './zoned-date-time.ts';
export interface InterviewTimeCandidate extends Omit<ZonedTimeCandidate, 'instant'> { readonly startsAt: string; }
export type InterviewTimeResolution =
  | { readonly kind: 'invalid' | 'gap'; readonly message: string; readonly candidates: readonly [] }
  | { readonly kind: 'valid' | 'ambiguous'; readonly message: string; readonly candidates: readonly InterviewTimeCandidate[] };
/** Preserve the interview contract while sharing explicit wall-time conversion. */
export function resolveInterviewTime(local: string, timeZone: string): InterviewTimeResolution {
  const result: ZonedTimeResolution = resolveZonedTime(local, timeZone);
  if (result.kind === 'invalid' || result.kind === 'gap') return result;
  return Object.freeze({ ...result,
    message: result.kind === 'ambiguous' ? '这个时间出现了两次。请根据面试邀请中的 UTC 偏移量，选择对应的一次。' : result.message,
    candidates: Object.freeze(result.candidates.map(({ instant, ...value }) => Object.freeze({ ...value, startsAt: instant }))),
  });
}
