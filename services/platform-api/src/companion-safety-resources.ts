import type { CompanionSafetyBodyProjection, CompanionSafetyPublicationRequest, CompanionSafetyResourceIndex,
  CompanionSafetyResourceResult, CompanionSafetyResourceState, CompanionSafetySourceKind } from '@companion/platform-contracts';
import { parseCompanionSafetyPublicationRequest, parseCompanionSafetyResourceCommand, parseCompanionSafetyTargetRequest } from '@companion/platform-contracts';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { Database } from './database.ts';
import { DataCryptoError, type DataCrypto } from './data-crypto.ts';
import type { PlatformConfig } from './config.ts';
import type { LegalBundle } from './legal-documents.ts';
import { ApiError } from './errors.ts';
import { OnboardingStorage, type IntakeOperationRow, type SafetySubmissionRow } from './onboarding-storage.ts';
import { OnboardingSafetyDelivery } from './onboarding-safety-delivery.ts';
import { readIntakeResourceSourceInTransaction } from './onboarding-resource-source.ts';
import { CompanionNameSafetyDelivery } from './companion-name-safety-delivery.ts';
import { readNameRawSourceInTransaction, readNameResourceSourceInTransaction } from './companion-name-resource-source.ts';
import { readSafetyResponseBundle, SafetyResponseBundleError, type SafetyResponseBundle } from './safety-response-bundle.ts';
import { deliveryStorageUnavailable, openDelivery, readSafetyDeliveryReview, SafetyDeliveryReviewRegistry, type SafetyDeliveryReview } from './safety-delivery-review.ts';
import { SafetyQuestionDelivery } from './safety-question-delivery.ts';

function parsed<T>(run:()=>T):T{try{return run();}catch{throw new ApiError(400,'INVALID_INPUT','Use an actual resource source and operation.');}}
export interface CompanionSafetyResourceConfiguration { readonly bundle:Readonly<SafetyResponseBundle>|null;readonly review:Readonly<SafetyDeliveryReview>|null; }
/** Reading files does not record professional review, activate a policy or seed assets. */
export async function readCompanionSafetyResourceConfiguration(config:Pick<PlatformConfig,'safetyResponseBundlePath'|'safetyDeliveryReviewPath'>):Promise<CompanionSafetyResourceConfiguration>{
  const [bundle,review]=await Promise.allSettled([readSafetyResponseBundle(config.safetyResponseBundlePath),readSafetyDeliveryReview(config.safetyDeliveryReviewPath)]);
  if(bundle.status==='rejected'&&!(bundle.reason instanceof SafetyResponseBundleError))throw bundle.reason;
  if(review.status==='rejected'&&(!(review.reason instanceof ApiError)||review.reason.code!=='SAFETY_DELIVERY_UNAVAILABLE'))throw review.reason;
  return Object.freeze({bundle:bundle.status==='fulfilled'?bundle.value:null,review:review.status==='fulfilled'?review.value:null});
}
/** Two real source families share a viewer, never execution admission. Metadata
 * reads do not prepare, publish, repair, classify, dispatch, ask or handle. */
