import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CareerTargetController } from '../src/career-target-controller.ts';
import { readCareerTargets, changeCareerTarget, type CareerTargetClient } from '../src/career-target-api.ts';
import { ApiError } from '../src/api-error.ts';
const owner = randomUUID(), id = randomUUID(), at = '2026-10-08T00:00:00.000Z';
const command = () => ({ operationId: randomUUID(), expectedRevision: 0, roleFamily: 'da', title: 'Fictional direction', locations: [], priority: 1, reviewOn: '2028-02-29' });
function saved(body: any, replayed = false) { const { expectedRevision, operationId, ...fields } = body; return { target: { ...fields, id, ownerId: owner, status: 'exploring', source: 'user_entered', proposedBy: null, revision: expectedRevision + 1, lastOperationId: operationId, createdAt: at, updatedAt: at }, operation: { id: operationId, targetId: id, appliedRevision: expectedRevision + 1, replayed } }; }
function harness(run: (path: string, init: RequestInit) => unknown) {
    let active = true; const listeners = new Set<() => void>();
    const client: CareerTargetClient = { account: { accountId: owner, generation: 1 }, isCurrent: () => active, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, request: async (path, init = {}) => await run(path, init) as any };
    return { client, controller: new CareerTargetController(client, () => {}, 40), invalidate() { active = false; for (const fn of [...listeners]) fn(); } };
}
async function until(check: () => boolean) { for (let i = 0; i < 150; i++) { if (check()) return; await new Promise(r => setTimeout(r, 2)); } assert(check()); }
async function ready(h: ReturnType<typeof harness>) { h.controller.start(); await until(() => h.controller.snapshot().loaded && !h.controller.snapshot().busy); }
test('lost acknowledgement retains one frozen command across reads and missing observation; retry performs no duplicate effect', async () => {
    let receipt: any, effects = 0; const writes: any[] = [];
    const h = harness((path, init) => { if (path.includes('/operations/')) throw new ApiError('Missing', 404, 'NOT_FOUND'); if (!init.method) return { targets: receipt ? [receipt.target] : [] }; const body = JSON.parse(String(init.body)); writes.push(body); if (receipt) return { ...receipt, operation: { ...receipt.operation, replayed: true } }; effects++; receipt = saved(body); throw Error('Lost'); });
    await ready(h); h.controller.begin('create', null, command()); await until(() => h.controller.snapshot().uncertain);
    const original = h.controller.snapshot().pending!; assert(Object.isFrozen(original)); assert(Object.isFrozen(original.body));
    await h.controller.observe(); assert.equal(h.controller.snapshot().pending, original);
    await h.controller.refresh(); assert.equal(h.controller.snapshot().pending, original);
    h.controller.begin('create', null, command()); assert.equal(writes.length, 1);
    await h.controller.retry(); assert.equal(effects, 1); assert.deepEqual(writes[0], writes[1]); assert.equal(h.controller.snapshot().pending, null); assert.equal(h.controller.snapshot().targets.length, 1); h.controller.stop();
});
test('read-only observation accepts later revision or deletion and never sends a mutation', async () => {
    for (const deleted of [false, true]) {
        let receipt: any, writes = 0;
        const h = harness((path, init) => { if (path.includes('/operations/')) { assert.equal(init.method, undefined); assert.equal(init.body, undefined); return { ...receipt, target: deleted ? null : { ...receipt.target, revision: 3, lastOperationId: randomUUID(), reviewOn: null }, operation: { ...receipt.operation, replayed: true } }; } if (!init.method) return { targets: [] }; writes++; receipt = saved(JSON.parse(String(init.body))); throw Error('Lost'); });
        await ready(h); h.controller.begin('create', null, command()); await until(() => h.controller.snapshot().uncertain); await h.controller.observe();
        assert.equal(writes, 1); assert.equal(h.controller.snapshot().pending, null); assert.match(h.controller.snapshot().notice, deleted ? /移除/ : /之后保存/); assert.equal(h.controller.snapshot().targets.length, deleted ? 0 : 1); h.controller.stop();
    }
});
test('non-cooperating timed-out request cannot hang, late success cannot overwrite a recovered result, offline resume only reads', async () => {
    let resolve!: (v: unknown) => void, body: any, writes = 0;
    const h = harness((path, init) => { if (path.includes('/operations/')) return saved(body, true); if (!init.method) return { targets: [] }; writes++; body = JSON.parse(String(init.body)); return new Promise(r => resolve = r); });
    await ready(h); h.controller.begin('create', null, command()); await until(() => h.controller.snapshot().uncertain); const original = h.controller.snapshot().pending;
    h.controller.suspend(); assert.equal(h.controller.snapshot().loaded, false); assert.equal(h.controller.snapshot().pending, original);
    h.controller.resume(); await until(() => h.controller.snapshot().loaded); assert.equal(writes, 1); await h.controller.observe();
    resolve({ target: null, operation: { ...saved(body).operation, replayed: true } }); await new Promise(r => setTimeout(r, 5));
    assert.equal(h.controller.snapshot().targets.length, 1); assert.equal(h.controller.snapshot().pending, null); h.controller.stop();
});
test('failed refresh hides stale list without discarding pending intent; observing one target requires rereading the complete list', async () => {
    let failRead = false, receipt: any;
    const h = harness((path, init) => { if (path.includes('/operations/')) return { ...receipt, operation: { ...receipt.operation, replayed: true } }; if (!init.method) { if (failRead) throw Error('Offline'); return { targets: receipt ? [receipt.target] : [] }; } receipt = saved(JSON.parse(String(init.body))); throw Error('Lost'); });
    await ready(h); h.controller.begin('create', null, command()); await until(() => h.controller.snapshot().uncertain);
    failRead = true; await h.controller.refresh(); assert.equal(h.controller.snapshot().loaded, false); assert(h.controller.snapshot().pending);
    await h.controller.observe(); assert.equal(h.controller.snapshot().pending, null); assert.equal(h.controller.snapshot().loaded, false); assert.deepEqual(h.controller.snapshot().targets, []);
    failRead = false; await h.controller.refresh(); assert.equal(h.controller.snapshot().targets.length, 1); h.controller.stop();
});
test('definitive revision conflict requires re-read and fresh owner intent; stale editor is rejected before transport', async () => {
    let writes = 0; const body = command(), record = saved(body).target;
    const h = harness((_p, init) => { if (init.method) { writes++; throw new ApiError('Changed', 409, 'CAREER_TARGET_REVISION_CHANGED'); } return { targets: [record] }; });
    await ready(h); h.controller.begin('edit', id, { operationId: randomUUID(), expectedRevision: 2, title: 'Fictional correction' }); assert.equal(writes, 0);
    h.controller.begin('edit', id, { operationId: randomUUID(), expectedRevision: 1, title: 'Fictional correction' }); await until(() => !h.controller.snapshot().busy);
    assert.equal(h.controller.snapshot().pending, null); assert.equal(h.controller.snapshot().loaded, false); h.controller.begin('create', null, command()); assert.equal(writes, 1); h.controller.stop();
});
test('account invalidation and strict-mode stop/start clear private state and ignore prior async completions', async () => {
    let resolve!: (v: unknown) => void, reads = 0;
    const h = harness(() => { if (++reads === 1) return new Promise(r => resolve = r); return { targets: [] }; });
    h.controller.start(); h.controller.stop(); h.controller.start(); await until(() => h.controller.snapshot().loaded);
    resolve({ targets: [saved(command()).target] }); await new Promise(r => setTimeout(r, 5)); assert.equal(h.controller.snapshot().targets.length, 0);
    h.invalidate(); assert.equal(h.controller.snapshot().loaded, false); assert.equal(h.controller.snapshot().pending, null);
});
test('transport enforces current client before sending and after empty/deleted responses, and GET recovery requires a replay acknowledgement', async () => {
    let calls = 0; const h = harness(() => { calls++; return { targets: [] }; }); h.invalidate(); await assert.rejects(readCareerTargets(h.client)); await assert.rejects(changeCareerTarget(h.client, 'create', null, command())); assert.equal(calls, 0);
    const pending = command(); const late = harness(() => { late.invalidate(); return { target: null, operation: { ...saved(pending).operation, replayed: true } }; }); await assert.rejects(changeCareerTarget(late.client, 'create', null, pending, undefined, true));
    const staleRead = harness(() => { staleRead.invalidate(); return { targets: [] }; }); await assert.rejects(readCareerTargets(staleRead.client));
    await assert.rejects(changeCareerTarget(harness(() => saved(pending)).client, 'create', null, pending, undefined, true));
});
