import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOrgP0Asset, assertOrgAssetText, externalQuestionPrompt } from '../src/assets/p0-assets.ts';
const q = () => ({ question_ref: 'fictional.question', type: 'sql', role_families: ['da'], difficulty: 1, topics: ['aggregation'],
  prompt_en: 'Explain a fictional aggregate query.', prompt_zh: '', external_ref: null, rubric: null,
  key_points: ['Explain the grouping.'], follow_ups: [], time_budget_min: 15 });
test('closed shapes reject nested accessors, sparse arrays, extra fields and fake roles', () => {
  assert.equal((parseOrgP0Asset('question', q()) as any).type, 'sql');
  assert.throws(() => parseOrgP0Asset('question', { ...q(), model: 'invented' }));
  assert.throws(() => parseOrgP0Asset('question', { ...q(), role_families: ['invented'] }));
  assert.throws(() => parseOrgP0Asset('question', { ...q(), topics: Array(1) }));
  let called = false; const ref = { platform: 'Fictional', key: 'one', get url() { called = true; return 'https://example.invalid/problem/one'; } };
  assert.throws(() => parseOrgP0Asset('question', { ...q(), external_ref: ref })); assert.equal(called, false);
});
test('external problems store generated reference requests and rubrics require three to six dimensions with four scores each', () => {
  const external_ref = { platform: 'Fictional', key: 'one', url: 'https://example.invalid/problem/one' };
  assert.throws(() => parseOrgP0Asset('question', { ...q(), external_ref }));
  assert.equal((parseOrgP0Asset('question', { ...q(), external_ref, prompt_en: externalQuestionPrompt(external_ref) }) as any).external_ref.url, external_ref.url);
  assert.throws(() => parseOrgP0Asset('question', { ...q(), rubric: [{ dimension: 'x', scores: ['one'] }] }));
});
test('contact and sales tripwires do not certify human de-identification', () => {
  for (const text of ['Fictional student@example.invalid', '123-456-7890', '名额只剩三个', '再不投就没机会', '稳过']) assert.throws(() => assertOrgAssetText('conversation_pattern', text));
  assert.doesNotThrow(() => assertOrgAssetText('question', 'A fictional question without contact identifiers.'));
  assert.throws(() => assertOrgAssetText('question', '字'.repeat(23000)));
});
