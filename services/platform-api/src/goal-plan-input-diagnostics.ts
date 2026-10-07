import type { GoalPlanStepInput } from '@companion/platform-contracts';
import { ApiError, object, string } from './errors.ts';

export type GoalPlanInputReason = 'missing' | 'type' | 'empty' | 'too_long' | 'too_many' | 'out_of_range' | 'unsupported_field' | 'invalid_value';
const expectations = [
  'object', 'allowed_fields_only', 'array_1_8_steps', 'task_or_agent_turn',
  'string_1_120_characters', 'string_1_8000_characters', 'string_1_6000_characters',
  'string_1_80_characters', 'string_1_150_characters', 'string_1_20000_characters',
  'supported_task_kind', 'object_max_20000_characters', 'object_max_131072_utf8_bytes',
  'array_max_10_distinct_uuids', 'array_max_4_distinct_uuids', 'valid_task_input', 'valid_mcp_options',
  'analysis_text_or_artifact_text', 'append_or_replace', 'integer_0_7', 'integer_0_63',
  'array_1_4_reference_images', 'valid_previous_result_binding', 'earlier_step_index',
  'text_binding_for_image_video_speech_cli', 'matching_analysis_or_task_text_source',
  'reference_images_for_image_video', 'at_most_4_combined_reference_images', 'earlier_task_step_index',
  'array_1_4_artifact_files', 'artifact_files_for_cli', 'at_most_4_combined_artifact_files', 'earlier_ordinary_task_step_index',
] as const;
export type GoalPlanInputExpected = typeof expectations[number];
export interface GoalPlanInputDiagnostic { path: string; reason: GoalPlanInputReason; expected: GoalPlanInputExpected }
const reasons = new Set<GoalPlanInputReason>(['missing','type','empty','too_long','too_many','out_of_range','unsupported_field','invalid_value']);
// Paths are code-owned field names and bounded indexes, never keys supplied by a user.
const pathPattern = /^(?:\$|title|goal|steps|steps\[[0-7]\](?:\.(?:title|kind|instruction|provider|model|task(?:\.(?:kind|provider|prompt|model|options|attachmentIds|executionTemplate))?|bindings(?:\.(?:prompt(?:\.(?:fromStep|source|artifactIndex|mode))?|referenceImages(?:\[[0-3]\](?:\.(?:fromStep|imageIndex))?)?|artifactFiles(?:\[[0-3]\](?:\.(?:fromStep|artifactIndex))?)?))?))?)$/;

class GoalPlanInputDiagnosticError extends ApiError {
  readonly diagnostic: Readonly<GoalPlanInputDiagnostic>;
  constructor(error: ApiError, diagnostic: GoalPlanInputDiagnostic) {
    super(error.status, error.code, error.publicMessage);
    if (!pathPattern.test(diagnostic.path) || !reasons.has(diagnostic.reason) || !expectations.includes(diagnostic.expected)) throw error;
    this.diagnostic = Object.freeze({ path: diagnostic.path, reason: diagnostic.reason, expected: diagnostic.expected });
  }
}
export function goalPlanInputDiagnostic(error: unknown): GoalPlanInputDiagnostic | undefined {
  if (!(error instanceof GoalPlanInputDiagnosticError)) return undefined;
  const { path, reason, expected } = error.diagnostic;
  return { path, reason, expected };
}
/** Annotate only the original deterministic input failure; never change acceptance or status. */
export function withGoalPlanDiagnostic<T>(parse: () => T, diagnostic: GoalPlanInputDiagnostic | (() => GoalPlanInputDiagnostic)): T {
  try { return parse(); }
  catch (error) {
    if (!(error instanceof ApiError) || error.status !== 400 || error.code !== 'INVALID_INPUT' || error instanceof GoalPlanInputDiagnosticError) throw error;
    throw new GoalPlanInputDiagnosticError(error, typeof diagnostic === 'function' ? diagnostic() : diagnostic);
  }
}
function stringReason(value: unknown, maximum: number): GoalPlanInputReason {
  return value === undefined ? 'missing' : typeof value !== 'string' ? 'type' : !value.trim() ? 'empty' : value.length > maximum ? 'too_long' : 'invalid_value';
}
export function goalPlanInputString(value: unknown, label: string, maximum: 80 | 120 | 150 | 6000 | 8000 | 20000, path: string): string {
  const expected = `string_1_${maximum}_characters` as GoalPlanInputExpected;
  return withGoalPlanDiagnostic(() => string(value, label, maximum), () => ({ path, reason: stringReason(value, maximum), expected }));
}
export function goalPlanInputObject(value: unknown, path: string): Record<string,unknown> {
  return withGoalPlanDiagnostic(() => object(value), { path, reason: value === undefined ? 'missing' : 'type', expected: 'object' });
}
function record(value: unknown): value is Record<string,unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function extra(data: Record<string,unknown>, allowed: readonly string[]) { return Object.keys(data).some(key => !allowed.includes(key)); }

