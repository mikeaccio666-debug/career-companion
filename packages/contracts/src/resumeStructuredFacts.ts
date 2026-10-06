/** Additive, raw-verbatim resume candidates. These never carry Profile IDs or confirmation authority. */
import {
  PROFILE_V2_SCALAR_PATHS, PROFILE_V2_EXPERIENCE_FIELD_CODES, PROFILE_V2_EDUCATION_FIELD_CODES,
  PROFILE_V2_SKILL_FIELD_CODES, PROFILE_V2_LANGUAGE_FIELD_CODES, PROFILE_V2_PROJECT_FIELD_CODES,
  PROFILE_V2_ACHIEVEMENT_FIELD_CODES, PROFILE_V2_COLLECTION_LIMITS,
  type CandidateProfileScalarPathV2, type ProfileExperienceFieldCodeV2, type ProfileEducationFieldCodeV2,
  type ProfileSkillFieldCodeV2, type ProfileLanguageFieldCodeV2, type ProfileProjectFieldCodeV2,
  type ProfileAchievementFieldCodeV2,
} from './profileV2.ts';
import type { ResumeProfileTextSuggestionV1 } from './resumeProfileSuggestions.ts';

export const RESUME_STRUCTURED_SCALAR_PATHS = PROFILE_V2_SCALAR_PATHS.filter(path => path !== 'noExperience');
export type ResumeStructuredScalarPathV1 = Exclude<CandidateProfileScalarPathV2, 'noExperience'>;
export type ResumeStructuredProjectFieldV1 = Exclude<ProfileProjectFieldCodeV2, 'skillIds'> | 'skillNames';
export type ResumeStructuredAchievementFieldV1 = Exclude<ProfileAchievementFieldCodeV2, 'context'>;
export const RESUME_STRUCTURED_GROUP_FIELDS = {
  experiences: PROFILE_V2_EXPERIENCE_FIELD_CODES,
  educations: PROFILE_V2_EDUCATION_FIELD_CODES,
  skills: PROFILE_V2_SKILL_FIELD_CODES,
  languages: PROFILE_V2_LANGUAGE_FIELD_CODES,
  projects: [...PROFILE_V2_PROJECT_FIELD_CODES.filter(key => key !== 'skillIds'), 'skillNames'],
  achievements: PROFILE_V2_ACHIEVEMENT_FIELD_CODES.filter(key => key !== 'context'),
} as const;
export type ResumeStructuredFieldsV1<Key extends string> = Readonly<Partial<Record<Key, ResumeProfileTextSuggestionV1>>>;
export interface ResumeStructuredEntryV1<Key extends string> {
  readonly id: string;
  readonly fields: ResumeStructuredFieldsV1<Key>;
  /** Literal source is verified; membership in one record still requires an explicit user decision. */
  readonly association?: { readonly status: 'UNCONFIRMED'; readonly sourceExcerpt: string };
}
export interface ResumeStructuredAchievementV1 extends ResumeStructuredEntryV1<ResumeStructuredAchievementFieldV1> {
  readonly context: { readonly type: 'EXPERIENCE' | 'EDUCATION' | 'PROJECT'; readonly suggestionId: string } | null;
}
export interface ResumeProfileStructuredFactsV1 {
  readonly scalars: ResumeStructuredFieldsV1<ResumeStructuredScalarPathV1>;
  readonly experiences: readonly ResumeStructuredEntryV1<ProfileExperienceFieldCodeV2>[];
  readonly educations: readonly ResumeStructuredEntryV1<ProfileEducationFieldCodeV2>[];
  readonly skills: readonly ResumeStructuredEntryV1<ProfileSkillFieldCodeV2>[];
  readonly languages: readonly ResumeStructuredEntryV1<ProfileLanguageFieldCodeV2>[];
  readonly projects: readonly ResumeStructuredEntryV1<ResumeStructuredProjectFieldV1>[];
  readonly achievements: readonly ResumeStructuredAchievementV1[];
}

export function parseResumeProfileStructuredFactsV1(value: unknown): ResumeProfileStructuredFactsV1 | null {
  if (!object(value) || Object.keys(value).length !== 7 || !fields(value.scalars, RESUME_STRUCTURED_SCALAR_PATHS)) return null;
  const ids = new Map<string, Set<string>>();
  for (const [group, keys] of Object.entries(RESUME_STRUCTURED_GROUP_FIELDS)) {
    const entries = value[group];
    if (!Array.isArray(entries) || entries.length > PROFILE_V2_COLLECTION_LIMITS[group as keyof typeof RESUME_STRUCTURED_GROUP_FIELDS]) return null;
    const seen = new Set<string>(); ids.set(group, seen);
    for (const entry of entries) {
      if (!object(entry) || Object.keys(entry).length !== (group === 'achievements' ? 3 : 2) + (Object.hasOwn(entry, 'association') ? 1 : 0)
        || !id(entry.id) || seen.has(entry.id) || !fields(entry.fields, keys) || Object.keys(entry.fields).length === 0) return null;
      if (Object.hasOwn(entry, 'association') && (group === 'skills' || group === 'languages'
        || !object(entry.association) || Object.keys(entry.association).length !== 2
        || entry.association.status !== 'UNCONFIRMED' || typeof entry.association.sourceExcerpt !== 'string'
        || !entry.association.sourceExcerpt.trim() || entry.association.sourceExcerpt.length > 16_000
        || !Object.values(entry.fields as Record<string, ResumeProfileTextSuggestionV1>).every(field => entry.association && (entry.association as { sourceExcerpt: string }).sourceExcerpt.includes(field.value)))) return null;
      if (group === 'achievements' && entry.association && entry.context !== null) return null;
      seen.add(entry.id);
      if (group === 'achievements' && entry.context !== null) {
        if (!object(entry.context) || Object.keys(entry.context).length !== 2
          || (entry.context.type !== 'EXPERIENCE' && entry.context.type !== 'EDUCATION' && entry.context.type !== 'PROJECT')
          || !id(entry.context.suggestionId)) return null;
      }
    }
  }
  for (const entry of value.achievements as { context: { type: string; suggestionId: string } | null }[]) {
    if (!entry.context) continue;
    const group = entry.context.type === 'EXPERIENCE' ? 'experiences' : entry.context.type === 'EDUCATION' ? 'educations' : 'projects';
    if (!ids.get(group)!.has(entry.context.suggestionId) || (value[group] as { id: string; association?: unknown }[]).find(parent => parent.id === entry.context!.suggestionId)?.association) return null;
  }
  return value as unknown as ResumeProfileStructuredFactsV1;
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function id(value: unknown): value is string { return typeof value === 'string' && /^[a-z]+-[0-9]{2,3}$/u.test(value); }
function fields(value: unknown, keys: readonly string[]): value is Record<string, ResumeProfileTextSuggestionV1> {
  return object(value) && Object.entries(value).every(([key, field]) => keys.includes(key) && object(field)
    && Object.keys(field).length === 3 && field.source === 'RESUME_TEXT' && typeof field.value === 'string'
    && field.value.trim().length > 0 && field.value.length <= (['summary', 'description', 'statement', 'coursework'].includes(key) ? 4000 : key === 'url' ? 2048 : 256)
    && typeof field.confidence === 'number' && Number.isFinite(field.confidence) && field.confidence >= 0 && field.confidence <= 1);
}
