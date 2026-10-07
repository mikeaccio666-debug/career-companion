import { EXPERT_KEYS, type AgentRoomKind, type AgentSpeakerKey, type ToolEffect } from '@companion/platform-contracts';
import { ROLE_FAMILIES, type CareerPhase, type CareerSkillId } from './contracts.ts';
import { CAREER_SKILLS } from './skills.ts';

export interface CareerCapabilityDefinition {
  readonly id: string;
  readonly kind: 'internal' | 'engine' | 'external';
  readonly definition: { readonly name: string; readonly description: string; readonly parameters: Readonly<Record<string, unknown>> };
  readonly examples: readonly Readonly<Record<string, unknown>>[];
  readonly effect: ToolEffect;
  readonly speakers: readonly AgentSpeakerKey[];
  readonly rooms: readonly AgentRoomKind[];
  readonly phase: CareerPhase;
  readonly enabledWhenAny?: readonly CareerPhase[];
  readonly speakerPhases?: Readonly<Partial<Record<AgentSpeakerKey, CareerPhase>>>;
  readonly progressPhrase: string;
  readonly phraseGroup: string;
  readonly timeoutMs: number;
  readonly maxResultChars: number;
  readonly alwaysVisible: boolean;
  readonly alwaysVisibleFor?: readonly AgentSpeakerKey[];
  readonly skillVisibility?: readonly CareerSkillId[];
  /** Deferred means a later server-owned interaction mode must supply its visibility rule. */
  readonly visibility: 'core' | 'skill' | 'deferred';
  readonly evalSet: string;
}
export interface CareerCapabilityProfile { speaker: AgentSpeakerKey; loadedSkillIds?: readonly CareerSkillId[]; }
export interface CareerCapabilityRoom { kind: AgentRoomKind; expert?: Exclude<AgentSpeakerKey, 'companion'>; background?: boolean; }
/** Each feature must be explicitly enabled; P1-10 does not imply P1-6 or P1-7. */
export interface CareerCapabilityPhase {
  enabledFeatures: readonly CareerPhase[];
  enabledSpeakers: readonly AgentSpeakerKey[];
  reviewedSkills: readonly CareerSkillId[];
}
const all: readonly AgentSpeakerKey[] = ['companion', ...EXPERT_KEYS];
const experts: readonly AgentSpeakerKey[] = EXPERT_KEYS;
const rooms: readonly AgentRoomKind[] = ['main', 'expert_room'];
const str = (maxLength = 240) => ({ type: 'string', minLength: 1, maxLength });
const strings = (maxItems = 10, maxLength = 240) => ({ type: 'array', items: str(maxLength), minItems: 1, maxItems });
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required });
const ref = object({ id: str(), revision: { type: 'integer', minimum: 1, maximum: 2147483647 } }, ['id', 'revision']);
const references = { type: 'array', items: ref, maxItems: 30 };
function frozen<T>(value: T): T { if (value && typeof value === 'object') { for (const item of Object.values(value)) frozen(item); Object.freeze(value); } return value; }
function cap(id: string, effect: ToolEffect, speakers: readonly AgentSpeakerKey[], description: string, parameters: Record<string, unknown>, example: Record<string, unknown>, options: Partial<Omit<CareerCapabilityDefinition, 'id' | 'effect' | 'speakers' | 'definition' | 'examples'>> = {}): CareerCapabilityDefinition {
  return frozen({ id, kind: 'internal', definition: { name: id, description, parameters }, examples: [example], effect, speakers, rooms, phase: 'P0',
    progressPhrase: effect === 'read' ? '{speaker} 在核对资料…' : '{speaker} 在整理草稿…', phraseGroup: effect === 'read' ? 'sources' : 'drafts', timeoutMs: 8000, maxResultChars: 16000, alwaysVisible: false,
    visibility: options.alwaysVisible || options.alwaysVisibleFor?.length ? 'core' : options.skillVisibility?.length || CAREER_SKILLS.some(skill => skill.tools.includes(id as never)) ? 'skill' : 'deferred', evalSet: `career-capability:${id}:v1`, ...options });
}
const readOptions = object({ id: str(), detail: { enum: ['summary', 'full'] } });
const search = object({ query: str(), limit: { type: 'integer', minimum: 1, maximum: 8 } }, ['query']);
const passage = object({ sourceId: str(), revision: { type: 'integer', minimum: 1 }, passageId: str() }, ['sourceId', 'revision', 'passageId']);
const draft = object({ content: str(16000), references }, ['content', 'references']);
const definitions: CareerCapabilityDefinition[] = [
  cap('read_profile', 'read', ['companion', 'planner', 'guide', 'coach', 'networker', 'applier'], '读取已拥有档案的普通字段，未确认内容不能当事实。', object({}), {}, { progressPhrase: '{speaker} 在翻你的档案…' }),
  cap('read_journey', 'read', ['companion', 'planner', 'interviewer', 'networker', 'applier'], '读取旅程与收藏岗位；不把收藏样本当市场统计。', readOptions, {}, { progressPhrase: '{speaker} 在翻你的旅程…', alwaysVisibleFor: ['companion', 'planner', 'applier', 'networker'] }),
  cap('read_evidence', 'read', ['guide', 'coach', 'interviewer', 'networker', 'applier'], '读取真实项目或练习证据；草稿和提议不是已确认事实。', readOptions, {}, { alwaysVisibleFor: ['coach', 'interviewer'] }),
  cap('read_stories', 'read', ['guide', 'coach', 'interviewer', 'networker', 'applier'], '读取用户已确认的项目故事。', readOptions, {}),
  cap('read_resume_version', 'read', ['guide', 'interviewer', 'applier'], '读取指定或当前简历版本；归档或变更版本须重新选择。', readOptions, {}, { progressPhrase: '{speaker} 在对照你的简历版本…', alwaysVisibleFor: ['guide'] }),
  cap('search_knowledge', 'read', all, '检索私人资料库，只引用本次实际返回的段落。', search, { query: 'fictional career fair notes', limit: 3 }, { progressPhrase: '{speaker} 在资料库里找…' }),
  cap('read_knowledge_passage', 'read', all, '读取有版本的私人资料库段落。', passage, { sourceId: 'fictional-source', revision: 1, passageId: '1:0' }, { skillVisibility: CAREER_SKILLS.filter(skill => skill.tools.includes('search_knowledge')).map(skill => skill.id) }),
  cap('search_org_knowledge', 'read', all, '检索已发布、已授权组织知识；主理人只检索课程目录。', search, { query: 'behavioral rubric', limit: 3 }, { speakerPhases: { companion: 'P1b' }, progressPhrase: '{speaker} 在查授权资料…' }),
  cap('read_org_knowledge_passage', 'read', all, '读取有版本且授权仍有效的组织知识段落；主理人只读课程目录。', passage, { sourceId: 'fictional-org-source', revision: 1, passageId: '1:0' }, { speakerPhases: { companion: 'P1b' }, skillVisibility: CAREER_SKILLS.filter(skill => skill.tools.includes('search_org_knowledge')).map(skill => skill.id) }),
  cap('summarize_interview_coverage', 'read', ['interviewer'], '对本轮合法面经样本计算覆盖计数，保留分母与出处。', object({ targetJobId: str(), passageIds: strings(8) }, ['targetJobId', 'passageIds']), { targetJobId: 'fictional-job', passageIds: ['1:0'] }, { phase: 'P1-4' }),
  cap('find_mentors', 'read', ['companion', 'guide', 'networker'], '查找授权导师网络的公开摘要，不显示私人联系方式。', object({ roleFamily: { enum: [...ROLE_FAMILIES] }, timezone: str(80) }, ['roleFamily']), { roleFamily: 'da' }, { phase: 'P1-10' }),
  cap('search_jobs', 'read', ['planner', 'applier'], '检索真实岗位源；未知赞助与开放状态保持未知。', object({ query: str(), limit: { type: 'integer', minimum: 1, maximum: 20 } }, ['query']), { query: 'data analyst', limit: 5 }, { phase: 'P2' }),
  cap('read_job_posting', 'read', ['planner', 'applier'], '读取有来源的一个岗位，不抓取 LinkedIn 或 Indeed。', object({ postingId: str() }, ['postingId']), { postingId: 'fictional-posting' }, { phase: 'P2' }),
  cap('save_plan_draft', 'draft', ['companion', 'planner', 'coach'], '保存计划草稿，不确认档案、授予执行权限或发送任何材料。', object({ title: str(120), steps: strings(12, 1000), references }, ['title', 'steps', 'references']), { title: 'fictional small action', steps: ['Check one public report'], references: [] }),
  cap('save_story_draft', 'draft', ['guide'], '保存故事草稿，保留课程项目与个人贡献边界。', draft, { content: 'Fictional course-project story draft.', references: [] }),
  cap('save_resume_draft', 'draft', ['guide'], '保存简历草稿，新增断言必须单列待核实，不得伪造经历；确认前不成为 active 版本。', object({ sourceId: str(), sourceRevision: { type: 'integer', minimum: 1 }, content: str(16000), unverifiedClaims: { type: 'array', items: str(2000), maxItems: 30 }, references }, ['sourceId', 'sourceRevision', 'content', 'unverifiedClaims', 'references']), { sourceId: 'fictional-resume', sourceRevision: 1, content: 'Fictional bullet.', unverifiedClaims: [], references: [] }),
  cap('save_practice_record', 'draft', ['coach', 'interviewer', 'networker'], '保存一次题目、回答和 rubric 反馈；模型评分只算练习反馈。', object({ question: str(2000), answer: str(8000), feedback: str(4000), references }, ['question', 'answer', 'feedback', 'references']), { question: 'Describe a fictional course project.', answer: 'Fictional answer.', feedback: 'Clarify one decision.', references: [] }, { rooms: [...rooms, 'interview'] }),
  cap('draft_outbound', 'draft', ['companion', 'guide', 'interviewer', 'networker', 'applier'], '起草允许类型的待确认对象，绝不发送、登录、代签或最终提交。', object({ kind: { enum: ['application_packet', 'email_draft', 'outreach_message', 'mentor_packet', 'resume_version', 'parent_report', 'knowledge_contribution'] }, content: str(16000), targetId: str(), references }, ['kind', 'content', 'references']), { kind: 'application_packet', content: 'Fictional packet.', references: [] }),
  cap('propose_journey_update', 'draft', ['companion', 'planner', 'interviewer', 'applier'], '提议旅程变更，不直接确认记录。', object({ targetId: str(), proposal: str(4000), references }, ['targetId', 'proposal', 'references']), { targetId: 'fictional-target', proposal: 'Explore a data role.', references: [] }),
  cap('propose_memory', 'draft', all, '提议一条记忆，不自动确认或写入敏感身份结论。', object({ text: str(1000), sourceMessageId: str() }, ['text', 'sourceMessageId']), { text: 'Fictional preference for short practice.', sourceMessageId: 'fictional-message' }),
  cap('search_memories', 'read', all, '检索普通敏感度且已确认的记忆；专家不得读取 sensitive 或 restricted。', search, { query: 'project preferences', limit: 3 }, { alwaysVisible: true, progressPhrase: '{speaker} 在回看你之前说过的…' }),
  cap('use_skill', 'read', all, '加载自己的已评审技能；准备被阻塞时如实返回缺口，工具在下一步才可用。', object({ id: { enum: CAREER_SKILLS.map(skill => skill.id) } }, ['id']), { id: 'career-intake' }, { kind: 'engine', alwaysVisible: true, rooms: [...rooms, 'interview'], progressPhrase: '{speaker} 在准备这一步的做法…' }),
  cap('read_skill_reference', 'read', all, '读取已加载技能引用的授权方法卡数据，不能改变工具权限。', object({ id: { enum: CAREER_SKILLS.map(skill => skill.id) }, ref: str() }, ['id', 'ref']), { id: 'career-intake', ref: 'fictional-published-method' }, { kind: 'engine' }),
  cap('read_apply_authorization', 'read', ['applier'], '读取现有逐项投递授权与待补问项；聊天不能改授权。', object({ applicationId: str() }, ['applicationId']), { applicationId: 'fictional-application' }, { phase: 'P1-1' }),
  cap('read_apply_receipts', 'read', ['applier'], '读取已拥有的真实插件回执；无回执不能声称已投递。', object({ applicationId: str() }, ['applicationId']), { applicationId: 'fictional-application' }, { phase: 'P1-1' }),
  cap('draft_authorization_card', 'draft', ['companion', 'guide', 'coach', 'interviewer', 'applier'], '起草授权确认卡，不使授权生效；apply_authorization 只限投。', object({ kind: { enum: ['apply_authorization', 'external_grant'] }, targetId: str() }, ['kind', 'targetId']), { kind: 'apply_authorization', targetId: 'fictional-application' }, { phase: 'P1-1', enabledWhenAny: ['P1-1', 'P1b'] }),
  cap('consult', 'consult', ['companion'], '请一位已上线专家，只有一层，主理人不代写队员结论。', object({ expert: { enum: [...EXPERT_KEYS] }, objective: str(60), mode: { enum: ['advise', 'task'] }, skillHint: { enum: CAREER_SKILLS.map(skill => skill.id) } }, ['expert', 'objective', 'mode']), { expert: 'guide', objective: 'Review the fictional first screen.', mode: 'advise' }, { kind: 'engine', alwaysVisible: true, rooms: ['main'], progressPhrase: '{speaker} 在请队员一起看看…', phraseGroup: 'consult' }),
  cap('ask_user', 'ask_user', all, '问最影响下一步的一项；最多三个选择，不代替用户确认。', object({ question: str(500), choices: { type: 'array', items: str(120), maxItems: 3 } }, ['question']), { question: 'Which fictional project should we inspect first?' }, { kind: 'engine', alwaysVisible: true, rooms: [...rooms, 'interview'], progressPhrase: '{speaker} 在整理要问你的问题…', phraseGroup: 'question' }),
  cap('start_background_task', 'background', ['companion', 'guide', 'interviewer', 'applier'], '起自己的技能模板；不能启动工作台执行或对外动作。', object({ template: { enum: ['project_facts_from_uploads', 'saved_jobs_scan', 'resume_full_pass', 'interview_brief', 'job_triage'] }, inputs: references, brief: str(1000) }, ['template', 'inputs', 'brief']), { template: 'project_facts_from_uploads', inputs: [], brief: 'Inspect fictional uploaded project facts.' }, { kind: 'engine', skillVisibility: ['career-intake', 'resume-revision', 'application-preparation', 'interview-brief', 'job-triage'], speakerPhases: { interviewer: 'P1-4' }, progressPhrase: '{speaker} 在安排继续整理…', phraseGroup: 'background' }),
  cap('update_plan', 'none', all, '更新本轮计划，只影响步骤进度，不产生已完成求职证据。', object({ steps: strings(12, 200) }, ['steps']), { steps: ['Read records', 'Draft one action'] }, { kind: 'engine', skillVisibility: CAREER_SKILLS.map(skill => skill.id), progressPhrase: '{speaker} 在整理接下来的步骤…', phraseGroup: 'plan' }),
  cap('read_task_result', 'read', all, '读取已拥有任务的草稿或真实结果；失败不是完成。', object({ taskId: str() }, ['taskId']), { taskId: 'fictional-task' }, { kind: 'engine', skillVisibility: CAREER_SKILLS.map(skill => skill.id) }),
  cap('suggest_human_help', 'none', experts, '建议真人帮助，不承诺内推、展示私密联系方式或代预约。', object({ reason: str(500) }, ['reason']), { reason: 'A fictional resume needs a human review.' }),
  cap('suggest_course_unit', 'none', ['coach'], '建议已包含课程单元；付费建议只由主理人按产品规则处理。', object({ unitId: str(), reason: str(500) }, ['unitId', 'reason']), { unitId: 'fictional-unit', reason: 'Practice one SQL concept.' }, { phase: 'P1-7' }),
  cap('schedule_reminder', 'draft', ['companion'], '起草用户明确要求的提醒，确认前不发通知。', object({ label: str(200), at: { type: 'string', format: 'date-time' }, sourceMessageId: str() }, ['label', 'at', 'sourceMessageId']), { label: 'Fictional project review', at: '2026-10-08T12:00:00Z', sourceMessageId: 'fictional-message' }),
];
export const CAREER_CAPABILITIES: readonly CareerCapabilityDefinition[] = frozen(definitions);
export function careerCapability(id: string): CareerCapabilityDefinition | undefined { return CAREER_CAPABILITIES.find(capability => capability.id === id); }
export function capabilityPermitted(capability: CareerCapabilityDefinition, profile: CareerCapabilityProfile, room: CareerCapabilityRoom, phase: CareerCapabilityPhase): boolean {
  if (room.kind === 'mentor_room' || !capability.speakers.includes(profile.speaker) || !phase.enabledSpeakers.includes(profile.speaker) || !capability.rooms.includes(room.kind) || !(capability.enabledWhenAny ?? [capability.phase]).some(gate => phase.enabledFeatures.includes(gate))) return false;
  const speakerPhase: Partial<Record<AgentSpeakerKey, CareerPhase>> = { planner: 'P1-6', coach: 'P1-7', networker: 'P2' };
  if (speakerPhase[profile.speaker] && !phase.enabledFeatures.includes(speakerPhase[profile.speaker]!)) return false;
  if (room.kind === 'expert_room' && (profile.speaker === 'companion' || room.expert !== profile.speaker)) return false;
  if (room.kind === 'interview' && profile.speaker !== 'interviewer') return false;
  if (capability.effect === 'act') return false;
  if (room.background && !['read', 'draft', 'none'].includes(capability.effect)) return false;
  const extraPhase = capability.speakerPhases?.[profile.speaker];
  return !extraPhase || phase.enabledFeatures.includes(extraPhase);
}
export function capabilityVisible(capability: CareerCapabilityDefinition, profile: CareerCapabilityProfile, room: CareerCapabilityRoom, phase: CareerCapabilityPhase): boolean {
  if (!capabilityPermitted(capability, profile, room, phase)) return false;
  if (capability.alwaysVisible || capability.alwaysVisibleFor?.includes(profile.speaker)) return true;
  if (capability.id === 'read_skill_reference') return CAREER_SKILLS.some(skill => profile.loadedSkillIds?.includes(skill.id) && skill.owner === profile.speaker && phase.reviewedSkills.includes(skill.id) && phase.enabledFeatures.includes(skill.phase) && skill.methodRefs.length > 0);
  return CAREER_SKILLS.some(skill => profile.loadedSkillIds?.includes(skill.id) && skill.owner === profile.speaker && phase.enabledFeatures.includes(skill.phase) && phase.reviewedSkills.includes(skill.id) && (skill.tools.includes(capability.id as never) || capability.skillVisibility?.includes(skill.id)));
}
