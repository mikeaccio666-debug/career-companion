import { parseAssistantCoverDraftRequest,parseAssistantCoverDraftResponse,type AssistantCoverDraftRequest,type AssistantCoverDraftResponse } from './assistantCoverDraft.ts';
import { parseResumeLibrarySnapshotV1,type ResumeLibrarySnapshotV1 } from './resumeLibrary.ts';
import { parseStartApplicationPreparationsRequest, parseRetryApplicationPreparationRequest, parseApplicationPreparationsResponse,
  type StartApplicationPreparationsRequest, type RetryApplicationPreparationRequest, type ApplicationPreparationsResponse } from './applicationPreparations.ts';
import { parseListResumeSelectionOptionsResponseV1, type ListResumeSelectionOptionsResponseV1 } from './resumeSelection.ts';
import { parseGetRecommendationBatchResponse, type GetRecommendationBatchResponse } from './recommendations.ts';
import { parseUuid, type Uuid } from './common.ts';
import { ASSISTANT_ROLE_CODES } from './assistantRoles.ts';
import { parseCommercialUsageResponse, type CommercialUsageResponse } from './commercial-usage.ts';
import { parseAssistantJobBatchesResponse, parseAssistantJobDecisionRequest, parseAssistantJobResponse, parseAssistantJobsDeliveryRequest,
  parseAssistantJobsQuery, parseAssistantJobsResponse, type AssistantJobBatchesResponse, type AssistantJobDecisionRequest,
  type AssistantJobResponse, type AssistantJobsDeliveryRequest, type AssistantJobsQuery, type AssistantJobsResponse } from './assistant-jobs.ts';
import { parseAtsReportLookupResponse, type AtsReportLookupResponse, parseAtsReportRequest, parseAtsReportResponse, type AtsReportRequest, type AtsReportResponse } from './ats-reports.ts';
import { parseGetRecommendationItemDetailResponse, type GetRecommendationItemDetailResponse } from './recommendations.ts';
import { parseJobCardView } from './job-card.ts';
export const ASSISTANT_COMMERCE_PATHS = { jobs:'/api/v1/agent/assistant/jobs',ats:'/api/v1/agent/assistant/ats-reports',usage:'/payments/commercial/usage' } as const;
export const ASSISTANT_COMMERCE_CODES = [...ASSISTANT_ROLE_CODES,'USAGE_EXHAUSTED','SOURCE_CHANGED','RATE_LIMITED'] as const;
export type AssistantCommerceCode = typeof ASSISTANT_COMMERCE_CODES[number];
export type AssistantCommerceCommand =
  | { readonly operation:'COVER_READ';readonly entryId:string }
  | { readonly operation:'COVER_WRITE';readonly entryId:string;readonly request:AssistantCoverDraftRequest }
  | { readonly operation:'RESUME_LIBRARY' }
  | { readonly operation:'RESUME_SELECTION' }
  | { readonly operation:'PREPARATION_BATCH'; readonly batchId:string }
  | { readonly operation:'PREPARATION_LIST'; readonly batchId:string }
  | { readonly operation:'PREPARATION_START'; readonly batchId:string; readonly request:StartApplicationPreparationsRequest }
  | { readonly operation:'PREPARATION_RETRY'; readonly batchId:string; readonly preparationId:string; readonly request:RetryApplicationPreparationRequest }
  | { readonly operation:'USAGE' }
  | { readonly operation:'JOBS_BATCHES';readonly conversationId:string }
  | { readonly operation:'JOBS_LIST';readonly query:AssistantJobsQuery }
  | { readonly operation:'JOBS_DELIVER';readonly request:AssistantJobsDeliveryRequest }
  | { readonly operation:'JOB_DECIDE';readonly entryId:string;readonly request:AssistantJobDecisionRequest }
  | { readonly operation:'JOB_DETAIL';readonly batchId:string;readonly itemId:string }
  | { readonly operation:'ATS_LOOKUP';readonly request:AtsReportRequest }
  | { readonly operation:'ATS_START';readonly request:AtsReportRequest }
  | { readonly operation:'ATS_GET';readonly reportId:string;readonly entryId:string };
export interface AssistantCommerceValues {
  COVER_READ:AssistantCoverDraftResponse;COVER_WRITE:AssistantCoverDraftResponse;RESUME_LIBRARY:ResumeLibrarySnapshotV1;
  RESUME_SELECTION:ListResumeSelectionOptionsResponseV1; PREPARATION_BATCH:GetRecommendationBatchResponse; PREPARATION_LIST:ApplicationPreparationsResponse; PREPARATION_START:ApplicationPreparationsResponse; PREPARATION_RETRY:ApplicationPreparationsResponse;
  USAGE:CommercialUsageResponse; JOBS_BATCHES:AssistantJobBatchesResponse; JOBS_LIST:AssistantJobsResponse; JOBS_DELIVER:AssistantJobsResponse;
  JOB_DECIDE:AssistantJobResponse; JOB_DETAIL:GetRecommendationItemDetailResponse; ATS_LOOKUP:AtsReportLookupResponse; ATS_START:AtsReportResponse; ATS_GET:AtsReportResponse;
}
export type AssistantCommerceOperation = keyof AssistantCommerceValues;
export type AssistantCommerceRequest = AssistantCommerceCommand & { readonly kind:'assistant/commerce-request-v1';readonly id:Uuid };
export type AssistantCommerceResult = {[K in AssistantCommerceOperation]: {readonly operation:K} & (
  {readonly ok:true;readonly value:AssistantCommerceValues[K]} | {readonly ok:false;readonly code:AssistantCommerceCode})}[AssistantCommerceOperation];
