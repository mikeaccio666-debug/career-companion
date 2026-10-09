import { CareerProfiles } from './career-profiles.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { OnboardingDraft, OnboardingFollowupResult, OnboardingFollowupState } from '@companion/platform-contracts';
import { resumeOnboardingDraft } from '@companion/career-core';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { PlatformConfig } from './config.ts';
import type { Database } from './database.ts';
import { DataCryptoError } from './data-crypto.ts';
import { ApiError } from './errors.ts';
import type { LegalBundle } from './legal-documents.ts';
import { OnboardingStorage, type SafetySubmissionRow } from './onboarding-storage.ts';
import { publicSafetyResponse } from './onboarding-safety-responses.ts';
import { observeIntakeSourcesInTransaction } from './onboarding-resource-source.ts';
import { captureFollowup, followupConflict, followupDigest, followupUnavailable, parseSafetyFollowupCommand,
  readSafetyFollowupHistory, type SafetyFollowupCapture, type SafetyFollowupCommand,
  type SafetyFollowupRow, type SafetyPublicationCapture, type SafetyResumeStatus } from './onboarding-safety-followup-protocol.ts';

const changed=()=>new ApiError(409,'ONBOARDING_REVISION_CHANGED','Read the current intake progress before making another change.');
const presentationRequired=()=>new ApiError(409,'ONBOARDING_SAFETY_PRESENTATION_REQUIRED','Present the current fixed resource response before acknowledging it.');
const acknowledgmentRequired=()=>new ApiError(409,'ONBOARDING_SAFETY_ACKNOWLEDGMENT_REQUIRED','Acknowledge the fixed resource response before continuing.');
const expired=()=>new ApiError(409,'ONBOARDING_SAFETY_RESPONSE_EXPIRED','The fixed resource response needs a current reviewed capture.');
const stateChanged=()=>new ApiError(409,'ONBOARDING_STATE_CHANGED','Read the current intake question before continuing.');
type History=Awaited<ReturnType<typeof readSafetyFollowupHistory>>;
function fixedContext(context:FixedSessionContext):FixedSessionContext {
  return Object.freeze({userId:context.userId,tokenHash:context.tokenHash});
}
function canonicalInput(command:SafetyFollowupCommand) {
  const action=command.action;
  return {operationId:command.operationId,expectedDraftRevision:command.expectedDraftRevision,publicationId:command.publicationId,
    kind:action.kind,presentationDigest:'presentationReceipt'in action?followupDigest(action.presentationReceipt):null,
    ...(action.kind==='clarify_exaggeration'?{safe:true,exaggeration:true}:{})};
}
function capturedInput(value:SafetyFollowupCapture) {
  return {operationId:value.operationId,expectedDraftRevision:value.expectedDraftRevision,publicationId:value.publicationId,
    kind:value.kind,presentationDigest:value.kind==='present'?null:value.presentationDigest,
    ...(value.kind==='clarify_exaggeration'?{safe:true,exaggeration:true}:{})};
}

/** Real fixed-resource publication and user continuation. No model, cost, lease or tool permission is granted.
 * A presentation receipt is an authenticated client claim, never evidence of human reading or clinical safety.
 */
