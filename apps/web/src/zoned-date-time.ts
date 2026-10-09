import { DateTime } from 'luxon';
import { careerInterviewTimeZone } from '@companion/platform-contracts';

export interface ZonedTimeCandidate {
  readonly instant: string;
  readonly timeZone: string;
  readonly label: string;
}
export type ZonedTimeResolution =
  | { readonly kind: 'invalid'; readonly message: string; readonly candidates: readonly [] }
  | { readonly kind: 'gap'; readonly message: string; readonly candidates: readonly [] }
  | { readonly kind: 'valid' | 'ambiguous'; readonly message: string; readonly candidates: readonly ZonedTimeCandidate[] };
const invalid = (message: string): ZonedTimeResolution => Object.freeze({ kind: 'invalid', message, candidates: Object.freeze([] as const) });
function components(dt: DateTime) { return [dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second, dt.millisecond]; }
function same(a: DateTime, b: DateTime) { return components(a).every((v, i) => v === components(b)[i]); }
function iso(dt: DateTime) {
  const value = dt.toUTC().toISO({ suppressMilliseconds: false });
  if (!value || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value) || value.startsWith('0000-')) throw Error('Invalid instant');
  return value;
}
function dateLabel(dt: DateTime, zone: string) {
  const format = dt.millisecond ? 'yyyy-MM-dd HH:mm:ss.SSS' : dt.second ? 'yyyy-MM-dd HH:mm:ss' : 'yyyy-MM-dd HH:mm';
  return dt.toFormat(format) + ' · ' + zone + ' · UTC' + dt.toFormat('ZZ');
}
/** Explicit wall time only. Gaps are rejected; overlaps require an owner choice. */
export function resolveZonedTime(local: string, timeZone: string): ZonedTimeResolution {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]{1,3})?)?$/.test(local) || local.startsWith('0000-')) return invalid('请填写完整的日期和时间。');
  let zone: string;
  try { zone = careerInterviewTimeZone(timeZone); } catch { return invalid('请明确填写有效的时区，例如 America/New_York。'); }
  const wall = DateTime.fromISO(local, { zone: 'UTC', locale: 'en', numberingSystem: 'latn' });
  if (!wall.isValid || wall.year < 1 || wall.year > 9999 || wall.hour === 0 && local.slice(11, 13) === '24') return invalid('这不是有效的日期和时间，请重新核对。');
  const dt = DateTime.fromObject({
    year: wall.year, month: wall.month, day: wall.day, hour: wall.hour,
    minute: wall.minute, second: wall.second, millisecond: wall.millisecond,
  }, { zone, locale: 'en', numberingSystem: 'latn' });
  if (!dt.isValid) return invalid('这个时区暂时无法读取，请核对。');
  if (!same(dt, wall)) return Object.freeze({ kind: 'gap', message: '这个时区在切换时间时跳过了这一时刻。请选择另一个时间；不会自动顺延。', candidates: Object.freeze([] as const) });
  try {
    const values = dt.getPossibleOffsets().filter(value => value.isValid && same(value, wall));
    const unique = [...new Map(values.map(value => [iso(value), value])).values()].sort((a, b) => a.toMillis() - b.toMillis());
    if (!unique.length) return invalid('这个时间暂时无法确认。');
    const candidates = Object.freeze(unique.map(value => Object.freeze({ instant: iso(value), timeZone: zone, label: dateLabel(value, zone) })));
    return Object.freeze({ kind: candidates.length === 1 ? 'valid' : 'ambiguous',
      message: candidates.length === 1 ? '' : '这个时间出现了两次。请根据原文中的 UTC 偏移量，选择对应的一次。', candidates });
  } catch { return invalid('这个时间无法保存，请重新核对。'); }
}
export function zonedLocalInput(instant: string, timeZone: string): string {
  const zone = careerInterviewTimeZone(timeZone);
  const dt = DateTime.fromISO(instant, { zone: 'UTC', locale: 'en', numberingSystem: 'latn' }).setZone(zone);
  if (!dt.isValid) throw Error('Invalid saved time');
  return dt.toFormat("yyyy-MM-dd'T'HH:mm:ss.SSS");
}
export function displayZonedTime(instant: string, timeZone: string): string {
  try {
    const zone = careerInterviewTimeZone(timeZone);
    const dt = DateTime.fromISO(instant, { zone: 'UTC', locale: 'en', numberingSystem: 'latn' }).setZone(zone);
    return dt.isValid ? dateLabel(dt, zone) : '时间暂时无法显示';
  } catch { return '请填写有效的显示时区'; }
}
export function deviceTimeZone(): string {
  try { return careerInterviewTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone); } catch { return ''; }
}
