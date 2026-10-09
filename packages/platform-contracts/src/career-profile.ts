import { CAREER_ROLE_FAMILIES, careerRecordObject, careerRecordId, CareerRecordInputError, type CareerRoleFamily } from './career-record-values.ts';
export const CAREER_DEGREE_FIELDS = Object.freeze(['cs', 'ds_statistics', 'ece_ee', 'other_stem'] as const);
export type CareerDegreeField = typeof CAREER_DEGREE_FIELDS[number];
export interface CareerProfileFacts {
    readonly degreeField: CareerDegreeField | null;
    readonly graduationMonth: string | null;
    readonly graduated: boolean | null;
    readonly targetTracks: readonly CareerRoleFamily[];
}
export interface CareerProfile extends CareerProfileFacts {
    readonly id: string;
    readonly ownerId: string;
    readonly revision: number;
    readonly source: 'user_entered';
    readonly confirmedAt: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly lastOperationId: string;
}
export interface CareerProfileSnapshot {
    readonly ownerId: string;
    readonly revision: number;
    readonly profile: Readonly<CareerProfile> | null;
}
export type CareerProfileAction = 'save' | 'delete';
export interface CareerProfileCommand {
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly facts?: Readonly<CareerProfileFacts>;
    readonly confirmed?: true;
}
const fail = (): never => { throw new CareerRecordInputError(); };
export function careerProfileRevision(value: unknown, minimum = 0): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum || value > 2147483647)
        return fail();
    return value;
}
function timestamp(value: unknown): string {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
        return fail();
    return value;
}
export function parseCareerProfileFacts(value: unknown): Readonly<CareerProfileFacts> {
    const v = careerRecordObject(value, ['degreeField', 'graduationMonth', 'graduated', 'targetTracks']);
    if (v.degreeField !== null && !CAREER_DEGREE_FIELDS.includes(v.degreeField as CareerDegreeField))
        return fail();
    if (v.graduationMonth !== null && (typeof v.graduationMonth !== 'string' || v.graduationMonth.length !== 7 || !/^(?:19|20|21)[0-9]{2}-(?:0[1-9]|1[0-2])$/.test(v.graduationMonth)))
        return fail();
    if (v.graduated !== null && typeof v.graduated !== 'boolean')
        return fail();
    const list = v.targetTracks;
    if (!Array.isArray(list) || Object.getPrototypeOf(list) !== Array.prototype || list.length > CAREER_ROLE_FAMILIES.length)
        return fail();
    const descriptors = Object.getOwnPropertyDescriptors(list);
    if (Reflect.ownKeys(descriptors).length !== list.length + 1)
        return fail();
    const tracks: CareerRoleFamily[] = [];
    for (let i = 0; i < list.length; i++) {
        const d = descriptors[i];
        if (!d || !('value' in d) || !d.enumerable || !CAREER_ROLE_FAMILIES.includes(d.value))
            return fail();
        tracks.push(d.value);
    }
    if (new Set(tracks).size !== tracks.length)
        return fail();
    return Object.freeze({ degreeField: v.degreeField as CareerDegreeField | null, graduationMonth: v.graduationMonth as string | null, graduated: v.graduated as boolean | null, targetTracks: Object.freeze(tracks) });
}
export function parseCareerProfile(value: unknown): Readonly<CareerProfile> {
    const v = careerRecordObject(value, ['id', 'ownerId', 'revision', 'source', 'confirmedAt', 'createdAt', 'updatedAt', 'lastOperationId', 'degreeField', 'graduationMonth', 'graduated', 'targetTracks']);
    const id = careerRecordId(v.id), ownerId = careerRecordId(v.ownerId), createdAt = timestamp(v.createdAt), updatedAt = timestamp(v.updatedAt), confirmedAt = timestamp(v.confirmedAt);
    if (id !== ownerId || v.source !== 'user_entered' || confirmedAt !== updatedAt || createdAt > updatedAt)
        return fail();
    return Object.freeze({ ...parseCareerProfileFacts({ degreeField: v.degreeField, graduationMonth: v.graduationMonth, graduated: v.graduated, targetTracks: v.targetTracks }),
        id, ownerId, revision: careerProfileRevision(v.revision, 1), source: 'user_entered', createdAt, updatedAt, confirmedAt, lastOperationId: careerRecordId(v.lastOperationId) });
}
export function parseCareerProfileSnapshot(value: unknown): Readonly<CareerProfileSnapshot> {
    const v = careerRecordObject(value, ['ownerId', 'revision', 'profile']), ownerId = careerRecordId(v.ownerId), revision = careerProfileRevision(v.revision), profile = v.profile === null ? null : parseCareerProfile(v.profile);
    if (profile && (profile.ownerId !== ownerId || profile.revision !== revision))
        return fail();
    return Object.freeze({ ownerId, revision, profile });
}
export function parseCareerProfileCommand(action: CareerProfileAction, value: unknown): Readonly<CareerProfileCommand> {
    if (action !== 'save' && action !== 'delete')
        return fail();
    const v = careerRecordObject(value, action === 'save' ? ['operationId', 'expectedRevision', 'facts', 'confirmed'] : ['operationId', 'expectedRevision']);
    const common = { operationId: careerRecordId(v.operationId), expectedRevision: careerProfileRevision(v.expectedRevision) };
    if (action === 'delete')
        return Object.freeze(common);
    if (v.confirmed !== true)
        return fail();
    return Object.freeze({ ...common, facts: parseCareerProfileFacts(v.facts), confirmed: true });
}
