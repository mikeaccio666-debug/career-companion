import { createPresentationData } from '../presentation-data';
const { mentors, phases, fieldMeta, dimensionCatalog, usageLabels, runRows } = createPresentationData('zh-CN');
import type { AssistantData, Profile, Mentor, ResumeOption, ProfilePhase, ProfileField, FieldMeta, Job, AtsReport, Entitlement, RunRow, Extraction, ExtractHit, TextSegment } from '../state/types';
import charlie from '../assets/mentors/charlie.webp';
import alice from '../assets/mentors/alice.webp';
import darren from '../assets/mentors/darren.webp';
import xena from '../assets/mentors/xena.webp';

/** Fictional Fable reference data. Only the preview entry may import this module. */
type JobRow = [string, string, string, string, string, string, string | null, string | null, string, string[], string];
// ---------- 用户 / 资料 ----------
const profile: Profile = {
  name: 'Mia Chen', nick: 'Mia', email: 'mia@example.test', phone: '+1 202 555 0148',
  city: 'San Francisco, CA', links: 'portfolio.example.test',
  role: 'Product Designer', locations: 'San Francisco · Remote (US)', workMode: 'Remote / Hybrid',
  salary: '$140k – $170k · USD / 年', start: '4 周内', notice: '2 周',
  workAuth: '', sponsorship: '',
  gender: '', race: '', disability: '', veteran: '',
  education: 'BFA · Interaction Design · Example School of Design · 2022',
  experience: ['Product Designer · Openfield Studio · 2022 — 至今', 'Design Intern · Meadow Labs · 2021'],
  skills: ['Figma', 'Prototyping', 'UX Research', 'Design Systems', 'Accessibility', 'Motion'],
  projects: '面向创作者的协作工作台（示例）', languages: '中文 · English', summary: '关注复杂流程的清晰表达与设计系统落地。'
};



const resumeVersions: ResumeOption[] = [
  { id: 'pd-v3', track: 'Product design', version: 'v3', label: 'Product design · v3', kind: 'existing', current: true, note: '当前版本 · 2026-08' },
  { id: 'ux-v2', track: 'UX research', version: 'v2', label: 'UX research · v2', kind: 'existing', current: false, note: '历史方向 · 2026-03' },
  { id: 'gen', track: 'Product design', version: '岗位版', label: '为每个岗位生成新版', kind: 'generated', current: false, note: '基于 v3 · 待生成' }
];

// ---------- 资料抽取规则（原型演示；正式由后端结构化候选驱动） ----------




