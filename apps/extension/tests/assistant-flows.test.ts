import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAssistantController } from '../assistant/app/controller';
import { atsInputKey, visibleBatchSize } from '../assistant/app/view-context';
import { initialAssistantState } from '../assistant/state/initial';
import { previewData, entitlementScenarios, scores } from '../assistant/testing/fixtures';
import { createPreviewPorts } from '../assistant/testing/preview-ports';
import type { AssistantPorts, UiResult } from '../assistant/ports/assistant-ports';
import type { AtsReport, ChatMessage } from '../assistant/state/types';

const controllers: ReturnType<typeof createAssistantController>[] = [];
function setup(overrides: Partial<AssistantPorts> = {}) {
  const preview = createPreviewPorts(0);
  const entitlements = { ats: entitlementScenarios.ats.granted, jobs: entitlementScenarios.jobs.plenty, letters: entitlementScenarios.letters, chat: entitlementScenarios.chat, voice: entitlementScenarios.voice };
  const controller = createAssistantController(previewData, { ...preview.ports, ...overrides }, initialAssistantState(previewData, { persona: 'connected', locale: 'zh-CN', reduced: true, entitlements }));
  controller.ctx.afterRender = () => Promise.resolve();
  controllers.push(controller); return { controller, preview };
}
const cards = (messages: ChatMessage[]) => messages.filter(m => m.role === 'card');
async function say(c: ReturnType<typeof createAssistantController>, text: string) { c.ctx.patch(s => ({ ...s, chat: { ...s.chat, input: text } })); await c.intake.send(); }
afterEach(() => { controllers.splice(0).forEach(c => c.dispose()); vi.restoreAllMocks(); });

describe('assistant candidate confirmation', () => {
  it('keeps edits on a failed save and publishes only after a successful retry', async () => {
    const { controller: c, preview } = setup(); await c.intake.start(0);
    await say(c, '叫我 Mia，我在纽约，邮箱 mia@example.test。');
    const card = cards(c.ctx.state.chat.messages)[0]; expect(card).toBeDefined();
    c.intake.edit(card.id, 'city', 'New York, NY');
    preview.failNext('saveCandidate', 'SAVE_FAILED'); await c.intake.confirm(card.id);
    expect(c.ctx.state.profile.city).toBe('San Francisco, CA');
    expect(cards(c.ctx.state.chat.messages)[0].card.notice).toBe(true);
    expect(cards(c.ctx.state.chat.messages)[0].card.fields.find(f => f.key === 'city')?.value).toBe('New York, NY');
    await c.intake.confirm(card.id);
    expect(c.ctx.state.profile.city).toBe('New York, NY');
    expect(cards(c.ctx.state.chat.messages)[0].card.readOnly).toBe(true);
    expect(c.ctx.state.chat.phase).toBe(1);
  });
  it('saves each extracted role independently and keeps shared authorization out of targets', async () => {
    const { controller: c } = setup(); await c.intake.start(1);
    await say(c, '想找 Product Designer 和 UX Researcher，地点纽约，远程或混合，四周内可以开始。');
    const pending = cards(c.ctx.state.chat.messages); expect(pending).toHaveLength(2);
    expect(pending[0].card.fields.find(f => f.key === 'locations')?.value).toBe('纽约');
    c.intake.edit(pending[0].id, 'workAuth', '有工作许可');
    await c.intake.confirm(pending[0].id);
    expect(c.ctx.state.targets).toHaveLength(1);
    expect(c.ctx.state.targets[0].role).toBe('Product Designer');
    expect(c.ctx.state.profile.workAuth).toBe('有工作许可');
    await c.intake.confirm(pending[1].id);
    expect(c.ctx.state.targets).toHaveLength(2);
    expect(c.ctx.state.profile.workAuth).toBe('有工作许可');
    expect(c.ctx.state.targets.every(t => !('workAuth' in t) && !('gender' in t))).toBe(true);
    c.intake.useTarget(c.ctx.state.targets[0].id);
    expect(c.ctx.state.currentTargetId).toBe(c.ctx.state.targets[0].id);
  });
  it('does not edit a card while its save is in flight, or apply that result after reset', async () => {
    let finish!: (result: UiResult<void>) => void;
    const { controller: c } = setup({ saveCandidate: () => new Promise(resolve => { finish = resolve; }) });
    await c.intake.start(0); await say(c, '叫我 Mia，我在纽约。');
    const card = cards(c.ctx.state.chat.messages)[0];
    const saving = c.intake.confirm(card.id);
    c.intake.edit(card.id, 'city', 'unconfirmed later edit');
    expect(cards(c.ctx.state.chat.messages)[0].card.fields.find(f => f.key === 'city')?.value).not.toBe('unconfirmed later edit');
    c.reset(); finish({ ok: true, value: undefined }); await saving;
    expect(c.ctx.state.confirmed[0]).toBe(false);
    expect(c.ctx.state.profile.city).toBe('San Francisco, CA');
  });
  it('requires a confirmation card before saving optional declined answers', async () => {
    const { controller: c } = setup(); await c.intake.start(2); await c.intake.privacy('decline');
    expect(c.ctx.state.profile.gender).toBe(''); expect(c.ctx.state.confirmed[2]).toBe(false);
    await c.intake.confirm(cards(c.ctx.state.chat.messages)[0].id);
    expect(c.ctx.state.profile.gender).toBe('不愿回答'); expect(c.ctx.state.privacy).toBe('declined');
  });
});

