import { APPLICATION_QUESTION_BATCH_LIMITS, parseApplicationQuestionBatchV1, type ApplicationQuestionSchemaV1 } from '@edaix/contracts';
import type { QuestionDescription } from '@edaix/apply-kernel/questions';
import { describe, expect, it, vi } from 'vitest';
import { createApplicationQuestionClient } from '../lib/applicationQuestionClient';
import { handleApplicationQuestionMessage } from '../lib/applicationQuestionMessages';
import { withSchemaOptions } from '../lib/applicationQuestionSchema';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const missionId = uuid(5);

const schema: ApplicationQuestionSchemaV1 = {
  schemaVersion: 1,
  provider: 'GREENHOUSE',
  fields: [
    { name: 'first_name', type: 'input_text', required: true, label: 'First Name', options: [] },
    {
      name: 'question_2', type: 'multi_value_single_select', required: true, label: 'Do you need sponsorship?',
      options: [{ optionId: 'o0', text: 'Yes' }, { optionId: 'o1', text: 'No' }],
    },
    {
      name: 'question_3[]', type: 'multi_value_multi_select', required: false, label: 'Which have you used?',
      options: [{ optionId: 'o0', text: 'TypeScript' }, { optionId: 'o1', text: 'Rust' }],
    },
    {
      name: '9001', type: 'multi_value_single_select', required: false, label: 'Gender',
      options: [{ optionId: 'o0', text: 'Prefer not to say' }],
    },
  ],
};

const question = (fieldName: string, text: string): QuestionDescription =>
  ({ questionId: `q:${fieldName}`, text, fieldName, controlType: 'TEXT', required: false, options: [] });

