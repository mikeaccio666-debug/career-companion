import test from 'node:test';
import assert from 'node:assert/strict';
import { CompanionWelcomeContractError, parseCompanionWelcomeObservation, parseCompanionWelcomeChoice, parseCompanionWelcomeOpen, parseCompanionWelcomeChoiceResult } from '../src/companion-welcome.ts';
const id = (n: number) => `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const at = '2026-10-08T12:00:00.000Z';
const welcome = () => ({ kind: 'welcome', id: id(1), companionId: id(2), conversationId: id(3),
    revision: 1, step: 'C1', choice: null, openedAt: at, updatedAt: at,
    intro: { id: id(4), kind: 'text', rendering: 'fixed_intro_v1', content: '虚构的初见内容，AI 主理人。', createdAt: at,
        speaker: { name: '墨', sealChar: '墨', inkToken: 'dai', personaRevision: 1 } } });
const command = () => ({ operationId: id(5), welcomeId: id(1), expectedRevision: 1, choice: 'begin' });
const rejected = (parse: (v: unknown) => unknown, values: unknown[]) => values.forEach(v => assert.throws(() => parse(v), CompanionWelcomeContractError));
test('C1 and next-path projections are immutable copies and distinguish missing introduction from a completed path', () => {
    const input = welcome(), parsed = parseCompanionWelcomeObservation(input);
    assert.equal(parsed.kind, 'welcome');
    if (parsed.kind !== 'welcome')
        return;
    input.intro.speaker.name = '另一个虚构名字';
    assert.equal(parsed.intro.speaker.name, '墨');
    assert(Object.isFrozen(parsed));
    assert(Object.isFrozen(parsed.intro));
    assert(Object.isFrozen(parsed.intro.speaker));
    for (const [step, choice] of [['C2', 'begin'], ['C7', 'direct_letter']])
        assert.equal(parseCompanionWelcomeObservation({ ...welcome(), revision: 2, step, choice }).kind, 'welcome');
    assert.deepEqual(parseCompanionWelcomeObservation({ kind: 'not_opened' }), { kind: 'not_opened' });
});
test('stage, revision, time and rendering inconsistencies cannot impersonate saved progress or model output', () => {
    const w = welcome();
    rejected(parseCompanionWelcomeObservation, [
        { ...w, revision: 2 }, { ...w, step: 'C2' }, { ...w, choice: 'begin' },
        { ...w, revision: 2, step: 'C7', choice: 'begin' }, { ...w, revision: 2, step: 'C2', choice: null },
        { ...w, updatedAt: '2026-10-08T11:59:59.999Z' },
        { ...w, intro: { ...w.intro, createdAt: '2026-10-08T12:00:00.001Z' } },
        { ...w, intro: { ...w.intro, rendering: 'model_generated' } },
        { ...w, intro: { ...w.intro, speaker: { ...w.intro.speaker, inkToken: 'unregistered' } } },
        { ...w, openedAt: '2026-10-08T12:00:00Z' },
    ]);
});
test('closed commands carry only actual source preconditions and explicit next path, never persona, grant or message input', () => {
    const input = command(), parsed = parseCompanionWelcomeChoice(input);
    input.choice = 'direct_letter';
    assert.equal(parsed.choice, 'begin');
    assert(Object.isFrozen(parsed));
    rejected(parseCompanionWelcomeChoice, [{ ...command(), welcomeId: undefined }, { ...command(), operationId: id(26).toUpperCase() },
        { ...command(), expectedRevision: 2 }, { ...command(), choice: 'submit_application' },
        { ...command(), persona: 'caller' }, { ...command(), approval: true }, { ...command(), content: 'caller' }]);
    assert.deepEqual(parseCompanionWelcomeOpen({ expectedCompanionId: id(2) }), { expectedCompanionId: id(2) });
    rejected(parseCompanionWelcomeOpen, [{}, { expectedCompanionId: id(2), consent: true }, { expectedCompanionId: 'not-a-source' }]);
});
test('accessors, prototypes, symbols and non-enumerable fields are rejected without executing getters', () => {
    let calls = 0;
    const accessor = { ...command() };
    Object.defineProperty(accessor, 'choice', { enumerable: true, get: () => { calls++; return 'begin'; } });
    const hidden = { ...command() };
    Object.defineProperty(hidden, 'choice', { value: 'begin', enumerable: false });
    rejected(parseCompanionWelcomeChoice, [accessor, hidden, Object.assign(Object.create({ inherited: true }), command()), { ...command(), [Symbol('extra')]: true }]);
    const kindGetter = { get kind() { calls++; return 'not_opened'; } };
    rejected(parseCompanionWelcomeObservation, [kindGetter, { kind: 'not_opened', extra: true }]);
    assert.equal(calls, 0);
    assert.deepEqual(parseCompanionWelcomeChoice(Object.assign(Object.create(null), command())), parseCompanionWelcomeChoice(command()));
});
test('choice acknowledgement must contain a saved next path and a closed operation receipt', () => {
    const state = { ...welcome(), revision: 2, step: 'C2', choice: 'begin' };
    const result = { state, operation: { id: id(5), appliedRevision: 2, replayed: false } };
    assert.equal(parseCompanionWelcomeChoiceResult(result).state.step, 'C2');
    rejected(parseCompanionWelcomeChoiceResult, [{ ...result, state: welcome() },
        { ...result, operation: { ...result.operation, replayed: 'yes' } }, { ...result, operation: { ...result.operation, appliedRevision: 1 } },
        { ...result, deliveredLetter: true }]);
});
