import {
  ASSISTANT_COMMERCE_PATHS,
  getAssistantCoverDraft,
  getRecommendationBatch,
  getRecommendationItemDetail,
  getResumeLibrary,
  listApplicationPreparations,
  listResumeSelectionOptions,
  parseAssistantCommerceRequest,
  parseAssistantCommerceResponse,
  retryApplicationPreparation,
  startApplicationPreparations,
  type AssistantCommerceCode,
  type AssistantCommerceRequest,
  type AssistantCommerceResult,
  writeAssistantCoverDraft,
} from '@edaix/contracts';
import type { OwnerProfileWriterInput } from '../profile/owner-writer';
import { boundedJson,exactOrigin } from '../session/owner-reader';
import { sameSession,type SessionIdentity } from '../session/read-ports';

/** Fixed owner APIs only. The renderer never receives a token or supplies an endpoint. */
export function createOwnerCommerce(input:OwnerProfileWriterInput) {
  const origin=input.enabled===true ? exactOrigin(input.apiBase) : null,fetchFn=input.fetchFn??fetch;
  return { async execute(identity:SessionIdentity,raw:AssistantCommerceRequest,caller:AbortSignal,admitted:()=>Promise<boolean>):Promise<AssistantCommerceResult> {
    const command=parseAssistantCommerceRequest(raw);
    const fail=(code:AssistantCommerceCode):AssistantCommerceResult=>({operation:raw.operation,ok:false,code});
    if (!command) return fail('VALIDATION_FAILED');
    if (!origin) return fail('DISABLED');
    const signal=AbortSignal.any([caller,AbortSignal.timeout(command.operation==='COVER_WRITE' && command.request.operation==='GENERATE'?90_000:12_000)]); let submitted=false;
    const check=async():Promise<AssistantCommerceCode|null>=> {
      if (signal.aborted) return submitted?'SAVE_UNCERTAIN':'CANCELLED';
      if (!await admitted()) return 'SENDER_REJECTED';
      const current=await input.currentSession();
      if (!current) return 'LOGIN_REQUIRED';
      return sameSession(identity,current)?null:'OWNER_CHANGED';
    };
    try {
      const first=await check();if(first)return fail(first);
      const token=await input.accessToken();if(!token)return fail('LOGIN_REQUIRED');
      const next=await check();if(next)return fail(next);
      const route=endpoint(command);submitted=route.body!==undefined;
      const response=await fetchFn(new URL(route.path,origin).href,{method:submitted?'POST':'GET',signal,credentials:'omit',cache:'no-store',redirect:'error',
        headers:{accept:'application/json',authorization:`Bearer ${token}`,...(submitted?{'content-type':'application/json'}:{})},
        ...(submitted?{body:JSON.stringify(route.body)}:{})});
      const decoded=await boundedJson(response),after=await check();if(after)return fail(after);
      if (!response.ok) {
        const error=decoded.ok && decoded.value && typeof decoded.value==='object' ? decoded.value as {code?:unknown}:{};
        if(response.status===401)return fail('LOGIN_REQUIRED');
        if(error.code==='RATE_LIMITED')return fail('RATE_LIMITED');
        if(error.code==='USAGE_EXHAUSTED')return fail('USAGE_EXHAUSTED');
        if(['RESUME_VERSION_STALE','JOB_UNAVAILABLE','VERSION_NOT_READY'].includes(String(error.code)))return fail('SOURCE_CHANGED');
        if(response.status===402 || response.status===403)return fail('LOCKED');
        if(response.status===404)return fail('NOT_FOUND');
        if(response.status===409)return fail('REVISION_CONFLICT');
        if(response.status===400)return fail('VALIDATION_FAILED');
        return fail(submitted?'SAVE_UNCERTAIN':'UNAVAILABLE');
      }
      const result=decoded.ok?parseAssistantCommerceResponse({kind:'assistant/commerce-result-v1',id:command.id,operation:command.operation,ok:true,value:decoded.value}):null;
      if(!result?.ok)return fail('RESPONSE_MALFORMED');
      if((command.operation==='JOBS_LIST'||command.operation==='JOBS_DELIVER') && (result.operation==='JOBS_LIST'||result.operation==='JOBS_DELIVER')) {
        const role=command.operation==='JOBS_LIST'?command.query.conversationId:command.request.conversationId;
        if(result.value.entries.some(entry=>entry.conversationId!==role || command.operation==='JOBS_LIST' && command.query.state!==undefined && entry.state!==command.query.state))return fail('RESPONSE_MALFORMED');
      }
      if(command.operation==='JOB_DECIDE' && result.operation==='JOB_DECIDE' && result.value.entry.id!==command.entryId)return fail('RESPONSE_MALFORMED');
      if(command.operation==='JOB_DETAIL' && result.operation==='JOB_DETAIL' && (result.value.item.batchId!==command.batchId||result.value.item.itemId!==command.itemId))return fail('RESPONSE_MALFORMED');
      if(command.operation==='ATS_LOOKUP' && result.operation==='ATS_LOOKUP' && result.value.report && (result.value.report.entryId!==command.request.entryId||result.value.report.resumeVersionId!==command.request.resumeVersionId))return fail('RESPONSE_MALFORMED');
      if(command.operation==='ATS_START' && result.operation==='ATS_START' && (result.value.entryId!==command.request.entryId||result.value.resumeVersionId!==command.request.resumeVersionId))return fail('RESPONSE_MALFORMED');
      if(command.operation==='ATS_GET' && result.operation==='ATS_GET' && (result.value.id!==command.reportId||result.value.entryId!==command.entryId))return fail('RESPONSE_MALFORMED');
      if(command.operation==='PREPARATION_BATCH' && result.operation==='PREPARATION_BATCH' && result.value.batch.id!==command.batchId)return fail('RESPONSE_MALFORMED');
      if((command.operation==='PREPARATION_LIST'||command.operation==='PREPARATION_START'||command.operation==='PREPARATION_RETRY') &&
        (result.operation==='PREPARATION_LIST'||result.operation==='PREPARATION_START'||result.operation==='PREPARATION_RETRY') && result.value.batchId!==command.batchId)return fail('RESPONSE_MALFORMED');
      if((command.operation==='COVER_READ'||command.operation==='COVER_WRITE')&&(result.operation==='COVER_READ'||result.operation==='COVER_WRITE')&&result.value.entryId!==command.entryId)return fail('RESPONSE_MALFORMED');
      return result;
    } catch { return fail(caller.aborted?(submitted?'SAVE_UNCERTAIN':'CANCELLED'):submitted?'SAVE_UNCERTAIN':'UNAVAILABLE'); }
  }};
}
function endpoint(command:AssistantCommerceRequest):{path:string;body?:unknown} {
  const paths=ASSISTANT_COMMERCE_PATHS;
  switch(command.operation) {
    case 'COVER_READ':return {path:getAssistantCoverDraft.path.replace(':entryId',command.entryId)};
    case 'COVER_WRITE':return {path:writeAssistantCoverDraft.path.replace(':entryId',command.entryId),body:command.request};
    case 'RESUME_LIBRARY':return {path:getResumeLibrary.path};
    case 'RESUME_SELECTION':return {path:listResumeSelectionOptions.path};
    case 'PREPARATION_BATCH':return {path:getRecommendationBatch.path.replace(':batchId',command.batchId)};
    case 'PREPARATION_LIST':return {path:listApplicationPreparations.path.replace(':batchId',command.batchId)};
    case 'PREPARATION_START':return {path:startApplicationPreparations.path.replace(':batchId',command.batchId),body:command.request};
    case 'PREPARATION_RETRY':return {path:retryApplicationPreparation.path.replace(':batchId',command.batchId).replace(':preparationId',command.preparationId),body:command.request};
    case 'USAGE':return {path:paths.usage};
    case 'JOBS_BATCHES':return {path:`${paths.jobs}/batches?${new URLSearchParams({conversationId:command.conversationId})}`};
    case 'JOBS_LIST':return {path:`${paths.jobs}?${new URLSearchParams({...command.query})}`};
    case 'JOBS_DELIVER':return {path:`${paths.jobs}/deliver`,body:command.request};
    case 'JOB_DECIDE':return {path:`${paths.jobs}/${command.entryId}/decision`,body:command.request};
    case 'JOB_DETAIL':return {path:getRecommendationItemDetail.path.replace(':batchId',command.batchId).replace(':itemId',command.itemId)};
    case 'ATS_LOOKUP':return {path:`${paths.ats}?${new URLSearchParams({...command.request})}`};
    case 'ATS_START':return {path:paths.ats,body:command.request};
    case 'ATS_GET':return {path:`${paths.ats}/${command.reportId}?${new URLSearchParams({entryId:command.entryId})}`};
  }
}