/** Called only after the real task parser rejected; this classifier grants nothing. */
export function taskInputDiagnostic(value: unknown, path: string): GoalPlanInputDiagnostic {
  const at = (field: string, reason: GoalPlanInputReason, expected: GoalPlanInputExpected) => ({ path: field ? `${path}.${field}` : path, reason, expected });
  if (!record(value)) return at('', value === undefined ? 'missing' : 'type', 'object');
  if (extra(value, ['kind','provider','prompt','model','options','attachmentIds','executionTemplate'])) return at('', 'unsupported_field', 'allowed_fields_only');
  if (typeof value.kind !== 'string' || !value.kind.trim() || value.kind.length > 30 || !['image','video','speech','browser','cli','workflow','mcp'].includes(value.kind.trim())) return at('kind', stringReason(value.kind,30), 'supported_task_kind');
  const kind = value.kind.trim();
  if (kind === 'mcp' && ['model','attachmentIds','executionTemplate'].some(key => Object.hasOwn(value,key))) return at('', 'unsupported_field', 'valid_mcp_options');
  if (value.options !== undefined) {
    if (!record(value.options)) return at('options','type','object');
    const encoded = JSON.stringify(value.options);
    if (kind === 'workflow' ? Buffer.byteLength(encoded,'utf8') > 128 * 1024 : encoded.length > 20_000) return at('options','too_long',kind === 'workflow' ? 'object_max_131072_utf8_bytes' : 'object_max_20000_characters');
  }
  if (value.attachmentIds !== undefined && (!Array.isArray(value.attachmentIds) || value.attachmentIds.length > 10)) return at('attachmentIds',Array.isArray(value.attachmentIds) ? 'too_many' : 'type','array_max_10_distinct_uuids');
  if (Array.isArray(value.attachmentIds) && new Set(value.attachmentIds).size !== value.attachmentIds.length) return at('attachmentIds','invalid_value','array_max_10_distinct_uuids');
  if (['image','video'].includes(kind) && Array.isArray(value.attachmentIds) && value.attachmentIds.length > 4) return at('attachmentIds','too_many','array_max_4_distinct_uuids');
  for (const [field,maximum] of [['provider',80],['prompt',20000],['model',150]] as const) {
    if (field === 'model' && (value.model === undefined || value.model === null)) continue;
    if (typeof value[field] !== 'string' || !value[field].trim() || value[field].length > maximum) return at(field,stringReason(value[field],maximum),`string_1_${maximum}_characters` as GoalPlanInputExpected);
  }
  return at(kind === 'mcp' ? 'options' : '', 'invalid_value', kind === 'mcp' ? 'valid_mcp_options' : 'valid_task_input');
}

