import { parseIsoDateTime, parseUuid } from './common.ts';
/** A private editable draft, never a granted attachment or generated-evidence authority. */
export type AssistantCoverDraftRequest = { readonly clientRequestId:string; readonly expectedRevision:number } & (
  | { readonly operation:'SAVE'; readonly body:string }
  | { readonly operation:'DELETE' }
  | { readonly operation:'GENERATE'; readonly unknownRequirementChoice:'GENERATE' });
export interface AssistantCoverDraftResponse {
  readonly schemaVersion:1; readonly entryId:string; readonly revision:number;
  readonly unavailableReason?:'CONTENT_UNAVAILABLE';
  readonly draft:null | { readonly id:string; readonly body:string; readonly updatedAt:string; readonly origin:'USER_EDITED'|'GENERATED'; readonly deliveryAuthorized:false };
}
export function parseAssistantCoverDraftRequest(value:unknown):AssistantCoverDraftRequest|null {
  if(!record(value) || !parseUuid(value.clientRequestId) || !revision(value.expectedRevision))return null;
  const base=['clientRequestId','expectedRevision','operation'];
  if(value.operation==='DELETE' && exact(value,base))return value as unknown as AssistantCoverDraftRequest;
  if(value.operation==='SAVE' && exact(value,[...base,'body']) && body(value.body))return value as unknown as AssistantCoverDraftRequest;
  if(value.operation==='GENERATE' && exact(value,[...base,'unknownRequirementChoice']) && value.unknownRequirementChoice==='GENERATE')return value as unknown as AssistantCoverDraftRequest;
  return null;
}
export function parseAssistantCoverDraftResponse(value:unknown):AssistantCoverDraftResponse|null {
  if(!record(value)||!exact(value,['schemaVersion','entryId','revision','draft',...(Object.hasOwn(value,'unavailableReason')?['unavailableReason']:[])])||value.schemaVersion!==1||!parseUuid(value.entryId)||!revision(value.revision))return null;
  if(Object.hasOwn(value,'unavailableReason')&&(value.unavailableReason!=='CONTENT_UNAVAILABLE'||value.draft!==null||value.revision===0))return null;
  const d=value.draft;
  if(d!==null && (!record(d)||!exact(d,['id','body','updatedAt','origin','deliveryAuthorized'])||!parseUuid(d.id)||!body(d.body)||!parseIsoDateTime(d.updatedAt)||
    !['USER_EDITED','GENERATED'].includes(String(d.origin))||d.deliveryAuthorized!==false||value.revision===0))return null;
  return value as unknown as AssistantCoverDraftResponse;
}
function body(v:unknown):v is string{return typeof v==='string'&&v.trim().length>0&&new TextEncoder().encode(v).length<=12000&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v);}
function revision(v:unknown):v is number{return Number.isSafeInteger(v)&&Number(v)>=0;}
function record(v:unknown):v is Record<string,unknown>{return !!v&&typeof v==='object'&&!Array.isArray(v);}
function exact(v:Record<string,unknown>,keys:string[]):boolean{return Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));}
