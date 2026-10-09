import type {PoolClient} from 'pg';
import {careerRecordId as id,careerRecordObject as object,type OnboardingCommand,type OnboardingDraft} from '@companion/platform-contracts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import type {PlatformConfig} from './config.ts';
import {OnboardingStorage} from './onboarding-storage.ts';
import {ApiError} from './errors.ts';

export const ONBOARDING_EXPORT_TABLES=Object.freeze(['platform_onboarding_drafts','platform_onboarding_operations','platform_onboarding_safety_submissions'] as const);
export type OnboardingExportSection='onboardingDrafts'|'onboardingOperations'|'onboardingSafetySubmissions';
const unavailable=()=>new ApiError(503,'ACCOUNT_ONBOARDING_EXPORT_UNAVAILABLE','The saved intake records could not be confirmed.');
/** Read original private intake data only. The normal draft reader recovers old
 * inbox entries; exports must not call that reader or create missing history. */
export class AccountOnboardingExport {
 private readonly storage:OnboardingStorage;
 constructor(config:Pick<PlatformConfig,'dataCrypto'|'requireVerifiedEmail'>){this.storage=new OnboardingStorage(config,null);}
 private async *rows(client:PoolClient,owner:string,table:typeof ONBOARDING_EXPORT_TABLES[number],signal?:AbortSignal){
  const key=table==='platform_onboarding_operations'?'operation_id':'id';let after:string|null=null;
  for(;;){signal?.throwIfAborted();
   const found:Record<string,any>[]=(await client.query(`SELECT * FROM ${table} WHERE user_id=$1 AND ($2::uuid IS NULL OR ${key}>$2) ORDER BY ${key} LIMIT 100`,[owner,after])).rows;
   for(const row of found){signal?.throwIfAborted();if(row.user_id!==owner)throw unavailable();yield row;}
   if(found.length<100)break;after=id(found.at(-1)![key]);
  }
 }
 async *exportInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal):AsyncGenerator<{section:OnboardingExportSection;record:unknown}>{
  const raw=object(value,['userId','tokenHash']),who=Object.freeze({userId:id(raw.userId),tokenHash:raw.tokenHash as string});
  if(typeof who.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(who.tokenHash))throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');
  await authorizeFixedSession(client,who,signal);
  try{
   const drafts=new Map<string,OnboardingDraft>();
   for await(const row of this.rows(client,who.userId,'platform_onboarding_drafts',signal)){
    const draft=this.storage.decode(row as any);drafts.set(draft.id,draft);
    yield {section:'onboardingDrafts',record:{...draft,createdAt:row.created_at.toISOString()}};
   }
   const operations=new Map<string,{draftId:string;revision:number;command:OnboardingCommand}>();
   for await(const row of this.rows(client,who.userId,'platform_onboarding_operations',signal)){
    const draft=drafts.get(row.draft_id);if(!draft||row.applied_revision>draft.revision)throw unavailable();
    const command=this.storage.decodeOperation(row as any,who.userId);
    operations.set(row.operation_id,{draftId:row.draft_id,revision:row.applied_revision,command});
    yield {section:'onboardingOperations',record:{ownerId:who.userId,draftId:row.draft_id,command,appliedRevision:row.applied_revision,createdAt:row.created_at.toISOString()}};
   }
   const textReference=(draft:OnboardingDraft,textId:string,question:string,submittedRevision:number)=>{
    const saved=operations.get(textId);
    if(!saved||saved.draftId!==draft.id||saved.revision!==submittedRevision||saved.command.action.kind!=='text'||saved.command.action.questionId!==question)throw unavailable();
   };
   for(const draft of drafts.values()){
    if(draft.pendingText)textReference(draft,draft.pendingText.id,draft.pendingText.questionId,draft.pendingText.submittedAtRevision);
    if(draft.safety)textReference(draft,draft.safety.textId,draft.safety.questionId,draft.safety.submittedAtRevision);
    for(const [question,answer] of Object.entries(draft.answersPartial))if(answer&&'textId' in answer&&answer.textId)
     textReference(draft,answer.textId,question,answer.appliedRevision-1);
   }
   for await(const row of this.rows(client,who.userId,'platform_onboarding_safety_submissions',signal)){
    const draft=drafts.get(row.draft_id);if(!draft)throw unavailable();
    textReference(draft,row.operation_id,row.question_id,row.submitted_revision);
    if(!['pending','running','detected'].includes(row.status))throw unavailable();
    const result=row.status==='detected'?this.storage.decodeResult(row as any):null;
    if(!result&&(row.result_ciphertext!==null||row.level!==null||row.detector_mode!==null))throw unavailable();
    yield {section:'onboardingSafetySubmissions',record:{id:row.id,ownerId:who.userId,operationId:row.operation_id,draftId:row.draft_id,
     questionId:row.question_id,submittedRevision:row.submitted_revision,status:row.status,generation:row.generation,
     detectorRevision:row.detector_revision,level:row.level,detectorMode:row.detector_mode,failure:row.failure,
     leaseUntil:row.lease_until?.toISOString()??null,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString(),result}};
   }
  }catch{signal?.throwIfAborted();throw unavailable();}
  await authorizeFixedSession(client,who,signal);signal?.throwIfAborted();
 }
}
