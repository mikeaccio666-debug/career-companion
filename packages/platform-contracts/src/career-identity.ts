/** Owner records only. No eligibility, countdown, reminder, or expert permission. */
import { careerRecordObject, careerRecordId, CareerRecordInputError } from './career-record-values.ts';
export const CAREER_IDENTITY_FIELDS = Object.freeze(['program_end_date', 'stem_designated', 'opt_status', 'opt_start_date', 'opt_end_date', 'stem_opt_start_date', 'stem_opt_end_date', 'unemployment_days_reported', 'employment_reported', 'h1b_registration', 'custom_status_date'] as const);
export type CareerIdentityField = typeof CAREER_IDENTITY_FIELDS[number];
export type CareerIdentityAction = 'create' | 'edit' | 'delete';
export type H1bReportedOutcome = 'selected' | 'not_selected' | 'unknown';
export type CareerIdentityValue = string | boolean | Readonly<{
    days: number;
    reportedAt: string;
}> | Readonly<{
    year: number;
    outcome: H1bReportedOutcome;
}>;
export type CareerIdentityInputValue = string | boolean | Readonly<{
    days: number;
}> | Readonly<{
    year: number;
    outcome: H1bReportedOutcome;
}>;
export interface CareerIdentityRecord {
    readonly id: string;
    readonly ownerId: string;
    readonly field: CareerIdentityField;
    readonly value: CareerIdentityValue;
    readonly label: string | null;
    readonly source: 'user_entered';
    readonly sensitivity: 'sensitive' | 'restricted';
    readonly confirmedAt: string;
    readonly remindBeforeDays: null;
    readonly revision: number;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly lastOperationId: string;
}
export interface CareerIdentityCommand {
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly field?: CareerIdentityField;
    readonly value?: CareerIdentityInputValue;
    readonly label?: string | null;
}
const fail = (): never => { throw new CareerRecordInputError(); };
export function careerIdentitySensitivity(field: CareerIdentityField) { return field === 'program_end_date' || field === 'stem_designated' ? 'sensitive' as const : 'restricted' as const; }
function integer(v: unknown, min: number, max = 2147483647) {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || Object.is(v, -0) || v < min || v > max)
        return fail();
    return v;
}
function text(v: unknown, max: number) {
    if (typeof v !== 'string' || v.trim() !== v || !v || Array.from(v).length > max || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(v))
        return fail();
    return v;
}
function at(v: unknown) {
    if (typeof v !== 'string' || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v)
        return fail();
    return v;
}
export function careerIdentityCalendarDate(v: unknown): string {
    if (typeof v !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v))
        return fail();
    const [year, month, day] = v.split('-').map(Number), leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0), days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1])
        return fail();
    return v;
}
function field(v: unknown): CareerIdentityField {
    if (typeof v !== 'string' || !CAREER_IDENTITY_FIELDS.includes(v as CareerIdentityField))
        return fail();
    return v as CareerIdentityField;
}
function valueFor(key: CareerIdentityField, v: unknown, saved: boolean): CareerIdentityValue | CareerIdentityInputValue {
    if (['program_end_date', 'opt_start_date', 'opt_end_date', 'stem_opt_start_date', 'stem_opt_end_date', 'custom_status_date'].includes(key))
        return careerIdentityCalendarDate(v);
    if (key === 'stem_designated' || key === 'employment_reported') {
        if (typeof v !== 'boolean')
            return fail();
        return v;
    }
    if (key === 'opt_status')
        return text(v, 160); // Owner wording; never a system legal classification.
    if (key === 'h1b_registration') {
        const x = careerRecordObject(v, ['year', 'outcome']);
        if (!['selected', 'not_selected', 'unknown'].includes(x.outcome as string))
            return fail();
        return Object.freeze({ year: integer(x.year, 1, 9999), outcome: x.outcome as H1bReportedOutcome });
    }
    const x = careerRecordObject(v, saved ? ['days', 'reportedAt'] : ['days']);
    return Object.freeze({ days: integer(x.days, 0), ...(saved ? { reportedAt: at(x.reportedAt) } : {}) });
}
function labelFor(key: CareerIdentityField, v: unknown): string | null {
    if (key === 'custom_status_date')
        return text(v, 120);
    if (v !== null)
        return fail();
    return null;
}
export function parseCareerIdentityCommand(action: CareerIdentityAction, input: unknown): Readonly<CareerIdentityCommand> {
    if (!['create', 'edit', 'delete'].includes(action))
        return fail();
    const v = careerRecordObject(input, ['operationId', 'expectedRevision', ...(action === 'delete' ? [] : ['field', 'value', 'label'])]);
    const result: CareerIdentityCommand = { operationId: careerRecordId(v.operationId), expectedRevision: integer(v.expectedRevision, action === 'create' ? 0 : 1) };
    if (action === 'create' && result.expectedRevision !== 0)
        return fail();
    if (action === 'delete')
        return Object.freeze(result);
    const key = field(v.field);
    return Object.freeze({ ...result, field: key, value: valueFor(key, v.value, false) as CareerIdentityInputValue, label: labelFor(key, v.label) });
}
export function parseCareerIdentityRecord(input: unknown): Readonly<CareerIdentityRecord> {
    const v = careerRecordObject(input, ['id', 'ownerId', 'field', 'value', 'label', 'source', 'sensitivity', 'confirmedAt', 'remindBeforeDays', 'revision', 'createdAt', 'updatedAt', 'lastOperationId']), key = field(v.field);
    if (v.source !== 'user_entered' || v.sensitivity !== careerIdentitySensitivity(key) || v.remindBeforeDays !== null)
        return fail();
    const record = { id: careerRecordId(v.id), ownerId: careerRecordId(v.ownerId), field: key, value: valueFor(key, v.value, true) as CareerIdentityValue, label: labelFor(key, v.label), source: 'user_entered' as const, sensitivity: careerIdentitySensitivity(key), confirmedAt: at(v.confirmedAt), remindBeforeDays: null, revision: integer(v.revision, 1), createdAt: at(v.createdAt), updatedAt: at(v.updatedAt), lastOperationId: careerRecordId(v.lastOperationId) };
    if (record.createdAt > record.updatedAt || record.confirmedAt !== record.updatedAt || key === 'unemployment_days_reported' && (record.value as {
        reportedAt: string;
    }).reportedAt !== record.confirmedAt)
        return fail();
    return Object.freeze(record);
}
/** Actual intake selection for the explicit personal-record management page.
 * This is not a C5 completion, StatusClock preference or execution grant. */
export type CareerIdentityEntry = Readonly<{
    kind: 'hidden';
    ownerId: string;
}> | Readonly<{
    kind: 'available';
    ownerId: string;
    stage: 'f1_student' | 'opt' | 'stem_opt';
    source: Readonly<{
        draftId: string;
        revision: number;
    }>;
}>;
export function parseCareerIdentityEntry(input: unknown): CareerIdentityEntry {
    const base = careerRecordObject(input, ['kind', 'ownerId'], ['stage', 'source']), ownerId = careerRecordId(base.ownerId);
    if (base.kind === 'hidden') {
        careerRecordObject(input, ['kind', 'ownerId']);
        return Object.freeze({ kind: 'hidden', ownerId });
    }
    if (base.kind !== 'available' || !['f1_student', 'opt', 'stem_opt'].includes(base.stage as string))
        return fail();
    const source = careerRecordObject(base.source, ['draftId', 'revision']);
    return Object.freeze({ kind: 'available', ownerId, stage: base.stage as 'f1_student' | 'opt' | 'stem_opt', source: Object.freeze({ draftId: careerRecordId(source.draftId), revision: integer(source.revision, 1) }) });
}
