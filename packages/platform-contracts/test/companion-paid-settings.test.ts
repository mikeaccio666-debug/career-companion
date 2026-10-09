import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseCompanionPaidSettings, parseCompanionPaidSettingsCommand } from '../src/companion-paid-settings.ts';
const state = { ownerId: randomUUID(), companionId: randomUUID(), paidSuggestionsMode: 'when_relevant', revision: 0, updatedAt: null, lastOperationId: null };
test('default preference is not an owner-confirmed version; positive revisions require real receipt coordinates', () => {
    assert(Object.isFrozen(parseCompanionPaidSettings(state)));
    for (const patch of [{ paidSuggestionsMode: 'only_when_asked' }, { lastOperationId: randomUUID() }, { revision: 1 }, { revision: -0 }, { unknown: true }])
        assert.throws(() => parseCompanionPaidSettings({ ...state, ...patch }));
    assert.equal(parseCompanionPaidSettings({ ...state, paidSuggestionsMode: 'only_when_asked', revision: 1, updatedAt: '2026-10-08T00:00:00.000Z', lastOperationId: randomUUID() }).revision, 1);
});
test('owner command is closed and versioned, and rejects caller sources and accessors', () => {
    const c = { companionId: state.companionId, operationId: randomUUID(), expectedRevision: 0, paidSuggestionsMode: 'only_when_asked' };
    assert(Object.isFrozen(parseCompanionPaidSettingsCommand(c)));
    for (const patch of [{ ownerId: state.ownerId }, { provider: 'fictional' }, { expectedRevision: 2147483647 }, { paidSuggestionsMode: 'always' }, { confirmed: true }])
        assert.throws(() => parseCompanionPaidSettingsCommand({ ...c, ...patch }));
    let read = false;
    assert.throws(() => parseCompanionPaidSettingsCommand({ ...c, get paidSuggestionsMode() { read = true; return 'when_relevant'; } }));
    assert.equal(read, false);
});
