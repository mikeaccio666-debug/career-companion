import test from 'node:test';
import assert from 'node:assert/strict';
import { CompanionIdentityError, CompanionNameError, companionSealCandidates, parseCompanionIdentityPolicy, validateCompanionName,
  type CompanionIdentityPolicy, type CompanionNameCategory } from '../src/companion/identity.ts';
import type { CompanionDimensions } from '../src/companion/mapping.ts';

const id = '00000000-0000-4000-8000-000000000123';
const dimensions: CompanionDimensions = { warmth: 0, directness: 0, drive: 0, structure: 0, levity: 0, code_mix: 0, length: 'medium' };
/** Fictional policy fixtures are neither the standard-character table nor a reviewed production asset. */
const fixture = (): CompanionIdentityPolicy => ({ familyOrPartner: ['妈妈', 'Partner'], teamOrOrg: ['课程组'], abusive: ['坏词甲'],
  publicFigures: ['公众甲'], allowedSealCharacters: ['墨', '稳', '拾', '启', '朗', '灯', '远', '舟', '如', '暖', '砺', '恒'],
  englishSealAliases: [{ name: 'Lumen', sealChar: '灯' }, { name: 'Élodie', sealChar: '朗' }, { name: 'Juno', sealChar: '如' }] });
const name = (value: string, userName = '虚构用户甲', policy = fixture()) => validateCompanionName({ name: value, userName, policy });
const rejected = (value: string, category: CompanionNameCategory, userName?: string) => assert.throws(() => name(value, userName),
  (error: unknown) => error instanceof CompanionNameError && error.code === 'NAME_REJECTED' && error.category === category && !error.message.includes(value));

