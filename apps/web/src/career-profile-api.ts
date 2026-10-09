import { careerRecordObject, careerRecordId, parseCareerProfileCommand, parseCareerProfileSnapshot, type CareerProfileAction } from '@companion/platform-contracts';
export interface CareerProfileClient {
    readonly account: {
        readonly accountId: string;
    };
    isCurrent(): boolean;
    subscribe(fn: () => void): () => void;
    request<T>(path: string, init?: RequestInit): Promise<T>;
}
const root = '/career/profile';
const fail = (): never => { throw Error('职业档案暂时无法确认，请重新读取。'); };
function current(c: CareerProfileClient, s?: AbortSignal) { s?.throwIfAborted(); if (!c.isCurrent())
    fail(); }
function snapshot(c: CareerProfileClient, raw: unknown) { const result = parseCareerProfileSnapshot(raw); if (result.ownerId !== c.account.accountId)
    fail(); return result; }
const canonical = (value: unknown) => JSON.stringify(value, (_k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
export async function readCareerProfile(c: CareerProfileClient, signal?: AbortSignal) {
    current(c, signal);
    const raw = await c.request(root, { signal, cache: 'no-store' });
    current(c, signal);
    return snapshot(c, raw);
}
export async function changeCareerProfile(c: CareerProfileClient, action: CareerProfileAction, input: unknown, signal?: AbortSignal, observe = false) {
    const cmd = parseCareerProfileCommand(action, input);
    current(c, signal);
    const raw = await c.request(root + (observe ? '/operations/' + cmd.operationId : ''), observe ? { signal, cache: 'no-store' } : { signal, cache: 'no-store', method: action === 'save' ? 'PATCH' : 'DELETE', body: JSON.stringify(cmd) });
    current(c, signal);
    const v = careerRecordObject(raw, ['ownerId', 'revision', 'profile', 'operation']), result = snapshot(c, { ownerId: v.ownerId, revision: v.revision, profile: v.profile });
    const op = careerRecordObject(v.operation, ['id', 'action', 'appliedRevision', 'replayed']);
    if (careerRecordId(op.id) !== cmd.operationId || op.action !== action || op.appliedRevision !== cmd.expectedRevision + 1 || typeof op.replayed !== 'boolean' || observe && !op.replayed || result.revision < (op.appliedRevision as number))
        fail();
    if (!op.replayed && result.revision !== op.appliedRevision)
        fail();
    if (result.revision === op.appliedRevision) {
        const p = result.profile;
        if (action === 'delete') {
            if (p !== null)
                fail();
        }
        else if (!p || p.lastOperationId !== cmd.operationId || canonical({ degreeField: p.degreeField, graduationMonth: p.graduationMonth, graduated: p.graduated, targetTracks: p.targetTracks }) !== canonical(cmd.facts))
            fail();
    }
    return Object.freeze({ ...result, operation: Object.freeze({ id: cmd.operationId, action, appliedRevision: op.appliedRevision as number, replayed: op.replayed }) });
}
