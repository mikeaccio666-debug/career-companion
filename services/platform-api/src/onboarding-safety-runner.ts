import type { PlatformProviderRuntime } from '@companion/platform-contracts';
import type { FixedSessionContext } from './auth.ts';
import type { PlatformConfig } from './config.ts';
import { ApiError } from './errors.ts';
import { OnboardingDrafts } from './onboarding-drafts.ts';
import { createOnboardingSafetyClassifier } from './onboarding-safety-classifier.ts';
import { resolveModelRoute } from './model-routing.ts';
import { createSafetyModelUsage } from './safety-model-usage.ts';
import { readSafetyDetectorProfile, safetyDetectorUnavailable, type SafetyDetectorProfile } from './safety-detector-profile.ts';

/** Server-only integration. This is not a student route, scheduler or approval to open O1. */
export class OnboardingSafetyRunner {
  private readonly config: Pick<PlatformConfig, 'modelRoutes' | 'safetyDailyModelCallLimit'>;
  constructor(private readonly drafts: OnboardingDrafts, config: Pick<PlatformConfig, 'modelRoutes' | 'safetyDailyModelCallLimit'>,
    private readonly runtime: PlatformProviderRuntime, private readonly profile: SafetyDetectorProfile | null) {
    this.config = { modelRoutes: structuredClone(config.modelRoutes), safetyDailyModelCallLimit: config.safetyDailyModelCallLimit };
  }
  async runNext(context: FixedSessionContext, signal?: AbortSignal) {
    const fixed = Object.freeze({ userId: context.userId, tokenHash: context.tokenHash });
    if (!this.profile) { await this.drafts.readSafety(fixed, signal); throw safetyDetectorUnavailable(); }
    const claim = await this.drafts.claimSafety(fixed, { detectorRevision: this.profile.revision }, signal);
    if (!claim) return null;
    let usage;
    try { usage = createSafetyModelUsage(this.drafts.db, claim, resolveModelRoute(this.config, this.runtime, 'safety_classify'), this.config.safetyDailyModelCallLimit); }
    catch { /* Missing provider metadata disables the model, without disabling reviewed keyword signals. */ }
    try {
      const executor = createOnboardingSafetyClassifier({ claim, profile: this.profile, config: this.config, runtime: this.runtime, usage });
      return await this.drafts.processSafety(claim, executor.classify, signal, executor.guard);
    } catch (error) {
      // Only an actual, still-current claim can return to pending. Never erase a newer generation or manufacture a result.
      await this.drafts.failSafety(claim, error instanceof ApiError && error.code === 'INVALID_SAFETY_RESULT' ? 'invalid_result' : 'unavailable').catch(() => {});
      if (error instanceof ApiError) throw error;
      throw safetyDetectorUnavailable();
    }
  }
}
/** Capture one checked server profile at startup. Explicit malformed/unreadable profiles fail with a bounded error. */
export async function createOnboardingSafetyRunner(drafts: OnboardingDrafts, config: Pick<PlatformConfig, 'modelRoutes' | 'safetyDailyModelCallLimit' | 'safetyDetectorProfilePath'>, runtime: PlatformProviderRuntime) {
  return new OnboardingSafetyRunner(drafts, config, runtime, await readSafetyDetectorProfile(config.safetyDetectorProfilePath));
}
