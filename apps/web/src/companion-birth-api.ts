import { parseCompanionBirthCommand, parseCompanionBirthResult, parseCompanionBirthViewerState,
  parseCompanionBirthReceiptObservation, parseCompanionBirthIdempotencyKey,
  type CompanionBirthCommand } from '@companion/platform-contracts';
import type { BoundPlatformClient } from './api.ts';

export async function readCompanionBirth(client: BoundPlatformClient, signal?: AbortSignal) {
  return parseCompanionBirthViewerState(await client.request('/companion', { signal }));
}
export async function readCompanionBirthReceipt(client: BoundPlatformClient, key: string, signal?: AbortSignal) {
  const id = parseCompanionBirthIdempotencyKey(key);
  const result = parseCompanionBirthReceiptObservation(await client.request('/companion/birth/receipts/' + id, { signal }));
  if (result.kind === 'found' && result.receipt.idempotencyKey !== id) throw new Error('诞生记录暂时无法确认。');
  return result;
}
export async function saveCompanionBirth(client: BoundPlatformClient, value: CompanionBirthCommand, signal?: AbortSignal) {
  const command = parseCompanionBirthCommand(value.request, value.idempotencyKey);
  const result = parseCompanionBirthResult(await client.request('/companion/birth', {
    method: 'POST', headers: { 'Idempotency-Key': command.idempotencyKey }, body: JSON.stringify(command.request), signal,
  }));
  if (result.receipt.idempotencyKey !== command.idempotencyKey || result.receipt.identity.name !== command.request.name
    || result.receipt.identity.sealChar !== command.request.sealChar) throw new Error('诞生记录暂时无法确认。');
  return result;
}
