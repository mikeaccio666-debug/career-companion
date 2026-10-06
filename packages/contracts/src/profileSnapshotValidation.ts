/** Read projections validate every consumed field and discard additive unknown API fields. */
import { parseIsoDateTime, parseLocalDate, parseUuid } from './common.ts';
import { parseIsoCountryCode, parseSafeToken } from './sensitiveWrite.ts';
import { APPLICATION_PROFILE_FIELD_KEYS } from './executionIntent.ts';
import type { ProfileDirectoryPersonalV1 } from './profileDirectory.ts';
import * as P from './profileV2.ts';

type Check = (value: unknown) => boolean;
export const closedRecord = (value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && [...required, ...optional].includes(key) && 'value' in descriptors[key]!)
    && required.every(key => Object.hasOwn(descriptors, key));
};
// Projection and validation share each field declaration. Unknown fields are never
// evaluated or forwarded; closedRecord remains strict for commands/envelopes.
const projections = new WeakMap<Check, (value: unknown) => unknown>();
const projectValue = (check: Check, value: unknown): unknown => { const projection = projections.get(check); return projection ? projection(value) : value; };
function projecting(check: Check, projection: (value: unknown) => unknown): Check {
  projections.set(check, projection); return check;
}
/**
 * 可空的字段，**省略等同于 null**。
 *
 * 两种写法说的是同一件事：`{"userConfirmedAt": null}` 与把这个键整个不发。
 * JSON 那一侧尤其如此——`JSON.stringify` 本来就会丢掉值为 `undefined` 的键，
 * 所以服务端只要有一处写了 `x?.toISOString()` 而不是 `x === null ? null : …`，
 * 发出来的就是后一种。
 *
 * 2026-09-18 线上就是这个形状：argoland 的档案投影少发了一个 `userConfirmedAt`，
 * 而它是**每一条未确认事实**都有的字段（简历解析出来的每一条一开始都是 SUGGESTED）。
 * 严格到「少一个可空键就整份拒收」，代价是**每一个用户**的资料面板一片空白——
 * 为一个时间戳的编码写法，废掉整份档案。
 *
 * 所以可空 = 可省。这不放松任何**值**的检查：非空字段照旧必须在场，
 * 每个在场的值照旧逐条校验。服务端仍然应该把键发全（argoland 那边已修），
 * 这里让它不再是一次全有或全无。
 */
const NULLABLE = new WeakSet<Check>();
const obj = (shape: Record<string, Check>, partial = false): Check => {
  const entries = Object.entries(shape);
  return projecting(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    return entries.every(([key, check]) => {
      const d = Object.getOwnPropertyDescriptor(value, key);
      return d ? 'value' in d && check(d.value) : (partial || NULLABLE.has(check));
    });
  }, value => {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(entries
      .filter(([key, check]) => Object.hasOwn(record, key) || NULLABLE.has(check))
      .map(([key, check]) => [key, Object.hasOwn(record, key) ? projectValue(check, record[key]) : null]));
  });
};
const nullable = (check: Check): Check => {
  const wrapped = projecting(value => value === null || check(value), value => value === null ? null : projectValue(check, value));
  NULLABLE.add(wrapped);
  return wrapped;
};
const either = (...checks: Check[]): Check => projecting(value => checks.some(check => check(value)), value => projectValue(checks.find(check => check(value))!, value));
const str = (max: number, min = 1): Check => value => typeof value === 'string' && value.length >= min && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
const one = (values: readonly unknown[]): Check => value => values.includes(value);
const bool: Check = value => typeof value === 'boolean';
const integer = (min: number, max: number): Check => value => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
const decimal: Check = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value);
const uuid: Check = value => parseUuid(value) !== null;
const instant: Check = value => parseIsoDateTime(value) !== null;
const date: Check = value => parseLocalDate(value) !== null;
const country: Check = value => parseIsoCountryCode(value) !== null;
const token: Check = value => parseSafeToken(value) !== null;
const url: Check = value => {
  if (!str(2048)(value)) return false;
  try { const u = new URL(value as string); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password; }
  catch { return false; }
};
const array = (check: Check, max: number, id?: string, min = 0): Check => projecting(value => Array.isArray(value) && value.length >= min && value.length <= max &&
  Object.getPrototypeOf(value) === Array.prototype && Reflect.ownKeys(value).length === value.length + 1 &&
  Array.from({ length: value.length }, (_, i) => Object.getOwnPropertyDescriptor(value, String(i))).every(d => d && 'value' in d && check(d.value)) && (!id || new Set(value.map(item => item[id])).size === value.length),
  value => (value as unknown[]).map((item: unknown) => projectValue(check, item)));
