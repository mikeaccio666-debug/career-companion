import { careerRecordObject as object, parseCompanionPaidSettings, parseCompanionPaidSettingsCommand, type CompanionPaidSettingsResult } from '@companion/platform-contracts';
import type { BoundPlatformClient } from './api.ts';
export type PaidSettingsClient = Pick<BoundPlatformClient, 'account' | 'request' | 'isCurrent' | 'subscribe'>;
const fail = (): never => { throw Error('付费建议设置尚未确认，请重新读取。'); };
function owned(client: PaidSettingsClient, value: unknown) { const settings = parseCompanionPaidSettings(value); if (!client.isCurrent() || settings.ownerId !== client.account.accountId)
    fail(); return settings; }
export async function readPaidSettings(client: PaidSettingsClient, signal?: AbortSignal) { if (!client.isCurrent())
    fail(); const v = object(await client.request('/companion/settings', { signal }), ['settings']); return owned(client, v.settings); }
export async function changePaidSettings(client: PaidSettingsClient, input: unknown, observe = false, signal?: AbortSignal): Promise<Readonly<CompanionPaidSettingsResult>> {
    if (!client.isCurrent())
        fail();
    const command = parseCompanionPaidSettingsCommand(input);
    const v = object(await client.request('/companion/settings' + (observe ? '/operations/' + command.operationId : ''), observe ? { signal } : { method: 'PATCH', body: JSON.stringify(command), signal }), ['settings', 'operation']);
    const settings = owned(client, v.settings), op = object(v.operation, ['id', 'appliedRevision', 'paidSuggestionsMode', 'replayed']);
    if (settings.companionId !== command.companionId || op.id !== command.operationId || op.appliedRevision !== command.expectedRevision + 1 || op.paidSuggestionsMode !== command.paidSuggestionsMode || typeof op.replayed !== 'boolean' || observe && !op.replayed || settings.revision < (op.appliedRevision as number))
        fail();
    if (!op.replayed && (settings.revision !== op.appliedRevision || settings.lastOperationId !== op.id || settings.paidSuggestionsMode !== command.paidSuggestionsMode))
        fail();
    return Object.freeze({ settings, operation: Object.freeze({ id: command.operationId, appliedRevision: op.appliedRevision as number, paidSuggestionsMode: command.paidSuggestionsMode, replayed: op.replayed as boolean }) });
}
