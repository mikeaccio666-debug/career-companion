import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { OnboardingDraft } from '@companion/platform-contracts';
import type { OnboardingStorage, SafetySubmissionRow } from './onboarding-storage.ts';
import { ApiError } from './errors.ts';
import { publicSafetyResponse, readAuthenticatedSafetyResponses } from './onboarding-safety-responses.ts';

export type SafetyFollowupAction = { readonly kind:'present'|'need_support' }
  | { readonly kind:'acknowledge'|'continue_intake'; readonly presentationReceipt:string }
  | { readonly kind:'clarify_exaggeration'; readonly presentationReceipt:string; readonly safe:true; readonly exaggeration:true };
export interface SafetyFollowupCommand {
  readonly operationId:string; readonly expectedDraftRevision:number; readonly publicationId:string; readonly action:SafetyFollowupAction;
}
export type SafetyResumeStatus='not_requested'|'remaining_safety'|'waiting_for_safety'|'resumed';
export interface SafetyPublicationRow {
  id:string;user_id:string;draft_id:string;response_id:string;submission_id:string;source_generation:number;
  projection_digest:string;payload_ciphertext:Buffer;published_at:Date;retention_until:Date;
}
export interface SafetyFollowupRow {
  user_id:string;operation_id:string;draft_id:string;publication_id:string;action_kind:SafetyFollowupAction['kind'];
  expected_revision:number;applied_revision:number;session_hash:string;presentation_digest:string|null;
  presentation_operation_id:string|null;acknowledgment_operation_id:string|null;handled:boolean;clarified_at:Date|null;
  payload_ciphertext:Buffer;created_at:Date;
}
export type PublishedSafetyResponse=ReturnType<typeof publicSafetyResponse>;
export interface SafetyPublicationCapture {
  schemaVersion:1;id:string;userId:string;draftId:string;responseId:string;submissionId:string;sourceGeneration:number;
  preparedAt:string;publishedAt:string;retentionUntil:string;projectionDigest:string;response:PublishedSafetyResponse;
}
export interface SafetyFollowupCapture {
  schemaVersion:1;operationId:string;userId:string;draftId:string;publicationId:string;kind:SafetyFollowupAction['kind'];
  expectedDraftRevision:number;appliedRevision:number;sessionHash:string;presentationDigest:string|null;
  presentationOperationId:string|null;acknowledgmentOperationId:string|null;handled:boolean;clarifiedAt:string|null;
  at:string;resumeStatus:SafetyResumeStatus;safe?:true;exaggeration?:true;
}
export const followupUnavailable=()=>new ApiError(503,'DATA_STORAGE_UNAVAILABLE','The private safety follow-up could not be saved or read.');
export const followupConflict=()=>new ApiError(409,'ONBOARDING_OPERATION_CONFLICT','Use a new operation identifier for a different safety response.');
export const followupDigest=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function exactRecord(value:unknown,keys:readonly string[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw invalid();
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(value).length!==keys.length||Reflect.ownKeys(value).some(key=>typeof key!=='string'||!keys.includes(key))
    ||keys.some(key=>!Object.hasOwn(descriptors,key))||Object.values(descriptors).some(item=>!('value'in item)||!item.enumerable)) throw invalid();
  return value as Record<string,unknown>;
}
const invalid=()=>new ApiError(400,'INVALID_INPUT','Use a valid safety follow-up operation.');
export function parseSafetyFollowupCommand(value:unknown):SafetyFollowupCommand {
  try {
    const data=exactRecord(value,['operationId','expectedDraftRevision','publicationId','action']);
    if(typeof data.operationId!=='string'||uuid.exec(data.operationId)?.[0]!==data.operationId
      ||typeof data.publicationId!=='string'||uuid.exec(data.publicationId)?.[0]!==data.publicationId
      ||typeof data.expectedDraftRevision!=='number'||!Number.isSafeInteger(data.expectedDraftRevision)
      ||data.expectedDraftRevision<1||data.expectedDraftRevision>2147483647) throw invalid();
    const descriptor=data.action&&typeof data.action==='object'?Object.getOwnPropertyDescriptor(data.action,'kind'):null;
    if(!descriptor||!('value'in descriptor)) throw invalid();
    const kind=descriptor.value;
    const keys=kind==='present'||kind==='need_support'?['kind']:kind==='clarify_exaggeration'?['kind','presentationReceipt','safe','exaggeration']:['kind','presentationReceipt'];
    const action=exactRecord(data.action,keys);
    if(!['present','need_support','acknowledge','continue_intake','clarify_exaggeration'].includes(kind)) throw invalid();
    if('presentationReceipt'in action&&(typeof action.presentationReceipt!=='string'||/^[A-Za-z0-9_-]{43}$/.exec(action.presentationReceipt)?.[0]!==action.presentationReceipt)) throw invalid();
    if(kind==='clarify_exaggeration'&&(action.safe!==true||action.exaggeration!==true)) throw invalid();
    return Object.freeze({operationId:data.operationId,expectedDraftRevision:data.expectedDraftRevision,publicationId:data.publicationId,
      action:Object.freeze({...action}) as SafetyFollowupAction});
  }catch(error){if(error instanceof ApiError)throw error;throw invalid();}
}
function open(storage:OnboardingStorage,table:string,column:string,id:string,userId:string,revision:number,cipher:Buffer):unknown {
  try{return JSON.parse(storage.crypto!.openUtf8(cipher,{table,column,rowId:id,ownerId:userId,revision}));}catch{throw followupUnavailable();}
}
export function captureFollowup(storage:OnboardingStorage,row:SafetyFollowupRow):SafetyFollowupCapture {
  const value=open(storage,'platform_onboarding_safety_followups','payload_ciphertext',row.operation_id,row.user_id,row.applied_revision,row.payload_ciphertext);
  try {
    const keys=['schemaVersion','operationId','userId','draftId','publicationId','kind','expectedDraftRevision','appliedRevision','sessionHash','presentationDigest',
      'presentationOperationId','acknowledgmentOperationId','handled','clarifiedAt','at','resumeStatus',...(row.action_kind==='clarify_exaggeration'?['safe','exaggeration']:[])];
    const data=exactRecord(value,keys);
    if(data.schemaVersion!==1||data.operationId!==row.operation_id||data.userId!==row.user_id||data.draftId!==row.draft_id
      ||data.publicationId!==row.publication_id||data.kind!==row.action_kind||data.expectedDraftRevision!==row.expected_revision
      ||data.appliedRevision!==row.applied_revision||data.sessionHash!==row.session_hash||data.presentationDigest!==row.presentation_digest
      ||data.presentationOperationId!==row.presentation_operation_id||data.acknowledgmentOperationId!==row.acknowledgment_operation_id
      ||data.handled!==row.handled||data.clarifiedAt!==(row.clarified_at?.toISOString()??null)||data.at!==row.created_at.toISOString()
      ||!['not_requested','remaining_safety','waiting_for_safety','resumed'].includes(data.resumeStatus as string)
      ||(row.handled?data.resumeStatus==='not_requested':data.resumeStatus!=='not_requested')
      ||row.action_kind==='clarify_exaggeration'&&(data.safe!==true||data.exaggeration!==true)) throw followupUnavailable();
    return data as unknown as SafetyFollowupCapture;
  }catch{throw followupUnavailable();}
}
/** Authenticate the complete history, including rows unrelated to the latest response.
 * A handled source remains L1/L2; it is never eligibility for facts, personality or context.
 */
