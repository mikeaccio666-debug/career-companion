import type {
  CandidateProfileScalarPatchV2,
  CandidateProfileSnapshotV2,
  DatePart,
  PatchCandidateProfileV2,
  ProfileDegreeLevelV2,
  ProfileLanguageProficiencyV2,
  ProfileLinkKindV2,
  ProfileWorkModeV2,
} from '@edaix/contracts';
import { COPY, type DockCopy } from './copy';

/**
 * 资料编辑器的草稿与 Profile V2 之间的来回（2026-09-23）。
 *
 * 保存的写法照门户（argoland `profile-v2-draft-save.ts`）：标量只发改过的路径；集合（链接、经历、
 * 教育、技能、语言、工作许可）一改就整份重发——没带上的行服务端会删掉，所以没改的行也原样带上，
 * 编辑器里看不到的字段（雇用类型、GPA 满分……）从原行里抄过去；已有的行只确认编辑器里看得见的
 * 字段，新行确认全部字段。纯函数：不发请求、不碰 DOM。
 */

export interface ExpDraft {
  readonly id: string | null;
  readonly title: string;
  readonly company: string;
  readonly loc: string;
  readonly current: boolean;
  readonly from: string;
  readonly to: string;
  readonly desc: string;
}

export interface EduDraft {
  readonly id: string | null;
  readonly school: string;
  readonly degree: string;
  readonly major: string;
  readonly gpa: string;
  /**
   * 在读（2026-10-04）：开着时 `to` 是预计毕业时间（存进 expectedGraduationDate、endDate 为空——argoland 的保存规则，
   * 内核 #139 读它）；关着时 `to` 是实际毕业时间。编辑器里看得见、能改，所以已有的行保存时也确认它：不确认，内核的投影
   * 整条教育都不填（简历导入的那几段尤其如此）。
   */
  readonly current: boolean;
  readonly from: string;
  readonly to: string;
}

export interface ProfileDraft {
  readonly first: string;
  readonly last: string;
  readonly preferred: string;
  readonly pronouns: string;
  readonly email: string;
  readonly phoneCc: string;
  readonly phone: string;
  readonly line1: string;
  readonly city: string;
  readonly region: string;
  readonly postal: string;
  readonly country: string;
  readonly linkedin: string;
  readonly github: string;
  readonly portfolio: string;
  readonly website: string;
  readonly workAuth: string;
  readonly sponsor: string;
  readonly over18: string;
  readonly salary: string;
  readonly currency: string;
  readonly period: string;
  readonly modes: readonly string[];
  readonly start: string;
  readonly notice: number | null;
  readonly relocate: string;
  readonly cities: readonly string[];
  readonly referral: string;
  readonly summary: string;
  readonly exp: readonly ExpDraft[];
  readonly edu: readonly EduDraft[];
  readonly skills: readonly string[];
  readonly langs: readonly string[];
}

// 办公模式与学位在草稿里存的是这几个词（草稿自己的值，不给人看；编辑器按钮上的字在 `copy.ts`，跟界面语言走）。
export const WORK_MODE_LABEL: Readonly<Record<ProfileWorkModeV2, string>> = { REMOTE: '远程', HYBRID: '混合', ONSITE: '现场' };
const WORK_MODE_BY_LABEL: Readonly<Record<string, ProfileWorkModeV2>> = { 远程: 'REMOTE', 混合: 'HYBRID', 现场: 'ONSITE', 到岗: 'ONSITE' };
export const DEGREE_LABEL: Readonly<Partial<Record<ProfileDegreeLevelV2, string>>> = { ASSOCIATE: '副学士', BACHELOR: '学士', MASTER: '硕士', PHD: '博士' };
const DEGREE_BY_LABEL: Readonly<Record<string, ProfileDegreeLevelV2>> = { 副学士: 'ASSOCIATE', 学士: 'BACHELOR', 硕士: 'MASTER', 博士: 'PHD' };
/**
 * 语言标签后半截的熟练程度 → Profile V2。中文与英文编辑器写出来的词都认（`copy.ts` 的 `profile.proficiency`，
 * 2026-09-25 起有英文界面）：一改语言整份重发，没动过的那几行也要按原样读回去，读不懂就会被改成缺省的「流利」。
 * 英文不分大小写。
 */
