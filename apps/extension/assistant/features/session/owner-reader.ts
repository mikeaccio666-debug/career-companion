import {
  getOwnerApplicationProfileV2,
  getOwnerProfileDirectoryPersonalV1,
  getResumeLibrary,
  parseCandidateProfileSnapshotV2,
  parseProfileDirectoryPersonalV1,
  parseResumeLibrarySnapshotV1,
} from '@edaix/contracts';
import { readResult, sameSession, type AssistantReadPorts, type ReadCode, type ReadResult, type SessionIdentity } from './read-ports';

interface OwnerReaderInput {
  readonly enabled?: boolean;
  readonly apiBase: string | null;
  /** Worker-local identity/epoch; never supplied by the host page or UI. */
  readonly currentSession: () => Promise<SessionIdentity | null>;
  readonly accessToken: () => Promise<string | null>;
  readonly refreshAccessToken: () => Promise<string | null>;
  readonly fetchFn?: typeof fetch;
}

/** Worker-only owner adapter, enabled only by the explicit assistant development build. */
export function createOwnerReader(input: OwnerReaderInput): Pick<AssistantReadPorts, 'personal' | 'resumes'> & Required<Pick<AssistantReadPorts, 'profileV2'>> {
  const origin = input.enabled === true ? exactOrigin(input.apiBase) : null;
  const fetchFn = input.fetchFn ?? fetch;
  const fail = (code: ReadCode): { readonly ok: false; readonly code: ReadCode } => ({ ok: false, code });
  async function current(expected: SessionIdentity, signal: AbortSignal): Promise<ReadResult<void>> {
    if (signal.aborted) return fail('CANCELLED');
    if (!origin) return fail('DISABLED');
    const actual = await input.currentSession();
    if (!actual) return fail('LOGIN_REQUIRED');
    if (!sameSession(expected, actual)) return fail('OWNER_CHANGED');
    return signal.aborted ? fail('CANCELLED') : { ok: true, value: undefined };
  }
  const methods = {
    async read<T>(identity: SessionIdentity, callerSignal: AbortSignal, path: string, parse: (value: unknown) => T | null): Promise<ReadResult<T>> {
      const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(10_000)]);
      return readResult(async () => {
        const before = await current(identity, signal); if (!before.ok) return before;
        let token = await input.accessToken();
        if (!token) return fail('LOGIN_REQUIRED');
        const admitted = await current(identity, signal); if (!admitted.ok) return admitted;
        const send = (bearer: string) => fetchFn(new URL(path, origin!).href, {
          method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${bearer}` },
          credentials: 'omit', cache: 'no-store', redirect: 'error', signal,
        });
        let response = await send(token);
        if (response.status === 401) {
          const body = await boundedJson(response);
          if (body.ok && isLoginRequired(body.value)) {
            const check = await current(identity, signal); if (!check.ok) return check;
            token = await input.refreshAccessToken(); if (!token) return fail('LOGIN_REQUIRED');
            const fresh = await current(identity, signal); if (!fresh.ok) return fresh;
            response = await send(token);
          }
        }
        const latest = await current(identity, signal); if (!latest.ok) return latest;
        if (response.status === 401) return fail('LOGIN_REQUIRED');
        if (response.status === 402) return fail('LOCKED');
        if (!response.ok) return fail('UNAVAILABLE');
        const body = await boundedJson(response); if (!body.ok) return body;
        const final = await current(identity, signal); if (!final.ok) return final;
        const value = parse(body.value);
        return value ? { ok: true, value } : fail('RESPONSE_MALFORMED');
      }, signal);
    },
  };
  return { personal: (identity, signal) => methods.read(identity, signal, getOwnerProfileDirectoryPersonalV1.path, parseProfileDirectoryPersonalV1),
    resumes: (identity, signal) => methods.read(identity, signal, getResumeLibrary.path, parseResumeLibrarySnapshotV1),
    profileV2: (identity, signal) => methods.read(identity, signal, getOwnerApplicationProfileV2.path, parseCandidateProfileSnapshotV2),
  };
}

export function exactOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return null;
    return url.origin;
  } catch { return null; }
}
const isLoginRequired = (value: unknown) => !!value && typeof value === 'object' &&
  !Array.isArray(value) && (value as Record<string, unknown>).code === 'LOGIN_REQUIRED';

/** Metadata only, capped while streaming; unknown error bodies never escape. */
export async function boundedJson(response: Response): Promise<ReadResult<unknown>> {
  const fail = (): ReadResult<never> => ({ ok: false, code: 'RESPONSE_MALFORMED' });
  const max = 512 * 1024, length = response.headers.get('content-length');
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail();
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > max)) return fail();
  if (!response.body) return fail();
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > max) { await reader.cancel(); return fail(); }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown };
  } catch { return fail(); }
  finally { reader.releaseLock(); }
}
