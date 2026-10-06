import { describe, expect, it, vi } from 'vitest';
import { createAssistantController } from '../assistant/app/controller';
import { createReadOnlyPorts } from '../assistant/features/session/read-only-ports';
import { initialAssistantState } from '../assistant/state/initial';
import { previewData } from '../assistant/testing/fixtures';
import { createRoleFixture } from '../assistant/testing/role-fixture';
function setup() {
  const fixture = createRoleFixture(); const save = vi.spyOn(fixture.ports, 'save'), create = vi.spyOn(fixture.ports, 'create');
  const connected = async () => ({ ok: true as const, value: undefined });
  const ui = createAssistantController(previewData, { ...createReadOnlyPorts({ login: connected, logout: connected, refresh: connected }), roles: fixture.ports }, {
    ...initialAssistantState(previewData, { persona: 'out', entitlements: { ats: { access: 'locked' }, jobs: { access: 'locked' }, letters: { access: 'locked' }, chat: { access: 'locked' }, voice: { access: 'locked' } } }), session: 'connected', roleManagementEnabled: true,
  });
  return { fixture, ui, save, create };
}
describe('Role management UI state', () => {
  it('selects a server Role without changing global profile and saves only that Role', async () => {
    const { ui, save } = setup(), profile = structuredClone(ui.ctx.state.profile);
    await ui.dispatch('open-targets'); const [first, second] = ui.ctx.state.roleManager!.items;
    await ui.dispatch('role-use', first!.id); expect(ui.ctx.state.currentTargetId).toBe(first!.id); expect(ui.ctx.state.profile).toEqual(profile);
    await ui.dispatch('open-targets'); await ui.dispatch('role-edit', second!.id); ui.roles.edit('workMode', 'REMOTE'); await ui.dispatch('role-save');
    expect(save).toHaveBeenCalledWith(second!.id, expect.objectContaining({ expectedRevision: '1', preferences: expect.objectContaining({ workMode: 'REMOTE' }) }), expect.any(AbortSignal));
    expect(ui.ctx.state.currentTargetId).toBe(first!.id); expect(ui.ctx.state.profile).toEqual(profile); ui.dispose();
  });
  it('requires fresh comparison after an uncertain save and preserves unedited latest fields', async () => {
    const { ui, fixture, save } = setup(); await ui.dispatch('open-targets'); await ui.dispatch('role-edit', ui.ctx.state.roleManager!.items[0]!.id);
    ui.roles.edit('workMode', 'REMOTE'); fixture.scenario('conflict'); await ui.dispatch('role-save');
    await ui.dispatch('role-save'); expect(save).toHaveBeenCalledOnce();
    await ui.dispatch('role-rebase'); expect(ui.ctx.state.roleManager!.editor!.phase).toBe('review');
    await ui.dispatch('role-read-latest'); await ui.dispatch('role-rebase');
    expect(ui.ctx.state.roleManager!.editor).toMatchObject({ phase: 'editing', base: { revision: '2' }, draft: { location: 'Montreal', workMode: 'REMOTE' } });
    fixture.scenario('normal'); await ui.dispatch('role-save'); expect(save).toHaveBeenCalledTimes(2); ui.dispose();
  });
  it('does not repeat a lost create until explicit list reconciliation', async () => {
    const { ui, fixture, create } = setup(); await ui.dispatch('open-targets'); await ui.dispatch('role-create-new'); ui.roles.edit('name', 'Engineer');
    fixture.scenario('uncertain'); await ui.dispatch('role-create'); await ui.dispatch('role-create'); expect(create).toHaveBeenCalledOnce();
    await ui.dispatch('role-refresh'); expect(ui.ctx.state.roleManager!.items.filter(r => r.targetRole === 'Engineer')).toHaveLength(1);
    await ui.dispatch('role-create'); expect(create).toHaveBeenCalledTimes(2); expect(ui.ctx.state.roleManager!.items.filter(r => r.targetRole === 'Engineer')).toHaveLength(1); ui.dispose();
  });
  it('preserves uncertain drafts on collapse and ignores late success', async () => {
    const { ui, save } = setup(); await ui.dispatch('open-targets'); await ui.dispatch('role-edit', ui.ctx.state.roleManager!.items[0]!.id);
    let finish!: (v: Awaited<ReturnType<typeof save>>) => void; save.mockImplementationOnce(() => new Promise(r => { finish = r; }));
    ui.roles.edit('location', 'Ottawa'); const saving = ui.dispatch('role-save'); await Promise.resolve(); await ui.dispatch('panel-close');
    expect(ui.ctx.state.roleManager!.editor).toMatchObject({ phase: 'review', code: 'SAVE_UNCERTAIN', draft: { location: 'Ottawa' } });
    finish({ ok: true, value: ui.ctx.state.roleManager!.editor!.base }); await saving;
    expect(ui.ctx.state.roleManager!.editor!.phase).toBe('review'); ui.dispose();
  });
});
