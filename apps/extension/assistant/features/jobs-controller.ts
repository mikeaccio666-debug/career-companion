import type { ControllerContext } from '../app/controller-context';
import { isCurrent, portResult } from '../app/controller-context';
import { atsInputKey, visibleBatchSize } from '../app/view-context';
import type { UsageKind } from '../state/types';

export function canUse(ctx: ControllerContext, kind: UsageKind) {
  const e = ctx.state.entitlements[kind];
  return e.access === 'granted' && !e.serviceDown && (e.remaining === null || (e.remaining !== undefined && e.remaining > 0));
}
export function consume(ctx: ControllerContext, kind: UsageKind, count = 1) {
  ctx.patch(s => { const e = s.entitlements[kind]; return { ...s, entitlements: { ...s.entitlements, [kind]: { ...e, used: (e.used ?? 0) + count, remaining: e.remaining == null ? e.remaining : Math.max(0, e.remaining - count) } } }; });
}
export function createJobsController(ctx: ControllerContext) {
  async function nextBatch() {
    const state = ctx.state, deck = state.deck;
    const count = visibleBatchSize(state.entitlements.jobs, ctx.data.jobs.length - deck.cursor);
    if (!count) { await ctx.go('batchend'); return; }
    const items = ctx.data.jobs.slice(deck.cursor, deck.cursor + count).map(job => job.id);
    ctx.patch({ deck: { ...deck, items, index: 0, cursor: deck.cursor + count, batchNo: deck.batchNo + 1, history: [], busy: false } });
    consume(ctx, 'jobs', count); await ctx.go('deck');
  }
  async function discover(allowPreview = false) {
    if (!ctx.state.currentTargetId && !allowPreview) {
      ctx.patch({ modal: { title: ctx.t("先告诉我想找的方向"), text: ctx.t("有了目标岗位，就可以按你的偏好整理机会。也可以先浏览示例岗位。"), actions: [{ id: 'to-profile', label: ctx.t("完善我的资料"), primary: true }, { id: 'demo-deck', label: ctx.t("先看示例岗位") }, { id: 'noop', label: ctx.t("稍后"), ghost: true }] } }); return;
    }
    if (ctx.state.deck.items.length && ctx.state.deck.index < ctx.state.deck.items.length) await ctx.go('deck'); else await nextBatch();
  }
  async function decide(accept: boolean) {
    const deck = ctx.state.deck, id = deck.items[deck.index], scope = ctx.store.scope();
    if (deck.busy || !id) return;
    ctx.patch({ deck: { ...deck, busy: true } });
    await ctx.motion?.chooseCard(accept);
    if (!isCurrent(ctx, scope)) return;
    ctx.patch(s => ({ ...s, deck: { ...s.deck, index: s.deck.index + 1, selected: accept ? [...new Set([...s.deck.selected, id])] : s.deck.selected, skipped: accept ? s.deck.skipped : [...s.deck.skipped, id], history: [...s.deck.history, { id, accept }], busy: false } }));
    if (ctx.state.deck.index >= ctx.state.deck.items.length) await ctx.go('batchend');
    else { await ctx.afterRender(); ctx.motion?.enterCard(); }
  }
  async function undo() {
    const d = ctx.state.deck, last = d.history.at(-1); if (!last || d.busy) return;
    ctx.patch({ deck: { ...d, index: Math.max(0, d.index - 1), history: d.history.slice(0, -1), selected: last.accept ? d.selected.filter(id => id !== last.id) : d.selected, skipped: last.accept ? d.skipped : d.skipped.filter(id => id !== last.id) } });
    if (ctx.state.scene !== 'deck') await ctx.go('deck'); else { await ctx.afterRender(); ctx.motion?.enterCard(last.accept); }
  }
  async function score(id: string) {
    const job = ctx.data.jobs.find(j => j.id === id), resumeId = ctx.state.resumeId;
    if (!job || !resumeId || !canUse(ctx, 'ats')) { ctx.toast(ctx.t("评估权益尚未可用，请查看用量。")); return; }
    const key = atsInputKey(job, resumeId), scope = ctx.store.scope();
    if (ctx.state.atsResults[key]?.status === 'scoring') return;
    ctx.patch(s => ({ ...s, atsResults: { ...s.atsResults, [key]: { status: 'scoring', resumeId } } }));
    const result = await portResult(() => ctx.ports.score({ job, resumeId }, scope.signal));
    if (!isCurrent(ctx, scope)) return;
    ctx.patch(s => ({ ...s, atsResults: { ...s.atsResults, [key]: result.ok ? { status: 'ready', resumeId, report: result.value } : { status: 'failed', resumeId } }, staleIds: { ...s.staleIds, [id]: s.resumeId !== resumeId } }));
    if (result.ok) consume(ctx, 'ats');
  }
  function pickResume(id: string) {
    if (id === ctx.state.resumeId || !ctx.data.resumeVersions.some(r => r.id === id)) return;
    if (Object.values(ctx.state.prep).some(status => status === 'queued' || status === 'preparing' || status === 'ready')) { ctx.toast(ctx.t("申请材料已绑定简历版本；请先完成当前申请任务。")); return; }
    const staleIds = Object.fromEntries(Object.keys(ctx.state.atsResults).map(key => [key.split('|')[0], true]));
    ctx.patch({ resumeId: id, staleIds }); ctx.toast(ctx.t("已切换简历版本，评估将使用新的简历。"));
  }
  return { discover, nextBatch, decide, undo, score, pickResume };
}
