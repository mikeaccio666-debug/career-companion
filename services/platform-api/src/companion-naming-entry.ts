import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { CompanionNamingAccepted, CompanionNamingProgress, CompanionNamingState, PlatformProviderRuntime } from '@companion/platform-contracts';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { BackgroundGeneration } from './background-generation.ts';
import type { PlatformConfig } from './config.ts';
import type { Database } from './database.ts';
import type { LegalBundle } from './legal-documents.ts';
import { ApiError } from './errors.ts';
import { CompanionNameSafety } from './companion-name-safety.ts';
import { CompanionNameSafetyRunner, createCompanionNameSafetyRunner } from './companion-name-safety-runner.ts';
import { CompanionNameSafetyResponses } from './companion-name-safety-responses.ts';
import { CompanionNameSafetyDelivery } from './companion-name-safety-delivery.ts';
import { CompanionPrebirthSafety } from './companion-prebirth-safety.ts';
import { CompanionIdentityDrafts } from './companion-identity-drafts.ts';
import { OnboardingStorage } from './onboarding-storage.ts';
import { verifyPrebirthInventoryInTransaction } from './companion-prebirth-protocol.ts';
import { companionNameUuid, parseCompanionNameSubmissionRequest } from './companion-name-safety-protocol.ts';
import { readSafetyResponseBundle, type SafetyResponseBundle } from './safety-response-bundle.ts';
import { acceptNameDispatchInTransaction, companionNameNotification, nameDispatchUnavailable, readNameDispatchInTransaction,
  recordNameDispatchStage, type AuthenticatedNameDispatch, type CompanionNameNotification, type NameDispatchHold } from './companion-name-dispatch-protocol.ts';

const fixed=(context:FixedSessionContext)=>Object.freeze({userId:context.userId,tokenHash:context.tokenHash});
const digest=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
const notification=(d:AuthenticatedNameDispatch):CompanionNameNotification=>({dispatchId:d.row.id,taskId:d.row.task_id,submissionId:d.row.submission_id});
/** Accepted execution is server-owned. Observers never submit, renew, classify,
 * apply, adopt an inventory, enqueue or prepare a resource. */
