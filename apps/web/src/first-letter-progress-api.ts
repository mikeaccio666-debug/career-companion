import {careerRecordId,parseFirstLetterProgress} from '@companion/platform-contracts';
import type {BoundPlatformClient} from './api.ts';
export async function readFirstLetterProgress(client:Pick<BoundPlatformClient,'account'|'isCurrent'|'request'>,
 companionId:string,welcomeId:string,signal?:AbortSignal){
 const companion=careerRecordId(companionId),welcome=careerRecordId(welcomeId);
 if(!client.isCurrent())throw Error('Account changed.');signal?.throwIfAborted();
 const result=parseFirstLetterProgress(await client.request('/companion/first-letter/progress',{signal}));
 signal?.throwIfAborted();
 if(!client.isCurrent()||result.ownerId!==client.account.accountId||result.companionId!==companion||result.welcomeId!==welcome)
  throw Error('Letter context changed.');
 return result;
}
