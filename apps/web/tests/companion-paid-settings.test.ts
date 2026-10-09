import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PaidSettingsController } from '../src/companion-paid-settings-controller.ts';
import { readPaidSettings, changePaidSettings, type PaidSettingsClient } from '../src/companion-paid-settings-api.ts';
import { ApiError } from '../src/api-error.ts';
const owner = randomUUID(), companionId = randomUUID(), at = '2026-10-08T00:00:00.000Z';
const initial = { ownerId: owner, companionId, paidSuggestionsMode: 'when_relevant', revision: 0, updatedAt: null, lastOperationId: null };
const cmd = () => ({ companionId, operationId: randomUUID(), expectedRevision: 0, paidSuggestionsMode: 'only_when_asked' });
function saved(c: any, replayed = false) { return { settings: { ...initial, paidSuggestionsMode: c.paidSuggestionsMode, revision: c.expectedRevision + 1, updatedAt: at, lastOperationId: c.operationId }, operation: { id: c.operationId, appliedRevision: c.expectedRevision + 1, paidSuggestionsMode: c.paidSuggestionsMode, replayed } }; }
function harness(run: (path: string, init: RequestInit) => unknown) { let active = true; const listeners = new Set<() => void>(); const client: PaidSettingsClient = { account: { accountId: owner, generation: 1 }, isCurrent: () => active, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, request: async (p, i = {}) => await run(p, i) as any }; return { client, controller: new PaidSettingsController(client, () => { }, 40), invalidate() { active = false; for (const f of [...listeners])
        f(); } }; }