export type AssistantCommerceResponse = AssistantCommerceResult & {readonly kind:'assistant/commerce-result-v1';readonly id:Uuid};
export function parseAssistantCommerceRequest(value:unknown):AssistantCommerceRequest|null {
  if (!record(value) || value.kind !== 'assistant/commerce-request-v1' || !parseUuid(value.id)) return null;
  const valid = (extra:string[],okay:unknown) => okay && exact(value,['kind','id','operation',...extra]) ? value as unknown as AssistantCommerceRequest : null;
  switch(value.operation) {
    case 'COVER_READ':return valid(['entryId'],parseUuid(value.entryId));
    case 'COVER_WRITE':return valid(['entryId','request'],parseUuid(value.entryId)&&parseAssistantCoverDraftRequest(value.request));
    case 'RESUME_LIBRARY':return valid([],true);
    case 'RESUME_SELECTION':return valid([],true);
    case 'PREPARATION_BATCH':
    case 'PREPARATION_LIST':return valid(['batchId'],parseUuid(value.batchId));
    case 'PREPARATION_START':return valid(['batchId','request'],parseUuid(value.batchId) && parseStartApplicationPreparationsRequest(value.request));
    case 'PREPARATION_RETRY':return valid(['batchId','preparationId','request'],parseUuid(value.batchId) && parseUuid(value.preparationId) && parseRetryApplicationPreparationRequest(value.request));
    case 'USAGE':return valid([],true);
    case 'JOBS_BATCHES':return valid(['conversationId'],parseUuid(value.conversationId));
    case 'JOBS_LIST':return valid(['query'],parseAssistantJobsQuery(value.query));
    case 'JOBS_DELIVER':return valid(['request'],parseAssistantJobsDeliveryRequest(value.request));
    case 'JOB_DECIDE':return valid(['entryId','request'],parseUuid(value.entryId) && parseAssistantJobDecisionRequest(value.request));
    case 'JOB_DETAIL':return valid(['batchId','itemId'],parseUuid(value.batchId) && parseUuid(value.itemId));
    case 'ATS_LOOKUP':
    case 'ATS_START':return valid(['request'],parseAtsReportRequest(value.request));
    case 'ATS_GET':return valid(['reportId','entryId'],parseUuid(value.reportId) && parseUuid(value.entryId));
    default:return null;
  }
}
export function parseAssistantCommerceResponse(value:unknown):AssistantCommerceResponse|null {
  if (!record(value) || value.kind !== 'assistant/commerce-result-v1' || !parseUuid(value.id) || !Object.hasOwn(decoders,String(value.operation))) return null;
  if (value.ok === false) return exact(value,['kind','id','operation','ok','code']) && ASSISTANT_COMMERCE_CODES.includes(value.code as AssistantCommerceCode) ? value as unknown as AssistantCommerceResponse : null;
  if (value.ok !== true || !exact(value,['kind','id','operation','ok','value'])) return null;
  const decoded = decoders[value.operation as AssistantCommerceOperation](value.value);
  if (!decoded) return null;
  // 简历库与可选简历的解析器对后端先发的加法容错（2026-09-28）：交出去的是它们按认得的字段重建的那一份，
  // 多出来的成员不往下传。别的解析器照旧只作判定。
  return (value.operation === 'RESUME_LIBRARY' || value.operation === 'RESUME_SELECTION')
    ? { ...value, value: decoded } as unknown as AssistantCommerceResponse
    : value as unknown as AssistantCommerceResponse;
}
const decoders:Record<AssistantCommerceOperation,(value:unknown)=>unknown> = {
  COVER_READ:parseAssistantCoverDraftResponse,COVER_WRITE:parseAssistantCoverDraftResponse,RESUME_LIBRARY:parseResumeLibrarySnapshotV1,
  RESUME_SELECTION:parseListResumeSelectionOptionsResponseV1,PREPARATION_BATCH:parseGetRecommendationBatchResponse,PREPARATION_LIST:parseApplicationPreparationsResponse,PREPARATION_START:parseApplicationPreparationsResponse,PREPARATION_RETRY:parseApplicationPreparationsResponse,
  USAGE:parseCommercialUsageResponse,JOBS_BATCHES:parseAssistantJobBatchesResponse,JOBS_LIST:parseAssistantJobsResponse,JOBS_DELIVER:parseAssistantJobsResponse,
  JOB_DECIDE:parseAssistantJobResponse,JOB_DETAIL:value=>parseGetRecommendationItemDetailResponse(value,(v):v is import('./conversations.ts').JobCardView=>parseJobCardView(v)!==null),
  ATS_LOOKUP:parseAtsReportLookupResponse,ATS_START:parseAtsReportResponse,ATS_GET:parseAtsReportResponse,
};
function record(value:unknown):value is Record<string,unknown> { return value!==null && typeof value==='object' && !Array.isArray(value); }
function exact(value:Record<string,unknown>,keys:string[]):boolean { return Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key)); }