test('names preserve trimmed spelling, permit Unicode Latin and normalize decomposed accents', () => {
  assert.equal(name('  北北  '), '北北'); assert.equal(name(' Lumen '), 'Lumen');
  assert.equal(name('Élodie'), 'Élodie'); assert.equal(name('E\u0301lodie'), 'Élodie'); assert.equal(name('Ana-María'), 'Ana-María');
  assert.equal(name('Jean Luc'), 'Jean Luc'); assert.equal(name('Chris'), 'Chris');
});
test('all six product rejection categories remain distinct and bounded', () => {
  rejected('妈妈', 'family_or_partner'); rejected('Partner', 'family_or_partner'); rejected('课程组', 'team_or_org');
  rejected('北北', 'same_as_user', '北北'); rejected('坏词甲', 'abusive'); rejected('公众甲', 'public_figure');
  rejected('七个汉字多一个', 'length');
});
test('fixed roles and genuine mentor/organization identities cannot be relaxed by an empty external team list', () => {
  const policy = { ...fixture(), teamOrOrg: [] };
  for (const value of ['规', '前', '教', '面', '脉', '投', '导', '伴', '主理人', '规划师', '前辈', '教练', '技能教练', '面试官',
    '人脉官', '投递官', '导师', '蔓藤', 'h-r', 'dso', '移民局', 'companion', 'planner', 'guide', 'coach', 'interviewer', 'networker', 'applier', 'mentor']) {
    assert.throws(() => name(value, '虚构用户甲', policy), (error: unknown) => error instanceof CompanionNameError && error.category === 'team_or_org');
  }
  assert.equal(name('Chris', '虚构用户甲', policy), 'Chris');
});
test('explicit family/partner boundaries cannot be removed by an empty external family list', () => {
  const policy = { ...fixture(), familyOrPartner: [] };
  for (const value of ['妈妈', '爸爸', '老公', '老婆', '男朋友', '女朋友', '宝贝', '亲爱的']) {
    assert.throws(() => name(value, '虚构用户甲', policy), (error: unknown) => error instanceof CompanionNameError && error.category === 'family_or_partner');
  }
});
test('same-name/list comparison folds case, width and separators without changing returned spelling', () => {
  rejected('jUnO', 'same_as_user', 'Juno'); rejected('Jean-Luc', 'same_as_user', 'Jean Luc');
  rejected('Ｊｕｎｏ', 'same_as_user', 'Juno'); rejected('ｐａｒｔｎｅｒ', 'family_or_partner');
  assert.equal(name('Ｌｕｍｅｎ'), 'Ｌｕｍｅｎ');
});
test('names use separate Han/Latin length boundaries and reject digits, other scripts and control/surrogate input', () => {
  assert.equal(name('甲乙丙丁戊己'), '甲乙丙丁戊己'); assert.equal(name('abcdefghijklmnop'), 'abcdefghijklmnop');
  for (const value of ['', '   ', '--', '甲乙丙丁戊己庚', 'abcdefghijklmnopq', '墨A', 'A1', 'AⅣ', 'Αda', 'Аda', '<墨>', 'Lumen\n', 'Lu\u202emen', '\ud800']) {
    assert.throws(() => name(value), (error: unknown) => error instanceof CompanionNameError && error.category === 'length');
  }
});
test('closed name and policy inputs never execute accessors or accept injected authority fields', () => {
  let reads = 0;
  const input = { userName: '虚构用户甲', policy: fixture(), get name() { reads++; return '墨'; } };
  assert.throws(() => validateCompanionName(input), CompanionIdentityError); assert.equal(reads, 0);
  const policy = { ...fixture(), get abusive() { reads++; return []; } };
  assert.throws(() => name('墨', '虚构用户甲', policy), CompanionIdentityError); assert.equal(reads, 0);
  assert.throws(() => validateCompanionName({ name: '墨', userName: '虚构用户甲', policy: fixture(), active: true } as never), CompanionIdentityError);
  for (const value of [undefined, null, {}, { ...fixture(), approved: true }]) assert.throws(() => parseCompanionIdentityPolicy(value),
    (error: unknown) => error instanceof CompanionIdentityError && error.code === 'COMPANION_IDENTITY_POLICY_INVALID');
});
test('policy rejects every fixed forbidden seal, duplicates, sparse arrays and unknown/unqualified aliases', () => {
  for (const char of ['规', '前', '导', '教', '面', '脉', '投', '伴', '缄', '贺', '蔓', '藤', '死', '亡', '败', '拒', '病', '灾', '哀']) {
    assert.throws(() => parseCompanionIdentityPolicy({ ...fixture(), allowedSealCharacters: ['墨', '稳', char] }), CompanionIdentityError);
  }
  for (const chars of [['墨', '稳'], ['墨', '墨', '稳'], ['墨', '稳', 'AA'], ['墨', '稳', 'A'], new Array(3), new Array(3501).fill('墨')]) {
    assert.throws(() => parseCompanionIdentityPolicy({ ...fixture(), allowedSealCharacters: chars }), CompanionIdentityError);
  }
  for (const aliases of [[{ name: 'Lumen', sealChar: '界' }], [{ name: 'Lumen', sealChar: '灯', meaning: 'invented' }],
    [{ name: 'Lumen', sealChar: '灯' }, { name: 'lumen', sealChar: '稳' }]]) {
    assert.throws(() => parseCompanionIdentityPolicy({ ...fixture(), englishSealAliases: aliases }), CompanionIdentityError);
  }
});
test('policy parsing copies and freezes all supplied lists and aliases without claiming approval', () => {
  const input = fixture(), parsed = parseCompanionIdentityPolicy(input);
  (input.allowedSealCharacters as string[])[0] = '前'; (input.englishSealAliases as { name: string; sealChar: string }[])[0].sealChar = '投';
  assert.equal(parsed.allowedSealCharacters[0], '墨'); assert.equal(parsed.englishSealAliases[0].sealChar, '灯');
  for (const value of [parsed, parsed.allowedSealCharacters, parsed.englishSealAliases, parsed.englishSealAliases[0], parsed.abusive]) assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.hasOwn(parsed, 'approved'), false);
});
test('Han first candidate is the actual allowed name character, with three stable distinct qualified choices', () => {
  const input = { companionId: id, name: '墨', dimensions, policy: fixture() }, result = companionSealCandidates(input);
  assert.equal(result[0].char, '墨'); assert.match(result[0].reason, /名字/); assert.equal(result.length, 3);
  assert.equal(new Set(result.map(item => item.char)).size, 3);
  for (const candidate of result) { assert.ok(fixture().allowedSealCharacters.includes(candidate.char)); assert.ok(candidate.reason.trim()); assert.equal(Object.isFrozen(candidate), true); }
  assert.deepEqual(companionSealCandidates(input), result); assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.hasOwn(result, 'sealChar'), false);
});
test('English aliases must be supplied and point to an allowed character; absence is explicitly unavailable', () => {
  const result = companionSealCandidates({ companionId: id, name: 'lUmEn', dimensions, policy: fixture() });
  assert.equal(result[0].char, '灯'); assert.match(result[0].reason, /映射/);
  assert.throws(() => companionSealCandidates({ companionId: id, name: 'Missing', dimensions, policy: fixture() }),
    (error: unknown) => error instanceof CompanionIdentityError && error.code === 'SEAL_CANDIDATES_UNAVAILABLE');
});
test('unqualified Han name characters use the external pool without pretending they came from the name', () => {
  const policy: CompanionIdentityPolicy = { ...fixture(), allowedSealCharacters: ['稳', '启', '朗'], englishSealAliases: [] };
  const result = companionSealCandidates({ companionId: id, name: '北北', dimensions, policy });
  assert.deepEqual([...result.map(candidate => candidate.char)].sort(), ['启', '朗', '稳'].sort());
  assert.equal(result.some(candidate => candidate.reason.includes('名字')), false);
});
test('candidate preparation rejects malformed seed/dimensions and permission-shaped input, not only bad names', () => {
  const input = { companionId: id, name: '墨', dimensions, policy: fixture() };
  for (const patch of [{ companionId: id + '\n' }, { companionId: id.toUpperCase().replace('000000000123', 'ABC000000123') },
    { dimensions: { ...dimensions, warmth: 2 } }, { dimensions: { ...dimensions, length: 'unlimited' } },
    { dimensions: { ...dimensions, active: true } }, { userId: id }]) assert.throws(() => companionSealCandidates({ ...input, ...patch } as never), CompanionIdentityError);
});
