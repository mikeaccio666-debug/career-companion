import test from 'node:test';
import assert from 'node:assert/strict';
import { companionLatinSealInitials, companionSealCandidates, companionSealCandidatesV2, parseCompanionIdentityPolicy,
  parseCompanionIdentityPolicyV2, validateCompanionNameV2, CompanionIdentityError, CompanionNameError,
  type CompanionIdentityPolicy, type CompanionIdentityPolicyV2 } from '../src/companion/identity.ts';
import type { CompanionDimensions } from '../src/companion/mapping.ts';

const id = '00000000-0000-4000-8000-000000000123';
const dimensions: CompanionDimensions = { warmth: 0, directness: 0, drive: 0, structure: 0, levity: 0, code_mix: 0, length: 'medium' };
// Fictional total maps test software coverage, not linguistic quality, approved
// production copy or membership of the real standard-character vocabulary.
const base = (): CompanionIdentityPolicy => ({ familyOrPartner: [], teamOrOrg: [], abusive: [], publicFigures: [],
  allowedSealCharacters: ['墨', '舟', '启', '朗', '如'], englishSealAliases: [{ name: 'Juno', sealChar: '如' }] });
const fixture = (): CompanionIdentityPolicyV2 => ({ ...base(), englishSealRules: { normalization: 'latin_nfkd_initial_v1',
  initials: companionLatinSealInitials().map(spelling => ({ spelling, sealChar: '舟', reason: '虚构首字母规则，用于测试，不是实际发音证明。' })),
  prefixes: [{ spelling: 'mi', sealChar: '墨', reason: '虚构较短拼写规则。' }, { spelling: 'milo', sealChar: '朗', reason: '虚构较长拼写规则。' }] } });
const candidates = (name: string, policy = fixture()) => companionSealCandidatesV2({ companionId: id, name, dimensions, policy });

test('V1 exact-only policy and all canonical bytes/reasons stay unchanged', () => {
  const original = base(), bytes = JSON.stringify(original);
  assert.equal(JSON.stringify(parseCompanionIdentityPolicy(original)), bytes);
  assert.deepEqual(candidates('Juno'), companionSealCandidates({ companionId: id, name: 'Juno', dimensions, policy: original }));
  assert.throws(() => companionSealCandidates({ companionId: id, name: 'Milo', dimensions, policy: original }),
    (error: unknown) => error instanceof CompanionIdentityError && error.code === 'SEAL_CANDIDATES_UNAVAILABLE');
  assert.throws(() => parseCompanionIdentityPolicy(fixture()), CompanionIdentityError);
});
test('exact aliases win; otherwise longest approved prefix then approved starter supplies one related glyph', () => {
  assert.equal(candidates('jUnO')[0].char, '如'); assert.equal(candidates('Milo')[0].char, '朗');
  assert.equal(candidates('Mirage')[0].char, '墨'); assert.equal(candidates('Zelda')[0].char, '舟');
  assert.match(candidates('Milo')[0].reason, /较长/);
  assert.deepEqual(candidates('Milo'), candidates('Milo'));
  for (const value of ['Milo', 'Zelda', 'Åda', 'Łódź', 'Æon', 'ßeta', 'Ｌｕｍｅｎ', 'Jean-Luc', '- Ana', 'Élodie', '墨']) {
    const output = candidates(value); assert.equal(output.length, 3); assert.equal(new Set(output.map(item => item.char)).size, 3);
    assert.ok(output.every(item => base().allowedSealCharacters.includes(item.char)));
  }
});
test('total normalized starter map covers every legal current Unicode Latin first letter without changing saved spelling', () => {
  const policy = parseCompanionIdentityPolicyV2(fixture());
  for (const scalar of companionLatinSealInitials()) {
    assert.equal(candidates(`${scalar}a`, policy)[0].char, '舟');
  }
  assert.equal(validateCompanionNameV2({ name: ' E\u0301lodie ', userName: '虚构用户', policy }), 'Élodie');
  assert.equal(validateCompanionNameV2({ name: 'Ｌｕｍｅｎ', userName: '虚构用户', policy }), 'Ｌｕｍｅｎ');
  assert.equal(Object.isFrozen(companionLatinSealInitials()), true);
});
test('missing/duplicate starter, out-of-vocabulary output and unsupported normalization fail closed as asset errors', () => {
  const value = fixture(), rules = value.englishSealRules;
  for (const replacement of [
    { ...rules, initials: rules.initials.slice(1) },
    { ...rules, initials: [...rules.initials, rules.initials[0]] },
    { ...rules, initials: [{ ...rules.initials[0], sealChar: '界' }, ...rules.initials.slice(1)] },
    { ...rules, prefixes: [{ spelling: 'MILO', sealChar: '墨', reason: '虚构规则。' }] },
    { ...rules, normalization: 'anything' },
    { ...rules, prefixes: [{ spelling: 'mi', sealChar: '墨', reason: '虚构规则。' }, { spelling: 'mi', sealChar: '朗', reason: '重复规则。' }] },
  ]) assert.throws(() => parseCompanionIdentityPolicyV2({ ...value, englishSealRules: replacement }),
    (error: unknown) => error instanceof CompanionIdentityError && error.code === 'COMPANION_IDENTITY_POLICY_INVALID');
});
test('closed V2 rules reject accessors, sparse arrays and implied approval without reading getters', () => {
  let reads = 0; const value = fixture(), first = value.englishSealRules.initials[0];
  const badRule = { ...first, get reason() { reads++; return 'not allowed'; } };
  const rules = { ...value.englishSealRules, initials: [badRule, ...value.englishSealRules.initials.slice(1)] };
  assert.throws(() => parseCompanionIdentityPolicyV2({ ...value, englishSealRules: rules }), CompanionIdentityError);
  assert.throws(() => parseCompanionIdentityPolicyV2({ ...value, englishSealRules: { ...value.englishSealRules, prefixes: new Array(1) } }), CompanionIdentityError);
  assert.throws(() => parseCompanionIdentityPolicyV2({ ...value, englishSealRules: { ...value.englishSealRules, approved: true } }), CompanionIdentityError);
  assert.equal(reads, 0);
  const parsed = parseCompanionIdentityPolicyV2(value);
  (value.englishSealRules.initials as { spelling: string; sealChar: string; reason: string }[])[0].sealChar = '投';
  assert.equal(parsed.englishSealRules.initials[0].sealChar, '舟');
  assert.equal(Object.isFrozen(parsed.englishSealRules.initials[0]), true);
  assert.equal(Object.hasOwn(parsed, 'approved'), false);
});
test('V2 coverage never relaxes actual six-category semantic validation or makes a selection', () => {
  for (const name of ['妈妈', 'companion', 'A1', 'abcdefghijklmnopq']) assert.throws(() => validateCompanionNameV2({ name, userName: '虚构用户', policy: fixture() }), CompanionNameError);
  assert.throws(() => validateCompanionNameV2({ name: 'Juno', userName: 'juno', policy: fixture() }), CompanionNameError);
  assert.equal(Object.hasOwn(candidates('Milo'), 'selectedSeal'), false);
});
