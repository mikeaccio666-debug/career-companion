import { careerRecordId,careerRecordObject } from './career-record-values.ts';

// Values and neutral wording follow product 05 section 3.1.
export const APPLICATION_OPEN_STAGES=Object.freeze(['saved','applied','oa','interview','offer'] as const);
export const APPLICATION_STAGES=Object.freeze([...APPLICATION_OPEN_STAGES,'closed'] as const);
export const APPLICATION_CLOSE_REASONS=Object.freeze(['not_advanced','withdrawn','role_closed','no_response','declined','rescinded'] as const);
export const APPLICATION_OFFER_STATES=Object.freeze(['verbal','written','accepted','declined','expired'] as const);
export const APPLICATION_SUBMISSION_CHANNELS=Object.freeze(['user_sends','extension','in_product'] as const);
export type ApplicationOpenStage=typeof APPLICATION_OPEN_STAGES[number];
export type ApplicationStage=typeof APPLICATION_STAGES[number];
export type ApplicationCloseReason=typeof APPLICATION_CLOSE_REASONS[number];
export type ApplicationOfferState=typeof APPLICATION_OFFER_STATES[number];
export type ApplicationSubmissionChannel=typeof APPLICATION_SUBMISSION_CHANNELS[number];
export const APPLICATION_STAGE_LABELS=Object.freeze({saved:'收藏',applied:'已投',oa:'OA',interview:'面试',offer:'Offer',closed:'已结束'} satisfies Record<ApplicationStage,string>);
export const APPLICATION_CLOSE_REASON_LABELS=Object.freeze({not_advanced:'这一轮没走下去',withdrawn:'我决定不继续',role_closed:'岗位关闭',no_response:'一直没有回音',declined:'我没有接受这份 offer',rescinded:'这份 offer 没有继续'} satisfies Record<ApplicationCloseReason,string>);
export const APPLICATION_OFFER_STATE_LABELS=Object.freeze({verbal:'口头',written:'书面',accepted:'已接受',declined:'未接受',expired:'已过答复期'} satisfies Record<ApplicationOfferState,string>);

/** A state description, never a verified submission receipt or execution grant. */
export interface ApplicationStageState {
 readonly stage:ApplicationStage;
 readonly closedReason:ApplicationCloseReason|null;
 readonly closedAtStage:ApplicationOpenStage|null;
 readonly offerState:ApplicationOfferState|null;
 readonly submittedVia:ApplicationSubmissionChannel|null;
}
export type ApplicationStageChoice=
 | {readonly stage:'closed';readonly closedReason:ApplicationCloseReason}
 | {readonly stage:'offer';readonly offerState:ApplicationOfferState}
 | {readonly stage:Exclude<ApplicationOpenStage,'offer'>};
export type ApplicationStageCommand=ApplicationStageChoice&{readonly operationId:string;readonly expectedRevision:number};
function fail():never{throw new Error('The application stage could not be confirmed.');}
function enumValue<T extends string>(value:unknown,values:readonly T[]):T{if(typeof value!=='string'||!values.includes(value as T))return fail();return value as T;}
/** Only owner intent. Server must derive closedAtStage and provenance itself. */
export function parseApplicationStageChoice(value:unknown):Readonly<ApplicationStageChoice>{
 const v=careerRecordObject(value,['stage'],['closedReason','offerState']);
 const stage=enumValue(v.stage,APPLICATION_STAGES);
 if(stage==='closed'){
  if(!Object.hasOwn(v,'closedReason')||Object.hasOwn(v,'offerState'))return fail();
  return Object.freeze({stage,closedReason:enumValue(v.closedReason,APPLICATION_CLOSE_REASONS)});
 }
 if(stage==='offer'){
  if(!Object.hasOwn(v,'offerState')||Object.hasOwn(v,'closedReason'))return fail();
  return Object.freeze({stage,offerState:enumValue(v.offerState,APPLICATION_OFFER_STATES)});
 }
 if(Object.hasOwn(v,'closedReason')||Object.hasOwn(v,'offerState'))return fail();
 return Object.freeze({stage});
}
export function parseApplicationStageCommand(value:unknown):Readonly<ApplicationStageCommand>{
 const v=careerRecordObject(value,['operationId','expectedRevision','stage'],['closedReason','offerState']);
 const operationId=careerRecordId(v.operationId),expectedRevision=v.expectedRevision;
 if(typeof expectedRevision!=='number'||!Number.isSafeInteger(expectedRevision)||Object.is(expectedRevision,-0)||expectedRevision<1||expectedRevision>2147483647)return fail();
 const {operationId:_id,expectedRevision:_revision,...choice}=v;
 return Object.freeze({...parseApplicationStageChoice(choice),operationId,expectedRevision});
}
export function parseApplicationStageState(value:unknown):Readonly<ApplicationStageState>{
 const v=careerRecordObject(value,['stage','closedReason','closedAtStage','offerState','submittedVia']);
 const stage=enumValue(v.stage,APPLICATION_STAGES);
 const closedReason=stage==='closed'?enumValue(v.closedReason,APPLICATION_CLOSE_REASONS):null;
 const closedAtStage=stage==='closed'?enumValue(v.closedAtStage,APPLICATION_OPEN_STAGES):null;
 const offerState=stage==='offer'?enumValue(v.offerState,APPLICATION_OFFER_STATES):null;
 if(stage!=='closed'&&(v.closedReason!==null||v.closedAtStage!==null)||stage!=='offer'&&v.offerState!==null)return fail();
 const submittedVia=v.submittedVia===null?null:enumValue(v.submittedVia,APPLICATION_SUBMISSION_CHANNELS);
 // The optional channel describes provenance; null means no channel asserted.
 // It cannot turn a saved job into an actual submitted application.
 if(stage==='saved'&&submittedVia!==null)return fail();
 return Object.freeze({stage,closedReason,closedAtStage,offerState,submittedVia});
}
