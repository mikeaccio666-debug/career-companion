import type { AgentSpeakerKey } from '@companion/platform-contracts';
import type { CareerPhase, CareerSkillDefinition, CareerSkillId } from './contracts.ts';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
type Skill = Omit<CareerSkillDefinition, 'outputContract' | 'methodRefs' | 'invocation' | 'evals'>;
const text = { type: 'string', minLength: 1, maxLength: 2000 };
const strings = { type: 'array', items: text, maxItems: 50 };
const shape = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const artifact = shape({ id: text, revision: { type: 'integer', minimum: 1 }, status: { enum: ['draft', 'pending'] } });
const cited = shape({ text, sourceRefs: { type: 'array', items: text, minItems: 1, maxItems: 20 } });
const nextAction = shape({ action: text, evidence: text, expectedMinutes: { type: 'integer', minimum: 1, maximum: 120 } });
const outputSchemas: Record<string, unknown> = {
  profile_draft: shape({ summary: text, unconfirmedFields: strings }), open_questions: strings, next_small_action: nextAction,
  resume_draft: artifact, change_notes: { type: 'array', items: shape({ before: text, after: text, sourceRefs: strings }), maxItems: 50 },
  unverified_claims: { type: 'array', items: shape({ text, sourceRefs: strings }), maxItems: 50 },
  fact_inventory: { type: 'array', items: shape({ fact: text, sourceId: text, contribution: { enum: ['personal', 'team', 'unknown'] } }), maxItems: 50 },
  story_draft: artifact, follow_up_questions: strings, evidence_gaps: strings,
  application_packet: artifact, fit_evidence: { type: 'array', items: cited, maxItems: 50 }, missing_fields: strings, user_review: shape({ required: { const: true } }),
  email_draft: { type: 'array', items: artifact, maxItems: 20 }, outreach_message: { type: 'array', items: artifact, maxItems: 20 },
  interview_scenario: shape({ question: text, kind: { enum: ['behavioral', 'technical', 'system_design', 'hr'] } }),
  rubric_feedback: shape({ strength: text, nextChange: text, label: { const: 'practice_feedback' } }), practice_evidence: artifact, next_attempt: nextAction,
  battle_brief: shape({ targetJobId: text, preparationPoints: strings, unknowns: strings, label: { enum: ['通用', '有出处'] } }),
  coverage_citations: { type: 'array', items: shape({ sourceId: text, revision: { type: 'integer', minimum: 1 }, passageId: text }), maxItems: 8 },
  mentor_packet_draft: artifact,
  role_comparison: { type: 'array', minItems: 2, maxItems: 3, items: shape({ direction: text, evidence: strings, unknowns: strings, verificationAction: nextAction }) },
  market_citations: { type: 'array', items: cited, maxItems: 20 }, unknowns: strings, exploration_action: nextAction,
  drill_set: { type: 'array', items: shape({ question: text, enoughStandard: text }), minItems: 1, maxItems: 10 }, practice_feedback: shape({ strength: text, nextChange: text, label: { const: 'practice_feedback' } }),
  sprint_draft: artifact, deliverables: strings, review_rubric: strings, time_budget: shape({ availableHours: { type: 'number', minimum: 0, maximum: 336 }, nextReviewAt: text }),
  practice_scenario: shape({ objective: text, opening: text, followUp: text }), message_draft: artifact,
  job_candidates: { type: 'array', items: shape({ postingId: text, sourceUrl: text, observedAt: text, state: { enum: ['observed_open', 'unknown', 'closed'] } }), maxItems: 50 },
  sponsorship_quotes: { type: 'array', items: shape({ postingId: text, quote: { type: 'string', maxLength: 2000 }, status: { enum: ['explicit_yes', 'explicit_no', 'unknown'] } }), maxItems: 50 },
};
/** Built-in procedures contain no licensed organization material or inferred publication revisions. */
function manifest(skill: Skill): CareerSkillDefinition {
  return freeze({ ...skill, methodRefs: [], invocation: 'both', evals: [`career-skill:${skill.id}:v${skill.revision}`],
    outputContract: shape(Object.fromEntries(skill.outputs.map(output => { if (!outputSchemas[output]) throw new Error('Missing output schema.'); return [output, outputSchemas[output]]; }))) });
}
const definitions: CareerSkillDefinition[] = [
  manifest({ id: 'career-intake', revision: 1, owner: 'companion', phase: 'P0', name: '了解经历与限制', goal: '形成用户能纠正的档案，确定一个值得探索的问题。', whenToUse: '初次了解经历、用户不知道从哪里开始、需要收敛职业方向时用。', instructions: '先读实际档案；没有资料就明确缺口，一次只问最影响下一步的一项。把课程、项目、兴趣、可用时间写成可纠正的提议，事实与推断分开，允许不知道。P1-6 前可收敛到少量岗位家族，不预测录取概率。起草一个可验证的小行动，等待用户审阅，不把草稿写成已确认事实。', requiredInputs: [], tools: ['read_profile', 'save_plan_draft'], outputs: ['profile_draft', 'open_questions', 'next_small_action'], reviewCriteria: ['事实与推断分开', '允许不知道', '时间与偏好由用户确认'], stopWhen: '一份可纠正的档案和一个下一步准备好后等待审阅。', expectedSeconds: 20 }),
  manifest({ id: 'resume-revision', revision: 1, owner: 'guide', phase: 'P0', name: '修改简历', goal: '用已确认经历按目标岗位修改一版简历。', whenToUse: '用户上传简历、要求改简历、问为什么没回音时用。', instructions: '核对已确认档案、当前简历和目标岗位。先保留一句写得清楚的话，再改最影响第一屏的一条，给改前改后对照。注明事实来源，本人贡献与团队贡献分开；课程项目保留标签，原稿没有的事实列为待核实，不补数字、奖项或雇佣经历。只保存简历草稿与差异说明，交用户确认。', requiredInputs: ['confirmed-profile', 'resume-source', 'target-role'], tools: ['read_profile', 'read_evidence', 'read_resume_version', 'search_org_knowledge', 'save_resume_draft', 'draft_outbound'], outputs: ['resume_draft', 'change_notes', 'unverified_claims'], reviewCriteria: ['改前改后可核对', '新增事实单独标明', '数字来自已确认资料', '版本进待确认'], stopWhen: '一版草稿进待确认，待核实项列清。', expectedSeconds: 25 }),
  manifest({ id: 'evidence-story', revision: 1, owner: 'guide', phase: 'P0', name: '把课程项目讲清楚', goal: '从真实项目恢复判断过程并形成可解释的求职案例。', whenToUse: '用户准备项目故事、恢复课程经历、练习解释自己贡献时用。', instructions: '读档案与项目证据，恢复问题、约束、本人行动、取舍和结果。确定事实和待核实问题分开，不把教授点评改写为奖项，不把团队成果归给个人。列事实，再起草英文故事与中文要点，保留课程项目标签。保存故事草稿；用户能回答关键追问后仍须确认，草稿不代表独立验证的能力。', requiredInputs: ['profile', 'project-facts'], tools: ['read_profile', 'read_evidence', 'save_story_draft'], outputs: ['fact_inventory', 'story_draft', 'follow_up_questions', 'evidence_gaps'], reviewCriteria: ['课程项目标签保留', '本人贡献与团队贡献分开', '不把评价改写为奖项或编造指标', '用户能回答关键追问'], stopWhen: '有可审阅故事和待核实问题；不自动写为已验证能力。', expectedSeconds: 25 }),
  manifest({ id: 'application-preparation', revision: 2, owner: 'applier', phase: 'P0', name: '准备一次合适的投递', goal: '把用户已确认的资料映射到具体岗位并准备材料。', whenToUse: '用户为收藏岗位准备材料、cover letter、开放题或相关邮件时用。', instructions: '核对固定岗位、已确认档案和同 track 简历。先报清单，用 JD 原文对照契合与差距，引用来源和查看时间，未知 sponsorship 保持未知。准备 application_packet 和本次投递相关的邮件或外联草稿。身份类题只留需要用户回答的占位，不生成答案。材料进待确认，不登录、不发送、不代签、不最终提交；准备不算投递成果。', requiredInputs: ['target-job', 'confirmed-profile', 'reviewed-resume'], tools: ['read_profile', 'read_evidence', 'draft_outbound'], outputs: ['application_packet', 'fit_evidence', 'missing_fields', 'user_review', 'email_draft', 'outreach_message'], reviewCriteria: ['岗位仍有可核实来源', '契合与差距均有证据', '敏感字段由用户处理', '准备不算已提交'], stopWhen: '固定岗位和材料等待用户审阅；不登录、不发送、不最终提交。', expectedSeconds: 25 }),
  manifest({ id: 'interview-practice', revision: 1, owner: 'interviewer', phase: 'P0', name: '练习面试并复盘', goal: '用目标岗位和真实经历演练可迁移的回答能力。', whenToUse: '用户要求模拟面试、面后复盘、练 behavioral 或技术口述时用。', instructions: '核对目标岗位与真实项目。全英文一次一题，用户回答前不夸，回答后追问一层理解。点评切回用户的情绪语言，只说一处做得好、一处最该改，反馈只来自回答和已确认经历。保存题目、回答、rubric 和下一次改进为练习记录；模型评分只是练习反馈。真实面试或 OA 不代答，不評口音和外貌，不预测录取。', requiredInputs: ['target-role', 'project-facts'], tools: ['read_evidence', 'search_knowledge', 'save_practice_record'], outputs: ['interview_scenario', 'rubric_feedback', 'practice_evidence', 'next_attempt'], reviewCriteria: ['回答的事实可追溯', '追问检查理解', '不同尝试用可比较rubric', '模型评分只是练习反馈'], stopWhen: '一次练习和具体改进完成；面试邀请只能由真实证据确认。', expectedSeconds: 25 }),
  manifest({ id: 'interview-brief', revision: 1, owner: 'interviewer', phase: 'P1-4', name: '准备面试作战简报', goal: '按岗位、安排与有出处的面经准备简报。', whenToUse: '用户有面试安排，需要提前整理岗位重点和面经覆盖时用。', instructions: '读固定岗位和面试安排，检索授权组织库并使用覆盖统计工具。统计分母与来源必须来自实际返回；没有面经标通用，不用模型记忆补来源。列重点、可用故事、未知项和练习顺序，生成简报卡。不把练习写为真实面试经历，不承诺某题会被问到。', requiredInputs: ['target-job', 'knowledge'], tools: ['read_journey', 'search_org_knowledge', 'summarize_interview_coverage'], outputs: ['battle_brief', 'coverage_citations'], reviewCriteria: ['面试安排来自用户数据', '覆盖数字可复算', '没有面经标通用'], stopWhen: '简报卡生成；没有面经时标通用。', expectedSeconds: 60 }),
  manifest({ id: 'mentor-handoff', revision: 1, owner: 'guide', phase: 'P1-10', name: '准备真人导师交接包', goal: '为真人导师提供经用户审阅的材料和具体问题。', whenToUse: '用户要约真人导师、希望导师审阅岗位材料时用。', instructions: '核对固定岗位、已审阅简历与故事。只提取此次审阅所需材料，区分确认事实和待核实项。至少列一个具体问题，起草 mentor_packet，不展示导师私人联系方式、不以导师口吻说话。交接包进待确认，授权前不发送。', requiredInputs: ['target-job', 'reviewed-resume'], tools: ['read_journey', 'read_stories', 'read_resume_version', 'draft_outbound'], outputs: ['mentor_packet_draft'], reviewCriteria: ['至少一个具体问题', '材料最小化', '发送前确认'], stopWhen: '交接包进待确认，至少 1 个问题。', expectedSeconds: 25 }),
  manifest({ id: 'role-exploration', revision: 2, owner: 'planner', phase: 'P1-6', name: '探索职业方向', goal: '用真实岗位和工作任务比较少量方向。', whenToUse: '用户比较职业方向、安排周计划、复盘投递分散时用。', instructions: '只比较收藏与看板里的至少三个岗位，不用在线搜索补样本。按工作任务、已有证据、缺口和兴趣比较两到三个方向，带出处与观察时间。区分小样本和全国统计，未知 sponsorship 保持未知，不编薪资或面试概率。起草两周验证行动，方向由用户确认后才进旅程。', requiredInputs: ['profile', 'current-jobs', 'knowledge'], tools: ['read_profile', 'read_journey', 'search_knowledge', 'save_plan_draft'], outputs: ['role_comparison', 'market_citations', 'unknowns', 'exploration_action'], reviewCriteria: ['岗位来源和观察时间明确', '招聘样本与全国统计分开', '未知sponsorship保持未知', '不给不可验证的面试概率'], stopWhen: '两到三个方向有证据和验证行动，缺少资料则提出缺口。', expectedSeconds: 25 }),
  manifest({ id: 'skill-drill', revision: 1, owner: 'coach', phase: 'P1-7', name: '练习一个技能点', goal: '针对可核实的技能缺口安排非面试练习。', whenToUse: '用户想补 SQL、coding、统计或概念，需要一次具体练习时用。', instructions: '用至少三条最近练习证据核对 rubric 缺口，选择一个技能点和授权题库。明确够了的标准，一次一个点，提示逐步减少。保存练习与反馈，不把模型分数当独立验证；不为真实 OA 提供答案，用户停下就结束。', requiredInputs: ['target-role', 'skill-gaps'], tools: ['read_evidence', 'search_org_knowledge', 'save_practice_record'], outputs: ['drill_set', 'practice_feedback'], reviewCriteria: ['只练一个点', '够了标准可观察', '评分只是练习反馈'], stopWhen: '达到够了标准或用户停下。', expectedSeconds: 25 }),
  manifest({ id: 'project-sprint', revision: 1, owner: 'coach', phase: 'P1-7', name: '完成能展示的小项目', goal: '围绕一个岗位任务安排现实可完成的交付与反馈。', whenToUse: '用户需要真实项目经验、安排两周小项目冲刺时用。', instructions: '读档案、目标岗位和练习缺口，将项目缩到可用时间内一个真实工作任务。明确交付物、验收 rubric、下一次交付和评阅。起草冲刺计划，完成需有成果与反馈；模拟任务保留标签，不伪装雇佣经历。教练负责做项目，故事改写另交前辈。', requiredInputs: ['profile', 'target-role', 'skill-gaps'], tools: ['read_profile', 'read_evidence', 'search_knowledge', 'save_plan_draft'], outputs: ['sprint_draft', 'deliverables', 'review_rubric', 'time_budget'], reviewCriteria: ['交付物对应岗位任务', '范围符合可用时间', '完成需有成果和评阅', '模拟任务不伪装为雇佣经历'], stopWhen: '下一次交付、评阅方式和时间预算已明确。', expectedSeconds: 25 }),
  manifest({ id: 'networking-practice', revision: 2, owner: 'networker', phase: 'P2', name: '练习一次职业交流', goal: '演练开场、追问和结束，让用户敢完成一次小交流。', whenToUse: '用户练 coffee chat、准备给具体联系人写外联或感谢信时用。', instructions: '核对岗位、交流目的和真实联系人，不编关系。演练开场、追问、结束，逐步减少提示，反馈落到下一次可改的一项。英文外联默认不超过四句，每条单独进待确认，由用户本人发。保存练习记录，草稿不算发送；不抓取或自动操作 LinkedIn，不群发、不展示导师私人联系方式。', requiredInputs: ['target-role', 'conversation-goal', 'contact'], tools: ['read_evidence', 'search_knowledge', 'save_practice_record', 'draft_outbound'], outputs: ['practice_scenario', 'message_draft', 'practice_feedback', 'next_attempt', 'outreach_message'], reviewCriteria: ['先明确交流目的', '逐步减少提示', '草稿不算已发送', '反馈说明具体下一次改进'], stopWhen: '一次演练与反馈完成；真实发送另走授权执行。', expectedSeconds: 25 }),
  manifest({ id: 'job-triage', revision: 1, owner: 'applier', phase: 'P2', name: '整理岗位候选', goal: '按已确认方向和有来源的岗位记录准备收藏候选。', whenToUse: '用户希望按目标方向批量整理真实岗位候选时用。', instructions: '读档案、全部 active 方向和至少三个当前收藏岗位。只用岗位端口的真实记录，逐帖核对公司、来源、观察时间和状态。sponsorship 只引用 JD 原句，缺失保持未知。候选和看板更新只是提议，不海投、不自动提交、不编匹配概率。', requiredInputs: ['profile', 'target-direction', 'current-jobs'], tools: ['search_jobs', 'read_job_posting', 'propose_journey_update'], outputs: ['job_candidates', 'sponsorship_quotes'], reviewCriteria: ['岗位来源真实', '引用为原文子串', '候选只是提议'], stopWhen: '候选进收藏。', expectedSeconds: 60 }),
];

