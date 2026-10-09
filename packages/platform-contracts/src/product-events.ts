import { FEEDBACK_CATEGORIES,type FeedbackCategory } from './product-feedback.ts';
import { careerRecordObject } from './career-record-values.ts';
import { APPLICATION_STAGES, APPLICATION_CLOSE_REASONS, type ApplicationStage, type ApplicationCloseReason } from './application-stages.ts';

/** Implemented event whitelist from product 07 §7.5. Never a free-form analytics payload. */
export type ProductEvent =
 | Readonly<{event:'feedback_submitted';props:Readonly<{category:FeedbackCategory}>}>
 | Readonly<{event:'application_stage_changed';props:Readonly<{from_stage:ApplicationStage;to_stage:ApplicationStage;closed_reason:ApplicationCloseReason|'none'}>}>
 | Readonly<{event:'story_saved';props:Readonly<{source:'user_entered'}>}>
 | Readonly<{event:'resume_version_created';props:Readonly<{source:'paste'|'upload'|'derived'}>}>;
export const PRODUCT_EVENT_NAMES=Object.freeze(['application_stage_changed','story_saved','resume_version_created','feedback_submitted'] as const);
const fail=():never=>{throw Error('Unsupported product event.');};
function choice<T extends string>(v:unknown,values:readonly T[]):T{if(typeof v!=='string'||!values.includes(v as T))return fail();return v as T;}
export function parseProductEvent(value:unknown):ProductEvent {
 try {
  const v=careerRecordObject(value,['event','props']);
  if(v.event==='feedback_submitted'){const p=careerRecordObject(v.props,['category']);return Object.freeze({event:v.event,props:Object.freeze({category:choice(p.category,FEEDBACK_CATEGORIES)})});}
  if(v.event==='application_stage_changed'){
   const p=careerRecordObject(v.props,['from_stage','to_stage','closed_reason']);
   const from_stage=choice(p.from_stage,APPLICATION_STAGES),to_stage=choice(p.to_stage,APPLICATION_STAGES);
   const closed_reason=choice(p.closed_reason,[...APPLICATION_CLOSE_REASONS,'none'] as const);
   if((to_stage==='closed')===(closed_reason==='none'))return fail();
   return Object.freeze({event:v.event,props:Object.freeze({from_stage,to_stage,closed_reason})});
  }
  const p=careerRecordObject(v.props,['source']);
  if(v.event==='story_saved')return Object.freeze({event:v.event,props:Object.freeze({source:choice(p.source,['user_entered'] as const)})});
  if(v.event==='resume_version_created')return Object.freeze({event:v.event,props:Object.freeze({source:choice(p.source,['paste','upload','derived'] as const)})});
  return fail();
 } catch {return fail();}
}
