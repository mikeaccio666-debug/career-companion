import {autofillFieldLabel} from '../features/autofill/field-label';
import { C } from '../design/palette';
import type { Entitlement, UsageKind } from '../state/types';
import { EMPTY_REPORT, type ViewContext } from './view-context';

function usageView(ctx: ViewContext, label: string, e: Entitlement) {
  const base = { label, tag: '', tagBg: C.grey, tagColor: C.muted, hasBar: false, pct: 0, barColor: C.steel, line: '', right: '' };
  if (e.access === 'locked') return { ...base, tag: ctx.t("未解锁"), tagBg: C.lilac, tagColor: C.ink2, line: ctx.t("解锁后可用"), right: ctx.t("查看套餐") };
  if (e.access === 'sync') return { ...base, tag: ctx.t("权益同步中"), line: ctx.t("正在与服务端确认") };
  if (e.access !== 'granted' || e.remaining === undefined) return { ...base, tag: ctx.t("暂不可用"), line: ctx.t("可用数量尚未确认") };
  if (e.remaining === null) return { ...base, tag: ctx.t("不限量"), tagBg: C.mint, tagColor: C.green, line: ctx.t("已用 {v0} {v1}", { v0: e.used ?? 0, v1: e.unit ?? '' }) };
  const limit = e.limit ?? 0;
  const pct = limit > 0 ? Math.round(Math.min(1, Math.max(0, (limit - e.remaining) / limit)) * 100) : 0;
  const zero = e.remaining === 0;
  return { ...base, tag: zero ? ctx.t("额度已用完") : e.serviceDown ? ctx.t("服务异常") : ctx.t("已解锁"), tagBg: zero ? C.peach : e.serviceDown ? C.rose : C.mint, tagColor: zero ? '#8A5A2B' : e.serviceDown ? '#B4483A' : C.green,
    hasBar: limit > 0, pct, barColor: pct > 80 || zero ? C.warm : C.steel,
    line: ctx.t("{v0}剩余 {v1} / {v2} {v3}", { v0: e.period ?? '', v1: e.remaining, v2: limit, v3: e.unit ?? '' }), right: e.resetsAt ? ctx.t("{v0} 恢复", { v0: e.resetsAt }) : '' };
}

function atsDetails(ctx: ViewContext, id?: string, sample = false) {
  const report = id ? ctx.report(id, sample) : EMPTY_REPORT;
  const job = ctx.job(id);
  return {
    sample, total: report.total, max: report.max, headline: report.total >= 85 ? ctx.t("与该岗位匹配度高") : report.total >= 70 ? ctx.t("匹配良好，有可补强之处") : ctx.t("有明显差距，建议先补充"),
    resume: ctx.resume().label, job: ctx.state.commerceEnabled ? job.title : job.jdDigest,
    dims: Object.entries(report.definitions??ctx.data.dimensionCatalog).map(([code, definition]) => {
      const value = report.dims[code];
      const available = value !== null && value !== undefined && definition.max > 0;
      const ratio = available ? value[0] / definition.max : 0;
      return { code, label: definition.label, desc: available ? definition.desc : ctx.t("该维度暂不可用：服务未返回，不记作 0 分。"),
        scoreText: available ? `${value[0]} / ${definition.max}` : ctx.t("暂不可用"), scoreColor: available ? C.ink : C.faint,
        pct: available ? Math.round(Math.min(1, Math.max(0, ratio)) * 100) : 0, color: ratio >= .8 ? C.green : ratio >= .6 ? C.steel : C.warm,
        problems: available ? value[1].map(text => ({ text })) : [] };
    }),
    hasProblems: report.problems.length > 0, problems: report.problems.map(text => ({ text })), suggestions: report.suggestions.map(text => ({ text })), missing: report.missing.map(text => ({ text })),
    meta: ctx.state.commerceEnabled ? ctx.t("基于所选简历与已验证 JD · 规则 {v0} · 评估于 {v1}",{v0:report.rubricVersion,v1:report.measuredAt}) : ctx.t("评分性质：ATS 多维匹配（AtsScoringService）· 规则版本 {v0} · 评估于 {v1} · 维度名称与含义以服务规范为准，此处为示例标注。简历或 JD 变更后需要重新评估。", { v0: report.rubricVersion, v1: report.measuredAt }),
  };
}

