import { careerRecordObject, careerRecordId, CAREER_ROLE_FAMILIES, careerLibraryTime, type AgentSpeakerKey } from '@companion/platform-contracts';
import { CAREER_SKILLS } from '../skills.ts';
export const ORG_P0_ASSET_CLASSES = ['question', 'method_card', 'conversation_pattern'] as const;
export type OrgP0AssetClass = typeof ORG_P0_ASSET_CLASSES[number];
export const ORG_QUESTION_TYPES = ['coding', 'sql', 'stats', 'ab_testing', 'ml_concept', 'ml_system_design', 'system_design', 'product_sense', 'case', 'behavioral', 'domain_hw'] as const;
const speakers = ['companion', 'guide', 'applier', 'interviewer', 'planner', 'coach', 'networker'] as const;
const situations = ['overwhelmed', 'direction_stuck', 'family_pressure', 'post_rejection', 'long_unemployment', 'peer_comparison', 'considering_quit', 'considering_agency'] as const;
function fail(): never { throw Error('The organization asset is invalid.'); }
export function orgText(value: unknown, max = 2000, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || Array.from(value).length > max ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(value)) return fail();
  return value;
}
export function orgInteger(v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || Object.is(v, -0) || v < min || v > max) return fail(); return v;
}
export function orgChoice<T extends string>(v: unknown, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) return fail(); return v as T;
}
export function orgArray<T>(v: unknown, parse: (x: unknown) => T, max = 50, min = 0): readonly T[] {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype || v.length < min || v.length > max) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(v);
  if (Reflect.ownKeys(descriptors).length !== v.length + 1) return fail();
  const out: T[] = [];
  for (let i = 0; i < v.length; i++) {
    if (!descriptors[i] || !('value' in descriptors[i]) || !descriptors[i].enumerable) return fail();
    out.push(parse(descriptors[i].value));
  }
  return Object.freeze(out);
}
function token(v: unknown) { const s = orgText(v, 100); if (!/^[a-z][a-z0-9_.-]*$/.test(s)) return fail(); return s; }
function unique<T>(v: readonly T[]): readonly T[] { if (new Set(v).size !== v.length) return fail(); return v; }
const tokens = (v: unknown, max = 50, min = 0) => unique(orgArray(v, token, max, min));
const texts = (v: unknown, min = 0) => orgArray(v, x => orgText(x), 50, min);
const roles = (v: unknown) => unique(orgArray(v, x => orgChoice(x, CAREER_ROLE_FAMILIES), 7, 1));
const speakerList = (v: unknown) => unique(orgArray(v, x => orgChoice(x, speakers), 7, 1));
function externalRef(v: unknown) {
  if (v === null) return null;
  const o = careerRecordObject(v, ['platform', 'key', 'url']);
  const platform = orgText(o.platform, 80), key = orgText(o.key, 80), raw = orgText(o.url, 2000);
  let url: URL; try { url = new URL(raw); } catch { return fail(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.href !== raw) return fail();
  return Object.freeze({ platform, key, url: raw });
}
export function externalQuestionPrompt(ref: { platform: string; key: string }) { return 'Discuss your approach to ' + ref.platform + ' problem ' + ref.key + '.'; }
export function parseOrgP0Asset(assetClass: OrgP0AssetClass, value: unknown) {
  orgChoice(assetClass, ORG_P0_ASSET_CLASSES);
  if (assetClass === 'question') {
    const o = careerRecordObject(value, ['question_ref', 'type', 'role_families', 'difficulty', 'topics', 'prompt_en', 'prompt_zh', 'external_ref', 'rubric', 'key_points', 'follow_ups', 'time_budget_min']);
    const type = orgChoice(o.type, ORG_QUESTION_TYPES), ref = externalRef(o.external_ref), prompt = orgText(o.prompt_en, 12000);
    // External problems store only a generated reference request, never a pasted original.
    if (ref && (prompt !== externalQuestionPrompt(ref) || o.prompt_zh !== '')) return fail();
    const rubric = o.rubric === null ? null : orgArray(o.rubric, v => {
      const d = careerRecordObject(v, ['dimension', 'scores']);
      return Object.freeze({ dimension: orgText(d.dimension, 100), scores: orgArray(d.scores, x => orgText(x, 500), 4, 4) });
    }, 6, 3);
    if (rubric && new Set(rubric.map(d => d.dimension)).size !== rubric.length) return fail();
    const points = texts(o.key_points), followUps = texts(o.follow_ups);
    // Behavioral practice never supplies a ready-made personal answer.
    if (type === 'behavioral' && points.some(p => /\b(?:I worked|I led|I built|my team|my project)\b/i.test(p))) return fail();
    return Object.freeze({ question_ref: token(o.question_ref), type, role_families: roles(o.role_families),
      difficulty: orgInteger(o.difficulty, 1, 4), topics: tokens(o.topics), prompt_en: prompt,
      prompt_zh: orgText(o.prompt_zh, 12000, true), external_ref: ref, rubric,
      key_points: points, follow_ups: followUps, time_budget_min: orgInteger(o.time_budget_min, 1, 2147483647) });
  }
  if (assetClass === 'method_card') {
    const o = careerRecordObject(value, ['method_id', 'revision', 'author_id', 'reviewer_id', 'applies_to', 'prerequisites', 'steps', 'rubric_ref', 'stop_when', 'counterexamples', 'escalate_when', 'evidence_nature', 'bound_skills', 'when_to_use', 'bound_speakers', 'effective_from', 'superseded_by']);
    const applies = careerRecordObject(o.applies_to, ['role_families', 'stages', 'situations']);
    const steps = orgArray(o.steps, v => {
      const s = careerRecordObject(v, ['goal', 'method', 'allowed_tools', 'output']);
      return Object.freeze({ goal: orgText(s.goal), method: orgText(s.method, 4000), allowed_tools: tokens(s.allowed_tools), output: orgText(s.output) });
    }, 50, 1);
    const skillIds = CAREER_SKILLS.map(s => s.id);
    return Object.freeze({ method_id: token(o.method_id), revision: orgInteger(o.revision, 1, 2147483647), author_id: careerRecordId(o.author_id), reviewer_id: careerRecordId(o.reviewer_id),
      applies_to: Object.freeze({ role_families: roles(applies.role_families), stages: tokens(applies.stages), situations: tokens(applies.situations) }),
      prerequisites: tokens(o.prerequisites), steps, rubric_ref: o.rubric_ref === null ? null : token(o.rubric_ref),
      stop_when: texts(o.stop_when), counterexamples: texts(o.counterexamples, 1), escalate_when: texts(o.escalate_when),
      evidence_nature: orgChoice(o.evidence_nature, ['经验建议', '公开数据', '内部统计'] as const),
      bound_skills: unique(orgArray(o.bound_skills, x => orgChoice(x, skillIds), 50, 1)),
      when_to_use: orgText(o.when_to_use, 80), bound_speakers: speakerList(o.bound_speakers),
      effective_from: careerLibraryTime(o.effective_from), superseded_by: o.superseded_by === null ? null : token(o.superseded_by) });
  }
  const o = careerRecordObject(value, ['pattern_id', 'situation', 'goal', 'do', 'dont', 'example_lines_zh', 'escalate', 'source_segment_refs', 'revision']);
  return Object.freeze({ pattern_id: token(o.pattern_id), situation: orgChoice(o.situation, situations), goal: orgText(o.goal),
    do: texts(o.do, 1), dont: texts(o.dont, 1), example_lines_zh: texts(o.example_lines_zh),
    escalate: orgChoice(o.escalate, ['safety_flow'] as const), source_segment_refs: tokens(o.source_segment_refs, 50, 1),
    revision: orgInteger(o.revision, 1, 2147483647) });
}
export type OrgP0Asset = ReturnType<typeof parseOrgP0Asset>;
/** Pre-import tripwires supplement the named human review; they do not certify de-identification. */
export function assertOrgAssetText(assetClass: OrgP0AssetClass, body: string) {
  orgText(body, 65536);
  if (new TextEncoder().encode(body).length > 65536 ||
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b\d{10}\b|\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/i.test(body)) return fail();
  if (assetClass === 'conversation_pattern' && /名额只剩|最后\s*\d+\s*个|错过就没|再不.{0,20}就|保\s*offer|包内推|上岸率|必考|一定会考|稳过|sales_pressure|sales_qualify/i.test(body)) return fail();
}
export function orgAssetBody(asset: OrgP0Asset) { return JSON.stringify(asset, null, 2); }
export function orgAssetSpeakers(assetClass: OrgP0AssetClass, asset: OrgP0Asset): readonly AgentSpeakerKey[] {
  if (assetClass === 'method_card') return (asset as { bound_speakers: readonly AgentSpeakerKey[] }).bound_speakers;
  if (assetClass === 'conversation_pattern') return ['companion', 'planner'];
  return ['guide', 'applier', 'interviewer', 'coach'];
}
