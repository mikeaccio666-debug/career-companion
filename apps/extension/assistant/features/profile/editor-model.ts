import * as C from '@edaix/contracts';
import type { MessageKey } from '../../i18n';

export const PROFILE_SECTIONS = ['basic', 'summary', 'links', 'experiences', 'educations', 'skills', 'languages', 'projects', 'achievements', 'availability', 'workAuthorizations'] as const;
export type ProfileSection = typeof PROFILE_SECTIONS[number];
type Collection = Exclude<ProfileSection, 'basic' | 'summary' | 'availability'>;
export type EditorValue = string | string[];
export interface EditorField { key: string; label: MessageKey; kind?: 'text' | 'long' | 'select' | 'multi' | 'date' | 'number' | 'part'; options?: readonly string[]; required?: boolean }
export interface EditorRow { key: string; id?: string; values: Record<string, EditorValue>; confirmed?: boolean }
export interface ProfileDraft { section: ProfileSection; base: C.CandidateProfileSnapshotV2; rows: EditorRow[]; extras: Record<string, EditorValue> }
export type EditorCode = 'NO_CHANGES' | 'VALIDATION_FAILED' | 'CONFIRM_REQUIRED' | 'REFERENCE_IN_USE' | 'REBASE_BLOCKED';
export type EditorResult<T> = { ok: true; value: T } | { ok: false; code: EditorCode };
export interface ProfileEditorState { intake?: { sessionId: string; turnId: string; candidateId: string }; draft: ProfileDraft; phase: 'editing' | 'saving' | 'review'; code?: EditorCode | C.AssistantProfileCode; latest?: C.CandidateProfileSnapshotV2; reading?: boolean }
const yesNo = ['true', 'false'];
const field = (key: string, label: MessageKey, kind: EditorField['kind'] = 'text', options?: readonly string[], required = false): EditorField => ({ key, label, kind, options, required });
const dateFields = [field('startDate', '开始年月', 'part'), field('endDate', '结束年月', 'part'), field('isCurrent', '目前仍在进行', 'select', yesNo, true)];
export const sectionLabels: Record<ProfileSection, MessageKey> = { basic: '基本资料', summary: '概述', links: '链接', experiences: '工作经历', educations: '教育', skills: '技能', languages: '语言', projects: '项目', achievements: '成果', availability: '可开始时间', workAuthorizations: '工作许可' };
export const sectionFields: Record<ProfileSection, EditorField[]> = {
  basic: [field('identity.firstName', '名'), field('identity.middleName', '中间名'), field('identity.lastName', '姓'), field('identity.fullName', '完整姓名'), field('identity.preferredName', '称呼'), field('contact.email', '邮箱'), field('contact.phone.countryCode', '电话国际区号'), field('contact.phone.e164', '国际格式电话号码'), field('contact.phone.display', '电话显示格式'), field('contact.phone.type', '电话类型', 'select', C.PROFILE_V2_PHONE_TYPES), field('address.line1', '地址第一行'), field('address.line2', '地址第二行'), field('address.city', '所在城市'), field('address.region', '州或地区'), field('address.postalCode', '邮政编码'), field('address.countryCode', '国家或地区代码')],
  summary: [field('summary', '概述', 'long')],
  availability: [field('availability.earliestStartDate', '可开始时间', 'date'), field('availability.noticePeriodDays', '提前通知天数', 'number')],
  links: [field('kind', '链接类型', 'select', C.PROFILE_V2_LINK_KINDS, true), field('label', '链接名称'), field('url', '网址', 'text', undefined, true)],
  experiences: [field('company', '公司', 'text', undefined, true), field('title', '职位', 'text', undefined, true), field('city', '所在城市'), field('region', '州或地区'), field('employmentType', '雇佣类型', 'select', C.PROFILE_V2_EMPLOYMENT_TYPES), ...dateFields, field('description', '经历描述', 'long')],
  educations: [field('school', '学校', 'text', undefined, true), field('degree', '学位名称'), field('degreeLevel', '学历层次', 'select', C.PROFILE_V2_DEGREE_LEVELS), field('fieldOfStudy', '专业'), field('city', '所在城市'), field('region', '州或地区'), ...dateFields, field('expectedGraduationDate', '预计毕业年月', 'part'), field('gpa', 'GPA'), field('gpaScale', 'GPA 满分'), field('coursework', '课程', 'long')],
  skills: [field('name', '技能名称', 'text', undefined, true), field('categories', '技能分类', 'multi', C.PROFILE_V2_SKILL_CATEGORIES, true)],
  languages: [field('language', '语言名称', 'text', undefined, true), field('proficiency', '熟练程度', 'select', C.PROFILE_V2_LANGUAGE_PROFICIENCIES, true)],
  projects: [field('title', '项目名称', 'text', undefined, true), field('organization', '组织'), field('role', '担任角色'), field('location', '地点'), field('url', '网址'), ...dateFields, field('description', '项目描述', 'long'), field('skillIds', '相关技能', 'multi')],
  achievements: [field('kind', '成果类型', 'select', C.PROFILE_V2_ACHIEVEMENT_KINDS, true), field('title', '成果名称', 'text', undefined, true), field('statement', '成果说明', 'long', undefined, true), field('occurredAt', '发生年月', 'part'), field('url', '网址'), field('context.type', '关联经历类型', 'select', C.PROFILE_V2_ACHIEVEMENT_CONTEXT_TYPES, true), field('context.itemId', '关联经历', 'select')],
  workAuthorizations: [field('regionCode', '国家或地区代码', 'text', undefined, true), field('authorizedToWork', '拥有该地区工作许可', 'select', C.PROFILE_V2_WORK_AUTHORIZATION_ANSWERS, true), field('requiresSponsorship', '需要签证支持', 'select', C.PROFILE_V2_WORK_AUTHORIZATION_ANSWERS, true)],
};
const codes: Record<Collection, readonly string[]> = { links: C.PROFILE_V2_LINK_FIELD_CODES, experiences: C.PROFILE_V2_EXPERIENCE_FIELD_CODES, educations: C.PROFILE_V2_EDUCATION_FIELD_CODES, skills: C.PROFILE_V2_SKILL_FIELD_CODES, languages: C.PROFILE_V2_LANGUAGE_FIELD_CODES, projects: C.PROFILE_V2_PROJECT_FIELD_CODES, achievements: C.PROFILE_V2_ACHIEVEMENT_FIELD_CODES, workAuthorizations: C.PROFILE_V2_WORK_AUTHORIZATION_FIELD_CODES };
export const isCollection = (section: ProfileSection): section is Collection => section in codes;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function get(value: unknown, path: string): unknown { return path.split('.').reduce<unknown>((v, key) => v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined, value); }
function encode(v: unknown, spec: EditorField): EditorValue {
  if (spec.kind === 'multi') return Array.isArray(v) ? [...v] : [];
  if (spec.kind === 'part' && v && typeof v === 'object' && 'year' in v && 'month' in v) return `${v.year}${v.month ? '-' + String(v.month).padStart(2, '0') : ''}`;
  return v === undefined || v === null ? '' : String(v);
}
function decode(v: EditorValue, spec: EditorField): unknown {
  if (Array.isArray(v)) return [...new Set(v)].sort();
  const text = v.trim();
  if (!text) return null;
  if (spec.key === 'isCurrent' || spec.key === 'noExperience') return text === 'true' ? true : text === 'false' ? false : text;
  if (spec.kind === 'number') return /^\d+$/.test(text) ? Number(text) : text;
  if (spec.kind === 'part') return /^\d{4}(?:-\d{2})?$/.test(text) ? { year: Number(text.slice(0, 4)), month: text.length === 4 ? null : Number(text.slice(5)) } : text;
  if (spec.key.endsWith('countryCode') && !spec.key.startsWith('contact.') || spec.key === 'regionCode') return text.toUpperCase();
  return text;
}
export function createProfileDraft(base: C.CandidateProfileSnapshotV2, section: ProfileSection): ProfileDraft {
  const p = base.profile;
  const rows = isCollection(section) ? p[section].map((row) => ({ key: 'id' in row ? row.id : row.regionCode, ...('id' in row ? { id: row.id } : {}), values: Object.fromEntries(sectionFields[section].map(spec => [spec.key, encode(get(row, spec.key), spec)])), confirmed: false })) : [{ key: 'scalar', values: Object.fromEntries(sectionFields[section].map(spec => [spec.key, encode(get(p, spec.key), spec)])) }];
  const extras: ProfileDraft['extras'] = {};
  if (section === 'links') for (const kind of C.PROFILE_V2_LINK_KINDS) extras[kind] = p.primaryLinkIdByKind[kind] ?? '';
  if (section === 'experiences') { extras.primaryCurrentExperienceId = p.primaryCurrentExperienceId ?? ''; extras.noExperience = p.noExperience === null ? '' : String(p.noExperience); }
  return { base, section, rows, extras };
}
export function addProfileRow(draft: ProfileDraft, key: string): ProfileDraft {
  if (!isCollection(draft.section) || draft.rows.length >= C.PROFILE_V2_COLLECTION_LIMITS[draft.section]) return draft;
  return { ...draft, rows: [...draft.rows, { key, values: Object.fromEntries(sectionFields[draft.section].map(spec => [spec.key, spec.kind === 'multi' ? [] : ''])), confirmed: false }] };
}
export function editProfileValue(draft: ProfileDraft, key: string, fieldKey: string, value: EditorValue): ProfileDraft {
  if (key === 'extras') return { ...draft, extras: { ...draft.extras, [fieldKey]: value } };
  return { ...draft, rows: draft.rows.map(row => {
    if (row.key !== key) return row;
    if (fieldKey === '$confirmed') return { ...row, confirmed: value === 'true' };
    if (!sectionFields[draft.section].some(spec => spec.key === fieldKey)) return row;
    const values = { ...row.values, [fieldKey]: value };
    if (fieldKey === 'isCurrent' && value === 'true') values.endDate = '';
    if (fieldKey === 'isCurrent' && value === 'false' && draft.section === 'educations') values.expectedGraduationDate = '';
    if (fieldKey === 'context.type') values['context.itemId'] = '';
    return { ...row, values, confirmed: false };
  }) };
}
export function removeProfileRow(draft: ProfileDraft, key: string): ProfileDraft { return { ...draft, rows: draft.rows.filter(row => row.key !== key) }; }
function rowWire(draft: ProfileDraft, row: EditorRow): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const spec of sectionFields[draft.section]) {
    const value = decode(row.values[spec.key] ?? '', spec);
    if (spec.key.startsWith('context.')) { result.context ??= {}; (result.context as Record<string, unknown>)[spec.key.slice(8)] = value; }
    else result[spec.key] = value;
  }
  return result;
}
function referenceInUse(draft: ProfileDraft): boolean {
  if (!isCollection(draft.section)) return false;
  const base = draft.base.profile, ids = new Set(draft.rows.map(row => row.id));
  if (draft.section === 'skills') return base.projects.some(row => row.skillIds.some(id => !ids.has(id)));
  const type = ({ experiences: 'EXPERIENCE', projects: 'PROJECT', educations: 'EDUCATION' } as Record<string, string>)[draft.section];
  return !!type && base.achievements.some(row => row.context.type === type && !ids.has(row.context.itemId ?? undefined));
}
export function buildProfilePatch(draft: ProfileDraft): EditorResult<C.PatchCandidateProfileV2> {
  const before = createProfileDraft(draft.base, draft.section);
  const explicitWorkConfirmation = draft.section === 'workAuthorizations' && draft.rows.length > 0 && draft.rows.every(row => row.confirmed);
  if (!explicitWorkConfirmation && equal(before.rows.map(r => r.values), draft.rows.map(r => r.values)) && equal(before.rows.map(r => r.key), draft.rows.map(r => r.key)) && equal(before.extras, draft.extras)) return { ok: false, code: 'NO_CHANGES' };
  if (referenceInUse(draft)) return { ok: false, code: 'REFERENCE_IN_USE' };
  const raw: Record<string, unknown> = { schemaVersion: 2, expectedRevision: draft.base.revision, expectedDeletionEpoch: draft.base.deletionEpoch };
  if (isCollection(draft.section)) {
    if (draft.section === 'workAuthorizations' && draft.rows.some(row => !row.confirmed)) return { ok: false, code: 'CONFIRM_REQUIRED' };
    const section = draft.section;
    const rows = draft.rows.map(row => {
      const old = before.rows.find(r => r.key === row.key), values = rowWire(draft, row), original = old ? rowWire(before, old) : null;
      return { ...(row.id ? { id: row.id } : {}), ...values, confirmFields: codes[section].filter(key => !row.id || !original || !equal(values[key], original[key])).slice().sort() };
    });
    if (section === 'workAuthorizations') rows.sort((a, b) => String((a as Record<string, unknown>).regionCode).localeCompare(String((b as Record<string, unknown>).regionCode)));
    raw[section] = rows;
    if (section === 'links') raw.primaryLinkIdByKind = Object.fromEntries(C.PROFILE_V2_LINK_KINDS.map(kind => [kind, draft.rows.some(row => row.id && row.id === draft.extras[kind] && row.values.kind === kind) ? draft.extras[kind] : null]));
    if (section === 'experiences') {
      raw.primaryCurrentExperienceId = draft.rows.some(row => row.id && row.id === draft.extras.primaryCurrentExperienceId && row.values.isCurrent === 'true') ? draft.extras.primaryCurrentExperienceId : null;
      if (draft.extras.noExperience === 'true' && draft.rows.length) return { ok: false, code: 'VALIDATION_FAILED' };
      if (draft.extras.noExperience !== before.extras.noExperience) raw.fields = { noExperience: draft.extras.noExperience === '' ? null : draft.extras.noExperience === 'true' };
    }
  } else {
    const values = rowWire(draft, draft.rows[0]!), original = rowWire(before, before.rows[0]!);
    raw.fields = Object.fromEntries(Object.entries(values).filter(([key, value]) => !equal(value, original[key])));
    if (!Object.keys(raw.fields as object).length) return { ok: false, code: 'NO_CHANGES' };
  }
  const patch = C.parseCandidateProfileV2Patch(raw);
  return patch ? { ok: true, value: patch } : { ok: false, code: 'VALIDATION_FAILED' };
}
/** Explicit three-way merge. This changes the editing base, never submits a write. */
export function rebaseProfileDraft(draft: ProfileDraft, latest: C.CandidateProfileSnapshotV2): EditorResult<ProfileDraft> {
  if (draft.base.deletionEpoch !== latest.deletionEpoch) return { ok: false, code: 'REBASE_BLOCKED' };
  const old = createProfileDraft(draft.base, draft.section), fresh = createProfileDraft(latest, draft.section);
  for (const row of draft.rows) {
    const original = old.rows.find(v => v.key === row.key);
    if (!original) {
      // A previous uncertain save may already have assigned this new row a server id.
      // Only an exact value match introduced after our base can consume that draft row.
      const candidates = fresh.rows.filter(candidate => !old.rows.some(v => v.key === candidate.key) && equal(rowWire(fresh, candidate), rowWire(draft, row)));
      if (candidates.length > 1) return { ok: false, code: 'REBASE_BLOCKED' };
      if (candidates.length === 0) fresh.rows.push({ ...structuredClone(row), confirmed: false });
      continue;
    }
    const target = fresh.rows.find(v => v.key === row.key);
    const changed = Object.keys(row.values).filter(key => !equal(row.values[key], original.values[key]));
    if (!target && changed.length) return { ok: false, code: 'REBASE_BLOCKED' };
    if (target) for (const key of changed) target.values[key] = structuredClone(row.values[key]!);
  }
  fresh.rows = fresh.rows.filter(row => !old.rows.some(v => v.key === row.key) || draft.rows.some(v => v.key === row.key));
  for (const key of Object.keys(draft.extras)) if (!equal(draft.extras[key], old.extras[key])) fresh.extras[key] = structuredClone(draft.extras[key]!);
  return referenceInUse(fresh) ? { ok: false, code: 'REFERENCE_IN_USE' } : { ok: true, value: fresh };
}
export function interruptProfileEditor(editor: ProfileEditorState | undefined): ProfileEditorState | undefined {
  return editor && { ...editor, reading: false, ...(editor.phase === 'saving' ? { phase: 'review', code: 'SAVE_UNCERTAIN', latest: undefined } as const : {}) };
}
