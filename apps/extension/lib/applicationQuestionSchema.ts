import type { ApplicationQuestionSchemaFieldV1, ApplicationQuestionSchemaV1 } from '@edaix/contracts';
import { APPLICATION_QUESTION_BATCH_LIMITS } from '@edaix/contracts';
import type { QuestionDescription } from '@edaix/apply-kernel/questions';

/**
 * Give a scanned question the options the page could not show.
 *
 * A vendor combobox keeps its option list out of the DOM until the menu opens, so the scanner can
 * only describe it as free text. The application schema (AGENT-API-CONTRACT §4.16) lists the same
 * controls by the `name`/`id` they carry on the page, so a question whose control is one of those
 * closed fields can be asked as the closed question it really is.
 *
 * Everything else is returned exactly as scanned — a question the page already closed keeps the
 * options it actually renders, and a missing or failed schema changes nothing.
 */
export function withSchemaOptions(
  questions: readonly QuestionDescription[],
  schema: ApplicationQuestionSchemaV1 | null,
): readonly QuestionDescription[] {
  if (!schema || schema.fields.length === 0) return questions;
  const byName = new Map(schema.fields.map((field) => [field.name, field]));
  const enriched = questions.map((question) => {
    if (question.controlType !== 'TEXT' || question.fieldName === '') return question;
    const field = byName.get(question.fieldName) ?? byName.get(`${question.fieldName}[]`);
    if (!field || field.options.length === 0 || field.options.length > APPLICATION_QUESTION_BATCH_LIMITS.optionsPerQuestion) return question;
    return { ...question, controlType: controlOf(field), options: field.options };
  });
  return withinTextBudget(questions, enriched);
}

/**
 * The schema may list far more per field than one candidates batch may carry, and the batch is
 * refused as a whole when it overflows. A question that would not fit keeps its scanned shape:
 * a school or degree list cut short would be worse than free text, and one wide field must not
 * silence the rest of the page. Over the byte budget, the largest enrichments go back first.
 */
function withinTextBudget(scanned: readonly QuestionDescription[], enriched: readonly QuestionDescription[]): readonly QuestionDescription[] {
  const bytes = (question: QuestionDescription) => utf8(question.text) + question.options.reduce((total, option) => total + utf8(option.text), 0);
  let total = enriched.reduce((sum, question) => sum + bytes(question), 0);
  const result = [...enriched];
  const byWeight = enriched.map((question, index) => index).filter((index) => enriched[index] !== scanned[index])
    .sort((a, b) => bytes(enriched[b]!) - bytes(enriched[a]!));
  for (const index of byWeight) {
    if (total <= APPLICATION_QUESTION_BATCH_LIMITS.textBytes) break;
    total -= bytes(enriched[index]!) - bytes(scanned[index]!);
    result[index] = scanned[index]!;
  }
  return result;
}

function utf8(value: string): number {
  return new TextEncoder().encode(value).length;
}

function controlOf(field: ApplicationQuestionSchemaFieldV1): QuestionDescription['controlType'] {
  return field.type === 'multi_value_multi_select' ? 'MULTI_CHOICE' : 'SINGLE_CHOICE';
}
