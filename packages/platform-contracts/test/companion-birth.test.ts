import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CompanionBirthContractError,
  parseActiveCompanion,
  parseCompanionBirthCommand,
  parseCompanionBirthIdempotencyKey,
  parseCompanionBirthReceipt,
  parseCompanionBirthReceiptObservation,
  parseCompanionBirthRequest,
  parseCompanionBirthResult,
  parseCompanionBirthViewerState,
} from '../src/companion-birth.ts';

// Fictional coordinates. These fixtures are projections, never evidence of a birth.
const id = (last: number) => `00000000-0000-4000-8000-${String(last).padStart(12, '0')}`;
const bornAt = '2026-10-07T18:23:45.123Z';

function birthReceipt() {
  return {
    kind: 'birth_receipt',
    id: id(1),
    idempotencyKey: id(2),
    bornAt,
    identity: {
      companionId: id(3),
      name: '墨',
      nameOrigin: 'user_typed',
      sealChar: '墨',
      inkToken: 'dai',
      personaRevision: 1,
      identityRevision: 2,
      selectionRevision: 3,
      sealAssetId: id(6),
    },
    main: { id: id(4), kind: 'main', companionId: id(3) },
    event: {
      id: id(5),
      conversationId: id(4),
      companionId: id(3),
      kind: 'event',
      event: 'companion_born',
      speakerKind: 'system',
      speakerSnapshot: {
        displayName: '系统',
        roleLabel: '系统',
        sealChar: null,
        inkToken: null,
        personaRevision: null,
      },
      createdAt: bornAt,
    },
  };
}

function activeCompanion() {
  return {
    kind: 'active_companion',
    companionId: id(3),
    status: 'active',
    bornAt,
    currentRevision: 1,
    identity: {
      name: '阿墨',
      nameOrigin: 'user_typed',
      sealChar: '墨',
      inkToken: 'dai',
      sealAssetId: id(6),
    },
    relationshipStage: 'familiar',
    main: { id: id(4), kind: 'main', companionId: id(3) },
  };
}

function rejects(parse: (value: unknown) => unknown, value: unknown, reason: string) {
  assert.throws(() => parse(value), CompanionBirthContractError, reason);
}