export class CompanionNamingEntry {
  private readonly storage:OnboardingStorage;
  constructor(readonly db:Database,readonly config:PlatformConfig,legal:LegalBundle|null,
    private readonly names:CompanionNameSafety,private readonly runner:CompanionNameSafetyRunner,private readonly prebirth:CompanionPrebirthSafety,
    private readonly resources?:CompanionNameSafetyResponses) {
    this.storage=new OnboardingStorage(config,legal);
  }
  private async viewer(client:PoolClient,context:FixedSessionContext,signal?:AbortSignal) {
    await authorizeFixedSession(client,context,signal);
    const owner=(await client.query<{account_kind:string}>('SELECT account_kind FROM platform_users WHERE id=$1 FOR NO KEY UPDATE',[context.userId])).rows[0];
    if(!owner||owner.account_kind!=='student')throw new ApiError(403,'STUDENT_ACCOUNT_REQUIRED','Use a student account for private naming progress.');
    if(!this.storage.crypto)throw nameDispatchUnavailable();
    await verifyPrebirthInventoryInTransaction(client,this.storage.crypto,context.userId,signal);
  }
  private async progress(client:PoolClient,d:AuthenticatedNameDispatch,signal?:AbortSignal):Promise<CompanionNamingProgress> {
    const source=await this.names.observeSubmissionInTransaction(client,d.row.submission_id,signal);
    const queue=(await client.query<{held_reason:NameDispatchHold|null}>('SELECT held_reason FROM platform_companion_name_dispatch_outbox WHERE dispatch_id=$1 FOR UPDATE',[d.row.id])).rows[0];
    if(!queue)throw nameDispatchUnavailable();
    const completion=d.operations.at(-1)?.kind==='application'||d.operations.at(-1)?.kind==='resource';
    const reason=d.hold??(queue.held_reason==='terminal'&&completion?null:queue.held_reason);
    let resource:CompanionNamingProgress['resource']=source.status==='detected'?'not_required':'not_determined';
    if(source.status==='detected'&&source.level!=='L0') {
      resource=this.resources?'pending':'unavailable';
      if(this.resources) {
        try {
          const capture=await this.resources.readCaptureInTransaction(client,source.id,signal),record=d.operations.filter(x=>x.kind==='resource').at(-1);
          if(record&&(!capture?.row.payload_ciphertext||record.evidence.responseId!==capture.row.id||record.evidence.captureDigest!==digest(capture.row.payload_ciphertext)))throw nameDispatchUnavailable();
          if(capture)resource='ready';
        }
        catch(error) {signal?.throwIfAborted();if(d.operations.some(x=>x.kind==='resource')||!(error instanceof ApiError)||!['COMPANION_NAME_RESOURCE_UNAVAILABLE','COMPANION_NAME_SAFETY_RESPONSE_UNAVAILABLE'].includes(error.code))throw error;resource=reason==='configuration'?'unavailable':'pending';}
      }
    }
    const uncertain=source.status!=='detected'&&source.generation>0&&source.status==='pending';
    const hold=uncertain?'requires_review' as const:reason===null?null:reason==='authorization'?'authorization_required' as const:
      reason==='configuration'?'configuration_unavailable' as const:'requires_review' as const;
    return {dispatchId:d.row.id,taskId:source.task_id,submissionId:source.id,submittedRevision:source.submitted_revision,
      phase:hold?'held':source.status==='detected'?'detected':source.status==='running'?'checking':'queued',hold,
      detection:{status:source.status,generation:source.generation,level:source.level,mode:source.detector_mode},
      application:{status:source.application_status,rejectedCategory:source.rejected_category,identityRevision:source.applied_identity_revision},resource};
  }
  private async accepted(client:PoolClient,d:AuthenticatedNameDispatch,replayed:boolean,signal?:AbortSignal):Promise<CompanionNamingAccepted> {
    return {acceptance:{...notification(d),operation:{id:d.row.operation_id,appliedRevision:d.row.submitted_revision,replayed}},progress:await this.progress(client,d,signal)};
  }
  async accept(context:FixedSessionContext,value:unknown,signal?:AbortSignal):Promise<CompanionNamingAccepted> {
    const captured=fixed(context),input=parseCompanionNameSubmissionRequest(value);
    return this.db.withBoundedTransaction(async client=>{
      const saved=await this.names.submitInTransaction(client,captured,input,signal);
      if(saved.operation.replayed) {
        const source=(await client.query<{first_name_dispatch_id:string|null}>('SELECT first_name_dispatch_id FROM platform_companion_name_submissions WHERE id=$1 AND user_id=$2 FOR UPDATE',[saved.submissionId,captured.userId])).rows[0];
        if(!source?.first_name_dispatch_id)throw new ApiError(409,'COMPANION_NAME_OPERATION_CONFLICT','This source predates managed naming acceptance. Use a new operation.');
      }
      const d=await acceptNameDispatchInTransaction(client,this.storage.crypto,saved.submissionId,signal),out=await this.accepted(client,d,saved.operation.replayed,signal);
      await authorizeFixedSession(client,captured,signal);signal?.throwIfAborted();return out;
    });
  }
  async read(context:FixedSessionContext,signal?:AbortSignal):Promise<CompanionNamingState> {
    const captured=fixed(context);
    return this.db.withBoundedTransaction(async client=>{
      await this.viewer(client,captured,signal);
      const entries=(await client.query<{task_id:string;companion_id:string;revision:number;latest_submission_id:string}>(
        `SELECT e.task_id,e.companion_id,e.revision,e.latest_submission_id FROM platform_companion_name_entries e
          JOIN platform_companions c ON c.id=e.companion_id AND c.user_id=e.user_id
          WHERE e.user_id=$1 AND c.status IN ('drafting','awaiting_name','active') FOR UPDATE OF e,c`,[captured.userId])).rows;
      if(entries.length>1)throw nameDispatchUnavailable();const entry=entries[0];
      if(!entry){await authorizeFixedSession(client,captured,signal);signal?.throwIfAborted();return {kind:'not_started'};}
      const source=await this.names.observeSubmissionInTransaction(client,entry.latest_submission_id,signal);
      if(source.user_id!==captured.userId||source.task_id!==entry.task_id||source.companion_id!==entry.companion_id||source.submitted_revision!==entry.revision)throw nameDispatchUnavailable();
      const anchor=source.first_name_dispatch_id;
      const latest=anchor?await this.progress(client,await readNameDispatchInTransaction(client,this.storage.crypto,{dispatchId:anchor,taskId:source.task_id,submissionId:source.id},signal),signal):null;
      await authorizeFixedSession(client,captured,signal);signal?.throwIfAborted();return {kind:'naming',entry:{taskId:entry.task_id,companionId:entry.companion_id,
        revision:entry.revision,latestSubmissionId:entry.latest_submission_id},latest};
    });
  }
  async readOperation(context:FixedSessionContext,operationId:string,signal?:AbortSignal):Promise<CompanionNamingAccepted|null> {
    const captured=fixed(context),id=companionNameUuid(operationId);
    return this.db.withBoundedTransaction(async client=>{
      await this.viewer(client,captured,signal);
      const rows=(await client.query<{id:string;task_id:string;submission_id:string}>('SELECT id,task_id,submission_id FROM platform_companion_name_dispatches WHERE user_id=$1 AND operation_id=$2 FOR UPDATE',[captured.userId,id])).rows;
      if(rows.length>1)throw nameDispatchUnavailable();
      const row=rows[0],out=row?await this.accepted(client,await readNameDispatchInTransaction(client,this.storage.crypto,{dispatchId:row.id,taskId:row.task_id,submissionId:row.submission_id},signal),true,signal):null;
      await authorizeFixedSession(client,captured,signal);signal?.throwIfAborted();return out;
    });
  }
  private async hold(value:CompanionNameNotification,reason:NameDispatchHold,signal?:AbortSignal) {
    await this.db.withBoundedTransaction(async client=>{
      const d=await readNameDispatchInTransaction(client,this.storage.crypto,value,signal);
      // Do not downgrade real start uncertainty into an automatically retried config hold.
      const actual=d.source.status!=='detected'&&(d.operations.some(x=>x.kind==='start')||d.source.generation>0&&d.source.status==='pending')?'requires_review':reason;
      await recordNameDispatchStage(client,this.storage.crypto,d,'hold',{reason:actual},signal);
    });
  }
  async executeNotification(value:unknown,signal?:AbortSignal):Promise<void> {
    const notice=companionNameNotification(value);signal?.throwIfAborted();
    const target=await this.db.withBoundedTransaction(async client=>{
      const d=await readNameDispatchInTransaction(client,this.storage.crypto,notice,signal);
      await this.names.observeSubmissionInTransaction(client,d.row.submission_id,signal);return d;
    });
    const context=fixed({userId:target.row.user_id,tokenHash:target.snapshot.originalSessionHash});
    if(target.source.status!=='detected') {
      if(target.source.status==='running'&&(await this.db.query('SELECT lease_until>clock_timestamp() AS active FROM platform_companion_name_submissions WHERE id=$1',[target.source.id])).rows[0]?.active)return;
      try {await this.runner.runAcceptedSubmission(context,notice,signal);}
      catch(error) {
        signal?.throwIfAborted();const reason=error instanceof ApiError&&['AUTH_REQUIRED','TERMS_CONFIRMATION_REQUIRED','EMAIL_VERIFICATION_REQUIRED'].includes(error.code)?'authorization':
          error instanceof ApiError&&error.code==='COMPANION_NAME_SAFETY_UNAVAILABLE'?'configuration':'requires_review';
        await this.hold(notice,reason,signal);return;
      }
    }
    const detected=await this.db.withBoundedTransaction(async client=>{
      const d=await readNameDispatchInTransaction(client,this.storage.crypto,notice,signal),source=await this.names.observeSubmissionInTransaction(client,d.row.submission_id,signal);
      if(source.status!=='detected')return null;return source;
    });
    if(!detected)return;
    if(detected.level==='L0') {
      try {
        if(detected.application_status==='pending') {
          await this.db.withBoundedTransaction(async client=>{
            const version=await this.storage.authorizeSession(client,context,signal);
            if(version!==String(detected.submitted_auth_version))throw new ApiError(401,'AUTH_REQUIRED','The original naming authorization has ended.');
            await this.prebirth.assertCurrentWriteInTransaction(client,context,{taskId:detected.task_id},signal);
            await this.names.applyInTransaction(client,context,{taskId:detected.task_id,submissionId:detected.id},signal);
            const d=await readNameDispatchInTransaction(client,this.storage.crypto,notice,signal),source=await this.names.observeSubmissionInTransaction(client,detected.id,signal);
            if(!source.application_ciphertext||source.application_status==='pending')throw nameDispatchUnavailable();
            await recordNameDispatchStage(client,this.storage.crypto,d,'application',{status:source.application_status,applicationDigest:digest(source.application_ciphertext),identityRevision:source.applied_identity_revision,rejectedCategory:source.rejected_category},signal);
            await authorizeFixedSession(client,context,signal);signal?.throwIfAborted();
          });
        } else await this.db.withBoundedTransaction(async client=>{
          const d=await readNameDispatchInTransaction(client,this.storage.crypto,notice,signal),source=await this.names.observeSubmissionInTransaction(client,detected.id,signal);
          if(!source.application_ciphertext)throw nameDispatchUnavailable();
          await recordNameDispatchStage(client,this.storage.crypto,d,'application',{status:source.application_status,applicationDigest:digest(source.application_ciphertext),identityRevision:source.applied_identity_revision,rejectedCategory:source.rejected_category},signal);
        });
      } catch(error) {signal?.throwIfAborted();await this.hold(notice,error instanceof ApiError&&['AUTH_REQUIRED','TERMS_CONFIRMATION_REQUIRED','EMAIL_VERIFICATION_REQUIRED'].includes(error.code)?'authorization':'requires_review',signal);}
    } else {
      // Already saved risk resources use their own target-only historical proof.
      // They need no renewed model/session/terms/quota permission.
      try {
        if(!this.resources)throw new ApiError(503,'COMPANION_NAME_SAFETY_RESPONSE_UNAVAILABLE','Fixed resources are not configured.');
        await this.resources.prepareSubmission(detected.id,signal);
        await this.db.withBoundedTransaction(async client=>{
          const d=await readNameDispatchInTransaction(client,this.storage.crypto,notice,signal),capture=await this.resources!.readCaptureInTransaction(client,detected.id,signal);
          if(!capture?.row.payload_ciphertext)throw nameDispatchUnavailable();
          await recordNameDispatchStage(client,this.storage.crypto,d,'resource',{responseId:capture.row.id,captureDigest:digest(capture.row.payload_ciphertext)},signal);
        });
      } catch(error) {signal?.throwIfAborted();await this.hold(notice,error instanceof ApiError&&['COMPANION_NAME_RESOURCE_UNAVAILABLE','COMPANION_NAME_SAFETY_RESPONSE_UNAVAILABLE'].includes(error.code)?'configuration':'storage',signal);}
    }
  }
}
/** App/worker share the existing actual background. Loading files grants no
 * activation/review or public resource/question access. Invalid/missing new
 * configuration disables new work without preventing default app startup. */
export async function createCompanionNamingEntry(db:Database,config:PlatformConfig,legal:LegalBundle|null,runtime:PlatformProviderRuntime,background:BackgroundGeneration) {
  const identities=await CompanionIdentityDrafts.fromConfiguration(db,config,legal,background);
  let bundle:SafetyResponseBundle|null=null;try {bundle=await readSafetyResponseBundle(config.safetyResponseBundlePath);}catch { /* unavailable */ }
  const resources=new CompanionNameSafetyResponses(db,config,bundle);
  const delivery=new CompanionNameSafetyDelivery(db,config,legal,resources,bundle,null);
  const names=new CompanionNameSafety(db,config,legal,background,identities,delivery);
  let runner:CompanionNameSafetyRunner;
  try {runner=await createCompanionNameSafetyRunner(names,config,runtime);}catch {runner=new CompanionNameSafetyRunner(names,config,runtime,null);}
  return new CompanionNamingEntry(db,config,legal,names,runner,new CompanionPrebirthSafety(db,config,legal,background,names,identities),resources);
}
