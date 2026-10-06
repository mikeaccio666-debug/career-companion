import { savedProfileView } from '../features/session/profile-view';
import { C, PRIMARY_BG, PRIMARY_SHADOW } from '../design/palette';
import type { ViewContext } from './view-context';
import type { ChatMessage, CandidateCard, Entitlement, ProfileField, UploadState } from '../state/types';

export function usageLine(ctx: ViewContext) { const a = ctx.ent('ats'), j = ctx.ent('jobs'); const f = (e: Entitlement) => e.access === 'locked' ? ctx.t("未解锁") : e.access === 'sync' ? ctx.t("同步中") : e.remaining === undefined ? ctx.t("暂不可用") : e.remaining === null ? ctx.t("不限量") : ctx.t("剩 ") + e.remaining; return ctx.t("ATS 评估 ") + f(a) + ctx.t(" · 岗位 ") + f(j) + (ctx.state.reads ? '' : ctx.t(" · 示例")); }

export function uploadView(ctx: ViewContext, u: UploadState) {
    const st = u.state; const steps = [[ctx.t("上传文件"), 'uploading'], [ctx.t("读取内容"), 'reading'], [ctx.t("整理资料"), 'organizing']]; const order = ['uploading', 'reading', 'organizing']; const idx = order.indexOf(st);
    const stepsV = steps.map((s, i) => { const done = idx > i || st === 'done'; const active = idx === i; return { label: s[0], mark: done ? '✓' : (i + 1), bg: done ? C.mint : active ? C.ink : C.grey, fg: done ? C.green : active ? '#fff' : C.faint, color: active ? C.ink : done ? C.green : C.faint, right: active ? ctx.t("进行中") : done ? ctx.t("完成") : '' }; });
    const A = (act: string, label: string, primary = false) => ({ act, label, bg: primary ? C.ink : '#fff', color: primary ? '#fff' : C.ink, border: primary ? 'transparent' : C.line });
    const v = { title: ctx.t("把你的故事带到这里"), text: ctx.t("PDF / DOCX 简历。\n这个原型使用一份虚构的演示简历，不读取真实文件。"), showSteps: false, scanning: false, slow: !!u.slow, steps: stepsV, actions: [A('upload-start', ctx.t("使用演示简历，体验解析"), true), A('upload-manual', ctx.t("先手动填写"))] };
    if (idx >= 0) Object.assign(v, { title: 'Mia · Product design.pdf', text: [ctx.t("正在上传…"), ctx.t("正在阅读你的经历…"), ctx.t("正在整理成候选资料…")][idx], showSteps: true, scanning: true, actions: [A('upload-cancel', ctx.t("取消"))] });
    if (st === 'failed') Object.assign(v, { title: ctx.t("这份简历暂时无法读取"), text: ctx.t("可以换一个 PDF / DOCX 重试，也可以先手动填写。已有资料不会被这次失败覆盖。"), actions: [A('upload-retry', ctx.t("重试解析"), true), A('upload-manual', ctx.t("手动填写"))] });
    if (st === 'done') Object.assign(v, { title: ctx.t("演示简历已整理"), text: ctx.t("发现 2 段工作经历、1 段教育经历和 6 项技能。\n它们是待你确认的候选，还没有保存。"), showSteps: true, actions: [A('open-review', ctx.t("回看解析出的经历"))] });
    if (st === 'skipped') Object.assign(v, { title: ctx.t("先不上传"), text: ctx.t("之后随时可以从工作台「我的简历」上传。"), actions: [] });
    return v;
  }