describe('closed questions take their options from the application schema', () => {
  it('turns a matched combobox into a single or multi choice question and leaves the rest alone', () => {
    const questions = [
      question('first_name', 'First name'),
      question('question_2', 'Do you need sponsorship?'),
      question('question_3', 'Which have you used?'),
      question('9001', 'Gender'),
      question('question_99', 'Anything else?'),
      question('', 'Unnamed control'),
    ];
    expect(withSchemaOptions(questions, schema).map((q) => [q.fieldName, q.controlType, q.options.map((o) => o.text)])).toEqual([
      ['first_name', 'TEXT', []],
      ['question_2', 'SINGLE_CHOICE', ['Yes', 'No']],
      ['question_3', 'MULTI_CHOICE', ['TypeScript', 'Rust']],
      ['9001', 'SINGLE_CHOICE', ['Prefer not to say']],
      ['question_99', 'TEXT', []],
      ['', 'TEXT', []],
    ]);
  });

  // Independent review of #327 (P1): the schema allows 200 options per field and 128,000 text
  // bytes, the candidates batch allows 40 and 64,000 and rejects the whole batch when exceeded.
  // Copying a school/degree list into a question silenced every question on the page, including
  // the free-text ones that worked before. Too many options keep the scanned shape; truncating
  // the list would be worse than free text.
  const options = (count: number, size = 1) => Array.from({ length: count }, (_, i) => ({ optionId: `o${i}`, text: `${i}`.padEnd(size, 'x') }));
  const closed = (name: string, count: number, size = 1): ApplicationQuestionSchemaV1['fields'][number] =>
    ({ name, type: 'multi_value_single_select', required: false, label: name, options: options(count, size) });
  // The wire carries the contract's five fields; fieldName stays local, as the content script does.
  const batch = (questions: readonly QuestionDescription[]) => ({ schemaVersion: 1, requestId: uuid(7),
    questions: questions.map(({ questionId, text, controlType, required, options }) => ({ questionId, text, controlType, required, options })),
    context: { extensionInstallId: uuid(4), missionId, missionRevision: '2', canonicalJobId: uuid(6), applicationBundleVersion: '3', applicationTargetRevision: '7', pageId: 'page-1', pageGeneration: '1' } });

  it('keeps the scanned shape for a field with more options than one question may carry', () => {
    const wide: ApplicationQuestionSchemaV1 = { schemaVersion: 1, provider: 'GREENHOUSE', fields: [
      closed('school', APPLICATION_QUESTION_BATCH_LIMITS.optionsPerQuestion + 1), closed('degree', APPLICATION_QUESTION_BATCH_LIMITS.optionsPerQuestion)] };
    const questions = [question('school', 'School'), question('degree', 'Degree'), question('question_99', 'Anything else?')];
    const result = withSchemaOptions(questions, wide);
    expect(result.map((q) => [q.fieldName, q.controlType, q.options.length])).toEqual([
      ['school', 'TEXT', 0], ['degree', 'SINGLE_CHOICE', APPLICATION_QUESTION_BATCH_LIMITS.optionsPerQuestion], ['question_99', 'TEXT', 0]]);
    expect(parseApplicationQuestionBatchV1(batch(result))).not.toBeNull();
  });

  it('gives back the largest enrichments first when the options would push the batch past its text budget', () => {
    const size = Math.ceil(APPLICATION_QUESTION_BATCH_LIMITS.textBytes / APPLICATION_QUESTION_BATCH_LIMITS.optionsPerQuestion / 2);
    const heavy: ApplicationQuestionSchemaV1 = { schemaVersion: 1, provider: 'GREENHOUSE', fields: [
      closed('discipline', APPLICATION_QUESTION_BATCH_LIMITS.optionsPerQuestion, size + 1),
      closed('school', APPLICATION_QUESTION_BATCH_LIMITS.optionsPerQuestion, size),
      closed('question_2', 2)] };
    const questions = [question('discipline', 'Discipline'), question('school', 'School'), question('question_2', 'Sponsorship?'), question('question_99', 'Anything else?')];
    const result = withSchemaOptions(questions, heavy);
    expect(result.map((q) => [q.fieldName, q.controlType])).toEqual([
      ['discipline', 'TEXT'], ['school', 'SINGLE_CHOICE'], ['question_2', 'SINGLE_CHOICE'], ['question_99', 'TEXT']]);
    expect(parseApplicationQuestionBatchV1(batch(result))).not.toBeNull();
  });

  it('leaves every question exactly as scanned when there is no schema', () => {
    const questions = [question('question_2', 'Do you need sponsorship?')];
    expect(withSchemaOptions(questions, null)).toEqual(questions);
  });

  it('never rewrites a question the page already answered as a closed one', () => {
    const scanned: QuestionDescription = {
      ...question('question_3', 'Which have you used?'),
      controlType: 'MULTI_CHOICE',
      options: [{ optionId: 'o0', text: 'Only what the page showed' }],
    };
    expect(withSchemaOptions([scanned], schema)).toEqual([scanned]);
  });
});

describe('application-question/schema', () => {
  it('fetches the mission question schema in the background and refuses a mission it cannot read', async () => {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const fetchFn = vi.fn(async (url: string) =>
      url.endsWith(`/api/v1/agent/missions/${missionId}/application-questions`) ? json(schema) : json({}, 404));
    const client = createApplicationQuestionClient({
      apiBase: 'https://api.example.test',
      getAccessToken: async () => 'token',
      getInstallId: async () => uuid(4),
      resolveTarget: async () => ({ missionRevision: '2', revision: '7' }),
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(await handleApplicationQuestionMessage(client, 'application-question/schema', { missionId }))
      .toEqual({ ok: true, schema });
    expect(await handleApplicationQuestionMessage(client, 'application-question/schema', { missionId: 'not-a-uuid' }))
      .toEqual({ ok: false, code: 'INVALID' });
    expect(await handleApplicationQuestionMessage(client, 'application-question/schema', { missionId: uuid(9) }))
      .toEqual({ ok: false, code: 'UNAVAILABLE' });
  });
});
