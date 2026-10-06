import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createPlatformClient } from '../src/api.ts';
import { createPlatformEndpoints } from '../src/platform-endpoints.ts';
import { createKnowledgeClient } from '../src/knowledge-api.ts';
import type { KnowledgeSource } from '@companion/platform-contracts';

const id = '10000000-0000-4000-8000-000000000001';
const source: KnowledgeSource = { id, title: 'Fictional note', content: 'Fictional private paragraph.', revision: 3, passageCount: 1, byteSize: 28, createdAt: '2026-10-06T00:00:00Z', updatedAt: '2026-10-06T00:00:00Z' };

test('actual loopback HTTP uses private CRUD/search routes, optimistic revisions and never fetches source metadata URLs', async () => {
  const observed: { path: string; method: string; body: any; contentType?: string }[] = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    observed.push({ path: request.url!, method: request.method!, body: body ? JSON.parse(body) : null, contentType: request.headers['content-type'] });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.method === 'DELETE' ? { ok: true } : request.url?.endsWith('/knowledge-search') ? { query: 'fictional', method: 'lexical', matches: [] } : request.url?.endsWith('/knowledge-sources') && request.method === 'GET' ? { sources: [{ ...source, content: undefined }] } : { source }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const transport = createPlatformClient(createPlatformEndpoints(`http://127.0.0.1:${address.port}`));
  const client = createKnowledgeClient(transport.request);
  try {
    assert.equal((await client.list())[0].id, id); assert.equal((await client.read(id)).content, source.content);
    const input = { title: source.title, content: source.content, sourceUrl: 'https://example.invalid/metadata-only' };
    await client.save(input, null); await client.save(input, { id, revision: 2 }); await client.search({ query: 'fictional', limit: 5, sourceIds: [id] }); await client.delete({ id, revision: 3 });
    assert.deepEqual(observed.map(({ method, path }) => [method, path]), [['GET', '/api/platform/knowledge-sources'], ['GET', `/api/platform/knowledge-sources/${id}`], ['POST', '/api/platform/knowledge-sources'], ['PUT', `/api/platform/knowledge-sources/${id}`], ['POST', '/api/platform/knowledge-search'], ['DELETE', `/api/platform/knowledge-sources/${id}`]]);
    assert.deepEqual(observed[2].body, input); assert.deepEqual(observed[3].body, { ...input, revision: 2 }); assert.deepEqual(observed[5].body, { revision: 3 });
    assert.equal(observed[5].contentType, 'application/json'); assert.equal(observed.length, 6);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('pre-aborted reads send nothing; an ignored cancellation cannot return late private source content', async () => {
  let calls = 0, resolve!: (value: unknown) => void;
  const client = createKnowledgeClient(<T>() => { calls++; return new Promise<T>((done) => { resolve = done as any; }); });
  const pre = new AbortController(); pre.abort(); await assert.rejects(client.read(id, pre.signal), { name: 'AbortError' }); assert.equal(calls, 0);
  const active = new AbortController(), reading = client.read(id, active.signal); assert.equal(calls, 1); active.abort(); resolve({ source });
  await assert.rejects(reading, { name: 'AbortError' });
});

test('malformed identifiers and revisions are rejected before transport; malformed successful payloads do not claim saved data', async () => {
  let calls = 0; const client = createKnowledgeClient(async <T>() => { calls++; return {} as T; });
  await assert.rejects(client.read('not-an-id')); await assert.rejects(client.save({ title: 'Fictional', content: 'Fixture' }, { id, revision: 0 })); await assert.rejects(client.delete({ id, revision: -1 })); assert.equal(calls, 0);
  await assert.rejects(client.list(), /资料列表/); await assert.rejects(client.read(id), /完整资料/); await assert.rejects(client.search({ query: 'fixture' }), /搜索结果/); await assert.rejects(client.delete({ id, revision: 1 }), /确认删除/);
});
