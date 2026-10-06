import { parseUuid, type DecimalString, type Uuid } from './common.ts';
import { closedRecord } from './profileSnapshotValidation.ts';

export const ROLE_WORK_MODES = ['REMOTE', 'HYBRID', 'ONSITE'] as const;
export const ROLE_SALARY_PERIODS = ['YEAR', 'MONTH', 'HOUR'] as const;
/** Supported ISO 4217 codes; never infer currency from location or locale. */
export const ROLE_SALARY_CURRENCIES = ['USD', 'CAD', 'EUR', 'GBP', 'CNY', 'HKD', 'SGD', 'JPY', 'AUD', 'NZD', 'TWD', 'INR'] as const;
export interface RolePreferences {
  readonly preferredLocation: string | null;
  readonly workMode: typeof ROLE_WORK_MODES[number] | null;
  readonly salary: {
    readonly min: string | null;
    readonly max: string | null;
    readonly currency: typeof ROLE_SALARY_CURRENCIES[number];
    readonly period: typeof ROLE_SALARY_PERIODS[number];
  } | null;
  readonly availableFrom: string | null;
}
export interface RolePreferencesPatch { readonly expectedRevision: DecimalString; readonly preferences: RolePreferences }
export interface RolePreferencesSnapshot {
  readonly schemaVersion: 1;
  readonly conversationId: Uuid;
  readonly revision: DecimalString;
  readonly preferences: RolePreferences;
}
export const ROLE_PREFERENCES_PATH = '/api/v1/agent/conversations/:conversationId/job-preferences';
export const ROLE_PREFERENCES_MAX_BYTES = 4096;
const enumValue = <T extends string>(value: unknown, values: readonly T[]): value is T => typeof value === 'string' && values.includes(value as T);
export function isRoleRevision(value: unknown): value is DecimalString {
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
}
function amount(value: unknown): value is string | null {
  return value === null || typeof value === 'string' && /^(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?$/.test(value);
}
function cents(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
}
function validDate(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string' || !/^(19|20|21)[0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function location(value: unknown): value is string | null {
  return value === null || typeof value === 'string' && value.length > 0 && [...value].length <= 256 &&
    !/[\uD800-\uDFFF]/u.test(value) && value === value.normalize('NFC').trim() && !/\p{Cc}/u.test(value);
}
export function parseRolePreferences(value: unknown): RolePreferences | null {
  if (!closedRecord(value, ['preferredLocation', 'workMode', 'salary', 'availableFrom']) || !location(value.preferredLocation) ||
    value.workMode !== null && !enumValue(value.workMode, ROLE_WORK_MODES) || !validDate(value.availableFrom)) return null;
  let salary: RolePreferences['salary'] = null;
  if (value.salary !== null) {
    const s = value.salary;
    if (!closedRecord(s, ['min', 'max', 'currency', 'period']) || !amount(s.min) || !amount(s.max) ||
      s.min === null && s.max === null || !enumValue(s.currency, ROLE_SALARY_CURRENCIES) || !enumValue(s.period, ROLE_SALARY_PERIODS) ||
      s.min !== null && s.max !== null && cents(s.min) > cents(s.max)) return null;
    salary = { min: s.min, max: s.max, currency: s.currency, period: s.period };
  }
  return { preferredLocation: value.preferredLocation, workMode: value.workMode, salary, availableFrom: value.availableFrom };
}
export function upgradeRolePreferences(value: unknown): RolePreferences | null {
  if (!closedRecord(value, ['preferredLocation']) || !location(value.preferredLocation)) return null;
  return { preferredLocation: value.preferredLocation, workMode: null, salary: null, availableFrom: null };
}
export function parseRolePreferencesPatch(value: unknown): RolePreferencesPatch | null {
  if (!closedRecord(value, ['expectedRevision', 'preferences']) || !isRoleRevision(value.expectedRevision)) return null;
  const preferences = parseRolePreferences(value.preferences);
  return preferences ? { expectedRevision: value.expectedRevision, preferences } : null;
}
export function parseRolePreferencesSnapshot(value: unknown): RolePreferencesSnapshot | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== 1 || !parseUuid(v.conversationId) || !isRoleRevision(v.revision)) return null;
  const preferences = parseRolePreferences(v.preferences);
  return preferences ? { schemaVersion: 1, conversationId: parseUuid(v.conversationId)!, revision: v.revision, preferences } : null;
}
