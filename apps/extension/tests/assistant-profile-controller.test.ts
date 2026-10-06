import { describe, expect, it, vi } from 'vitest';
import { createAssistantController } from '../assistant/app/controller';
import { createReadOnlyPorts } from '../assistant/features/session/read-only-ports';
import { initialAssistantState } from '../assistant/state/initial';
import { previewData } from '../assistant/testing/fixtures';
import { fictionalProfileSnapshot } from '../assistant/testing/profile-snapshot';
const base = () => fictionalProfileSnapshot('Example Person')!;
function setup() {
  const save = vi.fn(async () => ({ ok: false as const, code: 'SAVE_UNCERTAIN' as const }));
  const read = vi.fn(async () => ({ ok: true as const, value: base() }));
  const ui = createAssistantController(previewData, { ...createReadOnlyPorts({ login: async () => ({ ok: true, value: undefined }), refresh: async () => ({ ok: true, value: undefined }), logout: async () => ({ ok: true, value: undefined }) }), profile: { save, read } }, { ...initialAssistantState(previewData, { persona: 'out', entitlements: { ats: { access: 'locked' }, jobs: { access: 'locked' }, letters: { access: 'locked' }, chat: { access: 'locked' }, voice: { access: 'locked' } } }), session: 'connected', profileEditingEnabled: true, profileV2: base() });
  return { ui, save, read };
}
describe('profile editor controller', () => {
  it('keeps edits on uncertain save, reads before rebase, and never retries automatically', async () => {
    const h = setup(); await h.ui.dispatch('profile-edit', 'summary');
    h.ui.profile.edit('scalar', 'summary', 'A changed summary');
    await h.ui.dispatch('profile-save');
    expect(h.save).toHaveBeenCalledOnce();
    expect(h.ui.ctx.state.profileEditor?.phase).toBe('review');
    await h.ui.dispatch('profile-save'); expect(h.save).toHaveBeenCalledOnce();
    h.read.mockResolvedValueOnce({ ok: true, value: { ...base(), revision: '2' as never } });
    await h.ui.dispatch('profile-read-latest'); expect(h.read).toHaveBeenCalledOnce();
    await h.ui.dispatch('profile-rebase'); expect(h.save).toHaveBeenCalledOnce();
    expect(h.ui.ctx.state.profileEditor?.draft.rows[0]?.values.summary).toBe('A changed summary');
    expect(h.ui.ctx.state.profileEditor?.phase).toBe('editing');
    expect(h.ui.ctx.state.profileV2?.revision).toBe('2');
    h.ui.dispose();
  });
  it('treats closing while saving as uncertain and ignores late completion', async () => {
    const h = setup(); let resolve!: (v: any) => void;
    h.save.mockImplementation(() => new Promise(r => { resolve = r; }));
    await h.ui.dispatch('profile-edit', 'summary'); h.ui.profile.edit('scalar', 'summary', 'Draft');
    const saving = h.ui.dispatch('profile-save'); await Promise.resolve();
    await h.ui.dispatch('panel-close');
    expect(h.ui.ctx.state.profileEditor).toMatchObject({ phase: 'review', code: 'SAVE_UNCERTAIN' });
    resolve({ ok: true, value: base() }); await saving;
    expect(h.ui.ctx.state.profileEditor?.draft.rows[0]?.values.summary).toBe('Draft');
    h.ui.dispose();
  });
  it('does not expose edits through the readonly composition', async () => {
    const h = setup(); h.ui.ctx.patch({ profileEditingEnabled: false });
    await h.ui.dispatch('profile-edit', 'summary');
    expect(h.ui.ctx.state.profileEditor).toBeUndefined(); expect(h.save).not.toHaveBeenCalled(); h.ui.dispose();
  });
});
