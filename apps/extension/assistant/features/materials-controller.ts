import type { ControllerContext } from '../app/controller-context';
import { isCurrent, portResult } from '../app/controller-context';
import { emptyRun } from '../state/initial';
import { canUse, consume } from './jobs-controller';

export function createMaterialsController(ctx: ControllerContext) {
  async function prepareOne(id: string, index: number, scope = ctx.store.scope()) {
    const job = ctx.data.jobs.find(j => j.id === id); if (!job || ctx.state.prep[id] === 'preparing' || ctx.state.prep[id] === 'ready') return;
    const resumeId = ctx.state.resumeId;
    ctx.patch(s => ({ ...s, prep: { ...s.prep, [id]: 'preparing' } }), scope);
    const result = await portResult(() => ctx.ports.prepare({ job, resumeId, index }, scope.signal));
    if (!isCurrent(ctx, scope)) return;
    ctx.patch(s => ({ ...s, prep: { ...s.prep, [id]: result.ok ? 'ready' : 'failed' }, preparedResume: result.ok ? { ...s.preparedResume, [id]: result.value.resumeId } : s.preparedResume }), scope);
  }
  async function prepare() {
    const ids = ctx.state.deck.selected.filter(id => ctx.state.prep[id] !== 'ready'); if (!ids.length || Object.values(ctx.state.prep).some(p => p === 'preparing' || p === 'queued')) return;
    const scope = ctx.store.scope();
    ctx.patch(s => ({ ...s, prep: { ...s.prep, ...Object.fromEntries(ids.map(id => [id, 'queued' as const])) } })); await ctx.go('preparing');
    for (let i = 0; i < ids.length; i++) { if (!isCurrent(ctx, scope)) return; await prepareOne(ids[i], i, scope); }
    if (!isCurrent(ctx, scope)) return;
    await ctx.go('shortlist'); ctx.toast(Object.values(ctx.state.prep).includes('failed') ? ctx.t("部分岗位准备失败，可单独重试。") : ctx.t("申请任务已就绪。"));
  }
  async function generate(id: string) {
    const job = ctx.data.jobs.find(j => j.id === id); if (!job || ctx.state.letters[id]?.status === 'generating') return;
    if (!canUse(ctx, 'letters')) { ctx.toast(ctx.t("求职信生成权益暂不可用。")); return; }
    const scope = ctx.store.scope();
    ctx.patch(s => ({ ...s, letters: { ...s.letters, [id]: { status: 'generating', text: '' } } }));
    const result = await portResult(() => ctx.ports.generateLetter({ job, profile: ctx.state.profile }, scope.signal));
    if (!isCurrent(ctx, scope)) return;
    ctx.patch(s => ({ ...s, letters: { ...s.letters, [id]: result.ok ? { status: 'draft', text: result.value } : { status: 'failed', text: '' } } }));
    if (result.ok) consume(ctx, 'letters');
  }
  async function openJob(id: string) {
    if (ctx.state.prep[id] !== 'ready' || !ctx.state.preparedResume[id]) { ctx.toast(ctx.t("请先准备这个岗位的申请材料。")); return; }
    ctx.patch({ fillId: id, run: emptyRun(), hostHighlight: false }); await ctx.go('autofill');
  }
  async function fill() {
    const state = ctx.state, job = ctx.data.jobs.find(j => j.id === state.fillId), resumeId = state.preparedResume[state.fillId];
    if (!job || !resumeId || state.prep[job.id] !== 'ready' || state.run.status === 'running') return;
    const scope = ctx.store.scope();
    ctx.patch({ sheet: null, run: { status: 'running', count: 0, rows: ctx.data.runRows.map(row => ({ ...row, state: 'pending' })), failed: false } });
    const result = await portResult(() => ctx.ports.run({ job, resumeId }, row => ctx.patch(s => {
      const rows = s.run.rows.map(current => current.key === row.key ? row : current);
      return { ...s, run: { ...s.run, rows, count: rows.filter(r => ['filled', 'kept', 'manual'].includes(r.state)).length } };
    }, scope), scope.signal));
    if (!isCurrent(ctx, scope)) return;
    ctx.patch(s => ({ ...s, run: { ...s.run, status: result.ok ? 'done' : 'paused', failed: !result.ok } }));
    if (!result.ok) ctx.patch({ modal: { title: result.code === 'PAGE_CHANGED' ? ctx.t("申请页面发生了变化") : ctx.t("本次填写已暂停"), text: ctx.t("已完成的内容保留。请核对当前岗位和页面后，重新检查；未完成的项目需要由你确认。"), actions: [{ id: 'page-recheck', label: ctx.t("重新核对页面"), primary: true }, { id: 'go-shortlist', label: ctx.t("返回申请清单"), ghost: true }] } });
  }
  return { prepare, retry: (id: string) => prepareOne(id, 0), generate, openJob, fill,
    async openCover(id: string) { if (!ctx.data.jobs.some(j => j.id === id)) return; ctx.patch({ coverId: id, sheet: null }); await ctx.go('cover'); },
    editLetter(text: string) { const id = ctx.state.coverId, letter = ctx.state.letters[id]; if (!letter || letter.status === 'generating') return; ctx.patch(s => ({ ...s, letters: { ...s.letters, [id]: { ...letter, text, status: 'draft', edited: true } } })); },
    keepLetter() { const id = ctx.state.coverId, letter = ctx.state.letters[id]; if (!letter || !letter.text || letter.status === 'generating') return; ctx.patch(s => ({ ...s, letters: { ...s.letters, [id]: { ...letter, status: 'kept' } } })); ctx.toast(ctx.t("草稿已保留在本次预览中。")); },
    remove(id: string) { if (ctx.state.prep[id] === 'preparing') return; ctx.patch(s => ({ ...s, deck: { ...s.deck, selected: s.deck.selected.filter(x => x !== id) } })); },
    async handoff() { ctx.patch({ hostHighlight: true }); await ctx.close(); },
  };
}
