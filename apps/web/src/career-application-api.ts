import { careerRecordId, careerRecordObject, parseCareerApplication, parseCareerApplicationSummary, parseCareerApplicationCommand, parseCareerApplicationEvent, type CareerApplicationAction, type CareerApplication, type CareerApplicationEvent, type CareerApplicationSummary, type ApplicationStage } from '@companion/platform-contracts';
import type { BoundPlatformClient } from './api';
const root = '/career/applications';
function fail(): never { throw Error('申请记录暂时无法确认，请重新读取。'); }
function owned<T extends {
    ownerId: string;
}>(client: BoundPlatformClient, value: T): T {
    if (value.ownerId !== client.account.accountId || !client.isCurrent())
        return fail();
    return value;
}
function array<T>(value: unknown, parse: (v: unknown) => T): readonly T[] {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 50)
        return fail();
    const fields = Object.getOwnPropertyDescriptors(value), out: T[] = [];
    if (Reflect.ownKeys(fields).length !== value.length + 1)
        return fail();
    for (let i = 0; i < value.length; i++) {
        if (!fields[i] || !('value' in fields[i]))
            return fail();
        out.push(parse(fields[i].value));
    }
    return Object.freeze(out);
}
export async function readCareerApplications(client: BoundPlatformClient, after: string | null = null, stage: ApplicationStage | 'active' | null = null, signal?: AbortSignal) {
    if (stage !== null && !['active', 'saved', 'applied', 'oa', 'interview', 'offer', 'closed'].includes(stage))
        return fail();
    const query = new URLSearchParams();
    if (after)
        query.set('after', careerRecordId(after));
    if (stage)
        query.set('stage', stage);
    const v = careerRecordObject(await client.request(root + (query.size ? '?' + query : ''), { signal }), ['applications', 'nextAfter']);
    const applications = array(v.applications, x => owned(client, parseCareerApplicationSummary(x)));
    if (new Set(applications.map(x => x.id)).size !== applications.length || stage && applications.some(x => stage === 'active' ? x.stage === 'closed' : x.stage !== stage))
        return fail();
    const nextAfter = v.nextAfter === null ? null : careerRecordId(v.nextAfter);
    if (nextAfter !== null && (applications.length !== 50 || nextAfter !== applications.at(-1)!.id))
        return fail();
    return Object.freeze({ applications, nextAfter });
}
export async function readCareerApplication(client: BoundPlatformClient, id: string, signal?: AbortSignal) {
    const key = careerRecordId(id), v = careerRecordObject(await client.request(root + '/' + key, { signal }), ['application']);
    const application = owned(client, parseCareerApplication(v.application));
    if (application.id !== key)
        return fail();
    return application;
}
export async function readCareerApplicationEvents(client: BoundPlatformClient, id: string, after: string | null = null, signal?: AbortSignal) {
    const key = careerRecordId(id), v = careerRecordObject(await client.request(root + '/' + key + '/events' + (after ? '?after=' + careerRecordId(after) : ''), { signal }), ['applicationId', 'events', 'nextAfter']);
    if (v.applicationId !== key)
        return fail();
    const events = array(v.events, x => owned(client, parseCareerApplicationEvent(x)));
    if (events.some((x, i) => x.applicationId !== key || i > 0 && x.revision <= events[i - 1].revision) || new Set(events.map(x => x.id)).size !== events.length || events.some(x => x.id === after))
        return fail();
    const nextAfter = v.nextAfter === null ? null : careerRecordId(v.nextAfter);
    if (nextAfter !== null && (events.length !== 50 || events.at(-1)!.id !== nextAfter))
        return fail();
    return Object.freeze({ events, nextAfter });
}
export interface ApplicationIntent {
    readonly action: CareerApplicationAction;
    readonly id: string | null;
    readonly body: unknown;
}
function intent(value: ApplicationIntent) {
    const command = parseCareerApplicationCommand(value.action, value.body), id = value.action === 'create' ? null : careerRecordId(value.id);
    if (value.action === 'create' && value.id !== null)
        return fail();
    return { command, id, action: value.action };
}
function result(client: BoundPlatformClient, raw: unknown, expected: ReturnType<typeof intent>, observed: boolean) {
    const v = careerRecordObject(raw, ['application', 'operation']), op = careerRecordObject(v.operation, ['id', 'applicationId', 'action', 'appliedRevision', 'replayed']);
    const id = careerRecordId(op.id), applicationId = careerRecordId(op.applicationId);
    if (id !== expected.command.operationId || op.action !== expected.action || op.appliedRevision !== expected.command.expectedRevision + 1 || typeof op.replayed !== 'boolean' || observed && !op.replayed || expected.id !== null && applicationId !== expected.id)
        return fail();
    const application = v.application === null ? null : owned(client, parseCareerApplication(v.application));
    if (application && (application.id !== applicationId || application.revision < (op.appliedRevision as number) || application.revision === op.appliedRevision && application.lastOperationId !== id))
        return fail();
    if (!op.replayed && (expected.action === 'delete' ? application !== null : !application || application.revision !== op.appliedRevision))
        return fail();
    if (application?.revision === op.appliedRevision) {
        const cmd = expected.command as Record<string, unknown>;
        if (expected.action === 'create' && (application.job.id !== cmd.jobObservationId || application.job.revision !== cmd.jobObservationRevision || application.stage !== 'saved' || application.privateNote !== cmd.privateNote))
            return fail();
        if (expected.action === 'edit' && application.privateNote !== cmd.privateNote)
            return fail();
        if (expected.action === 'stage' && (application.stage !== cmd.stage || cmd.stage === 'closed' && application.closedReason !== cmd.closedReason || cmd.stage === 'offer' && application.offerState !== cmd.offerState || cmd.stage === 'applied' && application.submittedVia !== 'user_sends'))
            return fail();
        if (expected.action === 'delete')
            return fail();
    }
    return Object.freeze({ application, operation: Object.freeze({ id, applicationId, action: expected.action, appliedRevision: op.appliedRevision as number, replayed: op.replayed as boolean }) });
}
export async function changeCareerApplication(client: BoundPlatformClient, value: ApplicationIntent, signal?: AbortSignal) {
    const expected = intent(value), path = root + (expected.id ? '/' + expected.id : '') + (expected.action === 'stage' ? '/stage' : '');
    const method = expected.action === 'delete' ? 'DELETE' : expected.action === 'edit' ? 'PATCH' : 'POST';
    return result(client, await client.request(path, { method, body: JSON.stringify(expected.command), signal }), expected, false);
}
export async function observeCareerApplication(client: BoundPlatformClient, value: ApplicationIntent, signal?: AbortSignal) {
    const expected = intent(value);
    return result(client, await client.request(root + '/operations/' + expected.command.operationId, { signal }), expected, true);
}
export type ApplicationResult = Awaited<ReturnType<typeof changeCareerApplication>>;
