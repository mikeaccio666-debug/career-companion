import { careerRecordObject as object, careerRecordId as id, CareerRecordInputError } from './career-record-values.ts';
export const DAILY_PREFERENCE_DEFAULTS = Object.freeze({ morningTime: '09:00', quietStart: '22:30', quietEnd: '08:30', dailyMinutes: 90, webAlert: 'none' as const });
export interface DailyPreferences { readonly timeZone: string; readonly morningTime: string; readonly quietStart: string; readonly quietEnd: string; readonly dailyMinutes: number; readonly webAlert: 'none' | 'email'; }
export interface CompanionDailySettings { readonly ownerId: string; readonly companionId: string; readonly preferences: Readonly<DailyPreferences> | null; readonly revision: number; readonly updatedAt: string | null; readonly lastOperationId: string | null; }
export interface CompanionDailySettingsCommand { readonly companionId: string; readonly operationId: string; readonly expectedRevision: number; readonly preferences: Readonly<DailyPreferences>; }
export interface CompanionDailySettingsResult { readonly settings: Readonly<CompanionDailySettings>; readonly operation: { readonly id: string; readonly appliedRevision: number; readonly preferences: Readonly<DailyPreferences>; readonly replayed: boolean }; }
const fail = (): never => { throw new CareerRecordInputError(); };
function revision(v: unknown, max = 2147483647): number { if (typeof v !== 'number' || !Number.isSafeInteger(v) || Object.is(v, -0) || v < 0 || v > max) return fail(); return v; }
function time(v: unknown): string { if (typeof v !== 'string' || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(v)) return fail(); return v; }
export function parseDailyPreferences(value: unknown): Readonly<DailyPreferences> {
  const v = object(value, ['timeZone', 'morningTime', 'quietStart', 'quietEnd', 'dailyMinutes', 'webAlert']);
  if (typeof v.timeZone !== 'string' || v.timeZone.length > 100 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)*$/.test(v.timeZone)) return fail();
  try { new Intl.DateTimeFormat('en-US', { timeZone: v.timeZone }).format(0); } catch { return fail(); }
  const quietStart = time(v.quietStart), quietEnd = time(v.quietEnd), dailyMinutes = revision(v.dailyMinutes, 1440);
  if (quietStart === quietEnd || v.webAlert !== 'none' && v.webAlert !== 'email') return fail();
  return Object.freeze({ timeZone: v.timeZone, morningTime: time(v.morningTime), quietStart, quietEnd, dailyMinutes, webAlert: v.webAlert });
}
export function parseCompanionDailySettings(value: unknown): Readonly<CompanionDailySettings> {
  const v = object(value, ['ownerId', 'companionId', 'preferences', 'revision', 'updatedAt', 'lastOperationId']), rev = revision(v.revision);
  if (rev === 0) { if (v.preferences !== null || v.updatedAt !== null || v.lastOperationId !== null) return fail(); }
  else if (typeof v.updatedAt !== 'string' || !Number.isFinite(Date.parse(v.updatedAt)) || new Date(v.updatedAt).toISOString() !== v.updatedAt) return fail();
  return Object.freeze({ ownerId: id(v.ownerId), companionId: id(v.companionId), preferences: rev ? parseDailyPreferences(v.preferences) : null, revision: rev, updatedAt: rev ? v.updatedAt as string : null, lastOperationId: rev ? id(v.lastOperationId) : null });
}
export function parseCompanionDailySettingsCommand(value: unknown): Readonly<CompanionDailySettingsCommand> {
  const v = object(value, ['companionId', 'operationId', 'expectedRevision', 'preferences']);
  return Object.freeze({ companionId: id(v.companionId), operationId: id(v.operationId), expectedRevision: revision(v.expectedRevision, 2147483646), preferences: parseDailyPreferences(v.preferences) });
}
