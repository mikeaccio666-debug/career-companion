import { C, PRIMARY_BG, PRIMARY_SHADOW } from '../design/palette';
import type { ViewContext } from './view-context';
import type { ChatMessage, CandidateCard, Entitlement, ProfileField, UploadState } from '../state/types';

export function deckView(ctx: ViewContext) {
    const S = ctx.state, F = ctx.data, d = S.deck; const id = d.items[d.index]; const j = id ? ctx.job(id) : null; const total = d.items.length;
    const e = ctx.ent('jobs'); const note = S.commerceEnabled ? ctx.t("已保存的真实岗位 · 按你的节奏挑选") : total < 10 ? (e.remaining != null && e.remaining === 0 ? ctx.t("本组 ") + total + ctx.t(" 个 · 本周额度已用完") : e.sourceExhausted ? ctx.t("本组 ") + total + ctx.t(" 个 · 暂无更多来源岗位") : ctx.t("本组 ") + total + ctx.t(" 个 · 受剩余额度限制")) : ctx.t("示例岗位 · Greenhouse 来源 · 按你的节奏挑选");
    const jobV = j ? { id: j.id, company: j.company, initial: j.company[0], markBg: ctx.markBg(j.id), title: j.title, location: j.mode.startsWith(j.location) ? 'US' : j.location, mode: j.mode, type: j.type, salary: j.salary || ctx.t("薪资未公开"), salaryUnit: j.salary ? j.salaryUnit : ctx.t("待确认"), salaryColor: j.salary ? C.ink : C.faint, summary: j.summary, matches: j.matches.map(t => ({ text: t })), gap: j.gap, source: j.source, posted: j.posted, closed: d.closedJob === j.id } : { id: '', company: '', initial: '', markBg: C.ice, title: '', location: '', mode: '', type: '', salary: '', salaryUnit: '', salaryColor: C.faint, summary: '', matches: [], gap: '', source: '', posted: '', closed: false };
    return { sourceLine: ctx.state.commerceEnabled ? [j?.source,j?.posted].filter(Boolean).join(' · ') : (j?.source??'')+ctx.t(' · 示例岗位 · ')+(j?.posted??''), jobId: id, hasCard: !!j, job: jobV, counter: total ? String(Math.min(d.index + 1, total)).padStart(2, '0') + ' / ' + String(total).padStart(2, '0') : '—', groupNote: note, skipped: d.skipped.length, selectedCount: d.selected.length, busy: d.busy, undoDisabled: !d.history.length || d.busy };
  }