describe('assistant jobs and materials', () => {
  it('uses the available remainder, and never interprets unknown quota as unlimited', async () => {
    expect(visibleBatchSize({ access: 'granted' }, 30)).toBe(0);
    expect(visibleBatchSize({ access: 'sync', remaining: 20 }, 30)).toBe(0);
    const { controller: c } = setup();
    c.ctx.patch(s => ({ ...s, entitlements: { ...s.entitlements, jobs: entitlementScenarios.jobs.short } }));
    await c.jobs.nextBatch(); expect(c.ctx.state.deck.items).toHaveLength(4); expect(c.ctx.state.entitlements.jobs.remaining).toBe(0);
    await c.jobs.decide(true); expect(c.ctx.state.deck.selected).toHaveLength(1);
    await c.jobs.undo(); expect(c.ctx.state.deck.selected).toHaveLength(0); expect(c.ctx.state.deck.index).toBe(0);
  });
  it('keys a late score to the requested resume, and rejects it entirely after closing', async () => {
    let finish!: (result: UiResult<AtsReport>) => void;
    const { controller: c } = setup({ score: () => new Promise(resolve => { finish = resolve; }) });
    const job = previewData.jobs[0], oldResume = c.ctx.state.resumeId;
    const pending = c.jobs.score(job.id); c.jobs.pickResume('ux-v2');
    finish({ ok: true, value: scores[job.id] }); await pending;
    expect(c.ctx.state.atsResults[atsInputKey(job, 'ux-v2')]).toBeUndefined();
    expect(c.ctx.state.atsResults[atsInputKey(job, oldResume)].status).toBe('ready');
    const next = c.jobs.score(job.id); await c.ctx.close(); finish({ ok: true, value: scores[job.id] }); await next;
    expect(c.ctx.state.atsResults[atsInputKey(job, 'ux-v2')].status).toBe('failed');
  });
  it('locks each prepared resume into the run', async () => {
    const run = vi.fn<AssistantPorts['run']>(async (_input, onRow) => { onRow({ ...previewData.runRows[0], state: 'filled' }); return { ok: true, value: undefined }; });
    const { controller: c } = setup({ run }); const id = previewData.jobs[0].id;
    c.ctx.patch(s => ({ ...s, deck: { ...s.deck, selected: [id] } }));
    await c.materials.prepare(); expect(c.ctx.state.prep[id]).toBe('ready');
    c.jobs.pickResume('ux-v2'); expect(c.ctx.state.resumeId).toBe('pd-v3');
    await c.materials.openJob(id); await c.materials.fill();
    expect(run.mock.calls[0][0].resumeId).toBe('pd-v3'); expect(c.ctx.state.run.rows[0].state).toBe('filled');
  });
  it('retries one failed preparation without preparing successful jobs again', async () => {
    const prepare = vi.fn<AssistantPorts['prepare']>().mockResolvedValueOnce({ ok: true, value: { resumeId: 'first' } }).mockResolvedValueOnce({ ok: false, code: 'UNAVAILABLE' }).mockResolvedValueOnce({ ok: true, value: { resumeId: 'second' } });
    const { controller: c } = setup({ prepare }); const ids = previewData.jobs.slice(0, 2).map(j => j.id);
    c.ctx.patch(s => ({ ...s, deck: { ...s.deck, selected: ids } })); await c.materials.prepare();
    expect(c.ctx.state.prep[ids[0]]).toBe('ready'); expect(c.ctx.state.prep[ids[1]]).toBe('failed');
    await c.materials.retry(ids[1]); expect(prepare).toHaveBeenCalledTimes(3);
    expect(prepare.mock.calls[2][0].job.id).toBe(ids[1]); expect(c.ctx.state.preparedResume[ids[0]]).toBe('first');
    await c.materials.prepare(); expect(prepare).toHaveBeenCalledTimes(3);
  });
});

describe('assistant failure projections', () => {
  it('keeps a required cover letter distinct from an unknown requirement and offers retry on failure', async () => {
    const { createViewContext } = await import('../assistant/app/view-context');
    const { coverView } = await import('../assistant/app/materials-view');
    const { panelDimensions } = await import('../assistant/shell/geometry');
    const { controller: c } = setup(); const id = previewData.jobs.find(j => j.coverLetterRequirement === 'REQUIRED')!.id;
    c.ctx.patch({ coverId: id });
    const view = () => coverView(createViewContext(c.ctx.state, previewData, panelDimensions('cover', { width: 1440, height: 900 })));
    expect(view().askText).toContain('该岗位要求求职信'); expect(view().deferLabel).toBe('稍后处理');
    c.ctx.patch({ letters: { [id]: { status: 'failed', text: '' } } });
    expect(view().ask).toBe(true); expect(view().askText).toContain('重试');
  });
});
