import { parseResumeReviewPayload, type ResumeTextDiff } from '@companion/platform-contracts';
/** Linear, exact text comparison. The changed middle is a region, not an
 * assertion that every character in it changed. No normalization, truncation,
 * model, external source, permissions or factual claims are introduced. */
export function compareOwnerResumeText(before: unknown, after: unknown): Readonly<ResumeTextDiff> {
    const a = parseResumeReviewPayload(before), b = parseResumeReviewPayload(after);
    if (JSON.stringify(a.source_refs) !== JSON.stringify(b.source_refs)) throw Error('Compare revisions of the same original source.');
    const left = Array.from(a.text), right = Array.from(b.text);
    let start = 0, end = 0;
    while (start < left.length && start < right.length && left[start] === right[start]) start++;
    while (end < left.length - start && end < right.length - start && left[left.length - 1 - end] === right[right.length - 1 - end]) end++;
    return Object.freeze({ prefix: left.slice(0, start).join(''), removed: left.slice(start, left.length - end).join(''), added: right.slice(start, right.length - end).join(''), suffix: end ? left.slice(-end).join('') : '' });
}
