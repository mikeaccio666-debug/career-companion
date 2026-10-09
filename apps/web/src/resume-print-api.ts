import {parseResumeReviewItem,type ResumeReviewItem} from '@companion/platform-contracts';
import type {BoundPlatformClient} from './api.ts';
import {readResumeReview} from './resume-review-api.ts';

export async function readPrintableResume(client:BoundPlatformClient,basis:Readonly<ResumeReviewItem>,signal:AbortSignal):Promise<string>{
 const current=()=>{signal.throwIfAborted();if(!client.isCurrent())throw Error('账号已变化。');};
 current();
 const item=parseResumeReviewItem(basis);
 if(item.ownerId!==client.account.accountId||item.status!=='approved'||item.approvedRevision!==item.revision||item.approvedDigest!==item.payloadDigest)throw Error('请先确认这一版简历。');
 const fresh=await readResumeReview(client,item.id,signal);
 current();
 for(const key of ['id','ownerId','resumeVersionId','revision','generation','payloadDigest','status','resumeStatus','approvedRevision','approvedDigest'] as const){
  if(fresh.item[key]!==item[key])throw Error('版本已变化，请关闭预览，重新读取并核对。');
 }
 return fresh.payload.text;
}
