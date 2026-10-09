import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readResumeDiff, type ResumeDiffClient, type ResumeDiffSelection } from '../src/resume-diff-api.ts';
import { resumePayloadDigest } from '../src/resume-review-api.ts';
const id = randomUUID(), owner = randomUUID();
async function response() { const sourceRefs = [{ kind: 'owner_resume_input' as const, id, revision: 1 as const } ] as const; const digest = (text: string) => resumePayloadDigest({ text, claims: [], source_refs: sourceRefs }); return { itemId: id, ownerId: owner, currentRevision: 2, from: { revision: 1, payloadDigest: await digest('Fictional old text') }, to: { revision: 2, payloadDigest: await digest('Fictional new text') }, sourceRefs, text: { prefix: 'Fictional ', removed: 'old', added: 'new', suffix: ' text' }, unresolvedClaims: [] }; }
const selection = (r: Awaited<ReturnType<typeof response>>): ResumeDiffSelection => ({ itemId: id, from: 1, to: 2, currentRevision: 2, currentDigest: r.to.payloadDigest });
function client(run: (path: string, init: RequestInit) => unknown) { let active = true; const c: ResumeDiffClient = { account: { accountId: owner, generation: 1 }, isCurrent: () => active, subscribe: () => () => {}, request: async (p, i = {}) => await run(p, i) as any }; return { c, invalidate() { active = false; } }; }
test('actual read coordinates and both reconstructed payload digests are checked before displaying private text', async () => {
    const r = await response(); const h = client((path, init) => { assert.equal(path, '/pending-items/' + id + '/diff?from=1&to=2'); assert.equal(init.method, undefined); assert.equal(init.body, undefined); return r; });
    assert.equal((await readResumeDiff(h.c, selection(r))).text.added, 'new');
    for (const patch of [{ ownerId: randomUUID() }, { itemId: randomUUID() }, { currentRevision: 3 }, { text: { ...r.text, removed: 'forged' } }, { text: { ...r.text, added: 'forged' } }, { from: { ...r.from, payloadDigest: 'a'.repeat(64) } }, { to: { ...r.to, payloadDigest: 'b'.repeat(64) } }]) await assert.rejects(readResumeDiff(client(() => ({ ...r, ...patch })).c, selection(r)));
});
test('stale account windows and aborted requests cannot send or display a comparison, including a late successful response', async () => {
    const r = await response(); let calls = 0; const h = client(() => { calls++; return r; }); h.invalidate(); await assert.rejects(readResumeDiff(h.c, selection(r))); assert.equal(calls, 0);
    const aborted = client(() => { calls++; return r; }); await assert.rejects(readResumeDiff(aborted.c, selection(r), AbortSignal.abort())); assert.equal(calls, 0);
    const late = client(() => { late.invalidate(); return r; }); await assert.rejects(readResumeDiff(late.c, selection(r)));
});
test('the selected current digest and ascending versions are captured; it cannot silently switch comparison targets', async () => {
    const r = await response(); let calls = 0; const h = client(() => { calls++; return r; });
    for (const patch of [{ from: 2 }, { from: 0 }, { to: 1 }, { currentRevision: 3 }]) await assert.rejects(readResumeDiff(h.c, { ...selection(r), ...patch })); assert.equal(calls, 0);
    await assert.rejects(readResumeDiff(h.c, { ...selection(r), currentDigest: 'a'.repeat(64) }));
});
