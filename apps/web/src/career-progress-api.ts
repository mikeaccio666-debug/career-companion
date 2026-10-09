import { parseCareerProgressSnapshot } from '@companion/platform-contracts';
import type { BoundPlatformClient } from './api.ts';
export type CareerProgressClient = Pick<BoundPlatformClient, 'account' | 'isCurrent' | 'request' | 'subscribe'>;
export async function readCareerProgress(client: CareerProgressClient, signal?: AbortSignal) {
    if (!client.isCurrent()) throw Error('Account changed.');
    signal?.throwIfAborted();
    const value = parseCareerProgressSnapshot(await client.request('/career/progress', { signal }));
    signal?.throwIfAborted();
    if (!client.isCurrent() || value.ownerId !== client.account.accountId) throw Error('Account changed.');
    return value;
}
