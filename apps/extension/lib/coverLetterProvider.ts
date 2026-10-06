import type { CoverLetterAttachmentFailureCode, CoverLetterAttachmentTargetV1 } from '@edaix/contracts';
import { encodeBase64 } from './binaryEncoding';
import type { CoverLetterAttachmentClient, CoverLetterAttachmentFailure } from './coverLetterAttachmentClient';
import type { CoverLetterRefusal, DockCoverLetterIntent, DockCoverLetterReply } from './coverLetterIntent';

/**
 * worker 这一侧：按内容脚本的一步（PREPARE / TEXT / PDF）去问后端（2026-09-27）。
 *
 * PREPARE 先 `lookup`（免费）：岗位库里的岗位已经有一封就直接交回，不去碰计量的 `prepare`——免费账号没有写信的
 * 额度，计量那一关会把「原来就有的那一封」也挡掉。不在岗位库里的页面，已有的那一封也要经 `prepare` 带上这一页的
 * 职位描述才交回（同一条路径上可能挂着好几个岗位，服务端按标题与公司认是不是同一个；是就免费交回）。
 *
 * 同一页的 PREPARE 同时来两次（用户连点、翻页回来）合成一次；重试带同一个 `clientRequestId` 与同一份请求体，
 * 服务端重放、不重扣。收件人由调用方拿核对过的发信页组，这里不看页面报的任何东西。
 */
export function createCoverLetterProvider(deps: Readonly<{
  client: CoverLetterAttachmentClient;
  newRequestId?: () => string;
  now?: () => number;
  onDiagnostic?: (code: string) => void;
}>): Readonly<{ handle: (intent: DockCoverLetterIntent, senderKey: string) => Promise<DockCoverLetterReply> }> {
  const newRequestId = deps.newRequestId ?? (() => crypto.randomUUID());
  const now = deps.now ?? Date.now;
  const inFlight = new Map<string, Promise<DockCoverLetterReply>>();
  /** 同一页、同一份职位描述的请求号，十分钟内重试沿用（服务端据此重放）。 */
  const requestIds = new Map<string, Readonly<{ id: string; at: number }>>();
  const REQUEST_ID_TTL_MS = 10 * 60_000;

  const diag = (code: string): void => { deps.onDiagnostic?.(code); };
  const refused = (code: CoverLetterRefusal): DockCoverLetterReply => ({ kind: 'REFUSED', code });

  const requestIdFor = (key: string): string => {
    const at = now();
    for (const [known, entry] of requestIds) if (at - entry.at > REQUEST_ID_TTL_MS) requestIds.delete(known);
    const known = requestIds.get(key);
    if (known !== undefined) return known.id;
    const id = newRequestId();
    requestIds.set(key, { id, at });
    return id;
  };

  const prepare = async (intent: DockCoverLetterIntent, target: CoverLetterAttachmentTargetV1, pageKey: string): Promise<DockCoverLetterReply> => {
    const found = await deps.client.lookup(target);
    if (!found.ok) {
      diag(`COVER_LETTER_LOOKUP_${found.code}`);
      return refused(fromClient(found.code));
    }
    if (found.value.jobSource === 'CATALOG' && found.value.state === 'READY') {
      return { kind: 'COVER_LETTER_READY', artifactId: found.value.artifactId, generated: false };
    }
    // 不在岗位库里、又没读到这一页的职位描述：写不了。
    if (found.value.jobSource === 'PAGE' && intent.pageJob === undefined) return refused('NEEDS_PAGE_JOB');
    const pageJob = found.value.jobSource === 'PAGE' ? intent.pageJob : undefined;
    // 请求体不同就是另一次请求：职位描述按整份内容算一个指纹（只在内存里当键用）。
    const bodyKey = pageJob === undefined ? pageKey : `${pageKey}|${fingerprint(JSON.stringify(pageJob))}`;
    const prepared = await deps.client.prepare(target, {
      clientRequestId: requestIdFor(bodyKey),
      ...(pageJob === undefined ? {} : { pageJob }),
    });
    if (!prepared.ok) {
      diag(`COVER_LETTER_PREPARE_${prepared.code}`);
      return refused(fromClient(prepared.code));
    }
    if (!prepared.value.ok) {
      diag(prepared.value.code);
      return refused(fromDomain(prepared.value.code));
    }
    // 写好了（或原样交回）：下一次同一页的请求另起一个请求号——那是另一次要信，不是这一次的重试。
    requestIds.delete(bodyKey);
    return { kind: 'COVER_LETTER_READY', artifactId: prepared.value.coverLetter.artifactId, generated: prepared.value.generated };
  };

  return Object.freeze({
    async handle(intent, senderKey) {
      const target: CoverLetterAttachmentTargetV1 = { canonicalOrigin: intent.origin, jobId: intent.pathname };
      if (intent.step === 'PREPARE') {
        const pageKey = `${senderKey}|${intent.origin}${intent.pathname}`;
        const pending = inFlight.get(pageKey);
        if (pending !== undefined) return pending;
        const started = prepare(intent, target, pageKey).finally(() => { inFlight.delete(pageKey); });
        inFlight.set(pageKey, started);
        return started;
      }
      const artifactId = intent.artifactId;
      if (artifactId === undefined) return refused('UNAVAILABLE');
      if (intent.step === 'TEXT') {
        const text = await deps.client.text(target, artifactId);
        if (!text.ok) {
          diag(`COVER_LETTER_TEXT_${text.code}`);
          return refused(fromClient(text.code));
        }
        return { kind: 'COVER_LETTER_TEXT', artifactId, text: text.value };
      }
      const pdf = await deps.client.pdf(target, artifactId);
      if (!pdf.ok) {
        diag(`COVER_LETTER_PDF_${pdf.code}`);
        return refused(fromClient(pdf.code));
      }
      return { kind: 'COVER_LETTER_FILE', artifactId, fileName: pdf.value.fileName, size: pdf.value.size, bytesBase64: encodeBase64(pdf.value.bytes) };
    },
  });
}

/** FNV-1a 32 位：同一页十分钟内分辨「是不是同一份请求体」，不做任何安全用途。 */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

function fromClient(code: CoverLetterAttachmentFailure): CoverLetterRefusal {
  return code;
}

/** prepare 的领域失败（200 ok:false）→ 浮层上那几句话。 */
function fromDomain(code: CoverLetterAttachmentFailureCode): CoverLetterRefusal {
  switch (code) {
    case 'COVER_LETTER_JOB_NOT_IN_CATALOG':
      return 'NEEDS_PAGE_JOB';
    case 'COVER_LETTER_JOB_UNAVAILABLE':
    case 'COVER_LETTER_JOB_STALE':
    case 'COVER_LETTER_JOB_TEXT_UNAVAILABLE':
    case 'COVER_LETTER_JOB_TEXT_INVALID':
    case 'COVER_LETTER_INPUT_TOO_LARGE':
    case 'COVER_LETTER_UNSAFE_SOURCE':
      return 'JOB_TEXT_UNUSABLE';
    case 'COVER_LETTER_PROFILE_UNAVAILABLE':
    case 'COVER_LETTER_PROFILE_INVALID':
    case 'COVER_LETTER_EVIDENCE_UNAVAILABLE':
      return 'PROFILE_UNAVAILABLE';
    case 'COVER_LETTER_BUSY':
      return 'BUSY';
    default:
      return 'UNAVAILABLE';
  }
}
