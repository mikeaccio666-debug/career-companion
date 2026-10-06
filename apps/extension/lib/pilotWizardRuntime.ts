import { readDeclaredWizardStep, type DeclaredWizardStep } from '@edaix/apply-kernel/wizardIdentity';
import { readResolvedDiscoveryWizardDeclaration, type ResolvedContentWizardRuntimeAuthority } from './executionRuntimeAuthority';

/** Opaque content-local handle. Selectors and authority callbacks are never serialized. */
export interface PilotWizardRuntime {
  readonly scope: 'LOCAL_SESSION';
  readonly rulesetDigest: string;
  readonly runtimeBundleVersion: string;
}

type StepResult = Readonly<{ ok: true; value: DeclaredWizardStep }> |
  Readonly<{ ok: false; code: 'PILOT_DISCOVERY_UNAVAILABLE' | 'PILOT_TARGET_DRIFT' }>;
const unavailable = (): StepResult => ({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });
const runtimes = new WeakMap<PilotWizardRuntime, Readonly<{
  isCurrent(): boolean;
  read(isVisible: (element: Element) => boolean): StepResult;
}>>();

/**
 * Adapt the existing verified discovery authority, never infer its ATS mapping.
 * The caller's currentness proof must cover its fresh authority/storage revision;
 * the clock and exact document URL/root are independently checked here. This
 * handle confers no owner, Mission, write, Next, or Submit authorization.
 */
export function createPilotWizardRuntime(input: Readonly<{
  authority: ResolvedContentWizardRuntimeAuthority;
  document: Document;
  location: Location;
  now: () => number;
  isAuthorityCurrent: () => boolean;
}>): PilotWizardRuntime | null {
  try {
    const declaration = readResolvedDiscoveryWizardDeclaration(input.authority);
    if (declaration === null) return null;
    const href = input.location.href, root = input.document.documentElement;
    const deadline = Math.min(input.authority.freshUntilMs, input.authority.notAfterMs);
    let lastTime = input.now(), retired = false;
    const isCurrent = (): boolean => {
      if (retired) return false;
      try {
        const time = input.now();
        if (!Number.isSafeInteger(lastTime) || !Number.isSafeInteger(time) || time < lastTime ||
            !Number.isSafeInteger(deadline) || time >= deadline || input.location.href !== href ||
            input.document.documentElement !== root || input.isAuthorityCurrent() !== true) retired = true;
        lastTime = time;
      } catch { retired = true; }
      return !retired;
    };
    if (!isCurrent()) return null;
    const handle: PilotWizardRuntime = Object.freeze({ scope: 'LOCAL_SESSION',
      rulesetDigest: input.authority.authorization.rulesetDigest,
      runtimeBundleVersion: input.authority.authorization.runtimeBundleVersion,
    });
    runtimes.set(handle, Object.freeze({
      isCurrent,
      read(isVisible) {
        if (!isCurrent()) return unavailable();
        const result = readDeclaredWizardStep({ declaration, document: input.document, isVisible });
        return isCurrent() ? result : unavailable();
      },
    }));
    return handle;
  } catch { return null; }
}

export function isPilotWizardRuntimeCurrent(runtime: PilotWizardRuntime): boolean {
  return runtimes.get(runtime)?.isCurrent() === true;
}

export function readPilotWizardRuntimeStep(runtime: PilotWizardRuntime, isVisible: (element: Element) => boolean): StepResult {
  return runtimes.get(runtime)?.read(isVisible) ?? unavailable();
}
