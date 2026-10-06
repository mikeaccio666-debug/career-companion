import { parseUuid, type DecimalString, type Uuid } from './common.ts';
import { parseCandidateProfileV2Patch } from './profilePatchValidation.ts';
import { closedRecord } from './profileSnapshotValidation.ts';
import { PROFILE_V2_SCALAR_PATHS, PROFILE_V2_LINK_FIELD_CODES, PROFILE_V2_EXPERIENCE_FIELD_CODES,
  PROFILE_V2_EDUCATION_FIELD_CODES, PROFILE_V2_SKILL_FIELD_CODES, PROFILE_V2_LANGUAGE_FIELD_CODES,
  PROFILE_V2_PROJECT_FIELD_CODES, PROFILE_V2_ACHIEVEMENT_FIELD_CODES, type PatchCandidateProfileV2 } from './profileV2.ts';

export const INTAKE_TEXT_LIMIT = 6000;
export const INTAKE_REPLY_FEATURE = 'profile_intake_reply_v1';
export const INTAKE_SPEECH_FEATURE = 'profile_intake_speech_second_v1';
export const INTAKE_SECTIONS = ['basic', 'summary', 'availability', 'links', 'experiences', 'educations', 'skills', 'languages', 'projects', 'achievements'] as const;
export type IntakeSection = typeof INTAKE_SECTIONS[number];
/**
 * Collect only fields supported by intake editing. Sensitive declarations stay manual-only.
 *
 * `referralSource`（「你从哪听说这个职位」）也在手填那一侧：它是**这一次申请**的事，
 * 不是简历里读得出来的东西。它接替了从前 `mobility.*` 在这张排除表上的位置。
 */
export const INTAKE_PROFILE_FIELDS: readonly { section: IntakeSection; path: string }[] = [
  // 2026-09-21 加的那几组（代词、期望薪资、办公模式、搬迁、年满 18）不进老师的问询面：
  // 加一个档案字段不该静默变成一条付费问询，那一面要另行评审。
  ...PROFILE_V2_SCALAR_PATHS.filter(path => path !== 'noExperience' && path !== 'referralSource' && path !== 'identity.pronouns' &&
    !path.startsWith('compensation.') && !path.startsWith('preferences.') && !path.startsWith('eligibility.')).map(path => ({ path,
    section: (path === 'summary' ? 'summary' : path.startsWith('availability.') ? 'availability' : 'basic') as IntakeSection })),
  ...Object.entries({ links: PROFILE_V2_LINK_FIELD_CODES, experiences: PROFILE_V2_EXPERIENCE_FIELD_CODES,
    educations: PROFILE_V2_EDUCATION_FIELD_CODES, skills: PROFILE_V2_SKILL_FIELD_CODES, languages: PROFILE_V2_LANGUAGE_FIELD_CODES,
    projects: PROFILE_V2_PROJECT_FIELD_CODES, achievements: PROFILE_V2_ACHIEVEMENT_FIELD_CODES }).flatMap(([section, fields]) =>
    fields.filter(path => !['skillIds', 'context'].includes(path)).map(path => ({ section: section as IntakeSection, path }))),
];
export interface IntakeSourceSpan { readonly start: number; readonly end: number; readonly quote: string }
export interface IntakeCandidateField { readonly path: string; readonly value: string; readonly sources: readonly IntakeSourceSpan[] }
export interface IntakeCandidate { readonly id: string; readonly section: IntakeSection; readonly fields: readonly IntakeCandidateField[] }
export interface IntakeRoleSuggestion { readonly id: string; readonly title: string; readonly rationale: string; readonly sources: readonly IntakeSourceSpan[] }
export interface IntakeModelOutput {
  readonly reply: string;
  readonly candidates: readonly IntakeCandidate[];
  readonly roleSuggestions: readonly IntakeRoleSuggestion[];
  readonly clarifications: readonly string[];
  readonly declinedFields: readonly { readonly section: IntakeSection; readonly path: string; readonly sources: readonly IntakeSourceSpan[] }[];
}
export interface IntakeConfiguration { readonly version: string; readonly maxRecordingSeconds: number; readonly chunkSeconds: number; readonly nudgeAfterTurns: number; readonly maxSessionTurns: number }
export interface IntakeTurnRequest { readonly clientRequestId: Uuid; readonly expectedRevision: DecimalString; readonly text: string; readonly source: 'TEXT' | 'TRANSCRIPT' }
export interface IntakeStartRequest { readonly clientRequestId: Uuid; readonly locale: 'en-US' | 'zh-CN' }
export interface IntakeRevisionRequest { readonly expectedRevision: DecimalString }
export type IntakeFailure = 'CANCELLED' | 'PROVIDER_FAILED' | 'OUTPUT_INVALID' | 'TIMED_OUT';
export type IntakeDecision = 'PENDING' | 'DISMISSED' | 'DEFERRED' | 'CONFIRMED';
export interface IntakeCandidateState { readonly candidate: IntakeCandidate; readonly decision: IntakeDecision; readonly savedRevision: DecimalString | null }
export interface IntakeTurn {
  readonly id: Uuid; readonly kind: 'REPLY' | 'SPEECH'; readonly status: 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  readonly text: string; readonly reply: string; readonly source: 'TEXT' | 'TRANSCRIPT'; readonly failure: IntakeFailure | null;
  readonly candidates: readonly IntakeCandidateState[]; readonly roleSuggestions: readonly IntakeRoleSuggestion[];
  readonly clarifications: readonly string[]; readonly baseProfileRevision: DecimalString; readonly baseDeletionEpoch: DecimalString;
}
export interface IntakeUsageUnit { readonly state: 'AVAILABLE' | 'EXHAUSTED' | 'UNAVAILABLE'; readonly remaining: number | null; readonly resetsAt: string | null }
export interface IntakeUsage { readonly replies: IntakeUsageUnit; readonly speechSeconds: IntakeUsageUnit }
export interface IntakeSession {
  readonly schemaVersion: 1; readonly id: Uuid; readonly revision: DecimalString; readonly locale: 'en-US' | 'zh-CN';
  readonly turns: readonly IntakeTurn[]; readonly noProgressTurns: number; readonly selectedRoleId: Uuid | null;
}
export interface IntakeView { readonly schemaVersion: 1; readonly session: IntakeSession | null; readonly usage: IntakeUsage; readonly configuration: IntakeConfiguration | null }
export type IntakeCandidateDecisionRequest = IntakeRevisionRequest & { readonly decision: 'DISMISSED' | 'DEFERRED' };
export type IntakeConfirmRequest = IntakeRevisionRequest & { readonly patch: PatchCandidateProfileV2 };
export type IntakeEvent =
  | { readonly kind: 'intake.accepted'; readonly sessionId: Uuid; readonly turnId: Uuid }
  | { readonly kind: 'intake.delta'; readonly sessionId: Uuid; readonly turnId: Uuid; readonly sequence: number; readonly text: string }
  | { readonly kind: 'intake.completed'; readonly view: IntakeView }
  | { readonly kind: 'intake.failed'; readonly code: IntakeFailure; readonly view: IntakeView };
