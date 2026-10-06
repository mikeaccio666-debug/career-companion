import type { ControllerContext } from '../../app/controller-context';
import { isCurrent } from '../../app/controller-context';
import { readResult } from '../session/read-ports';
import { PROFILE_SECTIONS, addProfileRow, buildProfilePatch, createProfileDraft, editProfileValue, rebaseProfileDraft, removeProfileRow, type EditorValue, type ProfileSection } from './editor-model';

export function createProfileEditorController(ctx: ControllerContext) {
  const admitted = () => ctx.state.session === 'connected' && ctx.state.profileEditingEnabled === true && !!ctx.ports.profile;
  function edit(row: string, key: string, value: EditorValue) {
    const editor = ctx.state.profileEditor;
    if (!admitted() || !editor || editor.phase !== 'editing') return;
    ctx.patch({ profileEditor: { ...editor, code: undefined, draft: editProfileValue(editor.draft, row, key, value) } });
  }
  async function action(act: string, arg: string) {
    if (!admitted()) return;
    const editor = ctx.state.profileEditor;
    if (act === 'profile-edit') {
      if (!ctx.state.profileV2 || !PROFILE_SECTIONS.includes(arg as ProfileSection)) return;
      if (!editor) ctx.patch({ profileEditor: { draft: createProfileDraft(ctx.state.profileV2, arg as ProfileSection), phase: 'editing' } });
      if (ctx.state.scene !== 'profile') await ctx.go('profile'); return;
    }
    if (!editor) return;
    if (act === 'profile-save' && editor.phase === 'editing') {
      const patch = buildProfilePatch(editor.draft);
      if (!patch.ok) { ctx.patch({ profileEditor: { ...editor, code: patch.code } }); return; }
      const scope = ctx.store.scope();
      ctx.patch({ profileEditor: { ...editor, phase: 'saving', code: undefined, latest: undefined } });
      // The port enforces a deadline. A thrown adapter never becomes an automatic retry.
      const save = async (): Promise<import('./owner-writer').ProfileSaveResult> => {
        if (!editor.intake) return ctx.ports.profile!.save(patch.value, scope.signal);
        const session = ctx.state.privateIntake?.view?.session;
        if (!ctx.ports.privateIntake || !session || session.id !== editor.intake.sessionId) return { ok: false, code: 'SAVE_UNCERTAIN' };
        const saved = await ctx.ports.privateIntake.execute({ operation: 'CONFIRM', ...editor.intake, request: { expectedRevision: session.revision, patch: patch.value } }, scope.signal);
        if (!isCurrent(ctx, scope)) return { ok: false, code: 'CANCELLED' };
        if (!saved.ok) return { ok: false, code: ['REVISION_CONFLICT', 'VALIDATION_FAILED', 'LOCKED', 'DISABLED', 'CANCELLED'].includes(saved.code) ? saved.code as 'REVISION_CONFLICT' | 'VALIDATION_FAILED' | 'LOCKED' | 'DISABLED' | 'CANCELLED' : 'SAVE_UNCERTAIN' };
        if (ctx.state.privateIntake) ctx.patch({ privateIntake: { ...ctx.state.privateIntake, view: saved.value } });
        const fresh = await ctx.ports.profile!.read(scope.signal);
        return fresh.ok ? fresh : { ok: false, code: 'SAVE_UNCERTAIN' };
      };
      const result = await save().catch(() => ({ ok: false, code: 'SAVE_UNCERTAIN' } as const));
      if (!isCurrent(ctx, scope)) return;
      if (result.ok) { ctx.patch({ profileV2: result.value, profileEditor: undefined }); ctx.toast(ctx.t('资料已保存并重新核对。')); if (editor.intake) await ctx.go('chat'); }
      else ctx.patch({ profileEditor: { ...editor, phase: ['VALIDATION_FAILED', 'LOCKED', 'DISABLED', 'CANCELLED'].includes(result.code) ? 'editing' : 'review', code: result.code } });
      return;
    }
    if (act === 'profile-read-latest' && editor.phase === 'review' && !editor.reading) {
      const scope = ctx.store.scope(); ctx.patch({ profileEditor: { ...editor, reading: true, latest: undefined } });
      const result = await readResult(() => ctx.ports.profile!.read(scope.signal), AbortSignal.any([scope.signal, AbortSignal.timeout(12_000)]));
      if (isCurrent(ctx, scope)) ctx.patch({ profileEditor: { ...editor, reading: false, ...(result.ok ? { latest: result.value } : { code: result.code, latest: undefined }) } });
      return;
    }
    if (act === 'profile-rebase' && editor.phase === 'review' && editor.latest && !editor.reading) {
      const result = rebaseProfileDraft(editor.draft, editor.latest);
      ctx.patch({ ...(result.ok ? { profileV2: editor.latest } : {}), profileEditor: result.ok ? { ...editor, draft: result.value, phase: 'editing', latest: undefined, code: undefined } : { ...editor, code: result.code } }); return;
    }
    if (act === 'profile-discard' && editor.phase !== 'saving' && !editor.reading) {
      ctx.patch({ profileEditor: undefined, ...(editor.latest ? { profileV2: editor.latest } : {}) }); if (editor.intake) await ctx.go('chat'); return;
    }
    if (editor.phase !== 'editing') return;
    if (act === 'profile-add') ctx.patch({ profileEditor: { ...editor, code: undefined, draft: addProfileRow(editor.draft, ctx.nextId('profile-row')) } });
    if (act === 'profile-remove') ctx.patch({ profileEditor: { ...editor, code: undefined, draft: removeProfileRow(editor.draft, arg) } });
  }
  return { edit, action };
}