const datePart = obj({ year: integer(1, 9999), month: nullable(integer(1, 12)) });
/**
 * 事实权威的元数据：来源、确认状态、来源种类（2026-09-28 起对**这一版不认识的值**容错）。
 *
 * 它们挂在每一条事实上。后端加一种来源或确认状态，旧包从前对任何一条带它的事实整份拒收——
 * 「我的资料」空白，填写时各个集合一起读不出来。现在：长得像枚举（大写 token）的陌生值原样
 * 留着、不解释；消费端（内核投影、工作授权）只拿确认闭集与已知来源逐一比对，陌生值对不上，
 * 这条事实就**不算已确认**，不会被替用户填进申请表。陌生的来源种类只留 `kind`。
 *
 * 认得的值照旧逐字段校验；不像枚举的值（小写、空串、带空格）是坏数据，照旧整份拒收。
 * 元数据不随「我的资料」的保存发回去（保存只带 confirmFields），原值不会被改写。
 */
const ENUM_TOKEN = /^[A-Z][A-Z0-9_]{0,31}$/;
const enumToken: Check = value => typeof value === 'string' && ENUM_TOKEN.test(value);
const KNOWN_SOURCE_REF_KINDS: ReadonlySet<string> = new Set(P.PROFILE_V2_SOURCE_REF_KINDS);
const ref = nullable(either(
  obj({ kind: one(['RESUME_FACT']), resumeVersionId: uuid, parserVersion: token, factId: uuid }),
  obj({ kind: one(['DERIVATION']), policyVersion: token, evidenceFacts: array(obj({ factId: uuid, factRevision: decimal }), P.PROFILE_V2_COLLECTION_LIMITS.derivationEvidenceFacts, undefined, 1) }),
  obj({ kind: one(['LEGACY_PROFILE']), migrationId: token }),
  obj({ kind: value => enumToken(value) && !KNOWN_SOURCE_REF_KINDS.has(value as string) }),
));
const authority = obj({ factId: uuid, factRevision: decimal, deletionEpoch: decimal,
  meta: obj({ source: enumToken, authorityState: enumToken,
    confidence: nullable(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1),
    userConfirmedAt: nullable(instant), sourceRef: ref }) });
const authorityMap = (keys: readonly string[], partial = false): Check => obj(Object.fromEntries(keys.map(key => [key, authority])), partial);
const item = (shape: Record<string, Check>, fields: readonly string[]): Check => obj({ id: uuid, ...shape, factAuthorityByField: authorityMap(fields) });
const link = item({ kind: one(P.PROFILE_V2_LINK_KINDS), label: nullable(str(80)), url }, P.PROFILE_V2_LINK_FIELD_CODES);
/**
 * 本版本不认得的链接种类（后端加了一种，比如 TWITTER）：整条链接**丢弃**，不让它把
 * 整份快照判成 malformed。2026-09-18 的资料面板空白就是同一形状——服务端多给一样东西，
 * 闭集校验整份拒收。种类名仍要长得像枚举（大写 token），别的照旧拒。
 */
const KNOWN_LINK_KINDS: ReadonlySet<string> = new Set(P.PROFILE_V2_LINK_KINDS);
const foreignLink = item({ kind: v => typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(v) && !KNOWN_LINK_KINDS.has(v), label: nullable(str(80)), url }, P.PROFILE_V2_LINK_FIELD_CODES);
const experience = item({ company: str(160), title: str(160), city: nullable(str(120)), region: nullable(str(120)),
  employmentType: nullable(one(P.PROFILE_V2_EMPLOYMENT_TYPES)), startDate: nullable(datePart), endDate: nullable(datePart),
  // 上限跟着契约常量走。写死 2000 时，一段长经历（一份两页简历上的资深岗位
  // 常常就是十来条）会让**整份档案**判 malformed——不是那一段被截短，是整份读不出来。
  // argoland 2026-09 把它提到 6000，这边跟版（RULE-EXT-CONTRACT-CONSUMER）。
  isCurrent: bool, description: nullable(str(P.PROFILE_V2_DESCRIPTION_MAX_LENGTH)) }, P.PROFILE_V2_EXPERIENCE_FIELD_CODES);