const PROFICIENCY_BY_LABEL: Readonly<Record<string, ProfileLanguageProficiencyV2>> = {
  母语: 'NATIVE_OR_BILINGUAL', 双语: 'NATIVE_OR_BILINGUAL', 流利: 'PROFESSIONAL', 专业: 'PROFESSIONAL',
  日常交流: 'CONVERSATIONAL', 日常: 'CONVERSATIONAL', 会话: 'CONVERSATIONAL', 基础: 'BASIC', 入门: 'BASIC',
  native: 'NATIVE_OR_BILINGUAL', bilingual: 'NATIVE_OR_BILINGUAL', fluent: 'PROFESSIONAL', professional: 'PROFESSIONAL',
  conversational: 'CONVERSATIONAL', basic: 'BASIC', beginner: 'BASIC',
};
const PERIOD_BY_WIRE: Readonly<Record<string, string>> = { YEAR: 'year', MONTH: 'month', HOUR: 'hour' };
const WIRE_BY_PERIOD: Readonly<Record<string, 'YEAR' | 'MONTH' | 'HOUR'>> = { year: 'YEAR', month: 'MONTH', hour: 'HOUR' };

const monthOf = (date: DatePart | null): string =>
  date === null ? '' : `${String(date.year).padStart(4, '0')}-${String(date.month ?? 1).padStart(2, '0')}`;
const dateOf = (month: string): DatePart | null => {
  const match = /^(\d{4})-(\d{2})$/u.exec(month);
  return match === null ? null : { year: Number(match[1]), month: Number(match[2]) };
};
// 旧一点的服务端还没有 09-21 那几段（代词、薪资、偏好、资格）：缺席按空读。
const text = (value: string | null | undefined): string => value ?? '';
const yesNo = (value: boolean | null | undefined): string => (value === true ? 'yes' : value === false ? 'no' : '');
const opt = (value: string): string | null => (value.trim() === '' ? null : value.trim());

type Profile = CandidateProfileSnapshotV2['profile'];

function primaryLink(profile: Profile, kind: ProfileLinkKindV2): string {
  const id = profile.primaryLinkIdByKind[kind];
  const link = profile.links.find((item) => item.id === id) ?? profile.links.find((item) => item.kind === kind);
  return link?.url ?? '';
}

