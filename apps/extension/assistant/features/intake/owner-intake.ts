import { parseUuid, isIntakeRevision } from '@edaix/contracts';
import { decodeIntakeAudio } from './audio';
import { parseAssistantIntakeRequest, parseIntakeEvent, parseIntakeView, type IntakeCommand, type IntakeEvent, type IntakeClientCode, type IntakeResult } from '@edaix/contracts';
import type { OwnerProfileWriterInput } from '../profile/owner-writer';
import { exactOrigin } from '../session/owner-reader';
import { sameSession, type SessionIdentity } from '../session/read-ports';
const MAX_VIEW_BYTES = 12 * 1024 * 1024;
/** Worker-only fixed routes. User content, audio and tokens never reach host-page messages. */
export function createOwnerIntake(input: OwnerProfileWriterInput) {
  const origin = exactOrigin(input.apiBase), fetcher = input.fetchFn ?? fetch;
  async function execute(identity: SessionIdentity, command: IntakeCommand, caller: AbortSignal, admitted: () => Promise<boolean>, onEvent?: (event: IntakeEvent) => void): Promise<IntakeResult> {
    let submitted = false;
    const fail = (code: IntakeClientCode): IntakeResult => ({ ok: false, code });
    const signal = AbortSignal.any([caller, AbortSignal.timeout(command.operation === 'REPLY' ? 110000 : 15000)]);
    const check = async (): Promise<IntakeClientCode | null> => {
      if (signal.aborted) return submitted ? 'SAVE_UNCERTAIN' : 'CANCELLED';
      if (!origin) return 'UNAVAILABLE';
      if (!await admitted()) return 'SENDER_REJECTED';
      const current = await input.currentSession();
      if (!current) return 'LOGIN_REQUIRED'; if (!sameSession(current, identity)) return 'OWNER_CHANGED';
      return signal.aborted ? 'CANCELLED' : null;
    };
    try {
      if (!parseAssistantIntakeRequest({ kind: 'assistant/intake-request-v1', id: crypto.randomUUID(), ...command })) return fail('VALIDATION_FAILED');
      const before = await check(); if (before) return fail(before);
      const token = await input.accessToken(); if (!token) return fail('LOGIN_REQUIRED');
      const ready = await check(); if (ready) return fail(ready);
      const path = intakePath(command), method = command.operation === 'CURRENT' ? 'GET' : 'POST'; submitted = method === 'POST';
      const response = await fetcher(new URL(path, origin!).href, { method, signal, credentials: 'omit', cache: 'no-store', redirect: 'error',
        ...(command.operation === 'CURRENT' ? {} : { body: JSON.stringify(command.request) }),
        headers: { authorization: `Bearer ${token}`, accept: command.operation === 'REPLY' ? 'text/event-stream' : 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) } });
      const after = await check(); if (after) { await response.body?.cancel(); return fail(after); }
      if (!response.ok) return fail(await intakeHttpFailure(response));
      if (command.operation !== 'REPLY') { const view = parseIntakeView(await boundedIntakeJson(response)); const final = await check(); if (final) return fail(final); return view && (command.operation === 'CURRENT' || command.operation === 'START' || command.operation === 'CLEAR' || view.session?.id === command.sessionId) ? { ok: true, value: view } : fail('RESPONSE_MALFORMED'); }
      let terminal: IntakeResult | null = null, sequence = 0, accepted = false;
      for await (const event of intakeEvents(response, signal)) {
        const guard = await check(); if (guard) return fail(guard);
        if (event.kind === 'intake.accepted') { if (accepted || event.sessionId !== command.sessionId || event.turnId !== command.request.clientRequestId) return fail('RESPONSE_MALFORMED'); accepted = true; }
        if (event.kind === 'intake.delta') { if (!accepted || event.sessionId !== command.sessionId || event.turnId !== command.request.clientRequestId || event.sequence !== sequence++) return fail('RESPONSE_MALFORMED'); }
        if (terminal) return fail('RESPONSE_MALFORMED');
        if (event.kind === 'intake.completed' || event.kind === 'intake.failed') {
          if (event.view.session && event.view.session.id !== command.sessionId) return fail('RESPONSE_MALFORMED');
          terminal = { ok: true, value: event.view };
        }
        onEvent?.(event);
      }
      const final = await check(); if (final) return fail(final);
      return terminal ?? fail('SAVE_UNCERTAIN');
    } catch { return fail(signal.aborted && !submitted ? 'CANCELLED' : submitted ? 'SAVE_UNCERTAIN' : 'UNAVAILABLE'); }
  }
  async function speech(identity: SessionIdentity, session: string, request: string, revision: string, wav: Uint8Array, caller: AbortSignal, admitted: () => Promise<boolean>): Promise<IntakeResult> {
    if (!parseUuid(session) || !parseUuid(request) || !isIntakeRevision(revision) || !decodeIntakeAudio(wav)) return { ok: false, code: 'VALIDATION_FAILED' };
    const signal = AbortSignal.any([caller, AbortSignal.timeout(110000)]);
    const check = async () => !signal.aborted && !!origin && await admitted() && sameSession(identity, await input.currentSession());
    try {
      if (!await check()) return { ok: false, code: 'OWNER_CHANGED' };
      const token = await input.accessToken(); if (!token) return { ok: false, code: 'LOGIN_REQUIRED' };
      if (!await check()) return { ok: false, code: 'OWNER_CHANGED' };
      const response = await fetcher(new URL(`/profile-intake/sessions/${session}/speech/${request}/${revision}`, origin!).href, {
        method: 'POST', signal, body: new Uint8Array(wav), credentials: 'omit', cache: 'no-store', redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'audio/wav', accept: 'application/json' } });
      if (!response.ok) return { ok: false, code: await intakeHttpFailure(response) };
      const view = parseIntakeView(await boundedIntakeJson(response));
      if (!await check()) return { ok: false, code: 'OWNER_CHANGED' };
      return view?.session?.id === session ? { ok: true, value: view } : { ok: false, code: 'RESPONSE_MALFORMED' };
    } catch { return { ok: false, code: 'SAVE_UNCERTAIN' }; }
  }
  return { execute, speech };
}
function intakePath(command: IntakeCommand): string {
  if (command.operation === 'CURRENT') return '/profile-intake/current';
  if (command.operation === 'START') return '/profile-intake/sessions';
  const base = `/profile-intake/sessions/${command.sessionId}`;
  if (command.operation === 'REPLY') return `${base}/turns`;
  if (command.operation === 'CLEAR') return `${base}/clear`;
  const turn = `${base}/turns/${command.turnId}`;
  if (command.operation === 'CANCEL') return `${turn}/cancel`;
  return `${turn}/candidates/${command.candidateId}/${command.operation === 'CONFIRM' ? 'confirm' : 'decision'}`;
}
export async function boundedIntakeJson(response: Response): Promise<unknown> {
  if (!/^application\/json(?:;|$)/iu.test(response.headers.get('content-type') ?? '') || !response.body) throw new Error('INTAKE_RESPONSE_INVALID');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }); let body = '', size = 0;
  try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > MAX_VIEW_BYTES) throw new Error('INTAKE_RESPONSE_LIMIT'); body += decoder.decode(part.value, { stream: true }); } body += decoder.decode(); return JSON.parse(body); }
  finally { await reader.cancel(); reader.releaseLock(); }
}
export async function* intakeEvents(response: Response, signal: AbortSignal): AsyncIterable<IntakeEvent> {
  if (!/^text\/event-stream(?:;|$)/iu.test(response.headers.get('content-type') ?? '') || !response.body) throw new Error('INTAKE_STREAM_INVALID');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }); let buffer = '', size = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error('INTAKE_STREAM_CANCELLED');
      const part = await reader.read();
      if (part.done) { buffer += decoder.decode(); if (buffer.trim()) throw new Error('INTAKE_STREAM_TRUNCATED'); break; }
      size += part.value.length; if (size > MAX_VIEW_BYTES + 256000) throw new Error('INTAKE_STREAM_LIMIT'); buffer += decoder.decode(part.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) { const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (!block.startsWith('data: ') || block.slice(6).includes('\n')) throw new Error('INTAKE_STREAM_INVALID');
        const event = parseIntakeEvent(JSON.parse(block.slice(6))); if (!event) throw new Error('INTAKE_STREAM_INVALID'); yield event;
      }
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
}
async function intakeHttpFailure(response: Response): Promise<IntakeClientCode> {
  if (response.status === 401) { await response.body?.cancel(); return 'LOGIN_REQUIRED'; }
  if (response.status === 402 || response.status === 403) { await response.body?.cancel(); return 'LOCKED'; }
  if (response.status === 404) { await response.body?.cancel(); return 'NOT_FOUND'; }
  const raw = await boundedIntakeJson(response), code = raw && typeof raw === 'object' && 'code' in raw ? raw.code : null;
  if (code === 'RATE_LIMITED') return 'RATE_LIMITED';
  if (code === 'USAGE_EXHAUSTED') return 'USAGE_EXHAUSTED';
  if (['PROFILE_INTAKE_CONFLICT', 'PROFILE_REVISION_MISMATCH', 'PROFILE_DELETION_EPOCH_MISMATCH'].includes(String(code))) return 'REVISION_CONFLICT';
  if (code === 'PROFILE_INTAKE_LIMIT_REACHED') return 'LIMIT_REACHED';
  if (code === 'PROFILE_INTAKE_AUDIO_INVALID') return 'AUDIO_INVALID';
  return code === 'VALIDATION_FAILED' ? 'VALIDATION_FAILED' : 'UNAVAILABLE';
}
