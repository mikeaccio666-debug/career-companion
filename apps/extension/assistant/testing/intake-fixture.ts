import { parseIntakeView, type IntakeView, type Uuid, type DecimalString, type IntakeTurn } from '@edaix/contracts';
import type { PrivateIntakePorts } from '../features/intake/private-ports';
import type { createProfileFixture } from './profile-fixture';
/** Development-only simulated provider/accounting. Never imported by installed entrypoints. */
export function createIntakeFixture(profile: ReturnType<typeof createProfileFixture>) {
  let view: IntakeView = { schemaVersion: 1, session: null, configuration: { version: 'fixture-v1', maxRecordingSeconds: 900, chunkSeconds: 30, nudgeAfterTurns: 3, maxSessionTurns: 100 },
    usage: { replies: { state: 'AVAILABLE', remaining: 20, resetsAt: '2027-01-01T00:00:00Z' }, speechSeconds: { state: 'AVAILABLE', remaining: 300, resetsAt: '2027-01-01T00:00:00Z' } } };
  const update = (turns: readonly IntakeTurn[]) => { if (view.session) view = { ...view, session: { ...view.session, turns, revision: String(BigInt(view.session.revision) + 1n) as DecimalString } }; };
  const ports: PrivateIntakePorts = { async execute(command, signal, onEvent) {
    if (signal.aborted) return { ok: false, code: 'CANCELLED' };
    if (command.operation === 'START' && !view.session) view = { ...view, session: { schemaVersion: 1, id: crypto.randomUUID() as Uuid, revision: '0' as DecimalString, locale: command.request.locale, turns: [], noProgressTurns: 0, selectedRoleId: null } };
    if (command.operation === 'CLEAR') view = { ...view, session: null };
    if (command.operation === 'REPLY' && view.session) {
      const remaining = view.usage.replies.remaining!; if (remaining <= 0) return { ok: false, code: 'USAGE_EXHAUSTED' };
      const read = await profile.ports.read(signal); if (!read.ok) return { ok: false, code: 'UNAVAILABLE' };
      const quote = [...command.request.text].slice(0, 1800).join(''), reply = view.session.locale === 'zh-CN' ? '我把你刚才的话放进了概述候选。你可以先核对；也可以接着聊一个具体项目：当时你负责什么，结果如何？' : 'I put your words in a summary candidate for review. You can also tell me about a specific project: what did you do, and how did it turn out?';
      onEvent?.({ kind: 'intake.accepted', sessionId: view.session.id, turnId: command.request.clientRequestId });
      for (let i = 0; i < reply.length; i += 12) { if (signal.aborted) return { ok: false, code: 'CANCELLED' }; await new Promise(r => setTimeout(r, 35)); onEvent?.({ kind: 'intake.delta', sessionId: view.session.id, turnId: command.request.clientRequestId, sequence: i / 12, text: reply.slice(i, i + 12) }); }
      update([...view.session.turns, { id: command.request.clientRequestId, kind: 'REPLY', status: 'COMPLETED', text: command.request.text, reply, source: command.request.source, failure: null,
        candidates: [{ candidate: { id: 'summary', section: 'summary', fields: [{ path: 'summary', value: quote, sources: [{ start: 0, end: [...quote].length, quote }] }] }, decision: 'PENDING', savedRevision: null }], roleSuggestions: [], clarifications: [], baseProfileRevision: read.value.revision, baseDeletionEpoch: read.value.deletionEpoch }]);
      view = { ...view, usage: { ...view.usage, replies: { ...view.usage.replies, remaining: remaining - 1, state: remaining === 1 ? 'EXHAUSTED' : 'AVAILABLE' } } };
      onEvent?.({ kind: 'intake.completed', view });
    }
    if ((command.operation === 'DECIDE' || command.operation === 'CONFIRM') && view.session) {
      let savedRevision: DecimalString | null = null;
      if (command.operation === 'CONFIRM') { const saved = await profile.ports.save(command.request.patch, signal); if (!saved.ok) return { ok: false, code: saved.code === 'VALIDATION_FAILED' ? 'VALIDATION_FAILED' : 'REVISION_CONFLICT' }; savedRevision = saved.value.revision; }
      update(view.session.turns.map(turn => turn.id !== command.turnId ? turn : { ...turn, candidates: turn.candidates.map(c => c.candidate.id !== command.candidateId ? c : { ...c, decision: command.operation === 'DECIDE' ? command.request.decision : 'CONFIRMED', savedRevision }) }));
    }
    return parseIntakeView(view) ? { ok: true, value: structuredClone(view) } : { ok: false, code: 'RESPONSE_MALFORMED' };
  } };
  return { ports };
}