export function countIntakeText(value: string): number { return [...value].length; }
export function truncateIntakeText(value: string): { text: string; truncated: boolean; count: number } {
  const points = [...value], kept = points.slice(0, INTAKE_TEXT_LIMIT);
  return { text: kept.join(''), truncated: points.length > kept.length, count: kept.length };
}
const finite = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
export const isIntakeRevision = (v: unknown): v is DecimalString => typeof v === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && countIntakeText(v) <= max && !/[\uD800-\uDFFF]/u.test(v) && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(v);
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v);
const section = (v: unknown): v is IntakeSection => typeof v === 'string' && INTAKE_SECTIONS.includes(v as IntakeSection);
export function parseIntakeConfiguration(value: unknown): IntakeConfiguration | null {
  if (!closedRecord(value, ['version', 'maxRecordingSeconds', 'chunkSeconds', 'nudgeAfterTurns', 'maxSessionTurns']) || !identifier(value.version) ||
    !finite(value.maxRecordingSeconds, 5, 900) || !finite(value.chunkSeconds, 5, 60) || value.chunkSeconds > value.maxRecordingSeconds ||
    !finite(value.nudgeAfterTurns, 1, 20) || !finite(value.maxSessionTurns, 1, 100)) return null;
  return { version: value.version, maxRecordingSeconds: value.maxRecordingSeconds, chunkSeconds: value.chunkSeconds,
    nudgeAfterTurns: value.nudgeAfterTurns, maxSessionTurns: value.maxSessionTurns };
}
export function parseIntakeStartRequest(v: unknown): IntakeStartRequest | null {
  if (!closedRecord(v, ['clientRequestId', 'locale']) || !parseUuid(v.clientRequestId) || !['en-US', 'zh-CN'].includes(v.locale as string)) return null;
  return { clientRequestId: parseUuid(v.clientRequestId)!, locale: v.locale as IntakeStartRequest['locale'] };
}
export function parseIntakeRevisionRequest(v: unknown): IntakeRevisionRequest | null {
  return closedRecord(v, ['expectedRevision']) && isIntakeRevision(v.expectedRevision) ? { expectedRevision: v.expectedRevision } : null;
}
export function parseIntakeTurnRequest(v: unknown): IntakeTurnRequest | null {
  if (!closedRecord(v, ['clientRequestId', 'expectedRevision', 'text', 'source']) || !parseUuid(v.clientRequestId) ||
    !isIntakeRevision(v.expectedRevision) || !text(v.text, INTAKE_TEXT_LIMIT) || v.source !== 'TEXT' && v.source !== 'TRANSCRIPT') return null;
  return { clientRequestId: parseUuid(v.clientRequestId)!, expectedRevision: v.expectedRevision, text: v.text, source: v.source };
}
function spans(v: unknown, input: string): readonly IntakeSourceSpan[] | null {
  if (!Array.isArray(v) || !v.length || v.length > 8) return null;
  const points = [...input], result: IntakeSourceSpan[] = [];
  for (const s of v) {
    if (!closedRecord(s, ['start', 'end', 'quote']) || !finite(s.start, 0, points.length - 1) || !finite(s.end, s.start + 1, points.length) ||
      !text(s.quote, INTAKE_TEXT_LIMIT) || points.slice(s.start, s.end).join('') !== s.quote) return null;
    result.push({ start: s.start, end: s.end, quote: s.quote });
  }
  return result;
}
function candidate(v: unknown, input: string): IntakeCandidate | null {
  if (!closedRecord(v, ['id', 'section', 'fields']) || !identifier(v.id) || !section(v.section) || !Array.isArray(v.fields) || !v.fields.length || v.fields.length > 24) return null;
  const fields: IntakeCandidateField[] = [], used = new Set<string>();
  for (const f of v.fields) {
    if (!closedRecord(f, ['path', 'value', 'sources']) || !text(f.path, 80) || !text(f.value, INTAKE_TEXT_LIMIT) || used.has(f.path) ||
      !INTAKE_PROFILE_FIELDS.some(s => s.section === v.section && s.path === f.path)) return null;
    const source = spans(f.sources, input);
    // Facts remain verbatim; classifications/dates that need interpretation are reviewed manually.
    if (!source || source.map(s => s.quote.trim()).join(' ').normalize('NFC') !== f.value.normalize('NFC').trim()) return null;
    used.add(f.path); fields.push({ path: f.path, value: f.value, sources: source });
  }
  return { id: v.id, section: v.section, fields };
}
export function parseIntakeModelOutput(v: unknown, input: string): IntakeModelOutput | null {
  if (!closedRecord(v, ['reply', 'candidates', 'roleSuggestions', 'clarifications', 'declinedFields']) || !text(v.reply, 6000) ||
    !Array.isArray(v.candidates) || v.candidates.length > 24 || !Array.isArray(v.roleSuggestions) || v.roleSuggestions.length > 6 ||
    !Array.isArray(v.clarifications) || v.clarifications.length > 8 || v.clarifications.some(c => !text(c, 500)) ||
    !Array.isArray(v.declinedFields) || v.declinedFields.length > 24) return null;
  const candidates: IntakeCandidate[] = [], roleSuggestions: IntakeRoleSuggestion[] = [], declinedFields: IntakeModelOutput['declinedFields'][number][] = [], ids = new Set<string>();
  for (const raw of v.candidates) { const c = candidate(raw, input); if (!c || ids.has(c.id)) return null; ids.add(c.id); candidates.push(c); }
  for (const raw of v.roleSuggestions) {
    if (!closedRecord(raw, ['id', 'title', 'rationale', 'sources']) || !identifier(raw.id) || ids.has(raw.id) || !text(raw.title, 120) || !text(raw.rationale, 1000)) return null;
    const source = spans(raw.sources, input); if (!source) return null;
    ids.add(raw.id); roleSuggestions.push({ id: raw.id, title: raw.title, rationale: raw.rationale, sources: source });
  }
  for (const raw of v.declinedFields) {
    if (!closedRecord(raw, ['section', 'path', 'sources']) || !section(raw.section) || !text(raw.path, 80) || !INTAKE_PROFILE_FIELDS.some(f => f.section === raw.section && f.path === raw.path)) return null;
    const source = spans(raw.sources, input); if (!source) return null;
    declinedFields.push({ section: raw.section, path: raw.path, sources: source });
  }
  return { reply: v.reply, candidates, roleSuggestions, clarifications: v.clarifications as string[], declinedFields };
}