const education = item({ school: str(160), degree: nullable(str(120)), degreeLevel: nullable(one(P.PROFILE_V2_DEGREE_LEVELS)),
  fieldOfStudy: nullable(str(120)), city: nullable(str(120)), region: nullable(str(120)), startDate: nullable(datePart),
  endDate: nullable(datePart), expectedGraduationDate: nullable(datePart), isCurrent: bool,
  gpa: nullable(str(16)), gpaScale: nullable(str(16)), coursework: nullable(str(2000)) }, P.PROFILE_V2_EDUCATION_FIELD_CODES);
// 上限跟着契约常量走（2026-09-27）：argoland 09-18 把技能名提到 120，这里写死 80 时一条长技能就让整份档案读不出来。
const skill = item({ name: str(P.PROFILE_V2_SKILL_NAME_MAX_LENGTH), categories: v => array(one(P.PROFILE_V2_SKILL_CATEGORIES), 3)(v) && new Set(v as unknown[]).size === (v as unknown[]).length }, P.PROFILE_V2_SKILL_FIELD_CODES);
const language = item({ language: str(80), proficiency: one(P.PROFILE_V2_LANGUAGE_PROFICIENCIES) }, P.PROFILE_V2_LANGUAGE_FIELD_CODES);
const project = item({ title: str(160), organization: nullable(str(160)), role: nullable(str(160)), location: nullable(str(256)),
  url: nullable(url), startDate: nullable(datePart), endDate: nullable(datePart), isCurrent: bool,
  description: nullable(str(P.PROFILE_V2_DESCRIPTION_MAX_LENGTH)),
  skillIds: array(uuid, P.PROFILE_V2_COLLECTION_LIMITS.skills) }, P.PROFILE_V2_PROJECT_FIELD_CODES);
const context = either(obj({ type: one(['STANDALONE']), itemId: one([null]) }),
  obj({ type: one(['EXPERIENCE', 'PROJECT', 'EDUCATION']), itemId: uuid }));
const achievement = item({ kind: one(P.PROFILE_V2_ACHIEVEMENT_KINDS), title: str(160), statement: str(1000),
  occurredAt: nullable(datePart), url: nullable(url), context }, P.PROFILE_V2_ACHIEVEMENT_FIELD_CODES);
// 推荐人（P1-9）：整个集合可缺——argoland 加上它之前的服务端不发；缺失读成 null、下面补成空数组。
const referral = item({ name: str(160), company: str(160), relationship: nullable(str(80)) }, P.PROFILE_V2_REFERRAL_FIELD_CODES);
const workAuthorization = obj({ regionCode: country, authorizedToWork: one(P.PROFILE_V2_WORK_AUTHORIZATION_ANSWERS),
  requiresSponsorship: one(P.PROFILE_V2_WORK_AUTHORIZATION_ANSWERS), revision: decimal, effectiveAt: instant,
  expiresAt: nullable(instant), revokedAt: nullable(instant), factAuthorityByField: authorityMap(P.PROFILE_V2_WORK_AUTHORIZATION_FIELD_CODES) });
