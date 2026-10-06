import { ARTIFACT_TEXT_MIME_TYPES, CLI_INPUT_MAX_FILES, CLI_INPUT_MAX_FILE_BYTES, CLI_INPUT_MAX_TOTAL_BYTES, type CreateJobInput, type GoalPlan, type GoalPlanInputSnapshot, type GoalPlanInputSource, type GoalPlanStep } from '@companion/platform-contracts';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const sha = /^[0-9a-f]{64}$/i;
export const goalReferenceImageMimes = ['image/png', 'image/jpeg', 'image/webp'] as const;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, names: string[]) => Object.keys(value).every((key) => names.includes(key));
const number = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const positive = (value: unknown) => number(value) && Number(value) > 0;
const id = (value: unknown) => typeof value === 'string' && uuid.test(value);
const hash = (value: unknown) => typeof value === 'string' && sha.test(value);
const fileName = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
const fileMime = (value: unknown): value is string => typeof value === 'string' && value.length <= 150 && /^[a-z0-9][a-z0-9.+_-]*\/[a-z0-9][a-z0-9.+_-]*$/i.test(value);
const fingerprint = (value: unknown): string => JSON.stringify(value, (_key, item) => object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const fields = ['kind', 'provider', 'prompt', 'model', 'options', 'attachmentIds', 'executionTemplate'] as const;
const fallback = (field: typeof fields[number]) => field === 'options' ? {} : field === 'attachmentIds' ? [] : null;
function inputMatches(first: CreateJobInput, second: CreateJobInput, names: readonly typeof fields[number][] = fields): boolean { return names.every((field) => fingerprint(first[field] ?? fallback(field)) === fingerprint(second[field] ?? fallback(field))); }
function invalid(): never { throw new Error('本步的实际输入、来源或独立审批不一致，请重新读取并核对计划。'); }

/** Receipt order is canonical. Never sort UUIDs or substitute the latest job generation. */
export function goalReceiptResults(step: GoalPlanStep, mimes?: readonly string[]) {
  if (step.receipt?.kind !== 'task') return [];
  const byId = new Map(step.artifacts.map((artifact) => [artifact.id, artifact]));
  return step.receipt.artifactIds.flatMap((artifactId) => { const artifact = byId.get(artifactId); return artifact && (!mimes || mimes.includes(artifact.mime)) ? [artifact] : []; });
}
export function assertGoalPlanInputSources(plan: GoalPlan, step: GoalPlanStep): void {
  const bindings = step.input.kind === 'task' ? step.input.bindings : undefined;
  const prepared = !!step.job || step.resolvedTask !== undefined || step.inputSources !== undefined;
  if (!prepared) return; // A deleted child may retain only a blocked historical receipt.
  if (step.input.kind !== 'task') { if (step.resolvedTask !== undefined || step.inputSources !== undefined) invalid(); return; }
  if (bindings && (step.resolvedTask === undefined || step.inputSources === undefined)) invalid();
  if (step.resolvedTask === undefined && step.inputSources === undefined) { if (step.approval?.args.goalPlanInput !== undefined) invalid(); return; } // Older, unbound task histories.
  const actual = step.resolvedTask;
  if (!object(actual) || !keys(actual, [...fields]) || actual.options !== undefined && !object(actual.options) || !inputMatches(actual, step.input.task, ['kind', 'provider', 'model', 'options', 'executionTemplate']) || typeof actual.prompt !== 'string' || !actual.prompt.trim() || actual.prompt.length > 20_000 || !Array.isArray(step.inputSources) || step.inputSources.length > 5) invalid();
  if (step.job && !inputMatches(actual, step.job)) invalid();
  const expected = [...(bindings?.prompt ? [bindings.prompt] : []), ...(bindings?.referenceImages || []).map((image) => ({ ...image, source: 'reference_image' as const })), ...(bindings?.artifactFiles || []).map((file) => ({ ...file, source: 'artifact_file' as const }))];
  if (expected.length !== step.inputSources.length) invalid();
  for (const [slot, source] of step.inputSources.entries()) {
    const rule = expected[slot];
    if (!object(source) || !rule || source.source !== rule.source || source.fromStep !== rule.fromStep || !number(source.fromStep) || source.fromStep >= step.index || !hash(source.sha256) || !number(source.byteSize)) invalid();
    const prior = plan.steps[source.fromStep];
    if (!prior?.receipt) invalid();
    if (source.source === 'analysis_text') {
      if (!keys(source, ['source', 'fromStep', 'mode', 'messageId', 'sha256', 'byteSize']) || !('mode' in rule) || source.mode !== rule.mode || !id(source.messageId) || prior.input.kind !== 'agent_turn' || prior.receipt.kind !== 'agent_turn' || source.messageId !== prior.receipt.messageId) invalid();
    } else if (source.source === 'artifact_text' || source.source === 'reference_image' || source.source === 'artifact_file') {
      const image = source.source === 'reference_image', file = source.source === 'artifact_file';
      const sourceKeys = image ? ['source', 'fromStep', 'imageIndex', 'jobId', 'generation', 'artifactId', 'attachmentId', 'mime', 'sha256', 'byteSize'] : file ? ['source', 'fromStep', 'artifactIndex', 'jobId', 'generation', 'artifactId', 'attachmentId', 'name', 'mime', 'sha256', 'byteSize'] : ['source', 'fromStep', 'mode', 'artifactIndex', 'jobId', 'generation', 'artifactId', 'mime', 'sha256', 'byteSize'];
      if (!keys(source, sourceKeys) || prior.input.kind !== 'task' || prior.receipt.kind !== 'task' || source.jobId !== prior.receipt.jobId || source.generation !== prior.receipt.generation || source.generation !== prior.generation || !positive(source.generation) || !id(source.artifactId) || !prior.receipt.artifactIds.includes(source.artifactId)) invalid();
      if (image) {
        if (source.imageIndex !== ('imageIndex' in rule ? rule.imageIndex ?? 0 : 0) || !id(source.attachmentId) || !positive(source.byteSize) || !(goalReferenceImageMimes as readonly string[]).includes(source.mime)) invalid();
      } else if (file) {
        if (actual.kind !== 'cli' || source.artifactIndex !== ('artifactIndex' in rule ? rule.artifactIndex ?? 0 : 0) || !id(source.attachmentId) || !fileName(source.name) || !fileMime(source.mime) || !positive(source.byteSize) || source.byteSize > CLI_INPUT_MAX_FILE_BYTES || ['browser', 'mcp'].includes(prior.input.task.kind)) invalid();
      } else if (!('mode' in rule) || source.mode !== rule.mode || source.artifactIndex !== ('artifactIndex' in rule ? rule.artifactIndex ?? 0 : 0) || !(ARTIFACT_TEXT_MIME_TYPES as readonly string[]).includes(source.mime) || ['browser', 'mcp'].includes(prior.input.task.kind)) invalid();
      const available = prior.artifacts.find((artifact) => artifact.id === source.artifactId);
      if (available && (available.mime !== source.mime || file && (available.name !== source.name || available.size !== undefined && available.size !== source.byteSize))) invalid();
      const complete = prior.receipt.artifactIds.every((artifactId) => prior.artifacts.some((artifact) => artifact.id === artifactId));
      if (!complete && prior.state !== 'blocked') invalid();
      if (file ? prior.receipt.artifactIds[source.artifactIndex] !== source.artifactId : complete && goalReceiptResults(prior, image ? goalReferenceImageMimes : ARTIFACT_TEXT_MIME_TYPES)[image ? source.imageIndex : source.artifactIndex]?.id !== source.artifactId) invalid();
    } else invalid();
  }
  if (bindings?.prompt ? bindings.prompt.mode === 'append' && !actual.prompt.startsWith(`${step.input.task.prompt}\n\n`) : actual.prompt !== step.input.task.prompt) invalid();
  const fileSources = step.inputSources.filter((source): source is Extract<GoalPlanInputSource, { source: 'artifact_file' }> => source.source === 'artifact_file');
  const attachments = [...(step.input.task.attachmentIds || []), ...step.inputSources.filter((source): source is Extract<GoalPlanInputSource, { source: 'reference_image' | 'artifact_file' }> => source.source === 'reference_image' || source.source === 'artifact_file').map((source) => source.attachmentId)];
  if (fileSources.length && (attachments.length > CLI_INPUT_MAX_FILES || fileSources.reduce((bytes, source) => bytes + source.byteSize, 0) > CLI_INPUT_MAX_TOTAL_BYTES)) invalid();
  if (fingerprint(actual.attachmentIds || []) !== fingerprint(attachments) || new Set(attachments).size !== attachments.length) invalid();
  if (step.approval) {
    const snapshot = step.approval.args.goalPlanInput;
    if (!object(snapshot) || !keys(snapshot, ['planId', 'revision', 'stepIndex', 'templateHash', 'effectiveInputHash', 'inputSources']) || snapshot.planId !== plan.id || snapshot.revision !== plan.revision || snapshot.stepIndex !== step.index || !hash(snapshot.templateHash) || !hash(snapshot.effectiveInputHash) || fingerprint(snapshot.inputSources) !== fingerprint(step.inputSources)) invalid();
  }
}
export function goalInputSourceSummary(source: GoalPlanInputSource): string {
  if (source.source === 'analysis_text') return `第 ${source.fromStep + 1} 步的已保存分析正文 · ${source.mode === 'append' ? '追加' : '使用全文'} · ${source.byteSize.toLocaleString('zh-CN')} 字节`;
  if (source.source === 'artifact_file') return `第 ${source.fromStep + 1} 步成功回执中全部成果的第 ${source.artifactIndex + 1} 份文件「${source.name}」 · 任务版本 ${source.generation} · ${source.mime} · ${source.byteSize.toLocaleString('zh-CN')} 字节`;
  return `第 ${source.fromStep + 1} 步的第 ${(source.source === 'reference_image' ? source.imageIndex : source.artifactIndex) + 1} 份${source.source === 'reference_image' ? '图片' : '文字'}成果 · 任务版本 ${source.generation} · ${source.mime} · ${source.byteSize.toLocaleString('zh-CN')} 字节`;
}
export function goalPreparedInputSnapshot(step: GoalPlanStep): GoalPlanInputSnapshot | undefined { return step.approval?.args.goalPlanInput as GoalPlanInputSnapshot | undefined; }