export function atsView(ctx: ViewContext, id: string | undefined) {
    const S = ctx.state, F = ctx.data; const e = ctx.ent('ats'); const A = (act: string, label: string, primary = false, arg?: string) => ({ act, label, arg: arg || id || '', bg: primary ? C.ink : '#fff', color: primary ? '#fff' : C.ink, border: primary ? 'transparent' : C.line });
    const v = { bg: C.grey, border: C.line, showScore: false, showSpinner: false, showLock: false, showWarn: false, showBars: false, hasActions: true, actions: [] as ReturnType<typeof A>[], usage: '', title: '', caption: '', total: '' as string | number, max: 100, mini: [] as { label: string; max: number; pct: number; color: string }[], warnColor: '#B4483A' };
    if (!id) return v;
    const res = S.atsResults[ctx.atsKey(id)]; const usageText = S.commerceEnabled ? (e.access==='granted'?ctx.t("剩余 {v0} {v1}",{v0:e.remaining??0,v1:e.unit??''}):'') : e.access === 'granted' ? (e.remaining == null ? ctx.t("不限量（示例）") : ctx.t("剩余 ") + e.remaining + ' ' + e.unit + ctx.t("（示例）")) : '';
    if (!S.hasResume) return Object.assign(v, { showWarn: true, warnColor: C.faint, title: ctx.t("需要简历才能评估"), caption: ctx.t("上传并确认简历后，评估会基于你的经历与该岗位 JD。"), actions: [A('personalize', ctx.t("先整理我的资料"), true)] });
    if (res && res.status === 'ready') { const sc = res.report; if (!sc) return v; const mini = Object.keys(sc.definitions??F.dimensionCatalog).map(k => { const dm = sc.dims[k]; const cat = (sc.definitions??F.dimensionCatalog)[k]; return { label: cat.label, max: cat.max, pct: dm ? Math.round(dm[0] / cat.max * 100) : 0, color: dm ? (dm[0] / cat.max >= .8 ? C.green : dm[0] / cat.max >= .6 ? C.steel : C.warm) : '#D9E0EA' }; }); return Object.assign(v, { bg: '#F7FAFD', border: C.line, showScore: true, total: sc.total, max: sc.max, showBars: true, mini, title: ctx.t("多维 ATS 评估"), caption: ctx.resume().label + (S.commerceEnabled?ctx.t(" · 已验证职位版本 · 不是录用概率"):' · JD '+ctx.job(id).jdDigest+ctx.t(" · 不是录用概率")), actions: [A('ats-details', ctx.t("查看多维详情"))], usage: usageText }); }
    if(res?.status==='pending')return Object.assign(v,{showSpinner:false,showWarn:true,title:ctx.t("评估在后台继续"),caption:ctx.t("关闭面板不会丢失任务；可随时查看进度。"),actions:[A('ats-score',ctx.t("查看进度"),true)]});
    if (e.access === 'locked') return Object.assign(v, { bg: C.lilac, border: '#E4E1F6', showLock: true, title: ctx.t("多维 ATS 评估 · 未解锁"), caption: ctx.t("解锁后可查看该岗位与你简历的多维匹配、问题与改进建议。不影响挑选岗位。"), actions: [A('open-plans', ctx.t("查看套餐 / 解锁评分"), true), S.commerceEnabled?A('ats-existing',ctx.t("查看已有评估")):A('ats-sample', ctx.t("看看示例"))] });
    if (e.access === 'sync') return Object.assign(v, { showSpinner: true, title: ctx.t("正在确认你的权益…"), caption: ctx.t("付款返回不等于权益已生效；确认前不会开始评分。"), actions: [A('ats-retry-sync', ctx.t("重试确认")),...(S.commerceEnabled?[A('ats-existing',ctx.t("查看已有评估"))]:[])] });
    if (S.staleIds[id] && (!res || res.status !== 'ready')) return Object.assign(v, { bg: C.peach, border: '#F1D9C2', showWarn: true, warnColor: '#B86A2B', title: ctx.t("简历已更换 · 需要重新评估"), caption: ctx.t("上次结果基于另一版简历；不会沿用旧分数。"), actions: e.remaining === 0 ? [A('open-usage', ctx.t("查看额度"))] : [A('ats-score', ctx.t("重新评估") + (e.remaining == null ? '' : ctx.t(" · 用 1 份")), true)], usage: usageText });
    if (res && res.status === 'scoring') return Object.assign(v, { showSpinner: true, title: ctx.t("正在评估…"), caption: ctx.t("基于 ") + ctx.resume().label + ctx.t(" 与该岗位 JD"), hasActions: false });

    if (e.access === 'unavailable' || e.remaining === undefined) return Object.assign(v, { showWarn: true, title: ctx.t("评分权益暂不可用"), caption: ctx.t("暂时无法确认你的可用额度，请稍后重试。"), actions: [A('ats-retry-sync', ctx.t("重试确认")),...(S.commerceEnabled?[A('ats-existing',ctx.t("查看已有评估"))]:[])] });
    if (e.remaining === 0) return Object.assign(v, { bg: C.peach, border: '#F1D9C2', showWarn: true, warnColor: '#B86A2B', title: ctx.t("ATS 评估额度已用完"), caption: ctx.t("本周期 ") + e.limit + ' ' + e.unit + ctx.t("已用完") + (e.resetsAt ? ' · ' + e.resetsAt + ctx.t(S.commerceEnabled?"恢复":"恢复（示例）") : '') + ctx.t("。仍可挑选岗位。"), actions: [A('open-usage', ctx.t("查看额度")), A('open-plans', ctx.t("查看套餐")),...(S.commerceEnabled?[A('ats-existing',ctx.t("查看已有评估"))]:[])] });
    if (res?.status === 'failed' && res.failureCode === 'RATE_LIMITED') return Object.assign(v, { showWarn:true, title:ctx.t('今天的服务调用次数已达安全上限，请明天再试；已保存资料仍可编辑。'), caption:usageText, actions:[A('ats-existing',ctx.t('查看已有评估'))] });
    if (res && res.status === 'failed') return Object.assign(v, { bg: C.rose, border: '#F1C9C2', showWarn: true, title: ctx.t("评分服务暂不可用"), caption: ctx.t("不影响挑选岗位。稍后重试；不会记作 0 分，也不会换用其他估分。"), actions: [A('ats-retry', ctx.t("重试"))] });
    if (e.serviceDown) return Object.assign(v, { bg: C.rose, border: '#F1C9C2', showWarn: true, title: ctx.t("评分服务暂不可用"), caption: ctx.t("不影响挑选岗位。稍后重试；不会记作 0 分。"), actions: [A('ats-retry', ctx.t("重试"))] });
    return Object.assign(v, { showWarn: true, warnColor: C.steel, title: ctx.t("多维 ATS 评估 · 待评分"), caption: e.remaining == null ? ctx.t("基于 ") + ctx.resume().label + ctx.t(" 与该岗位 JD，不是录用概率。") : ctx.t("评估此岗位将使用 1 ") + (S.commerceEnabled ? ctx.t("份评估额度") : e.unit) + ctx.t("；结果可重复查看，不重复扣量。"), actions: [A('ats-score', e.remaining == null ? ctx.t("评估这个岗位") : ctx.t("评估 · 用 1 份"), true)], usage: usageText });
  }

