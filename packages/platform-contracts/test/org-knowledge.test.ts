import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOrgKnowledgeReference, parseStudentOrgKnowledgePassage, orgKnowledgeBrand } from '../src/org-knowledge.ts';
const id = '11111111-1111-4111-8111-111111111111';
const ref = () => ({ sourceId: id, revision: 2, passageId: '2:0' });
const passage = () => ({ ...ref(), title: 'Fictional source', text: 'Fictional reviewed words.', updatedAt: '2026-10-08T00:00:00.000Z',
  scope: 'org', assetClass: 'question', provenanceLabel: '蔓藤题库', provenance: 'untrusted_knowledge', deidentified: true, older: false, brand: '蔓藤', assetRevision: null });
test('exact coordinates retain canonical citation revision and bounded segment index', () => {
  assert.deepEqual(parseOrgKnowledgeReference(ref()), ref());
  for (const patch of [{ revision: 0 }, { revision: 2147483648 }, { passageId: '1:0' }, { passageId: '2:00' }, { passageId: '2:128' }, { passageId: '../2:0' }, { scope: 'private' }])
    assert.throws(() => parseOrgKnowledgeReference({ ...ref(), ...patch }));
});
test('server provenance and method version are exact; patterns, private content and fabricated brand labels cannot enter the view', () => {
  assert.equal(parseStudentOrgKnowledgePassage(passage()).provenanceLabel, '蔓藤题库');
  const method = { ...passage(), assetClass: 'method_card', assetRevision: 7, provenanceLabel: '蔓藤方法 · v7' };
  assert.equal(parseStudentOrgKnowledgePassage(method).assetRevision, 7);
  for (const patch of [{ assetClass: 'conversation_pattern' }, { scope: 'private' }, { provenanceLabel: '蔓藤面经' }, { older: true }, { deidentified: false },
    { assetRevision: 2 }, { model: 'invented' }, { text: 'x'.repeat(1201) }, { updatedAt: 'not a date' }])
    assert.throws(() => parseStudentOrgKnowledgePassage({ ...passage(), ...patch }));
  assert.throws(() => parseStudentOrgKnowledgePassage({ ...method, provenanceLabel: '蔓藤方法 · v2' }));
  assert.equal(parseStudentOrgKnowledgePassage({ ...method, brand: 'Fictional', provenanceLabel: 'Fictional方法 · v7' }).brand, 'Fictional');
});
test('closed data rejects hidden/accessor/symbol fields without invoking them and freezes detached data', () => {
  let called = false; const value = passage(); Object.defineProperty(value, 'text', { enumerable: true, get() { called = true; return 'hidden'; } });
  assert.throws(() => parseStudentOrgKnowledgePassage(value)); assert.equal(called, false);
  const input = passage(), output = parseStudentOrgKnowledgePassage(input); input.text = 'changed'; assert.equal(output.text, 'Fictional reviewed words.'); assert(Object.isFrozen(output));
  const hidden = passage(); Object.defineProperty(hidden, 'private', { value: true }); assert.throws(() => parseStudentOrgKnowledgePassage(hidden));
  assert.throws(() => parseOrgKnowledgeReference({ ...ref(), [Symbol('forged')]: true }));
});
test('brand prefixes reject controls, bidi, markup and ambiguous separators without echoing the input', () => {
  for (const value of ['', ' brand ', 'brand\ntext', '<script>', 'x·y', '\u202eExample', 'x'.repeat(41)]) assert.throws(() => orgKnowledgeBrand(value));
  assert.equal(orgKnowledgeBrand('蔓藤'), '蔓藤');
});