async function until(check: () => boolean) { for (let i = 0; i < 150; i++) {
    if (check())
        return;
    await new Promise(r => setTimeout(r, 2));
} assert(check()); }
async function ready(h: ReturnType<typeof harness>) { h.controller.start(); await until(() => h.controller.snapshot().loaded && !h.controller.snapshot().busy); }
test('lost acknowledgement retains one frozen command; reads and missing observations cannot discard it, and retry has one effect', async () => {
    let receipt: any, effects = 0;
    const writes: any[] = [];
    const h = harness((path, init) => { if (path.includes('/operations/'))
        throw new ApiError('Not found', 404, 'NOT_FOUND'); if (!init.method)
        return { settings: receipt?.settings ?? initial }; const body = JSON.parse(String(init.body)); writes.push(body); if (receipt)
        return { ...receipt, operation: { ...receipt.operation, replayed: true } }; effects++; receipt = saved(body); throw Error('Fictional lost acknowledgement'); });
    await ready(h);
    h.controller.begin('only_when_asked');
    await until(() => h.controller.snapshot().uncertain);
    assert(Object.isFrozen(h.controller.snapshot().pending));
    await h.controller.observe();
    assert(h.controller.snapshot().pending);
    await h.controller.refresh();
    assert(h.controller.snapshot().pending);
    h.controller.begin('when_relevant');
    assert.equal(writes.length, 1);
    await h.controller.retry();
    assert.equal(effects, 1);
    assert.deepEqual(writes[0], writes[1]);
    assert.equal(h.controller.snapshot().pending, null);
    assert.equal(h.controller.snapshot().settings?.paidSuggestionsMode, 'only_when_asked');
    h.controller.stop();
});
test('original observation may return a newer owner choice without claiming the earlier choice is still current', async () => {
    let command: any;
    const h = harness((path, init) => { if (path.includes('/operations/')) {
        const r = saved(command, true);
        return { ...r, settings: { ...r.settings, paidSuggestionsMode: 'when_relevant', revision: 2, lastOperationId: randomUUID() } };
    } if (init.method) {
        command = JSON.parse(String(init.body));
        throw Error('Lost');
    } return { settings: initial }; });
    await ready(h);
    h.controller.begin('only_when_asked');
    await until(() => h.controller.snapshot().uncertain);
    await h.controller.observe();
    assert.equal(h.controller.snapshot().pending, null);
    assert.equal(h.controller.snapshot().settings?.paidSuggestionsMode, 'when_relevant');
    assert.match(h.controller.snapshot().notice, /之后保存/);
    h.controller.stop();
});
test('timeouts are bounded; offline/resume only read, preserve the original command, and reject a late response after account expiry', async () => {
    let resolve!: (v: unknown) => void, command: any, writes = 0;
    const h = harness((_path, init) => { if (init.method) {
        writes++;
        command = JSON.parse(String(init.body));
        return new Promise(r => resolve = r);
    } return { settings: initial }; });
    await ready(h);
    h.controller.begin('only_when_asked');
    await until(() => h.controller.snapshot().uncertain);
    const original = h.controller.snapshot().pending;
    h.controller.suspend();
    assert.equal(h.controller.snapshot().settings, null);
    assert.equal(h.controller.snapshot().pending, original);
    h.controller.resume();
    await until(() => h.controller.snapshot().loaded);
    assert.equal(writes, 1);
    assert.equal(h.controller.snapshot().pending, original);
    h.invalidate();
    resolve(saved(command));
    await new Promise(r => setTimeout(r, 4));
    assert.equal(h.controller.snapshot().pending, null);
    assert.equal(h.controller.snapshot().settings, null);
    assert.equal(h.controller.snapshot().loaded, false);
});
test('definitive version conflict requires a fresh read and new owner decision, while a failed read conceals stale choices', async () => {
    let fail = false, writes = 0;
    const h = harness((_p, init) => { if (init.method) {
        writes++;
        throw new ApiError('Changed', 409, 'PAID_SETTINGS_REVISION_CHANGED');
    } if (fail)
        throw Error('Missing'); return { settings: initial }; });
    await ready(h);
    h.controller.begin('only_when_asked');
    await until(() => !h.controller.snapshot().busy);
    assert.equal(h.controller.snapshot().pending, null);
    assert.equal(h.controller.snapshot().settings, null);
    h.controller.begin('when_relevant');
    assert.equal(writes, 1);
    await h.controller.refresh();
    fail = true;
    await h.controller.refresh();
    assert.equal(h.controller.snapshot().settings, null);
    assert.equal(h.controller.snapshot().loaded, false);
    h.controller.stop();
});
test('transport rejects cross-owner, substituted modes, wrong companion, operation and revision; stale clients never send', async () => {
    const c = cmd(), receipt = saved(c);
    for (const value of [
        { ...receipt, settings: { ...receipt.settings, ownerId: randomUUID() } }, { ...receipt, settings: { ...receipt.settings, companionId: randomUUID() } },
        { ...receipt, settings: { ...receipt.settings, paidSuggestionsMode: 'when_relevant' } }, { ...receipt, operation: { ...receipt.operation, id: randomUUID() } },
        { ...receipt, operation: { ...receipt.operation, paidSuggestionsMode: 'when_relevant' } }, { ...receipt, settings: { ...receipt.settings, revision: 2 } }
    ])
        await assert.rejects(changePaidSettings(harness(() => value).client, c));
    await assert.rejects(changePaidSettings(harness(() => receipt).client, c, true));
    let calls = 0;
    const h = harness(() => { calls++; return { settings: initial }; });
    h.invalidate();
    await assert.rejects(readPaidSettings(h.client));
    await assert.rejects(changePaidSettings(h.client, c));
    assert.equal(calls, 0);
});
test('strict-mode stop/start does not replay a write or revive private state from an old read', async () => {
    let resolve!: (v: unknown) => void, reads = 0;
    const h = harness((_p, init) => { assert(!init.method); if (++reads === 1)
        return new Promise(r => resolve = r); return { settings: initial }; });
    h.controller.start();
    h.controller.stop();
    h.controller.start();
    await until(() => h.controller.snapshot().loaded);
    resolve({ settings: { ...initial, ownerId: randomUUID() } });
    await new Promise(r => setTimeout(r, 4));
    assert.equal(h.controller.snapshot().settings?.ownerId, owner);
    h.controller.stop();
});
