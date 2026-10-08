import { parseResumeReviewPayload,type ResumeReviewItem,type ResumeReviewAction,type ResumeReviewStatus } from '@companion/platform-contracts';
/** Only explicit owner-authored original text. Model claims and arbitrary
 * source references cannot enter this adapter; expert drafts need their own
 * full claim/source validator and authenticated origin before saving. */
export const validateOwnerResumePayload=parseResumeReviewPayload;
export function ownerResumeActionAllowed(item:Readonly<ResumeReviewItem>,action:Exclude<ResumeReviewAction,'create'>):boolean{
 switch(action){
  case 'edit':case 'decline':return item.status==='pending';
  case 'approve':return item.status==='pending'||item.status==='approved';
  case 'reopen':return item.status==='expired';
  case 'archive':return item.status==='approved'&&item.resumeStatus==='active';
  case 'delete':return true;
 }
}
export const RESUME_PENDING_PRESENTATION:Readonly<Record<ResumeReviewStatus,{label:string;tone:'pending'|'done'|'neutral'|'quiet'}>>=Object.freeze({
 pending:Object.freeze({label:'等你确认',tone:'pending'}),approved:Object.freeze({label:'已确认 · 可以用了',tone:'done'}),
 declined:Object.freeze({label:'不要了',tone:'neutral'}),expired:Object.freeze({label:'过期了',tone:'quiet'}),superseded:Object.freeze({label:'已被替换',tone:'quiet'}),
});
