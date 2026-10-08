import { careerRecordId, careerRecordObject } from './career-record-values.ts';
import { careerLibraryText, careerLibraryTime } from './career-stories.ts';
import { parseManualJobSummary, type ManualJobSummary } from './manual-jobs.ts';
import { parseApplicationStageCommand, parseApplicationStageState, type ApplicationStageState, type ApplicationStageCommand } from './application-stages.ts';
export type CareerApplicationAction = 'create' | 'stage' | 'edit' | 'delete';
export interface ApplicationCareWindow {
    readonly kind: 'post_rejection';
    readonly sourceEventId: string;
    readonly eventRevision: number;
    readonly startedAt: string;
    readonly until: string;
}
export interface CareerApplication extends ApplicationStageState {
    readonly id: string;
    readonly ownerId: string;
    readonly revision: number;
    readonly lastOperationId: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly source: 'user_recorded';
    readonly job: Readonly<ManualJobSummary>;
    readonly privateNote: string;
    readonly packetId: null;
    readonly careWindow: Readonly<ApplicationCareWindow> | null;
}
export type CareerApplicationSummary = Omit<CareerApplication, 'privateNote'>;
export type CareerApplicationCommand = ApplicationStageCommand | {
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly jobObservationId?: string;
    readonly jobObservationRevision?: number;
    readonly privateNote?: string;
};
export interface CareerApplicationEvent {
    readonly id: string;
    readonly ownerId: string;
    readonly applicationId: string;
    readonly revision: number;
    readonly action: CareerApplicationAction;
    readonly actor: 'user';
    readonly channel: 'web';
    readonly createdAt: string;
    readonly previous: Readonly<ApplicationStageState> | null;
    readonly next: Readonly<ApplicationStageState> | null;
    readonly careWindowUntil: string | null;
}
function fail(): never { throw Error('The application record could not be confirmed.'); }
function integer(v: unknown, min = 1): number { if (typeof v !== 'number' || !Number.isSafeInteger(v) || Object.is(v, -0) || v < min || v > 2147483647)
    return fail(); return v; }
