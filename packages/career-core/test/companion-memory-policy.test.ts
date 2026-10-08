import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryContextError, selectCompanionContextMemories, type ContextMemory, type MemoryContextScope } from '../src/index.ts';
const now = '2026-10-08T12:00:00.000Z';
function memory(id: string, patch: Partial<ContextMemory> = {}): ContextMemory {
  return { id, ownerId: 'fictional-owner', revision: 1, category: 'experience', sensitivity: 'normal', status: 'confirmed', confidence: 'high',
    usePolicy: 'normal', content: `fictional ${id}`, confirmedAt: '2026-10-07T12:00:00.000Z', validUntil: null, speakerScope: null, intentKeys: [], ...patch };
}
function scope(patch: Partial<MemoryContextScope> = {}): MemoryContextScope {
  return { ownerId: 'fictional-owner', speaker: 'companion', channel: 'web', purpose: 'chat', now, intentKeys: [], userRaisedMemoryIds: [], selfSetReminderMemoryIds: [], ...patch };
}
const selected = (rows: ContextMemory[], patch: Partial<MemoryContextScope> = {}) => selectCompanionContextMemories({ scope: scope(patch), memories: rows });
const ids = (result: ReturnType<typeof selected>) => result.useReferences.map(ref => ref.id);
test('confirmed, current high/medium only; archived, proposed, low and expired are not injected', () => {
  const rows = [memory('high'), memory('medium', { confidence: 'medium' }), memory('low', { confidence: 'low' }), memory('proposed', { status: 'proposed', confirmedAt: null }),
    memory('archived', { status: 'archived' }), memory('expired', { validUntil: now }), memory('future', { confirmedAt: '2026-10-09T00:00:00.000Z' })];
  assert.deepEqual(ids(selected(rows)), ['high', 'medium']);
  assert.match(selected(rows).current.find(item => item.id === 'medium')!.attribution!, /2026-10-07.*确认.*核对/);
  assert.equal(selected(rows).current.find(item => item.id === 'high')!.attribution, null);
});
test('only-if-raised uses exact resolved IDs and stays in the current layer', () => {
  const rows = [memory('private-agreement', { category: 'agreement', usePolicy: 'only_if_user_raises' }), memory('always', { category: 'agreement' })];
  assert.deepEqual(ids(selected(rows)), ['always']);
  const admitted = selected(rows, { userRaisedMemoryIds: ['private-agreement'] });
  assert.deepEqual(admitted.stable.map(item => item.id), ['always']); assert.deepEqual(admitted.current.map(item => item.id), ['private-agreement']);
  assert.deepEqual(ids(selected(rows, { userRaisedMemoryIds: ['not-the-memory'] })), ['always']);
});
test('companion sensitive text is web chat/draft only; proactive, Discord and voice get no raw text', () => {
  const rows = [memory('public'), memory('sensitive', { sensitivity: 'sensitive' })];
  assert.deepEqual(ids(selected(rows)), ['public', 'sensitive']);
  for (const patch of [{ channel: 'discord' }, { channel: 'voice' }, { purpose: 'morning_brief' }, { purpose: 'self_set_reminder' }])
    assert.deepEqual(ids(selected(rows, patch as Partial<MemoryContextScope>)), ['public']);
});
test('restricted only enters exact user-raised web companion chat or self-set reminder', () => {
  const rows = [memory('restriction', { sensitivity: 'restricted', category: 'identity_timeline' })];
  assert.deepEqual(ids(selected(rows)), []); assert.deepEqual(ids(selected(rows, { userRaisedMemoryIds: ['restriction'] })), ['restriction']);
  assert.deepEqual(ids(selected(rows, { purpose: 'self_set_reminder', selfSetReminderMemoryIds: ['restriction'] })), ['restriction']);
  assert.deepEqual(ids(selected([memory('restriction', { sensitivity: 'restricted', usePolicy: 'only_if_user_raises' })], { purpose: 'self_set_reminder', selfSetReminderMemoryIds: ['restriction'] })), ['restriction']);
  for (const channel of ['discord', 'voice'] as const) assert.deepEqual(ids(selected(rows, { channel, userRaisedMemoryIds: ['restriction'] })), []);
  assert.deepEqual(ids(selected(rows, { purpose: 'morning_brief', userRaisedMemoryIds: ['restriction'] })), []);
  assert.deepEqual(ids(selected(rows, { purpose: 'external_draft', userRaisedMemoryIds: ['restriction'] })), []);
});
test('all experts reject sensitive/restricted raw text and direct emotion-rhythm memory', () => {
  const rows = [memory('normal'), memory('emotion', { category: 'emotion_rhythm' }), memory('sensitive', { sensitivity: 'sensitive' }), memory('restricted', { sensitivity: 'restricted' })];
  for (const speaker of ['planner', 'guide', 'coach', 'interviewer', 'networker', 'applier'] as const)
    assert.deepEqual(ids(selected(rows, { speaker, userRaisedMemoryIds: ['sensitive', 'restricted'] })), ['normal']);
});
test('normal identity timeline and speaker-specific communication follow the category table', () => {
  const rows = [memory('graduation', { category: 'identity_timeline' }), memory('only-guide', { category: 'communication', speakerScope: 'guide' })];
  assert.deepEqual(ids(selected(rows, { speaker: 'guide' })), ['only-guide', 'graduation']);
  for (const speaker of ['planner', 'interviewer', 'applier'] as const) assert.deepEqual(ids(selected(rows, { speaker })), ['graduation']);
  for (const speaker of ['coach', 'networker'] as const) assert.deepEqual(ids(selected(rows, { speaker })), []);
  assert.deepEqual(ids(selected(rows)), ['graduation']);
});
test('order: agreement, communication, intent, then latest confirmed; limit 30/15', () => {
  const rows = Array.from({ length: 45 }, (_, index) => memory(`m${String(index).padStart(2, '0')}`));
  rows.push(memory('agreement', { category: 'agreement' }), memory('communication', { category: 'communication' }), memory('intent', { intentKeys: ['practice'] }));
  assert.deepEqual(ids(selected(rows.reverse(), { intentKeys: ['practice'] })).slice(0, 4), ['agreement', 'communication', 'intent', 'm00']);
  assert.equal(ids(selected(rows)).length, 30); assert.equal(ids(selected(rows, { speaker: 'guide' })).length, 15);
  const dated = [memory('older'), memory('newer', { confirmedAt: '2026-10-08T11:00:00.000Z' })];
  assert.deepEqual(ids(selected(dated)), ['newer', 'older']);
});
test('medium can provide attributed chat context but cannot ground external drafts', () => {
  const rows = [memory('high'), memory('medium', { confidence: 'medium' })];
  assert.deepEqual(ids(selected(rows, { purpose: 'external_draft' })), ['high']);
});
test('closed boundary rejects foreign owners, duplicate IDs, scope injection, sparse arrays and getters without evaluating them', () => {
  assert.throws(() => selected([memory('foreign', { ownerId: 'someone-else' })]), MemoryContextError);
  assert.throws(() => selected([memory('same'), memory('same')]), MemoryContextError);
  assert.throws(() => selected([memory('illegal-scope', { speakerScope: 'guide' })]), MemoryContextError);
  assert.throws(() => selected([memory('bad-date', { confirmedAt: 'invalid' })]), MemoryContextError);
  const sparse: ContextMemory[] = []; sparse.length = 2; assert.throws(() => selected(sparse), MemoryContextError);
  let reads = 0; const attack = { ...memory('attack'), get content() { reads++; return 'secret'; } };
  assert.throws(() => selected([attack]), MemoryContextError); assert.equal(reads, 0);
  const arrayAttack = [memory('a')]; Object.defineProperty(arrayAttack, '0', { get() { reads++; return memory('a'); }, enumerable: true });
  assert.throws(() => selected(arrayAttack), MemoryContextError); assert.equal(reads, 0);
  assert.throws(() => selected([memory('a', { admin: true } as never)]), MemoryContextError);
  assert.throws(() => selectCompanionContextMemories({ scope: { ...scope(), permitted: true } as never, memories: [] }), MemoryContextError);
});
test('output is deeply frozen, detached and contains only selected references, never execution authority or confirmation writes', () => {
  const row = memory('a', { category: 'agreement' }), result = selected([row]);
  for (const item of [result, result.stable, result.stable[0], result.current, result.useReferences, result.useReferences[0]]) assert.ok(Object.isFrozen(item));
  (row as { content: string }).content = 'changed later'; assert.equal(result.stable[0].content, 'fictional a');
  assert.equal(Object.hasOwn(result, 'grants'), false); assert.equal(Object.hasOwn(result, 'saved'), false);
});
