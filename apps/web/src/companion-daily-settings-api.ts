import { careerRecordObject as object, parseCompanionDailySettings, parseCompanionDailySettingsCommand, parseDailyPreferences, type CompanionDailySettingsResult } from '@companion/platform-contracts';
import type { BoundPlatformClient } from './api.ts';
export type DailySettingsClient = Pick<BoundPlatformClient, 'account' | 'request' | 'isCurrent' | 'subscribe'>;
const fail = (): never => { throw Error('每日时间设置尚未确认，请重新读取。'); };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function owned(client: DailySettingsClient, value: unknown) {
  const settings = parseCompanionDailySettings(value);
  if (!client.isCurrent() || settings.ownerId !== client.account.accountId) fail();
  return settings;
}
const path = '/companion/settings/daily';
export async function readDailySettings(client: DailySettingsClient, signal?: AbortSignal) {
  if (!client.isCurrent()) fail();
  const v = object(await client.request(path, { signal, cache: 'no-store' }), ['settings']);
  return owned(client, v.settings);
}
export async function changeDailySettings(client: DailySettingsClient, input: unknown, observe = false, signal?: AbortSignal): Promise<Readonly<CompanionDailySettingsResult>> {
  if (!client.isCurrent()) fail();
  const command = parseCompanionDailySettingsCommand(input);
  const v = object(await client.request(path + (observe ? '/operations/' + command.operationId : ''), observe ? { signal, cache: 'no-store' } : { method: 'PATCH', body: JSON.stringify(command), signal, cache: 'no-store' }), ['settings', 'operation']);
  const settings = owned(client, v.settings), op = object(v.operation, ['id', 'appliedRevision', 'preferences', 'replayed']);
  const preferences = parseDailyPreferences(op.preferences);
  if (settings.companionId !== command.companionId || op.id !== command.operationId || op.appliedRevision !== command.expectedRevision + 1 || !same(preferences, command.preferences) || typeof op.replayed !== 'boolean' || observe && !op.replayed || settings.revision < (op.appliedRevision as number)) fail();
  if (!op.replayed && settings.revision !== op.appliedRevision) fail();
  if (settings.revision === op.appliedRevision && (settings.lastOperationId !== op.id || !same(settings.preferences, command.preferences))) fail();
  return Object.freeze({ settings, operation: Object.freeze({ id: command.operationId, appliedRevision: op.appliedRevision as number, preferences, replayed: op.replayed as boolean }) });
}
