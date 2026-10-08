import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ApiError, type BoundPlatformClient } from '../src/api.ts';
import { CareerIdentityController } from '../src/career-identity-controller.ts';
const owner = randomUUID(), id = randomUUID(), at = '2026-10-08T10:00:00.000Z';
const entry = { kind: 'available', ownerId: owner, stage: 'opt', source: { draftId: randomUUID(), revision: 10 } };
const intent = () => ({ action: 'create' as const, id: null, body: { operationId: randomUUID(), expectedRevision: 0, field: 'program_end_date', value: '2028-02-29', label: null } });
function response(body: any, replayed = false) { return { record: { id, ownerId: owner, field: body.field, value: body.value, label: body.label, source: 'user_entered', sensitivity: 'sensitive', confirmedAt: at, remindBeforeDays: null, revision: 1, createdAt: at, updatedAt: at, lastOperationId: body.operationId }, operation: { id: body.operationId, recordId: id, action: 'create', appliedRevision: 1, replayed } }; }
function harness(run: (path: string, init: RequestInit) => unknown) {
    let active = true;
    const listeners = new Set<() => void>(), updates: any[] = [];
    const client = { account: { accountId: owner, generation: 1 }, isCurrent: () => active, subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); }, request: async (path: string, init: RequestInit = {}) => await run(path, init) } as BoundPlatformClient;
    const controller = new CareerIdentityController(client, s => updates.push(s), { read: 100, write: 20 });
    return { controller, updates, invalidate() { active = false; for (const fn of [...listeners])
            fn(); } };
}
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) {
    if (check())
        return;
    await new Promise(resolve => setTimeout(resolve, 2));
} assert(check(), 'controller should reach the requested state'); }
test('a declined or unproven actual entry never requests saved values, offers a recording intent or turns dates into a qualifying identity', async () => {
    const paths: string[] = [];
    const h = harness(path => { paths.push(path); return { kind: 'hidden', ownerId: owner }; });
    h.controller.start();
    await until(() => h.controller.snapshot().entry !== null);
    h.controller.begin(intent());
    assert.deepEqual(paths, ['/career/identity/entry']);
    assert.equal(h.controller.snapshot().pending, null);
    assert.equal(h.controller.snapshot().records.length, 0);
    h.controller.stop();
});
test('lost response preserves the original command; missing observer result is not confirmation and original retry produces one accepted effect', async () => {
    const posts: string[] = [], records = new Map<string, unknown>();
    let effects = 0;
    const h = harness((path, init) => {
        if (path === '/career/identity/entry')
            return entry;
        if (path === '/career/identity' && !init.method)
            return { records: [] };
        if (path.includes('/operations/'))
            throw new ApiError('Not yet observed', 404, 'NOT_FOUND');
        const body = JSON.parse(String(init.body));
        posts.push(body.operationId);
        const old = records.get(body.operationId);
        if (old)
            return response(body, true);
        effects++;
        records.set(body.operationId, response(body));
        throw Error('response lost after actual acceptance');
    });
    h.controller.start();
    await until(() => !h.controller.snapshot().busy && h.controller.snapshot().entry !== null);
    const original = intent();
    h.controller.begin(original);
    await until(() => h.controller.snapshot().uncertain);
    await h.controller.observe();
    assert.equal((h.controller.snapshot().pending!.body as any).operationId, original.body.operationId);
    h.controller.begin(intent());
    assert.equal(posts.length, 1);
    await h.controller.retry();
    assert.deepEqual(posts, [original.body.operationId, original.body.operationId]);
    assert.equal(effects, 1);
    assert.equal(h.controller.snapshot().pending, null);
    assert.equal(h.controller.snapshot().records[0].lastOperationId, original.body.operationId);
    h.controller.stop();
});
test('write timeout cannot turn a late HTTP response into confirmation; a successful original observer resolves it explicitly', async () => {
    let resolve!: (v: unknown) => void, saved: any;
    const h = harness((path, init) => {
        if (path === '/career/identity/entry')
            return entry;
        if (path === '/career/identity' && !init.method)
            return { records: [] };
        if (path.includes('/operations/'))
            return { ...saved, operation: { ...saved.operation, replayed: true } };
        saved = response(JSON.parse(String(init.body)));
        return new Promise(r => { resolve = r; });
    });
    h.controller.start();
    await until(() => !h.controller.snapshot().busy && h.controller.snapshot().entry !== null);
    h.controller.begin(intent());
    await until(() => h.controller.snapshot().uncertain);
    resolve(saved);
    await new Promise(r => setTimeout(r, 5));
    assert.equal(h.controller.snapshot().records.length, 0);
    assert(h.controller.snapshot().pending);
    await h.controller.observe();
    assert.equal(h.controller.snapshot().records.length, 1);
    assert.equal(h.controller.snapshot().uncertain, false);
    h.controller.stop();
});
test('account invalidation aborts the accepted request and discards private values and intent; late responses cannot repaint another account', async () => {
    let resolve!: (v: unknown) => void, signal: AbortSignal | null = null, saved: any;
    const h = harness((path, init) => {
        if (path === '/career/identity/entry')
            return entry;
        if (path === '/career/identity' && !init.method)
            return { records: [] };
        signal = init.signal as AbortSignal;
        saved = response(JSON.parse(String(init.body)));
        return new Promise(r => { resolve = r; });
    });
    h.controller.start();
    await until(() => !h.controller.snapshot().busy && h.controller.snapshot().entry !== null);
    h.controller.begin(intent());
    await until(() => signal !== null);
    h.invalidate();
    assert((signal as unknown as AbortSignal).aborted);
    resolve(saved);
    await new Promise(r => setTimeout(r, 5));
    assert.equal(h.controller.snapshot().entry, null);
    assert.equal(h.controller.snapshot().records.length, 0);
    assert.equal(h.controller.snapshot().pending, null);
    assert(h.updates.at(-1).entry === null);
});
test('a known revision conflict does not claim success or discard the owner editor; a refreshed list is required for another version', async () => {
    const h = harness((path, init) => path.endsWith('/entry') ? entry : !init.method ? { records: [] } : Promise.reject(new ApiError('changed', 409, 'CAREER_IDENTITY_REVISION_CHANGED')));
    h.controller.start();
    await until(() => !h.controller.snapshot().busy && h.controller.snapshot().entry !== null);
    h.controller.begin(intent());
    await until(() => !h.controller.snapshot().busy);
    assert.equal(h.controller.snapshot().pending, null);
    assert.equal(h.controller.snapshot().lastResult, null);
    assert.equal(h.controller.snapshot().uncertain, false);
    assert(h.controller.snapshot().error.includes('重新读取'));
    h.controller.stop();
});
test('restarting the same captured controller cannot let an aborted prior read clear the new read status', async () => {
    let requests = 0;
    const resolves: Array<(v: unknown) => void> = [];
    const h = harness((path) => { if (path.endsWith('/entry')) {
        requests++;
        return new Promise(r => resolves.push(r));
    } return { records: [] }; });
    h.controller.start();
    await until(() => requests === 1);
    h.controller.stop();
    h.controller.start();
    await until(() => requests === 2);
    await new Promise(r => setTimeout(r, 5));
    assert.equal(h.controller.snapshot().busy, true);
    assert.equal(h.controller.snapshot().error, '');
    resolves[1](entry);
    await until(() => h.controller.snapshot().entry !== null);
    resolves[0]({ kind: 'hidden', ownerId: owner });
    await new Promise(r => setTimeout(r, 5));
    assert.equal(h.controller.snapshot().entry?.kind, 'available');
    h.controller.stop();
});
