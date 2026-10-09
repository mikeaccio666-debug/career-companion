import { parseTodayAgenda } from '@companion/platform-contracts';
import type { BoundPlatformClient } from './api.ts';
export type TodayAgendaClient = Pick<BoundPlatformClient, 'account' | 'isCurrent' | 'request' | 'subscribe'>;
export async function readTodayAgenda(client: TodayAgendaClient, signal?: AbortSignal) {
  if (!client.isCurrent()) throw Error('Account changed.');
  signal?.throwIfAborted();
  const view = parseTodayAgenda(await client.request('/today/agenda', { signal }));
  signal?.throwIfAborted();
  if (!client.isCurrent() || view.ownerId !== client.account.accountId) throw Error('Account changed.');
  return view;
}