/** `proficiency`：语言标签后半截用哪一套词（编辑器按浮层的界面语言传；不传是中文）。 */
export function draftFromSnapshot(
  snapshot: CandidateProfileSnapshotV2,
  proficiency: DockCopy['profile']['proficiency'] = COPY.profile.proficiency,
): ProfileDraft {
  const p = snapshot.profile;
  const us = p.workAuthorizations.find((item) => item.regionCode === 'US');
  const answer = (value: string | undefined): string => (value === 'YES' ? 'yes' : value === 'NO' ? 'no' : '');
  const cc = text(p.contact.phone.countryCode) || '+1';
  const e164 = text(p.contact.phone.e164);
  const national = e164.startsWith(cc) ? e164.slice(cc.length) : e164.replace(/^\+/u, '');
  return Object.freeze({
    first: text(p.identity.firstName),
    last: text(p.identity.lastName),
    preferred: text(p.identity.preferredName),
    pronouns: text(p.identity.pronouns ?? null),
    email: text(p.contact.email),
    phoneCc: cc,
    phone: text(p.contact.phone.display) || national,
    line1: text(p.address.line1),
    city: text(p.address.city),
    region: text(p.address.region),
    postal: text(p.address.postalCode),
    country: text(p.address.countryCode),
    linkedin: primaryLink(p, 'LINKEDIN'),
    github: primaryLink(p, 'GITHUB'),
    portfolio: primaryLink(p, 'PORTFOLIO'),
    website: primaryLink(p, 'WEBSITE'),
    workAuth: answer(us?.authorizedToWork),
    sponsor: answer(us?.requiresSponsorship),
    over18: yesNo(p.eligibility?.over18),
    salary: text(p.compensation?.expectedSalaryAmount),
    currency: text(p.compensation?.expectedSalaryCurrency) || 'USD',
    period: PERIOD_BY_WIRE[p.compensation?.expectedSalaryPeriod ?? ''] ?? 'year',
    modes: (p.preferences?.workModes ?? []).map((mode) => WORK_MODE_LABEL[mode]),
    start: text(p.availability.earliestStartDate),
    notice: p.availability.noticePeriodDays,
    relocate: yesNo(p.preferences?.openToRelocation),
    cities: text(p.preferences?.openToRelocationCities).split(/[,，;；]/u).map((city) => city.trim()).filter(Boolean),
    referral: text(p.referralSource),
    summary: text(p.summary),
    exp: p.experiences.map((item) => Object.freeze({
      id: item.id,
      title: item.title,
      company: item.company,
      loc: [item.city, item.region].filter((part): part is NonNullable<typeof part> => part !== null && part !== '').join(', '),
      current: item.isCurrent,
      from: monthOf(item.startDate),
      to: item.isCurrent ? '' : monthOf(item.endDate),
      desc: text(item.description),
    })),
    edu: p.educations.map((item) => Object.freeze({
      id: item.id,
      school: item.school,
      degree: item.degreeLevel === null ? '' : DEGREE_LABEL[item.degreeLevel] ?? '',
      major: text(item.fieldOfStudy),
      gpa: text(item.gpa),
      current: item.isCurrent,
      from: monthOf(item.startDate),
      to: monthOf(item.isCurrent ? item.expectedGraduationDate : item.endDate),
    })),
    skills: p.skills.map((item) => item.name),
    langs: p.languages.map((item) => `${item.language} · ${proficiency[item.proficiency]}`),
  });
}

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

/** 改过的「项」数：一个标量一项；电话、薪资各算一项；集合里改了的每一格一项，多出或少了的每一行一项。 */
export function dirtyCount(draft: ProfileDraft, base: ProfileDraft): number {
  let n = 0;
  const scalar = (keys: readonly (keyof ProfileDraft)[]): void => { if (keys.some((key) => !same(draft[key], base[key]))) n += 1; };
  for (const key of ['first', 'last', 'preferred', 'pronouns', 'email', 'line1', 'city', 'region', 'postal', 'country',
    'linkedin', 'github', 'portfolio', 'website', 'workAuth', 'sponsor', 'over18', 'modes', 'start', 'notice', 'relocate',
    'cities', 'referral', 'summary', 'skills', 'langs'] as const) scalar([key]);
  scalar(['phoneCc', 'phone']);
  scalar(['salary', 'currency', 'period']);
  for (const [list, baseList] of [[draft.exp, base.exp], [draft.edu, base.edu]] as const) {
    n += Math.abs(list.length - baseList.length);
    list.forEach((item, index) => {
      const before = baseList[index] as unknown as Record<string, unknown> | undefined;
      if (before === undefined) return;
      for (const [key, value] of Object.entries(item)) if (key !== 'id' && !same(value, before[key])) n += 1;
    });
  }
  return n;
}

export type ValidationErrors = Readonly<Record<string, string>>;