export class OnboardingSafetyFollowup {
  private readonly storage:OnboardingStorage;
  private readonly profiles:CareerProfiles;
  constructor(private readonly db:Database,config:Pick<PlatformConfig,'dataCrypto'|'requireVerifiedEmail'>,legal:LegalBundle|null,private readonly prospective=false) {
    this.storage=new OnboardingStorage(config,legal);
    this.profiles=new CareerProfiles(db,config,legal);
  }
  private async resourceAdmission(client:PoolClient,fixed:FixedSessionContext,signal?:AbortSignal) {
    await authorizeFixedSession(client,fixed,signal);
    const account=(await client.query<{account_kind:string}>('SELECT account_kind FROM platform_users WHERE id=$1 FOR NO KEY UPDATE',[fixed.userId])).rows[0];
    if(!account||account.account_kind!=='student')throw new ApiError(403,'STUDENT_ACCOUNT_REQUIRED','Use a student account for intake.');
    if(!this.storage.crypto)throw followupUnavailable();
    await authorizeFixedSession(client,fixed,signal);
  }
  private async history(client:PoolClient,fixed:FixedSessionContext,observe=false) {
    const row=await this.storage.row(client,fixed.userId);
    if(!row)return null;
    const draft=this.storage.decode(row),sources=observe?await observeIntakeSourcesInTransaction(client,this.storage,draft):await this.storage.recover(client,draft);
    const history=await readSafetyFollowupHistory(client,this.storage,draft,sources);
    return {draft,sources,history};
  }
  private async publish(client:PoolClient,draft:OnboardingDraft,sources:SafetySubmissionRow[],history:History,at:string):Promise<History> {
    const now=new Date(at);
    for(const capture of history.captures){
      const row=capture.row;
      if(!capture.response||row.status!=='ready'||row.retention_until!<=now||history.publications.some(item=>item.response_id===row.id))continue;
      const id=randomUUID(),response=publicSafetyResponse(capture.response),digest=followupDigest(JSON.stringify(response));
      const payload:SafetyPublicationCapture={schemaVersion:1,id,userId:draft.userId,draftId:draft.id,responseId:row.id,
        submissionId:row.submission_id,sourceGeneration:row.source_generation,preparedAt:row.prepared_at!.toISOString(),
        publishedAt:at,retentionUntil:row.retention_until!.toISOString(),projectionDigest:digest,response};
      const sealed=this.storage.crypto!.sealUtf8(JSON.stringify(payload),{
        table:'platform_onboarding_safety_publications',column:'payload_ciphertext',rowId:id,ownerId:draft.userId,revision:1});
      await client.query(`INSERT INTO platform_onboarding_safety_publications
        (id,user_id,draft_id,response_id,submission_id,source_generation,projection_digest,payload_ciphertext,published_at,retention_until)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,draft.userId,draft.id,row.id,row.submission_id,row.source_generation,digest,sealed,at,row.retention_until]);
    }
    return readSafetyFollowupHistory(client,this.storage,draft,sources);
  }
  async read(context:FixedSessionContext,signal?:AbortSignal):Promise<OnboardingFollowupState> {
    const fixed=fixedContext(context);
    try {
      return await this.db.withBoundedTransaction(async client=>{
        await this.resourceAdmission(client,fixed,signal);
        const anchor=(await client.query<{safety_resource_v2_draft_id:string|null}>('SELECT safety_resource_v2_draft_id FROM platform_onboarding_drafts WHERE user_id=$1 FOR SHARE',[fixed.userId])).rows[0];
        const prospective=this.prospective||anchor?.safety_resource_v2_draft_id!==null&&anchor!==undefined;
        const current=await this.history(client,fixed,prospective);
        if(!current){await authorizeFixedSession(client,fixed,signal);return {draft:null,publications:[],pendingResponses:[],safety:{status:'clear',pendingCount:0,blockedLevel:null}};}
        const at=await this.storage.at(client),history=prospective?current.history:await this.publish(client,current.draft,current.sources,current.history,at),now=new Date(at);
        const publications=prospective?[]:history.publications.filter(row=>row.retention_until>now).map(row=>{
          const capture=history.decoded.get(row.id)!,ops=history.operations.filter(item=>item.publication_id===row.id);
          const clarification=ops.find(item=>item.action_kind==='clarify_exaggeration');
          const source=current.sources.find(item=>item.id===row.submission_id)!;
          // Before birth, the stable draft is the logical conversation. A distinct detected
          // high-risk source is a new signal; repeated reads of the same source do not create one.
          // This is grounded in a persisted client presentation claim, not a prepared/GET/seen claim.
          const recentPresentation=ops.some(item=>item.action_kind==='present'&&item.created_at.getTime()>now.getTime()-86400_000);
          const {question,...withoutQuestion}=capture.response;
          const response=question!==undefined&&recentPresentation?Object.freeze(withoutQuestion):capture.response;
          return Object.freeze({publicationId:row.id,responseId:row.response_id,submissionId:row.submission_id,level:source.level as 'L1'|'L2',
            publishedAt:row.published_at.toISOString(),retentionUntil:row.retention_until.toISOString(),response,
            presented:ops.some(item=>item.action_kind==='present'),acknowledged:ops.some(item=>item.action_kind==='acknowledge'),
            handled:history.handled.has(row.submission_id),clarifiedAt:clarification?.clarified_at?.toISOString()??null});
        });
        const pendingResponses=history.captures.filter(item=>item.row.status==='pending'||item.row.retention_until!<=now).map(item=>({
          responseId:item.row.id,submissionId:item.row.submission_id,status:item.row.status==='pending'?'pending' as const:'expired' as const}));
        await authorizeFixedSession(client,fixed,signal);signal?.throwIfAborted();
        const handled=prospective?await this.storage.handledSources(client,current.draft,current.sources):history.handled;
        return {draft:current.draft,publications,pendingResponses,safety:this.storage.safetyState(current.sources,handled)};
      });
    }catch(error){if(error instanceof DataCryptoError)throw followupUnavailable();throw error;}
  }
  async act(context:FixedSessionContext,value:unknown,signal?:AbortSignal):Promise<OnboardingFollowupResult> {
    const fixed=fixedContext(context),command=parseSafetyFollowupCommand(value),input=JSON.stringify(canonicalInput(command));
    try {
      return await this.db.withBoundedTransaction(async client=>{
        const kind=command.action.kind;
        const handling=kind==='continue_intake'||kind==='clarify_exaggeration';
        const authVersion=handling?await this.storage.authorizeSession(client,fixed,signal):null;
        if(!handling)await this.resourceAdmission(client,fixed,signal);
        const current=await this.history(client,fixed);
        if(!current)throw new ApiError(404,'NOT_FOUND','The intake is not available.');
        const {draft,sources,history}=current;
        const old=history.operations.find(item=>item.operation_id===command.operationId);
        if(old){
          const payload=captureFollowup(this.storage,old);
          if(old.session_hash!==fixed.tokenHash||JSON.stringify(capturedInput(payload))!==input)throw followupConflict();
          await authorizeFixedSession(client,fixed,signal);signal?.throwIfAborted();
          // Only hashes are persisted. A lost presentation handle is recovered by a new actual presentation operation.
          return {draft,operation:{id:old.operation_id,appliedRevision:old.applied_revision,replayed:true},publicationId:old.publication_id,resumeStatus:payload.resumeStatus};
        }
        const cutover=(await client.query<{safety_resource_v2_draft_id:string|null}>('SELECT safety_resource_v2_draft_id FROM platform_onboarding_drafts WHERE id=$1 AND user_id=$2 FOR SHARE',[draft.id,fixed.userId])).rows[0];
        if(this.prospective||cutover?.safety_resource_v2_draft_id!==null&&cutover!==undefined)throw new ApiError(409,'SAFETY_DELIVERY_PROTOCOL_CHANGED','Use the current resource body and explicit actions.');
        const namespaceCollision=(await client.query('SELECT operation_id FROM platform_onboarding_operations WHERE user_id=$1 AND operation_id=$2 FOR UPDATE',[fixed.userId,command.operationId])).rowCount;
        if(namespaceCollision)throw followupConflict();
        if(command.expectedDraftRevision!==draft.revision)throw changed();
        const publication=history.publications.find(item=>item.id===command.publicationId);
        if(!publication)throw new ApiError(404,'NOT_FOUND','The fixed resource response is not available.');
        const at=await this.storage.at(client),now=new Date(at);
        if(publication.retention_until<=now&&kind!=='continue_intake'&&kind!=='clarify_exaggeration')throw expired();
        let presentationReceipt:string|undefined,presentationDigest:string|null=null,presentationOperationId:string|null=null,acknowledgmentOperationId:string|null=null;
        if(kind==='present'){
          presentationReceipt=randomBytes(32).toString('base64url');presentationDigest=followupDigest(presentationReceipt);
        }else if('presentationReceipt'in command.action){
          presentationDigest=followupDigest(command.action.presentationReceipt);
          const present=history.operations.find(item=>item.publication_id===publication.id&&item.action_kind==='present'
            &&item.session_hash===fixed.tokenHash&&item.presentation_digest===presentationDigest);
          if(!present)throw presentationRequired();presentationOperationId=present.operation_id;
          if(kind==='continue_intake'||kind==='clarify_exaggeration'){
            const ack=history.operations.find(item=>item.action_kind==='acknowledge'&&item.publication_id===publication.id
              &&item.session_hash===fixed.tokenHash&&item.presentation_operation_id===present.operation_id&&item.presentation_digest===presentationDigest);
            if(!ack)throw acknowledgmentRequired();acknowledgmentOperationId=ack.operation_id;
          }
        }
        const handled=kind==='continue_intake'||kind==='clarify_exaggeration';
        if(handled&&history.handled.has(publication.submission_id))throw stateChanged();
        let next=draft,resumeStatus:SafetyResumeStatus='not_requested';
        if(handled){
          const allHandled=new Set(history.handled);allHandled.add(publication.submission_id);
          const safety=this.storage.safetyState(sources,allHandled);
          if(safety.status==='blocked')resumeStatus='remaining_safety';
          else if(safety.status==='pending')resumeStatus='waiting_for_safety';
          else {
            if(draft.state==='safety_paused')next=resumeOnboardingDraft(draft,{expectedRevision:draft.revision,at});
            else if(draft.state==='safety_pending'){
              const source=sources.find(item=>item.operation_id===draft.pendingText!.id);
              if(!source||source.status!=='detected'||source.level!=='L0'||source.detector_mode!=='full')throw stateChanged();
              next=resumeOnboardingDraft(draft,{expectedRevision:draft.revision,at,currentTextResult:this.storage.decodeResult(source)});
            }else if(draft.state!=='collecting'&&draft.state!=='intake_ready')throw stateChanged();
            resumeStatus='resumed';
          }
        }
        const payload:SafetyFollowupCapture={schemaVersion:1,operationId:command.operationId,userId:fixed.userId,draftId:draft.id,publicationId:publication.id,
          kind,expectedDraftRevision:command.expectedDraftRevision,appliedRevision:next.revision,sessionHash:fixed.tokenHash,presentationDigest,
          presentationOperationId,acknowledgmentOperationId,handled,clarifiedAt:kind==='clarify_exaggeration'?at:null,at,resumeStatus,
          ...(kind==='clarify_exaggeration'?{safe:true,exaggeration:true}:{})};
        const ciphertext=this.storage.crypto!.sealUtf8(JSON.stringify(payload),{
          table:'platform_onboarding_safety_followups',column:'payload_ciphertext',rowId:command.operationId,ownerId:fixed.userId,revision:next.revision});
        await authorizeFixedSession(client,fixed,signal);
        if(next!==draft){
          await this.storage.write(client,draft,next);
          await this.profiles.projectIntakeInTransaction(client,draft,next,authVersion!,signal);
        }
        await client.query(`INSERT INTO platform_onboarding_safety_followups
          (user_id,operation_id,draft_id,publication_id,action_kind,expected_revision,applied_revision,session_hash,presentation_digest,
           presentation_operation_id,acknowledgment_operation_id,handled,clarified_at,payload_ciphertext,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [fixed.userId,command.operationId,draft.id,publication.id,kind,command.expectedDraftRevision,next.revision,fixed.tokenHash,presentationDigest,
          presentationOperationId,acknowledgmentOperationId,handled,payload.clarifiedAt,ciphertext,at]);
        await readSafetyFollowupHistory(client,this.storage,next,sources);
        await authorizeFixedSession(client,fixed,signal);signal?.throwIfAborted();
        return {draft:next,operation:{id:command.operationId,appliedRevision:next.revision,replayed:false},publicationId:publication.id,resumeStatus,
          ...(presentationReceipt?{presentationReceipt}:{})};
      });
    }catch(error){if(error instanceof DataCryptoError)throw followupUnavailable();throw error;}
  }
}
