import { careerRecordId, parseResumeReviewDiff, resumeReviewInteger, resumeReviewDigest } from '@companion/platform-contracts';
import type { BoundPlatformClient } from './api.ts';
import { resumePayloadDigest } from './resume-review-api.ts';
export type ResumeDiffClient = Pick<BoundPlatformClient, 'account' | 'request' | 'isCurrent' | 'subscribe'>;
export interface ResumeDiffSelection { readonly itemId: string; readonly from: number; readonly to: number; readonly currentRevision: number; readonly currentDigest: string; }
const fail = (): never => { throw Error('版本差异暂时无法核对，请重新读取原稿。'); };
export async function readResumeDiff(client: ResumeDiffClient, input: ResumeDiffSelection, signal?: AbortSignal) {
    const itemId = careerRecordId(input.itemId), from = resumeReviewInteger(input.from), to = resumeReviewInteger(input.to), currentRevision = resumeReviewInteger(input.currentRevision), currentDigest = resumeReviewDigest(input.currentDigest);
    if (!client.isCurrent() || from >= to || to !== currentRevision) fail();
    signal?.throwIfAborted();
    const diff = parseResumeReviewDiff(await client.request('/pending-items/' + itemId + '/diff?from=' + from + '&to=' + to, { signal }));
    if (!client.isCurrent() || diff.ownerId !== client.account.accountId || diff.itemId !== itemId || diff.from.revision !== from || diff.to.revision !== to || diff.currentRevision !== currentRevision || diff.to.payloadDigest !== currentDigest) fail();
    const { prefix, removed, added, suffix } = diff.text;
    const digests = await Promise.all([removed, added].map(middle => resumePayloadDigest({ text: prefix + middle + suffix, claims: [], source_refs: diff.sourceRefs })));
    signal?.throwIfAborted();
    if (!client.isCurrent() || digests[0] !== diff.from.payloadDigest || digests[1] !== diff.to.payloadDigest) fail();
    return diff;
}
