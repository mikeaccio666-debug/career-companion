import { GOAL_PLAN_GOAL_CHARACTERS, GOAL_PLAN_INSTRUCTION_CHARACTERS, GOAL_PLAN_MAX_BYTES, GOAL_PLAN_MAX_STEPS, type CreateJobInput, type GoalPlanInput, type GoalPlanStepInput, type JobKind } from '@companion/platform-contracts';
import { parseGoalTaskBindings, type GoalTaskBindings } from './goal-plan-bindings.ts';

export const goalTaskKinds = ['image', 'video', 'speech', 'browser', 'cli', 'workflow', 'mcp'] as const;
export interface GoalStepDraft {
  kind: 'task' | 'agent_turn'; title: string; provider: string; model: string;
  instruction: string; taskKind: JobKind; prompt: string; options: string;
  attachmentIds: string; executionTemplate: string;
  bindings?: GoalTaskBindings;
}
export interface GoalPlanDraft { title: string; goal: string; steps: GoalStepDraft[] }
export function newGoalStep(): GoalStepDraft {
  return { kind: 'agent_turn', title: '', provider: '', model: '', instruction: '', taskKind: 'image', prompt: '', options: '{}', attachmentIds: '', executionTemplate: '' };
}
export function newGoalDraft(): GoalPlanDraft { return { title: '', goal: '', steps: [newGoalStep()] }; }
export function goalInputToDraft(input: GoalPlanInput): GoalPlanDraft {
  return { title: input.title, goal: input.goal, steps: input.steps.map((step) => step.kind === 'agent_turn'
    ? { ...newGoalStep(), kind: step.kind, title: step.title, provider: step.provider, model: step.model || '', instruction: step.instruction, ...(Object.hasOwn(step, 'bindings') ? { bindings: structuredClone((step as unknown as GoalStepDraft).bindings) } : {}) }
    : { ...newGoalStep(), kind: step.kind, title: step.title, taskKind: step.task.kind, provider: step.task.provider, model: step.task.model || '', prompt: step.task.prompt, options: JSON.stringify(step.task.options || {}, null, 2), attachmentIds: (step.task.attachmentIds || []).join(', '), executionTemplate: step.task.executionTemplate ? JSON.stringify(step.task.executionTemplate, null, 2) : '', ...(step.bindings !== undefined ? { bindings: structuredClone(step.bindings) } : {}) }) };
}
function text(value: string, label: string, max: number): string { const result = value.trim(); if (!result || result.length > max) throw new Error(`${label}需要填写，最多 ${max.toLocaleString('zh-CN')} 字。`); return result; }
function jsonObject(value: string, label: string): Record<string, unknown> {
  let result: unknown; try { result = JSON.parse(value); } catch { throw new Error(`${label}需要完整的 JSON 对象。`); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(`${label}需要 JSON 对象。`);
  return result as Record<string, unknown>;
}
export function parseGoalDraft(draft: GoalPlanDraft): GoalPlanInput {
  if (!draft.steps.length || draft.steps.length > GOAL_PLAN_MAX_STEPS) throw new Error(`计划需要 1–${GOAL_PLAN_MAX_STEPS} 个顺序步骤。`);
  const steps: GoalPlanStepInput[] = draft.steps.map((step, index) => {
    const label = `第 ${index + 1} 步`, title = text(step.title, `${label}标题`, 120), provider = text(step.provider, `${label}服务`, 80), model = step.model.trim();
    if (model.length > 150) throw new Error(`${label}模型名称最多 150 字。`);
    if (step.kind === 'agent_turn') { parseGoalTaskBindings(step.bindings, index, draft.steps); return { kind: step.kind, title, provider, ...(model ? { model } : {}), instruction: text(step.instruction, `${label}分析要求`, GOAL_PLAN_INSTRUCTION_CHARACTERS) }; }
    if (!(goalTaskKinds as readonly string[]).includes(step.taskKind)) throw new Error(`${label}任务类型不可用。`);
    const ids = step.attachmentIds.split(',').map((id) => id.trim()).filter(Boolean);
    const maxAttachments = ['image', 'video'].includes(step.taskKind) ? 4 : 8;
    if (ids.length > maxAttachments || new Set(ids).size !== ids.length || ids.some((id) => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))) throw new Error(`${label}附件需要最多 ${maxAttachments} 个不同的已保存附件 ID，以逗号分隔。`);
    const template = step.executionTemplate.trim() ? jsonObject(step.executionTemplate, `${label}模板绑定`) : undefined;
    if (step.taskKind === 'mcp' && (model || ids.length || template)) throw new Error(`${label}外部工具不接受模型、附件或生成模板。`);
    const options = jsonObject(step.options || '{}', `${label}任务参数`), serialized = JSON.stringify(options);
    if (step.taskKind === 'workflow' ? new TextEncoder().encode(serialized).byteLength > 128 * 1024 : serialized.length > 20_000) throw new Error(`${label}任务参数超过服务端上限。`);
    const bindings = parseGoalTaskBindings(step.bindings, index, draft.steps, ids.length);
    return { kind: 'task', title, task: { kind: step.taskKind, provider, prompt: text(step.prompt, `${label}任务要求`, 20_000), ...(model ? { model } : {}), options, ...(ids.length ? { attachmentIds: ids } : {}), ...(template ? { executionTemplate: template as unknown as CreateJobInput['executionTemplate'] } : {}) }, ...(bindings ? { bindings } : {}) };
  });
  const input: GoalPlanInput = { title: text(draft.title, '计划名称', 120), goal: text(draft.goal, '目标', GOAL_PLAN_GOAL_CHARACTERS), steps };
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > GOAL_PLAN_MAX_BYTES) throw new Error('计划内容超过保存上限，请缩短参数或步骤。');
  return input;
}
