import { truncateIntakeText, type CandidateProfileSnapshotV2, type IntakeCandidate, type IntakeClientCode, type IntakeCommand, type IntakeView, type Uuid } from '@edaix/contracts';
import type { ControllerContext } from '../../app/controller-context';
import { isCurrent } from '../../app/controller-context';
import { addProfileRow, createProfileDraft, editProfileValue, isCollection, sectionFields } from '../profile/editor-model';
export interface PrivateIntakeState {
  view: IntakeView | null; input: string; source: 'TEXT' | 'TRANSCRIPT'; busy: boolean; streaming: string; code?: IntakeClientCode; truncated: boolean;
  recording: 'idle' | 'recording' | 'processing';
}
export const initialPrivateIntake = (): PrivateIntakeState => ({ view: null, input: '', source: 'TEXT', busy: false, streaming: '', truncated: false, recording: 'idle' });
export function candidateProfileDraft(profile: CandidateProfileSnapshotV2, candidate: IntakeCandidate) {
  let draft = createProfileDraft(profile, candidate.section);
  const key = isCollection(candidate.section) ? crypto.randomUUID() : 'scalar';
  if (isCollection(candidate.section)) draft = addProfileRow(draft, key);
  for (const field of candidate.fields) {
    const spec = sectionFields[candidate.section].find(f => f.key === field.path);
    if (!spec) continue;
    // Quoted labels cannot silently become an enum, date or inferred boolean.
    if (spec.kind === 'multi') { if (spec.options?.includes(field.value)) draft = editProfileValue(draft, key, field.path, [field.value]); }
    else if (spec.kind !== 'select' || spec.options?.includes(field.value)) draft = editProfileValue(draft, key, field.path, field.value);
  }
  return draft;
}
export function createPrivateIntakeController(ctx: ControllerContext) {
  let active: AbortController | null = null, recording: AbortController | null = null, sequence = 0;
  const state = () => ctx.state.privateIntake ?? initialPrivateIntake();
  const set = (patch: Partial<PrivateIntakeState>) => ctx.patch({ privateIntake: { ...state(), ...patch } });
  const admitted = () => ctx.state.session === 'connected' && ctx.state.intakeEnabled !== false;
  async function execute(command: IntakeCommand, stream = false) {
    if (!admitted() || state().busy) return;
    if (!ctx.ports.privateIntake) { set({ code: 'UNAVAILABLE' }); return; }
    const scope = ctx.store.scope(), seq = ++sequence, abort = new AbortController(); active = abort;
    set({ busy: true, code: undefined, ...(stream ? { streaming: '' } : {}) });
    const signal = AbortSignal.any([scope.signal, abort.signal]);
    const result = await ctx.ports.privateIntake.execute(command, signal, event => {
      if (!isCurrent(ctx, scope) || seq !== sequence || signal.aborted) return;
      if (event.kind === 'intake.delta') set({ streaming: state().streaming + event.text });
      if (event.kind === 'intake.completed' || event.kind === 'intake.failed') set({ view: event.view, streaming: '', ...(event.kind === 'intake.failed' ? { code: event.code === 'CANCELLED' ? 'CANCELLED' : 'UNAVAILABLE' } : {}) });
    }).catch(() => ({ ok: false, code: 'SAVE_UNCERTAIN' } as const));
    if (!isCurrent(ctx, scope) || seq !== sequence) return;
    active = null;
    if (result.ok) {
      const completed = command.operation === 'REPLY' && result.value.session?.turns.find(t => t.id === command.request.clientRequestId)?.status === 'COMPLETED';
      set({ busy: false, view: result.value, streaming: '', ...(completed ? { input: '', source: 'TEXT', truncated: false } : {}) });
    } else set({ busy: false, streaming: '', code: result.code });
  }
  async function open() { if (!admitted()) return; ctx.patch({ sheet: null, profileEditor: undefined }); await ctx.go('chat'); await execute({ operation: 'CURRENT' }); }
  function edit(text: string, source: 'TEXT' | 'TRANSCRIPT' = state().source) { const limited = truncateIntakeText(text); set({ input: limited.text, truncated: limited.truncated, source }); }
  async function send() {
    if (!admitted() || state().busy || state().recording !== 'idle' || !state().input.trim()) return;
    if (!state().view?.session) await execute({ operation: 'START', request: { clientRequestId: crypto.randomUUID() as Uuid, locale: ctx.state.locale ?? 'en-US' } });
    const session = state().view?.session; if (!session || state().busy) return;
    await execute({ operation: 'REPLY', sessionId: session.id, request: { clientRequestId: crypto.randomUUID() as Uuid, expectedRevision: session.revision, text: state().input, source: state().source } }, true);
  }
  async function review(turnId: string, candidateId: string) {
    if (!admitted() || state().busy || !ctx.ports.profile) return;
    const session = state().view?.session, turn = session?.turns.find(t => t.id === turnId), candidate = turn?.candidates.find(c => c.candidate.id === candidateId);
    if (!session || !candidate || !['PENDING', 'DEFERRED'].includes(candidate.decision)) return;
    const scope = ctx.store.scope(); set({ busy: true, code: undefined });
    const result = await ctx.ports.profile.read(scope.signal).catch(() => ({ ok: false, code: 'UNAVAILABLE' } as const));
    if (!isCurrent(ctx, scope)) return; set({ busy: false });
    if (!result.ok || result.value.deletionEpoch !== turn!.baseDeletionEpoch) { set({ code: 'REVISION_CONFLICT' }); return; }
    ctx.patch({ profileV2: result.value, profileEditor: { draft: candidateProfileDraft(result.value, candidate.candidate), phase: 'editing', intake: { sessionId: session.id, turnId, candidateId } } });
    await ctx.go('profile');
  }
  async function decide(turnId: string, candidateId: string, decision: 'DISMISSED' | 'DEFERRED') {
    const session = state().view?.session; if (!session) return;
    await execute({ operation: 'DECIDE', sessionId: session.id, turnId, candidateId, request: { expectedRevision: session.revision, decision } });
  }
  async function cancel() {
    active?.abort(); sequence++; active = null; set({ busy: false, streaming: '', code: 'CANCELLED' });
    await execute({ operation: 'CURRENT' });
    const session = state().view?.session, pending = session?.turns.find(t => t.status === 'PENDING');
    if (session && pending) await execute({ operation: 'CANCEL', sessionId: session.id, turnId: pending.id, request: { expectedRevision: session.revision } });
  }
  async function clear() { const session = state().view?.session; if (session && !state().busy) await execute({ operation: 'CLEAR', sessionId: session.id, request: { expectedRevision: session.revision } }); }
  async function record() {
    if (!admitted() || state().busy || recording || !ctx.ports.privateIntake?.record) { set({ code: 'UNAVAILABLE' }); return; }
    const scope = ctx.store.scope(), abort = new AbortController(); recording = abort;
    const r = await ctx.ports.privateIntake.record(AbortSignal.any([scope.signal, abort.signal]), transcript => { if (isCurrent(ctx, scope) && !abort.signal.aborted) edit(`${state().input}${state().input ? '\n' : ''}${transcript}`, 'TRANSCRIPT'); }, next => { if (isCurrent(ctx, scope) && !abort.signal.aborted) set({ recording: next }); }).catch(() => ({ ok: false, code: 'UNAVAILABLE' } as const));
    if (recording === abort) recording = null;
    if (isCurrent(ctx, scope)) { set({ recording: 'idle', ...(r.ok ? {} : { code: r.code }) }); if (!abort.signal.aborted) await execute({ operation: 'CURRENT' }); }
  }
  function interrupt() { sequence++; active?.abort(); active = null; recording?.abort(); recording = null; ctx.ports.privateIntake?.stopRecording?.(); set({ busy: false, streaming: '', recording: 'idle' }); }
  return { open, edit, send, review, decide, cancel, clear, record, interrupt, stopRecording: () => ctx.ports.privateIntake?.stopRecording?.(), refresh: () => execute({ operation: 'CURRENT' }) };
}