/** `say`：每一种问题怎么说（编辑器按浮层的界面语言传；不传是中文）。 */
export function validate(draft: ProfileDraft, say: DockCopy['profile']['errors'] = COPY.profile.errors): ValidationErrors {
  const errors: Record<string, string> = {};
  if (draft.first.trim() === '') errors.first = say.first;
  if (draft.last.trim() === '') errors.last = say.last;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(draft.email.trim())) errors.email = say.email;
  if (draft.phone.replace(/\D/gu, '').length < 7) errors.phone = say.phone;
  if (draft.salary.trim() !== '' && !/^\d[\d,]*(\.\d{1,2})?$/u.test(draft.salary.trim())) errors.salary = say.salary;
  for (const [key, url] of [['linkedin', draft.linkedin], ['github', draft.github], ['portfolio', draft.portfolio], ['website', draft.website]] as const) {
    if (url.trim() !== '' && normalizeUrl(url) === null) errors[key] = say.url;
  }
  draft.exp.forEach((item, index) => {
    if (item.title.trim() === '') errors[`exp.${index}.title`] = say.title;
    if (item.company.trim() === '') errors[`exp.${index}.company`] = say.company;
  });
  draft.edu.forEach((item, index) => {
    if (item.school.trim() === '') errors[`edu.${index}.school`] = say.school;
  });
  return errors;
}

/** 没写协议的链接补 https://；补了也不像链接就算无效。 */
export function normalizeUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const candidate = /^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    return url.hostname.includes('.') ? url.toString() : null;
  } catch {
    return null;
  }
}

function newId(): string {
  return globalThis.crypto.randomUUID();
}

const LINK_KINDS = [['linkedin', 'LINKEDIN'], ['github', 'GITHUB'], ['portfolio', 'PORTFOLIO'], ['website', 'WEBSITE']] as const;

/**
 * 草稿 → 一份 PATCH（只带改过的部分）。没改任何 Profile V2 的东西就返回 null。
 */
