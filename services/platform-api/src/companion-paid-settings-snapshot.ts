import {createHash} from 'node:crypto';
import {careerRecordObject as object, parseCompanionPaidSettings, parseCompanionPaidSettingsCommand, type CompanionPaidSettingsCommand, type CompanionPaidSettings} from '@companion/platform-contracts';
import type {DataCrypto} from './data-crypto.ts';
import {ApiError} from './errors.ts';
const unavailable=()=>new ApiError(503,'PAID_SETTINGS_UNAVAILABLE','The saved preference could not be confirmed.');
export const paidSettingsCanonical = (v: unknown) => JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
export const paidSettingsDigest = (ownerId: string, command: CompanionPaidSettingsCommand) => createHash('sha256').update(paidSettingsCanonical({ ownerId, command })).digest('hex');
const canonical=paidSettingsCanonical,digest=paidSettingsDigest;
export interface PaidSettingsOperationRow {
 user_id:string;companion_id:string;operation_id:string;applied_revision:number;receipt_ciphertext:Buffer;created_at:Date;
}
export interface PaidSettingsRow {
 id:string;user_id:string;paid_suggestions_mode:string;paid_suggestions_revision:number;paid_suggestions_ciphertext:Buffer|null;
 paid_suggestions_operation_id:string|null;paid_suggestions_updated_at:Date|null;
}
export interface PaidSettingsReceipt {
    schemaVersion: 1;
    ownerId: string;
    command: Readonly<CompanionPaidSettingsCommand>;
    commandDigest: string;
    appliedRevision: number;
    acceptedAuthVersion: string;
    createdAt: string;
}

/** Shared authenticated decoders; no database reads, writes or current-model admission. */
export function decodePaidSettingsReceipt(crypto:DataCrypto|undefined,ownerId:string,row:PaidSettingsOperationRow):PaidSettingsReceipt {
        try {
            if(row.user_id!==ownerId)throw unavailable();
            const raw = crypto!.openUtf8(row.receipt_ciphertext, { table: 'platform_companion_paid_setting_operations', column: 'receipt_ciphertext', rowId: row.operation_id, ownerId: ownerId, revision: row.applied_revision });
            const v = object(JSON.parse(raw), ['schemaVersion', 'ownerId', 'command', 'commandDigest', 'appliedRevision', 'acceptedAuthVersion', 'createdAt']), command = parseCompanionPaidSettingsCommand(v.command);
            if (canonical(v) !== raw || v.schemaVersion !== 1 || v.ownerId !== ownerId || command.companionId !== row.companion_id || command.operationId !== row.operation_id || command.expectedRevision + 1 !== row.applied_revision || v.appliedRevision !== row.applied_revision || v.createdAt !== row.created_at.toISOString() || v.commandDigest !== digest(ownerId, command) || typeof v.acceptedAuthVersion !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v.acceptedAuthVersion))
                throw unavailable();
            return { ...v, command } as unknown as PaidSettingsReceipt;
        }
        catch {
            throw unavailable();
        }
}
export function decodePaidSettingsSnapshot(crypto:DataCrypto|undefined,ownerId:string,row:PaidSettingsRow,latest:PaidSettingsOperationRow|undefined):Readonly<CompanionPaidSettings> {
        if(row.user_id!==ownerId || latest && (latest.user_id!==ownerId || latest.companion_id!==row.id))throw unavailable();
        if (row.paid_suggestions_revision === 0) {
            if (latest || row.paid_suggestions_mode !== 'when_relevant' || row.paid_suggestions_ciphertext !== null || row.paid_suggestions_operation_id !== null || row.paid_suggestions_updated_at !== null)
                throw unavailable();
            return parseCompanionPaidSettings({ ownerId: ownerId, companionId: row.id, paidSuggestionsMode: 'when_relevant', revision: 0, updatedAt: null, lastOperationId: null });
        }
        try {
            if(!crypto || !row.paid_suggestions_ciphertext)throw unavailable();
            const raw = crypto.openUtf8(row.paid_suggestions_ciphertext, { table: 'platform_companions', column: 'paid_suggestions_ciphertext', rowId: row.id, ownerId: ownerId, revision: row.paid_suggestions_revision });
            const state = parseCompanionPaidSettings(JSON.parse(raw)), proof = latest ? decodePaidSettingsReceipt(crypto, ownerId, latest) : null;
            if (canonical(state) !== raw || state.ownerId !== ownerId || state.companionId !== row.id || state.revision !== row.paid_suggestions_revision || state.paidSuggestionsMode !== row.paid_suggestions_mode || state.updatedAt !== row.paid_suggestions_updated_at?.toISOString() || state.lastOperationId !== row.paid_suggestions_operation_id || !proof || proof.appliedRevision !== state.revision || proof.command.operationId !== state.lastOperationId || proof.command.paidSuggestionsMode !== state.paidSuggestionsMode || proof.createdAt !== state.updatedAt)
                throw unavailable();
            return state;
        }
        catch {
            throw unavailable();
        }
}
