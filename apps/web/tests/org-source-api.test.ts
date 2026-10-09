import { fictionalMethodDetails } from './fixtures/org-method.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { orgSourcePath, orgSourceReferenceFromPath, readOrgSource, readOrgMethod, type OrgSourceClient } from '../src/org-source-api.ts';
const id = '11111111-1111-4111-8111-111111111111', ref = { sourceId: id, revision: 2, passageId: '2:0' };
const passage = () => ({ ...ref, title: 'Fictional source', text: 'Fictional words.', updatedAt: '2026-10-08T00:00:00.000Z',
  scope: 'org', assetClass: 'question', provenanceLabel: '蔓藤题库', provenance: 'untrusted_knowledge', deidentified: true, older: false, brand: '蔓藤', assetRevision: null });
const client = (run: (path: string, init?: RequestInit) => unknown, current = () => true): OrgSourceClient => ({
  account: { accountId: id }, isCurrent: current, subscribe: () => () => {}, request: async <T>(path: string, init?: RequestInit) => await run(path, init) as T,
});
test('source navigation is same-site and exact; malformed IDs/versions/paths never form a read request', () => {
  const path = orgSourcePath(ref); assert.equal(path, '/sources/org/' + id + '/2/2%3A0'); assert.deepEqual(orgSourceReferenceFromPath(path), ref);
  for (const value of [path + '/extra', path + '?scope=private', '//evil.invalid' + path, path.replace('/2/2%3A0', '/3/2%3A0'), path.replace('2%3A0', '2%3A128'), path.replace('2%3A0', '2%253A0')])
    assert.equal(orgSourceReferenceFromPath(value), null);
  assert.throws(() => orgSourcePath({ ...ref, sourceId: '../foreign' }));
});
test('actual citation coordinates and untrusted server provenance are checked after no-store transport', async () => {
  let calls = 0;
  const result = await readOrgSource(client((path, init) => { calls++; assert.equal(path, '/org-knowledge/passages/' + id + '/2/2%3A0');
    assert.equal(init?.cache, 'no-store'); assert.equal(init?.method, undefined); return { passage: passage() }; }), ref);
  assert.equal(result.text, 'Fictional words.'); assert.equal(calls, 1);
  for (const patch of [{ sourceId: '22222222-2222-4222-8222-222222222222' }, { revision: 3, passageId: '3:0' }, { passageId: '2:1' }, { provenance: 'trusted_system' }, { assetClass: 'conversation_pattern' }])
    await assert.rejects(readOrgSource(client(() => ({ passage: { ...passage(), ...patch } })), ref));
});
test('pre-abort makes no request; late account invalidation and ignored abort cannot deliver source content', async () => {
  const abort = new AbortController(); abort.abort(); let calls = 0;
  await assert.rejects(readOrgSource(client(() => { calls++; return { passage: passage() }; }), ref, abort.signal)); assert.equal(calls, 0);
  let current = true; await assert.rejects(readOrgSource(client(() => { current = false; return { passage: passage() }; }, () => current), ref));
  const during = new AbortController(); await assert.rejects(readOrgSource(client(() => { during.abort(); return { passage: passage() }; }), ref, during.signal));
});

test('full method uses no-store and exact citation coordinates; excerpt-shaped and cross-source results cannot enter', async () => {
  const method = fictionalMethodDetails();
  const read = await readOrgMethod(client((path, init) => {
    assert.equal(path, '/org-knowledge/methods/' + id + '/2/2%3A0'); assert.equal(init?.cache, 'no-store');
    return { method };
  }), ref);
  assert.equal(read.content.counterexamples[0], '团队成果不能全部说成个人贡献。');
  for (const patch of [{ sourceId: '22222222-2222-4222-8222-222222222222' }, { revision: 3, passageId: '3:0' },
    { assetClass: 'question' }, { author_id: id }, { text: 'unexpected raw source' }])
    await assert.rejects(readOrgMethod(client(() => ({ method: { ...method, ...patch } })), ref));
  await assert.rejects(readOrgMethod(client(() => ({ passage: passage() })), ref));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(readOrgMethod(client(() => assert.fail('Pre-aborted request ran.')), ref, abort.signal));
  let current = true;
  await assert.rejects(readOrgMethod(client(() => { current = false; return { method }; }, () => current), ref));
  const during = new AbortController();
  await assert.rejects(readOrgMethod(client(() => { during.abort(); return { method }; }), ref, during.signal));
});