/** Structural binding hints contain no data from the rejected binding. */
export function bindingInputDiagnostic(value: unknown, path: string): GoalPlanInputDiagnostic {
  const at = (field: string, reason: GoalPlanInputReason, expected: GoalPlanInputExpected) => ({ path: field ? `${path}.${field}` : path, reason, expected });
  if (!record(value)) return at('',value === undefined ? 'missing' : 'type','object');
  if (extra(value,['prompt','referenceImages','artifactFiles'])) return at('','unsupported_field','allowed_fields_only');
  const indexHint = (item: unknown, field: string, maximum: 7 | 63): GoalPlanInputDiagnostic | undefined =>
    typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0 || item > maximum ? at(field,item === undefined ? 'missing' : typeof item !== 'number' ? 'type' : 'out_of_range',maximum === 7 ? 'integer_0_7' : 'integer_0_63') : undefined;
  if (value.prompt !== undefined) {
    const prompt = value.prompt;
    if (!record(prompt)) return at('prompt','type','object');
    if (extra(prompt,['fromStep','source','artifactIndex','mode'])) return at('prompt','unsupported_field','allowed_fields_only');
    for (const field of ['source','mode'] as const) {
      const expected = field === 'source' ? 'analysis_text_or_artifact_text' : 'append_or_replace';
      if (typeof prompt[field] !== 'string' || !(field === 'source' ? ['analysis_text','artifact_text'] : ['append','replace']).includes(prompt[field])) return at(`prompt.${field}`,prompt[field] === undefined ? 'missing' : typeof prompt[field] !== 'string' ? 'type' : 'invalid_value',expected);
    }
    if (prompt.source === 'analysis_text' && prompt.artifactIndex !== undefined) return at('prompt.artifactIndex','unsupported_field','allowed_fields_only');
    const fromStep = indexHint(prompt.fromStep,'prompt.fromStep',7); if (fromStep) return fromStep;
    if (prompt.artifactIndex !== undefined) { const artifact = indexHint(prompt.artifactIndex,'prompt.artifactIndex',63); if (artifact) return artifact; }
  }
  if (value.referenceImages !== undefined) {
    if (!Array.isArray(value.referenceImages) || !value.referenceImages.length || value.referenceImages.length > 4) return at('referenceImages',!Array.isArray(value.referenceImages) ? 'type' : !value.referenceImages.length ? 'empty' : 'too_many','array_1_4_reference_images');
    for (const [index,image] of value.referenceImages.entries()) {
      if (!record(image)) return at(`referenceImages[${index}]`,'type','object');
      if (extra(image,['fromStep','imageIndex'])) return at(`referenceImages[${index}]`,'unsupported_field','allowed_fields_only');
      const fromStep = indexHint(image.fromStep,`referenceImages[${index}].fromStep`,7); if (fromStep) return fromStep;
      if (image.imageIndex !== undefined) { const imageIndex = indexHint(image.imageIndex,`referenceImages[${index}].imageIndex`,63); if (imageIndex) return imageIndex; }
    }
  }
  if (value.artifactFiles !== undefined) {
    if (!Array.isArray(value.artifactFiles) || !value.artifactFiles.length || value.artifactFiles.length > 4) return at('artifactFiles',!Array.isArray(value.artifactFiles) ? 'type' : !value.artifactFiles.length ? 'empty' : 'too_many','array_1_4_artifact_files');
    for (const [index,file] of value.artifactFiles.entries()) {
      if (!record(file)) return at(`artifactFiles[${index}]`,'type','object');
      if (extra(file,['fromStep','artifactIndex'])) return at(`artifactFiles[${index}]`,'unsupported_field','allowed_fields_only');
      const fromStep = indexHint(file.fromStep,`artifactFiles[${index}].fromStep`,7); if (fromStep) return fromStep;
      if (file.artifactIndex !== undefined) { const artifactIndex = indexHint(file.artifactIndex,`artifactFiles[${index}].artifactIndex`,63); if (artifactIndex) return artifactIndex; }
    }
  }
  return at('','invalid_value','valid_previous_result_binding');
}
/** Locate the first invalid dependency after the authoritative semantic validator fails. */
export function semanticBindingDiagnostic(steps: GoalPlanStepInput[]): GoalPlanInputDiagnostic {
  for (const [index,step] of steps.entries()) {
    if (step.kind !== 'task' || !step.bindings) continue;
    const path = `steps[${index}].bindings`;
    const prompt = step.bindings.prompt;
    if (prompt) {
      if (prompt.fromStep >= index || !steps[prompt.fromStep]) return {path:`${path}.prompt.fromStep`,reason:'out_of_range',expected:'earlier_step_index'};
      if (!['image','video','speech','cli'].includes(step.task.kind)) return {path:`${path}.prompt`,reason:'invalid_value',expected:'text_binding_for_image_video_speech_cli'};
      const source = steps[prompt.fromStep];
      if (prompt.source === 'analysis_text' ? source.kind !== 'agent_turn' : source.kind !== 'task' || ['browser','mcp'].includes(source.task.kind)) return {path:`${path}.prompt.source`,reason:'invalid_value',expected:'matching_analysis_or_task_text_source'};
    }
    if (step.bindings.referenceImages) {
      if (!['image','video'].includes(step.task.kind)) return {path:`${path}.referenceImages`,reason:'invalid_value',expected:'reference_images_for_image_video'};
      if ((step.task.attachmentIds?.length ?? 0) + step.bindings.referenceImages.length > 4) return {path:`${path}.referenceImages`,reason:'too_many',expected:'at_most_4_combined_reference_images'};
      for (const [imageIndex,image] of step.bindings.referenceImages.entries()) {
        const source = steps[image.fromStep];
        if (image.fromStep >= index || !source) return {path:`${path}.referenceImages[${imageIndex}].fromStep`,reason:'out_of_range',expected:'earlier_step_index'};
        if (source.kind !== 'task') return {path:`${path}.referenceImages[${imageIndex}].fromStep`,reason:'invalid_value',expected:'earlier_task_step_index'};
      }
    }
    if (step.bindings.artifactFiles) {
      if (step.task.kind !== 'cli') return {path:`${path}.artifactFiles`,reason:'invalid_value',expected:'artifact_files_for_cli'};
      if ((step.task.attachmentIds?.length ?? 0) + step.bindings.artifactFiles.length > 4) return {path:`${path}.artifactFiles`,reason:'too_many',expected:'at_most_4_combined_artifact_files'};
      for (const [fileIndex,file] of step.bindings.artifactFiles.entries()) {
        const source = steps[file.fromStep];
        if (file.fromStep >= index || !source) return {path:`${path}.artifactFiles[${fileIndex}].fromStep`,reason:'out_of_range',expected:'earlier_step_index'};
        if (source.kind !== 'task' || ['browser','mcp'].includes(source.task.kind)) return {path:`${path}.artifactFiles[${fileIndex}].fromStep`,reason:'invalid_value',expected:'earlier_ordinary_task_step_index'};
      }
    }
  }
  return {path:'steps',reason:'invalid_value',expected:'valid_previous_result_binding'};
}