export async function readSafetyFollowupHistory(client:PoolClient,storage:OnboardingStorage,draft:OnboardingDraft,sources:SafetySubmissionRow[]) {
  if(!storage.crypto)throw followupUnavailable();
  const captures=await readAuthenticatedSafetyResponses(client,storage,draft.userId,sources);
  const publications=(await client.query<SafetyPublicationRow>('SELECT * FROM platform_onboarding_safety_publications WHERE user_id=$1 ORDER BY published_at,id FOR UPDATE',[draft.userId])).rows;
  const decoded=new Map<string,SafetyPublicationCapture>();
  for(const row of publications){
    const source=captures.find(item=>item.row.id===row.response_id);
    if(!source||!source.response||source.row.status!=='ready'||row.user_id!==draft.userId||row.draft_id!==draft.id
      ||row.submission_id!==source.row.submission_id||row.source_generation!==source.row.source_generation
      ||row.retention_until.toISOString()!==source.row.retention_until!.toISOString()||row.published_at<source.row.prepared_at!) throw followupUnavailable();
    try {
      const data=exactRecord(open(storage,'platform_onboarding_safety_publications','payload_ciphertext',row.id,row.user_id,1,row.payload_ciphertext),
        ['schemaVersion','id','userId','draftId','responseId','submissionId','sourceGeneration','preparedAt','publishedAt','retentionUntil','projectionDigest','response']);
      const response=publicSafetyResponse(source.response), json=JSON.stringify(response);
      if(data.schemaVersion!==1||data.id!==row.id||data.userId!==row.user_id||data.draftId!==row.draft_id||data.responseId!==row.response_id
        ||data.submissionId!==row.submission_id||data.sourceGeneration!==row.source_generation||data.preparedAt!==source.row.prepared_at!.toISOString()
        ||data.publishedAt!==row.published_at.toISOString()||data.retentionUntil!==row.retention_until.toISOString()
        ||data.projectionDigest!==row.projection_digest||row.projection_digest!==followupDigest(json)||JSON.stringify(data.response)!==json) throw followupUnavailable();
      decoded.set(row.id,data as unknown as SafetyPublicationCapture);
    }catch{throw followupUnavailable();}
  }
  const operations=(await client.query<SafetyFollowupRow>('SELECT * FROM platform_onboarding_safety_followups WHERE user_id=$1 ORDER BY created_at,operation_id FOR UPDATE',[draft.userId])).rows;
  const opCaptures=new Map<string,SafetyFollowupCapture>();
  for(const row of operations){
    if(row.draft_id!==draft.id||row.applied_revision>draft.revision||!decoded.has(row.publication_id))throw followupUnavailable();
    const payload=captureFollowup(storage,row);opCaptures.set(row.operation_id,payload);
    const publication=publications.find(item=>item.id===row.publication_id)!;
    // Once genuinely presented and acknowledged while current, an explicit continuation can
    // recover after expiry without republishing old resources or inventing a fresh presentation.
    if(row.created_at<publication.published_at||!row.handled&&row.created_at>=publication.retention_until)throw followupUnavailable();
  }
  const handled=new Set<string>();
  for(const row of operations){
    if(row.action_kind==='present'||row.action_kind==='need_support')continue;
    const present=operations.find(item=>item.operation_id===row.presentation_operation_id);
    if(!present||present.action_kind!=='present'||present.publication_id!==row.publication_id||present.session_hash!==row.session_hash
      ||present.presentation_digest!==row.presentation_digest||present.created_at>row.created_at)throw followupUnavailable();
    if(row.action_kind==='acknowledge')continue;
    const ack=operations.find(item=>item.operation_id===row.acknowledgment_operation_id);
    if(!ack||ack.action_kind!=='acknowledge'||ack.publication_id!==row.publication_id||ack.session_hash!==row.session_hash
      ||ack.presentation_operation_id!==present.operation_id||ack.presentation_digest!==row.presentation_digest||ack.created_at>row.created_at)throw followupUnavailable();
    const publication=publications.find(item=>item.id===row.publication_id)!;
    if(handled.has(publication.submission_id))throw followupUnavailable();handled.add(publication.submission_id);
  }
  return {captures,publications,decoded,operations,opCaptures,handled};
}
export async function readHandledOnboardingSources(client:PoolClient,storage:OnboardingStorage,draft:OnboardingDraft,sources:SafetySubmissionRow[]):Promise<ReadonlySet<string>> {
  const legacy=(await readSafetyFollowupHistory(client,storage,draft,sources)).handled;
  const { readHandledIntakeV2Sources } = await import('./onboarding-safety-delivery-protocol.ts');
  const modern=await readHandledIntakeV2Sources(client,storage,draft,sources);
  return new Set([...legacy,...modern]);
}
