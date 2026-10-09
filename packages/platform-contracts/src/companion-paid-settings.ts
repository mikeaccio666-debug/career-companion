import { careerRecordObject as object, careerRecordId as id, CareerRecordInputError } from './career-record-values.ts';
export const PAID_SUGGESTION_MODES = Object.freeze(['when_relevant', 'only_when_asked'] as const);
export type PaidSuggestionsMode = typeof PAID_SUGGESTION_MODES[number];
export interface CompanionPaidSettings {
    readonly ownerId: string;
    readonly companionId: string;
    readonly paidSuggestionsMode: PaidSuggestionsMode;
    readonly revision: number;
    readonly updatedAt: string | null;
    readonly lastOperationId: string | null;
}
export interface CompanionPaidSettingsCommand {
    readonly companionId: string;
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly paidSuggestionsMode: PaidSuggestionsMode;
}
export interface CompanionPaidSettingsResult {
    readonly settings: Readonly<CompanionPaidSettings>;
    readonly operation: {
        readonly id: string;
        readonly appliedRevision: number;
        readonly paidSuggestionsMode: PaidSuggestionsMode;
        readonly replayed: boolean;
    };
}
const fail = (): never => { throw new CareerRecordInputError(); };
function mode(v: unknown): PaidSuggestionsMode { if (typeof v !== 'string' || !PAID_SUGGESTION_MODES.includes(v as PaidSuggestionsMode))
    return fail(); return v as PaidSuggestionsMode; }
function rev(v: unknown, max = 2147483647): number { if (typeof v !== 'number' || !Number.isSafeInteger(v) || Object.is(v, -0) || v < 0 || v > max)
    return fail(); return v; }
function at(v: unknown): string { if (typeof v !== 'string' || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v)
    return fail(); return v; }
export function parseCompanionPaidSettings(value: unknown): Readonly<CompanionPaidSettings> {
    const v = object(value, ['ownerId', 'companionId', 'paidSuggestionsMode', 'revision', 'updatedAt', 'lastOperationId']);
    const revision = rev(v.revision), paidSuggestionsMode = mode(v.paidSuggestionsMode);
    if (revision === 0 && (paidSuggestionsMode !== 'when_relevant' || v.updatedAt !== null || v.lastOperationId !== null))
        return fail();
    return Object.freeze({ ownerId: id(v.ownerId), companionId: id(v.companionId), paidSuggestionsMode, revision, updatedAt: revision === 0 ? null : at(v.updatedAt), lastOperationId: revision === 0 ? null : id(v.lastOperationId) });
}
export function parseCompanionPaidSettingsCommand(value: unknown): Readonly<CompanionPaidSettingsCommand> { const v = object(value, ['companionId', 'operationId', 'expectedRevision', 'paidSuggestionsMode']); return Object.freeze({ companionId: id(v.companionId), operationId: id(v.operationId), expectedRevision: rev(v.expectedRevision, 2147483646), paidSuggestionsMode: mode(v.paidSuggestionsMode) }); }