export function sheetView(ctx: ViewContext) {
  const S = ctx.state, F = ctx.data, sh = S.sheet;
  const kind = sh?.kind;
  const job = ctx.job(sh?.id);
  const versions = F.resumeVersions.filter(v => v.kind === 'existing').map(v => ({
    id: v.id, label: v.label, note: S.reads ? ctx.t('{v0} · 交付权限需在申请时验证', { v0: ctx.t(v.current ? '当前版本' : '历史版本') }) : v.note, tag: v.id === S.resumeId ? ctx.t("使用中") : v.current ? ctx.t("当前版本") : ctx.t("历史版本"), tagBg: v.id === S.resumeId ? C.mint : C.grey, tagColor: v.id === S.resumeId ? C.green : C.muted,
  }));
  const targets = S.targets.map(t => {
    const on = t.id === S.currentTargetId;
    return { id: t.id, role: t.role, line: [t.locations, t.workMode].filter(Boolean).join(' · ') || ctx.t("地点与方式未填写"), line2: [t.salary, t.start ? ctx.t("可开始：{v0}", { v0: t.start }) : ''].filter(Boolean).join(' · ') || ctx.t("薪酬与时间未填写"),
      tag: on ? ctx.t("使用中") : t.source === 'Portal' ? ctx.t("来自 Portal") : ctx.t("切换使用"), tagBg: on ? C.mint : C.grey, tagColor: on ? C.green : C.muted, border: on ? C.steel : C.line, bg: on ? '#F7FAFD' : '#fff', shadow: on ? '0 0 0 3px rgba(168,192,220,.25)' : 'none' };
  });
  const usage = (['ats', 'jobs', 'letters', 'chat', 'voice'] as UsageKind[]).map(k => usageView(ctx, F.usageLabels[k], ctx.ent(k)));
  const lettersJobs = S.deck.selected.map(id => {
    const j = ctx.job(id), letter = S.letters[id];
    return { id, title: j.title, company: j.company, initial: j.company[0] ?? '', markBg: ctx.markBg(id), letterState: letter ? letter.status === 'kept' ? ctx.t("已保留草稿") : ctx.t("候选草稿") : ctx.t("尚未生成") };
  });
  const fillJob = ctx.job(S.fillId), profile = S.profile;
  const titles = {
    ats: sh?.sample ? ctx.t("多维 ATS 评估 · 示例") : ctx.t("多维 ATS 评估"), jd: job.title, targets: ctx.t("目标岗位"), usage: ctx.t("权益与用量"), resume: ctx.t("我的简历"), fill: ctx.t("确认本次填写"), letters: ctx.t("求职信"),
  };
  const captions = {
    ats: `${job.company} · ${job.title}`, jd: ctx.t("{v0} · {v1} · 示例 JD", { v0: job.company, v1: job.source }), targets: ctx.t("选择今天用于推荐、评估与材料的一组偏好 · 可随时切换"),
    usage: ctx.t("是否可用与可用数量分别显示 · 示例数字"), resume: ctx.t("来自简历库 · 方向与版本分开显示"), fill: `${fillJob.company} · ${fillJob.title}`, letters: ctx.t("属于具体岗位的材料"),
  };
  if (S.reads) captions.usage = S.commerceEnabled?ctx.t("服务端用量 · 失败任务不扣量"):ctx.t("权益尚未由服务端确认");
  if(S.commerceEnabled)captions.jd=`${job.company} · ${job.source}`;
  const resumeStatus = !S.reads ? '' : S.reads.resumes === 'loading' ? ctx.t("正在读取简历库…")
    : S.reads.resumes === 'locked' ? ctx.t("暂未获准读取简历库，请在 Portal 查看可用权益。")
    : S.reads.resumes === 'unavailable' ? ctx.t("暂时无法读取简历库，请稍后刷新。")
    : [versions.length ? ctx.t("{v0} 个可查看版本", { v0: versions.length }) : ctx.t("尚无已就绪版本"),
      S.reads.processingCount ? ctx.t("{v0} 个处理中", { v0: S.reads.processingCount }) : '',
      S.reads.failedCount ? ctx.t("{v0} 个处理失败", { v0: S.reads.failedCount }) : '',
      S.reads.hasMoreVersions ? ctx.t("更多历史版本请前往 Portal") : ''].filter(Boolean).join(' · ');
  return {
    readOnly: !!S.reads, resumeStatus,
    open: sh !== null, isTargets: kind === 'targets', isAts: kind === 'ats', isJd: kind === 'jd', isUsage: kind === 'usage', isResume: kind === 'resume', isFillConfirm: kind === 'fill', isLetters: kind === 'letters',
    title: kind ? titles[kind] : '', caption: kind ? captions[kind] : '',
    ats: atsDetails(ctx, sh?.id, sh?.sample), jd: { ...job, salary: job.salary ? `${job.salary} ${job.salaryUnit ?? ''}` : ctx.t("薪资未公开") },
    targets, targetsEmpty: targets.length === 0, usage, versions, lettersJobs, lettersHasJobs: lettersJobs.length > 0, lettersNoJobs: lettersJobs.length === 0,
    fillUses: S.autofill ? [
      {label:ctx.t("岗位"),value:`${fillJob.title} · ${fillJob.company}`},
      {label:ctx.t("简历"),value:ctx.data.resumeVersions.find(r=>r.id===S.autofill!.selection.resumeVersionId)?.label??ctx.t("本任务已绑定的简历版本")},
      {label:ctx.t("本次批准的字段"),value:(S.autofill.snapshot?.fieldKeys??[]).map((key,i)=>autofillFieldLabel(ctx.t,key,i)).join(" · ")},
      {label:ctx.t("留给你"),value:ctx.t("请在网站核对所有内容。其余问题与最终 Submit 由你完成。")},
    ] : [
      { label: ctx.t("岗位"), value: `${fillJob.title} · ${fillJob.company}` }, { label: ctx.t("简历"), value: S.autofill ? (ctx.data.resumeVersions.find(r=>r.id===S.autofill!.selection.resumeVersionId)?.label??ctx.t('本任务已绑定的简历版本')) : ctx.resume().label },
      { label: ctx.t("基本资料"), value: `${profile.name} · ${profile.email} · ${profile.phone}` }, { label: ctx.t("所在地"), value: profile.city }, { label: ctx.t("留给你"), value: ctx.t("工作授权 · 信息确认与签名") },
    ],
  };
}
