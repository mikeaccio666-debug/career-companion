import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { KNOWLEDGE_SOURCE_MAX_BYTES } from '@companion/platform-contracts';
import { ApiError } from '../src/errors.ts';
import { KnowledgeSources, parseKnowledgePassageInput, parseKnowledgeSearchInput, parseKnowledgeSourceInput, splitKnowledgePassages } from '../src/knowledge-sources.ts';
import type { Database } from '../src/database.ts';

const invalid = (error: unknown) => error instanceof ApiError && error.status === 400;
test('knowledge text preserves exact submitted whitespace and validates UTF8 rather than replacing malformed surrogates', () => {
  const content = ' \r\nSynthetic course notes 汉字🌱e\u0301\r\n\n  ';
  assert.equal(parseKnowledgeSourceInput({ title: ' Course notes ', content }).content, content);
  assert.equal(parseKnowledgeSourceInput({ title: ' Course notes ', content }).title, 'Course notes');
  for (const value of ['\ud800', 'x\udfff', 'hello\u0000', 'hello\u009f', '\t\r\n ']) assert.throws(() => parseKnowledgeSourceInput({ title: 'Synthetic', content: value }), invalid);
});
test('knowledge character and byte budgets are distinct and inclusive', () => {
  assert.equal(Buffer.byteLength(parseKnowledgeSourceInput({ title: '🌱'.repeat(120), content: 'a'.repeat(KNOWLEDGE_SOURCE_MAX_BYTES), sourceLabel: '标'.repeat(200) }).content), KNOWLEDGE_SOURCE_MAX_BYTES);
  for (const data of [{ title: 'x'.repeat(121), content: 'x' }, { title: 'x', content: 'a'.repeat(KNOWLEDGE_SOURCE_MAX_BYTES + 1) }, { title: 'x', content: '🌱'.repeat(16385) }, { title: 'x', content: 'x', sourceLabel: 'x'.repeat(201) }]) assert.throws(() => parseKnowledgeSourceInput(data), invalid);
});
test('knowledge source metadata accepts HTTPS provenance only and cannot carry URL credentials or unknown authority fields', () => {
  assert.equal(parseKnowledgeSourceInput({ title: 'Synthetic', content: 'x', sourceUrl: 'https://example.invalid/source#section' }).sourceUrl, 'https://example.invalid/source#section');
  for (const sourceUrl of ['http://example.invalid/', 'file:///tmp/private', 'https://user:secret@example.invalid/', 'https://example.invalid/\n', 'https://example.invalid/' + 'x'.repeat(2048), ' https://example.invalid/']) assert.throws(() => parseKnowledgeSourceInput({ title: 'Synthetic', content: 'x', sourceUrl }), invalid);
  for (const field of ['ownerId', 'userId', 'revision', 'trusted', 'fetch', 'instructions']) assert.throws(() => parseKnowledgeSourceInput({ title: 'Synthetic', content: 'x', [field]: 'forbidden' }), invalid);
});
test('knowledge search requires bounded strict arguments and preserves literal percent underscore and slash characters', () => {
  const id = randomUUID();
  assert.deepEqual(parseKnowledgeSearchInput({ query: ' %_\\ ', sourceIds: [id] }), { query: '%_\\', limit: 5, sourceIds: [id] });
  assert.equal(parseKnowledgeSearchInput({ query: '汉'.repeat(240), limit: 8 }).limit, 8);
  for (const data of [{ query: '' }, { query: 'x'.repeat(241) }, { query: 'x', limit: 0 }, { query: 'x', limit: 9 }, { query: 'x', limit: null }, { query: 'x', limit: '5' }, { query: 'x', sourceIds: [] }, { query: 'x', sourceIds: [id, id] }, { query: 'x', sourceIds: ['invalid'] }, { query: 'x', sourceIds: Array.from({ length: 11 }, () => randomUUID()) }, { query: 'x', ownerId: id }, { query: '\ud800' }]) assert.throws(() => parseKnowledgeSearchInput(data), invalid);
});
test('knowledge passage identities bind revision to the source and reject missing or widened authority', () => {
  const sourceId = randomUUID();
  assert.deepEqual(parseKnowledgePassageInput({ sourceId, revision: 2, passageId: '2:0' }), { sourceId, revision: 2, passageId: '2:0' });
  for (const data of [{ sourceId, revision: 0, passageId: '0:0' }, { sourceId, revision: '2', passageId: '2:0' }, { sourceId, revision: 2, passageId: '1:0' }, { sourceId, revision: 2, passageId: '2:-1' }, { sourceId, revision: 2, passageId: '2:0', ownerId: sourceId }]) assert.throws(() => parseKnowledgePassageInput(data), invalid);
});
test('deterministic knowledge passages preserve every Unicode character across natural and hard boundaries', () => {
  const id = randomUUID();
  for (const content of [' \r\n' + ('中文🌱e\u0301 '.repeat(1000)) + '\r\n\n  ', 'x'.repeat(1200) + '🌱'.repeat(1201), ('y'.repeat(850) + '\r\n').repeat(10)]) {
    const parts = splitKnowledgePassages(id, 3, content);
    assert.equal(parts.map(part => part.text).join(''), content);
    assert.deepEqual(parts, splitKnowledgePassages(id, 3, content));
    for (const [index, part] of parts.entries()) { assert(Array.from(part.text).length <= 1200); assert.equal(part.passageIndex, index); assert.equal(part.passageId, `3:${index}`); }
    assert.equal(splitKnowledgePassages(id, 4, content)[0]!.passageId, '4:0');
  }
});
test('knowledge reads and searches respect cancellation before and after the database response', async () => {
  for (const method of ['search', 'readPassage'] as const) {
    let calls = 0; const controller = new AbortController();
    const db = { query: async () => { calls++; controller.abort(); return { rowCount: 0, rows: [] }; } } as unknown as Database;
    const service = new KnowledgeSources(db), input = method === 'search' ? { query: 'synthetic' } : { sourceId: randomUUID(), revision: 1, passageId: '1:0' };
    const cancelled = (error: unknown) => error instanceof ApiError && error.code === 'KNOWLEDGE_CANCELLED';
    await assert.rejects(service[method]('synthetic-owner', input, controller.signal), cancelled); assert.equal(calls, 1);
    await assert.rejects(service[method]('synthetic-owner', input, controller.signal), cancelled); assert.equal(calls, 1);
  }
});
test('cancellation during result assembly cannot return a passage or search matches', async () => {
  for (const method of ['search', 'readPassage'] as const) {
    const controller = new AbortController(), id = randomUUID();
    const row = { source_id: id, source_revision: 1, revision: 1, passage_id: '1:0', passage_index: 0, passage_text: 'Synthetic private passage', updated_at: '2026-01-01T00:00:00Z', source_label: null, source_url: null, deleted_at: null,
      get title() { controller.abort(); return 'Synthetic title'; } };
    const service = new KnowledgeSources({ query: async () => ({ rowCount: 1, rows: [row] }) } as unknown as Database);
    const input = method === 'search' ? { query: 'synthetic' } : { sourceId: id, revision: 1, passageId: '1:0' };
    await assert.rejects(service[method]('synthetic-owner', input, controller.signal), (error: unknown) => error instanceof ApiError && error.code === 'KNOWLEDGE_CANCELLED');
  }
});
