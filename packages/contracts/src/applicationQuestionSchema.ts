/**
 * The application form's own field list for one listing, read from the board provider and
 * served per Mission (§4.16). It is value-free: field names, labels and option texts only,
 * never an answer and never anything owner-scoped.
 */
import type { Uuid } from './common.ts';

export const APPLICATION_QUESTION_SCHEMA_FIELD_TYPES = [
  'input_text', 'textarea', 'input_file', 'input_hidden',
  'multi_value_single_select', 'multi_value_multi_select',
] as const;
export type ApplicationQuestionSchemaFieldTypeV1 = typeof APPLICATION_QUESTION_SCHEMA_FIELD_TYPES[number];

export type ApplicationQuestionSchemaFieldV1 = Readonly<{
  /** The control's own form name on the rendered page (`question_12345`, `question_12345[]`, `first_name`). */
  name: string;
  type: ApplicationQuestionSchemaFieldTypeV1;
  required: boolean;
  label: string;
  /** Empty for every type that takes no options. */
  options: readonly Readonly<{ optionId: string; text: string }>[];
}>;

export type ApplicationQuestionSchemaV1 = Readonly<{
  schemaVersion: 1;
  provider: 'GREENHOUSE';
  fields: readonly ApplicationQuestionSchemaFieldV1[];
}>;

export interface GetMissionApplicationQuestionsParams { readonly missionId: Uuid }
export type GetMissionApplicationQuestionsResponse = ApplicationQuestionSchemaV1;

export const APPLICATION_QUESTION_SCHEMA_LIMITS = Object.freeze({
  fields: 300,
  optionsPerField: 200,
  labelBytes: 2_000,
  totalTextBytes: 128_000,
});

export function parseApplicationQuestionSchemaV1(value: unknown): ApplicationQuestionSchemaV1 | null {
  if (!object(value, ['schemaVersion', 'provider', 'fields']) || value.schemaVersion !== 1
    || value.provider !== 'GREENHOUSE' || !Array.isArray(value.fields)
    || value.fields.length > APPLICATION_QUESTION_SCHEMA_LIMITS.fields) return null;
  const names = new Set<string>();
  let bytes = 0;
  for (const field of value.fields) {
    if (!object(field, ['name', 'type', 'required', 'label', 'options']) || !fieldName(field.name)
      || names.has(field.name) || !member(APPLICATION_QUESTION_SCHEMA_FIELD_TYPES, field.type)
      || typeof field.required !== 'boolean' || !text(field.label, APPLICATION_QUESTION_SCHEMA_LIMITS.labelBytes)
      || !Array.isArray(field.options) || field.options.length > APPLICATION_QUESTION_SCHEMA_LIMITS.optionsPerField) return null;
    if (field.options.length > 0 && !field.type.startsWith('multi_value_')) return null;
    names.add(field.name);
    bytes += utf8(field.label);
    const optionIds = new Set<string>();
    for (const [index, option] of field.options.entries()) {
      if (!object(option, ['optionId', 'text']) || option.optionId !== `o${index}` || optionIds.has(option.optionId)
        || !text(option.text, APPLICATION_QUESTION_SCHEMA_LIMITS.labelBytes)) return null;
      optionIds.add(option.optionId);
      bytes += utf8(option.text);
    }
    if (bytes > APPLICATION_QUESTION_SCHEMA_LIMITS.totalTextBytes) return null;
  }
  return value as ApplicationQuestionSchemaV1;
}

function object(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
}
function member<T extends readonly string[]>(values: T, v: unknown): v is T[number] { return typeof v === 'string' && values.includes(v); }
/** The rendered control's `name`/`id`; Greenhouse multi-selects carry a trailing `[]`. */
function fieldName(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,127}$/u.test(v) && !['constructor', '__proto__', 'prototype'].includes(v);
}
function utf8(v: string): number { return new TextEncoder().encode(v).length; }
function text(v: unknown, limit: number): v is string {
  return typeof v === 'string' && v.trim().length > 0 && utf8(v) <= limit
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(v);
}