const profile = obj({
  identity: obj({ firstName: nullable(str(80)), middleName: nullable(str(80)), lastName: nullable(str(80)), fullName: nullable(str(256)), preferredName: nullable(str(80)), pronouns: nullable(str(40)) }),
  contact: obj({ email: nullable(v => str(254)(v) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v as string)),
    phone: obj({ countryCode: nullable(v => typeof v === 'string' && /^\+[1-9][0-9]{0,2}$/.test(v)),
      e164: nullable(v => typeof v === 'string' && /^\+[1-9][0-9]{1,14}$/.test(v)), display: nullable(str(64)), type: nullable(one(P.PROFILE_V2_PHONE_TYPES)) }) }),
  address: obj({ line1: nullable(str(200)), line2: nullable(str(200)), city: nullable(str(120)), region: nullable(str(120)), postalCode: nullable(str(16)), countryCode: nullable(country) }),
  summary: nullable(str(2000)), noExperience: nullable(bool), links: array(either(link, foreignLink), P.PROFILE_V2_COLLECTION_LIMITS.links, 'id'),
  primaryLinkIdByKind: obj(Object.fromEntries(P.PROFILE_V2_LINK_KINDS.map(key => [key, nullable(uuid)]))),
  experiences: array(experience, P.PROFILE_V2_COLLECTION_LIMITS.experiences, 'id'), primaryCurrentExperienceId: nullable(uuid),
  educations: array(education, P.PROFILE_V2_COLLECTION_LIMITS.educations, 'id'), skills: array(skill, P.PROFILE_V2_COLLECTION_LIMITS.skills, 'id'),
  languages: array(language, P.PROFILE_V2_COLLECTION_LIMITS.languages, 'id'), projects: array(project, P.PROFILE_V2_COLLECTION_LIMITS.projects, 'id'),
  achievements: array(achievement, P.PROFILE_V2_COLLECTION_LIMITS.achievements, 'id'),
  referrals: nullable(array(referral, P.PROFILE_V2_COLLECTION_LIMITS.referrals, 'id')),
  legacyUnresolved: obj({ profileLocation: nullable(str(256)),
    experienceLocations: array(obj({ experienceId: uuid, value: str(256) }), P.PROFILE_V2_COLLECTION_LIMITS.experiences, 'experienceId'),
    fieldValues: array(obj({ fieldKey: one(P.PROFILE_V2_LEGACY_FIELD_KEYS), value: str(2048) }), P.PROFILE_V2_LEGACY_FIELD_KEYS.length, 'fieldKey') }),
  availability: obj({ earliestStartDate: nullable(date), noticePeriodDays: nullable(integer(0, 365)) }),
  // argoland 那边把 `mobility.*` 换成了一个 `referralSource`（2026-09 契约变更），
  // 而这边一直停在旧形状。闭集校验于是对**每一次**真实答复都判 malformed：
  // 服务端多给一个 referralSource、少给一个 mobility，两条都足以整份拒收。
  // 实测后果是资料面板永远空白（2026-09-18）。权威在 argoland，这边跟版。
  referralSource: nullable(str(64)),
  // 2026-09-21 填写键扩展（argoland #535）。三组都 nullable：#535 上线之前的服务端不发它们，
  // 缺失读成 null、下面再补成全空的一组——旧后端与新插件的组合也要能开面板。
  compensation: nullable(obj({ expectedSalaryAmount: nullable(v => str(16)(v) && P.PROFILE_V2_SALARY_AMOUNT_PATTERN.test(v as string)),
    expectedSalaryCurrency: nullable(v => str(3)(v) && P.PROFILE_V2_CURRENCY_CODE_PATTERN.test(v as string)),
    expectedSalaryPeriod: nullable(one(P.PROFILE_V2_SALARY_PERIODS)) })),
  preferences: nullable(obj({ workModes: nullable(v => array(one(P.PROFILE_V2_WORK_MODES), 3, undefined, 1)(v) && new Set(v as unknown[]).size === (v as unknown[]).length),
    openToRelocation: nullable(bool), openToRelocationCities: nullable(str(256)),
    // 2026-09-28：「可以联系你现在的雇主吗？」。可省：旧服务端不发它，读成 null（= 没答）。
    contactCurrentEmployer: nullable(bool),
    // 2026-10-04（argoland #738）：「出差最多能接受多少？」，只收那五档。可省：旧服务端不发它，读成 null（= 没答）。
    travelPercentMax: nullable(one(P.PROFILE_V2_TRAVEL_PERCENTS)) })),
  eligibility: nullable(obj({ over18: nullable(bool) })),
  workAuthorizations: array(workAuthorization, P.PROFILE_V2_COLLECTION_LIMITS.workAuthorizations, 'regionCode'),
  scalarAuthorityByPath: authorityMap(P.PROFILE_V2_SCALAR_PATHS, true),
  referenceAuthority: obj({ primaryLinkIdByKind: authorityMap(P.PROFILE_V2_LINK_KINDS, true), primaryCurrentExperienceId: nullable(authority) }),
});
const snapshot = obj({ schemaVersion: one([2]), revision: decimal, deletionEpoch: decimal, hasStoredProfile: bool, updatedAt: nullable(instant), profile });
export function parseCandidateProfileSnapshotV2(value: unknown): P.CandidateProfileSnapshotV2 | null {
  if (!snapshot(value)) return null;
  const result = projectValue(snapshot, value) as P.CandidateProfileSnapshotV2, p = result.profile;
  // 认不得种类的链接到此为止：主链接表只投影认得的种类，所以不会有悬空引用。
  (p as { links: P.CandidateProfileSnapshotV2['profile']['links'] }).links = p.links.filter(link => KNOWN_LINK_KINDS.has(link.kind));
  // 旧后端不发这三组：缺失补成全空的一组，读侧就不必处处判 null。
  const mutable = p as unknown as Record<string, unknown>;
  if (mutable['compensation'] === null) mutable['compensation'] = { expectedSalaryAmount: null, expectedSalaryCurrency: null, expectedSalaryPeriod: null };
  if (mutable['preferences'] === null) mutable['preferences'] = { workModes: null, openToRelocation: null, openToRelocationCities: null, contactCurrentEmployer: null, travelPercentMax: null };
  if (mutable['eligibility'] === null) mutable['eligibility'] = { over18: null };
  if (mutable['referrals'] === null) mutable['referrals'] = [];
  if (Object.entries(p.primaryLinkIdByKind).some(([kind, id]) => id !== null && !p.links.some(link => link.id === id && link.kind === kind)) ||
    (p.primaryCurrentExperienceId !== null && !p.experiences.some(e => e.id === p.primaryCurrentExperienceId && e.isCurrent)) ||
    p.projects.some(project => project.skillIds.some(id => !p.skills.some(skill => skill.id === id)))) return null;
  return result;
}

