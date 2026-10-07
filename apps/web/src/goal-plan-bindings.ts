import { CLI_INPUT_MAX_FILES, GOAL_PLAN_RESULT_INDEX_MAX, type GoalPlanTaskInput, type JobKind } from '@companion/platform-contracts';

export type GoalTaskBindings = NonNullable<GoalPlanTaskInput['bindings']>;
export type GoalPromptBinding = NonNullable<GoalTaskBindings['prompt']>;
export type GoalImageBinding = NonNullable<GoalTaskBindings['referenceImages']>[number];
export type GoalFileBinding = NonNullable<GoalTaskBindings['artifactFiles']>[number];
export interface GoalBindingStep { kind: 'task' | 'agent_turn'; title: string; taskKind?: JobKind; bindings?: GoalTaskBindings }
export const goalBindingResultLimit = GOAL_PLAN_RESULT_INDEX_MAX + 1;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const ownKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every((key) => keys.includes(key));
const position = (value: unknown, limit: number): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < limit;
export function goalArtifactTextSource(step: GoalBindingStep): boolean { return step.kind === 'task' && !!step.taskKind && !['browser', 'mcp'].includes(step.taskKind); }
export function goalPromptTarget(step: GoalBindingStep): boolean { return step.kind === 'task' && ['image', 'video', 'speech', 'cli'].includes(step.taskKind || ''); }
export function goalReferenceImageTarget(step: GoalBindingStep): boolean { return step.kind === 'task' && ['image', 'video'].includes(step.taskKind || ''); }
export function goalArtifactFileTarget(step: GoalBindingStep): boolean { return step.kind === 'task' && step.taskKind === 'cli'; }
export interface GoalBindingChoice { fromStep: number; source: 'analysis_text' | 'artifact_text'; label: string }
export function goalBindingOptions(steps: readonly GoalBindingStep[], target: number): GoalBindingChoice[] {
  return steps.slice(0, target).flatMap<GoalBindingChoice>((step, fromStep) => step.kind === 'agent_turn'
    ? [{ fromStep, source: 'analysis_text' as const, label: `第 ${fromStep + 1} 步「${step.title || '未命名'}」的分析正文` }]
    : goalArtifactTextSource(step) ? [{ fromStep, source: 'artifact_text' as const, label: `第 ${fromStep + 1} 步「${step.title || '未命名'}」的文字成果` }] : []);
}
/** Invalid references are retained in the editor and rejected, never silently mapped to another step. */
export function parseGoalTaskBindings(value: unknown, index: number, steps: readonly GoalBindingStep[], attachmentCount = 0): GoalTaskBindings | undefined {
  const fail = (message: string): never => { throw new Error(`第 ${index + 1} 步的前序成果绑定：${message}`); };
  if (value === undefined) return;
  if (!object(value) || !ownKeys(value, ['prompt', 'referenceImages', 'artifactFiles']) || value.prompt === undefined && value.referenceImages === undefined && value.artifactFiles === undefined) return fail('请重新选择来源，或明确取消绑定。');
  if (steps[index]?.kind !== 'task') return fail('分析步骤不接受执行任务的输入绑定，请明确取消。');
  const sourceStep = (fromStep: unknown) => {
    if (!position(fromStep, index)) return fail('只能选择本计划更早的步骤。');
    return steps[fromStep];
  };
  let prompt: GoalPromptBinding | undefined;
  if (value.prompt !== undefined) {
    if (!goalPromptTarget(steps[index])) return fail('此任务的外层要求不是实际执行输入，请明确取消正文绑定。');
    const input = value.prompt;
    if (!object(input) || !ownKeys(input, ['fromStep', 'source', 'artifactIndex', 'mode']) || !['analysis_text', 'artifact_text'].includes(String(input.source)) || !['append', 'replace'].includes(String(input.mode))) return fail('正文来源或使用方式不完整，请重新选择。');
    const source = sourceStep(input.fromStep);
    if (input.source === 'analysis_text' ? source.kind !== 'agent_turn' || input.artifactIndex !== undefined : !goalArtifactTextSource(source) || input.artifactIndex !== undefined && !position(input.artifactIndex, goalBindingResultLimit)) return fail('分析正文须来自分析步骤；文字成果须来自普通任务，成果序号也需有效。');
    prompt = { fromStep: Number(input.fromStep), source: input.source as GoalPromptBinding['source'], mode: input.mode as GoalPromptBinding['mode'], ...(input.artifactIndex !== undefined ? { artifactIndex: Number(input.artifactIndex) } : {}) };
  }
  let referenceImages: GoalImageBinding[] | undefined;
  if (value.referenceImages !== undefined) {
    if (!goalReferenceImageTarget(steps[index])) return fail('只有图片或视频任务可以接收参考图，请明确取消参考图绑定。');
    if (!Array.isArray(value.referenceImages) || !value.referenceImages.length || value.referenceImages.length + attachmentCount > 4) return fail('固定附件与前序参考图合计最多 4 张，不能保存空的参考图规则。');
    referenceImages = value.referenceImages.map((item) => {
      if (!object(item) || !ownKeys(item, ['fromStep', 'imageIndex'])) return fail('参考图来源不完整，请重新选择。');
      const source = sourceStep(item.fromStep);
      if (source.kind !== 'task' || item.imageIndex !== undefined && !position(item.imageIndex, goalBindingResultLimit)) return fail('参考图须来自前序执行任务，图片序号也需有效。');
      return { fromStep: Number(item.fromStep), ...(item.imageIndex !== undefined ? { imageIndex: Number(item.imageIndex) } : {}) };
    });
    if (new Set(referenceImages.map((item) => `${item.fromStep}:${item.imageIndex ?? 0}`)).size !== referenceImages.length) return fail('同一份参考图只能选择一次。');
  }
  let artifactFiles: GoalFileBinding[] | undefined;
  if (value.artifactFiles !== undefined) {
    if (!goalArtifactFileTarget(steps[index])) return fail('只有终端任务可以接收前序成果文件，请明确取消文件绑定。');
    if (!Array.isArray(value.artifactFiles) || !value.artifactFiles.length || value.artifactFiles.length + attachmentCount > CLI_INPUT_MAX_FILES) return fail(`终端的固定附件与前序成果文件合计最多 ${CLI_INPUT_MAX_FILES} 个，不能保存空的文件规则。`);
    artifactFiles = value.artifactFiles.map((item) => {
      if (!object(item) || !ownKeys(item, ['fromStep', 'artifactIndex'])) return fail('文件来源不完整，请重新选择。');
      const source = sourceStep(item.fromStep);
      if (!goalArtifactTextSource(source) || item.artifactIndex !== undefined && !position(item.artifactIndex, goalBindingResultLimit)) return fail('文件须来自前序普通执行任务，不能来自浏览器或外部工具；成果序号也需有效。');
      return { fromStep: Number(item.fromStep), ...(item.artifactIndex !== undefined ? { artifactIndex: Number(item.artifactIndex) } : {}) };
    });
    if (new Set(artifactFiles.map((item) => `${item.fromStep}:${item.artifactIndex ?? 0}`)).size !== artifactFiles.length) return fail('同一份成果文件只能选择一次。');
  }
  return { ...(prompt ? { prompt } : {}), ...(referenceImages ? { referenceImages } : {}), ...(artifactFiles ? { artifactFiles } : {}) };
}
export function goalBindingProblem(step: GoalBindingStep, index: number, steps: readonly GoalBindingStep[], attachmentCount = 0): string {
  try { parseGoalTaskBindings(step.bindings, index, steps, attachmentCount); return ''; } catch (error) { return error instanceof Error ? error.message : '前序成果绑定不完整，请重新选择。'; }
}
/** Deleting a prior slot may also shift a later source. Block that edit until the user clears/reselects it. */
export function removeGoalStep<T extends GoalBindingStep>(steps: readonly T[], index: number): T[] {
  const affected = steps.flatMap((step, target) => {
    if (target === index || !step.bindings) return [];
    const sources = [step.bindings.prompt?.fromStep, ...(step.bindings.referenceImages || []).map((item) => item.fromStep), ...(step.bindings.artifactFiles || []).map((item) => item.fromStep)].filter((item): item is number => item !== undefined);
    return sources.some((source) => source >= index) ? [target + 1] : [];
  });
  if (affected.length) throw new Error(`第 ${affected.join('、')} 步使用了此步或其后步骤的成果。请先在这些步骤取消或重新选择来源，再移除第 ${index + 1} 步；其他编辑已保留。`);
  return steps.filter((_, slot) => slot !== index);
}
export function goalBindingRuleSummary(bindings: GoalTaskBindings): string[] {
  const rules: string[] = [];
  if (bindings.prompt) { const input = bindings.prompt; rules.push(`任务正文${input.mode === 'append' ? '追加' : '使用全文替换'}：第 ${input.fromStep + 1} 步的${input.source === 'analysis_text' ? '分析正文' : `第 ${(input.artifactIndex ?? 0) + 1} 份文字成果`}。`); }
  for (const image of bindings.referenceImages || []) rules.push(`参考图：第 ${image.fromStep + 1} 步的第 ${(image.imageIndex ?? 0) + 1} 份图片成果。`);
  for (const file of bindings.artifactFiles || []) rules.push(`终端输入文件：第 ${file.fromStep + 1} 步成功回执中全部成果的第 ${(file.artifactIndex ?? 0) + 1} 份（不按文件类型筛选）。`);
  return rules;
}
