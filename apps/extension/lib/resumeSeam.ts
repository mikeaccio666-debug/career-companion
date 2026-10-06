import { decodeBase64 } from './binaryEncoding';
import type { KernelFillInput } from './kernelFiller';
import type { DockResumeAttachmentReply, ResumeAttachmentStep } from './resumeAttachmentIntent';

/**
 * 内容脚本侧：把 worker 的 PLAN / RELEASE 答复接成内核的简历接缝（P1-4）。
 *
 * `kernelFiller.ts` 的 `resume` 接缝上写着一句要紧的话：`targetVerified` "must never
 * be inferred from hostname/DOM"。这里它只在 **PLAN 答了 200** 之后才为真——那一步
 * 是服务端拿运营清单判过收件域名之后才答的（见 `resumeAtsAttachment.ts` 头注）。
 * PLAN 被拒、超时、答复不成形，接缝就整个不给（`undefined`），内核把简历栏如实
 * 记成 `NO_VALUE`，其余字段照常。
 *
 * `resolve` 才去要字节，而且只在内核真走到简历栏时被调：这一页没有简历栏，
 * 就一个字节都不过桥、后端也不留一条「释出」的痕。
 */
export type AskResumeAttachment = (step: ResumeAttachmentStep) => Promise<DockResumeAttachmentReply | null>;

/**
 * 预取简历问询之前的粗判（2026-09-23）：页面上有没有文件框。只决定要不要提前问，
 * 不决定写不写——那一栏认不认、写不写，照旧只由规则扫描说了算。
 * 只在浮层挂上（授权之后）用户打开面板时调，启动期不碰宿主页面。
 */
export function pageOffersFileInput(doc: Document): boolean {
  return doc.querySelector('input[type="file"]') !== null;
}

export async function resumeSeamFromWorker(ask: AskResumeAttachment): Promise<KernelFillInput['resume'] | undefined> {
  const plan = await ask('PLAN');
  if (plan === null || plan.kind !== 'RESUME_ATTACHMENT_PLAN') return undefined;
  const { fileName, size } = plan;
  return {
    fileName,
    targetVerified: true,
    resolve: async () => {
      const released = await ask('RELEASE');
      if (released === null || released.kind !== 'RESUME_ATTACHMENT_FILE') return null;
      // 回来的必须就是问询时报的那一份：名字、大小都得对上，对不上就不挂。
      if (released.fileName !== fileName || released.size !== size) return null;
      const bytes = decodeBase64(released.bytesBase64);
      if (bytes === null || bytes.byteLength !== size) return null;
      return new File([bytes], fileName, { type: 'application/pdf' });
    },
  };
}
