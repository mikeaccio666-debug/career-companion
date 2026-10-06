import type { AssistantData, Profile, Mentor, ResumeOption, ProfilePhase, ProfileField, FieldMeta, Job, AtsReport, Entitlement, RunRow, Extraction, ExtractHit, TextSegment } from './state/types';
import charlie from './assets/mentors/charlie.webp';
import alice from './assets/mentors/alice.webp';
import darren from './assets/mentors/darren.webp';
import xena from './assets/mentors/xena.webp';

import { createTranslator, type AssistantLocale } from './i18n';

/** Application-owned labels and demo instructions, separate from user/backend content. */
export function createPresentationData(locale: AssistantLocale) {
const t = createTranslator(locale);
const mentors: Mentor[] = [
  { id: 'charlie', src: charlie, name: 'Charlie' },
  { id: 'alice', src: alice, name: 'Alice' },
  { id: 'darren', src: darren, name: 'Darren' },
  { id: 'xena', src: xena, name: 'Xena' }
];
const phases: ProfilePhase[] = [
  { id: 0, title: t("基本资料与履历"), short: t("基本资料"), intro: t("我已经从 Portal 同步了你的简历：产品设计与研究经历、教育背景和 6 项技能都在了，不用再重复讲。\n再告诉我你希望的称呼、现在所在的城市，以及方便联系的方式，基本资料就齐了。"),
    introNoResume: t("简历里的经历我已经整理成候选。现在只差几项基本信息：你希望的称呼、所在城市，以及方便联系的方式。"),
    hint: t("例如：叫我 Mia 就好，我在旧金山，邮箱 mia@example.test"), fields: ['nick', 'city', 'email', 'phone', 'links'],
    demoVoice: t("叫我 Mia 就好，我现在住在旧金山，邮箱是 mia@example.test，电话 +1 202 555 0148。") },
  { id: 1, title: t("工作与偏好"), short: t("工作与偏好"), intro: t("很高兴更了解你了。\n接下来聊聊你想做的工作、理想的地点与工作方式、期望薪酬，以及什么时候可以开始。\n工作许可和是否需要签证支持，请按申请地区由你亲自确认——我不会替你推断。"),
    hint: t("例如：想找产品设计岗位，远程或混合，四周内可以开始"), fields: ['role', 'locations', 'workMode', 'salary', 'start', 'workAuth', 'sponsorship'],
    demoVoice: t("我想找产品设计岗位，也可以看设计系统设计师，希望远程或混合办公，期望 14 万到 17 万美元，四周内可以开始，有美国工作许可，不需要签证支持。") },
  { id: 2, title: t("可选的自我认同信息"), short: t("可选隐私"), intro: t("最后一组完全由你决定。\n一些申请表会问性别、种族、残障或退伍军人身份，用于雇主的合规统计。你可以提供、跳过，或选择「不愿回答」。\n我不会从简历推断这些信息；只保存你确认的选择，之后可以随时查看、修改或删除。"),
    hint: t("你可以直接说「跳过」或「不愿回答」"), fields: ['gender', 'race', 'disability', 'veteran'],
    demoVoice: t("这部分我选择不愿回答。") }
];
const fieldMeta: Partial<Record<ProfileField, FieldMeta>> = {
  nick: { label: t("称呼"), group: t("基本资料") }, city: { label: t("所在城市"), group: t("基本资料") }, email: { label: t("邮箱"), group: t("基本资料") },
  phone: { label: t("电话"), group: t("基本资料") }, links: { label: t("链接"), group: t("基本资料") },
  role: { label: t("目标职位"), group: t("工作与偏好") }, locations: { label: t("理想地点"), group: t("工作与偏好") }, workMode: { label: t("工作方式"), group: t("工作与偏好") },
  salary: { label: t("期望薪酬"), group: t("工作与偏好") }, start: { label: t("可开始时间"), group: t("工作与偏好") },
  workAuth: { label: t("工作许可（美国）"), group: t("工作与偏好"), self: true }, sponsorship: { label: t("需要签证支持"), group: t("工作与偏好"), self: true },
  gender: { label: t("性别"), group: t("可选隐私"), optional: true }, race: { label: t("种族 / 族裔"), group: t("可选隐私"), optional: true },
  disability: { label: t("残障状况"), group: t("可选隐私"), optional: true }, veteran: { label: t("退伍军人身份"), group: t("可选隐私"), optional: true }
};
const dimensionCatalog = {
  A: { label: t("关键词匹配"), max: 30, desc: t("JD 关键术语在简历中的覆盖与上下文一致性") },
  B: { label: t("技能覆盖"), max: 25, desc: t("岗位要求技能与简历技能的对应") },
  C: { label: t("经历相关度"), max: 20, desc: t("工作经历与岗位职责的相关程度") },
  D: { label: t("教育与资质"), max: 10, desc: t("学历、证书与岗位门槛") },
  E: { label: t("格式与可解析性"), max: 10, desc: t("ATS 是否能稳定读取简历结构") },
  F: { label: t("成就量化（示例长标签：可量化成果与影响力表达）"), max: 5, desc: t("是否用数字表达成果") }
};
const usageLabels = { ats: t("多维 ATS 评估"), jobs: t("岗位推荐"), letters: t("求职信生成"), chat: t("ArgoLand.AI 对话"), voice: t("语音输入"), materials: t("申请材料准备") };
const runRows: RunRow[] = [
  { key: 'name', label: t("姓名"), source: t("基本资料"), outcome: 'filled' },
  { key: 'email', label: t("邮箱"), source: t("基本资料"), outcome: 'filled' },
  { key: 'phone', label: t("电话"), source: t("基本资料"), outcome: 'filled' },
  { key: 'city', label: t("所在地"), source: t("基本资料"), outcome: 'filled' },
  { key: 'links', label: t("LinkedIn / 作品集"), source: t("链接"), outcome: 'kept', note: t("页面已有你填过的内容，已保留") },
  { key: 'resume', label: t("简历附件"), source: t("简历版本"), outcome: 'filled' },
  { key: 'workAuth', label: t("工作授权问题"), source: t("需本人确认"), outcome: 'manual' },
  { key: 'sign', label: t("信息确认与签名"), source: t("网站要求本人"), outcome: 'manual' }
];
return { mentors, phases, fieldMeta, dimensionCatalog, usageLabels, runRows };
}