// 每条规则：正则 + 字段 + 取值函数。命中的文本片段成为"要点"，其余变淡。
const rules: { field: ProfileField | 'decline'; re: RegExp; pick?: number; multi?: boolean }[] = [
  { field: 'email', re: /[\w.+-]+@[\w-]+\.[\w.]+/ },
  { field: 'phone', re: /\+?\d[\d\s-]{7,}\d/ },
  { field: 'nick', re: /(?:叫我|称呼我|call me|I'm|I am)\s*([A-Za-z\u4e00-\u9fa5]{1,12})/i, pick: 1 },
  { field: 'city', re: /(旧金山|San Francisco|纽约|New York|西雅图|Seattle|洛杉矶|Los Angeles|北京|上海|深圳|波士顿|Boston|奥斯汀|Austin|伦敦|London)/i },
  { field: 'role', multi: true, re: /(产品设计[师岗位]*|Product Designer|UX (?:Designer|Researcher)|交互设计[师]*|设计系统[设计师]*|Design Systems? Designer|用户研究[员]*|UX Researcher|增长设计[师]*|Growth Designer)/gi },
  { field: 'workMode', re: /(远程或混合|远程\s*\/\s*混合|远程|混合办公|混合|现场办公|Remote|Hybrid|On-site)/i },
  { field: 'salary', re: /(\$?\d{2,3}\s*[kK万]?\s*(?:到|-|–|至)\s*\$?\d{2,3}\s*[kK万]?\s*(?:美元|USD|美金)?)/ },
  { field: 'start', re: /((?:[一二两三四五六七八九十\d]+)\s*(?:周|个月|天)内(?:可以开始)?|立即|随时)/ },
  { field: 'workAuth', re: /(有美国工作许可|有工作许可|没有工作许可|无工作许可|需要工作许可)/ },
  { field: 'sponsorship', re: /((?:不需要|需要)签证支持)/ },
  { field: 'decline', re: /(不愿回答|跳过|不想回答|暂不提供)/ }
];

export function extract(text: string, phaseId: 0 | 1 | 2): Extraction {
  const allowed = new Set<ProfileField | 'decline'>([...phases[phaseId].fields, ...(phaseId === 2 ? ['decline' as const] : [])]);
  const hits: ExtractHit[] = [];
  rules.forEach(rule => {
    const r = phaseId === 1 && rule.field === 'city' ? { ...rule, field: 'locations' as const } : rule;
    if (!allowed.has(r.field)) return;
    if (r.multi) { r.re.lastIndex = 0; let m; while ((m = r.re.exec(text))) { hits.push({ field: r.field, value: m[0].trim(), start: m.index, end: m.index + m[0].length }); } return; }
    const m = r.re.exec(text);
    if (!m) return;
    const val = r.pick ? m[r.pick] : m[0];
    const start = r.pick ? m.index + m[0].indexOf(val) : m.index;
    hits.push({ field: r.field, value: val.trim(), start, end: start + val.length });
  });
  hits.sort((a, b) => a.start - b.start);
  // 去重叠
  const clean: ExtractHit[] = []; let cursor = 0;
  hits.forEach(h => { if (h.start >= cursor) { clean.push(h); cursor = h.end; } });
  const segments: TextSegment[] = []; cursor = 0;
  clean.forEach((h, i) => {
    if (h.start > cursor) segments.push({ text: text.slice(cursor, h.start), key: false, id: 's' + i });
    segments.push({ text: text.slice(h.start, h.end), key: true, field: h.field, id: 'k' + i });
    cursor = h.end;
  });
  if (cursor < text.length) segments.push({ text: text.slice(cursor), key: false, id: 'tail' });
  return { segments, hits: clean };
}

// ---------- 岗位 ----------
const jobs: Job[] = ([
  ['northstar', 'Northstar', 'Product Designer', 'San Francisco, CA', 'Hybrid', 'Full-time', '$140k – $175k', 'USD / 年', '为中小团队的协作工具设计核心流程，负责设计系统演进与复杂表单体验。', ['设计系统与复杂流程经验直接对应', '有跨职能协作与交付记录'], '岗位强调 B2B 场景，作品集里 B2B 案例较少'],
  ['forma', 'Forma', 'UX / Product Designer', 'Remote', 'Remote · US', 'Full-time', '$125k – $160k', 'USD / 年', '推动研究驱动的产品迭代，负责端到端原型与可用性验证。', ['研究与原型经验直接匹配', '无障碍设计经验是加分项'], 'JD 要求展示无障碍设计的完整案例'],
  ['morrow', 'Morrow', 'Senior Product Designer', 'New York, NY', 'Hybrid', 'Full-time', '$150k – $185k', 'USD / 年', '带领两条产品线的设计方向，与 PM、工程共同定义路线图。', ['端到端设计与协作能力', '设计系统落地经验'], '要求带领过大型项目，资历偏 Senior'],
  ['aperture', 'Aperture', 'Design Systems Designer', 'Remote', 'Remote · US', 'Full-time', '$135k – $170k', 'USD / 年', '维护跨平台组件库与交互规范，服务 6 个产品团队。', ['组件系统与交互规范经验', '与工程协作的 token 化实践'], '希望有多平台（iOS / Web）组件经验'],
  ['pebble', 'Pebble', 'Product Designer, Growth', 'San Francisco, CA', 'On-site', 'Full-time', null, null, '负责增长实验与新用户旅程设计，量化实验结果。', ['用户旅程与实验设计经验', '快速原型能力'], '岗位偏好可量化的增长结果'],
  ['commonground', 'Common Ground', 'UX Designer', 'Boston, MA', 'Hybrid', 'Full-time', '$120k – $155k', 'USD / 年', '为教育平台设计学习与评估流程，重视可用性研究。', ['用户研究与可用性测试经验', '教育场景兴趣匹配'], '建议增加复杂业务场景案例'],
  ['orbit', 'Orbit Works', 'Product Designer II', 'Austin, TX', 'Hybrid', 'Full-time', '$125k – $155k', 'USD / 年', '在数据密集型工作台中设计信息层级与交互模式。', ['跨团队协作与交付经验', '数据密集界面经验'], '需确认是否接受 Austin 混合办公'],
  ['stillwater', 'Stillwater', 'Interaction Designer', 'Remote', 'Remote · US', 'Contract', '$70 – $85', 'USD / 小时', '为消费级应用设计动效与高保真交互原型。', ['动效与高保真原型能力', '细节把控'], '偏向移动端作品，合同制'],
  ['daybreak', 'Daybreak', 'Product Designer', 'Seattle, WA', 'Hybrid', 'Full-time', '$135k – $168k', 'USD / 年', '设计分析与报表产品，与数据科学团队紧密协作。', ['设计系统与研究方法', '结构化信息表达'], '岗位偏好数据可视化经验'],
  ['pollen', 'Pollen', 'Founding Designer', 'Remote', 'Remote · US', 'Full-time', '$145k – $180k', 'USD / 年 · 含期权', '作为首位设计师定义产品体验与品牌基础。', ['从零到一与多领域协作', '品牌与产品兼顾'], '早期团队职责更广，需要自我驱动'],
  ['harbor', 'Harbor', 'Product Designer', 'Remote', 'Remote · US', 'Full-time', '$130k – $160k', 'USD / 年', '为物流团队设计调度与追踪体验。', ['复杂流程可视化', '设计系统经验'], '需要物流或运营领域知识'],
  ['lumen', 'Lumen Health', 'UX Designer', 'Los Angeles, CA', 'Hybrid', 'Full-time', null, null, '设计患者预约与随访流程，注重可及性。', ['无障碍与研究经验', '表单体验'], '医疗合规经验为加分项'],
  ['fieldnote', 'Fieldnote', 'Senior UX Designer', 'Remote', 'Remote · US', 'Full-time', '$150k – $180k', 'USD / 年', '负责田野数据采集应用的离线体验。', ['移动与复杂状态经验', '研究驱动'], '要求 6 年以上经验'],
  ['quill', 'Quill', 'Product Designer', 'New York, NY', 'On-site', 'Full-time', '$135k – $165k', 'USD / 年', '写作与出版工具的编辑器体验设计。', ['编辑器与交互细节', '动效经验'], '现场办公，需搬迁'],
  ['tidewater', 'Tidewater', 'Design Systems Lead', 'Remote', 'Remote · US', 'Full-time', '$160k – $190k', 'USD / 年', '主导设计系统治理与工具链。', ['设计系统深度经验', 'token 化实践'], '要求带团队经验'],
  ['meadow', 'Meadow Labs', 'Product Designer', 'San Francisco, CA', 'Hybrid', 'Full-time', '$130k – $160k', 'USD / 年', '协作与知识管理产品的核心流程设计。', ['曾在此实习，了解产品', '协作工具经验'], '需要说明与实习期的成长'],
  ['vantage', 'Vantage', 'UX Researcher / Designer', 'Remote', 'Remote · US', 'Full-time', '$120k – $150k', 'USD / 年', '研究与设计混合角色，负责洞察到方案的闭环。', ['研究方法', '原型能力'], '研究比重更高'],
  ['cairn', 'Cairn', 'Product Designer', 'Denver, CO', 'Hybrid', 'Full-time', '$125k – $150k', 'USD / 年', '户外装备电商的购买旅程设计。', ['用户旅程', '设计系统'], '电商经验较少'],
  ['sable', 'Sable', 'Interaction Designer', 'Remote', 'Remote · US', 'Full-time', '$128k – $163k', 'USD / 年', '金融工具的交互与动效设计。', ['动效', '复杂表单'], '金融合规经验'],
  ['brightline', 'Brightline', 'Product Designer', 'Chicago, IL', 'Hybrid', 'Full-time', '$130k – $158k', 'USD / 年', '客服平台的工作台体验设计。', ['数据密集界面', '流程设计'], '需要客服领域理解']
] as JobRow[]).map((r, i) => ({
  id: r[0], company: r[1], title: r[2], location: r[3], mode: r[4], type: r[5], salary: r[6], salaryUnit: r[7], summary: r[8], matches: r[9], gap: r[10],
  coverLetterRequirement: (['REQUIRED', 'UNKNOWN', 'NOT_REQUIRED'] as const)[i % 3],
  responsibilities: ['与产品和工程共同定义关键流程并交付高保真设计', '维护并推进设计系统与交互规范', '通过研究与验证迭代方案'], requirements: ['3 年以上产品设计经验', '能清晰表达设计决策与取舍', r[10]],
  source: 'Greenhouse', posted: (i % 5) + 1 + ' 天前', boardUrl: 'boards.greenhouse.example/' + r[0] + '/jobs/' + (48210 + i * 7), jdDigest: 'jd-' + r[0] + '-r' + (3 + (i % 4))
}));

// ---------- 多维 ATS 评分（示例结构；维度名称以 AtsScoringService 规范为准） ----------


function mkScore(total: number, dims: AtsReport['dims'], problems: string[], suggestions: string[], missing: string[]): AtsReport {
  return { total, max: 100, dims, problems, suggestions, missing, rubricVersion: 'ats-rubric-示例', measuredAt: '刚刚' };
}
export const scores: Record<string, AtsReport> = {
  northstar: mkScore(82, { A: [24, ['缺少 “B2B” “enterprise” 表述']], B: [21, []], C: [16, []], D: [9, []], E: [8, []], F: [4, []] },
    ['JD 中 “multi-tenant” 与 “permissions” 未在简历出现'], ['在 Openfield 经历里补一句面向团队/管理员的流程设计', '把设计系统成果加上数字，例如组件复用率'], ['B2B', 'permissions', 'multi-tenant']),
  forma: mkScore(88, { A: [26, []], B: [23, []], C: [17, []], D: [9, []], E: [9, []], F: [4, []] },
    ['无障碍案例仅出现在技能列表，缺少具体项目'], ['为一个项目补充 WCAG 相关的验证方法'], ['WCAG', 'screen reader']),
  morrow: mkScore(69, { A: [19, ['缺少 “roadmap” “mentoring”']], B: [18, []], C: [12, ['Senior 级别职责表述不足']], D: [9, []], E: [8, []], F: [3, []] },
    ['资历表述与 Senior 要求有差距'], ['突出带领项目和影响他人的经历'], ['roadmap', 'mentoring', 'stakeholder']),
  aperture: mkScore(85, { A: [25, []], B: [22, []], C: [17, []], D: [9, []], E: null, F: [4, []] },
    ['E 维度暂不可用：服务未返回该项'], ['补充 iOS / Web 双平台组件经验'], ['iOS', 'tokens pipeline']),
  pebble: mkScore(74, { A: [21, []], B: [19, []], C: [14, ['增长实验经历较少']], D: [9, []], E: [8, []], F: [3, ['缺少量化结果']] },
    ['缺少 A/B 测试与量化结果'], ['为实验设计补充指标变化'], ['A/B testing', 'conversion']),
  commonground: mkScore(80, { A: [23, []], B: [21, []], C: [15, []], D: [9, []], E: [9, []], F: [3, []] }, [], ['补充复杂业务流程案例'], ['LMS']),
  orbit: mkScore(83, { A: [24, []], B: [22, []], C: [16, []], D: [9, []], E: [8, []], F: [4, []] }, [], ['说明数据密集界面的信息层级方法'], ['dashboard']),
  stillwater: mkScore(86, { A: [25, []], B: [22, []], C: [17, []], D: [9, []], E: [9, []], F: [4, []] }, [], ['补充移动端动效案例'], ['iOS motion']),
  daybreak: mkScore(78, { A: [22, []], B: [20, []], C: [15, []], D: [9, []], E: [9, []], F: [3, []] }, ['缺少数据可视化关键词'], ['补充图表/报表设计经验'], ['data visualization', 'charts']),
  pollen: mkScore(71, { A: [20, []], B: [18, []], C: [13, []], D: [9, []], E: [8, []], F: [3, []] }, ['0→1 经历表述不足'], ['强调独立推进项目的经历'], ['0 to 1', 'brand'])
};
jobs.forEach((j, i) => { if (!scores[j.id]) scores[j.id] = mkScore(60 + ((i * 7) % 30), { A: [18 + (i % 8), []], B: [16 + (i % 6), []], C: [12 + (i % 5), []], D: [8, []], E: [8, []], F: [3, []] }, ['示例问题：部分关键词缺失'], ['示例建议：补充相关项目'], ['示例关键词']); });

// ---------- 权益与额度场景（数字均为示例，非套餐承诺） ----------
// access: granted | locked | sync | unavailable ；remaining: number | null(不限量) | undefined(未知)
export const entitlementScenarios: { ats: Record<string, Entitlement>; jobs: Record<string, Entitlement>; letters: Entitlement; chat: Entitlement; voice: Entitlement } = {
  ats: {
    'granted': { access: 'granted', unit: '份评估报告', period: '本月', limit: 20, used: 12, remaining: 8, resetsAt: '10 月 1 日' },
    'unlimited': { access: 'granted', unit: '份评估报告', period: null, limit: null, used: 12, remaining: null },
    'low': { access: 'granted', unit: '份评估报告', period: '本月', limit: 20, used: 18, remaining: 2, resetsAt: '10 月 1 日' },
    'zero': { access: 'granted', unit: '份评估报告', period: '本月', limit: 20, used: 20, remaining: 0, resetsAt: '10 月 1 日' },
    'locked': { access: 'locked' },
    'sync': { access: 'sync' },
    'down': { access: 'granted', unit: '份评估报告', period: '本月', limit: 20, used: 12, remaining: 8, serviceDown: true }
  },
  jobs: {
    'plenty': { access: 'granted', unit: '个新岗位', period: '本周', limit: 40, used: 10, remaining: 30, resetsAt: '周一' },
    'short': { access: 'granted', unit: '个新岗位', period: '本周', limit: 40, used: 36, remaining: 4, resetsAt: '周一' },
    'zero': { access: 'granted', unit: '个新岗位', period: '本周', limit: 40, used: 40, remaining: 0, resetsAt: '周一' },
    'unlimited': { access: 'granted', unit: '个新岗位', limit: null, remaining: null },
    'nomore': { access: 'granted', unit: '个新岗位', period: '本周', limit: 40, used: 10, remaining: 30, sourceExhausted: true }
  },
  letters: { access: 'granted', unit: '封求职信', period: '本月', limit: 15, used: 4, remaining: 11, resetsAt: '10 月 1 日' },
  chat: { access: 'granted', unit: '轮对话', period: '今天', limit: 60, used: 9, remaining: 51, resetsAt: '明天 0:00' },
  voice: { access: 'granted', unit: '分钟语音', period: '今天', limit: 20, used: 3, remaining: 17, resetsAt: '明天 0:00' }
};



// ---------- Autofill 运行示例 ----------


export const previewData: AssistantData = { profile, mentors, resumeVersions, phases, fieldMeta, jobs, dimensionCatalog, usageLabels, runRows, sampleReports: scores };
