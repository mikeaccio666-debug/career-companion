import { careerRecordObject, careerRecordId, parseCareerIdentityEntry, parseCareerIdentityRecord, parseCareerIdentityCommand, type CareerIdentityAction, type CareerIdentityRecord } from '@companion/platform-contracts';
/** Portable account-bound request port; no Vite/browser globals or UI authority. */
export interface IdentityRecordClient {readonly account:{readonly accountId:string};isCurrent():boolean;request<T>(path:string,init?:RequestInit):Promise<T>;}
const root = '/career/identity';
function fail(): never { throw Error('这次记录暂时无法确认，请重新读取。'); }
function owned<T extends {
    ownerId: string;
}>(client: IdentityRecordClient, value: T): T { if (!client.isCurrent() || value.ownerId !== client.account.accountId)
    return fail(); return value; }
export async function readIdentityEntry(client: IdentityRecordClient, signal?: AbortSignal) { return owned(client, parseCareerIdentityEntry(await client.request(root + '/entry', { signal }))); }
export async function readIdentityRecords(client: IdentityRecordClient, signal?: AbortSignal) {
    const v = careerRecordObject(await client.request(root, { signal }), ['records']);
    if (!Array.isArray(v.records) || Object.getPrototypeOf(v.records) !== Array.prototype || v.records.length > 100)
        return fail();
    const d = Object.getOwnPropertyDescriptors(v.records);
    if (Reflect.ownKeys(d).length !== v.records.length + 1)
        return fail();
    const records: Readonly<CareerIdentityRecord>[] = [];
    for (let i = 0; i < v.records.length; i++) {
        if (!d[i] || !('value' in d[i]) || !d[i].enumerable)
            return fail();
        records.push(owned(client, parseCareerIdentityRecord(d[i].value)));
    }
    if (new Set(records.map(r => r.id)).size !== records.length)
        return fail();
    return Object.freeze(records);
}
export interface IdentityIntent {
    action: CareerIdentityAction;
    id: string | null;
    body: unknown;
}
function intent(v: IdentityIntent) { const command = parseCareerIdentityCommand(v.action, v.body), id = v.action === 'create' ? null : careerRecordId(v.id); if (v.action === 'create' && v.id !== null)
    return fail(); return Object.freeze({ action: v.action, id, command }); }
function canonical(v: unknown): string { return JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x); }
function result(client: IdentityRecordClient, raw: unknown, expected: ReturnType<typeof intent>, observed: boolean) {
    const v = careerRecordObject(raw, ['record', 'operation']), op = careerRecordObject(v.operation, ['id', 'recordId', 'action', 'appliedRevision', 'replayed']), id = careerRecordId(op.id), recordId = careerRecordId(op.recordId);
    if (id !== expected.command.operationId || op.action !== expected.action || op.appliedRevision !== expected.command.expectedRevision + 1 || typeof op.replayed !== 'boolean' || observed && !op.replayed || expected.id !== null && recordId !== expected.id)
        return fail();
    const record = v.record === null ? null : owned(client, parseCareerIdentityRecord(v.record));
    if (!client.isCurrent() || record && (record.id !== recordId || record.revision < (op.appliedRevision as number) || record.revision === op.appliedRevision && record.lastOperationId !== id))
        return fail();
    if (expected.action === 'delete' && record !== null || !op.replayed && expected.action !== 'delete' && (!record || record.revision !== op.appliedRevision))
        return fail();
    if (record?.revision === op.appliedRevision) {
        const cmd = expected.command, value = record.field === 'unemployment_days_reported' ? { days: (record.value as {
                days: number;
            }).days } : record.value;
        if (record.field !== cmd.field || record.label !== cmd.label || canonical(value) !== canonical(cmd.value))
            return fail();
    }
    return Object.freeze({ record, operation: Object.freeze({ id, recordId, action: expected.action, appliedRevision: op.appliedRevision as number, replayed: op.replayed as boolean }) });
}
export async function changeIdentityRecord(client: IdentityRecordClient, value: IdentityIntent, signal?: AbortSignal) {
    const expected = intent(value), method = expected.action === 'create' ? 'POST' : expected.action === 'edit' ? 'PATCH' : 'DELETE';
    return result(client, await client.request(root + (expected.id ? '/' + expected.id : ''), { method, body: JSON.stringify(expected.command), signal }), expected, false);
}
export async function observeIdentityRecord(client: IdentityRecordClient, value: IdentityIntent, signal?: AbortSignal) { const expected = intent(value); return result(client, await client.request(root + '/operations/' + expected.command.operationId, { signal }), expected, true); }
export type IdentityResult = Awaited<ReturnType<typeof changeIdentityRecord>>;