/** Only application-owned catalog fields are localized. Profiles, jobs, resume names and input stay verbatim. */
export function localizePresentationData(data: AssistantData, locale: AssistantLocale): AssistantData {
  const source = createPresentationData('zh-CN'), target = createPresentationData(locale);
  return { ...data,
    phases: data.phases.map(phase => {
      const from = source.phases[phase.id], to = target.phases[phase.id];
      const result = { ...phase };
      for (const key of ['title', 'short', 'intro', 'introNoResume', 'hint', 'demoVoice'] as const) {
        if (phase[key] === from[key]) result[key] = to[key] ?? '';
      }
      return result;
    }),
    fieldMeta: Object.fromEntries(Object.entries(data.fieldMeta).map(([key, field]) => {
      const from = source.fieldMeta[key as ProfileField], to = target.fieldMeta[key as ProfileField];
      return [key, { ...field, label: field?.label === from?.label ? to?.label : field?.label,
        group: field?.group === from?.group ? to?.group : field?.group }];
    })),
    dimensionCatalog: Object.fromEntries(Object.entries(data.dimensionCatalog).map(([key, value]) => {
      const from = source.dimensionCatalog[key as keyof typeof source.dimensionCatalog], to = target.dimensionCatalog[key as keyof typeof target.dimensionCatalog];
      return [key, { ...value, label: value.label === from?.label ? to.label : value.label,
        desc: value.desc === from?.desc ? to.desc : value.desc }];
    })),
    usageLabels: Object.fromEntries(Object.entries(data.usageLabels).map(([key, value]) =>
      [key, value === source.usageLabels[key as keyof typeof source.usageLabels] ? target.usageLabels[key as keyof typeof target.usageLabels] : value])) as AssistantData['usageLabels'],
  };
}