export class CompanionSafetyResources {
  constructor(private readonly db:Database,private readonly crypto:DataCrypto|undefined,
    readonly nameDelivery:CompanionNameSafetyDelivery,readonly intakeDelivery:OnboardingSafetyDelivery){}
  private service(kind:CompanionSafetySourceKind){return kind==='onboarding'?this.intakeDelivery:this.nameDelivery;}
  private async handled(context:FixedSessionContext,kind:CompanionSafetySourceKind,submissionId:string,signal?:AbortSignal){
    const fixed=Object.freeze({...context});return this.db.withBoundedTransaction(async client=>{
      await authorizeFixedSession(client,fixed,signal);const result=await this.service(kind).verifyHandledInTransaction(client,fixed.userId,submissionId,signal);
      await authorizeFixedSession(client,fixed,signal);signal?.throwIfAborted();return result;
    });
  }
  async readIndex(context:FixedSessionContext,signal?:AbortSignal):Promise<CompanionSafetyResourceIndex>{
    const fixed=Object.freeze({...context});
    return this.db.withBoundedTransaction(async client=>{
      await authorizeFixedSession(client,fixed,signal);
      const owner=(await client.query<{account_kind:string}>('SELECT account_kind FROM platform_users WHERE id=$1 FOR NO KEY UPDATE',[fixed.userId])).rows[0];
      if(!owner||owner.account_kind!=='student')throw new ApiError(403,'STUDENT_ACCOUNT_REQUIRED','Use a student account for private resources.');
      if(!this.crypto)throw deliveryStorageUnavailable();
      const rows=(await client.query<{kind:CompanionSafetySourceKind;id:string;status:string}>(`SELECT 'onboarding' AS kind,id,status FROM platform_onboarding_safety_submissions WHERE user_id=$1
        UNION ALL SELECT 'companion_name' AS kind,id,status FROM platform_companion_name_submissions WHERE user_id=$1 ORDER BY kind,id`,[fixed.userId])).rows;
      const sources:CompanionSafetyResourceIndex['sources'][number][]=[];
      const storage=new OnboardingStorage({dataCrypto:this.crypto,requireVerifiedEmail:false},null);
      for(const row of rows){signal?.throwIfAborted();
        const sourceRef={kind:row.kind,submissionId:row.id};
        try{
          if(row.status!=='detected'){
            if(row.kind==='companion_name'){const raw=await readNameRawSourceInTransaction(client,this.crypto,row.id,signal);if(raw.source.result_ciphertext||raw.source.level!==null||raw.source.detector_mode!==null)throw deliveryStorageUnavailable();}
            else{
              const source=(await client.query<SafetySubmissionRow>('SELECT * FROM platform_onboarding_safety_submissions WHERE id=$1 AND user_id=$2 FOR SHARE',[row.id,fixed.userId])).rows[0];
              if(!source)throw deliveryStorageUnavailable();
              if(source.result_ciphertext||source.level!==null||source.detector_mode!==null)throw deliveryStorageUnavailable();
              const operation=(await client.query<IntakeOperationRow>('SELECT operation_id,draft_id,applied_revision,request_ciphertext FROM platform_onboarding_operations WHERE user_id=$1 AND operation_id=$2 FOR SHARE',[fixed.userId,source.operation_id])).rows[0];
              if(!operation||operation.draft_id!==source.draft_id||operation.applied_revision!==source.submitted_revision)throw deliveryStorageUnavailable();
              const raw=storage.decodeOperation(operation,fixed.userId);if(raw.action.kind!=='text'||raw.action.questionId!==source.question_id)throw deliveryStorageUnavailable();
            }
            sources.push({sourceRef,availability:'pending',publication:null});continue;
          }
          const actual=row.kind==='onboarding'?await readIntakeResourceSourceInTransaction(client,this.crypto,row.id,signal):await readNameResourceSourceInTransaction(client,this.crypto,row.id,signal);
          if(actual.decision.level==='L0')continue;
          const table=row.kind==='onboarding'?'platform_onboarding_delivery_v2_heads':'platform_companion_name_delivery_heads';
          const head=(await client.query<{submission_id:string;user_id:string;source_generation:number;detector_revision:number;level:string;detector_mode:string;revision:number;latest_publication_id:string|null;payload_ciphertext:Buffer}>(`SELECT * FROM ${table} WHERE submission_id=$1 AND user_id=$2 FOR SHARE`,[row.id,fixed.userId])).rows[0];
          if(!head){
            const anchored=(await client.query<{anchor:string|null}>(row.kind==='onboarding'
              ?'SELECT first_safety_v2_publication_id AS anchor FROM platform_onboarding_safety_submissions WHERE id=$1 AND user_id=$2'
              :'SELECT first_safety_publication_id AS anchor FROM platform_companion_name_submissions WHERE id=$1 AND user_id=$2',[row.id,fixed.userId])).rows[0];
            if(!anchored||anchored.anchor!==null)throw deliveryStorageUnavailable();
            sources.push({sourceRef,availability:'ready',publication:null});continue;
          }
          if(!head.latest_publication_id)throw deliveryStorageUnavailable();
          const publicationTable=row.kind==='onboarding'?'platform_onboarding_safety_v2_publications':'platform_companion_name_safety_publications';
          const publications=(await client.query<{id:string;edition:number}>(`SELECT id,edition FROM ${publicationTable} WHERE submission_id=$1 AND user_id=$2 ORDER BY edition FOR SHARE`,[row.id,fixed.userId])).rows;
          const anchor=(await client.query<{anchor:string|null}>(row.kind==='onboarding'
            ?'SELECT first_safety_v2_publication_id AS anchor FROM platform_onboarding_safety_submissions WHERE id=$1 AND user_id=$2'
            :'SELECT first_safety_publication_id AS anchor FROM platform_companion_name_submissions WHERE id=$1 AND user_id=$2',[row.id,fixed.userId])).rows[0];
          const capture={schemaVersion:1,submissionId:head.submission_id,userId:head.user_id,sourceGeneration:head.source_generation,detectorRevision:head.detector_revision,
            level:head.level,mode:head.detector_mode,revision:head.revision,latestPublicationId:head.latest_publication_id};
          if(head.source_generation!==actual.source.generation||head.detector_revision!==actual.source.detector_revision||head.level!==actual.decision.level||head.detector_mode!==actual.decision.mode
            ||publications.length!==head.revision||publications.some((p,i)=>p.edition!==i+1)||head.latest_publication_id!==publications.at(-1)?.id||anchor?.anchor!==publications[0]?.id
            ||JSON.stringify(openDelivery(this.crypto,table,row.id,fixed.userId,head.revision,head.payload_ciphertext))!==JSON.stringify(capture))throw deliveryStorageUnavailable();
          const delivery=this.service(row.kind),captured=await delivery.readPublicationInTransaction(client,fixed,head.latest_publication_id,signal);
          if(captured.row.submission_id!==row.id)throw deliveryStorageUnavailable();
          const live=(await client.query<{live:boolean}>('SELECT $1::timestamptz>clock_timestamp() AS live',[captured.row.retention_until])).rows[0].live;
          const handled=await delivery.verifyHandledInTransaction(client,fixed.userId,row.id,signal);
          sources.push({sourceRef,availability:'ready',publication:{sourceKind:row.kind,publicationId:captured.row.id,submissionId:row.id,edition:captured.row.edition,
            revision:captured.journal.state.revision,status:live?'ready':'expired',level:captured.row.level,mode:captured.row.detector_mode,
            preparedAt:captured.row.prepared_at.toISOString(),publishedAt:captured.row.published_at.toISOString(),retentionUntil:captured.row.retention_until.toISOString(),
            presented:captured.journal.operations.some(op=>op.kind==='present_body'||op.kind==='present_body_evidence'),acknowledged:captured.journal.operations.some(op=>op.kind==='acknowledge'),
            handled,clarifiedAt:captured.journal.operations.find(op=>op.kind==='clarify_exaggeration')?.clarified_at?.toISOString()??null}});
        }catch(error){signal?.throwIfAborted();
          if(!(error instanceof DataCryptoError)&&(!(error instanceof ApiError)||![404,409,503].includes(error.status)))throw error;
          sources.push({sourceRef,availability:'unavailable',publication:null});
        }
      }
      await authorizeFixedSession(client,fixed,signal);signal?.throwIfAborted();return {sources};
    });
  }
  private async publication(context:FixedSessionContext,value:unknown,kind:'publish'|'recover',signal?:AbortSignal){
    const request=parsed(()=>parseCompanionSafetyPublicationRequest(value)),result=await this.service(request.sourceRef.kind)[kind](context,
      {operationId:request.operationId,submissionId:request.sourceRef.submissionId,expectedEdition:request.expectedEdition},signal);
    return result?{sourceKind:request.sourceRef.kind,...result}:null;
  }
  publish(context:FixedSessionContext,value:unknown,signal?:AbortSignal){return this.publication(context,value,'publish',signal);}
  recover(context:FixedSessionContext,value:unknown,signal?:AbortSignal){return this.publication(context,value,'recover',signal);}
  async read(context:FixedSessionContext,value:unknown,signal?:AbortSignal):Promise<CompanionSafetyResourceState>{
    const request=parsed(()=>parseCompanionSafetyTargetRequest(value)),state=await this.service(request.sourceKind).read(context,{publicationId:request.publicationId},signal);
    return {sourceKind:request.sourceKind,...state,handled:await this.handled(context,request.sourceKind,state.submissionId,signal)};
  }
  async readBody(context:FixedSessionContext,value:unknown,signal?:AbortSignal):Promise<CompanionSafetyBodyProjection>{
    const request=parsed(()=>parseCompanionSafetyTargetRequest(value)),projection=await this.service(request.sourceKind).issueBodyProjection(context,{publicationId:request.publicationId},signal);
    return {sourceKind:request.sourceKind,...projection};
  }
  issueBodyProjection(context:FixedSessionContext,value:unknown,signal?:AbortSignal){return this.readBody(context,value,signal);}
  async act(context:FixedSessionContext,value:unknown,signal?:AbortSignal):Promise<CompanionSafetyResourceResult>{
    const request=parsed(()=>parseCompanionSafetyResourceCommand(value)),{sourceKind,...command}=request;
    const result=sourceKind==='onboarding'?await this.intakeDelivery.act(context,command,signal):await this.nameDelivery.act(context,command,signal);
    return {...result,state:{sourceKind,...result.state,handled:await this.handled(context,sourceKind,result.state.submissionId,signal)}};
  }
}
export async function createCompanionSafetyResources(db:Database,config:PlatformConfig,legal:LegalBundle|null,nameDelivery:CompanionNameSafetyDelivery,
  supplied?:CompanionSafetyResourceConfiguration){
  const assets=supplied??await readCompanionSafetyResourceConfiguration(config);
  const intakeDelivery=new OnboardingSafetyDelivery(db,config,legal,assets.bundle,assets.review),resources=new CompanionSafetyResources(db,config.dataCrypto,nameDelivery,intakeDelivery);
  return {resources,intakeDelivery,questionDelivery:new SafetyQuestionDelivery(db,config.dataCrypto,nameDelivery,undefined,intakeDelivery),
    reviewRegistry:new SafetyDeliveryReviewRegistry(db,config.dataCrypto,assets.bundle,assets.review),...assets};
}