function assertDeepFrozen(value: unknown) {
  if (!value || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

test('the documented body and UUID header remain separate through canonical naming', () => {
  const body = { name: '  E\u0301lie  ', sealChar: '墨' };
  const command = parseCompanionBirthCommand(body, id(2));
  assert.deepEqual(command, {
    idempotencyKey: id(2),
    request: { name: 'Élie', sealChar: '墨' },
  });
  assert.deepEqual(parseCompanionBirthRequest({ name: '  Juno  Mae  ', sealChar: '如' }), {
    name: 'Juno  Mae', sealChar: '如',
  });
  assert.equal(body.name, '  E\u0301lie  ', 'parsing does not mutate the caller');
  assertDeepFrozen(command);

  for (const extra of [
    { idempotencyKey: id(2) },
    { operationId: id(2) },
    { expectedRevision: 1 },
    { companionId: id(3) },
    { userId: id(7) },
  ]) {
    rejects(parseCompanionBirthRequest, { ...body, ...extra }, 'header/owner coordinates are not body fields');
  }
  assert.throws(() => parseCompanionBirthCommand({ name: '墨', sealChar: '墨' }, undefined), CompanionBirthContractError);
  assert.throws(() => parseCompanionBirthCommand(body, { 'Idempotency-Key': id(2) }), CompanionBirthContractError);
  rejects(parseCompanionBirthRequest, { name: '墨' }, 'saved selection does not make the required seal body field optional');
  rejects(parseCompanionBirthRequest, { sealChar: '墨' }, 'saved naming does not make the required name body field optional');
  rejects(parseCompanionBirthRequest, command, 'an assembled command is not an HTTP body');
});

test('name limits count NFC characters and retain the existing naming spelling rules', () => {
  for (const [input, expected] of [
    ['墨', '墨'],
    ['墨墨墨墨墨墨', '墨墨墨墨墨墨'],
    ['a'.repeat(16), 'a'.repeat(16)],
    ['E\u0301'.repeat(16), 'É'.repeat(16)],
    ['\u00a0Élie\u00a0', 'Élie'],
    ['Ana-María', 'Ana-María'],
  ]) {
    assert.equal(parseCompanionBirthRequest({ name: input, sealChar: '墨' }).name, expected);
  }
  for (const name of [
    '', '   ', '墨墨墨墨墨墨墨', 'a'.repeat(17), 'E\u0301'.repeat(17),
    '墨Juno', 'Juno7', '--', 'Juno_Lee', 'Juno🙂', '墨\n', '\t墨',
    '<墨>', 'Jun\u202eo', 'Jun\u0000o', '\ud800',
  ]) {
    rejects(parseCompanionBirthRequest, { name, sealChar: '墨' }, `invalid name ${JSON.stringify(name)}`);
  }
  for (const sealChar of ['', '墨舟', ' 墨', '墨\n', 'M', '\ud800']) {
    rejects(parseCompanionBirthRequest, { name: '墨', sealChar }, 'the seal is exactly one Han character');
  }
});

test('syntax alone supplies neither semantic name approval nor a reviewed seal selection', () => {
  // Actual policy, same_as_user and current saved candidate membership belong to
  // the service transaction, not this codec or caller-provided approval flags.
  assert.deepEqual(parseCompanionBirthRequest({ name: '妈妈', sealChar: '导' }), {
    name: '妈妈', sealChar: '导',
  });
  for (const field of ['authorized', 'reviewApproved', 'safetyClear', 'canBirth', 'chatReady']) {
    rejects(parseCompanionBirthRequest, { name: '墨', sealChar: '墨', [field]: true }, field);
  }
});

test('birth requests cannot carry provider, model, voice or persona authority', () => {
  const body = { name: '墨', sealChar: '墨' };
  const controls: readonly (readonly [string, unknown])[] = [
    ['provider', 'example-provider'],
    ['model', 'example-model'],
    ['voice', 'example-voice'],
    ['voicePreset', id(8)],
    ['persona', 'caller instructions'],
    ['instructions', 'caller instructions'],
    ['inkToken', 'dai'],
    ['nameOrigin', 'inspiration_picked'],
    ['sealCandidates', ['墨', '舟', '启']],
  ];
  for (const [field, value] of controls) {
    rejects(parseCompanionBirthRequest, { ...body, [field]: value }, field);
  }
});

test('immutable origin, mutable profile, POST result and observations stay distinct', () => {
  const origin = birthReceipt();
  const active = activeCompanion();
  const result = { kind: 'birth_result', receipt: origin, replayed: true };
  assert.deepEqual(parseCompanionBirthReceipt(origin), origin);
  assert.deepEqual(parseActiveCompanion(active), active);
  assert.deepEqual(parseCompanionBirthResult(result), result);
  assert.deepEqual(parseCompanionBirthResult({ ...result, replayed: false }), { ...result, replayed: false });
  assert.deepEqual(parseCompanionBirthViewerState({ kind: 'active', companion: active }), { kind: 'active', companion: active });
  assert.deepEqual(parseCompanionBirthViewerState({ kind: 'not_born' }), { kind: 'not_born' });
  assert.deepEqual(parseCompanionBirthReceiptObservation({ kind: 'found', receipt: origin }), { kind: 'found', receipt: origin });
  assert.deepEqual(parseCompanionBirthReceiptObservation({ kind: 'not_found' }), { kind: 'not_found' });
  assert.equal(parseCompanionBirthReceipt(origin).identity.name, '墨');
  assert.equal(parseActiveCompanion(active).identity.name, '阿墨');

  for (const observation of [origin, active, result, { kind: 'active', companion: active }, { kind: 'found', receipt: origin }]) {
    assert.throws(() => parseCompanionBirthCommand(observation, id(2)), CompanionBirthContractError,
      'a replay or viewer must not be posted as a new command');
  }
  rejects(parseCompanionBirthResult, { kind: 'found', receipt: origin }, 'receipt lookup is not a POST result');
  rejects(parseCompanionBirthReceiptObservation, result, 'POST result is not a receipt lookup');
  rejects(parseCompanionBirthReceipt, active, 'current profile is not immutable origin');
  rejects(parseActiveCompanion, origin, 'immutable origin is not current profile');
  rejects(parseCompanionBirthViewerState, { kind: 'active', companion: origin }, 'viewer requires an active profile');
  rejects(parseCompanionBirthResult, { ...result, replayed: 'true' }, 'replay is an actual boolean');
  rejects(parseCompanionBirthViewerState, { kind: 'not_born', companion: active }, 'empty variant cannot hide an active profile');
  rejects(parseCompanionBirthReceiptObservation, { kind: 'not_found', receipt: origin }, 'missing variant cannot hide a receipt');
});

test('saved identity reads reject noncanonical spelling instead of silently rewriting history', () => {
  for (const name of [' 墨', '墨 ', 'E\u0301lie']) {
    const origin = birthReceipt();
    const active = activeCompanion();
    const invalidOrigin = { ...origin, identity: { ...origin.identity, name } };
    const invalidActive = { ...active, identity: { ...active.identity, name } };
    rejects(parseCompanionBirthReceipt, invalidOrigin, 'origin is already canonical');
    rejects(parseCompanionBirthResult, { kind: 'birth_result', receipt: invalidOrigin, replayed: true }, 'replay preserves origin');
    rejects(parseCompanionBirthReceiptObservation, { kind: 'found', receipt: invalidOrigin }, 'receipt lookup preserves origin');
    rejects(parseActiveCompanion, invalidActive, 'current saved name is already canonical');
    rejects(parseCompanionBirthViewerState, { kind: 'active', companion: invalidActive }, 'viewer does not repair profile');
  }
  const origin = birthReceipt();
  assert.equal(parseCompanionBirthReceipt({ ...origin, identity: { ...origin.identity, name: 'Élie' } }).identity.name, 'Élie');
});

test('mixed companion, room and event projections cannot form a birth receipt', () => {
  const origin = birthReceipt();
  const counterexamples = [
    { ...origin, identity: { ...origin.identity, companionId: id(9) } },
    { ...origin, main: { ...origin.main, companionId: id(9) } },
    { ...origin, event: { ...origin.event, companionId: id(9) } },
    { ...origin, main: { ...origin.main, id: id(9) } },
    { ...origin, event: { ...origin.event, conversationId: id(9) } },
    { ...origin, event: { ...origin.event, createdAt: '2026-10-07T18:23:45.124Z' } },
    { ...origin, bornAt: '2026-10-07T18:23:45.124Z' },
    { ...origin, main: { ...origin.main, kind: 'expert' } },
  ];
  for (const value of counterexamples) {
    rejects(parseCompanionBirthReceipt, value, 'one origin has one linked companion, main room and birth time');
    rejects(parseCompanionBirthReceiptObservation, { kind: 'found', receipt: value }, 'lookup cannot hide mixed origin');
    rejects(parseCompanionBirthResult, { kind: 'birth_result', receipt: value, replayed: true }, 'replay cannot hide mixed origin');
  }
  const active = activeCompanion();
  rejects(parseActiveCompanion, { ...active, main: { ...active.main, companionId: id(9) } }, 'active main must belong to that companion');
  rejects(parseCompanionBirthViewerState, { kind: 'active', companion: { ...active, companionId: id(9) } }, 'viewer preserves the main owner link');
});

test('the birth event remains a system line rather than C1, a letter or a model reply', () => {
  const origin = birthReceipt();
  for (const event of [
    { ...origin.event, kind: 'text' },
    { ...origin.event, event: 'first_letter' },
    { ...origin.event, speakerKind: 'companion' },
    { ...origin.event, content: '我是墨，名字是你起的。' },
    { ...origin.event, model: 'example-model' },
    { ...origin.event, speakerSnapshot: { ...origin.event.speakerSnapshot, displayName: '墨' } },
    { ...origin.event, speakerSnapshot: { ...origin.event.speakerSnapshot, roleLabel: 'AI 主理人' } },
    { ...origin.event, speakerSnapshot: { ...origin.event.speakerSnapshot, sealChar: '墨' } },
    { ...origin.event, speakerSnapshot: { ...origin.event.speakerSnapshot, inkToken: 'dai' } },
    { ...origin.event, speakerSnapshot: { ...origin.event.speakerSnapshot, personaRevision: 1 } },
  ]) {
    rejects(parseCompanionBirthReceipt, { ...origin, event }, 'system birth event has no ordinary companion identity or generated content');
  }
});

test('read DTOs reject internal fields at each nested projection boundary', () => {
  const origin = birthReceipt();
  for (const value of [
    { ...origin, userId: id(7) },
    { ...origin, sessionHash: 'private-session-hash' },
    { ...origin, requestCiphertext: 'private-request' },
    { ...origin, reviewApproved: true },
    { ...origin, identity: { ...origin.identity, styleCard: 'private-persona' } },
    { ...origin, identity: { ...origin.identity, sourceText: 'private-user-text' } },
    { ...origin, identity: { ...origin.identity, provider: 'example-provider' } },
    { ...origin, main: { ...origin.main, persona: 'private-persona' } },
    { ...origin, event: { ...origin.event, usage: { tokens: 1 } } },
    { ...origin, event: { ...origin.event, speakerSnapshot: { ...origin.event.speakerSnapshot, voicePreset: id(8) } } },
  ]) {
    rejects(parseCompanionBirthReceipt, value, 'private fields must not be stripped into a plausible public receipt');
  }
  const active = activeCompanion();
  rejects(parseActiveCompanion, { ...active, safetyClear: true }, 'active observation carries no safety authority');
  rejects(parseActiveCompanion, { ...active, identity: { ...active.identity, model: 'example-model' } }, 'profile has no model controls');
  rejects(parseCompanionBirthViewerState, { kind: 'not_born', canBirth: true }, 'viewer cannot grant birth');
  rejects(parseCompanionBirthReceiptObservation, { kind: 'not_found', authorized: true }, 'lookup cannot grant authority');
});

test('getters are rejected at body, nested event, profile and union boundaries without being invoked', () => {
  let reads = 0;
  const getter = () => { reads++; return 'private or executable value'; };
  const accessor = (value: object, field: string) => Object.defineProperty(value, field, {
    enumerable: true, configurable: true, get: getter,
  });
  rejects(parseCompanionBirthRequest, accessor({ name: '墨', sealChar: '墨' }, 'name'), 'body accessor');
  rejects(parseCompanionBirthRequest, accessor({ name: '墨', sealChar: '墨' }, 'provider'), 'unknown accessor');
  rejects(parseCompanionBirthReceipt, accessor(birthReceipt(), 'identity'), 'receipt accessor');
  const origin = birthReceipt();
  rejects(parseCompanionBirthReceipt, { ...origin, event: accessor(origin.event, 'conversationId') }, 'nested event accessor');
  const second = birthReceipt();
  rejects(parseCompanionBirthReceipt, {
    ...second, event: { ...second.event, speakerSnapshot: accessor(second.event.speakerSnapshot, 'displayName') },
  }, 'snapshot accessor');
  rejects(parseActiveCompanion, accessor(activeCompanion(), 'main'), 'active profile accessor');
  rejects(parseCompanionBirthViewerState, accessor({ kind: 'not_born' }, 'kind'), 'viewer discriminator accessor');
  rejects(parseCompanionBirthViewerState, accessor({ kind: 'active', companion: activeCompanion() }, 'companion'), 'viewer profile accessor');
  rejects(parseCompanionBirthReceiptObservation, accessor({ kind: 'found', receipt: birthReceipt() }, 'receipt'), 'observation accessor');
  rejects(parseCompanionBirthReceiptObservation, accessor({ kind: 'not_found' }, 'kind'), 'lookup discriminator accessor');
  assert.equal(reads, 0);
});

test('prototype, hidden and symbol injections cannot evade a closed body or nested receipt', () => {
  const body = { name: '墨', sealChar: '墨' };
  rejects(parseCompanionBirthRequest, Object.assign(Object.create({ provider: 'inherited' }), body), 'custom prototype');
  rejects(parseCompanionBirthRequest, Object.create(body), 'inherited required fields');
  rejects(parseCompanionBirthRequest, { ...body, [Symbol('model')]: 'private' }, 'symbol field');
  rejects(parseCompanionBirthRequest, Object.defineProperty({ ...body }, 'provider', { value: 'hidden' }), 'hidden unknown field');
  rejects(parseCompanionBirthRequest, Object.defineProperty({ ...body }, 'name', { enumerable: false }), 'hidden required field');
  rejects(parseCompanionBirthRequest, [body], 'array instead of body');
  const origin = birthReceipt();
  rejects(parseCompanionBirthReceipt, {
    ...origin, main: Object.assign(Object.create({ authorized: true }), origin.main),
  }, 'nested prototype');
  rejects(parseCompanionBirthReceipt, {
    ...origin, identity: { ...origin.identity, [Symbol('source')]: 'private' },
  }, 'nested symbol');
  assert.deepEqual(parseCompanionBirthRequest(Object.assign(Object.create(null), body)), body,
    'a data-only null prototype remains valid');
});

test('codecs copy and deeply freeze results without freezing or retaining caller objects', () => {
  const raw = birthReceipt();
  const parsed = parseCompanionBirthReceipt(raw);
  assertDeepFrozen(parsed);
  assert.notEqual(parsed, raw);
  assert.notEqual(parsed.identity, raw.identity);
  assert.notEqual(parsed.main, raw.main);
  assert.notEqual(parsed.event, raw.event);
  assert.notEqual(parsed.event.speakerSnapshot, raw.event.speakerSnapshot);
  assert.equal(Object.isFrozen(raw), false);
  assert.equal(Object.isFrozen(raw.identity), false);
  raw.identity.name = '阿墨';
  raw.main.id = id(9);
  raw.event.speakerSnapshot.displayName = 'changed';
  assert.equal(parsed.identity.name, '墨');
  assert.equal(parsed.main.id, id(4));
  assert.equal(parsed.event.speakerSnapshot.displayName, '系统');
  assert.equal(Reflect.set(parsed.identity, 'name', 'changed'), false);
  assert.equal(Reflect.set(parsed.event.speakerSnapshot, 'sealChar', '墨'), false);

  const projections = [
    parseCompanionBirthCommand({ name: '墨', sealChar: '墨' }, id(2)),
    parseCompanionBirthResult({ kind: 'birth_result', receipt: birthReceipt(), replayed: true }),
    parseActiveCompanion(activeCompanion()),
    parseCompanionBirthViewerState({ kind: 'active', companion: activeCompanion() }),
    parseCompanionBirthReceiptObservation({ kind: 'found', receipt: birthReceipt() }),
    parseCompanionBirthViewerState({ kind: 'not_born' }),
    parseCompanionBirthReceiptObservation({ kind: 'not_found' }),
  ];
  for (const projection of projections) assertDeepFrozen(projection);
});

test('UUIDs use the existing exact lowercase syntax without repairing headers or stored coordinates', () => {
  const key = 'abcdef01-2345-4000-8000-0123456789ab';
  assert.equal(parseCompanionBirthIdempotencyKey(key), key);
  assert.equal(parseCompanionBirthIdempotencyKey('00000000-0000-0000-0000-000000000000'),
    '00000000-0000-0000-0000-000000000000', 'syntax is not proof of a stored operation');
  for (const value of [
    undefined, null, 7, new String(key), key.toUpperCase(), ` ${key}`, `${key} `,
    `${key}\n`, key.replaceAll('-', ''), `{${key}}`, 'g' + key.slice(1), [key, key],
  ]) {
    rejects(parseCompanionBirthIdempotencyKey, value, 'one exact UUID header string');
  }
  const origin = birthReceipt();
  rejects(parseCompanionBirthReceipt, { ...origin, id: `${id(1)}\n` }, 'receipt ID exactness');
  rejects(parseCompanionBirthReceipt, { ...origin, identity: { ...origin.identity, sealAssetId: key.toUpperCase() } }, 'asset ID exactness');
  rejects(parseCompanionBirthReceipt, { ...origin, event: { ...origin.event, id: 'not-a-uuid' } }, 'event ID exactness');
});

test('birth times require real calendar dates and exact UTC milliseconds even when both copies agree', () => {
  const origin = birthReceipt();
  const at = (time: unknown) => ({ ...origin, bornAt: time, event: { ...origin.event, createdAt: time } });
  const leapDay = '2024-02-29T23:59:59.999Z';
  assert.equal(parseCompanionBirthReceipt(at(leapDay)).bornAt, leapDay);
  for (const time of [
    '2026-02-29T12:00:00.000Z', '2026-04-31T12:00:00.000Z',
    '2026-10-07T24:00:00.000Z', '2026-10-07T18:23:60.000Z',
    '2026-13-07T18:23:45.123Z', '2026-10-00T18:23:45.123Z',
    '2026-10-07T18:23:45Z', '2026-10-07T18:23:45.1230Z',
    '2026-10-07T18:23:45.123+00:00', '2026-10-07T11:23:45.123-07:00',
    '2026-10-07t18:23:45.123z', `${bornAt}\n`, ` ${bornAt}`,
    '+010000-01-01T00:00:00.000Z', 1791397425123, new Date(bornAt),
  ]) {
    rejects(parseCompanionBirthReceipt, at(time), 'matching malformed copies are still not a canonical stored time');
  }
  const active = activeCompanion();
  rejects(parseActiveCompanion, { ...active, bornAt: '2026-10-07T18:23:45Z' }, 'active profile shares the stored-time boundary');
});

test('identity and selection revisions are independent positive PostgreSQL integers', () => {
  const origin = birthReceipt();
  const max = { ...origin, identity: { ...origin.identity, identityRevision: 2147483647, selectionRevision: 1 } };
  assert.equal(parseCompanionBirthReceipt(max).identity.identityRevision, 2147483647);
  const otherMax = { ...origin, identity: { ...origin.identity, identityRevision: 1, selectionRevision: 2147483647 } };
  assert.equal(parseCompanionBirthReceipt(otherMax).identity.selectionRevision, 2147483647);
  for (const value of [0, -0, -1, 1.5, NaN, Infinity, 2147483648, Number.MAX_SAFE_INTEGER, '1', null, undefined, true]) {
    for (const field of ['identityRevision', 'selectionRevision']) {
      rejects(parseCompanionBirthReceipt, {
        ...origin, identity: { ...origin.identity, [field]: value },
      }, `${field} cannot imply a never-selected, fractional or overflowing revision`);
    }
  }
});

test('current source and persona limits reject unsupported inspiration or revision claims', () => {
  const origin = birthReceipt();
  rejects(parseCompanionBirthReceipt, {
    ...origin, identity: { ...origin.identity, nameOrigin: 'inspiration_picked' },
  }, 'only the implemented user-typed naming source is projected');
  for (const personaRevision of [0, 2, '1', null]) {
    rejects(parseCompanionBirthReceipt, {
      ...origin, identity: { ...origin.identity, personaRevision },
    }, 'current preparation is persona revision one');
  }
  const active = activeCompanion();
  rejects(parseActiveCompanion, { ...active, currentRevision: 2 }, 'later personality revisions need their actual implementation');
  rejects(parseActiveCompanion, { ...active, identity: { ...active.identity, nameOrigin: 'inspiration_picked' } }, 'active source uses the same real naming path');
  rejects(parseActiveCompanion, { ...active, status: 'awaiting_name' }, 'preparation is not active');
  rejects(parseActiveCompanion, { ...active, relationshipStage: 'partner' }, 'only current P0 relationship stages');
  rejects(parseCompanionBirthReceipt, { ...origin, identity: { ...origin.identity, inkToken: '#112233' } }, 'ink is the shared public token, not a caller color');
});
