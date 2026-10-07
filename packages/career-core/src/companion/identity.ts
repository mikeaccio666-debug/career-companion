import type { CompanionDimensions } from './mapping.ts';

export interface CompanionIdentityPolicy {
  readonly familyOrPartner: readonly string[];
  readonly teamOrOrg: readonly string[];
  readonly abusive: readonly string[];
  readonly publicFigures: readonly string[];
  /** A reviewed external subset, never an implicit copy of all 3,500 level-one characters. */
  readonly allowedSealCharacters: readonly string[];
  readonly englishSealAliases: readonly Readonly<{ name: string; sealChar: string }>[];
}
export type CompanionNameCategory = 'family_or_partner' | 'team_or_org' | 'same_as_user' | 'abusive' | 'public_figure' | 'length';
export class CompanionNameError extends Error {
  readonly code = 'NAME_REJECTED';
  constructor(readonly category: CompanionNameCategory) { super('Choose another companion name.'); this.name = 'CompanionNameError'; }
}
export class CompanionIdentityError extends Error {
  constructor(readonly code: 'COMPANION_IDENTITY_INVALID_INPUT' | 'COMPANION_IDENTITY_POLICY_INVALID' | 'SEAL_CANDIDATES_UNAVAILABLE') {
    super('The companion identity rules are not available.'); this.name = 'CompanionIdentityError';
  }
}
export interface CompanionSealCandidate { readonly char: string; readonly reason: string; }
export type CompanionSealCandidates = readonly [CompanionSealCandidate, CompanionSealCandidate, CompanionSealCandidate];

// 02 §5.3 / 08 §5.2: an external policy cannot repurpose these identities or negative examples.
const forbiddenSeals = new Set(['规', '前', '导', '教', '面', '脉', '投', '伴', '缄', '贺', '蔓', '藤', '死', '亡', '败', '拒', '病', '灾', '哀']);
// 02 §5.2: the explicit family/partner examples are permanent boundaries, not optional asset defaults.
const fixedFamilyNames = ['妈妈', '爸爸', '老公', '老婆', '男朋友', '女朋友', '宝贝', '亲爱的'];
// 03 §1.1 and §4.4: fixed role names remain reserved even when an external list is empty.
const fixedTeamNames = ['规', '规划师', '前', '前辈', '教', '教练', '技能教练', '面', '面试官', '脉', '人脉官', '投', '投递官',
  '导', '导师', '伴', '主理人', '蔓藤', 'HR', 'DSO', '移民局', 'companion', 'planner', 'guide', 'coach', 'interviewer', 'networker', 'applier', 'mentor'];
const han = /^\p{Unified_Ideograph}+$/u, latin = /^[\p{Script=Latin} -]+$/u;
const unsafe = /[<>\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u;
function invalid(policy = false): never { throw new CompanionIdentityError(policy ? 'COMPANION_IDENTITY_POLICY_INVALID' : 'COMPANION_IDENTITY_INVALID_INPUT'); }
function record(value: unknown, keys: readonly string[], policy = false): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(policy);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key)) || keys.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(descriptor => !('value' in descriptor) || !descriptor.enumerable)) invalid(policy);
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) invalid(true);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => key !== 'length' && (typeof key !== 'string' || /^(0|[1-9][0-9]*)$/.exec(key)?.[0] !== key || Number(key) >= value.length))
    || Object.values(descriptors).some(descriptor => !('value' in descriptor))) invalid(true);
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index++) { const entry = descriptors[index]; if (!entry?.enumerable) invalid(true); result.push(entry.value); }
  return result;
}
const nameKey = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[ -]+/g, '');
const latinName = (value: string) => latin.test(value) && /\p{L}/u.test(value)
  && Array.from(value).every(char => char === ' ' || char === '-' || /\p{L}/u.test(char));
