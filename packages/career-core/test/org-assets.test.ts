import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOrgP0Asset, orgAssetBody, orgAssetLegacyBody, assertOrgAssetText, externalQuestionPrompt } from '../src/assets/p0-assets.ts';
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

test('readable excerpts keep reviewed text while internal identities, bindings and tool declarations stay out of the body', () => {
  const question = parseOrgP0Asset('question', q()), text = orgAssetBody(question);
  assert(text.startsWith(q().prompt_en)); assert(!text.includes('"question_ref"')); assert(text.includes(q().key_points[0]));
  const method = parseOrgP0Asset('method_card', { method_id: 'fictional.method', revision: 7,
    author_id: '11111111-1111-4111-8111-111111111111', reviewer_id: '22222222-2222-4222-8222-222222222222',
    applies_to: { role_families: ['da'], stages: ['interview'], situations: ['preparing'] }, prerequisites: [],
    steps: [{ goal: 'A fictional goal', method: 'A reviewed method.', allowed_tools: ['private_tool'], output: 'A useful output.' }],
    rubric_ref: null, stop_when: ['Stop after one example.'], counterexamples: ['Do not invent data.'], escalate_when: [],
    evidence_nature: '经验建议', bound_skills: ['interview-practice'], when_to_use: 'Before practice.', bound_speakers: ['interviewer'],
    effective_from: '2025-01-01T00:00:00.000Z', superseded_by: null });
  const body = orgAssetBody(method); assert(body.includes('A reviewed method.')); assert(body.includes('Do not invent data.'));
  for (const internal of ['private_tool', '11111111', '22222222', 'interview-practice', 'bound_speakers']) assert(!body.includes(internal));
  assert(orgAssetLegacyBody(method).includes('"author_id"'));
});
