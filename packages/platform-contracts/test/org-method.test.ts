import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOrgMethodContent, parseStudentOrgMethod } from '../src/org-knowledge.ts';
const content = () => ({ whenToUse: 'Fictional project preparation.', appliesTo: { role_families: ['da'], stages: ['preparation'], situations: ['course_project'] },
  prerequisites: ['project-facts'], evidenceNature: '经验建议', steps: [{ goal: 'Check a fact.', method: 'Read fictional notes.', output: 'A supported claim.' }],
  rubricRef: null, stopWhen: ['The claim has evidence.'], counterexamples: ['A group result is not individual ownership.'], escalateWhen: [] });
const method = () => ({ sourceId: '11111111-1111-4111-8111-111111111111', revision: 2, passageId: '2:0',
  title: 'Fictional method', updatedAt: '2026-10-08T00:00:00.000Z', scope: 'org', assetClass: 'method_card', assetRevision: 7,
  brand: '蔓藤', provenanceLabel: '蔓藤方法 · v7', provenance: 'untrusted_knowledge', deidentified: true, older: false, content: content() });
test('full method keeps publication and method revisions separate and returns detached frozen conditions and steps', () => {
  const input = method(), result = parseStudentOrgMethod(input); input.content.steps[0].method = 'Changed';
  assert.equal(result.content.steps[0].method, 'Read fictional notes.');
  assert.equal(result.revision, 2); assert.equal(result.assetRevision, 7);
  assert(Object.isFrozen(result.content.steps[0])); assert(Object.isFrozen(result.content.appliesTo.role_families));
  assert.equal(parseStudentOrgMethod({ ...method(), older: true }).older, true);
});
test('full source DTO rejects staff identities, tool declarations, invalid classes, missing counterexamples and unbounded bodies', () => {
  for (const patch of [{ assetClass: 'question' }, { author_id: 'private' }, { text: 'raw body' }, { assetRevision: null }, { provenanceLabel: 'Invented' }])
    assert.throws(() => parseStudentOrgMethod({ ...method(), ...patch }));
  for (const patch of [{ counterexamples: [] }, { steps: [] }, { allowed_tools: ['executeCli'] }, { evidenceNature: 'Guaranteed result' },
    { steps: [{ goal: 'x', method: 'x'.repeat(4001), output: 'x' }] }, { appliesTo: { role_families: ['unknown'], stages: [], situations: [] } },
    { counterexamples: Array.from({ length: 50 }, () => 'x'.repeat(2000)) }])
    assert.throws(() => parseOrgMethodContent({ ...content(), ...patch }));
});
test('nested accessors and sparse arrays cannot execute code or enter the full method view', () => {
  let ran = false; const bad = content(); Object.defineProperty(bad.steps[0], 'method', { enumerable: true, get() { ran = true; return 'bad'; } });
  assert.throws(() => parseOrgMethodContent(bad)); assert.equal(ran, false);
  const sparse = content(); sparse.steps = Array(1); assert.throws(() => parseOrgMethodContent(sparse));
  const extra = content(); Object.defineProperty(extra.counterexamples, 'hidden', { value: 'private' }); assert.throws(() => parseOrgMethodContent(extra));
});
