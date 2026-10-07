import type { PlatformProviderRuntime } from '@companion/platform-contracts';
import type { PoolClient } from 'pg';
import type { FixedSessionContext } from './auth.ts';
import type { PlatformConfig } from './config.ts';
import { ApiError } from './errors.ts';
import { CompanionNameSafety } from './companion-name-safety.ts';
import { createCompanionNameSafetyClassifier } from './companion-name-safety-classifier.ts';
import { parseCompanionNameTask } from './companion-name-safety-protocol.ts';
import { resolveModelRoute } from './model-routing.ts';
import { createCompanionNameSafetyModelUsage } from './safety-model-usage.ts';
import { assertActiveSafetyDetector, readSafetyDetectorProfile, type SafetyDetectorProfile } from './safety-detector-profile.ts';

const unavailable = () => new ApiError(503, 'COMPANION_NAME_SAFETY_UNAVAILABLE', 'Name detection is not available.');
/** Server-only execution for already committed name inputs. A read never launches
 * a classifier, and detection does not itself select a seal or create a room. */
export class CompanionNameSafetyRunner {
  private readonly config: Pick<PlatformConfig, 'modelRoutes' | 'safetyDailyModelCallLimit'>;
  constructor(private readonly names: CompanionNameSafety, config: Pick<PlatformConfig, 'modelRoutes' | 'safetyDailyModelCallLimit'>,
    private readonly runtime: PlatformProviderRuntime, private readonly profile: SafetyDetectorProfile | null) {
    this.config = { modelRoutes: structuredClone(config.modelRoutes), safetyDailyModelCallLimit: config.safetyDailyModelCallLimit };
  }
  async runNext(context: FixedSessionContext, value: { taskId: string }, signal?: AbortSignal) {
    const fixed = Object.freeze({ userId: context.userId, tokenHash: context.tokenHash }), taskId = parseCompanionNameTask(value);
    if (!this.profile) { await this.names.read(fixed, { taskId }, signal); throw unavailable(); }
    const claim = await this.names.claim(fixed, { taskId, detectorRevision: this.profile.revision }, signal);
    if (!claim) return null;
    const profile = this.profile;
    let executionGuard: ((client: PoolClient, signal?: AbortSignal) => Promise<void>) | undefined;
    try {
      return await this.names.process(claim, async (input, admission, execution) => {
        // The real process has now committed its execution token. No fabricated
        // claim or caller-supplied decision is used to construct the usage adapter.
        let usage;
        try { usage = createCompanionNameSafetyModelUsage(this.names.db, claim,
          resolveModelRoute(this.config, this.runtime, 'safety_classify'), this.config.safetyDailyModelCallLimit, execution); }
        catch { /* Missing provider metadata disables only the model path. */ }
        const classifier = createCompanionNameSafetyClassifier({ claim, profile, config: this.config, runtime: this.runtime, usage });
        executionGuard = classifier.guard;
        return classifier.classify(input, admission);
      }, signal, async (client, guardedSignal) => {
        try {
          if (executionGuard) await executionGuard(client, guardedSignal);
          else await assertActiveSafetyDetector(client, profile, guardedSignal);
        } catch { if (guardedSignal?.aborted) guardedSignal.throwIfAborted(); throw unavailable(); }
      });
    } catch (error) {
      await this.names.fail(claim, error instanceof ApiError && error.code === 'INVALID_SAFETY_RESULT' ? 'invalid_result' : 'unavailable').catch(() => {});
      if (error instanceof ApiError) throw error;
      throw unavailable();
    }
  }
}
export async function createCompanionNameSafetyRunner(names: CompanionNameSafety,
  config: Pick<PlatformConfig, 'modelRoutes' | 'safetyDailyModelCallLimit' | 'safetyDetectorProfilePath'>, runtime: PlatformProviderRuntime) {
  return new CompanionNameSafetyRunner(names, config, runtime, await readSafetyDetectorProfile(config.safetyDetectorProfilePath));
}
