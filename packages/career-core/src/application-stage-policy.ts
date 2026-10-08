import {parseApplicationStageChoice,parseApplicationStageState,type ApplicationStageState} from '@companion/platform-contracts';

export interface ApplicationStagePlan {
 readonly previous:Readonly<ApplicationStageState>;
 readonly next:Readonly<ApplicationStageState>;
 readonly changed:boolean;
 /** Persist the source event and restriction atomically; this is not a reply. */
 readonly postRejection:{readonly kind:'post_rejection';readonly until:string}|null;
}
/** Product 05 sections 2.7 and 3.1. No model, browser, clock or authorization. */
export function applicationNeedsPostRejection(value:unknown):boolean{
 const state=parseApplicationStageState(value);
 return state.stage==='closed'&&(state.closedReason==='not_advanced'||state.closedReason==='rescinded')
  &&(state.closedAtStage==='oa'||state.closedAtStage==='interview'||state.closedAtStage==='offer');
}
/** Pure planning only. The writer supplies its actual database timestamp and
 * preserves original events. A plan does not permit a user or receipt to write. */
export function planApplicationStageChange(current:unknown,choice:unknown,at:unknown):Readonly<ApplicationStagePlan>{
 const previous=parseApplicationStageState(current),intent=parseApplicationStageChoice(choice);
 if(typeof at!=='string'||!Number.isFinite(Date.parse(at))||new Date(at).toISOString()!==at)throw new Error('Use the actual canonical stage-change timestamp.');
 const next=parseApplicationStageState({stage:intent.stage,
  closedReason:intent.stage==='closed'?intent.closedReason:null,
  closedAtStage:intent.stage==='closed'?(previous.stage==='closed'?previous.closedAtStage:previous.stage):null,
  offerState:intent.stage==='offer'?intent.offerState:null,
  // A choice cannot invent submission provenance. The authenticated write or
  // genuine receipt channel must supply that independently when applicable.
  submittedVia:intent.stage==='saved'?null:previous.submittedVia});
 const changed=JSON.stringify(previous)!==JSON.stringify(next);
 const postRejection=changed&&applicationNeedsPostRejection(next)&&!applicationNeedsPostRejection(previous)
  ?Object.freeze({kind:'post_rejection' as const,until:new Date(Date.parse(at)+48*60*60*1000).toISOString()}):null;
 return Object.freeze({previous,next,changed,postRejection});
}
