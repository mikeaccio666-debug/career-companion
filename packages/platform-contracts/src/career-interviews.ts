import { careerRecordId, careerRecordObject, CAREER_ROLE_FAMILIES, type CareerRoleFamily } from './career-record-values.ts';
import { careerLibraryText, careerLibraryTime } from './career-stories.ts';
export const CAREER_INTERVIEW_ROUND_TYPES = Object.freeze(['coding', 'system_design', 'ml_design', 'sql', 'stats', 'product_case', 'behavioral', 'hiring_manager', 'bug_bash', 'take_home'] as const);
export type CareerInterviewRoundType = typeof CAREER_INTERVIEW_ROUND_TYPES[number];
export type CareerInterviewStatus = 'scheduled' | 'rescheduled' | 'done' | 'cancelled';
export type CareerInterviewAction = 'create' | 'edit' | 'reschedule' | 'status' | 'delete';
export interface InterviewApplicationReference {
    readonly id: string;
    readonly ownerId: string;
    readonly revision: number;
    readonly employer: string;
    readonly title: string;
    readonly roleFamily: CareerRoleFamily;
}
export interface CareerInterview {
    readonly id: string;
    readonly ownerId: string;
    readonly revision: number;
    readonly lastOperationId: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly source: 'user_recorded';
    readonly application: Readonly<InterviewApplicationReference>;
    readonly roundType: CareerInterviewRoundType;
    readonly startsAt: string;
    readonly timeZone: string;
    readonly durationMin: number;
    readonly status: CareerInterviewStatus;
    readonly briefId: null;
    readonly debrief: null;
}
interface Base {
    readonly operationId: string;
    readonly expectedRevision: number;
}
export type CareerInterviewCommand = Base & ({
    readonly action: 'create';
    readonly applicationId: string;
    readonly applicationRevision: number;
    readonly roundType: CareerInterviewRoundType;
    readonly startsAt: string;
    readonly timeZone: string;
    readonly durationMin: number;
} | {
    readonly action: 'edit';
    readonly roundType: CareerInterviewRoundType;
    readonly durationMin: number;
} | {
    readonly action: 'reschedule';
    readonly startsAt: string;
    readonly timeZone: string;
} | {
    readonly action: 'status';
    readonly status: 'done' | 'cancelled';
} | {
    readonly action: 'delete';
});
export interface CareerInterviewOperation {
    readonly id: string;
    readonly interviewId: string;
    readonly action: CareerInterviewAction;
    readonly appliedRevision: number;
    readonly replayed: boolean;
}
const actions = Object.freeze(['create', 'edit', 'reschedule', 'status', 'delete'] as const);
function fail(): never { throw Error('The interview record could not be confirmed.'); }
function integer(value: unknown, min = 1, max = 2147483647): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max)
    return fail(); return value; }
function choice<T extends string>(value: unknown, values: readonly T[]): T { if (typeof value !== 'string' || !values.includes(value as T))
    return fail(); return value as T; }
/** A named zone is mandatory. UTC instants are never inferred from device time or an ambiguous wall time. */
export function careerInterviewTimeZone(value: unknown): string {
    if (typeof value !== 'string' || value.length > 100 || !/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(value))
        return fail();
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    }
    catch {
        return fail();
    }
    return value;
}
function instant(value: unknown): string { const v = careerLibraryTime(value); if (v.startsWith('0000-') || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v))
    return fail(); return v; }
export function parseCareerInterviewApplicationReference(value: unknown): Readonly<InterviewApplicationReference> {
    const v = careerRecordObject(value, ['id', 'ownerId', 'revision', 'employer', 'title', 'roleFamily']);
    return Object.freeze({ id: careerRecordId(v.id), ownerId: careerRecordId(v.ownerId), revision: integer(v.revision), employer: careerLibraryText(v.employer, 200), title: careerLibraryText(v.title, 200), roleFamily: choice(v.roleFamily, CAREER_ROLE_FAMILIES) });
}
export function parseCareerInterviewCommand(action: CareerInterviewAction, value: unknown): Readonly<CareerInterviewCommand> {
    choice(action, actions);
    const extra = action === 'create' ? ['applicationId', 'applicationRevision', 'roundType', 'startsAt', 'timeZone', 'durationMin'] : action === 'edit' ? ['roundType', 'durationMin'] : action === 'reschedule' ? ['startsAt', 'timeZone'] : action === 'status' ? ['status'] : [];
    const v = careerRecordObject(value, ['operationId', 'expectedRevision', ...extra]);
    const base = { operationId: careerRecordId(v.operationId), expectedRevision: integer(v.expectedRevision, action === 'create' ? 0 : 1) };
    if (action === 'create' && base.expectedRevision !== 0)
        return fail();
    switch (action) {
        case 'create': return Object.freeze({ ...base, action, applicationId: careerRecordId(v.applicationId), applicationRevision: integer(v.applicationRevision), roundType: choice(v.roundType, CAREER_INTERVIEW_ROUND_TYPES), startsAt: instant(v.startsAt), timeZone: careerInterviewTimeZone(v.timeZone), durationMin: integer(v.durationMin) });
        case 'edit': return Object.freeze({ ...base, action, roundType: choice(v.roundType, CAREER_INTERVIEW_ROUND_TYPES), durationMin: integer(v.durationMin) });
        case 'reschedule': return Object.freeze({ ...base, action, startsAt: instant(v.startsAt), timeZone: careerInterviewTimeZone(v.timeZone) });
        case 'status': return Object.freeze({ ...base, action, status: choice(v.status, ['done', 'cancelled'] as const) });
        case 'delete': return Object.freeze({ ...base, action });
    }
}
export function parseCareerInterview(value: unknown): Readonly<CareerInterview> {
    const v = careerRecordObject(value, ['id', 'ownerId', 'revision', 'lastOperationId', 'createdAt', 'updatedAt', 'source', 'application', 'roundType', 'startsAt', 'timeZone', 'durationMin', 'status', 'briefId', 'debrief']);
    const ownerId = careerRecordId(v.ownerId), application = parseCareerInterviewApplicationReference(v.application), createdAt = careerLibraryTime(v.createdAt), updatedAt = careerLibraryTime(v.updatedAt), revision = integer(v.revision), status = choice(v.status, ['scheduled', 'rescheduled', 'done', 'cancelled'] as const);
    if (v.source !== 'user_recorded' || application.ownerId !== ownerId || updatedAt < createdAt || v.briefId !== null || v.debrief !== null || revision === 1 && (status !== 'scheduled' || updatedAt !== createdAt))
        return fail();
    return Object.freeze({ id: careerRecordId(v.id), ownerId, revision, lastOperationId: careerRecordId(v.lastOperationId), createdAt, updatedAt, source: 'user_recorded', application, roundType: choice(v.roundType, CAREER_INTERVIEW_ROUND_TYPES), startsAt: instant(v.startsAt), timeZone: careerInterviewTimeZone(v.timeZone), durationMin: integer(v.durationMin), status, briefId: null, debrief: null });
}
export function parseCareerInterviewOperation(value: unknown): Readonly<CareerInterviewOperation> {
    const v = careerRecordObject(value, ['id', 'interviewId', 'action', 'appliedRevision', 'replayed']);
    const action = choice(v.action, actions), appliedRevision = integer(v.appliedRevision);
    if (typeof v.replayed !== 'boolean' || (action === 'create' ? appliedRevision !== 1 : appliedRevision < 2))
        return fail();
    return Object.freeze({ id: careerRecordId(v.id), interviewId: careerRecordId(v.interviewId), action, appliedRevision, replayed: v.replayed });
}
