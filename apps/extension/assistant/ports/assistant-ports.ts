import type { AtsReport, Extraction, Job, Phase, Profile, ProfileField, RunProgressRow, UploadState } from '../state/types';

/** These are internal UI service results, not a new HTTP or channel contract. */
export type UiFailureCode = 'CANCELLED' | 'UNAVAILABLE' | 'CONFLICT' | 'SAVE_FAILED' | 'VOICE_DENIED' | 'VOICE_NO_DEVICE' | 'VOICE_UNCLEAR' | 'PARSE_FAILED' | 'PAGE_CHANGED';
export type UiResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: UiFailureCode };

export interface AssistantPorts {
  readonly autofill?:import('../features/autofill/ports').AutofillPorts;
  readonly openBilling?:()=>Promise<UiResult<void>>;
  readonly commerce?: import('../features/commerce/ports').CommercePorts;
  readonly privateIntake?: import('../features/intake/private-ports').PrivateIntakePorts;
  readonly roles?: import('../features/targets/owner-roles').RolePorts;
  readonly mode: 'preview' | 'connected';
  readonly profile?: {
    save(patch: import('@edaix/contracts').PatchCandidateProfileV2, signal: AbortSignal): Promise<import('../features/profile/owner-writer').ProfileSaveResult>;
    read(signal: AbortSignal): Promise<import('../features/session/read-ports').ReadResult<import('@edaix/contracts').CandidateProfileSnapshotV2>>;
  };
  readonly connection?: { login(): Promise<UiResult<void>>; refresh(): Promise<UiResult<void>>; logout(): Promise<UiResult<void>> };
  extract(input: { text: string; phase: Phase }, signal: AbortSignal): Promise<UiResult<Extraction>>;
  saveCandidate(input: { phase: Phase; fields: Partial<Record<ProfileField, string>>; targetId: string | null }, signal: AbortSignal): Promise<UiResult<void>>;
  parseResume(onStage: (stage: UploadState) => void, signal: AbortSignal): Promise<UiResult<Partial<Profile>>>;
  transcribe(phase: Phase, signal: AbortSignal): Promise<UiResult<string>>;
  score(input: { job: Job; resumeId: string }, signal: AbortSignal): Promise<UiResult<AtsReport>>;
  prepare(input: { job: Job; resumeId: string; index: number }, signal: AbortSignal): Promise<UiResult<{ resumeId: string }>>;
  generateLetter(input: { job: Job; profile: Profile }, signal: AbortSignal): Promise<UiResult<string>>;
  run(input: { job: Job; resumeId: string }, onRow: (row: RunProgressRow) => void, signal: AbortSignal): Promise<UiResult<void>>;
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const cancelled = () => { clearTimeout(timer); resolve(false); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancelled); resolve(true); }, ms);
    signal.addEventListener('abort', cancelled, { once: true });
  });
}
