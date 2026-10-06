import { COVER_LETTER_ATTACHMENT_PDF_FILE_NAME, type CoverLetterPageJobV1 } from '@edaix/contracts';
import { decodeBase64 } from './binaryEncoding';
import type { CoverLetterRefusal, DockCoverLetterReply } from './coverLetterIntent';
import type { DockCoverLetterRefusal } from './dock/types';
import type { KernelCoverLetterMaterial } from './kernelFiller';

/**
 * 内容脚本侧：把 worker 的 PREPARE / TEXT / PDF 答复接成交给内核的求职信（2026-09-27）。
 *
 * 表上有文字框就当场要正文（一封信十几 KB 以内）；有上传栏就只交一个文件名和一个 `resolve`——字节等内核真走到
 * 那一栏时才要，与简历同一个姿势（`resumeSeam.ts`）。回来的必须就是 PREPARE 答的那一封：id、名字、大小都对上。
 */
/**
 * 开填之前最多等求职信这么久：原来就有的那一封往往一秒内就回来，赶得上这一轮；还在写的写好了再附（同一下点击、30 秒之内
 * 当场附上）。2026-10-04 从 2.5 秒调到 0.8 秒：测试台上有求职信栏的页开填前多等 1.6–2.4 秒（AI 代答的请求也跟着晚发），
 * 而那 2.5 秒里多半等不到——信要现写，或者根本写不出（Lever 两页 COVER_LETTER_JOB_UNAVAILABLE 也照等）。
 */
export const COVER_LETTER_WAIT_MS = 800;

/** worker 的拒绝码 → 浮层上那几句话（找不到那一封、同一封还在写：都说这次没写出来）。 */
export function shownLetterRefusal(code: CoverLetterRefusal): DockCoverLetterRefusal {
  return code === 'NOT_FOUND' || code === 'BUSY' ? 'UNAVAILABLE' : code;
}

export type AskCoverLetter = (
  request: Readonly<{ step: 'PREPARE'; pageJob?: CoverLetterPageJobV1 }> | Readonly<{ step: 'TEXT' | 'PDF'; artifactId: string }>,
) => Promise<DockCoverLetterReply | null>;

export type CoverLetterOutcome =
  /** `generated`：这一次新写的；false 是原来就有的那一封。 */
  | Readonly<{ kind: 'MATERIAL'; material: KernelCoverLetterMaterial; generated: boolean }>
  | Readonly<{ kind: 'REFUSED'; code: CoverLetterRefusal }>;

export async function coverLetterFromWorker(
  ask: AskCoverLetter,
  need: Readonly<{ text: boolean; file: boolean }>,
  pageJob?: CoverLetterPageJobV1,
): Promise<CoverLetterOutcome> {
  const ready = await ask(pageJob === undefined ? { step: 'PREPARE' } : { step: 'PREPARE', pageJob }).catch(() => null);
  if (ready === null) return { kind: 'REFUSED', code: 'UNAVAILABLE' };
  if (ready.kind === 'REFUSED') return ready;
  if (ready.kind !== 'COVER_LETTER_READY') return { kind: 'REFUSED', code: 'UNAVAILABLE' };
  const { artifactId } = ready;
  let text: string | undefined;
  if (need.text) {
    const released = await ask({ step: 'TEXT', artifactId }).catch(() => null);
    if (released?.kind === 'COVER_LETTER_TEXT' && released.artifactId === artifactId) text = released.text;
    // 只有文字框、正文又要不到：这一次没有可交的。
    else if (!need.file) return { kind: 'REFUSED', code: released?.kind === 'REFUSED' ? released.code : 'UNAVAILABLE' };
  }
  const file = need.file
    ? {
        fileName: COVER_LETTER_ATTACHMENT_PDF_FILE_NAME,
        resolve: async (): Promise<File | null> => {
          const released = await ask({ step: 'PDF', artifactId }).catch(() => null);
          if (released?.kind !== 'COVER_LETTER_FILE' || released.artifactId !== artifactId) return null;
          if (released.fileName !== COVER_LETTER_ATTACHMENT_PDF_FILE_NAME) return null;
          const bytes = decodeBase64(released.bytesBase64);
          if (bytes === null || bytes.byteLength !== released.size) return null;
          return new File([bytes], released.fileName, { type: 'application/pdf' });
        },
      }
    : undefined;
  return {
    kind: 'MATERIAL',
    generated: ready.generated,
    material: Object.freeze({ ...(text === undefined ? {} : { text }), ...(file === undefined ? {} : { file }) }),
  };
}
