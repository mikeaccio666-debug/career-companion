import { parsePilotUa4FinalDisposition, parseUnobservedRegions, PILOT_UA4_MAX_UNOBSERVED_REGIONS,
  type PilotUa4FinalDisposition, type PilotUa4UnobservedRegion } from './pilotUa4WriteAuthority.ts';

export interface PilotLocalWizardStepIdentity {
  readonly identityDigest: string;
  /** Index in the declared linear sequence; no application-wide denominator. */
  readonly stepIndex: number;
}

export interface PilotLocalWizardCheckpoint extends PilotLocalWizardStepIdentity {
  readonly discoveryComplete: boolean;
  readonly requiredDispositions: readonly Readonly<{ questionId: string; disposition: PilotUa4FinalDisposition }>[];
  readonly unobservedRegions: readonly PilotUa4UnobservedRegion[];
}

/** Memory-only display history. This is neither a Mission nor any execution authority. */
export interface PilotLocalWizardProjection {
  readonly schemaVersion: 1;
  readonly scope: 'LOCAL_SESSION';
  readonly sessionDigest: string;
  readonly currentStep: PilotLocalWizardStepIdentity | null;
  readonly checkpoints: readonly PilotLocalWizardCheckpoint[];
}

const DIGEST = /^[a-f0-9]{64}$/u;
const QUESTION = /^[A-Za-z0-9._:-]{1,128}$/u;
const invalid = () => Object.freeze({ ok: false as const, code: 'PILOT_UA5_INPUT_INVALID' as const });
function record(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(descriptors);
  if (names.length !== keys.length || names.some((key) => typeof key !== 'string' || !keys.includes(key))) return null;
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const property = descriptors[key];
    if (!property || !('value' in property) || !property.enumerable) return null;
    result[key] = property.value;
  }
  return result;
}
function array(value: unknown, maximum: number): readonly unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const props = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  const length = props.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum || Reflect.ownKeys(props).length !== length + 1) return null;
  const result: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const property = props[String(i)];
    if (!property || !('value' in property) || !property.enumerable) return null;
    result.push(property.value);
  }
  return result;
}
function step(value: Record<string, unknown>): PilotLocalWizardStepIdentity | null {
  return typeof value.identityDigest === 'string' && DIGEST.test(value.identityDigest) &&
    Number.isSafeInteger(value.stepIndex) && Number(value.stepIndex) >= 0 && Number(value.stepIndex) < 64
    ? Object.freeze({ identityDigest: value.identityDigest, stepIndex: Number(value.stepIndex) }) : null;
}

export function parsePilotLocalWizardProjection(input: unknown):
  Readonly<{ ok: true; value: PilotLocalWizardProjection }> | ReturnType<typeof invalid> {
  try {
    const value = record(input, ['schemaVersion', 'scope', 'sessionDigest', 'currentStep', 'checkpoints']);
    if (!value || value.schemaVersion !== 1 || value.scope !== 'LOCAL_SESSION' ||
        typeof value.sessionDigest !== 'string' || !DIGEST.test(value.sessionDigest)) return invalid();
    const entries = array(value.checkpoints, 64);
    if (entries === null) return invalid();
    const checkpoints: PilotLocalWizardCheckpoint[] = [], digests = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      const fields = record(entry, ['identityDigest', 'stepIndex', 'discoveryComplete', 'requiredDispositions', 'unobservedRegions']);
      const identity = fields && step(fields);
      if (!fields || !identity || identity.stepIndex !== index || digests.has(identity.identityDigest) || typeof fields.discoveryComplete !== 'boolean') return invalid();
      const questions = array(fields.requiredDispositions, 500), rawRegions = array(fields.unobservedRegions, PILOT_UA4_MAX_UNOBSERVED_REGIONS);
      if (!questions || rawRegions === null) return invalid();
      const ids = new Set<string>(), requiredDispositions: PilotLocalWizardCheckpoint['requiredDispositions'][number][] = [];
      for (const question of questions) {
        const data = record(question, ['questionId', 'disposition']);
        if (!data || typeof data.questionId !== 'string' || !QUESTION.test(data.questionId) || ids.has(data.questionId)) return invalid();
        const disposition = parsePilotUa4FinalDisposition(data.disposition);
        if (!disposition || (fields.discoveryComplete && disposition.state === 'DISCOVERY_INCOMPLETE')) return invalid();
        ids.add(data.questionId);
        requiredDispositions.push(Object.freeze({ questionId: data.questionId, disposition }));
      }
      const regions = parseUnobservedRegions(rawRegions, ids);
      if (regions === null || (fields.discoveryComplete && regions.length > 0)) return invalid();
      digests.add(identity.identityDigest);
      checkpoints.push(Object.freeze({ ...identity, discoveryComplete: fields.discoveryComplete,
        requiredDispositions: Object.freeze(requiredDispositions), unobservedRegions: regions }));
    }
    let currentStep: PilotLocalWizardStepIdentity | null = null;
    if (value.currentStep !== null) {
      const fields = record(value.currentStep, ['identityDigest', 'stepIndex']);
      currentStep = fields && step(fields);
      const last = checkpoints.at(-1);
      if (!currentStep || (last === undefined ? currentStep.stepIndex !== 0 :
        !(currentStep.stepIndex === last.stepIndex && currentStep.identityDigest === last.identityDigest) &&
        !(currentStep.stepIndex === last.stepIndex + 1 && !digests.has(currentStep.identityDigest)))) return invalid();
    }
    return Object.freeze({ ok: true, value: Object.freeze({ schemaVersion: 1, scope: 'LOCAL_SESSION',
      sessionDigest: value.sessionDigest, currentStep, checkpoints: Object.freeze(checkpoints) }) });
  } catch { return invalid(); }
}