function policyWord(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 200 || Array.from(value).length > 100 || unsafe.test(value)) invalid(true);
  return value;
}
/** Closed integrity codec only. External membership/review metadata must be established by the server. */
export function parseCompanionIdentityPolicy(value: unknown): Readonly<CompanionIdentityPolicy> {
  try {
    const data = record(value, ['familyOrPartner', 'teamOrOrg', 'abusive', 'publicFigures', 'allowedSealCharacters', 'englishSealAliases'], true);
    const words = (value: unknown) => {
      const entries = array(value, 10000).map(policyWord);
      if (new Set(entries.map(nameKey)).size !== entries.length) invalid(true); return Object.freeze(entries);
    };
    const allowedSealCharacters = array(data.allowedSealCharacters, 3500).map(value => {
      if (typeof value !== 'string' || Array.from(value).length !== 1 || !han.test(value) || forbiddenSeals.has(value)) invalid(true); return value;
    });
    if (allowedSealCharacters.length < 3 || new Set(allowedSealCharacters).size !== allowedSealCharacters.length) invalid(true);
    const aliases = array(data.englishSealAliases, 10000).map(value => {
      const alias = record(value, ['name', 'sealChar'], true), name = policyWord(alias.name);
      if (Array.from(name).length > 16 || !latinName(name)
        || typeof alias.sealChar !== 'string' || !allowedSealCharacters.includes(alias.sealChar)) invalid(true);
      return Object.freeze({ name, sealChar: alias.sealChar });
    });
    if (new Set(aliases.map(alias => nameKey(alias.name))).size !== aliases.length) invalid(true);
    return Object.freeze({ familyOrPartner: words(data.familyOrPartner), teamOrOrg: words(data.teamOrOrg), abusive: words(data.abusive),
      publicFigures: words(data.publicFigures), allowedSealCharacters: Object.freeze(allowedSealCharacters), englishSealAliases: Object.freeze(aliases) });
  } catch { throw new CompanionIdentityError('COMPANION_IDENTITY_POLICY_INVALID'); }
}
function canonicalName(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 || unsafe.test(value)) throw new CompanionNameError('length');
  // Preserve spelling/case; NFC makes a decomposed Latin accent one character before length validation.
  const name = value.trim().normalize('NFC'), length = Array.from(name).length;
  if (!name || !(han.test(name) && length <= 6 || latinName(name) && length <= 16)) throw new CompanionNameError('length');
  return name;
}
function checkName(name: string, userName: string, policy: CompanionIdentityPolicy): void {
  const key = nameKey(name), matches = (words: readonly string[]) => words.some(word => nameKey(word) === key);
  if (matches(fixedFamilyNames) || matches(policy.familyOrPartner)) throw new CompanionNameError('family_or_partner');
  if (matches(fixedTeamNames) || matches(policy.teamOrOrg)) throw new CompanionNameError('team_or_org');
  if (key === nameKey(userName.trim())) throw new CompanionNameError('same_as_user');
  if (matches(policy.abusive)) throw new CompanionNameError('abusive');
  if (matches(policy.publicFigures)) throw new CompanionNameError('public_figure');
}
/** Pure name validation. The application supplies the real account name and frozen external policy. */
export function validateCompanionName(input: { name: string; userName: string; policy: CompanionIdentityPolicy }): string {
  const data = record(input, ['name', 'userName', 'policy']);
  const policy = parseCompanionIdentityPolicy(data.policy), name = canonicalName(data.name);
  if (typeof data.userName !== 'string' || data.userName.length > 200 || unsafe.test(data.userName)) invalid();
  checkName(name, data.userName, policy); return name;
}
function seed(value: string): number { let number = 2166136261; for (const char of value) number = Math.imul(number ^ char.charCodeAt(0), 16777619) >>> 0; return number; }
function dimensions(value: unknown): CompanionDimensions {
  const data = record(value, ['warmth', 'directness', 'drive', 'structure', 'levity', 'code_mix', 'length']);
  for (const key of ['warmth', 'directness', 'drive', 'structure', 'levity', 'code_mix']) if (![-1, 0, 1].includes(data[key] as number) || Object.is(data[key], -0)) invalid();
  if (!['short', 'medium', 'long'].includes(data.length as string)) invalid(); return data as unknown as CompanionDimensions;
}
/** Seeded candidates are suggestions, not a selected seal, birth, or reroll authorization. */
export function companionSealCandidates(input: { companionId: string; name: string; dimensions: CompanionDimensions; policy: CompanionIdentityPolicy }): CompanionSealCandidates {
  const data = record(input, ['companionId', 'name', 'dimensions', 'policy']);
  if (typeof data.companionId !== 'string' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(data.companionId)?.[0] !== data.companionId) invalid();
  const policy = parseCompanionIdentityPolicy(data.policy), name = canonicalName(data.name), values = dimensions(data.dimensions);
  checkName(name, '', policy);
  const chosen: CompanionSealCandidate[] = [];
  if (han.test(name)) {
    const first = Array.from(name)[0];
    if (policy.allowedSealCharacters.includes(first)) chosen.push({ char: first, reason: '你起的名字里的第一个字。' });
  } else {
    const alias = policy.englishSealAliases.find(alias => nameKey(alias.name) === nameKey(name));
    if (!alias) throw new CompanionIdentityError('SEAL_CANDIDATES_UNAVAILABLE');
    chosen.push({ char: alias.sealChar, reason: '外部名字映射提供的读音或意义相关字。' });
  }
  const preferred = (values.warmth > 0 ? ['暖', '灯'] : values.directness > 0 ? ['砺', '恒'] : values.structure > 0 ? ['稳', '拾'] : ['舟', '远', '栖', '启', '朗']);
  const rest = policy.allowedSealCharacters.filter(char => !chosen.some(candidate => candidate.char === char));
  const preferredAvailable = rest.filter(char => preferred.includes(char)), other = rest.filter(char => !preferred.includes(char));
  const draw = (pool: string[]) => {
    let position = 0;
    while (pool.length && chosen.length < 3) {
      const index = seed(`${data.companionId}:${JSON.stringify(values)}:${position++}:${chosen.length}`) % pool.length;
      const [char] = pool.splice(index, 1); chosen.push({ char, reason: '从已配置的合格字中，按说话方式和种子挑选。' });
    }
  };
  draw(preferredAvailable); draw(other);
  if (chosen.length !== 3) throw new CompanionIdentityError('SEAL_CANDIDATES_UNAVAILABLE');
  return Object.freeze(chosen.map(candidate => Object.freeze(candidate))) as unknown as CompanionSealCandidates;
}