/**
 * 这份（已解析的）快照里有没有带这一版不认识的元数据的事实权威（2026-09-28 起照读、不算已确认）。
 * 只答是否，给诊断记一个稳定码用；不带任何值。
 */
export function hasUnrecognizedProfileAuthorityV2(snapshot: P.CandidateProfileSnapshotV2): boolean {
  const sources: ReadonlySet<string> = new Set(P.PROFILE_V2_FACT_SOURCES);
  const states: ReadonlySet<string> = new Set(P.PROFILE_V2_AUTHORITY_STATES);
  const unrecognized = (authority: P.ProfileFieldAuthorityV2 | null | undefined): boolean =>
    authority !== null && authority !== undefined && (
      !sources.has(authority.meta.source) ||
      !states.has(authority.meta.authorityState) ||
      (authority.meta.sourceRef !== null && !KNOWN_SOURCE_REF_KINDS.has(authority.meta.sourceRef.kind)));
  const p = snapshot.profile;
  const maps: object[] = [p.scalarAuthorityByPath, p.referenceAuthority.primaryLinkIdByKind];
  for (const list of [p.links, p.experiences, p.educations, p.skills, p.languages, p.projects, p.achievements, p.referrals ?? [], p.workAuthorizations]) {
    for (const item of list as readonly { factAuthorityByField: object }[]) maps.push(item.factAuthorityByField);
  }
  return unrecognized(p.referenceAuthority.primaryCurrentExperienceId) ||
    maps.some((map) => Object.values(map as Record<string, P.ProfileFieldAuthorityV2 | undefined>).some(unrecognized));
}

const personal = obj({ schemaVersion: one([1]), revision: decimal, deletionEpoch: decimal, updatedAt: nullable(instant),
  fields: obj(Object.fromEntries(APPLICATION_PROFILE_FIELD_KEYS.map(key => [key, nullable(str(2048, 0))]))) });
export function parseProfileDirectoryPersonalV1(value: unknown): ProfileDirectoryPersonalV1 | null {
  return personal(value) ? projectValue(personal, value) as ProfileDirectoryPersonalV1 : null;
}
