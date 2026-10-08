import { careerRecordObject, careerRecordId, CareerRecordInputError } from './career-record-values.ts';
/** Service information only. Availability is an operator declaration, never a booking or payment permission. */
export const MENTOR_SERVICE_KINDS = Object.freeze(['mock_interview', 'resume_direction', 'offer_negotiation'] as const);
export type MentorServiceKind = typeof MENTOR_SERVICE_KINDS[number];
export const MENTOR_INTENT_PRIVACY = '蔓藤运营会看到你的称呼、邮箱和你写的需求；看不到对话、记忆和身份日期。';
export interface MentorServiceTerms {
  readonly kind: MentorServiceKind; readonly title: string; readonly durationMin: number; readonly priceCents: number;
  readonly currency: 'USD'; readonly collector: string; readonly description: string; readonly exclusions: string;
  readonly refundVersion: string; readonly refundRules: string; readonly appealInstructions: string;
  readonly disclosureVersion: string; readonly disclosure: string;
  readonly validFrom: string; readonly validUntil: string; readonly earliestSlotAt: string | null;
}
export interface MentorServiceOffer extends MentorServiceTerms {
  readonly id: string; readonly organizationId: string; readonly revision: number; readonly updatedAt: string;
  readonly availability: 'available' | 'unavailable'; readonly intentPrivacy: typeof MENTOR_INTENT_PRIVACY;
}
const fail = (): never => { throw new CareerRecordInputError(); };
export function mentorServiceText(v: unknown, max: number): string {
  if (typeof v !== 'string' || !v || v.trim() !== v || Array.from(v).length > max ||
      /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(v)) return fail();
  return v;
}
export function mentorServiceInteger(v: unknown, min: number, max = 2147483647): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || Object.is(v, -0) || v < min || v > max) return fail(); return v;
}
export function mentorServiceTime(v: unknown): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) ||
      !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) return fail(); return v;
}
export const MENTOR_SERVICE_TERM_KEYS = Object.freeze(['kind', 'title', 'durationMin', 'priceCents', 'currency', 'collector',
  'description', 'exclusions', 'refundVersion', 'refundRules', 'appealInstructions', 'disclosureVersion', 'disclosure',
  'validFrom', 'validUntil', 'earliestSlotAt'] as const);
export function parseMentorServiceTerms(input: unknown): Readonly<MentorServiceTerms> {
  const v = careerRecordObject(input, MENTOR_SERVICE_TERM_KEYS);
  if (typeof v.kind !== 'string' || !MENTOR_SERVICE_KINDS.includes(v.kind as MentorServiceKind) || v.currency !== 'USD') return fail();
  const validFrom = mentorServiceTime(v.validFrom), validUntil = mentorServiceTime(v.validUntil);
  const earliestSlotAt = v.earliestSlotAt === null ? null : mentorServiceTime(v.earliestSlotAt);
  if (validUntil <= validFrom || earliestSlotAt !== null && (earliestSlotAt < validFrom || earliestSlotAt >= validUntil)) return fail();
  return Object.freeze({ kind: v.kind as MentorServiceKind, title: mentorServiceText(v.title, 100),
    durationMin: mentorServiceInteger(v.durationMin, 1, 240), priceCents: mentorServiceInteger(v.priceCents, 1),
    currency: 'USD', collector: mentorServiceText(v.collector, 200), description: mentorServiceText(v.description, 2000),
    exclusions: mentorServiceText(v.exclusions, 2000), refundVersion: mentorServiceText(v.refundVersion, 100),
    refundRules: mentorServiceText(v.refundRules, 2000), appealInstructions: mentorServiceText(v.appealInstructions, 2000),
    disclosureVersion: mentorServiceText(v.disclosureVersion, 100), disclosure: mentorServiceText(v.disclosure, 2000),
    validFrom, validUntil, earliestSlotAt });
}
export function parseMentorServiceOffer(input: unknown): Readonly<MentorServiceOffer> {
  const v = careerRecordObject(input, [...MENTOR_SERVICE_TERM_KEYS, 'id', 'organizationId', 'revision', 'updatedAt', 'availability', 'intentPrivacy']);
  if (!['available', 'unavailable'].includes(v.availability as string) || v.intentPrivacy !== MENTOR_INTENT_PRIVACY) return fail();
  const terms = parseMentorServiceTerms(Object.fromEntries(MENTOR_SERVICE_TERM_KEYS.map(k => [k, v[k]])));
  if (v.availability === 'available' && terms.earliestSlotAt === null) return fail();
  return Object.freeze({ ...terms, id: careerRecordId(v.id), organizationId: careerRecordId(v.organizationId),
    revision: mentorServiceInteger(v.revision, 1), updatedAt: mentorServiceTime(v.updatedAt),
    availability: v.availability as MentorServiceOffer['availability'], intentPrivacy: MENTOR_INTENT_PRIVACY });
}