export function patchFromDraft(draft: ProfileDraft, base: ProfileDraft, snapshot: CandidateProfileSnapshotV2): PatchCandidateProfileV2 | null {
  const p = snapshot.profile;
  const fields: Record<string, unknown> = {};
  const set = (changed: boolean, path: string, value: unknown): void => { if (changed) fields[path] = value; };
  const changed = (...keys: (keyof ProfileDraft)[]): boolean => keys.some((key) => !same(draft[key], base[key]));
  set(changed('first'), 'identity.firstName', opt(draft.first));
  set(changed('last'), 'identity.lastName', opt(draft.last));
  set(changed('preferred'), 'identity.preferredName', opt(draft.preferred));
  set(changed('pronouns'), 'identity.pronouns', opt(draft.pronouns));
  set(changed('email'), 'contact.email', opt(draft.email));
  if (changed('phoneCc', 'phone')) {
    const ccDigits = (draft.phoneCc.trim() || '+1').replace(/\D/gu, '');
    let digits = draft.phone.replace(/\D/gu, '');
    // 用户在号码里又带了一遍区号（「+1 415 …」）：去掉，不叠两次。
    if (draft.phone.trim().startsWith('+') && digits.startsWith(ccDigits)) digits = digits.slice(ccDigits.length);
    fields['contact.phone.countryCode'] = `+${ccDigits}`;
    fields['contact.phone.e164'] = digits === '' ? null : `+${ccDigits}${digits}`;
    fields['contact.phone.display'] = opt(draft.phone);
  }
  set(changed('line1'), 'address.line1', opt(draft.line1));
  set(changed('city'), 'address.city', opt(draft.city));
  set(changed('region'), 'address.region', opt(draft.region));
  set(changed('postal'), 'address.postalCode', opt(draft.postal));
  set(changed('country'), 'address.countryCode', opt(draft.country.toUpperCase()));
  set(changed('over18'), 'eligibility.over18', draft.over18 === '' ? null : draft.over18 === 'yes');
  if (changed('salary', 'currency', 'period')) {
    fields['compensation.expectedSalaryAmount'] = opt(draft.salary.replace(/,/gu, ''));
    fields['compensation.expectedSalaryCurrency'] = opt(draft.currency.toUpperCase());
    fields['compensation.expectedSalaryPeriod'] = WIRE_BY_PERIOD[draft.period] ?? null;
  }
  set(changed('modes'), 'preferences.workModes', draft.modes.map((mode) => WORK_MODE_BY_LABEL[mode]).filter((mode): mode is ProfileWorkModeV2 => mode !== undefined));
  set(changed('start'), 'availability.earliestStartDate', opt(draft.start));
  set(changed('notice'), 'availability.noticePeriodDays', draft.notice);
  set(changed('relocate'), 'preferences.openToRelocation', draft.relocate === '' ? null : draft.relocate === 'yes');
  set(changed('cities'), 'preferences.openToRelocationCities', opt(draft.cities.join(', ')));
  set(changed('referral'), 'referralSource', opt(draft.referral));
  set(changed('summary'), 'summary', opt(draft.summary));

  const patch: Record<string, unknown> = {
    schemaVersion: 2,
    expectedRevision: snapshot.revision,
    expectedDeletionEpoch: snapshot.deletionEpoch,
  };
  if (Object.keys(fields).length > 0) patch.fields = fields as CandidateProfileScalarPatchV2;

  // 链接：一改就整份重发；编辑器管的四种各取主链接，其余原样带上。
  if (changed('linkedin', 'github', 'portfolio', 'website')) {
    const links: Record<string, unknown>[] = [];
    const primary = { ...p.primaryLinkIdByKind } as Record<string, string | null>;
    const handled = new Set<string>();
    for (const [key, kind] of LINK_KINDS) {
      const url = normalizeUrl(draft[key]);
      const existing = p.links.find((item) => item.id === p.primaryLinkIdByKind[kind]) ?? p.links.find((item) => item.kind === kind);
      if (existing !== undefined) handled.add(existing.id);
      if (url === null) { primary[kind] = null; continue; }
      if (existing !== undefined) {
        links.push({ id: existing.id, kind, label: existing.label, url, confirmFields: ['kind', 'url'] });
        primary[kind] = existing.id;
      } else {
        const id = newId();
        links.push({ id, kind, label: null, url, confirmFields: ['kind', 'label', 'url'] });
        primary[kind] = id;
      }
    }
    for (const item of p.links) {
      if (handled.has(item.id)) continue;
      links.push({ id: item.id, kind: item.kind, label: item.label, url: item.url, confirmFields: [] });
    }
    for (const [kind, id] of Object.entries(primary)) if (id !== null && !links.some((link) => link.id === id)) primary[kind] = null;
    patch.links = links;
    patch.primaryLinkIdByKind = primary;
  }

  // 工作许可：美国那一条；另两个国家的记录原样带上。
  if (changed('workAuth', 'sponsor')) {
    const wire = (value: string) => (value === 'yes' ? 'YES' : value === 'no' ? 'NO' : 'UNSPECIFIED');
    const rows = p.workAuthorizations
      .filter((item) => item.regionCode !== 'US')
      .map((item) => ({ regionCode: item.regionCode, authorizedToWork: item.authorizedToWork, requiresSponsorship: item.requiresSponsorship, confirmFields: [] as string[] }));
    if (draft.workAuth !== '' || draft.sponsor !== '') {
      rows.push({ regionCode: 'US' as never, authorizedToWork: wire(draft.workAuth) as never, requiresSponsorship: wire(draft.sponsor) as never, confirmFields: ['authorizedToWork', 'regionCode', 'requiresSponsorship'] });
    }
    patch.workAuthorizations = rows.sort((left, right) => String(left.regionCode).localeCompare(String(right.regionCode)));
  }

  // 经历：整份重发；编辑器里看不到的字段从原行抄。
  if (!same(draft.exp, base.exp)) {
    const experiences = draft.exp.map((item) => {
      const existing = item.id === null ? undefined : p.experiences.find((row) => row.id === item.id);
      const [city, region] = splitLocation(item.loc);
      return {
        id: existing?.id ?? newId(),
        company: item.company.trim(),
        title: item.title.trim(),
        city: city ?? null,
        region: region ?? existing?.region ?? null,
        employmentType: existing?.employmentType ?? null,
        startDate: dateOf(item.from),
        endDate: item.current ? null : dateOf(item.to),
        isCurrent: item.current,
        description: opt(item.desc),
        confirmFields: existing === undefined
          ? ['city', 'company', 'description', 'employmentType', 'endDate', 'isCurrent', 'region', 'startDate', 'title']
          : ['city', 'company', 'description', 'endDate', 'isCurrent', 'region', 'startDate', 'title'],
      };
    });
    patch.experiences = experiences;
    const kept = experiences.find((item) => item.id === p.primaryCurrentExperienceId && item.isCurrent);
    patch.primaryCurrentExperienceId = kept?.id ?? experiences.find((item) => item.isCurrent)?.id ?? null;
  }

  if (!same(draft.edu, base.edu)) {
    patch.educations = draft.edu.map((item) => {
      const existing = item.id === null ? undefined : p.educations.find((row) => row.id === item.id);
      // 在读是编辑器里那一个开关（从前沿用原行、不确认——简历导入的教育改过之后照样整条不填，2026-10-03 后端体检）。
      const current = item.current;
      const graduation = dateOf(item.to);
      return {
        id: existing?.id ?? newId(),
        school: item.school.trim(),
        degree: existing?.degree ?? null,
        degreeLevel: DEGREE_BY_LABEL[item.degree] ?? (item.degree === '' ? null : existing?.degreeLevel ?? null),
        fieldOfStudy: opt(item.major),
        city: existing?.city ?? null,
        region: existing?.region ?? null,
        startDate: dateOf(item.from),
        endDate: current ? null : graduation,
        expectedGraduationDate: current ? graduation : null,
        isCurrent: current,
        gpa: opt(item.gpa),
        gpaScale: existing?.gpaScale ?? null,
        coursework: existing?.coursework ?? null,
        confirmFields: existing === undefined
          ? ['city', 'coursework', 'degree', 'degreeLevel', 'endDate', 'expectedGraduationDate', 'fieldOfStudy', 'gpa', 'gpaScale', 'isCurrent', 'region', 'school', 'startDate']
          : ['degreeLevel', 'endDate', 'expectedGraduationDate', 'fieldOfStudy', 'gpa', 'isCurrent', 'school', 'startDate'],
      };
    });
  }

  if (changed('skills')) {
    const seen = new Set<string>();
    patch.skills = draft.skills.filter((name) => {
      const key = name.trim().toLocaleLowerCase('en-US');
      if (key === '' || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((name) => {
      const existing = p.skills.find((row) => row.name.trim().toLocaleLowerCase('en-US') === name.trim().toLocaleLowerCase('en-US'));
      return existing === undefined
        ? { id: newId(), name: name.trim(), categories: ['TECHNICAL'], confirmFields: ['categories', 'name'] }
        : { id: existing.id, name: existing.name, categories: existing.categories, confirmFields: ['categories', 'name'] };
    });
  }

  if (changed('langs')) {
    patch.languages = draft.langs.map((tag) => {
      const [language, level] = tag.split(/\s*[·•|/]\s*/u);
      const name = (language ?? tag).trim();
      const word = (level ?? '').trim();
      const proficiency = PROFICIENCY_BY_LABEL[word] ?? PROFICIENCY_BY_LABEL[word.toLocaleLowerCase('en-US')] ?? 'PROFESSIONAL';
      const existing = p.languages.find((row) => row.language.trim().toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'));
      return { id: existing?.id ?? newId(), language: name, proficiency, confirmFields: ['language', 'proficiency'] };
    }).filter((row) => row.language !== '');
  }

  return Object.keys(patch).length > 3 ? (patch as unknown as PatchCandidateProfileV2) : null;
}

function splitLocation(value: string): [string | null, string | null] {
  const trimmed = value.trim();
  if (trimmed === '') return [null, null];
  const index = trimmed.lastIndexOf(',');
  if (index < 0) return [trimmed, null];
  const city = trimmed.slice(0, index).trim();
  const region = trimmed.slice(index + 1).trim();
  return [city === '' ? null : city, region === '' ? null : region];
}
