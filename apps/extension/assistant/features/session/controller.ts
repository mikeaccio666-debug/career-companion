import { interruptRoleManager } from '../targets/controller';
import { interruptProfileEditor } from '../profile/editor-model';
import type { AssistantController } from '../../app/controller';
import { initialAssistantState } from '../../state/initial';
import type { AssistantState } from '../../state/types';
import { emptyProfile, projectPersonal, projectResumeLibrary } from './read-model';
import { readResult, sameSession, type AssistantReadPorts, type ReadCode, type ReadResult, type SessionIdentity } from './read-ports';

/** No tokens, persistence or browser messages. The composition supplies a trusted read port. */
export function createSessionController(ui: AssistantController, ports: AssistantReadPorts) {
  let identity: SessionIdentity | null = null, disposed = false, sequence = 0;
  let request = new AbortController();
  let suspended: { ownerId: string; scene: AssistantState['scene']; chat: AssistantState['chat']; privateIntake?: AssistantState['privateIntake']; profileEditor?: AssistantState['profileEditor']; roleManager?: AssistantState['roleManager']; currentTargetId?: string | null } | null = null;
  const failure = (code: ReadCode): ReadResult<void> => ({ ok: false, code });
  const unavailable = () => ({ access: 'unavailable' as const });
  const reads = () => ({ personal: 'unavailable' as const, resumes: 'unavailable' as const, processingCount: 0, failedCount: 0, hasMoreVersions: false });
  function clear(session: AssistantState['session']) {
    const previous = ui.ctx.state;
    const fresh = initialAssistantState({ ...ui.ctx.data, profile: emptyProfile(), resumeVersions: [] }, {
      persona: 'out', reduced: previous.reduced, locale: previous.locale,
      entitlements: { ats: unavailable(), jobs: unavailable(), letters: unavailable(), chat: unavailable(), voice: unavailable() },
    });
    ui.reset({ ...fresh,session,commerceEnabled:previous.commerceEnabled,jobOptions:[], intakeEnabled: previous.intakeEnabled, profileEditingEnabled: previous.profileEditingEnabled, roleManagementEnabled: previous.roleManagementEnabled, panelOpen: previous.panelOpen, launcherHidden: previous.launcherHidden,
      launcherTop: previous.launcherTop, hiddenNote: previous.hiddenNote, reads: reads(), resumeOptions: [] });
  }
  function suspend() {
    if (identity && ui.ctx.state.session === 'connected') suspended = {
      ownerId: identity.ownerId, privateIntake: ui.ctx.state.privateIntake ? { ...structuredClone(ui.ctx.state.privateIntake), busy: false, streaming: '', recording: 'idle' } : undefined, scene: ui.ctx.state.scene, chat: structuredClone(ui.ctx.state.chat), profileEditor: structuredClone(interruptProfileEditor(ui.ctx.state.profileEditor)), roleManager: structuredClone(interruptRoleManager(ui.ctx.state.roleManager)), currentTargetId: ui.ctx.state.currentTargetId,
    };
  }
  function invalidate(reason: 'expired' | 'out' | 'unavailable' = 'expired', issue?: AssistantState['connectionIssue']) {
    request.abort(); request = new AbortController(); sequence++;
    if (reason !== 'out') suspend(); else suspended = null;
    identity = null; clear(reason);
    if (issue) ui.ctx.patch({ connectionIssue: issue });
  }
  async function refresh(): Promise<ReadResult<void>> {
    if (disposed) return failure('CANCELLED');
    request.abort(); request = new AbortController(); const id = ++sequence;
    suspend(); identity = null; clear('connecting');
    const storeScope = ui.store.scope();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 12_000);
    const signal = AbortSignal.any([request.signal, storeScope.signal, deadline.signal]);
    const current = () => !disposed && sequence === id && !signal.aborted;
    let stage: NonNullable<AssistantState['connectionIssue']>['stage'] = 'SESSION';
    const cancelled = () => {
      if (!disposed && sequence === id && deadline.signal.aborted) { invalidate('unavailable', { stage, code: 'UNAVAILABLE' }); return failure('UNAVAILABLE'); }
      // Closing the panel aborts its store scope. Preserve the closed panel, but
      // leave an explicit reconnect state instead of a permanently loading read.
      if (!disposed && sequence === id && storeScope.signal.aborted) invalidate('unavailable', { stage, code: 'CANCELLED' });
      return failure('CANCELLED');
    };
    try {
      const result = await readResult(() => ports.session(signal), signal);
      if (!current()) return cancelled();
      if (!result.ok || !result.value) {
        const code = result.ok ? 'LOGIN_REQUIRED' : result.code;
        invalidate(code === 'LOGIN_REQUIRED' ? (suspended ? 'expired' : 'out') : code === 'OWNER_CHANGED' ? 'expired' : 'unavailable', { stage, code });
        return failure(code);
      }
      const bound = result.value;
      if (suspended && suspended.ownerId !== bound.ownerId) suspended = null;
      identity = bound;
      ui.ctx.patch({ session: 'connected', everConnected: true, reads: { ...reads(), personal: 'loading', resumes: 'loading', ...(ports.profileV2 ? { profileV2: 'loading' } : {}) },
        ...(suspended ? { scene: suspended.scene, privateIntake: structuredClone(suspended.privateIntake), chat: structuredClone(suspended.chat), profileEditor: structuredClone(suspended.profileEditor), roleManager: structuredClone(suspended.roleManager), currentTargetId: suspended.currentTargetId ?? null } : {}) }, storeScope);
      // Never publish one owner's payload while the other parallel request is still pending.
      stage = 'READS';
      const [personal, resumes, profileV2] = await Promise.all([
        readResult(() => ports.personal(bound, signal), signal),
        readResult(() => ports.resumes(bound, signal), signal),
        ports.profileV2 ? readResult(() => ports.profileV2!(bound, signal), signal) : Promise.resolve(null),
      ]);
      if (!current()) return cancelled();
      stage = 'VERIFY';
      const latest = await readResult(() => ports.session(signal), signal);
      if (!current()) return cancelled();
      if (!latest.ok) {
        invalidate(['LOGIN_REQUIRED', 'OWNER_CHANGED'].includes(latest.code) ? 'expired' : 'unavailable', { stage, code: latest.code });
        return failure(latest.code);
      }
      if (!sameSession(bound, latest.value)) {
        invalidate('expired', { stage, code: 'OWNER_CHANGED' }); return failure('OWNER_CHANGED');
      }
      for (const [readStage, value] of [['PERSONAL', personal], ['RESUMES', resumes], ['PROFILE_V2', profileV2]] as const) {
        if (value && !value.ok && ['LOGIN_REQUIRED', 'OWNER_CHANGED'].includes(value.code)) {
          invalidate('expired', { stage: readStage, code: value.code }); return failure(value.code);
        }
      }
      const library = resumes.ok ? projectResumeLibrary(resumes.value, '', ui.ctx.state.locale) : null;
      ui.ctx.patch({ profile: personal.ok ? projectPersonal(personal.value) : emptyProfile(),
        profileV2: profileV2?.ok ? profileV2.value : undefined,
        hasResume: !!library?.options.length, resumeId: library?.selectedId ?? '', resumeOptions: library?.options ?? [],
        reads: { personal: personal.ok ? 'ready' : personal.code === 'LOCKED' ? 'locked' : 'unavailable',
          ...(profileV2 ? { profileV2: profileV2.ok ? 'ready' as const : profileV2.code === 'LOCKED' ? 'locked' as const : 'unavailable' as const } : {}),
          resumes: resumes.ok ? 'ready' : resumes.code === 'LOCKED' ? 'locked' : 'unavailable',
          processingCount: library?.processingCount ?? 0, failedCount: library?.failedCount ?? 0,
          hasMoreVersions: library?.hasMoreVersions ?? false } }, storeScope);
      suspended = null;
      if (ui.ctx.state.scene === 'chat' && ui.ctx.state.intakeEnabled !== false) void ui.privateIntake.refresh();
      if (ui.ctx.state.roleManagementEnabled) void ui.roles.refresh();
      return { ok: true, value: undefined };
    } finally { clearTimeout(timer); }
  }
  async function login(): Promise<ReadResult<void>> {
    if (disposed) return failure('CANCELLED');
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(12_000)]);
    // Opening a portal never manufactures a connected state; a later refresh must attest it.
    return readResult(() => ports.openPortal(signal), signal);
  }
  async function logout(): Promise<ReadResult<void>> {
    if (disposed) return failure('CANCELLED');
    invalidate('out'); request = new AbortController();
    // Worker invalidation is expected during logout and must not cancel its acknowledgement.
    const signal = AbortSignal.timeout(12_000);
    const result = await readResult(() => ports.logout(signal), signal);
    if (!disposed) clear('out');
    return result;
  }
  async function verify(): Promise<void> {
    if (disposed || !identity) return;
    const expected = identity, id = sequence;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(12_000)]);
    const result = await readResult(() => ports.session(signal), signal);
    if (!disposed && sequence === id && (!result.ok || !sameSession(expected, result.value))) {
      const code = result.ok ? 'OWNER_CHANGED' : result.code;
      invalidate(['LOGIN_REQUIRED', 'OWNER_CHANGED'].includes(code) ? 'expired' : 'unavailable', { stage: 'VERIFY', code });
    }
  }
  return { refresh, verify, login, logout, invalidate, currentIdentity: () => identity,
    dispose() { if (disposed) return; disposed = true; invalidate('out'); suspended = null; },
  };
}
