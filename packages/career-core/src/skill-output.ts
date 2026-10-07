import type { CareerSkillId, CareerTool } from './contracts.ts';
import { careerCapability } from './capabilities.ts';
import { careerSkill } from './skills.ts';

const supportedKeywords = new Set(['type', 'const', 'enum', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum']);
function matches(value: unknown, schema: Record<string, any>, depth = 0): boolean {
  if (depth > 12) return false;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || Object.keys(schema).some(key => !supportedKeywords.has(key))) return false;
  if (schema.type !== undefined && !['object', 'array', 'string', 'number', 'integer'].includes(schema.type)) return false;
  if (schema.const !== undefined && value !== schema.const || schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const data = value as Record<string, unknown>;
    if ((schema.required as string[] ?? []).some(key => !Object.hasOwn(data, key))) return false;
    if (!schema.properties || schema.additionalProperties !== false || Object.keys(data).some(key => !Object.hasOwn(schema.properties, key))) return false;
    return Object.entries(schema.properties ?? {}).every(([key, child]) => !Object.hasOwn(data, key) || matches(data[key], child as Record<string, any>, depth + 1));
  }
  if (schema.type === 'array') return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? Infinity) && value.every(item => matches(item, schema.items, depth + 1));
  if (schema.type === 'string') return typeof value === 'string' && Array.from(value).length >= (schema.minLength ?? 0) && Array.from(value).length <= (schema.maxLength ?? Infinity);
  if (schema.type === 'number' || schema.type === 'integer') return typeof value === 'number' && Number.isFinite(value) && (schema.type !== 'integer' || Number.isSafeInteger(value)) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
  return schema.const !== undefined || Array.isArray(schema.enum);
}
/** The supported schema subset is deliberately closed; adding a keyword requires its implementation and tests. */
export function careerSkillOutputMatchesContract(output: unknown, schema: Readonly<Record<string, unknown>>): boolean { return matches(output, schema); }
function artifactReferences(value: unknown): { id: string; revision: number }[] {
  if (!value || typeof value !== 'object') return [];
  const item = value as Record<string, unknown>;
  if (['draft', 'pending'].includes(String(item.status)) && typeof item.id === 'string' && typeof item.revision === 'number') return [{ id: item.id, revision: item.revision }];
  return Object.values(item).flatMap(artifactReferences);
}
/** Completion is about this output and successful draft receipts, never prose claims or achievement credit. */
export function careerSkillCompletion(id: CareerSkillId, input: { output: unknown; finalText: string; successfulSaves: readonly { tool: CareerTool; id: string; revision: number }[] }): { complete: boolean; reasons: string[] } {
  const skill = careerSkill(id), reasons: string[] = [];
  if (!matches(input.output, skill.outputContract)) reasons.push('output_contract_failed');
  if (!input.finalText.trim() || /[?？][\s”"'）)\]】]*$/u.test(input.finalText)) reasons.push('still_waiting_for_answer');
  const saves = input.successfulSaves.filter(save => skill.tools.includes(save.tool) && careerCapability(save.tool)?.effect === 'draft' && !!save.id.trim() && Number.isSafeInteger(save.revision) && save.revision > 0);
  if (skill.tools.some(tool => careerCapability(tool)?.effect === 'draft') && !saves.length) reasons.push('draft_save_unconfirmed');
  if (!reasons.includes('output_contract_failed') && artifactReferences(input.output).some(ref => !saves.some(save => save.id === ref.id && save.revision === ref.revision))) reasons.push('output_artifact_unconfirmed');
  return { complete: reasons.length === 0, reasons };
}
