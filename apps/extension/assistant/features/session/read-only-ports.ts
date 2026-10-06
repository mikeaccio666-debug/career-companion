import type { AssistantPorts, UiResult } from '../../ports/assistant-ports';

/** S2 composition exposes reads only. Preview mutations can never be its fallback. */
export function createReadOnlyPorts(connection: NonNullable<AssistantPorts['connection']>): AssistantPorts {
  const unavailable = async (): Promise<UiResult<never>> => ({ ok: false, code: 'UNAVAILABLE' });
  return { mode: 'connected', connection, extract: unavailable, saveCandidate: unavailable,
    parseResume: unavailable, transcribe: unavailable, score: unavailable, prepare: unavailable,
    generateLetter: unavailable, run: unavailable };
}