export function parseIntakeCandidateDecisionRequest(v: unknown): IntakeCandidateDecisionRequest | null {
  if (!closedRecord(v, ['expectedRevision', 'decision']) || !isIntakeRevision(v.expectedRevision) || (v.decision !== 'DISMISSED' && v.decision !== 'DEFERRED')) return null;
  return { expectedRevision: v.expectedRevision, decision: v.decision };
}
export function parseIntakeConfirmRequest(v: unknown): IntakeConfirmRequest | null {
  if (!closedRecord(v, ['expectedRevision', 'patch']) || !isIntakeRevision(v.expectedRevision)) return null;
  const patch = parseCandidateProfileV2Patch(v.patch);
  return patch ? { expectedRevision: v.expectedRevision, patch } : null;
}
/** A confirmed card may change only its group; sensitive declarations never enter this route. */
export function intakePatchMatchesSection(patch: PatchCandidateProfileV2, group: IntakeSection): boolean {
  const metadata = ['schemaVersion', 'expectedRevision', 'expectedDeletionEpoch'];
  const groupKeys = group === 'basic' || group === 'summary' || group === 'availability' ? ['fields']
    : group === 'links' ? ['links', 'primaryLinkIdByKind'] : group === 'experiences' ? ['experiences', 'primaryCurrentExperienceId'] : [group];
  if (Object.keys(patch).some(k => !metadata.includes(k) && !groupKeys.includes(k))) return false;
  if (!Object.keys(patch).some(k => groupKeys.includes(k))) return false;
  if (patch.fields && Object.keys(patch.fields).some(path => !INTAKE_PROFILE_FIELDS.some(f => f.section === group && f.path === path))) return false;
  return true;
}
function usageUnit(v: unknown): IntakeUsageUnit | null {
  if (!closedRecord(v, ['state', 'remaining', 'resetsAt']) || !['AVAILABLE', 'EXHAUSTED', 'UNAVAILABLE'].includes(v.state as string) ||
    v.remaining !== null && !finite(v.remaining, 0, 2147483647) || v.resetsAt !== null && (typeof v.resetsAt !== 'string' || !Number.isFinite(Date.parse(v.resetsAt)))) return null;
  if (v.state === 'UNAVAILABLE' && (v.remaining !== null || v.resetsAt !== null) || v.state === 'EXHAUSTED' && v.remaining !== 0 || v.state === 'AVAILABLE' && v.remaining === 0 || v.state !== 'UNAVAILABLE' && v.resetsAt === null) return null;
  return v as unknown as IntakeUsageUnit;
}
export function parseIntakeTurn(v: unknown): IntakeTurn | null {
  if (!closedRecord(v, ['id', 'kind', 'status', 'text', 'reply', 'source', 'failure', 'candidates', 'roleSuggestions', 'clarifications', 'baseProfileRevision', 'baseDeletionEpoch']) ||
    !parseUuid(v.id) || !['REPLY', 'SPEECH'].includes(v.kind as string) || !['PENDING', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(v.status as string) ||
    typeof v.text !== 'string' || v.text !== '' && !text(v.text, v.kind === 'SPEECH' ? 16000 : INTAKE_TEXT_LIMIT) || typeof v.reply !== 'string' ||
    !['TEXT', 'TRANSCRIPT'].includes(v.source as string) || !isIntakeRevision(v.baseProfileRevision) || !isIntakeRevision(v.baseDeletionEpoch) ||
    v.failure !== null && !['CANCELLED', 'PROVIDER_FAILED', 'OUTPUT_INVALID', 'TIMED_OUT'].includes(v.failure as string) ||
    !Array.isArray(v.candidates) || v.candidates.length > 24) return null;
  if ((v.status === 'FAILED' || v.status === 'CANCELLED') !== (v.failure !== null) || v.status === 'CANCELLED' && v.failure !== 'CANCELLED') return null;
  const states: IntakeCandidateState[] = [];
  for (const raw of v.candidates) {
    if (!closedRecord(raw, ['candidate', 'decision', 'savedRevision']) || !['PENDING', 'DISMISSED', 'DEFERRED', 'CONFIRMED'].includes(raw.decision as string) ||
      raw.savedRevision !== null && !isIntakeRevision(raw.savedRevision) || (raw.decision === 'CONFIRMED') !== (raw.savedRevision !== null)) return null;
    const parsed = candidate(raw.candidate, v.text); if (!parsed) return null;
    states.push({ candidate: parsed, decision: raw.decision as IntakeDecision, savedRevision: raw.savedRevision as DecimalString | null });
  }
  const out = parseIntakeModelOutput({ reply: v.reply || ' ', candidates: states.map(s => s.candidate), roleSuggestions: v.roleSuggestions, clarifications: v.clarifications, declinedFields: [] }, v.text);
  // Empty replies are valid for speech, pending and failed turns only.
  const output = v.reply === '' ? parseIntakeModelOutput({ reply: 'pending', candidates: states.map(s => s.candidate), roleSuggestions: v.roleSuggestions, clarifications: v.clarifications, declinedFields: [] }, v.text) : out;
  if (!output || v.kind === 'REPLY' && v.status === 'COMPLETED' && !v.reply || v.kind === 'SPEECH' && (v.reply !== '' || states.length || output.roleSuggestions.length || output.clarifications.length) ||
    v.status !== 'COMPLETED' && (v.reply !== '' || states.length || output.roleSuggestions.length || output.clarifications.length)) return null;
  return { id: v.id as Uuid, kind: v.kind as IntakeTurn['kind'], status: v.status as IntakeTurn['status'], text: v.text, reply: v.reply, source: v.source as IntakeTurn['source'], failure: v.failure as IntakeFailure | null,
    candidates: states, roleSuggestions: output.roleSuggestions, clarifications: output.clarifications, baseProfileRevision: v.baseProfileRevision, baseDeletionEpoch: v.baseDeletionEpoch };
}
export function parseIntakeView(v: unknown): IntakeView | null {
  if (!closedRecord(v, ['schemaVersion', 'session', 'usage', 'configuration']) || v.schemaVersion !== 1 || !closedRecord(v.usage, ['replies', 'speechSeconds'])) return null;
  const replies = usageUnit(v.usage.replies), speechSeconds = usageUnit(v.usage.speechSeconds), configuration = v.configuration === null ? null : parseIntakeConfiguration(v.configuration);
  if (!replies || !speechSeconds || v.configuration !== null && !configuration) return null;
  let session: IntakeSession | null = null;
  if (v.session !== null) {
    const s = v.session;
    if (!closedRecord(s, ['schemaVersion', 'id', 'revision', 'locale', 'turns', 'noProgressTurns', 'selectedRoleId']) || s.schemaVersion !== 1 || !parseUuid(s.id) || !isIntakeRevision(s.revision) ||
      !['en-US', 'zh-CN'].includes(s.locale as string) || !Array.isArray(s.turns) || s.turns.length > 10000 || !finite(s.noProgressTurns, 0, 10000) || s.selectedRoleId !== null && !parseUuid(s.selectedRoleId)) return null;
    const turns = s.turns.map(parseIntakeTurn); if (turns.some(t => !t) || new Set(turns.map(t => t?.id)).size !== turns.length || turns.filter(t => t?.status === 'PENDING').length > 1) return null;
    session = { schemaVersion: 1, id: s.id as Uuid, revision: s.revision, locale: s.locale as IntakeSession['locale'], turns: turns as IntakeTurn[], noProgressTurns: s.noProgressTurns, selectedRoleId: s.selectedRoleId as Uuid | null };
  }
  return { schemaVersion: 1, session, usage: { replies, speechSeconds }, configuration };
}
export function parseIntakeEvent(input: unknown): IntakeEvent | null {
  const v = input as Record<string, unknown>;
  if (!v || typeof v !== 'object' || !('kind' in v)) return null;
  if (v.kind === 'intake.accepted' && closedRecord(v, ['kind', 'sessionId', 'turnId']) && parseUuid(v.sessionId) && parseUuid(v.turnId)) return v as unknown as IntakeEvent;
  if (v.kind === 'intake.delta' && closedRecord(v, ['kind', 'sessionId', 'turnId', 'sequence', 'text']) && parseUuid(v.sessionId) && parseUuid(v.turnId) && finite(v.sequence, 0, 100000) && typeof v.text === 'string' && v.text.length > 0 && countIntakeText(v.text) <= 6000 && !/[\uD800-\uDFFF]/u.test(v.text)) return v as unknown as IntakeEvent;
  if (v.kind === 'intake.completed' && closedRecord(v, ['kind', 'view'])) { const view = parseIntakeView(v.view); return view ? { kind: v.kind, view } : null; }
  if (v.kind === 'intake.failed' && closedRecord(v, ['kind', 'code', 'view']) && ['CANCELLED', 'PROVIDER_FAILED', 'OUTPUT_INVALID', 'TIMED_OUT'].includes(v.code as string)) {
    const view = parseIntakeView(v.view); return view ? { kind: v.kind, code: v.code as IntakeFailure, view } : null;
  }
  return null;
}
