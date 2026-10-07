import { onboardingAnswerSummaries, onboardingQuestionDefinition, parseOnboardingCommand } from '@companion/career-core';
import type { OnboardingEntryState, PlatformProviderRuntime } from '@companion/platform-contracts';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { PlatformConfig } from './config.ts';
import type { Database } from './database.ts';
import { ApiError } from './errors.ts';
import type { LegalBundle } from './legal-documents.ts';
import { resolveModelRoute } from './model-routing.ts';
import { OnboardingDrafts } from './onboarding-drafts.ts';
import { OnboardingStorage } from './onboarding-storage.ts';
import { OnboardingSafetyRunner } from './onboarding-safety-runner.ts';
import { OnboardingSafetyResponses } from './onboarding-safety-responses.ts';
import { OnboardingSafetyFollowup } from './onboarding-safety-followup.ts';
import { assertActiveSafetyDetector, readSafetyDetectorProfile, SafetyDetectorProfileError, type SafetyDetectorProfile } from './safety-detector-profile.ts';
import { readSafetyResponseBundle, SafetyResponseBundleError, type SafetyResponseBundle } from './safety-response-bundle.ts';

/** Student transport composition. The server fixes identity and policy; HTTP never supplies classifier results. */
export class OnboardingEntry {
  readonly drafts: OnboardingDrafts;
  readonly followup: OnboardingSafetyFollowup;
  private readonly storage: OnboardingStorage;
  private readonly responses: OnboardingSafetyResponses;
  private readonly runner: OnboardingSafetyRunner;
  constructor(private readonly db: Database, private readonly config: PlatformConfig,
    private readonly legal: LegalBundle|null, private readonly runtime: PlatformProviderRuntime,
    private readonly profile: SafetyDetectorProfile|null, private readonly responseBundle: SafetyResponseBundle|null) {
    this.storage=new OnboardingStorage(config,legal);
    this.drafts=new OnboardingDrafts(db,config,legal);
    this.responses=new OnboardingSafetyResponses(db,config,legal,responseBundle);
    this.followup=new OnboardingSafetyFollowup(db,config,legal);
    this.runner=new OnboardingSafetyRunner(this.drafts,config,runtime,profile);
  }
  private fixed(context: FixedSessionContext) { return Object.freeze({userId:context.userId,tokenHash:context.tokenHash}); }
  private async assertTextAvailable(context: FixedSessionContext, signal?:AbortSignal) {
    const fixed=this.fixed(context);
    await this.db.withBoundedTransaction(async client=>{
      await this.storage.authorizeSession(client,fixed,signal);
      await assertActiveSafetyDetector(client,this.profile,signal);
      const bundle=this.responseBundle;
      const policy=(await client.query('SELECT revision,content_digest,review_digest FROM platform_safety_response_policy WHERE singleton=true FOR SHARE')).rows[0];
      if (!bundle || !policy || policy.revision!==bundle.revision || policy.content_digest!==bundle.contentDigest || policy.review_digest!==bundle.reviewDigest) {
        throw new ApiError(503,'ONBOARDING_SAFETY_RESPONSE_UNAVAILABLE','Intake text is not available yet.');
      }
      const route=resolveModelRoute(this.config,this.runtime,'safety_classify');
      const providers=this.runtime.capabilities().filter(provider=>provider.id===route.provider);
      if (providers.length!==1 || !providers[0].keyConfigured || !this.runtime.streamModelStep || this.config.safetyDailyModelCallLimit<1) {
        throw new ApiError(503,'ONBOARDING_SAFETY_UNAVAILABLE','Intake text is not available yet.');
      }
      await authorizeFixedSession(client,fixed,signal);
    });
  }
  /** Fixed resources are readable without current model/terms/quota availability. */
  async resources(context: FixedSessionContext, signal?:AbortSignal) {
    const fixed=this.fixed(context);
    let state=await this.followup.read(fixed,signal);
    for (const pending of state.pendingResponses) {
      if (pending.status!=='pending') continue;
      try { await this.responses.prepareSubmission(pending.submissionId,signal); }
      catch (error) {
        signal?.throwIfAborted();
        // Missing approved content remains pending. Storage damage and unexpected failures do not disappear.
        if (!(error instanceof ApiError) || error.code!=='ONBOARDING_SAFETY_RESPONSE_UNAVAILABLE') throw error;
      }
    }
    state=await this.followup.read(fixed,signal); return state;
  }
  async read(context: FixedSessionContext, signal?:AbortSignal):Promise<OnboardingEntryState> {
    const fixed=this.fixed(context);
    await this.drafts.read(fixed,signal); // Normal intake still requires current student admission.
    const state=await this.resources(fixed,signal);
    let freeTextAvailable=false;
    try { await this.assertTextAvailable(fixed,signal); freeTextAvailable=true; }
    catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof ApiError) || !['ONBOARDING_SAFETY_UNAVAILABLE','ONBOARDING_SAFETY_RESPONSE_UNAVAILABLE','MODEL_ROUTE_UNAVAILABLE'].includes(error.code)) throw error;
    }
    const definition=state.draft?.currentQuestion?onboardingQuestionDefinition(state.draft.currentQuestion):null;
    const question=definition?{questionId:definition.questionId,prompt:definition.prompt,choices:definition.choices}:null;
    const answerSummaries=state.draft?onboardingAnswerSummaries(state.draft):[];
    return {...state,freeTextAvailable,question,answerSummaries};
  }
  async save(context: FixedSessionContext, value:unknown, signal?:AbortSignal) {
    const fixed=this.fixed(context);
    let command;
    try { command=parseOnboardingCommand(value); }
    catch { throw new ApiError(400,'INVALID_INPUT','Use a valid intake operation.'); }
    if (command.action.kind==='text') await this.assertTextAvailable(fixed,signal);
    const result=await this.drafts.save(fixed,command,signal);
    // Saving is acknowledged independently of detection. A failed detector leaves a recoverable pending source.
    return result;
  }
  async retrySafety(context:FixedSessionContext, signal?:AbortSignal) {
    const fixed=this.fixed(context);
    await this.drafts.read(fixed,signal);
    try { await this.runner.runNext(fixed,signal); }
    catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof ApiError) || !['ONBOARDING_SAFETY_UNAVAILABLE','ONBOARDING_SAFETY_CLAIM_CHANGED'].includes(error.code)) throw error;
    }
    return this.read(fixed,signal);
  }
}
export async function createOnboardingEntry(db:Database,config:PlatformConfig,legal:LegalBundle|null,runtime:PlatformProviderRuntime) {
  const [detector,resources]=await Promise.allSettled([readSafetyDetectorProfile(config.safetyDetectorProfilePath),readSafetyResponseBundle(config.safetyResponseBundlePath)]);
  // Invalid current intake assets close new text/classification, while previously authenticated resources remain readable.
  // Their original encrypted captures and review provenance are still verified; no replacement content is invented.
  if(detector.status==='rejected'&&!(detector.reason instanceof SafetyDetectorProfileError))throw detector.reason;
  if(resources.status==='rejected'&&!(resources.reason instanceof SafetyResponseBundleError))throw resources.reason;
  const profile=detector.status==='fulfilled'?detector.value:null,bundle=resources.status==='fulfilled'?resources.value:null;
  return new OnboardingEntry(db,config,legal,runtime,profile,bundle);
}
