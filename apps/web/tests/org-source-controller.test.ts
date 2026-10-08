import test from 'node:test';
import assert from 'node:assert/strict';
import { OrgSourceController, type OrgSourceSnapshot } from '../src/org-source-controller.ts';
import type { OrgSourceClient } from '../src/org-source-api.ts';
const id = '11111111-1111-4111-8111-111111111111', ref = { sourceId: id, revision: 2, passageId: '2:0' };
const passage = { ...ref, title: 'Fictional source', text: 'Fictional words.', updatedAt: '2026-10-08T00:00:00.000Z',
  scope: 'org', assetClass: 'question', provenanceLabel: '蔓藤题库', provenance: 'untrusted_knowledge', deidentified: true, older: false, brand: '蔓藤', assetRevision: null };
function harness(run: (path: string, init: RequestInit) => unknown, timeout = 100) {
  let active = true; const listeners = new Set<() => void>(), updates: OrgSourceSnapshot[] = [];
  const client: OrgSourceClient = { account: { accountId: id }, isCurrent: () => active,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, request: async <T>(path: string, init: RequestInit = {}) => await run(path, init) as T };
  const controller = new OrgSourceController(client, ref, s => updates.push(s), timeout);
  return { controller, updates, invalidate() { active = false; for (const fn of [...listeners]) fn(); } };
}
async function until(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(r => setTimeout(r, 2)); } assert(check()); }
test('refresh and suspension clear loaded text before waiting; hidden-page request cannot later republish', async () => {
  let resolve: ((value: unknown) => void) | null = null, count = 0;
  const h = harness(() => ++count === 1 ? { passage } : new Promise(r => { resolve = r; }));
  h.controller.start(); await until(() => h.controller.snapshot().state === 'ready');
  const pending = h.controller.refresh(); assert.equal(h.controller.snapshot().passage, null); assert.equal(h.controller.snapshot().state, 'loading');
  h.controller.suspend(); assert.equal(h.controller.snapshot().state, 'idle'); assert.equal(h.controller.snapshot().passage, null);
  resolve!({ passage }); await pending; assert.equal(h.controller.snapshot().state, 'idle'); h.controller.stop();
});
test('older ignored-abort response cannot overwrite a newer generation', async () => {
  const pending: ((value: unknown) => void)[] = [], h = harness(() => new Promise(resolve => pending.push(resolve)));
  h.controller.start(); const next = h.controller.refresh(); assert.equal(pending.length, 2);
  pending[1]({ passage: { ...passage, text: 'Latest verified words.' } }); await next;
  pending[0]({ passage }); await new Promise(r => setTimeout(r, 0)); assert.equal(h.controller.snapshot().passage?.text, 'Latest verified words.'); h.controller.stop();
});
test('current revoked/stale/missing/admission responses erase content and map only fixed status/code pairs', async () => {
  for (const [status, code, state] of [[403, 'NOT_ENTITLED', 'denied'], [409, 'STALE_REVISION', 'stale'], [404, 'NOT_FOUND', 'missing'],
    [403, 'TERMS_CONFIRMATION_REQUIRED', 'account_inactive'], [503, 'private error details', 'unavailable'], [409, 'private error details', 'unavailable']] as const) {
    const h = harness(() => { throw { status, code, message: 'Private text never copied.' }; }); h.controller.start();
    await until(() => h.controller.snapshot().state !== 'loading'); assert.equal(h.controller.snapshot().state, state); assert.equal(h.controller.snapshot().passage, null);
    assert(!JSON.stringify(h.updates).includes('Private text')); h.controller.stop();
  }
});
test('timeout settles even if transport ignores abort; later content and old callbacks stay discarded after account invalidation', async () => {
  let resolve: (v: unknown) => void = () => {}, signal: AbortSignal | undefined;
  const h = harness((_path, init) => { signal = init.signal!; return new Promise(r => { resolve = r; }); }, 3);
  h.controller.start(); await until(() => h.controller.snapshot().state === 'unavailable'); assert(signal?.aborted);
  h.invalidate(); resolve({ passage }); await new Promise(r => setTimeout(r, 5)); assert.equal(h.controller.snapshot().passage, null); assert.equal(h.controller.snapshot().state, 'idle');
  await h.controller.refresh(); assert.equal(h.controller.snapshot().state, 'idle');
});
