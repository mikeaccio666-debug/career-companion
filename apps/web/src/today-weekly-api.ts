import { parseTodayWeeklyActivity } from '@companion/platform-contracts';
import type { BoundPlatformClient } from './api.ts';
export type TodayWeeklyClient = Pick<BoundPlatformClient,'account'|'isCurrent'|'request'|'subscribe'>;
export async function readTodayWeekly(client:TodayWeeklyClient,signal?:AbortSignal){
 if(!client.isCurrent())throw Error('Account changed.');signal?.throwIfAborted();
 const view=parseTodayWeeklyActivity(await client.request('/today/weekly',{signal}));
 signal?.throwIfAborted();
 if(!client.isCurrent()||view.ownerId!==client.account.accountId)throw Error('Account changed.');
 return view;
}