export function reviewView(ctx: ViewContext, wide: boolean) {
    const S = ctx.state, F = ctx.data, p = S.profile;
    const dot = (v: string, kind?: string) => v ? { dot: C.green, color: C.ink } : kind === 'self' ? { dot: C.warm, color: '#8A5A2B' } : { dot: '#C9D2DF', color: C.faint };
    const row = (label: string, v: string, kind?: string, emptyText?: string) => Object.assign({ label, value: v || emptyText || ctx.t("未提供") }, dot(v, kind));
    const privacyRow = (k: ProfileField) => { const v = p[k]; if (v) return row((F.fieldMeta[k]?.label ?? k), v); return Object.assign({ label: (F.fieldMeta[k]?.label ?? k), value: S.privacy === 'skipped' ? ctx.t("已跳过 · 由你决定") : ctx.t("未选择") }, { dot: '#C9D2DF', color: C.faint }); };
    const groups = [
      { title: ctx.t("基本资料"), phase: 0, rows: [row(ctx.t("称呼"), p.nick), row(ctx.t("姓名"), p.name), row(ctx.t("所在城市"), p.city), row(ctx.t("邮箱"), p.email), row(ctx.t("电话"), p.phone), row(ctx.t("链接"), p.links)] },
      { title: ctx.t("教育与经历"), phase: 0, rows: [row(ctx.t("教育"), p.education), row(ctx.t("工作经历"), (p.experience || []).join('\n')), row(ctx.t("技能"), (p.skills || []).join(' · ')), row(ctx.t("项目"), p.projects), row(ctx.t("语言"), p.languages), row(ctx.t("概述"), p.summary)] },
      { title: ctx.t("工作与偏好"), phase: 1, hasSwitch: true, stacked: S.targets.length > 1, stackPad: S.targets.length > 1 ? 8 : 0, subtitle: S.targets.length > 1 ? ctx.t("当前使用「") + (ctx.currentTarget()?.role ?? '') + ctx.t("」· 共 ") + S.targets.length + ctx.t(" 组目标岗位") : S.targets.length === 1 ? ctx.t("只有一组目标岗位 · 可添加更多") : ctx.t("还没有保存的目标岗位"), switchLabel: S.targets.length > 1 ? ctx.t("其他 ") + (S.targets.length - 1) + ctx.t(" 组") : ctx.t("添加"), rows: [row(ctx.t("目标职位"), p.role), row(ctx.t("理想地点"), p.locations), row(ctx.t("工作方式"), p.workMode), row(ctx.t("期望薪酬"), p.salary), row(ctx.t("可开始时间"), p.start), row(ctx.t("工作许可"), p.workAuth, 'self', ctx.t("需按申请地区由你确认")), row(ctx.t("签证支持"), p.sponsorship, 'self', ctx.t("需按申请地区由你确认"))] },
      { title: ctx.t("可选的自我认同信息"), phase: 2, rows: (['gender', 'race', 'disability', 'veteran'] as ProfileField[]).map(privacyRow) }];
    const readOnly = !!S.reads;
    const status = S.reads?.personal;
    const complete = readOnly && S.reads?.profileV2 ? savedProfileView(ctx) : null;
    return { readOnly, legend: readOnly ? ctx.t("已保存") : ctx.t("已确认"), primaryAct: readOnly ? 'home' : 'review-confirm', primaryLabel: readOnly ? ctx.t("回到工作台") : ctx.t("确认资料，回到工作台"),
      title: readOnly ? ctx.t("你的已保存资料") : ctx.t("这是你的故事，") + (p.nick || p.name) + '。',
      sub: complete?.sub ?? (readOnly ? status === 'loading' ? ctx.t("正在读取基本资料…") : status === 'locked' ? ctx.t("基本资料暂未获准读取。") : status === 'unavailable' ? ctx.t("暂时无法读取基本资料，请稍后刷新。") : ctx.t("以下为已保存的基本资料，可在 Portal 中修改。") : ctx.t("请检查每一组资料。可选信息由你决定，不会被推断。")),
      columns: wide && !readOnly ? '1fr 1fr' : '1fr',
      groups: complete?.groups ?? (readOnly ? (status === 'ready' ? groups.slice(0, 1) : []) : groups).map(g => ({ hasSwitch: false, stacked: false, stackPad: 0, subtitle: '', switchLabel: '', editSection: undefined as import('../features/profile/editor-model').ProfileSection | undefined, ...g })),
      foot: complete?.foot ?? (readOnly ? ctx.t("履历、工作偏好与可选信息尚未接入此视图。") : ctx.t("确认后保存到你的求职资料。工作许可与自我认同信息不会因此对所有网站自动填写。")) };
  }