export function parseCareerApplicationCommand(action: CareerApplicationAction, value: unknown): Readonly<CareerApplicationCommand> {
    if (action === 'stage')
        return parseApplicationStageCommand(value);
    if (!['create', 'edit', 'delete'].includes(action))
        return fail();
    const v = careerRecordObject(value, ['operationId', 'expectedRevision', ...(action === 'create' ? ['jobObservationId', 'jobObservationRevision', 'privateNote'] : action === 'edit' ? ['privateNote'] : [])]);
    const operationId = careerRecordId(v.operationId), expectedRevision = integer(v.expectedRevision, action === 'create' ? 0 : 1);
    if (action === 'create') {
        if (expectedRevision !== 0)
            return fail();
        return Object.freeze({ operationId, expectedRevision, jobObservationId: careerRecordId(v.jobObservationId), jobObservationRevision: integer(v.jobObservationRevision), privateNote: careerLibraryText(v.privateNote, 2000, true, true) });
    }
    return Object.freeze({ operationId, expectedRevision, ...(action === 'edit' ? { privateNote: careerLibraryText(v.privateNote, 2000, true, true) } : {}) });
}
export function parseApplicationCareWindow(value: unknown): Readonly<ApplicationCareWindow> {
    const v = careerRecordObject(value, ['kind', 'sourceEventId', 'eventRevision', 'startedAt', 'until']);
    const startedAt = careerLibraryTime(v.startedAt), until = careerLibraryTime(v.until);
    if (v.kind !== 'post_rejection' || Date.parse(until) - Date.parse(startedAt) !== 48 * 60 * 60 * 1000)
        return fail();
    return Object.freeze({ kind: 'post_rejection', sourceEventId: careerRecordId(v.sourceEventId), eventRevision: integer(v.eventRevision, 2), startedAt, until });
}
const fields = ['id', 'ownerId', 'revision', 'lastOperationId', 'createdAt', 'updatedAt', 'source', 'job', 'packetId', 'careWindow', 'stage', 'closedReason', 'closedAtStage', 'offerState', 'submittedVia'];
function record(value: unknown, summary: boolean): Readonly<CareerApplicationSummary> | Readonly<CareerApplication> {
    const v = careerRecordObject(value, [...fields, ...(summary ? [] : ['privateNote'])]), ownerId = careerRecordId(v.ownerId), revision = integer(v.revision), createdAt = careerLibraryTime(v.createdAt), updatedAt = careerLibraryTime(v.updatedAt);
    const state = parseApplicationStageState({ stage: v.stage, closedReason: v.closedReason, closedAtStage: v.closedAtStage, offerState: v.offerState, submittedVia: v.submittedVia }), job = parseManualJobSummary(v.job), careWindow = v.careWindow === null ? null : parseApplicationCareWindow(v.careWindow);
    if (v.source !== 'user_recorded' || v.packetId !== null || job.ownerId !== ownerId || Date.parse(updatedAt) < Date.parse(createdAt) || Date.parse(job.observedAt) > Date.parse(createdAt) || careWindow && (careWindow.eventRevision > revision || Date.parse(careWindow.startedAt) < Date.parse(createdAt) || Date.parse(careWindow.startedAt) > Date.parse(updatedAt)))
        return fail();
    // This owner path has no trusted extension or in-product execution adapter.
    if (state.submittedVia !== null && state.submittedVia !== 'user_sends')
        return fail();
    return Object.freeze({ id: careerRecordId(v.id), ownerId, revision, lastOperationId: careerRecordId(v.lastOperationId), createdAt, updatedAt, source: 'user_recorded', job, packetId: null, careWindow, ...state, ...(summary ? {} : { privateNote: careerLibraryText(v.privateNote, 2000, true, true) }) });
}
export function parseCareerApplication(value: unknown) { return record(value, false) as Readonly<CareerApplication>; }
export function parseCareerApplicationSummary(value: unknown) { return record(value, true) as Readonly<CareerApplicationSummary>; }
export function careerApplicationSummary(value: Readonly<CareerApplication>): Readonly<CareerApplicationSummary> { const { privateNote, ...summary } = value; return Object.freeze(summary); }
export function parseCareerApplicationEvent(value: unknown): Readonly<CareerApplicationEvent> {
    const v = careerRecordObject(value, ['id', 'ownerId', 'applicationId', 'revision', 'action', 'actor', 'channel', 'createdAt', 'previous', 'next', 'careWindowUntil']);
    if (!['create', 'stage', 'edit', 'delete'].includes(v.action as string) || v.actor !== 'user' || v.channel !== 'web')
        return fail();
    const previous = v.previous === null ? null : parseApplicationStageState(v.previous), next = v.next === null ? null : parseApplicationStageState(v.next), revision = integer(v.revision), createdAt = careerLibraryTime(v.createdAt), careWindowUntil = v.careWindowUntil === null ? null : careerLibraryTime(v.careWindowUntil);
    if (v.action === 'create') {
        if (revision !== 1 || previous !== null || next?.stage !== 'saved')
            return fail();
    }
    else if (revision < 2 || previous === null || (v.action === 'delete' ? next !== null : next === null))
        return fail();
    for (const state of [previous, next])
        if (state && state.submittedVia !== null && state.submittedVia !== 'user_sends')
            return fail();
    if (v.action === 'edit' && JSON.stringify(previous) !== JSON.stringify(next))
        return fail();
    if (v.action === 'stage' && next?.stage === 'closed' && next.closedAtStage !== (previous!.stage === 'closed' ? previous!.closedAtStage : previous!.stage))
        return fail();
    const qualifies = (state: Readonly<ApplicationStageState> | null) => state?.stage === 'closed' && ['not_advanced', 'rescinded'].includes(state.closedReason!) && ['oa', 'interview', 'offer'].includes(state.closedAtStage!);
    const newCare = v.action === 'stage' && qualifies(next) && !qualifies(previous);
    if ((careWindowUntil !== null) !== newCare || careWindowUntil !== null && Date.parse(careWindowUntil) - Date.parse(createdAt) !== 48 * 60 * 60 * 1000)
        return fail();
    return Object.freeze({ id: careerRecordId(v.id), ownerId: careerRecordId(v.ownerId), applicationId: careerRecordId(v.applicationId), revision, action: v.action as CareerApplicationAction, actor: 'user', channel: 'web', createdAt, previous, next, careWindowUntil });
}
