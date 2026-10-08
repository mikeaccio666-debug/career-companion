import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHandoffNote, HandoffNoteError, type ContextMemory, type MemoryContextScope } from '../src/index.ts';
const scope: MemoryContextScope = { ownerId: 'fictional-owner', speaker: 'guide', channel: 'web', purpose: 'chat', now: '2026-10-08T12:00:00.000Z', intentKeys: [], userRaisedMemoryIds: [], selfSetReminderMemoryIds: [] };
const memory = (id: string, patch: Partial<ContextMemory> = {}): ContextMemory => ({ id, ownerId: scope.ownerId, revision: 1, category: 'experience', sensitivity: 'normal', status: 'confirmed', confidence: 'high', usePolicy: 'normal', content: `fictional ${id}`, confirmedAt: '2026-10-07T12:00:00.000Z', validUntil: null, speakerScope: null, intentKeys: [], ...patch });
const note = (memories: ContextMemory[]) => buildHandoffNote({ scope, memories, objective: '核对一个课程项目的依据。', lastResultSummary: null });
test('visible deterministic handoff uses confirmed facts and communication phrases, with exact references', () => {
  const result = note([memory('a'), memory('b'), memory('pref', { category: 'communication', content: '先给结论，一次最多三个选项。' })]);
  assert.match(result.text, /目标：核对/); assert.match(result.text, /偏好：先给结论/); assert.match(result.text, /fictional a；fictional b/);
  assert.deepEqual(result.memoryReferences, [{ id: 'a', revision: 1 }, { id: 'b', revision: 1 }, { id: 'pref', revision: 1 }]);
  assert.ok(Array.from(result.text).length <= 600); assert.ok(Object.isFrozen(result.memoryReferences[0]));
});
test('no sensitive/restricted/emotion traits, inferred preference, archived or speaker-specific foreign memory is paraphrased', () => {
  const result = note([memory('secret-sensitive', { sensitivity: 'sensitive' }), memory('secret-restricted', { sensitivity: 'restricted' }), memory('secret-emotion', { category: 'emotion_rhythm' }),
    memory('secret-archived', { status: 'archived' }), memory('secret-other', { category: 'communication', speakerScope: 'applier' }), memory('medium-preference', { category: 'communication', confidence: 'medium' })]);
  assert.doesNotMatch(result.text, /secret|medium-preference/); assert.deepEqual(result.memoryReferences, []); assert.match(result.text, /尚无/);
});
test('attributed medium facts remain attributed; whole facts only, at most four, no model rewriting to squeeze long text', () => {
  const result = note([memory('a', { confidence: 'medium' }), ...Array.from({ length: 8 }, (_, n) => memory(`short-${n}`)), memory('long', { content: '长'.repeat(140) })]);
  assert.match(result.text, /2026-10-07.*确认.*核对/); assert.equal(result.memoryReferences.length, 4); assert.doesNotMatch(result.text, /长/);
});
test('last result requires same owner, confirmed normal projection and bounded content; unknown fields/getters fail closed', () => {
  const valid = { ownerId: scope.ownerId, id: 'last-result', revision: 3, sensitivity: 'normal' as const, status: 'confirmed' as const, content: '上次只核对了课程项目原稿。' };
  const base = { scope, memories: [], objective: '核对材料。', lastResultSummary: valid };
  assert.deepEqual(buildHandoffNote(base).resultReference, { id: 'last-result', revision: 3 });
  for (const patch of [{ ownerId: 'other' }, { sensitivity: 'restricted' }, { status: 'withdrawn' }, { content: 'x'.repeat(121) }]) assert.throws(() => buildHandoffNote({ ...base, lastResultSummary: { ...valid, ...patch } } as never), HandoffNoteError);
  let reads = 0; assert.throws(() => buildHandoffNote({ ...base, get objective() { reads++; return 'secret'; } }), HandoffNoteError); assert.equal(reads, 0);
  assert.throws(() => buildHandoffNote({ ...base, arbitraryPreference: 'secret' } as never), HandoffNoteError);
  assert.throws(() => buildHandoffNote({ ...base, scope: { ...scope, speaker: 'companion' } }), HandoffNoteError);
});