export function batchView(ctx: ViewContext) {
    const S = ctx.state, d = S.deck; const n = d.selected.length; const size = ctx.batchSize(); const e = ctx.ent('jobs');
    const B = (act: string, label: string, primary = false, arg?: string) => ({ act, label, arg: arg || '', h: primary ? 50 : 44, bg: primary ? PRIMARY_BG : '#fff', color: primary ? '#fff' : C.ink, border: primary ? 'transparent' : C.line, weight: 600, shadow: primary ? PRIMARY_SHADOW : '0 1px 2px rgba(10,17,40,.04)' });
    const ghost = (act: string, label: string) => ({ act, label, arg: '', h: 40, bg: 'transparent', color: C.ink2, border: 'transparent', weight: 500, shadow: 'none' });
    if(S.commerceEnabled){
      const exhausted=e.access==='granted'&&e.remaining===0,none=e.sourceExhausted;
      const actions=[...(n?[B('open-shortlist',ctx.t("查看收藏"),true)]:[]),B('next-batch',ctx.t("检查更多岗位"),!n),ghost('home',ctx.t("回到工作台"))];
      if(exhausted)actions.splice(actions.length-1,0,B('open-usage',ctx.t("查看额度与套餐")));
      if(d.history.length)actions.splice(actions.length-1,0,ghost('deck-undo',ctx.t("↶ 撤回上一张")));
      return {count:n,title:n?ctx.t("已收藏 {v0} 个机会",{v0:n}):ctx.t("这一组已看完。"),sub:ctx.t("收藏会保留在当前求职方向，之后可以继续查看。"),actions,
        showQuota:!!none||exhausted,quotaText:none?ctx.t("暂时没有更多新岗位。已选的机会会保留，你可以调整偏好，或稍后再来看。"):exhausted?ctx.t("本周期额度已用完；已收录的岗位仍可查看。"):"",quotaBg:C.grey,quotaIcon:'i',quotaIconColor:C.ink};
    }
    let title, sub, actions: ReturnType<typeof B>[] = [], showQuota = false, quotaText = '', quotaBg = C.grey, quotaIcon = 'i', quotaIconColor = C.ink;
    title = n ? ctx.t("你选中了 ") + n + ctx.t(" 个机会。") : ctx.t("下一份心动，或许在下一轮。");
    sub = n ? ctx.t("这一组已看完。继续看看，还是开始准备申请？") : ctx.t("这一组已看完。可以再看一组，也可以调整工作偏好。");
    let more = null;
    if (e.sourceExhausted || d.cursor >= ctx.data.jobs.length) { showQuota = true; quotaText = ctx.t("暂时没有更多新岗位。已选的机会会保留，你可以调整偏好，或稍后再来看。"); }
    else if (size === 0) { showQuota = true; quotaBg = C.peach; quotaIcon = '!'; quotaIconColor = '#B86A2B'; quotaText = ctx.t("本周的岗位额度已用完（示例 ") + e.limit + ' ' + e.unit + '）。' + (e.resetsAt ? e.resetsAt + ctx.t("恢复，") : '') + ctx.t("或查看套餐以获得更多。已选的机会不受影响。"); }
    else { more = B('next-batch', ctx.t("再看 ") + size + ctx.t(" 个机会"), !n); if (size < 10) { showQuota = true; quotaText = e.remaining != null && e.remaining < 10 ? ctx.t("本周剩余额度还能提供 ") + size + ctx.t(" 个新岗位（示例）。不会重复展示看过的岗位。") : ctx.t("来源里还剩 ") + size + ctx.t(" 个新岗位；不会重复凑数。"); } }
    if (n) actions.push(B('open-shortlist', ctx.t("准备这 ") + n + ctx.t(" 份申请"), true));
    if (more) actions.push(more);
    if (e.sourceExhausted || d.cursor >= ctx.data.jobs.length) actions.push(B('personalize', ctx.t("调整我的偏好"), !n));
    if (size === 0 && !e.sourceExhausted) { actions.push(B('open-usage', ctx.t("查看额度与套餐"), !n)); }
    if (d.history.length) actions.push(ghost('deck-undo', ctx.t("↶ 撤回上一张")));
    actions.push(ghost('home', ctx.t("回到工作台")));
    return { count: n, title, sub, actions, showQuota, quotaText, quotaBg, quotaIcon, quotaIconColor };
  }
