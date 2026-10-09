import { careerRecordObject as object, parseTodayRestSettings, parseTodayRestCommand, parseTodayRestChoice, type TodayRestResult } from '@companion/platform-contracts';
import type { BoundPlatformClient } from './api.ts';
export type TodayRestClient = Pick<BoundPlatformClient, 'account' | 'request' | 'isCurrent' | 'subscribe'>;
const fail = (): never => { throw Error('休息安排尚未确认，请重新读取。'); };
function owned(client: TodayRestClient, value: unknown) {
  const settings = parseTodayRestSettings(value);
  if (!client.isCurrent() || settings.ownerId !== client.account.accountId) fail();
  return settings;
}
const path = '/today/pause';
export async function readTodayRest(client: TodayRestClient, signal?: AbortSignal) {
  if (!client.isCurrent()) fail();
  const v = object(await client.request(path, { signal, cache: 'no-store' }), ['settings']);
  return owned(client, v.settings);
}
export async function changeTodayRest(client: TodayRestClient, input: unknown, observe = false, signal?: AbortSignal): Promise<Readonly<TodayRestResult>> {
  if (!client.isCurrent()) fail();
  const command = parseTodayRestCommand(input);
  const v = object(await client.request(path + (observe ? '/operations/' + command.operationId : ''), observe ? { signal, cache: 'no-store' } : { method: 'POST', body: JSON.stringify(command), signal, cache: 'no-store' }), ['settings', 'operation']);
  const settings = owned(client, v.settings), op = object(v.operation, ['id', 'appliedRevision', 'choice', 'replayed']);
  const choice = parseTodayRestChoice(op.choice);
  if (settings.companionId !== command.companionId || op.id !== command.operationId || op.appliedRevision !== command.expectedRevision + 1 || choice !== command.choice || typeof op.replayed !== 'boolean' || observe && !op.replayed || settings.revision < (op.appliedRevision as number)) fail();
  if (!op.replayed && settings.revision !== op.appliedRevision) fail();
  if (settings.revision === op.appliedRevision && (settings.lastOperationId !== op.id)) fail();
  if (settings.revision === op.appliedRevision) {
    if (choice === 'today' && !settings.optedOutUntil || choice === 'reminders_off' && settings.reminders !== 'off'
      || ['1_day','3_days','7_days'].includes(choice) && !settings.pauseUntil) fail();
  }
  return Object.freeze({ settings, operation: Object.freeze({ id: command.operationId, appliedRevision: op.appliedRevision as number, choice, replayed: op.replayed as boolean }) });
}
