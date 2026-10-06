import type { CandidateProfileSnapshotV2, ProfileDirectoryPersonalV1, ResumeLibrarySnapshotV1, AssistantSessionIdentity, AssistantReadCode } from '@edaix/contracts';

/** In-process ports behind the validated shared assistant runtime wire. */
export type ReadCode = Exclude<AssistantReadCode, 'SENDER_REJECTED'>;
export type ReadResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: ReadCode };
export type SessionIdentity = AssistantSessionIdentity;
export interface AssistantReadPorts {
  session(signal: AbortSignal): Promise<ReadResult<SessionIdentity | null>>;
  openPortal(signal: AbortSignal): Promise<ReadResult<void>>;
  logout(signal: AbortSignal): Promise<ReadResult<void>>;
  personal(identity: SessionIdentity, signal: AbortSignal): Promise<ReadResult<ProfileDirectoryPersonalV1>>;
  resumes(identity: SessionIdentity, signal: AbortSignal): Promise<ReadResult<ResumeLibrarySnapshotV1>>;
  profileV2?(identity: SessionIdentity, signal: AbortSignal): Promise<ReadResult<CandidateProfileSnapshotV2>>;
}
export const sameSession = (a: SessionIdentity | null, b: SessionIdentity | null) =>
  a !== null && b !== null && a.ownerId === b.ownerId && a.generation === b.generation;

/** Bounds even injected operations that ignore cancellation, without logging their errors. */
export async function readResult<T>(operation: () => Promise<ReadResult<T>>, signal: AbortSignal): Promise<ReadResult<T>> {
  if (signal.aborted) return { ok: false, code: 'CANCELLED' };
  let cancel: () => void = () => {};
  const cancelled = new Promise<ReadResult<T>>(resolve => {
    cancel = () => resolve({ ok: false, code: 'CANCELLED' });
    signal.addEventListener('abort', cancel, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(() => signal.aborted ? { ok: false as const, code: 'CANCELLED' as const } : operation()), cancelled]); }
  catch { return { ok: false, code: 'UNAVAILABLE' }; }
  finally { signal.removeEventListener('abort', cancel); }
}
