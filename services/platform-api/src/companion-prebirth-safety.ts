import type { PoolClient } from 'pg';
import type { CompanionSealSelectionSaved } from '@companion/platform-contracts';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { BackgroundGeneration } from './background-generation.ts';
import type { PlatformConfig } from './config.ts';
import type { Database } from './database.ts';
import type { LegalBundle } from './legal-documents.ts';
import { OnboardingStorage } from './onboarding-storage.ts';
import { CompanionNameSafety } from './companion-name-safety.ts';
import { CompanionIdentityDrafts, selectionCommand } from './companion-identity-drafts.ts';
import { parseCompanionNameApplication, parseCompanionNameTask } from './companion-name-safety-protocol.ts';
import { syncPrebirthInventoryInTransaction, verifyPrebirthInventoryInTransaction } from './companion-prebirth-protocol.ts';
import { ApiError } from './errors.ts';

const fixed = (context:FixedSessionContext) => Object.freeze({userId:context.userId,tokenHash:context.tokenHash});

/** Internal complete prebirth composition. No returned proof authorizes a later
 * transaction. Admission, all authentic intake/name sources, current preview,
 * application provenance and writes share the owner lock and one real COMMIT. */
export class CompanionPrebirthSafety {
  private readonly storage:OnboardingStorage;
  constructor(readonly db:Database, config:Pick<PlatformConfig,'dataCrypto'|'requireVerifiedEmail'>, legal:LegalBundle|null,
    private readonly background:BackgroundGeneration, private readonly names:CompanionNameSafety,
    private readonly identities:CompanionIdentityDrafts) {
    this.storage=new OnboardingStorage(config,legal);
  }
  async assertCurrentWriteInTransaction(client:PoolClient,context:FixedSessionContext,value:unknown,signal?:AbortSignal):Promise<void> {
    const contextSnapshot=fixed(context),taskId=parseCompanionNameTask(value);
    // Every writer starts with the actual owner before session/draft/source
    // locks, serializing even an entry or raw text that did not exist yet.
    await this.storage.authorizeSession(client,contextSnapshot,signal);
    await verifyPrebirthInventoryInTransaction(client,this.storage.crypto,contextSnapshot.userId,signal);
    const row=await this.storage.row(client,contextSnapshot.userId);
    if(!row) throw new ApiError(409,'ONBOARDING_SAFETY_REQUIRED','Complete the current intake before continuing.');
    const draft=this.storage.decode(row), sources=await this.storage.recover(client,draft);
    // Explicit first legacy adoption: only genuine surviving raw inputs are
    // sealed, under this same owner lock. Adopted missing history is never reset.
    await syncPrebirthInventoryInTransaction(client,this.storage.crypto,contextSnapshot.userId,signal);
    const handled=await this.storage.handledSources(client,draft,sources), state=this.storage.safetyState(sources,handled);
    if(state.status==='blocked') throw new ApiError(409,'ONBOARDING_SAFETY_REVIEW_REQUIRED','The intake safety response must be handled before continuing.');
    if(state.status!=='clear' || sources.some(source=>!handled.has(source.id) && (source.status!=='detected' || source.level!=='L0' || source.detector_mode!=='full')))
      throw new ApiError(409,'ONBOARDING_SAFETY_REQUIRED','Wait for the complete current intake safety check before continuing.');
    // Handled risks remain their actual L1/L2 and cannot provide profile facts.
    // background's seed still enforces current revision, questionnaire, rules,
    // classified dimensions and the original authentic generation provenance.
    await this.names.assertPrebirthNamesInTransaction(client,contextSnapshot,signal);
    const current=await this.background.readInTransaction(client,contextSnapshot,{taskId},signal);
    if(!current) throw new ApiError(409,'COMPANION_PREVIEW_REQUIRED','Wait for the current completed companion preview.');
    await authorizeFixedSession(client,contextSnapshot,signal); signal?.throwIfAborted();
  }
  async apply(context:FixedSessionContext,value:unknown,signal?:AbortSignal) {
    const contextSnapshot=fixed(context), input=parseCompanionNameApplication(value);
    return this.db.withBoundedTransaction(async client=>{
      await this.assertCurrentWriteInTransaction(client,contextSnapshot,{taskId:input.taskId},signal);
      const result=await this.names.applyInTransaction(client,contextSnapshot,input,signal);
      await authorizeFixedSession(client,contextSnapshot,signal); signal?.throwIfAborted(); return result;
    });
  }
  async select(context:FixedSessionContext,value:unknown,signal?:AbortSignal):Promise<Readonly<CompanionSealSelectionSaved>> {
    const contextSnapshot=fixed(context),input=selectionCommand(value);
    return this.db.withBoundedTransaction(async client=>{
      await this.assertCurrentWriteInTransaction(client,contextSnapshot,{taskId:input.taskId},signal);
      await this.names.assertCurrentIdentityProvenanceInTransaction(client,contextSnapshot,{taskId:input.taskId},signal);
      const result=await this.identities.saveSelectionInTransaction(client,contextSnapshot,input,signal);
      await authorizeFixedSession(client,contextSnapshot,signal); signal?.throwIfAborted(); return result;
    });
  }
}
