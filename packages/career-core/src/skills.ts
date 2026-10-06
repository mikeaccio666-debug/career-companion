import type { CareerSkillDefinition, CareerSkillId } from './contracts.ts';

const definitions: CareerSkillDefinition[] = [
  { id: 'career-intake', revision: 1, name: '了解经历与限制', goal: '形成用户能纠正的档案，确定一个值得探索的问题。', requiredInputs: [], tools: ['read_profile', 'save_plan_draft'], outputs: ['profile_draft', 'open_questions', 'next_small_action'], reviewCriteria: ['事实与推断分开', '允许不知道', '时间与偏好由用户确认'], stopWhen: '一份可纠正的档案和一个下一步准备好后等待审阅。' },
  { id: 'role-exploration', revision: 1, name: '探索职业方向', goal: '用真实岗位和工作任务比较少量方向。', requiredInputs: ['profile', 'current-jobs', 'knowledge'], tools: ['read_profile', 'search_jobs', 'search_knowledge', 'save_plan_draft'], outputs: ['role_comparison', 'market_citations', 'unknowns', 'exploration_action'], reviewCriteria: ['岗位来源和观察时间明确', '招聘样本与全国统计分开', '未知sponsorship保持未知', '不给不可验证的面试概率'], stopWhen: '两到三个方向有证据和验证行动，缺少资料则提出缺口。' },
  { id: 'evidence-story', revision: 1, name: '把课程项目讲清楚', goal: '从真实项目恢复判断过程并形成可解释的求职案例。', requiredInputs: ['profile', 'project-facts'], tools: ['read_profile', 'read_evidence', 'save_practice_draft'], outputs: ['fact_inventory', 'story_draft', 'follow_up_questions', 'evidence_gaps'], reviewCriteria: ['课程项目标签保留', '本人贡献与团队贡献分开', '不把评价改写为奖项或编造指标', '用户能回答关键追问'], stopWhen: '有可审阅故事和待核实问题；不自动写为已验证能力。' },
  { id: 'project-sprint', revision: 1, name: '完成能展示的小项目', goal: '围绕一个岗位任务安排现实可完成的交付与反馈。', requiredInputs: ['profile', 'target-role', 'skill-gaps'], tools: ['read_profile', 'read_evidence', 'search_knowledge', 'save_plan_draft'], outputs: ['sprint_draft', 'deliverables', 'review_rubric', 'time_budget'], reviewCriteria: ['交付物对应岗位任务', '范围符合可用时间', '完成需有成果和评阅', '模拟任务不伪装为雇佣经历'], stopWhen: '下一次交付、评阅方式和时间预算已明确。' },
  { id: 'networking-practice', revision: 1, name: '练习一次职业交流', goal: '演练开场、追问和结束，让用户敢完成一次小交流。', requiredInputs: ['target-role', 'conversation-goal'], tools: ['read_evidence', 'search_knowledge', 'save_practice_draft'], outputs: ['practice_scenario', 'message_draft', 'practice_feedback', 'next_attempt'], reviewCriteria: ['先明确交流目的', '逐步减少提示', '草稿不算已发送', '反馈说明具体下一次改进'], stopWhen: '一次演练与反馈完成；真实发送另走授权执行。' },
  { id: 'application-preparation', revision: 1, name: '准备一次合适的投递', goal: '把用户已确认的资料映射到具体岗位并准备材料。', requiredInputs: ['target-job', 'confirmed-profile', 'reviewed-resume'], tools: ['read_profile', 'read_evidence', 'prepare_application_draft'], outputs: ['application_draft', 'fit_evidence', 'missing_fields', 'user_review'], reviewCriteria: ['岗位仍有可核实来源', '契合与差距均有证据', '敏感字段由用户处理', '准备不算已提交'], stopWhen: '固定岗位和材料等待用户审阅；不登录、不发送、不最终提交。' },
  { id: 'interview-practice', revision: 1, name: '练习面试并复盘', goal: '用目标岗位和真实经历演练可迁移的回答能力。', requiredInputs: ['target-role', 'project-facts'], tools: ['read_evidence', 'search_knowledge', 'save_practice_draft'], outputs: ['interview_scenario', 'rubric_feedback', 'practice_evidence', 'next_attempt'], reviewCriteria: ['回答的事实可追溯', '追问检查理解', '不同尝试用可比较rubric', '模型评分只是练习反馈'], stopWhen: '一次练习和具体改进完成；面试邀请只能由真实证据确认。' },
];

export const CAREER_SKILLS: readonly CareerSkillDefinition[] = Object.freeze(definitions.map(definition => Object.freeze({ ...definition, requiredInputs: Object.freeze([...definition.requiredInputs]), tools: Object.freeze([...definition.tools]), outputs: Object.freeze([...definition.outputs]), reviewCriteria: Object.freeze([...definition.reviewCriteria]) })));
export function careerSkill(id: CareerSkillId): CareerSkillDefinition {
  const definition = CAREER_SKILLS.find(skill => skill.id === id);
  if (!definition) throw new Error('Unknown career skill.');
  return definition;
}