export const CAREER_SKILLS: readonly CareerSkillDefinition[] = freeze(definitions);
export function careerSkill(id: CareerSkillId): CareerSkillDefinition {
  const definition = CAREER_SKILLS.find(skill => skill.id === id);
  if (!definition) throw new Error('Unknown career skill.');
  return definition;
}
/** Explicitly reviewed skills only; phase numbers are independent feature gates. */
export function careerSkillIndex(input: { speaker: AgentSpeakerKey; enabledFeatures: readonly CareerPhase[]; reviewedSkills: readonly CareerSkillId[]; contextCharacters: number }): { text: string; omitted: CareerSkillId[] } {
  if (!Number.isSafeInteger(input.contextCharacters) || input.contextCharacters < 0) throw new Error('Invalid context budget.');
  const budget = Math.min(8000, Math.floor(input.contextCharacters * 0.02));
  const skills = CAREER_SKILLS.filter(skill => skill.owner === input.speaker && input.enabledFeatures.includes(skill.phase) && input.reviewedSkills.includes(skill.id));
  const order = (phase: CareerPhase) => ['P0', 'P1-1', 'P1-4', 'P1-6', 'P1-7', 'P1-8', 'P1-9', 'P1-10', 'P1b', 'P2'].indexOf(phase);
  const entries = skills.map(skill => ({ skill, line: `${skill.id}: ${skill.whenToUse}` }));
  if (entries.map(entry => entry.line).join('\n').length > budget) for (const entry of entries) entry.line = `${entry.skill.id}: ${Array.from(entry.skill.whenToUse).slice(0, 20).join('')}`;
  const omitted: CareerSkillId[] = [];
  for (const entry of [...entries].sort((a, b) => order(b.skill.phase) - order(a.skill.phase))) {
    if (entries.map(item => item.line).join('\n').length <= budget) break;
    entries.splice(entries.indexOf(entry), 1); omitted.push(entry.skill.id);
  }
  return { text: entries.map(entry => entry.line).join('\n'), omitted };
}
