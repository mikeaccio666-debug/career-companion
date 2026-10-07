import { getOwnerApplicationProfileV2, PROFILE_V2_MAX_REQUEST_BYTES, parseCandidateProfileV2Patch, parseCandidateProfileSnapshotV2,
  type AssistantProfileCode, type CandidateProfileSnapshotV2, type PatchCandidateProfileV2 } from '@edaix/contracts';
import { boundedJson, exactOrigin } from '../session/owner-reader';
import { readResult, sameSession, type SessionIdentity } from '../session/read-ports';

export type ProfileSaveResult = { readonly ok: true; readonly value: CandidateProfileSnapshotV2 }
  | { readonly ok: false; readonly code: AssistantProfileCode };
export interface OwnerProfileWriterInput {
  readonly enabled?: boolean;
  readonly apiBase: string | null;
  readonly currentSession: () => Promise<SessionIdentity | null>;
  readonly accessToken: () => Promise<string | null>;
  readonly fetchFn?: typeof fetch;
}

/** Worker-only. PATCH is never retried; backend owner/epoch/CAS remains the write authority. */
export function createOwnerProfileWriter(input: OwnerProfileWriterInput) {
  const origin = input.enabled === true ? exactOrigin(input.apiBase) : null;
  const fetchFn = input.fetchFn ?? fetch;
  const fail = (code: AssistantProfileCode): ProfileSaveResult => ({ ok: false, code });
  async function patch(identity: SessionIdentity, raw: PatchCandidateProfileV2, callerSignal: AbortSignal, admitted: () => Promise<boolean>): Promise<ProfileSaveResult> {
    let submitted = false;
    const check = async (signal: AbortSignal): Promise<AssistantProfileCode | null> => {
      if (signal.aborted) return submitted ? 'SAVE_UNCERTAIN' : 'CANCELLED';
      if (!origin) return 'DISABLED';
      if (!await admitted()) return 'SENDER_REJECTED';
      const actual = await input.currentSession();
      if (!actual) return 'LOGIN_REQUIRED';
      if (!sameSession(identity, actual)) return 'OWNER_CHANGED';
      return signal.aborted ? (submitted ? 'SAVE_UNCERTAIN' : 'CANCELLED') : null;
    };
    // Each phase bounds even adapters that ignore AbortSignal. A late phase
    // keeps its own aborted signal, so it cannot inherit the next phase's budget.
    const phase = async (execute: (signal: AbortSignal) => Promise<ProfileSaveResult>): Promise<ProfileSaveResult> => {
      const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(10_000)]);
      const bounded = await readResult(async () => ({ ok: true, value: await execute(signal) }), signal);
      return bounded.ok ? bounded.value : fail(submitted ? 'SAVE_UNCERTAIN' : bounded.code);
    };
    let token: string | null = null;
    let url = '';
    const options = () => ({ credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` } } as const);
    const saved = await phase(async signal => {
      const before = await check(signal); if (before) return fail(before);
      const normalized = parseCandidateProfileV2Patch(raw);
      if (!normalized) return fail('VALIDATION_FAILED');
      const body = JSON.stringify(normalized);
      if (new TextEncoder().encode(body).byteLength > PROFILE_V2_MAX_REQUEST_BYTES) return fail('VALIDATION_FAILED');
      token = await input.accessToken(); if (!token) return fail('LOGIN_REQUIRED');
      const ready = await check(signal); if (ready) return fail(ready);
      url = new URL(getOwnerApplicationProfileV2.path, origin!).href;
      submitted = true;
      const response = await fetchFn(url, { ...options(), signal, method: 'PATCH', body,
        headers: { ...options().headers, 'content-type': 'application/json' } });
      const after = await check(signal); if (after) return fail(after);
      if (response.status === 401) return fail('LOGIN_REQUIRED');
      if (response.status === 402) return fail('LOCKED');
      const decoded = await boundedJson(response);
      if (!response.ok) {
        const code = decoded.ok && decoded.value !== null && typeof decoded.value === 'object' && !Array.isArray(decoded.value)
          ? (decoded.value as Record<string, unknown>).code : null;
        if (response.status === 409 && ['PROFILE_REVISION_MISMATCH', 'PROFILE_DELETION_EPOCH_MISMATCH'].includes(String(code))) return fail('REVISION_CONFLICT');
        if (response.status === 400 && code === 'VALIDATION_FAILED') return fail('VALIDATION_FAILED');
        return fail('SAVE_UNCERTAIN');
      }
      const snapshot = decoded.ok ? parseCandidateProfileSnapshotV2(decoded.value) : null;
      const final = await check(signal); if (final) return fail(final);
      return snapshot ? { ok: true, value: snapshot } : fail('SAVE_UNCERTAIN');
    });
    if (!saved.ok) return saved;
    return phase(async signal => {
      const beforeRead = await check(signal); if (beforeRead) return fail(beforeRead);
      const fresh = await fetchFn(url, { ...options(), signal, method: 'GET' });
      const latestBody = await boundedJson(fresh);
      const final = await check(signal); if (final) return fail(final);
      const latest = fresh.ok && latestBody.ok ? parseCandidateProfileSnapshotV2(latestBody.value) : null;
      if (!latest) return fail('SAVE_UNCERTAIN');
      return sameSnapshot(saved.value, latest) ? { ok: true, value: latest } : fail('READBACK_CHANGED');
    });
  }
  return { patch };
}

/** Semantic JSON equality tolerates object-key ordering while retaining every fact and revision. */
export function sameSnapshot(a: CandidateProfileSnapshotV2, b: CandidateProfileSnapshotV2): boolean {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
