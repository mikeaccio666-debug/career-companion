import { careerRecordId, careerRecordObject } from './career-record-values.ts';
import { parseResumeReviewPayload, resumeReviewDigest, resumeReviewInteger, type ResumeReviewPayload } from './resume-review.ts';
export interface ResumeTextDiff { readonly prefix: string; readonly removed: string; readonly added: string; readonly suffix: string; }
export interface ResumeReviewDiff {
    readonly itemId: string; readonly ownerId: string; readonly currentRevision: number;
    readonly from: Readonly<{ revision: number; payloadDigest: string }>;
    readonly to: Readonly<{ revision: number; payloadDigest: string }>;
    readonly sourceRefs: ResumeReviewPayload['source_refs'];
    readonly text: Readonly<ResumeTextDiff>;
    /** Owner originals have no model claims. This is not a factual accuracy assessment. */
    readonly unresolvedClaims: readonly never[];
}
export function parseResumeReviewDiff(value: unknown): Readonly<ResumeReviewDiff> {
    const v = careerRecordObject(value, ['itemId', 'ownerId', 'currentRevision', 'from', 'to', 'sourceRefs', 'text', 'unresolvedClaims']);
    const itemId = careerRecordId(v.itemId), ownerId = careerRecordId(v.ownerId), currentRevision = resumeReviewInteger(v.currentRevision);
    const point = (value: unknown) => { const r = careerRecordObject(value, ['revision', 'payloadDigest']); return Object.freeze({ revision: resumeReviewInteger(r.revision), payloadDigest: resumeReviewDigest(r.payloadDigest) }); };
    const from = point(v.from), to = point(v.to);
    if (from.revision >= to.revision || to.revision > currentRevision) throw Error('Choose ordered saved revisions.');
    const raw = careerRecordObject(v.text, ['prefix', 'removed', 'added', 'suffix']);
    for (const value of Object.values(raw)) if (typeof value !== 'string' || value.length > 100000) throw Error('Invalid resume comparison.');
    const text = Object.freeze({ prefix: raw.prefix as string, removed: raw.removed as string, added: raw.added as string, suffix: raw.suffix as string });
    const before = text.prefix + text.removed + text.suffix, after = text.prefix + text.added + text.suffix;
    const a = parseResumeReviewPayload({ text: before, claims: v.unresolvedClaims, source_refs: v.sourceRefs });
    const b = parseResumeReviewPayload({ text: after, claims: v.unresolvedClaims, source_refs: v.sourceRefs });
    if (a.source_refs[0].id !== itemId || a.text !== before || b.text !== after || (from.payloadDigest === to.payloadDigest) !== (before === after)) throw Error('Invalid comparison source.');
    return Object.freeze({ itemId, ownerId, currentRevision, from, to, sourceRefs: a.source_refs, text, unresolvedClaims: a.claims });
}
